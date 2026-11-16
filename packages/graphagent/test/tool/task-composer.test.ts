// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@graphagent/core/v1/session"
import type { SessionPrompt } from "@/session/prompt"
import { Database } from "@graphagent/core/database/database"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { ROOT_ONLY_TOOLS } from "@/tool/pipeline"
import { ToolRegistry } from "@/tool/registry"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { WorkflowTool } from "@/tool/workflow"
import { disposeAllInstances } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"
import { initTaskTool } from "../lib/child-runs"
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

// A composer is only ever declared in configuration in this PR; the first
// built-in composers arrive with `surveyor` and `mapper`.
const composerConfig = {
  agent: {
    panel: {
      description: "Fans a question out to read-only workers",
      mode: "subagent" as const,
      contract: {
        role: "composer" as const,
        compose: { pattern: "fan_out" as const, dispatch: ["explore"], fallback: "explore" },
      },
    },
    helper: {
      description: "A plain worker",
      mode: "subagent" as const,
    },
  },
}

const seed = Effect.fn("TaskComposerTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Composer" })
  const user = yield* session.updateMessage({
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
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

/** A prompt side that fails the test if a child is ever driven. */
const forbiddenOps: TaskPromptOps = {
  cancel: () => Effect.void,
  resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
  prompt: () => Effect.die(new Error("the task tool must not drive a composer")),
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "helper",
      agent: input.agent ?? "helper",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

describe("task tool and composers", () => {
  it.instance(
    "the task catalog lists workers but not composers, while the workflow catalog lists both",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        if (!build) throw new Error("Expected the build agent")
        const registry = yield* ToolRegistry.Service
        const tools = yield* registry.tools({ ...ref, agent: build })
        const taskDescription = tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        const workflowDescription = tools.find((tool) => tool.id === WorkflowTool.id)?.description ?? ""

        expect(taskDescription).toContain("- helper: A plain worker")
        expect(taskDescription).toContain("- explore:")
        expect(taskDescription).not.toContain("- panel:")
        // A composer is a legal `worker_type`, it just cannot be a task target.
        expect(workflowDescription).toContain("- panel: Fans a question out to read-only workers")
        expect(workflowDescription).toContain("- helper:")
      }),
    { config: composerConfig },
  )

  it.instance(
    "the resolved tool definitions (turn path) apply the same composer filter",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        if (!build) throw new Error("Expected the build agent")
        const registry = yield* ToolRegistry.Service
        const chat = yield* (yield* Session.Service).create({ title: "Resolve" })
        const model = ProviderTest.model({ providerID: ref.providerID, id: ref.modelID })
        const resolved = yield* registry.resolve({ model, agent: build, session: chat })
        const task = resolved.find((entry) => entry.id === TaskTool.id)
        const workflow = resolved.find((entry) => entry.id === WorkflowTool.id)
        expect(task?.description ?? "").toContain("- helper:")
        expect(task?.description ?? "").not.toContain("- panel:")
        expect(workflow?.description ?? "").toContain("- panel:")
      }),
    { config: composerConfig },
  )

  it.instance(
    "starting a composer through the task tool fails with a pointer to the workflow tool",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* initTaskTool(tool)

        const exit = yield* def
          .execute(
            { description: "survey options", prompt: "compare three persistence designs", subagent_type: "panel" },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: forbiddenOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) return
        const message = Cause.pretty(exit.cause)
        expect(message).toContain('"panel"')
        expect(message).toContain("composer")
        expect(message).toContain("workflow")
        // No child session was created for the refused call.
        expect(yield* (yield* Session.Service).children(chat.id)).toHaveLength(0)
      }),
    { config: composerConfig },
  )

  it.instance(
    "a composer cannot be resumed through task_id either",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
        const tool = yield* TaskTool
        const def = yield* initTaskTool(tool)

        const exit = yield* def
          .execute(
            {
              description: "survey options",
              prompt: "continue",
              subagent_type: "panel",
              task_id: child.id,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: forbiddenOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("workflow")
      }),
    { config: composerConfig },
  )

  it.instance(
    "a plain worker is still accepted by the task tool",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* initTaskTool(tool)
        let prompted = false
        const promptOps: TaskPromptOps = {
          ...forbiddenOps,
          prompt: (input) =>
            Effect.sync(() => {
              prompted = true
              return reply(input, "worker done")
            }),
        }

        const result = yield* def.execute(
          { description: "small job", prompt: "do the small job", subagent_type: "helper" },
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

        expect(prompted).toBe(true)
        expect(JSON.stringify(result)).toContain("worker done")
      }),
    { config: composerConfig },
  )
})

describe("D4: children never get dispatch tools", () => {
  it.effect("ROOT_ONLY_TOOLS keeps every entry it had before the agent contract", () =>
    Effect.sync(() => {
      // The set only grows. Removing an entry would hand a child session a
      // dispatch or dialog tool (#1158 D4, #1026 invariant 9).
      for (const id of ["memory_search", "task", "workflow", "goal", "watch_pr", "question", "plan_exit"]) {
        expect(ROOT_ONLY_TOOLS.has(id)).toBe(true)
      }
      expect(ROOT_ONLY_TOOLS.size).toBeGreaterThanOrEqual(7)
    }),
  )
})
