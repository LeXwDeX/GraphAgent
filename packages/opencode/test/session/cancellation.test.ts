import { describe, expect } from "bun:test"
import { Deferred, Effect } from "effect"
import { SessionAbortReason } from "@/session/abort-reason"
import { SessionCancellation } from "@/session/cancellation"
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
