// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import type { DagNode, DagWorkflowSummary, GlobalEvent, Goal } from "@graphagent/sdk"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { setLanguage } from "../../src/i18n"
import { GUTTER, NARROW_WIDTH } from "../../src/ui/layout"
import { readSpans, renderUntilFrame } from "../fixture/frames"
import { promptShown, runApp, type Setup } from "../fixture/run-app"
import { assistantMessage, textPart, userMessage } from "../fixture/session-records"
import { directory, json, type FetchHandler } from "../fixture/tui-sdk"
import { sessionFixture } from "../routes/dag-mode-harness"

// The layout guard (#1671, spec #1669 13.1, 13.3, 13.4): the regions of the session screen keep the same gutters.
// A row of text without a frame (the top bar, the status band, the line under the input, the footer) starts in column 2
// and ends by column `W-3`; the frames of the input, of a panel and of an ask are the same width, with their borders in
// column 2 and column `W-3`; nothing is painted in columns 0, 1, `W-2` and `W-1`. Each case runs the real app through
// the three states of the bottom zone with the drawer closed, and measures the painted cells, not the characters of the
// frame: a wide character takes two.

afterEach(() => {
  setLanguage("zh-CN")
})

const mainID = "ses_guard_main"
const WORKFLOW = "release-check"
const GOAL_TEXT = "ship the release"
const USAGE = "1.2K · $1.50"
const FRAME_ROW = /^[╭│╰]/

const CASES = [
  { width: 80, height: 24, ambiguousWidth: 1 },
  { width: 80, height: 24, ambiguousWidth: 2 },
  { width: 120, height: 40, ambiguousWidth: 1 },
] as const

function wire(id: string, status: string, depends: string[] = []): DagNode {
  return {
    id,
    workflow_id: "dag_guard",
    name: id,
    worker_type: "task",
    status,
    required: false,
    depends_on: depends,
    replan_attempts: 0,
  }
}

const WORKFLOW_SUMMARY: DagWorkflowSummary = {
  id: "dag_guard",
  title: WORKFLOW,
  status: "running",
  graphRev: 1,
  nodeCount: 3,
  completedNodes: 1,
  runningNodes: 1,
  failedNodes: 0,
  skippedNodes: 0,
  abortedNodes: 0,
  queuedNodes: 1,
  escalatedNodes: 0,
}

const GOAL: Goal = { goal: GOAL_TEXT, status: "active", turnsUsed: 3, maxTurns: 30 }

const USER_TEXT = "Check that every region of the screen keeps the same margin at both sides."
const ANSWER_TEXT =
  "Each region now starts in the third column and ends in the third column from the right edge, so the transcript, " +
  "the status band, the input and the footer line up with the panels that open above the input."

const TOKENS = { input: 1000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } }

/** The server of the case: a session with a short transcript, a workflow and a goal, which fills every region. */
const server: FetchHandler = (url) => {
  const summary = url.pathname.match(/^\/dag\/session\/([^/]+)\/summary$/)
  if (summary) return json(summary[1] === mainID ? [WORKFLOW_SUMMARY] : [])
  if (/^\/dag\/[^/]+\/nodes$/.test(url.pathname)) {
    return json([wire("a", "completed"), wire("b", "running", ["a"]), wire("c", "queued", ["b"])])
  }
  if (url.pathname === `/session/${mainID}/goal`) return json(GOAL)
  if (url.pathname === `/session/${mainID}/message`) {
    return json([
      {
        info: userMessage("msg_guard_user", mainID, 10),
        parts: [textPart("msg_guard_user", mainID, "prt_u", USER_TEXT)],
      },
      {
        // A model the provider list does not know: the usage line gives the tokens and no share of a window.
        info: {
          ...assistantMessage("msg_guard_assistant", mainID, "msg_guard_user", 11),
          modelID: "unlisted",
          tokens: TOKENS,
        },
        parts: [textPart("msg_guard_assistant", mainID, "prt_a", ANSWER_TEXT)],
      },
    ])
  }
  return undefined
}

const session = sessionFixture(mainID, { title: "Layout guard", cost: 1.5, tokens: TOKENS })

/** One painted row: its text, and the first and the last column that hold a character other than a space. */
interface Row {
  index: number
  text: string
  first?: number
  last?: number
}

/**
 * The rows of a frame as painted. A span carries the cells it covers (`width`), which is not its length: a wide
 * character is one character and two cells. Spaces are one cell each, so the blank cells at either end of a span
 * are counted by their number.
 */
function paintedRows(frame: Awaited<ReturnType<typeof readSpans>>): Row[] {
  return frame.lines.map((line, index) => {
    const row: Row = { index, text: "" }
    let column = 0
    for (const span of line.spans) {
      row.text += span.text
      if (span.text.trim() !== "") {
        row.first ??= column + span.text.length - span.text.trimStart().length
        row.last = column + span.width - (span.text.length - span.text.trimEnd().length) - 1
      }
      column += span.width
    }
    return row
  })
}

async function painted(setup: Setup) {
  await setup.renderOnce()
  return paintedRows(await readSpans(setup))
}

const describeRow = (state: string, row: Row) =>
  `${state} · row ${row.index} [${row.first}..${row.last}]: ${row.text.trimEnd()}`

/** The first row of `rows` that holds `text`. */
function rowWith(rows: readonly Row[], text: string) {
  const row = rows.find((item) => item.text.includes(text))
  if (!row) throw new Error(`no row holds ${text}:\n${rows.map((item) => item.text).join("\n")}`)
  return row
}

/** The rows from the first top edge of a framed box to the bottom edge that closes it. */
function frameRows(rows: readonly Row[]) {
  const top = rows.findIndex((row) => row.text.trimStart().startsWith("╭"))
  const bottom = rows.findIndex((row, index) => index > top && row.text.trimStart().startsWith("╰"))
  if (top < 0 || bottom < 0) throw new Error(`no framed box in the frame:\n${rows.map((item) => item.text).join("\n")}`)
  return rows.slice(top, bottom + 1)
}

function collect(root: Renderable, result: Renderable[] = []) {
  result.push(root)
  for (const child of root.getChildren()) collect(child, result)
  return result
}

/** An unmounting prompt keeps its draft in module state; leave nothing for the next test in the process. */
function clearDrafts(setup: Setup) {
  for (const item of collect(setup.renderer.root)) {
    if (item instanceof TextareaRenderable && !item.isDestroyed) item.setText("")
  }
}

function statusEvent(type: "busy" | "idle"): GlobalEvent {
  return {
    directory,
    payload: { id: `evt_guard_${type}`, type: "session.status", properties: { sessionID: mainID, status: { type } } },
  }
}

function permissionEvent(): GlobalEvent {
  return {
    directory,
    payload: {
      id: "evt_guard_ask",
      type: "permission.asked",
      properties: {
        id: "per_000000000001",
        sessionID: mainID,
        permission: "bash",
        patterns: ["npm publish"],
        metadata: {},
        always: [],
      },
    },
  }
}

function repliedEvent(): GlobalEvent {
  return {
    directory,
    payload: {
      id: "evt_guard_replied",
      type: "permission.replied",
      properties: { sessionID: mainID, requestID: "per_000000000001", reply: "once" },
    },
  }
}

/** The first and the last column of the content area, between the gutters. */
function edges(width: number) {
  return { left: GUTTER, right: width - 1 - GUTTER }
}

/** Nothing is painted in the gutters, on any row. */
function expectGuttersClear(rows: readonly Row[], width: number, state: string) {
  const { left, right } = edges(width)
  const drawn = rows.filter((row) => row.first !== undefined && row.last !== undefined)
  expect(drawn.filter((row) => row.first! < left || row.last! > right).map((row) => describeRow(state, row))).toEqual(
    [],
  )
}

/**
 * A row without a frame starts in the first column of the content area and ends by its last; `exactEnd` says it is
 * flush with that column, as a right-aligned text is.
 */
function expectTextRow(row: Row, width: number, state: string, exactEnd: boolean) {
  const { left, right } = edges(width)
  const problems: string[] = []
  if (row.first !== left) problems.push(`starts in column ${row.first}, not ${left}`)
  if (row.last === undefined || (exactEnd ? row.last !== right : row.last > right)) {
    problems.push(`ends in column ${row.last}, ${exactEnd ? "not" : "past"} ${right}`)
  }
  expect(problems.length === 0 ? "" : `${describeRow(state, row)} -> ${problems.join(", ")}`).toBe("")
}

/** A framed box is as wide as the content area: its border is in the first column and in the last, on every row. */
function expectFramed(rows: readonly Row[], width: number, state: string) {
  const { left, right } = edges(width)
  expect(
    rows
      .filter((row) => row.first !== left || row.last !== right || !FRAME_ROW.test(row.text.trimStart()))
      .map((row) => describeRow(state, row)),
  ).toEqual([])
}

/** The rows every state has, whatever the bottom zone holds: the top bar, the status band, the footer. */
function expectChrome(rows: readonly Row[], width: number, ambiguousWidth: 1 | 2, state: string) {
  const { right } = edges(width)
  const wide = width >= NARROW_WIDTH

  const bar = rows[0]
  expect(bar.text).toContain("GraphAgent")
  // From the narrow breakpoint the model sits at the right edge of the bar.
  expectTextRow(bar, width, `${state}: the top bar`, wide)

  expectTextRow(rowWith(rows, WORKFLOW), width, `${state}: the workflow row`, false)
  // Below the breakpoint the band is one row, and the goal is the drawer's.
  if (wide) expectTextRow(rowWith(rows, GOAL_TEXT), width, `${state}: the goal row`, false)
  else expect(rows.some((row) => row.text.includes(GOAL_TEXT))).toBe(false)

  const footer = rows[rows.length - 1]
  expect(footer.text).toContain("build")
  // The hints are flush with the right edge, unless an ambiguous glyph is laid out one cell narrower than budgeted.
  expectTextRow(footer, width, `${state}: the footer`, ambiguousWidth === 1)
  expect(footer.last).toBeLessThanOrEqual(right)
  expectGuttersClear(rows, width, state)
}

for (const { width, height, ambiguousWidth } of CASES) {
  test(`${width}x${height}, ambiguous_width ${ambiguousWidth}: top bar, status band, input, panel, ask and footer share the gutters`, async () => {
    const app = await runApp({
      sessions: [session],
      args: { continue: true },
      width,
      height,
      ambiguousWidth,
      handler: server,
    })
    const { left, right } = edges(width)
    const wide = width >= NARROW_WIDTH
    let asked = false
    try {
      await renderUntilFrame(app.setup, promptShown, "the prompt")
      await renderUntilFrame(
        app.setup,
        (frame) => frame.includes(WORKFLOW) && frame.includes("Each region") && frame.includes(wide ? GOAL_TEXT : ""),
        "the screen",
      )

      // No panel: the input is the bottom zone. The transcript, the band and the footer are inside the gutters too.
      const idle = await painted(app.setup)
      expectChrome(idle, width, ambiguousWidth, "input")
      const input = frameRows(idle)
      expect(input.length).toBe(3)
      expectFramed(input, width, "the input")
      expect(rowWith(idle, "Each region").first).toBeGreaterThanOrEqual(left)

      // The line under the input: the usage figures end at the right edge of the input's frame.
      const below = idle[input[input.length - 1].index + 1]
      expect(below.text).toContain(USAGE)
      expect(below.last).toBe(right)

      // While a turn runs the spinner starts the line, in the first column of the content area.
      app.events.emit(statusEvent("busy"))
      await renderUntilFrame(app.setup, (frame) => frame.includes("interrupt"), "the running turn")
      const busy = await painted(app.setup)
      const status = rowWith(busy, "interrupt")
      expect(status.text).toContain(USAGE)
      expectTextRow(status, width, "the line under the input while a turn runs", true)
      expectGuttersClear(busy, width, "input while a turn runs")
      app.events.emit(statusEvent("idle"))
      await renderUntilFrame(app.setup, (frame) => !frame.includes("interrupt"), "the idle turn")

      // A list panel opened from the input: its frame is as wide as the input's, in the same columns.
      await app.setup.mockInput.typeText("/agents")
      await renderUntilFrame(app.setup, (frame) => frame.includes("子 agent"), "the command popup")
      app.setup.mockInput.pressEnter()
      await renderUntilFrame(app.setup, (frame) => frame.includes("esc 关闭"), "the panel")
      const panel = await painted(app.setup)
      expectChrome(panel, width, ambiguousWidth, "panel")
      const panelFrame = frameRows(panel)
      expectFramed(panelFrame, width, "the panel")
      app.setup.mockInput.pressEscape()
      await renderUntilFrame(app.setup, promptShown, "the input again")

      // A permission ask: the same frame again.
      asked = true
      app.events.emit(permissionEvent())
      await renderUntilFrame(app.setup, (frame) => frame.includes("Bash 需要权限"), "the ask")
      const ask = await painted(app.setup)
      expectChrome(ask, width, ambiguousWidth, "ask")
      const askFrame = frameRows(ask)
      expectFramed(askFrame, width, "the ask")

      // The three frames are the same width, whatever each holds.
      const columns = (rows: readonly Row[]) => ({ first: rows[0].first, last: rows[0].last })
      expect([columns(panelFrame), columns(askFrame)]).toEqual([columns(input), columns(input)])
      expect(columns(input)).toEqual({ first: left, last: right })
    } finally {
      // The quit key of the app rejects a pending ask instead of quitting: the server answers the ask first.
      if (asked) {
        app.events.emit(repliedEvent())
        await renderUntilFrame(app.setup, promptShown, "the input once the ask is answered", 3000).catch(() => {
          // `stop` closes the app all the same, and a failing test is to report its own error, not this wait's.
        })
      }
      clearDrafts(app.setup)
      await app.stop()
    }
  })
}

// The footer is the tightest row at 80 columns: with the gutter it has 76 cells for the agent, the DAG mode and the
// action on the left and the hints on the right. The keys of the first three hints stay whole in both languages, at both
// ambiguous widths, and nothing of the row is cut with an ellipsis; the last hint of the English footer is the one that
// gives way, as it did with the old margin.
const FOOTER_HINTS = {
  "zh-CN": ["⌃P 命令", "⌃B 侧边栏", "⌃O 展开输出"],
  en: ["⌃P commands", "⌃B drawer", "⌃O expand output"],
} as const

for (const language of ["zh-CN", "en"] as const) {
  for (const ambiguousWidth of [1, 2] as const) {
    test(`80x24, ${language}, ambiguous_width ${ambiguousWidth}: the footer keeps its key hints inside the gutters`, async () => {
      const app = await runApp({
        sessions: [session],
        args: { continue: true },
        width: 80,
        height: 24,
        ambiguousWidth,
        handler: (url, request) =>
          language === "en" && url.pathname === "/config" ? json({ language: "en" }) : server(url, request),
      })
      try {
        await renderUntilFrame(app.setup, promptShown, "the prompt")
        const rows = await painted(app.setup)
        const footer = rows[rows.length - 1]
        expectTextRow(footer, 80, `the ${language} footer`, false)
        for (const hint of FOOTER_HINTS[language]) expect(footer.text).toContain(hint)
        expect(footer.text).not.toContain("…")
      } finally {
        clearDrafts(app.setup)
        await app.stop()
      }
    })
  }
}
