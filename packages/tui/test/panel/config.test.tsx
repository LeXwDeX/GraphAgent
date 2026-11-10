// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { useSDK } from "../../src/context/sdk"
import { getLanguage, setLanguage } from "../../src/i18n"
import { ConfigPanel } from "../../src/panel/config"
import { PanelSurface, renderAppPanel, type AppPanelTestContext } from "./contexts"
import { json } from "../fixture/tui-sdk"
import { shellState } from "../shell/contexts"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

function ConfigHarness(props: { tab: string; stub?: (sdk: AppPanelTestContext["sdk"]) => void }) {
  const sdk = useSDK()
  // Runs before ConfigPanel builds its rows, so the panel sees the stubbed
  // write endpoint on its first render (writability is not reactive).
  props.stub?.(sdk)
  const [tab, setTab] = createSignal(props.tab)
  return <ConfigPanel activeTab={tab()} onTab={setTab} />
}

type RenderOptions = {
  tab?: string
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
          render: () => <ConfigHarness tab={options.tab ?? "interface"} stub={stub} />,
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
      setup: options.setup,
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

test("drawer, ambiguous width and language rows write their stores", async () => {
  let kv!: AppPanelTestContext["kv"]
  const { app, tmp, updates } = await renderConfig({ setup: (context) => ((kv = context.kv), undefined) })
  try {
    await down(app, 13)
    await enter(app)
    expect(kv.get("drawer_mode", "hidden")).toBe("auto")

    await down(app, 2)
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
    await down(app, 16)
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

    await down(app)
    await enter(app)
    await backspace(app, 2)
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
    await down(app, 16)
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
    directory: "/tmp/opencode",
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
