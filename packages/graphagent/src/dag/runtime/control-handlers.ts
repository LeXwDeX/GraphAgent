// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagLoopControlHandlers from "./control-handlers"

import { Effect, Stream } from "effect"
import { isWorkflowTerminalStatus, PAUSE_REASON_BUDGET_EXHAUSTED } from "@graphagent/core/dag/core/types"
import { DagEvent } from "@graphagent/schema/dag-event"
import type { DagLoopContext } from "./context"
import { guarded, type WorkflowEntry } from "./entry"
import type { DagLoopGates } from "./gates"
import type { DagReconciler } from "./reconciler"

/**
 * The handler of `WorkflowStarted` (#1344): a first wave goes to the reconciler.
 * It is subscribed before the node handlers, as it was while it sat in the loop.
 */
export const subscribeStarted = (
  loop: Pick<DagLoopContext.Context, "events">,
  operations: { readonly reconcileAfter: DagReconciler.Interface["reconcileAfter"] },
) =>
  Effect.gen(function* () {
    const { events } = loop
    const { reconcileAfter } = operations
    // A first wave is the reconciler's like any other adoption (decision 6). `reconcileAfter`: an evaluation
    // under way may have looked before the workflow existed, and the orphan path publishes this very event from
    // inside its own evaluation, which the call waits for and then finds the workflow failed.
    yield* events.subscribe(DagEvent.WorkflowStarted).pipe(
      Stream.runForEach((evt) =>
        reconcileAfter(evt.data.dagID as string).pipe(Effect.asVoid, guarded("WorkflowStarted")),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  })

/**
 * The handlers of the parent's control events (#1344): `WorkflowPaused`,
 * `WorkflowStepped` and `WorkflowResumed`. Each re-syncs the entry's control
 * flags from the durable row under its `evalLock`. A step and a resume then
 * schedule and check completion; a budget pause nudges the parent.
 */
export const subscribeControl = (
  loop: Pick<DagLoopContext.Context, "events" | "store" | "runtimes" | "nudge">,
  operations: {
    readonly spawnReady: DagLoopContext.SpawnReady
    readonly convergeSkippedNodes: DagLoopGates.Interface["convergeSkippedNodes"]
    readonly checkCompletion: DagLoopGates.Interface["checkCompletion"]
  },
) =>
  Effect.gen(function* () {
    const { events, store, runtimes, nudge } = loop
    const { spawnReady, convergeSkippedNodes, checkCompletion } = operations
    // Workflow-control handlers cross-check the durable row under the
    // evalLock before mutating runtime flags: projection is transactional
    // with publish, so the row reflects this event or a later one — never
    // an earlier one. Applying the event's implied flags blindly lets a
    // cross-stream ordering (pause/resume/step race) clobber a newer
    // control decision. Mirrors the node handlers' DB arbitration.
    const refreshControlFlags = Effect.fnUntraced(function* (dagID: string, entry: WorkflowEntry) {
      const workflow = yield* store.getWorkflow(dagID)
      if (!workflow || isWorkflowTerminalStatus(workflow.status as never)) return undefined
      // F2: honor the veto hold — see WorkflowEntry.vetoHold.
      entry.runtime.setPaused(workflow.status === "paused" || entry.vetoHold)
      entry.runtime.setStepMode(workflow.status === "stepping")
      return workflow
    })

    yield* events.subscribe(DagEvent.WorkflowPaused).pipe(
      Stream.filter((e) => runtimes.has(e.data.dagID as string)),
      Stream.runForEach((evt) =>
        Effect.gen(function* () {
          const dagID = evt.data.dagID as string
          const entry = runtimes.get(dagID)
          if (!entry) return
          const workflow = yield* entry.evalLock.withPermits(1)(refreshControlFlags(dagID, entry))
          // #1031 M5: a budget pause is an immediate report boundary, not a
          // five-minute reminder. Nudge now; the wake table's
          // budget-paused predicate makes the batch deliverable, and the
          // durable wake receipt keeps it to exactly one turn.
          if (workflow?.status === "paused" && workflow.pauseReason === PAUSE_REASON_BUDGET_EXHAUSTED) {
            yield* nudge(entry.parentSessionID)
          }
        }).pipe(guarded("WorkflowPaused")),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* events.subscribe(DagEvent.WorkflowStepped).pipe(
      Stream.filter((e) => runtimes.has(e.data.dagID as string)),
      Stream.runForEach((evt) =>
        Effect.gen(function* () {
          const dagID = evt.data.dagID as string
          const entry = runtimes.get(dagID)
          if (!entry) return
          yield* entry.evalLock.withPermits(1)(
            Effect.gen(function* () {
              // F2 (DAG-03): resume/step is the parent's explicit control —
              // release the fail-closed veto hold before the flag re-sync.
              entry.vetoHold = false
              const workflow = yield* refreshControlFlags(dagID, entry)
              if (workflow?.status !== "stepping") return
              // Dag.step validated "no in-flight node" on a DB snapshot
              // taken outside this evalLock; a terminal-event handler can
              // spawn in between (its DB status read predated the stepped
              // projection). Spawning now would put a second node in
              // flight under stepping — leave advancement to the next
              // explicit step command instead.
              if (entry.runtime.hasRunning()) return
              yield* spawnReady(dagID)
              // spawnReady may have paused on a durable checkpoint. Only
              // converge and terminalize when that scheduling gate stayed
              // open. These operations dispatch no additional child.
              if (entry.runtime.isPaused()) return
              yield* convergeSkippedNodes(dagID, entry)
              yield* checkCompletion(dagID)
            }),
          )
        }).pipe(guarded("WorkflowStepped")),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* events.subscribe(DagEvent.WorkflowResumed).pipe(
      Stream.filter((e) => runtimes.has(e.data.dagID as string)),
      Stream.runForEach((evt) =>
        Effect.gen(function* () {
          const dagID = evt.data.dagID as string
          const entry = runtimes.get(dagID)
          if (!entry) return
          yield* entry.evalLock.withPermits(1)(
            Effect.gen(function* () {
              // F2 (DAG-03): resume/step is the parent's explicit control —
              // release the fail-closed veto hold before the flag re-sync.
              entry.vetoHold = false
              const workflow = yield* refreshControlFlags(dagID, entry)
              if (workflow?.status === "running") yield* spawnReady(dagID)
              // A workflow can be resumed with every node already settled
              // (e.g. recovery-pause on a single lost node). Without this,
              // nothing else re-runs completion and the workflow hangs in
              // running forever.
              yield* checkCompletion(dagID)
            }),
          )
        }).pipe(guarded("WorkflowResumed")),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  })
