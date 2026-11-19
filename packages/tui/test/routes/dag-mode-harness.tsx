// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { GlobalEvent, Session, SessionDagMode, SessionOverhead, SessionUsage } from "@graphagent/sdk"
import { onCleanup, type JSX } from "solid-js"
import { unwrap } from "solid-js/store"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider, type ClipboardService } from "../../src/context/clipboard"
import { EditorContextProvider } from "../../src/context/editor"
import { useCommands } from "../../src/commands/context"
import { EpilogueProvider } from "../../src/context/epilogue"
import { ExitProvider } from "../../src/context/exit"
import { HookStatusProvider } from "../../src/context/hook-status"
import { KVProvider, useKV } from "../../src/context/kv"
import { ToastLocalProvider } from "../fixture/tui-local"
import { LocationProvider } from "../../src/context/location"
import { ProjectProvider } from "../../src/context/project"
import { PromptRefProvider, usePromptRef } from "../../src/context/prompt"
import { RouteProvider, useRoute, type Route } from "../../src/context/route"
import { SDKProvider, useSDK } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import type { Ticker } from "../../src/context/ticker"
import { TickerProvider } from "../../src/context/ticker-context"
import { GraphagentKeymapProvider, registerGraphagentKeymap, type OpenTuiKeymap } from "../../src/keymap"
import { FrecencyProvider } from "../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../src/prompt/history"
import { PromptStashProvider } from "../../src/prompt/stash"
import type { BottomZoneStateApi } from "../../src/shell/bottom-zone"
import { FooterToastProvider, useToast } from "../../src/ui/toast"
import { limitRendererListeners } from "../../src/util/renderer"
import { tmpdir } from "../fixture/fixture"
import { readFrame, readSpans } from "../fixture/frames"
import { RouteFrame } from "../fixture/route-frame"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json, type FetchHandler } from "../fixture/tui-sdk"
import { spyOverheadReads, type OverheadReads } from "../fixture/overhead-reads"
import { spyUsageReads, type UsageReads } from "../fixture/usage-reads"

export type Sent = { method: string; path: string; body: unknown }

// The frame readers live with the other frame helpers; they stay importable from here.
export { readFrame, readSpans }

export function sessionFixture(id: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    slug: id,
    role: extra.parentID ? "task_child" : "root",
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
    limits: {
      concurrency: 4,
      configuredConcurrency: null,
      maxTotalNodes: 32,
      configuredMaxTotalNodes: null,
      running: 0,
    },
    quality: null,
    ...extra,
  }
}

/** The usage of a task tree as the server sums it (`GET /session/:id/usage`); nothing used unless `extra` says so. */
export function usageFixture(rootID: string, extra: Partial<SessionUsage> = {}): SessionUsage {
  return {
    rootID,
    sessions: 1,
    cost: 0,
    costUnknown: false,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...extra,
  }
}

/** What the server reports of a session's fixed overhead (`GET /session/:id/overhead`); nothing before its first request. */
export function overheadFixture(extra: Partial<SessionOverhead> = {}): SessionOverhead {
  return { bytes: 0, tokens: 0, sources: [], ...extra }
}

/** The top of `sessionID`'s parent chain among `sessions`: the root the usage endpoint answers for any session of a tree. */
function rootOfFixture(sessions: readonly Session[], sessionID: string) {
  const byID = new Map(sessions.map((item) => [item.id, item]))
  let current = sessionID
  for (let depth = 0; depth < sessions.length; depth++) {
    const parentID = byID.get(current)?.parentID
    if (!parentID) break
    current = parentID
  }
  return current
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
  /**
   * Renders the view inside the app frame and its bottom zone. A route draws its prompt in the zone's composer
   * slot, so a view that needs its input (typing, drafts, autocomplete) has to be mounted this way.
   */
  frame?: boolean
  sessions?: readonly Session[]
  keybinds?: Parameters<typeof createTuiResolvedConfig>[0]
  /** Interface language served as the configured `language`; defaults to zh-CN. */
  language?: "zh-CN" | "en"
  /** Values of the kv file the app starts with, for example `ambiguous_width`; defaults to none. */
  kv?: Record<string, unknown>
  /** Replaces the one-second clock, so a test controls the time a view shows and counts who listens to it. */
  ticker?: Ticker
  /** Serve a primary agent and one connected model so commands carry both. */
  withAgentAndModel?: boolean
  /** Reply to `GET /session/:id/dag-mode`; defaults to an available status. */
  dagMode?: (sessionID: string) => Response | SessionDagMode | Promise<Response | SessionDagMode>
  /**
   * Reply to `GET /session/:id/usage`; defaults to the root of the session's tree with nothing used. The real endpoint
   * answers for any session of a tree with its root's total, so the default names the root, not the session asked.
   */
  usage?: (sessionID: string) => Response | SessionUsage | undefined | Promise<Response | SessionUsage | undefined>
  /**
   * Reply to `GET /session/:id/overhead`; defaults to nothing reported (zeros, which the drawer does not show). The
   * real endpoint answers for the session asked, whatever its place in a tree.
   */
  overhead?: (
    sessionID: string,
  ) => Response | SessionOverhead | undefined | Promise<Response | SessionOverhead | undefined>
  /** Reply to `POST /session/:id/command`. */
  command?: (body: unknown) => Response
  /** Extra endpoint replies, consulted before the built-in ones; return nothing to fall through. */
  handler?: FetchHandler
  /** Replaces the system clipboard, so tests can read what a copy command wrote. */
  clipboard?: ClipboardService
  /** Working directory of the TUI process (export writes there); defaults to the fake server's directory. */
  cwd?: string
  /** The event source the SDK subscribes to, when a test needs it before the mount returns. */
  events?: ReturnType<typeof createEventSource>
  width?: number
  height?: number
}

/**
 * Mounts one route view inside the same provider stack the app uses, with a
 * fake server that records every request. Background attention pings and lifecycle reads are
 * recorded too but excluded from `writes()`: they are telemetry, not a user
 * intent.
 */
export async function mountRoute(options: MountOptions) {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify(options.kv ?? {}))
  const events = options.events ?? createEventSource()
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
      if (url.pathname === `/session/${item.id}/usage`) {
        const reply = (await options.usage?.(item.id)) ?? usageFixture(rootOfFixture(sessions, item.id))
        return reply instanceof Response ? reply : json(reply)
      }
      if (url.pathname === `/session/${item.id}/overhead`) {
        const reply = (await options.overhead?.(item.id)) ?? overheadFixture()
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
  let sdk!: ReturnType<typeof useSDK>
  let usageReads: UsageReads | undefined
  let overheadReads: OverheadReads | undefined
  let kv!: ReturnType<typeof useKV>
  let promptRef!: ReturnType<typeof usePromptRef>
  let registry!: ReturnType<typeof useCommands>
  let bottomZone: BottomZoneStateApi | undefined

  function Probe() {
    toast = useToast()
    route = useRoute()
    sync = useSync()
    sdk = useSDK()
    // Ahead of the view's own effects, so a read the first render asks for is counted too; once, though the subtree
    // may be built again.
    usageReads ??= spyUsageReads(sdk)
    overheadReads ??= spyOverheadReads(sdk)
    kv = useKV()
    promptRef = usePromptRef()
    registry = useCommands()
    return <box />
  }

  const config = createTuiResolvedConfig(options.keybinds)
  const app = await testRender(
    () => {
      const renderer = useRenderer()
      // As the app root does (`App` in app.tsx): a full screen holds more `resize` listeners than Node's default ten.
      limitRendererListeners(renderer)
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
                      <TickerProvider ticker={options.ticker}>
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
                                        <ToastLocalProvider>
                                          <PromptStashProvider>
                                            <FrecencyProvider>
                                              <PromptHistoryProvider>
                                                <PromptRefProvider>
                                                  <EditorContextProvider integration={{}}>
                                                    <Probe />
                                                    <LocationProvider>
                                                      {options.frame ? (
                                                        <RouteFrame onZone={(zone) => (bottomZone = zone)}>
                                                          {options.view()}
                                                        </RouteFrame>
                                                      ) : (
                                                        options.view()
                                                      )}
                                                    </LocationProvider>
                                                  </EditorContextProvider>
                                                </PromptRefProvider>
                                              </PromptHistoryProvider>
                                            </FrecencyProvider>
                                          </PromptStashProvider>
                                        </ToastLocalProvider>
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
    /** The SDK the view talks to, for a test that flushes the frame an event rides in. */
    sdk: () => sdk,
    /**
     * The reads of the usage endpoint the sync layer asks for, counted at the SDK call: `asked()` the moment a trigger
     * has run, `answered()` once the sync layer has dealt with every answer (`test/fixture/usage-reads.ts`).
     */
    usageReads: {
      asked: () => usageReads!.asked(),
      answered: () => usageReads!.answered(),
    },
    /** The reads of the fixed-overhead endpoint the sync layer asks for, counted at the SDK call, as `usageReads`. */
    overheadReads: {
      asked: () => overheadReads!.asked(),
      answered: () => overheadReads!.answered(),
    },
    /** Emit an event and run the frame that carries it now: the handlers have run when this returns. */
    deliver(event: GlobalEvent) {
      events.emit(event)
      sdk.frameClock.flushNow()
    },
    /** The command registry the views register their handlers in; `run` is what a palette selection does. */
    registry: () => registry,
    /** The persisted preferences, for a test that changes one while the view is on screen. */
    kv: () => kv,
    /** The bottom zone of a view mounted with `frame`. */
    bottomZone: () => bottomZone,
    /** Text in the mounted prompt's draft; `undefined` when no prompt is mounted. */
    promptDraft: () => promptRef.current?.current.input,
    /** A plain copy of the mounted prompt's draft parts; `undefined` when no prompt is mounted. */
    promptParts: () => {
      const parts = promptRef.current?.current.parts
      return parts === undefined ? undefined : structuredClone(unwrap(parts))
    },
    /** Requests that mutate server state, minus the attention telemetry. */
    // A lifecycle read is a POST that writes nothing.
    writes: () => sent.filter((item) => !item.path.endsWith("/attention") && !item.path.endsWith("/lifecycle/states")),
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
