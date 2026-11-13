// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { ModelV2 } from "@graphagent/core/model"
import { ProjectV2 } from "@graphagent/core/project"
import { ProviderV2 } from "@graphagent/core/provider"
import { Effect, Layer, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { MCP } from "@/mcp"
import { Permission, type AskOptions } from "@/permission"
import { MessageID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { Session } from "@/session/session"
import { SessionTools } from "@/session/tools"
import { Tool } from "@/tool/tool"
import { ToolRegistry, canUseAgentMessages } from "@/tool/registry"
import { ROOT_ONLY_TOOLS } from "@/tool/pipeline"
import type { TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { ChildRegistry } from "@/session/child/registry"
import type { ChildOwner } from "@/session/child/types"
import { testEffect } from "../lib/effect"
import { builtinEntry } from "../fixture/tool-registry"
import { ProviderTest } from "../fake/provider"
import { DagStore } from "@graphagent/core/dag/store"
import { DagMessages } from "@graphagent/core/dag/messages"
import { Database } from "@graphagent/core/database/database"
import { sql } from "drizzle-orm"

const Parameters = Schema.Struct({})
const workflowDefinition: Tool.Def<typeof Parameters> = {
  id: "workflow",
  description: "workflow",
  parameters: Parameters,
  execute: () => Effect.succeed({ title: "workflow", output: "started", metadata: {} }),
}
const taskDefinition: Tool.Def<typeof Parameters> = {
  id: "task",
  description: "task",
  parameters: Parameters,
  execute: () => Effect.succeed({ title: "task", output: "started", metadata: {} }),
}
const agentDefinition: Tool.Def<typeof Parameters> = {
  id: "agent",
  description: "agent",
  parameters: Parameters,
  execute: () => Effect.succeed({ title: "agent", output: "queued", metadata: {} }),
}
const todoDefinition: Tool.Def<typeof Parameters> = {
  id: "todowrite",
  description: "todowrite",
  parameters: Parameters,
  execute: (_args, ctx) =>
    ctx
      .ask({ permission: "todowrite", patterns: ["*"], always: [], metadata: {} })
      .pipe(Effect.as({ title: "todo", output: "ok", metadata: {} })),
}
const askCapture: AskOptions[] = []
const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Truncate.defaultLayer,
    Layer.mock(Permission.Service, {
      ask: (_input, options) => {
        if (options) askCapture.push(options)
        return Effect.void
      },
      hookPolicy: () => Effect.succeed({ rules: [], directories: [] }),
    }),
    Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}) }),
    Layer.mock(ToolRegistry.Service, {
      tools: () => Effect.succeed([workflowDefinition, taskDefinition, agentDefinition]),
      resolve: (input) =>
        Effect.gen(function* () {
          const entries = [workflowDefinition, taskDefinition, todoDefinition].map((definition) =>
            builtinEntry(definition),
          )
          if (yield* canUseAgentMessages(input.session)) entries.push(builtinEntry(agentDefinition))
          return entries.filter((entry) => !input.session.parentID || !ROOT_ONLY_TOOLS.has(entry.id))
        }),
    }),
  ),
)

describe("workflow child boundary", () => {
  it.instance("exposes orchestration tools to the main conversation but not to child agents", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("Expected configured agent fixture")
      const parentID = SessionID.make("ses_workflow_tool_parent")
      const parentTools = yield* resolvedToolIDs(build, session(parentID))
      const childTools = yield* resolvedToolIDs(build, session(SessionID.make("ses_workflow_tool_child"), parentID))

      expect(parentTools).toEqual(expect.arrayContaining(["workflow", "task"]))
      expect(childTools).not.toContain("workflow")
      expect(childTools).not.toContain("task")
      expect(parentTools).not.toContain("agent")
      expect(childTools).not.toContain("agent")
    }),
  )

  it.instance("exposes the agent tool only to sessions with an active DAG node run", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("Expected configured agent fixture")
      const owner = SessionID.make("ses_workflow_owner")
      const node = SessionID.make("ses_workflow_node")
      const idle = SessionID.make("ses_workflow_idle_node")
      const taskChild = SessionID.make("ses_workflow_task_child")

      // No run in this process: neither the owner nor a child session sees the
      // tool, though the owner may still own a durable workflow.
      expect(yield* resolvedToolIDs(build, session(owner))).not.toContain("agent")
      expect(yield* resolvedToolIDs(build, session(node, owner))).not.toContain("agent")

      // A task-owned run is not a DAG endpoint.
      yield* dagRun(taskChild, owner, { kind: "task", toolCallID: "call_task" })
      expect(yield* resolvedToolIDs(build, session(owner))).not.toContain("agent")
      expect(yield* resolvedToolIDs(build, session(taskChild, owner))).not.toContain("agent")

      // A running DAG node is reachable from both sides of the boundary.
      const run = yield* dagRun(node, owner)
      expect(yield* resolvedToolIDs(build, session(owner))).toContain("agent")
      expect(yield* resolvedToolIDs(build, session(node, owner))).toContain("agent")
      // A child of the owner with no run of its own is not a node session.
      expect(yield* resolvedToolIDs(build, session(idle, owner))).not.toContain("agent")

      // Cancelling ends the run: the next resolution no longer sees a mailbox.
      expect(ChildRegistry.end(run, { type: "cancelled", by: { kind: "engine", reason: "test" } })).toBe(true)
      expect(yield* resolvedToolIDs(build, session(owner))).not.toContain("agent")
      expect(yield* resolvedToolIDs(build, session(node, owner))).not.toContain("agent")
    }),
  )
  it.instance("resolves workspace child tools using durable mailbox membership", () =>
    Effect.gen(function* () {
      const build = yield* (yield* Agent.Service).get("build")
      if (!build) throw new Error("Expected configured agent fixture")
      const database = Database.layerFromPath(":memory:")
      const services = Layer.mergeAll(
        database,
        DagStore.layer.pipe(Layer.provide(database)),
        DagMessages.layer.pipe(Layer.provide(database)),
      )
      yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        const messages = yield* DagMessages.Service
        const owner = { ...session(SessionID.make("ses_real_owner")), projectID: ProjectV2.ID.make("p-workspace") }
        const worker = {
          ...session(SessionID.make("ses_real_child"), owner.id),
          projectID: owner.projectID,
          directory: "/tmp/opencode-linked",
        }
        yield* db.run(
          sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES (${owner.projectID},${owner.directory},'[]',1,1)`,
        )
        for (const s of [owner, worker])
          yield* db.run(
            sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES (${s.id},${s.projectID},${s.parentID ?? null},${s.id},${s.directory},${s.title},'test',1,1)`,
          )
        yield* db.run(
          sql`INSERT INTO workflow (id,project_id,session_id,directory,execution_directory,target_fingerprint,title,status,config,seq,time_created,time_updated) VALUES ('wf-real',${owner.projectID},${owner.id},${owner.directory},${worker.directory},'{"kind":"none"}','W','running','{}',1,1,1)`,
        )
        yield* db.run(
          sql`INSERT INTO workflow_node (id,workflow_id,name,worker_type,status,depends_on,child_session_id,directory,seq,time_created,time_updated) VALUES ('n','wf-real','N','task','running','[]',${worker.id},${worker.directory},1,1,1)`,
        )
        // Visibility comes from the process registry; the rows above authorize
        // the messages themselves.
        yield* dagRun(worker.id, owner.id)
        expect(yield* resolvedToolIDs(build, owner)).toContain("agent")
        const childTools = yield* resolvedToolIDs(build, worker)
        expect(childTools).toContain("agent")
        expect(childTools).not.toContain("task")
        expect(childTools).not.toContain("workflow")
        const parentCaller = { projectID: owner.projectID, directory: owner.directory, sessionID: owner.id }
        const childCaller = { projectID: worker.projectID, directory: worker.directory, sessionID: worker.id }
        const sent = yield* messages.send(parentCaller, {
          workflowID: "wf-real",
          nodeID: "n",
          attemptID: DagMessages.nodeAttemptID(worker.id, 0),
          idempotencyKey: "hello",
          content: "hello",
        })
        expect(sent.ok).toBe(true)
        const received = yield* messages.receive(childCaller)
        expect(received.ok && received.value.map((item) => item.content)).toEqual(["hello"])
        expect(
          (yield* messages.send(childCaller, { workflowID: "wf-real", idempotencyKey: "reply", content: "reply" })).ok,
        ).toBe(true)
      }).pipe(Effect.provide(services))
    }),
  )
  it.instance("passes the child role defaults to permission checks", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("Expected configured agent fixture")
      const parentID = SessionID.make("ses_workflow_tool_parent")
      const child = {
        ...session(SessionID.make("ses_workflow_tool_permission_child"), parentID),
        permission: [...deriveSubagentSessionPermission({ parentSessionPermission: [], subagent: build })],
      }
      const tools = yield* resolveSessionTools(build, child)
      askCapture.length = 0

      yield* Effect.promise(() =>
        Promise.resolve(
          tools.todowrite.execute!(
            {},
            {
              toolCallId: "call_todo",
              messages: [],
              abortSignal: new AbortController().signal,
            },
          ),
        ),
      )

      expect(askCapture[0]?.role).toBe("build")
      expect(askCapture[0]?.roleDefaultIndices).toEqual([0, 1])
      expect(askCapture[0]?.sessionRuleCount).toBe(2)
    }),
  )
})

/**
 * One registered run of this process, released with the test (Issue #1026,
 * PR6): the agent tool's visibility reads the registry, not the database.
 */
function dagRun(childSessionID: SessionID, parentSessionID: SessionID, owner?: ChildOwner) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const ownerKey: ChildOwner = owner ?? {
        kind: "dag_node",
        workflowID: "workflow_owned",
        nodeID: `node_${childSessionID}`,
        attempt: 0,
      }
      const entry = ChildRegistry.create({
        id: `crun_${childSessionID}`,
        childSessionID,
        parentSessionID,
        ownerKind: ownerKey.kind,
        ownerKey,
        permission: { ask: "auto" },
        detached: false,
        directory: undefined,
        owner: {},
      })
      expect(ChildRegistry.register(entry)).toBe(true)
      return entry
    }),
    (entry) =>
      Effect.sync(() => {
        ChildRegistry.end(entry, { type: "completed" })
        ChildRegistry.release(entry)
      }),
  )
}

function resolveSessionTools(agent: Agent.Info, info: Session.Info) {
  const userID = MessageID.make(`msg_${info.id}`)
  const processor: Pick<
    SessionProcessor.Handle,
    "message" | "updateToolCall" | "previewToolCall" | "completeToolCall"
  > = {
    message: {
      id: MessageID.make(`msg_assistant_${info.id}`),
      role: "assistant",
      sessionID: info.id,
      parentID: userID,
      mode: agent.name,
      agent: agent.name,
      path: { cwd: info.directory, root: info.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: 1 },
    },
    updateToolCall: () => Effect.void.pipe(Effect.as(undefined)),
    previewToolCall: () => Effect.void,
    completeToolCall: () => Effect.void,
  }
  const promptOps: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed([]),
    prompt: () => Effect.die(new Error("prompt should not run while resolving tools")),
  }
  return SessionTools.resolve({
    agent,
    model: ProviderTest.model({
      providerID: ProviderV2.ID.make("test"),
      id: ModelV2.ID.make("test-model"),
    }),
    session: info,
    processor,
    bypassAgentCheck: false,
    messages: [],
    promptOps,
  })
}

function resolvedToolIDs(agent: Agent.Info, info: Session.Info) {
  return resolveSessionTools(agent, info).pipe(Effect.map((tools) => Object.keys(tools)))
}

function session(id: SessionID, parentID?: SessionID): Session.Info {
  return {
    id,
    slug: "workflow-child-tools",
    projectID: ProjectV2.ID.global,
    directory: "/tmp/opencode",
    parentID,
    title: "Workflow child tools",
    version: "1.0.0",
    time: { created: 1, updated: 1 },
  }
}
