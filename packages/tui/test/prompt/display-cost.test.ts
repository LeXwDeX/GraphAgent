// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { displaySlice, mentionTriggerIndex, promptOffsetWidth } from "../../src/prompt/display"
import { countSegmentation } from "../fixture/segmentation-probe"

/**
 * The prompt asks `mentionTriggerIndex` for the text before the cursor after every key. That used to segment
 * the whole text before the cursor, and every grapheme in it a second time to measure it, so a keystroke cost as
 * much as the text was long (#1261). These tests count what is asked of `Intl.Segmenter`: the number of
 * `segment()` calls and of iterator steps. Unlike a clock, the counts do not depend on the machine or its load.
 */

/** One key may cost a couple of graphemes at the edit; the budget leaves room for that and nothing like a text. */
const KEY = { calls: 2, steps: 16 }

const UNITS = {
  ascii: "The quick brown fox jumps over the lazy dog while typing a long prompt. ",
  cjk: "中文输入框性能测试，这是一段用于测量长输入每次按键开销的文字。",
  mixed: "混合 mixed 输入 😀 emoji 👨\u200d👩\u200d👧\u200d👦 与 English e\u0301 文本 🇺🇸 prompt。\n",
  mentions: "看 @src/app.ts 和 @docs/readme.md 然后 foo@example.com 继续 ",
}
const KINDS = ["ascii", "cjk", "mixed", "mentions"] as const
const LENGTHS = [200, 5000, 20000]

/** Whole units, so that no grapheme is cut in two. */
function textOf(unit: string, length: number) {
  let result = ""
  while (result.length + unit.length <= length) result += unit
  return result
}

/** The steps a cold text costs: each grapheme once, however many keys follow. */
function graphemeCount(value: string) {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length
}

describe("prompt display cost", () => {
  for (const kind of KINDS) {
    for (const length of LENGTHS) {
      test(`typing at the end of ${kind} text of ${length} characters costs a constant`, async () => {
        let value = textOf(UNITS[kind], length)
        let offset = promptOffsetWidth(value)
        // The first key after the text appeared indexes it; the keys after it only add to the index.
        mentionTriggerIndex(value, offset)

        const lead = " typing words and then "
        const trigger = offset + lead.length
        for (const [index, key] of (lead + "@src/main.ts").split("").entries()) {
          value += key
          offset += 1
          const caret = offset
          let found: number | undefined
          const cost = await countSegmentation(() => (found = mentionTriggerIndex(value, caret)))
          // Whatever it costs, the answer is the one the whole-text walk gave.
          expect(found).toBe(index >= lead.length ? trigger : undefined)
          expect(cost.calls).toBeLessThanOrEqual(KEY.calls)
          expect(cost.steps).toBeLessThanOrEqual(KEY.steps)
        }
      })

      test(`typing in the middle of ${kind} text of ${length} characters costs a constant`, async () => {
        const head = textOf(UNITS[kind], length / 2)
        const tail = textOf(UNITS[kind], length / 2)
        let typed = ""
        let offset = promptOffsetWidth(head)
        mentionTriggerIndex(head + tail, offset)

        for (const key of "abcdefghijklmnopqrst") {
          typed += key
          offset += 1
          const value = head + typed + tail
          const caret = offset
          const cost = await countSegmentation(() => mentionTriggerIndex(value, caret))
          expect(cost.calls).toBeLessThanOrEqual(KEY.calls)
          expect(cost.steps).toBeLessThanOrEqual(KEY.steps)
        }
      })
    }
  }

  test("a key costs the same in a long text as in a short one", async () => {
    const worst = async (length: number) => {
      let value = textOf(UNITS.mixed, length)
      let offset = promptOffsetWidth(value)
      mentionTriggerIndex(value, offset)
      const steps: number[] = []
      for (const key of "abcdefghijklmnopqrst") {
        value += key
        offset += 1
        const caret = offset
        steps.push((await countSegmentation(() => mentionTriggerIndex(value, caret))).steps)
      }
      return Math.max(...steps)
    }

    const short = await worst(200)
    const long = await worst(20000)
    expect(short).toBeGreaterThan(0)
    expect(long).toBeLessThanOrEqual(short + 2)
  })

  test("a text is indexed once and then read without segmenting", async () => {
    const value = textOf(UNITS.mixed, 5000)
    const width = promptOffsetWidth(value)

    const cold = await countSegmentation(() => mentionTriggerIndex(value, width))
    // Every grapheme once, not once per grapheme.
    expect(cold.calls).toBeLessThanOrEqual(2)
    expect(cold.steps).toBeLessThanOrEqual(graphemeCount(value) + 2)

    const warm = await countSegmentation(() => {
      for (const offset of [0, 1, 17, width >> 1, width - 3, width, width + 9]) {
        mentionTriggerIndex(value, offset)
        displaySlice(value, offset, width)
        displaySlice(value, 0, offset)
      }
      displaySlice(value)
    })
    expect(warm).toEqual({ calls: 0, steps: 0 })
  })

  test("an edit far from the end is indexed from the edit, not from the start", async () => {
    const base = textOf(UNITS.cjk, 5000)
    // Indexed to the end, as after typing there.
    mentionTriggerIndex(base, promptOffsetWidth(base))

    const typed = "abcdef"
    for (let count = 1; count <= typed.length; count++) {
      const value = typed.slice(0, count) + base
      const cost = await countSegmentation(() => mentionTriggerIndex(value, count))
      expect(cost.calls).toBeLessThanOrEqual(KEY.calls)
      expect(cost.steps).toBeLessThanOrEqual(KEY.steps)
    }

    // Going back to the end indexes the text again, once; typing there is cheap again.
    let value = typed + base
    let offset = promptOffsetWidth(value)
    const caret = offset
    const back = await countSegmentation(() => mentionTriggerIndex(value, caret))
    expect(back.steps).toBeLessThanOrEqual(graphemeCount(value) + 2)
    for (const key of "xyz") {
      value += key
      offset += 1
      const next = offset
      const cost = await countSegmentation(() => mentionTriggerIndex(value, next))
      expect(cost.steps).toBeLessThanOrEqual(KEY.steps)
    }
  })

  test("reading the query after a trigger costs a constant while it is typed", async () => {
    // The direct-mode composer reads the text after the trigger on every key while its menu is open.
    const prefix = textOf(UNITS.cjk, 5000) + " @"
    const at = promptOffsetWidth(prefix) - 1
    let value = prefix
    let offset = at + 1
    displaySlice(value, at, offset)

    for (const key of "components/prompt") {
      value += key
      offset += 1
      const caret = offset
      let query = ""
      const cost = await countSegmentation(() => {
        displaySlice(value, at, caret)
        query = displaySlice(value, at + 1, caret)
      })
      expect(query).toBe(value.slice(value.lastIndexOf("@") + 1))
      expect(cost.calls).toBeLessThanOrEqual(KEY.calls)
      expect(cost.steps).toBeLessThanOrEqual(KEY.steps)
    }
  })
})
