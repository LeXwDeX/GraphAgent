// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createSignal, onCleanup, Show } from "solid-js"
import { unwrap } from "solid-js/store"
import { Prompt, type PromptRef } from "../../src/component/prompt"
import { t } from "../../src/i18n"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { EditorContextProvider } from "../../src/context/editor"
import { EpilogueProvider } from "../../src/context/epilogue"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { LocalProvider, useLocal } from "../../src/context/local"
import { LocationProvider } from "../../src/context/location"
import { ProjectProvider } from "../../src/context/project"
import { PromptRefProvider } from "../../src/context/prompt"
import { RouteProvider, useRoute } from "../../src/context/route"
import { SDKProvider, useSDK } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { GraphagentKeymapProvider, registerGraphagentKeymap } from "../../src/keymap"
import { FrecencyProvider } from "../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../src/prompt/history"
import { PromptStashProvider } from "../../src/prompt/stash"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { useFooterStatus } from "../../src/shell/footer-status"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

async function wait(fn: () => boolean) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > 2000) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

async function mount(
  handler: (request: Request) => Promise<Response>,
  onPrompt?: (request: Request) => Promise<Response>,
  onSession?: (request: Request) => Promise<Response>,
  onAbort?: (request: Request) => Promise<Response>,
  onShell?: (request: Request) => Promise<Response>,
) {
  const tmp = await tmpdir()
  await Bun.write(
    `${tmp.path}/model.json`,
    JSON.stringify({
      variant: { "test/m": "xhigh" },
      recent: [
        { providerID: "test", modelID: "m" },
        { providerID: "test", modelID: "other" },
      ],
    }),
  )
  const events = createEventSource()
  const base = createFetch()
  const fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (/^\/session\/[^/]+\/model$/.test(new URL(request.url).pathname)) return handler(request)
      if (request.method === "POST" && /^\/session\/[^/]+\/abort$/.test(new URL(request.url).pathname) && onAbort)
        return onAbort(request)
      if (request.method === "GET" && /^\/session\/(a|b)$/.test(new URL(request.url).pathname) && onSession)
        return onSession(request)
      if (request.method === "POST" && /\/(message|command)$/.test(new URL(request.url).pathname) && onPrompt)
        return onPrompt(request)
      if (request.method === "POST" && /\/shell$/.test(new URL(request.url).pathname) && onShell)
        return onShell(request)
      return base.fetch(request)
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  let local!: ReturnType<typeof useLocal>
  let sync!: ReturnType<typeof useSync>
  let route!: ReturnType<typeof useRoute>
  let sdk!: ReturnType<typeof useSDK>
  let prompt!: PromptRef
  const [mounted, setMounted] = createSignal(true)
  function Content() {
    local = useLocal()
    sync = useSync()
    route = useRoute()
    sdk = useSDK()
    return (
      <Show when={mounted()}>
        <Prompt
          sessionID={route.data.type === "session" ? route.data.sessionID : undefined}
          ref={(value) => {
            if (value) prompt = value
          }}
        />
      </Show>
    )
  }
  // Mirrors the production footer slot that renders transient footer content.
  function FooterStatusView() {
    const status = useFooterStatus()
    return <box flexShrink={0}>{status()}</box>
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerGraphagentKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts cwd={directory} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <ExitProvider exit={() => {}}>
          <EpilogueProvider set={() => {}}>
            <ClipboardProvider>
              <GraphagentKeymapProvider keymap={keymap}>
                <ArgsProvider>
                  <KVProvider>
                    <ToastProvider>
                      <RouteProvider initialRoute={{ type: "home" }}>
                        <TuiConfigProvider config={config}>
                          <SDKProvider url="http://test" directory={directory} events={events.source} fetch={fetch}>
                            <ProjectProvider>
                              <SyncProvider>
                                <ThemeProvider mode="dark">
                                  <LocalProvider>
                                    <PromptStashProvider>
                                      <DialogProvider>
                                        <FrecencyProvider>
                                          <PromptHistoryProvider>
                                            <PromptRefProvider>
                                              <EditorContextProvider integration={{}}>
                                                <LocationProvider>
                                                  <Content />
                                                  <FooterStatusView />
                                                </LocationProvider>
                                              </EditorContextProvider>
                                            </PromptRefProvider>
                                          </PromptHistoryProvider>
                                        </FrecencyProvider>
                                      </DialogProvider>
                                    </PromptStashProvider>
                                  </LocalProvider>
                                </ThemeProvider>
                              </SyncProvider>
                            </ProjectProvider>
                          </SDKProvider>
                        </TuiConfigProvider>
                      </RouteProvider>
                    </ToastProvider>
                  </KVProvider>
                </ArgsProvider>
              </GraphagentKeymapProvider>
            </ClipboardProvider>
          </EpilogueProvider>
        </ExitProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: 80, height: 24 })
  await wait(() => Boolean(sync?.ready && local.model.ready))
  sync.set("agent", [{ name: "build", mode: "primary", hidden: false, options: {}, permission: [] }])
  sync.set("provider", [
    {
      id: "test",
      name: "test",
      source: "config",
      env: [],
      options: {},
      models: {
        m: {
          id: "m",
          name: "m",
          providerID: "test",
          api: { id: "m", url: "http://test", npm: "test" },
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-01-01",
          capabilities: {
            temperature: false,
            reasoning: true,
            attachment: true,
            toolcall: true,
            input: { text: true, audio: false, image: true, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          limit: { context: 10000, output: 1000 },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          variants: { high: {}, xhigh: {} },
        },
      },
    },
  ])
  sync.set(
    "session",
    ["a", "b"].map((id) => ({
      id,
      title: id,
      slug: id,
      projectID: "proj_test",
      time: { created: 0, updated: 0 },
      version: "1",
      directory,
      model: { id: "m", providerID: "test", variant: id === "a" ? "default" : "xhigh" },
    })),
  )
  sync.set("message", { a: [], b: [] })
  // The event gate forwards full session events only for sessions the UI
  // registered interest in; tests treat both synthetic sessions as open.
  await sync.interest.set("test", ["a", "b"])
  return {
    local,
    sync,
    route,
    app,
    tmp,
    events,
    /** Deliver queued events now instead of waiting for the next frame. */
    flush() {
      sdk.frameClock.flushNow()
    },
    get prompt() {
      return prompt
    },
    remount() {
      setMounted(false)
      setMounted(true)
    },
    async dispose() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

test("first restore keeps A's model and rollback snapshot isolated from B's model", async () => {
  let reject!: () => void
  const gate = new Promise<void>((resolve) => (reject = resolve))
  let submitted: unknown
  const app = await mount(
    async () => json(true),
    async (request) => {
      submitted = await request.json()
      await gate
      return json({ message: "refused" }, { status: 400 })
    },
  )
  try {
    const original = app.sync.data.provider[0].models.m
    app.sync.set("provider", 0, "models", "other", { ...original, id: "other" })
    app.sync.set("session", 0, "model", "variant", "xhigh")
    app.sync.set("session", 1, "model", { id: "other", providerID: "test", variant: "default" })
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.current() === "xhigh")
    app.prompt.set({ input: "keep model", parts: [] })
    app.prompt.submit()
    await wait(() => Boolean(submitted))
    expect(submitted).toMatchObject({ model: { providerID: "test", modelID: "m" }, variant: "xhigh" })
    app.route.navigate({ type: "session", sessionID: "b" })
    await wait(() => app.local.model.current()?.modelID === "other")
    app.route.navigate({ type: "session", sessionID: "a" })
    expect(app.local.model.current()?.modelID).toBe("m")
    expect(app.local.model.variant.current()).toBe("xhigh")
    reject()
    await wait(() => app.sync.data.pending_submission.a === undefined)
    expect(app.local.model.current()?.modelID).toBe("m")
    expect(app.local.model.variant.current()).toBe("xhigh")
    expect(app.sync.session.get("a")?.model).toEqual({ id: "m", providerID: "test", variant: "xhigh" })
  } finally {
    reject()
    await app.dispose()
  }
})

test("a stopped sent command cannot overwrite a later variant when accepted late", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let durable = "xhigh"
  let messageID = ""
  let aborts = 0
  const writes: string[] = []
  const app = await mount(
    async (request) => {
      const body = await request.json()
      writes.push(body.variant)
      durable = body.variant
      return json(true)
    },
    async (request) => {
      const body = await request.json()
      messageID = body.messageID
      expect(body.variant).toBe("xhigh")
      await gate
      // The server-side causal fence keeps the later high write; the command
      // message still records its original xhigh variant.
      const info = {
        id: messageID,
        sessionID: "a",
        role: "user" as const,
        time: { created: 1 },
        agent: "build",
        model: { providerID: "test", modelID: "m", variant: body.variant },
      }
      app.events.emit({
        directory,
        payload: { id: "late-command-accepted", type: "message.updated", properties: { sessionID: "a", info } },
      })
      return json({})
    },
    async () => json({ model: { id: "m", providerID: "test", variant: durable } }),
    async () => {
      aborts++
      app.sync.set("session_status", "a", { type: "idle" })
      return json(true)
    },
  )
  try {
    app.sync.set("session", 0, "model", "variant", "xhigh")
    app.sync.set("command", [{ name: "test", template: "test", hints: [] }])
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "xhigh")
    app.sync.set("session_status", "a", { type: "busy" })
    app.prompt.set({ input: "/test old", parts: [] })
    app.prompt.submit()
    await wait(() => Boolean(messageID))
    app.local.model.variant.cycle()
    app.local.model.variant.cycle()
    expect(app.local.model.variant.current()).toBe("high")
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("ESCAPE")
    await Bun.sleep(40)
    app.app.mockInput.pressKey("ESCAPE")
    await wait(() => aborts === 1)
    await Bun.sleep(50)
    // A command that may still be accepted must not hold the newer explicit
    // model write; the server-side causal fence keeps the old command from
    // restoring its variant after late acceptance.
    await wait(() => writes.includes("high"))
    expect(durable).toBe("high")
    expect(app.sync.data.failed_submission.a).toBeUndefined()
    release()
    await wait(() => app.local.model.variant.current() === "high")
    expect(durable).toBe("high")
    expect(app.local.model.variant.current()).toBe("high")
  } finally {
    release()
    await app.dispose()
  }
})

test("an unknown sent command remains blocked across remount and reconnect while other sessions proceed", async () => {
  let reject!: () => void
  const gate = new Promise<void>((resolve) => (reject = resolve))
  let sent = 0
  let aborts = 0
  const writes: string[] = []
  const app = await mount(
    async (request) => {
      writes.push(new URL(request.url).pathname)
      return json(true)
    },
    async () => {
      sent++
      await gate
      return json({ message: "unknown outcome" }, { status: 404 })
    },
    undefined,
    async () => {
      aborts++
      app.sync.set("session_status", "a", { type: "idle" })
      return json(true)
    },
  )
  try {
    app.sync.set("command", [{ name: "test", template: "test", hints: [] }])
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.sync.set("session_status", "a", { type: "busy" })
    app.prompt.set({ input: "/test unknown", parts: [] })
    app.prompt.submit()
    await wait(() => sent === 1)
    app.local.model.variant.cycle()
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("ESCAPE")
    await Bun.sleep(40)
    app.app.mockInput.pressKey("ESCAPE")
    await wait(() => aborts === 1)
    reject()
    await Bun.sleep(50)
    app.events.reconnect()
    app.route.navigate({ type: "session", sessionID: "b" })
    app.local.model.variant.cycle()
    await wait(() => writes.includes("/session/b/model"))
    app.route.navigate({ type: "session", sessionID: "a" })
    app.remount()
    await app.app.renderOnce()
    expect(app.app.captureCharFrame().replace(/\s+/g, " ")).toContain(
      t("prompt.submit.unconfirmed").split(/[;；]/)[0]!.slice(0, 10),
    )
    expect(app.sync.data.failed_submission.a).toBeUndefined()
    app.prompt.set({ input: "later", parts: [] })
    app.prompt.submit()
    await Bun.sleep(80)
    expect(sent).toBe(1)
    // The explicit model write is allowed to bypass the unconfirmed command;
    // a new prompt/submission remains queued behind it.
    expect(writes.filter((path) => path === "/session/a/model")).not.toEqual([])
  } finally {
    reject()
    await app.dispose()
  }
})

test.each([
  ["prompt", false],
  ["command", false],
  ["prompt", true],
  ["command", true],
])("idle interrupt cancels a locally queued %s after session switching (remount: %s)", async (kind, remount) => {
  let releaseModel!: () => void
  const gate = new Promise<void>((resolve) => (releaseModel = resolve))
  let models = 0
  let aborts = 0
  const sent: Array<{ path: string; body: any }> = []
  const app = await mount(
    async () => {
      models++
      await gate
      return json(true)
    },
    async (request) => {
      sent.push({ path: new URL(request.url).pathname, body: await request.json() })
      return json({})
    },
    undefined,
    async () => {
      aborts++
      return json(true)
    },
  )
  try {
    const original = app.sync.data.provider[0].models.m
    app.sync.set("provider", 0, "models", "other", { ...original, id: "other" })
    app.sync.set("command", [{ name: "test", template: "test", hints: [] }])
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.local.model.cycle(1)
    await wait(() => models === 1)
    const draft = kind === "command" ? "/test old" : "old prompt"
    app.prompt.set({ input: draft, parts: [] })
    app.prompt.submit()
    await Bun.sleep(0)
    expect(sent).toEqual([])
    app.route.navigate({ type: "session", sessionID: "b" })
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("ESCAPE")
    await Bun.sleep(40)
    app.app.mockInput.pressKey("ESCAPE")
    await Bun.sleep(40)
    const otherSessionAborts = aborts
    app.route.navigate({ type: "session", sessionID: "a" })
    if (remount) app.remount()
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("ESCAPE")
    await Bun.sleep(40)
    app.app.mockInput.pressKey("ESCAPE")
    await Bun.sleep(40)
    const targetSessionAborts = aborts
    const preservedDraft = remount ? app.sync.data.failed_submission.a?.input : app.prompt.current.input
    const replacement = kind === "command" ? "/test replacement" : "replacement prompt"
    app.prompt.set({ input: replacement, parts: [] })
    app.prompt.submit()
    await Bun.sleep(20)
    expect(sent).toEqual([])
    releaseModel()
    await wait(() => sent.length >= 1)
    expect(
      sent.some(({ body }) =>
        kind === "command"
          ? body.arguments === "old"
          : body.parts.some((part: { text?: string }) => part.text === draft),
      ),
    ).toBe(false)
    expect(sent[0].path).toBe(`/session/a/${kind === "command" ? "command" : "message"}`)
    if (kind === "command") expect(sent[0].body.arguments).toBe("replacement")
    else expect(sent[0].body.parts.some((part: { text?: string }) => part.text === replacement)).toBe(true)
    await Bun.sleep(20)
    expect(sent).toHaveLength(1)
    expect(otherSessionAborts).toBe(0)
    expect(targetSessionAborts).toBe(0)
    expect(preservedDraft).toBe(draft)
  } finally {
    releaseModel()
    await app.dispose()
  }
})

test("an idle interrupt sequence does not carry across sessions", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let models = 0
  let aborts = 0
  const sent: string[] = []
  const app = await mount(
    async () => {
      models++
      await gate
      return json(true)
    },
    async (request) => {
      sent.push(new URL(request.url).pathname)
      return json({})
    },
    undefined,
    async () => {
      aborts++
      return json(true)
    },
  )
  try {
    const original = app.sync.data.provider[0].models.m
    app.sync.set("provider", 0, "models", "other", { ...original, id: "other" })
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.local.model.cycle(1)
    await wait(() => models === 1)
    app.prompt.set({ input: "a queued", parts: [] })
    app.prompt.submit()
    await wait(() => app.local.model.queued("a"))
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("ESCAPE")
    await Bun.sleep(40)
    app.route.navigate({ type: "session", sessionID: "b" })
    app.local.model.cycle(1)
    await wait(() => models === 2)
    app.prompt.set({ input: "b queued", parts: [] })
    app.prompt.submit()
    await wait(() => app.local.model.queued("b"))
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("ESCAPE")
    await Bun.sleep(40)
    expect(app.local.model.queued("a")).toBe(true)
    expect(app.local.model.queued("b")).toBe(true)
    app.app.mockInput.pressKey("ESCAPE")
    await wait(() => !app.local.model.queued("b"))
    expect(app.local.model.queued("a")).toBe(true)
    app.route.navigate({ type: "session", sessionID: "a" })
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("ESCAPE")
    await Bun.sleep(40)
    app.app.mockInput.pressKey("ESCAPE")
    await wait(() => !app.local.model.queued("a"))
    release()
    await Bun.sleep(50)
    expect(aborts).toBe(0)
    expect(sent).toEqual([])
  } finally {
    release()
    await app.dispose()
  }
})

test("idle interrupt cancels only queued work, not a submission already sent", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const sent: string[] = []
  let aborts = 0
  const app = await mount(
    async () => json(true),
    async (request) => {
      const body = await request.json()
      sent.push(body.parts.find((part: { type: string }) => part.type === "text")?.text)
      await gate
      return json({})
    },
    undefined,
    async () => {
      aborts++
      return json(true)
    },
  )
  try {
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.prompt.set({ input: "already sent", parts: [] })
    app.prompt.submit()
    await wait(() => sent.length === 1)
    app.prompt.set({ input: "queued", parts: [] })
    app.prompt.submit()
    await Bun.sleep(0)
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("ESCAPE")
    await Bun.sleep(40)
    app.app.mockInput.pressKey("ESCAPE")
    await Bun.sleep(40)
    expect(aborts).toBe(0)
    expect(app.prompt.current.input).toBe("queued")
    release()
    await Bun.sleep(50)
    expect(sent).toEqual(["already sent"])
  } finally {
    release()
    await app.dispose()
  }
})

test.each([
  ["prompt", true],
  ["command", true],
  ["prompt", false],
])("interrupt cancels a queued %s and preserves its draft (abort success: %s)", async (kind, succeeds) => {
  let releaseModel!: () => void
  const gate = new Promise<void>((resolve) => (releaseModel = resolve))
  let models = 0
  let aborts = 0
  const sent: string[] = []
  const app = await mount(
    async () => {
      models++
      await gate
      return json(true)
    },
    async (request) => {
      sent.push(new URL(request.url).pathname)
      return json({})
    },
    undefined,
    async () => {
      aborts++
      if (!succeeds) return json({ message: "abort refused" }, { status: 400 })
      app.sync.set("session_status", "a", { type: "idle" })
      return json(true)
    },
  )
  try {
    const original = app.sync.data.provider[0].models.m
    app.sync.set("provider", 0, "models", "other", { ...original, id: "other" })
    app.sync.set("command", [{ name: "test", template: "test", hints: [] }])
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.sync.set("session_status", "a", { type: "busy" })
    app.local.model.cycle(1)
    await wait(() => models === 1)
    const draft = kind === "command" ? "/test" : "queued prompt"
    app.prompt.set({ input: draft, parts: [] })
    app.prompt.submit()
    await Bun.sleep(0)
    expect(sent).toEqual([])
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("ESCAPE")
    app.app.mockInput.pressKey("ESCAPE")
    await wait(() => aborts === 1)
    if (!succeeds) {
      await app.app.renderOnce()
      await wait(() => app.app.captureCharFrame().includes("Failed to stop session"))
      app.sync.set("session_status", "a", { type: "idle" })
    }
    releaseModel()
    await Bun.sleep(30)
    expect(sent).toEqual([])
    expect(app.prompt.current.input).toBe(draft)
    expect(app.local.model.current()?.modelID).toBe("other")
    app.prompt.submit()
    await wait(() => sent.length === 1)
    expect(sent[0]).toBe(`/session/a/${kind === "command" ? "command" : "message"}`)
  } finally {
    releaseModel()
    await app.dispose()
  }
})

test("a replacement after interrupt still waits for the preceding model request", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let models = 0
  let aborts = 0
  const sent: string[] = []
  const app = await mount(
    async () => {
      models++
      await gate
      return json(true)
    },
    async (request) => {
      const body = await request.json()
      sent.push(
        body.parts
          .map((part: { text?: string }) => part.text)
          .filter(Boolean)
          .join(" "),
      )
      return json({})
    },
    undefined,
    async () => {
      aborts++
      app.sync.set("session_status", "a", { type: "idle" })
      return json(true)
    },
  )
  try {
    const original = app.sync.data.provider[0].models.m
    app.sync.set("provider", 0, "models", "other", { ...original, id: "other" })
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.sync.set("session_status", "a", { type: "busy" })
    app.local.model.cycle(1)
    await wait(() => models === 1)
    app.prompt.set({ input: "cancelled", parts: [] })
    app.prompt.submit()
    await Bun.sleep(0)
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("ESCAPE")
    app.app.mockInput.pressKey("ESCAPE")
    await wait(() => aborts === 1)
    expect(app.prompt.current.input).toBe("cancelled")
    app.prompt.set({ input: "replacement", parts: [] })
    app.prompt.submit()
    await Bun.sleep(20)
    expect(sent).toEqual([])
    release()
    await wait(() => sent.length === 1)
    expect(sent).toEqual(["replacement"])
  } finally {
    release()
    await app.dispose()
  }
})

test.each(["prompt", "command"])(
  "interrupt restores the latest confirmed model after an in-flight %s",
  async (kind) => {
    let releaseModel!: () => void
    let rejectFirst!: () => void
    const modelGate = new Promise<void>((resolve) => (releaseModel = resolve))
    const promptGate = new Promise<void>((resolve) => (rejectFirst = resolve))
    const bodies: Array<{ model: string | { providerID: string; modelID: string }; variant?: string }> = []
    let models = 0
    let aborts = 0
    let durableModel = "m"
    const app = await mount(
      async (request) => {
        const body = await request.json()
        models++
        await modelGate
        durableModel = body.model.modelID
        return json(true)
      },
      async (request) => {
        bodies.push(await request.json())
        if (bodies.length === 1) {
          await promptGate
          return json({ _tag: "InvalidRequestError", message: "interrupted" }, { status: 400 })
        }
        return json({})
      },
      undefined,
      async () => {
        aborts++
        app.sync.set("session_status", "a", { type: "idle" })
        return json(true)
      },
    )
    try {
      const original = app.sync.data.provider[0].models.m
      app.sync.set("provider", 0, "models", "other", { ...original, id: "other" })
      app.sync.set("command", [{ name: "test", template: "test", hints: [] }])
      app.route.navigate({ type: "session", sessionID: "a" })
      await wait(() => app.local.model.variant.selected() === "default")
      app.sync.set("session_status", "a", { type: "busy" })
      const switched = app.local.model.set({ providerID: "test", modelID: "other" })
      await wait(() => models === 1)
      const draft = kind === "command" ? "/test" : "queued prompt"
      app.prompt.set({ input: draft, parts: [] })
      app.prompt.submit()
      releaseModel()
      await switched
      await wait(() => bodies.length === 1)
      expect(durableModel).toBe("other")
      expect(app.local.model.current()?.modelID).toBe("m")
      app.prompt.focus()
      await app.app.renderOnce()
      app.app.mockInput.pressKey("ESCAPE")
      app.app.mockInput.pressKey("ESCAPE")
      await wait(() => aborts === 1)
      expect(app.local.model.current()?.modelID).toBe("other")
      expect(app.local.model.variant.selected()).toBe("default")
      expect(app.prompt.current.input).toBe(draft)
      rejectFirst()
      await Bun.sleep(20)
      expect(app.local.model.current()?.modelID).toBe("other")
      expect(app.local.model.variant.selected()).toBe("default")
      app.prompt.submit()
      if (kind === "command") {
        // A command response is never proof that the command was cancelled.
        await wait(() => app.local.model.uncertain("a") === "unknown")
        await Bun.sleep(20)
        expect(bodies).toHaveLength(1)
      } else {
        await wait(() => bodies.length === 2)
        expect(bodies[1].model).toEqual({ providerID: "test", modelID: "other" })
        expect(bodies[1].variant).toBe("default")
      }
    } finally {
      releaseModel()
      rejectFirst()
      await app.dispose()
    }
  },
)

test("interrupt does not roll back a later variant choice", async () => {
  let rejectFirst!: () => void
  const gate = new Promise<void>((resolve) => (rejectFirst = resolve))
  let submitted = false
  let variants = 0
  let aborts = 0
  const app = await mount(
    async () => {
      variants++
      return json(true)
    },
    async () => {
      submitted = true
      await gate
      return json({ _tag: "InvalidRequestError", message: "interrupted" }, { status: 400 })
    },
    undefined,
    async () => {
      aborts++
      app.sync.set("session_status", "a", { type: "idle" })
      return json(true)
    },
  )
  try {
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.sync.set("session_status", "a", { type: "busy" })
    app.prompt.set({ input: "first", parts: [] })
    app.prompt.submit()
    await wait(() => submitted)
    app.local.model.variant.cycle()
    expect(app.local.model.variant.current()).toBe("high")
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("ESCAPE")
    app.app.mockInput.pressKey("ESCAPE")
    await wait(() => aborts === 1 && variants === 1)
    expect(app.local.model.variant.current()).toBe("high")
    rejectFirst()
    await Bun.sleep(20)
    expect(app.local.model.variant.current()).toBe("high")
  } finally {
    rejectFirst()
    await app.dispose()
  }
})

test.each(["prompt", "command"])("interrupt preserves a pending variant for an immediate %s retry", async (kind) => {
  let releaseVariant!: () => void
  const gate = new Promise<void>((resolve) => (releaseVariant = resolve))
  let requests = 0
  let aborts = 0
  let durable = "default"
  const sent: Array<{ variant?: string }> = []
  const app = await mount(
    async (request) => {
      const body = await request.json()
      requests++
      await gate
      durable = body.variant
      return json(true)
    },
    async (request) => {
      const body = await request.json()
      sent.push(body)
      durable = body.variant
      return json({})
    },
    undefined,
    async () => {
      aborts++
      app.sync.set("session_status", "a", { type: "idle" })
      return json(true)
    },
  )
  try {
    app.sync.set("command", [{ name: "test", template: "test", hints: [] }])
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.sync.set("session_status", "a", { type: "busy" })
    app.local.model.variant.cycle()
    await wait(() => requests === 1)
    const draft = kind === "command" ? "/test" : "retry me"
    app.prompt.set({ input: draft, parts: [] })
    app.prompt.submit()
    await Bun.sleep(0)
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("ESCAPE")
    app.app.mockInput.pressKey("ESCAPE")
    await wait(() => aborts === 1)
    expect(app.local.model.variant.current()).toBe("high")
    expect(app.prompt.current.input).toBe(draft)
    app.prompt.submit()
    await Bun.sleep(0)
    expect(sent).toEqual([])
    releaseVariant()
    await wait(() => sent.length === 1)
    expect(sent[0].variant).toBe("high")
    expect(durable).toBe("high")
  } finally {
    releaseVariant()
    await app.dispose()
  }
})

test.each([true, false])(
  "interrupt leaves the next variant cycle after the pending selection (first succeeds: %s)",
  async (firstSucceeds) => {
    let releaseVariant!: () => void
    const gate = new Promise<void>((resolve) => (releaseVariant = resolve))
    let requests = 0
    let aborts = 0
    const app = await mount(
      async () => {
        requests++
        if (requests === 1) {
          await gate
          if (!firstSucceeds) return json({ message: "refused" }, { status: 400 })
        }
        return json(true)
      },
      async () => json({}),
      undefined,
      async () => {
        aborts++
        app.sync.set("session_status", "a", { type: "idle" })
        return json(true)
      },
    )
    try {
      app.route.navigate({ type: "session", sessionID: "a" })
      await wait(() => app.local.model.variant.selected() === "default")
      app.sync.set("session_status", "a", { type: "busy" })
      app.local.model.variant.cycle()
      await wait(() => requests === 1)
      app.prompt.set({ input: "cancel", parts: [] })
      app.prompt.submit()
      await Bun.sleep(0)
      app.prompt.focus()
      await app.app.renderOnce()
      app.app.mockInput.pressKey("ESCAPE")
      app.app.mockInput.pressKey("ESCAPE")
      await wait(() => aborts === 1)
      expect(app.local.model.variant.current()).toBe("high")
      app.local.model.variant.cycle()
      expect(app.local.model.variant.current()).toBe("xhigh")
      releaseVariant()
      await wait(() => requests === 2)
      expect(app.local.model.variant.current()).toBe("xhigh")
    } finally {
      releaseVariant()
      await app.dispose()
    }
  },
)

test("a pending variant that fails after interrupt rolls back to the confirmed default", async () => {
  let releaseVariant!: () => void
  const gate = new Promise<void>((resolve) => (releaseVariant = resolve))
  let requests = 0
  let aborts = 0
  const app = await mount(
    async () => {
      requests++
      await gate
      return json({ message: "refused" }, { status: 400 })
    },
    async () => json({}),
    undefined,
    async () => {
      aborts++
      app.sync.set("session_status", "a", { type: "idle" })
      return json(true)
    },
  )
  try {
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.sync.set("session_status", "a", { type: "busy" })
    app.local.model.variant.cycle()
    await wait(() => requests === 1)
    app.prompt.set({ input: "cancel", parts: [] })
    app.prompt.submit()
    await Bun.sleep(0)
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("ESCAPE")
    app.app.mockInput.pressKey("ESCAPE")
    await wait(() => aborts === 1)
    expect(app.local.model.variant.current()).toBe("high")
    releaseVariant()
    await wait(() => app.local.model.variant.selected() === "default")
    expect(app.local.model.variant.current()).toBeUndefined()
  } finally {
    releaseVariant()
    await app.dispose()
  }
})

test.each([
  ["prompt", "before"],
  ["prompt", "after"],
  ["command", "before"],
  ["command", "after"],
])("a %s invalidates an earlier restore that finishes %s acceptance", async (kind, order) => {
  let releaseRead!: () => void
  let readConsumed!: () => void
  let acceptSubmit!: () => void
  const readGate = new Promise<void>((resolve) => (releaseRead = resolve))
  const consumed = new Promise<void>((resolve) => (readConsumed = resolve))
  const submitGate = new Promise<void>((resolve) => (acceptSubmit = resolve))
  let reads = 0
  let durable = "default"
  let submitted: unknown
  let stale: unknown
  const app = await mount(
    async (request) => {
      const body: unknown = await request.json()
      if (body && typeof body === "object" && "variant" in body && typeof body.variant === "string")
        durable = body.variant
      else durable = "default"
      return json(true)
    },
    async (request) => {
      const body: unknown = await request.json()
      if (!body || typeof body !== "object" || !("variant" in body)) throw new Error("missing submitted variant")
      submitted = body.variant
      if (order === "before") await submitGate
      if (typeof submitted === "string") durable = submitted
      return json({})
    },
    async () => {
      reads++
      if (reads > 1) {
        const session = app.sync.session.get("a")
        if (!session?.model) throw new Error("missing session model")
        const current = structuredClone(unwrap(session))
        if (!current.model) throw new Error("missing current model")
        current.model.variant = durable
        return json(current)
      }
      await readGate
      const response = json(stale)
      const text = response.text.bind(response)
      response.text = async () => {
        const result = await text()
        readConsumed()
        return result
      }
      return response
    },
  )
  try {
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    await app.local.model.set({ providerID: "test", modelID: "m" })
    expect(durable).toBe("default")
    const session = app.sync.session.get("a")
    if (!session?.model) throw new Error("missing session model")
    const snapshot = structuredClone(unwrap(session))
    if (!snapshot.model) throw new Error("missing snapshot model")
    durable = "xhigh"
    snapshot.model.variant = durable
    stale = snapshot
    app.route.navigate({ type: "session", sessionID: "b" })
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => reads === 1)
    if (kind === "command") app.sync.set("command", [{ name: "test", template: "test", hints: [] }])
    app.prompt.set({ input: kind === "command" ? "/test" : "hello", parts: [] })
    app.prompt.submit()
    await wait(() => submitted !== undefined)
    expect(submitted).toBe("default")
    if (order === "before") {
      releaseRead()
      await consumed
      await Bun.sleep(0)
      expect(app.local.model.variant.selected()).toBe("default")
      acceptSubmit()
      await wait(() => durable === "default")
    }
    expect(durable).toBe("default")
    if (order === "after") {
      releaseRead()
      await consumed
      await Bun.sleep(0)
    }
    expect(app.local.model.variant.selected()).toBe("default")
    expect(app.local.model.variant.current()).toBeUndefined()
    expect(durable).toBe("default")
  } finally {
    releaseRead()
    acceptSubmit()
    await app.dispose()
  }
})

test("reopening during submission keeps the choice without starting a restore", async () => {
  let accept!: () => void
  let releaseRead!: () => void
  const acceptance = new Promise<void>((resolve) => (accept = resolve))
  const readGate = new Promise<void>((resolve) => (releaseRead = resolve))
  let submitted: unknown
  const reads: string[] = []
  let durable = "default"
  let stale: unknown
  const app = await mount(
    async () => {
      durable = "default"
      return json(true)
    },
    async (request) => {
      const body: unknown = await request.json()
      if (!body || typeof body !== "object" || !("variant" in body)) throw new Error("missing submitted variant")
      submitted = body.variant
      await acceptance
      if (typeof submitted === "string") durable = submitted
      return json({})
    },
    async (request) => {
      reads.push(new URL(request.url).pathname)
      await readGate
      return json(stale)
    },
  )
  try {
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    await app.local.model.set({ providerID: "test", modelID: "m" })
    const session = app.sync.session.get("a")
    if (!session?.model) throw new Error("missing session model")
    const snapshot = structuredClone(unwrap(session))
    if (!snapshot.model) throw new Error("missing snapshot model")
    durable = "xhigh"
    snapshot.model.variant = durable
    stale = snapshot
    app.prompt.set({ input: "hello", parts: [] })
    app.prompt.submit()
    await wait(() => submitted !== undefined)
    expect(app.sync.data.pending_submission.a).toBeDefined()
    app.route.navigate({ type: "session", sessionID: "b" })
    app.route.navigate({ type: "session", sessionID: "a" })
    await Bun.sleep(0)
    expect(reads).toEqual([])
    accept()
    await wait(() => app.sync.data.pending_submission.a === undefined)
    expect(submitted).toBe("default")
    expect(durable).toBe("default")
    expect(app.local.model.variant.selected()).toBe("default")
  } finally {
    accept()
    releaseRead()
    await app.dispose()
  }
})

test("a prompt waits for the previous model request and acceptance releases later variant choices once", async () => {
  let releaseModel!: () => void
  let releasePrompt!: () => void
  const modelGate = new Promise<void>((resolve) => (releaseModel = resolve))
  const promptGate = new Promise<void>((resolve) => (releasePrompt = resolve))
  const models: string[] = []
  let messageID = ""
  let submittedModel = ""
  let submittedVariant: unknown
  const app = await mount(
    async (request) => {
      const body = await request.json()
      models.push(body.model.modelID)
      if (models.length === 1) await modelGate
      return json(true)
    },
    async (request) => {
      const body = await request.json()
      messageID = body.messageID
      submittedModel = body.model.modelID
      submittedVariant = body.variant
      await promptGate
      return json({ message: "late failure" }, { status: 500 })
    },
  )
  try {
    const original = app.sync.data.provider[0].models.m
    app.sync.set("provider", 0, "models", "other", { ...original, id: "other" })
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    const first = app.local.model.set({ providerID: "test", modelID: "other" })
    await wait(() => models.length === 1)
    app.prompt.set({ input: "hello", parts: [] })
    app.prompt.submit()
    await Bun.sleep(0)
    expect(messageID).toBe("")
    releaseModel()
    await first
    await wait(() => Boolean(messageID))
    expect(submittedModel).toBe("m")
    expect(submittedVariant).toBe("default")
    app.local.model.variant.cycle()
    const info = {
      id: messageID,
      sessionID: "a",
      role: "user" as const,
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test", modelID: "m", variant: "default" },
    }
    for (const id of ["one", "two"])
      app.events.emit({ directory, payload: { id, type: "message.updated", properties: { sessionID: "a", info } } })
    await wait(() => models.length === 2)
    expect(models).toEqual(["other", "m"])
    expect(app.local.model.variant.current()).toBe("high")
    releasePrompt()
    await Bun.sleep(20)
    expect(app.local.model.variant.current()).toBe("high")
    expect(app.sync.data.failed_submission.a).toBeUndefined()
  } finally {
    releaseModel()
    releasePrompt()
    await app.dispose()
  }
})

test("a pending model request in A does not block model selection in B", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const requests: string[] = []
  const app = await mount(async (request) => {
    const sessionID = new URL(request.url).pathname.split("/")[2]
    requests.push(sessionID)
    if (sessionID === "a") await gate
    return json(true)
  })
  try {
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    const a = app.local.model.set({ providerID: "test", modelID: "m" })
    await wait(() => requests.length === 1)
    app.route.navigate({ type: "session", sessionID: "b" })
    const b = app.local.model.set({ providerID: "test", modelID: "m" })
    expect(await b).toBe(true)
    expect(requests).toEqual(["a", "b"])
    release()
    await a
  } finally {
    release()
    await app.dispose()
  }
})

test("a pending selection in A does not block B's fresh session read", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let started = false
  let reads = 0
  let fresh: unknown
  const app = await mount(
    async (request) => {
      if (new URL(request.url).pathname === "/session/a/model") {
        started = true
        await gate
      }
      return json(true)
    },
    undefined,
    async () => {
      reads++
      return json(fresh)
    },
  )
  try {
    app.route.navigate({ type: "session", sessionID: "b" })
    await wait(() => app.local.model.variant.selected() === "xhigh")
    await app.local.model.set({ providerID: "test", modelID: "m" })
    const session = app.sync.session.get("b")
    if (!session?.model) throw new Error("missing session model")
    const snapshot = structuredClone(unwrap(session))
    if (!snapshot.model) throw new Error("missing snapshot model")
    snapshot.model.variant = "high"
    fresh = snapshot
    app.route.navigate({ type: "session", sessionID: "a" })
    const pending = app.local.model.set({ providerID: "test", modelID: "m" })
    await wait(() => started)
    app.route.navigate({ type: "session", sessionID: "b" })
    await wait(() => reads === 1 && app.local.model.variant.current() === "high")
    release()
    await pending
  } finally {
    release()
    await app.dispose()
  }
})

test("duplicate acceptance and late HTTP completion do not release a later prompt", async () => {
  let firstDone!: () => void
  let secondDone!: () => void
  const firstGate = new Promise<void>((resolve) => (firstDone = resolve))
  const secondGate = new Promise<void>((resolve) => (secondDone = resolve))
  const ids: string[] = []
  let variants = 0
  const app = await mount(
    async () => {
      variants++
      return json(true)
    },
    async (request) => {
      ids.push((await request.json()).messageID)
      await (ids.length === 1 ? firstGate : secondGate)
      return json({})
    },
  )
  try {
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    const accept = (id: string) => {
      const info = {
        id,
        sessionID: "a",
        role: "user" as const,
        time: { created: 1 },
        agent: "build",
        model: { providerID: "test", modelID: "m", variant: "default" },
      }
      app.events.emit({
        directory,
        payload: { id: `accepted-${id}`, type: "message.updated", properties: { sessionID: "a", info } },
      })
    }
    app.prompt.set({ input: "first", parts: [] })
    app.prompt.submit()
    await wait(() => ids.length === 1)
    accept(ids[0])
    app.prompt.set({ input: "second", parts: [] })
    app.prompt.submit()
    await wait(() => ids.length === 2)
    app.local.model.variant.cycle()
    accept(ids[0])
    firstDone()
    await Bun.sleep(20)
    expect(variants).toBe(0)
    accept(ids[1])
    await wait(() => variants === 1)
    expect(app.local.model.variant.current()).toBe("high")
  } finally {
    firstDone()
    secondDone()
    await app.dispose()
  }
})

test("deleting a session prevents its queued prompt from being sent", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let models = 0
  let prompts = 0
  const app = await mount(
    async () => {
      models++
      await gate
      return json(true)
    },
    async () => {
      prompts++
      return json({})
    },
  )
  try {
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    const model = app.local.model.set({ providerID: "test", modelID: "m" })
    await wait(() => models === 1)
    app.prompt.set({ input: "queued", parts: [] })
    app.prompt.submit()
    const info = app.sync.session.get("a")
    if (!info) throw new Error("missing session")
    app.events.emit({
      directory,
      payload: {
        id: "deleted",
        type: "session.deleted",
        properties: { sessionID: "a", info: structuredClone(unwrap(info)) },
      },
    })
    app.flush()
    release()
    await model
    await Bun.sleep(20)
    expect(prompts).toBe(0)
  } finally {
    release()
    await app.dispose()
  }
})

test("remounting the prompt does not cancel an in-flight submission or release its queue", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let id = ""
  let variants = 0
  const app = await mount(
    async () => {
      variants++
      return json(true)
    },
    async (request) => {
      id = (await request.json()).messageID
      await gate
      return json({})
    },
  )
  try {
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.prompt.set({ input: "first", parts: [] })
    app.prompt.submit()
    await wait(() => Boolean(id))
    app.remount()
    app.local.model.variant.cycle()
    await Bun.sleep(20)
    expect(variants).toBe(0)
    const info = {
      id,
      sessionID: "a",
      role: "user" as const,
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test", modelID: "m", variant: "default" },
    }
    app.events.emit({
      directory,
      payload: { id: "remount-accepted", type: "message.updated", properties: { sessionID: "a", info } },
    })
    await wait(() => variants === 1)
    expect(app.local.model.variant.current()).toBe("high")
  } finally {
    release()
    await app.dispose()
  }
})

test("provider cleanup prevents queued prompt requests from starting", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let models = 0
  let prompts = 0
  const app = await mount(
    async () => {
      models++
      await gate
      return json(true)
    },
    async () => {
      prompts++
      return json({})
    },
  )
  app.route.navigate({ type: "session", sessionID: "a" })
  await wait(() => app.local.model.variant.selected() === "default")
  const model = app.local.model.set({ providerID: "test", modelID: "m" })
  await wait(() => models === 1)
  app.prompt.set({ input: "queued", parts: [] })
  app.prompt.submit()
  await app.dispose()
  release()
  await model
  await Bun.sleep(20)
  expect(prompts).toBe(0)
})

test.each(["m", "other"])("command acceptance confirms the actual server model %s", async (serverModel) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let messageID = ""
  let reads = 0
  let snapshot: unknown
  const app = await mount(
    async () => json(true),
    async (request) => {
      messageID = (await request.json()).messageID
      await gate
      return json({})
    },
    async () => {
      reads++
      return json(snapshot)
    },
  )
  try {
    const original = app.sync.data.provider[0].models.m
    app.sync.set("provider", 0, "models", "other", { ...original, id: "other" })
    app.sync.set("command", [{ name: "test", template: "test", hints: [] }])
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    const session = app.sync.session.get("a")
    if (!session?.model) throw new Error("missing session model")
    const fresh = structuredClone(unwrap(session))
    if (!fresh.model) throw new Error("missing session model")
    fresh.model.id = serverModel
    fresh.model.variant = "high"
    snapshot = fresh
    app.prompt.set({ input: "/test", parts: [] })
    app.prompt.submit()
    await wait(() => Boolean(messageID))
    const info = {
      id: messageID,
      sessionID: "a",
      role: "user" as const,
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test", modelID: serverModel },
    }
    app.events.emit({
      directory,
      payload: { id: "command-accepted", type: "message.updated", properties: { sessionID: "a", info } },
    })
    await wait(
      () =>
        reads === 1 &&
        app.local.model.current()?.modelID === serverModel &&
        app.local.model.variant.current() === "high",
    )
  } finally {
    release()
    await app.dispose()
  }
})

test("a failed command confirmation read releases later choices without inventing a model", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let messageID = ""
  let variants = 0
  let reads = 0
  const app = await mount(
    async () => {
      variants++
      return json(true)
    },
    async (request) => {
      messageID = (await request.json()).messageID
      await gate
      return json({})
    },
    async () => {
      reads++
      return json({ message: "unavailable" }, { status: 500 })
    },
  )
  try {
    app.sync.set("command", [{ name: "test", template: "test", hints: [] }])
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.prompt.set({ input: "/test", parts: [] })
    app.prompt.submit()
    await wait(() => Boolean(messageID))
    app.local.model.variant.cycle()
    const info = {
      id: messageID,
      sessionID: "a",
      role: "user" as const,
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test", modelID: "m" },
    }
    app.events.emit({
      directory,
      payload: { id: "command-read-failure", type: "message.updated", properties: { sessionID: "a", info } },
    })
    await wait(() => reads === 1 && variants === 1)
    expect(app.local.model.current()?.modelID).toBe("m")
    expect(app.local.model.variant.current()).toBe("high")
  } finally {
    release()
    await app.dispose()
  }
})

test("a model selected after prompt acceptance survives the late prompt response", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let messageID = ""
  const app = await mount(
    async () => json(true),
    async (request) => {
      messageID = (await request.json()).messageID
      await gate
      return json({})
    },
  )
  try {
    const original = app.sync.data.provider[0].models.m
    app.sync.set("provider", 0, "models", "other", { ...original, id: "other" })
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.prompt.set({ input: "hello", parts: [] })
    app.prompt.submit()
    await wait(() => Boolean(messageID))
    const info = {
      id: messageID,
      sessionID: "a",
      role: "user" as const,
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test", modelID: "m", variant: "default" },
    }
    app.events.emit({
      directory,
      payload: { id: "model-after-prompt", type: "message.updated", properties: { sessionID: "a", info } },
    })
    expect(await app.local.model.set({ providerID: "test", modelID: "other" })).toBe(true)
    release()
    await Bun.sleep(20)
    expect(app.local.model.current()?.modelID).toBe("other")
  } finally {
    release()
    await app.dispose()
  }
})

test("a prompt rejected before acceptance releases the session for the next selection", async () => {
  let rejected = false
  let models = 0
  const app = await mount(
    async () => {
      models++
      return json(true)
    },
    async () => {
      rejected = true
      return json({ message: "refused" }, { status: 400 })
    },
  )
  try {
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.prompt.set({ input: "hello", parts: [] })
    app.prompt.submit()
    await wait(() => rejected)
    app.local.model.variant.cycle()
    await wait(() => models === 1)
    expect(app.local.model.variant.current()).toBe("high")
  } finally {
    await app.dispose()
  }
})

test("a prompt without a variant does not invent a confirmed default", async () => {
  let submitted = false
  let suppliedVariant = true
  let reads = 0
  let snapshot: unknown
  let readConsumed!: () => void
  const consumed = new Promise<void>((resolve) => (readConsumed = resolve))
  const app = await mount(
    async () => json(true),
    async (request) => {
      const body: unknown = await request.json()
      suppliedVariant = !!body && typeof body === "object" && "variant" in body
      submitted = true
      return json({})
    },
    async () => {
      reads++
      const response = json(snapshot)
      const text = response.text.bind(response)
      response.text = async () => {
        const result = await text()
        readConsumed()
        return result
      }
      return response
    },
  )
  try {
    app.sync.set("session", 0, "model", "variant", undefined)
    const session = app.sync.session.get("a")
    if (!session) throw new Error("missing session")
    snapshot = structuredClone(unwrap(session))
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === undefined)
    app.prompt.set({ input: "hello", parts: [] })
    app.prompt.submit()
    await wait(() => submitted && reads === 1)
    await consumed
    await Bun.sleep(0)
    expect(suppliedVariant).toBe(false)
    expect(app.local.model.variant.selected()).toBeUndefined()
  } finally {
    await app.dispose()
  }
})

test("a variant selected on the visible model wins over an earlier in-flight model switch", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const calls: Array<{ model: { modelID: string }; variant?: string }> = []
  const app = await mount(async (request) => {
    calls.push(await request.json())
    if (calls.length === 1) await gate
    return json(true)
  })
  try {
    const original = app.sync.data.provider[0].models.m
    app.sync.set("provider", 0, "models", "other", { ...original, id: "other" })
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.local.model.cycle(1)
    await wait(() => calls.length === 1)
    expect(app.local.model.current()?.modelID).toBe("m")
    app.local.model.variant.cycle()
    release()
    await wait(() => calls.length === 2)
    expect(calls.map((call) => [call.model.modelID, call.variant])).toEqual([
      ["other", undefined],
      ["m", "high"],
    ])
    await wait(() => app.local.model.current()?.modelID === "m" && app.local.model.variant.current() === "high")
  } finally {
    release()
    await app.dispose()
  }
})

test("a late session update cannot confirm an old round-trip value or overwrite the final variant", async () => {
  const calls: string[] = []
  let releaseRead!: () => void
  const gate = new Promise<void>((resolve) => (releaseRead = resolve))
  let reads = 0
  let fresh: unknown
  const app = await mount(
    async (request) => {
      const body: unknown = await request.json()
      if (!body || typeof body !== "object") throw new Error("invalid model request")
      calls.push("variant" in body && typeof body.variant === "string" ? body.variant : "default")
      return json(true)
    },
    undefined,
    async () => {
      reads++
      await gate
      return json(fresh)
    },
  )
  try {
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.local.model.variant.cycle()
    app.local.model.variant.cycle()
    app.local.model.variant.cycle()
    // This queued no-op waits for all three variant HTTP responses.
    await app.local.model.set({ providerID: "test", modelID: "m" })
    expect(calls).toEqual(["high", "xhigh", "default", "default"])
    const initial = app.sync.session.get("a")
    if (!initial?.model) throw new Error("missing session model")
    fresh = structuredClone(unwrap(initial))
    const stale = structuredClone(unwrap(initial))
    if (!stale.model) throw new Error("missing stale model")
    stale.model.variant = "high"
    stale.time.updated = 1
    app.events.emit({
      directory,
      payload: { id: "evt_stale", type: "session.updated", properties: { sessionID: "a", info: stale } },
    })
    await wait(() => app.sync.session.get("a")?.model?.variant === "high")
    app.route.navigate({ type: "session", sessionID: "b" })
    app.route.navigate({ type: "session", sessionID: "a" })
    expect(app.local.model.variant.selected()).toBe("default")
    expect(app.local.model.variant.current()).toBeUndefined()
    await wait(() => reads === 1)
    releaseRead()
  } finally {
    releaseRead()
    await app.dispose()
  }
})

test("reopening a locally selected session checks fresh server state for external changes", async () => {
  let fresh: unknown
  let reads = 0
  const app = await mount(
    async () => json(true),
    undefined,
    async () => {
      reads++
      return json(fresh)
    },
  )
  try {
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.local.model.variant.cycle()
    await app.local.model.set({ providerID: "test", modelID: "m" })
    const current = app.sync.session.get("a")
    if (!current?.model) throw new Error("missing session model")
    const external = structuredClone(unwrap(current))
    if (!external.model) throw new Error("missing external model")
    external.model.variant = "xhigh"
    fresh = external
    app.route.navigate({ type: "session", sessionID: "b" })
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => reads > 0 && app.local.model.variant.current() === "xhigh")
  } finally {
    await app.dispose()
  }
})

test("a refused visible-model variant restores the preceding accepted model", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let count = 0
  const app = await mount(async () => {
    count++
    if (count === 1) {
      await gate
      return json(true)
    }
    return json({ message: "refused" }, { status: 400 })
  })
  try {
    const original = app.sync.data.provider[0].models.m
    app.sync.set("provider", 0, "models", "other", { ...original, id: "other" })
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    const switched = app.local.model.set({ providerID: "test", modelID: "other" })
    await wait(() => count === 1)
    app.local.model.variant.cycle()
    release()
    await switched
    await wait(() => count === 2 && app.local.model.current()?.modelID === "other")
    expect(app.local.model.variant.selected()).toBe("default")
  } finally {
    release()
    await app.dispose()
  }
})

test("a delayed fresh-session response cannot replace a newer unsent variant selection", async () => {
  let releaseRead!: () => void
  let releaseVariant!: () => void
  const readGate = new Promise<void>((resolve) => (releaseRead = resolve))
  const variantGate = new Promise<void>((resolve) => (releaseVariant = resolve))
  let reads = 0
  let calls = 0
  let stale: unknown
  const app = await mount(
    async () => {
      calls++
      if (calls === 3) await variantGate
      return json(true)
    },
    undefined,
    async () => {
      reads++
      await readGate
      return json(stale)
    },
  )
  try {
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.local.model.variant.cycle()
    await app.local.model.set({ providerID: "test", modelID: "m" })
    stale = JSON.parse(JSON.stringify(app.sync.session.get("a")))
    app.route.navigate({ type: "session", sessionID: "b" })
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => reads === 1)
    app.local.model.variant.cycle()
    await wait(() => calls === 3)
    releaseRead()
    await Bun.sleep(20)
    expect(app.local.model.variant.current()).toBe("high")
  } finally {
    releaseRead()
    releaseVariant()
    await app.dispose()
  }
})

test("a restored default is sent explicitly in a prompt", async () => {
  let variant: unknown
  const app = await mount(
    async () => json(true),
    async (request) => {
      variant = (await request.json()).variant
      return json({})
    },
  )
  try {
    app.route.navigate({ type: "session", sessionID: "b" })
    await wait(() => app.local.model.variant.selected() === "xhigh")
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.prompt.set({ input: "hello", parts: [] })
    app.prompt.submit()
    await wait(() => variant !== undefined)
    expect(variant).toBe("default")
  } finally {
    await app.dispose()
  }
})

test("a rejected later cycle rolls back to the preceding accepted variant", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let count = 0
  const app = await mount(async () => {
    count++
    if (count === 1) {
      await gate
      return json(true)
    }
    return json({ message: "refused" }, { status: 400 })
  })
  try {
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.local.model.variant.cycle()
    await wait(() => count === 1)
    app.local.model.variant.cycle()
    release()
    await wait(() => count === 2)
    await Bun.sleep(30)
    expect(app.local.model.variant.current()).toBe("high")
  } finally {
    release()
    await app.dispose()
  }
})

test("a queued model switch follows the variant update without restoring the old model", async () => {
  let release!: () => void
  let releaseVariant!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const variantGate = new Promise<void>((resolve) => (releaseVariant = resolve))
  const calls: Array<{ model: { modelID: string }; variant?: string }> = []
  const app = await mount(async (request) => {
    calls.push(await request.json())
    if (calls.length === 1) await gate
    if (calls.length === 3) await variantGate
    return json(true)
  })
  try {
    const original = app.sync.data.provider[0].models.m
    app.sync.set("provider", 0, "models", "other", { ...original, id: "other" })
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.local.model.variant.cycle()
    await wait(() => calls.length === 1)
    const switched = app.local.model.set({ providerID: "test", modelID: "other" })
    release()
    expect(await switched).toBe(true)
    expect(calls.map((call) => [call.model.modelID, call.variant])).toEqual([
      ["m", "high"],
      ["other", undefined],
    ])
    expect(app.local.model.current()?.modelID).toBe("other")
    app.local.model.variant.cycle()
    await wait(() => calls.length === 3)
    app.route.navigate({ type: "session", sessionID: "b" })
    await wait(() => app.local.model.current()?.modelID === "m")
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.current()?.modelID === "other")
    expect(app.local.model.variant.current()).toBe("high")
  } finally {
    release()
    releaseVariant()
    await app.dispose()
  }
})

test("restores session variants without changing global preference and persists rapid cycles across switches", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const requests: Array<{ sessionID: string; variant: string }> = []
  const app = await mount(async (request) => {
    const body = (await request.json()) as { variant: string }
    requests.push({ sessionID: new URL(request.url).pathname.split("/")[2], variant: body.variant })
    if (requests.length === 1) await gate
    return json(true)
  })
  try {
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    expect(app.local.model.variant.current()).toBeUndefined()
    app.local.model.variant.cycle()
    await wait(() => requests.length === 1)
    app.local.model.variant.cycle()
    expect(app.local.model.variant.current()).toBe("xhigh")
    app.route.navigate({ type: "session", sessionID: "b" })
    await wait(() => app.local.model.variant.current() === "xhigh")
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.current() === "xhigh")
    app.local.model.variant.cycle()
    expect(app.local.model.variant.selected()).toBe("default")
    release()
    await wait(() => requests.length === 3)
    expect(requests).toEqual([
      { sessionID: "a", variant: "high" },
      { sessionID: "a", variant: "xhigh" },
      { sessionID: "a", variant: "default" },
    ])
    app.route.navigate({ type: "home" })
    expect(app.local.model.variant.current()).toBe("xhigh")
    expect(JSON.parse(await Bun.file(`${app.tmp.path}/model.json`).text()).variant).toEqual({ "test/m": "xhigh" })
  } finally {
    release()
    await app.dispose()
  }
})

test("failed variant persistence rolls back the original session after switching away", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let started = false
  const app = await mount(async () => {
    started = true
    await gate
    return json({ message: "refused" }, { status: 400 })
  })
  try {
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.local.model.variant.cycle()
    await wait(() => started)
    app.route.navigate({ type: "session", sessionID: "b" })
    release()
    await Bun.sleep(30)
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    expect(app.local.model.variant.current()).toBeUndefined()
  } finally {
    release()
    await app.dispose()
  }
})
test.each([404, 500, 502, 504])(
  "a %i command before acceptance stays unknown and preserves the later variant",
  async (status) => {
    let commandID = ""
    const variantWrites: Array<string | undefined> = []
    let durable = "xhigh"
    const app = await mount(
      async (request) => {
        const body = await request.json()
        variantWrites.push(body.variant)
        durable = body.variant
        return json(true)
      },
      async (request) => {
        const body = await request.json()
        commandID = body.messageID
        expect(body.variant).toBe("xhigh")
        // Mirrors the proxy body that previously fooled identifiableApiError.
        return json({ name: "UnknownError", data: { message: "gateway" } }, { status })
      },
      async () => json({ model: { id: "m", providerID: "test", variant: durable } }),
    )
    try {
      app.sync.set("session", 0, "model", "variant", "xhigh")
      app.sync.set("command", [{ name: "test", template: "test", hints: [] }])
      app.route.navigate({ type: "session", sessionID: "a" })
      await wait(() => app.local.model.variant.selected() === "xhigh")
      app.sync.set("session_status", "a", { type: "busy" })
      app.prompt.set({ input: "/test old", parts: [] })
      app.prompt.submit()
      await wait(() => Boolean(commandID))
      await wait(() => app.local.model.uncertain("a") === "unknown")
      await app.app.renderOnce()
      expect(app.app.captureCharFrame().replace(/\s+/g, " ")).toContain(
        t("prompt.submit.unconfirmed").split(/[;；]/)[0]!.slice(0, 10),
      )
      expect(app.app.captureCharFrame()).not.toContain("Failed to send prompt")
      app.local.model.variant.cycle()
      app.local.model.variant.cycle()
      expect(app.local.model.variant.current()).toBe("high")
      // An explicit model write is the newest user intent and must not wait for
      // the unconfirmed command; the server fence protects it from the late command.
      await wait(() => variantWrites.at(-1) === "high")
      expect(variantWrites).not.toContain("xhigh")
      const info = {
        id: commandID,
        sessionID: "a",
        role: "user" as const,
        time: { created: 1 },
        agent: "build",
        model: { providerID: "test", modelID: "m", variant: "xhigh" },
      }
      app.events.emit({
        directory,
        payload: { id: "late-command-accepted", type: "message.updated", properties: { sessionID: "a", info } },
      })
      await wait(() => app.local.model.uncertain("a") === undefined)
      expect(app.local.model.variant.current()).toBe("high")
      expect(durable).toBe("high")
    } finally {
      await app.dispose()
    }
  },
)

test("a command failure after acceptance cannot reopen unknown or revert the later variant", async () => {
  let commandID = ""
  let releaseResponse!: () => void
  const responseGate = new Promise<void>((resolve) => (releaseResponse = resolve))
  const variantWrites: Array<string | undefined> = []
  let app!: Awaited<ReturnType<typeof mount>>
  const acceptedInfo = () => ({
    id: commandID,
    sessionID: "a",
    role: "user" as const,
    time: { created: 1 },
    agent: "build",
    model: { providerID: "test", modelID: "m", variant: "xhigh" },
  })
  app = await mount(
    async (request) => {
      variantWrites.push((await request.json()).variant)
      return json(true)
    },
    async (request) => {
      commandID = (await request.json()).messageID
      app.events.emit({
        directory,
        payload: {
          id: "early-command-accepted",
          type: "message.updated",
          properties: { sessionID: "a", info: acceptedInfo() },
        },
      })
      await responseGate
      return json({ error: "gateway" }, { status: 502 })
    },
    async () => json({ model: { id: "m", providerID: "test", variant: "xhigh" } }),
  )
  try {
    app.sync.set("session", 0, "model", "variant", "xhigh")
    app.sync.set("command", [{ name: "test", template: "test", hints: [] }])
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "xhigh")
    app.sync.set("session_status", "a", { type: "busy" })
    app.prompt.set({ input: "/test old", parts: [] })
    app.prompt.submit()
    await wait(() => Boolean(commandID))
    app.local.model.variant.cycle()
    app.local.model.variant.cycle()
    await wait(() => variantWrites.at(-1) === "high")
    expect(app.local.model.variant.current()).toBe("high")
    releaseResponse()
    await Bun.sleep(40)
    expect(app.local.model.uncertain("a")).toBeUndefined()
    expect(app.local.model.variant.current()).toBe("high")
  } finally {
    releaseResponse()
    await app.dispose()
  }
})

test("a command rejection response stays unknown until exact acceptance", async () => {
  let commandID = ""
  const app = await mount(
    async () => json(true),
    async (request) => {
      commandID = (await request.json()).messageID
      return json({ _tag: "InvalidRequestError", message: "refused" }, { status: 400 })
    },
  )
  try {
    app.sync.set("command", [{ name: "test", template: "test", hints: [] }])
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.sync.set("session_status", "a", { type: "busy" })
    app.prompt.set({ input: "/test refused", parts: [] })
    app.prompt.submit()
    await wait(() => Boolean(commandID))
    await wait(() => app.local.model.uncertain("a") === "unknown")
    // A negative response body is not proof that the command was cancelled.
    expect(app.prompt.current.input).toBe("")
  } finally {
    await app.dispose()
  }
})
test("an interrupted ordinary prompt clears unknown when its own response settles", async () => {
  let releaseResponse!: () => void
  const gate = new Promise<void>((resolve) => (releaseResponse = resolve))
  let prompts = 0
  let aborts = 0
  const app = await mount(
    async () => json(true),
    async () => {
      prompts++
      await gate
      return json({})
    },
    undefined,
    async () => {
      aborts++
      return json(true)
    },
  )
  try {
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.sync.set("session_status", "a", { type: "busy" })
    app.prompt.set({ input: "interrupted prompt", parts: [] })
    app.prompt.submit()
    await wait(() => prompts === 1)
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("ESCAPE")
    await Bun.sleep(40)
    app.app.mockInput.pressKey("ESCAPE")
    await wait(() => aborts === 1 && app.local.model.uncertain("a") === "stopping")
    releaseResponse()
    await wait(() => app.local.model.uncertain("a") === undefined)
    app.prompt.set({ input: "next prompt", parts: [] })
    app.prompt.submit()
    await wait(() => prompts === 2)
  } finally {
    releaseResponse()
    await app.dispose()
  }
})

test("an interrupted ordinary prompt clears stopping on idle and allows shell", async () => {
  let releaseResponse!: () => void
  const gate = new Promise<void>((resolve) => (releaseResponse = resolve))
  let prompts = 0
  let shells = 0
  let aborts = 0
  const app = await mount(
    async () => json(true),
    async () => {
      prompts++
      await gate
      return json({})
    },
    undefined,
    async () => {
      aborts++
      return json(true)
    },
    async () => {
      shells++
      return json({})
    },
  )
  try {
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.sync.set("session_status", "a", { type: "busy" })
    app.prompt.set({ input: "interrupted prompt", parts: [] })
    app.prompt.submit()
    await wait(() => prompts === 1)
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("ESCAPE")
    await Bun.sleep(40)
    app.app.mockInput.pressKey("ESCAPE")
    await wait(() => aborts === 1 && app.local.model.uncertain("a") === "stopping")
    app.sync.set("session_status", "a", { type: "idle" })
    await wait(() => app.local.model.uncertain("a") === undefined)
    app.prompt.set({ input: "", parts: [] })
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("!")
    app.prompt.set({ input: "echo hello", parts: [] })
    app.prompt.submit()
    await wait(() => shells === 1)
  } finally {
    releaseResponse()
    await app.dispose()
  }
})

test("idle does not clear an unconfirmed command or allow a new prompt", async () => {
  let releaseResponse!: () => void
  const gate = new Promise<void>((resolve) => (releaseResponse = resolve))
  let commands = 0
  let prompts = 0
  let aborts = 0
  const app = await mount(
    async () => json(true),
    async (request) => {
      const body = await request.json()
      if (body.command) {
        commands++
        await gate
        return json({ name: "UnknownError", data: { message: "gateway" } }, { status: 502 })
      }
      prompts++
      return json({})
    },
    undefined,
    async () => {
      aborts++
      app.sync.set("session_status", "a", { type: "idle" })
      return json(true)
    },
  )
  try {
    app.sync.set("command", [{ name: "test", template: "test", hints: [] }])
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.sync.set("session_status", "a", { type: "busy" })
    app.prompt.set({ input: "/test pending", parts: [] })
    app.prompt.submit()
    await wait(() => commands === 1)
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("ESCAPE")
    await Bun.sleep(40)
    app.app.mockInput.pressKey("ESCAPE")
    await wait(() => aborts === 1 && app.local.model.uncertain("a") === "stopping")
    app.sync.set("session_status", "a", { type: "idle" })
    await Bun.sleep(50)
    expect(app.local.model.commandActive("a")).toBe(true)
    expect(app.local.model.uncertain("a")).toBe("stopping")
    app.prompt.set({ input: "blocked prompt", parts: [] })
    app.prompt.submit()
    await Bun.sleep(50)
    expect(prompts).toBe(0)
  } finally {
    releaseResponse()
    await app.dispose()
  }
})
test.each([200, 400])(
  "a late ordinary prompt response cannot clear a newer command unknown state (%i)",
  async (status) => {
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => (releaseA = resolve))
    let prompts = 0
    let commands = 0
    let aborts = 0
    const app = await mount(
      async () => json(true),
      async (request) => {
        const body = await request.json()
        if (body.command === "test") {
          commands++
          return json({ name: "UnknownError", data: { message: "gateway" } }, { status: 502 })
        }
        prompts++
        await gateA
        return json({}, { status })
      },
      undefined,
      async () => {
        aborts++
        return json(true)
      },
    )
    try {
      app.sync.set("command", [{ name: "test", template: "test", hints: [] }])
      app.route.navigate({ type: "session", sessionID: "a" })
      await wait(() => app.local.model.variant.selected() === "default")
      app.sync.set("session_status", "a", { type: "busy" })
      app.prompt.set({ input: "old prompt", parts: [] })
      app.prompt.submit()
      await wait(() => prompts === 1)
      app.prompt.focus()
      await app.app.renderOnce()
      app.app.mockInput.pressKey("ESCAPE")
      await Bun.sleep(40)
      app.app.mockInput.pressKey("ESCAPE")
      await wait(() => aborts === 1)
      app.prompt.set({ input: "/test b", parts: [] })
      app.prompt.submit()
      await wait(() => commands === 1)
      app.prompt.focus()
      await app.app.renderOnce()
      app.app.mockInput.pressKey("ESCAPE")
      await Bun.sleep(40)
      app.app.mockInput.pressKey("ESCAPE")
      await wait(() => aborts === 2)
      await wait(() => app.local.model.uncertain("a") === "unknown")
      releaseA()
      await Bun.sleep(80)
      expect(app.local.model.uncertain("a")).toBe("unknown")
      expect(app.local.model.commandActive("a")).toBe(true)
      await app.app.renderOnce()
      expect(app.app.captureCharFrame().replace(/\s+/g, " ")).toContain(
        t("prompt.submit.unconfirmed").split(/[;；]/)[0]!.slice(0, 10),
      )
    } finally {
      releaseA()
      await app.dispose()
    }
  },
)

test("a late ordinary prompt in A cannot clear command unknown in B", async () => {
  let releaseA!: () => void
  const gateA = new Promise<void>((resolve) => (releaseA = resolve))
  let prompts = 0
  let commands = 0
  let aborts = 0
  const app = await mount(
    async () => json(true),
    async (request) => {
      const body = await request.json()
      const sessionID = new URL(request.url).pathname.split("/")[2]
      if (body.command === "test") {
        commands++
        return json({ name: "UnknownError", data: { message: "gateway" } }, { status: 502 })
      }
      if (sessionID === "a") {
        prompts++
        await gateA
        return json({})
      }
      return json({})
    },
    undefined,
    async () => {
      aborts++
      return json(true)
    },
  )
  try {
    app.sync.set("command", [{ name: "test", template: "test", hints: [] }])
    app.route.navigate({ type: "session", sessionID: "a" })
    await wait(() => app.local.model.variant.selected() === "default")
    app.sync.set("session_status", "a", { type: "busy" })
    app.prompt.set({ input: "old prompt", parts: [] })
    app.prompt.submit()
    await wait(() => prompts === 1)
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("ESCAPE")
    await Bun.sleep(40)
    app.app.mockInput.pressKey("ESCAPE")
    await wait(() => aborts === 1)
    app.route.navigate({ type: "session", sessionID: "b" })
    await wait(() => app.local.model.variant.selected() === "xhigh")
    app.sync.set("session_status", "b", { type: "busy" })
    app.prompt.set({ input: "/test b", parts: [] })
    app.prompt.submit()
    await wait(() => commands === 1)
    app.prompt.focus()
    await app.app.renderOnce()
    app.app.mockInput.pressKey("ESCAPE")
    await Bun.sleep(40)
    app.app.mockInput.pressKey("ESCAPE")
    await wait(() => aborts === 2)
    await wait(() => app.local.model.uncertain("b") === "unknown")
    releaseA()
    await Bun.sleep(80)
    expect(app.local.model.uncertain("b")).toBe("unknown")
    expect(app.local.model.commandActive("b")).toBe(true)
  } finally {
    releaseA()
    await app.dispose()
  }
})
