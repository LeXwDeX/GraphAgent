// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { DagWorkflowSummary, Goal } from "@graphagent/sdk"
import type { DagNodeRow } from "../../src/dag/model"
import { setLanguage } from "../../src/i18n"
import { bandRowText, layoutDagRow, layoutGoalRow, type BandRow } from "../../src/shell/status-band"
import { cellWidth, type AmbiguousWidth } from "../../src/ui/width"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

function node(id: string, status: string, depends: string[] = [], extra: Partial<DagNodeRow> = {}): DagNodeRow {
  return {
    id,
    workflow_id: "dag_a",
    name: id,
    worker_type: "task",
    status,
    required: false,
    depends_on: depends,
    replan_attempts: 0,
    ...extra,
  }
}

/** Nine nodes in five waves: 4 done, 1 failed, 2 running, 2 queued. The wave in progress is the third. */
const NODES: readonly DagNodeRow[] = [
  node("n1", "completed"),
  node("n2", "completed"),
  node("n3", "completed"),
  node("n4", "completed", ["n1"]),
  node("n5", "failed", ["n2"]),
  node("n6", "running", ["n4"]),
  node("n7", "running", ["n4"]),
  node("n8", "queued", ["n6", "n7"]),
  node("n9", "queued", ["n8"]),
]

function summary(extra: Partial<DagWorkflowSummary> = {}): DagWorkflowSummary {
  return {
    id: "dag_a",
    title: "依赖升级验证",
    status: "running",
    graphRev: 1,
    nodeCount: 9,
    completedNodes: 4,
    runningNodes: 2,
    failedNodes: 1,
    skippedNodes: 0,
    abortedNodes: 0,
    queuedNodes: 2,
    escalatedNodes: 0,
    ...extra,
  }
}

/** A chain-and-fan workflow of `count` nodes, `waves` of them deep, every node done. */
function wide(count: number, waves: number): DagNodeRow[] {
  const result: DagNodeRow[] = []
  for (let index = 0; index < count; index++) {
    const wave = index % waves
    const depends = wave === 0 ? [] : [`m${index - 1}`]
    result.push(node(`m${index}`, "completed", depends))
  }
  return result
}

function goal(extra: Partial<Goal> = {}): Goal {
  return { goal: "全部依赖升到最新稳定版并通过 CI", status: "active", turnsUsed: 6, maxTurns: 30, ...extra }
}

const measured = (row: BandRow, aw: AmbiguousWidth) => cellWidth(bandRowText(row), aw)

describe("the DAG row", () => {
  test("draws the whole row when there is room, with the hint at the right edge", () => {
    const row = layoutDagRow({ summary: summary(), nodes: NODES, more: 0, width: 116 })
    const line = bandRowText(row)
    expect(
      line.startsWith("◆ 依赖升级验证 ━━━━━━━━━ ━━━━━━ ━━━━━━ ─── ─── 4/9 完成 · 第 3/5 波 · 2 运行中 · 1 失败"),
    ).toBe(true)
    expect(line.endsWith("/dag")).toBe(true)
    expect(row.cells).toBe(116)
    expect(measured(row, 1)).toBe(116)
  })

  test("paints the lead in the brand color, the bar by state and the failures as errors", () => {
    const row = layoutDagRow({ summary: summary(), nodes: NODES, more: 0, width: 116 })
    expect(row.spans[0]).toEqual({ text: "◆", token: "primary" })
    const bar = row.spans.filter((span) => /^[━─╌]/.test(span.text)).map((span) => [span.text, span.token])
    expect(bar).toEqual([
      ["━━━━━━━━━", "success"],
      ["━━━", "success"],
      ["━━━", "error"],
      ["━━━━━━", "statusRunning"],
      ["───", "statusQueued"],
      ["───", "statusQueued"],
    ])
    expect(row.spans.find((span) => span.text === "1 失败")?.token).toBe("error")
    expect(row.spans.find((span) => span.text === "4/9 完成")?.token).toBe("textMuted")
    expect(row.spans.find((span) => span.text === " · ")?.token).toBe("textDim")
    expect(row.spans.find((span) => span.text === "/dag")?.token).toBe("textDim")
  })

  test("folds the other workflows into +N in front of the hint", () => {
    const row = layoutDagRow({ summary: summary(), nodes: NODES, more: 2, width: 116 })
    expect(bandRowText(row).endsWith("+2 个  /dag")).toBe(true)
    expect(row.spans.find((span) => span.text === "+2 个")?.token).toBe("textMuted")
  })

  test("gives up the hint, then +N, then the wave, then the counts, then the title, in that order", () => {
    // A long title, so that cutting it to 12 cells shows.
    const long = summary({ title: "依赖升级验证与发布前检查" })
    const stageOf = (line: string) => {
      if (line.includes("/dag")) return 0
      if (line.includes("+2 个")) return 1
      if (line.includes("波")) return 2
      if (line.includes("完成")) return 3
      if (line.includes("发布前检查")) return 4
      return 5
    }
    const stages: number[] = []
    // The bar is 27 cells and 4 spaces and the shortest text 18: from 49 cells on the bar keeps its full size and
    // only the text can give way.
    for (let width = 200; width >= 49; width--) {
      const row = layoutDagRow({ summary: long, nodes: NODES, more: 2, width })
      const line = bandRowText(row)
      expect(line.match(/[━─]/g)).toHaveLength(27)
      stages.push(stageOf(line))
    }
    expect(stages[0]).toBe(0)
    expect(stages.at(-1)).toBe(5)
    expect(new Set(stages)).toEqual(new Set([0, 1, 2, 3, 4, 5]))
    // Every width gave up at least as much as the one above it.
    for (const [index, stage] of stages.entries())
      if (index > 0) expect(stage).toBeGreaterThanOrEqual(stages[index - 1])
  })

  test("compresses the counts to n/m and cuts the title to 12 cells when the row is 40 cells wide", () => {
    const row = layoutDagRow({
      summary: summary({ title: "依赖升级验证与发布前检查" }),
      nodes: NODES,
      more: 2,
      width: 40,
    })
    const line = bandRowText(row)
    expect(line).toContain("4/9")
    expect(line).not.toContain("完成")
    expect(line).toContain("依赖升级验…")
    expect(line).not.toContain("/dag")
    expect(row.cells).toBeLessThanOrEqual(40)
  })

  test("shrinks the bar last: a workflow too big for 3 cells a node keeps its bar and loses text first", () => {
    const nodes = wide(60, 10)
    const total = summary({ nodeCount: 60, completedNodes: 60, runningNodes: 0, failedNodes: 0, queuedNodes: 0 })
    const slots = (row: BandRow) => bandRowText(row).match(/━/g)?.length
    // 60 nodes at 3 cells and 9 spaces between the waves.
    expect(slots(layoutDagRow({ summary: total, nodes, more: 0, width: 400 }))).toBe(180)

    // One cell a node leaves room for the text again.
    const roomy = layoutDagRow({ summary: total, nodes, more: 0, width: 100 })
    expect(slots(roomy)).toBe(60)
    expect(bandRowText(roomy)).toContain("60/60 完成")

    // Where one cell a node does not fit either, the bar goes by wave and the text is down to n/m.
    const tight = layoutDagRow({ summary: total, nodes, more: 0, width: 76 })
    expect(tight.cells).toBeLessThanOrEqual(76)
    expect(slots(tight)).toBeLessThan(60)
    expect(bandRowText(tight)).toContain("60/60")
    expect(bandRowText(tight)).not.toContain("完成")
  })

  test("falls back to one segment per wave when even one cell a node does not fit", () => {
    const nodes = wide(200, 8)
    const total = summary({ nodeCount: 200, completedNodes: 200, runningNodes: 0, failedNodes: 0, queuedNodes: 0 })
    const row = layoutDagRow({ summary: total, nodes, more: 0, width: 56 })
    const line = bandRowText(row)
    expect(row.cells).toBeLessThanOrEqual(56)
    // Eight waves, a segment each, a space between them.
    expect(line.match(/[━]+/g)).toHaveLength(8)
  })

  for (const aw of [1, 2] as const) {
    test(`never claims more cells than it uses or than it has (ambiguous width ${aw})`, () => {
      const shapes: Array<[string, DagNodeRow[] | undefined, DagWorkflowSummary]> = [
        ["a table", [...NODES], summary()],
        ["no table", undefined, summary()],
        ["a long title", [...NODES], summary({ title: "依赖升级验证与发布前检查和回归测试的完整清单" })],
        ["60 nodes", wide(60, 10), summary({ nodeCount: 60, completedNodes: 60 })],
        ["200 nodes", wide(200, 8), summary({ nodeCount: 200, completedNodes: 200 })],
        [
          "a cycle",
          [node("a", "queued", ["b"]), node("b", "queued", ["a"]), node("c", "running")],
          summary({ nodeCount: 3 }),
        ],
        ["nothing", [], summary({ nodeCount: 0, completedNodes: 0, runningNodes: 0, failedNodes: 0, queuedNodes: 0 })],
      ]
      for (const [name, nodes, flow] of shapes) {
        for (let width = 8; width <= 160; width++) {
          const row = layoutDagRow({ summary: flow, nodes, more: 3, width, ambiguousWidth: aw })
          const label = `${name} at ${width} (aw ${aw})`
          expect(measured(row, aw), label).toBe(row.cells)
          expect(row.cells, label).toBeLessThanOrEqual(width)
        }
      }
    })
  }

  test("keeps a bar on screen at the narrowest terminal the shell draws", () => {
    for (const aw of [1, 2] as const) {
      for (const nodes of [[...NODES], wide(60, 10), wide(200, 8)]) {
        const row = layoutDagRow({
          summary: summary({ nodeCount: nodes.length }),
          nodes,
          more: 3,
          width: 56,
          ambiguousWidth: aw,
        })
        expect(bandRowText(row), `${nodes.length} nodes (aw ${aw})`).toMatch(/[━─╌]/)
      }
    }
  })

  test("draws a bar from the counts while the table is not loaded", () => {
    const row = layoutDagRow({ summary: summary(), more: 0, width: 116 })
    const bar = row.spans.filter((span) => /^[━─╌]/.test(span.text)).map((span) => [span.text, span.token])
    // 9 nodes: 4 done, 1 failed, 2 running, 2 queued; nine cells ahead of the counts, no waves to number.
    expect(bar).toEqual([
      ["━━━━━━━━━━━━", "success"],
      ["━━━", "error"],
      ["━━━━━━", "statusRunning"],
      ["──────", "statusQueued"],
    ])
    expect(bandRowText(row)).toContain("4/9 完成 · 2 运行中 · 1 失败")
    expect(bandRowText(row)).not.toContain("波")
  })

  test("counts nodes outside every wave in the bar, behind a marker", () => {
    const cycle = [node("a", "queued", ["b"]), node("b", "queued", ["a"]), node("c", "running")]
    const row = layoutDagRow({
      summary: summary({ nodeCount: 3, completedNodes: 0, runningNodes: 1, failedNodes: 0, queuedNodes: 2 }),
      nodes: cycle,
      more: 0,
      width: 116,
    })
    const bar = row.spans.filter((span) => /^[━─╌!]/.test(span.text)).map((span) => [span.text, span.token])
    expect(bar).toEqual([
      ["━━━", "statusRunning"],
      ["!", "error"],
      ["──────", "statusQueued"],
    ])
  })

  test("shows a paused workflow's running nodes as paused", () => {
    const row = layoutDagRow({ summary: summary({ status: "paused" }), nodes: NODES, more: 0, width: 116 })
    expect(bandRowText(row)).toContain("2 暂停")
    expect(bandRowText(row)).not.toContain("运行中")
    expect(row.spans.find((span) => span.text === "2 暂停")?.token).toBe("statusPaused")

    const idle = layoutDagRow({
      summary: summary({ status: "stepping", runningNodes: 0 }),
      nodes: NODES,
      more: 0,
      width: 116,
    })
    expect(bandRowText(idle)).toContain("已暂停")
  })

  test("keeps the completed, skipped and aborted split so 8/8 cannot hide skipped nodes", () => {
    const row = layoutDagRow({
      summary: summary({
        nodeCount: 8,
        completedNodes: 1,
        skippedNodes: 7,
        runningNodes: 0,
        failedNodes: 0,
        queuedNodes: 0,
      }),
      more: 0,
      width: 116,
    })
    expect(bandRowText(row)).toContain("8/8 ✓1 ⊘7 完成")
    const cancelled = layoutDagRow({
      summary: summary({
        nodeCount: 8,
        completedNodes: 3,
        abortedNodes: 5,
        runningNodes: 0,
        failedNodes: 0,
        queuedNodes: 0,
      }),
      more: 0,
      width: 116,
    })
    expect(bandRowText(cancelled)).toContain("3/8 ✓3 ⊘0 ↯5 完成")
  })

  test("reads sentinel numbers as zero", () => {
    const row = layoutDagRow({
      summary: summary({
        nodeCount: 3,
        completedNodes: "NaN",
        runningNodes: "Infinity",
        failedNodes: 0,
        queuedNodes: 3,
      }),
      more: 0,
      width: 116,
    })
    expect(bandRowText(row)).toContain("0/3 完成")
    expect(bandRowText(row)).not.toContain("运行中")
  })

  test("shows one line of the title with no escapes or breaks in it", () => {
    const row = layoutDagRow({
      summary: summary({ title: "\u001b[31mred\u001b[0m\nline\u0007 two" }),
      nodes: NODES,
      more: 0,
      width: 116,
    })
    const line = bandRowText(row)
    expect(line).toContain("red line two")
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
  })

  test("says it in English too", () => {
    setLanguage("en")
    const row = layoutDagRow({ summary: summary(), nodes: NODES, more: 2, width: 116 })
    const line = bandRowText(row)
    expect(line).toContain("4/9 done · wave 3/5 · 2 running · 1 failed")
    expect(line.endsWith("+2 more  /dag")).toBe(true)
  })

  test("draws nothing at all for a width that cannot hold the lead", () => {
    expect(layoutDagRow({ summary: summary(), nodes: NODES, more: 0, width: 0 })).toEqual({ spans: [], cells: 0 })
  })
})

describe("the goal row", () => {
  test("draws the lead, the goal and, at the right edge, the turns, the status and the hint", () => {
    const row = layoutGoalRow({ goal: goal(), width: 116 })
    const line = bandRowText(row)
    expect(line.startsWith("◎ 目标  全部依赖升到最新稳定版并通过 CI")).toBe(true)
    expect(line.endsWith("第 6/30 轮 · 进行中  /goal")).toBe(true)
    expect(row.cells).toBe(116)
    expect(row.spans[0]).toEqual({ text: "◎ ", token: "textMuted" })
  })

  test("counts the subgoals behind the status", () => {
    const row = layoutGoalRow({ goal: goal({ subgoals: ["写迁移脚本", "跑回归"] }), width: 116 })
    expect(bandRowText(row)).toContain("第 6/30 轮 · 进行中 · 2 个子目标  /goal")
  })

  test("leaves out the denominator when the turn limit is not a number", () => {
    const row = layoutGoalRow({ goal: goal({ maxTurns: "Infinity" }), width: 116 })
    expect(bandRowText(row)).toContain("第 6 轮 · 进行中")
    expect(bandRowText(row)).not.toContain("6/")
  })

  test("leaves out the turns when the count is not a number", () => {
    const row = layoutGoalRow({ goal: goal({ turnsUsed: "NaN" }), width: 116 })
    expect(bandRowText(row)).not.toContain("轮")
    expect(bandRowText(row)).toContain("进行中")
  })

  test("shows the paused reason in warning color in place of the status", () => {
    const row = layoutGoalRow({ goal: goal({ status: "paused", pausedReason: "等待 watch_pr" }), width: 116 })
    expect(bandRowText(row)).toContain("第 6/30 轮 · 等待 watch_pr")
    expect(bandRowText(row)).not.toContain("已暂停")
    expect(row.spans.find((span) => span.text === "等待 watch_pr")?.token).toBe("warning")
  })

  test("shows the reason of a waiting goal too, and the plain label of one without", () => {
    const withReason = layoutGoalRow({ goal: goal({ status: "waiting", pausedReason: "watch_pr" }), width: 116 })
    expect(withReason.spans.find((span) => span.text === "watch_pr")?.token).toBe("warning")
    const plain = layoutGoalRow({ goal: goal({ status: "waiting" }), width: 116 })
    expect(bandRowText(plain)).toContain("等待中")
    const paused = layoutGoalRow({ goal: goal({ status: "paused" }), width: 116 })
    expect(paused.spans.find((span) => span.text === "已暂停")?.token).toBe("warning")
  })

  test("colors the status by how it stands", () => {
    const active = layoutGoalRow({ goal: goal({ status: "active" }), width: 116 })
    expect(active.spans.find((span) => span.text === "进行中")?.token).toBe("text")
    const done = layoutGoalRow({ goal: goal({ status: "done" }), width: 116 })
    expect(done.spans.find((span) => span.text === "已达成")?.token).toBe("success")
  })

  test("gives up the hint, cuts the goal, then drops the subgoal count and last the turns", () => {
    const long = goal({
      goal: "全部依赖升到最新稳定版并通过 CI，再逐个核对发布说明里的破坏性变更",
      subgoals: ["a", "b", "c"],
    })
    const stageOf = (line: string) => {
      if (line.includes("/goal")) return 0
      if (line.includes("个子目标") && line.includes("变更")) return 1
      if (line.includes("个子目标")) return 2
      if (line.includes("第 6/30 轮")) return 3
      return 4
    }
    const stages: number[] = []
    for (let width = 130; width >= 30; width--) {
      const row = layoutGoalRow({ goal: long, width })
      const line = bandRowText(row)
      expect(row.cells).toBeLessThanOrEqual(width)
      expect(line).toContain("进行中")
      stages.push(stageOf(line))
    }
    expect(new Set(stages)).toEqual(new Set([0, 1, 2, 3, 4]))
    for (const [index, stage] of stages.entries())
      if (index > 0) expect(stage).toBeGreaterThanOrEqual(stages[index - 1])
  })

  test("cuts the goal text with an ellipsis once the hint is gone", () => {
    const long = goal({ goal: "全部依赖升到最新稳定版并通过 CI，再逐个核对发布说明里的破坏性变更" })
    const row = layoutGoalRow({ goal: long, width: 60 })
    const line = bandRowText(row)
    expect(line).toContain("…")
    expect(line).not.toContain("/goal")
    expect(line).toContain("第 6/30 轮 · 进行中")
    expect(row.cells).toBeLessThanOrEqual(60)
  })

  test("shows one line of the goal and of the reason with no escapes or breaks in it", () => {
    const row = layoutGoalRow({
      goal: goal({ goal: "\u001b[1mship\u001b[0m\nit", status: "paused", pausedReason: "wait\r\nfor\u0007 it" }),
      width: 116,
    })
    const line = bandRowText(row)
    expect(line).toContain("ship it")
    expect(line).toContain("wait for it")
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
  })

  test("says it in English too", () => {
    setLanguage("en")
    const row = layoutGoalRow({ goal: goal({ subgoals: ["a"] }), width: 116 })
    expect(bandRowText(row)).toContain("Goal  全部依赖升到最新稳定版并通过 CI")
    expect(bandRowText(row)).toContain("turn 6/30 · Active · subgoals 1  /goal")
  })

  for (const aw of [1, 2] as const) {
    test(`never claims more cells than it uses or than it has (ambiguous width ${aw})`, () => {
      const shapes: Goal[] = [
        goal(),
        goal({ subgoals: ["a", "b"], status: "waiting", pausedReason: "等待 watch_pr" }),
        goal({ goal: "全部依赖升到最新稳定版并通过 CI，再逐个核对发布说明里的破坏性变更", maxTurns: "Infinity" }),
        goal({ status: "paused", pausedReason: "x".repeat(200) }),
      ]
      for (const flow of shapes) {
        for (let width = 6; width <= 150; width++) {
          const row = layoutGoalRow({ goal: flow, width, ambiguousWidth: aw })
          const label = `${flow.status} at ${width} (aw ${aw})`
          expect(measured(row, aw), label).toBe(row.cells)
          expect(row.cells, label).toBeLessThanOrEqual(width)
        }
      }
    })
  }
})
