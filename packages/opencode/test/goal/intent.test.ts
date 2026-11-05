import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Goal } from "@/goal/goal"
import { GoalState } from "@/goal/state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

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

      expect(yield* goal.wake(id, "other", "ignored")).toBe(false)
      expect(yield* goal.wake(id, "job_1", "job result")).toBe(true)

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
})
