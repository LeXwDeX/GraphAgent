import { decodeRecord } from "../lib/hook-json"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const layer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
  Layer.provideMerge(FetchHttpClient.layer),
)
const it = testEffect(layer)

describe("hook HTTP transport", () => {
  it.instance("posts the event envelope and treats HTTP 500 as nonblocking unless onFailure is block", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const seen: { body: unknown; unlisted: string | null }[] = []
        const server = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          async fetch(request) {
            seen.push({ body: await request.json(), unlisted: request.headers.get("x-unlisted") })
            return new Response("unavailable", { status: 500 })
          },
        })
        return { server, seen }
      }),
      ({ server, seen }) =>
        Effect.gen(function* () {
          const store = yield* SessionHooks.Service
          const hook = yield* SettingsHook.Service
          const sessionID = SessionID.descending()
          const url = server.url.toString()
          yield* store.add(sessionID, {
            event: "PreToolUse",
            hooks: [{ type: "http", url, headers: { "x-unlisted": "$HOME" } }],
          })
          const allowed = yield* hook.trigger(
            { event: "PreToolUse", toolName: "Bash", toolInput: { command: "pwd" } },
            { sessionID, transcriptPath: "" },
          )
          expect(allowed.blocked).toBeUndefined()
          expect(seen).toHaveLength(1)
          expect(decodeRecord(seen[0].body).hook_event_name).toBe("PreToolUse")
          expect(seen[0].unlisted).toBe("")
          yield* store.add(sessionID, { event: "UserPromptSubmit", hooks: [{ type: "http", url, onFailure: "block" }] })
          const denied = yield* hook.trigger(
            { event: "UserPromptSubmit", prompt: "hello" },
            { sessionID, transcriptPath: "" },
          )
          expect(denied.blocked?.reason).toContain("500")
        }),
      ({ server }) => Effect.sync(() => server.stop(true)),
    ),
  )
})
