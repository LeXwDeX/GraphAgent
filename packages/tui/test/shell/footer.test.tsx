// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { testRender, useRenderer } from "@opentui/solid"
import { createSignal, onCleanup, onMount, type JSX, type ParentProps } from "solid-js"
import { TuiKeybind } from "../../src/config/keybind"
import { setLanguage } from "../../src/i18n"
import { GraphagentKeymapProvider, registerGraphagentKeymap } from "../../src/keymap"
import { Footer, useFooterKeyHints, type FooterHint } from "../../src/shell/footer"
import { useFooterStatus } from "../../src/shell/footer-status"
import { FooterToastProvider, toastDuration, useToast, type ToastOptions } from "../../src/ui/toast"
import { TickerProvider } from "../../src/context/ticker-context"
import { cellWidth, type AmbiguousWidth } from "../../src/ui/width"
import { ShellContexts, shellState } from "./contexts"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

function createResolvedKeymapConfig(input: TuiKeybind.KeybindOverrides = {}) {
  const keybinds = TuiKeybind.parse(input)
  return {
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(keybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: 2000,
  }
}

function KeymapHarness(props: ParentProps<{ overrides?: TuiKeybind.KeybindOverrides }>) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const config = createResolvedKeymapConfig(props.overrides)
  const offKeymap = registerGraphagentKeymap(keymap, renderer, config)
  const offLayer = keymap.registerLayer({
    commands: [
      { name: "agent.cycle", run() {} },
      { name: "command.palette.show", run() {} },
      { name: "session.drawer.toggle", run() {} },
      { name: "help.show", run() {} },
    ],
    bindings: config.keybinds.gather("app", [
      "agent.cycle",
      "command.palette.show",
      "session.drawer.toggle",
      "help.show",
    ]),
  })
  onCleanup(() => {
    offLayer()
    offKeymap()
  })
  return <GraphagentKeymapProvider keymap={keymap}>{props.children}</GraphagentKeymapProvider>
}

function FooterFromKeymap() {
  const keys = useFooterKeyHints()
  return <Footer agent="build" agentAction={keys().agent} hints={keys().hints} />
}

async function render(
  component: () => JSX.Element,
  options: { width: number; height?: number; state: string; overrides?: TuiKeybind.KeybindOverrides },
) {
  let ready!: () => void
  const settled = new Promise<void>((resolve) => (ready = resolve))
  const app = await testRender(
    () => (
      <ShellContexts state={options.state} onReady={ready}>
        <KeymapHarness overrides={options.overrides}>{component()}</KeymapHarness>
      </ShellContexts>
    ),
    { width: options.width, height: options.height ?? 1 },
  )
  await settled
  await app.renderOnce()
  await app.renderOnce()
  return app
}

function expectWithin(frame: string, width: number, ambiguousWidth: AmbiguousWidth) {
  for (const line of frame.split("\n").map((item) => item.trimEnd())) {
    expect(cellWidth(line, ambiguousWidth)).toBeLessThanOrEqual(width)
  }
}

const hints: readonly FooterHint[] = [
  { key: "/", label: "命令" },
  { key: "ctrl+b", label: "侧边栏" },
  { key: "ctrl+o", label: "展开输出" },
  { key: "?", label: "快捷键" },
]

test("renders the active agent and idle hints at 80 columns", async () => {
  await using tmp = await shellState()
  const app = await render(() => <Footer agent="build" agentAction="tab" hints={hints} />, {
    width: 80,
    state: tmp.path,
  })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("build")
    expect(frame).toContain("tab 切换 agent")
    expect(frame).toContain("/ 命令")
    expect(frame).toContain("ctrl+b 侧边栏")
    expect(frame).toContain("ctrl+o 展开输出")
    expect(frame).toContain("? 快捷键")
    expectWithin(frame, 80, 1)
  } finally {
    app.renderer.destroy()
  }
})

test("translates the footer labels", async () => {
  await using tmp = await shellState()
  setLanguage("en")
  const app = await render(() => <FooterFromKeymap />, { width: 120, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("tab switch agent")
    expect(frame).toContain("ctrl+p commands")
    expect(frame).toContain("ctrl+b drawer")
    expect(frame).toContain("? shortcuts")
    expect(frame).not.toContain("切换 agent")
  } finally {
    app.renderer.destroy()
  }
})

for (const ambiguousWidth of [1, 2] as const) {
  test(`drops trailing hints instead of overflowing at 80 columns with ambiguous_width ${ambiguousWidth}`, async () => {
    await using tmp = await shellState({ ambiguous_width: ambiguousWidth })
    const longHints: readonly FooterHint[] = [
      ...hints,
      { key: "ctrl+x b", label: "这个提示应该被丢弃" },
      { key: "ctrl+x c", label: "这个提示也应该被丢弃" },
    ]
    const app = await render(() => <Footer agent="build" agentAction="tab" hints={longHints} />, {
      width: 80,
      state: tmp.path,
    })

    try {
      const frame = app.captureCharFrame()
      expect(frame).toContain("/ 命令")
      expect(frame).not.toContain("这个提示也应该被丢弃")
      expectWithin(frame, 80, ambiguousWidth)
    } finally {
      app.renderer.destroy()
    }
  })
}

test("builds hints from registered keymap bindings", async () => {
  await using tmp = await shellState()
  const app = await render(() => <FooterFromKeymap />, {
    width: 120,
    state: tmp.path,
    overrides: { session_drawer_toggle: "f9" },
  })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("tab 切换 agent")
    expect(frame).toContain("ctrl+p 命令")
    expect(frame).toContain("f9 侧边栏")
    expect(frame).not.toContain("ctrl+b 侧边栏")
    expect(frame).toContain("? 快捷键")
    expect(frame).not.toContain("展开输出")
    expectWithin(frame, 120, 1)
  } finally {
    app.renderer.destroy()
  }
})

test("renders the shared right slot instead of idle hints", async () => {
  await using tmp = await shellState()
  const app = await render(
    () => (
      <Footer
        agent="build"
        agentAction="tab"
        hints={hints}
        meta={{ directory: "~/project:main", mcp: { count: 2, error: false }, version: "1.2.3" }}
        right={<text>status: indexing</text>}
      />
    ),
    { width: 80, state: tmp.path },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("status: indexing")
    expect(frame).not.toContain("/ 命令")
    expect(frame).not.toContain("~/project:main")
    expect(frame).not.toContain("1.2.3")
    expectWithin(frame, 80, 1)
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the trust reminder next to the right slot and drops it at zero", async () => {
  await using tmp = await shellState()
  const [trust, setTrust] = createSignal(1)
  function ReminderFooter() {
    return (
      <Footer
        agent="build"
        agentAction="tab"
        hints={hints}
        meta={{ trust: trust() }}
        right={<text>status: indexing</text>}
      />
    )
  }
  const app = await render(() => <ReminderFooter />, { width: 120, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("⚠ 1 条项目命令未信任 · /trust")
    expect(frame).toContain("status: indexing")
    expectWithin(frame, 120, 1)

    setTrust(0)
    await app.renderOnce()
    await app.renderOnce()
    const cleared = app.captureCharFrame()
    expect(cleared).not.toContain("未信任")
    expect(cleared).toContain("status: indexing")
  } finally {
    app.renderer.destroy()
  }
})

test("renders home meta between the agent and the idle hints", async () => {
  await using tmp = await shellState()
  const app = await render(
    () => (
      <Footer
        agent="build"
        agentAction="tab"
        hints={hints}
        meta={{ directory: "~/project:main", mcp: { count: 2, error: false }, version: "1.2.3" }}
      />
    ),
    { width: 120, state: tmp.path },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("~/project:main")
    expect(frame).toContain("⊙ 2 MCP")
    expect(frame).toContain("1.2.3")
    expect(frame).toContain("/ 命令")
    expectWithin(frame, 120, 1)
  } finally {
    app.renderer.destroy()
  }
})

function FooterFromStatus() {
  const toast = useToast()
  const status = useFooterStatus()
  onMount(() => {
    toast.show({ text: "Copied to clipboard", level: "info", duration: 30000 })
  })
  return (
    <box>
      <Footer agent="build" agentAction="tab" hints={hints} right={status()} />
    </box>
  )
}

test("renders a toast in the footer right slot instead of idle hints", async () => {
  await using tmp = await shellState()
  const app = await render(
    () => (
      <FooterToastProvider>
        <TickerProvider>
          <FooterFromStatus />
        </TickerProvider>
      </FooterToastProvider>
    ),
    { width: 80, state: tmp.path },
  )
  await app.renderOnce()

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Copied to clipboard")
    expect(frame).not.toContain("/ 命令")
    expectWithin(frame, 80, 1)
  } finally {
    app.renderer.destroy()
  }
})

test("shows pending leader keys ahead of a toast in the shared right slot", async () => {
  await using tmp = await shellState()
  const app = await render(
    () => (
      <FooterToastProvider>
        <TickerProvider>
          <FooterFromStatus />
        </TickerProvider>
      </FooterToastProvider>
    ),
    { width: 80, state: tmp.path },
  )
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("Copied to clipboard")

  try {
    app.mockInput.pressKey("x", { ctrl: true })
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("Copied to clipboard")
    expect(frame).not.toContain("/ 命令")
    expectWithin(frame, 80, 1)
  } finally {
    app.renderer.destroy()
  }
})

function ToastProbe(props: { onToast: (toast: ReturnType<typeof useToast>) => void }) {
  const toast = useToast()
  props.onToast(toast)
  return <box />
}

async function renderToastStore() {
  let toast!: ReturnType<typeof useToast>
  const app = await testRender(
    () => (
      <FooterToastProvider>
        <ToastProbe onToast={(value) => (toast = value)} />
      </FooterToastProvider>
    ),
    { width: 40, height: 1 },
  )
  return { app, toast: () => toast }
}

test("keeps one toast visible, queues three more and drops the oldest info", async () => {
  const { app, toast } = await renderToastStore()
  try {
    toast().show({ text: "one", level: "info" })
    toast().show({ text: "two", level: "info" })
    toast().show({ text: "warn", level: "warning" })
    toast().show({ text: "three", level: "info" })
    toast().show({ text: "four", level: "success" })
    expect(toast().currentToast?.text).toBe("one")
    expect(toast().queued.map((entry) => entry.text)).toEqual(["warn", "three", "four"])
  } finally {
    app.renderer.destroy()
  }
})

test("drops the oldest entry when no info toast can make room", async () => {
  const { app, toast } = await renderToastStore()
  try {
    toast().show({ text: "w1", level: "warning" })
    toast().show({ text: "e1", level: "error" })
    toast().show({ text: "w2", level: "warning" })
    toast().show({ text: "e2", level: "error" })
    toast().show({ text: "w3", level: "warning" })
    expect(toast().currentToast?.text).toBe("w1")
    expect(toast().queued.map((entry) => entry.text)).toEqual(["w2", "e2", "w3"])
  } finally {
    app.renderer.destroy()
  }
})

test("merges a repeated dedupeKey inside ten seconds and keeps the entry id", async () => {
  const { app, toast } = await renderToastStore()
  const clock = spyOn(Date, "now").mockReturnValue(1_000)
  try {
    toast().show({ text: "first", level: "info", dedupeKey: "same" })
    const id = toast().currentToast?.id
    clock.mockReturnValue(5_000)
    toast().show({ text: "second", level: "info", dedupeKey: "same" })
    expect(toast().currentToast?.id).toBe(id)
    expect(toast().currentToast?.text).toBe("second")
    expect(toast().queued).toHaveLength(0)
  } finally {
    clock.mockRestore()
    app.renderer.destroy()
  }
})

test("does not merge an expired dedupeKey", async () => {
  const { app, toast } = await renderToastStore()
  const clock = spyOn(Date, "now").mockReturnValue(1_000)
  try {
    toast().show({ text: "first", level: "info", dedupeKey: "same" })
    clock.mockReturnValue(11_000)
    toast().show({ text: "second", level: "info", dedupeKey: "same" })
    expect(toast().currentToast?.text).toBe("first")
    expect(toast().queued.map((entry) => entry.text)).toEqual(["second"])
  } finally {
    clock.mockRestore()
    app.renderer.destroy()
  }
})

test("merges identical plain text even without a dedupeKey", async () => {
  const { app, toast } = await renderToastStore()
  try {
    toast().show({ text: "same", level: "error" })
    toast().show({ text: "same", level: "error" })
    expect(toast().queued).toHaveLength(0)
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the latest twenty error messages for the status panel", async () => {
  const { app, toast } = await renderToastStore()
  const clock = spyOn(Date, "now").mockReturnValue(1_000)
  try {
    for (let index = 0; index < 21; index++) toast().show({ text: `error ${index}`, level: "error" })
    expect(toast().recentMessages).toHaveLength(20)
    expect(toast().recentMessages[0]?.text).toBe("error 20")
    expect(toast().recentMessages[19]?.text).toBe("error 1")
  } finally {
    clock.mockRestore()
    app.renderer.destroy()
  }
})

test("defaults to four seconds and eight seconds for errors", () => {
  expect(toastDuration({ text: "x", level: "info" })).toBe(4_000)
  expect(toastDuration({ text: "x", level: "error" })).toBe(8_000)
  expect(toastDuration({ text: "x", level: "success", duration: 1_500 })).toBe(1_500)
})

function ToastFooter(props: { options: ToastOptions; expose?: (toast: ReturnType<typeof useToast>) => void }) {
  const toast = useToast()
  const status = useFooterStatus()
  props.expose?.(toast)
  onMount(() => toast.show(props.options))
  return <Footer agent="build" agentAction="tab" hints={hints} right={status()} />
}

test("truncates an overlong error and keeps the full text in recent messages", async () => {
  await using tmp = await shellState()
  const long = `failure ${"x".repeat(200)}`
  let toast!: ReturnType<typeof useToast>
  const app = await render(
    () => (
      <FooterToastProvider>
        <TickerProvider>
          <ToastFooter options={{ text: long, level: "error", duration: 30_000 }} expose={(value) => (toast = value)} />
        </TickerProvider>
      </FooterToastProvider>
    ),
    { width: 80, state: tmp.path },
  )
  await app.renderOnce()
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("/status")
    expect(frame).not.toContain(long)
    expect(toast.recentMessages[0]?.text).toBe(long)
    expectWithin(frame, 80, 1)
  } finally {
    app.renderer.destroy()
  }
})

test("activates the footer toast on click", async () => {
  await using tmp = await shellState()
  let activations = 0
  const app = await render(
    () => (
      <FooterToastProvider>
        <TickerProvider>
          <ToastFooter
            options={{ text: "Activate me", level: "info", duration: 30_000, onActivate: () => activations++ }}
          />
        </TickerProvider>
      </FooterToastProvider>
    ),
    { width: 80, state: tmp.path },
  )
  await app.renderOnce()
  await app.renderOnce()
  try {
    const frame = app.captureCharFrame()
    const column = frame.split("\n")[0]!.indexOf("Activate me")
    expect(column).toBeGreaterThanOrEqual(0)
    await app.mockMouse.click(column + 2, 0)
    expect(activations).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})
