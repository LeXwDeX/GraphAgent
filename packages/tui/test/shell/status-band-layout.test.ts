// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { DagWorkflowSummary, Goal } from "@graphagent/sdk"
import type { DagUsage } from "../../src/dag/mode"
import type { DagNodeRow } from "../../src/dag/model"
import { setLanguage } from "../../src/i18n"
import {
  bandRowText,
  dagUsageAlert,
  isGoalShown,
  layoutDagRow,
  layoutEmptyRow,
  layoutGoalRow,
  type BandRow,
} from "../../src/shell/status-band"
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

/** A goal body as a broken server might send it: the wire type says what a goal has, this has less or other. */
function malformed(body: Record<string, unknown>): Goal {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic: a body the wire type does not allow.
  return body as unknown as Goal
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
    // The least text is 19 cells (the lead, a title of 12 cells, `4/9` and the gap before it) and a bar of 2 slots a
    // node is 22 (18 and 4 spaces). From 41 cells on the bar keeps at least 2 slots a node, 3 where the text leaves
    // the room, and only the text gives way (#1619: the text is sized first, so the third slot is what it takes).
    for (let width = 200; width >= 41; width--) {
      const row = layoutDagRow({ summary: long, nodes: NODES, more: 2, width })
      const line = bandRowText(row)
      expect([18, 27], `bar at ${width}`).toContain((line.match(/[━─]/g) ?? []).length)
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

  test("narrows the bar a step at a time: the third slot goes to the text, the second only when the least text needs it", () => {
    const nodes = wide(60, 10)
    const total = summary({ nodeCount: 60, completedNodes: 60, runningNodes: 0, failedNodes: 0, queuedNodes: 0 })
    const slots = (row: BandRow) => bandRowText(row).match(/━/g)?.length
    // 60 nodes at 3 slots and 9 spaces between the waves, beside the whole text.
    const wholeRow = layoutDagRow({ summary: total, nodes, more: 0, width: 400 })
    expect(slots(wholeRow)).toBe(180)
    expect(bandRowText(wholeRow)).toContain("第 10/10 波")

    // The third slot goes before the text does: where the bar at 3 a node leaves no room for the wave and the hint, it
    // takes 2 and the text stays whole. Until #1619 the bar kept its 3 and the hint and the wave went.
    const second = layoutDagRow({ summary: total, nodes, more: 0, width: 222 })
    expect(slots(second)).toBe(120)
    expect(bandRowText(second)).toContain("60/60 完成 · 第 10/10 波")
    expect(bandRowText(second).endsWith("/dag")).toBe(true)

    // One slot a node leaves room for the text again: 2 slots and the least text do not fit here.
    const roomy = layoutDagRow({ summary: total, nodes, more: 0, width: 100 })
    expect(slots(roomy)).toBe(60)
    expect(bandRowText(roomy)).toContain("60/60 完成")

    // Where one slot a node does not fit either, the bar goes by wave and the text is down to n/m.
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

describe("the DAG row: the text is sized first and the bar takes what it leaves (#1619)", () => {
  /** Ten nodes in five waves: 4 done, 1 failed, 2 running, 3 queued. The wave in progress is the third. */
  const TEN: readonly DagNodeRow[] = [...NODES, node("n10", "queued", ["n8"])]
  const TEN_FLOW = summary({ nodeCount: 10, queuedNodes: 3 })
  /** A 100-column terminal gives the band 96 cells: 2 columns of padding on each side. */
  const AT_100 = 96
  /** The bar's slots: one glyph each, whatever the ambiguous width. */
  const barSlots = (row: BandRow) => bandRowText(row).match(/[━─]/g)?.length ?? 0

  test("keeps the wave and the hint on a 100-column terminal, the bar at 2 slots a node: ten nodes in five waves", () => {
    // The mode mark stays: a running workflow in a session with DAG mode off carries `模式关`.
    const row = layoutDagRow({ summary: TEN_FLOW, nodes: TEN, more: 0, mode: "off", width: AT_100 })
    const line = bandRowText(row)
    expect(line).toContain("4/10 完成 · 第 3/5 波 · 2 运行中 · 1 失败")
    expect(line).toContain("模式关")
    expect(line.endsWith("/dag")).toBe(true)
    // 10 nodes at 2 slots each: the text took what it needed and the bar the rest, which is not enough for a third.
    expect(barSlots(row)).toBe(20)
    expect(row.cells).toBe(AT_100)
    expect(measured(row, 1)).toBe(AT_100)
  })

  test("says it in English too", () => {
    setLanguage("en")
    // The English text is longer: without the mode mark the row is whole at 96 cells; with `mode off` it needs 99,
    // so there the hint is the first to go (the wave stays) and it is back at 100.
    const plain = layoutDagRow({ summary: TEN_FLOW, nodes: TEN, more: 0, width: AT_100 })
    expect(bandRowText(plain)).toContain("4/10 done · wave 3/5 · 2 running · 1 failed")
    expect(bandRowText(plain).endsWith("/dag")).toBe(true)
    expect(barSlots(plain)).toBe(20)

    const marked = layoutDagRow({ summary: TEN_FLOW, nodes: TEN, more: 0, mode: "off", width: AT_100 })
    expect(bandRowText(marked)).toContain("wave 3/5")
    expect(bandRowText(marked)).toContain("mode off")
    expect(bandRowText(marked)).not.toContain("/dag")
    const wider = layoutDagRow({ summary: TEN_FLOW, nodes: TEN, more: 0, mode: "off", width: AT_100 + 4 })
    expect(bandRowText(wider)).toContain("4/10 done · wave 3/5 · 2 running · 1 failed")
    expect(bandRowText(wider).endsWith("mode off  /dag")).toBe(true)
    expect(barSlots(wider)).toBe(20)
  })

  test("hands the bar its third slot only where the whole text and 3 slots a node both fit", () => {
    const at = (width: number) => layoutDagRow({ summary: TEN_FLOW, nodes: TEN, more: 0, mode: "off", width })
    // The hint is the first of the text to go: the whole row is 71 cells and a bar of 2 slots a node is 24.
    expect(bandRowText(at(94))).toContain("第 3/5 波")
    expect(bandRowText(at(94))).not.toContain("/dag")
    for (let width = 95; width <= 104; width++) {
      expect(bandRowText(at(width)).endsWith("/dag"), `hint at ${width}`).toBe(true)
      expect(barSlots(at(width)), `bar at ${width}`).toBe(20)
    }
    // A bar of 3 slots a node is 34: it comes back with the whole text beside it, never at the text's expense.
    for (let width = 105; width <= 140; width++) {
      expect(bandRowText(at(width)).endsWith("/dag"), `hint at ${width}`).toBe(true)
      expect(bandRowText(at(width)), `wave at ${width}`).toContain("第 3/5 波")
      expect(barSlots(at(width)), `bar at ${width}`).toBe(30)
    }
  })

  /** What a row can keep of its text, in either language. */
  const PIECES = [
    /\/dag/,
    /\+\d+ (个|more)/,
    /tok/,
    /并发|slots/,
    /预算|budget/,
    /波|wave/,
    /等待主|waiting/,
    /完成|done/,
    /模式|mode (on|off)/,
  ]
  /** The pieces a row keeps; the last is the title, which counts as kept while it is not cut. */
  const piecesOf = (line: string) => [...PIECES.map((piece) => piece.test(line)), !line.includes("…")]

  const USAGE: DagUsage = { running: 3, cap: 12, tokens: 1_200_000, budget: 5_000_000, percent: 24, tier: "normal" }
  const WARN: DagUsage = { running: 3, cap: 12, tokens: 850_000, budget: 1_000_000, percent: 85, tier: "warn" }
  const VARIANTS = [
    ["the mode mark", { mode: "off" }],
    ["everything a quiet row says", { mode: "on", usage: USAGE, waiting: true, more: 2 }],
    ["a budget at its warning band", { mode: "on", usage: WARN, waiting: true, more: 1 }],
  ] as const
  /** The shapes: whether 1 slot a node fits at every width swept, so that every node can keep its slot. */
  const SHAPES: Array<[string, DagNodeRow[], DagWorkflowSummary, boolean]> = [
    ["nine nodes", [...NODES], summary(), true],
    ["ten nodes", [...TEN], TEN_FLOW, true],
    [
      "twenty nodes",
      wide(20, 5),
      summary({ nodeCount: 20, completedNodes: 20, runningNodes: 0, failedNodes: 0, queuedNodes: 0 }),
      false,
    ],
  ]

  for (const aw of [1, 2] as const) {
    test(`from 60 to 140 columns: never wider than the room, a slot for every node, and a text that only gets richer with the width but where the bar steps from 1 slot a node to 2 (ambiguous width ${aw})`, () => {
      for (const language of ["zh-CN", "en"] as const) {
        setLanguage(language)
        for (const [shape, nodes, flow, everyNode] of SHAPES) {
          for (const [variant, extra] of VARIANTS) {
            let before: { line: string; slots: number } | undefined
            for (let width = 60; width <= 140; width++) {
              const row = layoutDagRow({ summary: flow, nodes, more: 0, ...extra, width, ambiguousWidth: aw })
              const label = `${language}, ${shape}, ${variant} at ${width} (aw ${aw})`
              const line = bandRowText(row)
              const slots = barSlots(row)
              expect(measured(row, aw), label).toBe(row.cells)
              expect(row.cells, label).toBeLessThanOrEqual(width)
              if (everyNode) expect(slots, label).toBeGreaterThanOrEqual(nodes.length)
              if (before) {
                const kept = piecesOf(line)
                const lost = piecesOf(before.line).some((was, index) => was && !kept[index])
                // One cell wider and the row says less: that is the step where the bar goes from 1 slot a node to 2,
                // which the text pays for because the least text and a bar of 2 slots a node now fit, and the order of
                // the cramped rows (a bar of 1 slot beside the richest text that fits) no longer applies.
                if (lost) {
                  expect(before.slots, label).toBe(nodes.length)
                  expect(slots, label).toBeGreaterThanOrEqual(2 * nodes.length)
                }
              }
              before = { line, slots }
            }
          }
        }
      }
    })
  }
})

describe("the DAG row in DAG mode: the mode mark, the usage and the wait", () => {
  const USAGE: DagUsage = {
    running: 3,
    cap: 12,
    tokens: 1_200_000,
    budget: 5_000_000,
    percent: 24,
    tier: "normal",
  }
  const FULL = { summary: summary(), nodes: NODES, more: 2, mode: "on", usage: USAGE, waiting: true } as const

  test("draws, at the right edge, the wait, the mode mark, the usage, the folded workflows and the hint", () => {
    const row = layoutDagRow({ ...FULL, width: 200 })
    const line = bandRowText(row)
    expect(line.endsWith("等待主 agent  模式开  全进程并发 3/12 · 1.2M tok · 预算 24%  +2 个  /dag")).toBe(true)
    expect(row.cells).toBe(200)
    expect(measured(row, 1)).toBe(200)
  })

  test("paints the mark and the pieces in the colors the band keeps for them, none of them the brand color", () => {
    const token = (text: string) =>
      layoutDagRow({ ...FULL, width: 200 }).spans.find((span) => span.text === text)?.token
    expect(token("模式开")).toBe("text")
    expect(token("等待主 agent")).toBe("warning")
    expect(token("全进程并发 3/12")).toBe("textMuted")
    expect(token("1.2M tok")).toBe("textMuted")
    expect(token("预算 24%")).toBe("textMuted")
    const off = layoutDagRow({ ...FULL, mode: "off", width: 200 })
    expect(off.spans.find((span) => span.text === "模式关")?.token).toBe("textDim")
    // The lead is the one piece in the brand color, besides the running segments of the bar.
    const brand = layoutDagRow({ ...FULL, width: 200 }).spans.filter((span) => span.token === "primary")
    expect(brand.map((span) => span.text)).toEqual(["◆"])
  })

  test("colors the budget by its band: quiet, warning, error", () => {
    const budgetToken = (tier: DagUsage["tier"]) =>
      layoutDagRow({ ...FULL, usage: { ...USAGE, tier, percent: 24 }, width: 200 }).spans.find((span) =>
        span.text.startsWith("预算"),
      )?.token
    expect(budgetToken("normal")).toBe("textMuted")
    expect(budgetToken("warn")).toBe("warning")
    expect(budgetToken("exhausted")).toBe("error")
  })

  test("shows only the pieces of the usage that are known", () => {
    const rowText = (usage: DagUsage) => bandRowText(layoutDagRow({ ...FULL, waiting: false, usage, width: 200 }))
    // No budget: no percent. No slot count: no concurrency.
    const open = rowText({ running: 3, cap: 12, tokens: 900, tier: "normal" })
    expect(open).toContain("全进程并发 3/12 · 900 tok")
    expect(open).not.toContain("预算")
    const tokensOnly = rowText({ tokens: 5, tier: "normal" })
    expect(tokensOnly).toContain("模式开  5 tok  +2 个")
    expect(tokensOnly).not.toContain("并发")
    const slotsOnly = rowText({ running: 0, cap: 4, tier: "normal" })
    expect(slotsOnly).toContain("全进程并发 0/4")
    expect(slotsOnly).not.toContain("tok")
  })

  test("draws neither the mark nor the wait nor the usage when it is not given them", () => {
    const line = bandRowText(layoutDagRow({ summary: summary(), nodes: NODES, more: 2, width: 200 }))
    for (const word of ["模式", "等待主", "并发", "tok", "预算"]) expect(line).not.toContain(word)
  })

  test("gives way in the order: hint, budget, tokens, concurrency, +N, wave, wait, counts, title; the mark stays", () => {
    const long = summary({ title: "依赖升级验证与发布前检查" })
    const stageOf = (line: string) => {
      if (line.includes("/dag")) return 0
      if (line.includes("预算")) return 1
      if (line.includes("tok")) return 2
      if (line.includes("并发")) return 3
      if (line.includes("+2 个")) return 4
      if (line.includes("波")) return 5
      if (line.includes("等待主")) return 6
      if (line.includes("完成")) return 7
      if (line.includes("发布前检查")) return 8
      return 9
    }
    const stages: number[] = []
    // The least text is the lead, a title of 12 cells, `4/9` and the mark (6 cells and a gap of 2), 27 cells, and a bar
    // of 2 slots a node is 22 (18 and 4 spaces): from 49 cells on the bar keeps at least 2 slots a node, 3 where the
    // text leaves the room, and only the text gives way.
    for (let width = 220; width >= 49; width--) {
      const row = layoutDagRow({ ...FULL, summary: long, width })
      const line = bandRowText(row)
      expect([18, 27], `bar at ${width}`).toContain((line.match(/[━─]/g) ?? []).length)
      expect(line, `mark at ${width}`).toContain("模式开")
      stages.push(stageOf(line))
    }
    expect(stages[0]).toBe(0)
    expect(stages.at(-1)).toBe(9)
    expect(new Set(stages)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))
    for (const [index, stage] of stages.entries())
      if (index > 0) expect(stage, `width ${220 - index}`).toBeGreaterThanOrEqual(stages[index - 1])
  })

  for (const aw of [1, 2] as const) {
    test(`keeps the mark and a bar down to the narrowest terminal the shell draws (ambiguous width ${aw})`, () => {
      for (const nodes of [[...NODES], wide(60, 10), wide(200, 8)]) {
        for (const mode of ["on", "off"] as const) {
          for (let width = 56; width <= 140; width++) {
            const row = layoutDagRow({
              summary: summary({ nodeCount: nodes.length }),
              nodes,
              more: 3,
              mode,
              usage: USAGE,
              waiting: true,
              width,
              ambiguousWidth: aw,
            })
            const label = `${nodes.length} nodes, mode ${mode} at ${width} (aw ${aw})`
            expect(bandRowText(row), label).toContain(mode === "on" ? "模式开" : "模式关")
            expect(bandRowText(row), label).toMatch(/[━─╌]/)
            expect(row.cells, label).toBeLessThanOrEqual(width)
          }
        }
      }
    })

    test(`never claims more cells than it uses or than it has, whatever it is given (ambiguous width ${aw})`, () => {
      const shapes: Array<[string, DagNodeRow[] | undefined, DagWorkflowSummary]> = [
        ["a table", [...NODES], summary()],
        ["no table", undefined, summary()],
        ["a long title", [...NODES], summary({ title: "依赖升级验证与发布前检查和回归测试的完整清单" })],
        ["200 nodes", wide(200, 8), summary({ nodeCount: 200, completedNodes: 200 })],
      ]
      for (const [name, nodes, flow] of shapes) {
        for (const mode of [undefined, "on", "off"] as const) {
          for (const usage of [undefined, USAGE, { tokens: 7, tier: "warn" } as const]) {
            for (const waiting of [false, true]) {
              for (let width = 8; width <= 160; width++) {
                const row = layoutDagRow({
                  summary: flow,
                  nodes,
                  more: 3,
                  mode,
                  usage,
                  waiting,
                  width,
                  ambiguousWidth: aw,
                })
                const label = `${name}, ${mode}, ${usage ? "usage" : "no usage"}, ${waiting} at ${width} (aw ${aw})`
                expect(measured(row, aw), label).toBe(row.cells)
                expect(row.cells, label).toBeLessThanOrEqual(width)
              }
            }
          }
        }
      }
    })
  }

  test("says it in English too", () => {
    setLanguage("en")
    const row = layoutDagRow({ ...FULL, width: 200 })
    expect(
      bandRowText(row).endsWith(
        "waiting for main agent  mode on  global slots 3/12 · 1.2M tok · budget 24%  +2 more  /dag",
      ),
    ).toBe(true)
    const off = layoutDagRow({ ...FULL, mode: "off", waiting: false, width: 200 })
    expect(bandRowText(off)).toContain("mode off")
  })
})

describe("the DAG row when the budget is at its warning or exhausted band", () => {
  const BUDGET = { running: 3, cap: 12, budget: 1_000_000 } as const
  const QUIET: DagUsage = { ...BUDGET, tokens: 620_000, percent: 62, tier: "normal" }
  const WARN: DagUsage = { ...BUDGET, tokens: 850_000, percent: 85, tier: "warn" }
  const EXHAUSTED: DagUsage = { ...BUDGET, tokens: 1_000_000, percent: 100, tier: "exhausted" }
  /** A 120-column terminal gives the band 116 cells; nine nodes in five waves and their counts take most of them. */
  const AT_120 = 116
  const BASE = { summary: summary(), nodes: NODES, more: 1, mode: "on" } as const

  const rowOf = (usage: DagUsage, extra: { waiting?: boolean; width?: number; ambiguousWidth?: AmbiguousWidth } = {}) =>
    layoutDagRow({ ...BASE, usage, width: AT_120, ...extra })
  const textOf = (...args: Parameters<typeof rowOf>) => bandRowText(rowOf(...args))

  test("keeps the budget where a quiet one has given way: 120 columns, nine nodes", () => {
    expect(textOf(QUIET)).not.toContain("预算")
    expect(textOf(WARN)).toContain("预算 85%")
    expect(textOf(EXHAUSTED)).toContain("预算 100%")
  })

  test("the tokens, the slots and the hint are not promoted: they give way ahead of it as before", () => {
    for (const usage of [WARN, EXHAUSTED]) {
      const line = textOf(usage)
      expect(line).not.toContain("tok")
      expect(line).not.toContain("并发")
      expect(line).not.toContain("/dag")
    }
  })

  test("colors the budget it keeps: warning for the warning band, error for the exhausted one", () => {
    const token = (usage: DagUsage) => rowOf(usage).spans.find((span) => span.text.startsWith("预算"))?.token
    expect(token(WARN)).toBe("warning")
    expect(token(EXHAUSTED)).toBe("error")
  })

  test("the wait and the budget both outlast the counts text: 120 columns, nine nodes", () => {
    for (const usage of [WARN, EXHAUSTED]) {
      const budget = usage.tier === "warn" ? "预算 85%" : "预算 100%"
      const line = textOf(usage, { waiting: true })
      expect(line).toContain("等待主 agent")
      expect(line).toContain(budget)
      expect(line).toContain("4/9 完成")
      // The bar gave up its third slot (#1619), so the whole counts text, the wave included, stays beside them.
      expect(line).toContain("第 3/5 波")

      // Narrower, the wave is the first of the counts text to go; the wait and the budget stay.
      const narrow = textOf(usage, { waiting: true, width: 104 })
      expect(narrow).toContain("等待主 agent")
      expect(narrow).toContain(budget)
      expect(narrow).toContain("4/9 完成")
      expect(narrow).not.toContain("波")
    }
  })

  test("the counts are squeezed to n/m before either the wait or the budget goes: 100 and 88 columns", () => {
    for (const width of [96, 84]) {
      for (const usage of [WARN, EXHAUSTED]) {
        const line = textOf(usage, { waiting: true, width })
        expect(line, `at ${width}`).toContain("等待主 agent")
        expect(line, `at ${width}`).toContain(usage.tier === "warn" ? "预算 85%" : "预算 100%")
        expect(line, `at ${width}`).toContain("4/9")
        expect(line, `at ${width}`).not.toContain("完成")
      }
    }
    // A quiet budget has no such claim: the wait goes before the counts are squeezed, as it always did. At 84 cells
    // the quiet row has let the wait go and keeps its counts, where the rows above keep the wait and squeeze them. (At
    // 96 the bar's third slot is the only thing the quiet row gives up for the wait, #1619, so it keeps both.)
    const quiet = textOf(QUIET, { waiting: true, width: 84 })
    expect(quiet).not.toContain("等待主")
    expect(quiet).toContain("完成")
  })

  test("the wait does not need to be there for the budget to be promoted", () => {
    expect(textOf(WARN, { waiting: false })).toContain("预算 85%")
    expect(textOf(WARN, { waiting: true })).toContain("预算 85%")
  })

  test("gives way in the order: hint, tokens, concurrency, +N, wave, counts, title, wait, budget; the mark stays", () => {
    const long = summary({ title: "依赖升级验证与发布前检查" })
    const stageOf = (line: string) => {
      if (line.includes("/dag")) return 0
      if (line.includes("tok")) return 1
      if (line.includes("并发")) return 2
      if (line.includes("+2 个")) return 3
      if (line.includes("波")) return 4
      if (line.includes("完成")) return 5
      if (line.includes("发布前检查")) return 6
      if (line.includes("等待主")) return 7
      if (line.includes("预算")) return 8
      return 9
    }
    for (const usage of [WARN, EXHAUSTED]) {
      const stages: number[] = []
      // The least text is the lead, a title of 12 cells, `4/9` and the mark, as in a quiet band, and a bar of 2 slots
      // a node is 22 cells beside it: from 49 cells on the bar keeps at least 2 slots a node, 3 where the text leaves
      // the room, and the wait and the budget only ever take what that leaves.
      for (let width = 220; width >= 49; width--) {
        const line = bandRowText(layoutDagRow({ ...BASE, summary: long, more: 2, usage, waiting: true, width }))
        expect([18, 27], `bar at ${width}`).toContain((line.match(/[━─]/g) ?? []).length)
        expect(line, `mark at ${width}`).toContain("模式开")
        stages.push(stageOf(line))
      }
      expect(stages[0]).toBe(0)
      expect(stages.at(-1)).toBe(9)
      expect(new Set(stages)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))
      for (const [index, stage] of stages.entries())
        if (index > 0) expect(stage, `${usage.tier}, width ${220 - index}`).toBeGreaterThanOrEqual(stages[index - 1])
    }
  })

  test("when room is short for both, the budget stays and the wait goes", () => {
    for (let width = 58; width <= 220; width++) {
      const line = bandRowText(layoutDagRow({ ...BASE, usage: WARN, waiting: true, width }))
      if (line.includes("等待主")) expect(line, `at ${width}`).toContain("预算")
    }
  })

  test("a quiet budget keeps the order it had, whatever the wait", () => {
    const long = summary({ title: "依赖升级验证与发布前检查" })
    for (const waiting of [false, true]) {
      // In the quiet order the budget is the first of the usage to give way, ahead of the wave, wait and counts.
      let budgetGone = false
      for (let width = 220; width >= 58; width--) {
        const line = bandRowText(layoutDagRow({ ...BASE, summary: long, more: 2, usage: QUIET, waiting, width }))
        if (!line.includes("预算")) budgetGone = true
        if (budgetGone) expect(line, `at ${width}`).not.toContain("预算")
        if (line.includes("预算")) {
          expect(line, `at ${width}`).toContain("波")
          expect(line, `at ${width}`).toContain("tok")
        }
      }
    }
  })

  for (const aw of [1, 2] as const) {
    test(`keeps the mark and a bar down to the narrowest terminal the shell draws (ambiguous width ${aw})`, () => {
      for (const usage of [WARN, EXHAUSTED]) {
        for (const nodes of [[...NODES], wide(60, 10), wide(200, 8)]) {
          for (let width = 56; width <= 140; width++) {
            const row = layoutDagRow({
              summary: summary({ nodeCount: nodes.length }),
              nodes,
              more: 3,
              mode: "on",
              usage,
              waiting: true,
              width,
              ambiguousWidth: aw,
            })
            const label = `${usage.tier}, ${nodes.length} nodes at ${width} (aw ${aw})`
            expect(bandRowText(row), label).toContain("模式开")
            expect(bandRowText(row), label).toMatch(/[━─╌]/)
            expect(row.cells, label).toBeLessThanOrEqual(width)
          }
        }
      }
    })

    test(`never claims more cells than it uses or than it has (ambiguous width ${aw})`, () => {
      const shapes: Array<[string, DagNodeRow[] | undefined, DagWorkflowSummary]> = [
        ["a table", [...NODES], summary()],
        ["no table", undefined, summary()],
        ["a long title", [...NODES], summary({ title: "依赖升级验证与发布前检查和回归测试的完整清单" })],
        ["200 nodes", wide(200, 8), summary({ nodeCount: 200, completedNodes: 200 })],
      ]
      for (const [name, nodes, flow] of shapes) {
        for (const usage of [WARN, EXHAUSTED]) {
          for (const mode of [undefined, "on", "off"] as const) {
            for (const waiting of [false, true]) {
              for (let width = 8; width <= 160; width++) {
                const row = layoutDagRow({
                  summary: flow,
                  nodes,
                  more: 3,
                  mode,
                  usage,
                  waiting,
                  width,
                  ambiguousWidth: aw,
                })
                const label = `${name}, ${usage.tier}, ${mode}, ${waiting} at ${width} (aw ${aw})`
                expect(measured(row, aw), label).toBe(row.cells)
                expect(row.cells, label).toBeLessThanOrEqual(width)
              }
            }
          }
        }
      }
    })
  }

  test("says it in English too", () => {
    setLanguage("en")
    const line = textOf(WARN, { waiting: true })
    expect(line).toContain("waiting for main agent")
    expect(line).toContain("budget 85%")
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

  test("draws nothing, and does not throw, for a goal that lacks its text or its status", () => {
    // The wire type promises both; a body that is not a goal must cost the band its goal row, not the band.
    for (const body of [{}, { goal: "ship it" }, { status: "active" }, { goal: 5, status: "active" }]) {
      const row = layoutGoalRow({ goal: malformed(body), width: 116 })
      expect(row, JSON.stringify(body)).toEqual({ spans: [], cells: 0 })
    }
    expect(layoutGoalRow({ goal: malformed({ goal: "ship it", status: 3 }), width: 116 })).toEqual({
      spans: [],
      cells: 0,
    })
  })

  test("knows a goal from what is not one", () => {
    expect(isGoalShown(goal())).toBe(true)
    expect(isGoalShown(malformed({}))).toBe(false)
    expect(isGoalShown(malformed({ goal: "ship it" }))).toBe(false)
    expect(isGoalShown(malformed({ goal: "ship it", status: "active" }))).toBe(true)
    expect(isGoalShown(undefined)).toBe(false)
    // A server that answers "no goal" with null leaves null in the store, not undefined.
    expect(isGoalShown(null)).toBe(false)
  })

  test("shows a goal whose status is one this version does not know, as the text it is", () => {
    const row = layoutGoalRow({
      goal: malformed({ goal: "ship it", status: "parked", turnsUsed: 1, maxTurns: 5 }),
      width: 116,
    })
    expect(bandRowText(row)).toContain("parked")
  })

  test("takes a reason or a subgoal list of the wrong kind for none", () => {
    const row = layoutGoalRow({
      goal: malformed({
        goal: "ship it",
        status: "paused",
        pausedReason: 12,
        subgoals: "x",
        turnsUsed: 1,
        maxTurns: 5,
      }),
      width: 116,
    })
    const line = bandRowText(row)
    expect(line).toContain("ship it")
    expect(line).toContain("已暂停")
    expect(line).not.toContain("子目标")
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

const LANGUAGES = ["zh-CN", "en"] as const

describe("the background mark on a workflow row", () => {
  const MARK = "◇ 后台 3"
  const PR = "PR ~4/6"
  const BASE = { summary: summary(), nodes: NODES, more: 0 } as const
  const dag = (extra: Partial<Parameters<typeof layoutDagRow>[0]> = {}) =>
    layoutDagRow({ ...BASE, width: 116, ...extra })

  test("rides at the tail, after the PR mark, two cells off it, as a piece of its own", () => {
    const row = dag({ pr: PR, background: MARK })
    expect(bandRowText(row).endsWith("/dag  PR ~4/6  ◇ 后台 3")).toBe(true)
    expect(row.cells).toBe(116)
    expect(measured(row, 1)).toBe(116)
    expect(row.spans.filter((span) => span.action !== undefined)).toEqual([
      { text: MARK, token: "textMuted", action: "agents" },
    ])
    expect(row.spans.at(-1)?.action).toBe("agents")
  })

  test("is the last group when there is no PR mark either", () => {
    const row = dag({ background: MARK })
    expect(bandRowText(row).endsWith("/dag  ◇ 后台 3")).toBe(true)
  })

  test("is the first thing the row gives up: before the /dag hint, with the PR mark staying", () => {
    let hintWithoutMark = 0
    let markWidths = 0
    for (const language of LANGUAGES) {
      setLanguage(language)
      for (let width = 140; width >= 30; width--) {
        const marked = dag({ pr: PR, background: MARK, width })
        const plain = dag({ pr: PR, width })
        const line = bandRowText(marked)
        if (line.includes(MARK)) {
          markWidths++
          // The mark never outlives the hint, and the PR mark is there whenever the background mark is.
          expect(line, `width ${width}`).toContain("/dag")
          expect(line, `width ${width}`).toContain(PR)
        } else {
          // Without room for it the row is the row it was: nothing else gave way for the mark.
          expect(marked, `width ${width}`).toEqual(plain)
          if (line.includes("/dag")) hintWithoutMark++
        }
      }
    }
    // Both happen somewhere on the way down: the mark is there, and then the hint is still there without it.
    expect(markWidths).toBeGreaterThan(0)
    expect(hintWithoutMark).toBeGreaterThan(0)
  })

  test("the mark does not narrow the bar, take the counts or the title: the row is the unmarked one when it fits", () => {
    const marked = dag({ pr: PR, background: MARK, width: 200 })
    const plain = dag({ pr: PR, width: 200 })
    const named = (row: BandRow) => row.spans.filter((span) => span.text.trim() !== "" && span.action === undefined)
    expect(bandRowText(marked)).toContain(MARK)
    expect(named(marked)).toEqual(named(plain))
  })

  test("a row at the warning or exhausted band of its budget is a warning row: it takes no mark", () => {
    const base = { running: 3, cap: 12, budget: 1_000_000 } as const
    const quiet: DagUsage = { ...base, tokens: 620_000, percent: 62, tier: "normal" }
    const warn: DagUsage = { ...base, tokens: 850_000, percent: 85, tier: "warn" }
    const exhausted: DagUsage = { ...base, tokens: 1_000_000, percent: 100, tier: "exhausted" }
    expect(dagUsageAlert(undefined)).toBe(false)
    expect(dagUsageAlert(quiet)).toBe(false)
    expect(dagUsageAlert(warn)).toBe(true)
    expect(dagUsageAlert(exhausted)).toBe(true)
    // A tier without a percent is not drawn as an alert either (there is no budget to keep on the row).
    expect(dagUsageAlert({ tokens: 5, tier: "warn" })).toBe(false)
    for (const usage of [warn, exhausted]) {
      const row = dag({ usage, background: MARK, width: 200 })
      expect(bandRowText(row)).not.toContain("◇")
      expect(row.spans.some((span) => span.action !== undefined)).toBe(false)
      expect(row).toEqual(dag({ usage, width: 200 }))
    }
    expect(bandRowText(dag({ usage: quiet, background: MARK, width: 200 }))).toContain(MARK)
  })

  for (const language of LANGUAGES) {
    for (const aw of [1, 2] as const) {
      test(`never claims more cells than it has with the mark, 20 to 200, in ${language} at ambiguous width ${aw}`, () => {
        setLanguage(language)
        const mark = language === "en" ? "◇ bg 3·q1" : "◇ 后台 3·排1"
        for (let width = 20; width <= 200; width++) {
          const row = dag({ pr: PR, background: mark, width, ambiguousWidth: aw })
          expect(row.cells, `width ${width}`).toBeLessThanOrEqual(width)
          expect(measured(row, aw), `width ${width}`).toBe(row.cells)
        }
      })
    }
  }
})

describe("the background mark on the row `always` shows without a workflow", () => {
  const MARK = "◇ 后台 3"

  test("follows the hint and the PR mark, and gives way before the hint", () => {
    const row = layoutEmptyRow({ width: 116, pr: "PR ✓", background: MARK })
    expect(bandRowText(row).endsWith("/dag  PR ✓  ◇ 后台 3")).toBe(true)
    expect(row.cells).toBe(116)
    expect(row.spans.at(-1)).toEqual({ text: MARK, token: "textMuted", action: "agents" })

    let withHintOnly = 0
    for (let width = 90; width >= 10; width--) {
      const marked = layoutEmptyRow({ width, pr: "PR ✓", background: MARK })
      const plain = layoutEmptyRow({ width, pr: "PR ✓" })
      const line = bandRowText(marked)
      if (line.includes(MARK)) {
        expect(line, `width ${width}`).toContain("/dag")
        expect(line, `width ${width}`).toContain("PR ✓")
      } else {
        expect(marked, `width ${width}`).toEqual(plain)
        if (line.includes("/dag")) withHintOnly++
      }
    }
    expect(withHintOnly).toBeGreaterThan(0)
  })

  test("is the row it was when there is no mark, and never overflows with one", () => {
    for (const language of LANGUAGES) {
      for (const aw of [1, 2] as const) {
        setLanguage(language)
        const mark = language === "en" ? "◇ bg 12" : "◇ 后台 12"
        for (let width = 0; width <= 160; width++) {
          const row = layoutEmptyRow({ width, ambiguousWidth: aw, pr: "PR ~4/6", background: mark })
          expect(row.cells, `${language} aw ${aw} width ${width}`).toBeLessThanOrEqual(width)
          expect(measured(row, aw), `${language} aw ${aw} width ${width}`).toBe(row.cells)
        }
      }
    }
    expect(layoutEmptyRow({ width: 60 })).toEqual(layoutEmptyRow({ width: 60, background: undefined }))
  })
})

describe("the background mark on the goal row", () => {
  const MARK = "◇ 后台 3"

  test("follows the hint, two cells off it, when the row has room left over", () => {
    const row = layoutGoalRow({ goal: goal(), background: MARK, width: 116 })
    expect(bandRowText(row).endsWith("第 6/30 轮 · 进行中  /goal  ◇ 后台 3")).toBe(true)
    expect(row.cells).toBe(116)
    expect(row.spans.at(-1)).toEqual({ text: MARK, token: "textMuted", action: "agents" })
  })

  test("takes no room from the goal: a long goal fills the row and the mark is left out", () => {
    const long = goal({
      goal: "把所有依赖逐个升到最新稳定版，跑完整的回归测试，并且在每一步之后写一份迁移记录".repeat(3),
    })
    expect(layoutGoalRow({ goal: long, background: MARK, width: 116 })).toEqual(
      layoutGoalRow({ goal: long, width: 116 }),
    )
  })

  test("never changes what the row says: the pieces other than the mark are the unmarked row's, at every width", () => {
    const named = (row: BandRow) => row.spans.filter((span) => span.text.trim() !== "" && span.action === undefined)
    let drawn = 0
    for (const language of LANGUAGES) {
      for (const aw of [1, 2] as const) {
        setLanguage(language)
        const mark = language === "en" ? "◇ bg 3" : "◇ 后台 3"
        for (let width = 0; width <= 200; width++) {
          const marked = layoutGoalRow({
            goal: goal({ subgoals: ["a", "b"] }),
            background: mark,
            width,
            ambiguousWidth: aw,
          })
          const plain = layoutGoalRow({ goal: goal({ subgoals: ["a", "b"] }), width, ambiguousWidth: aw })
          expect(marked.cells, `${language} aw ${aw} width ${width}`).toBeLessThanOrEqual(width)
          expect(measured(marked, aw), `${language} aw ${aw} width ${width}`).toBe(marked.cells)
          expect(named(marked), `${language} aw ${aw} width ${width}`).toEqual(named(plain))
          if (marked.spans.some((span) => span.action !== undefined)) drawn++
        }
      }
    }
    expect(drawn).toBeGreaterThan(0)
  })
})
