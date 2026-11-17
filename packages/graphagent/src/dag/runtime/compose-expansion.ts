// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagComposeExpansion from "./compose-expansion"

import { Effect, Option } from "effect"
import { isTransitionRejection } from "@graphagent/core/dag/core/types"
import type { DagStore } from "@graphagent/core/dag/store"
import type { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { DagCompose } from "../compose"
import type { Dag, NodeConfig, NodeExecutionAttempt } from "../dag"
import { DagValidation } from "../validation"

/**
 * Admission-time expansion of a compose slot (#1158), the counterpart of the
 * `fan_out` branch in the scheduler's admission seam (ADR-0004). The scheduler
 * never spawns a node that carries `expand`: once its split node has settled, the
 * slot is replaced through the durable extend path by the plan's children and the
 * join node under its id, and the `WorkflowReplanned` handler schedules the
 * reshaped graph. The marker lives in the persisted definition, so a crash
 * before the extend commits plans again on the next round and gets the same ids.
 *
 * Expanding never fails or parks the workflow. A plan that cannot be expanded
 * degrades to one fallback worker that takes the whole task, and when even that
 * does not fit the graph, the slot itself fails with `compose_capacity` and
 * takes the failure semantics of its own `required`. What decides all of this is
 * `DagCompose.planExpansion`; this module only reads the state it needs, writes
 * the result and reports.
 *
 * The other end of the expansion is `admitJoin`: when the join node it left
 * behind becomes ready, it is checked against what its children produced before
 * any model is asked, and a join node with nothing it needs fails the way a slot
 * does, with its own `required` deciding what that costs.
 */

/** The error class a slot fails with when neither the expansion nor the fallback fits the graph. */
export const CAPACITY = "compose_capacity"
/** The error class a slot fails with when its composer can no longer be used at all. */
export const UNAVAILABLE = "compose_unavailable"

export interface Input {
  /** The runner's writes: the entry's port, so a lost lease refuses them. */
  readonly port: Pick<Dag.Interface, "extend" | "nodeFailed">
  readonly agents: Pick<Agent.Interface, "list">
  readonly dagID: string
  /** The slot as persisted: the definition that carries `expand`. */
  readonly slot: NodeConfig
  /** The workflow's rows of this scheduling round. */
  readonly nodes: readonly DagStore.NodeRow[]
  /** What the round read of the slot, so a parent's replan or cancel in between wins. */
  readonly attempt: NodeExecutionAttempt
}

/**
 * Expands the slot, or degrades it, or fails it. Resolves when the durable write
 * (if any) is made; the caller returns to let the replanned graph be scheduled.
 */
export const expand = Effect.fn("DagComposeExpansion.expand")(function* (input: Input) {
  const { port, dagID, slot, nodes, attempt } = input
  const fence = { nodeID: slot.id, attempt }
  // The end of the line: the slot fails, with the reason in its row and in the log. Its `required` decides what that costs.
  const giveUp = Effect.fn("DagComposeExpansion.giveUp")(function* (reason: string, errorClass?: string) {
    yield* Effect.logWarning("DAG compose slot failed: its expansion cannot be made", {
      dagID,
      nodeID: slot.id,
      reason,
      ...(errorClass !== undefined ? { errorClass } : {}),
    })
    yield* port.nodeFailed(dagID, slot.id, reason, "exec_failed", attempt, errorClass).pipe(Effect.ignore)
  })

  const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
  // Only the user's global layer may widen what a workflow spends: `dag.compose` is stripped from project files.
  const limits = DagCompose.limits(config ? yield* config.dagGlobal() : undefined)
  const catalog = DagCompose.catalogFrom(yield* input.agents.list())
  const resolution = DagCompose.resolve(catalog, slot.worker_type)
  if (!resolution.available) {
    // The composer itself is gone or no longer has anything to expand into, so there is no fallback worker either.
    yield* giveUp(`Compose expansion failed: ${resolution.reason}`, UNAVAILABLE)
    return
  }

  const existingNodeIDs = new Set(nodes.map((candidate) => candidate.id))
  // `Dag.extend` replaces a pending node and keeps a terminal one, so a fallback id some other node already holds
  // would either overwrite that node's work or let the join read its result as the fallback's. Fail instead.
  const fallbackTaken = existingNodeIDs.has(DagCompose.fallbackID(slot.id))
  const fallbackCollision = `Compose expansion failed: node "${DagCompose.fallbackID(slot.id)}" already exists, so the slot cannot degrade to its fallback worker`
  const plan = DagCompose.planExpansion({
    slot,
    composer: resolution.composer,
    limits,
    source: nodes.find((candidate) => candidate.id === slot.expand),
    existingNodeIDs,
  })
  if (plan.kind === "fallback" && fallbackTaken) {
    yield* giveUp(fallbackCollision)
    return
  }
  const first = yield* port.extend(dagID, plan.nodes, fence).pipe(Effect.result)
  if (first._tag === "Success") {
    yield* reportDegraded(dagID, slot.id, plan)
    return
  }
  // A stale fence means the parent reshaped the slot first; its replan handler schedules the current graph.
  if (isTransitionRejection(first.failure)) return

  // The one-worker fallback was what was refused: nothing smaller is left to try.
  if (plan.kind === "fallback") {
    const { reason, errorClass } = refusal(first.failure)
    yield* giveUp(reason, errorClass)
    return
  }
  // The expanded graph was refused (a node ceiling, most likely). One fallback worker is smaller; try it.
  if (fallbackTaken) {
    yield* giveUp(fallbackCollision)
    return
  }
  const smaller = DagCompose.degrade(
    slot,
    resolution.composer,
    `the expanded graph was rejected: ${message(first.failure)}`,
  )
  const second = yield* port.extend(dagID, smaller.nodes, fence).pipe(Effect.result)
  if (second._tag === "Success") {
    yield* reportDegraded(dagID, slot.id, smaller)
    return
  }
  if (isTransitionRejection(second.failure)) return
  const { reason, errorClass } = refusal(second.failure)
  yield* giveUp(reason, errorClass)
})

export interface JoinInput {
  /** The runner's writes: the entry's port, so a lost lease refuses them. */
  readonly port: Pick<Dag.Interface, "nodeFailed">
  readonly dagID: string
  /** The join node as persisted: the definition that carries `join`. */
  readonly node: NodeConfig
  /** The workflow's rows of this scheduling round. */
  readonly nodes: readonly DagStore.NodeRow[]
  /** What the round read of the node, so a parent's replan or cancel in between wins. */
  readonly attempt: NodeExecutionAttempt
}

/**
 * The join node's admission check (#1158): resolves `true` when the node may go
 * on to be spawned, and `false` when it was refused here, which is a durable
 * failure of the node with `compose_required_missing` or `compose_no_results`.
 * A refused join node never reaches a model. A write that a stale attempt or a
 * lost lease refused leaves the node pending and also resolves `false`, so a
 * round that no longer owns the node does not spawn it. A node with no `join`
 * is not one this applies to, and passes.
 *
 * The children are read by the node ids the join record holds. A recovery
 * rewrites that record together with the join node it replaces (`planRecovery`),
 * so the ids name the attempts that count and a superseded one is not read as if
 * it were current.
 */
export const admitJoin = Effect.fn("DagComposeExpansion.admitJoin")(function* (input: JoinInput) {
  const { port, dagID, node, nodes, attempt } = input
  if (node.join === undefined) return true
  const rows = new Map(nodes.map((row) => [row.id, row]))
  const verdict = DagCompose.checkJoin(node.join, (id) => rows.get(id))
  if (verdict.kind === "run") return true
  yield* Effect.logWarning("DAG compose join refused: its children left nothing it needs", {
    dagID,
    nodeID: node.id,
    errorClass: verdict.errorClass,
    reason: verdict.reason,
  })
  yield* port.nodeFailed(dagID, node.id, verdict.reason, "exec_failed", attempt, verdict.errorClass).pipe(Effect.ignore)
  return false
})

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A graph the ceilings have no room for is `compose_capacity`; any other refusal is a plain expansion failure. */
const refusal = (error: unknown): { reason: string; errorClass?: string } =>
  error instanceof DagValidation.StructuralValidationError
    ? { reason: `Compose expansion does not fit the graph: ${message(error)}`, errorClass: CAPACITY }
    : { reason: `Compose expansion failed: ${message(error)}` }

const reportDegraded = (dagID: string, nodeID: string, plan: DagCompose.Expansion) =>
  plan.kind === "fallback"
    ? Effect.logWarning("DAG compose expansion degraded; one worker takes the whole task", {
        dagID,
        nodeID,
        reason: plan.reason,
      })
    : Effect.void
