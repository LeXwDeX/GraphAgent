// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { createSignal, onCleanup, Show } from "solid-js"
import type { Agent, Provider, SessionDagMode } from "@graphagent/sdk"
import { useCommands } from "../../src/commands/context"
import { useTuiConfig } from "../../src/config"
import type { TuiKeybind } from "../../src/config/keybind"
import { useSDK } from "../../src/context/sdk"
import { getLanguage, setLanguage } from "../../src/i18n"
import { useBindings } from "../../src/keymap"
import { ConfigPanel } from "../../src/panel/config"
import { usePanelHost, type PanelHostApi } from "../../src/panel/host"
import { ModelPanel } from "../../src/panel/model"
import { cellWidth } from "../../src/ui/width"
import { PanelSurface, renderAppPanel, type AppPanelTestContext } from "./contexts"
import { readFrame, renderUntilFrame } from "../fixture/frames"
import { waitFor } from "../fixture/held-io"
import { PROMPT_MARK, runApp, waitForFrame, type Setup } from "../fixture/run-app"
import { json } from "../fixture/tui-sdk"
import { dagModeStatus, sessionFixture } from "../routes/dag-mode-harness"
import { shellState } from "../shell/contexts"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

function ConfigHarness(props: {
  tab: string
  stub?: (sdk: AppPanelTestContext["sdk"]) => void
  /** Holds the panel back until the route it opens in is in place. */
  open?: () => boolean
}) {
  const sdk = useSDK()
  const commands = useCommands()
  const host = usePanelHost()
  // Runs before ConfigPanel builds its rows, so the panel sees the stubbed
  // write endpoint on its first render (writability is not reactive).
  props.stub?.(sdk)
  // The app opens the model list when `model.list` runs; this is the same, on the stack the panel sits in.
  onCleanup(
    commands.setHandler("model.list", () => {
      host.push({ id: "model", render: () => <ModelPanel onConnectProvider={() => {}} onVariant={() => {}} /> })
    }),
  )
  const [tab, setTab] = createSignal(props.tab)
  return (
    <Show when={props.open?.() ?? true}>
      <ConfigPanel activeTab={tab()} onTab={setTab} />
    </Show>
  )
}

/**
 * A few keymap commands with the bindings the resolved configuration gives them, for the shortcuts tab to list; and
 * three the tab must leave out: hidden, one of the panels' own, and one with no binding.
 */
function ShortcutFixtures() {
  const config = useTuiConfig()
  useBindings(() => ({
    commands: [
      { name: "session.new", title: "New session", category: "Session", run: () => {} },
      { name: "session.list", title: "Switch to another session of this project", category: "Session", run: () => {} },
      {
        name: "session.dagmode.toggle",
        title: "Toggle DAG mode",
        desc: "Turns DAG mode on or off for this session",
        category: "DAG",
        run: () => {},
      },
      { name: "model.list", title: "Switch model", category: "Agent", run: () => {} },
      { name: "test.hidden", title: "Hidden command", category: "Session", hidden: true, run: () => {} },
      { name: "test.panel", title: "Panel command", category: "Panel", run: () => {} },
      { name: "test.unbound", title: "Unbound command", category: "Session", run: () => {} },
    ],
    bindings: [
      ...config.keybinds.gather("test.config", ["session.new", "session.list", "session.dagmode.toggle", "model.list"]),
      { key: "f9", cmd: "test.hidden" },
      { key: "f10", cmd: "test.panel" },
    ],
  }))
  return null
}

type RenderOptions = {
  tab?: string
  /** Open the panel inside this session instead of on the home view. */
  inSession?: string
  /** Leave the real SDK update in place and answer the HTTP request via `handler`. */
  realWrite?: boolean
  /** Simulate a server without the global config write endpoint. */
  disableWrite?: boolean
  handler?: (url: URL, request?: Request) => Response | undefined | Promise<Response | undefined>
  setup?: (context: AppPanelTestContext) => void | Promise<void>
  width?: number
  height?: number
  /** The interface language, applied once the app has settled. */
  language?: "zh-CN" | "en"
  /** The persisted kv state the panel starts from. */
  kv?: Record<string, unknown>
  keybinds?: TuiKeybind.KeybindOverrides
  /** Registers the keymap commands the shortcuts tab lists. */
  shortcuts?: boolean
}

async function renderConfig(options: RenderOptions = {}) {
  const tmp = await shellState(options.kv)
  const updates: Record<string, unknown>[] = []
  const seen: string[] = []
  /** Every request that is not a read: `METHOD /path`. The stubbed global configuration write is not one of them. */
  const writes: string[] = []
  let panelHost: PanelHostApi | undefined
  const [open, setOpen] = createSignal(options.inSession === undefined)
  const stub = (sdk: AppPanelTestContext["sdk"]) => {
    if (options.disableWrite) {
      sdk.client.global.config.update = undefined as never
      return
    }
    if (options.realWrite) return
    sdk.client.global.config.update = (async (parameters?: { config?: unknown }) => {
      updates.push((parameters?.config ?? {}) as Record<string, unknown>)
      return { data: {}, error: undefined }
    }) as never
  }
  const app = await renderAppPanel(
    () => (
      <>
        <Show when={options.shortcuts}>
          <ShortcutFixtures />
        </Show>
        <PanelSurface
          spec={{
            id: "config",
            render: () => <ConfigHarness tab={options.tab ?? "interface"} stub={stub} open={open} />,
          }}
          onHost={(value) => (panelHost = value)}
        />
      </>
    ),
    {
      width: options.width ?? 120,
      height: options.height ?? 40,
      state: tmp.path,
      keybinds: options.keybinds,
      handler: (url, request) => {
        seen.push(url.pathname)
        if (request && request.method !== "GET") writes.push(`${request.method} ${url.pathname}`)
        return options.handler?.(url, request)
      },
      setup: async (context) => {
        if (options.language) setLanguage(options.language)
        await options.setup?.(context)
        if (options.inSession === undefined) return
        context.route.navigate({ type: "session", sessionID: options.inSession })
        setOpen(true)
      },
    },
  )
  return { app, tmp, updates, seen, writes, host: () => panelHost! }
}

async function settle(app: Awaited<ReturnType<typeof renderAppPanel>>) {
  await Bun.sleep(30)
  await app.renderOnce()
}

async function down(app: Awaited<ReturnType<typeof renderAppPanel>>, times = 1) {
  for (let index = 0; index < times; index++) app.mockInput.pressArrow("down")
  await settle(app)
}

async function up(app: Awaited<ReturnType<typeof renderAppPanel>>, times = 1) {
  for (let index = 0; index < times; index++) app.mockInput.pressArrow("up")
  await settle(app)
}

async function right(app: Awaited<ReturnType<typeof renderAppPanel>>, times = 1) {
  for (let index = 0; index < times; index++) app.mockInput.pressArrow("right")
  await settle(app)
}

async function left(app: Awaited<ReturnType<typeof renderAppPanel>>, times = 1) {
  for (let index = 0; index < times; index++) app.mockInput.pressArrow("left")
  await settle(app)
}

async function enter(app: Awaited<ReturnType<typeof renderAppPanel>>) {
  app.mockInput.pressEnter()
  await settle(app)
}

async function type(app: Awaited<ReturnType<typeof renderAppPanel>>, text: string) {
  for (const key of text) app.mockInput.pressKey(key)
  await settle(app)
}

async function backspace(app: Awaited<ReturnType<typeof renderAppPanel>>, times = 1) {
  for (let index = 0; index < times; index++) app.mockInput.pressBackspace()
  await settle(app)
}

type Rendered = Awaited<ReturnType<typeof renderAppPanel>>

/** The line of a frame a row is drawn on. */
const lineOf = (frame: string, label: string) => frame.split("\n").find((line) => line.includes(label)) ?? ""

/** The row as it is drawn now: one render, then a read that does not race the renderer. */
async function rowNow(app: Rendered, label: string) {
  await app.renderOnce()
  return lineOf(await readFrame(app), label)
}

/** Render until the row's line satisfies the check and return that line; a wait that runs out reports the last frame. */
async function untilRow(app: Rendered, label: string, check: (line: string) => boolean) {
  const frame = await renderUntilFrame(app, (text) => check(lineOf(text, label)), `the "${label}" row`)
  return lineOf(frame, label)
}

/** The line the selection mark is on. */
const selectedLineOf = (frame: string) => frame.split("\n").find((line) => line.includes("›")) ?? ""

/** The hint row: the line above the bottom border. */
function hintsOf(frame: string) {
  const lines = frame.split("\n").map((line) => line.trimEnd())
  return lines[lines.findIndex((line) => line.includes("╰")) - 1] ?? ""
}

test("every general and interface toggle writes its documented kv key", async () => {
  let kv!: AppPanelTestContext["kv"]
  const { app, tmp } = await renderConfig({ tab: "general", setup: (context) => ((kv = context.kv), undefined) })
  try {
    // General: the language and the auto-compact rows write the global configuration, the four after them are kv.
    await down(app, 2)
    await enter(app)
    expect(kv.get("file_context_enabled", true)).toBe(false)

    await down(app)
    await enter(app)
    expect(kv.get("paste_summary_enabled", true)).toBe(false)

    await down(app)
    await enter(app)
    expect(kv.get("session_directory_filter_enabled", true)).toBe(false)

    await down(app)
    await enter(app)
    expect(kv.get("terminal_title_enabled", true)).toBe(false)

    // Interface: the five rows that moved to the general tab are no longer here.
    await right(app)
    expect(app.captureCharFrame()).not.toContain("文件上下文")
    await down(app, 2)
    await enter(app)
    expect(kv.get("animations_enabled", true)).toBe(false)

    await down(app, 2)
    await enter(app)
    expect(kv.get("timestamps", "hide")).toBe("show")

    await down(app)
    await enter(app)
    expect(kv.get("tool_details_visibility", true)).toBe(false)

    await down(app)
    await enter(app)
    expect(kv.get("generic_tool_output_visibility", false)).toBe(true)

    await down(app)
    await enter(app)
    expect(kv.get("scrollbar_visible", false)).toBe(true)

    await down(app)
    await enter(app)
    expect(kv.get("diff_wrap_mode", "word")).toBe("none")

    await down(app, 2)
    await enter(app)
    expect(kv.get("conceal_code", true)).toBe(false)
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("drawer, DAG band and ambiguous width rows write their stores, and the language row the global layer", async () => {
  let kv!: AppPanelTestContext["kv"]
  const { app, tmp, updates } = await renderConfig({ setup: (context) => ((kv = context.kv), undefined) })
  try {
    await down(app, 9)
    await enter(app)
    expect(kv.get("drawer_mode", "hidden")).toBe("auto")

    // The DAG band row sits after the code-block row; its three values cycle in the order the row lists them.
    await down(app, 2)
    expect(app.captureCharFrame()).toContain("DAG 状态带")
    expect(kv.get("dag_band", "auto")).toBe("auto")
    await enter(app)
    expect(kv.get("dag_band", "auto")).toBe("always")
    await enter(app)
    expect(kv.get("dag_band", "auto")).toBe("hidden")
    await enter(app)
    expect(kv.get("dag_band", "auto")).toBe("auto")

    await down(app)
    await enter(app)
    expect(kv.get("ambiguous_width", 1)).toBe(2)

    // The language row is the first of the general tab, left of this one.
    await left(app)
    await enter(app)
    await settle(app)
    expect(updates).toEqual([{ language: "en" }])
    expect(getLanguage()).toBe("en")
    expect(app.captureCharFrame()).toContain("Settings")
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("an unset language shows the inferred value as automatic", async () => {
  const { app, tmp, updates } = await renderConfig({ tab: "general" })
  try {
    expect(app.captureCharFrame()).toContain("自动")
    await enter(app)
    await settle(app)
    expect(updates).toEqual([{ language: "en" }])
    expect(app.captureCharFrame()).toContain("Interface")
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("DAG rows write the global layer and validate concurrency and budget", async () => {
  const { app, tmp, updates } = await renderConfig({ tab: "dag" })
  try {
    expect(app.captureCharFrame()).toContain("未设预算")

    await enter(app)
    await settle(app)
    expect(updates).toEqual([{ dag: { mode: "on" } }])
    expect(app.captureCharFrame()).toContain("开")

    // Nothing is configured and no snapshot is held, so the row starts empty: no default is made up for it.
    await down(app)
    await enter(app)
    await type(app, "3")
    await enter(app)
    expect(updates.at(-1)).toEqual({ dag: { concurrency: 3 } })

    await down(app)
    await enter(app)
    await type(app, "5000")
    await enter(app)
    expect(updates.at(-1)).toEqual({ dag: { budget: { tokens: 5000 } } })

    await enter(app)
    await backspace(app, 4)
    await enter(app)
    expect(updates.at(-1)).toEqual({ dag: { budget: { tokens: null } } })
    expect(app.captureCharFrame()).toContain("未设预算")

    await up(app, 2)
    await down(app)
    await enter(app)
    await backspace(app)
    await type(app, "0")
    await enter(app)
    expect(app.captureCharFrame()).toContain("必须是 1–64 的整数")
    expect(updates.at(-1)).toEqual({ dag: { budget: { tokens: null } } })

    app.mockInput.pressEscape()
    await settle(app)
    await enter(app)
    await backspace(app)
    await type(app, "65")
    await enter(app)
    expect(app.captureCharFrame()).toContain("必须是 1–64 的整数")
    expect(updates.at(-1)).toEqual({ dag: { budget: { tokens: null } } })
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("permission rows cycle actions and keep custom rules visible", async () => {
  const { app, tmp, updates } = await renderConfig({
    tab: "permissions",
    handler: (url) => (url.pathname === "/config" ? json({ permission: { bash: { "src/**": "allow" } } }) : undefined),
  })
  try {
    await enter(app)
    expect(updates).toEqual([{ permission: { edit: "allow" } }])

    await down(app)
    expect(app.captureCharFrame()).toContain("自定义规则")
    await enter(app)
    expect(updates.at(-1)).toEqual({ permission: { bash: "ask" } })
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("configuration rows are read-only without the global write endpoint", async () => {
  const { app, tmp, updates } = await renderConfig({ tab: "dag", disableWrite: true })
  try {
    await enter(app)
    await down(app)
    await enter(app)
    expect(app.captureCharFrame()).not.toContain("输入…")
    expect(updates).toEqual([])

    // The title model is a configuration row of the model tab, and the same.
    await left(app)
    await down(app, 2)
    await enter(app)
    expect(app.captureCharFrame()).not.toContain("输入…")
    expect(updates).toEqual([])

    // The language and the auto-compact rows of the general tab are the others.
    await left(app, 2)
    await enter(app)
    expect(getLanguage()).toBe("zh-CN")
    await down(app)
    // The row is dimmed and offers no change: no hint to change it, and none on the hint row.
    const frame = await renderUntilFrame(
      app,
      (text) => selectedLineOf(text).includes("自动压缩"),
      "the auto-compact row",
    )
    expect(selectedLineOf(frame)).not.toContain("换一个")
    expect(hintsOf(frame)).not.toContain("修改")
    await enter(app)
    expect(lineOf(await readFrame(app), "自动压缩")).toContain("开")
    expect(updates).toEqual([])
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("changing the new-session default leaves the current session unchanged", async () => {
  const session = {
    id: "ses_test",
    slug: "test",
    projectID: "proj_test",
    directory: "/tmp/graphagent",
    title: "Test",
    version: "0.0.0",
    time: { created: 1, updated: 1 },
    dagMode: "off" as const,
  }
  let sync!: AppPanelTestContext["sync"]
  const { app, tmp, updates } = await renderConfig({
    tab: "dag",
    handler: (url) => (url.pathname === "/session" ? json([session]) : undefined),
    setup: async (context) => {
      sync = context.sync
      context.route.navigate({ type: "session", sessionID: "ses_test" })
    },
  })
  try {
    await settle(app)
    expect(app.captureCharFrame()).toContain("本会话：关")
    await enter(app)
    await settle(app)
    expect(updates).toEqual([{ dag: { mode: "on" } }])
    expect(sync.session.get("ses_test")?.dagMode).toBe("off")
    expect(app.captureCharFrame()).toContain("本会话：关")
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("DAG writes use the hot-reload path without disposing instances", async () => {
  const { app, tmp, seen } = await renderConfig({
    tab: "dag",
    realWrite: true,
    handler: (url) => (url.pathname === "/global/config" ? json({}) : undefined),
  })
  try {
    await enter(app)
    for (let attempt = 0; attempt < 60; attempt++) {
      await Bun.sleep(20)
      await app.renderOnce()
      if (seen.includes("/global/config")) break
    }
    expect(seen).toContain("/global/config")
    expect(seen).not.toContain("/global/dispose")
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

// #1290: the concurrency row shows the limit the server enforces, read from the DAG mode snapshot of the session's tree;
// it keeps no default of its own. A configured value the server cuts down shows next to the value in force.
const dagSession = {
  id: "ses_limits",
  slug: "limits",
  projectID: "proj_test",
  directory: "/tmp/graphagent",
  title: "Limits",
  version: "0.0.0",
  time: { created: 1, updated: 1 },
  dagMode: "off" as const,
}

/** A session of the same tree: the snapshot belongs to the root, not to the session the panel is opened in. */
const dagChild = {
  ...dagSession,
  id: "ses_limits_child",
  slug: "limits-child",
  title: "Limits child",
  parentID: dagSession.id,
}

const limits = (concurrency: number, configuredConcurrency: number | null): SessionDagMode =>
  dagModeStatus({
    mode: "off",
    limits: { concurrency, configuredConcurrency, maxTotalNodes: 100, configuredMaxTotalNodes: null, running: 0 },
  })

async function renderLimits(input: {
  /** `dag.concurrency` in the configuration the TUI loaded. */
  configured?: number
  /** What the DAG mode read of the tree's root answers; absent answers nothing. */
  status?: SessionDagMode
  /** Open the panel in the child session instead of in the root. */
  child?: boolean
  width?: number
  setup?: RenderOptions["setup"]
}) {
  let held: AppPanelTestContext["sync"] | undefined
  const rendered = await renderConfig({
    tab: "dag",
    inSession: input.child ? dagChild.id : dagSession.id,
    width: input.width,
    setup: async (context) => {
      held = context.sync
      await input.setup?.(context)
    },
    handler: (url) => {
      if (url.pathname === "/session") return json([dagSession, dagChild])
      if (url.pathname === "/config" && input.configured !== undefined) {
        return json({ dag: { concurrency: input.configured } })
      }
      if (url.pathname === `/session/${dagSession.id}/dag-mode` && input.status) return json(input.status)
      return undefined
    },
  })
  /** The snapshot the sync layer holds for the tree: in the store once the panel's read has been answered. */
  const snapshot = () => held?.data.dagMode[dagSession.id]
  return { ...rendered, snapshot }
}

test("an unset concurrency shows the value the server enforces, marked as the default", async () => {
  const { app, tmp, seen } = await renderLimits({ status: limits(12, null) })
  try {
    // The value comes first and the note after it.
    const line = await untilRow(app, "DAG 并发上限", (text) => /12\s+默认值/.test(text))
    expect(line).toMatch(/12\s+默认值/)
    // The panel asked for the snapshot itself: a session with DAG mode off reads none otherwise, and it asked once.
    expect(seen.filter((path) => path === `/session/${dagSession.id}/dag-mode`)).toHaveLength(1)

    setLanguage("en")
    expect(await untilRow(app, "DAG concurrency cap", (text) => /12\s+Default/.test(text))).toMatch(/12\s+Default/)
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("a configured concurrency the server cuts down shows the configured value and the one in force", async () => {
  const { app, tmp } = await renderLimits({ configured: 20, status: limits(14, 20) })
  try {
    const line = await untilRow(app, "DAG 并发上限", (text) => /20\s+实际生效 14/.test(text))
    expect(line).not.toContain("默认值")

    setLanguage("en")
    await untilRow(app, "DAG concurrency cap", (text) => /20\s+In force 14/.test(text))
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("a configured concurrency inside the limit shows no note", async () => {
  const { app, tmp, snapshot } = await renderLimits({ configured: 8, status: limits(8, 8) })
  try {
    // Nothing on the row says the snapshot has arrived, so wait for the store the row is drawn from, then draw it.
    await waitFor(() => snapshot() !== undefined, "the DAG mode snapshot of the tree")
    const line = await rowNow(app, "DAG 并发上限")
    expect(line).toContain("8")
    expect(line).not.toContain("实际生效")
    expect(line).not.toContain("默认值")
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("opened in a child session, the row takes the limits of the tree's root", async () => {
  const { app, tmp, seen } = await renderLimits({ child: true, configured: 20, status: limits(14, 20) })
  try {
    const line = await untilRow(app, "DAG 并发上限", (text) => /20\s+实际生效 14/.test(text))
    expect(line).not.toContain("默认值")
    // The read went to the root of the tree; the child has no snapshot of its own.
    expect(seen).toContain(`/session/${dagSession.id}/dag-mode`)
    expect(seen).not.toContain(`/session/${dagChild.id}/dag-mode`)
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("a snapshot read before a write does not describe the value just written", async () => {
  const { app, tmp, updates } = await renderLimits({ status: limits(12, null) })
  try {
    await untilRow(app, "DAG 并发上限", (text) => /12\s+默认值/.test(text))
    await down(app)
    await enter(app)
    await backspace(app, 2)
    await type(app, "20")
    await enter(app)
    expect(updates.at(-1)).toEqual({ dag: { concurrency: 20 } })
    // The read-back has not landed: the row shows what was written and makes no claim about what is in force.
    const line = await rowNow(app, "DAG 并发上限")
    expect(line).toContain("20")
    expect(line).not.toContain("默认值")
    expect(line).not.toContain("实际生效")
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("outside a session the row shows what is configured and reads no snapshot", async () => {
  const { app, tmp, seen } = await renderConfig({
    tab: "dag",
    handler: (url) => (url.pathname === "/config" ? json({ dag: { concurrency: 20 } }) : undefined),
  })
  try {
    const line = await untilRow(app, "DAG 并发上限", (text) => text.includes("20"))
    expect(line).not.toContain("默认值")
    expect(seen.filter((path) => path.endsWith("/dag-mode"))).toEqual([])
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("the unset row without a snapshot says it is not set instead of making a value up", async () => {
  const { app, tmp } = await renderConfig({ tab: "dag" })
  try {
    const line = await untilRow(app, "DAG 并发上限", (text) => text.includes("未设置"))
    expect(line).not.toMatch(/\d/)
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

for (const [language, label, note] of [
  ["zh-CN", "DAG 并发上限", /20\s+实际生效 14/],
  ["en", "DAG concurrency cap", /20\s+In force 14/],
] as const) {
  for (const width of [1, 2] as const) {
    test(`the cut-down note fits 80 columns in ${language} with ambiguous width ${width}`, async () => {
      const { app, tmp } = await renderLimits({
        configured: 20,
        status: limits(14, 20),
        width: 80,
        setup: (context) => {
          context.kv.set("ambiguous_width", width)
          setLanguage(language)
        },
      })
      try {
        setLanguage(language)
        const line = await untilRow(app, label, (text) => note.test(text))
        // The panel border closes the line: nothing was pushed past it.
        expect(line.trimEnd().endsWith("│")).toBe(true)
      } finally {
        app.renderer.destroy()
        await tmp[Symbol.asyncDispose]()
      }
    })
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// #1617: the general, model and shortcuts tabs, and the rows the tabs hold.

/** The tab strip of each language, the active tab in brackets or not. */
const TAB_STRIP = {
  "zh-CN": /\[?通用\]?\s+\[?界面\]?\s+\[?模型\]?\s+\[?DAG 模式\]?\s+\[?权限\]?\s+\[?快捷键\]?/,
  en: /\[?General\]?\s+\[?Interface\]?\s+\[?Model\]?\s+\[?DAG mode\]?\s+\[?Permissions\]?\s+\[?Shortcuts\]?/,
} as const

/** The name of the active tab: the bracketed one on the tab line, which is the first line of the panel. */
async function activeTab(app: Rendered, language: "zh-CN" | "en" = "zh-CN") {
  const line = lineOf(await readFrame(app), language === "en" ? "Settings" : "设置  ")
  return /\[([^\]]+)\]/.exec(line)?.[1]
}

for (const language of ["zh-CN", "en"] as const) {
  test(`the settings panel has six tabs in this order, and left and right walk them, ${language}`, async () => {
    const { app, tmp } = await renderConfig({ tab: "general", language })
    try {
      const names =
        language === "en"
          ? ["General", "Interface", "Model", "DAG mode", "Permissions", "Shortcuts"]
          : ["通用", "界面", "模型", "DAG 模式", "权限", "快捷键"]
      const frame = await renderUntilFrame(app, (text) => text.includes(`[${names[0]}]`), "the tab strip")
      expect(lineOf(frame, `[${names[0]}]`)).toMatch(TAB_STRIP[language])
      const seen: (string | undefined)[] = [await activeTab(app, language)]
      for (let step = 0; step < names.length; step++) {
        await right(app)
        seen.push(await activeTab(app, language))
      }
      // One step right of the last tab is the first again.
      expect(seen).toEqual([...names, names[0]])
    } finally {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    }
  })
}

const agents: Agent[] = [{ name: "build", mode: "primary", hidden: false, options: {}, permission: [] }]

const modelFields = {
  providerID: "test",
  api: { id: "m", url: "http://test", npm: "test" },
  status: "active" as const,
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
}
/** A model with two reasoning variants, and one with none. */
const withVariants = { ...modelFields, id: "m", name: "Test model", variants: { high: {}, xhigh: {} } }
const withoutVariants = { ...modelFields, id: "plain", name: "Plain model" }

function providerOf(...models: (typeof withVariants | typeof withoutVariants)[]): Provider {
  return {
    id: "test",
    name: "Test Provider",
    source: "config",
    env: [],
    options: {},
    models: Object.fromEntries(models.map((model) => [model.id, model])),
  }
}

/** Connects one provider with these models, the first of which is the one the TUI starts on. */
function connect(...models: (typeof withVariants | typeof withoutVariants)[]) {
  return (context: AppPanelTestContext) => {
    context.sync.set("agent", agents)
    context.sync.set("provider", [providerOf(...models)])
  }
}

/** Waits until the TUI has a current model, then hands it back. */
async function currentModel(context: AppPanelTestContext) {
  await waitFor(() => context.local.model.current() !== undefined, "the current model")
  return context.local.model.current()!
}

// --- general: auto-compact -------------------------------------------------------------------------------------------

test("auto-compact is on while unset, writes compaction.auto once per change and reads the value back", async () => {
  const { app, tmp, updates } = await renderConfig({ tab: "general" })
  try {
    // The server has it on when nothing says otherwise.
    await down(app)
    const line = await untilRow(app, "自动压缩", (text) => text.includes("开"))
    expect(line).toContain("换一个（1/2）")

    await enter(app)
    expect(updates).toEqual([{ compaction: { auto: false } }])
    expect(await untilRow(app, "自动压缩", (text) => text.includes("关"))).toContain("换一个（2/2）")

    await enter(app)
    expect(updates).toEqual([{ compaction: { auto: false } }, { compaction: { auto: true } }])
    await untilRow(app, "自动压缩", (text) => text.includes("开"))
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("auto-compact shows the value the configuration file holds", async () => {
  const { app, tmp, updates } = await renderConfig({
    tab: "general",
    handler: (url) => (url.pathname === "/config" ? json({ compaction: { auto: false } }) : undefined),
  })
  try {
    expect(await untilRow(app, "自动压缩", (text) => text.includes("关"))).not.toContain("上下文到")
    expect(updates).toEqual([])
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

for (const [language, label, set, unset] of [
  ["zh-CN", "自动压缩", /开\s+上下文到 85% 时/, "上下文到"],
  ["en", "Auto-compact", /On\s+at 85% of the context/, "at 85%"],
] as const) {
  test(`auto-compact notes the trigger ratio only when it is set, ${language}`, async () => {
    const withRatio = await renderConfig({
      tab: "general",
      language,
      handler: (url) => (url.pathname === "/config" ? json({ compaction: { trigger_ratio: 0.85 } }) : undefined),
    })
    try {
      expect(await untilRow(withRatio.app, label, (line) => set.test(line))).toMatch(set)
    } finally {
      withRatio.app.renderer.destroy()
      await withRatio.tmp[Symbol.asyncDispose]()
    }

    const without = await renderConfig({ tab: "general", language })
    try {
      const line = await untilRow(without.app, label, () => true)
      expect(line).not.toContain(unset)
    } finally {
      without.app.renderer.destroy()
      await without.tmp[Symbol.asyncDispose]()
    }
  })
}

test("the trigger ratio is shown as a rounded percentage, and a value that is not a finite number is not shown", async () => {
  for (const [ratio, expected] of [
    [0.333, "上下文到 33% 时"],
    [1, "上下文到 100% 时"],
    ["Infinity", undefined],
  ] as const) {
    const { app, tmp } = await renderConfig({
      tab: "general",
      handler: (url) => (url.pathname === "/config" ? json({ compaction: { trigger_ratio: ratio } }) : undefined),
    })
    try {
      if (expected) await untilRow(app, "自动压缩", (line) => line.includes(expected))
      else expect(await untilRow(app, "自动压缩", () => true)).not.toContain("上下文到")
    } finally {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    }
  }
})

// --- model: the current model, the reasoning effort and the title model ----------------------------------------------

for (const [language, label, hintText] of [
  ["zh-CN", "当前模型", "换一个"],
  ["en", "Model", "change"],
] as const) {
  test(`the current model row shows the model's name, and enter opens the model list and writes nothing, ${language}`, async () => {
    let context!: AppPanelTestContext
    const { app, tmp, updates, writes, host } = await renderConfig({
      tab: "model",
      language,
      setup: (value) => {
        context = value
        connect(withVariants, withoutVariants)(value)
      },
    })
    try {
      await currentModel(context)
      // The name is the one the top bar shows; it is an action, so it has no hint to change a value. The row is the
      // first of the tab, so the one selected: the label alone would also find the tab of the same name.
      const frame = await renderUntilFrame(
        app,
        (text) => selectedLineOf(text).includes("Test model"),
        "the current model row",
      )
      expect(selectedLineOf(frame)).toContain(label)
      expect(selectedLineOf(frame)).not.toContain(hintText)
      expect(host().top()?.id).toBe("config")

      await enter(app)
      await waitFor(() => host().top()?.id === "model", "the model list")
      expect(await renderUntilFrame(app, (text) => text.includes("Plain model"), "the model list")).toContain(
        "Test model",
      )
      // Choosing a model is the list's business: opening it asks the server for nothing and writes no configuration.
      expect(writes).toEqual([])
      expect(updates).toEqual([])
    } finally {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    }
  })
}

test("without a connected provider the current model row reads not set, and the reasoning row says no variant exists", async () => {
  const { app, tmp, host } = await renderConfig({ tab: "model" })
  try {
    expect(await untilRow(app, "当前模型", (line) => line.includes("未设置"))).toContain("未设置")
    await enter(app)
    // The list is still the way to connect one.
    await waitFor(() => host().top()?.id === "model", "the model list")
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("the reasoning effort row offers default and the variants of the current model, and sets the one chosen", async () => {
  let context!: AppPanelTestContext
  const { app, tmp, updates, writes } = await renderConfig({
    tab: "model",
    setup: (value) => {
      context = value
      connect(withVariants, withoutVariants)(value)
    },
  })
  try {
    await currentModel(context)
    expect(context.local.model.variant.list()).toEqual(["high", "xhigh"])
    await down(app)
    const line = await untilRow(app, "推理强度", (text) => text.includes("默认"))
    expect(line).toContain("换一个（1/3）")
    expect(context.local.model.variant.current()).toBeUndefined()

    await enter(app)
    expect(context.local.model.variant.current()).toBe("high")
    expect(await untilRow(app, "推理强度", (text) => text.includes("high"))).toContain("换一个（2/3）")

    await enter(app)
    expect(context.local.model.variant.current()).toBe("xhigh")
    expect(await untilRow(app, "推理强度", (text) => text.includes("xhigh"))).toContain("换一个（3/3）")

    // Round again to the default, which is no variant at all.
    await enter(app)
    expect(context.local.model.variant.current()).toBeUndefined()
    expect(await untilRow(app, "推理强度", (text) => text.includes("默认"))).toContain("换一个（1/3）")

    // The home view has no session to tell: the choice is the TUI's own and nothing is written anywhere else.
    expect(writes).toEqual([])
    expect(updates).toEqual([])
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

for (const [language, label, none] of [
  ["zh-CN", "推理强度", "该模型不支持"],
  ["en", "Reasoning effort", "Not supported by this model"],
] as const) {
  test(`a model without variants shows the reasoning row as not supported and does nothing on it, ${language}`, async () => {
    let context!: AppPanelTestContext
    const { app, tmp, updates, writes } = await renderConfig({
      tab: "model",
      language,
      setup: (value) => {
        context = value
        connect(withoutVariants)(value)
      },
    })
    try {
      await currentModel(context)
      await down(app)
      const frame = await renderUntilFrame(app, (text) => selectedLineOf(text).includes(label), "the reasoning row")
      const line = selectedLineOf(frame)
      expect(line).toContain(none)
      // No hint to change, and no way to: not offered on the hint row, and key and click do nothing.
      expect(line).not.toMatch(/换一个|change \(/)
      for (const verb of ["修改", "选择", "Change", "Select"]) expect(hintsOf(frame)).not.toContain(verb)
      await enter(app)
      expect(context.local.model.variant.current()).toBeUndefined()
      const lines = (await readFrame(app)).split("\n")
      const row = lines.findIndex((candidate) => candidate.includes(label))
      await app.mockMouse.click(lines[row].indexOf(label) + 1, row)
      await settle(app)
      expect(context.local.model.variant.current()).toBeUndefined()
      expect(writes).toEqual([])
      expect(updates).toEqual([])
    } finally {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    }
  })
}

const modelRoot = sessionFixture("ses_cfg_model", {
  model: { id: "m", providerID: "test", variant: "default" },
})
const modelChild = sessionFixture("ses_cfg_model_child", { parentID: modelRoot.id })

/** Every request that sets a session's model: where it went and what it carried. */
function modelRequests(requests: { path: string; body: unknown }[]) {
  return async (url: URL, request?: Request) => {
    if (url.pathname === "/session") return json([modelRoot, modelChild])
    if (/^\/session\/[^/]+\/model$/.test(url.pathname) && request) {
      const body: unknown = await request.clone().json()
      requests.push({ path: url.pathname, body })
      return json(true)
    }
    return undefined
  }
}

test("in a main session the reasoning effort row sets the session's model, once, as the variant panel does", async () => {
  let context!: AppPanelTestContext
  const requests: { path: string; body: unknown }[] = []
  const { app, tmp, writes } = await renderConfig({
    tab: "model",
    inSession: modelRoot.id,
    handler: modelRequests(requests),
    setup: (value) => {
      context = value
      connect(withVariants)(value)
    },
  })
  try {
    await currentModel(context)
    await down(app)
    await untilRow(app, "推理强度", (line) => line.includes("默认"))
    await enter(app)
    await waitFor(() => requests.length === 1, "the request that sets the session's model")
    expect(requests[0]).toMatchObject({
      path: `/session/${modelRoot.id}/model`,
      body: { model: { providerID: "test", modelID: "m" }, variant: "high" },
    })
    expect(writes).toHaveLength(1)
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("in a sub-agent view the model rows are read-only: nothing is opened and nothing is written", async () => {
  let context!: AppPanelTestContext
  const requests: { path: string; body: unknown }[] = []
  const { app, tmp, updates, writes, host } = await renderConfig({
    tab: "model",
    inSession: modelChild.id,
    handler: modelRequests(requests),
    setup: (value) => {
      context = value
      connect(withVariants)(value)
    },
  })
  try {
    await currentModel(context)
    // Both rows say so, and are dimmed like a row whose write path is missing.
    expect(await untilRow(app, "当前模型", (line) => line.includes("只读"))).toContain("Test model")
    expect(await untilRow(app, "推理强度", (line) => line.includes("只读"))).toContain("默认")
    for (const times of [0, 1]) {
      await down(app, times)
      await enter(app)
      expect(host().top()?.id).toBe("config")
      expect(context.local.model.variant.current()).toBeUndefined()
    }
    expect(requests).toEqual([])
    expect(writes).toEqual([])
    expect(updates).toEqual([])
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

for (const [language, label, auto, invalid] of [
  ["zh-CN", "标题模型", /未设置\s+自动选择/, "必须是已连接服务商的 provider/model"],
  ["en", "Title model", /Not set\s+chosen automatically/, "Must be provider/model of a connected provider"],
] as const) {
  test(`the title model row takes only the provider/model of a connected provider, ${language}`, async () => {
    const { app, tmp, updates, writes } = await renderConfig({
      tab: "model",
      language,
      setup: connect(withVariants, withoutVariants),
    })
    try {
      // Unset: the template's own "not set", and the note that the server picks one.
      expect(await untilRow(app, label, (line) => auto.test(line))).toMatch(auto)

      await down(app, 2)
      await enter(app)
      // Nothing to submit yet: an empty value cannot be written, since the configuration has no way to clear a key.
      await enter(app)
      expect(await readFrame(app)).toContain(invalid)
      expect(updates).toEqual([])

      for (const bad of ["plain", "test", "test/", "/m", "other/m", "test/missing"]) {
        await type(app, bad)
        await enter(app)
        expect(await readFrame(app)).toContain(invalid)
        expect(updates).toEqual([])
        await backspace(app, bad.length)
      }

      // A model of the connected provider, with the blanks round it cut: written once as it is.
      await app.mockInput.typeText("  test/plain ")
      await settle(app)
      await enter(app)
      expect(updates).toEqual([{ small_model: "test/plain" }])
      const line = await untilRow(app, label, (text) => text.includes("test/plain"))
      expect(line).not.toMatch(auto)
      expect(writes).toEqual([])
    } finally {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    }
  })
}

test("the title model row shows the model the file holds, and explains how to clear it", async () => {
  const { app, tmp } = await renderConfig({
    tab: "model",
    handler: (url) => (url.pathname === "/config" ? json({ small_model: "test/m" }) : undefined),
    setup: connect(withVariants),
  })
  try {
    const line = await untilRow(app, "标题模型", (text) => text.includes("test/m"))
    expect(line).not.toContain("自动选择")
    await down(app, 2)
    expect(await renderUntilFrame(app, (text) => text.includes("清除请改配置文件"), "the note of the row")).toContain(
      "清除请改配置文件",
    )
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

// --- shortcuts: generated from the keymap, read-only ------------------------------------------------------------------

/** The text of a frame between the tab line and the hint row, as one line per row. */
function bodyOf(frame: string) {
  const lines = frame.split("\n").map((line) => line.trimEnd())
  return lines.slice(
    lines.findIndex((line) => line.includes("╭")) + 2,
    lines.findIndex((line) => line.includes("╰")) - 1,
  )
}

test("the shortcuts tab lists the keymap by category and then title, with the keys the keymap shows now", async () => {
  const { app, tmp } = await renderConfig({ tab: "shortcuts", shortcuts: true })
  try {
    const frame = await renderUntilFrame(app, (text) => text.includes("Switch model"), "the shortcut rows")
    // The border and its padding, the two-cell selection mark, then the name column of 22 cells.
    const names = bodyOf(frame).map((line) => line.slice(4, 4 + 22).trim())
    // The categories are Agent, DAG and Session: no row of its own for them, the rows follow in that order.
    expect(names.slice(0, 4)).toEqual(["Switch model", "Toggle DAG mode", "New session", "Switch to another se…"])
    expect(lineOf(frame, "Switch model")).toContain("ctrl+x m")
    expect(lineOf(frame, "Toggle DAG mode")).toContain("ctrl+x d")
    expect(lineOf(frame, "New session")).toContain("ctrl+x n")
    // A title too long for the name column is cut inside it, and the keys still start in the value column.
    expect(lineOf(frame, "Switch to another se…")).toContain("ctrl+x l")
    for (const left of ["Hidden command", "Panel command", "Unbound command"]) expect(frame).not.toContain(left)
    for (const heading of ["Agent", "DAG", "Session"]) expect(frame).not.toMatch(new RegExp(`│\\s+${heading}\\s+│`))
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("the shortcuts tab takes the description of the command as the note, and keeps the line for the rows without one", async () => {
  const { app, tmp } = await renderConfig({ tab: "shortcuts", shortcuts: true })
  try {
    // Switch model has none: the line stays, blank, so the panel does not change height with the selection.
    const first = await renderUntilFrame(app, (text) => text.includes("Switch model"), "the shortcut rows")
    expect(first).not.toContain("Turns DAG mode on or off")
    const height = first.split("\n").findIndex((line) => line.includes("╰"))
    await down(app)
    const second = await renderUntilFrame(app, (text) => text.includes("Turns DAG mode on or off"), "the note")
    expect(second.split("\n").findIndex((line) => line.includes("╰"))).toBe(height)
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("a key rebound in the configuration changes the shortcuts tab", async () => {
  const { app, tmp } = await renderConfig({
    tab: "shortcuts",
    shortcuts: true,
    keybinds: { session_dagmode_toggle: "f8" },
  })
  try {
    const frame = await renderUntilFrame(app, (text) => text.includes("Toggle DAG mode"), "the shortcut rows")
    expect(lineOf(frame, "Toggle DAG mode")).toContain("f8")
    expect(frame).not.toContain("ctrl+x d")
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("every shortcut row is read-only: enter and click write nothing, and no row offers a change", async () => {
  const { app, tmp, updates, writes, host } = await renderConfig({ tab: "shortcuts", shortcuts: true })
  try {
    await renderUntilFrame(app, (text) => text.includes("Switch model"), "the shortcut rows")
    for (let step = 0; step < 4; step++) {
      const frame = await renderUntilFrame(app, (text) => selectedLineOf(text) !== "", "the selection")
      // No hint to change the value, and the hint row offers neither a change nor a selection.
      expect(selectedLineOf(frame)).not.toContain("换一个")
      for (const verb of ["修改", "选择", "编辑", "提交"]) expect(hintsOf(frame)).not.toContain(verb)

      await enter(app)
      const lines = (await readFrame(app)).split("\n")
      const row = lines.findIndex((line) => line.includes("›"))
      await app.mockMouse.click(lines[row].indexOf("›") + 4, row)
      await settle(app)
      expect(host().top()?.id).toBe("config")
      expect(updates).toEqual([])
      expect(writes).toEqual([])
      await down(app)
    }
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

// --- every row names its store -----------------------------------------------------------------------------------------

/** Where a row keeps its value, and what that makes of activating it. */
type Store =
  /** A TUI preference in kv; activating the row changes the key from its default. */
  | { kv: string; initial: unknown }
  /** A key of the global configuration, written with `global.config.update`; `typed` is what a text row is given. */
  | { config: string; typed?: string }
  /** The per-agent model state of the TUI, in model.json. */
  | { local: "variant" }
  /** Opens another panel and stores nothing itself. */
  | { opens: string }

/** Every row of every tab that has a fixed list of them, in order: the label of the row and its store. */
const STORES: Record<string, readonly (readonly [label: string, store: Store])[]> = {
  general: [
    ["语言 / Language", { config: "language" }],
    ["自动压缩", { config: "compaction.auto" }],
    ["文件上下文", { kv: "file_context_enabled", initial: true }],
    ["粘贴摘要", { kv: "paste_summary_enabled", initial: true }],
    ["按目录过滤会话", { kv: "session_directory_filter_enabled", initial: true }],
    ["终端标题", { kv: "terminal_title_enabled", initial: true }],
  ],
  interface: [
    ["主题", { opens: "theme" }],
    ["主题模式", { kv: "theme_mode_lock", initial: undefined }],
    ["动画", { kv: "animations_enabled", initial: true }],
    ["推理过程", { kv: "thinking_mode", initial: "hide" }],
    ["时间戳", { kv: "timestamps", initial: "hide" }],
    ["工具详情", { kv: "tool_details_visibility", initial: true }],
    ["通用工具输出", { kv: "generic_tool_output_visibility", initial: false }],
    ["滚动条", { kv: "scrollbar_visible", initial: false }],
    ["差异换行", { kv: "diff_wrap_mode", initial: "word" }],
    ["抽屉", { kv: "drawer_mode", initial: "hidden" }],
    ["代码块隐藏", { kv: "conceal_code", initial: true }],
    ["DAG 状态带", { kv: "dag_band", initial: "auto" }],
    ["字符宽度", { kv: "ambiguous_width", initial: 1 }],
  ],
  model: [
    ["当前模型", { opens: "model" }],
    ["推理强度", { local: "variant" }],
    ["标题模型", { config: "small_model", typed: "test/m" }],
  ],
  dag: [
    ["新会话默认 DAG 模式", { config: "dag.mode" }],
    ["DAG 并发上限", { config: "dag.concurrency", typed: "3" }],
    ["DAG token 预算", { config: "dag.budget.tokens", typed: "5000" }],
  ],
  permissions: [
    ["编辑", { config: "permission.edit" }],
    ["Bash", { config: "permission.bash" }],
    ["网络请求", { config: "permission.webfetch" }],
    ["项目外目录", { config: "permission.external_directory" }],
  ],
}
/** The tabs that hold no store: their rows are generated and read-only. */
const GENERATED: Record<string, string> = { shortcuts: "由 keymap 生成，只读" }

/** The value at a dotted path of a configuration patch, if the patch has it. */
function patchValue(patch: unknown, path: string) {
  let value: unknown = patch
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null || !(key in value)) return undefined
    value = Reflect.get(value, key)
  }
  return value
}

test("every row of every tab has a store, and activating the row writes that store and nothing else", async () => {
  for (const [tab, rows] of Object.entries(STORES)) {
    let context!: AppPanelTestContext
    const { app, tmp, updates, writes, host } = await renderConfig({
      tab,
      setup: (value) => {
        context = value
        connect(withVariants)(value)
      },
    })
    const onRow = (label: string) =>
      renderUntilFrame(app, (text) => selectedLineOf(text).includes(`› ${label} `), `the selection on "${label}"`)
    try {
      await currentModel(context)
      for (const [index, [label, store]] of rows.entries()) {
        const frame = await onRow(label)
        // A row with a store has its place: the names match one for one, in order, and none is left over.
        expect({ tab, row: index, label: selectedLineOf(frame).includes(label) }).toEqual({
          tab,
          row: index,
          label: true,
        })

        const before = updates.length
        await enter(app)
        if ("kv" in store) {
          expect({ label, changed: context.kv.get(store.kv, store.initial) !== store.initial }).toEqual({
            label,
            changed: true,
          })
          expect(updates.length).toBe(before)
        } else if ("config" in store) {
          if (store.typed !== undefined) {
            await type(app, store.typed)
            await enter(app)
          }
          expect(updates).toHaveLength(before + 1)
          expect({ label, key: store.config, written: patchValue(updates.at(-1), store.config) !== undefined }).toEqual(
            {
              label,
              key: store.config,
              written: true,
            },
          )
          // The language row switches the labels too; the rows after it are looked for in the language they started in.
          setLanguage("zh-CN")
        } else if ("local" in store) {
          expect(context.local.model.variant.current()).toBe("high")
          expect(updates.length).toBe(before)
        } else {
          await waitFor(() => host().top()?.id === store.opens, `the ${store.opens} panel`)
          expect(updates.length).toBe(before)
          app.mockInput.pressEscape()
          await renderUntilFrame(app, (text) => text.includes("/config"), "the settings panel again")
          // The panel is shown again from its first row: the traversal goes on from there.
          expect(index).toBe(0)
        }
        // Nothing but the global configuration, the kv file and model.json is written: no request to the server.
        expect(writes).toEqual([])
        await down(app)
      }
      // The last row is followed by the first again: there is no row that is not in the list.
      await onRow(rows[0][0])
    } finally {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    }
  }

  // The rows of the generated tabs have no store: activating one writes nothing, anywhere.
  for (const tab of Object.keys(GENERATED)) {
    const { app, tmp, updates, writes, host } = await renderConfig({ tab, shortcuts: true })
    try {
      await renderUntilFrame(app, (text) => text.includes("Switch model"), `the rows of the ${tab} tab`)
      await enter(app)
      expect({ tab, updates, writes, top: host().top()?.id }).toEqual({ tab, updates: [], writes: [], top: "config" })
    } finally {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    }
  }
})

// --- the new tabs at 80x24 and 120x40, and nothing wider than 80 columns ---------------------------------------------

/** What the new tabs are drawn from: a ratio, and a title model too long for the column. */
const longTitleModel = "a-provider/a-model-with-a-name-far-too-long-for-the-value-column-of-this-panel"
const wideConfig = (url: URL) =>
  url.pathname === "/config" ? json({ compaction: { trigger_ratio: 0.85 }, small_model: longTitleModel }) : undefined

/** The frame a new tab shows once it has its rows. */
const TAB_READY = { general: "上下文到", model: "Test model", shortcuts: "Switch model" } as const
const TAB_READY_EN = { general: "of the context", model: "Test model", shortcuts: "Switch model" } as const

for (const language of ["zh-CN", "en"] as const) {
  test(`the general, model and shortcuts tabs at 80x24 and 120x40, ${language}`, async () => {
    for (const [width, height] of [
      [80, 24],
      [120, 40],
    ] as const) {
      for (const tab of ["general", "model", "shortcuts"] as const) {
        const { app, tmp } = await renderConfig({
          tab,
          width,
          height,
          language,
          shortcuts: true,
          handler: wideConfig,
          setup: connect(withVariants, withoutVariants),
        })
        try {
          const ready = (language === "en" ? TAB_READY_EN : TAB_READY)[tab]
          const frame = await renderUntilFrame(app, (text) => text.includes(ready), `the ${tab} tab`)
          expect(frame).toMatchSnapshot()
        } finally {
          app.renderer.destroy()
          await tmp[Symbol.asyncDispose]()
        }
      }
    }
  })
}

for (const language of ["zh-CN", "en"] as const) {
  for (const ambiguousWidth of [1, 2] as const) {
    test(`the new tabs lay nothing out wider than 80 columns, ${language}, ambiguous_width ${ambiguousWidth}`, async () => {
      for (const tab of ["general", "model", "shortcuts"] as const) {
        const { app, tmp } = await renderConfig({
          tab,
          width: 80,
          height: 24,
          language,
          kv: { ambiguous_width: ambiguousWidth },
          shortcuts: true,
          handler: wideConfig,
          setup: connect(withVariants, withoutVariants),
        })
        try {
          await renderUntilFrame(app, (text) => text.includes((language === "en" ? TAB_READY_EN : TAB_READY)[tab]), tab)
          let height: number | undefined
          // Each row in turn is the selected one, with the hint to change it and the note it brings.
          for (let row = 0; row < 7; row++) {
            const lines = (await readFrame(app)).split("\n").map((line) => line.trimEnd())
            const bordered = lines.filter((line) => line.startsWith("│") && line.endsWith("│"))
            expect(bordered.length).toBeGreaterThan(4)
            for (const line of bordered) {
              // Inside the border: the padding and what the panel itself laid out.
              expect({ tab, line, fits: cellWidth(line.slice(1, -1).trimEnd(), ambiguousWidth) <= 80 - 3 }).toEqual({
                tab,
                line,
                fits: true,
              })
            }
            // The note of the selected row is the line above the hint row; none of the new ones is cut to fit.
            const noteLine = lines[lines.findIndex((line) => line.includes("╰")) - 2] ?? ""
            expect({ tab, row, cut: noteLine.includes("…") }).toEqual({ tab, row, cut: false })
            // Nothing wrapped onto a second line: the panel keeps its height from row to row.
            const rows = lines.findIndex((line) => line.includes("╰")) - lines.findIndex((line) => line.includes("╭"))
            height ??= rows
            expect({ tab, row, rows }).toEqual({ tab, row, rows: height })
            app.mockInput.pressArrow("down")
            await settle(app)
          }
        } finally {
          app.renderer.destroy()
          await tmp[Symbol.asyncDispose]()
        }
      }
    })
  }
}

// --- the real app: which tab /config and /permissions open on ---------------------------------------------------------

function textareasOf(setup: Setup) {
  const collect = (root: Renderable, result: Renderable[] = []): Renderable[] => {
    result.push(root)
    for (const child of root.getChildren()) collect(child, result)
    return result
  }
  return collect(setup.renderer.root).filter((item): item is TextareaRenderable => item instanceof TextareaRenderable)
}

test("/config opens on the interface tab and /permissions on the permissions tab, and the model row opens /model", async () => {
  const app = await runApp({ sessions: [], args: {}, width: 120, height: 30 })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes(PROMPT_MARK), "the prompt")
    // Another test file of the same process can leave a draft in the prompt: what is typed here goes after nothing.
    for (const input of textareasOf(app.setup)) if (!input.isDestroyed) input.setText("")
    await app.setup.mockInput.typeText("/config")
    await waitForFrame(app.setup, (frame) => frame.includes("打开设置面板"), "the command popup")
    app.setup.mockInput.pressEnter()
    const frame = await waitForFrame(app.setup, (value) => value.includes("[界面]"), "the settings panel")
    expect(lineOf(frame, "[界面]")).toMatch(TAB_STRIP["zh-CN"])

    // The model tab is next to the right, and its first row opens the list `/model` opens.
    app.setup.mockInput.pressArrow("right")
    await waitForFrame(app.setup, (value) => value.includes("[模型]"), "the model tab")
    app.setup.mockInput.pressEnter()
    await waitForFrame(app.setup, (value) => value.includes("选择模型"), "the model list")
    expect(app.writes()).toEqual([])

    // Escape closes the list, and again the panel.
    app.setup.mockInput.pressEscape()
    await waitForFrame(app.setup, (value) => value.includes("[模型]"), "the settings panel again")
    app.setup.mockInput.pressEscape()
    await waitForFrame(app.setup, (value) => value.includes(PROMPT_MARK), "the prompt again")

    await app.setup.mockInput.typeText("/permissions")
    await waitForFrame(app.setup, (value) => value.includes("打开设置中的权限标签"), "the command popup")
    app.setup.mockInput.pressEnter()
    const permissions = await waitForFrame(app.setup, (value) => value.includes("[权限]"), "the permissions tab")
    expect(lineOf(permissions, "[权限]")).toMatch(TAB_STRIP["zh-CN"])
    expect(app.writes()).toEqual([])
  } finally {
    for (const input of textareasOf(app.setup)) if (!input.isDestroyed) input.setText("")
    await app.stop()
  }
})
