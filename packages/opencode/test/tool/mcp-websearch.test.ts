import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { WebSearchTool } from "@/tool/websearch"
import * as McpWebSearch from "@/tool/mcp-websearch"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_search_contract"),
  messageID: MessageID.make("msg_search_contract"),
  callID: "search",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}
const requests: { url: string; key: string | undefined; inspected: string }[] = []
let status = 200
let reply = ""
const http = HttpClient.make((request) => {
  requests.push({ url: request.url, key: request.headers["x-api-key"], inspected: JSON.stringify(request) })
  return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(reply, { status })))
})
const it = testEffect(
  Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, http),
    Truncate.defaultLayer,
    Agent.defaultLayer,
    RuntimeFlags.layer(),
  ),
)
const success = (text: string) => JSON.stringify({ result: { content: [{ type: "text", text }] } })

it.instance("Exa keys are read per request, sent only in redacted headers, and scrubbed from errors", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      requests.length = 0
      return { key: process.env.EXA_API_KEY, provider: process.env.OPENCODE_WEBSEARCH_PROVIDER }
    }),
    () =>
      Effect.gen(function* () {
        process.env.OPENCODE_WEBSEARCH_PROVIDER = "exa"
        const info = yield* WebSearchTool
        const tool = yield* info.init()
        for (const key of ["synthetic-first/key", "synthetic-second+key"]) {
          process.env.EXA_API_KEY = key
          status = 200
          reply = success("search results")
          expect((yield* tool.execute({ query: "test" }, ctx)).output).toBe("search results")
          const request = requests.at(-1)!
          expect(request.key).toBe(key)
          expect(request.url).toBe(McpWebSearch.EXA_URL)
          expect(request.url).not.toContain("exaApiKey")
          expect(request.inspected).not.toContain(key)
          for (const body of [
            JSON.stringify({
              error: {
                code: -32000,
                message: `Quota exceeded for https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(key)}`,
              },
            }),
            `data: ${JSON.stringify({ error: { code: -32000, message: `Quota exceeded for ${key}` } })}\n\n`,
          ]) {
            reply = body
            const exit = yield* tool.execute({ query: "test" }, ctx).pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (!Exit.isFailure(exit)) throw new Error("expected provider error")
            const error = Cause.pretty(exit.cause)
            expect(error).toContain("Quota exceeded")
            expect(error).toContain("[REDACTED]")
            expect(error).not.toContain(key)
            expect(error).not.toContain(encodeURIComponent(key))
          }
          status = 401
          reply = key
          const failure = yield* tool.execute({ query: "test" }, ctx).pipe(Effect.exit)
          expect(Exit.isFailure(failure)).toBe(true)
          if (Exit.isFailure(failure)) {
            expect(Cause.pretty(failure.cause)).toContain("401")
            expect(Cause.pretty(failure.cause)).not.toContain(key)
          }
        }
      }),
    (original) =>
      Effect.sync(() => {
        if (original.key === undefined) delete process.env.EXA_API_KEY
        else process.env.EXA_API_KEY = original.key
        if (original.provider === undefined) delete process.env.OPENCODE_WEBSEARCH_PROVIDER
        else process.env.OPENCODE_WEBSEARCH_PROVIDER = original.provider
      }),
  ),
)

describe("MCP search failures", () => {
  for (const [reply, message] of [
    [{ error: { code: -32602, message: "Invalid search query" } }, "MCP search error (-32602): Invalid search query"],
    [{ result: { isError: true, content: [{ type: "text", text: "Provider unavailable" }] } }, "Provider unavailable"],
  ] as const) {
    test(message, async () => {
      const exit = await Effect.runPromiseExit(McpWebSearch.parseResponse(JSON.stringify(reply)))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(message)
    })
  }
})
