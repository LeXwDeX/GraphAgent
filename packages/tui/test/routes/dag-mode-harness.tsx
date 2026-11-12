// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { Session, SessionDagMode } from "@graphagent/sdk"
import { onCleanup, type JSX } from "solid-js"
import { unwrap } from "solid-js/store"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider, type ClipboardService } from "../../src/context/clipboard"
import { EditorContextProvider } from "../../src/context/editor"
import { EpilogueProvider } from "../../src/context/epilogue"
import { ExitProvider } from "../../src/context/exit"
import { HookStatusProvider } from "../../src/context/hook-status"
import { KVProvider } from "../../src/context/kv"
import { LocalProvider } from "../../src/context/local"
import { LocationProvider } from "../../src/context/location"
import { ProjectProvider } from "../../src/context/project"
import { PromptRefProvider, usePromptRef } from "../../src/context/prompt"
import { RouteProvider, useRoute, type Route } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { TickerProvider } from "../../src/context/ticker-context"
import { GraphagentKeymapProvider, registerGraphagentKeymap, type OpenTuiKeymap } from "../../src/keymap"
import { FrecencyProvider } from "../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../src/prompt/history"
import { PromptStashProvider } from "../../src/prompt/stash"
import { FooterToastProvider, useToast } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json, type FetchHandler } from "../fixture/tui-sdk"

export type Sent = { method: string; path: string; body: unknown }

type TestApp = Awaited<ReturnType<typeof testRender>>

/**
 * Reads from the renderer's buffers without racing a frame that is still being presented.
 * While one is, the native buffer lease is busy and the read throws `OutputBusy`; the lease
 * frees on its own a moment later, so render again and retry instead of failing the test.
 */
async function whenFree<T>(app: Pick<TestApp, "renderOnce">, read: () => T): Promise<T> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return read()
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("OutputBusy"))) throw error
      await Bun.sleep(5)
      await app.renderOnce()
    }
  }
  throw new Error("the renderer stayed busy while a frame was read")
}

/** The frame as text. */
export function readFrame(app: Pick<TestApp, "renderOnce" | "captureCharFrame">) {
  return whenFree(app, () => app.captureCharFrame())
}

/** The frame as painted spans. */
export function readSpans(app: Pick<TestApp, "renderOnce" | "captureSpans">) {
  return whenFree(app, () => app.captureSpans())
}

export function sessionFixture(id: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    directory,
    title: id,
    version: "test",
    time: { created: 1, updated: 2 },
    ...extra,
  }
}

export function dagModeStatus(extra: Partial<SessionDagMode> = {}): SessionDagMode {
  return {
    mode: "on",
    defaultMode: "off",
    availability: "available",
    unavailableReason: null,
    budget: { tokens: null, used: 0, usedCacheRead: 0, warnRatio: 0.8 },
    limits: { concurrency: 4, maxTotalNodes: 32, running: 0 },
    quality: null,
    ...extra,
  }
}

const agent = { name: "build", mode: "primary", permission: [], options: {}, native: true }
const provider = {
  id: "test",
  name: "Test",
  source: "config",
  env: [],
  options: {},
  models: { "test-model": { id: "test-model", name: "Test model", capabilities: { reasoning: false } } },
}

export type MountOptions = {
  route: Route
  /** The view under test, rendered inside the full provider stack. */
  view: () => JSX.Element
  sessions?: readonly Session[]
  keybinds?: Parameters<typeof createTuiResolvedConfig>[0]
  /** Interface language served as the configured `language`; defaults to zh-CN. */
  language?: "zh-CN" | "en"
  /** Serve a primary agent and one connected model so commands carry both. */
  withAgentAndModel?: boolean
  /** Reply to `GET /session/:id/dag-mode`; defaults to an available status. */
  dagMode?: (sessionID: string) => Response | SessionDagMode | Promise<Response | SessionDagMode>
  /** Reply to `POST /session/:id/command`. */
  command?: (body: unknown) => Response
  /** Extra endpoint replies, consulted before the built-in ones; return nothing to fall through. */
  handler?: FetchHandler
  /** Replaces the system clipboard, so tests can read what a copy command wrote. */
  clipboard?: ClipboardService
  /** Working directory of the TUI process (export writes there); defaults to the fake server's directory. */
  cwd?: string
  width?: number
  height?: number
}

/**
 * Mounts one route view inside the same provider stack the app uses, with a
 * fake server that records every request. Background attention pings are
 * recorded too but excluded from `writes()`: they are telemetry, not a user
 * intent.
 */
export async function mountRoute(options: MountOptions) {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  const sent: Sent[] = []
  const requested: string[] = []
  const sessions = options.sessions ?? []
  const calls = createFetch(async (url, request) => {
    requested.push(`${request?.method ?? "GET"} ${url.pathname}`)
    if (request && request.method !== "GET") {
      const text = await request.clone().text()
      sent.push({ method: request.method, path: url.pathname, body: text ? JSON.parse(text) : undefined })
    }
    const custom = await options.handler?.(url, request)
    if (custom) return custom
    if (url.pathname === "/config") return json({ language: options.language ?? "zh-CN" })
    if (url.pathname === "/session") return json(sessions)
    if (options.withAgentAndModel) {
      if (url.pathname === "/agent") return json([agent])
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { test: "test-model" } })
      if (url.pathname === "/provider")
        return json({ all: [provider], default: { test: "test-model" }, connected: ["test"] })
    }
    for (const item of sessions) {
      if (url.pathname === `/session/${item.id}`) return json(item)
      if (url.pathname === `/session/${item.id}/message`) return json([])
      if (url.pathname === `/session/${item.id}/todo` || url.pathname === `/session/${item.id}/diff`) return json([])
      if (url.pathname === `/session/${item.id}/goal`) return json(undefined)
      if (url.pathname === `/session/${item.id}/attention`) return json({})
      if (url.pathname === `/session/${item.id}/dag-mode`) {
        const reply = (await options.dagMode?.(item.id)) ?? dagModeStatus()
        return reply instanceof Response ? reply : json(reply)
      }
      if (url.pathname === `/session/${item.id}/command`) {
        return options.command?.(sent.at(-1)?.body) ?? json({ info: {}, parts: [] })
      }
    }
    return undefined
  }, events)

  let keymap!: OpenTuiKeymap
  let toast!: ReturnType<typeof useToast>
  let route!: ReturnType<typeof useRoute>
  let sync!: ReturnType<typeof useSync>
  let promptRef!: ReturnType<typeof usePromptRef>

  function Probe() {
    toast = useToast()
    route = useRoute()
    sync = useSync()
    promptRef = usePromptRef()
    return <box />
  }

  const config = createTuiResolvedConfig(options.keybinds)
  const app = await testRender(
    () => {
      const renderer = useRenderer()
      keymap = createDefaultOpenTuiKeymap(renderer)
      onCleanup(registerGraphagentKeymap(keymap, renderer, config))
      return (
        <TestTuiContexts cwd={options.cwd ?? directory} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
          <ExitProvider exit={() => {}}>
            <EpilogueProvider set={() => {}}>
              <ClipboardProvider value={options.clipboard}>
                <GraphagentKeymapProvider keymap={keymap}>
                  <ArgsProvider>
                    <KVProvider>
                      <TickerProvider>
                        <FooterToastProvider>
                          <HookStatusProvider>
                            <RouteProvider initialRoute={options.route}>
                              <TuiConfigProvider config={config}>
                                <SDKProvider
                                  url="http://test"
                                  directory={directory}
                                  events={events.source}
                                  fetch={calls.fetch}
                                >
                                  <ProjectProvider>
                                    <SyncProvider>
                                      <ThemeProvider mode="dark">
                                        <LocalProvider>
                                          <PromptStashProvider>
                                            <FrecencyProvider>
                                              <PromptHistoryProvider>
                                                <PromptRefProvider>
                                                  <EditorContextProvider integration={{}}>
                                                    <Probe />
                                                    <LocationProvider>{options.view()}</LocationProvider>
                                                  </EditorContextProvider>
                                                </PromptRefProvider>
                                              </PromptHistoryProvider>
                                            </FrecencyProvider>
                                          </PromptStashProvider>
                                        </LocalProvider>
                                      </ThemeProvider>
                                    </SyncProvider>
                                  </ProjectProvider>
                                </SDKProvider>
                              </TuiConfigProvider>
                            </RouteProvider>
                          </HookStatusProvider>
                        </FooterToastProvider>
                      </TickerProvider>
                    </KVProvider>
                  </ArgsProvider>
                </GraphagentKeymapProvider>
              </ClipboardProvider>
            </EpilogueProvider>
          </ExitProvider>
        </TestTuiContexts>
      )
    },
    { width: options.width ?? 100, height: options.height ?? 30 },
  )

  const harness = {
    app,
    sent,
    requested,
    events,
    keymap: () => keymap,
    toast: () => toast,
    route: () => route,
    sync: () => sync,
    /** Text in the mounted prompt's draft; `undefined` when no prompt is mounted. */
    promptDraft: () => promptRef.current?.current.input,
    /** A plain copy of the mounted prompt's draft parts; `undefined` when no prompt is mounted. */
    promptParts: () => {
      const parts = promptRef.current?.current.parts
      return parts === undefined ? undefined : structuredClone(unwrap(parts))
    },
    /** Requests that mutate server state, minus the attention telemetry. */
    writes: () => sent.filter((item) => !item.path.endsWith("/attention")),
    commands: () => sent.filter((item) => item.path.endsWith("/command")),
    /** The frame as text, never read while a frame is still being presented. */
    frame: () => readFrame(app),
    /** The frame as painted spans, never read while a frame is still being presented. */
    spans: () => readSpans(app),
    /**
     * Renders until the frame satisfies `ready` and returns it. Poll through this instead of
     * `waitFor(() => app.captureCharFrame()...)`: a bare poll reads between renders, where the
     * native buffer can still be busy presenting the last one.
     */
    async waitForFrame(ready: (frame: string) => boolean, what = "the expected frame", timeout = 10_000) {
      const start = Date.now()
      for (;;) {
        await app.renderOnce()
        const frame = await readFrame(app)
        if (ready(frame)) return frame
        if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}; last frame:\n${frame}`)
        await Bun.sleep(10)
      }
    },
    async settle() {
      for (let attempt = 0; attempt < 10; attempt++) {
        await app.renderOnce()
        await Bun.sleep(10)
      }
      // End on a render, not on a sleep: a frame read right after must find the buffer idle.
      await app.renderOnce()
    },
    /** The default leader sequence for `session.dagmode.toggle`. */
    async leaderD() {
      app.mockInput.pressKey("x", { ctrl: true })
      await app.renderOnce()
      app.mockInput.pressKey("d")
      await harness.settle()
    },
    async dispose() {
      // An unmounting prompt stashes a non-empty draft in module state and the
      // next prompt in the process would restore it, so leave nothing behind.
      promptRef.current?.set({ input: "", parts: [] })
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }

  // Let the session load and the route register its bindings. A setup that fails must not leave
  // the renderer running: its timers and frames would go on into the tests that follow.
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      await app.renderOnce()
      await Bun.sleep(10)
    }
    // The prompt restores a draft another test in this process left in its
    // module-level stash; start every harness from an empty draft so the
    // assertions do not depend on test file order.
    promptRef.current?.set({ input: "", parts: [] })
    await app.renderOnce()
  } catch (error) {
    await harness.dispose()
    throw error
  }
  return harness
}

export async function waitFor(predicate: () => boolean, timeout = 3000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}
