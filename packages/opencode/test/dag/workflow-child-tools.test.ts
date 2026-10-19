import { describe, expect } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
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
import { DagStore } from "@opencode-ai/core/dag/store"
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
const trigger: Plugin.Interface["trigger"] = (_name, _input, output) => Effect.succeed(output)
const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Truncate.defaultLayer,
    Layer.mock(Plugin.Service, {
      init: () => Effect.void,
      list: () => Effect.succeed([]),
      trigger,
    }),
    Layer.mock(Permission.Service, {
      ask: () => Effect.void,
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
        const ids = yield* resolvedToolIDs(build, info).pipe(Effect.provide(store))
        expect(ids.filter((id) => id === "agent" || id === "submit_result")).toEqual([...expected])
      }
    }),
  )
})

function resolvedToolIDs(agent: Agent.Info, info: Session.Info) {
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
  }).pipe(Effect.map((tools) => Object.keys(tools)))
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
