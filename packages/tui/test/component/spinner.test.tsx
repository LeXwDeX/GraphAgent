// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, type Accessor } from "solid-js"
import { SPINNER_FRAMES, Spinner } from "../../src/component/spinner"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import type { Ticker } from "../../src/context/ticker"
import { TickerProvider } from "../../src/context/ticker-context"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

function fakeTicker() {
  const [frame, setFrame] = createSignal(0)
  let subscribes = 0
  let active = 0
  const ticker: Ticker = {
    frame,
    second: () => 0,
    subscribe() {
      subscribes++
      active++
      let live = true
      return () => {
        if (!live) return
        live = false
        active--
      }
    },
    subscribeSecond: () => () => {},
    at: () => () => {},
    now: () => 0,
  }
  return {
    ticker,
    advance() {
      setFrame((value) => value + 1)
    },
    stats: () => ({ subscribes, active }),
  }
}

async function mount(options: { visible?: Accessor<boolean>; animations?: boolean } = {}) {
  const state = await tmpdir()
  await Bun.write(`${state.path}/kv.json`, JSON.stringify({ animations_enabled: options.animations ?? true }))
  const clock = fakeTicker()
  const config = createTuiResolvedConfig()
  function Harness() {
    return (
      <TestTuiContexts paths={{ home: state.path, state: state.path, worktree: state.path }}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <TickerProvider ticker={clock.ticker}>
              <ThemeProvider mode="dark">
                <Spinner color={RGBA.fromHex("#ff0000")} visible={options.visible}>
                  working
                </Spinner>
              </ThemeProvider>
            </TickerProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: 20, height: 2 })
  return {
    app,
    clock,
    async render() {
      await app.renderOnce()
      return app.captureCharFrame()
    },
    async dispose() {
      app.renderer.destroy()
      await state[Symbol.asyncDispose]()
    },
  }
}

async function waitFrame(app: Awaited<ReturnType<typeof mount>>, text: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const frame = await app.render()
    if (frame.includes(text)) return frame
    await Bun.sleep(1)
  }
  throw new Error(`frame never contained ${text}`)
}

test("subscribes to the ticker only while visible", async () => {
  const [visible, setVisible] = createSignal(true)
  const app = await mount({ visible })
  try {
    await waitFrame(app, SPINNER_FRAMES[0]!)
    expect(app.clock.stats()).toEqual({ subscribes: 1, active: 1 })
    setVisible(false)
    await app.render()
    expect(app.clock.stats()).toEqual({ subscribes: 1, active: 0 })
    setVisible(true)
    await app.render()
    expect(app.clock.stats()).toEqual({ subscribes: 2, active: 1 })
  } finally {
    await app.dispose()
  }
})

test("renders the frame driven by the injected ticker", async () => {
  const app = await mount()
  try {
    await waitFrame(app, SPINNER_FRAMES[0]!)
    app.clock.advance()
    await waitFrame(app, SPINNER_FRAMES[1]!)
  } finally {
    await app.dispose()
  }
})

test("disabled animations render the ellipsis fallback without subscribing", async () => {
  const app = await mount({ animations: false })
  try {
    const frame = await waitFrame(app, "⋯")
    expect(frame).toContain("working")
    expect(app.clock.stats()).toEqual({ subscribes: 0, active: 0 })
  } finally {
    await app.dispose()
  }
})

/** A 4-line scroll box with 10 lines of spacer above the spinner, so the spinner starts below the fold. */
async function mountInScrollBox() {
  const state = await tmpdir()
  await Bun.write(`${state.path}/kv.json`, JSON.stringify({ animations_enabled: true }))
  const clock = fakeTicker()
  const config = createTuiResolvedConfig()
  let scroll: ScrollBoxRenderable | undefined
  function Harness() {
    return (
      <TestTuiContexts paths={{ home: state.path, state: state.path, worktree: state.path }}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <TickerProvider ticker={clock.ticker}>
              <ThemeProvider mode="dark">
                <scrollbox ref={(node: ScrollBoxRenderable) => (scroll = node)} height={4} stickyScroll={false}>
                  <box height={10} />
                  <Spinner>working</Spinner>
                </scrollbox>
              </ThemeProvider>
            </TickerProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: 20, height: 6 })
  // The providers mount the tree over the first frames.
  for (let attempt = 0; attempt < 100; attempt++) {
    await app.renderOnce()
    if (scroll) break
    await Bun.sleep(1)
  }
  return {
    app,
    clock,
    scroll: () => scroll!,
    /** Frames it takes for the number of live subscriptions to reach `active`; fails after `limit`. */
    async framesUntil(active: number, limit = 4) {
      for (let frame = 1; frame <= limit; frame++) {
        await app.renderOnce()
        if (clock.stats().active === active) return frame
      }
      throw new Error(`still ${clock.stats().active} subscriptions after ${limit} frames, expected ${active}`)
    },
    async dispose() {
      app.renderer.destroy()
      await state[Symbol.asyncDispose]()
    },
  }
}

test("a spinner below the fold of its scroll box does not tick, and ticks again once scrolled into view", async () => {
  const view = await mountInScrollBox()
  try {
    // It starts out assumed visible, and lets go as soon as a laid-out position says it is not.
    await view.framesUntil(0)
    expect(view.clock.stats().subscribes).toBeGreaterThanOrEqual(1)

    // Scrolling moves it relative to the viewport; the layout that shows it follows one frame later.
    view.scroll().scrollTo(10)
    expect(await view.framesUntil(1)).toBeLessThanOrEqual(2)

    view.scroll().scrollTo(0)
    expect(await view.framesUntil(0)).toBeLessThanOrEqual(2)
  } finally {
    await view.dispose()
  }
})

test("a spinner only partly inside the viewport still ticks", async () => {
  const view = await mountInScrollBox()
  try {
    await view.framesUntil(0)
    // Scrolled so that the spinner's line is the last one in the 4-line viewport.
    view.scroll().scrollTo(7)
    await view.framesUntil(1)
  } finally {
    await view.dispose()
  }
})
