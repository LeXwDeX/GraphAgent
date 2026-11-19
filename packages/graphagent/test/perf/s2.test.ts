// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { expectBytesWithinTolerance, withoutBytes } from "./determinism"
import { s2Scenario } from "./scenarios/s2"

const MESSAGES = 500

const scenario = s2Scenario()
const it = testEffect(scenario.layer)

describe("S2 session with two compactions", () => {
  it.instance(
    "500 messages and two automatic compactions are deterministic",
    () =>
      Effect.gen(function* () {
        const result = yield* scenario.run

        expect(result.first.compactionRequests).toBe(2)
        expect(result.first.conversationRequests).toBe(1)
        expect(result.first.compactionMessages).toBe(2)
        expect(result.first.finalRole).toBe("assistant")
        expect(result.first.counts["events.durable"]).toBeGreaterThan(0)
        expect(result.first.counts["sql.write"]).toBeGreaterThan(0)
        expect(result.first.counts["convert.messages"]).toBeGreaterThan(MESSAGES)
        expect(result.first.counts["json.parseBytes"]).toBeGreaterThan(0)

        expect(result.second.compactionRequests).toBe(2)
        expect(result.second.conversationRequests).toBe(1)
        expect(result.second.compactionMessages).toBe(2)
        // The measured turn writes three step-finish parts (two compactions and
        // the answer), each with whole-millisecond `metrics` durations that the
        // later history reads parse again (13, 7 and 3 times). A duration
        // crossing a digit boundary moves `json.parseBytes` by that many bytes
        // (determinism.ts has the full account), so the byte counters only need
        // to stay in the same small band; the rest is exact.
        expect(withoutBytes(result.second.counts)).toEqual(withoutBytes(result.first.counts))
        expectBytesWithinTolerance(result.second.counts, result.first.counts)
      }),
    scenario.instance,
    { timeout: scenario.timeout },
  )
})
