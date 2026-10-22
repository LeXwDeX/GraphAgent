// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DagStore } from "@opencode-ai/core/dag/store"
import type { NodeConfig, WorkflowConfig } from "./dag"
import { conditionReference, parseInputMappingReference } from "./runtime/eval"

export interface RecoveryPlan {
  config: WorkflowConfig
  replacements: { previous: string; current: string; logical: string; attempt: number }[]
  superseded: string[]
  reused: string[]
  preserved: string[]
}

const TERMINATION_REASONS = new Set(["workflow_failed", "workflow_cancelled"])

/** Rows that workflow termination interrupted (never a node's own verdict). */
function isTerminationCollateral(node: DagStore.NodeRow) {
  return (node.status === "skipped" || node.status === "aborted") && TERMINATION_REASONS.has(node.errorReason ?? "")
}

/** A new graph revision replaces affected attempts; durable old rows stay intact. */
export function planRecovery(
  config: WorkflowConfig,
  nodes: readonly DagStore.NodeRow[],
  selected: readonly string[],
  graphRev: number,
  maxAttempts: number,
): RecoveryPlan {
  if (selected.length === 0) throw new Error("Recovery requires at least one node_id")
  if (new Set(selected).size !== selected.length) throw new Error("Recovery node_ids must be unique")
  const current = nodes.filter((node) => !node.superseded)
  const currentByID = new Map(current.map((node) => [node.id, node]))
  const definitions = new Map(config.nodes.map((node) => [node.id, node]))
  for (const id of selected) {
    if (!currentByID.has(id)) throw new Error(`Recovery node is not in the current graph: ${id}`)
  }
  for (const node of current) {
    if (!definitions.has(node.id)) throw new Error(`Recovery cannot read the execution definition for node: ${node.id}`)
  }
  // Workflow termination (Dag.fail / Dag.cancel) skipped pending work and
  // aborted in-flight work without a node-level verdict. Recovery resumes that
  // interrupted work: left in place, scheduling would read these rows as
  // legitimately skipped and complete the workflow without running them.
  const affected = new Set([...selected, ...current.filter(isTerminationCollateral).map((node) => node.id)])
  for (let changed = true; changed; ) {
    changed = false
    for (const node of current) {
      if (affected.has(node.id) || !node.dependsOn.some((id) => affected.has(id))) continue
      affected.add(node.id)
      changed = true
    }
  }
  const remainingFailures = current.filter(
    (node) => !affected.has(node.id) && node.required && node.status === "failed",
  )
  if (remainingFailures.length > 0) {
    throw new Error(
      `Recovery would retain required failures; include these node_ids: ${remainingFailures.map((node) => node.id).join(", ")}`,
    )
  }
  const existingIDs = new Set(nodes.map((node) => node.id))
  const replacements = current
    .filter((node) => affected.has(node.id))
    .map((node) => {
      const previous = definitions.get(node.id)!
      const logical = previous.recovery?.logical_node_id ?? node.id
      const attempt = (previous.recovery?.attempt ?? 1) + 1
      if (attempt > maxAttempts + 1) throw new Error(`Recovery attempt ceiling exceeded for node: ${logical}`)
      const id = `${logical}__attempt_${attempt}_r${graphRev}`
      if (existingIDs.has(id)) throw new Error(`Recovery attempt ID already exists: ${id}`)
      existingIDs.add(id)
      return { previous: node.id, current: id, logical, attempt }
    })
  const remap = new Map(replacements.map((replacement) => [replacement.previous, replacement.current]))
  const mapID = (id: string) => remap.get(id) ?? id
  const mapSource = (source: string) => {
    const parsed = parseInputMappingReference(source)
    if (!parsed.ok) throw new Error(`Recovery cannot map input source "${source}": ${parsed.error}`)
    return `${mapID(parsed.nodeID)}${source.slice(parsed.nodeID.length)}`
  }
  const activeConfig = config.nodes.filter((node) => currentByID.has(node.id))
  const updatedNodes = activeConfig.map((node): NodeConfig => {
    const replacement = replacements.find((item) => item.previous === node.id)
    if (!replacement) return node
    const old = currentByID.get(node.id)!
    const conditionNode = conditionReference(node.condition)
    const condition =
      conditionNode && remap.has(conditionNode)
        ? node.condition!.replace(/^(\s*)([^.\s]+)/, (_, space: string) => `${space}${mapID(conditionNode)}`)
        : node.condition
    const { restart: _restart, cancel: _cancel, ...definition } = node
    return {
      ...definition,
      id: replacement.current,
      depends_on: node.depends_on.map(mapID),
      // Preserve prompt variable names, including implicit dependency bindings
      // and external prompt assets. Only their source attempts change.
      input_mapping: Object.fromEntries(
        Object.entries(node.input_mapping ?? Object.fromEntries(node.depends_on.map((id) => [id, id]))).map(
          ([variable, source]) => [variable, mapSource(source)],
        ),
      ),
      ...(condition !== undefined ? { condition } : {}),
      ...(node.fan_out !== undefined ? { fan_out: mapID(node.fan_out) } : {}),
      prompt_template: {
        ...node.prompt_template,
        input: {
          ...node.prompt_template.input,
          __workflow_recovery: {
            previous_node_id: node.id,
            previous_child_session_id: old.childSessionId,
            previous_status: old.status,
            previous_error: old.errorReason,
            instruction:
              "Inspect the prior session and current workspace before repeating writes or external actions. Continue from existing work where valid; this is a new execution attempt, not a rollback.",
          },
        },
      },
      ...(node.review
        ? {
            review: {
              ...node.review,
              ...(node.review.implementation_node_id
                ? { implementation_node_id: mapID(node.review.implementation_node_id) }
                : {}),
              ...(node.review.verification_node_id
                ? { verification_node_id: mapID(node.review.verification_node_id) }
                : {}),
            },
          }
        : {}),
      recovery: {
        logical_node_id: replacement.logical,
        attempt: replacement.attempt,
        previous_node_id: node.id,
      },
    }
  })
  return {
    config: { ...config, nodes: updatedNodes },
    replacements,
    superseded: [...affected],
    reused: current.filter((node) => !affected.has(node.id) && node.status === "completed").map((node) => node.id),
    preserved: current.filter((node) => !affected.has(node.id)).map((node) => node.id),
  }
}
