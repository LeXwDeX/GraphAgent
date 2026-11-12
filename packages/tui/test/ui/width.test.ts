// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { cellWidth, cursorWidth, truncateCells } from "../../src/ui/width"

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

test("truncates text to a cell budget with an ellipsis", () => {
  expect(truncateCells("hello", 5)).toBe("hello")
  expect(truncateCells("hello", 6)).toBe("hello")
  expect(truncateCells("hello", 4)).toBe("hel…")
  expect(truncateCells("hello", 0)).toBe("")
  expect(truncateCells("中文标题", 6)).toBe("中文…")
  expect(truncateCells("中文标题", 5)).toBe("中文…")
})

test("truncation follows ambiguous width", () => {
  expect(truncateCells("◆◆◆", 3)).toBe("◆◆◆")
  expect(truncateCells("◆◆◆", 2)).toBe("◆…")
  expect(truncateCells("◆◆◆", 4, 2)).toBe("◆…")
  expect(cellWidth(truncateCells("a◆b◆c", 7, 2), 2)).toBeLessThanOrEqual(7)
})

test("cursor width measures textarea offsets and ignores ambiguous width", () => {
  expect(cursorWidth("")).toBe(0)
  expect(cursorWidth("abc")).toBe(3)
  expect(cursorWidth("中文")).toBe(4)
  expect(cursorWidth("👨‍👩‍👧‍👦")).toBe(2)
  expect(cursorWidth("@src/中文.ts")).toBe(Bun.stringWidth("@src/中文.ts"))
  // Layout counts ambiguous glyphs as two cells with `ambiguous_width = 2`; the textarea does not.
  expect(cellWidth("◆─◇", 2)).toBe(6)
  expect(cursorWidth("◆─◇")).toBe(3)
  // Newlines are zero-width here; promptOffsetWidth adds them back as one position each.
  expect(cursorWidth("a\nb")).toBe(2)
})
