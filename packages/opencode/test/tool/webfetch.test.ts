import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Parameters, WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(FetchHttpClient.layer, Truncate.defaultLayer, Agent.defaultLayer))

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const withFetch = <A, E, R>(
  fetch: (req: Request) => Response | Promise<Response>,
  fn: (url: URL) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => fn(server.url),
    (server) => Effect.sync(() => server.stop(true)),
  )

const exec = Effect.fn("WebFetchToolTest.exec")(function* (args: Tool.InferParameters<typeof WebFetchTool>) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

describe("tool.webfetch", () => {
  it.instance("returns image responses as file attachments", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      yield* withFetch(
        () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
        (url) =>
          Effect.gen(function* () {
            const result = yield* exec({ url: new URL("/image.png", url).toString(), format: "markdown" })
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          }),
      )
    }),
  )

  it.instance("keeps svg as text output", () =>
    withFetch(
      () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>', {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/image.svg", url).toString(), format: "html" })
          expect(result.output).toContain("<svg")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("keeps text responses as text output", () =>
    withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text" })
          expect(result.output).toBe("hello from webfetch")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("extracts text from html without scripts or styles", () =>
    withFetch(
      () =>
        new Response(
          "<html><head><style>.hidden{}</style><script>alert('x')</script></head><body>Hello <b>world</b></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/page.html", url).toString(), format: "text" })
          expect(result.output).toBe("Hello world")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )
})

for (const timeout of [0, -1, Infinity, NaN]) {
  test(`webfetch rejects timeout ${timeout}`, () => {
    expect(() => Schema.decodeUnknownSync(Parameters)({ url: "https://example.com", timeout })).toThrow()
  })
}

it.instance("honors a supported declared charset", () =>
  withFetch(
    () =>
      new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
        headers: { "content-type": 'text/plain; charset="iso-8859-1"' },
      }),
    (url) =>
      Effect.gen(function* () {
        expect((yield* exec({ url: url.href, format: "text" })).output).toBe("café")
      }),
  ),
)

it.instance("refuses binary responses instead of decoding them as text", () =>
  withFetch(
    (req) =>
      new URL(req.url).pathname === "/doc.pdf"
        ? new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x0a, 0xff]), {
            headers: { "content-type": "application/pdf" },
          })
        : new Response(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]), {
            headers: { "content-type": "" },
          }),
    (url) =>
      Effect.gen(function* () {
        for (const file of ["/doc.pdf", "/program"]) {
          const exit = yield* exec({ url: new URL(file, url).href, format: "text" }).pipe(Effect.exit)
          expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain("The response is binary")
        }
      }),
  ),
)

it.instance("keeps json responses as text output", () =>
  withFetch(
    () => new Response('{"ok":true}', { headers: { "content-type": "application/vnd.api+json" } }),
    (url) =>
      Effect.gen(function* () {
        expect((yield* exec({ url: url.href, format: "text" })).output).toBe('{"ok":true}')
      }),
  ),
)

it.instance("rejects unsupported charsets explicitly", () =>
  withFetch(
    () => new Response("text", { headers: { "content-type": "text/plain; charset=not-a-charset" } }),
    (url) =>
      Effect.gen(function* () {
        const exit = yield* exec({ url: url.href, format: "text" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain("Unsupported response charset")
      }),
  ),
)

for (const mode of ["slow", "oversize"] as const) {
  it.instance(`aborts a ${mode} streamed body without waiting for its completion`, () =>
    Effect.gen(function* () {
      let produced = 0
      let cancelled = false
      let timer: ReturnType<typeof setInterval> | undefined
      yield* withFetch(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const chunk = new Uint8Array(mode === "slow" ? 1 : 64 * 1024)
                controller.enqueue(chunk)
                timer = setInterval(
                  () => {
                    produced++
                    controller.enqueue(chunk)
                    if (produced === 200) {
                      clearInterval(timer)
                      controller.close()
                    }
                  },
                  mode === "slow" ? 100 : 2,
                )
              },
              cancel() {
                cancelled = true
                clearInterval(timer)
              },
            }),
            { headers: { "content-type": "text/plain" } },
          ),
        (url) =>
          Effect.gen(function* () {
            const started = Date.now()
            const exit = yield* exec({ url: url.href, format: "text", timeout: mode === "slow" ? 0.05 : 5 }).pipe(
              Effect.exit,
            )
            expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain(
              mode === "slow" ? "Request timed out" : "Response too large",
            )
            expect(Date.now() - started).toBeLessThan(3000)
            yield* Effect.promise(() => Bun.sleep(100))
            expect(cancelled).toBe(true)
            expect(produced).toBeLessThan(200)
          }),
      )
    }),
  )
}
