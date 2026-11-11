// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
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
