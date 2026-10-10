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

import { Effect, Clock, Cause, Option } from "effect"
import { Dag, isStaleMessageInput } from "../dag"
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
import { resolveInputMapping } from "./eval"
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

export function reconcileWorkflow(
  dagID: string,
  checkSessionStatus: (childSessionID: string) => Effect.Effect<"active" | "completed" | "failed" | "unknown", Error>,
  cancelSession?: (sessionID: string) => Effect.Effect<void, Error>,
  workflowConfig?: {
    nodes: Pick<NodeConfig, "id" | "output_schema" | "review" | "input_mapping">[]
    result_protocol?: ResultProtocol
  } | null,
  lastAssistantText?: (childSessionID: string) => Effect.Effect<string | undefined, Error>,
  directory?: string,
  authorizeSource?: (childSessionID: string, source: string, workerType?: string) => Effect.Effect<void, Error>,
  lastAssistantMessage?: (childSessionID: string) => Effect.Effect<SessionV1.WithParts | undefined, Error>,
): Effect.Effect<{ reconciled: number; ownershipLost: number; continuations?: string[] }, Error, Dag.Service> {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const nodes = yield* dag.store.getNodes(dagID)
    const messages = yield* Effect.serviceOption(DagMessages.Service)
    const workflow = Option.isSome(messages) ? yield* dag.store.getWorkflow(dagID) : undefined
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
          dag.nodeFailed(
            dagID,
            node.id,
            "node was running but had no child session on recovery",
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

      // Checker failures propagate: aborting this reconcile (callers log and
      // retry on next access) beats inventing a nodeFailed from a read error.
      const sessionStatus = yield* checkSessionStatus(node.childSessionId)

      if (Option.isSome(messages) && workflow?.directory && sessionStatus !== "failed") {
        const metadata = yield* messages.value.revisions({
          projectID: workflow.projectId,
          directory: workflow.directory,
          sessionID: node.childSessionId,
        })
        if (metadata.ok && metadata.value.queued > 0) {
          if (node.deadlineMs !== null && (yield* Clock.currentTimeMillis) >= node.deadlineMs) {
            if (
              yield* settle(
                node.id,
                dag.nodeFailed(dagID, node.id, "deadline exceeded before message recovery", "timeout", attempt),
              )
            )
              reconciled++
          } else continuations.add(node.id)
          continue
        }
      }

      if (sessionStatus === "completed") {
        // #345 parity with the live path: an unparseable workflow row must
        // not degrade into the schemaless completion below — a schema-
        // carrying node would bypass settleCapturedOutput and land as an
        // undefined output. Fail loudly instead of inventing a settlement.
        if (workflowConfig === null) {
          const settled = yield* settle(
            node.id,
            dag.nodeFailed(
              dagID,
              node.id,
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
        const nodeConfig = workflowConfig?.nodes.find((n) => n.id === node.id)
        if (nodeConfig?.output_schema && workflowConfig?.result_protocol === "final_response") {
          const message = lastAssistantMessage ? yield* lastAssistantMessage(node.childSessionId) : undefined
          const caller = workflow?.directory
            ? { projectID: workflow.projectId, directory: workflow.directory, sessionID: node.childSessionId }
            : undefined
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
              ? dag.nodeCompleted(dagID, node.id, settlement.output, {
                  ...attempt,
                  inputSnapshotID: captured.ok ? captured.snapshotID : undefined,
                })
              : dag.nodeFailed(dagID, node.id, settlement.reason, "verdict_fail", {
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
              ? dag.nodeCompleted(dagID, node.id, settlement.output, attempt)
              : dag.nodeFailed(dagID, node.id, settlement.reason, "verdict_fail", attempt),
          )
          if (settled) reconciled++
        } else {
          const finalMessage =
            workflowConfig?.result_protocol === "final_response" && lastAssistantMessage
              ? yield* lastAssistantMessage(node.childSessionId)
              : undefined
          const final =
            workflowConfig?.result_protocol === "final_response" ? finalAssistantText(finalMessage) : undefined
          const caller = workflow?.directory
            ? { projectID: workflow.projectId, directory: workflow.directory, sessionID: node.childSessionId }
            : undefined
          const frozen =
            Option.isSome(messages) && caller && finalMessage
              ? yield* messages.value.snapshotForTurn(caller, finalMessage.info.id)
              : undefined
          const snapshotID = frozen?.ok ? frozen.value?.id : undefined
          if (final?.ok && Option.isSome(messages) && !snapshotID) {
            if (
              yield* settle(
                node.id,
                dag.nodeFailed(
                  dagID,
                  node.id,
                  "recovered final assistant response has no associated input snapshot",
                  "exec_failed",
                  attempt,
                ),
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
            if (isManagedOutputFileRef(node.capturedOutput) && authorizeSource)
              yield* authorizeSource(node.childSessionId!, node.capturedOutput.source_path, node.workerType)
            yield* verifyOutputFileRef(node.capturedOutput)
          }).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              settle(node.id, dag.nodeFailed(dagID, node.id, error.message, "exec_failed", attempt)).pipe(
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
              return yield* settle(
                node.id,
                dag.nodeCompleted(dagID, node.id, ref.path, { ...attempt, inputSnapshotID: snapshotID }, ref),
              )
            }).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : settle(node.id, dag.nodeFailed(dagID, node.id, Cause.pretty(cause), "exec_failed", attempt)),
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
                dag.nodeFailed(dagID, node.id, settlement.reason, "verdict_fail", {
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
                authorizeSource
                  ? (source) => authorizeSource(node.childSessionId!, source, node.workerType)
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
                if (directory) yield* ensureReportAreaGitignore(directory, fileRef.source_path)
              }
              return yield* settle(
                node.id,
                dag.nodeCompleted(
                  dagID,
                  node.id,
                  fileRef?.path ?? rawText,
                  { ...attempt, inputSnapshotID: snapshotID },
                  fileRef,
                ),
              )
            }).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : settle(node.id, dag.nodeFailed(dagID, node.id, Cause.pretty(cause), "exec_failed", attempt)),
              ),
            )
            if (completed) reconciled++
          }
        }
      } else if (sessionStatus === "failed") {
        if (
          yield* settle(
            node.id,
            dag.nodeFailed(dagID, node.id, "child session failed (recovered)", "exec_failed", attempt),
          )
        )
          reconciled++
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
              dag.nodeFailed(
                dagID,
                node.id,
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
          dag.nodeFailed(dagID, node.id, "execution ownership lost on recovery", "exec_failed", attempt),
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
        nodes: Pick<NodeConfig, "id" | "output_schema" | "review" | "input_mapping">[]
        result_protocol?: ResultProtocol
      }
    | null
    | undefined,
  directory?: string,
  authorizeSource?: (childSessionID: string, source: string, workerType?: string) => Effect.Effect<void, Error>,
): Effect.Effect<void, Error, Dag.Service | SessionPrompt.Service> {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const prompt = yield* SessionPrompt.Service
    const messages = yield* Effect.serviceOption(DagMessages.Service)
    const node = yield* dag.store.getNode(dagID, nodeID)
    const workflow = yield* dag.store.getWorkflow(dagID)
    if (
      Option.isNone(messages) ||
      !node?.childSessionId ||
      node.status !== "running" ||
      !workflow?.directory ||
      !["running", "stepping"].includes(workflow.status)
    )
      return
    const childSessionID = node.childSessionId
    const caller = { projectID: workflow.projectId, directory: workflow.directory, sessionID: childSessionID }
    const attempt = { replanAttempts: node.replanAttempts, childSessionID }
    yield* Effect.gen(function* () {
      const nodeConfig = config?.nodes.find((n) => n.id === nodeID)
      const latest = yield* messages.value.latestSnapshot(caller)
      if (latest?.ok && latest.value?.stopReason) {
        yield* dag.nodeFailed(
          dagID,
          nodeID,
          `message recovery blocked: ${latest.value.stopReason}`,
          "exec_failed",
          attempt,
        )
        return
      }
      const admit = Effect.gen(function* () {
        for (;;) {
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
            yield* dag.nodeFailed(
              dagID,
              nodeID,
              "node deadline expired before message recovery admission",
              "timeout",
              attempt,
            )
            return false
          }
          if (wf.status !== "paused") return true
          yield* Effect.sleep(250)
        }
      })
      if (!(yield* admit)) return
      if (config?.result_protocol === "final_response") registerFinalResponseSession(childSessionID)
      if (nodeConfig?.output_schema) registerCaptureSlot(childSessionID, nodeConfig.output_schema)
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
          yield* dag.nodeFailed(
            dagID,
            nodeID,
            "recovered model turn stopped without a successful result",
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
              return yield* dag.nodeFailed(dagID, nodeID, settlement.reason, "verdict_fail", {
                ...attempt,
                inputSnapshotID: snapshotID,
              })
            return yield* dag.nodeCompleted(dagID, nodeID, settlement.output, {
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
              return yield* dag.nodeFailed(dagID, nodeID, settlement.reason, "verdict_fail", attempt)
            return yield* dag.nodeCompleted(dagID, nodeID, settlement.output, {
              ...attempt,
              inputSnapshotID: current.capturedSnapshotID ?? undefined,
            })
          }
          const final = finalAssistantText(result, true)
          const settlement = settlePlainTextOutput(final.ok ? final.text : undefined)
          if (settlement.kind === "fail")
            return yield* dag.nodeFailed(dagID, nodeID, settlement.reason, "verdict_fail", {
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
            authorizeSource ? (source) => authorizeSource(childSessionID, source, current.workerType) : undefined,
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
            if (directory) yield* ensureReportAreaGitignore(directory, ref.source_path)
          }
          return yield* dag.nodeCompleted(
            dagID,
            nodeID,
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
          yield* dag.nodeFailed(
            dagID,
            nodeID,
            `message recovery continuation blocked: ${frozen.value.stopReason}`,
            "exec_failed",
            attempt,
          )
          return
        }
        const inbox = yield* messages.value.revisions(caller)
        if (!(yield* admit)) return
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
            const failed = yield* dag
              .nodeFailed(
                dagID,
                nodeID,
                `unchanged agent input cannot retry structured result: ${claim.ok ? "resubmission already requested" : claim.reason}`,
                "exec_failed",
                { ...attempt, ...(claim.ok ? { expectedAcceptedRevision: inbox.value.accepted } : {}) },
              )
              .pipe(
                Effect.as(true),
                Effect.catchIf(isStaleMessageInput, () => Effect.succeed(false)),
              )
            if (failed) return
            nudge = false
          }
        }
        result = nudge
          ? yield* prompt.prompt({
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
            })
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
  nodeConfig: Pick<NodeConfig, "review" | "input_mapping">,
  rows: readonly DagStore.NodeRow[],
  captured: unknown,
  submitted?: boolean,
): CapturedSettlement {
  if (nodeConfig.review?.phase !== "diff") return settleCapturedOutput(captured, undefined, " (recovered)", submitted)
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
  return settleCapturedOutput(captured, fingerprint, " (recovered)", submitted)
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
