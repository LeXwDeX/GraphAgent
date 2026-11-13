// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import type { Counters } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"
import { s6Scenario } from "./scenarios/s6"

const scenario = s6Scenario()
const it = testEffect(scenario.layer)

// One non-durable preview per streamed chunk. Durable publishes are limited to
// the shell/message lifecycle, which does not grow with the chunk count.
const CHUNKS = 600
const DURABLE_LIFECYCLE = 32

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

        // Running output is a non-durable tail event (#1016 HS4a): the turn
        // must not persist one durable event per line.
        expect(result.firstCounts["events.durable"]).toBeLessThanOrEqual(DURABLE_LIFECYCLE)
        expect(result.firstCounts["events.ephemeral"]).toBeGreaterThanOrEqual(CHUNKS)
        expect(result.firstCounts["sql.write"]).toBeGreaterThan(0)
        expect(result.firstCounts.commits).toBeGreaterThan(0)
        expect(result.firstCounts["json.encodeBytes"]).toBeGreaterThan(0)

        // #1278 replaces the issue's DB-size/WAL measurement with a row-count
        // gate: the perf database is in-memory (`:memory:` in the probe's
        // counting client), so no WAL file exists and page_count would fold
        // the fixture's own writes into the measured pass. Assert ADR 0002's
        // decision directly instead: the session aggregate still allocates
        // durable sequences but appends no `event` row, so reverting HS4d
        // makes the row count equal the durable lifecycle events.
        expect(result.sessionAggregateEventRows).toBe(0)
        expect(result.sessionAggregateEventSeq).toBeGreaterThan(0)

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
