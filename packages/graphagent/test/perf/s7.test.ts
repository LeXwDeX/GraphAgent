import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { expectDeterministicPasses } from "./determinism"
import { MESSAGES, s7Scenario } from "./scenarios/s7"

const scenario = s7Scenario()
const it = testEffect(scenario.layer)

describe("S7 S2 history with PreToolUse/PostToolUse/Stop hooks", () => {
  it.instance(
    "two compactions and one hooked read are deterministic",
    () =>
      Effect.gen(function* () {
        const result = yield* scenario.run

        expect(result.first.compactionRequests).toBe(2)
        expect(result.first.conversationRequests).toBe(2)
        expect(result.first.compactionMessages).toBe(2)
        expect(result.first.finalRole).toBe("assistant")
        expect(result.first.audit.map((entry) => entry.event)).toEqual(["PreToolUse", "PostToolUse", "Stop"])
        expect(result.first.audit[0]?.tool).toBe("read")
        expect(result.first.audit[1]?.tool).toBe("read")
        expect(result.first.audit[2]?.tool).toBe(null)
        expect(result.first.counts["events.durable"]).toBeGreaterThan(0)
        expect(result.first.counts["sql.write"]).toBeGreaterThan(0)
        expect(result.first.counts["convert.messages"]).toBeGreaterThan(MESSAGES)

        expect(result.audit.map((entry) => entry.event)).toEqual(["PreToolUse", "PostToolUse", "Stop"])
        // The hooked read reaches the same #523 real-time dedup as S4, so the
        // SQL book is compared by accounting and everything else exactly.
        expectDeterministicPasses(result.counts, result.first.counts)
      }),
    scenario.instance,
    { timeout: scenario.timeout },
  )
})