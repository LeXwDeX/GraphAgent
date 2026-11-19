import { describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { Agent } from "../../src/agent/agent"
import { DelegationHint } from "@/tool/delegation-hint"
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

  it.instance("says a timeout above the maximum was capped and records clamped (#1451)", () =>
    withFetch(
      () => new Response("hello", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }),
      (url) =>
        Effect.gen(function* () {
          const target = new URL("/file.txt", url).toString()

          const capped = yield* exec({ url: target, format: "text", timeout: 300_000 })
          expect(capped.output).toBe("hello\n\nNote: timeout 300000 is above the maximum 120000; 120000 was used.")
          expect(capped.metadata).toMatchObject({ corrections: ["clamped"] })

          const exact = yield* exec({ url: target, format: "text", timeout: 120_000 })
          expect(exact.output).toBe("hello")
          expect(exact.metadata).not.toHaveProperty("corrections")
        }),
    ),
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

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x0a, 0xff])
const savedPath = (output: string) => /read filePath="([^"]+)"/.exec(output)?.[1]

/** Fetches `body` as `contentType`, expects a saved PDF, and removes the saved file afterwards (#1454). */
const savedPdf = (contentType: string, body: Uint8Array<ArrayBuffer> = PDF) =>
  withFetch(
    () => new Response(body, { headers: { "content-type": contentType } }),
    (url) =>
      Effect.gen(function* () {
        const result = yield* exec({ url: new URL("/doc", url).href, format: "text" })
        const file = savedPath(result.output)
        if (file === undefined) throw new Error(`no saved file in: ${result.output}`)
        yield* Effect.addFinalizer(() => Effect.promise(() => rm(file, { force: true })))
        expect(result.output).toBe(
          `The response is a PDF (${body.byteLength} bytes), saved to ${file}. Read it with: read filePath="${file}"`,
        )
        // The tool wrapper marks a result that fits as not truncated; the PDF's note is short, so it fits.
        expect(result.metadata).toEqual({ truncated: false })
        expect(result.attachments).toBeUndefined()
        expect(path.dirname(file)).toBe(Truncate.DIR)
        expect(path.basename(file).startsWith("tool_")).toBe(true)
        expect(file.endsWith(".pdf")).toBe(true)
        expect(new Uint8Array(yield* Effect.promise(() => Bun.file(file).arrayBuffer()))).toEqual(body)
      }),
  )

it.instance("saves a PDF response to a file and says how to read it (#1454)", () => savedPdf("application/pdf"))

it.instance("saves a PDF served under another content type, found by its first bytes (#1454)", () =>
  savedPdf("application/octet-stream"),
)

it.instance("saves a response declared as a PDF whatever its bytes are (#1454)", () =>
  savedPdf("Application/PDF; charset=binary", new Uint8Array([0x00, 0x01, 0x02])),
)

it.instance(
  "a page cut at the output cap names its saved copy, which the delegation line gives a researcher (#1454)",
  () =>
    withFetch(
      () =>
        new Response(Array.from({ length: 3000 }, (_, index) => `line ${index}`).join("\n"), {
          headers: { "content-type": "text/plain" },
        }),
      (url) =>
        Effect.gen(function* () {
          const target = new URL("/long.txt", url).href
          // The wrapper adds `truncated` and `outputPath` beyond the `{}` the tool itself returns.
          const metadata: Record<string, unknown> = (yield* exec({ url: target, format: "text" })).metadata
          const saved = metadata.outputPath
          if (typeof saved !== "string") throw new Error("the cut page has no saved copy")
          yield* Effect.addFinalizer(() => Effect.promise(() => rm(saved, { force: true })))
          expect(metadata.truncated).toBe(true)
          expect(DelegationHint.hintOf("webfetch", { url: target, format: "text" }, metadata)).toEqual({
            agent: "researcher",
            path: saved,
          })
        }),
    ),
)

it.instance("refuses other binary responses instead of decoding them as text", () =>
  withFetch(
    (req) =>
      new URL(req.url).pathname === "/archive.zip"
        ? new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { headers: { "content-type": "application/zip" } })
        : new Response(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]), { headers: { "content-type": "" } }),
    (url) =>
      Effect.gen(function* () {
        for (const file of ["/archive.zip", "/program"]) {
          const exit = yield* exec({ url: new URL(file, url).href, format: "text" }).pipe(Effect.exit)
          expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain("The response is binary")
        }
      }),
  ),
)

it.instance("inspects generic octet-stream bodies instead of rejecting readable text", () =>
  withFetch(
    () => new Response("export const answer = 42\n", { headers: { "content-type": "application/octet-stream" } }),
    (url) =>
      Effect.gen(function* () {
        expect((yield* exec({ url: url.href, format: "text" })).output).toBe("export const answer = 42\n")
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
            const exit = yield* exec({ url: url.href, format: "text", timeout: mode === "slow" ? 50 : 5000 }).pipe(
              Effect.exit,
            )
            expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain(
              mode === "slow" ? "Request timed out after 50 ms" : "Response too large",
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
