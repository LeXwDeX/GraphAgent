// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Goal } from "@/goal/goal"
import { GoalState } from "@/goal/state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import { Database } from "@graphagent/core/database/database"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { Parameters as GoalToolParameters } from "@/tool/goal"

const testLayer = Goal.layer.pipe(
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
)

const it = testEffect(testLayer)

const sessionID = () => SessionID.make(`ses_goal_intent_${crypto.randomUUID()}`)

const awaitIntent = (overrides: Partial<GoalState.Wait> = {}): GoalState.Intent => ({
  kind: "await",
  wait: {
    source: "background_job",
    wait_id: "job_1",
    deadline: Date.now() + 60_000,
    max_wakes: GoalState.nni(1),
    wakes: GoalState.nni(0),
    ...overrides,
  },
})

describe("goal intent and waiting", () => {
  it.effect("stores an await intent as waiting", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const id = sessionID()
      yield* goal.set(id, "wait for the job", 5)

      const next = yield* goal.setIntent(id, awaitIntent())
      expect(next?.status).toBe("waiting")
      const loaded = yield* goal.load(id)
      expect(loaded?.intent).toMatchObject({ kind: "await", wait: { wait_id: "job_1" } })
    }),
  )

  it.effect("wakes a matching waiter once and returns the goal to active progress", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const id = sessionID()
      yield* goal.set(id, "wait for the job", 5)
      yield* goal.setIntent(id, awaitIntent())

      expect(yield* goal.wake(id, { source: "background_job", ids: ["other"] }, "ignored")).toBe(false)
      expect(yield* goal.wake(id, { source: "watch_pr", ids: ["job_1"] }, "ignored")).toBe(false)
      expect((yield* goal.load(id))?.status).toBe("waiting")
      expect(yield* goal.wake(id, { source: "background_job", ids: ["x", "job_1"] }, "job result")).toBe(true)

      const loaded = yield* goal.load(id)
      expect(loaded?.status).toBe("active")
      expect(loaded?.intent?.kind).toBe("progress")
      expect(loaded?.last_reason).toContain("job result")
    }),
  )

  it.effect("expires a waiting goal past its deadline", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const id = sessionID()
      yield* goal.set(id, "wait for the job", 5)
      yield* goal.setIntent(id, awaitIntent({ deadline: Date.now() - 1 }))

      const expired = yield* goal.expireWait(id)
      expect(expired?.status).toBe("paused")
      expect(expired?.paused_reason).toContain("job_1")
    }),
  )

  it.effect("expires a waiting goal after its wake budget", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const id = sessionID()
      yield* goal.set(id, "wait for the job", 5)
      yield* goal.setIntent(id, awaitIntent({ max_wakes: GoalState.nni(0) }))

      const expired = yield* goal.expireWait(id)
      expect(expired?.status).toBe("paused")
    }),
  )

  it.effect("does not wake a matching waiter whose wake budget is exhausted", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const id = sessionID()
      yield* goal.set(id, "wait for the job", 5)
      yield* goal.setIntent(id, awaitIntent({ max_wakes: GoalState.nni(0) }))

      expect(yield* goal.wake(id, { source: "background_job", ids: ["job_1"] })).toBe(false)
      expect((yield* goal.load(id))?.status).toBe("waiting")
    }),
  )

  it.effect("resume clears the intent that paused the goal", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const id = sessionID()
      yield* goal.set(id, "wait for the job", 5)
      yield* goal.setIntent(id, awaitIntent({ deadline: Date.now() - 1 }))
      const expired = yield* goal.expireWait(id)
      expect(expired?.intent?.kind).toBe("blocked")

      const resumed = yield* goal.resume(id)
      expect(resumed?.status).toBe("active")
      expect(resumed?.intent).toBeUndefined()
    }),
  )

  it.effect("turn-control resume clears a stale blocked intent", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const id = sessionID()
      yield* goal.set(id, "work", 5)
      yield* goal.setIntent(id, { kind: "blocked", reason: "needs input" })
      yield* goal.pause(id, "needs input")

      const result = yield* goal.controlDuringTurn(id, { action: "resume" })
      expect(result.changed).toBe(true)
      if (result.changed) expect(result.state.intent).toBeUndefined()
    }),
  )

  it.effect("pauses a waiting goal", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const id = sessionID()
      yield* goal.set(id, "wait for the job", 5)
      yield* goal.setIntent(id, awaitIntent())

      const paused = yield* goal.pause(id, "user-paused")
      expect(paused?.status).toBe("paused")

      yield* goal.set(id, "wait again", 5)
      yield* goal.setIntent(id, awaitIntent())
      const control = yield* goal.controlDuringTurn(id, { action: "pause", reason: "stop waiting" })
      expect(control.changed).toBe(true)
      if (control.changed) expect(control.state.status).toBe("paused")
    }),
  )

  it.effect("lets a waiting goal re-declare its intent", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const id = sessionID()
      yield* goal.set(id, "wait for the job", 5)
      yield* goal.setIntent(id, awaitIntent())

      const progress = yield* goal.setIntent(id, { kind: "progress" })
      expect(progress?.status).toBe("active")
      expect(progress?.intent?.kind).toBe("progress")

      yield* goal.setIntent(id, awaitIntent({ wait_id: "job_2" }))
      const replaced = yield* goal.setIntent(id, awaitIntent({ wait_id: "job_3" }))
      expect(replaced?.status).toBe("waiting")
      expect(replaced?.intent).toMatchObject({ kind: "await", wait: { wait_id: "job_3" } })
    }),
  )

  it.effect("shows a waiting goal in the status line", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const id = sessionID()
      yield* goal.set(id, "wait for the job", 5)
      yield* goal.setIntent(id, awaitIntent())

      const line = yield* goal.statusLine(id)
      expect(line).toContain("等待中")
      expect(line).toContain("background_job:job_1")
    }),
  )

  it.instance("does not replace a waiting goal with a new /goal", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const id = sessionID()
      yield* goal.set(id, "wait for the job", 5)
      yield* goal.setIntent(id, awaitIntent())

      const result = yield* goal.dispatch(id, "a different goal")
      expect(result.type).toBe("message")
      const loaded = yield* goal.load(id)
      expect(loaded?.goal).toBe("wait for the job")
      expect(loaded?.status).toBe("waiting")
    }),
  )

  test("the goal tool accepts only wait sources with a wake producer", () => {
    const decode = Schema.decodeUnknownSync(GoalToolParameters)
    for (const source of ["watch_pr", "background_job"] as const) {
      expect(decode({ action: "intent", intent: "await", wait_source: source, wait_id: "x" }).wait_source).toBe(source)
    }
    for (const source of ["hook", "timer", "dag"]) {
      expect(() => decode({ action: "intent", intent: "await", wait_source: source, wait_id: "x" })).toThrow()
    }
  })
})
