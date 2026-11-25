// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import type { GlobalEvent, Goal, Message, Session, SessionOverhead, SessionUsage } from "@graphagent/sdk"
import type { CapturedFrame, RGBA } from "@opentui/core"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createSignal, Show } from "solid-js"
import { useTuiConfig } from "../../../src/config"
import { DEFAULT_THEME } from "../../../src/context/theme"
import type { Ticker } from "../../../src/context/ticker"
import { setLanguage } from "../../../src/i18n"
import { useBindings } from "../../../src/keymap"
import { SessionDrawer } from "../../../src/routes/session/drawer"
import { DRAWER_TEXT_CELLS } from "../../../src/routes/session/drawer-model"
import { Drawer, DRAWER_WIDTH } from "../../../src/shell/drawer"
import { DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { DRAWER_INSET } from "../../../src/ui/layout"
import { cellWidth } from "../../../src/ui/width"
import { RUN_START, endRun, runSessionID, seedRun } from "../../fixture/background-runs"
import { probeStoreWrites } from "../../fixture/store-write-probe"
import { loggedLines } from "../../fixture/tui-log"
import { directory, json } from "../../fixture/tui-sdk"
import { mountRoute, sessionFixture, usageFixture, waitFor, type MountOptions } from "../dag-mode-harness"

// What the drawer's sections show and in what order (#1032 5.2): session, context, cost, the mode line, goal, todo,
// services, then the key that closes it. Empty sections are left out; the modified files are not shown (#1032 D8). The
// cost is the whole task tree's, read from the server for the root of the tree (#1475).

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

/** The same provider with its `window` model replaced: what a model that declares no window, or an effective one, looks like. */
const providersWith = (model: Record<string, unknown>) => ({
  ...providers,
  providers: [
    {
      ...providers.providers[0],
      models: { window: { id: "window", name: "Window", limit: { context: 1000, output: 100 }, ...model } },
    },
  ],
})

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
  /** Fields of the model the context is measured against, over the default `window` model (a 1,000-token window). */
  model?: Record<string, unknown>
  lsp?: readonly unknown[]
  mcp?: Record<string, unknown>
  /** What the server sums for the tree, whichever session of it is asked about; nothing used without it. */
  usage?: SessionUsage
  /** What the server reports of each session's fixed overhead, by session; nothing reported without an entry. */
  overhead?: Record<string, SessionOverhead>
}

async function mountDrawer(
  options: {
    root?: Partial<Session>
    child?: Partial<Session>
    sessionID?: string
    data?: Data
  } & Partial<MountOptions> = {},
) {
  const { root, child, sessionID, data = {}, ...rest } = options
  const width = rest.width ?? 120
  const harness = await mountRoute({
    route: { type: "session", sessionID: sessionID ?? ROOT },
    sessions: [
      sessionFixture(ROOT, { title: "依赖升级", cost: 1.5, time: { created: 1, updated: 9 }, ...root }),
      sessionFixture(CHILD, { parentID: ROOT, title: "子任务", cost: 0.25, ...child }),
    ],
    usage: () => data.usage,
    overhead: (id) => data.overhead?.[id],
    handler: (url) => {
      if (url.pathname === "/config/providers") return json(data.model ? providersWith(data.model) : providers)
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

/** The reads of the fixed-overhead endpoint the fake server has heard of, in order. */
const overheadRequests = (harness: { requested: readonly string[] }) =>
  harness.requested.filter((request) => request.endsWith("/overhead"))

/** What the failure path of a fixed-overhead read writes to the TUI log for a session: one file for the process. */
const overheadFailedFor = (sessionID: string) =>
  loggedLines(`Loading the fixed overhead failed { sessionID: '${sessionID}'`)

/** The reads of the usage endpoint the fake server has heard of, in order. */
const usageRequests = (harness: { requested: readonly string[] }) =>
  harness.requested.filter((request) => request.endsWith("/usage"))

/** What the failure path of a usage read writes to the TUI log for a root: one file for the process, so a test names the root. */
const failedFor = (rootID: string) => loggedLines(`Loading the usage failed { sessionID: '${rootID}'`)

let sequence = 0
/** A turn that ended in `sessionID`: the moment its usage was last written, and what makes the drawer read it again. */
function settledTurn(sessionID: string): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return {
    directory,
    project: "proj_test",
    payload: {
      id: `evt_drawer_usage_${++sequence}`,
      type: "session.turn.settled",
      properties: {
        sessionID,
        turnID: `turn_${sequence}`,
        outcome: { type: "completed" },
        steps: 1,
        timeEnded: sequence,
      },
    },
  } as GlobalEvent
}
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
  usage: usageFixture(ROOT, {
    sessions: 4,
    cost: 1.5,
    tokens: { input: 12_345, output: 3_400, reasoning: 800, cache: { read: 1_200_000, write: 30_000 } },
  }),
}

describe("the drawer's sections", () => {
  for (const width of [80, 120]) {
    test(`come in their order with their data, ${width} columns`, async () => {
      const harness = await mountDrawer({ width, data: FULL })
      try {
        const lines = await column(
          harness,
          width,
          (all) => has("85%")(all) && has("跑 CI")(all) && has("MCP 已连接")(all) && has("缓存 读")(all),
          "every section",
        )
        expect(lines).toMatchSnapshot()
        const at = (needle: string) => lines.findIndex((line) => line.includes(needle))
        const order = ["依赖升级", "上下文", "费用", "DAG 模式", "目标", "待办 1/3", "服务", "⌃B 关闭"].map(at)
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
        (all) => has("85%")(all) && has("MCP 2 connected")(all) && has("Todo 1/3")(all) && has("Cache r")(all),
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
      const lines = await column(harness, 120, (all) => has("$0.00")(all) && has("⌃B 关闭")(all), "the drawer")
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

describe("the context of a model that declares no window", () => {
  // The model has no `limit.context`, but the server's profile reads as the default 128,000-token window: the drawer
  // measures against it and marks the figures as an estimate. 1,009 input and 1 output tokens are 1,010 of it, 1%.
  const UNKNOWN = { limit: { context: 0, output: 100 }, profile: { sources: {} } }

  for (const language of ["zh-CN", "en"] as const) {
    for (const aw of [1, 2] as const) {
      test(`shows the default window and the share with a ~ at 80 columns, ${language}, ambiguous_width ${aw}`, async () => {
        setLanguage(language)
        const harness = await mountDrawer({
          width: 80,
          language,
          kv: { ambiguous_width: aw },
          data: { context: { [ROOT]: 1_009 }, model: UNKNOWN },
        })
        try {
          const lines = await column(harness, 80, has("~1%"), "the context")
          expect(lines.some((line) => line.includes("1,010 / ~128,000 tokens"))).toBe(true)
          for (const line of lines) expect(cellWidth(line, aw)).toBeLessThanOrEqual(DRAWER_WIDTH)
          const frame = await harness.waitForFrame(() => true, "the frame")
          for (const row of rowsOf(frame)) expect(row.slice(0, 80 - DRAWER_WIDTH).trim()).toBe("")
        } finally {
          await harness.dispose()
        }
      })
    }
  }

  test("shows a window the profile declares as it is, without a ~", async () => {
    const harness = await mountDrawer({
      data: {
        context: { [ROOT]: 1_009 },
        model: {
          limit: { context: 200_000, output: 100 },
          profile: { context: 200_000, sources: { context: "catalog" } },
        },
      },
    })
    try {
      const lines = await column(harness, 120, has("1%"), "the context")
      expect(lines.some((line) => line.includes("1,010 / 200,000 tokens"))).toBe(true)
      expect(has("~")(lines)).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  test("measures against the effective window the user set, without a ~", async () => {
    const harness = await mountDrawer({
      data: {
        context: { [ROOT]: 49_999 },
        model: {
          limit: { context: 200_000, output: 100 },
          profile: { context: 200_000, effectiveContext: 100_000, sources: { context: "catalog" } },
        },
      },
    })
    try {
      const lines = await column(harness, 120, has("50%"), "the context")
      expect(lines.some((line) => line.includes("50,000 / 100,000 tokens"))).toBe(true)
      expect(has("~")(lines)).toBe(false)
    } finally {
      await harness.dispose()
    }
  })
})

describe("a sub-agent session's drawer", () => {
  test("follows the sub-agent for context and todo, and shows the root session's goal and the tree's cost", async () => {
    const harness = await mountDrawer({
      sessionID: CHILD,
      data: {
        goal: GOAL,
        todo: { [ROOT]: FULL.todo![ROOT], [CHILD]: [{ content: "子任务待办", status: "pending", priority: "high" }] },
        context: { [ROOT]: 849, [CHILD]: 499 },
        usage: FULL.usage,
      },
    })
    try {
      const lines = await column(
        harness,
        120,
        (all) => has("子任务待办")(all) && has("全部依赖")(all) && has("50%")(all) && has("本会话")(all),
        "the sub-agent's drawer",
      )
      expect(has("跑 CI")(lines)).toBe(false)
      expect(has("85%")(lines)).toBe(false)
      expect(has("DAG 模式")(lines)).toBe(false)
      // The cost is the tree's, the root's own figure is not shown; the sub-agent's own comes last.
      expect(has("$1.50")(lines)).toBe(true)
      expect(lines.some((line) => line.trim() === "本会话 $0.25")).toBe(true)
    } finally {
      await harness.dispose()
    }
  })
})

// ── The cost section (#1475) ────────────────────────────────────────────────────────────────────────────────────
//
// The cost and the tokens of the whole task tree the screen's session belongs to, read for the tree's root: the same
// figures whichever session of the tree is on screen. A sub-agent's screen adds what that session used by itself.

const COST_SECTION = ["费用", "$1.50", "输入 12K · 输出 3.4K", "推理 800", "缓存 读 1.2M · 写 30K"]

/** The `count` lines of a drawer column from the cost heading on, trimmed: the heading and the lines under it. */
function costSection(lines: string[], count: number) {
  const from = lines.findIndex((line) => line.trim() === "费用" || line.trim() === "Cost")
  return from === -1 ? [] : lines.slice(from, from + count).map((line) => line.trim())
}

describe("the cost section", () => {
  test("shows the tree's cost and tokens, not the root session's own figure", async () => {
    // The root session row says $1.50 on its own; the tree, with its sub-agents, has cost more.
    const harness = await mountDrawer({
      data: { usage: usageFixture(ROOT, { cost: 4.25, tokens: FULL.usage!.tokens }) },
    })
    try {
      const lines = await column(harness, 120, has("缓存 读"), "the cost section")
      expect(costSection(lines, 5)).toEqual([
        "费用",
        "$4.25",
        "输入 12K · 输出 3.4K",
        "推理 800",
        "缓存 读 1.2M · 写 30K",
      ])
      expect(has("$1.50")(lines)).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  test("is the same on a sub-agent's screen, with the session's own cost under it", async () => {
    const harness = await mountDrawer({ sessionID: CHILD, data: { usage: FULL.usage } })
    try {
      const lines = await column(harness, 120, has("本会话"), "the cost section")
      expect(costSection(lines, 6)).toEqual([...COST_SECTION, "本会话 $0.25"])
      // It asked for the root's usage: one read, for the root, never for the sub-agent.
      expect(harness.requested.filter((request) => request.endsWith("/usage"))).toEqual([`GET /session/${ROOT}/usage`])
    } finally {
      await harness.dispose()
    }
  })

  test("says the same in English", async () => {
    setLanguage("en")
    const harness = await mountDrawer({ language: "en", sessionID: CHILD, data: { usage: FULL.usage } })
    try {
      const lines = await column(harness, 120, has("This session"), "the cost section")
      expect(costSection(lines, 6)).toEqual([
        "Cost",
        "$1.50",
        "In 12K · Out 3.4K",
        "Reasoning 800",
        "Cache r 1.2M · w 30K",
        "This session $0.25",
      ])
    } finally {
      await harness.dispose()
    }
  })

  for (const [language, unknown] of [
    ["zh-CN", "未知"],
    ["en", "unknown"],
  ] as const) {
    test(`names a price nobody has instead of showing it as free, ${language}`, async () => {
      setLanguage(language)
      const known = await mountDrawer({
        language,
        data: { usage: usageFixture(ROOT, { cost: 1.5, costUnknown: true }) },
      })
      try {
        const lines = await column(known, 120, has(unknown), "the unknown cost")
        expect(costSection(lines, 5)[1]).toBe(`$1.50 + ${unknown}`)
      } finally {
        await known.dispose()
      }

      // Nothing priced at all: the word alone, never `$0.00`.
      const none = await mountDrawer({
        language,
        sessionID: CHILD,
        // The sub-agent recorded tokens at no cost; so did the tree.
        child: { cost: 0, tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } },
        data: { usage: usageFixture(ROOT, { cost: 0, costUnknown: true }) },
      })
      try {
        const lines = await column(none, 120, has(language === "en" ? "This session" : "本会话"), "the unknown cost")
        const section = costSection(lines, 6)
        expect(section[1]).toBe(unknown)
        expect(section[5]).toBe(language === "en" ? `This session ${unknown}` : `本会话 ${unknown}`)
        expect(has("$0.00")(lines)).toBe(false)
      } finally {
        await none.dispose()
      }
    })
  }

  test("keeps a fraction of a cent: $0.0027 is not $0.00", async () => {
    const harness = await mountDrawer({ data: { usage: usageFixture(ROOT, { cost: 0.0027 }) } })
    try {
      const lines = await column(harness, 120, has("缓存 读"), "the cost section")
      expect(costSection(lines, 5)[1]).toBe("$0.0027")
    } finally {
      await harness.dispose()
    }
  })

  test("is a dash, and nothing else, until the usage is read; a failed read leaves it so", async () => {
    const before = failedFor(ROOT).length
    const harness = await mountDrawer({ data: FULL, usage: () => new Response("nope", { status: 500 }) })
    try {
      // The read the drawer made as it opened got an error for an answer; the failure was dealt with and logged.
      await harness.usageReads.answered()
      await waitFor(() => failedFor(ROOT).length > before, 5000)
      expect(failedFor(ROOT).at(-1)).toContain(`Loading the usage failed { sessionID: '${ROOT}', status: 500 }`)
      expect(harness.usageReads.asked()).toEqual([ROOT])
      // The section is what it was before the read: a dash.
      const lines = await column(harness, 120, has("MCP 已连接"), "the drawer")
      expect(costSection(lines, 2)).toEqual(["费用", "—"])
    } finally {
      await harness.dispose()
    }
  })

  test("is read again when a turn settles in the tree, and shows the new figures", async () => {
    let cost = 1.5
    const harness = await mountDrawer({
      sessionID: CHILD,
      data: FULL,
      usage: () => usageFixture(ROOT, { cost, tokens: FULL.usage!.tokens }),
    })
    try {
      await column(harness, 120, has("$1.50"), "the first figures")
      expect(harness.usageReads.asked()).toEqual([ROOT])
      cost = 2.75
      harness.deliver(settledTurn(CHILD))
      // Asked for in the handler of the event: the sub-agent's turn settled, and the read is the root's.
      expect(harness.usageReads.asked()).toEqual([ROOT, ROOT])
      const lines = await column(harness, 120, has("$2.75"), "the new figures")
      expect(has("$1.50")(lines)).toBe(false)
      await harness.usageReads.answered()
      expect(usageRequests(harness)).toEqual([`GET /session/${ROOT}/usage`, `GET /session/${ROOT}/usage`])
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("is read only while the drawer is open: closed, a settled turn asks for nothing; opened again, it reads", async () => {
    const [open, setOpen] = createSignal(true)
    const harness = await mountDrawer({
      data: FULL,
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
    })
    try {
      await column(harness, 120, has("缓存 读"), "the open drawer")
      expect(harness.usageReads.asked()).toEqual([ROOT])

      setOpen(false)
      await harness.waitForFrame((frame) => !frame.includes("上下文"), "the closed drawer")
      // Delivered now, so the handlers have run when `deliver` returns: a read they would have triggered is asked for.
      harness.deliver(settledTurn(ROOT))
      harness.deliver(settledTurn(CHILD))
      expect(harness.sync().data.turn_settled[CHILD]).toBeDefined()
      // A reconnect while it is closed asks for nothing either.
      harness.events.reconnect()
      expect(harness.usageReads.asked()).toEqual([ROOT])
      await harness.usageReads.answered()
      expect(usageRequests(harness)).toEqual([`GET /session/${ROOT}/usage`])

      setOpen(true)
      await column(harness, 120, has("缓存 读"), "the drawer opened again")
      expect(harness.usageReads.asked()).toEqual([ROOT, ROOT])
      await harness.usageReads.answered()
      expect(usageRequests(harness)).toHaveLength(2)
    } finally {
      await harness.dispose()
    }
  })

  test("follows the tree on screen: another tree's usage is read when it comes up, and the old one is let go", async () => {
    const OTHER = "ses_content_other"
    const [shown, setShown] = createSignal(ROOT)
    const harness = await mountDrawer({
      data: FULL,
      sessions: [
        sessionFixture(ROOT, { title: "依赖升级", cost: 1.5, time: { created: 1, updated: 9 } }),
        sessionFixture(CHILD, { parentID: ROOT, title: "子任务", cost: 0.25 }),
        sessionFixture(OTHER, { title: "另一棵树", cost: 7.5 }),
      ],
      usage: (id) => usageFixture(id, { cost: id === OTHER ? 7.5 : 1.5, tokens: FULL.usage!.tokens }),
      view: () => (
        <>
          <Bindings />
          <Drawer>
            <SessionDrawer sessionID={shown()} />
          </Drawer>
        </>
      ),
    })
    try {
      await column(harness, 120, has("$1.50"), "the first tree")
      expect(harness.usageReads.asked()).toEqual([ROOT])

      setShown(OTHER)
      await column(harness, 120, has("$7.50"), "the other tree")
      expect(harness.usageReads.asked()).toEqual([ROOT, OTHER])

      // The first tree is let go: a turn settling in it asks for nothing, one in the tree on screen does.
      harness.deliver(settledTurn(CHILD))
      expect(harness.sync().data.turn_settled[CHILD]).toBeDefined()
      expect(harness.usageReads.asked()).toEqual([ROOT, OTHER])
      harness.deliver(settledTurn(OTHER))
      expect(harness.usageReads.asked()).toEqual([ROOT, OTHER, OTHER])
      await harness.usageReads.answered()
      expect(usageRequests(harness)).toEqual([
        `GET /session/${ROOT}/usage`,
        `GET /session/${OTHER}/usage`,
        `GET /session/${OTHER}/usage`,
      ])
    } finally {
      await harness.dispose()
    }
  })

  test("listens to no clock: with the section on screen the ticker has no subscriber, and the figures arrive once", async () => {
    const clock = clockTicker(NOW)
    const harness = await mountDrawer({ data: FULL, ticker: clock.ticker })
    try {
      await column(harness, 120, has("缓存 读"), "the cost section")
      expect(clock.calls).toEqual({ frame: 0, second: 0, released: 0 })
      // Ten minutes go by on the clock the drawer would listen to. Nothing polls: the one read the section made as it
      // opened is the only one.
      clock.advance(10 * 60_000)
      expect(harness.usageReads.asked()).toEqual([ROOT])
      await harness.usageReads.answered()
      expect(usageRequests(harness)).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })

  test("a click anywhere in the section sends nothing and asks for nothing more", async () => {
    const harness = await mountDrawer({ sessionID: CHILD, data: FULL })
    try {
      const before = await column(harness, 120, has("本会话"), "the cost section")
      expect(harness.usageReads.asked()).toEqual([ROOT])
      // The section is at the top of the column: rows 1 to 14 cover it, whatever its height.
      for (let row = 1; row <= 14; row++) await harness.app.mockMouse.click(120 - DRAWER_WIDTH + 4, row)
      // A click that asked for a read did so as it was handled.
      expect(harness.usageReads.asked()).toEqual([ROOT])
      expect(columnOf(await harness.waitForFrame(() => true, "the frame"), 120)).toEqual(before)
      expect(harness.writes()).toEqual([])
      expect(harness.commands()).toEqual([])
      await harness.usageReads.answered()
      expect(usageRequests(harness)).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })
})

// ── The fixed-overhead section (#1461) ──────────────────────────────────────────────────────────────────────────────
//
// What every request of the session on screen carries besides its messages: the total with its share of the model's
// window, and the five largest sources under it. It sits after the context and follows the session on screen, a
// sub-agent's included. It is hidden until the server reports an overhead, and read only while the drawer is open.

const hash = "0123456789abcdef"

/** What the server reports for the root's latest request: the tools are the largest source, seven in all. */
const OVERHEAD_ROOT: SessionOverhead = {
  bytes: 52_200,
  tokens: 17_400,
  model: "test/window",
  window: 100_000,
  windowSource: "config",
  ratio: 0.174,
  sources: [
    { source: "base", bytes: 6_000, tokens: 2_000, hash },
    { source: "tools", bytes: 36_000, tokens: 12_000, hash },
    { source: "instructions", label: "AGENTS.md", bytes: 3_600, tokens: 1_200, hash },
    { source: "environment", bytes: 900, tokens: 300, hash },
    { source: "runtime_note", bytes: 2_700, tokens: 900, hash },
    { source: "skills", bytes: 2_100, tokens: 700, hash },
    { source: "hooks", bytes: 900, tokens: 300, hash },
  ],
}

/** What it reports for the sub-agent: a smaller request, and not the root's. */
const OVERHEAD_CHILD: SessionOverhead = {
  bytes: 7_500,
  tokens: 2_500,
  model: "test/window",
  window: 100_000,
  windowSource: "config",
  ratio: 0.03,
  sources: [{ source: "tools", bytes: 6_000, tokens: 2_000, hash }],
}

const OVERHEAD_ROWS = [
  "≈12,000 tools",
  "≈2,000 base",
  "≈1,200 instructions AGENTS.md",
  "≈900 runtime_note",
  "≈700 skills",
]

/** The `count` lines of a drawer column from the fixed-overhead heading on, trimmed: the heading and what is under it. */
function overheadBlock(lines: string[], count: number) {
  const from = lines.findIndex((line) => line.trim() === "固定开销" || line.trim() === "Fixed overhead")
  return from === -1 ? [] : lines.slice(from, from + count).map((line) => line.trim())
}

describe("the fixed-overhead section", () => {
  for (const width of [80, 120]) {
    test(`sits after the context and before the cost, with the total and the five largest sources, ${width} columns`, async () => {
      const harness = await mountDrawer({ width, data: { ...FULL, overhead: { [ROOT]: OVERHEAD_ROOT } } })
      try {
        const lines = await column(harness, width, (all) => has("≈17,400")(all) && has("缓存 读")(all), "the section")
        expect(lines).toMatchSnapshot()
        expect(overheadBlock(lines, 7)).toEqual(["固定开销", "≈17,400 tokens · 17%", ...OVERHEAD_ROWS])
        const at = (needle: string) => lines.findIndex((line) => line.includes(needle))
        const order = ["依赖升级", "上下文", "固定开销", "费用", "DAG 模式", "目标"].map(at)
        expect(order.every((index) => index >= 0)).toBe(true)
        expect([...order].sort((a, b) => a - b)).toEqual(order)
        // The two smallest sources are left out.
        expect(has("hooks")(lines)).toBe(false)
        expect(harness.writes()).toEqual([])
      } finally {
        await harness.dispose()
      }
    })
  }

  test("says the same in English", async () => {
    setLanguage("en")
    const harness = await mountDrawer({ language: "en", data: { ...FULL, overhead: { [ROOT]: OVERHEAD_ROOT } } })
    try {
      const lines = await column(harness, 120, (all) => has("≈17,400")(all) && has("Cache r")(all), "the section")
      expect(lines).toMatchSnapshot()
      expect(overheadBlock(lines, 7)).toEqual(["Fixed overhead", "≈17,400 tokens · 17%", ...OVERHEAD_ROWS])
    } finally {
      await harness.dispose()
    }
  })

  test("is hidden, and takes no gap, while the server reports nothing", async () => {
    const harness = await mountDrawer({ data: FULL })
    try {
      await column(harness, 120, has("缓存 读"), "the drawer")
      // The server was asked, and said that nothing had been sent: zeros.
      await harness.overheadReads.answered()
      expect(harness.overheadReads.asked()).toEqual([ROOT])
      const rows = rowsOf(await harness.waitForFrame(() => true, "the frame")).map((line) =>
        line.slice(120 - DRAWER_WIDTH).trimEnd(),
      )
      expect(rows.some((line) => line.includes("固定开销"))).toBe(false)
      // The cost follows the context after the one blank row every section is set off by.
      const cost = rows.findIndex((line) => line.trim() === "费用")
      expect(rows[cost - 1]?.trim()).toBe("")
      expect(rows[cost - 2]).toContain("85%")
    } finally {
      await harness.dispose()
    }
  })

  test("marks the share with a ~ when the window is the assumed one", async () => {
    const assumed: SessionOverhead = { ...OVERHEAD_ROOT, window: 128_000, windowSource: "default", ratio: 0.3 }
    const harness = await mountDrawer({ data: { ...FULL, overhead: { [ROOT]: assumed } } })
    try {
      const lines = await column(harness, 120, has("≈17,400"), "the section")
      expect(overheadBlock(lines, 2)).toEqual(["固定开销", "≈17,400 tokens · ~30%"])
    } finally {
      await harness.dispose()
    }
  })

  test("follows the session on screen: a sub-agent shows its own, read for that session and not for the root", async () => {
    const harness = await mountDrawer({
      sessionID: CHILD,
      data: { ...FULL, overhead: { [ROOT]: OVERHEAD_ROOT, [CHILD]: OVERHEAD_CHILD } },
    })
    try {
      const lines = await column(harness, 120, has("≈2,500"), "the sub-agent's section")
      expect(overheadBlock(lines, 3)).toEqual(["固定开销", "≈2,500 tokens · 3%", "≈2,000 tools"])
      expect(has("≈17,400")(lines)).toBe(false)
      expect(harness.overheadReads.asked()).toEqual([CHILD])
      await harness.overheadReads.answered()
      expect(overheadRequests(harness)).toEqual([`GET /session/${CHILD}/overhead`])
    } finally {
      await harness.dispose()
    }
  })

  test("is read again when a turn settles in the session, and shows the new figures", async () => {
    let tokens = 17_400
    const harness = await mountDrawer({
      data: FULL,
      overhead: () => ({ ...OVERHEAD_ROOT, tokens, ratio: tokens / 100_000 }),
    })
    try {
      await column(harness, 120, has("≈17,400 tokens"), "the first figures")
      expect(harness.overheadReads.asked()).toEqual([ROOT])
      tokens = 21_000
      harness.deliver(settledTurn(ROOT))
      // Asked for in the handler of the event.
      expect(harness.overheadReads.asked()).toEqual([ROOT, ROOT])
      const lines = await column(harness, 120, has("≈21,000 tokens"), "the new figures")
      expect(has("≈17,400 tokens")(lines)).toBe(false)
      expect(has("21%")(lines)).toBe(true)
      await harness.overheadReads.answered()
      expect(overheadRequests(harness)).toEqual([`GET /session/${ROOT}/overhead`, `GET /session/${ROOT}/overhead`])
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("a turn that settles in another session of the tree asks for nothing", async () => {
    const harness = await mountDrawer({ data: { ...FULL, overhead: { [ROOT]: OVERHEAD_ROOT } } })
    try {
      await column(harness, 120, has("≈17,400"), "the section")
      harness.deliver(settledTurn(CHILD))
      expect(harness.sync().data.turn_settled[CHILD]).toBeDefined()
      expect(harness.overheadReads.asked()).toEqual([ROOT])
      await harness.overheadReads.answered()
      expect(overheadRequests(harness)).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })

  test("is read only while the drawer is open: closed, a settled turn asks for nothing; opened again, it reads", async () => {
    const [open, setOpen] = createSignal(true)
    const harness = await mountDrawer({
      data: { ...FULL, overhead: { [ROOT]: OVERHEAD_ROOT } },
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
    })
    try {
      await column(harness, 120, has("≈17,400"), "the open drawer")
      expect(harness.overheadReads.asked()).toEqual([ROOT])

      setOpen(false)
      await harness.waitForFrame((frame) => !frame.includes("上下文"), "the closed drawer")
      // Delivered now, so the handlers have run when `deliver` returns: a read they would have triggered is asked for.
      harness.deliver(settledTurn(ROOT))
      harness.deliver(settledTurn(CHILD))
      // A reconnect while it is closed asks for nothing either.
      harness.events.reconnect()
      expect(harness.overheadReads.asked()).toEqual([ROOT])
      await harness.overheadReads.answered()
      expect(overheadRequests(harness)).toEqual([`GET /session/${ROOT}/overhead`])

      setOpen(true)
      await column(harness, 120, has("≈17,400"), "the drawer opened again")
      expect(harness.overheadReads.asked()).toEqual([ROOT, ROOT])
      await harness.overheadReads.answered()
      expect(overheadRequests(harness)).toHaveLength(2)
    } finally {
      await harness.dispose()
    }
  })

  test("follows the screen: another session's overhead is read when it comes up, and the old one is let go", async () => {
    const OTHER = "ses_content_other"
    const [shown, setShown] = createSignal(ROOT)
    const harness = await mountDrawer({
      data: {
        ...FULL,
        overhead: { [ROOT]: OVERHEAD_ROOT, [OTHER]: { ...OVERHEAD_CHILD, tokens: 3_300, ratio: 0.033 } },
      },
      sessions: [
        sessionFixture(ROOT, { title: "依赖升级", cost: 1.5, time: { created: 1, updated: 9 } }),
        sessionFixture(CHILD, { parentID: ROOT, title: "子任务", cost: 0.25 }),
        sessionFixture(OTHER, { title: "另一个会话", cost: 7.5 }),
      ],
      view: () => (
        <>
          <Bindings />
          <Drawer>
            <SessionDrawer sessionID={shown()} />
          </Drawer>
        </>
      ),
    })
    try {
      await column(harness, 120, has("≈17,400"), "the first session")
      expect(harness.overheadReads.asked()).toEqual([ROOT])

      setShown(OTHER)
      await column(harness, 120, has("≈3,300"), "the other session")
      expect(harness.overheadReads.asked()).toEqual([ROOT, OTHER])

      // The first session is let go: a turn settling in it asks for nothing, one in the session on screen does.
      harness.deliver(settledTurn(ROOT))
      expect(harness.overheadReads.asked()).toEqual([ROOT, OTHER])
      harness.deliver(settledTurn(OTHER))
      expect(harness.overheadReads.asked()).toEqual([ROOT, OTHER, OTHER])
      await harness.overheadReads.answered()
      expect(overheadRequests(harness)).toEqual([
        `GET /session/${ROOT}/overhead`,
        `GET /session/${OTHER}/overhead`,
        `GET /session/${OTHER}/overhead`,
      ])
    } finally {
      await harness.dispose()
    }
  })

  test("a failed read leaves it hidden, says so in the log, and the next turn reads again", async () => {
    const before = overheadFailedFor(ROOT).length
    let answer: Response | SessionOverhead = new Response("nope", { status: 500 })
    const harness = await mountDrawer({ data: FULL, overhead: () => answer })
    try {
      await harness.overheadReads.answered()
      await waitFor(() => overheadFailedFor(ROOT).length > before, 5000)
      expect(overheadFailedFor(ROOT).at(-1)).toContain(
        `Loading the fixed overhead failed { sessionID: '${ROOT}', status: 500 }`,
      )
      const lines = await column(harness, 120, has("缓存 读"), "the drawer")
      expect(has("固定开销")(lines)).toBe(false)

      answer = OVERHEAD_ROOT
      harness.deliver(settledTurn(ROOT))
      await column(harness, 120, has("≈17,400"), "the section after the next turn")
      expect(harness.overheadReads.asked()).toEqual([ROOT, ROOT])
    } finally {
      await harness.dispose()
    }
  })

  test("listens to no clock: with the section on screen the ticker has no subscriber, and the figures arrive once", async () => {
    const clock = clockTicker(NOW)
    const harness = await mountDrawer({ data: { ...FULL, overhead: { [ROOT]: OVERHEAD_ROOT } }, ticker: clock.ticker })
    try {
      await column(harness, 120, has("≈17,400"), "the section")
      expect(clock.calls).toEqual({ frame: 0, second: 0, released: 0 })
      // Ten minutes go by on the clock the drawer would listen to. Nothing polls: the one read the section made as it
      // opened is the only one.
      clock.advance(10 * 60_000)
      expect(harness.overheadReads.asked()).toEqual([ROOT])
      await harness.overheadReads.answered()
      expect(overheadRequests(harness)).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })

  test("a click anywhere in the section sends nothing and asks for nothing more", async () => {
    const harness = await mountDrawer({ data: { ...FULL, overhead: { [ROOT]: OVERHEAD_ROOT } } })
    try {
      const before = await column(harness, 120, has("≈17,400"), "the section")
      expect(harness.overheadReads.asked()).toEqual([ROOT])
      for (let row = 1; row <= 16; row++) await harness.app.mockMouse.click(120 - DRAWER_WIDTH + 4, row)
      expect(harness.overheadReads.asked()).toEqual([ROOT])
      expect(columnOf(await harness.waitForFrame(() => true, "the frame"), 120)).toEqual(before)
      expect(harness.writes()).toEqual([])
      expect(harness.commands()).toEqual([])
      await harness.overheadReads.answered()
      expect(overheadRequests(harness)).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })

  test("writes only its own slice: no message or part of the store changes", async () => {
    const harness = await mountDrawer({ data: { ...FULL, overhead: { [ROOT]: OVERHEAD_ROOT } } })
    try {
      await column(harness, 120, has("≈17,400"), "the section")
      const probe = probeStoreWrites(harness.sync().data, ["message", "part"])
      try {
        harness.deliver(settledTurn(ROOT))
        await harness.overheadReads.answered()
        await harness.settle()
        expect(probe.total()).toBe(0)
      } finally {
        probe.dispose()
      }
    } finally {
      await harness.dispose()
    }
  })
})

/** The worst the server can say: sources of the largest figures under a path that fills a line several times over. */
const OVERHEAD_WORST: SessionOverhead = {
  bytes: 999_999_999_999,
  tokens: 999_999_999_999,
  model: "test/window",
  window: 128_000,
  windowSource: "default",
  ratio: 7_812_499.99,
  sources: ["base", "tools", "instructions", "mcp_instructions", "skills", "hooks"].map((name) => ({
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the fixture names real sources.
    source: name as SessionOverhead["sources"][number]["source"],
    label: "/very/long/path/to/some/rules/".repeat(4),
    bytes: 999_999_999_999,
    tokens: 999_999_999_999,
    hash,
  })),
}

for (const aw of [1, 2] as const) {
  for (const language of ["zh-CN", "en"] as const) {
    test(`every row of the fixed-overhead section fits its 40 columns at 80 columns, ${language}, ambiguous_width ${aw}`, async () => {
      setLanguage(language)
      const heading = language === "en" ? "Fixed overhead" : "固定开销"
      const harness = await mountDrawer({
        width: 80,
        language,
        kv: { ambiguous_width: aw },
        data: { ...FULL, overhead: { [ROOT]: OVERHEAD_WORST } },
      })
      try {
        const lines = await column(harness, 80, has("≈999,999,999,999 tokens"), "the section")
        expect(overheadBlock(lines, 7)[0]).toBe(heading)
        for (const line of lines) expect(cellWidth(line, aw)).toBeLessThanOrEqual(DRAWER_WIDTH)
        // The columns left of the drawer are the main area's: nothing of the drawer spills into them.
        const frame = await harness.waitForFrame(() => true, "the frame")
        for (const row of rowsOf(frame)) expect(row.slice(0, 80 - DRAWER_WIDTH).trim()).toBe("")
      } finally {
        await harness.dispose()
      }
    })
  }
}

/** The worst a tree can say: a cost with a part nobody priced and figures that need every digit. */
const WORST = usageFixture(ROOT, {
  cost: 12_345.67,
  costUnknown: true,
  tokens: {
    input: 987_654_321,
    output: 123_456_789,
    reasoning: 999_999_999,
    cache: { read: 888_888_888, write: 777_777_777 },
  },
})

for (const width of [80, 120] as const) {
  for (const aw of [1, 2] as const) {
    for (const language of ["zh-CN", "en"] as const) {
      for (const [screen, sessionID] of [
        ["the root", ROOT],
        ["a sub-agent", CHILD],
      ] as const) {
        test(`every drawer row fits its 40 columns at ${width} columns, ${screen}, ${language}, ambiguous_width ${aw}`, async () => {
          setLanguage(language)
          const mark = language === "en" ? "Cache r" : "缓存 读"
          const harness = await mountDrawer({
            width,
            language,
            sessionID,
            kv: { ambiguous_width: aw },
            data: { ...FULL, context: { [ROOT]: 849, [CHILD]: 849 }, usage: WORST },
          })
          try {
            const lines = await column(harness, width, (all) => has("85%")(all) && has(mark)(all), "the drawer")
            // The cost section is on screen with its figures, so the widths below measure it.
            expect(has("$12,345.67")(lines)).toBe(true)
            for (const line of lines) expect(cellWidth(line, aw)).toBeLessThanOrEqual(DRAWER_WIDTH)
            // The columns left of the drawer are the main area's: nothing of the drawer spills into them.
            const frame = await harness.waitForFrame(() => true, "the frame")
            for (const row of rowsOf(frame)) expect(row.slice(0, width - DRAWER_WIDTH).trim()).toBe("")
          } finally {
            await harness.dispose()
          }
        })
      }
    }
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

// The text of a line of the drawer is `DRAWER_TEXT_CELLS` wide (#1672): a line the section cuts ends with its ellipsis in
// the last of those cells, after the inset the view pads with, and the drawer clips none of it.
test("a line cut to the width of the drawer's text ends in the last cell the drawer leaves for text", async () => {
  const clock = clockTicker(NOW)
  const harness = await mountDrawer({ width: 80, data: FULL, ticker: clock.ticker })
  try {
    seedRun(harness.sync(), {
      parent: ROOT,
      key: "long",
      state: "queued",
      kind: "explore",
      description: "x".repeat(120),
    })
    const lines = await column(harness, 80, has("xxxx"), "the background section")
    const line = lines.find((candidate) => candidate.includes("xxxx")) ?? ""
    expect(line).toContain("…")
    expect(cellWidth(line.slice(0, line.indexOf("…") + 1))).toBe(DRAWER_INSET + DRAWER_TEXT_CELLS)
  } finally {
    await harness.dispose()
  }
})

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
