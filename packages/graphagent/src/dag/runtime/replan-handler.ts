// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagLoopReplanHandler from "./replan-handler"

import { Cause, Clock, Effect, Fiber, Stream } from "effect"
import { toSchedulingNodes } from "@graphagent/core/dag/core/scheduling"
import { DagEvent } from "@graphagent/schema/dag-event"
import { SessionPrompt } from "@/session/prompt"
import { Dag, parseWorkflowConfig } from "../dag"
import { childAbort } from "./child-failure-reason"
import type { DagLoopContext } from "./context"
import { guarded } from "./entry"
import type { DagLoopGates } from "./gates"
import type { DagReconciler } from "./reconciler"
import { makeDeadlineWatcher } from "./spawn"

/**
 * The handler of `WorkflowReplanned` (#1344): a replan swaps the graph of a
 * workflow that has an entry. Under the entry's `evalLock` it releases the veto
 * hold, rebuilds the runtime from the current revision, re-times the running
 * nodes the replan gave a new `timeout_ms`, interrupts the attempts the replan
 * reset, and schedules the new graph. A workflow without an entry goes to the
 * reconciler.
 */
export const subscribe = (
  loop: Pick<DagLoopContext.Context, "events" | "store" | "runtimes" | "stateScope" | "promptSvc">,
  operations: {
    readonly abortChild: DagLoopContext.AbortChild
    readonly spawnReady: DagLoopContext.SpawnReady
    readonly checkCompletion: DagLoopGates.Interface["checkCompletion"]
    readonly reconcileAfter: DagReconciler.Interface["reconcileAfter"]
  },
) =>
  Effect.gen(function* () {
    const { events, store, runtimes, stateScope, promptSvc } = loop
    const { abortChild, spawnReady, checkCompletion, reconcileAfter } = operations
    yield* events.subscribe(DagEvent.WorkflowReplanned).pipe(
      Stream.runForEach((evt) =>
        Effect.gen(function* () {
          const dagID = evt.data.dagID as string
          const entry = runtimes.get(dagID)
          if (!entry) {
            // No entry: the reconciler adopts it (or leaves it to its holder). `reconcileAfter`, because an
            // evaluation under way (a tick's, a first wave's) may have looked before this replan committed.
            yield* reconcileAfter(dagID)
            return
          }
          const handled = yield* entry.evalLock.withPermits(1)(
            Effect.gen(function* () {
              // A stale terminal event for the run this replan reopened can
              // drop the runtime entry while this handler waits for the
              // evalLock. Scheduling against that dead entry would silently
              // do nothing; recovery owns the new revision instead.
              if (runtimes.get(dagID) !== entry) return false
              const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
              // F2 (DAG-03): a replan is the parent's explicit disposition
              // of the verdict — release the fail-closed veto hold and
              // re-sync the control flags from the durable row (this
              // handler never refreshed them, so a hold set by the verdict
              // gate would otherwise silence the trailing spawnReady
              // forever and the corrective nodes would never run).
              entry.vetoHold = false
              entry.runtime.setPaused(wf?.status === "paused")
              entry.runtime.setStepMode(wf?.status === "stepping")
              const oldConfig = entry.config
              if (wf) {
                entry.config = parseWorkflowConfig(wf.config)
                entry.graphRev = wf.graphRev
                // #945: a retarget rebinds the workflow workspace. New
                // attempts must spawn in the durable execution directory.
                entry.executionDirectory = wf.executionDirectory ?? wf.directory
              }
              // Rev-view (v1.0.15 Train A): THE aggregation filter point.
              // The rebuild input is the CURRENT graph revision only —
              // superseded rows (cancelled via replan, or terminal
              // failures the fragment bypassed) must not re-seed as
              // required-unsatisfied, or the wake-up bug fails a workflow
              // on its replaced segment despite the new path succeeding.
              // The re-time loop below only sees running rows (superseded
              // rows are terminal), so the filter changes nothing there.
              const nodes = yield* store.getCurrentNodes(dagID)
              entry.runtime.rebuildGraph(toSchedulingNodes(nodes))
              // Timeout extension (Q6): a running node gets a recomputed
              // deadline (now + new timeout) ONLY when the replan carries a
              // NEW worker_config.timeout_ms for it (§3.7) AND the node
              // actually needs re-timing (deadline elapsed or escalation
              // pending — see the gate below). Restarted nodes are pending
              // here — their new attempt spawns a fresh watcher via
              // spawnReady.
              const newConfig = entry.config
              for (const node of nodes) {
                if (node.status !== "running") continue
                const frag = newConfig?.nodes.find((candidate) => candidate.id === node.id)
                if (!frag) continue
                const oldTimeoutMs =
                  oldConfig?.nodes.find((candidate) => candidate.id === node.id)?.worker_config?.timeout_ms ??
                  oldConfig?.node_defaults?.worker_config?.timeout_ms ??
                  Dag.DEFAULT_WORKFLOW_CONFIG.nodeTimeoutMs
                const fragTimeoutMs =
                  frag.worker_config?.timeout_ms ??
                  newConfig?.node_defaults?.worker_config?.timeout_ms ??
                  Dag.DEFAULT_WORKFLOW_CONFIG.nodeTimeoutMs
                // §3.7: re-time only when the replan carries a NEW
                // timeout_ms. The persisted config behind WorkflowReplanned
                // is the MERGED config — every non-cancel survivor keeps its
                // definition — so a node the fragment never mentioned, or
                // re-specified with an unchanged/omitted timeout_ms,
                // matches here with its OLD timeout.
                if (fragTimeoutMs == null || fragTimeoutMs === oldTimeoutMs) continue
                const now = yield* Clock.currentTimeMillis
                // Cap gate (A1) + delivery gate (Q2): both are SKIP
                // conjuncts on this re-time path. The watchdog never
                // re-times — it only proposes escalations. The other
                // caller of nodeExtendTimeout, Dag.extendTimeout, applies
                // the same two gates (A1 in its own body, Q2 inside the
                // command).
                //   A1: a changed timeout alone must not move a healthy
                //   deadline forward. An agent replanning BEFORE each
                //   deadline with cycling values (10m→20m→10m…) would push
                //   the deadline away forever without a single escalation
                //   firing, so the extension count never climbs and the
                //   ≈21× cap is bypassed. Re-time only when the current
                //   deadline already elapsed or an escalation awaits
                //   adjudication; a gated-off node keeps its deadline and
                //   the self-renewing watcher escalates it the moment it
                //   passes. A null deadline is treated as elapsed —
                //   re-timing is what re-establishes supervision.
                //   Q2: an escalated node whose wake has NOT been delivered
                //   (escalationPending ∧ ¬wakeReported) is skipped too.
                //   Adjudication must follow delivery — otherwise the
                //   re-time below would call nodeExtendTimeout, which clears
                //   escalation_pending and marks wake_reported, silently
                //   adjudicating an escalation the main agent never saw
                //   (D2). The node keeps its elapsed deadline and the
                //   self-renewing watcher re-escalates toward the cap; the
                //   wake is delivered normally. This is a SKIP conjunct, not
                //   a pass-through disjunct — the disjunct form is swamped
                //   by the deadlineElapsed case on the public path and is a
                //   no-op there (cons-F1).
                if (
                  (!node.escalationPending && node.deadlineMs != null && node.deadlineMs > now) ||
                  (node.escalationPending && !node.wakeReported)
                )
                  continue
                // N1: write the new deadline FIRST. nodeExtendTimeout
                // acquires the workflow lock and can fail or block; if the
                // write never lands, the old watcher must keep supervising
                // the old deadline — interrupting it beforehand would leave
                // a RUNNING node with no watcher, no escalation, and a
                // defeated cap backstop (§5-5).
                // D1: one node's failed extend must not abort the rest of
                // the handler — an uncaught failure propagates to
                // guarded("WorkflowReplanned") and skips the stale-fiber
                // sweep below plus spawnReady/checkCompletion, leaving
                // restarted nodes pending with nobody to schedule them.
                // A failed write also leaves the deadline unmoved, so the
                // old watcher keeps supervising (N1) — this path must not
                // touch it. Interruption still propagates: hasInterrupts is
                // a structural check, whereas Cause.interruptors collects
                // only DEFINED fiber IDs and ignores interrupt reasons
                // carrying none — those would be swallowed as errors here.
                const written = yield* entry.port
                  .nodeExtendTimeout(dagID, node.id, now + fragTimeoutMs, {
                    replanAttempts: node.replanAttempts,
                    ...(node.childSessionId ? { childSessionID: node.childSessionId } : {}),
                  })
                  .pipe(
                    Effect.catchCause((cause) =>
                      Cause.hasInterrupts(cause)
                        ? Effect.failCause(cause)
                        : Effect.logWarning(
                            "DagLoop replan re-time failed; keeping the old watcher and continuing the batch",
                            { dagID, nodeID: node.id, cause },
                          ).pipe(Effect.as(-1)),
                    ),
                  )
                // Negative verdict: -1 (write failure, mapped above), -2
                // (Q2 delivery-gate rejection), or -3 (cumulative timeout
                // cap exhausted). In every case no deadline was written
                // and the node remains running, so the old watcher
                // must keep supervising the elapsed deadline and re-escalating
                // toward the cap (N1: a running node is never left without a
                // watcher). Clearing the watcher here would orphan the node and
                // defeat the cap backstop.
                if (written < 0) continue
                if (written === 0) {
                  // 0 = TERMINAL rejection: the status='running' guard rejected
                  // the write — the node terminalized between the getNodes read
                  // and this command. Only THIS meaning reaches the branch now
                  // (C1 split the Q2 case into -2 above). No deadline was
                  // written; stop the old watcher and do not install one for a
                  // row the command refused to touch.
                  const deadWatcher = entry.watchers.get(node.id)
                  if (deadWatcher) yield* Fiber.interrupt(deadWatcher).pipe(Effect.ignore)
                  entry.watchers.delete(node.id)
                  yield* Effect.logWarning("DagLoop replan re-time skipped — node no longer running", {
                    dagID,
                    nodeID: node.id,
                  })
                  continue
                }
                // Write committed: install the re-armed watcher BEFORE
                // interrupting the old one so supervision is never absent.
                // F8's original race is benign in this order — the old
                // watcher's next read sees the future deadline and sleeps;
                // an escalation already in flight (lock-serialized behind
                // this write) only adds a counted extension toward the cap,
                // it never removes supervision. Its sole residue is re-setting
                // escalation_pending on the now-extended node, which costs one
                // redundant wake and permits one extra re-time via the gate
                // above — cosmetic; the cap accounting still holds because the
                // count did climb.
                const newWatcher = yield* makeDeadlineWatcher({
                  dagID,
                  nodeID: node.id,
                  attempt: {
                    replanAttempts: node.replanAttempts,
                    ...(node.childSessionId ? { childSessionID: node.childSessionId } : {}),
                  },
                  timeoutMs: fragTimeoutMs,
                  maxTimeoutExtensions:
                    newConfig?.max_timeout_extensions ?? Dag.DEFAULT_WORKFLOW_CONFIG.maxTimeoutExtensions,
                  scope: stateScope,
                }).pipe(
                  Effect.provideService(Dag.Service, entry.port),
                  Effect.provideService(SessionPrompt.Service, promptSvc),
                  Effect.forkScoped,
                )
                const oldWatcher = entry.watchers.get(node.id)
                entry.watchers.set(node.id, newWatcher)
                if (oldWatcher) yield* Fiber.interrupt(oldWatcher).pipe(Effect.ignore)
                yield* Effect.logInfo("DagLoop extended node deadline via replan", {
                  dagID,
                  nodeID: node.id,
                  newDeadlineMs: now + fragTimeoutMs,
                })
              }
              // Replan resets restarted nodes to pending. Old fibers of nodes
              // that are no longer running/queued must be interrupted here:
              // nothing else will (there is no NodeRestarted subscriber), and
              // a leftover fiber's timeout path publishes NodeFailed — a legal
              // pending→failed transition guardNode cannot reject — poisoning
              // the new generation. Mirrors the workflow-terminal sweep.
              for (const [nodeID, fiber] of [...entry.fibers]) {
                const node = nodes.find((n) => n.id === nodeID)
                if (node && (node.status === "running" || node.status === "queued")) continue
                yield* abortChild(
                  dagID,
                  nodeID,
                  node?.childSessionId ?? null,
                  "dag.loop.replan.cleanup",
                  childAbort("replan", "dag-replan"),
                ).pipe(Effect.ignore)
                yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                const watcher = entry.watchers.get(nodeID)
                if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                entry.fibers.delete(nodeID)
                entry.watchers.delete(nodeID)
              }
              yield* spawnReady(dagID)
              yield* checkCompletion(dagID)
              return true
            }),
          )
          // Outside the lock: the evaluation takes the entry's lock itself (an eviction, an adoption).
          if (!handled) yield* reconcileAfter(dagID)
        }).pipe(guarded("WorkflowReplanned")),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  })
