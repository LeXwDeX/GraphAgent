// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import type { Goal, Message, Session } from "@graphagent/sdk"
import type { CapturedFrame, RGBA } from "@opentui/core"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createSignal, Show } from "solid-js"
import { useTuiConfig } from "../../../src/config"
import { DEFAULT_THEME } from "../../../src/context/theme"
import type { Ticker } from "../../../src/context/ticker"
import { setLanguage } from "../../../src/i18n"
import { useBindings } from "../../../src/keymap"
import { SessionDrawer } from "../../../src/routes/session/drawer"
import { Drawer, DRAWER_WIDTH } from "../../../src/shell/drawer"
import { DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { cellWidth } from "../../../src/ui/width"
import { RUN_START, endRun, runSessionID, seedRun } from "../../fixture/background-runs"
import { directory, json } from "../../fixture/tui-sdk"
import { mountRoute, sessionFixture, type MountOptions } from "../dag-mode-harness"

// What the drawer's sections show and in what order (#1032 5.2): session, context, cost, the mode line, goal, todo,
// services, then the key that closes it. Empty sections are left out; the modified files are not shown (#1032 D8).

const ROOT = "ses_content_root"
const CHILD = "ses_content_child"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

function assistant(sessionID: string, input: number): Message {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: the fields the drawer reads.
  return {
    id: `msg_${sessionID}_${input}`,
    sessionID,
    role: "assistant",
    parentID: `msg_${sessionID}_user`,
    agent: "build",
    mode: "build",
    modelID: "window",
    providerID: "test",
    path: { cwd: directory, root: directory },
    time: { created: 1, completed: 2 },
    cost: 0,
    tokens: { input, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  } as Message
}

/** A provider whose `window` model has a context of 1000 tokens. */
const providers = {
  providers: [
    {
      id: "test",
      name: "Test",
      source: "custom",
      env: [],
      options: {},
      models: { window: { id: "window", name: "Window", limit: { context: 1000, output: 100 } } },
    },
  ],
  default: {},
}

const GOAL: Goal = {
  goal: "全部依赖升到最新稳定版",
  status: "paused",
  turnsUsed: 6,
  maxTurns: 30,
  subgoals: ["升级 TypeScript", "修复类型错误"],
  pausedReason: "等待评审",
}

/** What the session route registers for the toggle and the mode switch, so the drawer has keys to show. */
function Bindings() {
  const config = useTuiConfig()
  useBindings(() => ({
    commands: [
      { name: "session.drawer.toggle", title: "Toggle drawer", category: "Session", run: () => {} },
      { name: "session.dagmode.toggle", title: "Toggle DAG mode", category: "Session", run: () => {} },
    ],
    bindings: [
      ...config.keybinds.gather("session_drawer_toggle", ["session.drawer.toggle"]),
      ...config.keybinds.gather("session_dagmode_toggle", ["session.dagmode.toggle"]),
    ],
  }))
  return null
}

type Todo = { content: string; status: string; priority: string }

type Data = {
  /** The root session's goal. */
  goal?: Goal
  /** Todo lists by session. */
  todo?: Record<string, readonly Todo[]>
  /** Input tokens of each session's latest answer (one output token is added), by session. */
  context?: Record<string, number>
  lsp?: readonly unknown[]
  mcp?: Record<string, unknown>
}

async function mountDrawer(
  options: { root?: Partial<Session>; sessionID?: string; data?: Data } & Partial<MountOptions> = {},
) {
  const { root, sessionID, data = {}, ...rest } = options
  const width = rest.width ?? 120
  const harness = await mountRoute({
    route: { type: "session", sessionID: sessionID ?? ROOT },
    sessions: [
      sessionFixture(ROOT, { title: "依赖升级", cost: 1.5, time: { created: 1, updated: 9 }, ...root }),
      sessionFixture(CHILD, { parentID: ROOT, title: "子任务", cost: 0.25 }),
    ],
    handler: (url) => {
      if (url.pathname === "/config/providers") return json(providers)
      if (url.pathname === "/lsp") return json(data.lsp ?? [])
      if (url.pathname === "/mcp") return json(data.mcp ?? {})
      if (url.pathname === "/vcs") return json({ branch: "feat/upgrade" })
      if (url.pathname === `/session/${ROOT}/goal`) return json(data.goal ?? null)
      for (const id of [ROOT, CHILD]) {
        if (url.pathname === `/session/${id}/todo`) return json(data.todo?.[id] ?? [])
        if (url.pathname === `/session/${id}/message`) {
          const input = data.context?.[id]
          return json(input === undefined ? [] : [{ info: assistant(id, input), parts: [] }])
        }
      }
      return undefined
    },
    view: () => (
      <>
        <Bindings />
        <Drawer>
          <SessionDrawer sessionID={sessionID ?? ROOT} />
        </Drawer>
      </>
    ),
    width,
    height: 40,
    ...rest,
  })
  // The route view is not mounted here, so load the sessions the way it would: messages, todo list and goal.
  await harness.sync().session.sync(ROOT)
  if (sessionID === CHILD) await harness.sync().session.sync(CHILD)
  return harness
}

type Mount = Awaited<ReturnType<typeof mountDrawer>>

const rowsOf = (frame: string) => frame.split("\n").map((line) => line.trimEnd())

/** The drawer's column of a frame, line by line, without the blank rows. */
const columnOf = (frame: string, width: number) =>
  rowsOf(frame)
    .map((line) => line.slice(width - DRAWER_WIDTH).trimEnd())
    .filter((line) => line.trim() !== "")

async function column(harness: Mount, width: number, ready: (lines: string[]) => boolean, what: string) {
  return columnOf(await harness.waitForFrame((value) => ready(columnOf(value, width)), what), width)
}

const has = (needle: string) => (lines: string[]) => lines.some((line) => line.includes(needle))
const palette = () => resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")

function colorOf(frame: CapturedFrame, needle: string): RGBA | undefined {
  for (const line of frame.lines) {
    for (const span of line.spans) if (span.text.includes(needle)) return span.fg
  }
  return undefined
}

const FULL: Data = {
  goal: GOAL,
  todo: {
    [ROOT]: [
      { content: "读取依赖清单", status: "completed", priority: "high" },
      { content: "升级 TypeScript", status: "in_progress", priority: "high" },
      { content: "跑 CI", status: "pending", priority: "medium" },
    ],
  },
  context: { [ROOT]: 849 },
  lsp: [{ id: "typescript", name: "TypeScript", root: directory, status: "connected" }],
  mcp: { github: { status: "connected" }, search: { status: "connected" }, broken: { status: "failed", error: "x" } },
}

describe("the drawer's sections", () => {
  for (const width of [80, 120]) {
    test(`come in their order with their data, ${width} columns`, async () => {
      const harness = await mountDrawer({ width, data: FULL })
      try {
        const lines = await column(
          harness,
          width,
          (all) => has("85%")(all) && has("跑 CI")(all) && has("MCP 已连接")(all),
          "every section",
        )
        expect(lines).toMatchSnapshot()
        const at = (needle: string) => lines.findIndex((line) => line.includes(needle))
        const order = ["依赖升级", "上下文", "费用", "DAG 模式", "目标", "待办 1/3", "服务", "ctrl+b 关闭"].map(at)
        expect(order.every((index) => index >= 0)).toBe(true)
        expect([...order].sort((a, b) => a - b)).toEqual(order)
        expect(harness.writes()).toEqual([])
      } finally {
        await harness.dispose()
      }
    })
  }

  test("say the same in English", async () => {
    setLanguage("en")
    const harness = await mountDrawer({ language: "en", data: FULL })
    try {
      const lines = await column(
        harness,
        120,
        (all) => has("85%")(all) && has("MCP 2 connected")(all) && has("Todo 1/3")(all),
        "every section",
      )
      expect(lines).toMatchSnapshot()
    } finally {
      await harness.dispose()
    }
  })

  test("leave out what has no data, and show the context as a dash before the first answer", async () => {
    const harness = await mountDrawer()
    try {
      const lines = await column(harness, 120, (all) => has("$1.50")(all) && has("ctrl+b 关闭")(all), "the drawer")
      expect(lines.some((line) => line.trim() === "—")).toBe(true)
      for (const absent of ["目标", "待办", "服务", "LSP", "MCP", "修改的文件"]) expect(has(absent)(lines)).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  test("show a paused goal's reason in the warning color and list every subgoal", async () => {
    const harness = await mountDrawer({ data: { goal: GOAL } })
    try {
      const lines = await column(harness, 120, has("修复类型错误"), "the goal")
      expect(lines.some((line) => line.includes("第 6/30 轮 · 等待评审"))).toBe(true)
      expect(lines.some((line) => line.includes("· 升级 TypeScript"))).toBe(true)
      expect(colorOf(await harness.spans(), "等待评审")?.equals(palette().warning)).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  test("mark todo items: done gray, in progress in the brand color, pending dim", async () => {
    const harness = await mountDrawer({ data: { todo: FULL.todo } })
    try {
      await column(harness, 120, has("跑 CI"), "the todo")
      const spans = await harness.spans()
      expect(colorOf(spans, "✓")?.equals(palette().textMuted)).toBe(true)
      expect(colorOf(spans, "●")?.equals(palette().primary)).toBe(true)
      expect(colorOf(spans, "○")?.equals(palette().textDim)).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  test("name an MCP server that is down in the error color", async () => {
    const harness = await mountDrawer({ data: { mcp: FULL.mcp } })
    try {
      await column(harness, 120, has("MCP 未连接：broken"), "the services")
      expect(colorOf(await harness.spans(), "MCP 未连接")?.equals(palette().error)).toBe(true)
    } finally {
      await harness.dispose()
    }
  })
})

describe("the context bar", () => {
  for (const [input, percent, token] of [
    [839, 84, "text"],
    [849, 85, "warning"],
    [949, 95, "error"],
  ] as const) {
    test(`is ${token} at ${percent}%`, async () => {
      const harness = await mountDrawer({ data: { context: { [ROOT]: input } } })
      try {
        const lines = await column(harness, 120, has(`${percent}%`), "the context")
        expect(lines.some((line) => line.includes(`${input + 1} / 1,000 tokens`))).toBe(true)
        const spans = await harness.spans()
        expect(colorOf(spans, `${percent}%`)?.equals(palette()[token])).toBe(true)
        expect(colorOf(spans, "█")?.equals(palette()[token])).toBe(true)
      } finally {
        await harness.dispose()
      }
    })
  }
})

describe("a sub-agent session's drawer", () => {
  test("follows the sub-agent for context, cost and todo, and shows the root session's goal", async () => {
    const harness = await mountDrawer({
      sessionID: CHILD,
      data: {
        goal: GOAL,
        todo: { [ROOT]: FULL.todo![ROOT], [CHILD]: [{ content: "子任务待办", status: "pending", priority: "high" }] },
        context: { [ROOT]: 849, [CHILD]: 499 },
      },
    })
    try {
      const lines = await column(
        harness,
        120,
        (all) => has("子任务待办")(all) && has("全部依赖")(all) && has("50%")(all),
        "the sub-agent's drawer",
      )
      expect(has("跑 CI")(lines)).toBe(false)
      expect(has("85%")(lines)).toBe(false)
      expect(has("$0.25")(lines)).toBe(true)
      expect(has("$1.50")(lines)).toBe(false)
      expect(has("DAG 模式")(lines)).toBe(false)
    } finally {
      await harness.dispose()
    }
  })
})

for (const aw of [1, 2] as const) {
  for (const language of ["zh-CN", "en"] as const) {
    test(`every drawer row fits its 40 columns at 80 columns, ${language}, ambiguous_width ${aw}`, async () => {
      setLanguage(language)
      const harness = await mountDrawer({ width: 80, language, kv: { ambiguous_width: aw }, data: FULL })
      try {
        const lines = await column(harness, 80, has("85%"), "the drawer")
        for (const line of lines) expect(cellWidth(line, aw)).toBeLessThanOrEqual(DRAWER_WIDTH)
        // The left 40 columns are the main area's: nothing of the drawer spills into them.
        const frame = await harness.waitForFrame(() => true, "the frame")
        for (const row of rowsOf(frame)) expect(row.slice(0, 80 - DRAWER_WIDTH).trim()).toBe("")
      } finally {
        await harness.dispose()
      }
    })
  }
}

test("a click anywhere in the drawer sends nothing and changes nothing", async () => {
  const harness = await mountDrawer({ data: FULL })
  try {
    const before = await column(harness, 120, (all) => has("85%")(all) && has("跑 CI")(all), "the drawer")
    for (let row = 1; row < 30; row += 2) await harness.app.mockMouse.click(120 - DRAWER_WIDTH + 4, row)
    await harness.settle()
    expect(columnOf(await harness.waitForFrame(() => true, "the frame"), 120)).toEqual(before)
    expect(harness.writes()).toEqual([])
    expect(harness.commands()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

// ── The background section (#1058 5) ────────────────────────────────────────────────────────────────────────────
//
// The root session's runs that are still going, between the goal and the todo: at most three lines, then a count that
// points at `/agents`. The times follow the one-second clock only while the drawer is open and a listed run runs.

/** A one-second clock the test drives; it counts who listens to it. */
function clockTicker(now: number) {
  const [second, setSecond] = createSignal(0)
  let time = now
  const calls = { frame: 0, second: 0, released: 0 }
  const ticker: Ticker = {
    frame: () => 0,
    second,
    subscribe() {
      calls.frame++
      return () => {}
    },
    subscribeSecond() {
      calls.second++
      return () => {
        calls.released++
      }
    },
    at: () => () => {},
    now: () => time,
  }
  return {
    ticker,
    calls,
    /** Subscriptions to the second clock that are held now. */
    listeners: () => calls.second - calls.released,
    advance(ms: number) {
      time += ms
      setSecond((value) => value + 1)
    },
  }
}

/** The clock the runs are timed against: the oldest running run has run 2m 14s, the other 58s. */
const NOW = RUN_START + 134_000

type Sync = ReturnType<Mount["sync"]>

/** Two running runs and two queued ones, all started by the root session. */
function fourRuns(sync: Sync, parent = ROOT) {
  seedRun(sync, {
    parent,
    key: "review",
    state: "running",
    kind: "review",
    description: "未提交改动",
    startedAt: RUN_START,
  })
  seedRun(sync, {
    parent,
    key: "scan",
    state: "running",
    kind: "explore",
    description: "扫描依赖",
    startedAt: NOW - 58_000,
  })
  seedRun(sync, {
    parent,
    key: "wait1",
    state: "queued",
    kind: "explore",
    description: "排队甲",
    startedAt: NOW - 3_000,
  })
  seedRun(sync, {
    parent,
    key: "wait2",
    state: "queued",
    kind: "general",
    description: "排队乙",
    startedAt: NOW - 2_000,
  })
}

describe("the background section", () => {
  for (const width of [80, 120]) {
    test(`sits between the goal and the todo, three runs and a count of the rest, ${width} columns`, async () => {
      const clock = clockTicker(NOW)
      const harness = await mountDrawer({ width, data: FULL, ticker: clock.ticker })
      try {
        fourRuns(harness.sync())
        const lines = await column(harness, width, has("还有 1 个"), "the background section")
        expect(lines).toMatchSnapshot()
        const at = (needle: string) => lines.findIndex((line) => line.includes(needle))
        const order = ["目标", "后台任务 4", "待办 1/3", "服务"].map(at)
        expect(order.every((index) => index >= 0)).toBe(true)
        expect([...order].sort((a, b) => a - b)).toEqual(order)
        // The newest running run first, then the older one, then the newest queued; the older queued one is counted.
        const rows = lines.slice(at("后台任务 4") + 1, at("待办 1/3")).map((line) => line.trim())
        expect(rows).toHaveLength(4)
        expect(rows[0]).toMatch(/^● explore · 扫描依赖 +58s$/)
        expect(rows[1]).toMatch(/^● review · 未提交改动 +2m 14s$/)
        expect(rows[2]).toBe("○ general · 排队乙")
        expect(rows[3]).toBe("… 还有 1 个 · /agents")
        expect(harness.writes()).toEqual([])
      } finally {
        await harness.dispose()
      }
    })
  }

  test("says the same in English", async () => {
    setLanguage("en")
    const clock = clockTicker(NOW)
    const harness = await mountDrawer({ language: "en", data: FULL, ticker: clock.ticker })
    try {
      fourRuns(harness.sync())
      const lines = await column(harness, 120, has("1 more"), "the background section")
      expect(lines).toMatchSnapshot()
      expect(has("Background 4")(lines)).toBe(true)
      expect(lines.some((line) => line.trim() === "… 1 more · /agents")).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  test("is hidden while no run is going, and with it the gap it would take", async () => {
    const harness = await mountDrawer({ data: FULL })
    try {
      const lines = await column(harness, 120, has("跑 CI"), "the drawer")
      expect(has("后台")(lines)).toBe(false)
      expect(has("/agents")(lines)).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  test("lists only the runs that are running or queued, started by the root, in the background", async () => {
    const harness = await mountDrawer()
    try {
      const sync = harness.sync()
      seedRun(sync, { parent: ROOT, key: "live", state: "running", description: "还在跑" })
      seedRun(sync, { parent: ROOT, key: "done", state: "completed", description: "已完成" })
      seedRun(sync, { parent: ROOT, key: "failed", state: "error", description: "已失败" })
      seedRun(sync, { parent: ROOT, key: "lost", state: "unknown", description: "不知道" })
      seedRun(sync, { parent: ROOT, key: "front", state: "running", description: "前台", background: false })
      seedRun(sync, { parent: "ses_elsewhere", key: "other", state: "running", description: "别的会话" })
      const lines = await column(harness, 120, has("后台任务 1"), "the background section")
      expect(has("还在跑")(lines)).toBe(true)
      for (const absent of ["已完成", "已失败", "不知道", "前台", "别的会话"]) expect(has(absent)(lines)).toBe(false)
      expect(has("还有")(lines)).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  test("goes when the last run ends, and comes back with the next", async () => {
    const harness = await mountDrawer()
    try {
      const sync = harness.sync()
      seedRun(sync, { parent: ROOT, key: "a", state: "running" })
      await column(harness, 120, has("后台任务 1"), "one run")
      endRun(sync, "a")
      await column(harness, 120, (lines) => !has("后台任务")(lines), "no run")
      seedRun(sync, { parent: ROOT, key: "b", state: "queued" })
      await column(harness, 120, has("后台任务 1"), "the next run")
    } finally {
      await harness.dispose()
    }
  })

  test("is the root session's in a sub-agent session, whose own sections follow it", async () => {
    const harness = await mountDrawer({
      sessionID: CHILD,
      data: { goal: GOAL, todo: { [CHILD]: [{ content: "子任务待办", status: "pending", priority: "high" }] } },
    })
    try {
      fourRuns(harness.sync())
      const lines = await column(harness, 120, has("后台任务 4"), "the root's runs")
      const at = (needle: string) => lines.findIndex((line) => line.includes(needle))
      expect(at("目标")).toBeLessThan(at("后台任务 4"))
      expect(at("后台任务 4")).toBeLessThan(at("子任务待办"))
    } finally {
      await harness.dispose()
    }
  })

  test("marks a running run `●` in the running color and a queued one `○` in the queued color, both static", async () => {
    const harness = await mountDrawer()
    try {
      seedRun(harness.sync(), { parent: ROOT, key: "a", state: "running", description: "跑着" })
      seedRun(harness.sync(), { parent: ROOT, key: "b", state: "queued", description: "等着" })
      await column(harness, 120, has("等着"), "both runs")
      const spans = await harness.spans()
      expect(colorOf(spans, "●")?.equals(palette().statusRunning)).toBe(true)
      expect(colorOf(spans, "○")?.equals(palette().statusQueued)).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  // #1407: three runs with a limit of one. The one that began shows its time from the moment it got its slot, the
  // two behind it wait and have none; a child that has shown nothing does not turn the first into a waiting one.
  test("lists the queue the server reports: the run that began runs and is timed without its wait", async () => {
    const clock = clockTicker(NOW)
    const harness = await mountDrawer({ ticker: clock.ticker })
    try {
      const sync = harness.sync()
      // Started 50 s ago, waited 40 s for its slot: it has run for 10 s.
      seedRun(sync, {
        parent: ROOT,
        key: "first",
        state: "started",
        description: "跑着",
        startedAt: NOW - 50_000,
        runningAt: NOW - 10_000,
      })
      seedRun(sync, { parent: ROOT, key: "second", state: "waiting", description: "等着甲", startedAt: NOW - 3_000 })
      seedRun(sync, { parent: ROOT, key: "third", state: "waiting", description: "等着乙", startedAt: NOW - 2_000 })
      const lines = await column(harness, 120, has("等着甲"), "the three runs")
      const rows = lines.map((line) => line.trim())
      expect(rows.find((row) => row.includes("后台任务"))).toBe("后台任务 3")
      expect(rows.find((row) => row.includes("跑着"))).toMatch(/^● explore · 跑着 +10s$/)
      expect(rows.find((row) => row.includes("等着甲"))).toBe("○ explore · 等着甲")
      expect(rows.find((row) => row.includes("等着乙"))).toBe("○ explore · 等着乙")
      const spans = await harness.spans()
      expect(colorOf(spans, "●")?.equals(palette().statusRunning)).toBe(true)
      expect(colorOf(spans, "○")?.equals(palette().statusQueued)).toBe(true)

      // The clock moves the run that began, from the moment it began.
      clock.advance(5_000)
      await column(harness, 120, has("15s"), "five seconds on")
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("shows the time of a running run only, and follows the clock", async () => {
    const clock = clockTicker(NOW)
    const harness = await mountDrawer({ ticker: clock.ticker })
    try {
      seedRun(harness.sync(), { parent: ROOT, key: "a", state: "running", description: "跑着", startedAt: RUN_START })
      seedRun(harness.sync(), { parent: ROOT, key: "b", state: "queued", description: "等着", startedAt: RUN_START })
      const lines = await column(harness, 120, has("2m 14s"), "the time")
      expect(lines.filter((line) => /\d+m \d+s|\d+s$/.test(line.trim()) && line.includes("等着"))).toEqual([])
      clock.advance(1_000)
      await column(harness, 120, has("2m 15s"), "the next second")
      clock.advance(60_000)
      await column(harness, 120, has("3m 15s"), "the next minute")
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("a click on any line of it sends nothing and changes nothing", async () => {
    const clock = clockTicker(NOW)
    const harness = await mountDrawer({ data: FULL, ticker: clock.ticker })
    try {
      fourRuns(harness.sync())
      const before = await column(harness, 120, has("还有 1 个"), "the section")
      for (let row = 1; row < 36; row++) await harness.app.mockMouse.click(120 - DRAWER_WIDTH + 4, row)
      await harness.settle()
      expect(columnOf(await harness.waitForFrame(() => true, "the frame"), 120)).toEqual(before)
      expect(harness.writes()).toEqual([])
      expect(harness.commands()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })
})

for (const aw of [1, 2] as const) {
  for (const language of ["zh-CN", "en"] as const) {
    test(`every line of the background section fits its 40 columns at 80 columns, ${language}, ambiguous_width ${aw}`, async () => {
      setLanguage(language)
      const clock = clockTicker(NOW)
      const harness = await mountDrawer({
        width: 80,
        language,
        kv: { ambiguous_width: aw },
        data: FULL,
        ticker: clock.ticker,
      })
      try {
        const sync = harness.sync()
        // Descriptions far longer than the column, a type that is long itself, and times in minutes and hours.
        seedRun(sync, {
          parent: ROOT,
          key: "a",
          state: "running",
          kind: "review",
          description: "把 changelog 里的破坏性变更逐条列出来并给出迁移建议，Review the uncommitted changes",
          startedAt: RUN_START,
        })
        seedRun(sync, {
          parent: ROOT,
          key: "b",
          state: "running",
          kind: "an-agent-type-with-a-very-long-name",
          description: "x".repeat(120),
          startedAt: NOW - 4_000_000,
        })
        seedRun(sync, {
          parent: ROOT,
          key: "c",
          state: "queued",
          kind: "explore",
          description: "ス キ ャ ン 依存関係 の 確認 を お願い します",
        })
        seedRun(sync, { parent: ROOT, key: "d", state: "queued", description: "排队" })
        const lines = await column(harness, 80, (all) => has("/agents")(all), "the background section")
        for (const line of lines) expect(cellWidth(line, aw), line).toBeLessThanOrEqual(DRAWER_WIDTH)
        // The long ones are cut with an ellipsis by the section itself, not clipped by the column.
        const first = lines.find((line) => line.includes("review ·") || line.includes("review "))
        expect(first?.includes("…")).toBe(true)
        // The left 40 columns are the main area's: nothing of the section spills into them.
        const frame = await harness.waitForFrame(() => true, "the frame")
        for (const row of rowsOf(frame)) expect(row.slice(0, 80 - DRAWER_WIDTH).trim()).toBe("")
      } finally {
        await harness.dispose()
      }
    })
  }
}

describe("the drawer's clock", () => {
  /** The drawer opened and closed by the test, the way the frame mounts it only while it is visible. */
  async function mountToggled(ticker: Ticker) {
    const [open, setOpen] = createSignal(false)
    const harness = await mountRoute({
      route: { type: "session", sessionID: ROOT },
      sessions: [
        sessionFixture(ROOT, { title: "依赖升级", cost: 1.5, time: { created: 1, updated: 9 } }),
        sessionFixture(CHILD, { parentID: ROOT, title: "子任务" }),
      ],
      handler: (url) => (url.pathname === `/session/${ROOT}/goal` ? json(null) : undefined),
      view: () => (
        <>
          <Bindings />
          <Show when={open()}>
            <Drawer>
              <SessionDrawer sessionID={ROOT} />
            </Drawer>
          </Show>
        </>
      ),
      ticker,
      width: 120,
      height: 40,
    })
    await harness.sync().session.sync(ROOT)
    return { harness, setOpen }
  }

  test("asks for nothing while the drawer is closed, and for one subscription while it is open with a running run", async () => {
    const clock = clockTicker(NOW)
    const { harness, setOpen } = await mountToggled(clock.ticker)
    try {
      await harness.settle()
      const bare = clock.listeners()
      seedRun(harness.sync(), { parent: ROOT, key: "a", state: "running" })
      await harness.settle()
      // Closed: the section is not mounted, so the run costs nothing.
      expect(clock.listeners()).toBe(bare)
      expect(clock.calls.frame).toBe(0)

      setOpen(true)
      await column(harness, 120, has("后台任务 1"), "the open drawer")
      expect(clock.listeners()).toBe(bare + 1)

      setOpen(false)
      await harness.settle()
      expect(clock.listeners()).toBe(bare)
      expect(clock.calls.frame).toBe(0)
    } finally {
      await harness.dispose()
    }
  })

  test("is not asked while no run is running: queued runs alone have no time to move", async () => {
    const clock = clockTicker(NOW)
    const { harness, setOpen } = await mountToggled(clock.ticker)
    try {
      await harness.settle()
      const bare = clock.listeners()
      seedRun(harness.sync(), { parent: ROOT, key: "w1", state: "queued" })
      seedRun(harness.sync(), { parent: ROOT, key: "w2", state: "queued" })
      setOpen(true)
      await column(harness, 120, has("后台任务 2"), "the queued runs")
      expect(clock.listeners()).toBe(bare)
    } finally {
      await harness.dispose()
    }
  })

  test("is asked while a run runs and let go when the last one ends, and again for the next", async () => {
    const clock = clockTicker(NOW)
    const { harness, setOpen } = await mountToggled(clock.ticker)
    try {
      await harness.settle()
      const bare = clock.listeners()
      setOpen(true)
      await harness.settle()
      expect(clock.listeners()).toBe(bare)

      seedRun(harness.sync(), { parent: ROOT, key: "a", state: "running" })
      await column(harness, 120, has("后台任务 1"), "a running run")
      expect(clock.listeners()).toBe(bare + 1)
      // More running runs do not add subscriptions: one clock serves the section.
      seedRun(harness.sync(), { parent: ROOT, key: "b", state: "running", startedAt: RUN_START + 1 })
      await column(harness, 120, has("后台任务 2"), "two running runs")
      expect(clock.listeners()).toBe(bare + 1)

      endRun(harness.sync(), "a")
      endRun(harness.sync(), "b")
      await column(harness, 120, (lines) => !has("后台任务")(lines), "no run")
      expect(clock.listeners()).toBe(bare)

      seedRun(harness.sync(), { parent: ROOT, key: "c", state: "running", startedAt: RUN_START + 2 })
      await column(harness, 120, has("后台任务 1"), "the next run")
      expect(clock.listeners()).toBe(bare + 1)
      expect(runSessionID("c")).toBe("ses_run_c")
    } finally {
      await harness.dispose()
    }
  })
})
