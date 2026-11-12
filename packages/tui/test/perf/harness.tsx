// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { ScrollBoxRenderable, TextareaRenderable, type Renderable } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import type { Part } from "@graphagent/sdk"
import { createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { EditorContextProvider } from "../../src/context/editor"
import { EpilogueProvider } from "../../src/context/epilogue"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { LocalProvider } from "../../src/context/local"
import { LocationProvider } from "../../src/context/location"
import { ProjectProvider } from "../../src/context/project"
import { PromptRefProvider, usePromptRef } from "../../src/context/prompt"
import { RouteProvider, useRoute } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { TickerProvider } from "../../src/context/ticker-context"
import { createTicker, type Ticker } from "../../src/context/ticker"
import { registerGraphagentKeymap, GraphagentKeymapProvider } from "../../src/keymap"
import type { PromptRef } from "../../src/component/prompt"
import { FrecencyProvider } from "../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../src/prompt/history"
import { PromptStashProvider } from "../../src/prompt/stash"
import { Home } from "../../src/routes/home"
import { Main } from "../../src/routes/session"
import {
  BottomZone,
  BottomZoneProvider,
  createBottomZoneState,
  type BottomZoneStateApi,
} from "../../src/shell/bottom-zone"
import { AppFrame } from "../../src/shell/app-frame"
import { FooterToastProvider } from "../../src/ui/toast"
import { HookStatusProvider } from "../../src/context/hook-status"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory } from "../fixture/tui-sdk"
import { probeStoreWrites } from "../fixture/store-write-probe"
import { tmpdir } from "../fixture/fixture"
import {
  backgroundEvent,
  deltaEvent,
  makeFetchFixture,
  type PerfFixture,
  streamTextPart,
  updatePartEvent,
} from "./fixtures"
import { createCounters, type CounterSnapshot, type PerfCounters } from "./counters"
import { SETTLE_DEADLINE_MS } from "./settle"

/**
 * A live reply: a text part at the tail of the last assistant message that is
 * opened with one snapshot, grown by `message.part.delta` events, and closed with
 * a terminal snapshot, the order the server sends them in.
 */
export type PerfStream = {
  /** The part as last snapshotted: empty and unfinished until `finish()`. */
  readonly part: Part
  /** Appends `text` with one `message.part.delta`. It reaches the stream buffer, not `store.part`. */
  delta(text: string): void
  /** Everything appended so far. */
  text(): string
  /** The terminal `message.part.updated`: the full text and an end time. */
  finish(): void
}

export type PerfHarness = {
  app: Awaited<ReturnType<typeof testRender>>
  fixture: PerfFixture
  clock: ManualClock
  counters: PerfCounters
  ticker: Ticker
  /** Live animation subscriptions; only visible spinners may hold one. */
  subscriptions(): number
  sync: ReturnType<typeof useSync>
  prompt: PromptRef
  emit(event: Parameters<ReturnType<typeof createEventSource>["emit"]>[0]): void
  /** Opens a live reply at the tail of the transcript (one `message.part.updated` snapshot). */
  openStream(): PerfStream
  tickBackground(tick: number): void
  hideAutocomplete(): void
  navigate(route: Parameters<ReturnType<typeof useRoute>["navigate"]>[0]): void
  /** Replaces the composer with a bottom-zone panel, as a real detail view does. */
  openPanel(): void
  closePanel(): void
  reset(): Promise<void>
  scroll(): ScrollBoxRenderable | undefined
  snapshot(): CounterSnapshot
  dispose(): Promise<void>
}

function findNodes(root: Renderable): Renderable[] {
  return [root, ...root.getChildren().flatMap(findNodes)]
}

function findScroll(root: Renderable): ScrollBoxRenderable | undefined {
  return findNodes(root).find((node): node is ScrollBoxRenderable => node instanceof ScrollBoxRenderable)
}

function findPrompt(root: Renderable): PromptRef | undefined {
  const input = findNodes(root).find((node): node is TextareaRenderable => node instanceof TextareaRenderable)
  if (!input) return undefined
  return {
    get focused() {
      return input.focused
    },
    get current() {
      return { input: input.plainText, parts: [] }
    },
    set(prompt) {
      input.setText(prompt.input)
    },
    append(text) {
      const current = input.plainText
      input.setText(current ? `${current}\n${text}` : text)
      input.focus()
    },
    edit(request) {
      input.setText(request.value)
      input.focus()
    },
    reset() {
      input.clear()
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    submit() {},
  }
}

export type HarnessOptions = {
  /**
   * Switch between the home and session routes the way `app.tsx` does, so a test
   * can leave the session and come back to it. Off, the session route is mounted
   * once and stays.
   */
  routes?: boolean
}

export async function mountHarness(fixture: PerfFixture, options: HarnessOptions = {}): Promise<PerfHarness> {
  const stateDir = await tmpdir()
  await Bun.write(`${stateDir.path}/kv.json`, "{}")
  const calls = createFetch((url) => makeFetchFixture(fixture, url))
  const events = createEventSource()
  const clock = new ManualClock()
  clock.setTime(Date.now())
  const config = createTuiResolvedConfig()
  const state = {} as {
    sync?: ReturnType<typeof useSync>
    promptRef?: ReturnType<typeof usePromptRef>
    prompt?: NonNullable<ReturnType<typeof usePromptRef>["current"]>
    bottomZone?: BottomZoneStateApi
    route?: ReturnType<typeof useRoute>
  }
  let counters!: PerfCounters
  let keymap!: ReturnType<typeof createDefaultOpenTuiKeymap>
  let harnessTicker: Ticker | undefined
  let activeSubscriptions = 0
  let streams = 0
  let deltas = 0

  function Probe(props: { bottomZone: BottomZoneStateApi }) {
    const sync = useSync()
    const promptRef = usePromptRef()
    const route = useRoute()
    state.sync = sync
    state.promptRef = promptRef
    state.route = route
    // Count the writes the sync store really performs. Inferring them from the
    // event type cannot see a delta that starts writing `store.part`.
    const probe = probeStoreWrites(sync.data, ["message", "part"], (slice) => counters.countStoreWrite(slice))
    onCleanup(() => probe.dispose())
    onMount(() => {
      state.sync = sync
      state.promptRef = promptRef
      state.route = route
    })
    return (
      <AppFrame
        topBar={{ path: directory }}
        footer={{ agent: "build" }}
        bottomZone={<BottomZone state={props.bottomZone} composer={<></>} />}
      >
        <Show when={options.routes} fallback={<Main />}>
          <Switch>
            <Match when={route.data.type === "home"}>
              <Home />
            </Match>
            <Match when={route.data.type === "session"}>
              <Main />
            </Match>
          </Switch>
        </Show>
      </AppFrame>
    )
  }

  function Harness() {
    const renderer = useRenderer()
    // The real app owns the bottom-zone state above AppFrame; the composer is
    // rendered by Main's session route, not by the frame (#1025 P17/P17b).
    const bottomZone = createBottomZoneState()
    state.bottomZone = bottomZone
    keymap = createDefaultOpenTuiKeymap(renderer)
    counters = createCounters(renderer, keymap)
    // Drive the TUI ticker from the manual clock so idle/busy frame counts are
    // deterministic. Focus/blur mirrors TickerProvider's production wiring.
    const [focused, setFocused] = createSignal(true)
    const onFocus = () => setFocused(true)
    const onBlur = () => setFocused(false)
    renderer.on("focus", onFocus)
    renderer.on("blur", onBlur)
    const ticker = createTicker({
      now: () => clock.now(),
      focused,
      // ManualClock hands out its own opaque `TimerHandle`, while the ticker
      // options use the ambient `setTimeout` return type. The handle is stored
      // and returned unchanged, never inspected.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- opaque timer handle
      setTimer: (callback, delay) => clock.setTimeout(callback, delay) as unknown as ReturnType<typeof setTimeout>,
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- opaque timer handle
      clearTimer: (handle) => clock.clearTimeout(handle as unknown as Parameters<typeof clock.clearTimeout>[0]),
    })
    const subscribeTicker = ticker.subscribe.bind(ticker)
    ticker.subscribe = () => {
      activeSubscriptions++
      const release = subscribeTicker()
      let done = false
      return () => {
        if (done) return
        done = true
        activeSubscriptions--
        release()
      }
    }
    harnessTicker = ticker
    onCleanup(registerGraphagentKeymap(keymap, renderer, config))
    onCleanup(() => counters.dispose())
    onCleanup(() => {
      renderer.off("focus", onFocus)
      renderer.off("blur", onBlur)
    })
    return (
      <TestTuiContexts cwd={directory} paths={{ home: stateDir.path, state: stateDir.path, worktree: "/tmp/opencode" }}>
        <ExitProvider exit={() => {}}>
          <EpilogueProvider set={() => {}}>
            <ClipboardProvider>
              <GraphagentKeymapProvider keymap={keymap}>
                <ArgsProvider>
                  <KVProvider>
                    <TickerProvider ticker={ticker}>
                      <FooterToastProvider>
                        <HookStatusProvider>
                          <RouteProvider initialRoute={{ type: "session", sessionID: fixture.session.id }}>
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
                                                  <LocationProvider>
                                                    <BottomZoneProvider state={bottomZone}>
                                                      <Probe bottomZone={bottomZone} />
                                                    </BottomZoneProvider>
                                                  </LocationProvider>
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
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 30, clock, gatherStats: true })
  app.renderer.requestRender()
  await app.renderOnce()
  // A fixed frame count timed out on a machine running other work; wait for the
  // state itself, up to the deadline the scenarios use for background work.
  const deadline = Date.now() + SETTLE_DEADLINE_MS
  while (state.sync?.status !== "complete" && Date.now() < deadline) {
    await app.renderOnce()
    await Bun.sleep(1)
  }
  if (state.sync?.status !== "complete") {
    const frame = app.captureCharFrame()
    app.renderer.destroy()
    throw new Error(`Sync bootstrap did not complete: ${state.sync?.status ?? "missing"}\n${frame}`)
  }
  await app.renderOnce()
  while (!state.prompt && Date.now() < deadline) {
    state.prompt = state.promptRef?.current
    if (!state.prompt) {
      await app.renderOnce()
      await Bun.sleep(1)
    }
  }
  if (!state.prompt && !findPrompt(app.renderer.root)) {
    const names = findNodes(app.renderer.root).map((node) => node.constructor.name)
    const frame = app.captureCharFrame()
    app.renderer.destroy()
    await stateDir[Symbol.asyncDispose]()
    throw new Error(
      `Session Prompt did not mount (${names.filter((name) => name.toLowerCase().includes("text")).join(", ")}):\n${frame}`,
    )
  }

  // Resolve the live Prompt each time: route and panel changes may remount it,
  // which destroys the previous EditBuffer.
  const currentPrompt = (): PromptRef => {
    const live = findPrompt(app.renderer.root) ?? state.promptRef?.current
    if (!live) throw new Error("Session Prompt is not mounted")
    return live
  }

  const emit = (event: Parameters<typeof events.emit>[0]) => {
    events.emit(event)
  }

  return {
    app,
    fixture,
    clock,
    counters,
    get ticker() {
      if (!harnessTicker) throw new Error("ticker not mounted")
      return harnessTicker
    },
    subscriptions() {
      return activeSubscriptions
    },
    sync: state.sync,
    get prompt() {
      return currentPrompt()
    },
    emit,
    openStream() {
      const ordinal = ++streams
      const open = streamTextPart(fixture, ordinal, "")
      let part = open
      let received = ""
      emit(updatePartEvent(open, ordinal, `evt_stream_${ordinal}_open`))
      return {
        get part() {
          return part
        },
        delta(text) {
          received += text
          emit(deltaEvent(open, text, `evt_stream_${ordinal}_delta_${++deltas}`))
        },
        text() {
          return received
        },
        finish() {
          part = streamTextPart(fixture, ordinal, received, ordinal + 1)
          emit(updatePartEvent(part, ordinal + 1, `evt_stream_${ordinal}_end`))
        },
      }
    },
    tickBackground(tick) {
      fixture.backgroundParts.forEach((part) => emit(backgroundEvent(part, tick)))
    },
    hideAutocomplete() {
      keymap.dispatchCommand("prompt.autocomplete.hide")
    },
    navigate(route) {
      state.route?.navigate(route)
    },
    openPanel() {
      state.bottomZone?.host.push({ id: "perf-panel", render: () => <text>panel</text> })
    },
    closePanel() {
      state.bottomZone?.host.clear()
    },
    async reset() {
      const live = currentPrompt()
      live.reset()
      keymap.dispatchCommand("prompt.autocomplete.hide")
      live.focus()
      findScroll(app.renderer.root)?.scrollTo(0)
      await app.renderOnce()
    },
    scroll() {
      return findScroll(app.renderer.root)
    },
    snapshot() {
      return counters.snapshot()
    },
    async dispose() {
      // A prompt stashes the text it holds when it unmounts, in a slot the next prompt mounted in this
      // process restores. A harness torn down with a draft in the composer (a scenario that types ends on
      // one) would hand it to whatever test mounts a prompt next, and a snapshot of that composer shows it.
      if (!app.renderer.isDestroyed) state.promptRef?.current?.reset()
      if (!app.renderer.isDestroyed) app.renderer.destroy()
      await stateDir[Symbol.asyncDispose]()
    },
  }
}
