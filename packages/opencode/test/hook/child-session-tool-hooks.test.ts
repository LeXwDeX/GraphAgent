import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { SessionTools } from "@/session/tools"
import { SettingsHook, type HookPayload, type TriggerResult } from "@/hook/settings"
import { ToolRegistry } from "@/tool/registry"
import { Plugin } from "@/plugin"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"

// Tool hooks inside a task child session: a tool executed by the child's own
// prompt loop (SessionTools.resolve with a child session) must trigger
// PreToolUse and PostToolUse keyed by the CHILD session ID, never the parent's.

const recorded: { payload: HookPayload; sessionID: string }[] = []
const recorder = Layer.succeed(
  SettingsHook.Service,
  SettingsHook.Service.of({
    trigger: (payload, context) =>
      Effect.sync(() => {
        recorded.push({ payload, sessionID: context.sessionID })
        const result: TriggerResult = { additionalContexts: [], systemMessages: [] }
        return result
      }),
    list: () => Effect.succeed([]),
  }),
)

const writeDefinition = {
  id: "write",
  description: "Fixture leaf writer",
  parameters: Schema.Struct({ filePath: Schema.String, content: Schema.String }),
  execute: (args: { filePath: string; content: string }) =>
    Effect.promise(async () => {
      await fs.writeFile(args.filePath, args.content)
      return { title: "written", output: "WRITE_COMPLETE", metadata: {} }
    }),
}

const it = testEffect(
  Layer.mergeAll(
    recorder,
    Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
    Layer.mock(Permission.Service, {
      ask: () => Effect.void,
      hookPolicy: () => Effect.succeed({ rules: [], directories: [] }),
    }),
    Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}) }),
    Layer.mock(Truncate.Service, {}),
    Layer.mock(ToolRegistry.Service, {
      tools: () => Effect.succeed([writeDefinition]),
      registrations: () =>
        Effect.succeed([{ definition: writeDefinition, sourceKind: "host-builtin", registrationID: "test:write" }]),
    }),
  ),
)

describe("tool hooks inside a task child session", () => {
  it.instance("PreToolUse and PostToolUse fire with the child session ID", () =>
    Effect.gen(function* () {
      recorded.length = 0
      const instance = yield* TestInstance
      const parentID = SessionID.descending()
      const childID = SessionID.descending()
      const tools = yield* SessionTools.resolve({
        agent: { name: "general", permission: [], options: {} } as any,
        model: ProviderTest.model(),
        session: { id: childID, parentID, directory: instance.directory, permission: [] } as any,
        processor: {
          message: { id: MessageID.ascending(), sessionID: childID },
          updateToolCall: () => Effect.succeed(undefined),
          completeToolCall: () => Effect.void,
        } as any,
        bypassAgentCheck: false,
        messages: [],
        promptOps: {} as any,
      })
      const target = path.join(instance.directory, "child.txt")
      yield* Effect.promise(() =>
        (tools as any).write.execute(
          { filePath: target, content: "child-output" },
          { toolCallId: "child-write", messages: [], abortSignal: new AbortController().signal },
        ),
      )

      expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("child-output")
      const tool = recorded.filter(({ payload }) => payload.event === "PreToolUse" || payload.event === "PostToolUse")
      expect(tool.map(({ payload }) => payload.event)).toEqual(["PreToolUse", "PostToolUse"])
      expect(tool.map(({ payload }) => (payload as { toolName?: string }).toolName)).toEqual(["write", "write"])
      expect(tool.map(({ sessionID }) => sessionID)).toEqual([childID, childID])
      expect(recorded.some(({ sessionID }) => sessionID === parentID)).toBe(false)
    }),
  )
})
