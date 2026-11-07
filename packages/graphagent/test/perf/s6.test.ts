import { describe, expect } from "bun:test"
import { Effect } from "effect"
import type { Counters } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"
import { s6Scenario } from "./scenarios/s6"

const scenario = s6Scenario()
const it = testEffect(scenario.layer)

// One durable event per preview line, at least.
const CHUNKS = 600

// The #523 idempotency gate skips a consecutive duplicate event only when no
// other event interleaves, and the preview stream does real persistence work
// between two measured passes. A skipped or replayed event shifts the SQL book
// by one three-statement unit; payload bytes carry the fixture path.
const SQL_TOLERANCE = 6
const BYTE_TOLERANCE = 512

const withoutVolatile = (counts: Counters) =>
  Object.fromEntries(
    Object.entries(counts).filter(
      ([key]) => !["json.parseBytes", "json.encodeBytes", "sha256Bytes", "sql.read", "sql.write"].includes(key),
    ),
  )

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

        // The same scripted turn in a second session must produce the same
        // engine counts. Timestamped payload bytes and the event-level dedup
        // book are the tolerated differences; every other counter is exact.
        expect(withoutVolatile(result.counts)).toEqual(withoutVolatile(result.firstCounts))
        expect(Math.abs(result.counts["sql.read"] - result.firstCounts["sql.read"])).toBeLessThanOrEqual(SQL_TOLERANCE)
        expect(Math.abs(result.counts["sql.write"] - result.firstCounts["sql.write"])).toBeLessThanOrEqual(
          SQL_TOLERANCE,
        )
        expect(Math.abs(result.counts["json.parseBytes"] - result.firstCounts["json.parseBytes"])).toBeLessThanOrEqual(
          BYTE_TOLERANCE,
        )
        expect(
          Math.abs(result.counts["json.encodeBytes"] - result.firstCounts["json.encodeBytes"]),
        ).toBeLessThanOrEqual(64)
      }),
    scenario.instance,
    { timeout: scenario.timeout },
  )
})
