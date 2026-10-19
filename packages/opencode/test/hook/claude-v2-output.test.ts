import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionConversationHooks } from "@opencode-ai/core/session/conversation-hooks"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { HookV2Conversation } from "@/hook/v2-conversation"
import { SettingsHook, type HookPayload } from "@/hook/settings"
import { claudeToolResponse } from "@/hook/tool-output"
import { Session } from "@/session/session"
import { InstanceStore } from "@/project/instance-store"
import { Permission } from "@/permission"
import { SessionAttention } from "@/notification/attention"
import { testEffect } from "../lib/effect"

const outputs = [
  {
    tool: "bash",
    input: { command: "echo done" },
    output: { command: "echo done", cwd: "/tmp", output: "done", exitCode: 0, truncated: false },
    expected: { stdout: "done", stderr: "", interrupted: false },
  },
  {
    tool: "bash",
    input: { command: "sleep 10" },
    output: { command: "sleep 10", cwd: "/tmp", output: "timed out", timedOut: true, truncated: false },
    expected: { stdout: "timed out", stderr: "", interrupted: true },
  },
  {
    tool: "read",
    input: { path: "/tmp/a.ts" },
    output: { type: "text-page", content: "file content", mime: "text/plain", offset: 1, truncated: false },
    expected: { file: { filePath: "/tmp/a.ts", content: "file content" } },
  },
  {
    tool: "read",
    input: { path: "/tmp/a.ts" },
    output: { uri: "file:///tmp/a.ts", content: "full content", encoding: "utf8", mime: "text/plain" },
    expected: { file: { filePath: "/tmp/a.ts", content: "full content" } },
  },
  {
    tool: "edit",
    input: { path: "a.ts" },
    output: { operation: "write", target: "/tmp/a.ts", resource: "a.ts", existed: true, replacements: 1 },
    expected: { filePath: "/tmp/a.ts", structuredPatch: [], success: true },
  },
  {
    tool: "write",
    input: { path: "a.ts" },
    output: { operation: "write", target: "/tmp/a.ts", resource: "a.ts", existed: false },
    expected: { filePath: "/tmp/a.ts", structuredPatch: [], success: true },
  },
  {
    tool: "apply_patch",
    input: { patchText: "*** Begin Patch\n*** Add File: a.ts\n+hello\n*** End Patch" },
    output: { applied: [{ type: "add", target: "/tmp/a.ts", resource: "a.ts" }] },
    expected: { filePath: "/tmp/a.ts", structuredPatch: [], success: true },
  },
]

for (const { tool, input, output, expected } of outputs) {
  test(`Claude V2 ${tool} output ${JSON.stringify(output)}`, () => {
    const before = JSON.stringify(output)
    expect(claudeToolResponse(tool, input, output, output)).toEqual(expected)
    expect(JSON.stringify(output)).toBe(before)
  })
}

test("Claude V2 adapter preserves unknown or directory outputs", () => {
  const output = { entries: [{ name: "a.ts", type: "file" }], truncated: false }
  expect(claudeToolResponse("read", { path: "/tmp" }, output, output)).toBe(output)
  expect(claudeToolResponse("custom", {}, outputs[0].output, "native")).toBe("native")
})

const payloads: HookPayload[] = []
const it = testEffect(
  HookV2Conversation.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(SettingsHook.Service, {
          hasEvent: () => Effect.succeed(false),
          trigger: (payload) =>
            Effect.sync(() => {
              payloads.push(payload)
              return { additionalContexts: [], systemMessages: [] }
            }),
        }),
        Layer.mock(Session.Service, {}),
        Layer.mock(InstanceStore.Service, { provide: (_input, effect) => effect }),
        Layer.mock(Permission.Service, {}),
        Layer.mock(SessionAttention.Service, {}),
      ),
    ),
  ),
)

it.effect("V2 conversation forwards complete output to adapters without changing native toolResponse", () =>
  Effect.gen(function* () {
    payloads.length = 0
    const hooks = yield* SessionConversationHooks.Service
    const fixture = outputs[0]
    yield* hooks
      .afterTool({
        sessionID: SessionSchema.ID.make("ses_claude_v2"),
        toolName: fixture.tool,
        toolInput: fixture.input,
        toolCallID: "call_v2",
        output: fixture.output,
      })
      .pipe(
        Effect.provide(
          Layer.mock(Location.Service, {
            directory: AbsolutePath.make("/tmp"),
            project: { id: Project.ID.global, directory: AbsolutePath.make("/tmp") },
          }),
        ),
      )
    const captured = payloads[0]
    expect(captured?.event).toBe("PostToolUse")
    if (captured?.event !== "PostToolUse") throw new Error("missing PostToolUse payload")
    expect(captured.toolResponse).toBe(fixture.output)
    expect(captured.toolOutput).toBe(fixture.output)
    expect(
      claudeToolResponse(captured.toolName, captured.toolInput, captured.toolOutput, captured.toolResponse),
    ).toEqual(fixture.expected)
  }),
)
