import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// httpHandler runtime contract against a real local server: configured
// entry.headers MUST reach the wire (auth tokens were silently dropped before
// this fix). A non-2xx response follows the handler's onFailure policy.

const testLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
  Layer.provideMerge(FetchHttpClient.layer),
)
const it = testEffect(testLayer)

const withFetch = <A, E, R>(
  fetch: (req: Request) => Response | Promise<Response>,
  fn: (url: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => fn(server.url.toString()),
    (server) => Effect.sync(() => server.stop(true)),
  )

describe("SettingsHook http handler", () => {
  it.instance("expands only allowed header environment variables on the wire", () =>
    Effect.gen(function* () {
      const store = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const id = SessionID.descending()
      const previous = process.env.OPENCODE_HOOK_HEADER_TEST
      process.env.OPENCODE_HOOK_HEADER_TEST = "fixture-value"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.OPENCODE_HOOK_HEADER_TEST
          else process.env.OPENCODE_HOOK_HEADER_TEST = previous
        }),
      )
      let seen: Headers | undefined
      yield* withFetch(
        (request) => {
          seen = request.headers
          return Response.json({})
        },
        (url) =>
          Effect.gen(function* () {
            yield* store.add(id, {
              event: "UserPromptSubmit",
              hooks: [
                {
                  type: "http",
                  url,
                  allowedEnvVars: ["OPENCODE_HOOK_HEADER_TEST"],
                  headers: {
                    "x-allowed": "Bearer ${OPENCODE_HOOK_HEADER_TEST}",
                    "x-bare": "$OPENCODE_HOOK_HEADER_TEST",
                    "x-denied": "value:${HOME}",
                  },
                },
              ],
            })
            yield* hook.trigger({ event: "UserPromptSubmit", prompt: "hello" }, { sessionID: id, transcriptPath: "" })
            expect(seen?.get("x-allowed")).toBe("Bearer fixture-value")
            expect(seen?.get("x-bare")).toBe("fixture-value")
            expect(seen?.get("x-denied")).toBe("value:")
          }),
      )
    }),
  )

  it.instance("applies configured entry.headers to the outbound POST", () =>
    Effect.gen(function* () {
      const sessionHooks = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      let seen: Headers | undefined
      yield* withFetch(
        (req) => {
          seen = req.headers
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
        },
        (url) =>
          Effect.gen(function* () {
            yield* sessionHooks.add(sessionID, {
              event: "UserPromptSubmit",
              hooks: [
                {
                  type: "http",
                  url,
                  headers: { authorization: "Bearer hook-secret", "x-hook-test": "present" },
                },
              ],
            })
            const r = yield* hook.trigger(
              { event: "UserPromptSubmit", prompt: "hi" },
              { sessionID, transcriptPath: "" },
            )
            expect(r.blocked).toBeUndefined()
            expect(seen).toBeDefined()
            expect(seen?.get("authorization")).toBe("Bearer hook-secret")
            expect(seen?.get("x-hook-test")).toBe("present")
          }),
      )
    }),
  )

  it.instance("non-2xx response continues by default and blocks when configured", () =>
    Effect.gen(function* () {
      const sessionHooks = yield* SessionHooks.Service
      const hook = yield* SettingsHook.Service
      const sessionID = SessionID.descending()
      yield* withFetch(
        () => new Response("nope", { status: 500 }),
        (url) =>
          Effect.gen(function* () {
            yield* sessionHooks.add(sessionID, {
              event: "UserPromptSubmit",
              hooks: [{ type: "http", url }],
            })
            const r = yield* hook.trigger(
              { event: "UserPromptSubmit", prompt: "hi" },
              { sessionID, transcriptPath: "" },
            )
            expect(r.blocked).toBeUndefined()
            yield* sessionHooks.add(sessionID, {
              event: "UserPromptSubmit",
              hooks: [{ type: "http", url, onFailure: "block" }],
            })
            const blocked = yield* hook.trigger(
              { event: "UserPromptSubmit", prompt: "hi" },
              { sessionID, transcriptPath: "" },
            )
            expect(blocked.blocked?.reason).toContain("500")
          }),
      )
    }),
  )
})

it.instance("Claude HTTP input adapts tool names, output and returned input without changing native siblings", () =>
  Effect.gen(function* () {
    const store = yield* SessionHooks.Service
    const hooks = yield* SettingsHook.Service
    const sessionID = SessionID.descending()
    const seen: any[] = []
    yield* withFetch(
      async (request) => {
        seen.push(await request.json())
        return Response.json({ hookSpecificOutput: { updatedInput: { file_path: "updated.ts" } } })
      },
      (url) =>
        Effect.gen(function* () {
          yield* store.add(sessionID, {
            event: "PreToolUse",
            hooks: [{ type: "http", url, inputFormat: "claude-code" }],
          })
          const pre = yield* hooks.trigger(
            { event: "PreToolUse", toolName: "read", toolInput: { filePath: "a.ts" } },
            { sessionID, transcriptPath: "" },
          )
          expect(seen[0].tool_name).toBe("Read")
          expect(seen[0].tool_input.file_path).toBe("a.ts")
          expect(pre.updatedInput).toEqual({ filePath: "updated.ts" })
          yield* store.add(sessionID, {
            event: "PostToolUse",
            hooks: [
              { type: "http", url, inputFormat: "claude-code" },
              { type: "http", url },
            ],
          })
          yield* hooks.trigger(
            {
              event: "PostToolUse",
              toolName: "bash",
              toolInput: { command: "echo hi" },
              toolResponse: { exit: 0 },
              toolOutput: { title: "echo", output: "hi", metadata: { exit: 0 } },
            },
            { sessionID, transcriptPath: "" },
          )
          expect(seen.find((item) => item.tool_name === "Bash").tool_response.stdout).toBe("hi")
          expect(seen.find((item) => item.tool_name === "bash").tool_response).toEqual({ exit: 0 })
        }),
    )
  }),
)
