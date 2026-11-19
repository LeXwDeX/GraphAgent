// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagLoopMessageContinuation from "./message-continuation"

import { Deferred, Effect, Exit } from "effect"
import type { Fiber } from "effect"
import { DagMessages } from "@graphagent/core/dag/messages"
import { SessionID } from "@/session/schema"
import { SessionPrompt } from "@/session/prompt"
import { SessionRole } from "@/session/role"
import { Dag } from "../dag"
import { artifactPermissionBase, makeArtifactSourceAuthorizer } from "./artifact-permissions"
import type { DagLoopContext } from "./context"
import { guarded, type WorkflowEntry } from "./entry"
import { continueRecoveredMessageNode } from "./recovery"
import { RunnerLease } from "./runner-lease"
import { makeDeadlineWatcher } from "./spawn"

/**
 * Message continuations (#1344): a node whose accepted agent message was found
 * running at recovery keeps its attempt. `make` returns the one start function:
 * for each such node it continues the child session the attempt already runs in
 * (one fiber, under the workflow's child slot, with a deadline watcher beside
 * it) once the workflow is running. A continuation that ends while its node is
 * still running re-arms itself under the entry's `evalLock`. `spawnReady` and
 * the adoption are its callers.
 */
export const make = (
  loop: Pick<
    DagLoopContext.Context,
    | "store"
    | "runtimes"
    | "ctx"
    | "stateScope"
    | "scheduler"
    | "sessionSvc"
    | "agentSvc"
    | "permissionSvc"
    | "promptSvc"
    | "messageSvc"
  >,
) => {
  const { store, runtimes, ctx, stateScope, scheduler, sessionSvc, agentSvc, permissionSvc, promptSvc, messageSvc } =
    loop

  const startMessageContinuations: (dagID: string, entry: WorkflowEntry) => Effect.Effect<void> = Effect.fn(
    "DagLoop.startMessageContinuations",
  )(function* (dagID: string, entry: WorkflowEntry) {
    if (entry.runtime.isPaused() || entry.messageContinuations.size === 0) return
    const workflow = yield* store.getWorkflow(dagID)
    if (!workflow || !["running", "stepping"].includes(workflow.status)) return
    for (const nodeID of entry.messageContinuations) {
      const node = yield* store.getNode(dagID, nodeID)
      if (!node || node.status !== "running" || !node.childSessionId) {
        entry.messageContinuations.delete(nodeID)
        continue
      }
      if (entry.fibers.has(nodeID)) continue
      const registered = yield* Deferred.make<void>()
      let ownedFiber: Fiber.Fiber<unknown, unknown> | undefined
      // #943: the continuation must run where this node was bound.
      // Ownership/mailbox stays on the owner directory; prompt, report
      // and artifact authorization follow the execution workspace.
      const nodeConfig = entry.config?.nodes.find((candidate) => candidate.id === nodeID)
      const executionDirectory = nodeConfig?.workspace ?? entry.executionDirectory ?? ctx.directory
      // A non-git owner has worktree "/", which would make every absolute
      // path "inside" the boundary. Derive the boundary from the instance
      // directory instead so external sources still require approval.
      const { worktree, boundary } = artifactPermissionBase(ctx.directory, ctx.worktree, executionDirectory)
      const continuation = Effect.scoped(
        Effect.gen(function* () {
          yield* scheduler.childSlot({ kind: "workflow", workflowID: dagID }, entry.concurrency, {
            rootSessionID: SessionRole.liveRootOf(SessionID.make(entry.parentSessionID)),
          })
          return yield* Deferred.await(registered).pipe(
            Effect.andThen(
              continueRecoveredMessageNode(
                dagID,
                nodeID,
                entry.config ?? null,
                workflow.directory,
                makeArtifactSourceAuthorizer(sessionSvc, agentSvc, worktree, permissionSvc, boundary),
                executionDirectory,
              ),
            ),
          )
        }),
      ).pipe(
        Effect.provideService(Dag.Service, entry.port),
        Effect.provideService(SessionPrompt.Service, promptSvc),
        (self) => (messageSvc ? Effect.provideService(self, DagMessages.Service, messageSvc) : self),
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            // A finished or interrupted helper must relinquish its own
            // reservation before any DB read or exit classification. Never
            // delete a replacement attempt's fiber installed under this ID.
            if (ownedFiber && entry.fibers.get(nodeID) === ownedFiber) entry.fibers.delete(nodeID)
            if (!Exit.isSuccess(exit) || runtimes.get(dagID) !== entry) return
            const current = yield* store.getNode(dagID, nodeID)
            if (current?.childSessionId !== node.childSessionId || current.replanAttempts !== node.replanAttempts)
              return
            if (current.status !== "running") return
            const phase = yield* store.getWorkflow(dagID)
            if (!phase || !["running", "stepping", "paused"].includes(phase.status)) return
            // Pause may win after the loop reserved this attempt but before
            // the helper's first phase read. Keep it resumable; if resume
            // raced this cleanup, the scoped retry rechecks the phase.
            entry.messageContinuations.add(nodeID)
            yield* entry.evalLock
              .withPermits(1)(startMessageContinuations(dagID, entry))
              .pipe(guarded("RecoveredAgentMessageRearm"), Effect.forkIn(stateScope))
          }),
        ),
        guarded("RecoveredAgentMessageContinuation"),
      )
      const fiber = yield* continuation.pipe(Effect.forkIn(stateScope))
      ownedFiber = fiber
      entry.fibers.set(nodeID, fiber)
      // It continues the child session this attempt already runs in; that is the one eviction cancels.
      entry.attemptChild.set(fiber, RunnerLease.attached(node.childSessionId))
      const watcher =
        entry.watchers.get(nodeID) ??
        (yield* makeDeadlineWatcher({
          dagID,
          nodeID,
          attempt: { replanAttempts: node.replanAttempts, childSessionID: node.childSessionId },
          timeoutMs: nodeConfig?.worker_config?.timeout_ms,
          maxTimeoutExtensions:
            entry.config?.max_timeout_extensions ?? Dag.DEFAULT_WORKFLOW_CONFIG.maxTimeoutExtensions,
          scope: stateScope,
        }).pipe(
          Effect.provideService(Dag.Service, entry.port),
          Effect.provideService(SessionPrompt.Service, promptSvc),
          Effect.forkIn(stateScope),
        ))
      entry.watchers.set(nodeID, watcher)
      entry.messageContinuations.delete(nodeID)
      yield* Deferred.succeed(registered, undefined)
    }
  })

  return startMessageContinuations
}
