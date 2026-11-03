// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DAG crash recovery — EventV2-driven, no separate recovery table/scan.
 *
 * A child Session's durable state can recover an already-settled result, but it
 * cannot prove that the current process owns provider execution. On startup,
 * every node left `running` by an unclean shutdown is therefore reconciled to a
 * DAG terminal event before its WorkflowRuntime is rebuilt.
 *
 * This is NOT a startup-blocking scan (unlike the old recoverOrphanedWorkflows).
 * It runs lazily when a workflow is first accessed, and only touches workflows
 * that have running nodes.
 *
 * `ownershipLost` counts nodes whose failure was INVENTED by reconciliation
 * (no durable proof of the child's outcome: session missing, still active, or
 * unknown), as opposed to failures read from durable child state. The caller
 * uses it to pause the workflow instead of letting the scheduler cascade skips
 * and terminalize on fabricated evidence (P2-2 recovery-pause).
 */

import { HookLifecycle } from "@/hook/lifecycle"
import { Effect, Clock, Cause, Exit, Option } from "effect"
import { Dag, isStaleMessageInput, type NodeExecutionAttempt } from "../dag"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionPrompt } from "@/session/prompt"
import type { NodeConfig, ResultProtocol } from "../dag"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "@/session/schema"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { DagStore } from "@opencode-ai/core/dag/store"
import { isTransitionRejection } from "@opencode-ai/core/dag/core/types"
import { reviewImplementationFingerprint } from "../review-lifecycle"
import { DagLocation } from "../location"
import { InstanceRef } from "@/effect/instance-ref"
import { resolveInputMapping } from "./eval"
import { childFailureReason } from "./child-failure-reason"
import {
  settleCapturedOutput,
  settlePlainTextOutput,
  registerCaptureSlot,
  clearCaptureSlot,
  registerFinalResponseSession,
  clearFinalResponseSession,
} from "./capture"
import type { CapturedSettlement } from "./capture"
import { captureFinalResponse, finalAssistantText, type FinalCaptureResult } from "./final-response"
import {
  commitOutputFileRef,
  ensureReportAreaGitignore,
  isManagedOutputFileRef,
  verifyOutputFileRef,
} from "./output-ref"
import { recoverIsolatedWorktree, recoverWorktreeMetadata } from "./worktree-completion"

export function reconcileWorkflow(
  dagID: string,
  checkSessionStatus: (childSessionID: string) => Effect.Effect<"active" | "completed" | "failed" | "unknown", Error>,
  cancelSession?: (sessionID: string) => Effect.Effect<void, Error>,
  workflowConfig?: {
    nodes: Pick<NodeConfig, "id" | "output_schema" | "review" | "input_mapping" | "workspace">[]
    result_protocol?: ResultProtocol
  } | null,
  lastAssistantText?: (childSessionID: string) => Effect.Effect<string | undefined, Error>,
  /** #943/#947: effective workflow execution directory. The workflow owner
   * directory is only for ownership checks in the caller; node-level and
   * per-attempt directories override this base. */
  executionDirectory?: string,
  /** Build the source authorizer for a node's effective execution directory. */
  authorizeSource?: (
    executionDirectory: string,
  ) => (
    childSessionID: string,
    source: string,
    workerType?: string,
    symlink?: boolean,
    canonical?: string,
  ) => Effect.Effect<void, Error>,
  lastAssistantMessage?: (childSessionID: string) => Effect.Effect<SessionV1.WithParts | undefined, Error>,
): Effect.Effect<{ reconciled: number; ownershipLost: number; continuations?: string[] }, Error, Dag.Service> {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const nodes = yield* dag.store.getNodes(dagID)
    const messages = yield* Effect.serviceOption(DagMessages.Service)
    const workflow = Option.isSome(messages) ? yield* dag.store.getWorkflow(dagID) : undefined
    const workflowExecutionDirectory =
      executionDirectory ?? workflow?.executionDirectory ?? workflow?.directory ?? undefined
    // #946: recovery must finish an isolated attempt exactly like the live
    // path — commit, patch, touched paths, then remove or keep. The Worktree
    // service and the instance store are lazy for the same bootstrap-cycle
    // reason as spawn.ts.
    const { Worktree } = yield* Effect.promise(() => import("@/worktree"))
    const worktreeSvc = Option.getOrUndefined(yield* Effect.serviceOption(Worktree.Service))
    const instance = yield* Effect.serviceOption(InstanceRef)
    const ambient = Option.isSome(instance) ? instance.value : undefined
    const ambientReal = ambient?.directory ? DagLocation.canonicalDirectory(ambient.directory) : undefined
    const { InstanceStore } = yield* Effect.promise(() => import("@/project/instance-store"))
    const instanceStore = Option.getOrUndefined(yield* Effect.serviceOption(InstanceStore.Service))
    const inOwnerInstance = <A, E, R>(
      directory: string | undefined,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => {
      const real = directory ? DagLocation.canonicalDirectory(directory) : undefined
      return instanceStore && real && real !== ambientReal ? instanceStore.provide({ directory: real }, effect) : effect
    }
    const nodeOwnerDirectory = (nodeConfig?: Pick<NodeConfig, "workspace">) =>
      nodeConfig?.workspace ?? workflowExecutionDirectory
    const failNode = (
      node: DagStore.NodeRow,
      reason: string,
      trigger: string,
      attempt?: NodeExecutionAttempt,
      errorClass?: string,
    ) => {
      const metadata = recoverWorktreeMetadata(node)
      return dag.nodeFailed(
        dagID,
        node.id,
        reason,
        trigger,
        attempt,
        errorClass,
        metadata ? { ...metadata, state: "kept" as const } : undefined,
      )
    }
    const completeNode = (
      node: DagStore.NodeRow,
      nodeConfig: Pick<NodeConfig, "workspace"> | undefined,
      output: unknown,
      attempt?: NodeExecutionAttempt,
      capturedOutput?: unknown,
    ) =>
      Effect.gen(function* () {
        const owner = nodeOwnerDirectory(nodeConfig)
        const completion = yield* recoverIsolatedWorktree({
          node,
          dagID,
          ownerDirectory: owner,
          worktreeSvc,
          remove: (directory) =>
            worktreeSvc ? inOwnerInstance(owner, worktreeSvc.remove({ directory })) : Effect.succeed(false),
        })
        if (!completion.ok)
          return yield* failNode(node, `worktree completion failed: ${completion.reason}`, "exec_failed", attempt)
        return yield* dag.nodeCompleted(
          dagID,
          node.id,
          output,
          attempt,
          capturedOutput,
          completion.worktree,
          completion.worktree ? completion.touchedPaths : undefined,
        )
      })
    const nodeExecutionDirectory = (node: DagStore.NodeRow, nodeConfig?: Pick<NodeConfig, "workspace">) =>
      node.directory ?? nodeConfig?.workspace ?? workflowExecutionDirectory
    const sessions = yield* Effect.serviceOption(Session.Service)
    const continuations = new Set<string>()
    const settle = (nodeID: string, action: Effect.Effect<void, Error>) =>
      action.pipe(
        Effect.as(true),
        Effect.catchIf(isStaleMessageInput, () =>
          Effect.sync(() => {
            continuations.add(nodeID)
            return false
          }),
        ),
        Effect.catchIf(isTransitionRejection, (error) =>
          Effect.logDebug("DAG recovery ignored a concurrent transition rejection", {
            dagID,
            nodeID,
            error,
          }).pipe(Effect.as(false)),
        ),
      )
    let reconciled = 0
    let ownershipLost = 0

    for (const node of nodes) {
      const attempt = {
        replanAttempts: node.replanAttempts,
        ...(node.childSessionId ? { childSessionID: node.childSessionId } : {}),
      }
      // Pending/queued nodes have no live execution attempt — a queued node
      // never created its child session (P0-2: sessions materialize inside
      // the permit), so both re-enter scheduling after runtime reconstruction
      // without any ownership judgement. This includes ordinary
      // dependency-blocked work and restart-orphans; a restart-orphan
      // (pending/queued + stale childSessionId from the attempt it replaced)
      // must have its old child session cancelled here, since spawnReady may
      // never revisit it if the workflow is about to become terminal.
      if (node.status === "pending" || node.status === "queued") {
        if (node.childSessionId && cancelSession) {
          // #349/REC-1: same hardening as the running-node branch below — a
          // persistent cancel failure must not abort the whole reconcile
          // (this workflow would then never be adopted by this process).
          yield* cancelSession(node.childSessionId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DAG recovery failed to cancel stale child session", {
                dagID,
                nodeID: node.id,
                childSessionID: node.childSessionId,
                cause,
              }),
            ),
          )
        }
        continue
      }
      if (node.status !== "running") continue
      if (!node.childSessionId) {
        // Crash landed between admission and session creation — no durable
        // outcome exists, so this is an invented failure like ownership loss.
        const settled = yield* settle(
          node.id,
          failNode(node, "node was running but had no child session on recovery", "exec_failed", attempt),
        )
        if (settled) {
          ownershipLost++
          reconciled++
        }
        continue
      }

      // Checker failures propagate: aborting this reconcile (callers log and
      // retry on next access) beats inventing a nodeFailed from a read error.
      const sessionStatus = yield* checkSessionStatus(node.childSessionId)
      const session = Option.isSome(messages) && Option.isSome(sessions)
        ? yield* sessions.value.get(SessionID.make(node.childSessionId)).pipe(
            Effect.map(Option.some),
            Effect.catchTag("NotFoundError", () => Effect.succeed(Option.none<Session.Info>())),
          )
        : Option.none<Session.Info>()
      const nodeConfig = workflowConfig?.nodes.find((config) => config.id === node.id)
      const childDirectory = Option.isSome(session)
        ? session.value.directory
        : Option.isNone(sessions) ? nodeExecutionDirectory(node, nodeConfig) : undefined
      const caller = workflow && childDirectory
        ? { projectID: workflow.projectId, directory: childDirectory, sessionID: node.childSessionId }
        : undefined
      if (Option.isSome(messages) && !caller && sessionStatus === "completed") {
        continuations.add(node.id)
        continue
      }

      if (Option.isSome(messages) && caller && sessionStatus !== "failed") {
        const metadata = yield* messages.value.revisions(caller)
        if (metadata.ok && metadata.value.queued > 0) {
          if (node.deadlineMs !== null && (yield* Clock.currentTimeMillis) >= node.deadlineMs) {
            if (
              yield* settle(
                node.id,
                failNode(node, "deadline exceeded before message recovery", "timeout", attempt),
              )
            )
              reconciled++
          } else continuations.add(node.id)
          continue
        }
      }

      if (sessionStatus === "completed") {
        const nodeExecution = nodeExecutionDirectory(node, nodeConfig)
        const authorize = nodeExecution && authorizeSource ? authorizeSource(nodeExecution) : undefined
        // #345 parity with the live path: an unparseable workflow row must
        // not degrade into the schemaless completion below — a schema-
        // carrying node would bypass settleCapturedOutput and land as an
        // undefined output. Fail loudly instead of inventing a settlement.
        if (workflowConfig === null) {
          const settled = yield* settle(
            node.id,
            failNode(
              node,
              "child session completed but the workflow config is unparseable on recovery — cannot settle safely",
              "exec_failed",
              attempt,
            ),
          )
          if (settled) {
            ownershipLost++
            reconciled++
          }
          continue
        }
        if (nodeConfig?.output_schema && workflowConfig?.result_protocol === "final_response") {
          const message = lastAssistantMessage ? yield* lastAssistantMessage(node.childSessionId) : undefined
          const frozen =
            Option.isSome(messages) && caller && message
              ? yield* messages.value.snapshotForTurn(caller, message.info.id)
              : undefined
          const snapshotID = frozen?.ok ? frozen.value?.id : undefined
          if (message && Option.isSome(messages) && caller && !snapshotID) {
            continuations.add(node.id)
            continue
          }
          let captured: FinalCaptureResult
          if (
            message &&
            finalAssistantText(message).ok &&
            snapshotID &&
            node.capturedOutputPresent &&
            node.capturedSnapshotID === snapshotID
          ) {
            // The guarded, validated receipt belongs to this exact final
            // model turn. A crash after capture but before NodeCompleted can
            // settle it without starting another validation worker.
            captured = { ok: true, output: node.capturedOutput, snapshotID }
          } else if (!message || (Option.isSome(messages) && caller && !snapshotID)) {
            captured = { ok: false, reason: "recovered final assistant response or input snapshot is unavailable" }
          } else {
            registerCaptureSlot(node.childSessionId, nodeConfig.output_schema)
            captured = yield* captureFinalResponse({
              store: dag.store,
              sessionID: node.childSessionId,
              message,
              snapshotID,
              caller,
              guard: {
                workflowID: dagID,
                nodeID: node.id,
                attemptID: DagMessages.nodeAttemptID(node.childSessionId, node.replanAttempts),
              },
            }).pipe(Effect.ensuring(Effect.sync(() => clearCaptureSlot(node.childSessionId!))))
          }
          if (!captured.ok && (captured.code === "stale_input" || captured.code === "unassociated")) {
            continuations.add(node.id)
            continue
          }
          const settlement = captured.ok
            ? recoveredSettlement(nodeConfig, nodes, captured.output, true)
            : ({ kind: "fail", reason: captured.reason } as const)
          const completed = yield* settle(
            node.id,
            settlement.kind === "complete"
              ? completeNode(node, nodeConfig, settlement.output, {
                  ...attempt,
                  inputSnapshotID: captured.ok ? captured.snapshotID : undefined,
                })
              : failNode(node, settlement.reason, "verdict_fail", {
                  ...attempt,
                  inputSnapshotID: snapshotID,
                }),
          )
          if (completed) reconciled++
        } else if (nodeConfig?.output_schema) {
          // Same settlement decision as spawn's completion gate — recovery
          // must not become a bypass of the review-result contract again (B1).
          const settlement = recoveredSettlement(nodeConfig, nodes, node.capturedOutput, node.capturedOutputPresent)
          const settled = yield* settle(
            node.id,
            settlement.kind === "complete"
              ? completeNode(node, nodeConfig, settlement.output, attempt)
              : failNode(node, settlement.reason, "verdict_fail", attempt),
          )
          if (settled) reconciled++
        } else {
          const finalMessage =
            workflowConfig?.result_protocol === "final_response" && lastAssistantMessage
              ? yield* lastAssistantMessage(node.childSessionId)
              : undefined
          const final =
            workflowConfig?.result_protocol === "final_response" ? finalAssistantText(finalMessage) : undefined
          const frozen =
            Option.isSome(messages) && caller && finalMessage
              ? yield* messages.value.snapshotForTurn(caller, finalMessage.info.id)
              : undefined
          const snapshotID = frozen?.ok ? frozen.value?.id : undefined
          if (final?.ok && Option.isSome(messages) && !snapshotID) {
            const currentInput = caller ? yield* messages.value.revisions(caller) : undefined
            if (!currentInput?.ok || currentInput.value.queued > 0) {
              continuations.add(node.id)
              continue
            }
            if (
              yield* settle(
                node.id,
                failNode(node, "recovered final assistant response has no associated input snapshot", "exec_failed", {
                  ...attempt,
                  expectedAcceptedRevision: currentInput.value.accepted,
                }),
              )
            )
              reconciled++
            continue
          }
          const finalSource = final?.ok
            ? process.platform === "win32"
              ? FSUtil.normalizePath(final.text.trim())
              : final.text.trim()
            : undefined
          const restorableFinalRef = yield* Effect.gen(function* () {
            if (
              !final?.ok ||
              !isManagedOutputFileRef(node.capturedOutput) ||
              finalSource !== node.capturedOutput.source_path
            )
              return false
            if (Option.isNone(messages)) return true
            return !!snapshotID && snapshotID === node.capturedSnapshotID
          })
          const previousRefValid = yield* Effect.gen(function* () {
            if (workflowConfig?.result_protocol === "final_response" && !restorableFinalRef) return
            if (isManagedOutputFileRef(node.capturedOutput) && authorize)
              yield* authorize(node.childSessionId!, node.capturedOutput.source_path, node.workerType)
            yield* verifyOutputFileRef(node.capturedOutput)
          }).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              settle(node.id, failNode(node, error.message, "exec_failed", attempt)).pipe(
                Effect.tap((settled) =>
                  Effect.sync(() => {
                    if (settled) reconciled++
                  }),
                ),
                Effect.as(false),
              ),
            ),
          )
          if (!previousRefValid) continue
          if (
            isManagedOutputFileRef(node.capturedOutput) &&
            (workflowConfig?.result_protocol !== "final_response" || restorableFinalRef)
          ) {
            const ref = node.capturedOutput
            const restored = yield* Effect.gen(function* () {
              if (
                ref.provenance?.workflow_id !== dagID ||
                ref.provenance?.node_id !== node.id ||
                ref.provenance?.child_session_id !== node.childSessionId ||
                ref.provenance?.replan_attempt !== node.replanAttempts
              )
                return yield* Effect.fail(new Error("Managed DAG artifact belongs to another execution attempt"))
              // Crash window: the live path persists this receipt before the
              // report-area exclude update. Repair best-effort from the verified
              // receipt without reopening the source or re-authorizing it.
              const reportDirectory =
                nodeExecution ??
                workflow?.directory ??
                (yield* dag.store.getWorkflow(dagID).pipe(
                  Effect.map((row) => row?.directory ?? undefined),
                  Effect.catchCause((cause) =>
                    Cause.hasInterrupts(cause)
                      ? Effect.failCause(cause)
                      : Effect.logWarning("DAG recovery could not read the workflow directory for report-area repair", {
                          dagID,
                          nodeID: node.id,
                          cause,
                        }).pipe(Effect.as(undefined)),
                  ),
                ))
              if (reportDirectory) yield* ensureReportAreaGitignore(reportDirectory, ref.source_path)
              return yield* settle(
                node.id,
                completeNode(node, nodeConfig, ref.path, { ...attempt, inputSnapshotID: snapshotID }, ref),
              )
            }).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : settle(node.id, failNode(node, Cause.pretty(cause), "exec_failed", attempt)),
              ),
            )
            if (restored) reconciled++
            continue
          }
          const settlement = settlePlainTextOutput(
            final
              ? final.ok
                ? final.text
                : undefined
              : lastAssistantText
                ? yield* lastAssistantText(node.childSessionId)
                : undefined,
          )
          if (settlement.kind === "fail") {
            if (
              yield* settle(
                node.id,
                failNode(node, settlement.reason, "verdict_fail", {
                  ...attempt,
                  ...(workflowConfig?.result_protocol === "final_response" ? { inputSnapshotID: snapshotID } : {}),
                }),
              )
            )
              reconciled++
          } else {
            const rawText = settlement.output
            const completed = yield* Effect.gen(function* () {
              const fileRef = yield* commitOutputFileRef(
                rawText,
                {
                  workflow_id: dagID,
                  node_id: node.id,
                  child_session_id: node.childSessionId!,
                  replan_attempt: node.replanAttempts,
                },
                authorize
                  ? (source, symlink, canonical) =>
                      authorize(node.childSessionId!, source, node.workerType, symlink, canonical)
                  : undefined,
              )
              if (
                workflowConfig?.result_protocol === "final_response" &&
                !restorableFinalRef &&
                !fileRef &&
                isManagedOutputFileRef(node.capturedOutput) &&
                finalSource === node.capturedOutput.source_path
              )
                return yield* Effect.fail(
                  new Error("previous file receipt belongs to an older input snapshot; source is unavailable"),
                )
              if (fileRef) {
                const receipt = dag.store.setCapturedOutput(node.childSessionId!, fileRef, snapshotID)
                if (workflowConfig?.result_protocol === "final_response" && Option.isSome(messages) && caller) {
                  const guarded = yield* messages.value.guard(
                    caller,
                    {
                      workflowID: dagID,
                      nodeID: node.id,
                      attemptID: DagMessages.nodeAttemptID(node.childSessionId!, node.replanAttempts),
                      snapshotID,
                      close: false,
                    },
                    receipt,
                  )
                  if (!guarded.ok) {
                    if (guarded.reason === "stale_input" || guarded.reason === "unassociated") {
                      continuations.add(node.id)
                      return false
                    }
                    return yield* Effect.fail(new Error(`Recovered output receipt rejected: ${guarded.reason}`))
                  }
                } else yield* receipt
                const reportDirectory = nodeExecution ?? workflow?.directory
                if (reportDirectory) yield* ensureReportAreaGitignore(reportDirectory, fileRef.source_path)
              }
              return yield* settle(
                node.id,
                completeNode(
                  node,
                  nodeConfig,
                  fileRef?.path ?? rawText,
                  { ...attempt, inputSnapshotID: snapshotID },
                  fileRef,
                ),
              )
            }).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : settle(node.id, failNode(node, Cause.pretty(cause), "exec_failed", attempt)),
              ),
            )
            if (completed) reconciled++
          }
        }
      } else if (sessionStatus === "failed") {
        // Diagnostic read failures retain the generic reason; interruption propagates.
        const lastMessage = lastAssistantMessage
          ? yield* lastAssistantMessage(node.childSessionId).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Effect.logWarning(
                      "DAG recovery could not read the child assistant message for the failure reason",
                      { dagID, nodeID: node.id, childSessionID: node.childSessionId, cause },
                    ).pipe(Effect.as(undefined)),
              ),
            )
          : undefined
        const reason = childFailureReason(
          "child session failed (recovered)",
          lastMessage?.info.role === "assistant" ? lastMessage.info.error : undefined,
        )
        if (yield* settle(node.id, failNode(node, reason, "exec_failed", attempt))) reconciled++
      } else {
        if (cancelSession) {
          yield* cancelSession(node.childSessionId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DAG recovery failed to cancel child session", {
                dagID,
                nodeID: node.id,
                childSessionID: node.childSessionId,
                cause,
              }),
            ),
          )
        }
        if (node.deadlineMs !== null) {
          const now = yield* Clock.currentTimeMillis
          if (now >= node.deadlineMs) {
            // S2: recovery of an escalated node preserves the timeout semantics
            // — the extension budget was spent before the crash, the deadline
            // was never re-extended, and the durable escalation count proves
            // it. Failure reason records the escalation so the parent can tell
            // "ran out of time after N extensions" from "never escalated".
            const settled = yield* settle(
              node.id,
              failNode(
                node,
                node.timeoutExtensions > 0
                  ? `timeout escalated (${node.timeoutExtensions} extension(s)) node failed on recovery`
                  : "deadline exceeded on recovery",
                "timeout",
                attempt,
              ),
            )
            if (settled) {
              ownershipLost++
              reconciled++
            }
            continue
          }
        }
        const settled = yield* settle(
          node.id,
          failNode(node, "execution ownership lost on recovery", "exec_failed", attempt),
        )
        if (settled) {
          ownershipLost++
          reconciled++
        }
      }
    }

    return { reconciled, ownershipLost, ...(continuations.size ? { continuations: [...continuations] } : {}) }
  })
}

/** Resume the existing child transcript at an eligible admission boundary. This never
 * creates a child or changes its attempt, and never replays completed tool executions.
 * The owning loop provides concurrency permits, a deadline watcher and scoped disposal.
 */
export function continueRecoveredMessageNode(
  dagID: string,
  nodeID: string,
  config:
    | {
        nodes: Pick<NodeConfig, "id" | "output_schema" | "review" | "input_mapping" | "workspace">[]
        result_protocol?: ResultProtocol
      }
    | null
    | undefined,
  directory?: string,
  authorizeSource?: (
    childSessionID: string,
    source: string,
    workerType?: string,
    symlink?: boolean,
    canonical?: string,
  ) => Effect.Effect<void, Error>,
  /** #943: execution directory resolved by the loop; node workspace wins. */
  executionDirectory?: string,
): Effect.Effect<void, Error, Dag.Service | SessionPrompt.Service> {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const prompt = yield* SessionPrompt.Service
    const messages = yield* Effect.serviceOption(DagMessages.Service)
    const node = yield* dag.store.getNode(dagID, nodeID)
    const workflow = yield* dag.store.getWorkflow(dagID)
    const nodeConfig = config?.nodes.find((candidate) => candidate.id === nodeID)
    // #948: recovered continuation dispatch must revalidate the shared
    // execution verdict before resuming a child prompt. A vanished workspace
    // fails the WORKFLOW; no child node may be failed or resumed against a
    // dead path.
    const location = workflow ? DagLocation.resolveExecution(workflow) : undefined
    if (workflow && location && location._tag !== "ok") {
      yield* dag
        .failUnrecoverable(dagID, DagLocation.executionFailureReason(location))
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.logWarning(
                  "DAG message continuation could not terminalize a workflow with an unusable execution directory",
                  { dagID, nodeID, cause },
                ),
          ),
        )
    }
    if (
      Option.isNone(messages) ||
      !node?.childSessionId ||
      node.status !== "running" ||
      !workflow ||
      !location ||
      location._tag !== "ok" ||
      !["running", "stepping"].includes(workflow.status)
    )
      return
    const childSessionID = node.childSessionId
    // Workflow ownership remains with the parent, while the mailbox belongs to the child session.
    const ownerDirectory = workflow.directory ?? location.directory
    const ownerExecutionDirectory =
      executionDirectory ?? nodeConfig?.workspace ?? workflow.executionDirectory ?? ownerDirectory
    const boundExecutionDirectory =
      node.directory && node.directory !== ownerDirectory ? node.directory : ownerExecutionDirectory
    const sessions = yield* Effect.serviceOption(Session.Service)
    const session = Option.isSome(sessions)
      ? yield* sessions.value.get(SessionID.make(childSessionID)).pipe(
          Effect.map(Option.some),
          Effect.catchTag("NotFoundError", () => Effect.succeed(Option.none<Session.Info>())),
        )
      : Option.none<Session.Info>()
    if (Option.isSome(sessions) && Option.isNone(session)) return
    const caller = {
      projectID: workflow.projectId,
      directory: Option.isSome(session) ? session.value.directory : (node.directory ?? boundExecutionDirectory),
      sessionID: childSessionID,
    }
    const attempt = { replanAttempts: node.replanAttempts, childSessionID }
    const failExecution = (reason: string) =>
      dag
        .failUnrecoverable(dagID, reason)
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.logWarning(
                  "DAG message continuation could not terminalize a workflow with an unusable execution directory",
                  { dagID, nodeID, cause },
                ),
          ),
        )
    const nodeWorkspaceUsable = Effect.gen(function* () {
      if (nodeConfig?.workspace === undefined) return true
      const resolved = DagLocation.resolveWorkspace(nodeConfig.workspace, ownerDirectory)
      if (resolved._tag === "invalid") {
        yield* failExecution(`workspace_invalid: ${resolved.reason}.`)
        return false
      }
      if (
          DagLocation.canonicalDirectory(resolved.directory) !== DagLocation.canonicalDirectory(ownerExecutionDirectory)
      ) {
        yield* failExecution(
          `workspace_invalid: node "${nodeID}" is bound to "${resolved.directory}", but recovery resolved "${ownerExecutionDirectory}".`,
        )
        return false
      }
      return true
    })
    // #948: dispatch may happen after an arbitrary pause/admit wait. Re-read
    // the durable workflow immediately before every prompt: a removed, moved
    // or replaced workspace must fail the workflow, never receive a prompt.
    const dispatchable = Effect.fnUntraced(function* () {
      const current = yield* dag.store.getWorkflow(dagID).pipe(Effect.exit)
      if (!Exit.isSuccess(current) || !current.value) return false
      if (!["running", "stepping", "paused"].includes(current.value.status)) return false
      const currentLocation = DagLocation.resolveExecution(current.value)
      if (currentLocation._tag !== "ok") {
        yield* failExecution(DagLocation.executionFailureReason(currentLocation))
        return false
      }
      if (!(yield* nodeWorkspaceUsable)) return false
      if (
        directory !== undefined &&
        (current.value.directory === null ||
          DagLocation.canonicalDirectory(current.value.directory) !== DagLocation.canonicalDirectory(directory))
      )
        return false
      const instance = yield* Effect.serviceOption(InstanceRef)
      const projectID = Option.isSome(instance) ? instance.value?.project?.id : undefined
      if (projectID !== undefined && current.value.projectId !== projectID) return false
      return true
    })
    const ambient = yield* Effect.serviceOption(InstanceRef)
    const ambientDirectory = Option.isSome(ambient) ? ambient.value?.directory : undefined
    // Lane is imported lazily for the same bootstrap-cycle reason as spawn.ts.
    const { InstanceStore } = yield* Effect.promise(() => import("@/project/instance-store"))
    const instanceStore = Option.getOrUndefined(yield* Effect.serviceOption(InstanceStore.Service))
    const inExecution = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      instanceStore &&
      (!ambientDirectory ||
        DagLocation.canonicalDirectory(boundExecutionDirectory) !== DagLocation.canonicalDirectory(ambientDirectory))
        ? instanceStore.provide({ directory: boundExecutionDirectory }, effect)
        : effect
    // #946: the continuation resumes an isolated attempt too. The loop enters
    // the owner execution instance before this helper runs, so the Worktree
    // service sees the owner context (never the worktree itself).
    const { Worktree } = yield* Effect.promise(() => import("@/worktree"))
    const worktreeSvc = Option.getOrUndefined(yield* Effect.serviceOption(Worktree.Service))
    const failNode = (
      row: DagStore.NodeRow,
      reason: string,
      trigger: string,
      attempt: NodeExecutionAttempt,
      errorClass?: string,
    ) => {
      const metadata = recoverWorktreeMetadata(row)
      return dag.nodeFailed(
        dagID,
        nodeID,
        reason,
        trigger,
        attempt,
        errorClass,
        metadata ? { ...metadata, state: "kept" as const } : undefined,
      )
    }
    const completeNode = (
      row: DagStore.NodeRow,
      output: unknown,
      attempt: NodeExecutionAttempt,
      capturedOutput?: unknown,
    ) =>
      Effect.gen(function* () {
        const completion = yield* recoverIsolatedWorktree({
          node: row,
          dagID,
          ownerDirectory: ownerExecutionDirectory,
          worktreeSvc,
          remove: (directory) => {
            const remove = worktreeSvc ? worktreeSvc.remove({ directory }) : Effect.succeed(false)
            return Option.isSome(ambient) ? remove.pipe(Effect.provideService(InstanceRef, ambient.value)) : remove
          },
        })
        if (!completion.ok)
          return yield* failNode(row, `worktree completion failed: ${completion.reason}`, "exec_failed", attempt)
        return yield* dag.nodeCompleted(
          dagID,
          nodeID,
          output,
          attempt,
          capturedOutput,
          completion.worktree,
          completion.worktree ? completion.touchedPaths : undefined,
        )
      })
    yield* inExecution(
      Effect.gen(function* () {
        const latest = yield* messages.value.latestSnapshot(caller)
        if (!(yield* dispatchable())) return
        if (latest?.ok && latest.value?.stopReason) {
          yield* failNode(node, `message recovery blocked: ${latest.value.stopReason}`, "exec_failed", attempt)
          return
        }
        const admit = Effect.gen(function* () {
          for (;;) {
            if (!(yield* dispatchable())) return false
            const current = yield* dag.store.getNode(dagID, nodeID)
            const wf = yield* dag.store.getWorkflow(dagID)
            if (
              !current ||
              current.status !== "running" ||
              current.childSessionId !== childSessionID ||
              current.replanAttempts !== attempt.replanAttempts ||
              !wf ||
              !["running", "stepping", "paused"].includes(wf.status)
            )
              return false
            if (current.deadlineMs !== null && (yield* Clock.currentTimeMillis) >= current.deadlineMs) {
              yield* failNode(current, "node deadline expired before message recovery admission", "timeout", attempt)
              return false
            }
            if (wf.status !== "paused") return true
            yield* Effect.sleep(250)
          }
        })
        if (!(yield* admit)) return
        if (config?.result_protocol === "final_response") registerFinalResponseSession(childSessionID)
        if (nodeConfig?.output_schema) registerCaptureSlot(childSessionID, nodeConfig.output_schema)
        // Recovery owns the full historical attempt, not each resumed model turn.
        // Do not replay its historical Start/Stop hooks in a new process.
        const lifecycle = yield* Effect.serviceOption(HookLifecycle.Service)
        if (Option.isSome(lifecycle)) yield* lifecycle.value.delegateChildStop(childSessionID)
        let result = yield* prompt.loop({ sessionID: SessionID.make(childSessionID) })
        for (;;) {
          if (!(yield* admit)) return
          const current = yield* dag.store.getNode(dagID, nodeID)
          const wf = yield* dag.store.getWorkflow(dagID)
          if (
            !current ||
            current.status !== "running" ||
            current.childSessionId !== childSessionID ||
            current.replanAttempts !== attempt.replanAttempts ||
            !wf ||
            !["running", "stepping"].includes(wf.status)
          )
            return
          if (result.info.role !== "assistant" || result.info.error) {
            yield* failNode(
              current,
              childFailureReason(
                "recovered model turn stopped without a successful result",
                result.info.role === "assistant" ? result.info.error : undefined,
              ),
              "exec_failed",
              attempt,
            )
            return
          }
          const frozen = yield* messages.value.snapshotForTurn(caller, result.info.id)
          const snapshotID = frozen.ok ? frozen.value?.id : undefined
          const settled = yield* Effect.gen(function* () {
            if (nodeConfig?.output_schema && config?.result_protocol === "final_response") {
              if (!snapshotID) yield* new Dag.StaleMessageInputError({ dagID, nodeID, reason: "unassociated" })
              const captured = yield* captureFinalResponse({
                store: dag.store,
                sessionID: childSessionID,
                message: result,
                snapshotID,
                caller,
                guard: {
                  workflowID: dagID,
                  nodeID,
                  attemptID: DagMessages.nodeAttemptID(childSessionID, attempt.replanAttempts),
                },
              })
              if (!captured.ok && (captured.code === "stale_input" || captured.code === "unassociated"))
                yield* new Dag.StaleMessageInputError({ dagID, nodeID, reason: captured.code })
              const all = yield* dag.store.getNodes(dagID)
              const settlement = captured.ok
                ? recoveredSettlement(nodeConfig, all, captured.output, true)
                : ({ kind: "fail", reason: captured.reason } as const)
              if (settlement.kind === "fail")
                return yield* failNode(
                  current,
                  settlement.reason,
                  "verdict_fail",
                  {
                    ...attempt,
                    inputSnapshotID: snapshotID,
                  },
                  !captured.ok && captured.schemaInvalid ? "schema_invalid" : undefined,
                )
              return yield* completeNode(current, settlement.output, {
                ...attempt,
                inputSnapshotID: snapshotID,
              })
            }
            if (nodeConfig?.output_schema) {
              const all = yield* dag.store.getNodes(dagID)
              const settlement = recoveredSettlement(
                nodeConfig,
                all,
                current.capturedOutput,
                current.capturedOutputPresent,
              )
              if (settlement.kind === "fail")
                return yield* failNode(current, settlement.reason, "verdict_fail", attempt)
              return yield* completeNode(current, settlement.output, {
                ...attempt,
                inputSnapshotID: current.capturedSnapshotID ?? undefined,
              })
            }
            const final = finalAssistantText(result, true)
            const settlement = settlePlainTextOutput(final.ok ? final.text : undefined)
            if (settlement.kind === "fail")
              return yield* failNode(current, settlement.reason, "verdict_fail", {
                ...attempt,
                ...(config?.result_protocol === "final_response" ? { inputSnapshotID: snapshotID } : {}),
              })
            const ref = yield* commitOutputFileRef(
              settlement.output,
              {
                workflow_id: dagID,
                node_id: nodeID,
                child_session_id: childSessionID,
                replan_attempt: attempt.replanAttempts,
              },
              authorizeSource
                ? (source, symlink, canonical) =>
                    authorizeSource(childSessionID, source, current.workerType, symlink, canonical)
                : undefined,
            )
            if (ref) {
              const receipt = yield* messages.value.guard(
                caller,
                {
                  workflowID: dagID,
                  nodeID,
                  attemptID: DagMessages.nodeAttemptID(childSessionID, attempt.replanAttempts),
                  snapshotID,
                  close: false,
                },
                dag.store.setCapturedOutput(childSessionID, ref, snapshotID),
              )
              if (!receipt.ok) {
                if (receipt.reason === "stale_input" || receipt.reason === "unassociated")
                  yield* new Dag.StaleMessageInputError({ dagID, nodeID, reason: receipt.reason })
                yield* Effect.fail(new Error(`Recovered output receipt rejected: ${receipt.reason}`))
              }
              yield* ensureReportAreaGitignore(boundExecutionDirectory, ref.source_path)
            }
            return yield* completeNode(
              current,
              ref?.path ?? settlement.output,
              { ...attempt, inputSnapshotID: snapshotID },
              ref,
            )
          }).pipe(
            Effect.as(true),
            Effect.catchIf(isStaleMessageInput, () => Effect.succeed(false)),
          )
          if (settled) return
          if (frozen.ok && frozen.value?.stopReason) {
            yield* failNode(
              current,
              `message recovery continuation blocked: ${frozen.value.stopReason}`,
              "exec_failed",
              attempt,
            )
            return
          }
          const inbox = yield* messages.value.revisions(caller)
          if (!(yield* admit)) return
          if (!(yield* dispatchable())) return
          let nudge = !!(
            nodeConfig?.output_schema &&
            config?.result_protocol !== "final_response" &&
            inbox.ok &&
            inbox.value.queued === 0
          )
          if (nudge && inbox.ok) {
            const claim = yield* messages.value.claimResultNudge(caller, inbox.value.accepted)
            if (!claim.ok && claim.reason === "stale_input") nudge = false
            else if (!claim.ok || !claim.value) {
              const failed = yield* failNode(
                current,
                `unchanged agent input cannot retry structured result: ${claim.ok ? "resubmission already requested" : claim.reason}`,
                "exec_failed",
                { ...attempt, ...(claim.ok ? { expectedAcceptedRevision: inbox.value.accepted } : {}) },
              ).pipe(
                Effect.as(true),
                Effect.catchIf(isStaleMessageInput, () => Effect.succeed(false)),
              )
              if (failed) return
              nudge = false
            }
          }
          result = nudge
            ? yield* prompt.prompt(
                {
                  sessionID: SessionID.make(childSessionID),
                  messageID: MessageID.ascending(),
                  agent: result.info.agent,
                  model: { modelID: result.info.modelID, providerID: result.info.providerID },
                  parts: [
                    {
                      type: "text",
                      text: "Runtime continuation: incorporate the recorded agent messages and submit an updated result. Keep completed tool evidence; do not repeat completed writes.",
                    },
                  ],
                },
                { internalDelegation: true },
              )
            : yield* prompt.loop({ sessionID: SessionID.make(childSessionID) })
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : dag
                .nodeFailed(dagID, nodeID, Cause.pretty(cause), "exec_failed", attempt)
                .pipe(Effect.catchIf(isTransitionRejection, () => Effect.void)),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            clearCaptureSlot(childSessionID)
            clearFinalResponseSession(childSessionID)
          }),
        ),
      ),
    )
  })
}

/**
 * Recovery-side wrapper around the shared settlement decision
 * (capture.ts settleCapturedOutput). Resolves the implementation fingerprint
 * from durable sibling rows — the same source input_mapping reads from — then
 * delegates. An unresolvable fingerprint fails conservatively: re-running the
 * review is always safe; completing an unvalidated one is not.
 *
 * Known asymmetry vs the spawn path: loop.ts passes the fingerprint through
 * sanitizeInput before spawning, this path reads the raw durable value. A
 * fingerprint the sanitizer would rewrite can therefore only produce a
 * spurious mismatch → forced re-run, never a false accept; typical hashes are
 * untouched by the sanitizer.
 */
function recoveredSettlement(
  nodeConfig: Pick<NodeConfig, "id" | "review" | "input_mapping">,
  rows: readonly DagStore.NodeRow[],
  captured: unknown,
  submitted?: boolean,
): CapturedSettlement {
  // Same evidence the spawn path passes: completed direct dependencies, read
  // from the node's durable edges.
  const dependsOn = rows.find((row) => row.id === nodeConfig.id)?.dependsOn ?? []
  const evidence = rows
    .filter((row) => dependsOn.includes(row.id) && row.status === "completed")
    .map((row) => ({ nodeID: row.id, output: row.output }))
  if (nodeConfig.review?.phase !== "diff")
    return settleCapturedOutput(captured, undefined, " (recovered)", submitted, evidence)
  const resolved = resolveInputMapping(
    nodeConfig.input_mapping,
    (nodeID) => rows.find((row) => row.id === nodeID)?.output,
  )
  const fingerprint = reviewImplementationFingerprint(nodeConfig, resolved)
  if (!fingerprint)
    return {
      kind: "fail",
      reason: "review implementation fingerprint could not be resolved from durable state (recovered)",
    }
  return settleCapturedOutput(captured, fingerprint, " (recovered)", submitted, evidence)
}

export function makeSessionStatusChecker(
  sessions: Session.Interface,
): (childSessionID: string) => Effect.Effect<"active" | "completed" | "failed" | "unknown", Error> {
  return (childSessionID) =>
    Effect.gen(function* () {
      // Only a missing session is legitimate "unknown"; any other failure must
      // propagate so recovery aborts instead of inventing node failures from
      // fabricated evidence. DB-level errors are already defects (orDie).
      const info = yield* sessions
        .get(SessionID.make(childSessionID))
        .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
      if (!info) return "unknown" as const
      const msgs = yield* sessions
        .messages({ sessionID: SessionID.make(childSessionID), limit: 1 })
        .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed([] as SessionV1.WithParts[])))
      if (msgs.length === 0) return "unknown" as const
      const last = msgs[msgs.length - 1]
      if (last.info.role !== "assistant") return "active" as const
      // An interrupted/aborted session has error set but finish undefined.
      if (last.info.error) return "failed" as const
      const finish = last.info.finish
      if (!finish || finish === "tool-calls" || finish === "unknown") return "active" as const
      if (finish === "error" || finish === "content-filter") return "failed" as const
      if (last.info.structured === undefined && typeof last.info.parentID === "string") {
        const parentID = last.info.parentID
        const parent =
          Object.hasOwn(sessions, "findMessage") && typeof sessions.findMessage === "function"
            ? yield* sessions
                .findMessage(SessionID.make(childSessionID), (message) => message.info.id === parentID)
                .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(Option.none<SessionV1.WithParts>())))
            : Option.fromNullishOr(
                (yield* sessions.messages({ sessionID: SessionID.make(childSessionID), limit: 20 })).find(
                  (message) => message.info.id === parentID,
                ),
              )
        if (
          Option.isSome(parent) &&
          parent.value.info.role === "user" &&
          parent.value.info.format?.type === "json_schema"
        )
          return "failed" as const
      }
      // stop, length, and any other terminal finish → completed
      return "completed" as const
    })
}

/** The latest message only: an older assistant turn is never a fallback result. */
export function makeLastAssistantMessageReader(
  sessions: Session.Interface,
): (childSessionID: string) => Effect.Effect<SessionV1.WithParts | undefined, Error> {
  return (childSessionID) =>
    Effect.gen(function* () {
      const msgs = yield* sessions
        .messages({ sessionID: SessionID.make(childSessionID), limit: 1 })
        .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed([] as SessionV1.WithParts[])))
      const last = msgs.at(-1)
      return last?.info.role === "assistant" ? last : undefined
    })
}

/** Plaintext compatibility reader with the same complete-message extraction. */
export function makeLastAssistantTextReader(
  sessions: Session.Interface,
): (childSessionID: string) => Effect.Effect<string | undefined, Error> {
  const read = makeLastAssistantMessageReader(sessions)
  return (childSessionID) =>
    Effect.gen(function* () {
      // Legacy test transcripts can omit finish; session-status recovery has
      // already established completion before this compatibility reader runs.
      const final = finalAssistantText(yield* read(childSessionID), true)
      return final.ok ? final.text : undefined
    })
}
