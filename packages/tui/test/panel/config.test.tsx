// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createSignal, Show } from "solid-js"
import type { SessionDagMode } from "@graphagent/sdk"
import { useSDK } from "../../src/context/sdk"
import { getLanguage, setLanguage } from "../../src/i18n"
import { ConfigPanel } from "../../src/panel/config"
import { PanelSurface, renderAppPanel, type AppPanelTestContext } from "./contexts"
import { readFrame, renderUntilFrame } from "../fixture/frames"
import { waitFor } from "../fixture/held-io"
import { json } from "../fixture/tui-sdk"
import { dagModeStatus } from "../routes/dag-mode-harness"
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
  // Runs before ConfigPanel builds its rows, so the panel sees the stubbed
  // write endpoint on its first render (writability is not reactive).
  props.stub?.(sdk)
  const [tab, setTab] = createSignal(props.tab)
  return (
    <Show when={props.open?.() ?? true}>
      <ConfigPanel activeTab={tab()} onTab={setTab} />
    </Show>
  )
}

type RenderOptions = {
  tab?: string
  /** Open the panel inside this session instead of on the home view. */
  inSession?: string
  /** Leave the real SDK update in place and answer the HTTP request via `handler`. */
  realWrite?: boolean
  /** Simulate a server without the global config write endpoint. */
  disableWrite?: boolean
  handler?: (url: URL) => Response | undefined
  setup?: (context: AppPanelTestContext) => void | Promise<void>
  width?: number
  height?: number
}

async function renderConfig(options: RenderOptions = {}) {
  const tmp = await shellState()
  const updates: Record<string, unknown>[] = []
  const seen: string[] = []
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
      <PanelSurface
        spec={{
          id: "config",
          render: () => <ConfigHarness tab={options.tab ?? "interface"} stub={stub} open={open} />,
        }}
      />
    ),
    {
      width: options.width ?? 120,
      height: options.height ?? 40,
      state: tmp.path,
      handler: (url) => {
        seen.push(url.pathname)
        return options.handler?.(url)
      },
      setup: async (context) => {
        await options.setup?.(context)
        if (options.inSession === undefined) return
        context.route.navigate({ type: "session", sessionID: options.inSession })
        setOpen(true)
      },
    },
  )
  return { app, tmp, updates, seen }
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

async function right(app: Awaited<ReturnType<typeof renderAppPanel>>) {
  app.mockInput.pressArrow("right")
  await settle(app)
}

async function left(app: Awaited<ReturnType<typeof renderAppPanel>>) {
  app.mockInput.pressArrow("left")
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

test("every interface toggle writes its documented kv key", async () => {
  let kv!: AppPanelTestContext["kv"]
  const { app, tmp } = await renderConfig({ setup: (context) => ((kv = context.kv), undefined) })
  try {
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
    expect(kv.get("file_context_enabled", true)).toBe(false)

    await down(app)
    await enter(app)
    expect(kv.get("diff_wrap_mode", "word")).toBe("none")

    await down(app)
    await enter(app)
    expect(kv.get("paste_summary_enabled", true)).toBe(false)

    await down(app)
    await enter(app)
    expect(kv.get("session_directory_filter_enabled", true)).toBe(false)

    await down(app)
    await enter(app)
    expect(kv.get("terminal_title_enabled", true)).toBe(false)

    await down(app, 2)
    await enter(app)
    expect(kv.get("conceal_code", true)).toBe(false)
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("drawer, DAG band, ambiguous width and language rows write their stores", async () => {
  let kv!: AppPanelTestContext["kv"]
  const { app, tmp, updates } = await renderConfig({ setup: (context) => ((kv = context.kv), undefined) })
  try {
    await down(app, 13)
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

    await down(app)
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
  const { app, tmp, updates } = await renderConfig()
  try {
    await down(app, 17)
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
  const { app, tmp, updates } = await renderConfig()
  try {
    await right(app)
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
  const { app, tmp, updates } = await renderConfig({ disableWrite: true })
  try {
    await right(app)
    await enter(app)
    await down(app)
    await enter(app)
    expect(app.captureCharFrame()).not.toContain("输入…")
    expect(updates).toEqual([])

    await left(app)
    await down(app, 17)
    await enter(app)
    expect(getLanguage()).toBe("zh-CN")
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
