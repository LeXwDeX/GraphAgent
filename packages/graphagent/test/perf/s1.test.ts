import { describe, expect } from "bun:test"
import { Effect } from "effect"
import type { Counters } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"
import { s1Scenario } from "./scenarios/s1"

const scenario = s1Scenario()
const it = testEffect(scenario.layer)

const withoutBytes = (counts: Counters) =>
  Object.fromEntries(Object.entries(counts).filter(([key]) => key !== "json.encodeBytes" && key !== "sha256Bytes"))

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

        // Payload byte totals include timestamps and event sequence numbers, so
        // they are not bit-identical across runs. Everything else must match
        // exactly; the byte counters only need to stay in the same small band.
        expect(withoutBytes(result.counts)).toEqual(withoutBytes(result.firstCounts))
        expect(result.firstCounts["json.encodeBytes"]).toBeGreaterThan(0)
        expect(
          Math.abs(result.counts["json.encodeBytes"] - result.firstCounts["json.encodeBytes"]),
        ).toBeLessThanOrEqual(64)
      }),
    scenario.instance,
    { timeout: scenario.timeout },
  )
})
