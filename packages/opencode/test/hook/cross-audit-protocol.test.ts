import { describe, expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { Effect, Layer } from "effect"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  SettingsHook,
  classifyStdout,
  resolveHookShell,
  expandHookCommand,
  type HookCommand,
  type HookEvent,
  type HookPayload,
  type ShellProbe,
} from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { MCP } from "@/mcp"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const layer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const it = testEffect(layer)

const node = (script: string, extra: Partial<HookCommand> = {}): HookCommand => ({
  type: "command",
  command: process.execPath,
  args: ["-e", script],
  ...extra,
})

const stdoutJSON = (value: unknown) => `process.stdout.write(${JSON.stringify(JSON.stringify(value))})`

describe("cross-audit: exec form placeholders and shell selection", () => {
  it.instance("exec form substitutes CLAUDE_PROJECT_DIR in command and every arg", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const instance = yield* TestInstance
      const sessionID = SessionID.descending()
      yield* store.add(sessionID, {
        event: "UserPromptSubmit",
        hooks: [
          {
            type: "command",
            command: process.execPath,
            args: [
              "-e",
              "process.stdout.write(process.argv[1] + '|' + process.argv[2])",
              "${CLAUDE_PROJECT_DIR}/a b",
              "x",
            ],
          },
        ],
      })
      const result = yield* hook.trigger({ event: "UserPromptSubmit", prompt: "go" }, { sessionID, transcriptPath: "" })
      expect(result.additionalContexts).toEqual([`${instance.directory}/a b|x`])
    }),
  )

  test("the exec command itself and PowerShell shell form rewrite placeholders", () => {
    const exec: HookCommand = { type: "command", command: "${CLAUDE_PROJECT_DIR}/bin/check", args: [] }
    expect(expandHookCommand(exec, { cwd: "/p q" })).toBe("/p q/bin/check")
    const shell: HookCommand = {
      type: "command",
      command: '& "${CLAUDE_PROJECT_DIR}\\h.ps1" ${CLAUDE_PLUGIN_ROOT} $env:CLAUDE_PROJECT_DIR',
      shell: "powershell",
    }
    expect(expandHookCommand(shell, { cwd: "/p", powershell: true })).toBe(
      '& "${env:CLAUDE_PROJECT_DIR}\\h.ps1" ${env:CLAUDE_PLUGIN_ROOT} $env:CLAUDE_PROJECT_DIR',
    )
    // POSIX shell form keeps the placeholder for the shell's own (quoted) expansion.
    expect(expandHookCommand({ type: "command", command: 'sh "${CLAUDE_PROJECT_DIR}/x"' }, { cwd: "/p q" })).toBe(
      'sh "${CLAUDE_PROJECT_DIR}/x"',
    )
  })

  const windows = (present: string[], env: Record<string, string> = {}): ShellProbe => ({
    platform: "win32",
    env: { PATH: "C:\\Tools;C:\\Program Files\\Git\\cmd", ProgramFiles: "C:\\Program Files", ...env },
    exists: (file) => present.includes(file),
  })

  test("Windows defaults to a real Git Bash, otherwise PowerShell", () => {
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe"
    expect(resolveHookShell({}, windows([gitBash]))).toEqual({ kind: "bash", file: gitBash })
    expect(resolveHookShell({}, windows([]))).toEqual({ kind: "powershell", file: "powershell.exe" })
    expect(resolveHookShell({}, windows(["C:\\Tools\\pwsh.exe"]))).toEqual({
      kind: "powershell",
      file: "C:\\Tools\\pwsh.exe",
    })
    // Git on PATH reveals the install root even outside Program Files.
    expect(
      resolveHookShell(
        {},
        {
          platform: "win32",
          env: { PATH: "D:\\dev\\Git\\cmd" },
          exists: (file) => ["D:\\dev\\Git\\cmd\\git.exe", "D:\\dev\\Git\\bin\\bash.exe"].includes(file),
        },
      ),
    ).toEqual({ kind: "bash", file: "D:\\dev\\Git\\bin\\bash.exe" })
    expect(resolveHookShell({ shell: "powershell" }, windows([gitBash])).kind).toBe("powershell")
    expect(resolveHookShell({}, { platform: "linux", env: {}, exists: () => false })).toEqual({
      kind: "sh",
      file: "/bin/sh",
    })
  })
})

describe("cross-audit: onFailure exemptions and exit 2", () => {
  const trigger = (event: HookEvent, hooks: HookCommand[], payload: HookPayload) =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      yield* store.add(sessionID, { event, hooks })
      return yield* hook.trigger(payload, { sessionID, transcriptPath: "" })
    })

  const exempt: [HookEvent, HookPayload][] = [
    ["Stop", { event: "Stop", stopHookActive: false }],
    ["SubagentStop", { event: "SubagentStop", stopHookActive: false }],
    ["TaskCompleted", { event: "TaskCompleted", taskID: "t" }],
    ["TeammateIdle", { event: "TeammateIdle" }],
  ]
  for (const [event, payload] of exempt) {
    it.instance(`${event}: onFailure block ignores failures but a real exit 2 still blocks`, () =>
      Effect.gen(function* () {
        const failed = yield* trigger(event, [node("process.exit(1)", { onFailure: "block" })], payload)
        expect(failed.blocked).toBeUndefined()
        const timedOut = yield* trigger(
          event,
          [node("setTimeout(()=>{},5000)", { onFailure: "block", timeout: 0.2 })],
          payload,
        )
        expect(timedOut.blocked).toBeUndefined()
        const real = yield* trigger(
          event,
          [node("process.stderr.write('stop');process.exit(2)", { onFailure: "block" })],
          payload,
        )
        expect(real.blocked?.reason).toBe("stop")
      }),
    )
  }

  it.instance("onFailure block still blocks PreToolUse and is ignored for async hooks", () =>
    Effect.gen(function* () {
      const blocked = yield* trigger("PreToolUse", [node("process.exit(1)", { onFailure: "block" })], {
        event: "PreToolUse",
        toolName: "Bash",
        toolInput: {},
      })
      expect(blocked.blocked?.reason).toContain("onFailure")
      const background = yield* trigger("PreToolUse", [node("process.exit(1)", { onFailure: "block", async: true })], {
        event: "PreToolUse",
        toolName: "Bash",
        toolInput: {},
      })
      expect(background.blocked).toBeUndefined()
    }),
  )

  it.instance("exit 2 with a missing-file stderr is non-blocking on Stop/SubagentStop/TaskCompleted only", () =>
    Effect.gen(function* () {
      const missing = "process.stderr.write('/x/hook.sh: No such file or directory');process.exit(2)"
      for (const [event, payload] of exempt.slice(0, 3)) {
        expect((yield* trigger(event, [node(missing)], payload)).blocked).toBeUndefined()
        // Output on stdout or a different stderr is still a real block.
        expect((yield* trigger(event, [node("process.stdout.write('x');" + missing)], payload)).blocked).toBeDefined()
        expect(
          (yield* trigger(event, [node("process.stderr.write('policy says no');process.exit(2)")], payload)).blocked
            ?.reason,
        ).toBe("policy says no")
      }
      const pre = yield* trigger("PreToolUse", [node(missing)], {
        event: "PreToolUse",
        toolName: "Bash",
        toolInput: {},
      })
      expect(pre.blocked).toBeDefined()
    }),
  )
})

describe("cross-audit: stdout classification", () => {
  test("follows the reference table", () => {
    expect(classifyStdout("").kind).toBe("plain")
    expect(classifyStdout("hello").kind).toBe("plain")
    // A truncated object and non-object JSON are plain text, not failures.
    expect(classifyStdout('{"decision": "bl').kind).toBe("plain")
    expect(classifyStdout("[1,2]").kind).toBe("plain")
    expect(classifyStdout('"text"').kind).toBe("plain")
    // A multi-line object is one JSON object.
    expect(classifyStdout('{\n  "systemMessage": "m"\n}\n').kind).toBe("json")
    // Schema-invalid and unparsable-but-braced output are failures.
    expect(classifyStdout('{"continue": "yes"}').kind).toBe("invalid")
    expect(classifyStdout("{ not json }").kind).toBe("invalid")
    // Several JSON lines: plain unless a line sets an output field.
    expect(classifyStdout('{"level":"info"}\n{"n":1}').kind).toBe("plain")
    expect(classifyStdout('{"level":"info"}\n{"systemMessage":"x"}').kind).toBe("invalid")
  })

  it.instance("truncated JSON on an eligible event is plain context, a schema failure is not", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      yield* store.add(sessionID, {
        event: "UserPromptSubmit",
        hooks: [node("process.stdout.write('{\"hookSpecificOutput\": ')")],
      })
      const plain = yield* hook.trigger({ event: "UserPromptSubmit", prompt: "p" }, { sessionID, transcriptPath: "" })
      expect(plain.additionalContexts).toEqual(['{"hookSpecificOutput":'])

      const other = SessionID.descending()
      yield* store.add(other, {
        event: "UserPromptSubmit",
        hooks: [node(stdoutJSON({ continue: "yes" }) + ";process.stdout.write('')")],
      })
      const invalid = yield* hook.trigger(
        { event: "UserPromptSubmit", prompt: "p" },
        { sessionID: other, transcriptPath: "" },
      )
      expect(invalid.additionalContexts).toEqual([])
      expect(invalid.preventContinuation).toBeUndefined()
    }),
  )

  it.instance("a schema-invalid object does not consume once; a valid result does", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      yield* store.add(sessionID, {
        event: "UserPromptSubmit",
        once: true,
        hooks: [node(stdoutJSON({ continue: "yes" }))],
      })
      yield* hook.trigger({ event: "UserPromptSubmit", prompt: "p" }, { sessionID, transcriptPath: "" })
      expect(yield* store.list(sessionID, "UserPromptSubmit")).toHaveLength(1)

      const good = SessionID.descending()
      yield* store.add(good, { event: "UserPromptSubmit", once: true, hooks: [node(stdoutJSON({}))] })
      yield* hook.trigger({ event: "UserPromptSubmit", prompt: "p" }, { sessionID: good, transcriptPath: "" })
      expect(yield* store.list(good, "UserPromptSubmit")).toHaveLength(0)
    }),
  )

  it.instance("an MCP parser failure is not a success and keeps once", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      const mcp = Layer.mock(MCP.Service, {
        tools: () =>
          Effect.succeed({
            audit_check: tool({
              inputSchema: jsonSchema({ type: "object", properties: {} }),
              execute: async () => ({ content: [{ type: "text", text: '{"continue":"yes"}' }] }),
            }),
          }),
      })
      yield* store.add(sessionID, {
        event: "UserPromptSubmit",
        once: true,
        hooks: [{ type: "mcp_tool", server: "audit", tool: "check" }],
      })
      const result = yield* hook
        .trigger({ event: "UserPromptSubmit", prompt: "p" }, { sessionID, transcriptPath: "" })
        .pipe(Effect.provide(mcp))
      expect(result.additionalContexts).toEqual([])
      expect(yield* store.list(sessionID, "UserPromptSubmit")).toHaveLength(1)
    }),
  )
})

describe("cross-audit: PreToolUse decision precedence", () => {
  const run = (hooks: HookCommand[]) =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      yield* store.add(sessionID, { event: "PreToolUse", hooks })
      return yield* hook.trigger(
        { event: "PreToolUse", toolName: "Bash", toolInput: { command: "pwd" } },
        { sessionID, transcriptPath: "" },
      )
    })
  const pre = (permissionDecision: string, reason?: string, extra: Record<string, unknown> = {}) =>
    stdoutJSON({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision,
        ...(reason ? { permissionDecisionReason: reason } : {}),
        ...extra,
      },
    })

  it.instance("an exit 2 hook denies even when another hook defers or its own JSON allows", () =>
    Effect.gen(function* () {
      for (const order of [0, 1]) {
        const defer = node(pre("defer"))
        const failing = node(
          `${pre("allow", "ALLOW REASON", { updatedInput: { command: "evil" } })};process.stderr.write('stderr reason');process.exit(2)`,
        )
        const result = yield* run(order === 0 ? [defer, failing] : [failing, defer])
        expect(result.permissionDecision).toBe("deny")
        expect(result.permissionDecisionReason).toBe("stderr reason")
        expect(result.blocked?.reason).toBe("stderr reason")
        expect(result.updatedInput).toBeUndefined()
      }
    }),
  )

  it.instance("a blocking JSON reason beats stderr on exit 2", () =>
    Effect.gen(function* () {
      const result = yield* run([node(`${pre("deny", "json reason")};process.stderr.write('stderr');process.exit(2)`)])
      expect(result.blocked?.reason).toBe("json reason")
      const legacy = yield* run([
        node(
          `${stdoutJSON({ decision: "block", reason: "legacy reason" })};process.stderr.write('stderr');process.exit(2)`,
        ),
      ])
      expect(legacy.blocked?.reason).toBe("legacy reason")
    }),
  )

  it.instance("deprecated top-level approve/block map to allow/deny and hookSpecificOutput wins", () =>
    Effect.gen(function* () {
      const approve = yield* run([node(stdoutJSON({ decision: "approve", reason: "fine" }))])
      expect(approve.permissionDecision).toBe("allow")
      const block = yield* run([node(stdoutJSON({ decision: "block", reason: "nope" }))])
      expect(block.permissionDecision).toBe("deny")
      expect(block.permissionDecisionReason).toBe("nope")
      const both = yield* run([
        node(
          stdoutJSON({
            decision: "block",
            reason: "top",
            hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" },
          }),
        ),
      ])
      expect(both.permissionDecision).toBe("ask")
    }),
  )
})

describe("cross-audit: PermissionRequest decisions from MCP hooks", () => {
  it.instance("mcp and mcp_tool entries may return the nested decision object", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      const text = JSON.stringify({
        hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
      })
      const mcp = Layer.mock(MCP.Service, {
        tools: () =>
          Effect.succeed({
            audit_check: tool({
              inputSchema: jsonSchema({ type: "object", properties: {} }),
              execute: async () => ({ content: [{ type: "text", text }] }),
            }),
          }),
      })
      for (const entry of [
        { type: "mcp_tool", server: "audit", tool: "check" },
        { type: "mcp", command: "mcp__audit__check" },
      ] as const) {
        yield* store.add(sessionID, { event: "PermissionRequest", hooks: [entry] })
        const result = yield* hook
          .trigger({ event: "PermissionRequest", toolName: "Bash", toolInput: {} }, { sessionID, transcriptPath: "" })
          .pipe(Effect.provide(mcp))
        expect(result.permissionRequestDecision).toEqual({ behavior: "allow" })
        yield* store.clear(sessionID)
      }
    }),
  )
})

describe("cross-audit: grandchild holding the output pipe", () => {
  const MARK = "sleep 597.41"
  it.instance(
    "an allow followed by an unredirected background process is refused",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        const store = yield* SessionHooks.Service
        const hook = yield* SettingsHook.Service
        const sessionID = SessionID.descending()
        const allow = JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
        })
        yield* store.add(sessionID, {
          event: "PreToolUse",
          hooks: [{ type: "command", command: `printf '%s' '${allow}'; ${MARK} &` }],
        })
        const result = yield* hook.trigger(
          { event: "PreToolUse", toolName: "Bash", toolInput: {} },
          { sessionID, transcriptPath: "" },
        )
        expect(result.blocked?.reason).toContain("suspect capture")
        expect(result.permissionDecision).toBe("deny")
        yield* Effect.sync(() => spawnSync("pkill", ["-f", MARK]))
      }),
    { timeout: 30_000 },
  )

  it.instance(
    "a redirected background process leaves the allow intact",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        const store = yield* SessionHooks.Service
        const hook = yield* SettingsHook.Service
        const sessionID = SessionID.descending()
        const allow = JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
        })
        yield* store.add(sessionID, {
          event: "PreToolUse",
          hooks: [{ type: "command", command: `printf '%s' '${allow}'; sleep 597.42 >/dev/null 2>&1 &` }],
        })
        const result = yield* hook.trigger(
          { event: "PreToolUse", toolName: "Bash", toolInput: {} },
          { sessionID, transcriptPath: "" },
        )
        expect(result.blocked).toBeUndefined()
        expect(result.permissionDecision).toBe("allow")
        yield* Effect.sync(() => spawnSync("pkill", ["-f", "sleep 597.42"]))
      }),
    { timeout: 30_000 },
  )
})

describe("cross-audit: canonical tool identity", () => {
  const echoStdin =
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:d}})))"
  const run = (
    entry: HookCommand,
    matcher: string | undefined,
    payload: HookPayload,
    ctx: Record<string, unknown> = {},
  ) =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      yield* store.add(sessionID, { event: payload.event as "PostToolUse", matcher, hooks: [entry] })
      const result = yield* hook.trigger(payload, { sessionID, transcriptPath: "", ...ctx })
      return result.additionalContexts[0] ? JSON.parse(result.additionalContexts[0]) : undefined
    })
  const post = (toolName: string): HookPayload => ({
    event: "PostToolUse",
    toolName,
    toolInput: {},
    toolResponse: "ok",
    durationMs: 12,
  })

  it.instance("matchers accept the official name and the native id", () =>
    Effect.gen(function* () {
      const ctx = { canonicalToolName: "mcp__srv__lookup", mcpServer: { name: "srv", source: "project" } }
      const entry = node(echoStdin)
      const official = yield* run(entry, "^mcp__srv__lookup$", post("srv_lookup"), ctx)
      expect(official.tool_name).toBe("srv_lookup")
      expect(official.mcp_server).toEqual({ name: "srv", source: "project" })
      expect(official.duration_ms).toBe(12)
      expect(yield* run(entry, "srv_lookup", post("srv_lookup"), ctx)).toBeDefined()
      expect(yield* run(entry, "^other$", post("srv_lookup"), ctx)).toBeUndefined()
      // Builtins use the official names without any runtime hint.
      expect(yield* run(entry, "Agent", post("task"))).toBeDefined()
      expect(yield* run(entry, "WebFetch", post("webfetch"))).toBeDefined()
      expect(yield* run(entry, "AskUserQuestion", post("question"))).toBeDefined()
      expect(yield* run(entry, "^Bash$", post("bash"))).toBeDefined()
    }),
  )

  it.instance("claude-code format reports the canonical name while native format keeps the native id", () =>
    Effect.gen(function* () {
      const ctx = { canonicalToolName: "mcp__srv__lookup" }
      const claude = yield* run({ ...node(echoStdin), inputFormat: "claude-code" }, undefined, post("srv_lookup"), ctx)
      expect(claude.tool_name).toBe("mcp__srv__lookup")
      const native = yield* run(node(echoStdin), undefined, post("srv_lookup"), ctx)
      expect(native.tool_name).toBe("srv_lookup")
      const task = yield* run({ ...node(echoStdin), inputFormat: "claude-code" }, undefined, post("task"))
      expect(task.tool_name).toBe("Agent")
    }),
  )

  it.instance("if conditions use the official name", () =>
    Effect.gen(function* () {
      const entry = { ...node(echoStdin), if: "mcp__srv__lookup" }
      const ctx = { canonicalToolName: "mcp__srv__lookup" }
      expect(yield* run(entry, undefined, post("srv_lookup"), ctx)).toBeDefined()
      expect(yield* run({ ...entry, if: "Agent" }, undefined, post("task"))).toBeDefined()
      expect(yield* run({ ...entry, if: "Agent" }, undefined, post("bash"))).toBeUndefined()
    }),
  )

  it.instance("UserPromptSubmit and ConfigChange inputs carry the official fields", () =>
    Effect.gen(function* () {
      const echo = (name: string) =>
        node(
          `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'${name}',additionalContext:d}})))`,
        )
      const ups = yield* run(echo("UserPromptSubmit"), undefined, {
        event: "UserPromptSubmit",
        prompt: "p",
        sessionTitle: "custom",
      })
      expect(ups.session_title).toBe("custom")
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      const dump = path.join(os.tmpdir(), `cfg-${crypto.randomUUID()}.json`)
      const sink = `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>require('node:fs').writeFileSync(process.argv[1],d))`
      yield* store.add(sessionID, {
        event: "ConfigChange",
        hooks: [node(sink, { args: ["-e", sink, dump] })],
      })
      yield* hook.trigger(
        { event: "ConfigChange", source: "project_settings", configPath: "/x/hooks.json" },
        { sessionID, transcriptPath: "" },
      )
      const stdin = JSON.parse(yield* Effect.promise(() => fs.readFile(dump, "utf8")))
      expect(stdin.file_path).toBe("/x/hooks.json")
      expect(stdin.config_path).toBe("/x/hooks.json")
      yield* Effect.promise(() => fs.rm(dump, { force: true }))
    }),
  )
})

describe("cross-audit: context delivery", () => {
  const context = (event: "UserPromptSubmit" | "SubagentStart" | "PostToolBatch") =>
    node(stdoutJSON({ hookSpecificOutput: { hookEventName: event, additionalContext: "SAME" } }))

  it.instance("UserPromptSubmit and PostToolBatch deliver identical context on every turn", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      yield* store.add(sessionID, { event: "UserPromptSubmit", hooks: [context("UserPromptSubmit")] })
      yield* store.add(sessionID, { event: "PostToolBatch", hooks: [context("PostToolBatch")] })
      const ctx = { sessionID, transcriptPath: "" }
      for (let turn = 0; turn < 2; turn++) {
        expect((yield* hook.trigger({ event: "UserPromptSubmit", prompt: "p" }, ctx)).additionalContexts).toEqual([
          "SAME",
        ])
        expect((yield* hook.trigger({ event: "PostToolBatch", toolCalls: [] }, ctx)).additionalContexts).toEqual([
          "SAME",
        ])
      }
    }),
  )

  it.instance("SubagentStart suppresses only the target child's own earlier copy", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const parent = SessionID.descending()
      yield* store.add(parent, { event: "SubagentStart", hooks: [context("SubagentStart")] })
      const ctx = { sessionID: parent, transcriptPath: "" }
      const start = (agentID: string) =>
        hook
          .trigger({ event: "SubagentStart", agentID, agentType: "general" }, ctx)
          .pipe(Effect.map((r) => r.additionalContexts))
      expect(yield* start("child-a")).toEqual(["SAME"])
      expect(yield* start("child-b")).toEqual(["SAME"])
      expect(yield* start("child-a")).toEqual([])
    }),
  )

  it.instance("ordinary async hooks queue only JSON fields, never plain stdout", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      yield* store.add(sessionID, {
        event: "UserPromptSubmit",
        hooks: [node("process.stdout.write('plain async text')", { async: true })],
      })
      yield* hook.trigger({ event: "UserPromptSubmit", prompt: "p" }, { sessionID, transcriptPath: "" })
      yield* Effect.sleep("300 millis")
      expect((yield* hook.drainAsync!(sessionID)).additionalContexts).toEqual([])
    }),
  )
})
