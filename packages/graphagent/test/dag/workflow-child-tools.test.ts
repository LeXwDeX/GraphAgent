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
import { ToolRegistry } from "@/tool/registry"
import type { TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"
import { DagStore } from "@graphagent/core/dag/store"
import { DagMessages } from "@graphagent/core/dag/messages"
import { Database } from "@graphagent/core/database/database"
import { sql } from "drizzle-orm"
import {
  registerCaptureSlot,
  clearCaptureSlot,
  registerFinalResponseSession,
  clearFinalResponseSession,
} from "@/dag/runtime/capture"

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
const submitDefinition: Tool.Def<typeof Parameters> = { ...agentDefinition, id: "submit_result" }
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
      registrations: () =>
        Effect.succeed([
          { definition: workflowDefinition, sourceKind: "host-builtin", registrationID: "test:workflow" },
          { definition: taskDefinition, sourceKind: "host-builtin", registrationID: "test:task" },
          { definition: agentDefinition, sourceKind: "host-builtin", registrationID: "test:agent" },
          { definition: submitDefinition, sourceKind: "host-builtin", registrationID: "test:submit" },
          { definition: todoDefinition, sourceKind: "host-builtin", registrationID: "test:todo" },
        ]),
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
      expect(parentTools).not.toContain("submit_result")
      expect(childTools).not.toContain("submit_result")
    }),
  )

  it.instance("exposes DAG tools only to workflow owners and their current node sessions", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("Expected configured agent fixture")
      const owner = SessionID.make("ses_workflow_owner")
      const legacy = SessionID.make("ses_legacy_node")
      const final = SessionID.make("ses_final_node")
      const plain = SessionID.make("ses_plain_node")
      const replaced = SessionID.make("ses_replaced_node")
      const workflow: DagStore.WorkflowRow = {
        id: "workflow_owned",
        projectId: ProjectV2.ID.global,
        sessionId: owner,
        directory: "/tmp/opencode",
        title: "Owned workflow",
        status: "running",
        config: "{}",
        seq: 1,
        wakeReported: false,
        graphRev: 0,
        startedAt: 1,
        completedAt: null,
        timeCreated: 1,
        timeUpdated: 1,
      }
      const store = Layer.mock(DagStore.Service, {
        listBySession: (id) => Effect.succeed(id === owner ? [workflow] : []),
        getNodes: () =>
          Effect.succeed(
            [legacy, final, plain, replaced].map((childSessionId): DagStore.NodeRow => ({
              id: childSessionId,
              workflowId: workflow.id,
              name: "worker",
              workerType: "general",
              status: "running",
              required: true,
              dependsOn: [],
              modelId: null,
              modelProviderId: null,
              childSessionId,
              superseded: childSessionId === replaced,
              output: null,
              capturedOutput: null,
              errorReason: null,
              errorClass: null,
              deadlineMs: null,
              wakeEligible: true,
              wakeReported: false,
              replanAttempts: 0,
              timeoutExtensions: 0,
              escalationPending: false,
              seq: 1,
              startedAt: 1,
              completedAt: null,
            })),
          ),
      })
      // The owner endpoint is a main mailbox; children report the node mailbox
      // of their own session, matching DagMessages.revisions.
      const messages = Layer.mock(DagMessages.Service, {
        resolve: (caller, workflowID) =>
          Effect.succeed(
            workflowID === workflow.id && caller.directory === workflow.directory && caller.sessionID === owner
              ? { ok: true, value: { id: `main:${owner}`, kind: "main", sessionID: owner } }
              : { ok: false, reason: "unauthorized" },
          ),
        revisions: (caller) =>
          Effect.succeed(
            caller.directory === workflow.directory
              ? {
                  ok: true,
                  value: {
                    endpoint: {
                      id: caller.sessionID,
                      kind: "node",
                      sessionID: caller.sessionID,
                      workflowID: workflow.id,
                      nodeID: caller.sessionID,
                      attemptID: DagMessages.nodeAttemptID(caller.sessionID, 0),
                    },
                    accepted: 0,
                    snapshot: 0,
                    queued: 0,
                    delivered: 0,
                    undeliverable: 0,
                  },
                }
              : { ok: false, reason: "unauthorized" },
          ),
      })
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          registerCaptureSlot(legacy, { type: "object" })
          registerCaptureSlot(final, { type: "object" })
          registerFinalResponseSession(final)
        }),
        () =>
          Effect.sync(() => {
            clearCaptureSlot(legacy)
            clearCaptureSlot(final)
            clearFinalResponseSession(final)
          }),
      )
      for (const [info, expected] of [
        [session(owner), ["agent"]],
        [session(SessionID.make("ses_without_workflow")), []],
        [session(SessionID.make("ses_task_child"), owner), []],
        [session(legacy, owner), ["agent", "submit_result"]],
        [session(final, owner), ["agent"]],
        [session(plain, owner), ["agent"]],
        [session(replaced, owner), []],
        [{ ...session(owner), directory: "/tmp/other-worktree" }, []],
      ] as const) {
        const ids = yield* resolvedToolIDs(build, info).pipe(Effect.provide(Layer.merge(store, messages)))
        expect(ids.filter((id) => id === "agent" || id === "submit_result")).toEqual([...expected])
      }
    }),
  )
  it.instance("resolves workspace child tools using durable mailbox membership", () =>
    Effect.gen(function* () {
      const build = yield* (yield* Agent.Service).get("build")
      if (!build) throw new Error("Expected configured agent fixture")
      const database = Database.layerFromPath(":memory:")
      const services = Layer.mergeAll(database, DagStore.layer.pipe(Layer.provide(database)), DagMessages.layer.pipe(Layer.provide(database)))
      yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        const messages = yield* DagMessages.Service
        const owner = { ...session(SessionID.make("ses_real_owner")), projectID: ProjectV2.ID.make("p-workspace") }
        const worker = { ...session(SessionID.make("ses_real_child"), owner.id), projectID: owner.projectID, directory: "/tmp/opencode-linked" }
        yield* db.run(sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES (${owner.projectID},${owner.directory},'[]',1,1)`)
        for (const s of [owner, worker]) yield* db.run(sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES (${s.id},${s.projectID},${s.parentID ?? null},${s.id},${s.directory},${s.title},'test',1,1)`)
        yield* db.run(sql`INSERT INTO workflow (id,project_id,session_id,directory,execution_directory,title,status,config,seq,time_created,time_updated) VALUES ('wf-real',${owner.projectID},${owner.id},${owner.directory},${worker.directory},'W','running','{}',1,1,1)`)
        yield* db.run(sql`INSERT INTO workflow_node (id,workflow_id,name,worker_type,status,depends_on,child_session_id,directory,seq,time_created,time_updated) VALUES ('n','wf-real','N','task','running','[]',${worker.id},${worker.directory},1,1,1)`)
        expect(yield* resolvedToolIDs(build, owner)).toContain("agent")
        const childTools = yield* resolvedToolIDs(build, worker)
        expect(childTools).toContain("agent")
        expect(childTools).not.toContain("task")
        expect(childTools).not.toContain("workflow")
        expect(yield* resolvedToolIDs(build, { ...worker, directory: owner.directory })).not.toContain("agent")
        expect(yield* resolvedToolIDs(build, { ...worker, projectID: ProjectV2.ID.make("foreign") })).not.toContain("agent")
        const parentCaller = { projectID: owner.projectID, directory: owner.directory, sessionID: owner.id }
        const childCaller = { projectID: worker.projectID, directory: worker.directory, sessionID: worker.id }
        const sent = yield* messages.send(parentCaller, { workflowID: "wf-real", nodeID: "n", attemptID: DagMessages.nodeAttemptID(worker.id, 0), idempotencyKey: "hello", content: "hello" })
        expect(sent.ok).toBe(true)
        const received = yield* messages.receive(childCaller)
        expect(received.ok && received.value.map((item) => item.content)).toEqual(["hello"])
        expect((yield* messages.send(childCaller, { workflowID: "wf-real", idempotencyKey: "reply", content: "reply" })).ok).toBe(true)
        yield* db.run(sql`UPDATE session SET parent_id = 'wrong' WHERE id = ${worker.id}`)
        expect(yield* resolvedToolIDs(build, worker)).not.toContain("agent")
        yield* db.run(sql`UPDATE session SET parent_id = ${owner.id} WHERE id = ${worker.id}`)
        yield* db.run(sql`UPDATE workflow_node SET status = 'pending', replan_attempts = 1 WHERE id = 'n'`)
        expect(yield* resolvedToolIDs(build, worker)).not.toContain("agent")
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

function resolveSessionTools(agent: Agent.Info, info: Session.Info) {
  const userID = MessageID.make(`msg_${info.id}`)
  const processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall"> = {
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
