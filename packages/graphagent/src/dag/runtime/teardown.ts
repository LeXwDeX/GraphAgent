// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagLoopTeardown from "./teardown"

import { Cause, Effect, Fiber } from "effect"
import { isTerminalWorkflowStatusValue } from "@graphagent/core/dag/core/types"
import type { DagStore } from "@graphagent/core/dag/store"
import { Logging } from "@graphagent/core/observability/logging"
import { boundedCancel } from "@/session/child/cancel"
import type { SessionAbortReason } from "@/session/abort-reason"
import { SessionID } from "@/session/schema"
import { DagLocation } from "../location"
import { childAbort } from "./child-failure-reason"
import type { DagLoopContext } from "./context"
import type { WorkflowEntry } from "./entry"
import { settleTerminalWorkflowWorktree } from "./worktree-completion"

/**
 * How the loop takes a workflow, or one of its children, down (#1344): the abort of a durable child session, the
 * failure of a workflow whose execution location can no longer be used, the settlement of its worktree, and the
 * retirement of the runtime entry of a workflow that ended. The terminal-event handlers and the reconciler's
 * `failUnusable` and `retire` actions end in these.
 */
export const make = (
  loop: Pick<
    DagLoopContext.Context,
    | "dag"
    | "store"
    | "events"
    | "ctx"
    | "runtimes"
    | "stateScope"
    | "promptSvc"
    | "childRuns"
    | "automation"
    | "nudge"
    | "runnerLease"
  >,
) => {
  const { dag, store, events, ctx, runtimes, stateScope, promptSvc, childRuns, automation, nudge, runnerLease } = loop

  /**
   * #948: one failure path for a workflow whose durable execution
   * location can no longer be used. The shared DagLocation verdict is
   * made by every entry point; this helper only performs the durable
   * terminalization, releases the in-memory lease registration, and
   * asks the normal wake drain to notify the parent once. The durable
   * wake row itself is the single-notification authority, so concurrent
   * callers (recovery, spawn, sweep) collapse to one report.
   */
  const failUnusableWorkspace = Effect.fn("DagLoop.failUnusableWorkspace")(function* (
    wf: DagStore.WorkflowRow,
    location: Exclude<DagLocation.ExecutionLocation, { _tag: "ok" }>,
  ) {
    const outcome = yield* dag.failUnrecoverable(wf.id, DagLocation.executionFailureReason(location)).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning("DagLoop could not terminalize a workflow with an unusable execution directory", {
              dagID: wf.id,
              location: location._tag,
              cause,
            }).pipe(Effect.as("ignored" as const)),
      ),
    )
    if (outcome !== "failed") return outcome
    yield* Effect.logWarning("DagLoop terminalized a workflow with an unusable execution directory", {
      dagID: wf.id,
      reason: location._tag,
    })
    // The workflow can never release its own registration now; do it
    // here before the terminal wake so the parent's session is not
    // pinned by a dead graph.
    yield* automation
      .unregister(SessionID.make(wf.sessionId), { kind: "dag", id: wf.id })
      .pipe(Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.void)))
    yield* nudge(wf.sessionId)
    return outcome
  })

  // Best-effort abort of a durable child session, independent of whether
  // a local wrapper fiber still exists.  Used at every replacement,
  // cancellation, failure, and workflow-terminal cleanup site.
  const abortChild = Effect.fnUntraced(function* (
    dagID: string,
    nodeID: string,
    childSessionId: string | null,
    source: string,
    abort: SessionAbortReason.Info,
  ) {
    if (!childSessionId) return
    // File-only DEBUG attribution for a future interruption whose initiator
    // is otherwise unknown (#777). Correlation IDs only; never prompt text.
    yield* Logging.backgroundDebug("lifecycle.dag.execution.aborted", {
      source,
      workflowID: dagID,
      nodeID,
      childSessionID: childSessionId,
    })
    // End the attempt's run (signal-and-return; its session cancellation is
    // bounded inside ChildRuns). A child session this process has no
    // active run for still gets a best-effort turn cancellation.
    const cancelled = yield* childRuns.cancelActive(SessionID.make(childSessionId), {
      kind: "engine",
      reason: abort.reason,
      actor: abort.actor,
    })
    if (cancelled === "not_active")
      yield* boundedCancel(promptSvc.cancel(childSessionId as never, { reason: abort }), "dag.abortChild").pipe(
        Effect.forkIn(stateScope, { startImmediately: true }),
        Effect.asVoid,
      )
  })

  // ADR-0008 decision 2: settlement is not behind the lease re-check. It
  // runs after the workflow ended, and `held` has no lease for a terminal
  // workflow (the admission guarantee), so a check here would always
  // refuse; the seam is idempotent and owner-gated instead.
  // #1030 D9-g: settlement runs on the terminal transition, before the
  // wake nudge, so the report/status read model carries its evidence. The
  // seam lives in worktree-completion (reused by E1b #1029 and a future
  // process-level reconciler); a host sweep that terminalizes without a
  // loop entry still has no settlement here until that reconciler exists.
  const settleWorkflowTerminal = (dagID: string) =>
    settleTerminalWorkflowWorktree({
      dagID,
      store,
      publish: events.publish,
      ambient: ctx,
      // #1030 D9-g: settlement and recovery/replan share one
      // per-workflow critical section, so a settlement computed for the
      // old terminal episode cannot commit the reopened episode's work.
      exclusive: (effect) => dag.exclusive(dagID, effect),
    })

  // ADR-0008 decision 6, row 1 (Amendment 3, 4b-C): the end of a runtime entry whose workflow ended or was deleted,
  // in one routine for the two ways this process learns of it. The terminal event handlers below hear of an end
  // that this process's own bus carried. An end that another process caused never reaches this bus (events do not
  // cross processes), so no handler runs here for it, and the news is the lost lease that a renewal or a spawn's
  // re-read finds, or the round's look at the entries that its scan did not list (a control op needs no lease, so
  // the renewal can go on succeeding): the reconciler's `retire` action (row 1) runs this same routine. Whichever
  // takes the entry's lock first retires the entry and does what follows; the other finds it gone, or replaced, and
  // ends right there, so the settlement and the wake of the parent follow once per entry. Returns whether this call
  // retired it.
  const retireTerminal = Effect.fn("DagLoop.retireTerminal")(function* (
    dagID: string,
    entry: WorkflowEntry,
    source: string,
  ) {
    const retired = yield* entry.evalLock.withPermits(1)(
      Effect.gen(function* () {
        // Terminal events have their own subscriber fiber per event
        // type, so a late WorkflowCompleted/Failed/Cancelled can be
        // delivered after an additive extend already reopened the
        // workflow (WorkflowReplanned), and the reconciler's verdict is
        // as old as its reads. Projectors run inside the durable publish
        // transaction, so a non-terminal durable row proves the news
        // stale: keep the new revision's fibers and runtime entry; its
        // own terminal event cleans up later. A row that is gone is a
        // deleted workflow, which is retired as an ended one.
        const durable = yield* store.getWorkflow(dagID)
        if (durable && !isTerminalWorkflowStatusValue(durable.status)) {
          yield* Effect.logDebug("DagLoop kept the entry of a workflow that is live again", {
            dagID,
            source,
            dbStatus: durable.status,
          })
          return false
        }
        // The entry may have been removed or replaced while this call
        // waited for the evalLock.
        if (runtimes.get(dagID) !== entry) return false
        // The children are stopped for the reason the durable row gives: how the workflow ended, or its deletion
        // (the session it hangs from was deleted, which cascades).
        const abort =
          durable?.status === "completed"
            ? childAbort("workflow-complete", "dag-loop")
            : durable?.status === "failed"
              ? childAbort("workflow-failed", "dag-loop")
              : durable?.status === "cancelled"
                ? childAbort("control-cancel", "parent-control")
                : childAbort("parent-session-deleted", "parent-session")
        for (const [nodeID, fiber] of entry.fibers) {
          // The child that this entry's own attempt recorded (`Evictable.attemptChild`), where it recorded one: once
          // another runner took the workflow over and restarted a node, the node row names that runner's child,
          // which this entry must not touch. An attempt that has recorded none (its spawn has not created the
          // child) falls back to the row, as the terminal handler always did.
          const own = entry.attemptChild.get(fiber)?.()
          const childSessionID = own ?? (yield* store.getNode(dagID, nodeID))?.childSessionId ?? null
          yield* abortChild(dagID, nodeID, childSessionID, "dag.loop.workflowTerminal", abort).pipe(Effect.ignore)
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
          const watcher = entry.watchers.get(nodeID)
          if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
        }
        entry.fibers.clear()
        entry.watchers.clear()
        runtimes.delete(dagID)
        return true
      }),
    )
    if (!retired) return false
    // ADR-0008: the entry is gone, so nothing renews this workflow's
    // lease any more. Give it back now, ahead of the steps below that
    // may fail: a runner that reopens the workflow (extend, recover)
    // must be able to adopt it at once, not be refused by a lease that
    // runs out only after the TTL, and a refused adoption is not retried.
    yield* runnerLease.abandon(dagID, entry.token)
    // #1030 D9-g: settle (commit + patch + remove/keep) before the
    // terminal wake reads the read model.
    yield* settleWorkflowTerminal(dagID)
    // P1-6: trigger wake on workflow terminal so the parent
    // learns the final outcome even if no idle event fires.
    // GOAL-FP-01-03: the dag registration lifetime is bound to
    // workflow state, not to wake delivery. A workflow that
    // terminalizes without a successful wake delivery must not
    // keep its registration (and the Session's ownership)
    // indefinitely. The key matches the registration key
    // (WorkflowTable.id === event dagID, per the projector);
    // the delivery drain re-registers its batch itself before
    // claiming the wake lease when a delivery is attempted.
    yield* automation.unregister(SessionID.make(entry.parentSessionID), { kind: "dag", id: dagID })
    yield* nudge(entry.parentSessionID)
    return true
  })

  return { failUnusableWorkspace, abortChild, settleWorkflowTerminal, retireTerminal }
}

export type Interface = ReturnType<typeof make>
