// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { expectBytesWithinTolerance, withoutBytes } from "./determinism"
import { s1Scenario } from "./scenarios/s1"

const scenario = s1Scenario()
const it = testEffect(scenario.layer)

describe("S1 single session", () => {
  it.instance(
    "50 messages then one measured turn is deterministic across sessions",
    () =>
      Effect.gen(function* () {
        const result = yield* scenario.run

        // The title fork belongs to turn 1; a measured turn is one request.
        expect(result.firstRequests).toBe(1)
        expect(result.requests).toHaveLength(1)
        expect(result.firstCounts["events.durable"]).toBeGreaterThan(0)
        expect(result.firstCounts["sql.write"]).toBeGreaterThan(0)
        expect(result.firstCounts["sql.read"]).toBeGreaterThan(0)
        expect(result.firstCounts.commits).toBeGreaterThan(0)

        // Payload byte totals are not bit-identical across runs: event payloads
        // carry timestamps and sequence numbers, and the 24 seeded step-finish
        // parts persist whole-millisecond `metrics` durations that every history
        // read parses again (three reads here), so a duration crossing a digit
        // boundary (9 ms against 10 ms) moves `json.parseBytes` by three bytes
        // (determinism.ts has the full account). Everything else must match
        // exactly; the byte counters only need to stay in the same small band.
        expect(withoutBytes(result.counts)).toEqual(withoutBytes(result.firstCounts))
        expect(result.firstCounts["json.encodeBytes"]).toBeGreaterThan(0)
        expectBytesWithinTolerance(result.counts, result.firstCounts)
      }),
    scenario.instance,
    { timeout: scenario.timeout },
  )
})
