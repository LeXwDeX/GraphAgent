// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- The compile-only reverse-acquisition checks exercise branded witnesses, which is the point of the test.

import { describe, expect } from "bun:test"
import { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import { Deferred, Effect, Fiber, Layer, ManagedRuntime } from "effect"
import { SessionCancellation } from "@/session/cancellation"
import {
  makeSessionLocks,
  type PromptLockWitness,
  type PublicationWitness,
  type RunRequestWitness,
  type SessionLocks,
} from "@/session/locks"
import { SessionID } from "@/session/schema"
import { awaitWithTimeout, it } from "../lib/effect"

/**
 * Issue #1019 PR9: the run-request ⊃ prompt-lock ⊃ publication lock order.
 *
 * (a) a cancel request is registered before the prompt lock is awaited;
 * (b) a publication section never waits for the cancel decision inside the lock;
 * (c) prompt.ts opens the run request before the prompt lock;
 * (d) publication is the innermost lock and reverse acquisition is untyped;
 * (e) two ManagedRuntime layer graphs fence each other through process state.
 */

/**
 * Compile-time only: an inner witness must not acquire an outer lock. These
 * calls are never executed; removing `@ts-expect-error` makes `tsgo` fail.
 */
function reverseAcquisition(locks: SessionLocks, run: RunRequestWitness, publication: PublicationWitness) {
  // @ts-expect-error a publication witness cannot open the prompt lock
  const promptFromPublication = locks.withPromptLock(publication, SessionID.make("ses_locks-types"), () => Effect.void)
  // @ts-expect-error a run-request witness cannot open the publication lock directly
  const publicationFromRun = locks.withPublication(run, SessionID.make("ses_locks-types"), () => Effect.void)
  return [promptFromPublication, publicationFromRun] as const
}
void reverseAcquisition

describe("session lock witnesses", () => {
  it.live("(a) registers the cancel request before waiting for the prompt lock", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_locks-register-before-lock")
      const locks = makeSessionLocks(KeyedMutex.makeUnsafe<SessionID>())
      const holderEntered = yield* Deferred.make<void>()
      const releaseHolder = yield* Deferred.make<void>()
      let abort: ReturnType<typeof SessionCancellation.begin> | undefined
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Deferred.doneUnsafe(releaseHolder, Effect.void)
          abort?.finish()
        }),
      )

      const holder = yield* locks
        .withRunRequest(sessionID, (_request, witness) =>
          locks.withPromptLock(witness, sessionID, () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(holderEntered, undefined)
              yield* Deferred.await(releaseHolder)
            }),
          ),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(holderEntered)

      const waiterStarted = yield* Deferred.make<void>()
      let ran = false
      const waiter = yield* locks
        .withRunRequest(sessionID, (request, witness) =>
          Effect.gen(function* () {
            // Registered before the lock wait: a cancel that lands now must
            // invalidate this request even though the lock is still held.
            yield* Deferred.succeed(waiterStarted, undefined)
            return yield* locks.withPromptLock(witness, sessionID, () =>
              Effect.sync(() => {
                if (!request.valid()) return "fenced"
                ran = true
                return "ran"
              }),
            )
          }),
        )
        .pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(waiterStarted), "the waiter did not register its request")

      abort = SessionCancellation.begin(sessionID)
      Deferred.doneUnsafe(releaseHolder, Effect.void)
      const outcome = yield* awaitWithTimeout(Fiber.join(waiter), "the waiter never acquired the prompt lock")
      expect(outcome).toBe("fenced")
      expect(ran).toBe(false)
      yield* Fiber.await(holder)
    }),
  )

  it.live("(b) never waits for the cancel decision inside the publication lock", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_locks-publication-no-wait")
      const locks = makeSessionLocks(KeyedMutex.makeUnsafe<SessionID>())
      const decided = yield* Deferred.make<void>()
      let abort: ReturnType<typeof SessionCancellation.begin> | undefined
      yield* Effect.addFinalizer(() => Effect.sync(() => abort?.finish()))

      const result = yield* locks.withRunRequest(sessionID, (_request, run) =>
        locks.withPromptLock(run, sessionID, (prompt) =>
          Effect.gen(function* () {
            const cancellation = SessionCancellation.begin(sessionID)
            abort = cancellation
            expect(SessionCancellation.goalCancelPending(sessionID)).toBe(true)
            // Mirrors SessionRunState.retire: observe the pending goal cancel,
            // fork the wait, and leave the publication section immediately.
            const first = yield* locks.withPublication(prompt, sessionID, () =>
              Effect.gen(function* () {
                expect(SessionCancellation.goalCancelPending(sessionID)).toBe(true)
                yield* Effect.forkChild(
                  SessionCancellation.waitForGoalCancels(sessionID).pipe(
                    Effect.andThen(Deferred.succeed(decided, undefined)),
                  ),
                )
                return "published"
              }),
            )
            // Entering again proves the first section released the lock
            // instead of awaiting the decision while holding it.
            const second = yield* locks.withPublication(prompt, sessionID, () => Effect.succeed("again"))
            expect(yield* Deferred.isDone(decided)).toBe(false)
            return [first, second] as const
          }),
        ),
      )
      expect(result).toEqual(["published", "again"])
      abort?.finish()
      yield* awaitWithTimeout(Deferred.await(decided), "the forked goal-cancel wait did not resolve")
    }),
  )

  it.live("(c) prompt.ts opens the run request before the prompt lock", () =>
    Effect.promise(async () => {
      const source = await Bun.file(new URL("../../src/session/prompt.ts", import.meta.url)).text()
      for (const marker of ["const loop: (input: LoopInput", 'const resume: Interface["resume"]']) {
        const start = source.indexOf(marker)
        expect(start).toBeGreaterThan(-1)
        const runRequest = source.indexOf("withRunRequest(", start)
        const promptLock = source.indexOf("locks.withPromptLock(", start)
        expect(runRequest).toBeGreaterThan(start)
        expect(promptLock).toBeGreaterThan(runRequest)
      }
    }),
  )

  it.effect("(d) nests run request, prompt lock and publication in order", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_locks-witness-order")
      const locks = makeSessionLocks(KeyedMutex.makeUnsafe<SessionID>())
      const seen: string[] = []
      const result = yield* locks.withRunRequest(sessionID, (_request, run) =>
        locks.withPromptLock(run, sessionID, (prompt: PromptLockWitness) =>
          locks.withPublication(prompt, sessionID, () =>
            Effect.sync(() => {
              seen.push("publication")
              return "innermost"
            }),
          ),
        ),
      )
      expect(result).toBe("innermost")
      expect(seen).toEqual(["publication"])
    }),
  )

  it.live("(e) fences a request opened by another ManagedRuntime layer graph", () =>
    Effect.gen(function* () {
      const first = ManagedRuntime.make(Layer.empty)
      const second = ManagedRuntime.make(Layer.empty)
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await first.dispose()
          await second.dispose()
        }),
      )
      // Each layer graph builds its own prompt mutex, exactly like one
      // `SessionPrompt.layer` per ManagedRuntime. Cancellation state is
      // process-wide, so a cancel from either graph fences both.
      const firstLocks = makeSessionLocks(KeyedMutex.makeUnsafe<SessionID>())
      const sessionID = SessionID.make("ses_locks-cross-runtime")
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fiber = first.runFork(
        firstLocks.withRunRequest(sessionID, (request) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return request.valid()
          }),
        ),
      )
      yield* awaitWithTimeout(Deferred.await(entered), "the first runtime did not open its request")

      const abort = yield* Effect.promise(() =>
        second.runPromise(Effect.sync(() => SessionCancellation.begin(sessionID))),
      )
      Deferred.doneUnsafe(release, Effect.void)
      const valid = yield* awaitWithTimeout(Fiber.join(fiber), "the first runtime did not finish its request")
      abort.finish()
      expect(valid).toBe(false)
    }),
  )
})
