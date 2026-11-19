// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * #946: the shared isolated-node completion seam. The live spawn path and
 * crash recovery both commit pending work, persist a patch, and decide whether
 * the worktree was removed or kept. The Worktree service itself must run in
 * the owner instance (never the worktree instance), so callers pass the
 * instance-aware remove operation in.
 */

import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { DateTime, Effect, Cause, Fiber, Option, Schedule, Schema } from "effect"
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
 * caller records `state: "kept"`. #1583: the commit's git and the patch write
 * are waited for off the event loop (`completeWorktreeAsync`), so the timers
 * and other workflows of the process keep running meanwhile. A cancel does not
 * cut the commit and the patch short, as it could not cut the synchronous
 * version: it waits for them, so it never leaves a worktree half committed
 * with no patch recorded. They run on a fiber of their own that stays
 * interruptible, so each git command's own timeout (`GIT_TIMEOUT_MS`) still
 * interrupts and reaps its child and bounds that wait; masking interruption
 * around them instead would mask those timeouts too. */
export function completeIsolatedNode(input: CompleteIsolatedNodeInput): Effect.Effect<IsolatedNodeCompletion> {
  return Effect.gen(function* () {
    const completing = yield* DagIsolation.completeWorktreeAsync({
      worktree: input.worktree,
      reportsArea: workflowReportsArea(input.projectID),
      dagID: input.dagID,
      nodeID: input.nodeID,
      message: input.message,
    }).pipe(Effect.forkDetach)
    const completed = yield* Fiber.join(completing).pipe(Effect.onInterrupt(() => Fiber.await(completing)))
    if (!completed.ok) return completed
    const { worktree, touchedPaths } = completed.completion
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

/** #1030 D9-g: a terminal isolated workflow's durable read model is final only
 * after its settlement projection commits. Delivery text (final report body and
 * the wake summary) embeds this evidence, while its receipt identity is pinned
 * to the terminal `(seq, graphRev)` — settlement deliberately does NOT advance
 * either. A receipt written from the unsettled row could therefore never match
 * a retry that reads the settled row: the delivery seams die permanently. Both
 * the delivery planner and `deliverReport` treat this state as "not ready" and
 * let the settlement nudge (or the startup sweep) retry. */
export function workflowWorktreeSettlementPending(
  workflow: Pick<DagStore.WorkflowRow, "worktree">,
  config: Pick<WorkflowConfig, "isolation" | "worktree"> | undefined,
): boolean {
  return workflow.worktree == null && config?.isolation === "worktree" && config.worktree != null
}

export type WorkflowWorktreeSettlement =
  | "settled"
  | "already_settled"
  | "not_isolated"
  | "settle_failed"
  /** The read model already belongs to a newer episode (a recovery reopened
   * the workflow while this settlement was still queued). Nothing is touched:
   * the new episode settles with its own evidence. */
  | "superseded"

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
  publish: (worktree: DagEvent.WorkflowWorktree, episode: DagEvent.WorkflowWorktreeEpisode) => Effect.Effect<void, unknown>
  /** #1030 D9-g: runs the whole settlement (durable read, filesystem work,
   * publish) under the same per-workflow mutex that serializes recovery and
   * replan. Without it the durable projection fence still rejects a stale
   * episode, but the git commit could interleave with the reopened episode's
   * writes. The live DagLoop passes `Dag.exclusive`. */
  exclusive?: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/** Commit pending workflow-level work, persist its patch, then remove (completed)
 * or keep (failed/cancelled) the worktree. Strictly idempotent via the durable
 * `workflow.worktree` pointer: once a settlement projection has committed for
 * the CURRENT terminal episode, later calls return `already_settled` without
 * touching disk. Recovery clears that pointer in the same projection that
 * reopens the workflow, so each terminal episode settles exactly once.
 *
 * Both the live DagLoop terminal handler and a future process-level reconciler
 * must call THIS function (E1b #1029 terminal branch reuses it too), so the
 * outcome does not depend on which observer noticed the terminal event. */
export function settleWorkflowWorktree(
  input: SettleWorkflowWorktreeInput,
): Effect.Effect<WorkflowWorktreeSettlement> {
  const settleEpisode = Effect.gen(function* () {
    const configured = input.config.worktree
    if (input.config.isolation !== "worktree" || !configured) return "not_isolated" as const
    // Idempotency gate: the projection writes `workflow.worktree` inside the
    // settlement event's publish transaction. Re-reading first makes a
    // duplicate call (or a second terminal observer) a pure no-op.
    const current = yield* input.store.getWorkflow(input.dagID).pipe(Effect.orDie)
    if (!current || current.worktree != null) return "already_settled" as const
    // #1030 D9-g: the caller observed a terminal event, but a recovery may
    // have reopened the workflow before this read or while the filesystem work
    // runs. A reopened row is `running` (or a later terminal episode); settling
    // it would commit the next episode's in-flight work and mark it settled.
    // The captured episode fences the durable write; this status check also
    // avoids touching the disk at all.
    if (current.status !== input.status) return "superseded" as const
    const episode: DagEvent.WorkflowWorktreeEpisode = { graphRev: current.graphRev, seq: current.seq }

    const settle = (worktree: DagEvent.WorkflowWorktree) =>
      input.publish(worktree, episode).pipe(
        Effect.retry({ times: 2, schedule: Schedule.spaced("200 millis") }),
        Effect.as("settled" as const),
        // A failed metadata publish must not break terminal cleanup, but it
        // must NOT claim "settled": the durable row still has worktree=NULL,
        // and delivery readiness treats that as "settlement not committed yet".
        // Report a distinct status so callers can annotate/retry; the startup
        // sweep (DagLoop init) and a process-level reconciler retry the same
        // durable terminal row.
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("workflow worktree settlement publish failed", {
                dagID: input.dagID,
                cause,
              }).pipe(Effect.as("settle_failed" as const)),
        ),
      )

    const base = {
      directory: configured.directory,
      ...(configured.branch ? { branch: configured.branch } : {}),
      ...(configured.baseHead ? { baseHead: configured.baseHead } : {}),
      touchedPaths: [] as string[],
    }
    if (!(yield* pathExists(configured.directory))) {
      // #1030 D9-g: a completed settlement removes the directory after
      // persisting its evidence but before publishing. A process that stops in
      // that window retries here with the checkout gone — publish the saved
      // head/patch/checksum/touched paths instead of an empty tombstone (the
      // write-once projection would make that loss permanent).
      const evidence = yield* readSettlementEvidence(input.projectID, input.dagID, configured.directory)
      if (evidence) return yield* settle(evidence)
      return yield* settle({ ...base, state: "removed", reason: "worktree directory is missing" })
    }

    // #1344: this runs under the workflow lock (`exclusive`), so git is waited
    // for without blocking the event loop; each command is bounded by its own
    // 20 s and the whole critical section by the lock's 30 s cap. #1583: so is
    // the disk (the existence check, the patch, the settlement evidence), which
    // the cap now reaches too. An interruption stops the wait, never an fs
    // step in the middle: each one is a single async function that runs to its
    // end, as the synchronous call it replaced did, so it leaves no half-written
    // file and no stranded temporary file, and a retry redoes what was cut short.
    // The one thing the synchronous call could not do is outlive the critical
    // section, and a write that does must not land over the next settlement's:
    // the patch and the evidence take their turn behind the earlier writes to
    // the same file (`DagIsolation.writeInOrder`).
    const commit = yield* DagIsolation.commitWorktreeAsync(
      configured.directory,
      configured.baseHead ?? "",
      `dag: workflow ${input.dagID}`,
    )
    const head =
      commit.ok && commit.change ? commit.change.commit : yield* DagLocation.gitHeadAsync(configured.directory)
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
      const written = yield* DagIsolation.writePatchArtifactAsync(
        workflowReportsArea(input.projectID),
        input.dagID,
        "_workflow",
        commit.change.patch,
      ).pipe(Effect.result)
      if (written._tag === "Failure") {
        return yield* settle({
          ...base,
          ...(head ? { head } : {}),
          touchedPaths,
          state: "kept",
          reason: written.failure.message,
        })
      }
      patch = written.success
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

    // Persist the settlement evidence BEFORE removing the checkout: head,
    // touched paths and the patch can no longer be recomputed once the
    // directory is gone (only the kept branch and patch artifact survive).
    // Failing to persist it is treated like a failed removal — keep the
    // worktree, publish the evidence we have, never remove without a recovery
    // record.
    const persisted = yield* persistSettlementEvidence(input.projectID, input.dagID, {
      ...settledBase,
      state: "removed",
    }).pipe(Effect.result)
    if (persisted._tag === "Failure") {
      return yield* settle({
        ...settledBase,
        state: "kept",
        reason: persisted.failure.message,
      })
    }

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
  // #1030 D9-g: recovery/replan take the same per-workflow mutex. Holding
  // it here makes "terminal read → commit/patch/remove → fenced publish" one
  // critical section with them, so the reopened episode cannot write into the
  // checkout while the settlement is committing it.
  return input.exclusive ? input.exclusive(settleEpisode) : settleEpisode
}

/** Where the pre-removal settlement evidence lives. The patch artifact already
 * uses `<reportsArea>/<dagID>/` and survives the checkout, so the settlement
 * record belongs next to it. */
function settlementEvidencePath(projectID: string, dagID: string): string | undefined {
  if (!dagID || dagID === "." || dagID === ".." || /[\\/\0]/.test(dagID)) return undefined
  return join(workflowReportsArea(projectID), dagID, "_workflow.settlement.json")
}

/** Whether a path exists, waiting for the disk off the event loop (#1583): a
 * path that cannot be looked at counts as missing, as with the synchronous check
 * this replaced. */
function pathExists(path: string): Effect.Effect<boolean> {
  return Effect.promise(() =>
    access(path).then(
      () => true,
      () => false,
    ),
  )
}

/** Atomically persist the evidence a completed settlement is about to publish.
 * A torn write must not make the retry publish half-decoded metadata.
 *
 * #1583: the directory, the temporary file and the rename wait for the disk off
 * the event loop, as one async function: once it has started it runs to its end
 * whatever happens to the fiber waiting for it, so an interruption cannot leave
 * a half-written temporary file or strand it, as it could not between the
 * synchronous calls it replaces. A failed write or rename removes the temporary
 * file and fails with the error's message, the reason the synchronous throw
 * gave. What the synchronous calls could not do is outlive the critical section:
 * the tail of an interrupted call can still be running when a recovery has
 * reopened the workflow and the next settlement persists its evidence, and its
 * rename would land over the newer file. So the whole sequence takes its turn
 * behind the earlier writes to the same file (`DagIsolation.writeInOrder`), which
 * also keeps two calls from sharing the temporary file. */
function persistSettlementEvidence(
  projectID: string,
  dagID: string,
  worktree: DagEvent.WorkflowWorktree,
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async (signal) => {
      const file = settlementEvidencePath(projectID, dagID)
      if (!file) throw new Error(`invalid workflow ID for settlement evidence: ${JSON.stringify(dagID)}`)
      await DagIsolation.writeInOrder(
        file,
        async () => {
          await mkdir(dirname(file), { recursive: true })
          const temporary = `${file}.tmp-${process.pid}`
          try {
            await writeFile(temporary, JSON.stringify(worktree))
            await rename(temporary, file)
          } catch (error) {
            await rm(temporary, { force: true })
            throw error
          }
        },
        signal,
      )
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

/** Read back the evidence persisted before removal. Anything unreadable or
 * scoped to a different worktree is discarded: an empty tombstone is worse
 * than the reason-bearing fallback but better than foreign evidence. #1583:
 * the read waits for the disk off the event loop; a file that is missing is as
 * unreadable as any other, so it needs no existence check of its own. */
function readSettlementEvidence(
  projectID: string,
  dagID: string,
  directory: string,
): Effect.Effect<DagEvent.WorkflowWorktree | undefined> {
  return Effect.promise(async (): Promise<DagEvent.WorkflowWorktree | undefined> => {
    const file = settlementEvidencePath(projectID, dagID)
    if (!file) return undefined
    try {
      const evidence = Schema.decodeUnknownSync(DagEvent.WorkflowWorktree)(JSON.parse(await readFile(file, "utf8")))
      if (evidence.directory !== directory) return undefined
      return { ...evidence, state: "removed" }
    } catch {
      return undefined
    }
  })
}

export interface SettleTerminalWorkflowInput {
  dagID: string
  store: DagStore.Interface
  publish: EventV2.Interface["publish"]
  /** Ambient instance context of the observer (the DagLoop). */
  ambient: { readonly directory: string; readonly trustProject?: boolean }
  /** #1030 D9-g: the per-workflow mutex shared with recovery/replan
   * (`Dag.exclusive`). The live loop always passes it; a standalone observer
   * degrades to the durable episode fence. */
  exclusive?: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
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
    const outcome = yield* settleWorkflowWorktree({
      dagID: input.dagID,
      status,
      config,
      store: input.store,
      projectID: workflow.projectId,
      remove: (directory, options) =>
        worktreeSvc
          ? inOwner(worktreeSvc.remove({ directory, keepBranch: options.keepBranch }))
          : Effect.succeed(false),
      publish: (worktree, episode) =>
        input.publish(DagEvent.WorkflowWorktreeSettled, {
          dagID: DagEvent.DagID.make(input.dagID),
          worktree,
          episode,
          timestamp,
        }).pipe(Effect.asVoid),
      exclusive: input.exclusive,
    })
    // `settle_failed` means the disk outcome happened but the durable pointer
    // did not commit. Delivery stays gated on that pointer; log loudly so the
    // startup sweep / reconciler retry is attributable.
    if (outcome === "settle_failed")
      yield* Effect.logWarning("workflow worktree settlement is not durable; delivery will retry after settlement", {
        dagID: input.dagID,
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
