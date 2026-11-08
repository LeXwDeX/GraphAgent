/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount, type JSX, type ParentProps } from "solid-js"
import { TuiKeybind } from "../../src/config/keybind"
import { setLanguage } from "../../src/i18n"
import { GraphagentKeymapProvider, registerGraphagentKeymap } from "../../src/keymap"
import { Footer, useFooterKeyHints, type FooterHint } from "../../src/shell/footer"
import { useFooterStatus } from "../../src/shell/footer-status"
import { ToastProvider, useToast } from "../../src/ui/toast"
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
    toast.show({ message: "Copied to clipboard", variant: "info", duration: 30000 })
  })
  return (
    <box>
      <Footer agent="build" agentAction="tab" hints={hints} right={status()} />
    </box>
  )
}

test("renders a toast in the footer right slot instead of idle hints", async () => {
  await using tmp = await shellState()
  const app = await render(() => (
    <ToastProvider>
      <FooterFromStatus />
    </ToastProvider>
  ), { width: 80, state: tmp.path })
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
  const app = await render(() => (
    <ToastProvider>
      <FooterFromStatus />
    </ToastProvider>
  ), { width: 80, state: tmp.path })
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
