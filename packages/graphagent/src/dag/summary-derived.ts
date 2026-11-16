// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The summary fields that cannot be aggregated in SQL (#1027 D6b): the coverage
 * entry count and the review quality of a workflow. Both come from the same
 * computations `inspect` runs on the same rows (`DagCoverage.workflowCoverage`,
 * `DagQuality`), so the panel and the tool result cannot disagree.
 *
 * Reads stay constant in the number of workflows and nodes: the workflow rows
 * are already loaded by the caller, node rows come from one statement that
 * loads an output only where a computation reads it, and the memo skips even
 * that for a workflow whose change marker has not moved.
 */
export * as DagSummaryDerived from "./summary-derived"

import { Effect } from "effect"
import { DagStore } from "@graphagent/core/dag/store"
import type { DagSummary } from "@graphagent/schema/dag-summary"
import { DagCoverage } from "./coverage"
import { parseWorkflowConfig, type WorkflowConfig } from "./dag"
import { DagQuality } from "./quality"

export interface Derived {
  /** `inspect` coverage entries for the workflow snapshot (not per-read page gaps). */
  readonly coverageCount: number
  readonly quality: DagSummary.WorkflowQuality | null
}

type DerivedWorkflow = Pick<DagStore.WorkflowRow, "id" | "config" | "status" | "pauseReason">
type DerivedStore = Pick<DagStore.Interface, "getSummaryNodes">
type MemoStore = DerivedStore & Pick<DagStore.Interface, "getWorkflowRevisions" | "listBySession">

function deriveWith(
  config: WorkflowConfig | undefined,
  workflow: DerivedWorkflow,
  nodes: readonly DagStore.SummaryNodeRow[],
): Derived {
  return {
    coverageCount: DagCoverage.workflowCoverage({
      config,
      nodes,
      workflow: { status: workflow.status, pauseReason: workflow.pauseReason },
    }).length,
    quality: DagQuality.workflowQuality({ config, nodes }),
  }
}

/** One workflow's derived values from its row and its current-revision nodes. */
export function derive(workflow: DerivedWorkflow, nodes: readonly DagStore.SummaryNodeRow[]): Derived {
  return deriveWith(parseWorkflowConfig(workflow.config), workflow, nodes)
}

/** The derived values of several workflows, read with one node statement. */
export const forWorkflows = Effect.fn("DagSummaryDerived.forWorkflows")(function* (
  store: DerivedStore,
  workflows: readonly DerivedWorkflow[],
) {
  const derived = new Map<string, Derived>()
  if (workflows.length === 0) return derived
  const configs = new Map(workflows.map((workflow) => [workflow.id, parseWorkflowConfig(workflow.config)]))
  const outputs = new Set<string>()
  for (const workflow of workflows) {
    const config = configs.get(workflow.id)
    if (!config) continue
    for (const id of DagQuality.outputNodeIDs(config)) outputs.add(DagStore.summaryNodeKey(workflow.id, id))
  }
  const rows = yield* store.getSummaryNodes({ workflowIds: workflows.map((workflow) => workflow.id), outputs })
  const byWorkflow = new Map<string, DagStore.SummaryNodeRow[]>()
  for (const row of rows) {
    const group = byWorkflow.get(row.workflowId)
    if (group) group.push(row)
    else byWorkflow.set(row.workflowId, [row])
  }
  for (const workflow of workflows)
    derived.set(workflow.id, deriveWith(configs.get(workflow.id), workflow, byWorkflow.get(workflow.id) ?? []))
  return derived
})

export interface Memo {
  /**
   * Derived values for the session's workflows. A workflow whose change marker
   * equals the one its values were derived at keeps them; every other workflow
   * is read and derived again. The memo only skips work, it never decides a
   * value, so dropping it changes cost, not results.
   */
  readonly resolve: (
    store: MemoStore,
    sessionID: string,
    workflowIDs: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, Derived>>
}

/**
 * A per-instance memo for the summary publisher. Usage ticks arrive far more
 * often than any workflow event, and long sessions accumulate many finished
 * workflows whose derived values can never change again; neither should
 * re-parse configs and re-read review outputs.
 */
export function memo(): Memo {
  const entries = new Map<
    string,
    { readonly sessionID: string; readonly revision: string; readonly derived: Derived }
  >()
  return {
    resolve: Effect.fn("DagSummaryDerived.memo")(function* (
      store: MemoStore,
      sessionID: string,
      workflowIDs: readonly string[],
    ) {
      const resolved = new Map<string, Derived>()
      if (workflowIDs.length === 0) {
        for (const [id, entry] of entries) if (entry.sessionID === sessionID) entries.delete(id)
        return resolved
      }
      // Read the markers before the data: a change in between only makes the
      // marker older than the data, which costs one extra derivation.
      const revisions = yield* store.getWorkflowRevisions(sessionID)
      const stale = new Set<string>()
      for (const id of workflowIDs) {
        const revision = revisions.get(id)
        const entry = entries.get(id)
        if (revision !== undefined && entry?.revision === revision) resolved.set(id, entry.derived)
        else stale.add(id)
      }
      if (stale.size > 0) {
        const workflows = (yield* store.listBySession(sessionID)).filter((workflow) => stale.has(workflow.id))
        for (const [id, derived] of yield* forWorkflows(store, workflows)) {
          resolved.set(id, derived)
          const revision = revisions.get(id)
          if (revision === undefined) entries.delete(id)
          else entries.set(id, { sessionID, revision, derived })
        }
      }
      const present = new Set(workflowIDs)
      for (const [id, entry] of entries) if (entry.sessionID === sessionID && !present.has(id)) entries.delete(id)
      return resolved
    }),
  }
}

/**
 * The public summary shape for one workflow: the store aggregates plus the
 * derived values and, when known, the process-wide DAG slot count. Built
 * field by field so nothing internal can ride along into the event or the
 * HTTP body.
 */
export function toWire(
  summary: DagStore.WorkflowSummary,
  derived: Derived | undefined,
  concurrencyRunning?: number,
): DagSummary.WorkflowSummary {
  return {
    id: summary.id,
    title: summary.title,
    status: summary.status,
    graphRev: summary.graphRev,
    nodeCount: summary.nodeCount,
    completedNodes: summary.completedNodes,
    runningNodes: summary.runningNodes,
    failedNodes: summary.failedNodes,
    skippedNodes: summary.skippedNodes,
    abortedNodes: summary.abortedNodes,
    queuedNodes: summary.queuedNodes,
    escalatedNodes: summary.escalatedNodes,
    tokens: summary.tokens,
    tokensCacheRead: summary.tokensCacheRead,
    checkpointPending: summary.checkpointPending,
    ...(derived ? { coverageCount: derived.coverageCount, quality: derived.quality } : {}),
    ...(concurrencyRunning === undefined ? {} : { concurrencyRunning }),
  }
}
