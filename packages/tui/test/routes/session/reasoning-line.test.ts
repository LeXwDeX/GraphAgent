// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { setLanguage } from "../../../src/i18n"
import { reasoningDuration, reasoningLine } from "../../../src/routes/session/reasoning-line"
import { cellWidth, type AmbiguousWidth } from "../../../src/ui/width"

/**
 * The words of the line a thought is drawn as (#1615 PR B): how long it took in whole seconds, and the one line the
 * header says, folded, open or still being written, with or without the title the summary starts with.
 */

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

const LANGUAGES = ["zh-CN", "en"] as const

describe("reasoningDuration", () => {
  test("is whole seconds under a minute, in each language", () => {
    setLanguage("zh-CN")
    expect(reasoningDuration(12_000)).toBe("12 秒")
    expect(reasoningDuration(59_000)).toBe("59 秒")
    setLanguage("en")
    expect(reasoningDuration(12_000)).toBe("12s")
    expect(reasoningDuration(59_000)).toBe("59s")
  })

  test("rounds to the nearest second, and a thought that took no time says zero", () => {
    setLanguage("en")
    expect(reasoningDuration(0)).toBe("0s")
    expect(reasoningDuration(1)).toBe("0s")
    expect(reasoningDuration(499)).toBe("0s")
    expect(reasoningDuration(500)).toBe("1s")
    expect(reasoningDuration(12_400)).toBe("12s")
    expect(reasoningDuration(12_600)).toBe("13s")
    // Never a negative time, which a clock that went back would give.
    expect(reasoningDuration(-5_000)).toBe("0s")
  })

  test("is minutes and the seconds left from a minute on, and the rounding carries into the minute", () => {
    setLanguage("zh-CN")
    expect(reasoningDuration(60_000)).toBe("1 分 0 秒")
    expect(reasoningDuration(72_000)).toBe("1 分 12 秒")
    expect(reasoningDuration(59_600)).toBe("1 分 0 秒")
    setLanguage("en")
    expect(reasoningDuration(60_000)).toBe("1m 0s")
    expect(reasoningDuration(72_000)).toBe("1m 12s")
    expect(reasoningDuration(3_725_000)).toBe("62m 5s")
  })
})

const line = (input: Partial<Parameters<typeof reasoningLine>[0]> & { done: boolean; open: boolean }) =>
  reasoningLine({ title: null, room: 200, ambiguousWidth: 1, ...input })

describe("reasoningLine", () => {
  test("a thought that is folded says how long it took and that it is folded", () => {
    setLanguage("zh-CN")
    expect(line({ done: true, open: false, duration: "12 秒" })).toBe("思考了 12 秒 · 已折叠")
    setLanguage("en")
    expect(line({ done: true, open: false, duration: "12s" })).toBe("Thought for 12s · collapsed")
  })

  test("a folded thought with a title says the title first", () => {
    setLanguage("zh-CN")
    expect(line({ done: true, open: false, title: "检查依赖", duration: "12 秒" })).toBe(
      "检查依赖 · 思考了 12 秒 · 已折叠",
    )
    setLanguage("en")
    expect(line({ done: true, open: false, title: "Planning the change", duration: "12s" })).toBe(
      "Planning the change · Thought for 12s · collapsed",
    )
  })

  test("an open thought does not say it is folded, with or without a title", () => {
    setLanguage("zh-CN")
    expect(line({ done: true, open: true, duration: "12 秒" })).toBe("思考了 12 秒")
    expect(line({ done: true, open: true, title: "检查依赖", duration: "12 秒" })).toBe("检查依赖 · 思考了 12 秒")
    setLanguage("en")
    expect(line({ done: true, open: true, duration: "12s" })).toBe("Thought for 12s")
    expect(line({ done: true, open: true, title: "Planning", duration: "12s" })).toBe("Planning · Thought for 12s")
  })

  test("a thought that is still being written says it is thinking, with its title when it has one", () => {
    setLanguage("zh-CN")
    expect(line({ done: false, open: false })).toBe("思考中…")
    expect(line({ done: false, open: false, title: "检查依赖" })).toBe("思考中：检查依赖")
    setLanguage("en")
    expect(line({ done: false, open: false })).toBe("Thinking…")
    expect(line({ done: false, open: true, title: "Planning" })).toBe("Thinking: Planning")
  })

  test("a title that is not one line is made one, and takes no control character or escape with it", () => {
    setLanguage("en")
    expect(line({ done: true, open: false, title: "a\nb\u001b[31mred\u001b[0m\u0007", duration: "1s" })).toBe(
      "a bred · Thought for 1s · collapsed",
    )
  })

  for (const language of LANGUAGES) {
    for (const aw of [1, 2] as const satisfies readonly AmbiguousWidth[]) {
      test(`never runs past the room it has at ambiguous width ${aw}, in ${language}`, () => {
        setLanguage(language)
        const title = "A title that goes on much longer than any row of a terminal has room for, 一直写下去"
        const duration = reasoningDuration(72_000)
        for (const done of [true, false]) {
          for (const open of [true, false]) {
            for (const withTitle of [true, false]) {
              for (let room = 0; room <= 90; room++) {
                const text = reasoningLine({
                  done,
                  open,
                  title: withTitle ? title : null,
                  duration: done ? duration : undefined,
                  room,
                  ambiguousWidth: aw,
                })
                expect(cellWidth(text, aw)).toBeLessThanOrEqual(room)
              }
            }
          }
        }
      })
    }
  }

  test("cuts the title and keeps the words that say how long the thought took and that it is folded", () => {
    setLanguage("en")
    const title = "T".repeat(60)
    const text = line({ done: true, open: false, title, duration: "12s", room: 50 })
    expect(text).toContain("…")
    expect(text.endsWith(" · Thought for 12s · collapsed")).toBe(true)
    expect(cellWidth(text, 1)).toBeLessThanOrEqual(50)
  })

  test("gives the title up for the line without one when it would be left with a few cells", () => {
    setLanguage("en")
    // The line without a title is 27 cells wide; the title would have 2 cells of the 30 the row has.
    const room = 30
    const text = line({ done: true, open: false, title: "Planning the change", duration: "12s", room })
    expect(text).toBe("Thought for 12s · collapsed")
    // With room for a few cells of it, the title comes back, cut.
    const wider = line({ done: true, open: false, title: "Planning the change", duration: "12s", room: 60 })
    expect(wider).toContain("Planning")
    expect(wider).toContain("Thought for 12s · collapsed")
  })

  test("cuts the line without a title when even that has no room", () => {
    setLanguage("en")
    const text = line({ done: true, open: false, duration: "12s", room: 10 })
    expect(text.endsWith("…")).toBe(true)
    expect(cellWidth(text, 1)).toBeLessThanOrEqual(10)
    expect(line({ done: true, open: false, duration: "12s", room: 0 })).toBe("")
  })
})
