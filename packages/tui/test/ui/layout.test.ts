// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import {
  DRAWER_WIDTH,
  FRAME_INSET,
  GUTTER,
  LEGACY_EDGE_GUTTER,
  MARK_CELLS,
  NARROW_WIDTH,
  ROW_INDENT,
  contentWidth,
  framedInnerWidth,
} from "../../src/ui/layout"

// #1670 moves the numbers without moving a cell on screen: these are the values the regions were drawn with before.
test("the tokens carry the numbers the screen is drawn with", () => {
  expect(GUTTER).toBe(2)
  expect(FRAME_INSET).toBe(2)
  expect(ROW_INDENT).toBe(3)
  expect(MARK_CELLS).toBe(2)
  expect(NARROW_WIDTH).toBe(100)
  expect(DRAWER_WIDTH).toBe(40)
  expect(LEGACY_EDGE_GUTTER).toBe(1)
})

test("contentWidth is the width between the two gutters", () => {
  expect(contentWidth(80)).toBe(76)
  expect(contentWidth(100)).toBe(96)
  expect(contentWidth(120)).toBe(116)
  for (const width of [60, 80, 100, 120, 200]) expect(contentWidth(width)).toBe(width - 2 * GUTTER)
})

test("framedInnerWidth takes the border and the padding off both sides", () => {
  expect(framedInnerWidth(80)).toBe(76)
  expect(framedInnerWidth(100)).toBe(96)
  expect(framedInnerWidth(120)).toBe(116)
  for (const width of [60, 80, 100, 120, 200]) expect(framedInnerWidth(width)).toBe(width - 2 * FRAME_INSET)
})

test("the widths are plain arithmetic, left to the caller to clamp", () => {
  expect(contentWidth(3)).toBe(-1)
  expect(framedInnerWidth(3)).toBe(-1)
})
