// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * #1031 M8: write-safety rules shared by `workflow start` and `DagControl`.
 *
 * Three rules, one writer definition (`DagBlocks.isWriterNode`):
 *
 * 1. The `plan` agent may only run read-only nodes. `run.start` and the
 *    `DagControl` extend/replan/recover prechecks refuse a graph whose
 *    newly-running nodes include a writer.
 * 2. Two unisolated writers never share one workspace across live workflows.
 *    `run.start` and the `DagControl` extend/replan/recover/retarget prechecks
 *    refuse a request that would newly run, or move, a writer beside another
 *    live workflow's unfinished writer.
 * 3. A strict workflow with parallel writers defaults to workflow-level
 *    worktree isolation, but only from a clean git checkout.
 *
 * Everything except `liveWriters` is a pure decision over facts the caller has
 * already read. None of it takes a lock: each check runs right before the
 * durable write, and the engine has no cross-workflow lock, so two writers
 * racing in the same instant can both pass.
 */

import { Effect } from "effect"
import { planReplan } from "@graphagent/core/dag/core/replan"
import { NodeStatus, isTerminalWorkflowStatusValue } from "@graphagent/core/dag/core/types"
import type { DagStore } from "@graphagent/core/dag/store"
import { DagBlocks } from "./blocks"
import { DEFAULT_WORKFLOW_CONFIG, parseWorkflowConfig, type NodeConfig, type WorkflowConfig } from "./dag"
import { DagLocation } from "./location"
import { planRecovery } from "./recovery-plan"
import { targetSensitiveNode } from "./review-lifecycle"
import { DagValidation } from "./validation"

/** The agent whose turns may only start read-only work. */
export const PLAN_AGENT = "plan"

type WriterShape = Pick<NodeConfig, "id" | "worker_type" | "block" | "workspace_writes" | "aggregates_writers">
type OrderedShape = WriterShape & Pick<NodeConfig, "depends_on">
type PlacedShape = WriterShape & Pick<NodeConfig, "workspace" | "isolation">

/** Ids of the write-capable nodes among `nodes`. */
export function writerIDs(nodes: readonly WriterShape[]): string[] {
  return nodes.filter(DagBlocks.isWriterNode).map((node) => node.id)
}

/**
 * Whether two writers have no dependency path between them. Any such pair
 * counts as a possible write-set intersection: the engine cannot see what a
 * writer will touch before it runs, so it takes the conservative reading.
 */
export function hasUnorderedWriters(nodes: readonly OrderedShape[]): boolean {
  const writers = nodes.filter(DagBlocks.isWriterNode)
  if (writers.length < 2) return false
  const byID = new Map(nodes.map((node) => [node.id, node]))
  const memo = new Map<string, ReadonlySet<string>>()
  const ancestorsOf = (id: string): ReadonlySet<string> => {
    const known = memo.get(id)
    if (known) return known
    const seen = new Set<string>()
    const pending = [...(byID.get(id)?.depends_on ?? [])]
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (seen.has(next)) continue
      seen.add(next)
      pending.push(...(byID.get(next)?.depends_on ?? []))
    }
    memo.set(id, seen)
    return seen
  }
  return writers.some((first, index) =>
    writers
      .slice(index + 1)
      .some((second) => !ancestorsOf(first.id).has(second.id) && !ancestorsOf(second.id).has(first.id)),
  )
}

// ============================================================================
// Plan agent
// ============================================================================

/** The requests that add work, which the plan agent may not use for writers. */
export type PlanAction = "start" | "extend" | "replan" | "recover"
/** The requests that can put a writer into a workspace: the above, and a
 * retarget, which moves the writers that spawn after it. */
export type WriteAction = PlanAction | "retarget"

/** The model-facing refusal for a plan-agent request that would run writers. */
export function planRejection(action: PlanAction, writers: readonly string[]): string {
  return `Workflow ${action} rejected: the plan agent may only run read-only nodes, but this ${action} would run write-capable node(s): ${writers.join(", ")}. Switch to build before running the implementation phase (plan_exit asks the user to switch).`
}

type FragmentRow = Pick<DagStore.NodeRow, "id" | "status" | "dependsOn" | "superseded">

const nodeStatusOf = (value: string): NodeStatus | undefined =>
  Object.values(NodeStatus).find((status) => status === value)

/**
 * The fragment nodes a replan would newly run: added ids, restarted nodes, and
 * pending or queued replacements. A running node that is merely re-stated keeps
 * its current run. Undefined when the fragment does not plan (or a stored
 * status is unknown); the real replan then reports why.
 */
export function replanNewRuns(rows: readonly FragmentRow[], fragment: readonly NodeConfig[]): NodeConfig[] | undefined {
  const current = rows.flatMap((row) => {
    const status = nodeStatusOf(row.status)
    return status === undefined ? [] : [{ id: row.id, status, depends_on: row.dependsOn, superseded: row.superseded }]
  })
  if (current.length !== rows.length) return undefined
  const plan = planReplan(
    { nodes: current },
    {
      nodes: fragment.map((node) => ({
        id: node.id,
        depends_on: node.depends_on,
        restart: node.restart,
        cancel: node.cancel,
      })),
    },
  )
  if (plan.errors.length > 0) return undefined
  const status = new Map(rows.map((row) => [row.id, row.status]))
  const runs = new Set([
    ...plan.add,
    ...plan.restart,
    ...plan.replace.filter((id) => status.get(id) === "pending" || status.get(id) === "queued"),
  ])
  return fragment.filter((node) => runs.has(node.id))
}

/**
 * The replacement attempts a recovery would create: the selected nodes, their
 * downstream, and work that workflow termination interrupted. Undefined when
 * the recovery does not plan; the real recover then reports why.
 */
export function recoveryNewRuns(input: {
  readonly config: WorkflowConfig
  readonly rows: readonly DagStore.NodeRow[]
  readonly nodeIDs: readonly string[]
  readonly graphRev: number
}): NodeConfig[] | undefined {
  try {
    const plan = planRecovery(
      input.config,
      input.rows,
      input.nodeIDs,
      input.graphRev + 1,
      input.config.max_node_replan_attempts ?? DEFAULT_WORKFLOW_CONFIG.maxNodeReplanAttempts,
    )
    const added = new Set(plan.replacements.map((replacement) => replacement.current))
    return plan.config.nodes.filter((node) => added.has(node.id))
  } catch {
    return undefined
  }
}

// ============================================================================
// Retarget
// ============================================================================

/** The nodes a retarget moves and the directory they run in afterwards. */
export interface RetargetPlacement {
  readonly nodes: NodeConfig[]
  readonly directory: string
}

/**
 * Where a retarget puts writers. It rebinds the workflow's execution directory,
 * and a node that spawns afterwards runs there unless it carries its own
 * `workspace`: that is every pending or queued node, plus the running
 * target-sensitive nodes the retarget itself restarts (`node_ids` narrows
 * those). A running node it does not restart keeps running where it started.
 * Undefined when nothing moves or the retarget will not apply (no `workspace`,
 * a terminal or workflow-isolated workflow, an unresolvable or unchanged
 * target, or `node_ids` the retarget would reject); the real retarget then
 * reports why.
 */
export function retargetPlacement(input: {
  readonly workflow: Pick<DagStore.WorkflowRow, "status" | "directory" | "executionDirectory" | "config">
  readonly rows: readonly DagStore.NodeRow[]
  readonly workspace: string | undefined
  readonly nodeIDs: readonly string[] | undefined
}): RetargetPlacement | undefined {
  const { workflow, rows, nodeIDs } = input
  if (input.workspace === undefined || isTerminalWorkflowStatusValue(workflow.status)) return undefined
  const config = parseWorkflowConfig(workflow.config)
  if (!config || config.isolation === "worktree") return undefined
  const target = DagLocation.resolveWorkspace(input.workspace, workflow.directory)
  if (target._tag !== "ok") return undefined
  const current = workflow.executionDirectory ?? workflow.directory
  if (DagLocation.canonicalDirectory(target.directory) === DagLocation.canonicalDirectory(current)) return undefined
  const definitions = new Map(config.nodes.map((node) => [node.id, node]))
  const sensitive = rows.filter(
    (row) => row.status === "running" && targetSensitiveNode(definitions.get(row.id), row.workerType),
  )
  if (nodeIDs !== undefined && (nodeIDs.length === 0 || nodeIDs.some((id) => !sensitive.some((row) => row.id === id))))
    return undefined
  const restarted = nodeIDs === undefined ? sensitive : sensitive.filter((row) => nodeIDs.includes(row.id))
  const moving = new Set([
    ...rows
      .filter((row) => !row.superseded && (row.status === "pending" || row.status === "queued"))
      .map((row) => row.id),
    ...restarted.map((row) => row.id),
  ])
  return {
    nodes: config.nodes.filter((node) => moving.has(node.id) && node.workspace === undefined),
    directory: target.directory,
  }
}

// ============================================================================
// Cross-workflow write conflicts
// ============================================================================

/** Workflow statuses that can still schedule work. */
const LIVE_STATUSES = ["pending", "running", "paused", "stepping"] as const
/** Node statuses that have not produced a final result yet. */
const UNFINISHED_STATUSES: ReadonlySet<string> = new Set(["pending", "queued", "running"])

/** The unfinished unisolated writers of one live workflow in one directory. */
export interface LiveWriters {
  readonly workflowID: string
  readonly sessionID: string
  readonly directory: string
  readonly nodeIDs: readonly string[]
}

/**
 * Unfinished unisolated writers of every live workflow except `exclude`, in any
 * session. A paused workflow counts: its pending writers run on resume. A node
 * runs in `node.workspace`, else the workflow's execution directory, else its
 * owner directory; a workflow-level worktree is such an execution directory, so
 * an isolated workflow never overlaps a checkout it does not share. A running
 * node is where it started (`NodeRow.directory`): a retarget rebinds the
 * execution directory but does not move an attempt that is already running.
 */
export function liveWriters(store: DagStore.Interface, exclude?: string): Effect.Effect<LiveWriters[]> {
  return Effect.gen(function* () {
    const live = (yield* Effect.forEach(LIVE_STATUSES, (status) => store.listByStatus(status))).flat()
    const groups: LiveWriters[] = []
    for (const workflow of live) {
      if (workflow.id === exclude) continue
      const config = parseWorkflowConfig(workflow.config)
      if (!config) continue
      const unfinished = new Map(
        (yield* store.getCurrentNodes(workflow.id))
          .filter((row) => UNFINISHED_STATUSES.has(row.status))
          .map((row) => [row.id, row] as const),
      )
      const home = workflow.executionDirectory ?? workflow.directory
      const placed = unisolatedWriters(
        config.nodes.flatMap((node) => {
          const row = unfinished.get(node.id)
          if (row === undefined) return []
          const started = row.status === "running" && row.directory ? row.directory : undefined
          return [{ ...node, workspace: started ?? node.workspace }]
        }),
        home,
      )
      for (const directory of new Set(placed.map((writer) => writer.directory))) {
        groups.push({
          workflowID: workflow.id,
          sessionID: workflow.sessionId,
          directory,
          nodeIDs: placed.filter((writer) => writer.directory === directory).map((writer) => writer.id),
        })
      }
    }
    return groups
  })
}

/** A new writer and the canonical directory it will write in. */
export interface PlacedWriter {
  readonly id: string
  readonly directory: string
}

/**
 * The writers among `nodes` that share their directory with the workflow: a
 * node with its own worktree (`isolation`) writes elsewhere. `directory` is
 * where nodes without a `workspace` run.
 */
export function unisolatedWriters(nodes: readonly PlacedShape[], directory: string): PlacedWriter[] {
  return nodes
    .filter((node) => node.isolation === undefined && DagBlocks.isWriterNode(node))
    .map((node) => ({ id: node.id, directory: DagLocation.canonicalDirectory(node.workspace ?? directory) }))
}

export interface WriteConflict {
  readonly workflowID: string
  readonly sessionID: string
  readonly directory: string
  /** The other workflow's unfinished writers in this directory. */
  readonly liveNodes: readonly string[]
  /** The new writers that would share the directory with them. */
  readonly newNodes: readonly string[]
}

/** The live workflows whose unfinished writers share a directory with `mine`. */
export function writeConflicts(live: readonly LiveWriters[], mine: readonly PlacedWriter[]): WriteConflict[] {
  return live.flatMap((group) => {
    const clash = mine.filter((writer) => writer.directory === group.directory)
    return clash.length === 0
      ? []
      : [
          {
            workflowID: group.workflowID,
            sessionID: group.sessionID,
            directory: group.directory,
            liveNodes: group.nodeIDs,
            newNodes: clash.map((writer) => writer.id),
          },
        ]
  })
}

/** What the parent can do about a refused write conflict, by request. A
 * recovery re-runs the stored node definitions, so it has no isolation to add;
 * a retarget moves nodes, so isolating them takes a replan. */
const CONFLICT_REMEDY: Record<WriteAction, string> = {
  start: "set config.isolation: worktree (needs a clean git checkout), or wait for that workflow to finish.",
  extend:
    "give the added write-capable node(s) isolation: worktree (needs a clean git checkout), or wait for that workflow to finish.",
  replan:
    "give the added, restarted or replaced write-capable node(s) isolation: worktree (needs a clean git checkout), or wait for that workflow to finish.",
  recover: "wait for that workflow to finish, then recover again.",
  retarget:
    "retarget to a linked worktree no other live workflow is writing, give the write-capable node(s) it would move isolation: worktree with a replan (needs a clean git checkout), or wait for that workflow to finish.",
}

/** The model-facing refusal for a request that would share a workspace. */
export function writeConflictMessage(action: WriteAction, conflicts: readonly WriteConflict[]): string {
  const effect = action === "retarget" ? "would move write-capable node(s) there" : "also writes there"
  const clauses = conflicts.map(
    (conflict) =>
      `workspace "${conflict.directory}" is being written by workflow ${conflict.workflowID} (session ${conflict.sessionID}; unfinished write-capable node(s): ${conflict.liveNodes.join(", ")}), and this ${action} ${effect} (${conflict.newNodes.join(", ")})`,
  )
  return `Workflow ${action} rejected: ${clauses.join("; ")}. Two unisolated writers must not share a workspace: ${CONFLICT_REMEDY[action]}`
}

// ============================================================================
// Default isolation
// ============================================================================

export type DefaultIsolation =
  | { readonly kind: "none" }
  | { readonly kind: "apply"; readonly notice: string }
  | { readonly kind: "skip"; readonly reason: "dirty" | "not-git" | "no-commits"; readonly notice: string }

const NONE: DefaultIsolation = { kind: "none" }

const APPLIED_NOTICE =
  "Default isolation: this strict workflow has parallel writers, so it runs in one workflow worktree (config.isolation: worktree). Its branch is kept when the workflow completes and is never merged automatically: merge it or open a PR, and stop to ask the user when the merge conflicts."

const SKIP_NOTICES = {
  dirty:
    "Warning: the checkout has uncommitted changes, so the workflow could not be isolated in a worktree and its parallel writers share the working tree. Keep their write sets disjoint (fan_out) or run the writers serially, do not commit or stash the user's changes yourself, and tell the user the workflow was not isolated because of the uncommitted changes.",
  "not-git":
    "Warning: the project is not a git repository, so the workflow could not be isolated in a worktree. A non-git project can only write serially: run the writers one after another.",
  "no-commits":
    "Warning: the repository has no commits yet, so a worktree cannot be created and the parallel writers share the working tree. Keep their write sets disjoint (fan_out) or run the writers serially.",
} as const

/**
 * Whether a workflow start defaults to workflow-level worktree isolation.
 * All of these must hold: the gate is strict, the document binds no workspace
 * or isolation (workflow or node level), at least two writers are unordered,
 * and the directory is a clean git checkout with a commit to branch from.
 * When only the checkout fails, the start proceeds unisolated and the notice
 * tells the parent why. The isolation rules themselves are
 * `DagValidation.workflowIsolationDiagnostics`, so this cannot disagree with
 * what `Dag.create` re-checks.
 */
export function defaultIsolation(input: {
  readonly config: Pick<WorkflowConfig, "review_gate" | "mode" | "workspace" | "isolation">
  readonly nodes: readonly NodeConfig[]
  readonly directory: string
}): DefaultIsolation {
  const strict = input.config.review_gate === "strict" || input.config.mode === "deep"
  if (!strict) return NONE
  if (input.config.workspace !== undefined || input.config.isolation !== undefined) return NONE
  if (input.nodes.some((node) => node.workspace !== undefined || node.isolation !== undefined)) return NONE
  if (!hasUnorderedWriters(input.nodes)) return NONE
  const problems = DagValidation.workflowIsolationDiagnostics({
    isolation: "worktree",
    nodes: input.nodes,
    ownerDirectory: input.directory,
    profile: "environment",
  })
  if (problems.length > 0) {
    const reason = DagLocation.isGitWorktree(input.directory) ? "dirty" : "not-git"
    return { kind: "skip", reason, notice: SKIP_NOTICES[reason] }
  }
  if (DagLocation.gitHead(input.directory) === undefined)
    return { kind: "skip", reason: "no-commits", notice: SKIP_NOTICES["no-commits"] }
  return { kind: "apply", notice: APPLIED_NOTICE }
}

export * as DagWriteGuard from "./write-guard"
