import { expect, test } from "bun:test"
import { cellWidth } from "../../src/ui/width"

test("ambiguous width defaults to one cell", () => {
  expect(cellWidth("◆")).toBe(1)
  expect(cellWidth("◇")).toBe(1)
  expect(cellWidth("◆─◇")).toBe(3)
})

test("ambiguous width two counts ambiguous glyphs as two cells", () => {
  expect(cellWidth("◆", 2)).toBe(2)
  expect(cellWidth("◇", 2)).toBe(2)
  expect(cellWidth("◆─◇", 2)).toBe(6)
  expect(cellWidth("a◆b", 2)).toBe(4)
})

test("measures ascii, wide and combining text", () => {
  expect(cellWidth("")).toBe(0)
  expect(cellWidth("abc")).toBe(3)
  expect(cellWidth("中文")).toBe(4)
  expect(cellWidth("é")).toBe(1)
  expect(cellWidth("👨‍👩‍👧‍👦")).toBe(2)
})

test("ignores ANSI escape sequences", () => {
  expect(cellWidth("\x1b[31mab\x1b[0m")).toBe(2)
})

test("keeps wide glyphs wide with ambiguous width two", () => {
  expect(cellWidth("中", 2)).toBe(2)
  expect(cellWidth("◆中", 2)).toBe(4)
})
