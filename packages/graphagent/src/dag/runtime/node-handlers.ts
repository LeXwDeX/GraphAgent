// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagLoopNodeHandlers from "./node-handlers"

import { Effect, Fiber, Stream } from "effect"
import { toSchedulingNodes } from "@graphagent/core/dag/core/scheduling"
import { isTerminalWorkflowStatusValue } from "@graphagent/core/dag/core/types"
import { DagEvent } from "@graphagent/schema/dag-event"
import { childAbort } from "./child-failure-reason"
import type { DagLoopContext } from "./context"
import { guarded, makeForkWakeAfter, type WorkflowEntry } from "./entry"
import type { DagLoopGates } from "./gates"

/**
 * The handlers of the node events of a workflow with an entry (#1344): `NodeCompleted`, `NodeSkipped` and
 * `NodeAborted` (one handler each, settling the node in the runtime), `NodeCancelled`, `NodeRequeued`, `NodeFailed`
 * and `NodeTimeoutEscalated`. Each cross-checks the durable row under the entry's `evalLock` before it touches the
 * runtime, drops an event that a later restart or replan made stale, and then schedules and checks completion. A
 * node that ended wakes the parent after the lock, even when the body failed. They are subscribed after the first
 * wave's handler and before the control events', as they were while they sat in the loop.
 */
export const subscribe = (
  loop: Pick<DagLoopContext.Context, "events" | "store" | "runtimes" | "nudge">,
  operations: {
    readonly abortChild: DagLoopContext.AbortChild
    readonly spawnReady: DagLoopContext.SpawnReady
    readonly enforceCheckpointGate: DagLoopGates.Interface["enforceCheckpointGate"]
    readonly checkCompletion: DagLoopGates.Interface["checkCompletion"]
  },
) =>
  Effect.gen(function* () {
    const { events, store, runtimes, nudge } = loop
    const { abortChild, spawnReady, enforceCheckpointGate, checkCompletion } = operations
    const forkWakeAfter = makeForkWakeAfter(nudge)

    for (const def of [DagEvent.NodeCompleted, DagEvent.NodeSkipped, DagEvent.NodeAborted]) {
      // A completed node is an output-producing success; a skipped node is a
      // terminal no-output state that must stay distinguishable so pure-skip
      // descendants cascade instead of running (D13).
      const settle =
        def === DagEvent.NodeSkipped || def === DagEvent.NodeAborted
          ? (entry: WorkflowEntry, nodeID: string) => entry.runtime.markSkipped(nodeID)
          : (entry: WorkflowEntry, nodeID: string) => entry.runtime.markSatisfied(nodeID)
      yield* events.subscribe(def).pipe(
        Stream.filter((e) => runtimes.has(e.data.dagID as string)),
        Stream.runForEach((evt) =>
          Effect.gen(function* () {
            const dagID = evt.data.dagID as string
            const entry = runtimes.get(dagID)
            if (!entry) return
            yield* entry.evalLock
              .withPermits(1)(
                Effect.gen(function* () {
                  const nodeID = evt.data.nodeID as string
                  // Same DB cross-check as the NodeFailed handler: projection
                  // is transactional with publish, so a row that no longer
                  // matches the event's terminal status means a later
                  // restart/replan reset it — drop the stale event without
                  // touching the new generation's fiber.
                  const expected =
                    def === DagEvent.NodeSkipped ? "skipped" : def === DagEvent.NodeAborted ? "aborted" : "completed"
                  const node = yield* store.getNode(dagID, nodeID)
                  const confirmed = node?.status === expected
                  if (confirmed) {
                    if (def === DagEvent.NodeSkipped || def === DagEvent.NodeAborted) {
                      // Cancel-skip race: workflow-level cancel publishes NodeSkipped
                      // for running nodes, and this handler may win the cross-stream
                      // race against WorkflowCancelled. Deleting the fiber here
                      // uninterrupted would orphan it from the WorkflowCancelled
                      // sweep and the child session would keep running until its
                      // prompt finishes or times out. Stop it now, mirroring the
                      // NodeCancelled handler. Completed nodes keep the plain
                      // delete — their fiber published the event and is finishing.
                      const fiber = entry.fibers.get(nodeID)
                      if (fiber) {
                        const reason = "reason" in evt.data ? evt.data.reason : undefined
                        const abort =
                          reason === "agent_complete"
                            ? childAbort("workflow-complete", "dag-loop")
                            : reason === "workflow_failed"
                              ? childAbort("workflow-failed", "dag-loop")
                              : childAbort("control-cancel", "parent-control")
                        yield* abortChild(
                          dagID,
                          nodeID,
                          node?.childSessionId ?? null,
                          "dag.loop.nodeSkipped.cancel-race",
                          abort,
                        ).pipe(Effect.ignore)
                        yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                      }
                    }
                    // N3: interrupt the watcher on BOTH terminal events. A node
                    // re-timed via replan carries a REPLACED watcher in
                    // entry.watchers; the spawn-time cleanup only interrupts the
                    // original watcherFiber, so without this the replacement
                    // lingers until its deadline wake (≤ the extended timeout)
                    // before it re-reads a terminal row and exits.
                    const watcher = entry.watchers.get(nodeID)
                    if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                    entry.fibers.delete(nodeID)
                    entry.watchers.delete(nodeID)
                  }
                  if (!confirmed) {
                    yield* Effect.logDebug("DagLoop dropped stale node terminal event", {
                      dagID,
                      nodeID,
                      expected,
                      dbStatus: node?.status ?? "missing",
                    })
                  }
                  const workflow = yield* store.getWorkflow(dagID)
                  // F2: honor the veto hold — a durable "running" row must
                  // not lift the fail-closed pause a verdict gate set.
                  entry.runtime.setPaused(workflow?.status === "paused" || entry.vetoHold)
                  entry.runtime.setStepMode(workflow?.status === "stepping")
                  // Guard against stale events: a node already cancelled
                  // (markUnsatisfied) or already satisfied must not be flipped
                  // back. Mirrors the NodeFailed handler's isActive guard.
                  let checkpointHeld = false
                  if (confirmed && entry.runtime.isActive(nodeID)) {
                    settle(entry, nodeID)
                    checkpointHeld = yield* enforceCheckpointGate(dagID, entry)
                    if (checkpointHeld) {
                      yield* Effect.logWarning("DagLoop paused workflow after gate verdict: replan", {
                        dagID,
                        nodeID,
                      })
                    }
                    // In stepMode, do NOT auto-advance — wait for the next
                    // explicit step command.
                    if (!checkpointHeld && !entry.runtime.isStepMode()) yield* spawnReady(dagID)
                  }
                  if (!checkpointHeld) yield* checkCompletion(dagID)
                }),
              )
              .pipe(
                // P1-2: trigger wake check directly on node terminal — the
                // parent session may already be idle (no new idle event will
                // fire), so we can't rely on the idle subscription alone.
                Effect.onExit(forkWakeAfter(entry.parentSessionID)),
              )
          }).pipe(
            guarded(
              def === DagEvent.NodeSkipped
                ? "NodeSkipped"
                : def === DagEvent.NodeAborted
                  ? "NodeAborted"
                  : "NodeCompleted",
            ),
          ),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
    }

    yield* events.subscribe(DagEvent.NodeCancelled).pipe(
      Stream.filter((e) => runtimes.has(e.data.dagID as string)),
      Stream.runForEach((evt) =>
        Effect.gen(function* () {
          const dagID = evt.data.dagID as string
          const entry = runtimes.get(dagID)
          if (!entry) return
          const nodeID = evt.data.nodeID as string
          // Attribute the child interruption to the canceller: a replan
          // owns graph rewrites, an agent control call owns a single
          // attempt. The projection already distinguishes the two rows.
          const origin =
            evt.data.source === "control"
              ? childAbort("control-cancel", "parent-control")
              : childAbort("replan", "dag-replan")
          yield* entry.evalLock.withPermits(1)(
            Effect.gen(function* () {
              const fiber = entry.fibers.get(nodeID)
              const node = yield* store.getNode(dagID, nodeID)
              yield* abortChild(dagID, nodeID, node?.childSessionId ?? null, "dag.loop.nodeCancelled", origin).pipe(
                Effect.ignore,
              )
              if (fiber) {
                yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                entry.fibers.delete(nodeID)
              }
              const watcher = entry.watchers.get(nodeID)
              if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
              entry.watchers.delete(nodeID)
              entry.runtime.markUnsatisfied(nodeID)
              // A control cancellation can ready an optional node's
              // dependents. Without a scheduling round they would stay
              // pending and the workflow would remain running forever;
              // mirror the NodeFailed handler (spawnReady also converges
              // skip cascades before dispatching).
              if (!entry.runtime.isStepMode()) yield* spawnReady(dagID)
              yield* checkCompletion(dagID)
            }),
          )
        }).pipe(guarded("NodeCancelled")),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    // D12 budget requeue: the node row is pending again, so the in-memory
    // graph must be rebuilt from the durable rows before any later schema
    // event (typically WorkflowResumed, which arrives in the same requeue
    // transaction). Rebuilding also drops the failed-unsatisfied seed that
    // would otherwise keep the node unready. Whichever handler wins the
    // race re-checks the durable status: a requeue on a paused workflow
    // (the budget-raise order) schedules nothing here and leaves dispatch
    // to WorkflowResumed.
    yield* events.subscribe(DagEvent.NodeRequeued).pipe(
      Stream.filter((e) => runtimes.has(e.data.dagID as string)),
      Stream.runForEach((evt) =>
        Effect.gen(function* () {
          const dagID = evt.data.dagID as string
          const entry = runtimes.get(dagID)
          if (!entry) return
          yield* entry.evalLock.withPermits(1)(
            Effect.gen(function* () {
              if (runtimes.get(dagID) !== entry) return
              const workflow = yield* store.getWorkflow(dagID)
              if (!workflow || isTerminalWorkflowStatusValue(workflow.status)) return
              // D12 budget raise: the requeue can beat the NodeFailed
              // handler that cancels the failed attempt. The row is pending
              // again by now, so that handler drops its event as stale and
              // the old child would keep running unowned. A pending node
              // that still holds a runtime fiber/watcher is exactly that
              // stale attempt: interrupt it before the rebuild can schedule
              // the replacement (spawn's onInterrupt cancels the child).
              const requeued = yield* store.getNode(dagID, evt.data.nodeID as string)
              if (requeued?.status === "pending") {
                const fiber = entry.fibers.get(requeued.id)
                const watcher = entry.watchers.get(requeued.id)
                entry.fibers.delete(requeued.id)
                entry.watchers.delete(requeued.id)
                if (fiber) yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
              }
              entry.vetoHold = false
              entry.runtime.setPaused(workflow.status === "paused")
              entry.runtime.setStepMode(workflow.status === "stepping")
              entry.runtime.rebuildGraph(toSchedulingNodes(yield* store.getCurrentNodes(dagID)))
              if (workflow.status === "running" && !entry.runtime.isStepMode()) yield* spawnReady(dagID)
              yield* checkCompletion(dagID)
            }),
          )
        }).pipe(guarded("NodeRequeued")),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* events.subscribe(DagEvent.NodeFailed).pipe(
      Stream.filter((e) => runtimes.has(e.data.dagID as string)),
      Stream.runForEach((evt) =>
        Effect.gen(function* () {
          const dagID = evt.data.dagID as string
          const entry = runtimes.get(dagID)
          if (!entry) return
          yield* entry.evalLock
            .withPermits(1)(
              Effect.gen(function* () {
                const nid = evt.data.nodeID as string
                // Generation arbitration via DB status: each projector runs
                // INSIDE the durable publish transaction (core/dag/projector.ts),
                // so by the time this handler consumes the event the row
                // already reflects it. If the row is no longer "failed", a
                // later NodeRestarted/replan reset the node — this event
                // belongs to a previous generation and must not touch the
                // new one (including the fiber map, which may already hold
                // the new attempt's fiber). No generation field needed.
                const node = yield* store.getNode(dagID, nid)
                // #3: only markUnsatisfied if the runtime still tracks this
                // node as non-terminal. A stale NodeFailed event (e.g. from
                // a replan-ceiling check after the node already completed)
                // would incorrectly flip a satisfied node to unsatisfied.
                if (node?.status === "failed" && entry.runtime.isActive(nid)) {
                  const fiber = entry.fibers.get(nid)
                  const watcher = entry.watchers.get(nid)
                  entry.fibers.delete(nid)
                  entry.watchers.delete(nid)
                  yield* abortChild(
                    dagID,
                    nid,
                    node.childSessionId ?? null,
                    "dag.loop.nodeFailed.cleanup",
                    childAbort("failure-cleanup", "dag-loop"),
                  ).pipe(Effect.ignore)
                  if (fiber) yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                  if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                  entry.runtime.markUnsatisfied(nid)
                  if (!entry.runtime.isStepMode()) yield* spawnReady(dagID)
                }
                if (node?.status !== "failed") {
                  yield* Effect.logDebug("DagLoop dropped stale NodeFailed", {
                    dagID,
                    nodeID: nid,
                    dbStatus: node?.status ?? "missing",
                  })
                }
                // In stepMode, checkCompletion (which can trigger autonomous
                // fail/complete) still runs, but spawnReady is skipped —
                // stepping must NOT auto-advance after a node fails.
                yield* checkCompletion(dagID)
              }),
            )
            .pipe(Effect.onExit(forkWakeAfter(entry.parentSessionID)))
        }).pipe(guarded("NodeFailed")),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    // Timeout escalation: the node keeps RUNNING — the runtime needs no
    // state change. The event's only job is to wake the main agent so it
    // can adjudicate (extend via replan with a new timeout_ms, or
    // cancel/replan). Delivery re-reads the wake snapshot, where the
    // escalated running node now appears (timeout_extensions > 0).
    yield* events.subscribe(DagEvent.NodeTimeoutEscalated).pipe(
      Stream.filter((e) => runtimes.has(e.data.dagID as string)),
      Stream.runForEach((evt) =>
        Effect.gen(function* () {
          const dagID = evt.data.dagID as string
          const entry = runtimes.get(dagID)
          if (!entry) return
          yield* nudge(entry.parentSessionID)
        }).pipe(guarded("NodeTimeoutEscalated")),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  })
