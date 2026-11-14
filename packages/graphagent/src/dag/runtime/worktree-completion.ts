// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * #946: the shared isolated-node completion seam. The live spawn path and
 * crash recovery both commit pending work, persist a patch, and decide whether
 * the worktree was removed or kept. The Worktree service itself must run in
 * the owner instance (never the worktree instance), so callers pass the
 * instance-aware remove operation in.
 */

import { existsSync } from "node:fs"
import { DateTime, Effect, Cause, Option } from "effect"
import type { EventV2 } from "@graphagent/core/event"
import type { DagStore } from "@graphagent/core/dag/store"
import { isTerminalWorkflowStatusValue } from "@graphagent/core/dag/core/types"
import { DagEvent } from "@graphagent/schema/dag-event"
import type { Worktree } from "@/worktree"
import { parseWorkflowConfig, type WorkflowConfig } from "../dag"
import { DagIsolation } from "../isolation"
import { DagLocation } from "../location"
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

// ---------------------------------------------------------------------------
// #1030 D9-g: workflow-level worktree settlement
// ---------------------------------------------------------------------------

export type WorkflowWorktreeSettlement = "settled" | "already_settled" | "not_isolated"

export interface SettleWorkflowWorktreeInput {
  dagID: string
  /** The durable terminal status. Completed removes the directory (keeping the
   * branch); failed/cancelled keep the whole worktree for inspection. */
  status: "completed" | "failed" | "cancelled"
  config: WorkflowConfig
  store: DagStore.Interface
  projectID: string
  /** Runs in the owner instance: the current instance must never remove its own
   * checkout. `keepBranch` is always true at settlement — the branch is the
   * durable pointer to the final commit. */
  remove: (directory: string, options: { keepBranch: boolean }) => Effect.Effect<boolean, unknown>
  publish: (worktree: DagEvent.WorkflowWorktree) => Effect.Effect<void, unknown>
}

/** Commit pending workflow-level work, persist its patch, then remove (completed)
 * or keep (failed/cancelled) the worktree. Strictly idempotent via the durable
 * `workflow.worktree` pointer: once any settlement projection has committed,
 * later calls return `already_settled` without touching disk.
 *
 * Both the live DagLoop terminal handler and a future process-level reconciler
 * must call THIS function (E1b #1029 terminal branch reuses it too), so the
 * outcome does not depend on which observer noticed the terminal event. */
export function settleWorkflowWorktree(
  input: SettleWorkflowWorktreeInput,
): Effect.Effect<WorkflowWorktreeSettlement> {
  return Effect.gen(function* () {
    const configured = input.config.worktree
    if (input.config.isolation !== "worktree" || !configured) return "not_isolated" as const
    // Idempotency gate: the projection writes `workflow.worktree` inside the
    // settlement event's publish transaction. Re-reading first makes a
    // duplicate call (or a second terminal observer) a pure no-op.
    const current = yield* input.store.getWorkflow(input.dagID).pipe(Effect.orDie)
    if (!current || current.worktree != null) return "already_settled" as const

    const settle = (worktree: DagEvent.WorkflowWorktree) =>
      input.publish(worktree).pipe(
        Effect.as("settled" as const),
        // A failed metadata publish must not break terminal cleanup: the
        // worktree on disk is already settled, and a reconciler retry reads
        // the same durable terminal row.
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("workflow worktree settlement publish failed", {
                dagID: input.dagID,
                cause,
              }).pipe(Effect.as("settled" as const)),
        ),
      )

    const base = {
      directory: configured.directory,
      ...(configured.branch ? { branch: configured.branch } : {}),
      ...(configured.baseHead ? { baseHead: configured.baseHead } : {}),
      touchedPaths: [] as string[],
    }
    if (!existsSync(configured.directory)) {
      return yield* settle({ ...base, state: "removed", reason: "worktree directory is missing" })
    }

    const commit = DagIsolation.commitWorktree(
      configured.directory,
      configured.baseHead ?? "",
      `dag: workflow ${input.dagID}`,
    )
    const head = commit.ok && commit.change ? commit.change.commit : DagLocation.gitHead(configured.directory)
    if (!commit.ok) {
      return yield* settle({
        ...base,
        ...(head ? { head } : {}),
        state: "kept",
        reason: commit.reason,
      })
    }
    const touchedPaths = commit.change?.touchedPaths ?? []
    let patch: { path: string; sha256: string } | undefined
    if (commit.change) {
      try {
        patch = DagIsolation.writePatchArtifact(
          workflowReportsArea(input.projectID),
          input.dagID,
          "_workflow",
          commit.change.patch,
        )
      } catch (error) {
        return yield* settle({
          ...base,
          ...(head ? { head } : {}),
          touchedPaths,
          state: "kept",
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const settledBase = {
      ...base,
      ...(head ? { head } : {}),
      ...(patch ? { patchPath: patch.path, patchSha256: patch.sha256 } : {}),
      touchedPaths,
    }
    // A failed/cancelled workflow keeps the whole worktree so an operator can
    // inspect the attempt; only a completed workflow removes the directory.
    if (input.status !== "completed") return yield* settle({ ...settledBase, state: "kept" })

    const removed = yield* input.remove(configured.directory, { keepBranch: true }).pipe(
      Effect.result,
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed({ _tag: "Failure" as const }),
      ),
    )
    if (removed._tag === "Success" && removed.success) return yield* settle({ ...settledBase, state: "removed" })
    return yield* settle({
      ...settledBase,
      state: "kept",
      reason:
        removed._tag === "Failure"
          ? String("failure" in removed ? removed.failure : "worktree remove failed")
          : "worktree remove returned false",
    })
  })
}

export interface SettleTerminalWorkflowInput {
  dagID: string
  store: DagStore.Interface
  publish: EventV2.Interface["publish"]
  /** Ambient instance context of the observer (the DagLoop). */
  ambient: { readonly directory: string; readonly trustProject?: boolean }
}

/** The terminal-event entry point used by `DagLoop` (and reusable by E1b's
 * terminal branch / a process-level reconciler). It applies the ownership and
 * config gates, resolves the owner-instance Worktree service, and delegates to
 * `settleWorkflowWorktree`. Settlement failures are logged, never allowed to
 * break terminal cleanup. */
export function settleTerminalWorkflowWorktree(
  input: SettleTerminalWorkflowInput,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const workflow = yield* input.store.getWorkflow(input.dagID).pipe(Effect.orDie)
    if (!workflow || !isTerminalWorkflowStatusValue(workflow.status)) return
    const status = workflow.status
    if (status !== "completed" && status !== "failed" && status !== "cancelled") return
    const config = parseWorkflowConfig(workflow.config)
    if (!config || config.isolation !== "worktree" || !config.worktree) return
    // Only the owner may remove the checkout; sibling instances observe the
    // same terminal event on the process-level bus.
    if (!(yield* DagLocation.ownsWorkflow(input.dagID, input.ambient.directory))) return
    // Lazy for the same bootstrap-cycle reason as spawn/recovery.
    const { Worktree } = yield* Effect.promise(() => import("@/worktree"))
    const worktreeSvc = Option.getOrUndefined(yield* Effect.serviceOption(Worktree.Service))
    const { InstanceStore } = yield* Effect.promise(() => import("@/project/instance-store"))
    const instanceStore = Option.getOrUndefined(yield* Effect.serviceOption(InstanceStore.Service))
    const ownerReal = DagLocation.canonicalDirectory(workflow.directory)
    const timestamp = yield* DateTime.now
    const inOwner = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      instanceStore && ownerReal !== DagLocation.canonicalDirectory(input.ambient.directory)
        ? instanceStore.provide({ directory: ownerReal, trustProject: input.ambient.trustProject === true }, effect)
        : effect
    yield* settleWorkflowWorktree({
      dagID: input.dagID,
      status,
      config,
      store: input.store,
      projectID: workflow.projectId,
      remove: (directory, options) =>
        worktreeSvc
          ? inOwner(worktreeSvc.remove({ directory, keepBranch: options.keepBranch }))
          : Effect.succeed(false),
      publish: (worktree) =>
        input.publish(DagEvent.WorkflowWorktreeSettled, {
          dagID: DagEvent.DagID.make(input.dagID),
          worktree,
          timestamp,
        }).pipe(Effect.asVoid),
    })
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.logWarning("workflow worktree settlement failed", { dagID: input.dagID, cause }),
    ),
  )
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
