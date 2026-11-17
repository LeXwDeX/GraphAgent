// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { CapturedFrame, RGBA } from "@opentui/core"
import type { DagNode, DagWorkflowSummary, GlobalEvent, Goal, Session } from "@graphagent/sdk"
import { createSignal, Show } from "solid-js"
import { DEFAULT_THEME } from "../../src/context/theme"
import type { Ticker } from "../../src/context/ticker"
import { setLanguage } from "../../src/i18n"
import { BAND_NARROW_WIDTH, DAG_PANEL_ID, SessionStatusBand } from "../../src/shell/status-band"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import { cellWidth, type AmbiguousWidth } from "../../src/ui/width"
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
