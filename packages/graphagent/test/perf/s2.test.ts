// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import type { Counters } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"
import { s2Scenario } from "./scenarios/s2"

const MESSAGES = 500

const scenario = s2Scenario()
const it = testEffect(scenario.layer)

const withoutBytes = (counts: Counters) =>
  Object.fromEntries(Object.entries(counts).filter(([key]) => key !== "json.encodeBytes" && key !== "sha256Bytes"))

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
        expect(withoutBytes(result.second.counts)).toEqual(withoutBytes(result.first.counts))
        expect(
          Math.abs(result.second.counts["json.encodeBytes"] - result.first.counts["json.encodeBytes"]),
        ).toBeLessThanOrEqual(64)
      }),
    scenario.instance,
    { timeout: scenario.timeout },
  )
})
