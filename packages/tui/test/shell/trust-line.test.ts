// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ProjectTrustEntry } from "@graphagent/sdk"
import { setLanguage } from "../../src/i18n"
import { bandRowText, type BandRow } from "../../src/shell/status-band"
import { layoutTrustRow, trustChangeCount } from "../../src/shell/trust-line"
import { cellWidth, type AmbiguousWidth } from "../../src/ui/width"

// The project-trust row of the status band (#1618) as pure layout: a count goes in, a row of colored spans comes out.
// No clock, no request, no store: every width is an argument.

const AMBIGUOUS_WIDTHS: readonly AmbiguousWidth[] = [1, 2]
const LANGUAGES = ["zh-CN", "en"] as const
/** The band keeps two columns clear at either edge, so a terminal of N columns gives its rows N - 4 cells. */
const bandCells = (columns: number) => columns - 4

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

const textOf = bandRowText
const tokens = (row: BandRow) => row.spans.map((span) => span.token)
const measured = (row: BandRow, aw: AmbiguousWidth) => cellWidth(textOf(row), aw)

/** The sentence of the row, as it reads whole in `language`. */
function sentence(language: (typeof LANGUAGES)[number], count: number) {
  if (language === "zh-CN") return `项目命令有 ${count} 处变化，未确认前暂停执行`
  return `${count} project command${count === 1 ? "" : "s"} changed · paused until confirmed`
}

describe("the trust row", () => {
  test("says how many commands changed and that they are paused, with the hint at the right edge", () => {
    const row = layoutTrustRow(2, bandCells(120))
    const left = "⚠ 项目命令有 2 处变化，未确认前暂停执行"
    expect(textOf(row)).toBe(`${left}${" ".repeat(bandCells(120) - cellWidth(left, 1) - 6)}/trust`)
    expect(row.cells).toBe(bandCells(120))
    expect(row.spans.at(-1)).toEqual({ text: "/trust", token: "textDim" })
  })

  test("colors the mark and the sentence with the warning token and the hint with the dim one", () => {
    const row = layoutTrustRow(3, bandCells(120))
    const said = row.spans.filter((span) => span.text.trim() !== "")
    expect(said.map((span) => span.token)).toEqual(["warning", "warning", "textDim"])
    expect(said.map((span) => span.text)).toEqual(["⚠ ", "项目命令有 3 处变化，未确认前暂停执行", "/trust"])
    // The gap between them is only spaces.
    expect(row.spans.filter((span) => span.text.trim() === "").every((span) => /^ +$/.test(span.text))).toBe(true)
  })

  test("never uses the brand color, whatever the width", () => {
    for (const width of [1, 2, 3, 10, 40, 60, 116]) {
      for (const token of tokens(layoutTrustRow(2, width))) expect(["warning", "textDim", "textMuted"]).toContain(token)
    }
  })

  test("writes the sentence in English, singular for one command and plural for the rest", () => {
    setLanguage("en")
    const left = (count: number) => `⚠ ${sentence("en", count)}`
    expect(textOf(layoutTrustRow(1, 120)).startsWith(left(1))).toBe(true)
    expect(textOf(layoutTrustRow(1, 120)).trimEnd().endsWith("/trust")).toBe(true)
    expect(textOf(layoutTrustRow(2, 120)).startsWith(left(2))).toBe(true)
    expect(textOf(layoutTrustRow(12, 120)).startsWith(left(12))).toBe(true)
    expect(textOf(layoutTrustRow(1, 120))).toContain("1 project command changed")
    expect(textOf(layoutTrustRow(1, 120))).not.toContain("commands")
    expect(textOf(layoutTrustRow(2, 120))).toContain("2 project commands changed")
  })

  test("says the same sentence for one command and for many in Chinese, with the number in it", () => {
    expect(textOf(layoutTrustRow(1, 120)).startsWith("⚠ 项目命令有 1 处变化，未确认前暂停执行")).toBe(true)
    expect(textOf(layoutTrustRow(40, 120)).startsWith("⚠ 项目命令有 40 处变化，未确认前暂停执行")).toBe(true)
  })

  test("takes no row for no count, an unusable count, or no room", () => {
    for (const count of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(layoutTrustRow(count, 80)).toEqual({ spans: [], cells: 0 })
    }
    for (const width of [0, -1, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(layoutTrustRow(2, width)).toEqual({ spans: [], cells: 0 })
    }
  })

  test("counts whole commands: a fraction is rounded down", () => {
    expect(textOf(layoutTrustRow(2.9, 120)).startsWith("⚠ 项目命令有 2 处变化")).toBe(true)
    expect(layoutTrustRow(0.5, 120)).toEqual({ spans: [], cells: 0 })
  })
})

describe("what the trust row gives up on a narrow row", () => {
  test("gives up the hint first and keeps the whole sentence while it fits", () => {
    // The mark, a space and the sentence take 39 cells; the hint needs 8 more.
    const whole = "⚠ 项目命令有 2 处变化，未确认前暂停执行"
    expect(cellWidth(whole, 1)).toBe(39)
    expect(textOf(layoutTrustRow(2, 47))).toBe(`${whole}  /trust`)
    expect(textOf(layoutTrustRow(2, 46))).toBe(whole)
    expect(textOf(layoutTrustRow(2, 39))).toBe(whole)
  })

  test("then cuts the end of the sentence and keeps the mark", () => {
    expect(textOf(layoutTrustRow(2, 38))).toBe("⚠ 项目命令有 2 处变化，未确认前暂停执…")
    expect(textOf(layoutTrustRow(2, 12))).toBe("⚠ 项目命令…")
    expect(textOf(layoutTrustRow(2, 4))).toBe("⚠ …")
    // Not even the ellipsis has room: the mark alone.
    expect(textOf(layoutTrustRow(2, 3))).toBe("⚠ …")
    expect(textOf(layoutTrustRow(2, 2))).toBe("⚠")
    expect(textOf(layoutTrustRow(2, 1))).toBe("⚠")
  })

  test("cuts the English sentence the same way", () => {
    setLanguage("en")
    expect(textOf(layoutTrustRow(1, 40))).toBe("⚠ 1 project command changed · paused un…")
    expect(textOf(layoutTrustRow(5, 20))).toBe("⚠ 5 project command…")
  })

  test("is empty only when the mark itself has no room", () => {
    expect(layoutTrustRow(2, 0)).toEqual({ spans: [], cells: 0 })
    for (const aw of AMBIGUOUS_WIDTHS) expect(textOf(layoutTrustRow(2, 1, aw))).toBe("⚠")
  })

  test("keeps the hint at the right edge exactly when it fits two cells from the sentence", () => {
    for (const language of LANGUAGES) {
      setLanguage(language)
      for (const aw of AMBIGUOUS_WIDTHS) {
        for (const count of [1, 2, 9, 10, 99, 1000]) {
          const need = cellWidth(`⚠ ${sentence(language, count)}`, aw) + 2 + 6
          const fits = layoutTrustRow(count, need, aw)
          expect(textOf(fits).endsWith("/trust"), `${language} ${count} at ${need}`).toBe(true)
          expect(fits.cells).toBe(need)
          const tight = layoutTrustRow(count, need - 1, aw)
          expect(textOf(tight)).not.toContain("/trust")
          // The sentence is whole while the hint is the only thing missing.
          expect(textOf(tight)).toBe(`⚠ ${sentence(language, count)}`)
        }
      }
    }
  })
})

describe("the trust row at 80 and 120 columns", () => {
  for (const language of LANGUAGES) {
    for (const aw of AMBIGUOUS_WIDTHS) {
      for (const columns of [80, 120]) {
        test(`fits ${columns} columns in ${language} at ambiguous width ${aw}, hint included`, () => {
          setLanguage(language)
          for (const count of [1, 2, 9, 10, 99, 1000]) {
            const row = layoutTrustRow(count, bandCells(columns), aw)
            expect(row.cells, `${count}`).toBe(measured(row, aw))
            // Two columns of padding at either edge: the row is as wide as the band's inside, and no wider.
            expect(row.cells + 4, `${count}`).toBeLessThanOrEqual(columns)
            expect(textOf(row).startsWith(`⚠ ${sentence(language, count)}`)).toBe(true)
            expect(textOf(row).endsWith("/trust")).toBe(true)
            expect(row.cells).toBe(bandCells(columns))
          }
        })
      }
    }
  }
})

describe("the trust row never claims more cells than it has", () => {
  test("holds for every width up to 130, both languages, both ambiguous widths, one count to many", () => {
    for (const language of LANGUAGES) {
      setLanguage(language)
      for (const aw of AMBIGUOUS_WIDTHS) {
        for (const count of [1, 2, 10, 99, 12345]) {
          for (let width = 0; width <= 130; width++) {
            const row = layoutTrustRow(count, width, aw)
            const where = `${language} ${count} at ${width} (aw ${aw})`
            // The cells it reports are the cells it takes, and they fit.
            expect(row.cells, where).toBe(measured(row, aw))
            expect(row.cells, where).toBeLessThanOrEqual(width)
            // No room for the mark: nothing. Otherwise the mark always leads, and nothing is drawn after a cut.
            if (width < 1) expect(row.spans, where).toEqual([])
            else expect(textOf(row).startsWith("⚠"), where).toBe(true)
            const text = textOf(row)
            if (text.includes("/trust")) expect(text.endsWith("/trust"), where).toBe(true)
          }
        }
      }
    }
  })

  test("the visible sentence only grows as the row widens", () => {
    for (const language of LANGUAGES) {
      setLanguage(language)
      for (const aw of AMBIGUOUS_WIDTHS) {
        let kept = 0
        for (let width = 1; width <= 130; width++) {
          const row = layoutTrustRow(2, width, aw)
          const shown = textOf(row).replace(/ +\/trust$/, "")
          const cells = cellWidth(shown, aw)
          expect(cells, `${language} at ${width} (aw ${aw})`).toBeGreaterThanOrEqual(kept)
          kept = cells
        }
      }
    }
  })
})

describe("which commands the row counts", () => {
  const entry = (state: ProjectTrustEntry["state"], change?: ProjectTrustEntry["change"]) => ({ state, change })

  test("counts the pending commands that are new or changed since the last decision", () => {
    expect(trustChangeCount([entry("pending", "new"), entry("pending", "modified"), entry("pending", "new")])).toBe(3)
  })

  test("leaves out a pending command with no change, as on the first visit to a project", () => {
    expect(trustChangeCount([entry("pending"), entry("pending"), entry("pending", "modified")])).toBe(1)
    expect(trustChangeCount([entry("pending"), entry("pending")])).toBe(0)
  })

  test("leaves out the commands that are already decided, whatever they carry", () => {
    expect(
      trustChangeCount([
        entry("trusted"),
        entry("trusted", "modified"),
        entry("declined"),
        entry("declined", "new"),
        entry("pending", "new"),
      ]),
    ).toBe(1)
  })

  test("is zero without commands", () => {
    expect(trustChangeCount([])).toBe(0)
  })

  test("is zero for something that is not a list, as an answer of another shape leaves in the store", () => {
    type Entries = Parameters<typeof trustChangeCount>[0]
    // A body that is an array has a function at `.entries`: that is what the sync layer keeps as the list then.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a store slice an answer of another shape left.
    expect(trustChangeCount([].entries as unknown as Entries)).toBe(0)
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a store slice an answer of another shape left.
    expect(trustChangeCount(undefined as unknown as Entries)).toBe(0)
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a store slice an answer of another shape left.
    expect(trustChangeCount({ length: 2 } as unknown as Entries)).toBe(0)
  })
})
