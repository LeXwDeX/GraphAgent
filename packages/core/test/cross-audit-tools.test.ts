import { describe, expect } from "bun:test"
import { Tool } from "@opencode-ai/core/tool/tool"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { SessionConversationHooks } from "@opencode-ai/core/session/conversation-hooks"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { settleTool } from "./lib/tool"

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const it = testEffect(ToolRegistry.layer.pipe(Layer.provide(ApplicationTools.layer), Layer.provide(outputStore)))
const call = (name: string): ToolRegistry.ExecuteInput => ({
  sessionID: SessionV2.ID.make("ses_cross_audit"),
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_cross_audit"),
  call: { type: "tool-call", id: `call-${name}`, name, input: { text: name } },
})
const failing = Tool.make({
  description: "Always fails",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.String,
  execute: () => Effect.fail(new Tool.Failure({ message: "CROSS_AUDIT_TOOL_FAILURE" })),
})
const hooks = (change: Partial<SessionConversationHooks.Interface>): SessionConversationHooks.Interface => ({
  admit: () => Effect.void,
  beforeTool: (input) => Effect.succeed({ toolInput: input.toolInput }),
  afterTool: () => Effect.succeed({}),
  ...change,
})

describe("V2 PreToolUse feedback on a failed tool", () => {
  it.effect("keeps the Pre context next to the execution error", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* registry.register({ failing })
      const result = yield* settleTool(registry, call("failing")).pipe(
        Effect.provideService(
          SessionConversationHooks.Service,
          hooks({
            beforeTool: (input) => Effect.succeed({ toolInput: input.toolInput, feedback: "CROSS_AUDIT_PRE_CTX" }),
          }),
        ),
      )
      expect(result.result.type).toBe("error")
      expect(String(result.result.value)).toContain("CROSS_AUDIT_TOOL_FAILURE")
      expect(String(result.result.value)).toContain("CROSS_AUDIT_PRE_CTX")
    }),
  )
})
