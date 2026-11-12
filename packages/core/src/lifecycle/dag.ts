// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { getValidNextNodeStatuses, getValidNextWorkflowStatuses } from "../dag/core/types"
import type { NodeStatus, WorkflowStatus } from "../dag/core/types"
import type { TransitionTable } from "./transition"
import { valuesOf } from "./vocabulary"

/**
 * Read-only DAG bridge (#1069 P8).
 *
 * The DAG already owns the authoritative state machine
 * (`packages/core/src/dag/core/types.ts`) and durable event/projector path.
 * This bridge only exposes those rules as lifecycle `TransitionTable`s so the
 * shared vocabulary can validate DAG domains without a second state machine
 * and without reading or writing DAG storage. Workflow/node writes stay in
 * `dag.*`; nothing here publishes `lifecycle.transitioned` on their behalf.
 *
 * Creation values are the ones the DAG's own create path writes: `pending`
 * for both domains.
 */

const isWorkflowStatus = (value: string): value is WorkflowStatus => valuesOf("workflow").includes(value)

const isNodeStatus = (value: string): value is NodeStatus => valuesOf("node").includes(value)

export const WORKFLOW_TRANSITION_TABLE: TransitionTable = {
  domain: "workflow",
  next: (from) =>
    from === null ? ["pending"] : isWorkflowStatus(from) ? getValidNextWorkflowStatuses(from) : [],
}

export const NODE_TRANSITION_TABLE: TransitionTable = {
  domain: "node",
  next: (from) => (from === null ? ["pending"] : isNodeStatus(from) ? getValidNextNodeStatuses(from) : []),
}
