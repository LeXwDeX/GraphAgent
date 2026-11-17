// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import type { Goal, Message, Session } from "@graphagent/sdk"
import type { CapturedFrame, RGBA } from "@opentui/core"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { useTuiConfig } from "../../../src/config"
import { DEFAULT_THEME } from "../../../src/context/theme"
import { setLanguage } from "../../../src/i18n"
import { useBindings } from "../../../src/keymap"
import { SessionDrawer } from "../../../src/routes/session/drawer"
import { Drawer, DRAWER_WIDTH } from "../../../src/shell/drawer"
import { DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { cellWidth } from "../../../src/ui/width"
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
