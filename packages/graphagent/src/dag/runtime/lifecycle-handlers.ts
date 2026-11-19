// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagLoopLifecycleHandlers from "./lifecycle-handlers"

import { Effect, Fiber, Stream } from "effect"
import { SessionV1 } from "@graphagent/core/v1/session"
import { isTerminalWorkflowStatusValue } from "@graphagent/core/dag/core/types"
import { DagEvent } from "@graphagent/schema/dag-event"
import { SessionEvent } from "@graphagent/schema/session-event"
import { SessionID } from "@/session/schema"
import { DagLocation } from "../location"
import { childAbort } from "./child-failure-reason"
import type { DagLoopContext } from "./context"
import { guarded } from "./entry"
import type { DagReconciler } from "./reconciler"
import type { DagLoopTeardown } from "./teardown"

/**
 * The handlers of the end of a workflow (#1344): `WorkflowCompleted`, `WorkflowFailed` and `WorkflowCancelled`. An
 * entry goes to the retirement of the teardown module. A workflow with no entry still has its worktree settled, its
 * registration released and its parent woken once. They are subscribed ahead of the delivery scheduler, as they
 * were while they sat in the loop.
 */
export const subscribeTerminal = (
  loop: Pick<DagLoopContext.Context, "events" | "store" | "runtimes" | "ctx" | "automation" | "nudge">,
  operations: {
    readonly retireTerminal: DagLoopTeardown.Interface["retireTerminal"]
    readonly settleWorkflowTerminal: DagLoopTeardown.Interface["settleWorkflowTerminal"]
  },
) =>
  Effect.gen(function* () {
    const { events, store, runtimes, ctx, automation, nudge } = loop
    const { retireTerminal, settleWorkflowTerminal } = operations
    for (const def of [DagEvent.WorkflowCompleted, DagEvent.WorkflowFailed, DagEvent.WorkflowCancelled]) {
      // Deliberately NO runtimes.has filter: a workflow terminalized by a
      // control op after a failed startup recovery (e.g. recoverWorkflow
      // aborted on an unreadable persisted row) has no runtime entry but
      // may still hold a dag registration from the startup wake sweep.
      // The handler stays a no-op for events not concerning this
      // instance: the entry's retirement (`retireTerminal`) and its wake
      // remain gated on `entry`, and the no-entry release below is scoped
      // by the durable row's project — the same cross-instance guard
      // every adoption path uses.
      yield* events.subscribe(def).pipe(
        Stream.runForEach((evt) =>
          Effect.gen(function* () {
            const dagID = evt.data.dagID as string
            const entry = runtimes.get(dagID)
            if (entry) {
              // The cleanup, the lease, the settlement and the wake of the parent: the routine that the reconciler
              // runs for a workflow that another process ended (row 1). A stale event, an entry that is gone or
              // replaced already, ends in it without a trace.
              yield* retireTerminal(dagID, entry, def.type)
              return
            }
            // #1030 D9-g: settle (commit + patch + remove/keep) before the
            // terminal wake reads the read model.
            yield* settleWorkflowTerminal(dagID)
            // P1-6: trigger wake on workflow terminal so the parent
            // learns the final outcome even if no idle event fires.
            // GOAL-FP-01-03 follow-up (P2-A): no runtime entry, but the
            // startup wake sweep may have registered this non-terminal
            // row before its recovery failed. Release from the durable
            // row (session_id + project) so a control-op
            // terminalization cannot leave a permanent registration
            // with no runtime to ever clean it. Foreign-project events
            // are a no-op here.
            const wf = yield* store.getWorkflow(dagID)
            // A stale terminal event for a reopened (running) workflow must
            // not release its registration; a terminal row only event is
            // the one that owes the wake.
            if (wf && wf.projectId === ctx.project.id && isTerminalWorkflowStatusValue(wf.status)) {
              yield* automation.unregister(SessionID.make(wf.sessionId), { kind: "dag", id: dagID })
              // #948: a workflow terminalized without a runtime entry
              // (swept at host level, or recovery that never adopted)
              // still owes the parent one wake. The drain re-applies
              // execution and notification-only ownership.
              yield* nudge(wf.sessionId)
            }
          }).pipe(guarded("WorkflowTerminal")),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
    }
  })

/**
 * The handlers of the session a workflow hangs from (#1344): `SessionV1.Event.Deleted` drops the entries of its
 * workflows with the rows the cascade removed, and `SessionEvent.Moved` converges the entries with the new
 * directory of the session through the reconciler: the old owner evicts, the new one adopts. They are subscribed
 * after the delivery scheduler, as they were while they sat in the loop.
 */
export const subscribeSession = (
  loop: Pick<DagLoopContext.Context, "events" | "store" | "runtimes" | "ctx" | "nudge">,
  operations: {
    readonly abortChild: DagLoopContext.AbortChild
    readonly reconcileAfter: DagReconciler.Interface["reconcileAfter"]
  },
) =>
  Effect.gen(function* () {
    const { events, store, runtimes, ctx, nudge } = loop
    const { abortChild, reconcileAfter } = operations
    // R5 session-deletion teardown: when the parent session is removed,
    // Session.remove publishes SessionV1.Event.Deleted and the FK cascade
    // wipes the workflow + node rows. The in-memory runtime entry must go
    // with them — otherwise a later stimulus (e.g. a workflow-terminal
    // event on the deleted dagID) would still find the entry in
    // `runtimes` and interrupt live fibers / drive a workflow that no
    // longer exists durably. Mirror the workflow-terminal cleanup
    // pattern: evalLock-serialized fiber + watcher interrupts, then drop
    // the entry.
    //
    // #1030 D9-g: this teardown does NOT settle a workflow-level worktree.
    // The FK cascade removes the rows without publishing a terminal event,
    // so there is no durable row left to settle against; the worktree is
    // intentionally left for the process-level reconciler (deterministic
    // `dag-<dagID>-` name). Recorded as a known limitation in
    // dag/CONTEXT.md.
    yield* events.subscribe(SessionV1.Event.Deleted).pipe(
      Stream.runForEach((evt) =>
        Effect.gen(function* () {
          const sessionID = evt.data.sessionID as string
          // Map iteration is mutation-safe for deletions of visited
          // entries — only THIS entry is deleted, inside its own evalLock.
          for (const [dagID, entry] of runtimes) {
            if (entry.parentSessionID !== sessionID) continue
            yield* entry.evalLock.withPermits(1)(
              Effect.gen(function* () {
                for (const [nodeID, fiber] of entry.fibers) {
                  const node = yield* store.getNode(dagID, nodeID)
                  yield* abortChild(
                    dagID,
                    nodeID,
                    node?.childSessionId ?? null,
                    "dag.loop.parentSessionDeleted",
                    childAbort("parent-session-deleted", "parent-session"),
                  ).pipe(Effect.ignore)
                  yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                  const watcher = entry.watchers.get(nodeID)
                  if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                }
                entry.fibers.clear()
                entry.watchers.clear()
                runtimes.delete(dagID)
              }),
            )
          }
        }).pipe(guarded("SessionDeleted")),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    // #269 SessionMoved ownership convergence: the Moved projection
    // (core session projector) re-stamps the session's workflow rows to the
    // destination directory in the SAME durable transaction, so by the time
    // this handler runs the durable rows already agree on ONE directory.
    // Converge the in-memory side through the reconciler (decision 6): (a) the
    // instance that no LONGER owns the moved session's workflows evicts its
    // stale runtime entries (row 2, fail-closed — its directory must not keep
    // acting on them), and (b) the NEW owner adopts the session's non-terminal
    // workflows (row 10) and re-forks the serialized wake drain so a terminal
    // wake that was wedged behind the old mixed stamps delivers immediately
    // (bounded time) instead of waiting for a fresh idle event or a restart.
    // `reconcileAfter`, because the move may have committed after an evaluation
    // that is under way (a tick's) read the old stamps; in fibers of their own,
    // so one evaluation that waits (a worktree removal, a hook) holds up neither
    // the other workflows of the session nor the next Moved event.
    yield* events.subscribe(SessionEvent.Moved).pipe(
      Stream.runForEach((evt) =>
        Effect.gen(function* () {
          const sessionID = evt.data.sessionID as string
          const converge = (dagID: string, event: string) =>
            reconcileAfter(dagID).pipe(Effect.asVoid, guarded(event), Effect.forkScoped)
          // Map iteration is mutation-safe for deletions of visited entries.
          // Only entries the re-stamp moved AWAY from this instance are handed
          // over (ownsWorkflow re-reads the durable row).
          for (const [dagID, entry] of runtimes) {
            if (entry.parentSessionID !== sessionID) continue
            if (yield* DagLocation.ownsWorkflow(dagID, ctx.directory)) continue
            yield* converge(dagID, "SessionMovedEviction")
          }
          // New owner: the re-stamp moved ownership HERE.
          if (yield* DagLocation.ownsSession(sessionID, ctx.directory)) {
            // Adopt every non-terminal workflow of the moved session. The old
            // owner just cancelled its children and interrupted its fibers, so
            // without adoption the durable rows stay running/paused/stepping
            // with dead attempts and nothing ever schedules them again. The
            // adoption reconciles dead attempts with attempt identity, pausing
            // on invented failures.
            const moved = yield* store.listBySession(sessionID)
            for (const wf of moved) {
              if (!["running", "paused", "stepping"].includes(wf.status)) continue
              if (runtimes.has(wf.id)) continue
              yield* converge(wf.id, "SessionMovedAdoption")
            }
            // Wake rows that were wedged (mixed stamps → no owner) are now
            // deliverable.
            yield* nudge(sessionID)
          }
        }).pipe(guarded("SessionMoved")),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  })
