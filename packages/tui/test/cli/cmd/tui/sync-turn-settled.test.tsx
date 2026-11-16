// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import type { Event, GlobalEvent } from "@graphagent/sdk"
import { tmpdir } from "../../../fixture/fixture"
import { probeStoreWrites } from "../../../fixture/store-write-probe"
import { directory, mount, wait } from "./sync-fixture"

type Outcome = Extract<Event, { type: "session.turn.settled" }>["properties"]["outcome"]

let sequence = 0

function settled(sessionID: string, turnID: string, outcome: Outcome, timeEnded: number): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: `evt_turn_${++sequence}`,
      type: "session.turn.settled",
      properties: { sessionID, turnID, outcome, steps: 1, timeEnded },
    },
  }
}

async function withMount(run: (ctx: Awaited<ReturnType<typeof mount>>) => Promise<void>) {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const ctx = await mount(undefined, tmp.path)
  try {
    await run(ctx)
  } finally {
    ctx.app.renderer.destroy()
  }
}

describe("tui sync settled turns", () => {
  test("records how the latest turn of each session ended, for sessions it has never loaded", async () => {
    await withMount(async ({ emit, sync }) => {
      expect(sync.data.turn_settled).toEqual({})
      emit(settled("ses_a", "turn_1", { type: "error", code: "provider_error", retryable: true }, 1_000))
      emit(settled("ses_b", "turn_2", { type: "completed" }, 2_000))
      emit(settled("ses_c", "turn_3", { type: "cancelled", reason: "user" }, 3_000))
      await wait(() => Object.keys(sync.data.turn_settled).length === 3)

      expect(sync.data.turn_settled.ses_a).toEqual({ turnID: "turn_1", outcome: "error", timeEnded: 1_000 })
      expect(sync.data.turn_settled.ses_b).toEqual({ turnID: "turn_2", outcome: "completed", timeEnded: 2_000 })
      expect(sync.data.turn_settled.ses_c).toEqual({ turnID: "turn_3", outcome: "cancelled", timeEnded: 3_000 })
    })
  })

  test("keeps the outcome type of every kind of ending", async () => {
    const outcomes: Outcome[] = [
      { type: "completed" },
      { type: "length" },
      { type: "tool_budget_exhausted" },
      { type: "structured_missing" },
      { type: "content_filter" },
      { type: "error", code: "x", retryable: false },
      { type: "cancelled" },
      { type: "context_overflow" },
      { type: "blocked", by: "hook", code: "denied" },
      { type: "interrupted" },
    ]
    await withMount(async ({ emit, sync }) => {
      for (const [index, outcome] of outcomes.entries()) {
        emit(settled("ses_a", `turn_${index}`, outcome, 1_000 + index))
        await wait(() => sync.data.turn_settled.ses_a?.turnID === `turn_${index}`)
        expect(sync.data.turn_settled.ses_a.outcome).toBe(outcome.type)
      }
    })
  })

  test("a later turn replaces the outcome; one that arrives late does not", async () => {
    await withMount(async ({ emit, sync }) => {
      emit(settled("ses_a", "turn_1", { type: "error", code: "x", retryable: false }, 1_000))
      await wait(() => sync.data.turn_settled.ses_a?.outcome === "error")

      emit(settled("ses_a", "turn_2", { type: "completed" }, 2_000))
      await wait(() => sync.data.turn_settled.ses_a?.outcome === "completed")

      // An older turn delivered after a newer one must not bring its outcome back.
      emit(settled("ses_a", "turn_1", { type: "error", code: "x", retryable: false }, 1_000))
      await Bun.sleep(60)
      expect(sync.data.turn_settled.ses_a).toEqual({ turnID: "turn_2", outcome: "completed", timeEnded: 2_000 })
    })
  })

  test("writes only its own slice: no message or part, and one write per event", async () => {
    await withMount(async ({ emit, sync }) => {
      const probe = probeStoreWrites(sync.data, ["message", "part", "turn_settled", "summary"])
      try {
        emit(settled("ses_a", "turn_1", { type: "completed" }, 1_000))
        await wait(() => sync.data.turn_settled.ses_a !== undefined)
        await Bun.sleep(40)
        expect(probe.writes("message")).toBe(0)
        expect(probe.writes("part")).toBe(0)
        expect(probe.writes("turn_settled")).toBe(1)
      } finally {
        probe.dispose()
      }
    })
  })

  test("deleting the session clears it", async () => {
    await withMount(async ({ emit, sdk, sync }) => {
      emit(settled("ses_a", "turn_1", { type: "completed" }, 1_000))
      emit(settled("ses_b", "turn_2", { type: "completed" }, 1_000))
      await wait(() => Object.keys(sync.data.turn_settled).length === 2)

      emit({
        directory,
        project: "proj_test",
        payload: {
          id: `evt_turn_${++sequence}`,
          type: "session.deleted",
          properties: {
            sessionID: "ses_a",
            info: {
              id: "ses_a",
              slug: "a",
              projectID: "proj_test",
              directory,
              title: "a",
              version: "test",
              time: { created: 0, updated: 0 },
            },
          },
        },
      })
      sdk.frameClock.flushNow()
      await wait(() => sync.data.turn_settled.ses_a === undefined)
      expect(sync.data.turn_settled.ses_b?.turnID).toBe("turn_2")
    })
  })

  test("a reconnect clears it: nothing can read it back, so an old outcome must not pass for the latest", async () => {
    await withMount(async ({ emit, reconnect, sync }) => {
      emit(settled("ses_a", "turn_1", { type: "error", code: "x", retryable: false }, 1_000))
      await wait(() => sync.data.turn_settled.ses_a !== undefined)

      reconnect()
      await wait(() => Object.keys(sync.data.turn_settled).length === 0)

      // Events after the reconnect record again.
      emit(settled("ses_a", "turn_3", { type: "completed" }, 3_000))
      await wait(() => sync.data.turn_settled.ses_a?.turnID === "turn_3")
    })
  })
})
