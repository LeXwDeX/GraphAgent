// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The call that reads one node's complete output, written the way the model
 * sends it. Parent-facing DAG text names this call instead of a prose verb
 * the tool does not have. Imports nothing so any DAG module can use it.
 */
export function workflowResultCall(workflowID: string, nodeID: string): string {
  return `workflow(${JSON.stringify({
    params: { action: "inspect", operation: "result", workflow_id: workflowID, node_id: nodeID },
  })})`
}
