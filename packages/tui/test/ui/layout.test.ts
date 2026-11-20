// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import {
  DRAWER_INSET,
  DRAWER_SCROLL_GAP,
  DRAWER_WIDTH,
  FRAME_INSET,
  FRAME_PADDING,
  GUTTER,
  MARK_CELLS,
  NARROW_WIDTH,
  ROW_INDENT,
  SCROLLBAR_CELLS,
  contentWidth,
  framedInnerWidth,
  panelInnerWidth,
} from "../../src/ui/layout"

// The numbers the regions of the screen are drawn with (#1669 13.1, 13.3, 13.5, 13.8, 6.4).
test("the tokens carry the numbers the screen is drawn with", () => {
  expect(GUTTER).toBe(2)
  expect(FRAME_INSET).toBe(2)
  expect(ROW_INDENT).toBe(3)
  expect(MARK_CELLS).toBe(2)
  expect(NARROW_WIDTH).toBe(100)
  expect(DRAWER_WIDTH).toBe(40)
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

test("the frame inset is the border and the padding of a framed box", () => {
  expect(FRAME_PADDING).toBe(1)
  expect(FRAME_INSET).toBe(1 + FRAME_PADDING)
})

// The text of a panel: its frame spans the content area between the gutters, and the border and the padding come off
// both its sides (#1672, 13.3, 13.7).
test("panelInnerWidth is the width of the text inside a panel's frame", () => {
  expect(panelInnerWidth(80)).toBe(72)
  expect(panelInnerWidth(100)).toBe(92)
  expect(panelInnerWidth(120)).toBe(112)
  for (const width of [60, 80, 100, 120, 200])
    expect(panelInnerWidth(width)).toBe(framedInnerWidth(contentWidth(width)))
})

test("a fullscreen panel spans the terminal, so its text is the framed width of the whole terminal", () => {
  expect(panelInnerWidth(80, true)).toBe(76)
  expect(panelInnerWidth(120, true)).toBe(116)
  for (const width of [60, 80, 100, 120, 200]) expect(panelInnerWidth(width, true)).toBe(framedInnerWidth(width))
  expect(panelInnerWidth(80, false)).toBe(panelInnerWidth(80))
})

test("the drawer's tokens carry its insets and the room the scrollbar takes", () => {
  expect(DRAWER_INSET).toBe(FRAME_INSET)
  expect(DRAWER_SCROLL_GAP).toBe(1)
  expect(SCROLLBAR_CELLS).toBe(1)
})
