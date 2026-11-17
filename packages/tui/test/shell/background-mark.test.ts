// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { TaskIndexEntry } from "../../src/context/session-summary"
import { setLanguage } from "../../src/i18n"
import { backgroundItems } from "../../src/session/background"
import {
  BACKGROUND_COUNT_MAX,
  BAND_RUNS_LISTED,
  backgroundBand,
  backgroundLabel,
  backgroundMark,
  backgroundMarkBudget,
  layoutBackgroundRow,
  sameBackgroundBand,
  withBackgroundMark,
  type BackgroundBand,
  type BackgroundLabel,
} from "../../src/shell/background-mark"
import { bandRowText, type BandRow } from "../../src/shell/status-band"
import { cellWidth, type AmbiguousWidth } from "../../src/ui/width"

// The background runs on the band as pure layout (#1058 4): the mark's text and its budget, which runs are counted,
// and the row of their own. No clocks: the band shows no time.

const LANGUAGES = ["zh-CN", "en"] as const
const AMBIGUOUS_WIDTHS: readonly AmbiguousWidth[] = [1, 2]

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

describe("the mark", () => {
  test("says how many runs are going, and how many of them wait, in both languages", () => {
    expect(backgroundMark({ total: 3, queued: 0 })).toBe("◇ 后台 3")
    expect(backgroundMark({ total: 3, queued: 1 })).toBe("◇ 后台 3·排1")
    setLanguage("en")
    expect(backgroundMark({ total: 3, queued: 0 })).toBe("◇ bg 3")
    expect(backgroundMark({ total: 3, queued: 1 })).toBe("◇ bg 3·q1")
  })

  test("is empty while no run is going", () => {
    expect(backgroundMark({ total: 0, queued: 0 })).toBe("")
    expect(backgroundMark({ total: Number.NaN, queued: 0 })).toBe("")
    expect(backgroundMark({ total: -2, queued: 0 })).toBe("")
  })

  test(`caps each number at ${BACKGROUND_COUNT_MAX}`, () => {
    setLanguage("en")
    expect(backgroundMark({ total: 250, queued: 0 })).toBe("◇ bg 99")
    expect(backgroundMark({ total: 250, queued: 180 })).toBe("◇ bg 99·q99")
    // A queued count cannot exceed the total it is part of.
    expect(backgroundMark({ total: 4, queued: 9 })).toBe("◇ bg 4·q4")
  })

  test("has a budget of 12 cells, 14 at ambiguous width 2", () => {
    expect(backgroundMarkBudget(1)).toBe(12)
    expect(backgroundMarkBudget(2)).toBe(14)
  })

  for (const language of LANGUAGES) {
    for (const aw of AMBIGUOUS_WIDTHS) {
      test(`stays inside its budget at every count, in ${language} at ambiguous width ${aw}`, () => {
        setLanguage(language)
        for (const total of [1, 2, 9, 10, 12, 98, 99, 100, 5000]) {
          for (const queued of [0, 1, 3, 9, 10, 99, 5000]) {
            const mark = backgroundMark({ total, queued }, aw)
            expect(cellWidth(mark, aw), `${total}/${queued}: ${mark}`).toBeLessThanOrEqual(backgroundMarkBudget(aw))
          }
        }
        // The widest the plain mark gets, and the widest queued form there is.
        expect(cellWidth(backgroundMark({ total: 99, queued: 0 }, aw), aw)).toBeLessThanOrEqual(
          backgroundMarkBudget(aw),
        )
        expect(cellWidth(backgroundMark({ total: 99, queued: 99 }, aw), aw)).toBeLessThanOrEqual(
          backgroundMarkBudget(aw),
        )
      })
    }
  }

  test("writes the queued form while it fits and the plain mark when it would not: zh at two digits", () => {
    // `◇ 后台 9·排3` is 12 cells; with a second digit in the total it is 13.
    expect(backgroundMark({ total: 9, queued: 3 }, 1)).toBe("◇ 后台 9·排3")
    expect(backgroundMark({ total: 10, queued: 3 }, 1)).toBe("◇ 后台 10")
    // At ambiguous width 2 the glyphs take two cells each, and the budget two more: the same split.
    expect(backgroundMark({ total: 9, queued: 3 }, 2)).toBe("◇ 后台 9·排3")
    expect(backgroundMark({ total: 10, queued: 3 }, 2)).toBe("◇ 后台 10")
    // English is shorter and keeps the queued form to the cap.
    setLanguage("en")
    expect(backgroundMark({ total: 99, queued: 99 }, 2)).toBe("◇ bg 99·q99")
  })
})

describe("which runs are counted", () => {
  const ROOT = "ses_root"
  const entry = (extra: Partial<TaskIndexEntry> = {}): TaskIndexEntry => ({
    parentSessionID: ROOT,
    parentMessageID: "msg",
    partID: "prt",
    kind: "explore",
    description: "Scan",
    background: true,
    startedAt: 1_000,
    ...extra,
  })

  /** One run of each kind the data layer can hold, and what each owner says of it. */
  const taskIndex: Record<string, TaskIndexEntry> = {
    runningOld: entry({ description: "Old run", startedAt: 1_000 }),
    runningNew: entry({ description: "New run", startedAt: 5_000 }),
    waiting: entry({ description: "Waiting run", startedAt: 3_000 }),
    finished: entry({
      description: "Finished",
      result: { status: "completed", title: "Finished", startedAt: 1, endedAt: 2, messageID: "m", partID: "p" },
    }),
    lost: entry({ description: "Nothing says" }),
    foreground: entry({ description: "Foreground", background: false }),
    elsewhere: entry({ description: "Another root's", parentSessionID: "ses_other" }),
    deeper: entry({ description: "A grandchild's", parentSessionID: "ses_child" }),
  }
  const jobs: Record<string, { value: string }> = {
    runningOld: { value: "running" },
    runningNew: { value: "running" },
    waiting: { value: "running" },
    foreground: { value: "running" },
    elsewhere: { value: "running" },
    deeper: { value: "running" },
  }
  const summaries: Record<string, { status: "busy" | "idle" | "retry" | "unknown"; toolCalls?: number }> = {
    runningOld: { status: "busy", toolCalls: 4 },
    runningNew: { status: "busy", toolCalls: 1 },
    foreground: { status: "busy" },
  }
  const items = () =>
    backgroundItems({
      taskIndex,
      rootID: ROOT,
      job: (id) => jobs[id],
      summary: (id) => summaries[id],
    })

  test("counts the running and the queued runs the root started, and nothing else", () => {
    const band = backgroundBand(items(), () => undefined)
    expect(band?.total).toBe(3)
    expect(band?.queued).toBe(1)
  })

  test("lists the running runs first, newest start first, then the queued ones", () => {
    const band = backgroundBand(items(), () => undefined)
    expect(band?.labels.map((label) => label.description)).toEqual(["New run", "Old run"].slice(0, BAND_RUNS_LISTED))
    const all = backgroundBand(items(), () => undefined)
    expect(all?.total).toBe(3)
  })

  test("counts nothing for finished, unknown, foreground and other sessions' runs, and has no band at all", () => {
    const quiet = backgroundItems({
      taskIndex: {
        finished: taskIndex.finished,
        lost: taskIndex.lost,
        foreground: taskIndex.foreground,
        elsewhere: taskIndex.elsewhere,
        deeper: taskIndex.deeper,
      },
      rootID: ROOT,
      job: (id) => jobs[id],
      summary: (id) => summaries[id],
    })
    expect(backgroundBand(quiet, () => undefined)).toBeUndefined()
  })

  test("a run that ended by its job's state stops counting", () => {
    const ended = backgroundItems({
      taskIndex,
      rootID: ROOT,
      job: (id) => (id === "runningNew" ? { value: "completed" } : jobs[id]),
      summary: (id) => summaries[id],
    })
    expect(backgroundBand(ended, () => undefined)?.total).toBe(2)
  })

  test("has the band equal itself while a run only reports progress, and differ when a count or a name moves", () => {
    const base = backgroundBand(items(), () => undefined)
    const again = backgroundBand(items(), () => undefined)
    expect(sameBackgroundBand(base, again)).toBe(true)
    const named = backgroundBand(items(), () => ({ title: "x", agent: "review" }))
    expect(sameBackgroundBand(base, named)).toBe(false)
    expect(sameBackgroundBand(base, undefined)).toBe(false)
    expect(sameBackgroundBand(undefined, undefined)).toBe(true)
    const fewer = backgroundBand({ running: items().running.slice(0, 1), queued: [] }, () => undefined)
    expect(sameBackgroundBand(base, fewer)).toBe(false)
  })
})

describe("how a run is named", () => {
  const link = (extra: Partial<TaskIndexEntry> = {}) => ({
    entry: {
      parentSessionID: "ses_root",
      parentMessageID: "msg",
      partID: "prt",
      ...extra,
    } satisfies TaskIndexEntry,
  })

  test("reads the child session's agent and the Task description, as /agents does", () => {
    expect(
      backgroundLabel(link({ kind: "explore", description: "Scan deps" }), { title: "t", agent: "review" }),
    ).toEqual({
      kind: "review",
      description: "Scan deps",
    })
  })

  test("reads the Task link alone before the session is known, and says `agent` when nothing names it", () => {
    expect(backgroundLabel(link({ kind: "explore", description: "Scan deps" }))).toEqual({
      kind: "explore",
      description: "Scan deps",
    })
    expect(backgroundLabel(link())).toEqual({ kind: "agent", description: "" })
  })

  test("strips escapes and line breaks from what the model wrote", () => {
    const label = backgroundLabel(link({ kind: "ex\u001b[31mplore", description: "Scan\n  the\u0007 deps\u001b[0m" }))
    expect(label).toEqual({ kind: "explore", description: "Scan the deps" })
  })
})

describe("the mark at the edge of a row", () => {
  const row = (text: string): BandRow => ({ spans: [{ text, token: "text" }], cells: cellWidth(text) })

  test("goes flush right, with room to spare, and is a piece of its own", () => {
    const marked = withBackgroundMark(row("abc"), "◇ bg 2", 20)
    expect(marked.cells).toBe(20)
    expect(bandRowText(marked)).toBe("abc" + " ".repeat(11) + "◇ bg 2")
    expect(marked.spans.at(-1)).toEqual({ text: "◇ bg 2", token: "textMuted", action: "agents" })
    expect(marked.spans.slice(0, -1).some((span) => span.action !== undefined)).toBe(false)
  })

  test("keeps two cells off what the row says, and leaves the row as it was when it has less", () => {
    const tight = row("abcdef")
    // 6 + 2 + 6 = 14 fits exactly; one cell less does not.
    expect(withBackgroundMark(tight, "◇ bg 2", 14).cells).toBe(14)
    expect(withBackgroundMark(tight, "◇ bg 2", 13)).toBe(tight)
  })

  test("leaves a row without text, and a call without a mark, alone", () => {
    const empty: BandRow = { spans: [], cells: 0 }
    expect(withBackgroundMark(empty, "◇ bg 2", 20)).toBe(empty)
    const plain = row("abc")
    expect(withBackgroundMark(plain, undefined, 20)).toBe(plain)
    expect(withBackgroundMark(plain, "", 20)).toBe(plain)
  })

  test("counts the width at ambiguous width 2, where `◇` takes two cells", () => {
    const plain = row("abcdef")
    // `◇ bg 2` is 6 cells at width 1 and 7 at width 2.
    expect(withBackgroundMark(plain, "◇ bg 2", 14, 1).cells).toBe(14)
    expect(withBackgroundMark(plain, "◇ bg 2", 14, 2)).toBe(plain)
    expect(withBackgroundMark(plain, "◇ bg 2", 15, 2).cells).toBe(15)
  })
})

describe("the row of the runs alone", () => {
  const label = (kind: string, description: string): BackgroundLabel => ({ kind, description })
  const band = (total: number, queued: number, ...labels: BackgroundLabel[]): BackgroundBand => ({
    total,
    queued,
    labels,
  })
  const THREE = band(3, 1, label("review", "未提交改动"), label("explore", "扫描依赖"))
  const measured = (row: BandRow, aw: AmbiguousWidth) => cellWidth(bandRowText(row), aw)

  test("names two runs and counts the rest in +k, with the hint at the right edge", () => {
    const row = layoutBackgroundRow({ band: THREE, width: 116 })
    const line = bandRowText(row)
    expect(line.startsWith("◇ 后台 3 · review 未提交改动 · explore 扫描依赖 · +1")).toBe(true)
    expect(line.endsWith("/agents")).toBe(true)
    expect(row.cells).toBe(116)
    expect(measured(row, 1)).toBe(116)
  })

  test("says the same in English", () => {
    setLanguage("en")
    const row = layoutBackgroundRow({
      band: band(2, 0, label("review", "uncommitted changes"), label("explore", "scan dependencies")),
      width: 116,
    })
    const line = bandRowText(row)
    expect(line.startsWith("◇ bg 2 · review uncommitted changes · explore scan dependencies")).toBe(true)
    // Both runs are named, so there is nothing left to count.
    expect(line).not.toContain("+")
    expect(line.endsWith("/agents")).toBe(true)
  })

  test("names one run alone without +k, and writes a run without a description as its type", () => {
    const one = bandRowText(layoutBackgroundRow({ band: band(1, 0, label("review", "未提交改动")), width: 116 }))
    expect(one.startsWith("◇ 后台 1 · review 未提交改动")).toBe(true)
    expect(one).not.toContain("+")
    const bare = bandRowText(layoutBackgroundRow({ band: band(1, 0, label("review", "")), width: 116 }))
    expect(bare.startsWith("◇ 后台 1 · review")).toBe(true)
    expect(bare).not.toContain("review ·")
  })

  test("colors the lead and the count muted, the names plain, the separators and the hint dim: never the brand color", () => {
    const row = layoutBackgroundRow({ band: THREE, width: 116 })
    expect(row.spans[0]).toEqual({ text: "◇ ", token: "textMuted" })
    expect(row.spans[1]).toEqual({ text: "后台 3", token: "textMuted" })
    expect(row.spans.find((span) => span.text === "review 未提交改动")?.token).toBe("text")
    expect(row.spans.find((span) => span.text === " · ")?.token).toBe("textDim")
    expect(row.spans.find((span) => span.text === "+1")?.token).toBe("textMuted")
    expect(row.spans.at(-1)).toEqual({ text: "/agents", token: "textDim" })
    expect(row.spans.some((span) => span.token === "primary")).toBe(false)
    // The whole row is the click target, so no piece of it has an action of its own.
    expect(row.spans.some((span) => span.action !== undefined)).toBe(false)
  })

  test("shortens the descriptions first, the longer one first, and keeps the agent types whole", () => {
    const long = band(
      2,
      0,
      label("review", "把 changelog 里的破坏性变更逐条列出来并给出迁移建议"),
      label("explore", "扫描依赖"),
    )
    const roomy = bandRowText(layoutBackgroundRow({ band: long, width: 116 }))
    expect(roomy).toContain("review 把 changelog 里的破坏性变更逐条列出来并给出迁移建议")
    const tight = layoutBackgroundRow({ band: long, width: 60 })
    const line = bandRowText(tight)
    expect(line).toContain("review ")
    expect(line).toContain("explore 扫描依赖")
    expect(line).toContain("…")
    expect(line).not.toContain("迁移建议")
    expect(line.endsWith("/agents")).toBe(true)
    expect(tight.cells).toBe(60)
  })

  test("lets go of the second run, then the first, then the hint, as the width shrinks", () => {
    for (const language of LANGUAGES) {
      for (const aw of AMBIGUOUS_WIDTHS) {
        setLanguage(language)
        const runs = band(3, 0, label("review", "未提交改动的审阅"), label("explore", "扫描依赖并列出过期的包"))
        let previous = { runs: 2, hint: true }
        for (let width = 160; width >= 0; width--) {
          const row = layoutBackgroundRow({ band: runs, width, ambiguousWidth: aw })
          const line = bandRowText(row)
          const named = ["review", "explore"].filter((kind) => line.includes(kind)).length
          const state = { runs: named, hint: line.includes("/agents") }
          expect(state.runs, `${language} aw ${aw} width ${width}`).toBeLessThanOrEqual(previous.runs)
          // The hint goes only once no run is named.
          if (previous.hint && !state.hint) expect(state.runs).toBe(0)
          // A run that is dropped from the list is still counted.
          if (named > 0 && named < 2) expect(line).toContain("+")
          // Once the hint is gone it stays gone.
          if (!previous.hint) expect(state.hint).toBe(false)
          previous = state
        }
      }
    }
  })

  for (const language of LANGUAGES) {
    for (const aw of AMBIGUOUS_WIDTHS) {
      test(`never claims more cells than it has, 0 to 160, in ${language} at ambiguous width ${aw}`, () => {
        setLanguage(language)
        const shapes = [
          band(1, 0, label("review", "")),
          band(1, 0, label("a-very-long-agent-type-name-from-config", "短")),
          band(2, 1, label("review", "未提交改动"), label("explore", "扫描依赖")),
          band(
            7,
            2,
            label("review", "Review the uncommitted changes carefully"),
            label("explore", "ス キ ャ ン 依存関係"),
          ),
          band(120, 40, label("review", "x".repeat(200)), label("explore", "y".repeat(200))),
          band(3, 0),
        ]
        for (const shape of shapes) {
          for (let width = 0; width <= 160; width++) {
            const row = layoutBackgroundRow({ band: shape, width, ambiguousWidth: aw })
            const label = `${shape.total} at ${width}`
            expect(row.cells, label).toBeLessThanOrEqual(width)
            expect(measured(row, aw), label).toBe(row.cells)
          }
        }
      })
    }
  }

  test("is no row at all without a width, and the head of the row when only the count nearly fits", () => {
    expect(layoutBackgroundRow({ band: THREE, width: 0 }).spans).toEqual([])
    expect(layoutBackgroundRow({ band: THREE, width: Number.NaN }).spans).toEqual([])
    expect(layoutBackgroundRow({ band: band(0, 0), width: 100 }).spans).toEqual([])
    // `◇ 后台 3` is 8 cells: with fewer the head is cut.
    expect(bandRowText(layoutBackgroundRow({ band: THREE, width: 5 }))).toBe("◇ 后…")
    expect(bandRowText(layoutBackgroundRow({ band: THREE, width: 8 }))).toBe("◇ 后台 3")
  })

  test("caps the count at 99, as the mark does", () => {
    const line = bandRowText(layoutBackgroundRow({ band: band(400, 0, label("review", "x")), width: 116 }))
    expect(line.startsWith("◇ 后台 99 · review x · +99")).toBe(true)
  })
})
