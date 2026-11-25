// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { testRender, useRenderer } from "@opentui/solid"
import type { Event } from "@graphagent/sdk"
import { createSignal, onCleanup, onMount, type JSX, type ParentProps } from "solid-js"
import { TuiKeybind } from "../../src/config/keybind"
import { createTuiNotifications } from "../../src/attention/notify"
import { setLanguage } from "../../src/i18n"
import { GraphagentKeymapProvider, registerGraphagentKeymap } from "../../src/keymap"
import { DEFAULT_THEME } from "../../src/context/theme"
import {
  Footer,
  subagentFooterHints,
  subagentNoticeReserve,
  useFooterKeyHints,
  type FooterHint,
} from "../../src/shell/footer"
import { useFooterStatus } from "../../src/shell/footer-status"
import { FooterToastProvider, toastDuration, useToast, type ToastOptions } from "../../src/ui/toast"
import { TickerProvider } from "../../src/context/ticker-context"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import { cellWidth, type AmbiguousWidth } from "../../src/ui/width"
import { ShellContexts, renderFirstFrame, shellState } from "./contexts"

let tmux: string | undefined

beforeEach(() => {
  setLanguage("zh-CN")
  // Inside tmux the drawer toggle shows its leader alternative, so the footer text
  // would depend on where the suite runs; tests that want tmux set it themselves.
  tmux = process.env.TMUX
  delete process.env.TMUX
})

afterEach(() => {
  setLanguage("zh-CN")
  if (tmux === undefined) delete process.env.TMUX
  else process.env.TMUX = tmux
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

/**
 * `expand` registers `view.expand.toggle` the way the session route does. Without it the command has no binding, as
 * on the home route, and the footer leaves the hint out.
 */
function KeymapHarness(props: ParentProps<{ overrides?: TuiKeybind.KeybindOverrides; expand?: boolean }>) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const config = createResolvedKeymapConfig(props.overrides)
  const offKeymap = registerGraphagentKeymap(keymap, renderer, config)
  const names = ["agent.cycle", "command.palette.show", "session.drawer.toggle", "help.show"]
  if (props.expand) names.push("view.expand.toggle")
  const offLayer = keymap.registerLayer({
    commands: names.map((name) => ({ name, run() {} })),
    bindings: config.keybinds.gather("app", names),
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
  options: {
    width: number
    height?: number
    state: string
    overrides?: TuiKeybind.KeybindOverrides
    expand?: boolean
  },
) {
  const app = await testRender(
    () => (
      <ShellContexts state={options.state}>
        <KeymapHarness overrides={options.overrides} expand={options.expand}>
          {component()}
        </KeymapHarness>
      </ShellContexts>
    ),
    { width: options.width, height: options.height ?? 1 },
  )
  await renderFirstFrame(app)
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
    expect(frame).toContain("⇥ switch agent")
    expect(frame).toContain("⌃P commands")
    expect(frame).toContain("⌃B drawer")
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

// The keys of the footer written as the user rebinds them: modifiers, shift and arrows, the widest the symbols get. `⇧`
// and the arrows take two cells each at ambiguous_width 2, so the row has less room there; it must still fit.
const ARROW_KEYS: TuiKeybind.KeybindOverrides = {
  agent_cycle: "shift+left",
  command_list: "ctrl+shift+up",
  session_drawer_toggle: "shift+down",
  view_expand_toggle: "alt+right",
  help_show: "<leader>down",
}

test("writes the rebound keys with the symbols of the keymap, in the order the footer lists them", async () => {
  await using tmp = await shellState()
  const app = await render(() => <FooterFromKeymap />, {
    width: 120,
    state: tmp.path,
    expand: true,
    overrides: ARROW_KEYS,
  })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("⇧← 切换 agent")
    expect(frame).toContain("⌃⇧↑ 命令 · ⇧↓ 侧边栏 · ⌥→ 展开输出 · ⌃X ↓ 快捷键")
    expectWithin(frame, 120, 1)
  } finally {
    app.renderer.destroy()
  }
})

for (const ambiguousWidth of [1, 2] as const) {
  test(`drops the trailing hints written with arrows instead of overflowing at 80 columns with ambiguous_width ${ambiguousWidth}`, async () => {
    await using tmp = await shellState({ ambiguous_width: ambiguousWidth })
    const app = await render(() => <FooterFromKeymap />, {
      width: 80,
      state: tmp.path,
      expand: true,
      overrides: ARROW_KEYS,
    })

    try {
      const frame = app.captureCharFrame()
      expect(frame).toContain("⌃⇧↑ 命令")
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
    expect(frame).toContain("⇥ 切换 agent")
    expect(frame).toContain("⌃P 命令")
    expect(frame).toContain("F9 侧边栏")
    expect(frame).not.toContain("⌃B 侧边栏")
    expect(frame).toContain("? 快捷键")
    expect(frame).not.toContain("展开输出")
    expectWithin(frame, 120, 1)
  } finally {
    app.renderer.destroy()
  }
})

test("lists the expand shortcut once the session route registers its command", async () => {
  await using tmp = await shellState()
  const app = await render(() => <FooterFromKeymap />, { width: 120, state: tmp.path, expand: true })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("⌃B 侧边栏")
    expect(frame).toContain("⌃O 展开输出")
    expect(frame).toContain("? 快捷键")
    // The hint sits between the drawer and the help hints, as the Issue's footer shows them.
    expect(frame.indexOf("侧边栏")).toBeLessThan(frame.indexOf("展开输出"))
    expect(frame.indexOf("展开输出")).toBeLessThan(frame.indexOf("快捷键"))
    expectWithin(frame, 120, 1)
  } finally {
    app.renderer.destroy()
  }
})

test("the expand hint follows the language and a rebound key", async () => {
  await using tmp = await shellState()
  setLanguage("en")
  const app = await render(() => <FooterFromKeymap />, {
    width: 120,
    state: tmp.path,
    expand: true,
    overrides: { view_expand_toggle: "f7" },
  })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("F7 expand output")
    expect(frame).not.toContain("⌃O")
    expect(frame).not.toContain("展开输出")
  } finally {
    app.renderer.destroy()
  }
})

test("shows the drawer toggle as its leader alternative inside tmux", async () => {
  await using tmp = await shellState()
  process.env.TMUX = "/tmp/tmux-1000/default,4242,0"
  const app = await render(() => <FooterFromKeymap />, { width: 120, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("⌃X B 侧边栏")
    expect(frame).not.toContain("⌃B 侧边栏")
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
        meta={{ mcp: { count: 2, error: false }, version: "1.2.3" }}
        right={<text>status: indexing</text>}
      />
    ),
    { width: 80, state: tmp.path },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("status: indexing")
    expect(frame).not.toContain("/ 命令")
    expect(frame).not.toContain("⊙ 2 MCP")
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
        meta={{ mcp: { count: 2, error: false }, version: "1.2.3" }}
      />
    ),
    { width: 120, state: tmp.path },
  )

  try {
    const frame = app.captureCharFrame()
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

for (const ambiguousWidth of [1, 2] as const) {
  test(`shows pending leader keys ahead of a toast in the shared right slot, with ambiguous_width ${ambiguousWidth}`, async () => {
    await using tmp = await shellState({ ambiguous_width: ambiguousWidth })
    const app = await render(
      () => (
        <FooterToastProvider>
          <TickerProvider>
            <FooterFromStatus />
          </TickerProvider>
        </FooterToastProvider>
      ),
      // The help command's leader key ends in an arrow, so the pending keys have one: `↓` takes two cells at 2.
      { width: 80, state: tmp.path, overrides: { help_show: "<leader>down" } },
    )
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Copied to clipboard")

    try {
      app.mockInput.pressKey("x", { ctrl: true })
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).not.toContain("Copied to clipboard")
      expect(frame).not.toContain("/ 命令")
      // The keys that can follow the leader, each written as the footer writes any key: capitals and symbols.
      expect(frame).toContain("B  ↓")
      expectWithin(frame, 80, ambiguousWidth)
    } finally {
      app.renderer.destroy()
    }
  })
}

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

test("an overflow drops a queued success before it drops a warning or an error", async () => {
  const { app, toast } = await renderToastStore()
  try {
    toast().show({ text: "now", level: "info" })
    toast().show({ text: "warn", level: "warning" })
    toast().show({ text: "ok1", level: "success" })
    toast().show({ text: "ok2", level: "success" })
    toast().show({ text: "ok3", level: "success" })
    expect(toast().currentToast?.text).toBe("now")
    expect(toast().queued.map((entry) => entry.text)).toEqual(["warn", "ok2", "ok3"])

    toast().show({ text: "err", level: "error" })
    expect(toast().queued.map((entry) => entry.text)).toEqual(["warn", "ok3", "err"])
    toast().show({ text: "ok4", level: "success" })
    expect(toast().queued.map((entry) => entry.text)).toEqual(["warn", "err", "ok4"])
  } finally {
    app.renderer.destroy()
  }
})

test("an overflow drops an info before a success, and a queue with only warnings and errors still drops the oldest", async () => {
  const { app, toast } = await renderToastStore()
  try {
    toast().show({ text: "now", level: "info" })
    toast().show({ text: "ok1", level: "success" })
    toast().show({ text: "note", level: "info" })
    toast().show({ text: "warn", level: "warning" })
    toast().show({ text: "ok2", level: "success" })
    expect(toast().queued.map((entry) => entry.text)).toEqual(["ok1", "warn", "ok2"])
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

// The toast of a finished background run (#1058 7) is keyed by its sub-agent, so a second result of the same one inside ten
// seconds is the same toast, with the second's text and click target, and its window starts over; later it is a new one.
test("two results of one sub-agent inside ten seconds are one toast, refreshed by the second", async () => {
  const { app, toast } = await renderToastStore()
  const clock = spyOn(Date, "now").mockReturnValue(1_000)
  const handlers: ((event: Event) => void)[] = []
  const opened: string[][] = []
  const dispose = createTuiNotifications({
    event: {
      on: (type, handler) => {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test double: the handler is kept for, and called with, the one event type it registered for.
        if (type === "message.part.updated") handlers.push(handler as (event: Event) => void)
        return () => {}
      },
    },
    sessions: {
      get: (sessionID) => ({
        title: sessionID,
        role: sessionID === "child" ? "task_child" : "root",
        parentID: sessionID === "child" ? "root" : undefined,
      }),
    },
    attention: { notify: async () => ({}) },
    subagent: {
      toast: toast(),
      viewing: () => "root",
      currentRoot: () => "root",
      task: () => ({ kind: "explore" }),
      open: () => {},
      openResult: (sessionID, messageID) => void opened.push([sessionID, messageID]),
    },
  })
  const report = (endedAt: number): Event => ({
    id: `event-${endedAt}`,
    type: "message.part.updated",
    properties: {
      sessionID: "root",
      time: endedAt,
      part: {
        id: `prt-${endedAt}`,
        sessionID: "root",
        messageID: `msg-${endedAt}`,
        type: "text",
        text: "<task_result>done</task_result>",
        synthetic: true,
        metadata: {
          backgroundResult: {
            childSessionID: "child",
            status: "completed",
            title: "scan",
            initiator: "agent",
            startedAt: 100,
            endedAt,
          },
        },
      },
    },
  })
  const emit = (event: Event) => {
    for (const handler of handlers) handler(event)
  }
  try {
    emit(report(300))
    const first = toast().currentToast
    expect(first?.text).toBe("explore 已完成 · 点击查看")
    expect(first?.dedupeKey).toBe("child")

    // Four seconds on, the same sub-agent reports again: it is the toast that is showing, not one behind it.
    clock.mockReturnValue(5_000)
    emit(report(400))
    expect(toast().currentToast?.id).toBe(first?.id)
    expect(toast().queued).toHaveLength(0)
    // The click goes where the later report is.
    toast().currentToast?.onActivate?.()
    expect(opened).toEqual([["root", "msg-400"]])

    // The window ran from the second report: nine seconds later it is still one toast, and past ten it is a new one.
    clock.mockReturnValue(14_000)
    emit(report(500))
    expect(toast().currentToast?.id).toBe(first?.id)
    expect(toast().queued).toHaveLength(0)
    clock.mockReturnValue(30_000)
    emit(report(600))
    expect(toast().queued.map((entry) => entry.text)).toEqual(["explore 已完成 · 点击查看"])
  } finally {
    dispose()
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

// ── Sub-agent view (#1033 3.3): the read-only notice and the keys of that view ───────────────────────────────────────

function SubagentFooterFromKeymap(props: { kind?: string; right?: JSX.Element; trust?: number }) {
  const keys = useFooterKeyHints()
  return (
    <Footer
      subagent={{ kind: props.kind ?? "explore" }}
      hints={subagentFooterHints(keys().drawer)}
      meta={props.trust ? { trust: props.trust } : undefined}
      right={props.right}
    />
  )
}

/** The footer row without the trailing blanks. */
const row = (frame: string) => frame.split("\n")[0].trimEnd()

test("a sub-agent footer says it is read-only and lists the keys of that view", async () => {
  await using tmp = await shellState()
  const app = await render(() => <SubagentFooterFromKeymap />, { width: 120, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    expect(row(frame)).toStartWith("  explore · 只读 · 子 agent 只接受主 agent 的通信")
    expect(row(frame)).toEndWith("←→ 切换子 agent")
    // The agent to switch to and the command hints belong to the views that have a prompt.
    expect(frame).not.toContain("切换 agent")
    expect(frame).not.toContain("⌃P")
    expect(frame).not.toContain("DAG")
    expectWithin(frame, 120, 1)
    expect(frame).toMatchSnapshot()
  } finally {
    app.renderer.destroy()
  }
})

test("a sub-agent footer in English", async () => {
  await using tmp = await shellState()
  setLanguage("en")
  const app = await render(() => <SubagentFooterFromKeymap />, { width: 120, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    expect(row(frame)).toStartWith("  explore · read-only · press esc to return to the main session")
    expect(frame).toMatchSnapshot()
  } finally {
    app.renderer.destroy()
  }
})

test("at 80 columns the trailing hints give way before the notice is cut", async () => {
  await using tmp = await shellState()
  // The row between the gutters has 76 cells. In Chinese the notice of `explore` takes 48 and the three hints 30, with
  // the gap 79: the drawer hint gives way beside the shortest kind already. The longest kind, below, leaves room for the
  // other two (56 + 1 + 18): the drawer hint goes first, the way back stays.
  const zh = await render(() => <SubagentFooterFromKeymap kind="general-purpose" />, { width: 80, state: tmp.path })
  try {
    const frame = zh.captureCharFrame()
    expect(row(frame)).toStartWith("  general-purpose · 只读 · 子 agent 只接受主 agent 的通信")
    expect(row(frame)).not.toContain("←→")
    expect(frame).not.toContain("侧边栏")
    expect(frame).toMatchSnapshot()
  } finally {
    zh.renderer.destroy()
  }

  setLanguage("en")
  const en = await render(() => <SubagentFooterFromKeymap />, { width: 80, state: tmp.path })
  try {
    const frame = en.captureCharFrame()
    expect(row(frame)).toStartWith("  explore · read-only · press esc to return to the main session")
    // The notice is short enough to leave the return hint visible.
    expect(row(frame)).not.toContain("←→")
    expect(frame).toMatchSnapshot()
  } finally {
    en.renderer.destroy()
  }
})

for (const language of ["zh-CN", "en"] as const) {
  for (const ambiguousWidth of [1, 2] as const) {
    test(`a sub-agent footer fits 80 columns in ${language} at ambiguous_width ${ambiguousWidth}`, async () => {
      await using tmp = await shellState({ ambiguous_width: ambiguousWidth })
      setLanguage(language)
      const app = await render(() => <SubagentFooterFromKeymap kind="general-purpose" trust={2} />, {
        width: 80,
        state: tmp.path,
      })

      try {
        const frame = app.captureCharFrame()
        expectWithin(frame, 80, ambiguousWidth)
        // The notice is whole at the left edge; what gives way is the right-hand hints and the trust reminder.
        expect(row(frame)).toStartWith(
          language === "en"
            ? "  general-purpose · read-only · press esc to return to the main session"
            : "  general-purpose · 只读 · 子 agent 只接受主 agent 的通信",
        )
      } finally {
        app.renderer.destroy()
      }
    })
  }
}

test("a notice that does not fit is cut from its end, the kind last", async () => {
  await using tmp = await shellState()
  const app = await render(() => <SubagentFooterFromKeymap />, { width: 40, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    expect(row(frame)).toStartWith("  explore · 只读 · 子 agent 只接受主 …")
    expectWithin(frame, 40, 1)
  } finally {
    app.renderer.destroy()
  }
})

test("the drawer hint follows the keymap, and a missing binding leaves it out", async () => {
  await using tmp = await shellState()
  const rebound = await render(() => <SubagentFooterFromKeymap />, {
    width: 120,
    state: tmp.path,
    overrides: { session_drawer_toggle: "f9" },
  })
  try {
    expect(row(rebound.captureCharFrame())).toEndWith("←→ 切换子 agent")
  } finally {
    rebound.renderer.destroy()
  }

  const unbound = await render(() => <SubagentFooterFromKeymap />, {
    width: 120,
    state: tmp.path,
    overrides: { session_drawer_toggle: "none" },
  })
  try {
    const frame = unbound.captureCharFrame()
    expect(row(frame)).toEndWith("←→ 切换子 agent")
    expect(frame).not.toContain("侧边栏")
  } finally {
    unbound.renderer.destroy()
  }
})

test("the shared right slot replaces the hints and the notice stays", async () => {
  await using tmp = await shellState()
  const app = await render(() => <SubagentFooterFromKeymap right={<text>status: indexing</text>} />, {
    width: 120,
    state: tmp.path,
  })

  try {
    const frame = app.captureCharFrame()
    expect(row(frame)).toStartWith("  explore · 只读 · 子 agent 只接受主 agent 的通信")
    expect(row(frame)).toEndWith("status: indexing")
    expect(frame).not.toContain("esc 返回")
  } finally {
    app.renderer.destroy()
  }
})

test("paints the notice with the text and muted colors, and no brand color", async () => {
  await using tmp = await shellState()
  const app = await render(() => <SubagentFooterFromKeymap />, { width: 120, state: tmp.path })

  try {
    const palette = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")
    const spans = app.captureSpans().lines[0].spans
    const colorOf = (needle: string) => spans.find((span) => span.text.includes(needle))?.fg
    expect(colorOf("explore")?.equals(palette.text)).toBe(true)
    expect(colorOf("只读")?.equals(palette.textMuted)).toBe(true)
    expect(spans.some((span) => span.text.trim() !== "" && span.fg.equals(palette.primary))).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("holds back the notice's width from the toast that shares the row", () => {
  // The notice is 86 cells wide in Chinese and 61 in English (the kind and the tag included), plus the gap; 26 columns
  // are held back already.
  expect(subagentNoticeReserve("explore", 1)).toBe(86 + 1 - 26)
  setLanguage("en")
  expect(subagentNoticeReserve("explore", 1)).toBe(36)
  // At ambiguous_width 2 the two `·` take a cell more each.
  expect(subagentNoticeReserve("explore", 2)).toBe(38)
})
