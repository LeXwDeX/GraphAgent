// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect } from "effect"
import { Dag } from "@/dag/dag"
import { verifyOutputFileRef } from "@/dag/runtime/output-ref"
import type { Tool } from "../tool"
import { requireOwnedWorkflow } from "./control"
import { renderResult, renderStatus } from "./render"
import type { InspectParams, Metadata } from "./schema"

export interface InspectContext {
  readonly dag: Dag.Interface
  readonly sessionID: string
}

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
      return renderStatus({ workflow, nodes, allNodes, failureReason, latestRetarget })
    }

    yield* requireOwnedWorkflow(dag, params.workflow_id, sessionID)
    const node = yield* dag.store.getNode(params.workflow_id, params.node_id).pipe(Effect.orDie)
    if (!node) {
      return yield* Effect.die(new Error(`Workflow node not found: ${params.workflow_id}/${params.node_id}`))
    }
    yield* verifyOutputFileRef(node.capturedOutput).pipe(Effect.orDie)
    return yield* renderResult(params.workflow_id, params.node_id, node, params.cursor, params.limit)
  })
