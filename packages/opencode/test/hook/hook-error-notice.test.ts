import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { SettingsHook, type HookCommand, type HookPayload } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MCP } from "@/mcp"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { LegacyEvent } from "@opencode-ai/schema/legacy-event"
import { decodeRecord, decodeString } from "../lib/hook-json"
import { testEffect } from "../lib/effect"

const layer = SettingsHook.layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(Layer.mock(MCP.Service, { tools: () => Effect.succeed({}) })),
)
const it = testEffect(layer)

const node = (script: string, extra: Partial<HookCommand> = {}): HookCommand => ({
  type: "command",
  command: process.execPath,
  args: ["-e", script],
  ...extra,
})

const preTool: HookPayload = { event: "PreToolUse", toolName: "Bash", toolInput: { command: "true" } }

const trigger = (hooks: HookCommand[], options: { payload?: HookPayload; matcher?: string } = {}) =>
  Effect.gen(function* () {
    const store = yield* SessionHooks.Service
    const hook = yield* SettingsHook.Service
    const sessionID = SessionID.descending()
    const payload = options.payload ?? preTool
    yield* store.add(sessionID, {
      event: payload.event,
      ...(options.matcher ? { matcher: options.matcher } : {}),
      hooks,
    })
    const result = yield* hook.trigger(payload, { sessionID, transcriptPath: "" })
    return { result, sessionID }
  })

// Reference parity: a hook that fails without blocking still has to be visible.
// Today these failures only reach log.warn, so a mistyped command or a dead
// endpoint silently stops firing for the rest of the session.
describe("non-blocking hook failures leave a transcript notice", () => {
  it.instance("a nonzero exit reports `<event>:<matcher> hook error` with its stderr", () =>
    Effect.gen(function* () {
      const { result } = yield* trigger([node("process.stderr.write('script exploded');process.exit(1)")], {
        matcher: "Bash",
      })
      expect(result.blocked).toBeUndefined()
      expect(result.hookErrors).toEqual(["PreToolUse:Bash hook error: script exploded"])
    }),
  )

  it.instance("a spawn failure is reported instead of disappearing into the log", () =>
    Effect.gen(function* () {
      const { result } = yield* trigger([{ type: "command", command: "/nonexistent/graphagent-hook", args: ["x"] }])
      expect(result.blocked).toBeUndefined()
      expect(result.hookErrors).toHaveLength(1)
      expect(result.hookErrors?.[0]).toContain("PreToolUse hook error:")
      expect(result.hookErrors?.[0]).toContain("/nonexistent/graphagent-hook")
    }),
  )

  it.instance("a timeout is reported with the configured budget", () =>
    Effect.gen(function* () {
      const { result } = yield* trigger([node("setTimeout(()=>{},5000)", { timeout: 0.2 })])
      expect(result.blocked).toBeUndefined()
      expect(result.hookErrors).toEqual(["PreToolUse hook error: hook timed out after 0.2s"])
    }),
  )

  it.instance("invalid JSON is reported", () =>
    Effect.gen(function* () {
      const { result } = yield* trigger([node("process.stdout.write('{not valid json}')")])
      expect(result.blocked).toBeUndefined()
      expect(result.hookErrors).toEqual(["PreToolUse hook error: hook returned invalid JSON"])
    }),
  )

  it.instance("an HTTP failure is reported and still only blocks under onFailure", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("unavailable", { status: 500 }) }),
      ),
      (server) =>
        Effect.gen(function* () {
          const failed = yield* trigger([{ type: "http", url: server.url.toString() }])
          expect(failed.result.blocked).toBeUndefined()
          expect(failed.result.hookErrors).toEqual(["PreToolUse hook error: hook returned status 500"])
          const blocked = yield* trigger([{ type: "http", url: server.url.toString(), onFailure: "block" }])
          expect(blocked.result.blocked?.reason).toContain("500")
          expect(blocked.result.hookErrors).toBeUndefined()
        }),
      (server) => Effect.sync(() => server.stop(true)),
    ),
  )

  it.instance("an MCP hook failure is reported", () =>
    Effect.gen(function* () {
      const { result } = yield* trigger([{ type: "mcp_tool", server: "srv", tool: "missing" }])
      expect(result.blocked).toBeUndefined()
      expect(result.hookErrors).toEqual(["PreToolUse hook error: MCP hook tool not found: mcp__srv__missing"])
    }),
  )

  it.instance("a missing-file exit 2 stays non-blocking and is reported", () =>
    Effect.gen(function* () {
      const { result } = yield* trigger(
        [node("process.stderr.write('/x/hook.sh: No such file or directory');process.exit(2)")],
        { payload: { event: "Stop", stopHookActive: false } },
      )
      expect(result.blocked).toBeUndefined()
      expect(result.hookErrors).toEqual(["Stop hook error: /x/hook.sh: No such file or directory"])
    }),
  )

  it.instance("blocking failures keep their existing semantics and add no notice", () =>
    Effect.gen(function* () {
      const blocked = yield* trigger([node("process.stderr.write('boom');process.exit(1)", { onFailure: "block" })])
      expect(blocked.result.blocked?.reason).toContain("boom")
      expect(blocked.result.hookErrors).toBeUndefined()
      const exitTwo = yield* trigger([node("process.stderr.write('policy says no');process.exit(2)")])
      expect(exitTwo.result.blocked?.reason).toBe("policy says no")
      expect(exitTwo.result.hookErrors).toBeUndefined()
    }),
  )

  it.instance("the notice lands on the session's hook-message channel", () =>
    Effect.gen(function* () {
      const { result, sessionID } = yield* trigger([node("process.stderr.write('script exploded');process.exit(1)")])
      const events = yield* EventV2Bridge.Service
      const notices: string[] = []
      const off = yield* events.listen((event) => {
        if (event.type === LegacyEvent.HookMessage.type) {
          const data = decodeRecord(event.data)
          if (data.sessionID === sessionID) notices.push(decodeString(data.message))
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => (typeof off === "function" ? Effect.sync(off) : off))
      yield* SettingsHook.landSystemMessages(result, { sessionID })
      expect(notices).toEqual(["PreToolUse hook error: script exploded"])
    }),
  )
})
