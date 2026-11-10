// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { autocompleteEvaluationCounts } from "../../src/component/prompt/autocomplete"
import { createFixture } from "../perf/fixtures"
import { mountHarness } from "../perf/harness"

const TYPED = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX"

test("closed autocomplete does no option work while typing", async () => {
  const harness = await mountHarness(createFixture("S"))
  try {
    await harness.reset()
    Object.assign(autocompleteEvaluationCounts, {
      options: 0,
      commands: 0,
      agents: 0,
      referenceAliases: 0,
    })

    for (const key of TYPED) {
      harness.prompt.focus()
      harness.app.mockInput.pressKey(key)
      await harness.app.renderOnce()
    }

    expect(autocompleteEvaluationCounts).toEqual({
      options: 0,
      commands: 0,
      agents: 0,
      referenceAliases: 0,
    })
  } finally {
    await harness.dispose()
  }
})
