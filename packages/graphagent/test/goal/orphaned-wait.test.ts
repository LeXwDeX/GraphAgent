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
 * `runtime_job` row is the only record left. `Goal.orphanedWait` is the decision
 * the goal startup scan takes for every waiting goal, and
 * `Goal.expireOrphanedWait` ends exactly that wait with the review marker a
 * timed-out wait gets; the reason is what the review turn tells the agent.
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

/** What the startup scan does for one goal: decide, then end exactly that wait. */
const expireOrphaned = (sid: SessionID) =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const orphan = yield* goal.orphanedWait(sid)
    return orphan ? yield* goal.expireOrphanedWait(sid, orphan) : undefined
  })

/**
 * The wait ended: the goal is active again with the blocked-review marker, and
 * the reason is the one the agent reads in the review prompt.
 */
const expectReviewMarker = (state: GoalState.Info | undefined, ...parts: string[]) => {
  expect(state?.status).toBe("active")
  expect(state?.intent).toEqual({ kind: "blocked", reason: expect.stringContaining("复核回合未取得进展") })
  expect(state?.paused_reason).toBeUndefined()
  for (const part of ["process_restart", "请决定重跑或放弃", ...parts]) expect(state?.last_reason).toContain(part)
}

describe("Goal.orphanedWait and Goal.expireOrphanedWait", () => {
  it.live("ends the wait of a job the restart recovery already failed, naming it", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* insertJob({
        id: "orphan_job_recovered",
        title: "watch https://github.com/acme/widgets/pull/42",
        process_id: "proc_dead",
        status: "error",
        error: "process_restart",
      })
      const sid = yield* waitingGoal("orphan_job_recovered")

      // Deciding is a read: the goal still waits until the expiry is applied.
      const orphan = yield* goal.orphanedWait(sid)
      expect(orphan?.jobID).toBe("orphan_job_recovered")
      expect((yield* goal.load(sid))?.status).toBe("waiting")

      const expired = yield* expireOrphaned(sid)

      expectReviewMarker(
        expired,
        "等待的后台任务",
        "watch https://github.com/acme/widgets/pull/42",
        "orphan_job_recovered",
        "因进程重启已终止（状态 error",
      )
      // What was returned is what was stored, and the wait is over: a second
      // pass finds an ordinary active goal.
      expectReviewMarker(yield* goal.load(sid), "orphan_job_recovered")
      expect(yield* expireOrphaned(sid)).toBeUndefined()
    }),
  )

  it.live("ends the wait of a job that finished but whose wake never arrived", () =>
    Effect.gen(function* () {
      yield* insertJob({ id: "orphan_job_finished", process_id: "proc_dead", status: "completed" })
      const sid = yield* waitingGoal("orphan_job_finished")

      expectReviewMarker(
        yield* expireOrphaned(sid),
        "orphan_job_finished",
        "已结束（状态 completed）",
        "唤醒因进程重启（process_restart）丢失",
      )
    }),
  )

  it.live("ends the wait of a job that already ended in this process without waking it", () =>
    Effect.gen(function* () {
      // An earlier instance generation of this process finished the job; the
      // owner of the wake went away with that generation's registry.
      yield* insertJob({ id: "orphan_job_ended_here", process_id: runtimeJobProcessID, status: "cancelled" })
      const sid = yield* waitingGoal("orphan_job_ended_here")

      expectReviewMarker(yield* expireOrphaned(sid), "orphan_job_ended_here", "已结束（状态 cancelled）")
    }),
  )

  it.live("ends the wait of a job an earlier process left running, before recovery reached it", () =>
    Effect.gen(function* () {
      yield* insertJob({ id: "orphan_job_leftover", process_id: "proc_dead", status: "settling" })
      const sid = yield* waitingGoal("orphan_job_leftover")

      expectReviewMarker(
        yield* expireOrphaned(sid),
        "orphan_job_leftover",
        "因进程重启已丢失（状态 settling，由已退出的进程留下",
      )
    }),
  )

  it.live("ends the wait of a job that was never recorded", () =>
    Effect.gen(function* () {
      const sid = yield* waitingGoal("orphan_job_unrecorded")

      expectReviewMarker(yield* expireOrphaned(sid), "orphan_job_unrecorded", "没有持久记录")
    }),
  )

  it.live("keeps waiting while the job row belongs to this process and is still running", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* insertJob({ id: "orphan_job_alive", process_id: runtimeJobProcessID, status: "running" })
      const sid = yield* waitingGoal("orphan_job_alive")

      expect(yield* goal.orphanedWait(sid)).toBeUndefined()
      expect(yield* expireOrphaned(sid)).toBeUndefined()

      const state = yield* goal.load(sid)
      expect(state?.status).toBe("waiting")
      expect(state?.intent?.kind).toBe("await")
    }),
  )

  it.live("leaves a wait that does not name its job by reference to its deadline", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sid = yield* waitingGoal("orphan_job_legacy", { ref: false })

      // No decision is taken for it at all, whatever the job table holds.
      expect(yield* goal.orphanedWait(sid)).toBeUndefined()
      expect(yield* expireOrphaned(sid)).toBeUndefined()
      expect((yield* goal.load(sid))?.status).toBe("waiting")
    }),
  )

  it.live("ignores goals that are not waiting", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const active = SessionID.descending()
      yield* goal.set(active, "ship it", 10)

      expect(yield* expireOrphaned(active)).toBeUndefined()
      expect((yield* goal.load(active))?.status).toBe("active")
      expect(yield* expireOrphaned(SessionID.descending())).toBeUndefined()
    }),
  )

  it.live("ends a wait whose wake budget is spent too: the job is gone either way", () =>
    Effect.gen(function* () {
      yield* insertJob({ id: "orphan_job_spent", process_id: "proc_dead", status: "error", error: "process_restart" })
      const sid = yield* waitingGoal("orphan_job_spent", { wakes: 1 })

      expectReviewMarker(yield* expireOrphaned(sid), "orphan_job_spent")
    }),
  )

  // The decision and its expiry are two steps: the compare-and-swap keeps the
  // expiry from landing on a wait the goal replaced or consumed in between.
  it.live("expires only the wait whose job was checked, not one declared since", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* insertJob({ id: "orphan_job_stale", process_id: "proc_dead", status: "error", error: "process_restart" })
      const sid = yield* waitingGoal("orphan_job_stale")
      const orphan = yield* goal.orphanedWait(sid)
      if (!orphan) throw new Error("expected an orphaned wait")

      // The agent re-declares its wait on another job before the expiry lands.
      yield* goal.setIntent(sid, awaitJob("orphan_job_replacement"))

      expect(yield* goal.expireOrphanedWait(sid, orphan)).toBeUndefined()
      const state = yield* goal.load(sid)
      expect(state?.status).toBe("waiting")
      expect(state?.intent?.kind === "await" ? state.intent.wait.ref?.id : undefined).toBe("orphan_job_replacement")
    }),
  )

  it.live("does not expire a wait that was woken since the decision", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* insertJob({ id: "orphan_job_woken", process_id: "proc_dead", status: "error", error: "process_restart" })
      const sid = yield* waitingGoal("orphan_job_woken")
      const orphan = yield* goal.orphanedWait(sid)
      if (!orphan) throw new Error("expected an orphaned wait")

      expect(yield* goal.wake(sid, { source: "watch_pr", ids: ["orphan_job_woken"] }, "checks passed")).toBe(true)

      expect(yield* goal.expireOrphanedWait(sid, orphan)).toBeUndefined()
      const state = yield* goal.load(sid)
      expect(state?.status).toBe("active")
      expect(state?.intent).toEqual({ kind: "progress" })
    }),
  )
})
