import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { type SessionAttentionUpdate, OpencodeClient } from "@opencode-ai/sdk/v2"
import { runInteractiveLocalMode, runInteractiveMode } from "@/cli/cmd/run/runtime"
import type { FooterApi, RunPrompt, RunProvider } from "@/cli/cmd/run/types"

type SessionMessage = NonNullable<Awaited<ReturnType<OpencodeClient["session"]["messages"]>>["data"]>[number]

const provider: RunProvider = {
  id: "openai",
  name: "OpenAI",
  source: "api",
  env: [],
  options: {},
  models: {
    "gpt-5": {
      id: "gpt-5",
      providerID: "openai",
      api: {
        id: "openai",
        url: "https://openai.test",
        npm: "@ai-sdk/openai",
      },
      name: "Little Frank",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        output: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
      limit: {
        context: 128000,
        output: 8192,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    },
  },
}

const transportProviders: RunProvider[][] = []

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function ok<T>(data: T) {
  return Promise.resolve({
    data,
    error: undefined,
    request: new Request("https://opencode.test"),
    response: new Response(),
  })
}

function footer(): FooterApi {
  let closed = false
  const closes = new Set<() => void>()

  const notify = () => {
    for (const fn of closes) fn()
  }

  return {
    get isClosed() {
      return closed
    },
    onPrompt: () => () => {},
    onQueuedRemove: () => () => {},
    onClose(fn) {
      if (closed) {
        fn()
        return () => {}
      }

      closes.add(fn)
      return () => {
        closes.delete(fn)
      }
    },
    event() {},
    append() {},
    idle() {
      return Promise.resolve()
    },
    close() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
    destroy() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
  }
}

afterEach(() => {
  mock.restore()
  transportProviders.length = 0
})

describe("run interactive runtime", () => {
  test("waits for provider metadata before eager replay transport bootstrap", async () => {
    const providersStarted = defer<void>()
    const providers = defer<void>()

    const sdk = new OpencodeClient()
    spyOn(sdk.config, "providers").mockImplementation(async () => {
      providersStarted.resolve()
      await providers.promise
      return ok({ providers: [provider], default: {} })
    })
    spyOn(sdk.session, "messages").mockImplementation(() =>
      ok([
        {
          info: {
            id: "msg-user-1",
            sessionID: "ses-1",
            role: "user",
            time: {
              created: 1,
            },
            agent: "build",
            model: {
              providerID: "openai",
              modelID: "gpt-5",
              variant: undefined,
            },
          },
          parts: [
            {
              id: "part-user-1",
              sessionID: "ses-1",
              messageID: "msg-user-1",
              type: "text",
              text: "hello",
            },
          ],
        } satisfies SessionMessage,
      ]),
    )
    spyOn(sdk.session, "get").mockRejectedValue(new Error("not needed"))
    spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
    spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
    spyOn(sdk.command, "list").mockImplementation(() => ok([]))

    const task = runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-1",
        sessionTitle: "Session",
        resume: true,
        replay: true,
        replayLimit: 100,
        agent: "build",
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
        variant: undefined,
        files: [],
        thinking: true,
        backgroundSubagents: false,
      },
      {
        createRuntimeLifecycle: async () => ({
          footer: footer(),
          onResize: () => () => {},
          refreshTheme: () => {},
          resetForReplay: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
        streamTransport: Promise.resolve({
          createSessionTransport: async (input: { providers?: () => RunProvider[]; footer: FooterApi }) => {
            transportProviders.push(input.providers?.() ?? [])
            setTimeout(() => {
              input.footer.close()
            }, 0)
            return {
              runPromptTurn: async () => {},
              selectSubagent: () => {},
              replayOnResize: async () => false,
              close: async () => {},
            }
          },
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    )

    await providersStarted.promise

    expect(transportProviders).toEqual([])

    providers.resolve()

    await task

    expect(transportProviders).toEqual([[provider]])
  })
})

test("local mini creates attention only after ensureSession, switches on /new, and closes the selected client", async () => {
  const ui = footer()
  const ready = defer<void>()
  const rows: SessionAttentionUpdate[] = []
  const turns: string[] = []
  const sessionReady = defer<void>()
  let submit: ((input: RunPrompt) => void) | undefined
  ui.onPrompt = (fn) => {
    submit = fn
    ready.resolve()
    return () => {
      submit = undefined
    }
  }
  const localFetch: typeof fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input)
      const path = new URL(request.url).pathname
      if (path.endsWith("/attention")) {
        rows.push({ ...(await request.json()), sessionID: path.split("/")[2] })
        return Response.json(true)
      }
      if (path === "/config/providers") return Response.json({ providers: [], default: {} })
      if (path === "/agent" || path === "/command") return Response.json([])
      if (path === "/experimental/resource") return Response.json({})
      return new Response("fixture route not used", { status: 404 })
    },
    { preconnect: fetch.preconnect },
  )
  const task = runInteractiveLocalMode(
    {
      directory: "/tmp",
      fetch: localFetch,
      resolveAgent: async () => "build",
      session: async () => {
        await sessionReady.promise
        return { id: "ses_first" }
      },
      share: async () => {},
      createSession: async () => ({ id: "ses_second" }),
      agent: "build",
      model: undefined,
      variant: undefined,
      files: [],
      thinking: false,
      backgroundSubagents: false,
    },
    {
      createRuntimeLifecycle: async (input) => {
        input.onActivity?.()
        input.onBackgroundView?.(true)
        expect(rows).toEqual([])
        return {
          footer: ui,
          onResize: () => () => {},
          refreshTheme: () => {},
          resetForReplay: async () => {},
          close: async () => {},
        }
      },
      streamTransport: Promise.resolve({
        createSessionTransport: async (input) => ({
          runPromptTurn: async () => {
            turns.push(input.sessionID)
          },
          selectSubagent: () => {},
          replayOnResize: async () => false,
          close: async () => {},
        }),
        formatUnknownError: (error) => String(error),
      }),
    },
  )
  const waitFor = async (check: () => boolean) => {
    for (let count = 0; count < 200 && !check(); count++) await Bun.sleep(5)
    expect(check()).toBe(true)
  }
  try {
    await ready.promise
    expect(rows).toEqual([])
    sessionReady.resolve()
    if (!submit) throw new Error("mini did not subscribe to prompt input")
    submit({ text: "first", parts: [] })
    await waitFor(() => turns.length === 1 && rows.length > 0)
    expect(rows[0]?.sessionID).toBe("ses_first")
    expect(rows[0]?.backgroundView).toBe(true)
    submit({ text: "/new", parts: [] })
    await waitFor(() => rows.some((row) => row.sessionID === "ses_second"))
    const oldClose = rows.findIndex((row) => row.sessionID === "ses_first" && row.closed)
    const next = rows.findIndex((row) => row.sessionID === "ses_second")
    expect(oldClose).toBeGreaterThanOrEqual(0)
    expect(oldClose).toBeLessThan(next)
    expect(rows[next]?.backgroundView).toBe(false)
    expect(turns).toEqual(["ses_first"])
  } finally {
    sessionReady.resolve()
    ui.close()
    await task
  }
  expect(rows.at(-1)).toMatchObject({ sessionID: "ses_second", closed: true, backgroundView: false })
})

for (const ignoresSignal of [false, true]) {
  test(`mini restores its shell when attention transport ${ignoresSignal ? "ignores abort" : "is a stalled real fetch"}`, async () => {
    const ui = footer()
    let entered = false
    let shellClosed = false
    const signals: AbortSignal[] = []
    let release: ((response: Response) => void) | undefined
    const held = new Promise<Response>((resolve) => {
      release = resolve
    })
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: () => held })
    const localFetch: typeof fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input)
        const path = new URL(request.url).pathname
        if (path.endsWith("/attention")) {
          entered = true
          signals.push(request.signal)
          return ignoresSignal ? held : fetch(server.url, { signal: request.signal })
        }
        if (path === "/config/providers") return Response.json({ providers: [], default: {} })
        if (path === "/agent" || path === "/command") return Response.json([])
        if (path === "/experimental/resource") return Response.json({})
        return new Response("unused fixture route", { status: 404 })
      },
      { preconnect: fetch.preconnect },
    )
    const task = runInteractiveLocalMode(
      {
        directory: "/tmp",
        fetch: localFetch,
        resolveAgent: async () => "build",
        session: async () => ({ id: "ses_stalled_runtime" }),
        share: async () => {},
        agent: "build",
        model: undefined,
        variant: undefined,
        files: [],
        thinking: false,
        backgroundSubagents: false,
      },
      {
        createRuntimeLifecycle: async () => ({
          footer: ui,
          onResize: () => () => {},
          refreshTheme: () => {},
          resetForReplay: async () => {},
          close: async () => {
            shellClosed = true
          },
        }),
        streamTransport: Promise.resolve({
          createSessionTransport: async () => ({
            runPromptTurn: async () => {},
            selectSubagent: () => {},
            replayOnResize: async () => false,
            close: async () => {},
          }),
          formatUnknownError: (error) => String(error),
        }),
      },
    )
    try {
      for (let count = 0; count < 200; count++) {
        if (entered) break
        await Bun.sleep(5)
      }
      expect(entered).toBe(true)
      ui.close()
      await Bun.sleep(2_150)
      expect(shellClosed).toBe(true)
      expect(signals.every((signal) => signal.aborted)).toBe(true)
    } finally {
      ui.close()
      release?.(new Response("released"))
      await task
      await server.stop(true)
    }
  })
}
