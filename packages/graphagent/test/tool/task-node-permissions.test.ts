// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1158 / #1026 invariant 12: one worker, one permission rule set, whether the
// main agent starts it with the task tool or a DAG node runs it. Checked here for
// the first-batch workers, through the real task tool and the real node spawn.
// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- The DAG, session and config doubles implement only
// what a node spawn reads, and carry the placeholder ids the spawn harness has always used.
import { afterEach, expect } from "bun:test"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Ripgrep } from "@graphagent/core/ripgrep"
import type { DagStore } from "@graphagent/core/dag/store"
import { Effect, Fiber, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { subagentRoleDefaultDenies } from "@/agent/subagent-permissions"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { Dag } from "@/dag/dag"
import { spawnNode } from "@/dag/runtime/spawn"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import type { SessionPrompt } from "@/session/prompt"
import { AgentScheduler } from "@/session/agent-scheduler"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { ToolRegistry } from "@/tool/registry"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { answer, type ArtifactName } from "../agent/artifact-fixtures"
import { makeNodeRow, makeWorkflowRow } from "../dag/fixtures"
import { disposeAllInstances, requireInstance } from "../fixture/fixture"
import { initTaskTool, mockSessionPrompt } from "../lib/child-runs"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    EventV2Bridge.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    Database.defaultLayer,
    RuntimeFlags.layer({}),
  ).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

const WORKERS: Array<[string, ArtifactName]> = [
  ["researcher", "research_findings"],
  ["architect", "architecture_proposal"],
  ["prototyper", "prototype"],
]

// What both paths inherit from the parent session: its denies and its external_directory rules.
const PARENT: PermissionV1.Ruleset = [
  { permission: "webfetch", pattern: "*", action: "deny" },
  { permission: "external_directory", pattern: "/vault/*", action: "allow" },
  { permission: "edit", pattern: "*", action: "allow" },
]

function assistantReply(input: SessionPrompt.PromptInput, text: string, sessionID?: SessionID): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "build",
      agent: input.agent ?? "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: sessionID ?? input.sessionID, type: "text", text }],
  }
}

/** The task path: the permission the child session of a real task tool call is created with. */
const viaTask = Effect.fn("TaskNodePermissions.viaTask")(function* (worker: string, artifact: ArtifactName) {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Parent", permission: PARENT })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  const promptOps: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) => Effect.succeed(assistantReply(input, answer(artifact))),
  }
  const def = yield* initTaskTool(yield* TaskTool)
  const result = yield* def.execute(
    { description: "look into it", prompt: "do the work", subagent_type: worker },
    {
      sessionID: chat.id,
      messageID: assistant.id,
      agent: "build",
      abort: new AbortController().signal,
      extra: { promptOps },
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    },
  )
  const child = yield* sessions.get(SessionID.make(result.metadata.sessionID))
  return child.permission ?? []
})

/** The node path: the permission `spawnNode` creates the child session of a DAG node with. */
const viaNode = Effect.fn("TaskNodePermissions.viaNode")(function* (info: Agent.Info, primaryTools: string[]) {
  const created: Array<{ permission?: PermissionV1.Ruleset }> = []
  // Inside a test instance the spawn is fail-closed on its workflow's location, so the store answers for it.
  const instance = yield* requireInstance
  const workflow = makeWorkflowRow({ directory: instance.directory, projectId: instance.project.id })
  const dagLayer = Layer.mock(Dag.Service, {
    store: {
      getWorkflow: () => Effect.succeed(workflow),
    } as unknown as DagStore.Interface,
    nodeQueued: () => Effect.void,
    nodeStarted: () => Effect.void,
    nodeCompleted: () => Effect.void,
    nodeFailed: () => Effect.void,
    failUnrecoverable: () => Effect.succeed("failed" as const),
  })
  const agentLayer = Layer.mock(Agent.Service, {
    get: () => Effect.succeed({ ...info, model: { providerID: ref.providerID, modelID: ref.modelID } }),
    list: () => Effect.succeed([]),
    defaultAgent: () => Effect.succeed("build"),
  })
  const sessionLayer = Layer.mock(Session.Service, {
    get: () => Effect.succeed({ id: "ses_parent" as never, permission: PARENT, agent: "build" } as never),
    create: (input?: { permission?: PermissionV1.Ruleset; directory?: string }) =>
      Effect.sync(() => {
        created.push(input ?? {})
        return { id: "ses_child" as never, directory: input?.directory ?? process.cwd() } as never
      }),
    list: () => Effect.succeed([]),
    messages: () => Effect.succeed([]),
  })
  const configLayer = Layer.mock(Config.Service, {
    get: () => Effect.succeed({ experimental: { primary_tools: primaryTools } } as never),
  })
  const promptLayer = mockSessionPrompt({
    prompt: (input) => Effect.succeed(assistantReply(input, "done", SessionID.make("ses_child"))),
  })
  yield* Effect.scoped(
    Effect.gen(function* () {
      const spawned = yield* spawnNode(
        { limit: { kind: "workflow" as const, workflowID: "wf-1" }, cap: 1 },
        {
          dagID: "wf-1",
          nodeID: "node-1",
          node: makeNodeRow({ workerType: info.name }),
          parentSessionID: "ses_parent",
          promptParts: [{ type: "text", text: "do the work" }] as never,
        },
      )
      yield* Fiber.await(spawned.fiber)
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(dagLayer, agentLayer, AgentScheduler.defaultLayer, sessionLayer, promptLayer, configLayer),
    ),
  ) as Effect.Effect<void>
  return created[0]?.permission ?? []
})

it.instance(
  "a first-batch worker gets the same permission rules from the task tool and from a DAG node",
  () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      for (const [worker, artifact] of WORKERS) {
        const info = yield* agents.get(worker)
        if (!info) throw new Error(`Expected the ${worker} agent`)

        const task = yield* viaTask(worker, artifact)
        const node = yield* viaNode(info, ["lsp"])

        // Rule for rule, in the same order.
        expect(node, worker).toEqual(task)
        // And what they equal is the derivation: role defaults, then the parent's denies and
        // external_directory rules (its edit allow is not inherited), then the global primary_tools denies.
        expect(task, worker).toEqual([
          ...subagentRoleDefaultDenies(info),
          { permission: "webfetch", pattern: "*", action: "deny" },
          { permission: "external_directory", pattern: "/vault/*", action: "allow" },
          { permission: "lsp", pattern: "*", action: "deny" },
        ])
        expect(
          task
            .filter((rule) => rule.action === "deny" && rule.permission !== "webfetch")
            .map((rule) => rule.permission),
        ).toEqual(["todowrite", "task", "lsp"])
      }
    }),
  { config: { experimental: { primary_tools: ["lsp"] } } },
)

it.instance(
  "a worker's own rules, not the session's, decide what it can write, on either path",
  () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const prototyper = yield* agents.get("prototyper")
      const researcher = yield* agents.get("researcher")
      if (!prototyper || !researcher) throw new Error("Expected the first-batch agents")
      // The parent's `edit: allow` is not inherited by either path (only denies and external_directory are).
      const task = yield* viaTask("researcher", "research_findings")
      const node = yield* viaNode(researcher, [])
      for (const rules of [task, node]) {
        expect(rules.some((rule) => rule.permission === "edit")).toBe(false)
        // The researcher's own rules still refuse the edit, merged the way a turn merges them.
        expect(Permission.evaluate("edit", "src/a.ts", Permission.merge(researcher.permission, rules)).action).toBe(
          "deny",
        )
        expect(
          Permission.evaluate("edit", "prototypes/a/b.ts", Permission.merge(prototyper.permission, rules)).action,
        ).toBe("allow")
        expect(Permission.evaluate("edit", "src/a.ts", Permission.merge(prototyper.permission, rules)).action).toBe(
          "deny",
        )
      }
    }),
  { git: true },
)
