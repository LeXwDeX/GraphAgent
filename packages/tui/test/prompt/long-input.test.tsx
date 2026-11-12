// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { autocompleteEvaluationCounts } from "../../src/component/prompt/autocomplete"
import { countSegmentation, type Segmentation } from "../fixture/segmentation-probe"
import { createFixture } from "../perf/fixtures"
import { mountHarness, type PerfHarness } from "../perf/harness"

/**
 * #1261: every key typed into the production prompt used to segment the whole text before the cursor, so the
 * cost of a key grew with the length of the draft. These tests drive the real `Prompt` of the session route and
 * count what the keys ask of `Intl.Segmenter`; `display-cost.test.ts` holds the same counts for the functions
 * alone.
 */

const UNIT = "中文输入框性能测试 😀 👨\u200d👩\u200d👧\u200d👦 e\u0301 🇺🇸 mixed text。 "

/** Whole units, so that no grapheme is cut in two. */
function draftOf(length: number) {
  let result = ""
  while (result.length + UNIT.length <= length) result += UNIT
  return result
}

function findTextarea(node: Renderable): TextareaRenderable | undefined {
  if (node instanceof TextareaRenderable) return node
  for (const child of node.getChildren()) {
    const found = findTextarea(child)
    if (found) return found
  }
  return undefined
}

/** Puts `text` in the prompt with the cursor at its end, as after a paste. */
async function paste(harness: PerfHarness, text: string) {
  await harness.reset()
  const input = findTextarea(harness.app.renderer.root)
  if (!input) throw new Error("the session prompt did not mount")
  input.setText(text)
  input.focus()
  input.gotoBufferEnd()
  await harness.app.renderOnce()
  return input
}

/** Frames that let the effects a change started finish: the autocomplete follows the text from effects. */
async function settle(harness: PerfHarness) {
  for (let frame = 0; frame < 4; frame++) await harness.app.renderOnce()
}

async function press(harness: PerfHarness, key: string) {
  harness.app.mockInput.pressKey(key)
  await settle(harness)
}

/**
 * An unmounting prompt keeps its draft in module state and the next prompt mounted in the process restores it,
 * so empty the draft before the harness goes: a later test file must not find a 5,000-character draft.
 */
async function leave(harness: PerfHarness) {
  try {
    await harness.reset()
  } finally {
    await harness.dispose()
  }
}

test("a key typed into a long draft asks for as much grapheme work as one typed into a short draft", async () => {
  const harness = await mountHarness(createFixture("S"))
  try {
    const perKey = async (length: number) => {
      const draft = draftOf(length)
      const input = await paste(harness, draft)
      // The first key after a paste indexes the draft once.
      await press(harness, "w")
      const costs: Segmentation[] = []
      for (const key of "abcdefgh") costs.push(await countSegmentation(() => press(harness, key)))
      expect(harness.prompt.current.input).toBe(draft + "wabcdefgh")
      expect(input.plainText.length).toBe(draft.length + 9)
      return costs
    }

    const short = await perKey(200)
    const long = await perKey(5000)
    for (const cost of [...short, ...long]) {
      expect(cost.calls).toBeLessThanOrEqual(2)
      expect(cost.steps).toBeLessThanOrEqual(16)
    }
    expect(Math.max(...long.map((cost) => cost.steps))).toBeLessThanOrEqual(
      Math.max(...short.map((cost) => cost.steps)) + 2,
    )
  } finally {
    await leave(harness)
  }
})

test("the mention popup opens, follows the query and closes behind a long draft of CJK, emoji and joined text", async () => {
  const harness = await mountHarness(createFixture("S"))
  try {
    const draft = draftOf(5000)
    await paste(harness, draft)
    const evaluated = () => autocompleteEvaluationCounts.options

    // Typing ordinary characters leaves the closed popup alone.
    await press(harness, "w")
    const closed = evaluated()
    await press(harness, " ")
    expect(evaluated()).toBe(closed)

    // The trigger sits at the right place, so the popup opens and tracks what is typed after it.
    await press(harness, "@")
    const opened = evaluated()
    expect(opened).toBeGreaterThan(closed)
    await press(harness, "a")
    expect(evaluated()).toBeGreaterThan(opened)
    await press(harness, "b")
    const query = evaluated()

    // A space ends the mention: the popup closes and typing after it does no popup work.
    await press(harness, " ")
    const closing = evaluated()
    expect(closing).toBeGreaterThan(query)
    await press(harness, "x")
    await press(harness, "y")
    expect(evaluated()).toBe(closing)

    // Deleting back over the space finds the trigger again and reopens the popup.
    for (const _ of "xy ") {
      harness.app.mockInput.pressBackspace()
      await settle(harness)
    }
    expect(evaluated()).toBeGreaterThan(closing)
    expect(harness.prompt.current.input).toBe(draft + "w @ab")
  } finally {
    await leave(harness)
  }
})
