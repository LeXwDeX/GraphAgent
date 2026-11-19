// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import type { DagNode, DagWorkflowSummary, GlobalEvent, Goal } from "@graphagent/sdk"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { setLanguage } from "../src/i18n"
import { cellWidth } from "../src/ui/width"
import {
  captureFrame,
  footerRow,
  promptShown,
  promptTop,
  runApp,
  waitFor,
  waitForFrame,
  type Setup,
} from "./fixture/run-app"
import { assistantMessage, taskCall, textPart, userMessage } from "./fixture/session-records"
import { trustEntry, trusting } from "./fixture/trust"
import { directory, json, type FetchHandler } from "./fixture/tui-sdk"
import { sessionFixture } from "./routes/dag-mode-harness"

// The real app against a fake server: the status band sits between the main area and the prompt, takes a row only
// while it has something to say, and follows the root session whichever view of its tree is on screen (#1032 F4).

const mainID = "ses_band_main"
const childID = "ses_band_sub"

afterEach(() => {
  setLanguage("zh-CN")
})

function wire(workflow: string, id: string, status: string, depends: string[] = []): DagNode {
  return {
    id,
    workflow_id: workflow,
    name: id,
    worker_type: "task",
    status,
    required: false,
    depends_on: depends,
    replan_attempts: 0,
  }
}

const TABLE = [
  wire("dag_alpha", "a", "completed"),
  wire("dag_alpha", "b", "completed"),
  wire("dag_alpha", "c", "running", ["a", "b"]),
  wire("dag_alpha", "d", "queued", ["c"]),
]

const ALPHA: DagWorkflowSummary = {
  id: "dag_alpha",
  title: "依赖升级验证",
  status: "running",
  graphRev: 1,
  nodeCount: 4,
  completedNodes: 2,
  runningNodes: 1,
  failedNodes: 0,
  skippedNodes: 0,
  abortedNodes: 0,
  queuedNodes: 1,
  escalatedNodes: 0,
}

const GOAL: Goal = { goal: "全部依赖升到最新稳定版并通过 CI", status: "active", turnsUsed: 6, maxTurns: 30 }

/** The server's side of the workflows: summaries by session and the table of every workflow. */
function workflows(summaries: Record<string, DagWorkflowSummary[]>) {
  const reads: string[] = []
  const handler: FetchHandler = (url) => {
    const summary = url.pathname.match(/^\/dag\/session\/([^/]+)\/summary$/)
    if (summary) return json(summaries[summary[1]] ?? [])
    const nodes = url.pathname.match(/^\/dag\/([^/]+)\/nodes$/)
    if (nodes) {
      reads.push(nodes[1])
      return json(TABLE)
    }
    return undefined
  }
  return { handler, reads }
}

function goalEvent(sessionID: string, goal: Goal): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return {
    directory,
    payload: { id: `evt_band_goal_${sessionID}`, type: "goal.updated", properties: { sessionID, goal } },
  } as GlobalEvent
}

function rowsOf(frame: string) {
  return frame.split("\n").map((line) => line.trimEnd())
}

/** The first row of the prompt: its top edge, below the top bar. */
function composerFirst(frame: string) {
  const first = promptTop(rowsOf(frame))
  if (first < 0) throw new Error(`no prompt in the frame:\n${frame}`)
  return first
}

async function settled(setup: Setup) {
  await Bun.sleep(60)
  await setup.renderOnce()
  return captureFrame(setup)
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

const sessions = [sessionFixture(mainID), sessionFixture(childID, { parentID: mainID })]

test("the band takes the row above the prompt and the prompt stays where it was", async () => {
  const bare = await runApp({ sessions, args: { continue: true }, width: 120, height: 30 })
  let where: number
  let above: string
  try {
    await waitForFrame(bare.setup, promptShown, "the prompt")
    const frame = await settled(bare.setup)
    where = composerFirst(frame)
    above = rowsOf(frame)[where - 1]
    // Nothing to show: not even an empty row between the main area and the prompt.
    expect(above).toBe("")
  } finally {
    clearDrafts(bare.setup)
    await bare.stop()
  }

  const served = workflows({ [mainID]: [ALPHA] })
  const app = await runApp({ sessions, args: { continue: true }, width: 120, height: 30, handler: served.handler })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("◆ 依赖升级验证"), "the band")
    await waitFor(() => served.reads.length > 0)
    const frame = await settled(app.setup)
    const rows = rowsOf(frame)
    expect(composerFirst(frame)).toBe(where)
    expect(rows[where - 1]).toContain("◆ 依赖升级验证 ━━━━━━ ━━━ ─── 2/4 完成 · 第 2/3 波 · 1 运行中")
    expect(rows[where - 1].endsWith("/dag")).toBe(true)
    // The main area gave the row up; the rows above the band are still the transcript's.
    expect(rows[where - 2]).toBe("")
    expect(served.reads).toEqual(["dag_alpha"])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("a goal adds a second row under the workflow row, still above the prompt", async () => {
  const served = workflows({ [mainID]: [ALPHA] })
  const app = await runApp({ sessions, args: { continue: true }, width: 120, height: 30, handler: served.handler })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("◆ 依赖升级验证"), "the band")
    app.events.emit(goalEvent(mainID, GOAL))
    await waitForFrame(app.setup, (frame) => frame.includes("◎ 目标"), "the goal row")
    const frame = await settled(app.setup)
    const rows = rowsOf(frame)
    const first = composerFirst(frame)
    expect(rows[first - 2]).toContain("◆ 依赖升级验证")
    expect(rows[first - 1]).toContain("◎ 目标  全部依赖升到最新稳定版并通过 CI")
    expect(rows[first - 1]).toContain("第 6/30 轮 · 进行中  /goal")
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("a goal alone takes one row and no workflow row", async () => {
  const app = await runApp({ sessions, args: { continue: true }, width: 120, height: 30 })
  try {
    await waitForFrame(app.setup, promptShown, "the prompt")
    app.events.emit(goalEvent(mainID, GOAL))
    await waitForFrame(app.setup, (frame) => frame.includes("◎ 目标"), "the goal row")
    const frame = await settled(app.setup)
    const rows = rowsOf(frame)
    const first = composerFirst(frame)
    expect(rows[first - 1]).toContain("◎ 目标")
    // The one row is the goal's; above it the main area goes on.
    expect(rows[first - 2]).toBe("")
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("home shows no band, whatever the sessions hold", async () => {
  const served = workflows({ [mainID]: [ALPHA] })
  const app = await runApp({ sessions, args: {}, width: 120, height: 30, handler: served.handler })
  try {
    await waitForFrame(app.setup, promptShown, "the home prompt")
    app.events.emit(goalEvent(mainID, GOAL))
    const frame = await settled(app.setup)
    expect(frame).not.toContain("依赖升级验证")
    expect(frame).not.toContain("◎ 目标")
    expect(served.reads).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("a sub-agent view shows the root session's workflow and goal", async () => {
  const served = workflows({ [mainID]: [ALPHA] })
  const app = await runApp({
    sessions,
    args: { sessionID: childID },
    width: 120,
    height: 30,
    handler: served.handler,
  })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("◆ 依赖升级验证"), "the root's workflow")
    app.events.emit(goalEvent(mainID, GOAL))
    const frame = await waitForFrame(app.setup, (frame) => frame.includes("◎ 目标"), "the root's goal")
    expect(frame).toContain("全部依赖升到最新稳定版并通过 CI")
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("/dag hands the workflow to the panel: the workflow row goes, the goal row stays, both come back", async () => {
  const served = workflows({ [mainID]: [ALPHA] })
  const app = await runApp({ sessions, args: { continue: true }, width: 120, height: 30, handler: served.handler })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("◆ 依赖升级验证"), "the band")
    app.events.emit(goalEvent(mainID, GOAL))
    await waitForFrame(app.setup, (frame) => frame.includes("◎ 目标"), "the goal row")

    await app.setup.mockInput.typeText("/dag")
    await waitForFrame(app.setup, (frame) => frame.includes("工作流"), "the command popup")
    app.setup.mockInput.pressEnter()
    const open = await waitForFrame(app.setup, (frame) => frame.includes("[运行中]"), "the workflow panel")
    // The panel has the title and the counts; the band no longer repeats them. The goal is not the panel's.
    expect(open).not.toContain("◆ 依赖升级验证")
    expect(open).toContain("◎ 目标")

    app.setup.mockInput.pressEscape()
    const closed = await waitForFrame(app.setup, (frame) => frame.includes("◆ 依赖升级验证"), "the band again")
    expect(closed).toContain("◎ 目标")
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("a click on the workflow row opens /dag, and a click on the goal row does nothing", async () => {
  const served = workflows({ [mainID]: [ALPHA] })
  const app = await runApp({ sessions, args: { continue: true }, width: 120, height: 30, handler: served.handler })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("◆ 依赖升级验证"), "the band")
    app.events.emit(goalEvent(mainID, GOAL))
    const frame = await waitForFrame(app.setup, (value) => value.includes("◎ 目标"), "the goal row")
    const rows = rowsOf(frame)
    const dagRow = rows.findIndex((row) => row.includes("◆ 依赖升级验证"))
    const goalRow = rows.findIndex((row) => row.includes("◎ 目标"))

    await app.setup.mockMouse.click(10, goalRow)
    await Bun.sleep(80)
    await app.setup.renderOnce()
    expect(await captureFrame(app.setup)).not.toContain("[运行中]")

    await app.setup.mockMouse.click(10, dagRow)
    await waitForFrame(app.setup, (value) => value.includes("[运行中]"), "the workflow panel")
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

for (const aw of [1, 2] as const) {
  test(`stays inside 80 columns at ambiguous width ${aw}`, async () => {
    const served = workflows({ [mainID]: [ALPHA] })
    const app = await runApp({
      sessions,
      args: { continue: true },
      width: 80,
      height: 24,
      ambiguousWidth: aw,
      handler: served.handler,
    })
    try {
      await waitForFrame(app.setup, (frame) => frame.includes("◆ 依赖升级验证"), "the band")
      await waitFor(() => served.reads.length > 0)
      app.events.emit(goalEvent(mainID, GOAL))
      const frame = await settled(app.setup)
      const rows = rowsOf(frame)
      const first = composerFirst(frame)
      // One row below 100 columns: the workflow's, and the goal left to the drawer.
      expect(rows[first - 1]).toContain("◆ 依赖升级验证")
      expect(rows[first - 2]).toBe("")
      expect(frame).not.toContain("◎ 目标")
      expect(cellWidth(rows[first - 1], aw)).toBeLessThanOrEqual(80)
    } finally {
      clearDrafts(app.setup)
      await app.stop()
    }
  })
}

test("hidden keeps the workflow row away, always shows an empty one", async () => {
  const served = workflows({ [mainID]: [ALPHA] })
  const hidden = await runApp({
    sessions,
    args: { continue: true },
    width: 120,
    height: 30,
    kv: { dag_band: "hidden" },
    handler: served.handler,
  })
  try {
    await waitForFrame(hidden.setup, promptShown, "the prompt")
    const frame = await settled(hidden.setup)
    expect(frame).not.toContain("依赖升级验证")
    expect(served.reads).toEqual([])
  } finally {
    clearDrafts(hidden.setup)
    await hidden.stop()
  }

  const always = await runApp({
    sessions,
    args: { continue: true },
    width: 120,
    height: 30,
    kv: { dag_band: "always" },
  })
  try {
    const frame = await waitForFrame(always.setup, (value) => value.includes("◆ 没有工作流"), "the empty band")
    expect(rowsOf(frame)[composerFirst(frame) - 1]).toContain("◆ 没有工作流")
  } finally {
    clearDrafts(always.setup)
    await always.stop()
  }
})

test("says it in English when the interface is English", async () => {
  const served = workflows({ [mainID]: [ALPHA] })
  const app = await runApp({
    sessions,
    args: { continue: true },
    width: 120,
    height: 30,
    handler: (url, request) => (url.pathname === "/config" ? json({ language: "en" }) : served.handler(url, request)),
  })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("◆ 依赖升级验证"), "the band")
    await waitFor(() => served.reads.length > 0)
    app.events.emit(goalEvent(mainID, GOAL))
    const frame = await waitForFrame(app.setup, (value) => value.includes("◎ Goal"), "the English goal row")
    expect(frame).toContain("2/4 done · wave 2/3 · 1 running")
    expect(frame).toContain("turn 6/30 · Active  /goal")
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

// ── The background runs (#1058 4, 5) ────────────────────────────────────────────────────────────────────────────
//
// The runs the root session started in the background, read from its Task calls and the jobs they own: a mark on the
// band, or a row of their own, a click that opens `/agents`, and a section of the drawer.

const bgOne = "ses_band_bg_one"
const bgTwo = "ses_band_bg_two"
const bgSessions = [
  ...sessions,
  sessionFixture(bgOne, { parentID: mainID, time: { created: 10, updated: 11 } }),
  sessionFixture(bgTwo, { parentID: mainID, time: { created: 12, updated: 13 } }),
]

/** The root's transcript with two Task calls that started background runs, and the jobs of both answering `running`. */
function backgroundServer() {
  const handler: FetchHandler = async (url, request) => {
    if (url.pathname === `/session/${mainID}/message`) {
      return json([
        {
          info: userMessage("msg_band_user", mainID, 1),
          parts: [textPart("msg_band_user", mainID, "prt_band_prompt", "scan everything")],
        },
        {
          info: assistantMessage("msg_band_assistant", mainID, "msg_band_user", 2),
          parts: [
            taskCall({
              parentID: mainID,
              messageID: "msg_band_assistant",
              id: "prt_band_one",
              childID: bgOne,
              description: "Scan one",
              background: true,
              initiator: "agent",
              start: 1_000,
            }),
            taskCall({
              parentID: mainID,
              messageID: "msg_band_assistant",
              id: "prt_band_two",
              childID: bgTwo,
              description: "Scan two",
              background: true,
              initiator: "agent",
              start: 2_000,
            }),
          ],
        },
      ])
    }
    if (url.pathname !== "/lifecycle/states") return undefined
    const body: unknown = await request?.json()
    const refs =
      typeof body === "object" && body !== null && "refs" in body && Array.isArray(body.refs) ? body.refs : []
    return json(
      refs.map((ref: { domain: string; id: string }) => ({
        domain: ref.domain,
        id: ref.id,
        state: {
          domain: ref.domain,
          id: ref.id,
          value: "running",
          phase: "running",
          terminal: false,
          settled: false,
          source: "live",
          observedAt: 3_000,
        },
      })),
    )
  }
  return handler
}

/** Where the mark is: its row in the frame and the cell column it starts at. */
function markAt(frame: string, rowNeedle: string) {
  const rows = rowsOf(frame)
  const row = rows.findIndex((line) => line.includes(rowNeedle))
  return { row, x: cellWidth(rows[row].slice(0, rows[row].indexOf("◇"))) }
}

test("the runs have a row of their own just above the prompt, and a click on it opens /agents", async () => {
  const app = await runApp({
    sessions: bgSessions,
    args: { sessionID: mainID },
    width: 120,
    height: 30,
    handler: backgroundServer(),
  })
  try {
    const frame = await waitForFrame(
      app.setup,
      (value) => value.includes("◇ 后台 2 · explore Scan two · explore Scan one"),
      "the row of the runs",
    )
    const rows = rowsOf(frame)
    const own = rows.findIndex((line) => line.includes("◇ 后台 2"))
    // The runs are both waiting for a slot (a running job and a child that has run no turn); newest first.
    expect(rows[own]).toContain("◇ 后台 2 · explore Scan two · explore Scan one")
    expect(rows[own].trimEnd().endsWith("/agents")).toBe(true)
    // The prompt starts on the next row: the band took a line of the main area, none of the prompt's.
    expect(promptTop(rows)).toBe(own + 1)
    expect(rows.filter((line) => line.includes("◇ 后台")).length).toBe(1)

    await app.setup.mockMouse.click(10, own)
    const panel = await waitForFrame(app.setup, (value) => value.includes("explore · Scan one"), "the sub-agent list")
    expect(promptShown(panel)).toBe(false)
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("the mark rides on the goal row, and a click on it opens /agents while one on the goal does nothing", async () => {
  const app = await runApp({
    sessions: bgSessions,
    args: { sessionID: mainID },
    width: 120,
    height: 30,
    handler: backgroundServer(),
  })
  try {
    await waitForFrame(app.setup, (value) => value.includes("◇ 后台 2"), "the runs")
    app.events.emit(goalEvent(mainID, GOAL))
    const frame = await waitForFrame(
      app.setup,
      (value) => value.includes("◎ 目标") && value.includes("/goal  ◇ 后台 2·排2"),
      "the mark on the goal row",
    )
    const at = markAt(frame, "◎ 目标")

    // A click on the goal row has no handler: a few renders are enough to see that nothing opened.
    await app.setup.mockMouse.click(10, at.row)
    for (let pass = 0; pass < 3; pass++) await app.setup.renderOnce()
    expect(promptShown(await captureFrame(app.setup))).toBe(true)

    app.setup.renderer.clearSelection()
    await app.setup.mockMouse.click(at.x + 1, at.row)
    const panel = await waitForFrame(app.setup, (value) => value.includes("explore · Scan two"), "the sub-agent list")
    expect(promptShown(panel)).toBe(false)
    expect(app.writes()).toEqual([])
    expect(app.commands()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("below 100 columns the band says nothing of the runs, and the drawer lists them while it is open", async () => {
  const app = await runApp({
    sessions: bgSessions,
    args: { sessionID: mainID },
    width: 80,
    height: 30,
    handler: backgroundServer(),
  })
  try {
    await waitForFrame(app.setup, promptShown, "the prompt")
    app.events.emit(goalEvent(mainID, GOAL))
    // The goal has the one row of a narrow band; the runs are not on it. Their Task rows say they wait for a slot once
    // the data layer holds them, which is when the band would have drawn them.
    const frame = await waitForFrame(
      app.setup,
      (value) => value.includes("◎ 目标") && value.includes("排队中 · 等待并发槽位"),
      "the goal row and the runs in the transcript",
    )
    expect(frame).not.toContain("◇ 后台")
    // The drawer closed has no section; open, it lists the runs the band left out.
    expect(frame).not.toContain("后台任务")
    app.setup.mockInput.pressKey("b", { ctrl: true })
    const open = await waitForFrame(app.setup, (value) => value.includes("后台任务 2"), "the drawer's section")
    expect(open).toContain("○ explore · Scan two")
    expect(open).toContain("○ explore · Scan one")
    app.setup.mockInput.pressKey("b", { ctrl: true })
    await waitForFrame(app.setup, (value) => !value.includes("后台任务"), "the drawer closed")
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

// ── The project-trust row (#1618) ───────────────────────────────────────────────────────────────────────────────
//
// Commands that were added or changed since the last decision are paused until a new one is made. The real app shows
// a warning row above the prompt for them; the footer reminder stays beside it with its own, wider count (every
// pending command, the first-time ones too), and a click on the row opens the project-trust panel.

/** Two commands that changed, one that is pending for the first time, and one that is already trusted. */
const trustMixed = [
  trustEntry("setup", "pending", "new"),
  trustEntry("lint", "pending", "modified"),
  trustEntry("first", "pending"),
  trustEntry("old", "trusted"),
]

test("a changed project command puts a warning row above the prompt, and a click on it opens the trust panel", async () => {
  const trusted = trusting(trustMixed)
  const app = await runApp({ sessions, args: { continue: true }, width: 120, height: 30, handler: trusted.handler })
  try {
    await waitForFrame(app.setup, (frame) => promptShown(frame) && frame.includes("未确认前暂停执行"), "the trust row")
    const frame = await settled(app.setup)
    const rows = rowsOf(frame)
    const first = composerFirst(frame)
    // The band took the row above the prompt, and the main area went on above it.
    expect(rows[first - 1].trim().startsWith("⚠ 项目命令有 2 处变化，未确认前暂停执行")).toBe(true)
    expect(rows[first - 1].endsWith("/trust")).toBe(true)
    expect(rows[first - 2]).toBe("")
    // The footer reminder is as it was: its count is every pending command, the first-time one included.
    expect(footerRow(frame)).toContain("⚠ 3 条项目命令未信任 · /trust")

    // A click anywhere on the row opens the panel, which lists every command; nothing is written.
    await app.setup.mockMouse.click(10, first - 1)
    const panel = await waitForFrame(
      app.setup,
      (value) => value.includes("项目信任") && value.includes("本项目共 4 条可执行条目。"),
      "the trust panel",
    )
    expect(promptShown(panel)).toBe(false)
    expect(app.writes()).toEqual([])
    expect(app.commands()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("says the row and the footer reminder in English when the interface is English", async () => {
  const trusted = trusting(trustMixed)
  const app = await runApp({
    sessions,
    args: { continue: true },
    width: 120,
    height: 30,
    handler: (url, request) => (url.pathname === "/config" ? json({ language: "en" }) : trusted.handler(url, request)),
  })
  try {
    await waitForFrame(
      app.setup,
      (frame) => promptShown(frame) && frame.includes("paused until confirmed"),
      "the English trust row",
    )
    const frame = await settled(app.setup)
    const rows = rowsOf(frame)
    const first = composerFirst(frame)
    expect(rows[first - 1].trim().startsWith("⚠ 2 project commands changed · paused until confirmed")).toBe(true)
    expect(rows[first - 1].endsWith("/trust")).toBe(true)
    expect(footerRow(frame)).toContain("⚠ 3 project commands untrusted · /trust")
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("the row goes with the last change decided, the footer counts what is still pending, the workflow row returns", async () => {
  const served = workflows({ [mainID]: [ALPHA] })
  const trusted = trusting(trustMixed)
  const app = await runApp({
    sessions,
    args: { continue: true },
    width: 120,
    height: 30,
    handler: async (url, request) => (await trusted.handler(url, request)) ?? served.handler(url, request),
  })
  try {
    await waitForFrame(
      app.setup,
      (frame) => frame.includes("未确认前暂停执行") && frame.includes("◆ 依赖升级验证"),
      "the trust row over the workflow row",
    )
    const both = rowsOf(await settled(app.setup))
    const trustRow = both.findIndex((row) => row.includes("未确认前暂停执行"))
    expect(both[trustRow + 1]).toContain("◆ 依赖升级验证")

    // Both changes are decided; the command that is pending for the first time still is.
    trusted.set([
      trustEntry("setup", "trusted"),
      trustEntry("lint", "declined"),
      trustEntry("first", "pending"),
      trustEntry("old", "trusted"),
    ])
    app.events.emit({
      directory,
      payload: {
        id: "evt_band_trust_decided",
        type: "project.trust.updated",
        properties: { projectID: "proj_test", entries: [], removed: [] },
      },
    })
    const frame = await waitForFrame(
      app.setup,
      (value) => !value.includes("未确认前暂停执行") && value.includes("◆ 依赖升级验证"),
      "the band without the trust row",
    )
    expect(footerRow(frame)).toContain("⚠ 1 条项目命令未信任 · /trust")
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

for (const aw of [1, 2] as const) {
  test(`keeps the trust row alone on the band inside 80 columns at ambiguous width ${aw}`, async () => {
    const served = workflows({ [mainID]: [ALPHA] })
    const trusted = trusting(trustMixed)
    const app = await runApp({
      sessions,
      args: { continue: true },
      width: 80,
      height: 24,
      ambiguousWidth: aw,
      handler: async (url, request) => (await trusted.handler(url, request)) ?? served.handler(url, request),
    })
    try {
      await waitForFrame(
        app.setup,
        (frame) => promptShown(frame) && frame.includes("未确认前暂停执行"),
        "the trust row",
      )
      app.events.emit(goalEvent(mainID, GOAL))
      const frame = await settled(app.setup)
      const rows = rowsOf(frame)
      const first = composerFirst(frame)
      // One row below 100 columns: the trust warning's, with the workflow and the goal left to the drawer.
      expect(rows[first - 1]).toContain("⚠ 项目命令有 2 处变化")
      expect(rows[first - 2]).toBe("")
      expect(frame).not.toContain("◆ 依赖升级验证")
      expect(frame).not.toContain("◎ 目标")
      expect(cellWidth(rows[first - 1], aw)).toBeLessThanOrEqual(80)
      expect(footerRow(frame)).toContain("⚠ 3 条项目命令未信任")
    } finally {
      clearDrafts(app.setup)
      await app.stop()
    }
  })
}

test("home has no band: a changed project command is the first-open panel's and the footer's, not a row", async () => {
  const trusted = trusting(trustMixed)
  const app = await runApp({ sessions, args: {}, width: 120, height: 30, handler: trusted.handler })
  try {
    // The panel for changed commands opens before the first session (#1040); the band has no place on home.
    const opened = await waitForFrame(app.setup, (frame) => frame.includes("项目命令有变化"), "the first-open panel")
    expect(opened).not.toContain("未确认前暂停执行")
    app.setup.mockInput.pressEscape()
    const home = await waitForFrame(
      app.setup,
      (frame) => promptShown(frame) && !frame.includes("项目命令有变化"),
      "home without the panel",
    )
    expect(home).not.toContain("未确认前暂停执行")
    expect(footerRow(home)).toContain("⚠ 3 条项目命令未信任 · /trust")
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})
