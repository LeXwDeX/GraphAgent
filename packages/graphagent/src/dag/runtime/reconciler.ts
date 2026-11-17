// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagReconciler from "./reconciler"

import { Cause, Clock, DateTime, Deferred, Effect, Exit, Fiber, Option } from "effect"
import { isTerminalWorkflowStatusValue } from "@graphagent/core/dag/core/types"
import { DagLease } from "@graphagent/core/dag/lease"
import type { DagStore } from "@graphagent/core/dag/store"
import type { EventV2 } from "@graphagent/core/event"
import { DagEvent } from "@graphagent/schema/dag-event"
import type { Dag } from "../dag"
import { DagLocation } from "../location"
import { ReconcileDecide } from "./reconcile-decide"
import type { RunnerLease } from "./runner-lease"

/**
 * The reconciler of one DagLoop instance (Issue #1029, ADR-0008 decision 6): the
 * thin shell around the pure `ReconcileDecide.decide`. For one workflow it
 *
 *   1. observes: the durable row, whether the instance's directory owns it, the
 *      execution location, the lease row, the instance's runtime entry;
 *   2. decides: `decide(observation)`, one action;
 *   3. acts: an eviction, a claim and an adoption, the terminalization of an
 *      orphan, or nothing.
 *
 * An evaluation is single-flight: at most one is under way per workflow, so no two
 * adoptions, evictions or terminalizations of one workflow run at once, which is
 * what the in-process `recovering` reservation of the loop used to stand for.
 * `round` reconciles every non-terminal workflow, orphans first. The renewal tick
 * of `RunnerLease` starts one per period, in a fiber of its own and never two at
 * once (and startup runs one, awaited), so a round that waits for a worktree
 * removal, the lifecycle lock or a user hook delays no renewal.
 *
 * Two entries, for two kinds of caller. `reconcile(dagID)` is for a caller that asks
 * "what is the state now" on its own schedule, the startup round and the tick:
 * concurrent calls for one workflow share one evaluation, a call that arrives while
 * one is under way takes its verdict. `reconcileAfter(dagID)` is for a caller that
 * brings news, an event whose change was committed after the evaluation under way
 * read what it read (a first wave, a replan with no entry, a session move). Joining
 * would hand it a verdict from before its own event: a `noop` for a workflow that
 * was terminal when the evaluation looked and has been reopened since, a `renew`
 * for an entry whose session has moved away. It waits for the evaluation under way
 * to end, however that ends, and evaluates once more; the calls that arrive in the
 * same wait share that one re-evaluation. With nothing under way it is `reconcile`.
 *
 * What the shell does not decide: the adoption is `recoverWorkflow` (a claim, then
 * the row read again, then the node-level reconciliation, then the runtime entry)
 * and the unusable-workspace failure is `failUnusableWorkspace`. Both stay in the
 * loop and are passed in. Every path that creates a runtime entry comes through an
 * adoption, and every adoption through an evaluation.
 *
 * Time. The clock is read once per observation, before the lease row, and a
 * lease is judged expired or live against that reading. A process that is
 * suspended between the reading and the lease read (a round that was in flight
 * when the machine went to sleep) then sees the lease as it was before the
 * suspension, which can only make it look younger than it is, never expired
 * early. The reading also goes to the instance's clock watch (`noteClock`, kept by
 * `RunnerLease`, which every tick feeds as well): a jump between the observations
 * of one round, a machine that slept after the first workflow was looked at, makes
 * the later observation `afterClockJump`, and so does every observation in the
 * quiet period after any jump. The observation takes the watch's verdict and the
 * caller's (`Round`) together.
 *
 * Order of the reads. The clock, then the instance's entry, then the lease row,
 * then the workflow row. `DagLease.held` has no row for a workflow that ended, so
 * the other order, the workflow and then the lease, reads a workflow that ended in
 * between as a live one whose entry lost its lease, and that eviction can take the
 * entry before the terminal handler does, which skips the worktree settlement and
 * the parent's wake. Read first, a missing lease row of an entry means that the
 * workflow had ended already, and the workflow row read after it says so (a
 * terminal workflow does not turn live in between, bar the reopen of a completed
 * one by an extend, which follows the terminal wake that the terminal handler
 * sends after it took the entry). The eviction reads the lease row once more under
 * the entry's lock, and leaves the entry alone unless another holder shows
 * (`RunnerLease.Interface.evict`).
 */

/**
 * What the caller already knows of the clock (decision 2): its own reading follows a clock jump. The observations ask
 * the clock watch about theirs besides; either one holds back a takeover.
 */
export interface Round {
  readonly afterClockJump: boolean
}

export interface Interface {
  /** Evaluate one workflow and act on the verdict; concurrent calls for one `dagID` collapse into one evaluation. */
  readonly reconcile: (dagID: string, round?: Round) => Effect.Effect<ReconcileDecide.Action>
  /**
   * `reconcile` for a trigger that brings news (an event whose change was committed after the evaluation under way read
   * its state): the verdict it returns comes from an evaluation that began after the call. With nothing under way this
   * is `reconcile`; otherwise the call waits for the evaluation under way to end, however it ends (a verdict, a failure,
   * an interruption), and evaluates once more. The calls that arrive during the same wait share that one re-evaluation,
   * and a call that arrives during it waits for the next.
   */
  readonly reconcileAfter: (dagID: string, round?: Round) => Effect.Effect<ReconcileDecide.Action>
  /** Reconcile every non-terminal workflow, one at a time: `pending` first (orphans), then the others. A failing workflow is logged and skipped. */
  readonly round: (round: Round) => Effect.Effect<void>
}

export interface Input<E extends RunnerLease.Evictable> {
  readonly store: Pick<DagStore.Interface, "getWorkflow" | "getNodes" | "listByStatus">
  /** Only the read: whoever holds the lease row is judged from `runnerID`'s point of view. */
  readonly leases: Pick<DagLease.Interface, "held">
  readonly runnerID: string
  /** The directory of the instance: what `ownsWorkflow` compares the workflow's stamp with. */
  readonly directory: string
  /** The instance's runtime entries. Read only here; evictions go through `lease.evict` and `evictMoved`. */
  readonly entries: ReadonlyMap<string, E>
  readonly events: Pick<EventV2.Interface, "publish">
  readonly lease: Pick<RunnerLease.Interface<E>, "claim" | "abandon" | "evict">
  /**
   * The instance's clock watch (`RunnerLease.Interface.noteClock`): each observation feeds it its reading of the clock
   * and takes its verdict. Without one an observation is `afterClockJump` only when its caller says so (`Round`).
   */
  readonly noteClock?: (at: number) => boolean
  /** The `Dag` service bound to a claim's token (ADR-0008 decision 5): the orphan is failed through it. */
  readonly portFor: (dagID: string, token: DagLease.Token) => Pick<Dag.Interface, "fail">
  /**
   * Take the workflow over: the loop's `recoverWorkflow`, which keeps its own guards, ends as a no-op when its claim is
   * refused, and reads the row again once it holds the claim (the row given here is the observation's, older than that).
   */
  readonly adopt: (workflow: DagStore.WorkflowRow) => Effect.Effect<void>
  /** The durable failure of a workflow whose execution location cannot be used (#948). */
  readonly failUnusable: (
    workflow: DagStore.WorkflowRow,
    location: Exclude<DagLocation.ExecutionLocation, { readonly _tag: "ok" }>,
  ) => Effect.Effect<unknown>
  /** The eviction of an entry the directory no longer owns (`movedEvictor`). */
  readonly evictMoved: (dagID: string, entry: E) => Effect.Effect<void>
}

/** The failure reason of an orphan `pending` workflow, persisted in its `WorkflowFailed` event. */
export const ORPHAN_REASON = "orphan pending workflow recovered at startup"

/** The statuses a round looks at, in order: an orphan leaves `pending` before the adoptions start. */
const LIVE_STATUSES = ["pending", "running", "paused", "stepping"] as const

const NO_JUMP: Round = { afterClockJump: false }

/** What an evaluation read, and what its action needs besides the verdict. */
interface Seen<E> {
  readonly observation: ReconcileDecide.Observation
  readonly workflow: DagStore.WorkflowRow | undefined
  readonly location: DagLocation.ExecutionLocation | undefined
  readonly entry: E | undefined
}

/**
 * What an evaluation tells the calls that took part in it: its verdict, `none` when it was interrupted before it had
 * one (they look again), or its failure. The same shape serves the evaluation under way (a flight) and the
 * re-evaluation that `reconcileAfter` calls wait for (a slot).
 */
type Flight = Deferred.Deferred<Option.Option<ReconcileDecide.Action>>

/** How a call took part in the evaluation of one workflow, as the step that it entered by decided: see `fly`. */
type Entered =
  /** Nothing was under way: this call registered the flight, evaluates, and ends the flight. */
  | { readonly _tag: "owner"; readonly flight: Flight }
  /** An evaluation is under way and its verdict answers for this call (`reconcile`). */
  | { readonly _tag: "joined"; readonly flight: Flight }
  /** An evaluation is under way; this call only waits for it to end, whatever it concludes, and then looks again. */
  | { readonly _tag: "behind"; readonly flight: Flight }
  /** A re-evaluation is already waiting for the one under way, and its verdict answers for this call too. */
  | { readonly _tag: "follower"; readonly slot: Flight }
  /** This call is the one that re-evaluates, behind the one under way, for itself and for the calls that follow it. */
  | { readonly _tag: "leader"; readonly slot: Flight }

export function make<E extends RunnerLease.Evictable>(input: Input<E>): Interface {
  const { store, leases, runnerID, directory, entries, events, lease, portFor } = input
  const { adopt, failUnusable, evictMoved, noteClock } = input
  // The evaluation under way, per workflow: at most one, registered and ended by its owner.
  const flights = new Map<string, Flight>()
  // The re-evaluation that `reconcileAfter` calls wait for, per workflow: created by the first of them while a flight is
  // under way, dropped in the step in which its leader registers the flight that is the re-evaluation.
  const trailing = new Map<string, Flight>()

  const observe = Effect.fn("DagReconciler.observe")(function* (dagID: string, round: Round) {
    // The clock first, and into the clock watch straight away: see the module comment.
    const startedAt = yield* Clock.currentTimeMillis
    const afterClockJump = (noteClock?.(startedAt) ?? false) || round.afterClockJump
    const entry = entries.get(dagID)
    // The lease row before the workflow row: see the module comment, "Order of the reads".
    const row = yield* leases.held(dagID)
    const workflow = yield* store.getWorkflow(dagID)
    // The fields that the rows from 3 on read are left at their neutral value when an earlier row ends it.
    const unread = {
      allNodesPending: false,
      ageMs: 0,
      location: "ok",
      lease: "none",
      entryTokenHeld: false,
      afterClockJump,
    } as const
    const hasEntry = entry !== undefined
    if (workflow === undefined || isTerminalWorkflowStatusValue(workflow.status)) {
      const observation = { ...unread, status: workflow?.status ?? "gone", owned: false, hasEntry }
      return { observation, workflow, location: undefined, entry } satisfies Seen<E>
    }
    // An owner-less (empty-directory) row has no owner under `ownsWorkflow`, which fails closed, so no
    // instance would ever dispose of it. A `pending` one is provably an abandoned create sequence and
    // leaving it pending forever is the zombie #948 removed: any instance may dispose of it.
    const owned =
      workflow.directory === "" ? workflow.status === "pending" : yield* DagLocation.ownsWorkflow(dagID, directory)
    if (!owned) {
      const observation = { ...unread, status: workflow.status, owned, hasEntry }
      return { observation, workflow, location: undefined, entry } satisfies Seen<E>
    }
    const location = DagLocation.resolveExecution(workflow)
    // No node proves that the create sequence did not progress (a vacuous truth for a workflow with none).
    const allNodesPending =
      workflow.status === "pending" ? (yield* store.getNodes(dagID)).every((node) => node.status === "pending") : false
    const observation = {
      status: workflow.status,
      allNodesPending,
      ageMs: startedAt - workflow.timeCreated,
      owned,
      location: location._tag === "ok" ? "ok" : "unusable",
      lease: ReconcileDecide.classifyLease(row, runnerID, startedAt),
      hasEntry,
      entryTokenHeld: hasEntry && DagLease.holds(row, entry.token),
      afterClockJump,
    } satisfies ReconcileDecide.Observation
    return { observation, workflow, location, entry } satisfies Seen<E>
  })

  /**
   * ADR-0008 decision 6, row 8: an orphan `pending` workflow is claimed, then
   * terminalized by the legal pending -> running -> failed sequence (the
   * projector accepts `WorkflowFailed` only from running or stepping, so a bare
   * fail would be dropped). Failed, not cancelled: that is the interrupted-create
   * semantics, and the reason persists in the durable event; cancelled is
   * reserved for an explicit user or agent cancel. The sequence runs inside the
   * workflow's flight, which is what keeps its `WorkflowStarted` (a real event on
   * the bus) from being adopted mid-way, as a zero-node orphan would be completed
   * instead of failed: the first-wave handler calls `reconcileAfter`, which waits
   * for this flight to end and finds the workflow failed. The bare
   * `WorkflowStarted` publish is not fenced (ADR-0008 Amendment 1; left to PR4b).
   */
  const terminalizeOrphan = Effect.fn("DagReconciler.terminalizeOrphan")(function* (dagID: string) {
    if (entries.has(dagID)) return
    let claimed: DagLease.Token | undefined
    yield* Effect.gen(function* () {
      // Failing the orphan is a runner write (decision 4): the runner holds the lease first, and a live
      // lease of another runner means that somebody drives it.
      const token = yield* lease.claim(dagID)
      if (!token) return
      claimed = token
      yield* events.publish(DagEvent.WorkflowStarted, { dagID: dagID as never, timestamp: yield* DateTime.now })
      // A rejection (a concurrent transition made it obsolete) ends the evaluation as a defect, which `round` logs.
      yield* portFor(dagID, token).fail(dagID, ORPHAN_REASON).pipe(Effect.orDie)
      yield* Effect.logWarning("DagLoop terminalized orphan pending workflow", { dagID })
    }).pipe(
      // The workflow ended: nothing renews the lease, so it is given back.
      Effect.onExit(() => lease.abandon(dagID, claimed)),
    )
  })

  const execute = Effect.fn("DagReconciler.execute")(function* (
    dagID: string,
    action: ReconcileDecide.Action,
    seen: Seen<E>,
  ) {
    const { workflow, location, entry } = seen
    switch (action._tag) {
      case "noop":
      case "renew":
        // The renewal of this tick ran ahead of the round (`RunnerLease`): nothing to write.
        return
      case "defer":
        yield* Effect.logDebug("DagReconciler left a workflow alone", { dagID, reason: action.reason })
        return
      case "evict":
        if (entry === undefined) return
        yield* action.reason === "lease-lost" ? lease.evict(dagID, entry) : evictMoved(dagID, entry)
        return
      case "fail-unrecoverable":
        if (workflow !== undefined && location !== undefined && location._tag !== "ok")
          yield* failUnusable(workflow, location)
        return
      case "terminalize-orphan":
        yield* terminalizeOrphan(dagID)
        return
      case "adopt":
        if (workflow !== undefined) yield* adopt(workflow)
        return
    }
  })

  const evaluate = Effect.fn("DagReconciler.evaluate")(function* (dagID: string, round: Round) {
    const seen = yield* observe(dagID, round)
    const action = ReconcileDecide.decide(seen.observation)
    yield* execute(dagID, action, seen)
    return action
  })

  // The three ways to enter. Each is one synchronous step, so that nothing can come between looking at the flights and
  // registering a flight (or a slot) of one's own; everything a call does after that runs under `fly`.
  const register = (dagID: string) => {
    const flight: Flight = Deferred.makeUnsafe()
    flights.set(dagID, flight)
    return flight
  }
  // `reconcile`: the evaluation under way answers.
  const joinOrOwn = (dagID: string) =>
    Effect.sync((): Entered => {
      const under = flights.get(dagID)
      return under === undefined ? { _tag: "owner", flight: register(dagID) } : { _tag: "joined", flight: under }
    })
  // `reconcileAfter`: the evaluation under way does not answer; a re-evaluation behind it does.
  const afterOrOwn = (dagID: string) =>
    Effect.sync((): Entered => {
      if (!flights.has(dagID)) return { _tag: "owner", flight: register(dagID) }
      const waiting = trailing.get(dagID)
      if (waiting !== undefined) return { _tag: "follower", slot: waiting }
      const slot: Flight = Deferred.makeUnsafe()
      trailing.set(dagID, slot)
      return { _tag: "leader", slot }
    })
  // The leader's turn, over and over until it is its own: while a flight is under way the leader stays behind it, and in
  // the step in which there is none it registers its own and gives up the slot, so a call that arrives from then on
  // waits for the next re-evaluation, not for this one (whose reads begin after this step, not before it).
  const leadOrWait = (dagID: string, slot: Flight) =>
    Effect.sync((): Entered => {
      const under = flights.get(dagID)
      if (under !== undefined) return { _tag: "behind", flight: under }
      if (trailing.get(dagID) === slot) trailing.delete(dagID)
      return { _tag: "owner", flight: register(dagID) }
    })

  /** What a flight or a slot tells the calls that waited for it, once its owner (or its leader) is done. */
  const conclude = (
    map: Map<string, Flight>,
    dagID: string,
    flight: Flight,
    exit: Exit.Exit<Option.Option<ReconcileDecide.Action>>,
  ) =>
    Effect.sync(() => {
      // The identity check: a flight that was ended is never the one a later call registered.
      if (map.get(dagID) === flight) map.delete(dagID)
      Deferred.doneUnsafe(
        flight,
        Exit.isSuccess(exit)
          ? Effect.succeed(exit.value)
          : Cause.hasInterruptsOnly(exit.cause)
            ? Effect.succeed(Option.none<ReconcileDecide.Action>())
            : Effect.failCause(exit.cause),
      )
    })

  /**
   * One call's part in the evaluation of `dagID`, as the step that it entered by (`enter`) decided: evaluate (owner),
   * take the verdict of the flight or of the slot (joined, follower), stay behind a flight until it is over (behind,
   * which has no verdict to give, so `none`), or re-evaluate for the slot (leader). `none` means "look again". The
   * flight and the slot are registered by the acquire step, which cannot be interrupted, and ended by the release
   * step, which always runs once they were: a call that is cut off anywhere leaves nothing that nobody ends.
   */
  const fly = (
    dagID: string,
    round: Round,
    enter: Effect.Effect<Entered>,
  ): Effect.Effect<Option.Option<ReconcileDecide.Action>> =>
    Effect.acquireUseRelease(
      enter,
      (entered) => {
        switch (entered._tag) {
          case "owner":
            return Effect.map(evaluate(dagID, round), Option.some)
          case "joined":
            return Deferred.await(entered.flight)
          case "follower":
            return Deferred.await(entered.slot)
          case "behind":
            // Whatever the flight concluded, it is not an answer for this call, and its failure is not this call's.
            return Deferred.await(entered.flight).pipe(
              Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.void)),
              Effect.as(Option.none<ReconcileDecide.Action>()),
            )
          default:
            // The leader: the re-evaluation that the slot stands for.
            return lead(dagID, round, entered.slot)
        }
      },
      (entered, exit) => {
        switch (entered._tag) {
          case "owner":
            return conclude(flights, dagID, entered.flight, exit)
          case "leader":
            return conclude(trailing, dagID, entered.slot, exit)
          default:
            return Effect.void
        }
      },
    )

  const lead = (dagID: string, round: Round, slot: Flight): Effect.Effect<Option.Option<ReconcileDecide.Action>> =>
    Effect.gen(function* () {
      for (;;) {
        const answer = yield* fly(dagID, round, leadOrWait(dagID, slot))
        if (Option.isSome(answer)) return answer
      }
    })

  const reconcile = Effect.fn("DagReconciler.reconcile")(function* (dagID: string, round: Round = NO_JUMP) {
    for (;;) {
      // `none`: the evaluation that was joined was interrupted before it concluded. Look again, this call may be the
      // one to evaluate.
      const answer = yield* fly(dagID, round, joinOrOwn(dagID))
      if (Option.isSome(answer)) return answer.value
    }
  })

  const reconcileAfter = Effect.fn("DagReconciler.reconcileAfter")(function* (dagID: string, round: Round = NO_JUMP) {
    for (;;) {
      // `none`: the leader of the re-evaluation was interrupted before it concluded. Look again.
      const answer = yield* fly(dagID, round, afterOrOwn(dagID))
      if (Option.isSome(answer)) return answer.value
    }
  })

  const sweep = Effect.fn("DagReconciler.round")(function* (round: Round) {
    for (const status of LIVE_STATUSES) {
      for (const workflow of yield* store.listByStatus(status)) {
        yield* reconcile(workflow.id, round).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("DagLoop reconciliation failed for workflow", { dagID: workflow.id, cause }),
          ),
        )
      }
    }
  })

  return { reconcile, reconcileAfter, round: sweep }
}

/**
 * Eviction of an entry whose workflow the instance's directory no longer owns
 * (decision 6, row 2; a session `Moved` away). The same semantics as the lease's
 * eviction in what it stops: the children, the fibers and the watchers, the
 * entry itself. It differs where the new owner is not another process:
 *
 *   - the children it cancels are the ones the node rows name, since the
 *     workflow stays in this process and no other runner restarted a node;
 *   - the dag registration of the parent session is kept: it is keyed by the
 *     session and the workflow, not by directory, the workflow is still live,
 *     and the new owner's adoption registers the same key again. Unregistering
 *     here could land after that adoption and strip the registration from a
 *     running workflow. The terminal handlers release it.
 *
 * The body runs under the entry's `evalLock`, and an entry that is gone by then
 * (another path dropped it) is left alone.
 */
export const movedEvictor = <E extends RunnerLease.Evictable>(input: {
  readonly entries: Map<string, E>
  readonly store: Pick<DagStore.Interface, "getNode">
  readonly abort: (dagID: string, nodeID: string, childSessionID: string | null) => Effect.Effect<void>
}) =>
  Effect.fn("DagReconciler.evictMoved")(function* (dagID: string, entry: E) {
    yield* entry.evalLock.withPermits(1)(
      Effect.gen(function* () {
        if (input.entries.get(dagID) !== entry) return
        for (const [nodeID, fiber] of entry.fibers) {
          const node = yield* input.store.getNode(dagID, nodeID)
          yield* input.abort(dagID, nodeID, node?.childSessionId ?? null)
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
          const watcher = entry.watchers.get(nodeID)
          if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
        }
        entry.fibers.clear()
        entry.watchers.clear()
        input.entries.delete(dagID)
      }),
    )
  })
