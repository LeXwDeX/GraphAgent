// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { CapturedFrame, RGBA } from "@opentui/core"
import type { DagNode, DagWorkflowSummary, GlobalEvent, Goal, PrWatchEntry, Session } from "@graphagent/sdk"
import open from "open"
import { createSignal, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { DEFAULT_THEME } from "../../src/context/theme"
import type { Ticker } from "../../src/context/ticker"
import { setLanguage } from "../../src/i18n"
import { createPrTracker } from "../../src/shell/pr-tracker"
import {
  PrTrackerProvider,
  type PrBandItem,
  type PrTracker,
  type ReminderBandItem,
} from "../../src/shell/pr-tracker-context"
import { BAND_NARROW_WIDTH, DAG_PANEL_ID, SessionStatusBand } from "../../src/shell/status-band"
import type { ToastOptions } from "../../src/ui/toast"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import { cellWidth, type AmbiguousWidth } from "../../src/ui/width"
import { RUN_START, endRun, seedRun } from "../fixture/background-runs"
import { MINUTE, T0, bandItem, ciItem, prEntry, stoppedItem, unresponsiveItem, workingItem } from "../fixture/pr-band"
import { createEventSource, directory, json, type FetchHandler } from "../fixture/tui-sdk"
import { dagModeStatus, mountRoute, sessionFixture, waitFor, type MountOptions } from "../routes/dag-mode-harness"

// The band as the session route shows it: the real provider stack, a fake server that serves the workflows'
// summaries and node tables, and the production event path for every change after that.

const rootID = "ses_band_root"
const childID = "ses_band_child"
const otherID = "ses_band_other"
const sessions = [
  sessionFixture(rootID, { time: { created: 1, updated: 9 } }),
  sessionFixture(childID, { parentID: rootID }),
  sessionFixture(otherID, { time: { created: 1, updated: 3 } }),
]

beforeEach(() => {
  setLanguage("zh-CN")
})

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

/** Four nodes in three waves: two done, one running, one queued. */
function table(workflow: string, running = "running"): DagNode[] {
  return [
    wire(workflow, "a", "completed"),
    wire(workflow, "b", "completed"),
    wire(workflow, "c", running, ["a", "b"]),
    wire(workflow, "d", "queued", ["c"]),
  ]
}

/** Four nodes, all done. */
function done(workflow: string): DagNode[] {
  return [
    wire(workflow, "a", "completed"),
    wire(workflow, "b", "completed"),
    wire(workflow, "c", "completed", ["a", "b"]),
    wire(workflow, "d", "completed", ["c"]),
  ]
}

function flow(id: string, status: string, extra: Partial<DagWorkflowSummary> = {}): DagWorkflowSummary {
  return {
    id,
    title: id.replace("dag_", ""),
    status,
    graphRev: 1,
    nodeCount: 4,
    completedNodes: 2,
    runningNodes: status === "running" ? 1 : 0,
    failedNodes: 0,
    skippedNodes: 0,
    abortedNodes: 0,
    queuedNodes: 1,
    escalatedNodes: 0,
    ...extra,
  }
}

function goal(extra: Partial<Goal> = {}): Goal {
  return { goal: "ship the upgrade", status: "active", turnsUsed: 6, maxTurns: 30, ...extra }
}

interface World {
  summaries: Record<string, DagWorkflowSummary[]>
  tables: Record<string, DagNode[]>
}

/** `dag.summary` and `dag.nodes` for the world, and a record of the table reads with the interest each one saw. */
function serve(world: World, interest: () => readonly string[]) {
  const reads: Array<{ workflow: string; interest: readonly string[] }> = []
  const summaryReads: string[] = []
  const handler: FetchHandler = (url) => {
    const summary = url.pathname.match(/^\/dag\/session\/([^/]+)\/summary$/)
    if (summary) {
      summaryReads.push(summary[1])
      return json(world.summaries[summary[1]] ?? [])
    }
    const nodes = url.pathname.match(/^\/dag\/([^/]+)\/nodes$/)
    if (nodes) {
      reads.push({ workflow: nodes[1], interest: interest() })
      return json(world.tables[nodes[1]] ?? [])
    }
    return undefined
  }
  return { handler, reads, summaryReads }
}

/** A ticker that counts who asks it for what, and never fires. */
function counting() {
  const calls = { frame: 0, second: 0, at: 0 }
  const ticker: Ticker = {
    frame: () => 0,
    second: () => 0,
    subscribe() {
      calls.frame++
      return () => {}
    },
    subscribeSecond() {
      calls.second++
      return () => {}
    },
    at() {
      calls.at++
      return () => {}
    },
    now: () => 0,
  }
  return { calls, ticker }
}

let sequence = 0
function event(payload: Record<string, unknown>): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return { directory, payload: { id: `evt_band_${++sequence}`, ...payload } } as GlobalEvent
}
const summaryEvent = (sessionID: string, summaries: DagWorkflowSummary[]) =>
  event({ type: "dag.workflow.summary.updated", properties: { sessionID, summaries } })
const nodesEvent = (sessionID: string, workflowID: string, seq: number, nodes: DagNode[]) =>
  event({
    type: "dag.workflow.nodes.updated",
    properties: { sessionID, workflowID, graphRev: 1, seq, nodes, removed: [] },
  })
const goalEvent = (sessionID: string, value: Goal) =>
  event({ type: "goal.updated", properties: { sessionID, goal: value } })
const goalCleared = (sessionID: string) => event({ type: "goal.cleared", properties: { sessionID } })

function rows(frame: string) {
  return frame
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

type Mount = Awaited<ReturnType<typeof mountRoute>>

async function mountBand(
  world: World,
  options: Partial<MountOptions> = {},
): Promise<{ harness: Mount; served: ReturnType<typeof serve> }> {
  const events = createEventSource()
  const served = serve(world, () => events.interest.at(-1) ?? [])
  const { handler: first, ...rest } = options
  const harness = await mountRoute({
    route: { type: "session", sessionID: rootID },
    sessions,
    view: () => <SessionStatusBand />,
    width: 120,
    height: 12,
    ...rest,
    events,
    // A test's own replies go first; the world answers the rest.
    handler: async (url, request) => (await first?.(url, request)) ?? served.handler(url, request),
  })
  return { harness, served }
}

/** Waits for a frame the band has drawn and hands back its non-empty rows. */
async function band(harness: Mount, ready: (rows: string[]) => boolean, what: string) {
  return rows(await harness.waitForFrame((frame) => ready(rows(frame)), what))
}

const running: World = {
  summaries: { [rootID]: [flow("dag_alpha", "running")] },
  tables: { dag_alpha: table("dag_alpha") },
}

describe("what the band shows", () => {
  test("takes no row while there is nothing to show", async () => {
    const { harness } = await mountBand({ summaries: {}, tables: {} })
    try {
      await harness.settle()
      expect(rows(await harness.frame())).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("shows the running workflow with its bar and counts, once the table is in", async () => {
    const { harness } = await mountBand(running)
    try {
      const lines = await band(harness, (all) => all.some((row) => row.includes("第 2/3 波")), "the loaded table")
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("◆ alpha ━━━━━━ ━━━ ─── 2/4 完成 · 第 2/3 波 · 1 运行中")
      expect(lines[0].endsWith("/dag")).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  test("leaves a completed workflow out and keeps it out of the band", async () => {
    const { harness } = await mountBand({
      summaries: { [rootID]: [flow("dag_alpha", "completed", { completedNodes: 4, queuedNodes: 0 })] },
      tables: {},
    })
    try {
      await harness.settle()
      expect(rows(await harness.frame())).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("updates when a node is pushed", async () => {
    const { harness } = await mountBand(running)
    try {
      await band(harness, (all) => all.some((row) => row.includes("第 2/3 波")), "the loaded table")
      harness.events.emit(nodesEvent(rootID, "dag_alpha", 1, [wire("dag_alpha", "c", "completed", ["a", "b"])]))
      harness.events.emit(
        summaryEvent(rootID, [flow("dag_alpha", "running", { completedNodes: 3, runningNodes: 0, queuedNodes: 1 })]),
      )
      const lines = await band(harness, (all) => all.some((row) => row.includes("3/4 完成")), "the pushed node")
      expect(lines[0]).toContain("◆ alpha ━━━━━━ ━━━ ─── 3/4 完成 · 第 3/3 波")
      expect(lines[0]).not.toContain("运行中")
    } finally {
      await harness.dispose()
    }
  })

  test("comes back as soon as a workflow starts and goes when the last one finishes", async () => {
    const { harness } = await mountBand({ summaries: {}, tables: { dag_alpha: table("dag_alpha") } })
    try {
      await harness.settle()
      expect(rows(await harness.frame())).toEqual([])

      harness.events.emit(summaryEvent(rootID, [flow("dag_alpha", "running")]))
      await band(harness, (all) => all.some((row) => row.includes("◆ alpha")), "the started workflow")

      harness.events.emit(summaryEvent(rootID, [flow("dag_alpha", "completed", { completedNodes: 4, queuedNodes: 0 })]))
      await band(harness, (all) => all.length === 0, "the finished workflow gone")
    } finally {
      await harness.dispose()
    }
  })

  test("keeps the numbers of a workflow whose table failed to load", async () => {
    const { harness } = await mountBand(running, {
      handler: (url) =>
        /^\/dag\/[^/]+\/nodes$/.test(url.pathname) ? json({ message: "down" }, { status: 500 }) : undefined,
    })
    try {
      const lines = await band(harness, (all) => all.some((row) => row.includes("2/4 完成")), "the counts")
      // No table, so no waves to number, and a bar drawn from the counts.
      expect(lines[0]).toContain("◆ alpha ━━━━━━━━━─── 2/4 完成 · 1 运行中")
      expect(lines[0]).not.toContain("波")
    } finally {
      await harness.dispose()
    }
  })
})

describe("the display policy", () => {
  const finished: World = {
    summaries: { [rootID]: [flow("dag_alpha", "completed", { completedNodes: 4, queuedNodes: 0 })] },
    tables: { dag_alpha: done("dag_alpha") },
  }

  test("auto shows the band for an active workflow only", async () => {
    const { harness } = await mountBand(running, { kv: { dag_band: "auto" } })
    try {
      await band(harness, (all) => all.some((row) => row.includes("◆ alpha")), "the active workflow")
    } finally {
      await harness.dispose()
    }
  })

  test("always keeps the newest workflow on screen after it finished", async () => {
    const { harness } = await mountBand(finished, { kv: { dag_band: "always" } })
    try {
      const lines = await band(harness, (all) => all.some((row) => row.includes("4/4 完成")), "the finished workflow")
      expect(lines[0]).toContain("◆ alpha")
    } finally {
      await harness.dispose()
    }
  })

  test("always says so when there is no workflow at all", async () => {
    const { harness } = await mountBand({ summaries: {}, tables: {} }, { kv: { dag_band: "always" } })
    try {
      const lines = await band(harness, (all) => all.some((row) => row.includes("没有工作流")), "the empty row")
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("◆ 没有工作流")
      expect(lines[0].endsWith("/dag")).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  test("hidden shows no workflow row, and no table is read for it", async () => {
    const { harness, served } = await mountBand(running, { kv: { dag_band: "hidden" } })
    try {
      await harness.settle()
      expect(rows(await harness.frame())).toEqual([])
      expect(served.reads).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("hidden leaves the goal row alone", async () => {
    const { harness } = await mountBand(running, { kv: { dag_band: "hidden" } })
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      const lines = await band(harness, (all) => all.some((row) => row.includes("◎")), "the goal row")
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("◎ 目标  ship the upgrade")
    } finally {
      await harness.dispose()
    }
  })

  test("follows a change of the policy at once, as the settings panel makes it", async () => {
    const { harness } = await mountBand(finished)
    try {
      await harness.settle()
      expect(rows(await harness.frame())).toEqual([])

      harness.kv().set("dag_band", "always")
      await band(harness, (all) => all.some((row) => row.includes("◆ alpha")), "the band shown by always")

      harness.kv().set("dag_band", "hidden")
      await band(harness, (all) => all.length === 0, "the band hidden")

      harness.kv().set("dag_band", "auto")
      await harness.settle()
      expect(rows(await harness.frame())).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("takes an unknown value for auto", async () => {
    const { harness } = await mountBand(running, { kv: { dag_band: "sometimes" } })
    try {
      await band(harness, (all) => all.some((row) => row.includes("◆ alpha")), "the active workflow")
    } finally {
      await harness.dispose()
    }
  })
})

describe("several workflows", () => {
  const three: World = {
    summaries: {
      [rootID]: [
        flow("dag_alpha", "running"),
        flow("dag_beta", "failed", { failedNodes: 1, runningNodes: 0, completedNodes: 1, queuedNodes: 2 }),
        flow("dag_gamma", "completed", { completedNodes: 4, queuedNodes: 0 }),
      ],
    },
    tables: { dag_alpha: table("dag_alpha"), dag_beta: table("dag_beta"), dag_gamma: done("dag_gamma") },
  }

  test("shows the running one and folds the other two into +2", async () => {
    const { harness } = await mountBand(three)
    try {
      const lines = await band(harness, (all) => all.some((row) => row.includes("+2 个")), "the folded workflows")
      expect(lines[0]).toContain("◆ alpha")
      expect(lines[0]).toContain("+2 个  /dag")
    } finally {
      await harness.dispose()
    }
  })

  test("follows the workflow the user picked in the panel", async () => {
    const { harness } = await mountBand(three)
    try {
      await band(harness, (all) => all.some((row) => row.includes("◆ alpha")), "the running workflow")
      harness.sync().dag.focus.choose(rootID, "dag_gamma")
      const lines = await band(harness, (all) => all.some((row) => row.includes("◆ gamma")), "the picked workflow")
      expect(lines[0]).toContain("4/4 完成")
      expect(lines[0]).toContain("+2 个")
    } finally {
      await harness.dispose()
    }
  })

  test("keeps an unconfirmed failure after the rest finished, until it is confirmed", async () => {
    const { harness } = await mountBand(three)
    try {
      await band(harness, (all) => all.some((row) => row.includes("◆ alpha")), "the running workflow")
      harness.events.emit(
        summaryEvent(rootID, [
          flow("dag_alpha", "completed", { completedNodes: 4, queuedNodes: 0 }),
          three.summaries[rootID][1],
          three.summaries[rootID][2],
        ]),
      )
      const failed = await band(harness, (all) => all.some((row) => row.includes("◆ beta")), "the unconfirmed failure")
      expect(failed[0]).toContain("1 失败")

      harness.sync().dag.focus.acknowledge(rootID, "dag_beta")
      await band(harness, (all) => all.length === 0, "the confirmed failure gone")
    } finally {
      await harness.dispose()
    }
  })

  test("takes a workflow of a sub-agent session for its own", async () => {
    const { harness } = await mountBand({
      summaries: { [rootID]: [], [childID]: [flow("dag_child", "running")] },
      tables: { dag_child: table("dag_child") },
    })
    try {
      await band(harness, (all) => all.some((row) => row.includes("◆ child")), "the sub-agent's workflow")
    } finally {
      await harness.dispose()
    }
  })

  test("prefers the root session's workflow to a sub-agent's", async () => {
    const { harness } = await mountBand({
      summaries: { [rootID]: [flow("dag_alpha", "running")], [childID]: [flow("dag_child", "running")] },
      tables: { dag_alpha: table("dag_alpha"), dag_child: table("dag_child") },
    })
    try {
      const lines = await band(harness, (all) => all.some((row) => row.includes("+1 个")), "the folded workflow")
      expect(lines[0]).toContain("◆ alpha")
    } finally {
      await harness.dispose()
    }
  })
})

describe("the goal row", () => {
  test("shows with the goal and goes with it", async () => {
    const { harness } = await mountBand({ summaries: {}, tables: {} })
    try {
      harness.events.emit(goalEvent(rootID, goal({ subgoals: ["a", "b"] })))
      const lines = await band(harness, (all) => all.some((row) => row.includes("◎")), "the goal row")
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("◎ 目标  ship the upgrade")
      expect(lines[0]).toContain("第 6/30 轮 · 进行中 · 2 个子目标  /goal")

      harness.events.emit(goalCleared(rootID))
      await band(harness, (all) => all.length === 0, "the goal gone")
    } finally {
      await harness.dispose()
    }
  })

  test("shows the goal of the root session in a sub-agent view", async () => {
    const { harness } = await mountBand(
      { summaries: {}, tables: {} },
      { route: { type: "session", sessionID: childID } },
    )
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      await band(harness, (all) => all.some((row) => row.includes("◎ 目标  ship the upgrade")), "the root's goal")
    } finally {
      await harness.dispose()
    }
  })

  test("leaves out another session's goal", async () => {
    const { harness } = await mountBand({ summaries: {}, tables: {} })
    try {
      harness.events.emit(goalEvent(otherID, goal()))
      await harness.settle()
      expect(rows(await harness.frame())).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("stacks under the workflow row, and each row is one line", async () => {
    const { harness } = await mountBand(running)
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      const lines = await band(harness, (all) => all.some((row) => row.includes("◎")), "both rows")
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain("◆ alpha")
      expect(lines[1]).toContain("◎ 目标")
    } finally {
      await harness.dispose()
    }
  })
})

describe("narrow terminals", () => {
  test(`merge into one row below ${BAND_NARROW_WIDTH} columns, the workflow first`, async () => {
    const { harness } = await mountBand(running, { width: BAND_NARROW_WIDTH - 1 })
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      const lines = await band(harness, (all) => all.some((row) => row.includes("◆ alpha")), "the workflow row")
      await harness.settle()
      expect(rows(await harness.frame())).toHaveLength(1)
      expect(lines[0]).not.toContain("◎")
    } finally {
      await harness.dispose()
    }
  })

  test(`keep both rows from ${BAND_NARROW_WIDTH} columns on`, async () => {
    const { harness } = await mountBand(running, { width: BAND_NARROW_WIDTH })
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      await band(harness, (all) => all.length === 2, "two rows")
    } finally {
      await harness.dispose()
    }
  })

  test("show the goal when no workflow competes for the row", async () => {
    const { harness } = await mountBand({ summaries: {}, tables: {} }, { width: 80 })
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      const lines = await band(harness, (all) => all.some((row) => row.includes("◎")), "the goal row")
      expect(lines).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })
})

describe("the /dag panel", () => {
  test("hides the workflow row while it is open and keeps the goal row", async () => {
    const { harness } = await mountBand(running, { frame: true })
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      await band(
        harness,
        (all) => all.some((row) => row.includes("◆ alpha")) && all.some((row) => row.includes("◎")),
        "both rows",
      )

      harness.bottomZone()!.host.push({ id: DAG_PANEL_ID, render: () => <text>panel</text> })
      const open = await band(
        harness,
        (all) => !all.some((row) => row.includes("◆ alpha")) && all.some((row) => row.includes("◎")),
        "only the goal row",
      )
      expect(open.some((row) => row.includes("◎ 目标"))).toBe(true)

      harness.bottomZone()!.host.close()
      await band(harness, (all) => all.some((row) => row.includes("◆ alpha")), "the workflow row again")
    } finally {
      await harness.dispose()
    }
  })

  test("is not hidden by another panel", async () => {
    const { harness } = await mountBand(running, { frame: true })
    try {
      await band(harness, (all) => all.some((row) => row.includes("◆ alpha")), "the workflow row")
      harness.bottomZone()!.host.push({ id: "sessions", render: () => <text>panel</text> })
      await harness.settle()
      expect(rows(await harness.frame()).some((row) => row.includes("◆ alpha"))).toBe(true)
    } finally {
      await harness.dispose()
    }
  })
})

describe("what the band asks the server for", () => {
  const owned: World = {
    summaries: { [rootID]: [], [childID]: [flow("dag_child", "running")] },
    tables: { dag_child: table("dag_child") },
  }

  test("registers the owner session first, then reads the table once", async () => {
    const { harness, served } = await mountBand(owned)
    try {
      await band(harness, (all) => all.some((row) => row.includes("第 2/3 波")), "the loaded table")
      expect(served.reads).toHaveLength(1)
      expect(served.reads[0].workflow).toBe("dag_child")
      expect(served.reads[0].interest).toContain(childID)
      expect(harness.events.interest.at(-1)).toContain(childID)
    } finally {
      await harness.dispose()
    }
  })

  test("reads no table again for a push, and merges it", async () => {
    const { harness, served } = await mountBand(owned)
    try {
      await band(harness, (all) => all.some((row) => row.includes("第 2/3 波")), "the loaded table")
      harness.events.emit(nodesEvent(childID, "dag_child", 1, [wire("dag_child", "c", "completed", ["a", "b"])]))
      harness.events.emit(summaryEvent(childID, [flow("dag_child", "running", { completedNodes: 3, runningNodes: 0 })]))
      await band(harness, (all) => all.some((row) => row.includes("3/4 完成 · 第 3/3 波")), "the pushed node")
      expect(served.reads).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })

  test("takes the registration back when the band goes away", async () => {
    const [shown, setShown] = createSignal(true)
    const { harness } = await mountBand(owned, {
      view: () => (
        <Show when={shown()}>
          <SessionStatusBand />
        </Show>
      ),
    })
    try {
      await band(harness, (all) => all.some((row) => row.includes("◆ child")), "the sub-agent's workflow")
      expect(harness.events.interest.at(-1)).toContain(childID)

      setShown(false)
      await band(harness, (all) => all.length === 0, "the band gone")
      expect(harness.events.interest.at(-1)).not.toContain(childID)
      expect(harness.sync().data.dagNodes.dag_child).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })

  test("takes the registration back when the session switches", async () => {
    const { harness, served } = await mountBand(owned)
    try {
      await band(harness, (all) => all.some((row) => row.includes("◆ child")), "the sub-agent's workflow")
      expect(harness.events.interest.at(-1)).toContain(childID)

      harness.route().navigate({ type: "session", sessionID: otherID })
      await band(harness, (all) => all.length === 0, "the other session's empty band")
      expect(harness.events.interest.at(-1)).not.toContain(childID)

      harness.route().navigate({ type: "session", sessionID: rootID })
      await band(harness, (all) => all.some((row) => row.includes("第 2/3 波")), "the workflow again")
      expect(harness.events.interest.at(-1)).toContain(childID)
      expect(served.reads).toHaveLength(2)
    } finally {
      await harness.dispose()
    }
  })

  test("takes the registration back when the home route replaces the session", async () => {
    const { harness } = await mountBand(owned)
    try {
      await band(harness, (all) => all.some((row) => row.includes("◆ child")), "the sub-agent's workflow")
      harness.route().navigate({ type: "home" })
      await band(harness, (all) => all.length === 0, "no band at home")
      expect(harness.events.interest.at(-1)).not.toContain(childID)
    } finally {
      await harness.dispose()
    }
  })

  test("takes the registration back while the panel shows the workflow instead", async () => {
    const { harness } = await mountBand(owned, { frame: true })
    try {
      await band(harness, (all) => all.some((row) => row.includes("◆ child")), "the sub-agent's workflow")
      harness.bottomZone()!.host.push({ id: DAG_PANEL_ID, render: () => <text>panel</text> })
      await band(harness, (all) => !all.some((row) => row.includes("◆ child")), "the workflow row hidden")
      expect(harness.events.interest.at(-1)).not.toContain(childID)
    } finally {
      await harness.dispose()
    }
  })

  test("refreshes after a reconnect: the table and the summaries are read again", async () => {
    const world: World = structuredClone(owned)
    const { harness, served } = await mountBand(world)
    try {
      await band(harness, (all) => all.some((row) => row.includes("2/4 完成 · 第 2/3 波")), "the loaded table")
      const tableReads = served.reads.length
      const summaryReads = served.summaryReads.length

      // What happened while the connection was down.
      world.summaries[childID] = [flow("dag_child", "running", { completedNodes: 3, runningNodes: 0 })]
      world.tables.dag_child = table("dag_child", "completed")
      harness.events.reconnect()

      await band(harness, (all) => all.some((row) => row.includes("3/4 完成 · 第 3/3 波")), "the refreshed workflow")
      expect(served.reads.length).toBe(tableReads + 1)
      expect(served.summaryReads.length).toBeGreaterThan(summaryReads)
    } finally {
      await harness.dispose()
    }
  })
})

describe("read only", () => {
  test("sends no request that changes anything, whatever is clicked", async () => {
    const { harness } = await mountBand(running)
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      const lines = await band(harness, (all) => all.length === 2, "both rows")
      const frame = await harness.frame()
      const dagRow = frame.split("\n").findIndex((row) => row.includes("◆ alpha"))
      const goalRow = frame.split("\n").findIndex((row) => row.includes("◎"))
      expect(lines).toHaveLength(2)
      await harness.app.mockMouse.click(6, dagRow)
      await harness.app.mockMouse.click(6, goalRow)
      await harness.app.mockMouse.click(100, dagRow)
      await harness.settle()
      expect(harness.writes()).toEqual([])
      expect(harness.requested.filter((entry) => entry.startsWith("POST") || entry.startsWith("PUT"))).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("opens /dag when the workflow row is clicked, and does nothing for the goal row", async () => {
    const { harness } = await mountBand(running)
    let opened = 0
    // The /dag panel registers its handler with the command registry.
    const off = harness.registry().setHandler("dag.open", () => {
      opened++
    })
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      await band(harness, (all) => all.length === 2, "both rows")
      const frame = await harness.frame()
      const dagRow = frame.split("\n").findIndex((row) => row.includes("◆ alpha"))
      const goalRow = frame.split("\n").findIndex((row) => row.includes("◎"))

      await harness.app.mockMouse.click(10, goalRow)
      expect(opened).toBe(0)
      await harness.app.mockMouse.click(10, dagRow)
      await waitFor(() => opened === 1)
      expect(opened).toBe(1)
    } finally {
      off()
      await harness.dispose()
    }
  })

  test("does not subscribe to the ticker", async () => {
    // What the providers around the band ask the ticker for with nothing of the band on screen.
    const bare = counting()
    const empty = await mountBand({ summaries: {}, tables: {} }, { ticker: bare.ticker })
    await empty.harness.settle()
    await empty.harness.dispose()

    const watched = counting()
    const { harness } = await mountBand(running, { ticker: watched.ticker })
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      await band(harness, (all) => all.length === 2 && all[0].includes("第 2/3 波"), "a running workflow and a goal")
      await harness.settle()
      // No animation, no one-second signal and no deadline of its own.
      expect(watched.calls).toEqual(bare.calls)
      expect(watched.calls.frame).toBe(0)
      expect(watched.calls.second).toBe(0)
    } finally {
      await harness.dispose()
    }
  })
})

describe("colors", () => {
  function brandRuns(frame: CapturedFrame, brand: RGBA) {
    const runs: Array<{ row: number; text: string }> = []
    frame.lines.forEach((line, row) => {
      for (const span of line.spans) {
        if (span.fg.equals(brand) && span.text.trim() !== "") runs.push({ row, text: span.text.trim() })
        if (span.bg.equals(brand)) runs.push({ row, text: "background" })
      }
    })
    return runs
  }

  test("paints only the leading mark and the running segments in the brand color", async () => {
    const { harness } = await mountBand(running)
    try {
      harness.events.emit(goalEvent(rootID, goal({ status: "paused", pausedReason: "waiting for watch_pr" })))
      await band(harness, (all) => all.length === 2 && all[0].includes("第 2/3 波"), "both rows")
      const brand = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark").primary
      await harness.app.renderOnce()
      const runs = brandRuns(await harness.spans(), brand)
      // The running node is one segment of three cells; everything else on both rows is gray or a state color.
      expect(runs).toEqual([
        { row: 0, text: "◆" },
        { row: 0, text: "━━━" },
      ])
    } finally {
      await harness.dispose()
    }
  })
})

describe("colors with PR rows", () => {
  test("paints no PR or reminder piece in the brand color: only the workflow row's mark and running segment", async () => {
    const tracked = fakeTracker({
      items: [unresponsiveItem({ number: 1040 }), ciItem({ number: 1036 }), stoppedItem({ number: 1041 })],
      reminder: { when: undefined, text: "ship it", due: true },
    })
    const { harness } = await mountTracked(running, tracked)
    try {
      await band(harness, (all) => all.length === 2 && all[1].includes("第 2/3 波"), "the PR and workflow rows")
      const brand = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark").primary
      await harness.app.renderOnce()
      const frame = await harness.spans()
      const runs: Array<{ row: number; text: string }> = []
      frame.lines.forEach((line, row) => {
        for (const span of line.spans) {
          if (span.fg.equals(brand) && span.text.trim() !== "") runs.push({ row, text: span.text.trim() })
          if (span.bg.equals(brand)) runs.push({ row, text: "background" })
        }
      })
      // The PR row is the first row; the workflow row under it keeps its two places.
      expect(runs).toEqual([
        { row: 1, text: "◆" },
        { row: 1, text: "━━━" },
      ])
    } finally {
      await harness.dispose()
    }
  })
})

describe("at 80 and 120 columns", () => {
  const upgrade: DagWorkflowSummary = {
    ...flow("dag_upgrade", "running"),
    title: "依赖升级验证",
    nodeCount: 9,
    completedNodes: 4,
    runningNodes: 2,
    failedNodes: 1,
    queuedNodes: 2,
  }
  const wideWorld: World = {
    summaries: { [rootID]: [upgrade, flow("dag_other", "completed")] },
    tables: {
      dag_upgrade: [
        wire("dag_upgrade", "n1", "completed"),
        wire("dag_upgrade", "n2", "completed"),
        wire("dag_upgrade", "n3", "completed"),
        wire("dag_upgrade", "n4", "completed", ["n1"]),
        wire("dag_upgrade", "n5", "failed", ["n2"]),
        wire("dag_upgrade", "n6", "running", ["n4"]),
        wire("dag_upgrade", "n7", "running", ["n4"]),
        wire("dag_upgrade", "n8", "queued", ["n6", "n7"]),
        wire("dag_upgrade", "n9", "queued", ["n8"]),
      ],
    },
  }
  const longGoal = goal({
    goal: "全部依赖升到最新稳定版并通过 CI",
    subgoals: ["写迁移脚本", "跑回归"],
    status: "waiting",
    pausedReason: "等待 watch_pr",
  })

  for (const language of ["zh-CN", "en"] as const) {
    for (const width of [80, 120]) {
      for (const aw of [1, 2] as const) {
        test(`draws the rows in ${language} inside ${width} columns at ambiguous width ${aw}`, async () => {
          setLanguage(language)
          const { harness, served } = await mountBand(wideWorld, { width, language, kv: { ambiguous_width: aw } })
          try {
            harness.events.emit(goalEvent(rootID, longGoal))
            await waitFor(() => served.reads.length > 0)
            await harness.settle()
            const drawn = rows(await harness.frame())
            // One row at 80 columns, both from 100 on.
            expect(drawn).toHaveLength(width < BAND_NARROW_WIDTH ? 1 : 2)
            for (const line of drawn) expect(cellWidth(line, aw as AmbiguousWidth), line).toBeLessThanOrEqual(width)
            expect(drawn.join("\n")).toMatchSnapshot()
          } finally {
            await harness.dispose()
          }
        })
      }
    }
  }
})

// ── DAG mode on the band (#1032 7) ─────────────────────────────────────────────────────────────────────────────

const modeSessions = [
  sessionFixture(rootID, { time: { created: 1, updated: 9 }, dagMode: "on" }),
  sessionFixture(childID, { parentID: rootID }),
  sessionFixture(otherID, { time: { created: 1, updated: 3 } }),
]

const palette = () => resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")

/** The color a piece of text is drawn in: the foreground of the first span that holds it. */
function colorOf(frame: CapturedFrame, needle: string): RGBA | undefined {
  for (const line of frame.lines) {
    for (const span of line.spans) if (span.text.includes(needle)) return span.fg
  }
  return undefined
}

const modeReads = (harness: Mount) =>
  harness.requested.filter((entry) => entry === `GET /session/${rootID}/dag-mode`).length

/** A running workflow that has used `tokens`, in a process whose slots are 3 busy out of 12 (set by `budgeted`). */
function usageWorld(tokens: number, extra: Partial<DagWorkflowSummary> = {}): World {
  return {
    summaries: { [rootID]: [flow("dag_alpha", "running", { tokens, concurrencyRunning: 3, ...extra })] },
    tables: { dag_alpha: table("dag_alpha") },
  }
}

const budgeted = (tokens: number | null = 1000, extra: { concurrency?: number } = {}) =>
  dagModeStatus({
    budget: { tokens, used: 620, usedCacheRead: 0, warnRatio: 0.8 },
    limits: { concurrency: extra.concurrency ?? 12, maxTotalNodes: 100, running: 3 },
  })

const sessionUpdated = (info: Session) => event({ type: "session.updated", properties: { info } })
const statusEvent = (sessionID: string, type: "idle" | "busy") =>
  event({ type: "session.status", properties: { sessionID, status: { type } } })
const settledEvent = (sessionID: string, outcome: Record<string, unknown>, timeEnded: number) =>
  event({
    type: "session.turn.settled",
    properties: { sessionID, turnID: `turn_${timeEnded}`, outcome, steps: 1, timeEnded },
  })

/**
 * Mounts the band and enters the session the way the session route does: the data layer then reads what the tree
 * needs, the mode snapshot among it. The band alone has no route to do that. The goal read answers "no goal", as the
 * real server does for a session without one: the harness's default reply parses as an empty goal object.
 */
async function mountEntered(world: World, options: Partial<MountOptions> = {}, entering = rootID) {
  const { handler: first, ...rest } = options
  const mounted = await mountBand(world, {
    ...rest,
    handler: async (url, request) =>
      (await first?.(url, request)) ?? (/^\/session\/[^/]+\/goal$/.test(url.pathname) ? json(null) : undefined),
  })
  await mounted.harness.sync().session.activate(entering)
  return mounted
}

/** The mounted band's row, once `ready` holds for it. */
async function row0(harness: Mount, ready: (line: string) => boolean, what: string) {
  const lines = await band(harness, (all) => all.length > 0 && ready(all[0]), what)
  return lines[0]
}

describe("the mode mark", () => {
  test("says the mode is on when the session has it on", async () => {
    const { harness } = await mountBand(running, { sessions: modeSessions })
    try {
      const line = await row0(harness, (text) => text.includes("第 2/3 波"), "the loaded table")
      expect(line).toContain("模式开")
      expect(line).not.toContain("模式关")
      expect(line.endsWith("/dag")).toBe(true)
      expect(colorOf(await harness.spans(), "模式开")?.equals(palette().text)).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  test("says the mode is off, dim, while a workflow runs under it", async () => {
    const { harness } = await mountBand(running)
    try {
      const line = await row0(harness, (text) => text.includes("第 2/3 波"), "the loaded table")
      expect(line).toContain("模式关")
      const frame = await harness.spans()
      expect(colorOf(frame, "模式关")?.equals(palette().textDim)).toBe(true)
      expect(colorOf(frame, "模式关")?.equals(palette().textMuted)).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  test("says nothing about the mode while it is off and nothing is running", async () => {
    const failedWorld: World = {
      summaries: { [rootID]: [flow("dag_alpha", "failed", { failedNodes: 1, runningNodes: 0, completedNodes: 3 })] },
      tables: {},
    }
    const { harness } = await mountBand(failedWorld)
    try {
      const line = await row0(harness, (text) => text.includes("alpha"), "the unconfirmed failure")
      expect(line).not.toContain("模式")
    } finally {
      await harness.dispose()
    }
  })

  test("follows the session's own switch, without reading anything again", async () => {
    const { harness } = await mountBand(running)
    try {
      await row0(harness, (text) => text.includes("模式关"), "the off mark")
      const reads = modeReads(harness)
      harness.events.emit(sessionUpdated(sessionFixture(rootID, { time: { created: 1, updated: 10 }, dagMode: "on" })))
      await row0(harness, (text) => text.includes("模式开"), "the on mark")
      expect(modeReads(harness)).toBe(reads)
      harness.events.emit(sessionUpdated(sessionFixture(rootID, { time: { created: 1, updated: 11 }, dagMode: "off" })))
      await row0(harness, (text) => text.includes("模式关"), "the off mark again")
      expect(modeReads(harness)).toBe(reads)
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("says it in English", async () => {
    setLanguage("en")
    const { harness } = await mountBand(running, { sessions: modeSessions, language: "en" })
    try {
      const line = await row0(harness, (text) => text.includes("wave 2/3"), "the loaded table")
      expect(line).toContain("mode on")
    } finally {
      await harness.dispose()
    }
  })
})

describe("the usage", () => {
  test("shows the slots of the whole process, the tokens and the budget used, read once and drawn from then on", async () => {
    const { harness } = await mountEntered(usageWorld(620), { sessions: modeSessions, dagMode: () => budgeted() })
    try {
      const line = await row0(harness, (text) => text.includes("预算 62%"), "the usage")
      expect(line).toContain("全进程并发 3/12 · 620 tok · 预算 62%")
      expect(modeReads(harness)).toBe(1)
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("follows the slots of the whole process when a session outside the tree moves them", async () => {
    const { harness } = await mountEntered(usageWorld(620), { sessions: modeSessions, dagMode: () => budgeted() })
    try {
      await row0(harness, (text) => text.includes("全进程并发 3/12"), "the usage")
      // Only the other session's own summary says so; the workflows of this tree keep their old figure of three.
      harness.events.emit(summaryEvent(otherID, [flow("dag_other", "running", { concurrencyRunning: 7 })]))
      const line = await row0(harness, (text) => text.includes("全进程并发 7/12"), "the slots of the whole process")
      expect(line).toContain("全进程并发 7/12 · 620 tok · 预算 62%")
      expect(modeReads(harness)).toBe(1)
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("colors the budget by its band, and takes the color back when the usage falls", async () => {
    const { harness } = await mountEntered(usageWorld(620), { sessions: modeSessions, dagMode: () => budgeted() })
    try {
      await row0(harness, (text) => text.includes("预算 62%"), "the usage")
      expect(colorOf(await harness.spans(), "预算 62%")?.equals(palette().textMuted)).toBe(true)

      const push = (tokens: number) =>
        harness.events.emit(summaryEvent(rootID, [flow("dag_alpha", "running", { tokens, concurrencyRunning: 3 })]))
      push(850)
      await row0(harness, (text) => text.includes("预算 85%"), "the warning band")
      expect(colorOf(await harness.spans(), "预算 85%")?.equals(palette().warning)).toBe(true)

      push(1000)
      await row0(harness, (text) => text.includes("预算 100%"), "the exhausted band")
      expect(colorOf(await harness.spans(), "预算 100%")?.equals(palette().error)).toBe(true)

      push(100)
      await row0(harness, (text) => text.includes("预算 10%"), "the normal band again")
      expect(colorOf(await harness.spans(), "预算 10%")?.equals(palette().textMuted)).toBe(true)
      // The workflows' own events moved all of it: the mode was not read again.
      expect(modeReads(harness)).toBe(1)
    } finally {
      await harness.dispose()
    }
  })

  test("shows no percent without a budget, and no slot count before the mode is known", async () => {
    const { harness } = await mountEntered(usageWorld(5000), { dagMode: () => budgeted(null) })
    try {
      const line = await row0(harness, (text) => text.includes("5K tok"), "the usage")
      expect(line).toContain("全进程并发 3/12 · 5K tok")
      expect(line).not.toContain("预算")
    } finally {
      await harness.dispose()
    }

    const broken = await mountEntered(usageWorld(5000), { dagMode: () => new Response("nope", { status: 500 }) })
    try {
      const line = await row0(broken.harness, (text) => text.includes("5K tok"), "the tokens alone")
      expect(line).not.toContain("并发")
      expect(line).not.toContain("预算")
    } finally {
      await broken.harness.dispose()
    }
  })

  test("reads the mode again when the session's budget changes, and the percent follows", async () => {
    let reply = budgeted(1000)
    const { harness } = await mountEntered(usageWorld(620), { sessions: modeSessions, dagMode: () => reply })
    try {
      await row0(harness, (text) => text.includes("预算 62%"), "the usage")
      reply = budgeted(2000)
      harness.events.emit(
        sessionUpdated(
          sessionFixture(rootID, { time: { created: 1, updated: 10 }, dagMode: "on", dagBudgetTokens: 2000 }),
        ),
      )
      await row0(harness, (text) => text.includes("预算 31%"), "the new budget")
      expect(modeReads(harness)).toBe(2)
    } finally {
      await harness.dispose()
    }
  })

  test("reads the mode again after a reconnect", async () => {
    let reply = budgeted(1000)
    const { harness } = await mountEntered(usageWorld(620), { sessions: modeSessions, dagMode: () => reply })
    try {
      await row0(harness, (text) => text.includes("3/12"), "the usage")
      reply = budgeted(1000, { concurrency: 8 })
      harness.events.reconnect()
      await row0(harness, (text) => text.includes("全进程并发 3/8"), "the new cap")
      expect(modeReads(harness)).toBe(2)
    } finally {
      await harness.dispose()
    }
  })

  test("raises no toast of its own, whether the snapshot arrives exhausted or the band is crossed", async () => {
    const { harness } = await mountEntered(usageWorld(1000), { sessions: modeSessions, dagMode: () => budgeted() })
    try {
      await row0(harness, (text) => text.includes("预算 100%"), "an exhausted snapshot")
      await harness.settle()
      expect(harness.toast().currentToast).toBeNull()
      expect(harness.toast().queued).toEqual([])

      const push = (tokens: number) =>
        harness.events.emit(summaryEvent(rootID, [flow("dag_alpha", "running", { tokens, concurrencyRunning: 3 })]))
      push(100)
      await row0(harness, (text) => text.includes("预算 10%"), "back to normal")
      push(850)
      await row0(harness, (text) => text.includes("预算 85%"), "a warning")
      harness.events.reconnect()
      await harness.settle()
      expect(harness.toast().currentToast).toBeNull()
      expect(harness.toast().queued).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("is the root session's in a sub-agent view", async () => {
    const { harness } = await mountEntered(
      usageWorld(620),
      { sessions: modeSessions, dagMode: () => budgeted(), route: { type: "session", sessionID: childID } },
      childID,
    )
    try {
      const line = await row0(harness, (text) => text.includes("预算 62%"), "the usage")
      expect(line).toContain("模式开")
    } finally {
      await harness.dispose()
    }
  })

  test("keeps the mark and the bar in a 60-column terminal, and the row inside it", async () => {
    for (const aw of [1, 2] as const) {
      const { harness } = await mountEntered(usageWorld(620, { checkpointPending: true }), {
        sessions: modeSessions,
        dagMode: () => budgeted(),
        width: 60,
        kv: { ambiguous_width: aw },
      })
      try {
        const line = await row0(harness, (text) => text.includes("模式开"), "the mark")
        expect(line).toMatch(/[━─]/)
        expect(cellWidth(line, aw as AmbiguousWidth)).toBeLessThanOrEqual(60)
        expect(rows(await harness.frame())).toHaveLength(1)
      } finally {
        await harness.dispose()
      }
    }
  })
})

describe("waiting for the main agent", () => {
  const waiting = (status = "paused"): World => ({
    summaries: { [rootID]: [flow("dag_alpha", status, { checkpointPending: true })] },
    tables: { dag_alpha: table("dag_alpha", "queued") },
  })

  test("a checkpoint is waiting and the main agent is not working: a warning on the row", async () => {
    const { harness } = await mountBand(waiting())
    try {
      const line = await row0(harness, (text) => text.includes("等待主 agent"), "the wait")
      expect(line.endsWith("/dag")).toBe(true)
      expect(colorOf(await harness.spans(), "等待主 agent")?.equals(palette().warning)).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  test("goes while the main agent works, and comes back when it stops", async () => {
    const { harness } = await mountBand(waiting())
    try {
      await row0(harness, (text) => text.includes("等待主 agent"), "the wait")
      harness.events.emit(statusEvent(rootID, "busy"))
      await row0(harness, (text) => !text.includes("等待主 agent"), "the main agent busy")
      harness.events.emit(statusEvent(rootID, "idle"))
      await row0(harness, (text) => text.includes("等待主 agent"), "the main agent idle")
    } finally {
      await harness.dispose()
    }
  })

  test("a turn that ended in an error counts as not working, whatever the status says", async () => {
    const { harness } = await mountBand(waiting())
    try {
      harness.events.emit(statusEvent(rootID, "busy"))
      await row0(harness, (text) => !text.includes("等待主 agent"), "the main agent busy")
      harness.events.emit(settledEvent(rootID, { type: "error", code: "provider_error", retryable: true }, 5_000))
      await row0(harness, (text) => text.includes("等待主 agent"), "the error")
      // A later turn that settled well is not an error.
      harness.events.emit(settledEvent(rootID, { type: "completed" }, 6_000))
      await row0(harness, (text) => !text.includes("等待主 agent"), "the error gone")
    } finally {
      await harness.dispose()
    }
  })

  test("says nothing when no checkpoint waits", async () => {
    const quiet: World = {
      summaries: { [rootID]: [flow("dag_alpha", "paused")] },
      tables: { dag_alpha: table("dag_alpha", "queued") },
    }
    const { harness } = await mountBand(quiet)
    try {
      const line = await row0(harness, (text) => text.includes("alpha"), "the paused workflow")
      expect(line).not.toContain("等待主")
    } finally {
      await harness.dispose()
    }
  })

  test("says it in English", async () => {
    setLanguage("en")
    const { harness } = await mountBand(waiting(), { language: "en" })
    try {
      await row0(harness, (text) => text.includes("waiting for main agent"), "the wait")
    } finally {
      await harness.dispose()
    }
  })
})

describe("DAG mode at 80 and 120 columns", () => {
  const upgrade: World = {
    summaries: {
      [rootID]: [
        flow("dag_upgrade", "running", {
          title: "依赖升级验证",
          nodeCount: 9,
          completedNodes: 4,
          runningNodes: 2,
          failedNodes: 1,
          queuedNodes: 2,
          tokens: 850,
          concurrencyRunning: 3,
          checkpointPending: true,
        }),
      ],
    },
    tables: {
      dag_upgrade: [
        wire("dag_upgrade", "n1", "completed"),
        wire("dag_upgrade", "n2", "completed"),
        wire("dag_upgrade", "n3", "completed"),
        wire("dag_upgrade", "n4", "completed", ["n1"]),
        wire("dag_upgrade", "n5", "failed", ["n2"]),
        wire("dag_upgrade", "n6", "running", ["n4"]),
        wire("dag_upgrade", "n7", "running", ["n4"]),
        wire("dag_upgrade", "n8", "queued", ["n6", "n7"]),
        wire("dag_upgrade", "n9", "queued", ["n8"]),
      ],
    },
  }

  for (const language of ["zh-CN", "en"] as const) {
    for (const width of [80, 120]) {
      for (const aw of [1, 2] as const) {
        test(`draws the mark, the usage and the wait in ${language} inside ${width} columns at ambiguous width ${aw}`, async () => {
          setLanguage(language)
          const { harness, served } = await mountEntered(upgrade, {
            sessions: modeSessions,
            dagMode: () => budgeted(1000),
            width,
            language,
            kv: { ambiguous_width: aw },
          })
          try {
            await waitFor(() => served.reads.length > 0)
            await harness.settle()
            const drawn = rows(await harness.frame())
            expect(drawn).toHaveLength(1)
            for (const line of drawn) expect(cellWidth(line, aw as AmbiguousWidth), line).toBeLessThanOrEqual(width)
            // The mark does not give way at either width, and the bar is still there beside it.
            expect(drawn[0]).toContain(language === "en" ? "mode on" : "模式开")
            expect(drawn[0]).toMatch(/[━─]/)
            // The budget is at its warning band (850 of 1000), so it is the last piece of the usage to go: both widths
            // keep it. At 120 columns the wait that is also on the row keeps its place beside it; at 80 the room
            // beside the bar, the title and the counts is short for both, and the budget stays while the wait goes.
            if (aw === 1) {
              expect(drawn[0]).toContain(language === "en" ? "budget 85%" : "预算 85%")
              const wait = language === "en" ? "waiting for main agent" : "等待主 agent"
              if (width === 120) expect(drawn[0]).toContain(wait)
              else expect(drawn[0]).not.toContain(wait)
            }
            expect(drawn.join("\n")).toMatchSnapshot()
          } finally {
            await harness.dispose()
          }
        })
      }
    }
  }
})

describe("a goal that is not one", () => {
  /** A goal body as a broken server might send it: the wire type says what a goal has, this has less. */
  function malformed(body: Record<string, unknown>): Goal {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic: a body the wire type does not allow.
    return body as unknown as Goal
  }

  test("takes no row, and the rest of the band goes on following the server", async () => {
    const { harness } = await mountBand(running)
    try {
      await band(harness, (all) => all.some((row) => row.includes("第 2/3 波")), "the loaded table")

      harness.events.emit(goalEvent(rootID, malformed({})))
      harness.events.emit(summaryEvent(rootID, [flow("dag_alpha", "running", { completedNodes: 3, queuedNodes: 0 })]))
      const lines = await band(harness, (all) => all.some((row) => row.includes("3/4 完成")), "the refreshed counts")
      // The workflow row only: a goal row with nothing in it would still take a line.
      expect(lines).toHaveLength(1)

      // A body with a text and no status is no goal either; the row stays away and the band still refreshes.
      harness.events.emit(goalEvent(rootID, malformed({ goal: "ship the upgrade" })))
      harness.events.emit(
        summaryEvent(rootID, [flow("dag_alpha", "running", { completedNodes: 4, queuedNodes: 0, runningNodes: 0 })]),
      )
      const later = await band(harness, (all) => all.some((row) => row.includes("4/4 完成")), "the counts again")
      expect(later).toHaveLength(1)

      // And a goal that is one gets its row once it arrives.
      harness.events.emit(goalEvent(rootID, goal()))
      const both = await band(harness, (all) => all.length === 2 && all[1].includes("◎ 目标"), "the real goal")
      expect(both[0]).toContain("4/4 完成")
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("does not stop the goal row of the next goal from coming and updating either", async () => {
    const { harness } = await mountBand(running)
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      await band(harness, (all) => all.length === 2 && all[1].includes("第 6/30 轮"), "the goal")
      harness.events.emit(goalCleared(rootID))
      await band(harness, (all) => all.length === 1, "the goal cleared")
      // The store merges an update into what it holds; with nothing held, this body is all there is of the goal.
      harness.events.emit(goalEvent(rootID, malformed({ status: "active" })))
      await harness.settle()
      expect(rows(await harness.frame())).toHaveLength(1)
      // A goal that is one arrives on top of it and is drawn whole.
      harness.events.emit(goalEvent(rootID, goal({ turnsUsed: 7 })))
      await band(harness, (all) => all.length === 2 && all[1].includes("第 7/30 轮"), "the goal again")
    } finally {
      await harness.dispose()
    }
  })
})

// ── PRs and reminders on the band (#1036 F6) ────────────────────────────────────────────────────────────────────

// A click on the PR row hands the address to `open`; the test records it and starts no browser. The mock is the
// whole process's until it is put back.
const opened: string[] = []
const realOpen = open
void mock.module("open", () => ({
  default: async (target: string) => {
    opened.push(target)
  },
}))
afterAll(() => {
  void mock.module("open", () => ({ default: realOpen }))
})

/** The tracker the band reads, driven by hand: the band draws what this lists, and nothing else moves it. */
function fakeTracker(initial: { items?: readonly PrBandItem[]; reminder?: ReminderBandItem } = {}) {
  const [items, setItems] = createSignal(initial.items ?? [])
  const [reminder, setReminder] = createSignal(initial.reminder)
  const roots = new Set<string | undefined>()
  const tracker: PrTracker = {
    items(root) {
      roots.add(root)
      return items()
    },
    reminder(root) {
      roots.add(root)
      return reminder()
    },
  }
  return { tracker, setItems, setReminder, roots }
}

type FakeTracker = ReturnType<typeof fakeTracker>

/** The band with a PR tracker around it, as the app provides one. */
function mountTracked(world: World, tracked: FakeTracker, options: Partial<MountOptions> = {}) {
  return mountBand(world, {
    ...options,
    view: () => (
      <PrTrackerProvider value={tracked.tracker}>
        <SessionStatusBand />
      </PrTrackerProvider>
    ),
  })
}

const noFlow: World = { summaries: {}, tables: {} }
const trimmed = (all: string[]) => all.map((row) => row.trim())

/** Rows of the band, once it has settled. */
async function settled(harness: Mount) {
  await harness.settle()
  return rows(await harness.frame())
}

const wait5 = (over: Partial<ReminderBandItem> = {}): ReminderBandItem => ({
  when: "5m",
  text: "部署完成后检查",
  due: false,
  ...over,
})

describe("the PR row", () => {
  test("draws a watched PR as a row of its own, follows the tracker, and leaves no line when it lists none", async () => {
    const tracked = fakeTracker({ items: [ciItem()] })
    const { harness } = await mountTracked(noFlow, tracked)
    try {
      expect(trimmed(await band(harness, (all) => all.length === 1, "the PR row"))).toEqual(["PR #1035  CI 4/6"])

      tracked.setItems([workingItem()])
      const next = await band(harness, (all) => all[0]?.includes("agent 处理中") ?? false, "the new state")
      expect(trimmed(next)).toEqual(["PR #1035  ✓ 通过 · agent 处理中"])

      tracked.setItems([])
      await band(harness, (all) => all.length === 0, "no row")
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("says it in English", async () => {
    setLanguage("en")
    const tracked = fakeTracker({ items: [workingItem()] })
    const { harness } = await mountTracked(noFlow, tracked, { language: "en" })
    try {
      expect(trimmed(await band(harness, (all) => all.length === 1, "the PR row"))).toEqual([
        "PR #1035  ✓ passed · agent working",
      ])
    } finally {
      await harness.dispose()
    }
  })

  test("asks the tracker about the root session, also from a sub-agent view", async () => {
    const tracked = fakeTracker({ items: [ciItem()] })
    const { harness } = await mountTracked(noFlow, tracked, { route: { type: "session", sessionID: childID } })
    try {
      await band(harness, (all) => all.length === 1, "the PR row")
      expect(tracked.roots).toEqual(new Set([rootID]))
    } finally {
      await harness.dispose()
    }
  })

  test("is not there without a tracker: a band mounted alone draws no PR and no reminder", async () => {
    const { harness } = await mountBand(running)
    try {
      const lines = await band(harness, (all) => all.some((row) => row.includes("第 2/3 波")), "the workflow row")
      expect(lines).toHaveLength(1)
      expect(lines[0]).not.toContain("PR")
      expect(lines[0].trimEnd().endsWith("/dag")).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  test("rides at the tail of the workflow row when a workflow row is drawn, and has no row of its own", async () => {
    const tracked = fakeTracker({ items: [ciItem()] })
    const { harness } = await mountTracked(running, tracked)
    try {
      const lines = await band(harness, (all) => all.some((row) => row.includes("第 2/3 波")), "the workflow row")
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("◆ alpha")
      expect(lines[0].trimEnd().endsWith("/dag  PR ~4/6")).toBe(true)

      // The tail follows the PR.
      tracked.setItems([workingItem()])
      const working = await band(harness, (all) => all.some((row) => row.trimEnd().endsWith("PR >")), "the new mark")
      expect(working).toHaveLength(1)

      tracked.setItems([])
      const none = await band(harness, (all) => all.length === 1 && !all[0].includes("PR"), "the tail gone")
      expect(none[0].trimEnd().endsWith("/dag")).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  test("gives a PR warning the first row, over the workflow row, and leaves the goal to the drawer", async () => {
    const tracked = fakeTracker({ items: [unresponsiveItem({ number: 1040 })] })
    const { harness } = await mountTracked(running, tracked)
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      const lines = await band(harness, (all) => all.length === 2 && all[1].includes("第 2/3 波"), "two rows")
      await harness.settle()
      const drawn = rows(await harness.frame())
      expect(drawn).toHaveLength(2)
      expect(drawn[0].trim()).toBe("PR #1040  ✓ 通过 · agent 未响应")
      expect(drawn[1]).toContain("◆ alpha")
      // The workflow row carries no PR mark: the warning has the row for it.
      expect(drawn[1]).not.toContain("PR")
      expect(lines.some((row) => row.includes("◎"))).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  test(`shows only the warning below ${BAND_NARROW_WIDTH} columns, and leaves the workflow undeclared until it clears`, async () => {
    const tracked = fakeTracker({ items: [unresponsiveItem({ number: 1040 })] })
    const { harness, served } = await mountTracked(running, tracked, { width: BAND_NARROW_WIDTH - 1 })
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      const lines = await band(harness, (all) => all.length === 1 && all[0].includes("PR #1040"), "the PR row")
      await harness.settle()
      expect(trimmed(rows(await harness.frame()))).toEqual(["PR #1040  ✓ 通过 · agent 未响应"])
      expect(lines).toHaveLength(1)
      // The workflow is not on screen, so its table was not asked for.
      expect(served.reads).toHaveLength(0)

      // The warning clears: the workflow row comes back, and the table is read for it.
      tracked.setItems([])
      await band(harness, (all) => all.length === 1 && all[0].includes("◆ alpha"), "the workflow row")
      await waitFor(() => served.reads.length === 1)
    } finally {
      await harness.dispose()
    }
  })

  test("takes the row the workflow had while the /dag panel hides it, and gives it back when the panel closes", async () => {
    const tracked = fakeTracker({ items: [ciItem()] })
    const { harness } = await mountTracked(running, tracked, { frame: true })
    try {
      await band(harness, (all) => all.some((row) => row.trimEnd().endsWith("/dag  PR ~4/6")), "the tail")

      harness.bottomZone()!.host.push({ id: DAG_PANEL_ID, render: () => <text>panel</text> })
      await band(
        harness,
        (all) => !all.some((row) => row.includes("◆ alpha")) && all.some((row) => row.includes("PR #1035  CI 4/6")),
        "the PR row alone",
      )

      harness.bottomZone()!.host.close()
      await band(harness, (all) => all.some((row) => row.trimEnd().endsWith("/dag  PR ~4/6")), "the tail again")
    } finally {
      await harness.dispose()
    }
  })

  test("rides at the tail of the row `always` shows while there is no workflow", async () => {
    const tracked = fakeTracker({ items: [ciItem()] })
    const { harness } = await mountTracked(noFlow, tracked, { kv: { dag_band: "always" } })
    try {
      const lines = await band(harness, (all) => all.some((row) => row.includes("没有工作流")), "the empty row")
      expect(lines).toHaveLength(1)
      expect(lines[0].trimEnd().endsWith("/dag  PR ~4/6")).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  test("takes the first row under `hidden`, where no workflow row competes for it", async () => {
    const tracked = fakeTracker({ items: [ciItem()] })
    const { harness } = await mountTracked(running, tracked, { kv: { dag_band: "hidden" } })
    try {
      const lines = await band(harness, (all) => all.length === 1, "the PR row")
      expect(trimmed(lines)).toEqual(["PR #1035  CI 4/6"])
    } finally {
      await harness.dispose()
    }
  })
})

describe("the PR row at several PRs", () => {
  const several = () => [
    unresponsiveItem({ number: 1040, url: "https://example.test/acme/repo/pull/1040" }),
    ciItem({ number: 1036 }),
    workingItem({ number: 1035 }),
    bandItem({ number: 1034 }),
  ]

  test("compresses to marks, the warning first", async () => {
    const tracked = fakeTracker({ items: several() })
    const { harness } = await mountTracked(noFlow, tracked)
    try {
      const lines = await band(harness, (all) => all.length === 1, "the PR row")
      expect(trimmed(lines)).toEqual(["PR !#1040 ~#1036 >#1035 ✓#1034"])
    } finally {
      await harness.dispose()
    }
  })

  test("counts what does not fit in +k, in a terminal that is short of columns", async () => {
    const tracked = fakeTracker({ items: several() })
    const { harness } = await mountTracked(noFlow, tracked, { width: 22 })
    try {
      const lines = await band(harness, (all) => all.length === 1, "the PR row")
      expect(trimmed(lines)).toEqual(["PR !#1040 +3"])
    } finally {
      await harness.dispose()
    }
  })

  test("is one mark at the workflow row's tail, `PR ~#1036 +1`, within 14 cells", async () => {
    const tracked = fakeTracker({ items: [ciItem({ number: 1036 }), workingItem({ number: 1035 })] })
    const { harness } = await mountTracked(running, tracked)
    try {
      const lines = await band(harness, (all) => all.some((row) => row.includes("第 2/3 波")), "the workflow row")
      expect(lines).toHaveLength(1)
      expect(lines[0].trimEnd().endsWith("/dag  PR ~#1036 +1")).toBe(true)
    } finally {
      await harness.dispose()
    }
  })
})

describe("the reminder row", () => {
  test("says how long is left and what for, and turns to a due warning once it fired", async () => {
    const tracked = fakeTracker({ reminder: wait5() })
    const { harness } = await mountTracked(noFlow, tracked)
    try {
      expect(trimmed(await band(harness, (all) => all.length === 1, "the reminder"))).toEqual([
        "提醒 · 5m后 · 部署完成后检查",
      ])

      tracked.setReminder(wait5({ when: undefined, due: true }))
      expect(trimmed(await band(harness, (all) => all[0]?.includes("已到期") ?? false, "due"))).toEqual([
        "提醒 · 已到期 · 部署完成后检查",
      ])

      tracked.setReminder(undefined)
      await band(harness, (all) => all.length === 0, "no row")
    } finally {
      await harness.dispose()
    }
  })

  test("says it in English", async () => {
    setLanguage("en")
    const tracked = fakeTracker({ reminder: wait5({ text: "deploy" }) })
    const { harness } = await mountTracked(noFlow, tracked, { language: "en" })
    try {
      expect(trimmed(await band(harness, (all) => all.length === 1, "the reminder"))).toEqual([
        "reminder · in 5m · deploy",
      ])
    } finally {
      await harness.dispose()
    }
  })

  test("has a row only when there is room: under the goal, ahead of nothing else", async () => {
    const tracked = fakeTracker({ reminder: wait5() })
    const { harness } = await mountTracked(noFlow, tracked)
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      const lines = await band(harness, (all) => all.length === 2, "the goal and the reminder")
      expect(lines[0]).toContain("◎ 目标")
      expect(lines[1]).toContain("提醒 · 5m后")

      // A workflow row and a goal row fill the band: the reminder gives way.
      tracked.setItems([])
      const full = await mountTracked(running, tracked)
      try {
        full.harness.events.emit(goalEvent(rootID, goal()))
        const two = await band(full.harness, (all) => all.length === 2 && all[0].includes("第 2/3 波"), "two rows")
        expect(two.some((row) => row.includes("提醒"))).toBe(false)
      } finally {
        await full.harness.dispose()
      }
    } finally {
      await harness.dispose()
    }
  })

  test(`yields to the goal below ${BAND_NARROW_WIDTH} columns`, async () => {
    const tracked = fakeTracker({ reminder: wait5() })
    const { harness } = await mountTracked(noFlow, tracked, { width: BAND_NARROW_WIDTH - 1 })
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      const lines = await band(harness, (all) => all.some((row) => row.includes("◎")), "the goal")
      await harness.settle()
      expect(rows(await harness.frame())).toHaveLength(1)
      expect(lines[0]).not.toContain("提醒")
    } finally {
      await harness.dispose()
    }
  })
})

describe("clicking the PR row", () => {
  beforeEach(() => {
    opened.length = 0
  })

  test("opens the pull request in the browser, once per click, and sends nothing to the server", async () => {
    const tracked = fakeTracker({ items: [ciItem({ url: "https://example.test/acme/repo/pull/1035" })] })
    const { harness } = await mountTracked(noFlow, tracked)
    try {
      await band(harness, (all) => all.length === 1, "the PR row")
      const frame = await harness.frame()
      const prRow = frame.split("\n").findIndex((row) => row.includes("PR #1035"))

      await harness.app.mockMouse.click(10, prRow)
      await waitFor(() => opened.length === 1)
      expect(opened).toEqual(["https://example.test/acme/repo/pull/1035"])

      await harness.app.mockMouse.click(90, prRow)
      await waitFor(() => opened.length === 2)
      await harness.settle()
      expect(opened).toEqual(["https://example.test/acme/repo/pull/1035", "https://example.test/acme/repo/pull/1035"])
      expect(harness.writes()).toEqual([])
      expect(harness.requested.filter((entry) => entry.startsWith("POST") || entry.startsWith("PUT"))).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("opens the first PR's page when several are compressed into one row, the warning one first", async () => {
    const tracked = fakeTracker({
      items: [
        unresponsiveItem({ number: 1040, url: "https://example.test/acme/repo/pull/1040" }),
        ciItem({ number: 1036, url: "https://example.test/acme/repo/pull/1036" }),
      ],
    })
    const { harness } = await mountTracked(noFlow, tracked)
    try {
      await band(harness, (all) => all.length === 1, "the PR row")
      const prRow = (await harness.frame()).split("\n").findIndex((row) => row.includes("PR !#1040"))
      await harness.app.mockMouse.click(6, prRow)
      await waitFor(() => opened.length === 1)
      expect(opened).toEqual(["https://example.test/acme/repo/pull/1040"])
    } finally {
      await harness.dispose()
    }
  })

  test("opens nothing for an address that is not a web page", async () => {
    const tracked = fakeTracker({ items: [ciItem({ url: "file:///etc/passwd" })] })
    const { harness } = await mountTracked(noFlow, tracked)
    try {
      await band(harness, (all) => all.length === 1, "the PR row")
      const prRow = (await harness.frame()).split("\n").findIndex((row) => row.includes("PR #1035"))
      await harness.app.mockMouse.click(6, prRow)
      await harness.settle()
      expect(opened).toEqual([])
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("does nothing for the goal row or the reminder row", async () => {
    const tracked = fakeTracker({ reminder: wait5() })
    const { harness } = await mountTracked(noFlow, tracked)
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      await band(harness, (all) => all.length === 2, "the goal and the reminder")
      const lines = (await harness.frame()).split("\n")
      await harness.app.mockMouse.click(
        10,
        lines.findIndex((row) => row.includes("◎")),
      )
      await harness.app.mockMouse.click(
        10,
        lines.findIndex((row) => row.includes("提醒")),
      )
      await harness.settle()
      expect(opened).toEqual([])
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("follows the row's kind as the rows change: the workflow row opens /dag, the warning row the page", async () => {
    const tracked = fakeTracker({ items: [ciItem({ number: 1036 })] })
    const { harness } = await mountTracked(running, tracked)
    let dagOpened = 0
    const off = harness.registry().setHandler("dag.open", () => {
      dagOpened++
    })
    try {
      await band(harness, (all) => all.some((row) => row.trimEnd().endsWith("/dag  PR ~4/6")), "the tail")
      const rowOf = async (needle: string) =>
        (await harness.frame()).split("\n").findIndex((row) => row.includes(needle))

      // The workflow row is the first row, with the PR mark at its tail: a click opens /dag, not the page.
      await harness.app.mockMouse.click(10, await rowOf("◆ alpha"))
      await waitFor(() => dagOpened === 1)
      expect(opened).toEqual([])

      // A warning comes: the PR row takes the first row, and the workflow row moves down with its handler.
      tracked.setItems([unresponsiveItem({ number: 1040, url: "https://example.test/acme/repo/pull/1040" })])
      await band(harness, (all) => all.length === 2 && all[0].includes("PR #1040"), "the warning row first")
      await harness.settle()
      // The first click left a selection on text that is gone; a click is not a drag, so the band opens on it.
      harness.app.renderer.clearSelection()
      await harness.app.mockMouse.click(10, await rowOf("PR #1040"))
      await waitFor(() => opened.length === 1)
      expect(opened).toEqual(["https://example.test/acme/repo/pull/1040"])
      expect(dagOpened).toBe(1)

      harness.app.renderer.clearSelection()
      await harness.app.mockMouse.click(10, await rowOf("◆ alpha"))
      await waitFor(() => dagOpened === 2)
      expect(opened).toHaveLength(1)
      expect(harness.writes()).toEqual([])
    } finally {
      off()
      await harness.dispose()
    }
  })
})

describe("the band with PR rows is still read only and clock-free", () => {
  test("does not subscribe to the ticker with PR, workflow, goal and reminder rows asked of it", async () => {
    // What the providers around the band ask the ticker for with nothing of the band on screen.
    const bare = counting()
    const empty = await mountTracked(noFlow, fakeTracker(), { ticker: bare.ticker })
    await empty.harness.settle()
    await empty.harness.dispose()

    const watched = counting()
    const tracked = fakeTracker({ items: [unresponsiveItem({ number: 1040 })], reminder: wait5() })
    const { harness } = await mountTracked(running, tracked, { ticker: watched.ticker })
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      await band(harness, (all) => all.length === 2 && all[0].includes("PR #1040"), "the PR and workflow rows")
      tracked.setItems([ciItem(), workingItem({ number: 1035 })])
      tracked.setReminder(wait5({ when: "4m" }))
      await band(harness, (all) => all.some((row) => row.includes("PR ~#1035")), "the new rows")
      await harness.settle()
      expect(watched.calls).toEqual(bare.calls)
      expect(watched.calls.frame).toBe(0)
      expect(watched.calls.second).toBe(0)
    } finally {
      await harness.dispose()
    }
  })
})

// ── A held PR warning follows the language (#1409) ──────────────────────────────────────────────────────────────────
//
// The real tracker, not the stand-in: the warning it keeps after the server dropped the entry was a copy of the words
// it had when it was raised, so it stayed in that language while the rest of the band was worded again.

/** The tracker as `app.tsx` wires it, over a store of its own and a clock that stands still (its `at` never fires). */
function liveTracker(now: number) {
  const toasts: ToastOptions[] = []
  const [data, setData] = createStore({
    pr_watch: {} as Record<string, Record<string, PrWatchEntry>>,
    reminder: {},
    session_status: {},
    message: {},
    part: {},
    hydrated: [rootID],
  })
  const tracker = createPrTracker({
    data,
    ticker: { now: () => now, at: () => () => {} },
    toast: { show: (options) => void toasts.push(options) },
    onPrWatchEvent: () => () => {},
    currentRoot: () => rootID,
  })
  return {
    tracker,
    toasts,
    /** What a read of the root's watches does: the map is replaced, and no event runs. */
    replace(entries: readonly PrWatchEntry[]) {
      const map = Object.fromEntries(entries.map((entry) => [entry.watchID, entry]))
      setData("pr_watch", rootID, reconcile(map))
    },
  }
}

describe("a held PR warning follows the language", () => {
  test("the band words it again after each switch, at 80 columns, with no toast and no request", async () => {
    setLanguage("zh-CN")
    let live!: ReturnType<typeof liveTracker>
    const { harness } = await mountBand(noFlow, {
      width: 80,
      height: 24,
      language: "zh-CN",
      view: () => {
        live = liveTracker(T0 + 4 * MINUTE)
        return (
          <PrTrackerProvider value={live.tracker}>
            <SessionStatusBand />
          </PrTrackerProvider>
        )
      },
    })
    try {
      // Notified at `T0`, nobody answered, and it is four minutes later: the warning is raised when it first appears.
      live.replace([prEntry({ sessionID: rootID, delivery: { state: "delivered", deliveredAt: T0 } })])
      await band(harness, (all) => all.length === 1, "the warning")
      // The server drops the entry; what is drawn from here on is the tracker's held copy of the warning.
      live.replace([])
      const zh = await settled(harness)
      expect(trimmed(zh)).toEqual(["PR #1035  ✓ 通过 · agent 未响应"])
      expect(zh.join("\n")).toMatchSnapshot()

      setLanguage("en")
      const en = await band(
        harness,
        (all) => all[0]?.includes("agent not responding") ?? false,
        "the warning in English",
      )
      expect(trimmed(en)).toEqual(["PR #1035  ✓ passed · agent not responding"])
      expect(en.join("\n")).toMatchSnapshot()

      setLanguage("zh-CN")
      expect(await band(harness, (all) => all[0]?.includes("agent 未响应") ?? false, "the warning again")).toEqual(zh)

      for (const line of [...zh, ...en]) expect(cellWidth(line, 1), line).toBeLessThanOrEqual(80)
      expect(live.toasts).toEqual([])
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })
})

describe("PR and reminder rows at 80 and 120 columns", () => {
  interface Scenario {
    readonly name: string
    readonly world: World
    readonly items?: () => readonly PrBandItem[]
    readonly reminder?: ReminderBandItem
    readonly goal?: boolean
    /** Rows drawn at 80 columns (below the narrow limit) and at 120. */
    readonly rows: readonly [number, number]
    /** Whether the workflow row is drawn at 80 columns and at 120: its table is read only then. */
    readonly dag?: readonly [boolean, boolean]
  }

  const scenarios: readonly Scenario[] = [
    { name: "a watched PR over the goal", world: noFlow, items: () => [ciItem()], goal: true, rows: [1, 2] },
    {
      name: "a PR mark at the workflow row's tail",
      world: running,
      items: () => [ciItem()],
      goal: true,
      rows: [1, 2],
      dag: [true, true],
    },
    {
      name: "a PR warning over the workflow row",
      world: running,
      items: () => [unresponsiveItem({ number: 1040 })],
      goal: true,
      rows: [1, 2],
      dag: [false, true],
    },
    {
      name: "several PRs",
      world: noFlow,
      items: () => [
        unresponsiveItem({ number: 1040 }),
        ciItem({ number: 1036 }),
        workingItem({ number: 1035 }),
        bandItem({ number: 1034 }),
      ],
      goal: true,
      rows: [1, 2],
    },
    { name: "a reminder", world: noFlow, reminder: wait5(), rows: [1, 1] },
  ]

  async function drawScenario(scenario: Scenario, options: Partial<MountOptions> & { width: number }) {
    const tracked = fakeTracker({ items: scenario.items?.(), reminder: scenario.reminder })
    const { harness, served } = await mountTracked(scenario.world, tracked, options)
    if (scenario.goal) harness.events.emit(goalEvent(rootID, goal()))
    if (scenario.dag?.[options.width < BAND_NARROW_WIDTH ? 0 : 1]) await waitFor(() => served.reads.length > 0)
    return { harness, tracked }
  }

  for (const language of ["zh-CN", "en"] as const) {
    for (const [width, height] of [
      [80, 24],
      [120, 40],
    ] as const) {
      for (const scenario of scenarios) {
        test(`draws ${scenario.name} in ${language} at ${width}x${height}`, async () => {
          setLanguage(language)
          const { harness } = await drawScenario(scenario, { width, height, language })
          try {
            const expected = scenario.rows[width === 80 ? 0 : 1]
            await band(harness, (all) => all.length === expected, `${expected} rows`)
            const drawn = await settled(harness)
            expect(drawn).toHaveLength(expected)
            for (const line of drawn) expect(cellWidth(line, 1), line).toBeLessThanOrEqual(width)
            expect(drawn.join("\n")).toMatchSnapshot()
            expect(harness.writes()).toEqual([])
          } finally {
            await harness.dispose()
          }
        })
      }
    }

    for (const scenario of scenarios) {
      test(`keeps ${scenario.name} inside 80 columns at ambiguous width 2 in ${language}`, async () => {
        setLanguage(language)
        const { harness } = await drawScenario(scenario, {
          width: 80,
          height: 24,
          language,
          kv: { ambiguous_width: 2 },
        })
        try {
          await band(harness, (all) => all.length === scenario.rows[0], `${scenario.rows[0]} rows`)
          const drawn = await settled(harness)
          expect(drawn).toHaveLength(scenario.rows[0])
          for (const line of drawn) expect(cellWidth(line, 2), line).toBeLessThanOrEqual(80)
        } finally {
          await harness.dispose()
        }
      })
    }
  }
})

// ── The background runs on the band (#1058 4) ───────────────────────────────────────────────────────────────────
//
// A mark `◇ 后台 n` at the tail of the first row that is not a warning, a row of the runs alone when there is no
// other row, neither below the narrow limit. A click on the mark or on that row opens `/agents`. No clock.

/** The mark of the two runs `twoRuns` seeds: both are going, one of them is waiting for a slot. */
const MARK = "◇ 后台 2·排1"

/** Two runs of the root session that are going: a running one and a queued one. */
function twoRuns(harness: Mount) {
  const sync = harness.sync()
  seedRun(sync, {
    parent: rootID,
    key: "review",
    state: "running",
    kind: "review",
    description: "未提交改动",
    startedAt: RUN_START + 2,
  })
  seedRun(sync, {
    parent: rootID,
    key: "scan",
    state: "queued",
    kind: "explore",
    description: "扫描依赖",
    startedAt: RUN_START + 1,
  })
}

/** The first row of the frame that holds `needle`, as a row index, and the cell column `mark` starts at in it. */
async function columnOfIn(harness: Mount, needle: string, mark: string) {
  const lines = (await harness.frame()).split("\n")
  const row = lines.findIndex((line) => line.includes(needle))
  if (row < 0) throw new Error(`no row holds ${needle}`)
  return { row, x: cellWidth(lines[row].slice(0, lines[row].indexOf(mark))) }
}

describe("the background mark", () => {
  test("rides at the tail of the workflow row, after the PR mark and the hint", async () => {
    const { harness } = await mountTracked(running, fakeTracker({ items: [ciItem()] }))
    try {
      await band(harness, (all) => all.some((row) => row.trimEnd().endsWith("/dag  PR ~4/6")), "the workflow row")
      twoRuns(harness)
      const lines = await band(harness, (all) => all.some((row) => row.includes(MARK)), "the mark")
      expect(lines).toHaveLength(1)
      expect(lines[0].trimEnd().endsWith(`/dag  PR ~4/6  ${MARK}`)).toBe(true)
      expect(lines[0]).toContain("◆ alpha")
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("rides at the tail of the goal row, and not at the cost of the goal", async () => {
    const { harness } = await mountBand(noFlow)
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      await band(harness, (all) => all.length === 1, "the goal row")
      twoRuns(harness)
      const lines = await band(harness, (all) => all.some((row) => row.includes(MARK)), "the mark")
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("◎ 目标  ship the upgrade")
      expect(lines[0].trimEnd().endsWith(`/goal  ${MARK}`)).toBe(true)

      // A goal too long for its row fills it: the mark is left out and the goal is not cut for it.
      harness.events.emit(goalEvent(rootID, goal({ goal: "ship the upgrade ".repeat(12) })))
      const long = await band(
        harness,
        (all) => all.some((row) => row.includes("ship the upgrade ship")),
        "the long goal",
      )
      expect(long).toHaveLength(1)
      expect(long[0]).not.toContain("◇")
    } finally {
      await harness.dispose()
    }
  })

  test("rides on the first row that is not a warning: under a PR warning, on the workflow row", async () => {
    const tracked = fakeTracker({ items: [unresponsiveItem({ number: 1040 })] })
    const { harness } = await mountTracked(running, tracked)
    try {
      await band(harness, (all) => all.length === 2 && all[0].includes("PR #1040"), "the warning over the workflow")
      twoRuns(harness)
      const lines = await band(harness, (all) => all.some((row) => row.includes("◇")), "the mark")
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain("PR #1040")
      expect(lines[0]).not.toContain("◇")
      expect(lines[1]).toContain("◆ alpha")
      expect(lines[1].trimEnd().endsWith(MARK)).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  test("has no place on a PR warning that is the only row: the runs get no row of their own then", async () => {
    const { harness } = await mountTracked(noFlow, fakeTracker({ items: [unresponsiveItem({ number: 1040 })] }))
    try {
      await band(harness, (all) => all.length === 1 && all[0].includes("PR #1040"), "the warning")
      twoRuns(harness)
      const lines = await settled(harness)
      expect(lines).toHaveLength(1)
      expect(lines[0]).not.toContain("◇")
    } finally {
      await harness.dispose()
    }
  })

  test("is not put on a workflow row whose budget is at its warning band: the goal row under it takes it", async () => {
    const { harness } = await mountEntered(usageWorld(850), { sessions: modeSessions, dagMode: () => budgeted() })
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      await band(harness, (all) => all.length === 2 && all[0].includes("预算 85%"), "the alert row and the goal row")
      twoRuns(harness)
      const lines = await band(harness, (all) => all.some((row) => row.includes("◇")), "the mark")
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain("预算 85%")
      expect(lines[0]).not.toContain("◇")
      expect(lines[1]).toContain("◎")
      expect(lines[1].trimEnd().endsWith(MARK)).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  test("has no place on a workflow row at the warning band that is the only row", async () => {
    const { harness } = await mountEntered(usageWorld(850), { sessions: modeSessions, dagMode: () => budgeted() })
    try {
      await row0(harness, (text) => text.includes("预算 85%"), "the alert row")
      twoRuns(harness)
      const lines = await settled(harness)
      expect(lines).toHaveLength(1)
      expect(lines[0]).not.toContain("◇")
    } finally {
      await harness.dispose()
    }
  })

  test("counts only the runs the root session started that are running or queued", async () => {
    const { harness } = await mountBand(noFlow)
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      const sync = harness.sync()
      twoRuns(harness)
      seedRun(sync, { parent: rootID, key: "done", state: "completed" })
      seedRun(sync, { parent: rootID, key: "failed", state: "error" })
      seedRun(sync, { parent: rootID, key: "lost", state: "unknown" })
      seedRun(sync, { parent: rootID, key: "front", state: "running", background: false })
      seedRun(sync, { parent: childID, key: "deeper", state: "running" })
      seedRun(sync, { parent: "ses_band_elsewhere", key: "other", state: "running" })
      // A watched PR, a workflow and a hook job each have a place of their own: none of them is a background run.
      sync.set("lifecycle", "pr_watch:pr_1", {
        domain: "pr_watch",
        id: "pr_1",
        value: "watching",
        phase: "running",
        at: 1,
      })
      sync.set("lifecycle", "job:hook_1", { domain: "job", id: "hook_1", value: "running", phase: "running", at: 1 })
      sync.set("lifecycle", "job:dag_alpha", {
        domain: "job",
        id: "dag_alpha",
        value: "running",
        phase: "running",
        at: 1,
      })
      const lines = await band(harness, (all) => all.some((row) => row.includes("◇")), "the mark")
      expect(lines[0].trimEnd().endsWith(MARK)).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  // #1407: with a limit of one, a run the server says is running is not counted as waiting because its child has shown
  // nothing yet; the runs it says are queued are.
  test("counts the queue the server reports: a run that began is running, the ones behind it wait", async () => {
    const { harness } = await mountBand(noFlow)
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      const sync = harness.sync()
      seedRun(sync, { parent: rootID, key: "first", state: "started", startedAt: RUN_START + 1 })
      seedRun(sync, { parent: rootID, key: "second", state: "waiting", startedAt: RUN_START + 2 })
      seedRun(sync, { parent: rootID, key: "third", state: "waiting", startedAt: RUN_START + 3 })
      await band(harness, (all) => all.some((row) => row.trimEnd().endsWith("◇ 后台 3·排2")), "one running, two queued")

      // The second begins when the first ends: still no child activity, and now it runs.
      endRun(sync, "first")
      seedRun(sync, {
        parent: rootID,
        key: "second",
        state: "started",
        startedAt: RUN_START + 2,
        runningAt: RUN_START + 9,
      })
      await band(harness, (all) => all.some((row) => row.trimEnd().endsWith("◇ 后台 2·排1")), "one running, one queued")
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("follows the runs: the count moves with them and the mark goes when the last one ends", async () => {
    const { harness } = await mountBand(noFlow)
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      twoRuns(harness)
      await band(harness, (all) => all.some((row) => row.trimEnd().endsWith(MARK)), "two runs")
      seedRun(harness.sync(), { parent: rootID, key: "third", state: "running", startedAt: RUN_START + 3 })
      await band(harness, (all) => all.some((row) => row.trimEnd().endsWith("◇ 后台 3·排1")), "three runs")
      endRun(harness.sync(), "third")
      endRun(harness.sync(), "review")
      await band(harness, (all) => all.some((row) => row.trimEnd().endsWith("/goal  ◇ 后台 1·排1")), "one run")
      endRun(harness.sync(), "scan")
      const lines = await band(harness, (all) => all.length === 1 && !all[0].includes("◇"), "no mark")
      expect(lines[0]).toContain("◎ 目标")
    } finally {
      await harness.dispose()
    }
  })

  test("says it in English", async () => {
    setLanguage("en")
    const { harness } = await mountTracked(running, fakeTracker({ items: [ciItem()] }), { language: "en" })
    try {
      twoRuns(harness)
      const lines = await band(harness, (all) => all.some((row) => row.includes("◇")), "the mark")
      expect(lines[0].trimEnd().endsWith("/dag  PR ~4/6  ◇ bg 2·q1")).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  test("is the root session's in a sub-agent view", async () => {
    const { harness } = await mountBand(noFlow, { route: { type: "session", sessionID: childID } })
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      await band(harness, (all) => all.some((row) => row.includes("◎")), "the root's goal")
      twoRuns(harness)
      const lines = await band(harness, (all) => all.some((row) => row.includes("◇")), "the mark")
      expect(lines[0].trimEnd().endsWith(MARK)).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  test("stays while the workflow row is hidden by `dag_band` or by the /dag panel, on the rows that are left", async () => {
    const { harness } = await mountBand(running, { frame: true })
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      twoRuns(harness)
      // The workflow row first, with the mark at its tail.
      await band(
        harness,
        (all) => all.some((row) => row.includes("◆ alpha") && row.trimEnd().endsWith(MARK)),
        "the mark on the workflow row",
      )

      // The panel takes the workflow row: the goal row is the first row now, and carries the mark.
      const goalWithMark = (all: string[]) =>
        all.some((row) => row.includes("◎") && row.trimEnd().endsWith(MARK)) &&
        !all.some((row) => row.includes("◆ alpha"))
      harness.bottomZone()!.host.push({ id: DAG_PANEL_ID, render: () => <text>panel</text> })
      await band(harness, goalWithMark, "the mark on the goal row under the panel")
      harness.bottomZone()!.host.close()
      await band(
        harness,
        (all) => all.some((row) => row.includes("◆ alpha") && row.trimEnd().endsWith(MARK)),
        "the workflow row again",
      )

      harness.kv().set("dag_band", "hidden")
      await band(harness, goalWithMark, "the mark on the goal row with the workflow row hidden")
    } finally {
      await harness.dispose()
    }
  })

  test("is on no row below the narrow limit, and is on the row at the limit", async () => {
    const { harness: narrow } = await mountBand(running, { width: BAND_NARROW_WIDTH - 1 })
    try {
      await band(narrow, (all) => all.length === 1, "the workflow row")
      twoRuns(narrow)
      const lines = await settled(narrow)
      expect(lines).toHaveLength(1)
      expect(lines[0]).not.toContain("◇")
    } finally {
      await narrow.dispose()
    }
    const { harness } = await mountBand(running, { width: BAND_NARROW_WIDTH, kv: { dag_band: "hidden" } })
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      await band(harness, (all) => all.length === 1 && all[0].includes("◎"), "the goal row")
      twoRuns(harness)
      const lines = await band(harness, (all) => all.some((row) => row.includes("◇")), "the mark")
      expect(lines[0].trimEnd().endsWith(MARK)).toBe(true)
    } finally {
      await harness.dispose()
    }
  })
})

describe("the row of the background runs", () => {
  test("is drawn when the band has nothing else to say: the runs by name, and the way to /agents", async () => {
    const { harness } = await mountBand(noFlow)
    try {
      await harness.settle()
      expect(rows(await harness.frame())).toEqual([])
      twoRuns(harness)
      const lines = await band(harness, (all) => all.some((row) => row.includes("◇")), "the row")
      expect(lines).toHaveLength(1)
      expect(lines[0].startsWith("  ◇ 后台 2 · review 未提交改动 · explore 扫描依赖")).toBe(true)
      expect(lines[0].trimEnd().endsWith("/agents")).toBe(true)
      // No time: the band subscribes to no clock.
      expect(lines[0]).not.toMatch(/\d+(s|m)\b/)
    } finally {
      await harness.dispose()
    }
  })

  test("names two runs and counts the rest in +k", async () => {
    const { harness } = await mountBand(noFlow)
    try {
      twoRuns(harness)
      seedRun(harness.sync(), {
        parent: rootID,
        key: "third",
        state: "running",
        kind: "general",
        description: "第三个",
        startedAt: RUN_START + 3,
      })
      seedRun(harness.sync(), {
        parent: rootID,
        key: "fourth",
        state: "queued",
        kind: "general",
        description: "第四个",
        startedAt: RUN_START,
      })
      const lines = await band(harness, (all) => all.some((row) => row.includes("+2")), "the count of the rest")
      // Running first, newest first: the third and the review; the two that wait are counted.
      expect(lines[0].startsWith("  ◇ 后台 4 · general 第三个 · review 未提交改动 · +2")).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  test("goes, and takes its line with it, when the last run ends", async () => {
    const { harness } = await mountBand(noFlow)
    try {
      twoRuns(harness)
      await band(harness, (all) => all.length === 1, "the row")
      endRun(harness.sync(), "review")
      endRun(harness.sync(), "scan")
      await harness.settle()
      expect(rows(await harness.frame())).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test("has the lowest priority: any other row takes the line, and the runs go onto it as a mark", async () => {
    const { harness } = await mountTracked(noFlow, fakeTracker({ reminder: wait5() }))
    try {
      twoRuns(harness)
      const lines = await band(harness, (all) => all.some((row) => row.includes("提醒")), "the reminder")
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("提醒 · 5m后")
      expect(lines[0].trimEnd().endsWith(MARK)).toBe(true)
      expect(lines.join("\n")).not.toContain("/agents")
    } finally {
      await harness.dispose()
    }
  })

  test("is left out below the narrow limit, where the drawer has the runs", async () => {
    const { harness } = await mountBand(noFlow, { width: BAND_NARROW_WIDTH - 1 })
    try {
      twoRuns(harness)
      await harness.settle()
      expect(rows(await harness.frame())).toEqual([])
    } finally {
      await harness.dispose()
    }
    const { harness: wide } = await mountBand(noFlow, { width: BAND_NARROW_WIDTH })
    try {
      twoRuns(wide)
      const lines = await band(wide, (all) => all.length === 1, "the row at the limit")
      expect(lines[0]).toContain("◇ 后台 2")
    } finally {
      await wide.dispose()
    }
  })

  test("says it in English", async () => {
    setLanguage("en")
    const { harness } = await mountBand(noFlow, { language: "en" })
    try {
      twoRuns(harness)
      const lines = await band(harness, (all) => all.some((row) => row.includes("◇")), "the row")
      expect(lines[0].startsWith("  ◇ bg 2 · review 未提交改动 · explore 扫描依赖")).toBe(true)
    } finally {
      await harness.dispose()
    }
  })
})

describe("clicking the background mark", () => {
  test("opens /agents from the mark on the workflow row, and /dag from the rest of that row", async () => {
    const { harness } = await mountTracked(running, fakeTracker({ items: [ciItem()] }))
    const opened = { agents: 0, dag: 0 }
    const offAgents = harness.registry().setHandler("agent.subagents", () => {
      opened.agents++
    })
    const offDag = harness.registry().setHandler("dag.open", () => {
      opened.dag++
    })
    try {
      twoRuns(harness)
      await band(harness, (all) => all.some((row) => row.trimEnd().endsWith(MARK)), "the mark")
      const at = await columnOfIn(harness, "◆ alpha", "◇")

      harness.app.renderer.clearSelection()
      await harness.app.mockMouse.click(at.x + 2, at.row)
      await waitFor(() => opened.agents === 1)
      await harness.settle()
      // The click on the mark is the mark's: the workflow row's own click did not run as well.
      expect(opened).toEqual({ agents: 1, dag: 0 })

      harness.app.renderer.clearSelection()
      await harness.app.mockMouse.click(10, at.row)
      await waitFor(() => opened.dag === 1)
      expect(opened).toEqual({ agents: 1, dag: 1 })

      // Two cells before the mark is the gap after the PR mark: that is the row's.
      harness.app.renderer.clearSelection()
      await harness.app.mockMouse.click(at.x - 1, at.row)
      await waitFor(() => opened.dag === 2)
      expect(opened).toEqual({ agents: 1, dag: 2 })
      expect(harness.writes()).toEqual([])
      expect(harness.requested.filter((entry) => entry.startsWith("POST") || entry.startsWith("PUT"))).toEqual([])
    } finally {
      offAgents()
      offDag()
      await harness.dispose()
    }
  })

  test("opens /agents from the mark on the goal row, and does nothing for the rest of it", async () => {
    const { harness } = await mountBand(noFlow)
    let opened = 0
    const off = harness.registry().setHandler("agent.subagents", () => {
      opened++
    })
    try {
      harness.events.emit(goalEvent(rootID, goal()))
      twoRuns(harness)
      await band(harness, (all) => all.some((row) => row.trimEnd().endsWith(MARK)), "the mark")
      const at = await columnOfIn(harness, "◎", "◇")
      harness.app.renderer.clearSelection()
      await harness.app.mockMouse.click(10, at.row)
      await harness.settle()
      expect(opened).toBe(0)
      harness.app.renderer.clearSelection()
      await harness.app.mockMouse.click(at.x, at.row)
      await waitFor(() => opened === 1)
      expect(harness.writes()).toEqual([])
    } finally {
      off()
      await harness.dispose()
    }
  })

  test("opens /agents from anywhere on the row of the runs alone", async () => {
    const { harness } = await mountBand(noFlow)
    let opened = 0
    const off = harness.registry().setHandler("agent.subagents", () => {
      opened++
    })
    try {
      twoRuns(harness)
      await band(harness, (all) => all.length === 1, "the row")
      const row = (await harness.frame()).split("\n").findIndex((line) => line.includes("◇"))
      for (const [index, x] of [6, 40, 110].entries()) {
        harness.app.renderer.clearSelection()
        await harness.app.mockMouse.click(x, row)
        await waitFor(() => opened === index + 1)
      }
      expect(harness.writes()).toEqual([])
      expect(harness.requested.filter((entry) => entry.startsWith("POST") || entry.startsWith("PUT"))).toEqual([])
    } finally {
      off()
      await harness.dispose()
    }
  })

  test("opens nothing of its own when a drag selected text", async () => {
    const { harness } = await mountBand(noFlow)
    let opened = 0
    const off = harness.registry().setHandler("agent.subagents", () => {
      opened++
    })
    try {
      twoRuns(harness)
      await band(harness, (all) => all.length === 1, "the row")
      const row = (await harness.frame()).split("\n").findIndex((line) => line.includes("◇"))
      await harness.app.mockMouse.drag(4, row, 30, row)
      await harness.settle()
      expect(opened).toBe(0)
      // The same row does open it for a plain click, so the drag above is what held it back.
      harness.app.renderer.clearSelection()
      await harness.app.mockMouse.click(10, row)
      await waitFor(() => opened === 1)
    } finally {
      off()
      await harness.dispose()
    }
  })
})

describe("the band with the background runs is still clock-free and read only", () => {
  test("does not subscribe to the ticker with the mark on a row, or with the row of the runs alone", async () => {
    const bare = counting()
    const empty = await mountBand(noFlow, { ticker: bare.ticker })
    await empty.harness.settle()
    await empty.harness.dispose()

    const watched = counting()
    const { harness } = await mountBand(noFlow, { ticker: watched.ticker })
    try {
      twoRuns(harness)
      await band(harness, (all) => all.length === 1 && all[0].includes("/agents"), "the row of the runs")
      harness.events.emit(goalEvent(rootID, goal()))
      await band(harness, (all) => all.length === 1 && all[0].includes("/goal"), "the mark on the goal row")
      seedRun(harness.sync(), { parent: rootID, key: "third", state: "running" })
      endRun(harness.sync(), "review")
      await harness.settle()
      // No animation, no one-second signal and no deadline of its own.
      expect(watched.calls).toEqual(bare.calls)
      expect(watched.calls.frame).toBe(0)
      expect(watched.calls.second).toBe(0)
    } finally {
      await harness.dispose()
    }
  })
})

describe("the background runs at 80 and 120 columns", () => {
  interface Scenario {
    readonly name: string
    readonly world: World
    readonly items?: () => readonly PrBandItem[]
    readonly goal?: boolean
    /** Rows drawn at 80 columns (below the narrow limit, where the runs have no place on the band) and at 120. */
    readonly rows: readonly [number, number]
  }

  const scenarios: readonly Scenario[] = [
    {
      name: "the mark after the PR mark on the workflow row",
      world: running,
      items: () => [ciItem()],
      goal: true,
      rows: [1, 2],
    },
    { name: "the mark on the goal row", world: noFlow, goal: true, rows: [1, 1] },
    { name: "the row of the runs alone", world: noFlow, rows: [0, 1] },
  ]

  async function drawScenario(scenario: Scenario, options: Partial<MountOptions> & { width: number }) {
    const tracked = fakeTracker({ items: scenario.items?.() })
    const { harness, served } = await mountTracked(scenario.world, tracked, options)
    if (scenario.goal) harness.events.emit(goalEvent(rootID, goal()))
    if (scenario.world === running) await waitFor(() => served.reads.length > 0)
    twoRuns(harness)
    return harness
  }

  /** Rows of the band once it has settled, and (when `marked`) once the runs are on it. */
  async function drawn(harness: Mount, expected: number, marked: boolean) {
    if (marked)
      await band(harness, (all) => all.length === expected && all.some((row) => row.includes("◇")), "the runs")
    else await band(harness, (all) => all.length === expected, `${expected} rows`)
    return settled(harness)
  }

  for (const language of ["zh-CN", "en"] as const) {
    for (const [width, height] of [
      [80, 24],
      [120, 40],
    ] as const) {
      for (const scenario of scenarios) {
        test(`draws ${scenario.name} in ${language} at ${width}x${height}`, async () => {
          setLanguage(language)
          const harness = await drawScenario(scenario, { width, height, language })
          try {
            const expected = scenario.rows[width === 80 ? 0 : 1]
            const lines = await drawn(harness, expected, width > 80)
            expect(lines).toHaveLength(expected)
            for (const line of lines) expect(cellWidth(line, 1), line).toBeLessThanOrEqual(width)
            // Below the narrow limit the runs are not on the band at all.
            if (width === 80) expect(lines.join("\n")).not.toContain("◇")
            else expect(lines.join("\n")).toContain("◇")
            if (expected > 0) expect(lines.join("\n")).toMatchSnapshot()
            expect(harness.writes()).toEqual([])
          } finally {
            await harness.dispose()
          }
        })
      }
    }

    // The least width the runs can show at is the narrow limit; both ambiguous widths keep every row inside it. A
    // crowded workflow row has no room for the mark there, so only the rows are waited for in that case.
    for (const width of [BAND_NARROW_WIDTH, 120]) {
      for (const scenario of scenarios) {
        test(`keeps ${scenario.name} inside ${width} columns at ambiguous width 2 in ${language}`, async () => {
          setLanguage(language)
          const harness = await drawScenario(scenario, { width, height: 24, language, kv: { ambiguous_width: 2 } })
          try {
            const crowded = scenario.world === running && width === BAND_NARROW_WIDTH
            const lines = await drawn(harness, scenario.rows[1], !crowded)
            for (const line of lines) expect(cellWidth(line, 2), line).toBeLessThanOrEqual(width)
          } finally {
            await harness.dispose()
          }
        })
      }
    }
  }
})
