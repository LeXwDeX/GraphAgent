// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { DagWorkflowSummary } from "@graphagent/sdk"
import type { DagUsage } from "../../src/dag/mode"
import type { DagNodeRow } from "../../src/dag/model"
import { setLanguage } from "../../src/i18n"
import { PR_MARK_CHARS, PR_TAIL_BUDGET } from "../../src/pr/state"
import {
  BAND_ROWS_MAX,
  chooseBandRows,
  layoutPrRow,
  layoutReminderRow,
  prHasWarning,
  prOpenUrl,
  prTailText,
  type BandCandidates,
  type BandRowKind,
  type MarkedRowKind,
} from "../../src/shell/pr-line"
import type { PrBandItem, ReminderBandItem } from "../../src/shell/pr-tracker-context"
import { bandRowText, layoutDagRow, type BandRow, type BandToken } from "../../src/shell/status-band"
import { cellWidth, type AmbiguousWidth } from "../../src/ui/width"
import {
  MINUTE,
  T0,
  bandItem as item,
  ciItem as ci,
  idle,
  stoppedItem as stopped,
  unresponsiveItem as unresponsive,
  workingItem as working,
} from "../fixture/pr-band"

// The PR and reminder rows as pure layout: what the tracker lists goes in, a row of colored spans comes out. No
// clocks and no sleeps: every time is an argument of `prLineState`.

const AMBIGUOUS_WIDTHS: readonly AmbiguousWidth[] = [1, 2]
const LANGUAGES = ["zh-CN", "en"] as const

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

const measured = (row: BandRow, aw: AmbiguousWidth) => cellWidth(bandRowText(row), aw)
const tokens = (row: BandRow) => row.spans.map((span) => span.token)

describe("the PR row", () => {
  test("writes one PR out: the label and number, the outcome and the sentence, each in its own color", () => {
    const row = layoutPrRow([working()], 76)
    expect(bandRowText(row)).toBe("PR #1035  ✓ 通过 · agent 处理中")
    expect(row.spans).toEqual([
      { text: "PR ", token: "textMuted" },
      { text: "#1035", token: "text" },
      { text: "  ", token: "textMuted" },
      { text: "✓ 通过", token: "success" },
      { text: " · ", token: "textDim" },
      { text: "agent 处理中", token: "textMuted" },
    ])
    expect(row.cells).toBe(cellWidth("PR #1035  ✓ 通过 · agent 处理中"))
  })

  test("says the CI counts while the PR is watched, and that it waits for CI before there are any", () => {
    expect(bandRowText(layoutPrRow([ci()], 76))).toBe("PR #1035  CI 4/6")
    expect(bandRowText(layoutPrRow([item({ phase: "watching", outcome: undefined })], 76))).toBe("PR #1035  等待 CI")
    // Watching has no outcome to put first, so the sentence follows the number alone.
    expect(layoutPrRow([ci()], 76).spans.at(-1)).toEqual({ text: "CI 4/6", token: "textMuted" })
  })

  test("draws a warning row in the warning color from the label on, the outcome keeping its own", () => {
    const row = layoutPrRow([unresponsive({ number: 1040 })], 76)
    expect(bandRowText(row)).toBe("PR #1040  ✓ 通过 · agent 未响应")
    expect(tokens(row)).toEqual(["warning", "warning", "textMuted", "success", "textDim", "warning"])

    const failed = layoutPrRow([stopped({ number: 1041 })], 76)
    expect(bandRowText(failed)).toBe("PR #1041  ✗ 失败 · 已通知 · 会话已中止，未自动继续")
    expect(failed.spans.find((span) => span.text === "✗ 失败")?.token).toBe("error")
  })

  /** One state of every kind `prLineState` can say about a delivered or ended watch, and how the row reads it. */
  const KINDS: Array<{
    kind: string
    item: () => PrBandItem
    zh: string
    en: string
    /** The colors of the label, the number, the outcome and the sentence; the gaps and the separator are fixed. */
    colors: [BandToken, BandToken, BandToken | undefined, BandToken | undefined]
  }> = [
    {
      kind: "watching",
      item: () => ci(),
      zh: "CI 4/6",
      en: "CI 4/6",
      colors: ["textMuted", "text", undefined, "textMuted"],
    },
    {
      kind: "awaiting",
      item: () => item({ phase: "delivering", delivery: { state: "pending" }, updatedAt: T0 - MINUTE }),
      zh: "✓ 通过 · 等待 agent 接收",
      en: "✓ passed · waiting for the agent",
      colors: ["textMuted", "text", "success", "textMuted"],
    },
    {
      kind: "notified",
      item: () => item({ delivery: { state: "delivered", deliveredAt: T0 } }),
      zh: "✓ 通过 · 已通知 agent",
      en: "✓ passed · agent notified",
      colors: ["textMuted", "text", "success", "textMuted"],
    },
    {
      kind: "working",
      item: () => working(),
      zh: "✓ 通过 · agent 处理中",
      en: "✓ passed · agent working",
      colors: ["textMuted", "text", "success", "textMuted"],
    },
    {
      kind: "handled",
      item: () =>
        item({ delivery: { state: "delivered", deliveredAt: T0 } }, idle, [
          { created: T0 + 1, completed: T0 + 2, error: false, aborted: false },
        ]),
      zh: "✓ 通过 · agent 已处理",
      en: "✓ passed · agent handled it",
      colors: ["textMuted", "text", "success", "textMuted"],
    },
    {
      kind: "turnError",
      item: () =>
        item({ delivery: { state: "delivered", deliveredAt: T0 } }, idle, [
          { created: T0 + 1, completed: T0 + 2, error: true, aborted: false },
        ]),
      zh: "✓ 通过 · agent 回合出错",
      en: "✓ passed · agent turn failed",
      colors: ["warning", "warning", "success", "warning"],
    },
    {
      kind: "unresponsive",
      item: () => unresponsive(),
      zh: "✓ 通过 · agent 未响应",
      en: "✓ passed · agent not responding",
      colors: ["warning", "warning", "success", "warning"],
    },
    {
      kind: "noReply",
      item: () => item({ delivery: { state: "delivered", deliveredAt: T0, noReply: true } }),
      zh: "✓ 通过 · 已通知 · 会话已中止，未自动继续",
      en: "✓ passed · notified · session stopped, not resumed",
      colors: ["warning", "warning", "success", "warning"],
    },
    {
      kind: "settled",
      item: () => item(),
      zh: "✓ 通过",
      en: "✓ passed",
      colors: ["textMuted", "text", "success", undefined],
    },
  ]

  for (const language of LANGUAGES) {
    test(`says every kind of state with its own sentence and colors, in ${language}`, () => {
      setLanguage(language)
      for (const spec of KINDS) {
        const row = layoutPrRow([spec.item()], 76)
        expect(bandRowText(row), spec.kind).toBe(`PR #1035  ${spec[language === "en" ? "en" : "zh"]}`)
        // Label, number, then the outcome and the sentence when there are any, each after its gap or separator.
        const [label, number, outcome, sentence] = spec.colors
        const painted = row.spans.filter((span) => span.token !== "textDim" && span.text.trim() !== "")
        expect(
          painted.map((span) => span.token),
          spec.kind,
        ).toEqual([label, number, ...(outcome ? [outcome] : []), ...(sentence ? [sentence] : [])])
      }
    })
  }

  // The tracker lists facts and no word (#1409), so a row is worded when it is drawn: one that was handed out in
  // another language, a held warning for one, says the sentence of the language the interface has by then.
  for (const [built, drawn] of [
    ["zh-CN", "en"],
    ["en", "zh-CN"],
  ] as const) {
    test(`words a row when it is drawn: built in ${built}, drawn in ${drawn}`, () => {
      for (const spec of KINDS) {
        setLanguage(built)
        const made = spec.item()
        setLanguage(drawn)
        expect(bandRowText(layoutPrRow([made], 76)), spec.kind).toBe(`PR #1035  ${spec[drawn === "en" ? "en" : "zh"]}`)
      }
    })
  }

  test("colors the outcome by what it was: passed gray, failed error, timed out warning, the rest muted", () => {
    const outcomes = [
      ["success", "✓ 通过", "success"],
      ["failure", "✗ 失败", "error"],
      ["merged", "已合并", "textMuted"],
      ["closed", "已关闭", "textMuted"],
      ["review", "review 有变化", "textMuted"],
      ["deadline", "超时", "warning"],
    ] as const
    for (const [outcome, text, token] of outcomes) {
      const row = layoutPrRow([item({ outcome })], 76)
      expect(bandRowText(row), outcome).toBe(`PR #1035  ${text}`)
      expect(row.spans.at(-1), outcome).toEqual({ text, token })
      // A timed-out PR is not a warning row as a whole: its label stays muted.
      expect(row.spans[0].token, outcome).toBe("textMuted")
    }
  })

  test("says it in English", () => {
    setLanguage("en")
    expect(bandRowText(layoutPrRow([working()], 76))).toBe("PR #1035  ✓ passed · agent working")
    expect(bandRowText(layoutPrRow([ci()], 76))).toBe("PR #1035  CI 4/6")
    expect(bandRowText(layoutPrRow([unresponsive()], 76))).toBe("PR #1035  ✓ passed · agent not responding")
  })

  test("compresses several PRs to marks, the warnings first, and colors the run by whether one is a warning", () => {
    const quiet = layoutPrRow([ci({ number: 1036 }), working({ number: 1035 })], 76)
    expect(quiet.spans).toEqual([{ text: "PR ~#1036 >#1035", token: "textMuted" }])

    const warned = layoutPrRow([unresponsive({ number: 1040 }), ci({ number: 1036 }), working({ number: 1035 })], 76)
    expect(warned.spans).toEqual([{ text: "PR !#1040 ~#1036 >#1035", token: "warning" }])
  })

  test("counts the PRs that do not fit in a trailing +k, and keeps the label and the count when little is left", () => {
    const many = [
      unresponsive({ number: 1040 }),
      stopped({ number: 1041 }),
      ci({ number: 1036 }),
      working({ number: 1035 }),
      ci({ number: 1034 }),
    ]
    expect(bandRowText(layoutPrRow(many, 76))).toBe("PR !#1040 !#1041 ~#1036 >#1035 ~#1034")
    expect(bandRowText(layoutPrRow(many, 26))).toBe("PR !#1040 !#1041 ~#1036 +2")
    expect(bandRowText(layoutPrRow(many, 12))).toBe("PR !#1040 +4")
    expect(bandRowText(layoutPrRow(many, 5))).toBe("PR +5")
    // Not even `PR +n` fits.
    expect(layoutPrRow(many, 4)).toEqual({ spans: [], cells: 0 })
  })

  test("writes the compressed marks with ASCII and the two Neutral check marks only, one cell each", () => {
    const digits = Array.from({ length: 10 }, (_, digit) => String(digit))
    const allowed = new Set([...PR_MARK_CHARS, "P", "R", " ", "#", "+", ...digits])
    const outcomes = ["success", "failure", "merged", "closed", "review", "deadline"] as const
    const many = [
      unresponsive({ number: 1040 }),
      ci({ number: 1036 }),
      working({ number: 1035 }),
      ...outcomes.map((outcome, index) =>
        item({ outcome, number: 2000 + index, delivery: { state: "delivered", deliveredAt: T0 } }, idle, [
          { created: T0 + 1, completed: T0 + 2, error: false, aborted: false },
        ]),
      ),
    ]
    for (const aw of AMBIGUOUS_WIDTHS) {
      for (let width = 5; width <= 80; width++) {
        const text = bandRowText(layoutPrRow(many, width, aw))
        for (const char of text) expect(allowed.has(char), `${JSON.stringify(char)} in ${text}`).toBe(true)
        expect(cellWidth(text, aw), text).toBe(text.length)
      }
    }
  })

  test("cuts the row from the end, so the number stays longest and no separator is left dangling", () => {
    expect(bandRowText(layoutPrRow([working()], 30))).toBe("PR #1035  ✓ 通过 · agent 处理…")
    expect(bandRowText(layoutPrRow([working()], 14))).toBe("PR #1035  ✓ …")
    expect(bandRowText(layoutPrRow([working()], 9))).toBe("PR #1035")
    expect(bandRowText(layoutPrRow([working()], 5))).toBe("PR #…")
    // One cell holds the ellipsis alone; where it is two cells wide (ambiguous width 2) there is no room for it.
    expect(bandRowText(layoutPrRow([working()], 1))).toBe("…")
    expect(bandRowText(layoutPrRow([working()], 1, 2))).toBe("")
    for (const width of [0, -3, Number.NaN]) expect(layoutPrRow([working()], width)).toEqual({ spans: [], cells: 0 })
  })

  test("never uses the brand color", () => {
    const rows = [
      layoutPrRow([working()], 76),
      layoutPrRow([ci()], 76),
      layoutPrRow([unresponsive(), stopped()], 76),
      layoutPrRow([stopped()], 76),
      layoutReminderRow({ when: "5m", text: "deploy", due: false }, 76),
      layoutReminderRow({ when: undefined, text: "deploy", due: true }, 76),
    ]
    for (const row of rows) expect(tokens(row)).not.toContain("primary")
  })

  test("takes no row without PRs, and draws none whose state is hidden", () => {
    expect(layoutPrRow([], 76)).toEqual({ spans: [], cells: 0 })
    const hidden = item({ phase: "cancelled", outcome: undefined })
    expect(hidden.state.hidden).toBe(true)
    expect(layoutPrRow([hidden], 76)).toEqual({ spans: [], cells: 0 })
    expect(bandRowText(layoutPrRow([hidden, ci()], 76))).toBe("PR #1035  CI 4/6")
  })

  for (const language of LANGUAGES) {
    for (const aw of AMBIGUOUS_WIDTHS) {
      test(`never claims more cells than it has or than it uses, in ${language} at ambiguous width ${aw}`, () => {
        setLanguage(language)
        const shapes: Array<[string, PrBandItem[]]> = [
          ["watching", [ci()]],
          ["waiting for CI", [item({ phase: "watching", outcome: undefined })]],
          ["working", [working()]],
          ["warning", [unresponsive()]],
          ["warning that says more", [stopped()]],
          ["a long number", [working({ number: 123_456_789 })]],
          ["several", [unresponsive({ number: 1040 }), ci({ number: 1036 }), working({ number: 1035 })]],
        ]
        for (const [name, items] of shapes) {
          for (let width = 0; width <= 140; width++) {
            const row = layoutPrRow(items, width, aw)
            expect(measured(row, aw), `${name} at ${width}`).toBe(row.cells)
            expect(row.cells, `${name} at ${width}`).toBeLessThanOrEqual(width)
          }
        }
      })

      test(`fits the band's 80-column width in ${language} at ambiguous width ${aw}`, () => {
        setLanguage(language)
        // The band is 80 columns minus its 2-column padding on both sides.
        for (const items of [[stopped()], [unresponsive()], [working()], [ci()]]) {
          const row = layoutPrRow(items, 76, aw)
          expect(row.cells).toBeLessThanOrEqual(76)
          // The whole sentence fits at 80 columns: nothing is cut.
          expect(bandRowText(row)).not.toContain("…")
        }
      })
    }
  }
})

describe("the tail mark for the workflow row", () => {
  test("is the short mark of the PRs: the CI counts, the wait, or the outcome's mark", () => {
    expect(prTailText([ci()])).toBe("PR ~4/6")
    expect(prTailText([item({ phase: "watching", outcome: undefined })])).toBe("PR ~")
    expect(prTailText([working()])).toBe("PR >")
    expect(prTailText([item()])).toBe("PR ✓")
    expect(prTailText([item({ outcome: "merged" })])).toBe("PR M")
  })

  test("is empty without PRs, for a hidden PR, and while a warning has a row of its own", () => {
    expect(prTailText([])).toBe("")
    expect(prTailText([item({ phase: "cancelled", outcome: undefined })])).toBe("")
    expect(prTailText([unresponsive()])).toBe("")
    expect(prTailText([ci({ number: 1036 }), unresponsive({ number: 1040 })])).toBe("")
  })

  test("compresses several PRs into 14 cells at most", () => {
    expect(prTailText([ci({ number: 1036 }), working({ number: 1035 })])).toBe("PR ~#1036 +1")
    for (const items of [
      [ci({ number: 1036 }), working({ number: 1035 }), item({ number: 1034 })],
      [ci({ number: 1036 }), item({ number: 1034 })],
      [ci({ number: 123_456 }), item({ number: 1034 })],
    ]) {
      for (const aw of AMBIGUOUS_WIDTHS) {
        const text = prTailText(items)
        expect(cellWidth(text, aw), text).toBeLessThanOrEqual(PR_TAIL_BUDGET)
      }
    }
  })

  test("knows when one of the PRs is a warning", () => {
    expect(prHasWarning([])).toBe(false)
    expect(prHasWarning([ci(), working()])).toBe(false)
    expect(prHasWarning([ci(), stopped()])).toBe(true)
    expect(prHasWarning([unresponsive()])).toBe(true)
  })
})

describe("the PR mark at the tail of the workflow row", () => {
  const NODES: readonly DagNodeRow[] = [
    ...["n1", "n2", "n3"].map((id) => node(id, "completed")),
    node("n4", "completed", ["n1"]),
    node("n5", "failed", ["n2"]),
    node("n6", "running", ["n4"]),
    node("n7", "running", ["n4"]),
    node("n8", "queued", ["n6", "n7"]),
    node("n9", "queued", ["n8"]),
  ]
  const USAGE: DagUsage = { running: 3, cap: 12, tokens: 1_200_000, budget: 5_000_000, percent: 24, tier: "normal" }
  const FULL = { summary: summary(), nodes: NODES, more: 2, mode: "on", usage: USAGE, waiting: true } as const

  function node(id: string, status: string, depends: string[] = []): DagNodeRow {
    return {
      id,
      workflow_id: "dag_a",
      name: id,
      worker_type: "task",
      status,
      required: false,
      depends_on: depends,
      replan_attempts: 0,
    }
  }

  function summary(): DagWorkflowSummary {
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
    }
  }

  test("is the last piece at the right edge, after the hint, in the muted color", () => {
    const row = layoutDagRow({ ...FULL, pr: "PR ~4/6", width: 200 })
    expect(
      bandRowText(row).endsWith("等待主 agent  模式开  全进程并发 3/12 · 1.2M tok · 预算 24%  +2 个  /dag  PR ~4/6"),
    ).toBe(true)
    expect(row.spans.at(-1)).toEqual({ text: "PR ~4/6", token: "textMuted" })
    expect(row.cells).toBe(200)
    expect(measured(row, 1)).toBe(200)
  })

  test("changes nothing for a row without it", () => {
    const plain = layoutDagRow({ ...FULL, width: 120 })
    expect(layoutDagRow({ ...FULL, pr: "", width: 120 })).toEqual(plain)
    expect(layoutDagRow({ ...FULL, pr: undefined, width: 120 })).toEqual(plain)
  })

  test("does not give way with the text: it stays, with the mode mark and a bar, down to the narrowest terminal", () => {
    const tails = ["PR ~4/6", "PR ~#1036 +1", "PR !#1040 +2"]
    for (const aw of AMBIGUOUS_WIDTHS) {
      for (const pr of tails) {
        for (const mode of ["on", "off"] as const) {
          for (let width = 56; width <= 140; width++) {
            const row = layoutDagRow({ ...FULL, mode, pr, width, ambiguousWidth: aw })
            const label = `${pr}, mode ${mode} at ${width} (aw ${aw})`
            expect(bandRowText(row), label).toContain(pr)
            expect(bandRowText(row), label).toContain(mode === "on" ? "模式开" : "模式关")
            expect(bandRowText(row), label).toMatch(/[━─╌]/)
            expect(row.cells, label).toBeLessThanOrEqual(width)
          }
        }
      }
    }
  })

  test("outlasts the text at the smallest levels: the title, the counts, the wait and the budget go first", () => {
    // 60 columns: the least text, the mark and the PR mark fit beside a bar of a few segments.
    const row = layoutDagRow({ ...FULL, pr: "PR ~4/6", width: 56 })
    const line = bandRowText(row)
    expect(line.endsWith("PR ~4/6")).toBe(true)
    for (const gone of ["/dag", "预算", "tok", "并发", "+2 个", "等待主"]) expect(line).not.toContain(gone)
  })

  test("never claims more cells than it has, however narrow the row", () => {
    for (const aw of AMBIGUOUS_WIDTHS) {
      for (const mode of [undefined, "on"] as const) {
        for (let width = 2; width <= 100; width++) {
          const row = layoutDagRow({ ...FULL, mode, pr: "PR ~#1036 +1", width, ambiguousWidth: aw })
          expect(measured(row, aw), `${mode} at ${width} (aw ${aw})`).toBe(row.cells)
          expect(row.cells, `${mode} at ${width} (aw ${aw})`).toBeLessThanOrEqual(width)
        }
      }
    }
  })
})

describe("the reminder row", () => {
  test("says how long is left, and what for", () => {
    const row = layoutReminderRow({ when: "5m", text: "部署完成后检查", due: false }, 76)
    expect(row.spans).toEqual([{ text: "提醒 · 5m后 · 部署完成后检查", token: "textMuted" }])
    expect(bandRowText(layoutReminderRow({ when: "1h 5m", text: "ship it", due: false }, 76))).toBe(
      "提醒 · 1h 5m后 · ship it",
    )
    setLanguage("en")
    expect(bandRowText(layoutReminderRow({ when: "5m", text: "deploy", due: false }, 76))).toBe(
      "reminder · in 5m · deploy",
    )
  })

  test("says it is due, in the warning color, once it fired", () => {
    const row = layoutReminderRow({ when: undefined, text: "部署", due: true }, 76)
    expect(row.spans).toEqual([{ text: "提醒 · 已到期 · 部署", token: "warning" }])
    setLanguage("en")
    expect(bandRowText(layoutReminderRow({ when: undefined, text: "deploy", due: true }, 76))).toBe(
      "reminder · due · deploy",
    )
  })

  test("reads under a minute as <1m when the tracker gave no time but the reminder has not fired", () => {
    expect(bandRowText(layoutReminderRow({ when: undefined, text: "ship", due: false }, 76))).toBe(
      "提醒 · <1m后 · ship",
    )
  })

  test("cuts its own text first, and then the head", () => {
    const long = { when: "1h 5m", text: "x".repeat(80), due: false }
    expect(bandRowText(layoutReminderRow(long, 30))).toBe("提醒 · 1h 5m后 · xxxxxxxxxxxx…")
    expect(bandRowText(layoutReminderRow(long, 12))).toBe("提醒 · 1h 5…")
    expect(layoutReminderRow(long, 0)).toEqual({ spans: [], cells: 0 })
  })

  test("draws the text as one line without escapes or control characters", () => {
    const row = layoutReminderRow({ when: "5m", text: "a\u001b[31mred\u001b[0m\nline\u0007two", due: false }, 76)
    // The escapes go, the line break becomes a space, and the bell is dropped.
    expect(bandRowText(row)).toBe("提醒 · 5m后 · ared linetwo")
    expect(bandRowText(row)).not.toMatch(/[\u0000-\u001f]/)
  })

  for (const language of LANGUAGES) {
    for (const aw of AMBIGUOUS_WIDTHS) {
      test(`never claims more cells than it has or than it uses, in ${language} at ambiguous width ${aw}`, () => {
        setLanguage(language)
        const reminders: ReminderBandItem[] = [
          { when: "5m", text: "部署完成后检查 the deploy", due: false },
          { when: "2d 3h", text: "x".repeat(200), due: false },
          { when: undefined, text: "全部依赖升到最新稳定版并通过 CI", due: true },
          { when: "<1m", text: "", due: false },
        ]
        for (const reminder of reminders) {
          for (let width = 0; width <= 140; width++) {
            const row = layoutReminderRow(reminder, width, aw)
            expect(measured(row, aw), `${reminder.text} at ${width}`).toBe(row.cells)
            expect(row.cells, `${reminder.text} at ${width}`).toBeLessThanOrEqual(width)
          }
        }
      })
    }
  }
})

describe("the page a click on the PR row opens", () => {
  test("is the first PR's: the warning one when there is one, else the list's first", () => {
    const warned = unresponsive({ number: 1040, url: "https://example.test/acme/repo/pull/1040" })
    const quiet = ci({ number: 1036, url: "https://example.test/acme/repo/pull/1036" })
    expect(prOpenUrl([quiet])).toBe("https://example.test/acme/repo/pull/1036")
    // The tracker lists warnings first; the band takes the first it is given.
    expect(prOpenUrl([warned, quiet])).toBe("https://example.test/acme/repo/pull/1040")
  })

  test("is nothing for no PR, and nothing that is not a web address", () => {
    expect(prOpenUrl([])).toBeUndefined()
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "-a/Applications/Calculator", "", "example.test"]) {
      expect(prOpenUrl([ci({ url })]), url).toBeUndefined()
    }
    expect(prOpenUrl([ci({ url: "HTTP://example.test/pr/1" })])).toBe("HTTP://example.test/pr/1")
  })

  test("skips a PR whose state is hidden", () => {
    const hidden = item({ phase: "cancelled", outcome: undefined, url: "https://example.test/acme/repo/pull/9" })
    expect(prOpenUrl([hidden, ci({ url: "https://example.test/acme/repo/pull/1036" })])).toBe(
      "https://example.test/acme/repo/pull/1036",
    )
    expect(prOpenUrl([hidden])).toBeUndefined()
  })
})

describe("which rows the band draws", () => {
  const row = (text: string): BandRow => ({ spans: [{ text, token: "text" }], cells: text.length })
  const trust = row("trust")
  const dag = row("dag")
  const goal = row("goal")
  const reminder = row("reminder")
  const quiet = { row: row("pr"), warning: false }
  const warned = { row: row("pr!"), warning: true }

  /** What the band draws, as `kind:text` top to bottom. */
  const draws = (candidates: BandCandidates, narrow = false) =>
    chooseBandRows(candidates, narrow).map((choice) => `${choice.kind}:${bandRowText(choice.row)}`)

  test("draws nothing, and takes no line for what has nothing to draw", () => {
    expect(draws({})).toEqual([])
    const blank: BandRow = { spans: [], cells: 0 }
    expect(draws({ pr: { row: blank, warning: true }, dag: blank, goal: blank, reminder: blank })).toEqual([])
    expect(draws({ dag: blank, goal })).toEqual(["goal:goal"])
  })

  test("keeps the workflow and the goal as before: both from the narrow limit, the workflow alone below it", () => {
    expect(draws({ dag, goal })).toEqual(["dag:dag", "goal:goal"])
    expect(draws({ dag, goal }, true)).toEqual(["dag:dag"])
    expect(draws({ goal }, true)).toEqual(["goal:goal"])
    expect(draws({ dag })).toEqual(["dag:dag"])
  })

  test("puts a quiet PR at the workflow row's tail, so it has no row while there is a workflow row", () => {
    expect(draws({ pr: quiet, dag })).toEqual(["dag:dag"])
    expect(draws({ pr: quiet, dag, goal })).toEqual(["dag:dag", "goal:goal"])
    expect(draws({ pr: quiet, dag, goal }, true)).toEqual(["dag:dag"])
  })

  test("gives a quiet PR a row of its own when there is no workflow row, ahead of the goal", () => {
    expect(draws({ pr: quiet })).toEqual(["pr:pr"])
    expect(draws({ pr: quiet, goal })).toEqual(["pr:pr", "goal:goal"])
    expect(draws({ pr: quiet, goal }, true)).toEqual(["pr:pr"])
    // A workflow row that could not be drawn is no workflow row.
    expect(draws({ pr: quiet, dag: { spans: [], cells: 0 } })).toEqual(["pr:pr"])
  })

  test("gives a PR warning the first row, over the workflow row, and pushes the goal out (it stays in the drawer)", () => {
    expect(draws({ pr: warned, dag })).toEqual(["pr:pr!", "dag:dag"])
    expect(draws({ pr: warned, dag, goal })).toEqual(["pr:pr!", "dag:dag"])
    expect(draws({ pr: warned, dag, goal, reminder })).toEqual(["pr:pr!", "dag:dag"])
    expect(draws({ pr: warned, goal })).toEqual(["pr:pr!", "goal:goal"])
    expect(draws({ pr: warned })).toEqual(["pr:pr!"])
  })

  test("keeps only the highest row on a narrow terminal: trust, PR warning, workflow, PR, goal, reminder", () => {
    expect(draws({ trust, pr: warned, dag, goal, reminder }, true)).toEqual(["trust:trust"])
    expect(draws({ pr: warned, dag, goal, reminder }, true)).toEqual(["pr:pr!"])
    expect(draws({ pr: quiet, dag, goal, reminder }, true)).toEqual(["dag:dag"])
    expect(draws({ pr: quiet, goal, reminder }, true)).toEqual(["pr:pr"])
    expect(draws({ goal, reminder }, true)).toEqual(["goal:goal"])
    expect(draws({ reminder }, true)).toEqual(["reminder:reminder"])
  })

  test("gives the trust warning the first row, ahead of a PR warning and the workflow, and pushes the goal out", () => {
    expect(draws({ trust })).toEqual(["trust:trust"])
    expect(draws({ trust, pr: warned, dag, goal, reminder })).toEqual(["trust:trust", "pr:pr!"])
    expect(draws({ trust, dag, goal, reminder })).toEqual(["trust:trust", "dag:dag"])
    expect(draws({ trust, pr: warned, goal })).toEqual(["trust:trust", "pr:pr!"])
    // A quiet PR still has a row of its own only without a workflow row, and then it is the second.
    expect(draws({ trust, pr: quiet, dag })).toEqual(["trust:trust", "dag:dag"])
    expect(draws({ trust, pr: quiet, goal })).toEqual(["trust:trust", "pr:pr"])
    // The goal and the reminder are what is left for the second row when nothing ranks between them and the trust row.
    expect(draws({ trust, goal, reminder })).toEqual(["trust:trust", "goal:goal"])
    expect(draws({ trust, reminder })).toEqual(["trust:trust", "reminder:reminder"])
  })

  test("takes no line for a trust row with nothing to draw, and changes nothing else about the choice", () => {
    const blank: BandRow = { spans: [], cells: 0 }
    expect(draws({ trust: blank, dag, goal })).toEqual(["dag:dag", "goal:goal"])
    expect(draws({ trust: blank, pr: warned, dag }, true)).toEqual(["pr:pr!"])
    // The same candidates without the trust row are the choice that was made before it.
    expect(draws({ pr: warned, dag, goal, reminder })).toEqual(["pr:pr!", "dag:dag"])
  })

  test("draws the reminder only when there is room: below the rows that rank above it", () => {
    expect(draws({ reminder })).toEqual(["reminder:reminder"])
    expect(draws({ goal, reminder })).toEqual(["goal:goal", "reminder:reminder"])
    expect(draws({ dag, reminder })).toEqual(["dag:dag", "reminder:reminder"])
    expect(draws({ pr: quiet, reminder })).toEqual(["pr:pr", "reminder:reminder"])
    expect(draws({ dag, goal, reminder })).toEqual(["dag:dag", "goal:goal"])
    expect(draws({ pr: quiet, goal, reminder })).toEqual(["pr:pr", "goal:goal"])
  })

  test(`draws ${BAND_ROWS_MAX} rows at most, whatever is given`, () => {
    const kinds = new Set<BandRowKind>()
    for (const tr of [undefined, trust]) {
      for (const pr of [undefined, quiet, warned]) {
        for (const d of [undefined, dag]) {
          for (const g of [undefined, goal]) {
            for (const r of [undefined, reminder]) {
              for (const narrow of [false, true]) {
                const chosen = chooseBandRows({ trust: tr, pr, dag: d, goal: g, reminder: r }, narrow)
                expect(chosen.length).toBeLessThanOrEqual(narrow ? 1 : BAND_ROWS_MAX)
                // The trust row, when there is one, is the first row: nothing ranks above it.
                if (tr) expect(chosen[0].kind).toBe("trust")
                for (const choice of chosen) kinds.add(choice.kind)
              }
            }
          }
        }
      }
    }
    expect(kinds).toEqual(new Set<BandRowKind>(["trust", "pr", "dag", "goal", "reminder"]))
  })
})

describe("the background mark on the PR and reminder rows", () => {
  const MARK = "◇ 后台 2"

  test("goes flush right on a PR row that has room, as a piece of its own", () => {
    const plain = layoutPrRow([ci()], 76)
    const row = layoutPrRow([ci()], 76, 1, MARK)
    expect(bandRowText(row)).toBe(
      `PR #1035  CI 4/6${" ".repeat(76 - cellWidth("PR #1035  CI 4/6") - cellWidth(MARK))}${MARK}`,
    )
    expect(row.cells).toBe(76)
    expect(row.spans.slice(0, plain.spans.length)).toEqual([...plain.spans])
    expect(row.spans.at(-1)).toEqual({ text: MARK, token: "textMuted", action: "agents" })
  })

  test("leaves the PR row as it was when it has no room: the PR keeps every cell", () => {
    const warned = layoutPrRow([unresponsive({ number: 1040 })], 40)
    expect(layoutPrRow([unresponsive({ number: 1040 })], 40, 1, MARK)).toEqual(warned)
    const several = [unresponsive({ number: 1040 }), ci({ number: 1036 }), working({ number: 1035 })]
    for (const width of [10, 20, 30]) expect(layoutPrRow(several, width, 1, MARK)).toEqual(layoutPrRow(several, width))
  })

  test("goes flush right on the reminder row, and leaves a full one alone", () => {
    const reminder = { when: "5m", text: "部署完成后检查", due: false }
    const row = layoutReminderRow(reminder, 60, 1, MARK)
    expect(bandRowText(row).startsWith("提醒 · 5m后 · 部署完成后检查")).toBe(true)
    expect(bandRowText(row).endsWith(MARK)).toBe(true)
    expect(row.cells).toBe(60)
    expect(row.spans.at(-1)?.action).toBe("agents")
    // The text is cut to the room: a row that fills it has none left for the mark.
    const long = { when: "5m", text: "部署".repeat(60), due: false }
    expect(layoutReminderRow(long, 60, 1, MARK)).toEqual(layoutReminderRow(long, 60))
  })

  for (const language of LANGUAGES) {
    for (const aw of AMBIGUOUS_WIDTHS) {
      test(`stay inside their width with the mark, 0 to 120, in ${language} at ambiguous width ${aw}`, () => {
        setLanguage(language)
        const mark = language === "en" ? "◇ bg 3·q1" : "◇ 后台 3·排1"
        const several = [unresponsive({ number: 1040 }), ci({ number: 1036 }), working({ number: 1035 })]
        for (let width = 0; width <= 120; width++) {
          for (const row of [
            layoutPrRow([ci()], width, aw, mark),
            layoutPrRow([working()], width, aw, mark),
            layoutPrRow(several, width, aw, mark),
            layoutReminderRow({ when: "5m", text: "部署完成后检查", due: false }, width, aw, mark),
            layoutReminderRow({ when: undefined, text: "deploy", due: true }, width, aw, mark),
          ]) {
            expect(row.cells, `width ${width}`).toBeLessThanOrEqual(width)
            expect(measured(row, aw), `width ${width}`).toBe(row.cells)
          }
        }
      })
    }
  }
})

describe("where the background runs go on the band", () => {
  const row = (text: string): BandRow => ({ spans: [{ text, token: "text" }], cells: text.length })
  const trust = row("trust")
  const dag = row("dag")
  const goal = row("goal")
  const reminder = row("reminder")
  const quiet = { row: row("pr"), warning: false }
  const warned = { row: row("pr!"), warning: true }

  /** The runs' part of the candidates, and a record of what the band was asked for. */
  function runs() {
    const asked = { marked: [] as string[], own: 0 }
    const background = {
      marked: (kind: MarkedRowKind) => {
        asked.marked.push(kind)
        return row(`${kind}◇`)
      },
      own: () => {
        asked.own++
        return row("own")
      },
    }
    return { asked, background }
  }

  /** What the band draws, as `kind:text` top to bottom. */
  const draws = (candidates: BandCandidates, narrow = false) =>
    chooseBandRows(candidates, narrow).map((choice) => `${choice.kind}:${bandRowText(choice.row)}`)

  test("rides at the tail of the first row drawn, and changes nothing else about the choice", () => {
    const { background } = runs()
    expect(draws({ dag, goal, background })).toEqual(["dag:dag◇", "goal:goal"])
    expect(draws({ pr: quiet, dag, goal, background })).toEqual(["dag:dag◇", "goal:goal"])
    expect(draws({ pr: quiet, goal, background })).toEqual(["pr:pr◇", "goal:goal"])
    expect(draws({ goal, reminder, background })).toEqual(["goal:goal◇", "reminder:reminder"])
    expect(draws({ reminder, background })).toEqual(["reminder:reminder◇"])
    // The same candidates without the runs are the choice that was made before them.
    expect(draws({ dag, goal })).toEqual(["dag:dag", "goal:goal"])
  })

  test("skips a PR warning: the row under it takes the mark", () => {
    const { background } = runs()
    expect(draws({ pr: warned, dag, background })).toEqual(["pr:pr!", "dag:dag◇"])
    expect(draws({ pr: warned, dag, goal, background })).toEqual(["pr:pr!", "dag:dag◇"])
    expect(draws({ pr: warned, goal, background })).toEqual(["pr:pr!", "goal:goal◇"])
    expect(draws({ pr: warned, reminder, background })).toEqual(["pr:pr!", "reminder:reminder◇"])
  })

  test("skips the trust row: the row under it takes the mark", () => {
    const { background } = runs()
    expect(draws({ trust, dag, background })).toEqual(["trust:trust", "dag:dag◇"])
    expect(draws({ trust, dag, goal, background })).toEqual(["trust:trust", "dag:dag◇"])
    expect(draws({ trust, pr: quiet, background })).toEqual(["trust:trust", "pr:pr◇"])
    expect(draws({ trust, goal, background })).toEqual(["trust:trust", "goal:goal◇"])
    expect(draws({ trust, reminder, background })).toEqual(["trust:trust", "reminder:reminder◇"])
    // Under a PR warning too, the trust row first and the warning second: neither takes it.
    expect(draws({ trust, pr: warned, dag, background })).toEqual(["trust:trust", "pr:pr!"])
    // A workflow row at the alert band of its budget is a warning row as well.
    expect(draws({ trust, dag, dagAlert: true, goal, background })).toEqual(["trust:trust", "dag:dag"])
  })

  test("skips a workflow row at the alert band of its budget: the row under it takes the mark", () => {
    const { background } = runs()
    expect(draws({ dag, dagAlert: true, goal, background })).toEqual(["dag:dag", "goal:goal◇"])
    expect(draws({ dag, dagAlert: true, reminder, background })).toEqual(["dag:dag", "reminder:reminder◇"])
    // An alert that is not about the workflow row on screen does not matter.
    expect(draws({ goal, dagAlert: true, background })).toEqual(["goal:goal◇"])
    expect(draws({ dag, dagAlert: false, background })).toEqual(["dag:dag◇"])
  })

  test("is nowhere when every row drawn is a warning row, and the runs have no row of their own then", () => {
    const { asked, background } = runs()
    expect(draws({ pr: warned, background })).toEqual(["pr:pr!"])
    expect(draws({ dag, dagAlert: true, background })).toEqual(["dag:dag"])
    expect(draws({ pr: warned, dag, dagAlert: true, background })).toEqual(["pr:pr!", "dag:dag"])
    // The trust row is a warning row: alone, it neither takes the mark nor leaves the runs a row beside it.
    expect(draws({ trust, background })).toEqual(["trust:trust"])
    expect(draws({ trust, pr: warned, background })).toEqual(["trust:trust", "pr:pr!"])
    expect(asked).toEqual({ marked: [], own: 0 })
  })

  test("has a row of its own only when no other row is drawn", () => {
    const { asked, background } = runs()
    expect(draws({ background })).toEqual(["background:own"])
    const blank: BandRow = { spans: [], cells: 0 }
    expect(draws({ pr: { row: blank, warning: false }, dag: blank, goal: blank, reminder: blank, background })).toEqual(
      ["background:own"],
    )
    expect(asked.own).toBe(2)
    expect(draws({ goal, background })).toEqual(["goal:goal◇"])
    expect(asked.own).toBe(2)
  })

  test("has neither the mark nor the row below the narrow limit, and asks for neither", () => {
    const { asked, background } = runs()
    expect(draws({ dag, goal, background }, true)).toEqual(["dag:dag"])
    expect(draws({ goal, reminder, background }, true)).toEqual(["goal:goal"])
    expect(draws({ background }, true)).toEqual([])
    expect(draws({ pr: warned, dag, background }, true)).toEqual(["pr:pr!"])
    expect(draws({ trust, dag, goal, background }, true)).toEqual(["trust:trust"])
    expect(asked).toEqual({ marked: [], own: 0 })
  })

  test("asks for the marked layout of the one row that takes it, once, and for the own row only when it is drawn", () => {
    const { asked, background } = runs()
    draws({ pr: warned, dag, goal, background })
    expect(asked).toEqual({ marked: ["dag"], own: 0 })
    draws({ background })
    expect(asked).toEqual({ marked: ["dag"], own: 1 })
  })

  test("leaves a row as it was when the mark did not fit it, or came back empty", () => {
    const unchanged = { marked: () => undefined, own: () => row("own") }
    expect(draws({ dag, goal, background: unchanged })).toEqual(["dag:dag", "goal:goal"])
    const emptied = { marked: () => ({ spans: [], cells: 0 }), own: () => ({ spans: [], cells: 0 }) }
    expect(draws({ dag, background: emptied })).toEqual(["dag:dag"])
    expect(draws({ background: emptied })).toEqual([])
  })

  test("never draws more than the rows the band has, whatever is given", () => {
    const { asked, background } = runs()
    for (const tr of [undefined, trust]) {
      for (const pr of [undefined, quiet, warned]) {
        for (const d of [undefined, dag]) {
          for (const dagAlert of [false, true]) {
            for (const g of [undefined, goal]) {
              for (const r of [undefined, reminder]) {
                for (const narrow of [false, true]) {
                  const chosen = chooseBandRows(
                    { trust: tr, pr, dag: d, dagAlert, goal: g, reminder: r, background },
                    narrow,
                  )
                  expect(chosen.length).toBeLessThanOrEqual(narrow ? 1 : BAND_ROWS_MAX)
                  // The row of the runs is never drawn beside another.
                  if (chosen.some((choice) => choice.kind === "background")) expect(chosen).toHaveLength(1)
                }
              }
            }
          }
        }
      }
    }
    // The trust row has no layout with the mark: it was never asked for one.
    expect(asked.marked).not.toContain("trust")
  })
})
