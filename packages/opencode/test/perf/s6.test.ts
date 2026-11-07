import { describe, expect } from "bun:test"
import { Effect } from "effect"
import type { Counters } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"
import { s6Scenario } from "./scenarios/s6"

const scenario = s6Scenario()
const it = testEffect(scenario.layer)

// One durable event per preview line, at least.
const CHUNKS = 600

const withoutBytes = (counts: Counters) =>
  Object.fromEntries(Object.entries(counts).filter(([key]) => key !== "json.encodeBytes" && key !== "sha256Bytes"))

describe("S6 long shell command", () => {
  it.instance(
    "a two-minute command is deterministic while previews stream",
    () =>
      Effect.gen(function* () {
        const result = yield* scenario.run

        expect(result.firstCounts["events.durable"]).toBeGreaterThanOrEqual(CHUNKS)
        expect(result.firstCounts["sql.write"]).toBeGreaterThan(0)
        expect(result.firstCounts.commits).toBeGreaterThan(0)
        expect(result.firstCounts["json.encodeBytes"]).toBeGreaterThan(0)

        // The same scripted turn in a second session must produce identical
        // engine counts. Timestamped payload bytes are the only tolerated
        // difference, exactly like S1.
        expect(withoutBytes(result.counts)).toEqual(withoutBytes(result.firstCounts))
        expect(
          Math.abs(result.counts["json.encodeBytes"] - result.firstCounts["json.encodeBytes"]),
        ).toBeLessThanOrEqual(64)
      }),
    scenario.instance,
    { timeout: scenario.timeout },
  )
})
