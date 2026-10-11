import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { CodexAuthPlugin } from "../../src/plugin/openai/codex"
import { OpenAIWebSocketPool, TITLE_HEADER } from "../../src/plugin/openai/ws-pool"

const originalHeaders = {
  authorization: "Bearer synthetic-original",
  "x-private": "synthetic-private",
  "X-Opencode-Title": "original-marker",
}

function withPreconnect(fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return Object.assign(fn, { preconnect() {} })
}

function createHTTPTransport(options: {
  httpFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}) {
  return OpenAIWebSocketPool.createWebSocketFetch({ httpFetch: withPreconnect(options.httpFetch) })
}

function headerCase(name: string) {
  const original: Record<string, string> =
    name === "inherited title only"
      ? { [TITLE_HEADER]: "true" }
      : name === "inherited clean"
        ? { "x-ordinary": "retained" }
        : originalHeaders
  const marker: Record<string, string> = name.startsWith("marker") ? { "X-Opencode-Title": "true" } : {}
  const headers: HeadersInit | undefined = name.endsWith("record")
    ? marker
    : name.endsWith("Headers")
      ? new Headers(marker)
      : name.endsWith("tuples")
        ? Object.entries(marker)
        : name === "nonempty override"
          ? { "x-ordinary": "overridden", "x-session-affinity": "retained-session" }
          : undefined
  const expected: Record<string, string> =
    name === "inherited ordinary" || name === "undefined override"
      ? { authorization: "Bearer synthetic-original", "x-private": "synthetic-private" }
      : name === "inherited clean"
        ? { "x-ordinary": "retained" }
        : name === "nonempty override"
          ? { "x-ordinary": "overridden", "x-session-affinity": "retained-session" }
          : {}
  return { original, headers, expected }
}

describe("Request header transport boundary", () => {
  for (const status of [307, 308]) {
    for (const kind of ["string", "Blob", "URLSearchParams"] as const) {
      for (const override of ["inherited", "empty", "marker"] as const) {
        test(`${status} redirect replays ${kind} Request body with ${override} headers`, async () => {
          const received: { method: string; body: string; headers: Headers }[] = []
          using server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
              if (new URL(request.url).pathname === "/redirect") {
                await request.text()
                return new Response(null, { status, headers: { location: "/target" } })
              }
              received.push({ method: request.method, body: await request.text(), headers: request.headers })
              return new Response("replayed")
            },
          })
          const body = () =>
            kind === "string"
              ? "retained-body"
              : kind === "Blob"
                ? new Blob(["retained-body"])
                : new URLSearchParams({ retained: "body" })
          const control = new Request(new URL("/redirect", server.url), { method: "POST", body: body() })
          expect(await (await fetch(control)).text()).toBe("replayed")
          const input = new Request(new URL("/redirect", server.url), {
            method: "POST",
            body: body(),
            headers: override === "inherited" ? { [TITLE_HEADER]: "true" } : originalHeaders,
          })
          const original = Object.fromEntries(input.headers)
          const transport = createHTTPTransport({
            httpFetch: (request, init) => fetch(new Request(request, init)),
          })
          try {
            const init: RequestInit | undefined =
              override === "inherited"
                ? undefined
                : { headers: override === "marker" ? { [TITLE_HEADER]: "true" } : {} }
            expect(await (await transport(input, init)).text()).toBe("replayed")
            expect(received).toHaveLength(2)
            expect(received[1]?.method).toBe("POST")
            expect(received[1]?.body).toBe(received[0]?.body)
            for (const key of ["authorization", "x-private", TITLE_HEADER])
              expect(received[1]?.headers.has(key)).toBe(false)
            expect(Object.fromEntries(input.headers)).toEqual(original)
            expect(input.bodyUsed).toBe(false)
          } finally {
            transport.close()
          }
        })
      }
    }
  }

  for (const route of ["pool HTTP", "OAuth to API HTTP"] as const) {
    for (const name of [
      "marker record",
      "marker Headers",
      "marker tuples",
      "empty record",
      "empty Headers",
      "empty tuples",
      "inherited title only",
      "inherited ordinary",
      "inherited clean",
      "undefined override",
      "nonempty override",
    ]) {
      test(`${route} preserves ${name} when the transport rebuilds Request`, async () => {
        const received: { headers: Headers; body: string; method: string; url: string }[] = []
        using server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            received.push({
              headers: request.headers,
              body: await request.text(),
              method: request.method,
              url: request.url,
            })
            return new Response("ok")
          },
        })
        const fixture = headerCase(name)
        const caller = new AbortController()
        const input = new Request(new URL("/headers?preserved=1", server.url), {
          method: "POST",
          headers: fixture.original,
          body: "retained-body",
          signal: caller.signal,
        })
        const original = Object.fromEntries(input.headers)
        let calls = 0
        const underlying = globalThis.fetch
        const rebuildingFetch = withPreconnect(async (request, init) => {
          calls++
          expect(input.bodyUsed).toBe(false)
          expect(input.body?.locked).toBe(false)
          return underlying(new Request(request, init))
        })
        const pool = route === "pool HTTP" ? createHTTPTransport({ httpFetch: rebuildingFetch }) : undefined
        let oauth = true
        const hooks =
          route === "OAuth to API HTTP"
            ? await CodexAuthPlugin({
                client: createOpencodeClient({ baseUrl: server.url.origin }),
                project: { id: "request-headers", worktree: "", time: { created: 0 } },
                directory: "",
                worktree: "",
                experimental_workspace: { register() {} },
                serverUrl: server.url,
                $,
              })
            : undefined
        const loaded = await hooks?.auth?.loader?.(
          async () =>
            oauth
              ? { type: "oauth", refresh: "synthetic", access: "synthetic", expires: Date.now() + 60_000 }
              : { type: "api", key: "synthetic" },
          { id: "openai", name: "OpenAI", source: "api", env: [], options: {}, models: {} },
        )
        oauth = false
        if (hooks) globalThis.fetch = rebuildingFetch
        try {
          const init =
            name === "inherited title only" || name === "inherited ordinary" || name === "inherited clean"
              ? undefined
              : { headers: fixture.headers }
          const response = pool ? await pool(input, init) : await loaded?.fetch(input, init)
          if (!response) throw new Error("Missing fixture transport")
          expect(await response.text()).toBe("ok")
          expect(calls).toBe(1)
          expect(received).toHaveLength(1)
          const request = received[0]
          if (!request) throw new Error("Missing HTTP request")
          for (const key of ["authorization", "x-private", TITLE_HEADER, "x-ordinary", "x-session-affinity"]) {
            expect(request.headers.get(key)).toBe(new Headers(fixture.expected).get(key))
          }
          expect(request.body).toBe("retained-body")
          expect(request.method).toBe("POST")
          expect(new URL(request.url).pathname + new URL(request.url).search).toBe("/headers?preserved=1")
          expect(Object.fromEntries(input.headers)).toEqual(original)
          expect(caller.signal.aborted).toBe(false)
        } finally {
          if (hooks) globalThis.fetch = underlying
          pool?.close()
          await hooks?.dispose?.()
        }
      })
    }
  }

  for (const kind of ["string", "stream"] as const) {
    test(`an unread ${kind} body remains available when the HTTP transport does not consume it`, async () => {
      let pulls = 0
      const source = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++
            controller.enqueue(new TextEncoder().encode("retained-body"))
            controller.close()
          },
        },
        { highWaterMark: 0 },
      )
      const input = new Request("http://127.0.0.1/unread", {
        method: "POST",
        headers: originalHeaders,
        body: kind === "string" ? "retained-body" : source,
      })
      let outgoing: Request | undefined
      let reconstructed: Request | undefined
      const transport = createHTTPTransport({
        async httpFetch(request, init) {
          if (!(request instanceof Request)) throw new Error("Expected Request input")
          outgoing = request
          reconstructed = new Request(request, init)
          expect(reconstructed.headers.has(TITLE_HEADER)).toBe(false)
          return new Response("not consumed")
        },
      })
      try {
        expect(await (await transport(input, { headers: {} })).text()).toBe("not consumed")
        expect(input.bodyUsed).toBe(false)
        expect(input.body?.locked).toBe(false)
        expect(pulls).toBe(kind === "stream" ? 1 : 0)
        expect(await input.text()).toBe("retained-body")
        if (!outgoing?.body) throw new Error("Missing outgoing body")
        await Promise.all([outgoing.body.cancel("discarded"), reconstructed?.body?.cancel("discarded")])
        expect(input.body?.locked).toBe(false)
      } finally {
        transport.close()
      }
    })
  }

  for (const state of ["used", "locked"] as const) {
    for (const replacement of [null, "replacement-body"]) {
      test(`an explicit ${replacement === null ? "null" : "text"} body replaces a ${state} original`, async () => {
        const input = new Request("http://127.0.0.1/replace", {
          method: "POST",
          headers: originalHeaders,
          body: "original-body",
        })
        const reader = state === "locked" ? input.body?.getReader() : undefined
        if (state === "used") await input.text()
        const transport = createHTTPTransport({
          async httpFetch(request, init) {
            const rebuilt = new Request(request, init)
            expect(rebuilt.headers.has(TITLE_HEADER)).toBe(false)
            return new Response(await rebuilt.text())
          },
        })
        try {
          const response = await transport(input, { headers: {}, body: replacement })
          expect(await response.text()).toBe(replacement ?? "")
          expect(input.headers.get("x-private")).toBe("synthetic-private")
        } finally {
          reader?.releaseLock()
          transport.close()
        }
      })
    }
    test(`a ${state} original without body replacement retains native Request behavior`, async () => {
      const control = new Request("http://127.0.0.1/used", {
        method: "POST",
        headers: originalHeaders,
        body: "original-body",
      })
      const controlReader = state === "locked" ? control.body?.getReader() : undefined
      if (state === "used") await control.text()
      const input = new Request("http://127.0.0.1/used", {
        method: "POST",
        headers: originalHeaders,
        body: "original-body",
      })
      const reader = state === "locked" ? input.body?.getReader() : undefined
      if (state === "used") await input.text()
      const transport = createHTTPTransport({
        async httpFetch(request, init) {
          return new Response(await new Request(request, init).text())
        },
      })
      try {
        const outcome = (fn: () => Promise<string>) =>
          Promise.resolve()
            .then(fn)
            .then(
              (text) => ({ text }),
              (error) => ({ error: error instanceof Error ? error.name : String(error) }),
            )
        const expected = await outcome(() => new Request(control, { headers: {} }).text())
        expect(await outcome(async () => (await transport(input, { headers: {} })).text())).toEqual(expected)
      } finally {
        controlReader?.releaseLock()
        reader?.releaseLock()
        transport.close()
      }
    })
  }

  for (const kind of ["raw stream", "Request-backed stream"] as const) {
    for (const state of ["fresh", "used", "locked"] as const) {
      test(`explicit ${kind} body reaches HTTP once with a ${state} original Request`, async () => {
        const received: { body: string; headers: Headers }[] = []
        using server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            received.push({ body: await request.text(), headers: request.headers })
            return new Response("accepted")
          },
        })
        const replacement = () => {
          const owner =
            kind === "Request-backed stream"
              ? new Request(server.url, { method: "POST", body: "replacement-body" })
              : undefined
          const body =
            owner?.body ??
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  controller.enqueue(new TextEncoder().encode("replacement-body"))
                  controller.close()
                },
              },
              { highWaterMark: 0 },
            )
          return { owner, body }
        }
        const makeInput = async () => {
          const input = new Request(server.url, { method: "POST", headers: originalHeaders, body: "old-body" })
          const reader = state === "locked" ? input.body?.getReader() : undefined
          if (state === "used") await input.text()
          return { input, reader }
        }
        const control = await makeInput()
        const input = await makeInput()
        const original = { headers: Object.fromEntries(input.input.headers), bodyUsed: input.input.bodyUsed }
        let preparation: { locked: boolean; used: boolean | undefined } | undefined
        const override = replacement()
        const transport = createHTTPTransport({
          httpFetch(request, init) {
            preparation = { locked: override.body.locked, used: override.owner?.bodyUsed }
            return fetch(new Request(request, init))
          },
        })
        try {
          expect(
            await (
              await fetch(new Request(control.input, { method: "POST", headers: {}, body: replacement().body }))
            ).text(),
          ).toBe("accepted")
          expect(await (await transport(input.input, { headers: {}, body: override.body })).text()).toBe("accepted")
          expect(preparation).toEqual({ locked: false, used: kind === "Request-backed stream" ? false : undefined })
          expect(received.map((request) => request.body)).toEqual(["replacement-body", "replacement-body"])
          for (const key of ["authorization", "x-private", TITLE_HEADER])
            expect(received[1]?.headers.has(key)).toBe(false)
          expect(Object.fromEntries(input.input.headers)).toEqual(original.headers)
          expect(input.input.bodyUsed).toBe(original.bodyUsed)
        } finally {
          control.reader?.releaseLock()
          input.reader?.releaseLock()
          transport.close()
        }
      })
    }
  }

  for (const status of [307, 308]) {
    for (const kind of ["null", "text", "Blob", "URLSearchParams"] as const) {
      test(`${status} redirect retains an explicit ${kind} body override and its native Content-Type`, async () => {
        const received: { body: string; type: string | null; headers: Headers }[] = []
        using server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            if (new URL(request.url).pathname === "/redirect") {
              await request.text()
              return new Response(null, { status, headers: { location: "/target" } })
            }
            received.push({
              body: await request.text(),
              type: request.headers.get("content-type"),
              headers: request.headers,
            })
            return new Response("replayed override")
          },
        })
        const body = () =>
          kind === "null"
            ? null
            : kind === "text"
              ? "replacement-body"
              : kind === "Blob"
                ? new Blob(["replacement-body"], { type: "application/replacement" })
                : new URLSearchParams({ replacement: "body" })
        const control = new Request(new URL("/redirect", server.url), { method: "POST", body: "old-body" })
        for (const key of Array.from(control.headers.keys())) control.headers.delete(key)
        const input = new Request(control.url, { method: "POST", body: "old-body", headers: originalHeaders })
        const original = Object.fromEntries(input.headers)
        const transport = createHTTPTransport({ httpFetch: (request, init) => fetch(new Request(request, init)) })
        try {
          expect(await (await fetch(new Request(control, { method: "POST", headers: {}, body: body() }))).text()).toBe(
            "replayed override",
          )
          expect(await (await transport(input, { headers: {}, body: body() })).text()).toBe("replayed override")
          expect(received).toHaveLength(2)
          expect(received[1]?.body).toBe(received[0]?.body)
          expect(received[1]?.type).toBe(received[0]?.type)
          for (const key of ["authorization", "x-private", TITLE_HEADER])
            expect(received[1]?.headers.has(key)).toBe(false)
          expect(Object.fromEntries(input.headers)).toEqual(original)
          expect(input.bodyUsed).toBe(false)
        } finally {
          transport.close()
        }
      })
    }
  }

  for (const state of ["used", "locked"] as const) {
    test(`explicit ${state} replacement stream retains the native rejection`, async () => {
      const replacement = async () => {
        const owner = new Request("http://127.0.0.1/replacement", { method: "POST", body: "replacement-body" })
        const reader = state === "locked" ? owner.body?.getReader() : undefined
        if (state === "used") await owner.text()
        if (!owner.body) throw new Error("Missing replacement body")
        return { body: owner.body, reader }
      }
      const control = await replacement()
      const actual = await replacement()
      const input = new Request("http://127.0.0.1/replace", {
        method: "POST",
        body: "old-body",
        headers: originalHeaders,
      })
      const transport = createHTTPTransport({
        async httpFetch(request, init) {
          return new Response(await new Request(request, init).text())
        },
      })
      const outcome = (fn: () => Promise<string>) =>
        Promise.resolve()
          .then(fn)
          .then(
            (text) => ({ text }),
            (error) => ({ error: error instanceof Error ? error.name : String(error) }),
          )
      try {
        const expected = await outcome(() =>
          new Request(input, { method: "POST", headers: {}, body: control.body }).text(),
        )
        expect(expected).toEqual({ error: "TypeError" })
        expect(await outcome(async () => (await transport(input, { headers: {}, body: actual.body })).text())).toEqual(
          expected,
        )
      } finally {
        control.reader?.releaseLock()
        actual.reader?.releaseLock()
        transport.close()
      }
    })
  }

  for (const ending of ["complete", "error", "cancel"] as const) {
    test(`stream Request copy supports body ${ending}`, async () => {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined
      const source = new ReadableStream<Uint8Array>(
        {
          start(value) {
            controller = value
          },
        },
        { highWaterMark: 0 },
      )
      const input = new Request("http://127.0.0.1/body", { method: "POST", headers: originalHeaders, body: source })
      const transport = createHTTPTransport({
        async httpFetch(request, init) {
          const rebuilt = new Request(request, init)
          if (!rebuilt.body) throw new Error("Missing rebuilt body")
          const reader = rebuilt.body.getReader()
          try {
            controller?.enqueue(new TextEncoder().encode("first"))
            expect(new TextDecoder().decode((await reader.read()).value)).toBe("first")
            const pending = reader.read()
            if (ending === "cancel") {
              // The original Request retains its native copy branch. Finish
              // that caller-owned branch while canceling the transport copy.
              const original = input.text()
              controller?.close()
              await reader.cancel("consumer canceled")
              expect((await pending).done).toBe(true)
              expect(await original).toBe("first")
            } else if (ending === "error") {
              controller?.error(new Error("source failed"))
              expect(await pending.catch((error) => error)).toMatchObject({ message: "source failed" })
            } else {
              controller?.close()
              expect((await pending).done).toBe(true)
            }
            expect(input.body?.locked).toBe(false)
            return new Response("done")
          } finally {
            reader.releaseLock()
          }
        },
      })
      try {
        expect(await (await transport(input, { headers: {} })).text()).toBe("done")
      } finally {
        transport.close()
      }
    })
  }

  test("Request properties and explicit method/signal overrides survive header cleanup", async () => {
    const originalCaller = new AbortController()
    const overrideCaller = new AbortController()
    const input = new Request("http://127.0.0.1/properties?query=retained", {
      method: "PUT",
      headers: originalHeaders,
      body: "body",
      signal: originalCaller.signal,
      credentials: "include",
      cache: "no-store",
      mode: "cors",
      redirect: "manual",
      referrer: "http://127.0.0.1/referrer",
      referrerPolicy: "origin",
      integrity: "",
      keepalive: false,
    })
    const transport = createHTTPTransport({
      async httpFetch(request, init) {
        const rebuilt = new Request(request, init)
        expect(rebuilt.url).toBe(input.url)
        expect(rebuilt.method).toBe("PATCH")
        for (const key of [
          "credentials",
          "cache",
          "mode",
          "redirect",
          "referrer",
          "referrerPolicy",
          "integrity",
          "keepalive",
        ] as const) {
          expect(rebuilt[key]).toBe(input[key])
        }
        originalCaller.abort()
        expect(rebuilt.signal.aborted).toBe(false)
        overrideCaller.abort()
        expect(rebuilt.signal.aborted).toBe(true)
        return new Response(await rebuilt.text())
      },
    })
    try {
      expect(
        await (await transport(input, { headers: {}, method: "PATCH", signal: overrideCaller.signal })).text(),
      ).toBe("body")
      expect(input.method).toBe("PUT")
      expect(input.headers.get(TITLE_HEADER)).toBe("original-marker")
    } finally {
      transport.close()
    }
  })

  test("pre-aborted Request rejection does not acquire or read its upload body", async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulls++
        },
      },
      { highWaterMark: 0 },
    )
    const caller = new AbortController()
    const input = new Request("http://127.0.0.1/aborted", {
      method: "POST",
      headers: originalHeaders,
      body,
      signal: caller.signal,
    })
    caller.abort(new DOMException("already stopped", "AbortError"))
    const transport = createHTTPTransport({
      httpFetch: (request, init) => fetch(new Request(request, init)),
    })
    try {
      const failure = await transport(input, { headers: {} }).catch((error) => error)
      expect(failure).toMatchObject({ name: "AbortError" })
      expect(pulls).toBe(0)
      expect(input.body?.locked).toBe(false)
      expect(input.bodyUsed).toBe(false)
    } finally {
      transport.close()
    }
  })

  test("aborting real HTTP upload stops transport while preserving the original Request copy", async () => {
    const arrived = Promise.withResolvers<void>()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const source = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value
          value.enqueue(new TextEncoder().encode("first"))
        },
      },
      { highWaterMark: 0 },
    )
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        arrived.resolve()
        try {
          await request.text()
        } catch {}
        return new Response("finished")
      },
    })
    const caller = new AbortController()
    const input = new Request(server.url, {
      method: "POST",
      headers: originalHeaders,
      body: source,
      signal: caller.signal,
    })
    const transport = createHTTPTransport({
      httpFetch: (request, init) => fetch(new Request(request, init)),
    })
    try {
      const pending = transport(input, { headers: {} })
      const failure = pending.catch((error) => error)
      await arrived.promise
      caller.abort(new DOMException("upload stopped", "AbortError"))
      expect(await failure).toMatchObject({ name: "AbortError" })
      expect(input.bodyUsed).toBe(false)
      expect(input.body?.locked).toBe(false)
      expect(input.headers.get("x-private")).toBe("synthetic-private")
    } finally {
      controller?.close()
      transport.close()
    }
  })
})
