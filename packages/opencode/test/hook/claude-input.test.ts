import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { SettingsHook, type HookPayload } from "@/hook/settings"
import { HookCommandSchema } from "@/hook/schema"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { claudeHookCommand, nativeHookCommand, hookCommand } from "../fixture/claude-hook"

const it = testEffect(
  SettingsHook.layer.pipe(
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provideMerge(SessionHooks.defaultLayer),
  ),
)

describe("command hook Claude input naming", () => {
  // Preserve the raw eight-case reproduction, plus uppercase and mixed-case inputs.
  for (const [toolName, toolInput] of [
    ["Grep", { pattern: "function matches", path: "/indexed" }],
    ["grep", { pattern: "function matches", path: "/indexed" }],
    ["Glob", { pattern: "**/settings.ts", path: "/indexed" }],
    ["glob", { pattern: "**/settings.ts", path: "/indexed" }],
    ["Read", { file_path: "/indexed/settings.ts" }],
    ["Read", { filePath: "/indexed/settings.ts" }],
    ["read", { file_path: "/indexed/settings.ts" }],
    ["read", { filePath: "/indexed/settings.ts" }],
    ["GREP", { pattern: "function matches" }],
    ["gReP", { pattern: "function matches" }],
    ["GLOB", { pattern: "**/*.ts" }],
    ["gLoB", { pattern: "**/*.ts" }],
    ["READ", { filePath: "/indexed/settings.ts" }],
    ["rEaD", { filePath: "/indexed/settings.ts" }],
  ] as const) {
    it.instance(`${toolName} ${JSON.stringify(toolInput)}: raw vs adapted stdin`, () =>
      Effect.gen(function* () {
        const hooks = yield* SettingsHook.Service
        const store = yield* SessionHooks.Service
        const event = toolName.toLowerCase() === "read" ? "PostToolUse" : "PreToolUse"
        const payload: HookPayload = { event, toolName, toolInput, toolResponse: {} }
        const rawID = SessionID.descending()
        yield* store.add(rawID, {
          event,
          matcher: "Grep|Glob|Read",
          hooks: [{ type: "command", command: claudeHookCommand }],
        })
        const raw = yield* hooks.trigger(payload, { sessionID: rawID, transcriptPath: "" })
        const rawWorks = toolName === "Grep" || toolName === "Glob" || (toolName === "Read" && "file_path" in toolInput)
        expect(raw.additionalContexts).toHaveLength(rawWorks ? 1 : 0)

        const id = SessionID.descending()
        yield* store.add(id, {
          event,
          matcher: "Grep|Glob|Read",
          hooks: [{ type: "command", command: claudeHookCommand, inputFormat: "claude-code" }],
        })
        const result = yield* hooks.trigger(payload, { sessionID: id, transcriptPath: "" })
        expect(result.additionalContexts).toHaveLength(1)
        const stdin = JSON.parse(result.additionalContexts[0].slice("CLAUDE_CONTEXT:".length))
        const name = toolName.toLowerCase()
        expect(stdin.tool_name).toBe(name[0].toUpperCase() + name.slice(1))
        expect(stdin.tool_input).toMatchObject(toolInput)
        if (name === "read") expect(stdin.tool_input.file_path).toBe("/indexed/settings.ts")
        expect(stdin.hook_event_name).toBe(event)
        expect(stdin.session_id).toBe(id)
        if (event === "PostToolUse") expect(stdin.tool_response).toEqual({})
      }),
    )
  }

  for (const event of [
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "PermissionDenied",
  ] as const) {
    it.instance(`${event}: native siblings stay native, existing Claude keys win`, () =>
      Effect.gen(function* () {
        const hooks = yield* SettingsHook.Service
        const store = yield* SessionHooks.Service
        const id = SessionID.descending()
        yield* store.add(id, {
          event,
          matcher: "Read",
          hooks: [
            { type: "command", command: claudeHookCommand, inputFormat: "claude-code" },
            { type: "command", command: nativeHookCommand },
            { type: "command", command: nativeHookCommand, inputFormat: "opencode" },
          ],
        })
        const toolInput = { filePath: "native.ts", file_path: "claude.ts", offset: 2, limit: 10 }
        const base = { toolName: "read", toolInput }
        const payload: HookPayload =
          event === "PostToolUse"
            ? { ...base, event, toolResponse: "unchanged" }
            : event === "PostToolUseFailure"
              ? { ...base, event, error: "failed" }
              : event === "PermissionDenied"
                ? { ...base, event, reason: "denied" }
                : { ...base, event }
        const result = yield* hooks.trigger(payload, { sessionID: id, transcriptPath: "" })
        if (event === "PermissionRequest" || event === "PermissionDenied") {
          // These events do not deliver additionalContext to the model.
          expect(result.additionalContexts).toEqual([])
          return
        }
        expect(result.additionalContexts).toHaveLength(2) // Native duplicate is deduplicated.
        const claude = JSON.parse(result.additionalContexts[0].slice("CLAUDE_CONTEXT:".length))
        const native = JSON.parse(result.additionalContexts[1].slice("NATIVE_CONTEXT:".length))
        expect(claude.tool_name).toBe("Read")
        expect(claude.tool_input).toEqual(toolInput)
        expect(native.tool_name).toBe("read")
        expect(native.tool_input).toEqual(toolInput)
        expect(toolInput).toEqual({ filePath: "native.ts", file_path: "claude.ts", offset: 2, limit: 10 })
      }),
    )
  }

  for (const [toolName, toolInput, expected] of [
    ["bAsH", { command: "true", timeout: 20 }, { command: "true", timeout: 20 }],
    ["wRiTe", { filePath: "file.ts", content: "text" }, { file_path: "file.ts", content: "text" }],
    [
      "eDiT",
      { filePath: "file.ts", oldString: "a", newString: "b", replaceAll: false },
      { file_path: "file.ts", old_string: "a", new_string: "b", replace_all: false },
    ],
    ["gReP", { pattern: "a", include: "*.ts" }, { pattern: "a", glob: "*.ts" }],
    ["read", { filePath: "file.ts", file_path: null }, { file_path: "file.ts" }],
  ] as const) {
    it.instance(`${toolName}: known argument aliases`, () =>
      Effect.gen(function* () {
        const hooks = yield* SettingsHook.Service
        const store = yield* SessionHooks.Service
        const id = SessionID.descending()
        yield* store.add(id, {
          event: "PreToolUse",
          hooks: [{ type: "command", command: claudeHookCommand, inputFormat: "claude-code" }],
        })
        const result = yield* hooks.trigger(
          { event: "PreToolUse", toolName, toolInput },
          { sessionID: id, transcriptPath: "" },
        )
        const stdin = JSON.parse(result.additionalContexts[0].slice("CLAUDE_CONTEXT:".length))
        expect(stdin.tool_input).toMatchObject(expected)
        for (const key of Object.keys(toolInput)) expect(Object.hasOwn(stdin.tool_input, key)).toBe(true)
      }),
    )
  }

  for (const [toolName, updatedInput, expected] of [
    ["READ", { file_path: "new.ts", filePath: "loses.ts", limit: 1 }, { filePath: "new.ts", limit: 1 }],
    ["write", { file_path: "new.ts", content: "new" }, { filePath: "new.ts", content: "new" }],
    [
      "edit",
      { file_path: "new.ts", old_string: "a", new_string: "b", replace_all: false },
      { filePath: "new.ts", oldString: "a", newString: "b", replaceAll: false },
    ],
    ["grep", { glob: "*.ts" }, { include: "*.ts" }],
  ] as const) {
    it.instance(`${toolName}: PreToolUse rewrites translate back`, () =>
      Effect.gen(function* () {
        const hooks = yield* SettingsHook.Service
        const store = yield* SessionHooks.Service
        const id = SessionID.descending()
        yield* store.add(id, {
          event: "PreToolUse",
          hooks: [
            {
              type: "command",
              inputFormat: "claude-code",
              command: hookCommand(
                `console.log(JSON.stringify(${JSON.stringify({ hookSpecificOutput: { updatedInput } })}))`,
              ),
            },
          ],
        })
        const result = yield* hooks.trigger(
          { event: "PreToolUse", toolName, toolInput: {} },
          { sessionID: id, transcriptPath: "" },
        )
        expect(result.updatedInput).toEqual(expected)
      }),
    )
  }

  it.instance("unknown tool: PreToolUse rewrite is not translated back", () =>
    Effect.gen(function* () {
      const hooks = yield* SettingsHook.Service
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      yield* store.add(id, {
        event: "PreToolUse",
        hooks: [
          {
            type: "command",
            inputFormat: "claude-code",
            command: hookCommand(
              `console.log(JSON.stringify(${JSON.stringify({
                hookSpecificOutput: { updatedInput: { file_path: "new.ts", filePath: "keep.ts" } },
              })}))`,
            ),
          },
        ],
      })
      const result = yield* hooks.trigger(
        { event: "PreToolUse", toolName: "mcp__CBM__Read", toolInput: {} },
        { sessionID: id, transcriptPath: "" },
      )
      // Unknown tools get no naming translation in either direction — the
      // rewrite passes through untouched, claude-style key included.
      expect(result.updatedInput).toEqual({ file_path: "new.ts", filePath: "keep.ts" })
    }),
  )

  it.instance("non-PreToolUse: rewrite is not translated back", () =>
    Effect.gen(function* () {
      const hooks = yield* SettingsHook.Service
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      yield* store.add(id, {
        event: "PostToolUse",
        hooks: [
          {
            type: "command",
            inputFormat: "claude-code",
            command: hookCommand(
              `console.log(JSON.stringify(${JSON.stringify({
                hookSpecificOutput: { updatedInput: { file_path: "new.ts", filePath: "keep.ts" } },
              })}))`,
            ),
          },
        ],
      })
      const result = yield* hooks.trigger(
        { event: "PostToolUse", toolName: "read", toolInput: { filePath: "file.ts" }, toolResponse: "response" },
        { sessionID: id, transcriptPath: "" },
      )
      // updatedInput controls PreToolUse only; a post-tool rewrite cannot
      // retroactively change the input of an already completed tool.
      expect(result.updatedInput).toBeUndefined()
    }),
  )

  it.instance("unknown/custom and lifecycle envelopes are not normalized", () =>
    Effect.gen(function* () {
      const hooks = yield* SettingsHook.Service
      const store = yield* SessionHooks.Service
      const id = SessionID.descending()
      for (const payload of [
        { event: "PreToolUse", toolName: "mcp__CBM__Read", toolInput: { filePath: "native.ts" } },
        { event: "PreToolUse", toolName: "CUSTOM", toolInput: { filePath: "native.ts" } },
        { event: "SessionStart", source: "startup" },
      ] as const) {
        yield* store.add(id, {
          event: payload.event,
          hooks: [{ type: "command", command: nativeHookCommand, inputFormat: "claude-code" }],
        })
        const result = yield* hooks.trigger(payload, { sessionID: id, transcriptPath: "" })
        expect(result.additionalContexts).toHaveLength(1)
        const stdin = JSON.parse(result.additionalContexts[0].slice("NATIVE_CONTEXT:".length))
        if (payload.event === "PreToolUse") {
          expect(stdin.tool_name).toBe(payload.toolName)
          expect(stdin.tool_input).toEqual(payload.toolInput)
        } else expect(stdin.source).toBe("startup")
      }
    }),
  )

  it.instance(
    "hooks.json loader retains the explicit adapter",
    () =>
      Effect.gen(function* () {
        const hooks = yield* SettingsHook.Service
        const instance = yield* TestInstance
        const result = yield* hooks.trigger(
          { event: "PostToolUse", toolName: "read", toolInput: { filePath: "file.ts" }, toolResponse: "response" },
          { sessionID: SessionID.descending(), transcriptPath: "" },
        )
        const stdin = JSON.parse(result.additionalContexts[0].slice("CLAUDE_CONTEXT:".length))
        expect(stdin.tool_name).toBe("Read")
        expect(stdin.tool_input).toEqual({ filePath: "file.ts", file_path: "file.ts" })
        expect(stdin.cwd).toBe(instance.directory)
      }),
    {
      init: (dir) =>
        Effect.promise(async () => {
          await fs.mkdir(path.join(dir, ".opencode"))
          await fs.writeFile(
            path.join(dir, ".opencode/hooks.json"),
            JSON.stringify({
              PostToolUse: [
                {
                  matcher: "Read",
                  hooks: [{ type: "command", command: claudeHookCommand, inputFormat: "claude-code" }],
                },
              ],
            }),
          )
        }),
    },
  )

  test("input format is validated for every handler", () => {
    expect(HookCommandSchema.safeParse({ type: "command", command: "true", inputFormat: "CLAUDE" }).success).toBe(false)
    for (const type of ["mcp", "mcp_tool", "http", "prompt", "agent"]) {
      expect(HookCommandSchema.safeParse({ type, command: "action", inputFormat: "claude-code" }).success).toBe(true)
      expect(HookCommandSchema.safeParse({ type, command: "action" }).success).toBe(true)
    }
  })
})

for (const toolName of ["apply_patch", "patch", "multiedit"]) {
  for (const matcher of ["Edit", "Write", "Edit|Write", toolName]) {
    it.instance(`${toolName} matches ${matcher} once and exposes affected paths`, () =>
      Effect.gen(function* () {
        const hooks = yield* SettingsHook.Service
        const store = yield* SessionHooks.Service
        const sessionID = SessionID.descending()
        yield* store.add(sessionID, {
          event: "PostToolUse",
          matcher,
          hooks: [
            {
              type: "command",
              command: nativeHookCommand,
              inputFormat: "claude-code",
            },
          ],
        })
        const toolInput =
          toolName === "multiedit"
            ? { edits: [{ filePath: "a.ts" }, { filePath: "b.ts" }] }
            : {
                patchText:
                  "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** Move to: b.ts\n*** Add File: c.ts\n+ok\n*** End Patch",
              }
        const result = yield* hooks.trigger(
          { event: "PostToolUse", toolName, toolInput, toolResponse: {} },
          { sessionID, transcriptPath: "" },
        )
        expect(result.additionalContexts).toHaveLength(1)
        const stdin = JSON.parse(result.additionalContexts[0].slice("NATIVE_CONTEXT:".length))
        expect(stdin.tool_name).toBe("Edit")
        expect(stdin.tool_input.file_path).toBe("a.ts")
        expect(stdin.tool_input.file_paths).toEqual(
          toolName === "multiedit" ? ["a.ts", "b.ts"] : ["a.ts", "b.ts", "c.ts"],
        )
      }),
    )
  }
}

for (const toolName of ["bash", "read", "edit", "write"]) {
  it.instance(`${toolName}: full output is adapted only for Claude entries`, () =>
    Effect.gen(function* () {
      const hooks = yield* SettingsHook.Service
      const store = yield* SessionHooks.Service
      const sessionID = SessionID.descending()
      yield* store.add(sessionID, {
        event: "PostToolUse",
        hooks: [
          { type: "command", command: nativeHookCommand, inputFormat: "claude-code" },
          { type: "command", command: nativeHookCommand },
        ],
      })
      const metadata = {
        marker: "native",
        display: { path: "a.ts", text: "file content" },
        diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after\n",
      }
      const result = yield* hooks.trigger(
        {
          event: "PostToolUse",
          toolName,
          toolInput: { filePath: "a.ts" },
          toolResponse: metadata,
          toolOutput: { title: "test", output: "full output", metadata },
        },
        { sessionID, transcriptPath: "" },
      )
      const [claude, native] = result.additionalContexts.map((item) => JSON.parse(item.slice("NATIVE_CONTEXT:".length)))
      expect(native.tool_response).toEqual(metadata)
      expect(native).not.toHaveProperty("toolOutput")
      if (toolName === "bash")
        expect(claude.tool_response).toEqual({ stdout: "full output", stderr: "", interrupted: false })
      else if (toolName === "read")
        expect(claude.tool_response).toEqual({ file: { filePath: "a.ts", content: "file content" } })
      else {
        expect(claude.tool_response.filePath).toBe("a.ts")
        expect(claude.tool_response.success).toBe(true)
        expect(claude.tool_response.structuredPatch[0]).toMatchObject({
          oldStart: 1,
          newStart: 1,
          lines: ["-before", "+after"],
        })
      }
    }),
  )
}

for (const toolName of ["read", "write", "edit"]) {
  for (const event of ["PreToolUse", "PermissionRequest"] as const) {
    it.instance(`V2 ${toolName} ${event}: path adapts and rewrites return the original native path key`, () =>
      Effect.gen(function* () {
        const hooks = yield* SettingsHook.Service
        const store = yield* SessionHooks.Service
        const sessionID = SessionID.descending()
        const input =
          toolName === "read"
            ? { path: "original.txt" }
            : toolName === "write"
              ? { path: "original.txt", content: "hello" }
              : { path: "original.txt", oldString: "before", newString: "after" }
        const script = `let input='';for await(const chunk of process.stdin)input+=chunk;const e=JSON.parse(input);if(e.tool_input.file_path!=='original.txt')process.exit(1);const updatedInput={...e.tool_input,file_path:'changed.txt'};console.log(JSON.stringify({hookSpecificOutput:${event === "PreToolUse" ? "{updatedInput}" : "{decision:{behavior:'allow',updatedInput}}"}}))`
        yield* store.add(sessionID, {
          event,
          hooks: [{ type: "command", inputFormat: "claude-code", command: process.execPath, args: ["-e", script] }],
        })
        const result = yield* hooks.trigger({ event, toolName, toolInput: input }, { sessionID, transcriptPath: "" })
        const updated = event === "PreToolUse" ? result.updatedInput : result.permissionRequestDecision?.updatedInput
        expect(updated).toEqual({ ...input, path: "changed.txt" })
        expect(result.hookErrors).toBeUndefined()
      }),
    )
  }
}
