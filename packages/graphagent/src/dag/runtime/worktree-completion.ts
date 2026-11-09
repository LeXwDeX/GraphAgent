// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * #946: the shared isolated-node completion seam. The live spawn path and
 * crash recovery both commit pending work, persist a patch, and decide whether
 * the worktree was removed or kept. The Worktree service itself must run in
 * the owner instance (never the worktree instance), so callers pass the
 * instance-aware remove operation in.
 */

import { Effect, Cause } from "effect"
import type { DagStore } from "@graphagent/core/dag/store"
import { DagEvent } from "@graphagent/schema/dag-event"
import type { Worktree } from "@/worktree"
import { DagIsolation } from "../isolation"
import { workflowReportsArea } from "./output-ref"

export type IsolatedNodeCompletion =
  { ok: true; worktree?: DagEvent.NodeWorktree; touchedPaths: string[] } | { ok: false; reason: string }

export interface CompleteIsolatedNodeInput {
  worktree: DagEvent.NodeWorktree
  ownerDirectory: string
  projectID: string
  dagID: string
  nodeID: string
  message: string
  remove: (directory: string) => Effect.Effect<boolean, unknown>
}

/** Commit and patch an isolated node, then remove or keep its worktree. A
 * removal failure is not a node failure: the evidence stays on disk and the
 * caller records `state: "kept"`. */
export function completeIsolatedNode(input: CompleteIsolatedNodeInput): Effect.Effect<IsolatedNodeCompletion> {
  return Effect.gen(function* () {
    const completed = yield* Effect.try({
      try: () =>
        DagIsolation.completeWorktree({
          worktree: input.worktree,
          reportsArea: workflowReportsArea(input.projectID),
          dagID: input.dagID,
          nodeID: input.nodeID,
          message: input.message,
        }),
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    }).pipe(Effect.result)
    if (completed._tag === "Failure") return { ok: false as const, reason: completed.failure }
    if (!completed.success.ok) return completed.success
    const { worktree, touchedPaths } = completed.success.completion
    const removed = yield* input.remove(worktree.directory).pipe(
      Effect.result,
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed({ _tag: "Failure" as const }),
      ),
    )
    const state = removed._tag === "Success" && removed.success ? "removed" : "kept"
    if (state === "kept")
      yield* Effect.logWarning("worktree remove failed; keeping it for inspection", {
        directory: worktree.directory,
      })
    return {
      ok: true as const,
      worktree: {
        ...worktree,
        state,
        conflictsWith: input.worktree.conflictsWith,
      },
      touchedPaths,
    }
  })
}

/** Rebuild the durable worktree pointer recorded by `NodeStarted`. */
export function recoverWorktreeMetadata(node: DagStore.NodeRow): DagEvent.NodeWorktree | undefined {
  if (!node.worktreeDirectory) return undefined
  const state = node.worktreeState
  return {
    directory: node.worktreeDirectory,
    ...(node.worktreeBranch ? { branch: node.worktreeBranch } : {}),
    ...(node.worktreeCommit ? { commit: node.worktreeCommit } : {}),
    ...(node.baseHead ? { baseHead: node.baseHead } : {}),
    ...(node.worktreePatchPath ? { patchPath: node.worktreePatchPath } : {}),
    ...(node.worktreePatchSha256 ? { patchSha256: node.worktreePatchSha256 } : {}),
    touchedPaths: node.touchedPaths ?? [],
    state: state === "removed" || state === "kept" ? state : "active",
    conflictsWith: (node.worktreeConflictsWith ?? []).map((id) => DagEvent.NodeID.make(id)),
  }
}

/** Complete a recovered isolated node through the same seam as the live path.
 * A missing service or owner directory fails closed: removing a worktree from
 * the wrong instance would be refused, and completing without evidence would
 * leave the durable row claiming an active worktree forever. */
export function recoverIsolatedWorktree(input: {
  node: DagStore.NodeRow
  dagID: string
  projectID: string
  ownerDirectory: string | undefined
  worktreeSvc: Worktree.Interface | undefined
  remove: (directory: string) => Effect.Effect<boolean, unknown>
}): Effect.Effect<IsolatedNodeCompletion> {
  const worktree = recoverWorktreeMetadata(input.node)
  if (!worktree || worktree.state !== "active")
    return Effect.succeed({ ok: true, worktree, touchedPaths: [...(worktree?.touchedPaths ?? [])] })
  if (!input.worktreeSvc || !input.ownerDirectory)
    return Effect.succeed({
      ok: false,
      reason: "worktree isolation recovery requires the Worktree service and an owner execution directory",
    })
  return completeIsolatedNode({
    worktree,
    ownerDirectory: input.ownerDirectory,
    projectID: input.projectID,
    dagID: input.dagID,
    nodeID: input.node.id,
    message: `dag: ${input.node.id} (${input.dagID})`,
    remove: input.remove,
  })
}
