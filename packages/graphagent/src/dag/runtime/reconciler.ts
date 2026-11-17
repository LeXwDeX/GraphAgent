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
 * `reconcile(dagID)` is single-flight: concurrent calls for one workflow share one
 * evaluation, so a trigger that arrives while another is mid-adoption joins it
 * instead of racing it. `round` reconciles every non-terminal workflow, orphans
 * first. The renewal tick of `RunnerLease` starts one per period, in a fiber of its
 * own and never two at once (and startup runs one, awaited), so a round that waits
 * for a worktree removal, the lifecycle lock or a user hook delays no renewal.
 *
 * What the shell does not decide: the adoption is `recoverWorkflow` (a claim, then
 * the node-level reconciliation, then the runtime entry) and still has its
 * in-process `recovering` reservation; the unusable-workspace failure is
 * `failUnusableWorkspace`. Both stay in the loop and are passed in. The other
 * triggers (a first wave, a replan with no entry, a session move) still call
 * `recoverWorkflow` themselves; they become calls of `reconcile` in PR4b.
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
  /** The in-process adoption reservations of the loop. An orphan's terminalization holds one: its `WorkflowStarted` must not be adopted. */
  readonly recovering: Set<string>
  readonly events: Pick<EventV2.Interface, "publish">
  readonly lease: Pick<RunnerLease.Interface<E>, "claim" | "abandon" | "evict">
  /**
   * The instance's clock watch (`RunnerLease.Interface.noteClock`): each observation feeds it its reading of the clock
   * and takes its verdict. Without one an observation is `afterClockJump` only when its caller says so (`Round`).
   */
  readonly noteClock?: (at: number) => boolean
  /** The `Dag` service bound to a claim's token (ADR-0008 decision 5): the orphan is failed through it. */
  readonly portFor: (dagID: string, token: DagLease.Token) => Pick<Dag.Interface, "fail">
  /** Take the workflow over: the loop's `recoverWorkflow`, which keeps its own guards and ends as a no-op when its claim is refused. */
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

export function make<E extends RunnerLease.Evictable>(input: Input<E>): Interface {
  const { store, leases, runnerID, directory, entries, recovering, events, lease, portFor } = input
  const { adopt, failUnusable, evictMoved, noteClock } = input
  const flights = new Map<string, Deferred.Deferred<Option.Option<ReconcileDecide.Action>>>()

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
   * reserved for an explicit user or agent cancel. The slot is reserved for the
   * whole sequence: its `WorkflowStarted` is a real event on the bus, and the
   * first-wave handler must not adopt the orphan mid-way (a zero-node orphan
   * would be completed instead of failed). The bare `WorkflowStarted` publish is
   * not fenced (ADR-0008 Amendment 1; left to PR4b).
   */
  const terminalizeOrphan = Effect.fn("DagReconciler.terminalizeOrphan")(function* (dagID: string) {
    if (entries.has(dagID) || recovering.has(dagID)) return
    recovering.add(dagID)
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
      Effect.ensuring(Effect.sync(() => recovering.delete(dagID))),
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

  const reconcile = Effect.fn("DagReconciler.reconcile")(function* (dagID: string, round: Round = NO_JUMP) {
    for (;;) {
      const flight = flights.get(dagID)
      if (flight === undefined) break
      // Joined: the evaluation under way answers for this call too.
      const joined = yield* Deferred.await(flight)
      if (Option.isSome(joined)) return joined.value
      // It was interrupted before it concluded: look again, this call may be the one to evaluate.
    }
    // The flight is registered by the acquire step, which cannot be interrupted, and ended by the release step,
    // which always runs once it was registered: a call that is cut off anywhere leaves no flight that nobody ends.
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const flight = Deferred.makeUnsafe<Option.Option<ReconcileDecide.Action>>()
        flights.set(dagID, flight)
        return flight
      }),
      () => evaluate(dagID, round),
      (flight, exit) =>
        Effect.sync(() => {
          flights.delete(dagID)
          Deferred.doneUnsafe(
            flight,
            Exit.isSuccess(exit)
              ? Effect.succeed(Option.some(exit.value))
              : Cause.hasInterruptsOnly(exit.cause)
                ? Effect.succeed(Option.none())
                : Effect.failCause(exit.cause),
          )
        }),
    )
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

  return { reconcile, round: sweep }
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
