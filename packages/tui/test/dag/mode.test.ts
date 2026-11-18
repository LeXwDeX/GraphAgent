// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { DagWorkflowQuality, DagWorkflowSummary } from "@graphagent/sdk"
import { setLanguage } from "../../src/i18n"
import {
  dagBudgetTier,
  dagCoverageEntries,
  dagModeLine,
  dagModeMarker,
  dagQualityText,
  dagUsage,
  dagWaitingForMainAgent,
  formatDagTokens,
  type DagModeSnapshot,
} from "../../src/dag/mode"
import type { DagNodeRow } from "../../src/dag/model"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

function snapshot(
  extra: { budget?: Partial<DagModeSnapshot["budget"]>; limits?: Partial<DagModeSnapshot["limits"]> } = {},
) {
  return {
    budget: { tokens: 5_000_000, used: 1_200_000, usedCacheRead: 0, warnRatio: 0.8, ...extra.budget },
    limits: {
      concurrency: 12,
      configuredConcurrency: null,
      maxTotalNodes: 100,
      configuredMaxTotalNodes: null,
      running: 3,
      ...extra.limits,
    },
  } satisfies DagModeSnapshot
}

describe("dagBudgetTier: the three bands of a budget", () => {
  test("a session with no budget is never anything but normal", () => {
    for (const budget of [null, undefined, 0, -5]) {
      expect(dagBudgetTier(0, budget, 0.8)).toBe("normal")
      expect(dagBudgetTier(10_000_000, budget, 0.8)).toBe("normal")
    }
  })

  test("normal below the warning line, warn from it, exhausted from the budget on", () => {
    expect(dagBudgetTier(0, 1000, 0.8)).toBe("normal")
    expect(dagBudgetTier(799, 1000, 0.8)).toBe("normal")
    expect(dagBudgetTier(800, 1000, 0.8)).toBe("warn")
    expect(dagBudgetTier(999, 1000, 0.8)).toBe("warn")
    expect(dagBudgetTier(1000, 1000, 0.8)).toBe("exhausted")
    expect(dagBudgetTier(1500, 1000, 0.8)).toBe("exhausted")
  })

  test("the warning line is cut where the server cuts it: whole tokens, rounded down", () => {
    // 1001 x 0.8 = 800.8: the server warns from 800, and so does the display, so their colors agree.
    expect(dagBudgetTier(799, 1001, 0.8)).toBe("normal")
    expect(dagBudgetTier(800, 1001, 0.8)).toBe("warn")
  })

  test("follows the configured ratio", () => {
    expect(dagBudgetTier(500, 1000, 0.5)).toBe("warn")
    expect(dagBudgetTier(499, 1000, 0.5)).toBe("normal")
    // A ratio of 1 has no band of its own: the budget itself is the line.
    expect(dagBudgetTier(999, 1000, 1)).toBe("normal")
    expect(dagBudgetTier(1000, 1000, 1)).toBe("exhausted")
  })
})

describe("formatDagTokens: counts as the band writes them", () => {
  test("small counts are whole numbers", () => {
    expect(formatDagTokens(0)).toBe("0")
    expect(formatDagTokens(940)).toBe("940")
  })

  test("thousands and millions are shortened to at most one decimal", () => {
    expect(formatDagTokens(1000)).toBe("1K")
    expect(formatDagTokens(1234)).toBe("1.2K")
    expect(formatDagTokens(12_345)).toBe("12K")
    expect(formatDagTokens(1_234_567)).toBe("1.2M")
    expect(formatDagTokens(5_000_000)).toBe("5M")
    expect(formatDagTokens(12_000_000)).toBe("12M")
  })

  test("a count that rounds up to the next unit says so, instead of 1000K", () => {
    expect(formatDagTokens(999_999)).toBe("1M")
  })

  test("a count that is not a count reads as nothing used", () => {
    expect(formatDagTokens(Number.NaN)).toBe("0")
    expect(formatDagTokens(-4)).toBe("0")
    expect(formatDagTokens(Number.POSITIVE_INFINITY)).toBe("0")
  })
})

describe("dagUsage: what the session's workflows have used", () => {
  test("says nothing while nothing is known", () => {
    expect(dagUsage({})).toBeUndefined()
    expect(dagUsage({ workflows: [] })).toBeUndefined()
    expect(dagUsage({ workflows: [{}, {}] })).toBeUndefined()
  })

  test("takes everything from the snapshot while no workflow reports usage", () => {
    expect(dagUsage({ snapshot: snapshot() })).toEqual({
      running: 3,
      cap: 12,
      tokens: 1_200_000,
      budget: 5_000_000,
      percent: 24,
      tier: "normal",
    })
  })

  test("the workflows' own tokens replace the snapshot's, which is older than their events", () => {
    const usage = dagUsage({ snapshot: snapshot(), workflows: [{ tokens: 2_000_000 }, { tokens: 500_000 }] })
    expect(usage?.tokens).toBe(2_500_000)
    expect(usage?.percent).toBe(50)
  })

  test("one workflow without the field counts as none while the others report it", () => {
    expect(dagUsage({ snapshot: snapshot(), workflows: [{ tokens: 100 }, {}] })?.tokens).toBe(100)
  })

  test("workflows that carry no tokens at all leave the snapshot's figure standing", () => {
    expect(dagUsage({ snapshot: snapshot(), workflows: [{}, {}] })?.tokens).toBe(1_200_000)
  })

  test("the running count follows the first workflow that carries it, else the snapshot", () => {
    expect(dagUsage({ snapshot: snapshot(), workflows: [{}, { concurrencyRunning: 7 }] })?.running).toBe(7)
    expect(dagUsage({ snapshot: snapshot(), workflows: [{ tokens: 1 }] })?.running).toBe(3)
    // A zero is a report, not a gap.
    expect(dagUsage({ snapshot: snapshot(), workflows: [{ concurrencyRunning: 0 }] })?.running).toBe(0)
  })

  test("the process's latest report beats the session's own summaries and the snapshot", () => {
    // Another session's event moved the slots after this session's workflows last reported.
    expect(dagUsage({ snapshot: snapshot(), workflows: [{ concurrencyRunning: 7 }], running: 9 })?.running).toBe(9)
    expect(dagUsage({ snapshot: snapshot(), workflows: [{ tokens: 1 }], running: 9 })?.running).toBe(9)
    expect(dagUsage({ snapshot: snapshot(), running: 9 })?.running).toBe(9)
    // A zero is a report here too, and leaves the cap and the budget to the snapshot.
    expect(dagUsage({ snapshot: snapshot(), workflows: [{ concurrencyRunning: 7 }], running: 0 })).toMatchObject({
      running: 0,
      cap: 12,
      budget: 5_000_000,
    })
  })

  test("without the process's report the order is the summaries' figure, then the snapshot's", () => {
    expect(
      dagUsage({ snapshot: snapshot(), workflows: [{ concurrencyRunning: 7 }], running: undefined })?.running,
    ).toBe(7)
    expect(dagUsage({ snapshot: snapshot(), running: undefined })?.running).toBe(3)
  })

  test("the process's figure alone is something to show, and invents no cap", () => {
    expect(dagUsage({ running: 2 })).toEqual({ running: 2, tier: "normal" })
  })

  test("without a snapshot only the workflows' own figures show, and no cap or budget is invented", () => {
    expect(dagUsage({ workflows: [{ tokens: 4200, concurrencyRunning: 2 }] })).toEqual({
      running: 2,
      tokens: 4200,
      tier: "normal",
    })
  })

  test("a session without a budget has tokens but no percent, and never leaves normal", () => {
    const usage = dagUsage({ snapshot: snapshot({ budget: { tokens: null, used: 90_000_000 } }) })
    expect(usage).toEqual({ running: 3, cap: 12, tokens: 90_000_000, tier: "normal" })
  })

  test("a budget of zero is no budget", () => {
    expect(dagUsage({ snapshot: snapshot({ budget: { tokens: 0 } }) })?.percent).toBeUndefined()
  })

  test("the percent is rounded down and may run past 100 once nodes finish after the budget ended", () => {
    expect(dagUsage({ snapshot: snapshot({ budget: { tokens: 1000, used: 629 } }) })?.percent).toBe(62)
    expect(dagUsage({ snapshot: snapshot({ budget: { tokens: 1000, used: 999 } }) })?.percent).toBe(99)
    expect(dagUsage({ snapshot: snapshot({ budget: { tokens: 1000, used: 1050 } }) })?.percent).toBe(105)
  })

  test("the tier comes from the usage, the budget and the snapshot's warn ratio", () => {
    const at = (used: number, warnRatio = 0.8) =>
      dagUsage({ snapshot: snapshot({ budget: { tokens: 1000, used, warnRatio } }) })?.tier
    expect(at(100)).toBe("normal")
    expect(at(800)).toBe("warn")
    expect(at(1000)).toBe("exhausted")
    expect(at(600, 0.5)).toBe("warn")
  })

  test("a workflow's events move the tier without another read of the snapshot", () => {
    const base = snapshot({ budget: { tokens: 1000, used: 100 } })
    expect(dagUsage({ snapshot: base, workflows: [{ tokens: 100 }] })?.tier).toBe("normal")
    expect(dagUsage({ snapshot: base, workflows: [{ tokens: 900 }] })?.tier).toBe("warn")
    expect(dagUsage({ snapshot: base, workflows: [{ tokens: 1000 }] })?.tier).toBe("exhausted")
  })
})

describe("dagModeMarker: the mode mark on the band", () => {
  test("is on whenever the mode is on", () => {
    expect(dagModeMarker(true, [])).toBe("on")
    expect(dagModeMarker(true, [{ status: "failed" }])).toBe("on")
  })

  test("is the dim off mark only while a workflow runs with the mode off", () => {
    expect(dagModeMarker(false, [{ status: "running" }])).toBe("off")
    expect(dagModeMarker(false, [{ status: "completed" }, { status: "stepping" }])).toBe("off")
  })

  test("is nothing when the mode is off and nothing is running", () => {
    expect(dagModeMarker(false, [])).toBeUndefined()
    expect(dagModeMarker(false, [{ status: "paused" }, { status: "failed" }, { status: "completed" }])).toBeUndefined()
  })
})

describe("dagWaitingForMainAgent: a checkpoint waits and the agent is not working", () => {
  const pending = [{ checkpointPending: true }]

  test("needs a workflow that waits at a checkpoint", () => {
    expect(dagWaitingForMainAgent({ workflows: [], idle: true })).toBe(false)
    expect(dagWaitingForMainAgent({ workflows: [{}, { checkpointPending: false }], idle: true })).toBe(false)
    expect(dagWaitingForMainAgent({ workflows: [{}, ...pending], idle: true })).toBe(true)
  })

  test("an idle root session is waiting; a busy one is not", () => {
    expect(dagWaitingForMainAgent({ workflows: pending, idle: true })).toBe(true)
    expect(dagWaitingForMainAgent({ workflows: pending, idle: false })).toBe(false)
    expect(dagWaitingForMainAgent({ workflows: pending, idle: false, lastTurn: "completed" })).toBe(false)
  })

  test("a latest turn that ended in an error counts as waiting even when the session does not read as idle", () => {
    expect(dagWaitingForMainAgent({ workflows: pending, idle: false, lastTurn: "error" })).toBe(true)
  })

  test("an error means nothing without a checkpoint", () => {
    expect(dagWaitingForMainAgent({ workflows: [], idle: false, lastTurn: "error" })).toBe(false)
  })
})

function quality(extra: Partial<DagWorkflowQuality> = {}): DagWorkflowQuality {
  return {
    reviewBound: true,
    reviews: 2,
    raised: 7,
    fixed: 5,
    refuted: 2,
    stillOpen: 0,
    skepticRefutations: 1,
    rounds: 4,
    quietRounds: 2,
    completeness: { covered: 5, total: 6, unlisted: 0 },
    ...extra,
  }
}

describe("dagQualityText: the review quality row", () => {
  test("is nothing for a workflow without a review decision", () => {
    expect(dagQualityText(null)).toBeUndefined()
    expect(dagQualityText(undefined)).toBeUndefined()
  })

  test("says reviews, what is still open and how complete the acceptance items are", () => {
    expect(dagQualityText(quality())).toBe("审核 2 次 · 遗留 0 项 · 完整性 5/6")
  })

  test("leaves completeness out until a completeness lane has completed", () => {
    expect(dagQualityText(quality({ completeness: null, stillOpen: 3 }))).toBe("审核 2 次 · 遗留 3 项")
  })

  test("says how many items the lanes judged that the acceptance list does not name", () => {
    expect(dagQualityText(quality({ completeness: { covered: 5, total: 6, unlisted: 2 } }))).toBe(
      "审核 2 次 · 遗留 0 项 · 完整性 5/6（未列出 2）",
    )
  })

  test("follows the interface language", () => {
    setLanguage("en")
    expect(dagQualityText(quality())).toBe("reviews 2 · open 0 · complete 5/6")
  })
})

function row(id: string, status: string, extra: Partial<DagNodeRow> = {}): DagNodeRow {
  return {
    id,
    workflow_id: "wf",
    name: id,
    worker_type: "task",
    status,
    required: false,
    depends_on: [],
    replan_attempts: 0,
    ...extra,
  }
}

describe("dagCoverageEntries: the nodes the work did not cover", () => {
  test("picks the failed, cancelled, aborted and skipped nodes, in the order given", () => {
    const entries = dagCoverageEntries([
      row("a", "completed"),
      row("b", "failed", { error_reason: "ripgrep 下载超时（504）" }),
      row("c", "running"),
      row("d", "skipped"),
      row("e", "failed", { error_class: "cancelled" }),
      row("f", "aborted"),
      row("g", "queued"),
      row("h", "pending"),
    ])
    expect(entries.map((entry) => [entry.id, entry.state])).toEqual([
      ["b", "failed"],
      ["d", "skipped"],
      ["e", "cancelled"],
      ["f", "aborted"],
    ])
  })

  test("a failed node carries its cleaned reason, the others none", () => {
    const entries = dagCoverageEntries([
      row("b", "failed", { error_reason: "Cause([Die(boom)])" }),
      row("d", "skipped", { error_reason: "ignored" }),
      row("f", "failed"),
    ])
    expect(entries.map((entry) => entry.reason)).toEqual(["boom", undefined, undefined])
  })

  test("a reason cannot carry escapes or line breaks to the screen", () => {
    const [entry] = dagCoverageEntries([row("b", "failed", { error_reason: "\u001b[31mred\u001b[0m\nsecond line" })])
    expect(entry.reason).toBe("red second line")
  })

  test("names come cleaned the same way", () => {
    const [entry] = dagCoverageEntries([row("b", "failed", { name: "e2e\u001b[2Jwin\nnext" })])
    expect(entry.name).toBe("e2ewin next")
  })

  test("a table with nothing to report gives nothing", () => {
    expect(dagCoverageEntries([row("a", "completed"), row("b", "running")])).toEqual([])
    expect(dagCoverageEntries([])).toEqual([])
  })
})

describe("dagModeLine: the mode and its figures above the workflow", () => {
  const text = (pieces: ReturnType<typeof dagModeLine>) => pieces.map((piece) => piece.text).join(" · ")

  test("on, with every figure", () => {
    const usage = dagUsage({ snapshot: snapshot() })
    expect(text(dagModeLine({ on: true, snapshot: snapshot(), usage }))).toBe(
      "DAG 模式：开 · 运行 3/12（全进程） · 节点上限 100 · token 1.2M/5M",
    )
  })

  test("off says so and keeps the figures", () => {
    const usage = dagUsage({ snapshot: snapshot() })
    expect(text(dagModeLine({ on: false, snapshot: snapshot(), usage }))).toBe(
      "DAG 模式：关 · 运行 3/12（全进程） · 节点上限 100 · token 1.2M/5M",
    )
  })

  test("without a budget the tokens stand alone and say there is none", () => {
    const base = snapshot({ budget: { tokens: null } })
    expect(text(dagModeLine({ on: true, snapshot: base, usage: dagUsage({ snapshot: base }) }))).toBe(
      "DAG 模式：开 · 运行 3/12（全进程） · 节点上限 100 · token 1.2M（未设预算）",
    )
  })

  test("without a snapshot only the mode is known", () => {
    expect(text(dagModeLine({ on: true }))).toBe("DAG 模式：开")
    expect(text(dagModeLine({ on: false }))).toBe("DAG 模式：关")
  })

  test("the tokens take the color of the budget band, the rest stay quiet", () => {
    const at = (used: number) => {
      const base = snapshot({ budget: { tokens: 1000, used } })
      return dagModeLine({ on: true, snapshot: base, usage: dagUsage({ snapshot: base }) })
    }
    const tokensToken = (pieces: ReturnType<typeof dagModeLine>) => pieces.at(-1)?.token
    expect(tokensToken(at(100))).toBe("textMuted")
    expect(tokensToken(at(850))).toBe("warning")
    expect(tokensToken(at(1000))).toBe("error")
    expect(
      at(850)
        .slice(0, -1)
        .map((piece) => piece.token),
    ).not.toContain("warning")
  })

  test("follows the interface language", () => {
    setLanguage("en")
    const usage = dagUsage({ snapshot: snapshot() })
    expect(text(dagModeLine({ on: false, snapshot: snapshot(), usage }))).toBe(
      "DAG mode: off · running 3/12 (process-wide) · node cap 100 · tokens 1.2M/5M",
    )
  })
})

describe("the summary fields the display reads exist on the wire type", () => {
  test("tokens, concurrencyRunning, coverageCount, checkpointPending and quality are summary fields", () => {
    const summary: DagWorkflowSummary = {
      id: "wf",
      title: "t",
      status: "running",
      graphRev: 1,
      nodeCount: 1,
      completedNodes: 0,
      runningNodes: 1,
      failedNodes: 0,
      skippedNodes: 0,
      abortedNodes: 0,
      queuedNodes: 0,
      escalatedNodes: 0,
      tokens: 1,
      tokensCacheRead: 2,
      concurrencyRunning: 3,
      coverageCount: 4,
      checkpointPending: true,
      quality: quality(),
    }
    expect(dagUsage({ workflows: [summary] })).toEqual({ running: 3, tokens: 1, tier: "normal" })
  })
})
