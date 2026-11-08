import { expect, test } from "bun:test"
import { LOGO_AGENT, LOGO_GAP, LOGO_GRAPH, LOGO_MINI, LOGO_MIN_COLUMNS, LOGO_WIDTH } from "../src/logo"

const GLYPHS = new Set(["█", "╗", "╔", "╝", "╚", "║", "═", " "])

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
})
