// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as RunnerLease from "./runner-lease"

import { Cause, Clock, Context, Effect, Fiber, Layer, Option, Scope, Semaphore } from "effect"
import { DagLease } from "@graphagent/core/dag/lease"
import { Database } from "@graphagent/core/database/database"
import { EngineProcess, type RunnerIdentity } from "@/session/engine-process"

/**
 * The runtime side of the runner lease for one DagLoop instance (Issue #1029,
 * ADR-0008 decisions 1, 2 and 6). `DagLease` in core is the table and its
 * four primitives; this is the loop's use of them:
 *
 *   - A workflow is driven only under a claim (`claim`). The claim comes first:
 *     the loop does not judge a running node as lost before it knows that no
 *     other live runner drives it, and another runner's live lease ends the
 *     adoption right there. The claim is also the admission of #270: a
 *     workflow that is gone or terminal is refused. Right before the entry is
 *     published `confirm` reads the lease again, which is what the old
 *     `DagStore.tryClaimAdoption` did for the window after the reconciliation.
 *     An adoption that ends without an entry gives its claim back (`abandon`),
 *     so the next runner does not wait out a TTL for a workflow nobody drives.
 *   - One fiber per instance renews the lease of every runtime entry, paused
 *     and stepping workflows included, every `RENEWAL_PERIOD_MS`. A renewal
 *     that finds the row naming another token means the lease is lost: the
 *     runner evicts the workflow at once (`evict`, which stops driving it and
 *     writes nothing for it; the new holder decides the outcome). A renewal
 *     that fails is not that: a database failure (`SQLITE_BUSY` after the busy
 *     timeout) is transient and is retried at the next tick.
 *   - At a clean exit the instance releases the leases it holds, after it has
 *     interrupted its fibers, so another runner can claim them at once.
 *   - A spawn re-reads the lease right before it creates a child session
 *     (`verify`); a lost lease ends the spawn and evicts the workflow.
 *   - `evictor` is the eviction itself: what an instance does with the entry of
 *     a workflow whose lease it lost. It cancels the children its own attempts
 *     created and no other (`Evictable.attemptChild`).
 *
 * Time comes from the `Clock` and the runner is `Identity`, so a test can drive
 * two runners in one process on a TestClock. Not here: the write fence that
 * carries the token on every runner write (PR3b), and the reconcile tick that
 * adds the clock-jump rule (PR4a).
 */

/**
 * Which runner a DagLoop instance runs as. Left out, it is this process
 * (`EngineProcess.runner`); a test that models several engine processes in one
 * process provides one identity per layer graph.
 */
export class Identity extends Context.Service<Identity, RunnerIdentity>()("@graphagent/DagRunnerIdentity") {}

/** What the lease needs of a runtime entry: the token it was claimed under. */
export interface Held {
  readonly token: DagLease.Token
}

/** What eviction needs of a runtime entry besides its token. */
export interface Evictable extends Held {
  readonly parentSessionID: string
  readonly evalLock: Semaphore.Semaphore
  readonly fibers: Map<string, Fiber.Fiber<unknown, unknown>>
  readonly watchers: Map<string, Fiber.Fiber<unknown, unknown>>
  /**
   * The child session each fiber of `fibers` drives, as the attempt recorded it
   * itself (a spawn's `NodeSpawnResult.childSessionID`; a recovered continuation
   * records the child it attached to). Keyed by fiber, so a fiber that is
   * replaced or dropped takes its record with it. Eviction cancels what is
   * recorded here and nothing else: the node row names the child of whichever
   * attempt wrote last, and once another runner took the lease over and
   * restarted the node that is the new holder's child, which an evicted runner
   * must not touch.
   */
  readonly attemptChild: WeakMap<Fiber.Fiber<unknown, unknown>, () => string | undefined>
}

/** The `attemptChild` record of an attempt that continues a child session which already exists: the child is known from the start. */
export const attached = (childSessionID: string) => (): string | undefined => childSessionID

export interface Interface<E extends Held = Held> {
  /**
   * Take the lease of `dagID` ahead of driving it. The token to drive under, or
   * `undefined` when this runner may not: another runner holds a live lease, or
   * the workflow is gone or terminal.
   */
  readonly claim: (dagID: string) => Effect.Effect<DagLease.Token | undefined>
  /** Whether `token` still holds the lease of a workflow that is still live: the last check before an entry is published. */
  readonly confirm: (dagID: string, token: DagLease.Token) => Effect.Effect<boolean>
  /** Give a claim back unless an entry carries it now. No claim (`undefined`) is nothing to give back. */
  readonly abandon: (dagID: string, token: DagLease.Token | undefined) => Effect.Effect<void>
  /**
   * A spawn's re-read right before its child session exists (ADR-0008 decision
   * 2): whether the entry's token still holds the lease of a live workflow. When
   * it does not, the lease is lost and the workflow is evicted, from a fiber of
   * its own: the evictor interrupts the spawn fiber that asks, which therefore
   * cannot wait for it.
   */
  readonly verify: (dagID: string, entry: E) => Effect.Effect<boolean>
}

/**
 * The lease primitives and the runner a loop claims as: those its graph
 * provides, otherwise this process's (`EngineProcess.runner`) over the loop's
 * own database. The table lives in that database, so an isolated unit graph
 * that mocks the rest and leaves the lease out still claims for real.
 */
export const resolve = Effect.fn("RunnerLease.resolve")(function* (database: Database.Interface) {
  const identity = Option.getOrElse(yield* Effect.serviceOption(Identity), () => EngineProcess.runner)
  const provided = yield* Effect.serviceOption(DagLease.Service)
  if (Option.isSome(provided)) return { leases: provided.value, runnerID: identity.id }
  const built = yield* Layer.build(DagLease.layer).pipe(Effect.provideService(Database.Service, database))
  return { leases: Context.get(built, DagLease.Service), runnerID: identity.id }
})

/**
 * A database failure is a defect (`SQLITE_BUSY` after the busy timeout
 * included), and for a renewal or a release it is transient: log it and carry
 * on with `fallback`. Interruption is not a failure and passes through.
 */
const absorb = <A, B>(self: Effect.Effect<A>, fallback: B, message: string, fields: Record<string, unknown>) =>
  self.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning(message, { ...fields, cause }).pipe(Effect.as(fallback)),
    ),
  )

const sameToken = (left: DagLease.Token, right: DagLease.Token) =>
  left.runnerID === right.runnerID && left.epoch === right.epoch

/**
 * Start the lease of one DagLoop instance. `entries` is the instance's table of
 * runtime entries, read by the renewal tick and at exit; `evict` drops the local
 * state of a workflow whose lease is gone. The release at exit is the first
 * finalizer of the calling scope, so it runs after the fibers forked later have
 * been interrupted.
 */
export function make<E extends Held>(input: {
  readonly leases: DagLease.Interface
  readonly runnerID: string
  readonly entries: ReadonlyMap<string, E>
  readonly evict: (dagID: string, entry: E) => Effect.Effect<void>
}): Effect.Effect<Interface<E>, never, Scope.Scope> {
  const { leases, runnerID, entries, evict } = input
  return Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const release = (dagID: string, token: DagLease.Token, message: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* absorb(leases.release({ dagID, token, now }), false, message, { dagID })
      })

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...entries],
        ([dagID, entry]) => release(dagID, entry.token, "DagLoop could not give a runner lease back at exit"),
        { discard: true },
      ),
    )

    const evictLost = (dagID: string, entry: E) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("DagLoop lost the runner lease of a workflow; evicting it", {
          dagID,
          runnerID,
          epoch: entry.token.epoch,
        })
        yield* absorb(evict(dagID, entry), undefined, "DagLoop could not evict a workflow that lost its lease", {
          dagID,
        })
      })

    const renewAll = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const lost: Array<readonly [string, E]> = []
      // The table changes while a renewal is in flight; a Map iterator tolerates that.
      for (const [dagID, entry] of entries) {
        const renewed = yield* absorb(
          leases.renew({ dagID, token: entry.token, now }),
          true,
          "DagLoop could not renew a runner lease; retrying at the next tick",
          { dagID },
        )
        if (!renewed) lost.push([dagID, entry])
      }
      for (const [dagID, entry] of lost) yield* evictLost(dagID, entry)
    })
    yield* Effect.sleep(DagLease.RENEWAL_PERIOD_MS).pipe(
      Effect.andThen(renewAll),
      Effect.forever,
      Effect.forkScoped({ startImmediately: true }),
    )

    return {
      claim: Effect.fn("RunnerLease.claim")(function* (dagID: string) {
        const lease = yield* leases.claim({ dagID, runnerID, now: yield* Clock.currentTimeMillis })
        if (lease === undefined) {
          yield* Effect.logDebug("DagLoop runner lease claim refused: another runner holds it, or the workflow ended", {
            dagID,
            runnerID,
          })
          return undefined
        }
        return { runnerID: lease.runnerID, epoch: lease.epoch }
      }),
      confirm: Effect.fn("RunnerLease.confirm")(function* (dagID: string, token: DagLease.Token) {
        return DagLease.holds(yield* leases.held(dagID), token)
      }),
      abandon: Effect.fn("RunnerLease.abandon")(function* (dagID: string, token: DagLease.Token | undefined) {
        if (token === undefined) return
        const entry = entries.get(dagID)
        if (entry !== undefined && sameToken(entry.token, token)) return
        yield* release(dagID, token, "DagLoop could not give back the lease of an abandoned adoption")
      }),
      verify: Effect.fn("RunnerLease.verify")(function* (dagID: string, entry: E) {
        const holds = DagLease.holds(yield* leases.held(dagID), entry.token)
        if (!holds) yield* evictLost(dagID, entry).pipe(Effect.forkIn(scope))
        return holds
      }),
    }
  })
}

/**
 * ADR-0008 decision 2: a runner that lost the lease of a workflow stops driving
 * it. It aborts the children its own attempts created, interrupts the fibers and
 * watchers, drops the entry and gives up the parent session's dag registration,
 * which belongs to the runner that drives the workflow now. Nothing is written
 * for the workflow: the new holder decides its outcome. The children are those
 * the entry itself recorded (`Evictable.attemptChild`), never the node row's
 * current value, which can already name an attempt of the new holder. The body
 * runs under the entry's `evalLock`, so it is serialized with the entry's event
 * handlers.
 */
export const evictor = <E extends Evictable>(input: {
  readonly entries: Map<string, E>
  readonly abort: (dagID: string, nodeID: string, childSessionID: string) => Effect.Effect<void>
  readonly unregister: (entry: E, dagID: string) => Effect.Effect<void>
}) =>
  Effect.fn("RunnerLease.evict")(function* (dagID: string, entry: E) {
    const evicted = yield* entry.evalLock.withPermits(1)(
      Effect.gen(function* () {
        // Already gone: a terminal event or a move dropped it first.
        if (input.entries.get(dagID) !== entry) return false
        for (const [nodeID, fiber] of entry.fibers) {
          // A spawn that has not created its child yet has nothing to cancel: interrupting its fiber ends it.
          const childSessionID = entry.attemptChild.get(fiber)?.()
          if (childSessionID !== undefined) yield* input.abort(dagID, nodeID, childSessionID)
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
        }
        for (const watcher of entry.watchers.values()) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
        entry.fibers.clear()
        entry.watchers.clear()
        input.entries.delete(dagID)
        return true
      }),
    )
    if (evicted)
      yield* absorb(
        input.unregister(entry, dagID),
        undefined,
        "DagLoop could not give up the dag registration of an evicted workflow",
        { dagID },
      )
  })
