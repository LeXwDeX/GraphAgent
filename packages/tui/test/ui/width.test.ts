// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { cellWidth, cursorWidth, truncateCells, truncateCellsLeft } from "../../src/ui/width"

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

test("left truncation keeps the end of the text and puts the ellipsis in front", () => {
  expect(truncateCellsLeft("hello", 5)).toBe("hello")
  expect(truncateCellsLeft("hello", 6)).toBe("hello")
  expect(truncateCellsLeft("hello", 4)).toBe("…llo")
  expect(truncateCellsLeft("hello", 1)).toBe("…")
  expect(truncateCellsLeft("hello", 0)).toBe("")
  expect(truncateCellsLeft("", 3)).toBe("")
  expect(truncateCellsLeft("/repo/.worktree/dag-1-workflow", 12)).toBe("…-1-workflow")
})

test("left truncation counts display cells, not characters", () => {
  // Wide glyphs are two cells: the ellipsis takes one and the kept end the rest, and one that does not fit is dropped.
  expect(truncateCellsLeft("中文标题", 6)).toBe("…标题")
  expect(truncateCellsLeft("中文标题", 5)).toBe("…标题")
  expect(truncateCellsLeft("中文标题", 4)).toBe("…题")
  expect(truncateCellsLeft("中文标题", 8)).toBe("中文标题")
  expect(truncateCellsLeft("/项目/工作目录/dag", 9)).toBe("…目录/dag")
  // A combined emoji is one cluster: kept whole or dropped whole, never split.
  expect(truncateCellsLeft("ab👨‍👩‍👧‍👦", 3)).toBe("…👨‍👩‍👧‍👦")
  expect(truncateCellsLeft("ab👨‍👩‍👧‍👦", 2)).toBe("…")
  expect(truncateCellsLeft("e\u0301e\u0301e\u0301", 2)).toBe("…e\u0301")
})

test("left truncation follows ambiguous width", () => {
  expect(truncateCellsLeft("◆◆◆", 3)).toBe("◆◆◆")
  expect(truncateCellsLeft("◆◆◆", 2)).toBe("…◆")
  // With ambiguous_width 2 the ellipsis and each diamond are two cells.
  expect(truncateCellsLeft("◆◆◆", 4, 2)).toBe("…◆")
  expect(truncateCellsLeft("◆◆◆", 5, 2)).toBe("…◆")
  expect(truncateCellsLeft("◆◆◆", 6, 2)).toBe("◆◆◆")
  expect(truncateCellsLeft("◆◆◆", 1, 2)).toBe("")
  expect(truncateCellsLeft("◆◆◆", 2, 2)).toBe("…")
})

test("left truncation never exceeds its budget and always ends the way the text does", () => {
  const samples = [
    "/work/project/worktree/dag-8f3a1c-workflow",
    "/项目/工作目录/分支-中文/dag-1",
    "◆─◇ boxes ━━ and ● dots/…/end",
    "a👨‍👩‍👧‍👦b👩🏽‍💻c",
  ]
  for (const text of samples) {
    for (const aw of [1, 2] as const) {
      for (let width = 0; width <= cellWidth(text, aw) + 2; width++) {
        const cut = truncateCellsLeft(text, width, aw)
        expect({ text, aw, width, fits: cellWidth(cut, aw) <= width }).toEqual({ text, aw, width, fits: true })
        // What is kept is a tail of the text, behind the ellipsis when anything was cut.
        const kept = cut === text ? cut : cut.replace(/^…/, "")
        expect({ text, aw, width, tail: text.endsWith(kept) }).toEqual({ text, aw, width, tail: true })
      }
    }
  }
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
