// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createSignal, onCleanup, onMount, type JSX, type ParentProps } from "solid-js"
import { useKV } from "../../src/context/kv"
import { useTheme } from "../../src/context/theme"
import { TickerProvider } from "../../src/context/ticker-context"
import type { Ticker } from "../../src/context/ticker"
import { setLanguage } from "../../src/i18n"
import { GraphagentKeymapProvider, registerGraphagentKeymap } from "../../src/keymap"
import {
  DAG_INDICATOR_NARROW_WIDTH,
  DagIndicator,
  dagIndicatorCompact,
  dagIndicatorReserve,
  dagIndicatorText,
  dagIndicatorToken,
  type DagIndicatorState,
} from "../../src/shell/dag-indicator"
import { AppFrame } from "../../src/shell/app-frame"
import { Footer, type FooterHint } from "../../src/shell/footer"
import { useFooterStatus } from "../../src/shell/footer-status"
import { FooterToastProvider, useToast } from "../../src/ui/toast"
import { cellWidth, type AmbiguousWidth } from "../../src/ui/width"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { ShellContexts, shellState } from "./contexts"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

const STATES: readonly DagIndicatorState[] = ["on", "off", "unavailable"]

const hints: readonly FooterHint[] = [
  { key: "/", label: "命令" },
  { key: "ctrl+b", label: "侧边栏" },
  { key: "ctrl+o", label: "展开输出" },
  { key: "?", label: "快捷键" },
]

type Rendered = Awaited<ReturnType<typeof testRender>>

type ThemeValue = ReturnType<typeof useTheme>["theme"]

function ThemeProbe(props: { onTheme: (theme: ThemeValue) => void }) {
  props.onTheme(useTheme().theme)
  return <></>
}

// The shell contexts resolve before the reactive swap from their blank
// fallback has painted, and a single `renderOnce` can still capture an empty
// frame. Render until the first non-empty frame instead of assuming a count.
async function settleFrame(app: Rendered) {
  const deadline = Date.now() + 5_000
  for (;;) {
    await app.renderOnce()
    await Bun.sleep(0)
    if (app.captureCharFrame().trim().length > 0) return
    if (Date.now() > deadline) throw new Error("timed out waiting for a non-empty frame")
  }
}

async function render(component: () => JSX.Element, options: { width: number; height?: number; state: string }) {
  let theme: ThemeValue | undefined
  let ready!: () => void
  const settled = new Promise<void>((resolve) => (ready = resolve))
  const app = await testRender(
    () => (
      <ShellContexts state={options.state} onReady={ready}>
        <ThemeProbe onTheme={(value) => (theme = value)} />
        {component()}
      </ShellContexts>
    ),
    { width: options.width, height: options.height ?? 1 },
  )
  await settled
  await settleFrame(app)
  const probe = {
    get theme() {
      if (!theme) throw new Error("the theme probe never mounted")
      return theme
    },
  }
  return { app, probe }
}

function expectWithin(frame: string, width: number, ambiguousWidth: AmbiguousWidth) {
  for (const line of frame.split("\n").map((item) => item.trimEnd())) {
    expect(cellWidth(line, ambiguousWidth)).toBeLessThanOrEqual(width)
  }
}

/** Foreground of the first span holding `text`, as the renderer painted it. */
function foregroundOf(app: Rendered, text: string) {
  for (const line of app.captureSpans().lines) {
    for (const span of line.spans) if (span.text.includes(text)) return span.fg
  }
  throw new Error(`no span contains ${text}:\n${app.captureCharFrame()}`)
}

const LABEL: Record<DagIndicatorState, string> = { on: "◆ DAG", off: "◇ DAG", unavailable: "◆ DAG !" }
const GLYPH: Record<DagIndicatorState, string> = { on: "◆", off: "◇", unavailable: "◆" }

test("labels each state and keeps only the marker glyph when compact", () => {
  for (const language of ["zh-CN", "en"] as const) {
    setLanguage(language)
    for (const state of STATES) {
      expect(dagIndicatorText(state, false)).toBe(LABEL[state])
      expect(dagIndicatorText(state, true)).toBe(GLYPH[state])
    }
  }
})

test("colors on with primary, off with textDim and unavailable with warning", () => {
  expect(dagIndicatorToken("on")).toBe("primary")
  expect(dagIndicatorToken("off")).toBe("textDim")
  expect(dagIndicatorToken("unavailable")).toBe("warning")
})

test("switches to the compact form below 80 columns", () => {
  expect(DAG_INDICATOR_NARROW_WIDTH).toBe(80)
  expect(dagIndicatorCompact(79)).toBe(true)
  expect(dagIndicatorCompact(80)).toBe(false)
  expect(dagIndicatorCompact(120)).toBe(false)
})

test("measures the marker glyph through cellWidth for both ambiguous widths", () => {
  expect(cellWidth("◆", 1)).toBe(1)
  expect(cellWidth("◇", 2)).toBe(2)
  expect(cellWidth(LABEL.on, 1)).toBe(5)
  expect(cellWidth(LABEL.on, 2)).toBe(6)
  expect(cellWidth(LABEL.unavailable, 1)).toBe(7)
  expect(cellWidth(LABEL.unavailable, 2)).toBe(8)
  // The reserve is the label plus the gap that separates it from its neighbor.
  expect(dagIndicatorReserve("on", 120, 1)).toBe(6)
  expect(dagIndicatorReserve("on", 120, 2)).toBe(7)
  expect(dagIndicatorReserve("unavailable", 80, 1)).toBe(8)
  expect(dagIndicatorReserve("unavailable", 80, 2)).toBe(9)
  expect(dagIndicatorReserve("off", 60, 1)).toBe(2)
  expect(dagIndicatorReserve("off", 60, 2)).toBe(3)
  expect(dagIndicatorReserve(undefined, 120, 2)).toBe(0)
})

for (const state of STATES) {
  test(`paints the ${state} indicator with its theme token`, async () => {
    await using tmp = await shellState()
    const { app, probe } = await render(() => <DagIndicator state={state} />, { width: 20, state: tmp.path })
    try {
      const frame = app.captureCharFrame()
      expect(frame).toContain(LABEL[state])
      const token = dagIndicatorToken(state)
      expect(foregroundOf(app, "DAG").equals(probe.theme[token])).toBe(true)
      // The three tokens are distinct colors, so a wrong mapping cannot pass.
      for (const other of ["primary", "textDim", "warning"] as const) {
        if (other !== token) expect(foregroundOf(app, "DAG").equals(probe.theme[other])).toBe(false)
      }
    } finally {
      app.renderer.destroy()
    }
  })

  test(`paints the compact ${state} marker with the same token`, async () => {
    await using tmp = await shellState()
    const { app, probe } = await render(() => <DagIndicator state={state} compact />, { width: 20, state: tmp.path })
    try {
      const frame = app.captureCharFrame()
      expect(frame).toContain(GLYPH[state])
      expect(frame).not.toContain("DAG")
      expect(foregroundOf(app, GLYPH[state]).equals(probe.theme[dagIndicatorToken(state)])).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })
}

for (const state of STATES) {
  test(`footer shows the ${state} indicator after the agent name at 120 columns`, async () => {
    await using tmp = await shellState()
    const { app, probe } = await render(() => <Footer agent="build" agentAction="tab" hints={hints} dag={state} />, {
      width: 120,
      state: tmp.path,
    })
    try {
      const frame = app.captureCharFrame()
      const line = frame.split("\n")[0]
      expect(line.indexOf(LABEL[state])).toBeGreaterThan(line.indexOf("build"))
      expect(line.indexOf(LABEL[state])).toBeLessThan(line.indexOf("tab 切换 agent"))
      expect(foregroundOf(app, "DAG").equals(probe.theme[dagIndicatorToken(state)])).toBe(true)
      expect(frame).toMatchSnapshot()
    } finally {
      app.renderer.destroy()
    }
  })

  test(`footer shows the ${state} indicator in full at 80 columns`, async () => {
    await using tmp = await shellState()
    const { app, probe } = await render(() => <Footer agent="build" agentAction="tab" hints={hints} dag={state} />, {
      width: 80,
      state: tmp.path,
    })
    try {
      const frame = app.captureCharFrame()
      expect(frame).toContain(`build ${LABEL[state]} tab 切换 agent`)
      expect(foregroundOf(app, "DAG").equals(probe.theme[dagIndicatorToken(state)])).toBe(true)
      expectWithin(frame, 80, 1)
      expect(frame).toMatchSnapshot()
    } finally {
      app.renderer.destroy()
    }
  })

  test(`footer keeps the ${state} marker alone at the 60 column minimum`, async () => {
    await using tmp = await shellState({ ambiguous_width: 2 })
    const { app, probe } = await render(() => <Footer agent="build" agentAction="tab" hints={hints} dag={state} />, {
      width: 60,
      state: tmp.path,
    })
    try {
      const frame = app.captureCharFrame()
      expect(frame).toContain(`build ${GLYPH[state]} tab 切换 agent`)
      expect(frame).not.toContain("DAG")
      expect(foregroundOf(app, GLYPH[state]).equals(probe.theme[dagIndicatorToken(state)])).toBe(true)
      expectWithin(frame, 60, 2)
    } finally {
      app.renderer.destroy()
    }
  })

  test(`footer keeps the ${state} marker alone at 79 columns`, async () => {
    await using tmp = await shellState()
    const { app, probe } = await render(() => <Footer agent="build" agentAction="tab" hints={hints} dag={state} />, {
      width: 79,
      state: tmp.path,
    })
    try {
      const frame = app.captureCharFrame()
      expect(frame).not.toContain("DAG")
      expect(frame).toContain(`build ${GLYPH[state]} tab 切换 agent`)
      expect(foregroundOf(app, GLYPH[state]).equals(probe.theme[dagIndicatorToken(state)])).toBe(true)
      expectWithin(frame, 79, 1)
      expect(frame).toMatchSnapshot()
    } finally {
      app.renderer.destroy()
    }
  })
}

test("footer without a DAG state is unchanged", async () => {
  await using tmp = await shellState()
  const { app } = await render(() => <Footer agent="build" agentAction="tab" hints={hints} />, {
    width: 120,
    state: tmp.path,
  })
  try {
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("DAG")
    expect(frame).toContain("build tab 切换 agent")
  } finally {
    app.renderer.destroy()
  }
})

for (const width of [80, 120]) {
  for (const ambiguousWidth of [1, 2] as const) {
    for (const state of STATES) {
      test(`footer row with the ${state} indicator fits ${width} columns at ambiguous_width ${ambiguousWidth}`, async () => {
        await using tmp = await shellState({ ambiguous_width: ambiguousWidth })
        const { app } = await render(
          () => (
            <Footer
              agent="build"
              agentAction="tab"
              hints={[...hints, { key: "ctrl+x b", label: "这个提示应该被丢弃" }]}
              dag={state}
            />
          ),
          { width, state: tmp.path },
        )
        try {
          const frame = app.captureCharFrame()
          expect(frame).toContain(LABEL[state])
          expectWithin(frame, width, ambiguousWidth)
        } finally {
          app.renderer.destroy()
        }
      })
    }
  }
}

for (const ambiguousWidth of [1, 2] as const) {
  test(`footer drops trailing hints before it lets the indicator overflow 80 columns at ambiguous_width ${ambiguousWidth}`, async () => {
    await using tmp = await shellState({ ambiguous_width: ambiguousWidth })
    // Without the indicator all four hints just fit; with it the last one has to go.
    const { app } = await render(() => <Footer agent="build" agentAction="tab" hints={hints} dag="unavailable" />, {
      width: 80,
      state: tmp.path,
    })
    try {
      const frame = app.captureCharFrame()
      expect(frame).toContain("◆ DAG !")
      expect(frame).toContain("ctrl+o 展开输出")
      expect(frame).not.toContain("快捷键")
      expectWithin(frame, 80, ambiguousWidth)
    } finally {
      app.renderer.destroy()
    }
  })
}

for (const ambiguousWidth of [1, 2] as const) {
  test(`footer keeps the indicator next to the shared right slot at ambiguous_width ${ambiguousWidth}`, async () => {
    await using tmp = await shellState({ ambiguous_width: ambiguousWidth })
    const { app } = await render(
      () => <Footer agent="build" agentAction="tab" dag="on" right={<text>status: indexing</text>} />,
      { width: 80, state: tmp.path },
    )
    try {
      const frame = app.captureCharFrame()
      expect(frame).toContain("build ◆ DAG tab 切换 agent")
      expect(frame).toContain("status: indexing")
      expectWithin(frame, 80, ambiguousWidth)
    } finally {
      app.renderer.destroy()
    }
  })

  test(`footer budgets the trust reminder after the indicator at ambiguous_width ${ambiguousWidth}`, async () => {
    await using tmp = await shellState({ ambiguous_width: ambiguousWidth })
    const { app } = await render(
      () => <Footer agent="build" agentAction="tab" hints={hints} dag="unavailable" meta={{ trust: 1 }} />,
      { width: 80, state: tmp.path },
    )
    try {
      const frame = app.captureCharFrame()
      expect(frame).toContain("◆ DAG !")
      expect(frame).toContain("未信任")
      expectWithin(frame, 80, ambiguousWidth)
    } finally {
      app.renderer.destroy()
    }
  })
}

function KeymapHarness(props: ParentProps) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  onCleanup(registerGraphagentKeymap(keymap, renderer, createTuiResolvedConfig()))
  return <GraphagentKeymapProvider keymap={keymap}>{props.children}</GraphagentKeymapProvider>
}

function ToastWithIndicator(props: { state: DagIndicatorState; text: string; reserve: boolean }) {
  const toast = useToast()
  const kv = useKV()
  const dimensions = useTerminalDimensions()
  const status = useFooterStatus(
    undefined,
    props.reserve
      ? () => dagIndicatorReserve(props.state, dimensions().width, kv.get("ambiguous_width", 1) === 2 ? 2 : 1)
      : undefined,
  )
  onMount(() => toast.show({ text: props.text, level: "error", duration: 30_000 }))
  return <Footer agent="build" agentAction="tab" hints={hints} dag={props.state} right={status()} />
}

async function renderToastWithIndicator(options: {
  state: DagIndicatorState
  reserve: boolean
  ambiguousWidth: AmbiguousWidth
  width: number
}) {
  const tmp = await shellState({ ambiguous_width: options.ambiguousWidth })
  const { app } = await render(
    () => (
      <KeymapHarness>
        <FooterToastProvider>
          <TickerProvider>
            <ToastWithIndicator state={options.state} text={`failure ${"x".repeat(200)}`} reserve={options.reserve} />
          </TickerProvider>
        </FooterToastProvider>
      </KeymapHarness>
    ),
    { width: options.width, state: tmp.path },
  )
  await settleFrame(app)
  return { app, tmp }
}

for (const ambiguousWidth of [1, 2] as const) {
  for (const state of STATES) {
    test(`a truncated toast leaves room for the ${state} indicator at ambiguous_width ${ambiguousWidth}`, async () => {
      const { app, tmp } = await renderToastWithIndicator({ state, reserve: true, ambiguousWidth, width: 80 })
      try {
        const frame = app.captureCharFrame()
        expect(frame).toContain(LABEL[state])
        expect(frame).toContain("/status")
        expectWithin(frame, 80, ambiguousWidth)
      } finally {
        app.renderer.destroy()
        await tmp[Symbol.asyncDispose]()
      }
    })
  }
}

test("without the reserve a truncated toast clips the footer's own text", async () => {
  // Guards the reserve above: it is what keeps the toast clear of the indicator.
  const { app, tmp } = await renderToastWithIndicator({
    state: "unavailable",
    reserve: false,
    ambiguousWidth: 1,
    width: 80,
  })
  try {
    const frame = app.captureCharFrame()
    expect(["◆ DAG !", "tab 切换 agent", "/status"].every((part) => frame.includes(part))).toBe(false)
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("footer shortens a long agent name before the indicator", async () => {
  await using tmp = await shellState({ ambiguous_width: 2 })
  const { app } = await render(
    () => <Footer agent={"a".repeat(120)} agentAction="tab" hints={hints} dag="unavailable" />,
    { width: 80, state: tmp.path },
  )
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("◆ DAG !")
    expect(frame).toContain("…")
    expectWithin(frame, 80, 2)
  } finally {
    app.renderer.destroy()
  }
})

test("footer follows state changes and the interface language", async () => {
  await using tmp = await shellState()
  const [state, setState] = createSignal<DagIndicatorState>("off")
  const { app } = await render(() => <Footer agent="build" agentAction="tab" hints={hints} dag={state()} />, {
    width: 120,
    state: tmp.path,
  })
  try {
    expect(app.captureCharFrame()).toContain("◇ DAG")
    setState("on")
    await settleFrame(app)
    expect(app.captureCharFrame()).toContain("◆ DAG")
    expect(app.captureCharFrame()).not.toContain("◇ DAG")
    setState("unavailable")
    await settleFrame(app)
    expect(app.captureCharFrame()).toContain("◆ DAG !")
    // The glyph labels are identical in both tables, so switching language keeps them.
    setLanguage("en")
    await settleFrame(app)
    expect(app.captureCharFrame()).toContain("◆ DAG !")
    expect(app.captureCharFrame()).toContain("tab switch agent")
  } finally {
    app.renderer.destroy()
  }
})

test("the indicator never touches the ticker", async () => {
  await using tmp = await shellState()
  const calls = { subscribe: 0, subscribeSecond: 0, at: 0, now: 0, frame: 0, second: 0 }
  const ticker: Ticker = {
    frame: () => {
      calls.frame += 1
      return 0
    },
    second: () => {
      calls.second += 1
      return 0
    },
    subscribe: () => {
      calls.subscribe += 1
      return () => {}
    },
    subscribeSecond: () => {
      calls.subscribeSecond += 1
      return () => {}
    },
    at: () => {
      calls.at += 1
      return () => {}
    },
    now: () => {
      calls.now += 1
      return 0
    },
  }
  const [state, setState] = createSignal<DagIndicatorState>("on")
  const { app } = await render(
    () => (
      <TickerProvider ticker={ticker}>
        <Footer agent="build" agentAction="tab" hints={hints} dag={state()} />
      </TickerProvider>
    ),
    { width: 120, state: tmp.path },
  )
  try {
    for (const next of STATES) {
      setState(next)
      await settleFrame(app)
    }
    expect(calls).toEqual({ subscribe: 0, subscribeSecond: 0, at: 0, now: 0, frame: 0, second: 0 })
  } finally {
    app.renderer.destroy()
  }
})

test("the indicator sources hold no timer, animation or ticker import", async () => {
  for (const file of ["dag-indicator.tsx", "footer.tsx"]) {
    const source = await Bun.file(new URL(`../../src/shell/${file}`, import.meta.url)).text()
    expect(source).not.toMatch(/from\s+["'][^"']*ticker[^"']*["']/)
    expect(source).not.toMatch(/\b(setInterval|setTimeout)\b/)
    expect(source).not.toMatch(/BLINK|createFadeIn|<Spinner|<spinner/)
  }
})

test("the display component stays free of data access", async () => {
  const source = await Bun.file(new URL("../../src/shell/dag-indicator.tsx", import.meta.url)).text()
  expect(source).not.toMatch(/\bsdk\b|useSDK|useSync|useRoute/)
})

for (const ambiguousWidth of [1, 2] as const) {
  test(`app frame hands footer.dag to the footer at ambiguous_width ${ambiguousWidth}`, async () => {
    await using tmp = await shellState({ ambiguous_width: ambiguousWidth })
    const { app } = await render(
      () => (
        <AppFrame footer={{ agent: "build", agentAction: "tab", hints, dag: "on" }}>
          <text>主区内容</text>
        </AppFrame>
      ),
      { width: 80, height: 24, state: tmp.path },
    )
    try {
      const frame = app.captureCharFrame()
      const footerLine = frame
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .at(-1)!
      expect(footerLine).toContain("build ◆ DAG tab 切换 agent")
      expectWithin(frame, 80, ambiguousWidth)
    } finally {
      app.renderer.destroy()
    }
  })
}
