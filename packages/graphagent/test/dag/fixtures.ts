// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect } from "effect"
import type { DagStore } from "@graphagent/core/dag/store"

/**
 * Acknowledge one node's wake the way delivery does: through the batch mark,
 * on the row's current revision. A row a newer event already moved on is left
 * alone, exactly as in production. Tests use this instead of a dedicated
 * single-row write on the store.
 */
export const markNodeWakeReported = (store: DagStore.Interface, workflowId: string, nodeID: string) =>
  store
    .getNode(workflowId, nodeID)
    .pipe(
      Effect.flatMap((node) =>
        node
          ? store.markWakeBatchReported({ nodes: [node], workflows: [] })
          : Effect.die(new Error(`node ${workflowId}/${nodeID} does not exist`)),
      ),
    )

export function makeWorkflowRow(overrides: Partial<DagStore.WorkflowRow> = {}): DagStore.WorkflowRow {
  return {
    id: "wf-1",
    projectId: "proj-1",
    sessionId: "ses_parent",
    // #948: spawned workflows must have a usable execution location. Unit
    // fixtures represent normal created workflows, so default to the existing
    // test process directory.
    directory: process.cwd(),
    executionDirectory: null,
    targetFingerprint: { kind: "none" },
    title: "Test Workflow",
    status: "running",
    pauseReason: null,
    config: "{}",
    seq: 1,
    wakeReported: false,
    graphRev: 1,
    startedAt: null,
    completedAt: null,
    timeCreated: 1,
    timeUpdated: 1,
    ...overrides,
  }
}

export function makeNodeRow(overrides: Partial<DagStore.NodeRow> = {}): DagStore.NodeRow {
  return {
    id: "node-1",
    workflowId: "wf-1",
    name: "Test Node",
    workerType: "build",
    status: "pending",
    required: true,
    dependsOn: [],
    modelId: null,
    modelProviderId: null,
    childSessionId: null,
    directory: null,
    baseHead: null,
    output: undefined,
    capturedOutput: undefined,
    errorReason: null,
    errorClass: null,
    deadlineMs: null,
    wakeEligible: false,
    wakeReported: false,
    replanAttempts: 0,
    timeoutExtensions: 0,
    escalationPending: false,
    superseded: false,
    seq: 0,
    startedAt: null,
    completedAt: null,
    timeCreated: 1,
    timeUpdated: 1,
    ...overrides,
  }
}
