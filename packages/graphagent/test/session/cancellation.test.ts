// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Deferred, Effect } from "effect"
import { SessionAbortReason } from "@/session/abort-reason"
import { SessionCancellation } from "@/session/cancellation"
import { EngineProcess } from "@/session/engine-process"
import { SessionID } from "@/session/schema"
import { awaitWithTimeout, it } from "../lib/effect"

describe("session cancellation coordinator", () => {
  it.live(
    "captures only existing owners and fences older requests",
    Effect.gen(function* () {
      const old = SessionCancellation.request("snapshot")
      yield* Effect.addFinalizer(() => Effect.sync(() => old.release()))
      let current = 1
      const cancelled: number[] = []
      const unregister = old.register(() => {
        const captured = current
        return Effect.sync(() => {
          cancelled.push(captured)
        })
      })
      expect(unregister).toBeDefined()
      yield* Effect.addFinalizer(() => Effect.sync(() => unregister?.()))

      const abort = SessionCancellation.begin("snapshot")
      yield* Effect.addFinalizer(() => Effect.sync(abort.finish))
      expect(old.valid()).toBe(false)
      expect(old.register(() => Effect.void)).toBeUndefined()
      unregister?.()
      current = 2

      const later = SessionCancellation.request("snapshot")
      yield* Effect.addFinalizer(() => Effect.sync(() => later.release()))
      const laterOwner = later.register(() =>
        Effect.sync(() => {
          cancelled.push(2)
        }),
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => laterOwner?.()))
      expect(later.valid()).toBe(true)
      expect(abort.owners).toHaveLength(1)
      yield* Effect.all(abort.owners)
      expect(cancelled).toEqual([1])
      abort.finish()
      yield* awaitWithTimeout(later.wait, "later request was not released")
    }),
  )

  it.live(
    "serializes aborts and keeps the barrier closed if a later abort finishes first",
    Effect.gen(function* () {
      const first = SessionCancellation.begin("barrier")
      const second = SessionCancellation.begin("barrier")
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          first.finish()
          second.finish()
        }),
      )
      const later = SessionCancellation.request("barrier")
      yield* Effect.addFinalizer(() => Effect.sync(() => later.release()))
      const entered = yield* Deferred.make<void>()
      yield* later.wait.pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.forkChild)
      expect(SessionCancellation.goalCancelPending("barrier")).toBe(true)
      first.finishGoalCancel()
      first.finishGoalCancel()
      expect(SessionCancellation.goalCancelPending("barrier")).toBe(true)
      second.finish()
      expect(SessionCancellation.goalCancelPending("barrier")).toBe(false)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(entered)).toBe(false)
      first.finish()
      yield* awaitWithTimeout(Deferred.await(entered), "abort barrier did not release")
      expect(later.valid()).toBe(true)
    }),
  )

  it.live(
    "does not fence another session",
    Effect.gen(function* () {
      const request = SessionCancellation.request("other")
      const abort = SessionCancellation.begin("target")
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          request.release()
          abort.finish()
        }),
      )
      yield* awaitWithTimeout(request.wait, "unrelated session was blocked")
      expect(request.valid()).toBe(true)
      expect(abort.owners).toHaveLength(0)
    }),
  )
})

describe("SessionCancellation.requestIfEpoch", () => {
  it.effect(
    "creates a request only for the observed epoch",
    Effect.sync(() => {
      const id = "request-if-epoch-match"
      const observed = SessionCancellation.epoch(id)
      const request = SessionCancellation.requestIfEpoch(id, observed)
      expect(request).toBeDefined()
      expect(request?.valid()).toBe(true)
      request?.release()
      // The match created cancellation state; release removed it.
      expect(EngineProcess.cancellation.sessions.has(id)).toBe(false)
    }),
  )

  it.effect(
    "a stale epoch creates no request and no cancellation state",
    Effect.sync(() => {
      const id = "request-if-epoch-mismatch"
      const abort = SessionCancellation.begin(id)
      abort.finish()
      expect(SessionCancellation.epoch(id)).toBe(1)
      expect(EngineProcess.cancellation.sessions.has(id)).toBe(false)
      expect(SessionCancellation.requestIfEpoch(id, 0)).toBeUndefined()
      // The mismatch is a comparison only: no CancellationSession is created.
      expect(EngineProcess.cancellation.sessions.has(id)).toBe(false)
    }),
  )

  it.effect(
    "a begin after the observation makes the old epoch stale",
    Effect.sync(() => {
      const id = "request-if-epoch-after-begin"
      const observed = SessionCancellation.epoch(id)
      const request = SessionCancellation.requestIfEpoch(id, observed)
      expect(request).toBeDefined()
      request?.release()
      const abort = SessionCancellation.begin(id)
      abort.finish()
      expect(SessionCancellation.requestIfEpoch(id, observed)).toBeUndefined()
      expect(EngineProcess.cancellation.sessions.has(id)).toBe(false)
    }),
  )
})

// #1584: `epochs` gained one entry per session ever cancelled and never lost one. Only a deletion may drop it:
// an epoch that fell back to 0 while its session lives could be matched by a stale observation.
describe("SessionCancellation.forget", () => {
  it.effect(
    "drops the remembered epoch, so a later reader sees 0 again",
    Effect.sync(() => {
      const id = "forget-epoch"
      SessionCancellation.begin(id).finish()
      SessionCancellation.begin(id).finish()
      expect(SessionCancellation.epoch(id)).toBe(2)

      SessionCancellation.forget(id)

      expect(EngineProcess.cancellation.epochs.has(id)).toBe(false)
      expect(SessionCancellation.epoch(id)).toBe(0)
    }),
  )

  it.effect(
    "touches only that session, and not the live state of an abort in flight",
    Effect.sync(() => {
      const id = "forget-in-flight"
      const other = "forget-other"
      SessionCancellation.begin(other).finish()
      const abort = SessionCancellation.begin(id)
      const request = SessionCancellation.request(id)

      SessionCancellation.forget(id)

      expect(SessionCancellation.epoch(other)).toBe(1)
      // The request keeps its fence: `sessions` is released by its own users, not by a delete.
      expect(request.valid()).toBe(true)
      expect(EngineProcess.cancellation.sessions.has(id)).toBe(true)
      abort.finish()
      request.release()
      expect(EngineProcess.cancellation.sessions.has(id)).toBe(false)
      // Finishing does not write the epoch back.
      expect(EngineProcess.cancellation.epochs.has(id)).toBe(false)
      SessionCancellation.forget(other)
    }),
  )

  it.effect(
    "an instance release is not a deletion: neither purgeDirectory nor the runtime caches' remove drop the epoch",
    Effect.gen(function* () {
      const id = SessionID.make("ses_forget_instance_release")
      const directory = "forget-instance-release-directory"
      SessionCancellation.begin(id).finish()
      EngineProcess.runtimes.own(id, directory)

      yield* Effect.promise(() => EngineProcess.runtimes.purgeDirectory(directory))
      yield* EngineProcess.runtimes.remove(id)

      expect(SessionCancellation.epoch(id)).toBe(1)
      SessionCancellation.forget(id)
    }),
  )
})

describe("session abort reason", () => {
  it.effect(
    "lets several owners read the same reason until its coordinator clears it",
    Effect.sync(() => {
      const id = "abort-reason-multiple-owners"
      const reason = SessionAbortReason.make("replan", "dag-replan")
      SessionAbortReason.set(id, reason)
      expect(SessionAbortReason.peek(id)).toBe(reason)
      expect(SessionAbortReason.peek(id)).toBe(reason)
      SessionAbortReason.clear(id, reason)
      expect(SessionAbortReason.peek(id)).toBeUndefined()
    }),
  )
})
