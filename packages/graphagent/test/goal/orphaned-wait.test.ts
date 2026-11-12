// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { runtimeJobProcessID } from "@/background/persist"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Goal } from "@/goal/goal"
import { GoalState } from "@/goal/state"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Database } from "@graphagent/core/database/database"
import { RuntimeJobTable } from "@graphagent/core/lifecycle/runtime-job.sql"
import { testEffect } from "../lib/effect"

/**
 * Issue #1069 (acceptance 5b): a goal waiting on a job must not sleep until its
 * deadline when the job can no longer wake it. A process restart drops the
 * in-process registry that would have delivered the wake, so the durable
 * `runtime_job` row is the only record left. `Goal.wakeOrphanedWait` is the
 * decision the goal startup scan applies to every waiting goal.
 */

const testLayer = Goal.layer.pipe(
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provideMerge(Database.defaultLayer),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
)

const it = testEffect(testLayer)

const awaitJob = (jobID: string, options: { ref?: boolean; wakes?: number } = {}): GoalState.Intent => ({
  kind: "await",
  wait: {
    source: "watch_pr",
    wait_id: jobID,
    ...(options.ref === false ? {} : { ref: { domain: "job" as const, id: jobID } }),
    deadline: Date.now() + 60_000,
    max_wakes: GoalState.nni(1),
    wakes: GoalState.nni(options.wakes ?? 0),
  },
})

const insertJob = (row: Partial<typeof RuntimeJobTable.$inferInsert> & { id: string }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(RuntimeJobTable)
      .values({ type: "watch_pr", status: "running", started_at: 1, updated_at: 1, ...row })
      .run()
      .pipe(Effect.orDie)
  })

/** A fresh waiting goal on `jobID`; the session id is unique per call. */
const waitingGoal = (jobID: string, options?: { ref?: boolean; wakes?: number }) =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sid = SessionID.descending()
    yield* goal.set(sid, "merge the PR", 10)
    yield* goal.setIntent(sid, awaitJob(jobID, options))
    return sid
  })

describe("Goal.wakeOrphanedWait", () => {
  it.live("wakes a goal whose job the restart recovery already failed", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* insertJob({
        id: "orphan_job_recovered",
        process_id: "proc_dead",
        status: "error",
        error: "process_restart",
      })
      const sid = yield* waitingGoal("orphan_job_recovered")

      expect(yield* goal.wakeOrphanedWait(sid)).toBe(true)

      const state = yield* goal.load(sid)
      expect(state?.status).toBe("active")
      expect(state?.intent).toEqual({ kind: "progress" })
      expect(state?.last_reason).toContain("process_restart")
      expect(state?.last_reason).toContain("orphan_job_recovered")
    }),
  )

  it.live("wakes a goal whose job finished but whose wake never arrived", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* insertJob({ id: "orphan_job_finished", process_id: "proc_dead", status: "completed" })
      const sid = yield* waitingGoal("orphan_job_finished")

      expect(yield* goal.wakeOrphanedWait(sid)).toBe(true)

      const state = yield* goal.load(sid)
      expect(state?.status).toBe("active")
      expect(state?.last_reason).toContain("process_restart")
      expect(state?.last_reason).toContain("completed")
    }),
  )

  it.live("wakes a goal whose job already ended in this process without waking it", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      // An earlier instance generation of this process finished the job; the
      // owner of the wake went away with that generation's registry.
      yield* insertJob({ id: "orphan_job_ended_here", process_id: runtimeJobProcessID, status: "cancelled" })
      const sid = yield* waitingGoal("orphan_job_ended_here")

      expect(yield* goal.wakeOrphanedWait(sid)).toBe(true)
      expect((yield* goal.load(sid))?.status).toBe("active")
    }),
  )

  it.live("wakes a goal whose job row an earlier process left running, before recovery reached it", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* insertJob({ id: "orphan_job_leftover", process_id: "proc_dead", status: "settling" })
      const sid = yield* waitingGoal("orphan_job_leftover")

      expect(yield* goal.wakeOrphanedWait(sid)).toBe(true)

      const state = yield* goal.load(sid)
      expect(state?.status).toBe("active")
      expect(state?.last_reason).toContain("process_restart")
    }),
  )

  it.live("wakes a goal whose job was never recorded", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sid = yield* waitingGoal("orphan_job_unrecorded")

      expect(yield* goal.wakeOrphanedWait(sid)).toBe(true)

      const state = yield* goal.load(sid)
      expect(state?.status).toBe("active")
      expect(state?.last_reason).toContain("process_restart")
    }),
  )

  it.live("keeps waiting while the job row belongs to this process and is still running", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* insertJob({ id: "orphan_job_alive", process_id: runtimeJobProcessID, status: "running" })
      const sid = yield* waitingGoal("orphan_job_alive")

      expect(yield* goal.wakeOrphanedWait(sid)).toBe(false)

      const state = yield* goal.load(sid)
      expect(state?.status).toBe("waiting")
      expect(state?.intent?.kind).toBe("await")
    }),
  )

  it.live("leaves a wait that does not name its job by reference to its deadline", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sid = yield* waitingGoal("orphan_job_legacy", { ref: false })

      expect(yield* goal.wakeOrphanedWait(sid)).toBe(false)
      expect((yield* goal.load(sid))?.status).toBe("waiting")
    }),
  )

  it.live("ignores goals that are not waiting and waits whose wake budget is spent", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const active = SessionID.descending()
      yield* goal.set(active, "ship it", 10)
      expect(yield* goal.wakeOrphanedWait(active)).toBe(false)
      expect(yield* goal.wakeOrphanedWait(SessionID.descending())).toBe(false)

      // The deadline path owns an exhausted budget and its visible pause.
      yield* insertJob({ id: "orphan_job_spent", process_id: "proc_dead", status: "error", error: "process_restart" })
      const spent = yield* waitingGoal("orphan_job_spent", { wakes: 1 })
      expect(yield* goal.wakeOrphanedWait(spent)).toBe(false)
      expect((yield* goal.load(spent))?.status).toBe("waiting")
    }),
  )
})
