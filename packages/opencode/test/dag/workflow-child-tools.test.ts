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
      expect(parentTools).toContain("agent")
      expect(childTools).toContain("agent")
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
