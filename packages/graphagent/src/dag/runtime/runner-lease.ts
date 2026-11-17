// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as RunnerLease from "./runner-lease"

import { Cause, Clock, Context, Effect, Fiber, Layer, Option, Scope, Semaphore } from "effect"
import { DagLease } from "@graphagent/core/dag/lease"
import { Database } from "@graphagent/core/database/database"
import { EngineProcess, type RunnerIdentity } from "@/session/engine-process"
import { ReconcileDecide } from "./reconcile-decide"

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
 *     published `confirm` reads the lease again, which is the #270 admission
 *     for the window after the reconciliation.
 *     An adoption that ends without an entry gives its claim back (`abandon`),
 *     so the next runner does not wait out a TTL for a workflow nobody drives.
 *     So does a workflow that ended: once its entry is dropped nothing renews
 *     its lease, and left alone that lease would keep every other runner from
 *     adopting the workflow again (extend, recover) until the TTL ran out.
 *   - One fiber per instance renews the lease of every runtime entry, paused
 *     and stepping workflows included, every `RENEWAL_PERIOD_MS`. A renewal
 *     that finds the row naming another token means the lease is lost: the
 *     workflow goes to the reconciler (`reconcile`, below), whose judgement
 *     evicts it (the eviction stops driving it and writes nothing for it; the
 *     new holder decides the outcome). A renewal that fails is not that: a
 *     database failure (`SQLITE_BUSY` after the busy timeout) is transient and
 *     is retried at the next tick.
 *   - At a clean exit the instance releases the leases it holds, after it has
 *     interrupted its fibers, so another runner can claim them at once.
 *   - A spawn re-reads the lease right before it creates a child session
 *     (`verify`); a lost lease ends the spawn and hands the workflow to the
 *     reconciler the same way.
 *   - `evictor` is the eviction itself: what an instance does with the entry of
 *     a workflow whose lease it lost. It cancels the children its own attempts
 *     created and no other (`Evictable.attemptChild`).
 *   - A write under the entry's token that the fence refuses (`refused`, which
 *     the runner port calls, `runner-port.ts`) is the third way to learn of the
 *     loss, after the renewal and the spawn's re-read: it evicts the same way.
 *
 * A lost lease is a trigger, not a verdict (ADR-0008 Amendment 3, 4b-C). The renewal
 * and `verify` only learn that the row does not name the entry's token. What that
 * means is the reconciler's judgement (`reconcile`, the loop's `reconcileAfter`:
 * the news is newer than any evaluation under way): the row of a workflow that
 * ended or was deleted is no loss, and its entry is retired by the routine of the
 * terminal handler (row 1), another holder's is evicted (row 3). Each trigger runs
 * in a fiber of the instance's scope, so neither the renewal tick nor the spawn
 * that asked waits for it. A graph that has no reconciler (the unit graphs of this
 * file's own tests) keeps the direct eviction of PR2, where nobody else is there
 * to judge.
 *
 * The same tick starts the instance's reconcile round (`round`, ADR-0008
 * decision 6, `reconciler.ts`), in a fiber of its own and never more than one at a
 * time. The tick renews and reads the clock and nothing else: a round can wait for
 * a worktree removal, the lifecycle lock or a user hook for longer than the TTL,
 * and the renewals of a runner that is still driving its workflows must not wait
 * for it. A tick that finds the previous round still running starts none.
 *
 * The clock-jump rule (decision 2) is one `ClockWatch` per instance, seeded at the
 * start of the instance (`noteClock`). Every tick feeds it its reading, and so does
 * every observation of the reconciler: a jump between two observations of one round
 * shows in the later one, and a round that is merely long is no jump, since the tick
 * goes on feeding the watch every period. A reading more than two periods after the
 * latest one (a suspended machine, a long stall) starts a quiet period of two
 * periods, every reading in it is told `afterClockJump`, and `decide` leaves
 * another runner's expired lease alone: everything on the machine saw the same jump,
 * so the lease ran out because nobody could renew it. Renewal is not held back: the
 * owner renews, whatever the clock did.
 *
 * Time comes from the `Clock` and the runner is `Identity`, so a test can drive
 * two runners in one process on a TestClock.
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
  /**
   * Give a claim back unless an entry carries it now: an adoption that ended
   * without an entry, or a workflow that ended and whose entry was just dropped.
   * Nothing renews such a lease, and left alone it keeps every other runner out
   * until the TTL runs out (and a refused adoption is not retried). The workflow
   * itself may be terminal: the release matches the token and nothing else. No
   * claim (`undefined`) is nothing to give back.
   */
  readonly abandon: (dagID: string, token: DagLease.Token | undefined) => Effect.Effect<void>
  /**
   * A spawn's re-read right before its child session exists (ADR-0008 decision
   * 2): whether the entry's token still holds the lease of a live workflow. When
   * it does not, the spawn ends and the lease is handed to the reconciler to judge
   * (`reconcile`), from a fiber of its own: the eviction that follows interrupts
   * the spawn fiber that asks, which therefore cannot wait for it. `verify` does
   * not evict itself: `held` has no row for a workflow that ended, and an eviction
   * that got to such an entry first would cost it the worktree settlement and the
   * wake of the parent; the reconciler retires it instead (row 1), settlement and
   * wake included. Without a `reconcile` it evicts directly, as it did before PR4b.
   */
  readonly verify: (dagID: string, entry: E) => Effect.Effect<boolean>
  /**
   * A write under `token` was refused by the write fence (ADR-0008 decision 5):
   * the lease no longer names it. Evicts the entry that carries the token, from a
   * fiber of its own, because the refused write may be made by a fiber the
   * eviction interrupts and under the entry's `evalLock` it takes. Starts the
   * eviction and returns; it is idempotent while one is in flight. It leaves the
   * entry alone when
   *   - no entry carries the token (an adoption that has not published its entry
   *     ends at its own `confirm`, and an entry that was replaced is not this
   *     one's to drop);
   *   - the lease row does not show another holder: the workflow is gone or
   *     terminal (its terminal and deletion handlers clean the entry up, and an
   *     eviction racing them would cost the terminal wake and the worktree
   *     settlement that they do), the row still names the token, or
   *     it could not be read (transient, as for a renewal; the next tick looks).
   */
  readonly refused: (dagID: string, token: DagLease.Token) => Effect.Effect<void>
  /**
   * The reconciler read the lease row and found that it no longer names the
   * entry's token (ADR-0008 decision 6, row 3): the lease is lost, evict the
   * entry as a renewal that finds the same does. Awaited, which `verify` and
   * `refused` cannot be: the reconciler runs in no fiber the eviction interrupts.
   * The verdict rests on reads that are older than the entry's lock, so the
   * eviction reads the lease row again once it holds the lock and leaves the entry
   * alone when
   *   - it is gone, or an entry that replaced it is the table's now;
   *   - the row does not show another holder (the judgement of `refused`): the
   *     workflow ended in between, and the entry is for the terminal handler or
   *     the next judgement to retire (row 1: the worktree, the parent's wake), or
   *     the row names the token after all, or it could not be read (the next round
   *     looks again).
   */
  readonly evict: (dagID: string, entry: E) => Effect.Effect<void>
  /**
   * Take one reading of the wall clock, `at`, into the instance's clock watch
   * (ADR-0008 decision 2), and tell whether it is in the shadow of a clock jump:
   * more than two periods after the latest reading, or within two periods of such
   * a jump. Every tick feeds the watch; the reconciler feeds it the reading of each
   * observation, so that a jump between two observations of one round is seen by
   * the second. It decides nothing itself: an expired lease of another runner is
   * left alone while it answers `true`, and the owner's renewal is never held back.
   */
  readonly noteClock: (at: number) => boolean
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
 * been interrupted, the renewal fiber and a round in flight among them.
 */
export function make<E extends Held>(input: {
  readonly leases: DagLease.Interface
  readonly runnerID: string
  readonly entries: ReadonlyMap<string, E>
  /**
   * `stillLost`, when given, is read under the entry's own lock before anything is
   * dropped, and an eviction that it answers `false` to does not happen
   * (`evictor` implements it; the reconciler's eviction asks for it).
   */
  readonly evict: (dagID: string, entry: E, stillLost?: Effect.Effect<boolean>) => Effect.Effect<void>
  /**
   * The reconcile round of the instance (ADR-0008 decision 6). Each tick that
   * finds no round in flight starts one in a fiber of the instance's scope, right
   * after its renewals, and does not wait for it: the renewals of the next tick
   * come on time however long a round takes, and a tick that finds the previous
   * round still running starts none (it logs at debug level). `afterClockJump` is
   * the verdict of the tick's own reading of the clock. A round that fails is
   * logged and the next tick starts another; one that is in flight when the
   * instance closes is interrupted.
   */
  readonly round?: (input: { readonly afterClockJump: boolean }) => Effect.Effect<void>
  /**
   * What a lost lease sets going (ADR-0008 Amendment 3, 4b-C): the reconciler's
   * trailing entry, `reconcileAfter(dagID)`. A renewal that finds its row naming
   * another token and a `verify` that finds the lease not held each start one, in
   * a fiber of the instance's scope that nobody waits for, so neither the tick nor
   * the spawn is held up. Its verdict is `decide`'s: an eviction when another
   * holder shows (row 3), the retirement of the entry when the workflow ended
   * (row 1). A call that fails is logged, and the next round looks again. Left
   * out, the direct eviction of PR2 stays (`evict` above): the graphs of this
   * file's own unit tests run no reconciler to judge a lost lease.
   */
  readonly reconcile?: (dagID: string) => Effect.Effect<unknown>
}): Effect.Effect<Interface<E>, never, Scope.Scope> {
  const { leases, runnerID, entries, evict, round, reconcile } = input
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

    // Entries whose eviction after a refused write is in flight: concurrent refusals (one per fiber
    // of the entry) start one eviction, not one each.
    const evicting = new WeakSet<object>()
    const announceLoss = (dagID: string, entry: E) =>
      Effect.logWarning("DagLoop lost the runner lease of a workflow; evicting it", {
        dagID,
        runnerID,
        epoch: entry.token.epoch,
      })
    const evictAbsorbed = (dagID: string, entry: E, stillLost?: Effect.Effect<boolean>) =>
      absorb(evict(dagID, entry, stillLost), undefined, "DagLoop could not evict a workflow that lost its lease", {
        dagID,
      })
    const evictLost = (dagID: string, entry: E) =>
      Effect.gen(function* () {
        yield* announceLoss(dagID, entry)
        yield* evictAbsorbed(dagID, entry)
      })
    // A lease found lost, by a renewal or by `verify`: the reconciler is asked to judge it (see `reconcile`), or
    // without one the entry is evicted on the spot. Either way in a fiber of the instance's scope, which is neither
    // the tick's nor the spawn's: the eviction interrupts the spawn's fiber, and the tick never waits for a judgement
    // (decision 6, two fibers). The fork does not start at once, so the call does not run on the caller's stack.
    const lostLease = (dagID: string, entry: E) =>
      (reconcile === undefined
        ? evictLost(dagID, entry)
        : absorb(
            Effect.asVoid(reconcile(dagID)),
            undefined,
            "DagLoop could not reconcile a workflow whose runner lease is lost; the next round looks again",
            { dagID },
          )
      ).pipe(Effect.forkIn(scope), Effect.asVoid)
    // Whether the lease row shows another holder right now: the row exists, so the workflow is live, and it does
    // not name `token`. No row (the workflow is gone or terminal), a row that names the token and a row that
    // cannot be read (transient, as for a renewal) are not a lost lease. `refused` and the reconciler's eviction
    // judge by this.
    const heldByAnother = (dagID: string, token: DagLease.Token, message: string) =>
      absorb(leases.held(dagID), "unreadable" as const, message, { dagID }).pipe(
        Effect.map((lease) => lease !== "unreadable" && lease !== undefined && !DagLease.holds(lease, token)),
      )

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
      for (const [dagID, entry] of lost) yield* lostLease(dagID, entry)
    })
    // The clock-jump rule: one watch for the instance, seeded with its start. The tick feeds it every period, so
    // a round that is merely long is no jump, and the reconciler feeds it the reading of every observation, so a
    // jump inside a round shows in the observation that follows it. Readings arrive in whatever order the two
    // fibers get to the watch; it keeps the largest.
    let watch = ReconcileDecide.noteClock(
      ReconcileDecide.unwatched,
      yield* Clock.currentTimeMillis,
      DagLease.RENEWAL_PERIOD_MS,
    ).watch
    const noteClock = (at: number) => {
      const noted = ReconcileDecide.noteClock(watch, at, DagLease.RENEWAL_PERIOD_MS)
      watch = noted.watch
      return noted.afterJump
    }
    // The tick renews and reads the clock, and never waits for a round: one round at a time runs in a fiber of
    // the instance's scope, and a tick that finds it still running starts none.
    let reconciling = false
    const tick = Effect.gen(function* () {
      const afterClockJump = noteClock(yield* Clock.currentTimeMillis)
      yield* renewAll
      if (round === undefined) return
      if (reconciling) {
        yield* Effect.logDebug("DagLoop did not start a reconcile round: the previous one is still running", {
          runnerID,
        })
        return
      }
      reconciling = true
      yield* absorb(
        Effect.suspend(() => round({ afterClockJump })),
        undefined,
        "DagLoop could not run its reconcile round; retrying at the next tick",
        {},
      ).pipe(
        Effect.ensuring(Effect.sync(() => void (reconciling = false))),
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.asVoid,
      )
    })
    yield* Effect.sleep(DagLease.RENEWAL_PERIOD_MS).pipe(
      Effect.andThen(tick),
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
        yield* release(dagID, token, "DagLoop could not give back a runner lease it no longer needs")
      }),
      verify: Effect.fn("RunnerLease.verify")(function* (dagID: string, entry: E) {
        const holds = DagLease.holds(yield* leases.held(dagID), entry.token)
        if (!holds) yield* lostLease(dagID, entry)
        return holds
      }),
      refused: Effect.fn("RunnerLease.refused")(function* (dagID: string, token: DagLease.Token) {
        const entry = entries.get(dagID)
        if (entry === undefined || !sameToken(entry.token, token) || evicting.has(entry)) return
        evicting.add(entry)
        yield* Effect.gen(function* () {
          const lost = yield* heldByAnother(
            dagID,
            token,
            "DagLoop could not read a runner lease after its write was refused; the next tick looks again",
          )
          if (lost) yield* evictLost(dagID, entry)
        }).pipe(Effect.ensuring(Effect.sync(() => void evicting.delete(entry))), Effect.forkIn(scope), Effect.asVoid)
      }),
      evict: Effect.fn("RunnerLease.evict")(function* (dagID: string, entry: E) {
        // The reconciler's verdict was made from reads that are older than the entry's lock: once the eviction holds
        // it, the lease row is read again, and a workflow that ended in between is left to be retired (row 1).
        const stillLost = heldByAnother(
          dagID,
          entry.token,
          "DagLoop could not read a runner lease before evicting its workflow; the next round looks again",
        ).pipe(
          Effect.tap((lost) =>
            lost
              ? announceLoss(dagID, entry)
              : Effect.logDebug("DagLoop left a workflow in place: its lease row shows no other holder now", { dagID }),
          ),
        )
        yield* evictAbsorbed(dagID, entry, stillLost)
      }),
      noteClock,
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
 * handlers. `stillLost`, when given, is read under that lock before anything is
 * touched: an eviction that decided on reads older than the lock asks it, and
 * leaves the entry alone when it answers `false`.
 */
export const evictor = <E extends Evictable>(input: {
  readonly entries: Map<string, E>
  readonly abort: (dagID: string, nodeID: string, childSessionID: string) => Effect.Effect<void>
  readonly unregister: (entry: E, dagID: string) => Effect.Effect<void>
}) =>
  Effect.fn("RunnerLease.evict")(function* (dagID: string, entry: E, stillLost?: Effect.Effect<boolean>) {
    const evicted = yield* entry.evalLock.withPermits(1)(
      Effect.gen(function* () {
        // Already gone: a terminal event or a move dropped it first.
        if (input.entries.get(dagID) !== entry) return false
        // Decided on older reads: what they showed may have ended since (a workflow that went terminal has its
        // retirement waiting for this lock, and the entry is what it settles).
        if (stillLost !== undefined && !(yield* stillLost)) return false
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
