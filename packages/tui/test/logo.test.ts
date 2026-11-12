// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { logoFits, logoRuns, type LogoTone } from "../src/component/logo"
import { LOGO_AGENT, LOGO_GAP, LOGO_GRAPH, LOGO_MINI, LOGO_MIN_COLUMNS, LOGO_MIN_ROWS, LOGO_WIDTH } from "../src/logo"

const GLYPHS = new Set(["█", "╗", "╔", "╝", "╚", "║", "═", " "])
const ROWS = LOGO_GRAPH.length
const GRAPH_WIDTH = 41

function fullRow(row: number) {
  return LOGO_GRAPH[row] + " ".repeat(LOGO_GAP) + LOGO_AGENT[row]
}

/** Expand the runs of one row into one tone per column. */
function tonesOf(row: number): LogoTone[] {
  return logoRuns(row).flatMap((run) => Array.from(run.text, () => run.tone))
}

test("wordmark rows are 41 and 44 columns wide", () => {
  expect(LOGO_GRAPH).toHaveLength(6)
  expect(LOGO_AGENT).toHaveLength(6)
  for (const row of LOGO_GRAPH) expect(Bun.stringWidth(row)).toBe(41)
  for (const row of LOGO_AGENT) expect(Bun.stringWidth(row)).toBe(44)
})

test("total width is 87 columns", () => {
  expect(LOGO_GAP).toBe(2)
  expect(LOGO_WIDTH).toBe(41 + LOGO_GAP + 44)
  expect(LOGO_WIDTH).toBe(87)
})

test("rows only use wordmark glyphs", () => {
  const unexpected = [...new Set([...LOGO_GRAPH, ...LOGO_AGENT].join("").split(""))].filter((char) => !GLYPHS.has(char))
  expect(unexpected).toEqual([])
})

test("the mini mark carries the product name", () => {
  expect(LOGO_MINI).toBe("◇─◆ GraphAgent")
  expect(LOGO_MIN_COLUMNS).toBe(90)
  expect(LOGO_MIN_ROWS).toBe(22)
})

test("the drawn wordmark is 87 columns by 6 rows", () => {
  expect(ROWS).toBe(6)
  for (let row = 0; row < ROWS; row++) {
    expect(Bun.stringWidth(fullRow(row))).toBe(87)
    // The runs cover the row exactly once: no gaps, no overlap, nothing dropped.
    const runs = logoRuns(row)
    expect(runs.map((run) => run.text).join("")).toBe(fullRow(row))
    let expectedStart = 0
    for (const run of runs) {
      expect(run.start).toBe(expectedStart)
      expectedStart += run.text.length
    }
    expect(expectedStart).toBe(LOGO_WIDTH)
  }
})

test("cells get the tone of their glyph and word", () => {
  for (let row = 0; row < ROWS; row++) {
    const text = fullRow(row)
    const tones = tonesOf(row)
    expect(tones).toHaveLength(LOGO_WIDTH)
    for (let column = 0; column < LOGO_WIDTH; column++) {
      const char = text[column]
      const expected: LogoTone =
        char === " " ? "blank" : char !== "█" ? "shadow" : column < GRAPH_WIDTH ? "face" : "accent"
      expect({ row, column, tone: tones[column] }).toEqual({ row, column, tone: expected })
    }
  }
})

test("the colour boundary between GRAPH and AGENT is the 42nd column", () => {
  for (let row = 0; row < ROWS; row++) {
    const tones = tonesOf(row)
    // Column 42 (index 41) and 43 (index 42) are the gap: blank in every row.
    expect(tones.slice(GRAPH_WIDTH, GRAPH_WIDTH + LOGO_GAP)).toEqual(["blank", "blank"])
    // GRAPH face never leaks past the gap and AGENT face never leaks in front of it. The
    // bottom row is outline only, so a tone may be absent from a row.
    expect(tones.lastIndexOf("face")).toBeLessThan(GRAPH_WIDTH)
    const firstAccent = tones.indexOf("accent")
    if (firstAccent !== -1) expect(firstAccent).toBeGreaterThanOrEqual(GRAPH_WIDTH + LOGO_GAP)
    // Whatever ends GRAPH, the gap run covers both gap columns.
    expect(
      logoRuns(row).some(
        (run) => run.tone === "blank" && run.start <= GRAPH_WIDTH && run.start + run.text.length >= 43,
      ),
    ).toBe(true)
  }
  expect(LOGO_GRAPH[0].length + 1).toBe(42)
})

test("a row is a handful of runs per glyph, never one run per character", () => {
  for (let row = 0; row < ROWS; row++) {
    expect(logoRuns(row).length).toBeLessThan(LOGO_WIDTH / 2)
  }
})

test("the wordmark needs at least 90 columns and 22 rows", () => {
  expect(logoFits({ width: 90, height: 22 })).toBe(true)
  expect(logoFits({ width: 120, height: 40 })).toBe(true)
  expect(logoFits({ width: 89, height: 40 })).toBe(false)
  expect(logoFits({ width: 120, height: 21 })).toBe(false)
  expect(logoFits({ width: 80, height: 24 })).toBe(false)
})

test("with ambiguous_width 2 the wordmark needs the wider terminal its glyphs really take", () => {
  expect(logoFits({ width: 120, height: 40 }, 2)).toBe(false)
  expect(logoFits({ width: 165, height: 40 }, 2)).toBe(false)
  expect(logoFits({ width: 166, height: 40 }, 2)).toBe(true)
  expect(logoFits({ width: 90, height: 22 }, 1)).toBe(true)
})
