// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { EngineProcess } from "../../src/session/engine-process"
import { canonicalJson, forgetSession, size } from "../../src/session/history/model"
import { MessageV2 } from "../../src/session/message-v2"
import { hasInlineMedia, makeScenario, makeSessionID } from "./model-history.generator"

const SCENARIOS = 200
const STEPS = 6

describe("MessageV2 conversion cache property", () => {
  test("matches the batched oracle across random operation sequences", async () => {
    const state = EngineProcess.runtimes.modelHistory
    let warmSteps = 0
    let maxEntries = 0

    for (let seed = 1; seed <= SCENARIOS; seed++) {
      const sessionID = makeSessionID(seed)
      const scenario = makeScenario(seed, sessionID)
      let view = scenario.view()

      for (let step = 0; step < STEPS; step++) {
        const operation = scenario.step()
        view = scenario.view()

        const cached = await MessageV2.toModelMessages(view, scenario.model, { ...scenario.options })
        const oracle = await MessageV2.toModelMessages(view, scenario.model, {
          ...scenario.options,
          cache: "bypass",
        })
        if (canonicalJson(cached) !== canonicalJson(oracle))
          throw new Error(`cache diverged from the batched conversion (seed ${seed}, step ${step}, after ${operation})`)

        if (hasInlineMedia(view)) continue
        const before = state.metrics.conversions
        const warm = await MessageV2.toModelMessages(view, scenario.model, { ...scenario.options })
        if (canonicalJson(warm) !== canonicalJson(oracle))
          throw new Error(`warm cache diverged (seed ${seed}, step ${step}, after ${operation})`)
        expect(state.metrics.conversions - before).toBe(0)
        warmSteps++
        maxEntries = Math.max(maxEntries, size(state).entries)
      }

      forgetSession(state, sessionID)
    }

    // The sequences must actually exercise hits and stored fragments; an
    // all-miss run would make the equivalence check vacuous.
    expect(warmSteps).toBeGreaterThan(SCENARIOS)
    expect(maxEntries).toBeGreaterThan(0)
  })
})
