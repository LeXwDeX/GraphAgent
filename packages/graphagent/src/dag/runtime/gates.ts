// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagLoopGates from "./gates"

import { Cause, Effect } from "effect"
import { isNodeTerminalStatus, isTransitionRejection, isWorkflowTerminalStatus } from "@graphagent/core/dag/core/types"
import type { DagStore } from "@graphagent/core/dag/store"
import type { Dag } from "../dag"
import { DagLocation } from "../location"
import { Checkpoint } from "./checkpoint"
import type { DagLoopContext } from "./context"
import type { WorkflowEntry } from "./entry"

/**
 * The gates between a scheduling round and the end of a workflow (#1344): the
 * checkpoint gate that holds scheduling behind an unresolved replan verdict, the
 * cascade of skips that settles a gated subtree, and the completion check that
 * terminalizes a workflow once its graph has settled. Each re-reads the durable
 * rows before it acts, so the in-memory runtime of an entry never decides alone.
 */
export const make = (loop: Pick<DagLoopContext.Context, "store" | "runtimes" | "ctx">) => {
  const { store, runtimes, ctx } = loop

  const checkpointDisposition = Effect.fn("DagLoop.checkpointDisposition")(function* (
    dagID: string,
    checkpoint: Checkpoint.ReplanCheckpoint,
    port: Dag.Interface,
  ) {
    const attempt = port
      .pauseForCheckpoint(dagID, checkpoint.seq)
      .pipe(Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.void)))
    const first = yield* attempt
    if (first) return first
    const second = yield* attempt
    if (second) return second

    const workflow = yield* store.getWorkflow(dagID).pipe(Effect.catchCause(() => Effect.void))
    if (!workflow || workflow.status === "completed" || workflow.status === "failed" || workflow.status === "cancelled")
      return "inactive" as const
    if (workflow.status === "paused") return "paused" as const
    yield* Effect.logError(
      "DagLoop checkpoint pause failed after retries — holding scheduling in memory (fail-closed)",
      { dagID, nodeID: checkpoint.id, checkpointSeq: checkpoint.seq, durableStatus: workflow.status },
    )
    return "held" as const
  })

  const enforceCheckpointGate = Effect.fn("DagLoop.enforceCheckpointGate")(function* (
    dagID: string,
    entry: WorkflowEntry,
    nodes?: readonly DagStore.NodeRow[],
  ) {
    const checkpoint = Checkpoint.latestReplanCheckpoint(entry.config, nodes ?? (yield* store.getCurrentNodes(dagID)))
    if (!checkpoint) return false

    const disposition = yield* checkpointDisposition(dagID, checkpoint, entry.port)
    if (disposition === "paused" || disposition === "held") {
      entry.vetoHold = disposition === "held"
      entry.runtime.setPaused(true)
      return true
    }

    // A newer resume/replan/step disposed of the verdict while this
    // event waited for the loop lock. Re-read the current control state:
    // an even newer manual pause still wins, while a running workflow
    // may continue converging normally.
    entry.vetoHold = false
    const workflow = yield* store.getWorkflow(dagID)
    entry.runtime.setPaused(workflow?.status === "paused")
    entry.runtime.setStepMode(workflow?.status === "stepping")
    return false
  })

  const convergeSkippedNodes = Effect.fn("DagLoop.convergeSkippedNodes")(function* (
    dagID: string,
    entry: WorkflowEntry,
  ) {
    // D13: settle cascade-skips before spawning. A node whose dependencies
    // are all skipped can never receive a real input; publish a durable
    // NodeSkipped(orphan_cascade) wave by wave until a fixpoint so gated
    // subtrees terminalize instead of running on placeholder inputs.
    // Eagerly markSkipped so the fixpoint advances synchronously; the
    // NodeSkipped handler's isActive guard then no-ops on these events.
    for (;;) {
      const cascade = entry.runtime.getCascadeSkipNodes()
      if (cascade.length === 0) return
      for (const nodeID of cascade) {
        const node = yield* store.getNode(dagID, nodeID)
        if (!node) return
        const attempt = {
          replanAttempts: node.replanAttempts,
          nodeSeq: node.seq,
          graphRev: entry.graphRev,
        }
        const skipped = yield* entry.port.nodeSkipped(dagID, nodeID, "orphan_cascade", attempt).pipe(
          Effect.as(true),
          Effect.catchIf(isTransitionRejection, () => Effect.succeed(false)),
        )
        // A replan can replace this row between the read and publish.
        // Only advance the old runtime after the durable guarded write
        // succeeds; its WorkflowReplanned handler will rebuild later.
        if (!skipped) return
        entry.runtime.markSkipped(nodeID)
      }
    }
  })

  const checkCompletion = Effect.fn("DagLoop.checkCompletion")(function* (dagID: string) {
    const entry = runtimes.get(dagID)
    if (!entry) return
    if (!entry.runtime.isComplete()) return
    // Graph-generation fence: a replan commits its NodeCancelled rows and
    // WorkflowReplanned (graph_rev + 1) in one durable batch, but the two
    // event types are consumed by independent handlers. When the
    // cancellation handler wins, it evaluates the OBSOLETE runtime graph:
    // a cancelled required node cascades its old dependents to
    // unsatisfied, so the stale graph looks complete with a required
    // failure even though the new revision rewired them. Only the
    // runtime paired with the durable revision may terminalize the
    // workflow; the WorkflowReplanned handler rebuilds and re-checks.
    const current = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
    if (current && current.graphRev !== entry.graphRev) return
    // A reporting leaf checkpoint is already runtime-complete. Recover
    // and enforce its veto before publishing WorkflowCompleted.
    if (yield* enforceCheckpointGate(dagID, entry)) return
    // Replan registers replacement nodes before cancelling nodes from the
    // old runtime graph. Event types are consumed independently, so the
    // cancellation handler can reach this point before WorkflowReplanned
    // rebuilds the in-memory graph. Durable active nodes prove that the
    // apparent completion belongs to an obsolete graph generation.
    // Rev-view (v1.0.15 Train A): the guard read filters to the current
    // revision — superseded rows are terminal and never trip the guard,
    // and the review-outcome input below must judge only current nodes.
    const nodes = yield* store.getCurrentNodes(dagID)
    const hasUnseenActiveNode = nodes.some(
      (node) => !isNodeTerminalStatus(node.status as never) && !entry.runtime.containsNode(node.id),
    )
    if (hasUnseenActiveNode) return
    // R6 identity revalidation: the ownership predicate re-reads the
    // durable row on every check. A workflow whose durable identity was
    // repainted (identity migration) or whose location moved away no
    // longer belongs to this in-memory entry — the stale entry must not
    // publish a workflow transition (complete/fail) for it.
    if (!(yield* DagLocation.ownsWorkflow(dagID, ctx.directory))) return
    const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
    if (wf && isWorkflowTerminalStatus(wf.status as never)) return
    // paused → completed/failed is not a legal transition: a node that
    // settles while the workflow is paused leaves the graph complete but
    // parked. Completion is re-checked when the workflow leaves pause
    // (WorkflowResumed / WorkflowStepped / replan) or when it is
    // cancelled; attempting it here would only fail the handler.
    if (wf?.status === "paused") return
    // A required-node failure is a workflow FAILURE, not a cancellation —
    // "cancelled" is reserved for explicit user/agent cancels so the
    // terminal status attributes the outcome correctly (P2-1). Required
    // verdict/skip gaps are evaluated from the current durable revision.
    // settleCompletion holds the workflow lock across the decision and
    // the terminal transition; expectedGraphRev prevents a stale runtime
    // snapshot from failing a graph that recover/replan already replaced.
    yield* entry.port.settleCompletion(dagID, {
      expectedGraphRev: entry.graphRev,
      owner: { projectID: ctx.project.id, directory: ctx.directory },
      skipReviewGate: true,
      allowAcceptedSkips: true,
    })
  })

  return { checkpointDisposition, enforceCheckpointGate, convergeSkippedNodes, checkCompletion }
}

export type Interface = ReturnType<typeof make>
