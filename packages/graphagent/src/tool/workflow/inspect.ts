// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Cause, Effect, Option } from "effect"
import { isTerminalWorkflowStatusValue } from "@graphagent/core/dag/core/types"
import type { NodeRow } from "@graphagent/core/dag/store"
import type { Config } from "@/config/config"
import { Dag } from "@/dag/dag"
import { DagBlocks } from "@/dag/blocks"
import { DagCoverage } from "@/dag/coverage"
import { DagValidation } from "@/dag/validation"
import { verifyOutputFileRef } from "@/dag/runtime/output-ref"
import type { ChildRunView } from "@/session/child/run"
import { SessionID } from "@/session/schema"
import type { Tool } from "../tool"
import { requireOwnedWorkflow } from "./mutation"
import { renderResult, renderStatus } from "./render"
import type { InspectParams, Metadata } from "./schema"

export interface InspectContext {
  readonly dag: Dag.Interface
  readonly sessionID: string
  /** #1030 D9-h: the calling session's child runs, read-only. */
  readonly children?: Tool.ChildRuns
  /** The user's global `dag.max_total_nodes` cap; absent in harnesses without
   * a Config service, which keep the documented default. */
  readonly config?: Pick<Config.Interface, "dagGlobal">
}

/** What `extend` does with a terminal workflow, for the parent to read before it
 * tries (#1073). A live workflow takes work and needs no note. */
const TERMINAL_EXTEND: Readonly<Record<string, string>> = {
  completed:
    "extend reopens a workflow only when it completed naturally at a reporting leaf checkpoint and the fragment adds new node ids; control(complete) never reopens it. Otherwise start a bounded successor",
  failed:
    "extend is rejected for a failed workflow; use control(recover) with node_ids and expected_graph_rev, or start a bounded successor",
  cancelled:
    "extend is rejected for a cancelled workflow; use control(recover) with resume_cancelled: true, or start a bounded successor",
}

/** #1073 preflight: the limits an extend runs into, stated before it is tried.
 * `nodes.used` counts every node the workflow ever registered, the figure the
 * ceiling check uses; the limit is the lower of the workflow's own cap and the
 * user's. */
const constraintsOf = (input: {
  readonly status: string
  readonly config: ReturnType<typeof Dag.parseWorkflowConfig>
  readonly registered: number
  readonly userMaxTotalNodes: number | undefined
}) => {
  const limit = DagValidation.effectiveMaxTotalNodes(input.config?.max_total_nodes, input.userMaxTotalNodes)
  const terminal = isTerminalWorkflowStatusValue(input.status)
  return {
    terminal,
    graph_form: DagBlocks.graphForm(input.config?.nodes ?? []),
    nodes: { used: input.registered, limit, remaining: Math.max(0, limit - input.registered) },
    ...(terminal && TERMINAL_EXTEND[input.status] ? { extend: TERMINAL_EXTEND[input.status] } : {}),
  }
}

/** #1030 D9-h: every node's current attempt run, read through
 * `ChildRuns.inspect`. The durable node row names the child session; the
 * session's latest run names the run id, and `inspect` is the one read that
 * returns the run's state. */
const nodeChildRuns = (
  children: Tool.ChildRuns | undefined,
  nodes: readonly NodeRow[],
): Effect.Effect<ReadonlyMap<string, ChildRunView>> =>
  Effect.gen(function* () {
    const views = new Map<string, ChildRunView>()
    if (!children) return views
    for (const node of nodes) {
      if (!node.childSessionId) continue
      const latest = yield* children.latest(SessionID.make(node.childSessionId))
      if (Option.isNone(latest)) continue
      const view = yield* children.inspect(latest.value.id)
      if (Option.isSome(view)) views.set(node.childSessionId, view.value)
    }
    return views
  })

export const inspectWorkflow = (context: InspectContext, params: InspectParams): Effect.Effect<Tool.ExecuteResult> =>
  Effect.gen(function* () {
    const { dag, sessionID } = context
    if (params.operation === "status") {
      const workflow = yield* requireOwnedWorkflow(dag, params.workflow_id, sessionID)
      // Rev-view (v1.0.15 Train A): status is a view seam — it shows
      // the CURRENT graph revision only. Superseded replaced segments
      // stay reachable via the result seam (getNode is unfiltered).
      const nodes = yield* dag.store.getCurrentNodes(params.workflow_id).pipe(Effect.orDie)
      // #946: a cancelled/restarted superseded row still owns a
      // worktree on disk. The worktree view reads every row so those
      // pointers stay visible; the graph views above stay current-rev
      // only.
      const allNodes = yield* dag.store.getNodes(params.workflow_id).pipe(Effect.orDie)
      // #948: the failure reason lives on the durable WorkflowFailed
      // event (no new column). Surface it here so a terminal workflow
      // explains itself, including workspace_missing/unstamped.
      const failureReason = dag.store.getWorkflowFailureReason
        ? yield* dag.store.getWorkflowFailureReason(workflow.id)
        : undefined
      // #945: the latest durable retarget is the audit pointer; event
      // history keeps the full record.
      const latestRetarget = dag.store.getLatestRetarget ? yield* dag.store.getLatestRetarget(workflow.id) : undefined
      const childRuns = yield* nodeChildRuns(context.children, nodes)
      // #1031 M6: coverage is engine-owned; skipped/failed/gated nodes, a
      // declined fan-out, lane gaps, and a budget pause are listed here
      // instead of relying on the model to mention them.
      const coverage = DagCoverage.workflowCoverage({
        config: Dag.parseWorkflowConfig(workflow.config),
        nodes,
        workflow: { status: workflow.status, pauseReason: workflow.pauseReason },
      })
      // Usage is presentational: a store implementation without the summary
      // query (or a read defect) must not fail the status view.
      const summaries = yield* Effect.suspend(() => dag.store.getWorkflowSummaries(sessionID)).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed([]),
        ),
      )
      const usage = summaries.find((summary) => summary.id === workflow.id)
      const userMaxTotalNodes = context.config ? (yield* context.config.dagGlobal()).max_total_nodes : undefined
      return renderStatus({
        workflow,
        nodes,
        allNodes,
        failureReason,
        latestRetarget,
        childRuns,
        coverage,
        constraints: constraintsOf({
          status: workflow.status,
          config: Dag.parseWorkflowConfig(workflow.config),
          registered: allNodes.length,
          userMaxTotalNodes,
        }),
        ...(usage
          ? {
              usage: {
                nodeCount: usage.nodeCount,
                tokens: usage.tokens,
                tokensCacheRead: usage.tokensCacheRead,
              },
            }
          : {}),
      })
    }

    const workflow = yield* requireOwnedWorkflow(dag, params.workflow_id, sessionID)
    const node = yield* dag.store.getNode(params.workflow_id, params.node_id).pipe(Effect.orDie)
    if (!node) {
      return yield* Effect.die(new Error(`Workflow node not found: ${params.workflow_id}/${params.node_id}`))
    }
    yield* verifyOutputFileRef(node.capturedOutput).pipe(Effect.orDie)
    const currentNodes = yield* dag.store.getCurrentNodes(params.workflow_id).pipe(Effect.orDie)
    const coverage = DagCoverage.workflowCoverage({
      config: Dag.parseWorkflowConfig(workflow.config),
      nodes: currentNodes,
      workflow: { status: workflow.status, pauseReason: workflow.pauseReason },
    })
    return yield* renderResult(params.workflow_id, params.node_id, node, params.cursor, params.limit, coverage)
  })
