// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { setLanguage } from "../../../src/i18n"
import {
  RESULT_CARD_INDENT,
  RESULT_CARD_MARK,
  resultCardChrome,
  resultCardPreview,
  resultCardTitle,
  resultPreviewRoom,
} from "../../../src/routes/session/result-card"
import { cellWidth, type AmbiguousWidth } from "../../../src/ui/width"

/**
 * How the card of a background result fits its lines to the width (#1058). Every case is measured in cells at both
 * settings of `ambiguous_width`: the border and the glyph that start the lines are two cells wide at the second.
 */

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

const SETTINGS: readonly AmbiguousWidth[] = [1, 2]
const base = { kind: "explore", title: "Scan src", status: "completed", elapsedMs: 65_000 } as const

describe("the room a card has", () => {
  test("is the width less the border, the padding and, for the preview, the indent", () => {
    expect(resultCardChrome(1)).toBe(4)
    expect(resultCardChrome(2)).toBe(5)
    expect(resultPreviewRoom(100, 1)).toBe(100 - 4 - RESULT_CARD_INDENT)
    expect(resultPreviewRoom(100, 2)).toBe(100 - 5 - RESULT_CARD_INDENT)
  })

  test("is never negative", () => {
    expect(resultPreviewRoom(3, 1)).toBe(0)
    expect(resultPreviewRoom(0, 2)).toBe(0)
  })
})

describe("resultCardTitle", () => {
  test("is the whole line when it fits", () => {
    setLanguage("en")
    for (const setting of SETTINGS) {
      expect(resultCardTitle(base, 100, setting)).toBe("background result · explore · Scan src · done · 1m 5s")
    }
  })

  test("cuts the end of the task title, which is free text, and keeps the status and the time", () => {
    setLanguage("en")
    const title = { ...base, title: `Scan ${"长标题".repeat(20)}` }
    for (const setting of SETTINGS) {
      const line = resultCardTitle(title, 70, setting)
      expect(line).toStartWith("background result · explore · Scan ")
      expect(line).toEndWith("… · done · 1m 5s")
      expect(cellWidth(`${RESULT_CARD_MARK} ${line}`, setting) + resultCardChrome(setting)).toBeLessThanOrEqual(70)
    }
  })

  test("keeps the status and the time in Chinese too", () => {
    setLanguage("zh-CN")
    const line = resultCardTitle({ ...base, status: "interrupted", title: "x".repeat(80) }, 60, 1)
    expect(line).toStartWith("后台结果 · explore · x")
    expect(line).toEndWith("… · 已中断 · 1m 5s")
  })

  test("is cut at its end when the words around the title leave it no room, and never overflows", () => {
    setLanguage("en")
    for (const setting of SETTINGS) {
      for (const width of [0, 1, 10, 30, 45]) {
        const line = resultCardTitle(base, width, setting)
        const room = Math.max(0, width - resultCardChrome(setting) - cellWidth(`${RESULT_CARD_MARK} `, setting))
        expect({ width, setting, fits: cellWidth(line, setting) <= room }).toEqual({ width, setting, fits: true })
      }
    }
    expect(resultCardTitle(base, 30, 1)).toEndWith("…")
  })
})

describe("resultCardPreview", () => {
  const hint = "ctrl+o expand · click to open"

  /** Cells the preview line takes, from the indent to the end of the hint, as the row draws them. */
  const taken = (preview: ReturnType<typeof resultCardPreview>, setting: AmbiguousWidth) =>
    cellWidth(preview.text, setting) + preview.pad + cellWidth(preview.hint, setting)

  test("a line that fits stands on the left and the hint at the right end of the room", () => {
    for (const setting of SETTINGS) {
      const room = resultPreviewRoom(80, setting)
      for (const folds of [true, false]) {
        const preview = resultCardPreview({ firstLine: "All clear.", hint, folds, width: 80, ambiguousWidth: setting })
        expect(preview.text).toBe("All clear.")
        expect(preview.hint).toBe(hint)
        expect(taken(preview, setting)).toBe(room)
      }
    }
  })

  test("a card that folds gives the hint the room it needs and cuts its line for it", () => {
    for (const setting of SETTINGS) {
      const line = "x".repeat(200)
      const preview = resultCardPreview({ firstLine: line, hint, folds: true, width: 80, ambiguousWidth: setting })
      expect(preview.text).toEndWith("…")
      expect(preview.hint).toBe(hint)
      expect(preview.pad).toBeGreaterThanOrEqual(2)
      expect(taken(preview, setting)).toBe(resultPreviewRoom(80, setting))
    }
  })

  test("a line that fits the room but not with the hint is cut when the card folds, and keeps the hint out when it does not", () => {
    // 58 cells: the room at 80 columns is 74; the long hint and its gap of two take 31, the short one 15.
    const line = "y".repeat(58)
    const folds = resultCardPreview({ firstLine: line, hint, folds: true, width: 80, ambiguousWidth: 1 })
    expect(folds.text).toEndWith("…")
    expect(folds.hint).toBe(hint)
    expect(taken(folds, 1)).toBe(74)
    const fits = resultCardPreview({
      firstLine: line,
      hint: "click to open",
      folds: false,
      width: 80,
      ambiguousWidth: 1,
    })
    expect(fits).toEqual({ text: line, pad: 74 - 58 - 13, hint: "click to open" })
    const crowded = resultCardPreview({ firstLine: line, hint, folds: false, width: 80, ambiguousWidth: 1 })
    expect(crowded).toEqual({ text: line, pad: 0, hint: "" })
  })

  test("a hint that would leave the line fewer than eight cells is dropped, and the card stays clickable", () => {
    // Room 40: the hint and its gap take 31 and leave nine; at 38 they leave seven.
    const wide = resultCardPreview({ firstLine: "z".repeat(100), hint, folds: true, width: 46, ambiguousWidth: 1 })
    expect(wide.hint).toBe(hint)
    expect(cellWidth(wide.text, 1)).toBe(9)
    const narrow = resultCardPreview({ firstLine: "z".repeat(100), hint, folds: true, width: 44, ambiguousWidth: 1 })
    expect(narrow.hint).toBe("")
    expect(narrow.pad).toBe(0)
    expect(cellWidth(narrow.text, 1)).toBeLessThanOrEqual(resultPreviewRoom(44, 1))
    // A line shorter than eight cells needs no more room than it has.
    const short = resultCardPreview({ firstLine: "ok", hint, folds: true, width: 40, ambiguousWidth: 1 })
    expect(short.hint).toBe(hint)
    expect(short.text).toBe("ok")
  })

  test("without a hint the line has the whole room, cut with an ellipsis if it is longer", () => {
    for (const setting of SETTINGS) {
      const preview = resultCardPreview({
        firstLine: "w".repeat(200),
        hint: "",
        folds: true,
        width: 80,
        ambiguousWidth: setting,
      })
      expect(preview.hint).toBe("")
      expect(preview.pad).toBe(0)
      expect(preview.text).toEndWith("…")
      expect(cellWidth(preview.text, setting)).toBeLessThanOrEqual(resultPreviewRoom(80, setting))
    }
  })

  test("an empty line leaves the hint alone at the right end, and nothing at all when there is none", () => {
    for (const setting of SETTINGS) {
      const alone = resultCardPreview({ firstLine: "", hint, folds: false, width: 80, ambiguousWidth: setting })
      expect(alone.text).toBe("")
      expect(taken(alone, setting)).toBe(resultPreviewRoom(80, setting))
      expect(resultCardPreview({ firstLine: "", hint: "", folds: false, width: 80, ambiguousWidth: setting })).toEqual({
        text: "",
        pad: 0,
        hint: "",
      })
    }
  })

  test("cuts by cells: a Chinese line and a line of glyphs of ambiguous width never run past the room", () => {
    for (const setting of SETTINGS) {
      for (const line of ["网络错误：".repeat(40), "·".repeat(150), "…".repeat(150)]) {
        for (const width of [60, 80, 120]) {
          for (const folds of [true, false]) {
            const preview = resultCardPreview({ firstLine: line, hint, folds, width, ambiguousWidth: setting })
            expect(taken(preview, setting)).toBeLessThanOrEqual(resultPreviewRoom(width, setting))
          }
        }
      }
    }
  })
})
