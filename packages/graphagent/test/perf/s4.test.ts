// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { expectDeterministicPasses } from "./determinism"
import { s4Scenario } from "./scenarios/s4"

// The session engine's idempotency gate (#523) drops a durable append whose
// type and payload hash repeat the aggregate's latest event. Repeated tool
// part updates that reach the publish path within the same millisecond carry
// identical payloads, so how many appends the gate drops depends on real time.
// The gate is the only source of variance in this scenario; the shared
// determinism helper compares everything else exactly and the SQL book by its
// append-unit accounting.
const STEPS = 20

const scenario = s4Scenario()
const it = testEffect(scenario.layer)

describe("S4 tool-dense turn", () => {
  it.instance(
    "twenty tool steps then a tools-disabled final step are deterministic",
    () =>
      Effect.gen(function* () {
        const result = yield* scenario.run

        const requests = result.requests
        expect(requests).toHaveLength(STEPS + 1)
        // The first twenty requests advertise the tool set and allow calls; the
        // final request runs after the step budget is spent, so the engine
        // disables tools and the model can only answer with text.
        expect(requests.slice(0, -1).every((request) => request.toolChoice === "auto")).toBe(true)
        expect(new Set(requests.slice(0, -1).map((request) => request.toolsHash)).size).toBe(1)
        expect(requests.at(-1)!.toolChoice).toBe("none")
        expect(requests.at(-1)!.toolsHash).not.toBe(requests[0].toolsHash)
        expect(result.firstCounts["events.durable"]).toBeGreaterThan(0)
        expect(result.firstCounts["sql.write"]).toBeGreaterThan(0)

        // Payload byte totals carry timestamps and sequence numbers; the
        // remaining counters must match exactly, the same rule as S1/S6.
        expectDeterministicPasses(result.counts, result.firstCounts)
      }),
    scenario.instance,
    { timeout: scenario.timeout },
  )
})