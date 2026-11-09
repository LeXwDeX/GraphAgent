// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import type { Counters } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"
import { COMPACTION_EVERY, MESSAGES, SUMMARY_DIFF_BYTES, TAIL_TURNS, TURNS, s3Scenario } from "./scenarios/s3"

const scenario = s3Scenario()
const it = testEffect(scenario.layer)

const withoutBytes = (counts: Counters) =>
  Object.fromEntries(Object.entries(counts).filter(([key]) => key !== "json.encodeBytes" && key !== "sha256Bytes"))

// Pre-H5 engine baseline recorded at d452d3a8. The measured window parsed the
// seeded 256KiB turn diff about seven times, so H5 (#1016) moving the diff to
// `message_diff` must remove at least one full diff budget from the window.
// Message and part row JSON still dominates the remaining parses, so the plan's
// literal `< SUMMARY_DIFF_BYTES` would not hold (measured ~4.1MiB after H5).
const PRE_H5_PARSE_BYTES = 5_985_446

describe("S3 cold start on a compacted long session", () => {
  it.instance(
    "5000 messages with ten compactions read only the retained tail",
    () =>
      Effect.gen(function* () {
        const result = yield* scenario.run
        const first = result.first

        expect(first.seededCompactions).toBe(TURNS / COMPACTION_EVERY)
        expect(first.conversationRequests).toBe(1)
        expect(first.compactionRequests).toBe(0)
        expect(first.finalRole).toBe("assistant")
        // The visible history is the retained tail plus the final compaction
        // pair and the measured prompt. Everything before the tail marker stays
        // in the table but must not reach the model.
        expect(first.counts["convert.messages"]).toBeGreaterThan(TAIL_TURNS * 2)
        expect(first.counts["convert.messages"]).toBeLessThan(MESSAGES / 2)
        // The current cold start pages through the whole table (the read is
        // statement-counted, not row-counted); the baseline records that cost
        // for H4's tail-bounded read, which must lower it substantially.
        expect(first.counts["sql.read"]).toBeGreaterThan(TAIL_TURNS)
        expect(first.counts["sql.read"]).toBeLessThan(MESSAGES)
        // H5 (#1016): turn diffs live in `message_diff`, so hydrating the user
        // message no longer parses the seeded payload-sized diff. Require the
        // window to lose at least one diff budget against the pre-H5 baseline.
        expect(first.counts["json.parseBytes"]).toBeLessThan(PRE_H5_PARSE_BYTES - SUMMARY_DIFF_BYTES)
        expect(first.counts["events.durable"]).toBeGreaterThan(0)
        expect(first.counts["sql.write"]).toBeGreaterThan(0)

        const second = result.second
        expect(second.seededCompactions).toBe(TURNS / COMPACTION_EVERY)
        expect(withoutBytes(second.counts)).toEqual(withoutBytes(first.counts))
        expect(Math.abs(second.counts["json.encodeBytes"] - first.counts["json.encodeBytes"])).toBeLessThanOrEqual(64)
      }),
    scenario.instance,
    { timeout: scenario.timeout },
  )
})
