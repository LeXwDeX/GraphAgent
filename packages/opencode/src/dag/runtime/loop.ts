// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

export * as DagLoop from "./loop"

import {
  Cause,
  Effect,
  Layer,
  Context,
  Stream,
  Semaphore,
  Fiber,
  Option,
  DateTime,
  Clock,
  Schema,
  Scope,
  Exit,
  Deferred,
} from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { Hash } from "@opencode-ai/core/util/hash"
import { Database } from "@opencode-ai/core/database/database"
import { DagLocation } from "../location"
import { WorkflowRuntime, toSchedulingNodes } from "@opencode-ai/core/dag/core/scheduling"
import {
  isNodeTerminalStatus,
  isTransitionRejection,
  isWorkflowTerminalStatus,
  isTerminalWorkflowStatusValue,
} from "@opencode-ai/core/dag/core/types"
import { Dag, type WorkflowConfig, parseWorkflowConfig, resultProtocol } from "../dag"
import { projectBriefForNode } from "../admission"
import {
  reviewImplementationFingerprint,
  reviewContractForNode,
  validateReviewExecutionInput,
  reviewEvidenceKeys,
} from "../review-lifecycle"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import * as MessageV2 from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionAutomationLease } from "@/session/automation-lease"
import { renderTemplate } from "../templates/resolve"
import { sanitizeInput } from "../templates/sanitize"
import { DagConfig } from "../config"
import { spawnNode, makeDeadlineWatcher } from "./spawn"
import { evaluateCondition, resolveInputMapping, resolveInputMappingChecked, parseInputMappingReference } from "./eval"
import {
  reconcileWorkflow,
  continueRecoveredMessageNode,
  makeSessionStatusChecker,
  makeLastAssistantTextReader,
  makeLastAssistantMessageReader,
} from "./recovery"
import { Checkpoint } from "./checkpoint"
import { verifyOutputFileRef, isManagedOutputFileRef } from "./output-ref"
import { makeArtifactSourceAuthorizer } from "./artifact-permissions"
import { Permission } from "@/permission"
import { deliverReport, selectReportNode } from "./report-delivery"

const parseJsonOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const PAUSED_REMINDER_DELAY_MS = 5 * 60_000

/** Stable local receipt for the exact durable wake batch, including execution
 * identity and event revisions. Repeated text from a new attempt is new input. */
export function wakeBatchIdentity(sessionID: string, batch: DagStore.WakeBatch) {
  const identity = Hash.sha256(
    JSON.stringify([
      sessionID,
      batch.nodes
        .map((node) => [
          node.workflowId,
          node.id,
          node.childSessionId,
          node.replanAttempts,
          node.seq,
          node.status,
          node.deadlineMs,
          node.timeoutExtensions,
        ])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      batch.workflows
        .map((workflow) => [workflow.id, workflow.graphRev, workflow.seq, workflow.status])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ]),
  )
  return { messageID: MessageID.make(`msg_dag_wake_${identity}`), partID: PartID.make(`prt_dag_wake_${identity}`) }
}

export function isPausedReminderDue(
  workflow: Pick<DagStore.WorkflowRow, "status" | "wakeReported" | "timeUpdated">,
  now: number,
) {
  return (
    workflow.status === "paused" && !workflow.wakeReported && now - workflow.timeUpdated >= PAUSED_REMINDER_DELAY_MS
  )
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DagLoop") {}

interface WorkflowEntry {
  runtime: WorkflowRuntime
  semaphore: Semaphore.Semaphore
  evalLock: Semaphore.Semaphore
  parentSessionID: string
  config: WorkflowConfig | undefined
  /** Durable graph revision paired with config and the scheduling runtime. */
  graphRev: number
  fibers: Map<string, Fiber.Fiber<unknown, unknown>>
  watchers: Map<string, Fiber.Fiber<unknown, unknown>>
  /** Accepted messages preserve an existing running attempt through recovery. */
  messageContinuations: Set<string>
  /** DAG-03/F2: a replan-verdict veto whose durable pause could not be
   * persisted. While set, the in-memory paused flag survives the durable-row
   * re-syncs performed by node terminal events and refreshControlFlags, so
   * no stimulus spawns the vetoed direction before the parent acts. Released
   * by the parent's explicit control events — replan and step are reachable
   * from every hold state; resume only when the durable row is not running
   * (paused/stepping — a held row reads "running" and resume is an invalid
   * transition there until a durable pause lands; control(replan) is the
   * disposition the verdict asked for). This is only the process-local
   * fallback: restart reconstruction re-evaluates the durable checkpoint and
   * its later control-event sequence before scheduling or completion. */
  vetoHold: boolean
}

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const store = yield* DagStore.Service
    const messageSvc = Option.getOrUndefined(yield* Effect.serviceOption(DagMessages.Service))
    const dag = yield* Dag.Service
    const agentSvc = yield* Agent.Service
    const sessionSvc = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
    const permissionSvc = Option.getOrUndefined(yield* Effect.serviceOption(Permission.Service))
    const statusSvc = yield* SessionStatus.Service
    const automation = yield* SessionAutomationLease.Service
    const database = yield* Database.Service

    const state = yield* InstanceState.make(
      Effect.fn("DagLoop.state")(function* (ctx) {
        const stateScope = yield* Scope.Scope
        const runtimes = new Map<string, WorkflowEntry>()
        // Adoption in-flight reservations: recoverWorkflow spans async yield
        // points before it publishes its entry into `runtimes`, so a plain
        // runtimes.has check is check-then-act. Reserved synchronously at
        // adoption entry, released when the adoption settles.
        const recovering = new Set<string>()
        const wakeInFlight = new Set<string>()
        const wakePending = new Set<string>()
        // Cache the receipt only as an optimization. Exact durable message/part
        // lookup below survives a crash between admission and wake marking.
        const deliveredWakeSummaries = new Map<string, string>()

        // Seed the commented global dag.jsonc once per instance init — the
        // per-round DagConfig.load below stays a pure read so the spawn
        // scheduling hot path never writes to the user's config dir.
        yield* DagConfig.load(ctx.directory, { autoSeed: true }).pipe(Effect.ignore)

        const checkpointDisposition = Effect.fn("DagLoop.checkpointDisposition")(function* (
          dagID: string,
          checkpoint: Checkpoint.ReplanCheckpoint,
        ) {
          const attempt = dag
            .pauseForCheckpoint(dagID, checkpoint.seq)
            .pipe(Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.void)))
          const first = yield* attempt
          if (first) return first
          const second = yield* attempt
          if (second) return second

          const workflow = yield* store.getWorkflow(dagID).pipe(
            Effect.catchCause(() => Effect.void),
          )
          if (
            !workflow ||
            workflow.status === "completed" ||
            workflow.status === "failed" ||
            workflow.status === "cancelled" ||
            workflow.status === "archived"
          )
            return "inactive" as const
          if (workflow.status === "paused") return "paused" as const
          yield* Effect.logError(
            "DagLoop checkpoint pause failed after retries — holding scheduling in memory (fail-closed)",
            { dagID, nodeID: checkpoint.id, checkpointSeq: checkpoint.seq, durableStatus: workflow.status },
          )
          return "held" as const
        })

        const enforceCheckpointGate = Effect.fn("DagLoop.enforceCheckpointGate")(function* (
          dagID: string,
          entry: WorkflowEntry,
          nodes?: readonly DagStore.NodeRow[],
        ) {
          const checkpoint = Checkpoint.latestReplanCheckpoint(entry.config, nodes ?? (yield* store.getCurrentNodes(dagID)))
          if (!checkpoint) return false

          const disposition = yield* checkpointDisposition(dagID, checkpoint)
          if (disposition === "paused" || disposition === "held") {
            entry.vetoHold = disposition === "held"
            entry.runtime.setPaused(true)
            return true
          }

          // A newer resume/replan/step disposed of the verdict while this
          // event waited for the loop lock. Re-read the current control state:
          // an even newer manual pause still wins, while a running workflow
          // may continue converging normally.
          entry.vetoHold = false
          const workflow = yield* store.getWorkflow(dagID)
          entry.runtime.setPaused(workflow?.status === "paused")
          entry.runtime.setStepMode(workflow?.status === "stepping")
          return false
        })

        const convergeSkippedNodes = Effect.fn("DagLoop.convergeSkippedNodes")(function* (
          dagID: string,
          entry: WorkflowEntry,
        ) {
          // D13: settle cascade-skips before spawning. A node whose dependencies
          // are all skipped can never receive a real input; publish a durable
          // NodeSkipped(orphan_cascade) wave by wave until a fixpoint so gated
          // subtrees terminalize instead of running on placeholder inputs.
          // Eagerly markSkipped so the fixpoint advances synchronously; the
          // NodeSkipped handler's isActive guard then no-ops on these events.
          for (;;) {
            const cascade = entry.runtime.getCascadeSkipNodes()
            if (cascade.length === 0) return
            for (const nodeID of cascade) {
              const node = yield* store.getNode(dagID, nodeID)
              if (!node) return
              const attempt = {
                replanAttempts: node.replanAttempts,
                nodeSeq: node.seq,
                graphRev: entry.graphRev,
              }
              const skipped = yield* dag.nodeSkipped(dagID, nodeID, "orphan_cascade", attempt).pipe(
                Effect.as(true),
                Effect.catchIf(isTransitionRejection, () => Effect.succeed(false)),
              )
              // A replan can replace this row between the read and publish.
              // Only advance the old runtime after the durable guarded write
              // succeeds; its WorkflowReplanned handler will rebuild later.
              if (!skipped) return
              entry.runtime.markSkipped(nodeID)
            }
          }
        })

        let startMessageContinuations: (dagID: string, entry: WorkflowEntry) => Effect.Effect<void> = () => Effect.void
        const spawnReady = Effect.fn("DagLoop.spawnReady")(function* (dagID: string) {
          const entry = runtimes.get(dagID)
          if (!entry) return
          // P2-C execution-location revalidation: every spawn call site funnels
          // through here. A workflow whose durable identity was repainted
          // (identity migration) or cascade-deleted must not keep scheduling
          // children under this instance's directory context — drop the stale
          // entry so no later stimulus acts on it either (its watchers
          // self-exit on terminal rows; its prompt fibers finish naturally).
          if (!(yield* DagLocation.ownsWorkflow(dagID, ctx.directory))) {
            runtimes.delete(dagID)
            return
          }
          // Checkpoint vetoes are a scheduling boundary, not merely a
          // NodeCompleted-handler side effect. A different event stream can
          // reach spawnReady first after the durable completion, so arbitrate
          // from durable rows before every dispatch round.
          if (yield* enforceCheckpointGate(dagID, entry)) return
          yield* startMessageContinuations(dagID, entry)
          yield* convergeSkippedNodes(dagID, entry)
          const ready = entry.runtime.getReadyNodes()
          // P1-3: one snapshot per scheduling round. Every ready node's
          // dependencies are already terminal (that's what made it ready), so
          // their outputs cannot change during this loop — per-node re-reads
          // were O(ready × nodes) pure overhead.
          const nodesSnapshot = ready.length > 0 ? yield* store.getNodes(dagID) : []
          // dag.jsonc defaults are read once per scheduling round (lazy, like
          // templates) so edits apply to the next round without a restart.
          const dagConfig: DagConfig.Info = ready.length > 0 ? yield* DagConfig.load(ctx.directory) : {}
          for (const nodeID of ready) {
            const node = nodesSnapshot.find((n) => n.id === nodeID)
            if (!node) continue
            const admissionAttempt = {
              replanAttempts: node.replanAttempts,
              nodeSeq: node.seq,
              graphRev: entry.graphRev,
            }
            const nodeConfig = entry.config?.nodes.find((n) => n.id === nodeID)
            if (!nodeConfig) {
              yield* dag
                .nodeFailed(
                  dagID,
                  nodeID,
                  `Node configuration missing for active node: ${nodeID}`,
                  "exec_failed",
                  admissionAttempt,
                )
                .pipe(Effect.ignore)
              continue
            }

            if (nodeConfig.condition) {
              const outputs: Record<string, unknown> = {}
              for (const dep of node.dependsOn) {
                const depNode = nodesSnapshot.find((n) => n.id === dep)
                if (!depNode) continue
                // DAG-01: a schema-less checkpoint completes with a raw
                // string output. Normalize JSON strings before condition
                // evaluation so `.output.<field>` gates read the parsed
                // structure instead of resolving undefined — pre-fix the
                // equality gate was permanently false, every gated dependent
                // was skipped as condition_false, and checkCompletion still
                // reported the workflow COMPLETED (silent half-graph loss).
                // Mirrors the replan-verdict gate's parseJsonOption
                // normalization in the NodeCompleted handler below (issue
                // #322). Non-JSON strings fall back to the raw value:
                // whole-output equality still works, field paths stay
                // undefined (documented condition_false), and numeric
                // comparisons keep their loud failure.
                outputs[dep] = {
                  output: typeof depNode.output === "string"
                    ? Option.getOrElse(parseJsonOption(depNode.output), () => depNode.output)
                    : depNode.output,
                }
              }
              const condResult = evaluateCondition(nodeConfig.condition, outputs)
              if (!condResult.ok) {
                yield* dag
                  .nodeFailed(dagID, nodeID, condResult.error, "exec_failed", admissionAttempt)
                  .pipe(Effect.ignore)
                continue
              }
              if (!condResult.value) {
                const skipped = yield* dag.nodeSkipped(
                  dagID,
                  nodeID,
                  "condition_false",
                  admissionAttempt,
                ).pipe(
                  Effect.as(true),
                  Effect.catchIf(isTransitionRejection, () => Effect.succeed(false)),
                )
                // Keep the in-memory graph in lockstep only after the durable
                // guarded write succeeds. This still exposes the skip cascade
                // synchronously while WorkflowStepped holds evalLock.
                if (skipped) {
                  entry.runtime.markSkipped(nodeID)
                  yield* convergeSkippedNodes(dagID, entry)
                }
                continue
              }
            }

            const promptParts: { type: "text"; text: string }[] = []

            let resolvedMapping: Record<string, unknown> = {}
            const inputMapping = nodeConfig.input_mapping ?? Object.fromEntries(node.dependsOn.map((dependency) => [dependency, dependency]))
            const sourceIDs = new Set([
              ...node.dependsOn,
              ...Object.values(inputMapping).flatMap((source) => {
                const reference = parseInputMappingReference(source)
                return reference.ok ? [reference.nodeID] : []
              }),
            ])
            const inputSources = nodesSnapshot.filter((source) => sourceIDs.has(source.id) && source.status === "completed")
            const artifactsValid = yield* Effect.forEach(
              inputSources,
              (source) => verifyOutputFileRef(source.capturedOutput),
              { discard: true },
            ).pipe(
              Effect.as(true),
              Effect.catch((error) => dag.nodeFailed(
                dagID, nodeID, `Input artifact verification failed: ${error.message}`, "exec_failed", admissionAttempt,
              ).pipe(Effect.as(false))),
            )
            if (!artifactsValid) continue
            if (nodeConfig.input_mapping) {
              const resolved = resolveInputMappingChecked(inputMapping, (dependency) => {
                const source = nodesSnapshot.find((candidate) => candidate.id === dependency)
                return source?.status === "completed"
                  ? { found: true, output: source.output }
                  : { found: false }
              })
              if (!resolved.ok) {
                yield* dag
                  .nodeFailed(
                    dagID,
                    nodeID,
                    `Input mapping resolution failed: ${resolved.error}`,
                    "exec_failed",
                    admissionAttempt,
                  )
                  .pipe(Effect.ignore)
                continue
              }
              resolvedMapping = resolved.value
            } else if (Object.keys(inputMapping).length > 0) {
              resolvedMapping = resolveInputMapping(inputMapping, (depId) => {
                const depNode = nodesSnapshot.find((n) => n.id === depId)
                if (!depNode) return null
                if (depNode.output !== null) return depNode.output
                if (depNode.status === "failed") {
                  return `Dependency "${depId}" failed: ${depNode.errorReason ?? "unknown error"}`
                }
                if (depNode.status === "skipped") {
                  return `Dependency "${depId}" skipped: ${depNode.errorReason ?? "no output"}`
                }
                if (depNode.status === "aborted") return `Dependency "${depId}" aborted`
                if (depNode.status === "completed") return `Dependency "${depId}" completed without output`
                return null
              })
            }

            // Sanitize the dynamic node-output surface (LLM-generated upstream
            // outputs) before interpolation and Context serialization. Review
            // implementation evidence (diff/patch artifacts) is exempted —
            // wrapped, not rewritten — so the reviewer sees the real diff (P1-2).
            resolvedMapping = sanitizeInput(resolvedMapping, nodeConfig ? reviewEvidenceKeys(nodeConfig) : undefined)

            if (nodeConfig) {
              const reviewInput = validateReviewExecutionInput(nodeConfig, resolvedMapping)
              if (!reviewInput.valid) {
                yield* dag.nodeFailed(
                  dagID,
                  nodeID,
                  `Review input contract failed: ${reviewInput.errors.join("; ")}`,
                  "verdict_fail",
                  admissionAttempt,
                ).pipe(Effect.ignore)
                continue
              }
            }

            const resolved = yield* nodeConfig?.prompt_template
              ? renderTemplate(nodeConfig.prompt_template, ctx.directory, resolvedMapping).pipe(
                  Effect.tap((result) =>
                    result.text.trim() === ""
                      ? Effect.logWarning("DAG node resolved template is empty", { dagID, nodeID })
                      : Effect.void,
                  ),
                  Effect.map((result) => ({ ok: true as const, ...result })),
                  Effect.catch((err: unknown) =>
                    Effect.gen(function* () {
                      yield* dag
                        .nodeFailed(
                          dagID,
                          nodeID,
                          `Template resolution failed: ${String(err)}`,
                          "exec_failed",
                          admissionAttempt,
                        )
                        .pipe(Effect.ignore)
                      return { ok: false as const, text: "", unresolvedPlaceholders: [], interpolatedDynamicKeys: [] }
                    }),
                  ),
                )
              : Effect.succeed({
                  ok: true as const,
                  text: node.name,
                  unresolvedPlaceholders: [],
                  interpolatedDynamicKeys: [],
                })
            if (!resolved.ok) continue

            if (resolved.unresolvedPlaceholders.length > 0) {
              yield* dag.nodeFailed(
                dagID,
                nodeID,
                `Unresolved template placeholders: ${resolved.unresolvedPlaceholders.join(", ")}`,
                "verdict_fail",
                admissionAttempt,
              ).pipe(Effect.ignore)
              continue
            }

            promptParts.push({ type: "text", text: resolved.text })
            const recoveryContext = nodeConfig.recovery && nodeConfig.prompt_template?.input?.__workflow_recovery
            if (recoveryContext) {
              promptParts.push({
                type: "text",
                text: `\n\nRecovery context:\n${JSON.stringify(sanitizeInput({ recovery: recoveryContext }).recovery, null, 2)}`,
              })
            }

            const reviewContract = nodeConfig ? reviewContractForNode(nodeConfig) : undefined
            if (reviewContract) {
              promptParts.push({ type: "text", text: `\n\n${reviewContract}` })
            }

            if (entry.config?.mode === "deep" && entry.config.admission) {
              promptParts.push({
                type: "text",
                text: `\n\nRequirement Brief:\n${JSON.stringify(projectBriefForNode(entry.config.admission.brief), null, 2)}`,
              })
            }

            const interpolatedKeys = new Set(resolved.interpolatedDynamicKeys)
            const remainingContext = Object.fromEntries(
              Object.entries(resolvedMapping).filter(([key]) => !interpolatedKeys.has(key)),
            )
            if (Object.keys(remainingContext).length > 0) {
              promptParts.push({ type: "text", text: `\n\nContext:\n${JSON.stringify(remainingContext, null, 2)}` })
            }

            if (nodeConfig?.output_schema) {
              promptParts.push({
                type: "text",
                text:
                  resultProtocol(entry.config) === "final_response"
                    ? `\n\n[OUTPUT CONTRACT] End with exactly one JSON value matching this schema:\n${JSON.stringify(nodeConfig.output_schema, null, 2)}\nUse your final assistant answer only: no Markdown fence or surrounding prose. The runtime validates and captures it automatically. Do not send the final result through agent.send. File changes and other side effects are not rolled back if validation fails.`
                    : `\n\n[OUTPUT CONTRACT — this node's success depends on it] You MUST call the submit_result tool with a JSON payload matching this schema before ending your turn:\n${JSON.stringify(nodeConfig.output_schema, null, 2)}\nPut your full summary inside the payload. Do not repeat the payload in your message text. Writing the payload in message text does NOT count as submitting: if you end your turn without a successful submit_result call, this node FAILS and no structured result is accepted. File changes and other side effects are not rolled back; inspect them before retrying. After submit_result succeeds, end your turn without restating the result.`,
              })
            }
            if (resultProtocol(entry.config) === "final_response" && !nodeConfig?.output_schema) {
              promptParts.push({
                type: "text",
                text: "\n\n[FINAL ANSWER] End with your complete final answer. It is captured automatically; do not also report it through agent.send. Use agent.send for questions, decisions and collaboration.",
              })
            }

            yield* spawnNode(entry.semaphore, {
              dagID,
              nodeID,
              node,
              graphRev: entry.graphRev,
              onAdmitted: Effect.gen(function* () {
                entry.runtime.markRunning(nodeID)
                const oldFiber = entry.fibers.get(nodeID)
                const oldWatcher = entry.watchers.get(nodeID)
                yield* abortChild(nodeID, node.childSessionId).pipe(Effect.ignore)
                if (oldFiber) yield* Fiber.interrupt(oldFiber).pipe(Effect.ignore)
                // Interrupt the old watcher before installing a new one. The
                // old self-renewing watcher would otherwise become unreachable
                // after the map overwrite and keep escalating stale deadlines.
                if (oldWatcher) yield* Fiber.interrupt(oldWatcher).pipe(Effect.ignore)
              }),
              parentSessionID: entry.parentSessionID,
              directory: ctx.directory,
              inputArtifacts: inputSources.map((source) => source.capturedOutput).filter(isManagedOutputFileRef),
              promptParts,
              outputSchema: nodeConfig?.output_schema as Record<string, unknown> | undefined,
              resultProtocol: resultProtocol(entry.config),
              timeoutMs: nodeConfig?.worker_config?.timeout_ms,
              reportToParent: nodeConfig?.report_to_parent,
              reviewImplementationFingerprint: nodeConfig
                ? reviewImplementationFingerprint(nodeConfig, resolvedMapping)
                : undefined,
              fallbackModel: DagConfig.tierModel(dagConfig, { required: node.required, workerType: node.workerType }),
              variant: dagConfig.thinking_depth,
              maxTimeoutExtensions: entry.config?.max_timeout_extensions ?? Dag.DEFAULT_WORKFLOW_CONFIG.maxTimeoutExtensions,
            }).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  entry.fibers.set(nodeID, result.fiber)
                  entry.watchers.set(nodeID, result.watcherFiber)
                }),
              ),
              Effect.provideService(Dag.Service, dag),
              Effect.provideService(Agent.Service, agentSvc),
              Effect.provideService(Session.Service, sessionSvc),
              Effect.provideService(SessionPrompt.Service, promptSvc),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : dag.nodeFailed(dagID, nodeID, Cause.pretty(cause), "exec_failed", admissionAttempt),
              ),
              Effect.ignore,
            )
          }
        })

        const checkCompletion = Effect.fn("DagLoop.checkCompletion")(function* (dagID: string) {
          const entry = runtimes.get(dagID)
          if (!entry) return
          if (!entry.runtime.isComplete()) return
          // A reporting leaf checkpoint is already runtime-complete. Recover
          // and enforce its veto before publishing WorkflowCompleted.
          if (yield* enforceCheckpointGate(dagID, entry)) return
          // Replan registers replacement nodes before cancelling nodes from the
          // old runtime graph. Event types are consumed independently, so the
          // cancellation handler can reach this point before WorkflowReplanned
          // rebuilds the in-memory graph. Durable active nodes prove that the
          // apparent completion belongs to an obsolete graph generation.
          // Rev-view (v1.0.15 Train A): the guard read filters to the current
          // revision — superseded rows are terminal and never trip the guard,
          // and the review-outcome input below must judge only current nodes.
          const nodes = yield* store.getCurrentNodes(dagID)
          const hasUnseenActiveNode = nodes.some(
            (node) => !isNodeTerminalStatus(node.status as never) && !entry.runtime.containsNode(node.id),
          )
          if (hasUnseenActiveNode) return
          // R6 identity revalidation: the ownership predicate re-reads the
          // durable row on every check. A workflow whose durable identity was
          // repainted (identity migration) or whose location moved away no
          // longer belongs to this in-memory entry — the stale entry must not
          // publish a workflow transition (complete/fail) for it.
          if (!(yield* DagLocation.ownsWorkflow(dagID, ctx.directory))) return
          const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
          if (wf && isWorkflowTerminalStatus(wf.status as never)) return
          // paused → completed/failed is not a legal transition: a node that
          // settles while the workflow is paused leaves the graph complete but
          // parked. Completion is re-checked when the workflow leaves pause
          // (WorkflowResumed / WorkflowStepped / replan) or when it is
          // cancelled; attempting it here would only fail the handler.
          if (wf?.status === "paused") return
          // A required-node failure is a workflow FAILURE, not a cancellation —
          // "cancelled" is reserved for explicit user/agent cancels so the
          // terminal status attributes the outcome correctly (P2-1).
          if (entry.runtime.hasRequiredFailure()) {
            yield* dag.fail(dagID, `required node(s) failed: ${entry.runtime.getRequiredFailures().join(", ")}`)
            return
          }
          // Unresolved review outcomes terminalize the graph as COMPLETED at
          // the checkpoint, not as a failure: the REJECT shape (skipped
          // dependents, reporting leaf) is exactly what reopen-extend is
          // designed to pick up, and a failed workflow is immutable
          // (issue #294). Explicit completion shortcuts keep the review gate.
          yield* dag.complete(dagID, { skipReviewGate: true })
        })

        const checkSessionStatus = makeSessionStatusChecker(sessionSvc)
        // #345: schemaless recovered nodes settle with the child's last
        // assistant text, mirroring the live spawn path.
        const lastAssistantText = makeLastAssistantTextReader(sessionSvc)
        const lastAssistantMessage = makeLastAssistantMessageReader(sessionSvc)

        // Best-effort abort of a durable child session, independent of whether
        // a local wrapper fiber still exists.  Used at every replacement,
        // cancellation, failure, and workflow-terminal cleanup site.
        const abortChild = Effect.fnUntraced(function* (nodeID: string, childSessionId: string | null) {
          if (!childSessionId) return
          yield* promptSvc.cancel(childSessionId as never).pipe(Effect.ignore)
        })

        // Subscription handlers must never die. dag.ts guards and checkCompletion
        // use orDie, whose defects punch straight through Effect.ignore (it only
        // absorbs the error channel) and would kill the forked runForEach fiber —
        // leaving that event type permanently unhandled for the rest of the
        // process. catchCause absorbs failures AND defects at the boundary.
        const guarded =
          (event: string) =>
          <A, E, R>(self: Effect.Effect<A, E, R>) =>
            self.pipe(Effect.catchCause((cause) => Effect.logWarning("DagLoop handler failed", { event, cause })))
        // Node-terminal handlers fork the parent wake drain after their
        // evalLock body even when that body fails or dies (e.g. a rejected
        // workflow transition): the durable node row is already terminal and
        // unreported, so the parent must still be woken. Interruption (scope
        // teardown) skips the fork.
        const forkWakeAfter =
          (sessionID: string) =>
          <A, E>(exit: Exit.Exit<A, E>) =>
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
              ? Effect.void
              : tryDeliverWake(sessionID).pipe(Effect.ignore, Effect.forkScoped, Effect.asVoid)

        startMessageContinuations = Effect.fn("DagLoop.startMessageContinuations")(function* (
          dagID: string,
          entry: WorkflowEntry,
        ) {
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
            const continuation = entry.semaphore
              .withPermits(1)(
                Deferred.await(registered).pipe(
                  Effect.andThen(
                    continueRecoveredMessageNode(
                      dagID,
                      nodeID,
                      entry.config ?? null,
                      ctx.directory,
                      makeArtifactSourceAuthorizer(sessionSvc, agentSvc, ctx.worktree, permissionSvc),
                    ),
                  ),
                ),
              )
              .pipe(
                Effect.provideService(Dag.Service, dag),
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
                    if (
                      current?.childSessionId !== node.childSessionId ||
                      current.replanAttempts !== node.replanAttempts
                    )
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
            const nodeConfig = entry.config?.nodes.find((candidate) => candidate.id === nodeID)
            const watcher =
              entry.watchers.get(nodeID) ??
              (yield* makeDeadlineWatcher({
                dagID,
                nodeID,
                attempt: { replanAttempts: node.replanAttempts, childSessionID: node.childSessionId },
                timeoutMs: nodeConfig?.worker_config?.timeout_ms,
                maxTimeoutExtensions:
                  entry.config?.max_timeout_extensions ?? Dag.DEFAULT_WORKFLOW_CONFIG.maxTimeoutExtensions,
              }).pipe(
                Effect.provideService(Dag.Service, dag),
                Effect.provideService(SessionPrompt.Service, promptSvc),
                Effect.forkIn(stateScope),
              ))
            entry.watchers.set(nodeID, watcher)
            entry.messageContinuations.delete(nodeID)
            yield* Deferred.succeed(registered, undefined)
          }
        })

        const recoverWorkflow = Effect.fn("DagLoop.recoverWorkflow")(function* (wf: DagStore.WorkflowRow) {
          // Cross-instance guard: DagLoop is per-directory InstanceState but the
          // event bus and store are process-global. Only the instance whose
          // DIRECTORY owns the workflow may adopt it — otherwise a
          // multi-directory server spawns children under a foreign directory
          // context. The execution-location authority (dag/location.ts)
          // re-reads the durable row: the project id is a fast-reject, the
          // stamped directory is the deciding guard.
          if (!(yield* DagLocation.ownsWorkflow(wf.id, ctx.directory))) return
          const dagID = wf.id
          // Idempotency guard: the startup scan and the WorkflowReplanned
          // handler's re-adoption path can both reach here for the same
          // workflow (e.g. a replan call arriving while the scan is still
          // reconciling it). A duplicate adoption would reconcile twice and
          // overwrite the runtimes entry — orphaning the first entry's fibers
          // from every interrupt sweep. Reserve synchronously before the
          // first yield so the second caller drops out immediately.
          if (runtimes.has(dagID) || recovering.has(dagID)) return
          recovering.add(dagID)
          // Effect.ensuring releases the adoption slot even when a fiber
          // interrupt cuts the adoption sequence — a finally block does not
          // survive interruption.
          yield* Effect.gen(function* () {
            const config = parseWorkflowConfig(wf.config)
            const recovery = yield* reconcileWorkflow(
              dagID,
              checkSessionStatus,
              (sid) => promptSvc.cancel(sid as never),
              // null (not undefined) marks an unparseable row so recovery
              // fails such nodes loudly instead of undefined-completing them.
              config ?? null,
              lastAssistantText,
              ctx.directory,
              makeArtifactSourceAuthorizer(sessionSvc, agentSvc, ctx.worktree, permissionSvc),
              lastAssistantMessage,
            ).pipe(Effect.provideService(Dag.Service, dag), (self) =>
              messageSvc ? Effect.provideService(self, DagMessages.Service, messageSvc) : self,
            )
            // P2-2 recovery-pause: reconciliation invented failures (ownership
            // lost / no child session / deadline enforced offline) without any
            // durable proof of the child's outcome. Letting spawnReady cascade
            // skips and checkCompletion terminalize now would weld the workflow
            // into a terminal status the parent never sanctioned — and terminal
            // nodes are immutable, so replan could no longer rewire downstream.
            // Pause instead: pending nodes stay replannable, the durable
            // NodeFailed wake rows reach the parent at the paused delivery
            // boundary, and disposition (replan / resume / cancel) stays under
            // explicit workflow control.
            const pausedForRecovery = recovery.ownershipLost > 0 && wf.status === "running"
            if (pausedForRecovery) {
              // #349/NEW-2: a pause rejected by a CONCURRENT TERMINAL control
              // op means this instance no longer controls the workflow —
              // abandoning adoption is correct. But a lock-timeout or store
              // defect used to take the same silent path: the invented
              // NodeFailed rows were persisted with no runtime entry, events
              // filtered by runtimes.has, wake boundaries requiring an entry —
              // the workflow stalled until a process restart. Mirror the
              // replan-verdict gate: retry twice, fold defects in, and only
              // abandon when the durable row is genuinely terminal.
              const pauseAccepted = yield* Effect.gen(function* () {
                const attemptPause = dag.pause(dagID).pipe(
                  Effect.map(() => true),
                  Effect.catchCause((cause) =>
                    Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(false),
                  ),
                )
                if (yield* attemptPause) return true
                if (yield* attemptPause) return true
                const row = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
                if (row && row.status !== "paused") {
                  yield* Effect.logError(
                    "DagLoop recovery pause failed after retries — workflow stays unadopted; it will be re-adopted on the next instance load",
                    { dagID, status: row.status },
                  )
                }
                return row?.status === "paused"
              })
              if (!pauseAccepted) return
              yield* Effect.logWarning("DagLoop paused workflow after recovery invented node failures", {
                dagID,
                reconciled: recovery.reconciled,
                ownershipLost: recovery.ownershipLost,
              })
            }
            if (recovery.ownershipLost > 0 && !pausedForRecovery) {
              yield* Effect.logWarning("DagLoop terminalized recovered nodes after execution ownership loss", {
                dagID,
                reconciled: recovery.reconciled,
                ownershipLost: recovery.ownershipLost,
              })
            }
            // Rev-view (v1.0.15 Train A): the recovery runtime rebuilds from
            // the CURRENT graph revision — a crash must not revive the
            // replaced segment's failures (same rebuild input as the
            // WorkflowReplanned handler). Durable truth (the unfiltered read
            // in recovery reconcile above) is untouched.
            const nodes = yield* store.getCurrentNodes(dagID)
            const checkpoint = Checkpoint.latestReplanCheckpoint(config, nodes)
            const checkpointState = checkpoint ? yield* checkpointDisposition(dagID, checkpoint) : undefined
            const pausedForCheckpoint = checkpointState === "paused" || checkpointState === "held"
            if (pausedForCheckpoint) {
              yield* Effect.logWarning("DagLoop recovered unresolved checkpoint verdict: replan", {
                dagID,
                nodeID: checkpoint?.id,
                checkpointSeq: checkpoint?.seq,
                durable: checkpointState === "paused",
              })
            }
            const currentWorkflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
            const maxConcurrency = Math.max(1, config?.max_concurrency ?? Dag.DEFAULT_WORKFLOW_CONFIG.maxConcurrency)
            const runtime = new WorkflowRuntime(toSchedulingNodes(nodes), maxConcurrency)
            const semaphore = Semaphore.makeUnsafe(maxConcurrency)
            const isPaused = currentWorkflow?.status === "paused" || pausedForRecovery || pausedForCheckpoint
            const isStepping = currentWorkflow?.status === "stepping" && !isPaused
            if (isPaused) runtime.setPaused(true)
            if (isStepping) runtime.setStepMode(true)
            const entry: WorkflowEntry = {
              runtime,
              semaphore,
              evalLock: Semaphore.makeUnsafe(1),
              parentSessionID: wf.sessionId,
              config,
              graphRev: currentWorkflow?.graphRev ?? wf.graphRev,
              fibers: new Map(),
              watchers: new Map(),
              messageContinuations: new Set(recovery.continuations ?? []),
              vetoHold: checkpointState === "held",
            }
            // P2-E deletion-race re-check: the SessionV1.Event.Deleted sweep
            // only removes entries already published into `runtimes`. If the
            // FK cascade deleted this workflow's row while reconciliation ran,
            // publishing now would leak an inert entry the sweep can no longer
            // reach. The ensuring below still clears the recovering reservation.
            if (!(yield* DagLocation.ownsWorkflow(dagID, ctx.directory))) return
            // #270 atomic-admission fence (C3): the durable read above and the
            // runtimes publish below are still two statements — a deletion can
            // commit between them. Collapse the admission into ONE conditional
            // UPDATE that matches only while the row exists and is non-terminal.
            // A cascade committed in that final window matches zero rows and the
            // adoption aborts here, before it ever publishes an entry.
            if (!(yield* store.tryClaimAdoption(dagID))) return
            runtimes.set(dagID, entry)
            yield* automation.register(SessionID.make(wf.sessionId), { kind: "dag", id: dagID })
            // Only accepted messages may continue their existing child attempt.
            // Paused workflows defer that continuation until explicit resume.
            if (!isPaused) yield* entry.evalLock.withPermits(1)(startMessageContinuations(dagID, entry))
            if (!isPaused && !isStepping) {
              yield* entry.evalLock.withPermits(1)(
                Effect.gen(function* () {
                  yield* spawnReady(dagID)
                  yield* checkCompletion(dagID)
                }),
              )
            }
            // Deliver the invented-failure wake rows now instead of waiting for
            // the next idle event — the workflow just paused itself and the
            // parent is the only actor that can dispose of it.
            if (pausedForRecovery || pausedForCheckpoint) {
              yield* tryDeliverWake(wf.sessionId).pipe(Effect.ignore, Effect.forkScoped)
            }
          }).pipe(Effect.ensuring(Effect.sync(() => recovering.delete(dagID))))
        })

        // Orphan-pending recovery: a pending workflow with no non-pending node
        // is a create sequence that crashed mid-way — Dag.create publishes
        // WorkflowCreated + NodeRegistered + WorkflowStarted in separate
        // transactions, so a crash between them leaves a row whose start event
        // never arrives. PENDING→RUNNING is its only legal transition
        // (core/dag/core/types.ts), so nothing else can ever move it — without
        // this sweep the workflow hangs in pending forever. Terminalize via the
        // legal pending→running→failed sequence: the projector accepts
        // WorkflowFailed only from running/stepping (core/dag/projector.ts), so
        // a bare fail would be silently dropped. Failed (not cancelled) matches
        // the interrupted-create semantics and persists the reason in the
        // durable WorkflowFailed event; cancelled is reserved for explicit
        // user/agent cancels (see the checkCompletion attribution comment).
        const recoverOrphanPending = Effect.fn("DagLoop.recoverOrphanPending")(function* (wf: DagStore.WorkflowRow) {
          // Same cross-instance guard as recoverWorkflow, through the same
          // execution-location authority: only the instance whose DIRECTORY
          // owns the workflow may dispose of the orphan.
          if (!(yield* DagLocation.ownsWorkflow(wf.id, ctx.directory))) return
          const dagID = wf.id
          if (runtimes.has(dagID) || recovering.has(dagID)) return
          // Reserve the adoption slot for the whole terminalization sequence:
          // the WorkflowStarted leg is a real event on the bus, and the
          // WorkflowStarted handler must not adopt the orphan mid-sequence
          // (a zero-node orphan would be checkCompleted straight to
          // "completed" instead of being failed with the recovery reason).
          // Effect.ensuring releases the slot even when a fiber interrupt cuts
          // the sequence — a finally block does not survive interruption.
          recovering.add(dagID)
          yield* Effect.gen(function* () {
            const nodes = yield* store.getNodes(dagID)
            // Defensive no-miss-kill criterion: any non-pending node proves the
            // workflow was adopted and progressed — it is mid-flight, not
            // orphaned. All-pending rows can only be interrupted creates, since
            // create() completes its start event within the same process.
            if (!nodes.every((node) => node.status === "pending")) return
            yield* events.publish(DagEvent.WorkflowStarted, { dagID: dagID as never, timestamp: yield* DateTime.now })
            // dag.fail guards running→failed, persists the reason in the durable
            // WorkflowFailed event, and terminalizes every pending node via
            // NodeSkipped — no node is ever scheduled.
            yield* dag.fail(dagID, "orphan pending workflow recovered at startup")
            yield* Effect.logWarning("DagLoop terminalized orphan pending workflow", { dagID })
          }).pipe(Effect.ensuring(Effect.sync(() => recovering.delete(dagID))))
        })

        yield* events.subscribe(DagEvent.WorkflowStarted).pipe(
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              // Adoption-in-flight reservations (recoverWorkflow and the
              // orphan-pending sweep) must suppress this handler too: the
              // orphan sweep publishes WorkflowStarted only to legalize its
              // pending→running→failed terminalization, and adopting the
              // orphan mid-sequence would start scheduling on a dead workflow.
              //
              // H1 (DAG-LOC-01): the handler also reserves the slot for
              // ITSELF — two concurrent WorkflowStarted events (e.g. a
              // duplicate publish racing the live handler) previously both
              // passed the guard above (neither reserves anything) and both
              // reached runtimes.set: the second overwrote the first entry,
              // orphaning its fibers/watchers from every interrupt sweep and
              // double-registering the automation lease. Reserve
              // synchronously right after the guard — no yield between the
              // check and the add, so the second event's guard sees the
              // reservation — and release via Effect.ensuring, exactly
              // mirroring recoverWorkflow / recoverOrphanPending. The latch
              // also supersedes the WorkflowReplanned no-entry re-adoption
              // race: a replan arriving mid-adoption drops out of
              // recoverWorkflow instead of overwriting this entry, and the
              // adoption's own getNodes reads the already-replanned rows.
              if (runtimes.has(dagID) || recovering.has(dagID)) return
              recovering.add(dagID)
              yield* Effect.gen(function* () {
                const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
                if (!wf) return
                // Status guard: the orphan-pending sweep publishes WorkflowStarted
                // only to legalize the pending→running leg of its terminalization
                // sequence. By the time the event reaches this handler the row is
                // already failed — adopting it would rebuild a runtime and start
                // scheduling nodes on a dead workflow. Accept running rows only.
                if (wf.status !== "running") return
                // Cross-instance guard via the execution-location authority:
                // only the instance whose DIRECTORY owns the workflow adopts
                // (see recoverWorkflow). First-wave spawns must not race across
                // directory contexts.
                if (!(yield* DagLocation.ownsWorkflow(dagID, ctx.directory))) return
                const config = parseWorkflowConfig(wf.config)
                // Rev-view (v1.0.15 Train A): same current-revision rebuild
                // input as recoverWorkflow — adoption must not resurrect the
                // replaced segment's failures either.
                const nodes = yield* store.getCurrentNodes(dagID)
                const maxConcurrency = Math.max(1, config?.max_concurrency ?? Dag.DEFAULT_WORKFLOW_CONFIG.maxConcurrency)
                const runtime = new WorkflowRuntime(toSchedulingNodes(nodes), maxConcurrency)
                const semaphore = Semaphore.makeUnsafe(maxConcurrency)
                const entry: WorkflowEntry = {
                  runtime,
                  semaphore,
                  evalLock: Semaphore.makeUnsafe(1),
                  parentSessionID: wf.sessionId,
                  config,
                  graphRev: wf.graphRev,
                  fibers: new Map(),
                  watchers: new Map(),
                  messageContinuations: new Set(),
                  vetoHold: false,
                }
                // P2-E deletion-race re-check (same window as recoverWorkflow):
                // the Deleted sweep only removes entries already in `runtimes`,
                // and getNodes above is an awaited yield a deletion can slip
                // through. A row cascade-deleted after the first guard must not
                // be adopted into an inert entry.
                if (!(yield* DagLocation.ownsWorkflow(dagID, ctx.directory))) return
                // #270 atomic-admission fence (C3, same as recoverWorkflow): the
                // durable read and the runtimes publish are two statements a
                // deletion can slip between; collapse the admission into one
                // conditional UPDATE (exists + non-terminal). A cascade committed
                // in the final window matches zero rows and the adoption aborts.
                if (!(yield* store.tryClaimAdoption(dagID))) return
                runtimes.set(dagID, entry)
                yield* automation.register(SessionID.make(wf.sessionId), { kind: "dag", id: dagID })
                yield* entry.evalLock.withPermits(1)(
                  Effect.gen(function* () {
                    yield* spawnReady(dagID)
                    yield* checkCompletion(dagID)
                  }),
                )
              }).pipe(Effect.ensuring(Effect.sync(() => recovering.delete(dagID))))
            }).pipe(guarded("WorkflowStarted")),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        for (const def of [DagEvent.NodeCompleted, DagEvent.NodeSkipped, DagEvent.NodeAborted]) {
          // A completed node is an output-producing success; a skipped node is a
          // terminal no-output state that must stay distinguishable so pure-skip
          // descendants cascade instead of running (D13).
          const settle = def === DagEvent.NodeSkipped || def === DagEvent.NodeAborted
            ? (entry: WorkflowEntry, nodeID: string) => entry.runtime.markSkipped(nodeID)
            : (entry: WorkflowEntry, nodeID: string) => entry.runtime.markSatisfied(nodeID)
          yield* events.subscribe(def).pipe(
            Stream.filter((e) => runtimes.has(e.data.dagID as string)),
            Stream.runForEach((evt) =>
              Effect.gen(function* () {
                const dagID = evt.data.dagID as string
                const entry = runtimes.get(dagID)
                if (!entry) return
                yield* entry.evalLock.withPermits(1)(
                  Effect.gen(function* () {
                    const nodeID = evt.data.nodeID as string
                    // Same DB cross-check as the NodeFailed handler: projection
                    // is transactional with publish, so a row that no longer
                    // matches the event's terminal status means a later
                    // restart/replan reset it — drop the stale event without
                    // touching the new generation's fiber.
                    const expected = def === DagEvent.NodeSkipped ? "skipped" : def === DagEvent.NodeAborted ? "aborted" : "completed"
                    const node = yield* store.getNode(dagID, nodeID)
                    const confirmed = node?.status === expected
                    if (confirmed) {
                      if (def === DagEvent.NodeSkipped || def === DagEvent.NodeAborted) {
                        // Cancel-skip race: workflow-level cancel publishes NodeSkipped
                        // for running nodes, and this handler may win the cross-stream
                        // race against WorkflowCancelled. Deleting the fiber here
                        // uninterrupted would orphan it from the WorkflowCancelled
                        // sweep and the child session would keep running until its
                        // prompt finishes or times out. Stop it now, mirroring the
                        // NodeCancelled handler. Completed nodes keep the plain
                        // delete — their fiber published the event and is finishing.
                        const fiber = entry.fibers.get(nodeID)
                        if (fiber) {
                          yield* abortChild(nodeID, node?.childSessionId ?? null).pipe(Effect.ignore)
                          yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                        }
                      }
                      // N3: interrupt the watcher on BOTH terminal events. A node
                      // re-timed via replan carries a REPLACED watcher in
                      // entry.watchers; the spawn-time cleanup only interrupts the
                      // original watcherFiber, so without this the replacement
                      // lingers until its deadline wake (≤ the extended timeout)
                      // before it re-reads a terminal row and exits.
                      const watcher = entry.watchers.get(nodeID)
                      if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                      entry.fibers.delete(nodeID)
                      entry.watchers.delete(nodeID)
                    }
                    if (!confirmed) {
                      yield* Effect.logDebug("DagLoop dropped stale node terminal event", { dagID, nodeID, expected, dbStatus: node?.status ?? "missing" })
                    }
                    const workflow = yield* store.getWorkflow(dagID)
                    // F2: honor the veto hold — a durable "running" row must
                    // not lift the fail-closed pause a verdict gate set.
                    entry.runtime.setPaused(workflow?.status === "paused" || entry.vetoHold)
                    entry.runtime.setStepMode(workflow?.status === "stepping")
                    // Guard against stale events: a node already cancelled
                    // (markUnsatisfied) or already satisfied must not be flipped
                    // back. Mirrors the NodeFailed handler's isActive guard.
                    let checkpointHeld = false
                    if (confirmed && entry.runtime.isActive(nodeID)) {
                      settle(entry, nodeID)
                      checkpointHeld = yield* enforceCheckpointGate(dagID, entry)
                      if (checkpointHeld) {
                        yield* Effect.logWarning("DagLoop paused workflow after gate verdict: replan", {
                          dagID,
                          nodeID,
                        })
                      }
                      // In stepMode, do NOT auto-advance — wait for the next
                      // explicit step command.
                      if (!checkpointHeld && !entry.runtime.isStepMode()) yield* spawnReady(dagID)
                    }
                    if (!checkpointHeld) yield* checkCompletion(dagID)
                  }),
                ).pipe(
                  // P1-2: trigger wake check directly on node terminal — the
                  // parent session may already be idle (no new idle event will
                  // fire), so we can't rely on the idle subscription alone.
                  Effect.onExit(forkWakeAfter(entry.parentSessionID)),
                )
              }).pipe(guarded(def === DagEvent.NodeSkipped ? "NodeSkipped" : def === DagEvent.NodeAborted ? "NodeAborted" : "NodeCompleted")),
            ),
            Effect.forkScoped({ startImmediately: true }),
          )
        }

        yield* events.subscribe(DagEvent.NodeCancelled).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              const entry = runtimes.get(dagID)
              if (!entry) return
              const nodeID = evt.data.nodeID as string
              yield* entry.evalLock.withPermits(1)(
                Effect.gen(function* () {
                  const fiber = entry.fibers.get(nodeID)
                  const node = yield* store.getNode(dagID, nodeID)
                  yield* abortChild(nodeID, node?.childSessionId ?? null).pipe(Effect.ignore)
                  if (fiber) {
                    yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                    entry.fibers.delete(nodeID)
                  }
                  const watcher = entry.watchers.get(nodeID)
                  if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                  entry.watchers.delete(nodeID)
                  entry.runtime.markUnsatisfied(nodeID)
                  yield* checkCompletion(dagID)
                }),
              )
            }).pipe(guarded("NodeCancelled")),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        yield* events.subscribe(DagEvent.NodeFailed).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
            Stream.runForEach((evt) =>
              Effect.gen(function* () {
                const dagID = evt.data.dagID as string
                const entry = runtimes.get(dagID)
                if (!entry) return
                yield* entry.evalLock.withPermits(1)(
                  Effect.gen(function* () {
                    const nid = evt.data.nodeID as string
                    // Generation arbitration via DB status: each projector runs
                    // INSIDE the durable publish transaction (core/dag/projector.ts),
                    // so by the time this handler consumes the event the row
                    // already reflects it. If the row is no longer "failed", a
                    // later NodeRestarted/replan reset the node — this event
                    // belongs to a previous generation and must not touch the
                    // new one (including the fiber map, which may already hold
                    // the new attempt's fiber). No generation field needed.
                    const node = yield* store.getNode(dagID, nid)
                    // #3: only markUnsatisfied if the runtime still tracks this
                    // node as non-terminal. A stale NodeFailed event (e.g. from
                    // a replan-ceiling check after the node already completed)
                    // would incorrectly flip a satisfied node to unsatisfied.
                    if (node?.status === "failed" && entry.runtime.isActive(nid)) {
                      const fiber = entry.fibers.get(nid)
                      const watcher = entry.watchers.get(nid)
                      entry.fibers.delete(nid)
                      entry.watchers.delete(nid)
                      yield* abortChild(nid, node.childSessionId ?? null).pipe(Effect.ignore)
                      if (fiber) yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                      if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                      entry.runtime.markUnsatisfied(nid)
                      if (!entry.runtime.isStepMode()) yield* spawnReady(dagID)
                    }
                    if (node?.status !== "failed") {
                      yield* Effect.logDebug("DagLoop dropped stale NodeFailed", { dagID, nodeID: nid, dbStatus: node?.status ?? "missing" })
                    }
                    // In stepMode, checkCompletion (which can trigger autonomous
                    // fail/complete) still runs, but spawnReady is skipped —
                    // stepping must NOT auto-advance after a node fails.
                    yield* checkCompletion(dagID)
                  }),
                ).pipe(Effect.onExit(forkWakeAfter(entry.parentSessionID)))
              }).pipe(guarded("NodeFailed")),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        // Timeout escalation: the node keeps RUNNING — the runtime needs no
        // state change. The event's only job is to wake the main agent so it
        // can adjudicate (extend via replan with a new timeout_ms, or
        // cancel/replan). Delivery re-reads the wake snapshot, where the
        // escalated running node now appears (timeout_extensions > 0).
        yield* events.subscribe(DagEvent.NodeTimeoutEscalated).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              const entry = runtimes.get(dagID)
              if (!entry) return
              yield* tryDeliverWake(entry.parentSessionID).pipe(Effect.ignore, Effect.forkScoped)
            }).pipe(guarded("NodeTimeoutEscalated")),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        // Workflow-control handlers cross-check the durable row under the
        // evalLock before mutating runtime flags: projection is transactional
        // with publish, so the row reflects this event or a later one — never
        // an earlier one. Applying the event's implied flags blindly lets a
        // cross-stream ordering (pause/resume/step race) clobber a newer
        // control decision. Mirrors the node handlers' DB arbitration.
        const refreshControlFlags = Effect.fnUntraced(function* (dagID: string, entry: WorkflowEntry) {
          const workflow = yield* store.getWorkflow(dagID)
          if (!workflow || isWorkflowTerminalStatus(workflow.status as never)) return undefined
          // F2: honor the veto hold — see WorkflowEntry.vetoHold.
          entry.runtime.setPaused(workflow.status === "paused" || entry.vetoHold)
          entry.runtime.setStepMode(workflow.status === "stepping")
          return workflow
        })

        yield* events.subscribe(DagEvent.WorkflowPaused).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              const entry = runtimes.get(dagID)
              if (!entry) return
              yield* entry.evalLock.withPermits(1)(refreshControlFlags(dagID, entry))
            }).pipe(guarded("WorkflowPaused")),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        yield* events.subscribe(DagEvent.WorkflowStepped).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              const entry = runtimes.get(dagID)
              if (!entry) return
              yield* entry.evalLock.withPermits(1)(
                Effect.gen(function* () {
                  // F2 (DAG-03): resume/step is the parent's explicit control —
                  // release the fail-closed veto hold before the flag re-sync.
                  entry.vetoHold = false
                  const workflow = yield* refreshControlFlags(dagID, entry)
                  if (workflow?.status !== "stepping") return
                  // Dag.step validated "no in-flight node" on a DB snapshot
                  // taken outside this evalLock; a terminal-event handler can
                  // spawn in between (its DB status read predated the stepped
                  // projection). Spawning now would put a second node in
                  // flight under stepping — leave advancement to the next
                  // explicit step command instead.
                  if (entry.runtime.hasRunning()) return
                  yield* spawnReady(dagID)
                  // spawnReady may have paused on a durable checkpoint. Only
                  // converge and terminalize when that scheduling gate stayed
                  // open. These operations dispatch no additional child.
                  if (entry.runtime.isPaused()) return
                  yield* convergeSkippedNodes(dagID, entry)
                  yield* checkCompletion(dagID)
                }),
              )
            }).pipe(guarded("WorkflowStepped")),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        yield* events.subscribe(DagEvent.WorkflowResumed).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              const entry = runtimes.get(dagID)
              if (!entry) return
              yield* entry.evalLock.withPermits(1)(
                Effect.gen(function* () {
                  // F2 (DAG-03): resume/step is the parent's explicit control —
                  // release the fail-closed veto hold before the flag re-sync.
                  entry.vetoHold = false
                  const workflow = yield* refreshControlFlags(dagID, entry)
                  if (workflow?.status === "running") yield* spawnReady(dagID)
                  // A workflow can be resumed with every node already settled
                  // (e.g. recovery-pause on a single lost node). Without this,
                  // nothing else re-runs completion and the workflow hangs in
                  // running forever.
                  yield* checkCompletion(dagID)
                }),
              )
            }).pipe(guarded("WorkflowResumed")),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        yield* events.subscribe(DagEvent.WorkflowReplanned).pipe(
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              const entry = runtimes.get(dagID)
              if (!entry) {
                const workflow = yield* store.getWorkflow(dagID)
                if (workflow) yield* recoverWorkflow(workflow)
                return
              }
              yield* entry.evalLock.withPermits(1)(
                Effect.gen(function* () {
                  const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
                  // F2 (DAG-03): a replan is the parent's explicit disposition
                  // of the verdict — release the fail-closed veto hold and
                  // re-sync the control flags from the durable row (this
                  // handler never refreshed them, so a hold set by the verdict
                  // gate would otherwise silence the trailing spawnReady
                  // forever and the corrective nodes would never run).
                  entry.vetoHold = false
                  entry.runtime.setPaused(wf?.status === "paused")
                  entry.runtime.setStepMode(wf?.status === "stepping")
                  const oldConfig = entry.config
                  if (wf) {
                    entry.config = parseWorkflowConfig(wf.config)
                    entry.graphRev = wf.graphRev
                  }
                  // Rev-view (v1.0.15 Train A): THE aggregation filter point.
                  // The rebuild input is the CURRENT graph revision only —
                  // superseded rows (cancelled via replan, or terminal
                  // failures the fragment bypassed) must not re-seed as
                  // required-unsatisfied, or the wake-up bug fails a workflow
                  // on its replaced segment despite the new path succeeding.
                  // The re-time loop below only sees running rows (superseded
                  // rows are terminal), so the filter changes nothing there.
                  const nodes = yield* store.getCurrentNodes(dagID)
                  entry.runtime.rebuildGraph(toSchedulingNodes(nodes))
                  // Timeout extension (Q6): a running node gets a recomputed
                  // deadline (now + new timeout) ONLY when the replan carries a
                  // NEW worker_config.timeout_ms for it (§3.7) AND the node
                  // actually needs re-timing (deadline elapsed or escalation
                  // pending — see the gate below). Restarted nodes are pending
                  // here — their new attempt spawns a fresh watcher via
                  // spawnReady.
                  const newConfig = entry.config
                  for (const node of nodes) {
                    if (node.status !== "running") continue
                    const frag = newConfig?.nodes.find((candidate) => candidate.id === node.id)
                    if (!frag) continue
                    const oldTimeoutMs =
                      oldConfig?.nodes.find((candidate) => candidate.id === node.id)?.worker_config?.timeout_ms
                      ?? oldConfig?.node_defaults?.worker_config?.timeout_ms
                      ?? Dag.DEFAULT_WORKFLOW_CONFIG.nodeTimeoutMs
                    const fragTimeoutMs =
                      frag.worker_config?.timeout_ms
                      ?? newConfig?.node_defaults?.worker_config?.timeout_ms
                      ?? Dag.DEFAULT_WORKFLOW_CONFIG.nodeTimeoutMs
                    // §3.7: re-time only when the replan carries a NEW
                    // timeout_ms. The persisted config behind WorkflowReplanned
                    // is the MERGED config — every non-cancel survivor keeps its
                    // definition — so a node the fragment never mentioned, or
                    // re-specified with an unchanged/omitted timeout_ms,
                    // matches here with its OLD timeout.
                    if (fragTimeoutMs == null || fragTimeoutMs === oldTimeoutMs) continue
                    const now = yield* Clock.currentTimeMillis
                    // Cap gate (A1) + delivery gate (Q2): both are SKIP
                    // conjuncts on this re-time path. The watchdog never
                    // re-times — it only proposes escalations. The other
                    // caller of nodeExtendTimeout, Dag.extendTimeout, applies
                    // the same two gates (A1 in its own body, Q2 inside the
                    // command).
                    //   A1: a changed timeout alone must not move a healthy
                    //   deadline forward. An agent replanning BEFORE each
                    //   deadline with cycling values (10m→20m→10m…) would push
                    //   the deadline away forever without a single escalation
                    //   firing, so the extension count never climbs and the
                    //   ≈21× cap is bypassed. Re-time only when the current
                    //   deadline already elapsed or an escalation awaits
                    //   adjudication; a gated-off node keeps its deadline and
                    //   the self-renewing watcher escalates it the moment it
                    //   passes. A null deadline is treated as elapsed —
                    //   re-timing is what re-establishes supervision.
                    //   Q2: an escalated node whose wake has NOT been delivered
                    //   (escalationPending ∧ ¬wakeReported) is skipped too.
                    //   Adjudication must follow delivery — otherwise the
                    //   re-time below would call nodeExtendTimeout, which clears
                    //   escalation_pending and marks wake_reported, silently
                    //   adjudicating an escalation the main agent never saw
                    //   (D2). The node keeps its elapsed deadline and the
                    //   self-renewing watcher re-escalates toward the cap; the
                    //   wake is delivered normally. This is a SKIP conjunct, not
                    //   a pass-through disjunct — the disjunct form is swamped
                    //   by the deadlineElapsed case on the public path and is a
                    //   no-op there (cons-F1).
                    if (
                      (!node.escalationPending && node.deadlineMs != null && node.deadlineMs > now)
                      || (node.escalationPending && !node.wakeReported)
                    ) continue
                    // N1: write the new deadline FIRST. nodeExtendTimeout
                    // acquires the workflow lock and can fail or block; if the
                    // write never lands, the old watcher must keep supervising
                    // the old deadline — interrupting it beforehand would leave
                    // a RUNNING node with no watcher, no escalation, and a
                    // defeated cap backstop (§5-5).
                    // D1: one node's failed extend must not abort the rest of
                    // the handler — an uncaught failure propagates to
                    // guarded("WorkflowReplanned") and skips the stale-fiber
                    // sweep below plus spawnReady/checkCompletion, leaving
                    // restarted nodes pending with nobody to schedule them.
                    // A failed write also leaves the deadline unmoved, so the
                    // old watcher keeps supervising (N1) — this path must not
                    // touch it. Interruption still propagates: hasInterrupts is
                    // a structural check, whereas Cause.interruptors collects
                    // only DEFINED fiber IDs and ignores interrupt reasons
                    // carrying none — those would be swallowed as errors here.
                    const written = yield* dag.nodeExtendTimeout(dagID, node.id, now + fragTimeoutMs, {
                      replanAttempts: node.replanAttempts,
                      ...(node.childSessionId ? { childSessionID: node.childSessionId } : {}),
                    }).pipe(
                      Effect.catchCause((cause) =>
                        Cause.hasInterrupts(cause)
                          ? Effect.failCause(cause)
                          : Effect.logWarning("DagLoop replan re-time failed; keeping the old watcher and continuing the batch", { dagID, nodeID: node.id, cause }).pipe(
                              Effect.as(-1),
                            ),
                      ),
                    )
                    // Negative verdict: -1 (write failure, mapped above), -2
                    // (Q2 delivery-gate rejection), or -3 (cumulative timeout
                    // cap exhausted). In every case no deadline was written
                    // and the node remains running, so the old watcher
                    // must keep supervising the elapsed deadline and re-escalating
                    // toward the cap (N1: a running node is never left without a
                    // watcher). Clearing the watcher here would orphan the node and
                    // defeat the cap backstop.
                    if (written < 0) continue
                    if (written === 0) {
                      // 0 = TERMINAL rejection: the status='running' guard rejected
                      // the write — the node terminalized between the getNodes read
                      // and this command. Only THIS meaning reaches the branch now
                      // (C1 split the Q2 case into -2 above). No deadline was
                      // written; stop the old watcher and do not install one for a
                      // row the command refused to touch.
                      const deadWatcher = entry.watchers.get(node.id)
                      if (deadWatcher) yield* Fiber.interrupt(deadWatcher).pipe(Effect.ignore)
                      entry.watchers.delete(node.id)
                      yield* Effect.logWarning("DagLoop replan re-time skipped — node no longer running", { dagID, nodeID: node.id })
                      continue
                    }
                    // Write committed: install the re-armed watcher BEFORE
                    // interrupting the old one so supervision is never absent.
                    // F8's original race is benign in this order — the old
                    // watcher's next read sees the future deadline and sleeps;
                    // an escalation already in flight (lock-serialized behind
                    // this write) only adds a counted extension toward the cap,
                    // it never removes supervision. Its sole residue is re-setting
                    // escalation_pending on the now-extended node, which costs one
                    // redundant wake and permits one extra re-time via the gate
                    // above — cosmetic; the cap accounting still holds because the
                    // count did climb.
                    const newWatcher = yield* makeDeadlineWatcher({
                      dagID,
                      nodeID: node.id,
                      attempt: {
                        replanAttempts: node.replanAttempts,
                        ...(node.childSessionId ? { childSessionID: node.childSessionId } : {}),
                      },
                      timeoutMs: fragTimeoutMs,
                      maxTimeoutExtensions: newConfig?.max_timeout_extensions ?? Dag.DEFAULT_WORKFLOW_CONFIG.maxTimeoutExtensions,
                    }).pipe(
                      Effect.provideService(Dag.Service, dag),
                      Effect.provideService(SessionPrompt.Service, promptSvc),
                      Effect.forkScoped,
                    )
                    const oldWatcher = entry.watchers.get(node.id)
                    entry.watchers.set(node.id, newWatcher)
                    if (oldWatcher) yield* Fiber.interrupt(oldWatcher).pipe(Effect.ignore)
                    yield* Effect.logInfo("DagLoop extended node deadline via replan", { dagID, nodeID: node.id, newDeadlineMs: now + fragTimeoutMs })
                  }
                  // Replan resets restarted nodes to pending. Old fibers of nodes
                  // that are no longer running/queued must be interrupted here:
                  // nothing else will (there is no NodeRestarted subscriber), and
                  // a leftover fiber's timeout path publishes NodeFailed — a legal
                  // pending→failed transition guardNode cannot reject — poisoning
                  // the new generation. Mirrors the workflow-terminal sweep.
                  for (const [nodeID, fiber] of [...entry.fibers]) {
                    const node = nodes.find((n) => n.id === nodeID)
                    if (node && (node.status === "running" || node.status === "queued")) continue
                    yield* abortChild(nodeID, node?.childSessionId ?? null).pipe(Effect.ignore)
                    yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                    const watcher = entry.watchers.get(nodeID)
                    if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                    entry.fibers.delete(nodeID)
                    entry.watchers.delete(nodeID)
                  }
                  yield* spawnReady(dagID)
                  yield* checkCompletion(dagID)
                }),
              )
            }).pipe(guarded("WorkflowReplanned")),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        for (const def of [DagEvent.WorkflowCompleted, DagEvent.WorkflowFailed, DagEvent.WorkflowCancelled]) {
          // Deliberately NO runtimes.has filter: a workflow terminalized by a
          // control op after a failed startup recovery (e.g. recoverWorkflow
          // aborted on an unreadable persisted row) has no runtime entry but
          // may still hold a dag registration from the startup wake sweep.
          // The handler stays a no-op for events not concerning this
          // instance: the evalLock cleanup and wake fork remain gated on
          // `entry`, and the no-entry release below is scoped by the durable
          // row's project — the same cross-instance guard every adoption
          // path uses.
          yield* events.subscribe(def).pipe(
            Stream.runForEach((evt) =>
              Effect.gen(function* () {
                const dagID = evt.data.dagID as string
                const entry = runtimes.get(dagID)
                const parentSessionID = entry?.parentSessionID
                if (entry) {
                  yield* entry.evalLock.withPermits(1)(
                    Effect.gen(function* () {
                      for (const [nodeID, fiber] of entry.fibers) {
                        const node = yield* store.getNode(dagID, nodeID)
                        yield* abortChild(nodeID, node?.childSessionId ?? null).pipe(Effect.ignore)
                        yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                        const watcher = entry.watchers.get(nodeID)
                        if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                      }
                      entry.fibers.clear()
                      entry.watchers.clear()
                      runtimes.delete(dagID)
                    }),
                  )
                }
                // P1-6: trigger wake on workflow terminal so the parent
                // learns the final outcome even if no idle event fires.
                if (parentSessionID) {
                  // GOAL-FP-01-03: the dag registration lifetime is bound to
                  // workflow state, not to wake delivery. A workflow that
                  // terminalizes without a successful wake delivery must not
                  // keep its registration (and the Session's ownership)
                  // indefinitely. The key matches the registration key
                  // (WorkflowTable.id === event dagID, per the projector);
                  // tryDeliverWake re-registers its batch itself before
                  // claiming the wake lease when a delivery is attempted.
                  yield* automation.unregister(SessionID.make(parentSessionID), { kind: "dag", id: dagID })
                  yield* tryDeliverWake(parentSessionID).pipe(Effect.ignore, Effect.forkScoped)
                } else {
                  // GOAL-FP-01-03 follow-up (P2-A): no runtime entry, but the
                  // startup wake sweep may have registered this non-terminal
                  // row before its recovery failed. Release from the durable
                  // row (session_id + project) so a control-op
                  // terminalization cannot leave a permanent registration
                  // with no runtime to ever clean it. Foreign-project events
                  // are a no-op here.
                  const wf = yield* store.getWorkflow(dagID)
                  if (wf && wf.projectId === ctx.project.id) {
                    yield* automation.unregister(SessionID.make(wf.sessionId), { kind: "dag", id: dagID })
                  }
                }
              }).pipe(guarded("WorkflowTerminal")),
            ),
            Effect.forkScoped({ startImmediately: true }),
          )
        }

        // ── D2+D7: Autonomous wake — extracted as reusable function ────
        // Called from both the idle-event subscription AND node-terminal
        // event handlers, so a wake fires even when the parent session is
        // already idle (P1-2 fix).

        const readWakeBatch = Effect.fn("DagLoop.readWakeBatch")(function* (sessionID: string) {
          const snapshot = yield* store.getWakeSnapshot(sessionID).pipe(
            Effect.catch(() =>
              Effect.succeed({ nodes: [], workflows: [] } satisfies DagStore.WakeSnapshot),
            ),
          )
          const now = yield* Clock.currentTimeMillis
          const reportableWorkflows = snapshot.workflows.filter(
            (workflow) => !workflow.wakeReported && (
              isTerminalWorkflowStatusValue(workflow.status)
              || isPausedReminderDue(workflow, now)
            ),
          )
          // Timeout-escalated nodes must reach the main agent for
          // adjudication — their workflow is a delivery boundary even though
          // the runtime still reports a running node. F11: a non-eligible node
          // that escalated then terminalized (cap-exhausted force-cancel) must
          // deliver its verdict immediately, not wait for the next natural
          // boundary (it may never come while other nodes keep running).
          // The boundary is escalation_pending (a live, not-yet-adjudicated
          // escalation) OR an escalated node that terminalized — NOT the sticky
          // extension count alone, or an already-adjudicated running node would
          // override the delivery boundary for the rest of the attempt.
          const escalatedWorkflowIDs = new Set(
            snapshot.nodes
              .filter((node) => node.escalationPending || (node.timeoutExtensions > 0 && isNodeTerminalStatus(node.status as never)))
              .map((node) => node.workflowId),
          )
          const workflowIDs = [...new Set([
            ...snapshot.nodes.map((node) => node.workflowId),
            ...reportableWorkflows.map((workflow) => workflow.id),
          ])]
          const workflowsByID = new Map(snapshot.workflows.map((workflow) => [workflow.id, workflow]))
          const workflows = workflowIDs.map((workflowID) => workflowsByID.get(workflowID))
          const boundaryWorkflows = workflows.filter((workflow): workflow is DagStore.WorkflowRow => {
            if (!workflow) return false
            if (isWorkflowTerminalStatus(workflow.status as never)) return true
            const entry = runtimes.get(workflow.id)
            if (workflow.status === "paused" || workflow.status === "stepping") return true
            if (entry?.runtime.isPaused() || entry?.runtime.isStepMode()) return true
            if (workflow.status !== "running" || !entry) return false
            if (escalatedWorkflowIDs.has(workflow.id)) return true
            // Delivery boundary uses the runtime's own running set, NOT fiber
            // ownership: between markRunning and fibers.set the spawn path has
            // async yield points, and a wake reading that window would misjudge
            // "running, no fiber, nothing ready" as a stalled boundary and
            // deliver a mid-flight batch. The orchestrator-unresponsive net
            // below keeps the stricter fiber-ownership check.
            if (entry.runtime.hasRunning()) return false
            return entry.runtime.getReadyNodes().length === 0
          })
          const atBoundary = new Set(boundaryWorkflows.map((workflow) => workflow.id))
          const batch = {
            nodes: snapshot.nodes.filter((node) => atBoundary.has(node.workflowId)),
            workflows: reportableWorkflows.filter((workflow) => atBoundary.has(workflow.id)),
          } satisfies DagStore.WakeBatch
          return {
            batch,
            completedReports: boundaryWorkflows.filter(
              (workflow) =>
                workflow.status === "completed" &&
                resultProtocol(parseWorkflowConfig(workflow.config)) === "final_response",
            ),
            actionableDagIDs: new Set(
              boundaryWorkflows
                .filter((workflow) => !isWorkflowTerminalStatus(workflow.status as never))
                .map((workflow) => workflow.id),
            ),
            unresponsiveDagIDs: new Set(
              boundaryWorkflows
                .filter((workflow) => {
                  const entry = runtimes.get(workflow.id)
                  return workflow.status === "running"
                    && !entry?.runtime.isPaused()
                    && !entry?.runtime.isStepMode()
                })
                .map((workflow) => workflow.id),
            ),
          }
        })

        let tryDeliverWake: (sessionID: string) => Effect.Effect<void> = () => Effect.void
        const deliverWake = Effect.fn("DagLoop.tryDeliverWake")(function* (sessionID: string) {
          // Cross-instance guard via the execution-location authority: wake
          // delivery is store-global (idle Status events, node-terminal
          // handlers, the startup sweep). Only the instance whose DIRECTORY
          // owns the session's workflows may deliver its wakes — sibling
          // worktrees of the same project must ignore each other's idle
          // sessions. The guard also covers the workflow-terminal stimulus
          // after a session deletion (the durable rows are gone).
          if (!(yield* DagLocation.ownsSession(sessionID, ctx.directory))) return
          if (wakeInFlight.has(sessionID)) {
            wakePending.add(sessionID)
            return
          }
          wakeInFlight.add(sessionID)
          // Re-read after each stable batch so rows committed during delivery
          // remain a separate batch. The reservation is released by an Effect
          // finalizer, not a generator `finally`: Effect does not resume a
          // generator's `finally` when the fiber is interrupted (the lease
          // timeout below), fails, or dies, so a generator release would leak
          // the reservation and park every later wake in `wakePending`.
          yield* Effect.gen(function* () {
            const deliveredUnresponsiveDagIDs = new Set<string>()
            for (;;) {
              const plan = yield* readWakeBatch(sessionID)
              let batch = plan.batch
              const hasUnreported = batch.nodes.length > 0 || batch.workflows.length > 0

              if (!hasUnreported) {
                // A terminal event can commit between either query. Coalesce
                // its trigger into another durable read before declaring idle.
                if (wakePending.delete(sessionID)) continue
                // D7: if we delivered at least one wake in this call and no more
                // unreported rows remain, check for orchestrator-unresponsive.
                // #5: scoped per-workflow — only fail the workflow whose node
                // was reported, not any other workflow under the same session.
                // Skip paused and stepping workflows; both can intentionally
                // have no ready nodes.
                if (deliveredUnresponsiveDagIDs.size > 0) {
                  for (const dagID of deliveredUnresponsiveDagIDs) {
                    const entry = runtimes.get(dagID)
                    if (!entry) continue
                    // Torn-read fix: every runtime/fibers mutation happens as a
                    // pair inside this entry's evalLock (markRunning+fibers.set
                    // in spawnReady, settle+spawnReady in the terminal handlers),
                    // so reading the five conditions under the same lock waits
                    // out the markRunning→fibers.set window instead of misreading
                    // it as a stalled orchestrator. dag.fail must run under the
                    // SAME permit: releasing the lock between the check and the
                    // fail lets a terminal-event handler spawn new ready nodes in
                    // the window, and the stale verdict would then kill a
                    // progressing workflow. evalLock→workflowLock nesting is the
                    // established order here (checkCompletion inside evalLock
                    // takes the same KeyedMutex); dag.ts never acquires evalLock,
                    // so no reverse ordering exists.
                    yield* entry.evalLock.withPermits(1)(
                      Effect.gen(function* () {
                        // P0-C: re-read the durable status under the evalLock. A
                        // parent that responded this turn — e.g. submitted a
                        // replan/extend that failed validation, which parks the
                        // workflow paused — must NOT be failed as unresponsive.
                        // The durable row is transactional with the pause event,
                        // so it is authoritative over the in-memory paused flag,
                        // which the WorkflowPaused handler refreshes async and
                        // could otherwise lose the race against this check.
                        const durable = yield* store.getWorkflow(dagID)
                        const shouldFail =
                          durable?.status === "running" &&
                          !entry.runtime.isPaused() &&
                          !entry.runtime.isStepMode() &&
                          // Suppress the net only when current-process execution
                          // ownership proves that a running node is making progress.
                          !entry.runtime.hasRunningMatching((id) => entry.fibers.has(id)) &&
                          entry.runtime.getReadyNodes().length === 0 &&
                          !entry.runtime.isComplete()
                        if (shouldFail) yield* dag.fail(dagID, "orchestrator_unresponsive").pipe(Effect.ignore)
                      }),
                    )
                  }
                }
                return
              }

              if ((yield* statusSvc.get(SessionID.make(sessionID))).type !== "idle") return

              // Completed final-response workflows display their result without a model turn.
              // Other decisions in the same snapshot take precedence; their wake excludes
              // these completed reports so they cannot invite a duplicate summary.
              const completedIDs = new Set(plan.completedReports.map((workflow) => workflow.id))
              const decisions = {
                nodes: batch.nodes.filter((node) => !completedIDs.has(node.workflowId)),
                workflows: batch.workflows.filter((workflow) => !completedIDs.has(workflow.id)),
              } satisfies DagStore.WakeBatch
              if (
                plan.completedReports.length > 0 &&
                decisions.nodes.length === 0 &&
                decisions.workflows.length === 0
              ) {
                for (const workflow of plan.completedReports) {
                  const reportBatch = {
                    nodes: batch.nodes.filter((node) => node.workflowId === workflow.id),
                    workflows: batch.workflows.filter((row) => row.id === workflow.id),
                  }
                  if (reportBatch.nodes.length === 0 && reportBatch.workflows.length === 0) continue
                  yield* automation.register(SessionID.make(sessionID), { kind: "dag", id: workflow.id })
                  const lease = Option.getOrUndefined(
                    yield* automation.claim(SessionID.make(sessionID), { kind: "dag" }),
                  )
                  if (!lease) return
                  const config = parseWorkflowConfig(workflow.config)
                  const reportNodes = yield* store.getCurrentNodes(workflow.id).pipe(Effect.orDie)
                  const node =
                    (config ? selectReportNode(config, reportNodes) : undefined) ??
                    reportNodes.find((node) => node.status === "completed")
                  const source = node?.childSessionId
                    ? yield* lastAssistantMessage(node.childSessionId).pipe(Effect.orDie)
                    : undefined
                  const delivered = yield* automation.use(
                    lease,
                    promptSvc.withIdle(
                      SessionID.make(sessionID),
                      deliverReport({
                        workflow,
                        batch: reportBatch,
                        store,
                        sessions: sessionSvc,
                        events,
                        directory: ctx.directory,
                        source,
                      }).pipe(
                        Effect.provideService(Database.Service, database),
                        Effect.tap((didDeliver) =>
                          didDeliver
                            ? statusSvc
                                .set(SessionID.make(sessionID), { type: "busy" })
                                .pipe(Effect.ensuring(statusSvc.set(SessionID.make(sessionID), { type: "idle" })))
                            : Effect.void,
                        ),
                      ),
                    ),
                  )
                  if (Option.isNone(delivered) || Option.isNone(delivered.value) || !delivered.value.value) return
                  yield* automation.unregister(SessionID.make(sessionID), { kind: "dag", id: workflow.id })
                }
                continue
              }
              if (completedIDs.size > 0) batch = decisions

              const wakeIdentity = wakeBatchIdentity(sessionID, batch)
              const durableReceipt =
                deliveredWakeSummaries.get(sessionID) === wakeIdentity.messageID
                  ? undefined
                  : yield* sessionSvc.getPart({
                      sessionID: SessionID.make(sessionID),
                      messageID: wakeIdentity.messageID,
                      partID: wakeIdentity.partID,
                    })
              const alreadyAdmitted =
                deliveredWakeSummaries.get(sessionID) === wakeIdentity.messageID ||
                (durableReceipt?.type === "text" && durableReceipt.synthetic === true)

              // Preemption guard (task 3.3): abort if fresher user message exists
              const msgs = yield* sessionSvc.messages({ sessionID: SessionID.make(sessionID), limit: 20 }).pipe(Effect.catch(() => Effect.succeed([])))
              let lastUserAt = -1
              let lastAsstAt = -1
              for (const m of msgs) {
                const t = m.info.time?.created
                if (typeof t !== "number") continue
                if (m.info.role === "user" && t > lastUserAt) lastUserAt = t
                else if (m.info.role === "assistant" && t > lastAsstAt) lastAsstAt = t
              }
              if (!alreadyAdmitted && lastUserAt > lastAsstAt) return

              const failuresByWorkflow = new Map<string, string[]>()
              for (const workflow of batch.workflows) {
                if (workflow.status !== "failed") continue
                // Rev-view (v1.0.15 Train A): attribution is terminal
                // aggregation — only CURRENT-revision failures are attributed.
                // Superseded replaced failures (cancelled rows already fall
                // out via errorClass null) must not be re-attributed.
                const failedNodes = yield* store.getCurrentNodes(workflow.id).pipe(
                  Effect.map((nodes) => nodes.filter((node): node is DagStore.NodeRow & { errorClass: string } => node.status === "failed" && node.errorClass !== null)),
                  Effect.catchCause((cause) =>
                    Effect.gen(function* () {
                      yield* Effect.logWarning("wake digest failed to read failed nodes", { workflowId: workflow.id, cause })
                      return [] as (DagStore.NodeRow & { errorClass: string })[]
                    }),
                  ),
                )
                if (failedNodes.length > 0) {
                  failuresByWorkflow.set(
                    workflow.id,
                    failedNodes.map((node) => `- "${node.name}" (${node.errorClass}): ${node.errorReason ?? "unknown error"}`.slice(0, 300)),
                  )
                }
              }
              const summaries = [
                ...batch.nodes.map((node) => {
                  // The timeout advisory is for a running node awaiting
                  // adjudication (escalation_pending). A batch node is
                  // wake_reported=false, so it cannot be an already-adjudicated
                  // extend — escalation_pending and timeoutExtensions>0 agree
                  // here; the flag is the intent-level signal.
                  if (node.status === "running" && node.escalationPending) {
                    return `[DAG Node Timeout] RUNNING node "${node.name}" exceeded its execution deadline (timeout escalation ${node.timeoutExtensions}) and is still executing. If the workflow's cumulative escalation cap is not exhausted, control(extend_timeout) { workflow_id, node_id, timeout_ms } grants more execution time WITHOUT a replan — it keeps the same child session and attempt, consumes no replan, rewrites no graph, and the deadline watcher picks up the new deadline on its next read. At the cap, extension of this attempt is refused and the watcher enforces the timeout verdict. The cumulative extension count is NOT reset (only a new attempt resets it). Use control(replan) with a NEW worker_config.timeout_ms when you must also change the graph; restart or cancel the node to stop the current attempt. Queued nodes are not extended: their admission deadline was fixed at permit acquisition and is not adjusted by extensions.`
                  }
                  const durableResult =
                    typeof node.output === "string"
                      ? node.output
                      : (node.errorReason ?? (node.output == null ? "(no output)" : JSON.stringify(node.output)))
                  const truncated = durableResult.length > 500
                  const output = durableResult.slice(0, 500)
                  const failureClass = node.status === "failed" && node.errorClass ? ` (${node.errorClass})` : ""
                  const retrieval = truncated
                    ? `\nComplete output: call workflow result with workflow_id="${node.workflowId}" and node_id="${node.id}".`
                    : ""
                  return `[DAG Node Result] Node "${node.name}" ${node.status}${failureClass}: ${output}\n[DAG Result Reference] workflow_id="${node.workflowId}" node_id="${node.id}" truncated=${truncated}${retrieval}`
                }),
                ...batch.workflows.map((workflow) => {
                  const failures = failuresByWorkflow.get(workflow.id)
                  const attribution = failures ? `\nFailed nodes:\n${failures.join("\n")}` : ""
                  return workflow.status === "paused"
                    ? `[DAG Workflow paused] Workflow "${workflow.title}" has remained paused for five minutes. It is still paused and awaits an explicit control(replan), control(extend), control(resume), or control(cancel); no automatic transition was made.`
                    : `[DAG Workflow ${workflow.status}] Workflow "${workflow.title}" has reached terminal status.${attribution}`
                }),
              ]
              const summary = [
                ...summaries,
                ...(plan.actionableDagIDs.size > 0
                  ? [
                      "Act on these workflows this turn (workflow tool: control extend_timeout for a timeout escalation; control replan / extend to reshape the graph; control resume / complete / cancel to settle). The orchestrator_unresponsive verdict is state-based: a workflow left RUNNING and stalled (no running or ready nodes) at the end of the turn is failed. After a rejected replan/extend, inspect its reported actual state: a durably paused workflow is recoverable, but a failed automatic pause does not protect a still-running workflow. Never cancel the whole graph over a rejection. If you need the user before acting on a stalled workflow, control(pause) it first and verify the state, then stop and ask. A paused workflow whose nodes have all finished settles via control(resume), not control(complete).",
                    ]
                  : []),
              ].join("\n\n")
              if (durableReceipt?.type === "text" && durableReceipt.text !== summary) {
                yield* Effect.die(new Error("DAG wake receipt content does not match its durable batch"))
                return
              }

              const wakeWorkflowIDs = new Set([
                ...batch.nodes.map((node) => node.workflowId),
                ...batch.workflows.map((workflow) => workflow.id),
              ])
              for (const workflowID of wakeWorkflowIDs) {
                yield* automation.register(SessionID.make(sessionID), { kind: "dag", id: workflowID })
              }
              const wakeLease = Option.getOrUndefined(
                yield* automation.claim(SessionID.make(sessionID), { kind: "dag" }),
              )
              if (!wakeLease) return

              // The part is marked synthetic: model-visible (the orchestrator
              // receives the node result and can act) but NOT rendered as a user
              // message in the TUI chat — DAG data surfaces via the sidebar panel
              // and Inspector, keeping the chat conversation clean.
              //
              // ADMIT SUCCESS == DELIVERED (issue #321). The previous contract
              // (GOAL-FP-01-14) persisted wake_reported only AFTER the whole
              // wake-driven parent turn completed. A restart or mid-turn
              // interruption therefore left wake_reported=false while the
              // synthetic part was already durable in transcript, so the startup
              // sweep re-injected a byte-identical wake (real incident: the same
              // 4391-char wake injected twice, ~10 min apart, after a TUI
              // restart). Redelivery adds duplicates, never information. The
              // Transcript persistence and the wake mark commit in one short
              // transaction; the prepared model turn activates after commit.
              //
              // The stable message and part IDs bind this exact durable batch
              // to its transcript receipt. A failed mark retries by reading
              // that receipt even after restart. New attempt/event revisions
              // produce a new identity; equal summary text cannot suppress it.
              if (deliveredWakeSummaries.size > 1024) deliveredWakeSummaries.clear()
              const didDeliver = yield* Effect.gen(function* () {
                let wakeTurn: Effect.Effect<SessionV1.WithParts> | undefined
                if (!alreadyAdmitted) {
                  const delivered = yield* automation.handoff(
                    wakeLease,
                    promptSvc.prepareIfIdle(
                      {
                        sessionID: SessionID.make(sessionID),
                        messageID: wakeIdentity.messageID,
                        parts: [{ id: wakeIdentity.partID, type: "text", text: summary, synthetic: true }],
                      },
                      store.markWakeBatchReported(batch),
                      { continueToolBudget: true },
                    ),
                  )
                  if (Option.isNone(delivered)) return false
                  deliveredWakeSummaries.set(sessionID, wakeIdentity.messageID)
                  wakeTurn = delivered.value
                }

                // New admission already committed its mark atomically. An old
                // durable receipt from before this boundary can still be
                // acknowledged under the current automation lease.
                const markLease = !alreadyAdmitted
                  ? undefined
                  : Option.getOrUndefined(yield* automation.claim(SessionID.make(sessionID), { kind: "dag" }))
                // Any mark failure (lease lost, generation raced, or the store
                // write dying) degrades to retry-later instead of propagating:
                // the rows stay unreported and a later trigger re-marks, while
                // the admitted turn below still runs (its end-of-turn idle is
                // what re-arms that retry). Only interruption propagates.
                const markSucceeded =
                  !alreadyAdmitted ||
                  (markLease
                    ? Option.isSome(
                        yield* automation.use(markLease, store.markWakeBatchReported(batch)).pipe(
                          Effect.catchCause((cause) =>
                            Cause.hasInterrupts(cause)
                              ? Effect.failCause(cause)
                              : Effect.logWarning("DAG wake batch mark failed; rows stay unreported for retry", {
                                  sessionID,
                                  cause: Cause.pretty(cause),
                                }).pipe(Effect.as(Option.none())),
                          ),
                        ),
                      )
                    : false)
                if (markSucceeded) {
                  plan.unresponsiveDagIDs.forEach((workflowID) => deliveredUnresponsiveDagIDs.add(workflowID))
                  yield* Effect.forEach(
                    batch.workflows.filter((workflow) => isWorkflowTerminalStatus(workflow.status as never)),
                    (workflow) => automation.unregister(SessionID.make(sessionID), { kind: "dag", id: workflow.id }),
                    { discard: true },
                  )
                }

                // Pacing — keep one wake turn at a time. The turn runs AFTER the
                // durable mark, so its failure can no longer lose the report;
                // swallow non-interrupt failures instead of surfacing them as a
                // delivery failure. It also runs when the mark raced, so its
                // end-of-turn idle re-arms the mark retry.
                if (wakeTurn) {
                  yield* wakeTurn.pipe(
                    Effect.catchCause((cause) =>
                      Cause.hasInterrupts(cause)
                        ? Effect.failCause(cause)
                        : Effect.logInfo("DAG wake turn did not complete; wake already reported", {
                            sessionID,
                            cause: Cause.pretty(cause),
                          }),
                    ),
                  )
                }
                return markSucceeded
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("DAG wake delivery failed", { sessionID, cause: Cause.pretty(cause) }).pipe(
                    Effect.as(false),
                  ),
                ),
              )
              if (!didDeliver) return
            }
          }).pipe(
            Effect.ensuring(
              Effect.suspend(() => {
                const retry = wakePending.delete(sessionID)
                wakeInFlight.delete(sessionID)
                return retry
                  ? tryDeliverWake(sessionID).pipe(guarded("WakePendingRetry"), Effect.forkIn(stateScope), Effect.asVoid)
                  : Effect.void
              }),
            ),
          )
        })
        // The in-flight reservation must have a finite lifetime even when a
        // parent turn or a dependency never settles. Timing out interrupts the
        // old delivery fiber; its `Effect.ensuring` finalizer releases the
        // reservation (and re-forks a wake that was queued behind it), so a
        // queued or periodic stimulus retries through the ordinary idle
        // admission gate.
        tryDeliverWake = (sessionID) =>
          deliverWake(sessionID).pipe(
            Effect.timeoutOption("7 minutes"),
            Effect.flatMap(
              Option.match({
                onSome: () => Effect.void,
                onNone: () =>
                  Effect.logWarning("DAG wake delivery lease expired; retry remains available", { sessionID }),
              }),
            ),
          )

        const mailboxInFlight = new Set<string>()
        const deliverAgentMessages = Effect.fn("DagLoop.deliverAgentMessages")(
          function* (sessionID: string) {
            if (!messageSvc || mailboxInFlight.has(sessionID)) return
            mailboxInFlight.add(sessionID)
            yield* Effect.gen(function* () {
              if ((yield* statusSvc.get(SessionID.make(sessionID))).type !== "idle") return
              const caller = { projectID: ctx.project.id, directory: ctx.directory, sessionID }
              const queued = yield* messageSvc.receive(caller, { limit: 64, queuedOnly: true })
              if (!queued.ok) return
              const message = queued.value.find((item) => item.state === "queued")
              if (!message || message.recipient.kind !== "main") return
              const history = yield* sessionSvc.messages({ sessionID: SessionID.make(sessionID), limit: 20 })
              const latestAssistant = history
                .filter((item) => item.info.role === "assistant")
                .toSorted((a, b) => (MessageV2.before(a.info, b.info) ? -1 : MessageV2.before(b.info, a.info) ? 1 : 0))
                .at(-1)
              if (
                latestAssistant?.info.role === "assistant" &&
                (latestAssistant.info.error || ["error", "content-filter"].includes(latestAssistant.info.finish ?? ""))
              ) {
                const mailboxInputs = new Set(queued.value.map((item) => item.transcriptID))
                const newContext = history.some((item) => {
                  if (
                    item.info.role !== "user" ||
                    !MessageV2.before(latestAssistant.info, item.info) ||
                    mailboxInputs.has(item.info.id)
                  )
                    return false
                  return !item.parts.some((part) => {
                    if (part.type !== "text") return false
                    const envelope = Option.getOrUndefined(parseJsonOption(part.text))
                    return (
                      typeof envelope === "object" &&
                      envelope !== null &&
                      "kind" in envelope &&
                      envelope.kind === "dag_agent_message"
                    )
                  })
                })
                // A retained queue cannot reset a failed execution every poll.
                // A later host-admitted prompt advances context; this predicate
                // grants no permissions and infers no human provenance.
                if (!newContext) return
              }
              // The mailbox lease is separate from workflow lifecycle ownership:
              // accepted node reports survive source completion and cancellation.
              const owner = { kind: "dag" as const, id: `agent-mailbox:${message.recipient.id}` }
              yield* automation.register(SessionID.make(sessionID), owner)
              yield* Effect.gen(function* () {
                const token = yield* automation.claim(SessionID.make(sessionID), { kind: "dag" })
                if (Option.isNone(token)) return
                const admitted = yield* SessionPrompt.admitIfIdle(promptSvc, automation, token.value, {
                  sessionID: SessionID.make(sessionID),
                  messageID: MessageID.make(message.transcriptID),
                  parts: [
                    {
                      id: PartID.make(message.partID),
                      type: "text",
                      text: DagMessages.renderMessage(message),
                      synthetic: true,
                    },
                  ],
                })
                if (Option.isNone(admitted)) return
                // Admission alone leaves delivery queued. SessionPrompt freezes
                // and associates the actual model input, then advances delivery.
                yield* automation.unregister(SessionID.make(sessionID), owner)
                yield* admitted.value
              }).pipe(Effect.ensuring(automation.unregister(SessionID.make(sessionID), owner)))
            }).pipe(Effect.ensuring(Effect.sync(() => mailboxInFlight.delete(sessionID))))
          },
          Effect.timeoutOption("7 minutes"),
          Effect.asVoid,
        )

        let mailboxCursor: string | undefined
        const pollAgentMailboxes = Effect.gen(function* () {
          if (!messageSvc) return
          const recipients = yield* messageSvc.pendingRecipients({
            projectID: ctx.project.id,
            directory: ctx.directory,
            limit: 20,
            afterSessionID: mailboxCursor,
          })
          mailboxCursor = recipients.at(-1)?.sessionID
          for (const endpoint of recipients) {
            yield* deliverAgentMessages(endpoint.sessionID).pipe(guarded("AgentMailboxAdmission"), Effect.forkScoped)
          }
        }).pipe(guarded("AgentMailboxSweep"))
        // Scoped, bounded scanning avoids a second event transport and catches
        // idle parents even when the source node finished before a restart.
        if (messageSvc) {
          yield* pollAgentMailboxes
          yield* Effect.forever(Effect.sleep(250).pipe(Effect.andThen(pollAgentMailboxes))).pipe(Effect.forkScoped)
        }

        // Idle-event subscription: the primary wake trigger. The handler only
        // forks, so the subscription itself cannot die — guarded here so a
        // defect inside a delivery attempt is logged instead of silently
        // killing its fiber.
        yield* events.subscribe(SessionStatusEvent.Status).pipe(
          Stream.filter((evt) => evt.data.status.type === "idle"),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              yield* tryDeliverWake(evt.data.sessionID as string).pipe(guarded("WakeDelivery"), Effect.forkScoped)
              yield* deliverAgentMessages(evt.data.sessionID as string).pipe(
                guarded("AgentMailboxIdle"),
                Effect.forkScoped,
              )
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        // A parked workflow can outlive the parent turn that caused its pause.
        // The paused row's durable wake marker permits one reminder per pause
        // episode, including after restart. Scanning only starts delivery; the
        // regular idle/admission and directory ownership gates still apply.
        const remindPausedWorkflows = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const paused = yield* store.listByStatus("paused")
          const sessions = new Set(
            paused.filter((workflow) => isPausedReminderDue(workflow, now)).map((workflow) => workflow.sessionId),
          )
          for (const sessionID of sessions) {
            if (!(yield* DagLocation.ownsSession(sessionID, ctx.directory))) continue
            yield* tryDeliverWake(sessionID).pipe(guarded("PausedReminder"), Effect.forkScoped)
          }
        }).pipe(guarded("PausedReminderSweep"))
        yield* Effect.forever(
          Effect.sleep(30_000).pipe(Effect.flatMap(() => remindPausedWorkflows)),
        ).pipe(Effect.forkScoped)

        // R5 session-deletion teardown: when the parent session is removed,
        // Session.remove publishes SessionV1.Event.Deleted and the FK cascade
        // wipes the workflow + node rows. The in-memory runtime entry must go
        // with them — otherwise a later stimulus (e.g. a workflow-terminal
        // event on the deleted dagID) would still find the entry in
        // `runtimes` and interrupt live fibers / drive a workflow that no
        // longer exists durably. Mirror the workflow-terminal cleanup
        // pattern: evalLock-serialized fiber + watcher interrupts, then drop
        // the entry.
        yield* events.subscribe(SessionV1.Event.Deleted).pipe(
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const sessionID = evt.data.sessionID as string
              // Map iteration is mutation-safe for deletions of visited
              // entries — only THIS entry is deleted, inside its own evalLock.
              for (const [dagID, entry] of runtimes) {
                if (entry.parentSessionID !== sessionID) continue
                yield* entry.evalLock.withPermits(1)(
                  Effect.gen(function* () {
                    for (const [nodeID, fiber] of entry.fibers) {
                      const node = yield* store.getNode(dagID, nodeID)
                      yield* abortChild(nodeID, node?.childSessionId ?? null).pipe(Effect.ignore)
                      yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                      const watcher = entry.watchers.get(nodeID)
                      if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                    }
                    entry.fibers.clear()
                    entry.watchers.clear()
                    runtimes.delete(dagID)
                  }),
                )
              }
            }).pipe(guarded("SessionDeleted")),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        // #269 SessionMoved ownership convergence: the Moved projection
        // (core session projector) re-stamps the session's workflow rows to the
        // destination directory in the SAME durable transaction, so by the time
        // this handler runs the durable rows already agree on ONE directory.
        // Converge the in-memory side: (a) the instance that no LONGER owns the
        // moved session's workflows evicts its stale runtime entries (fail-closed
        // — its directory must not keep acting on them), and (b) the NEW owner
        // adopts the session's non-terminal workflows (recoverWorkflow) and
        // re-forks the serialized wake drain so a terminal wake that was wedged
        // behind the old mixed stamps delivers immediately (bounded time) instead
        // of waiting for a fresh idle event or a restart.
        yield* events.subscribe(SessionEvent.Moved).pipe(
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const sessionID = evt.data.sessionID as string
              // Map iteration is mutation-safe for deletions of visited entries —
              // only entries of THIS session are deleted, each inside its own
              // evalLock. Evict only entries the re-stamp moved AWAY from this
              // instance (ownsWorkflow re-reads the durable row).
              for (const [dagID, entry] of runtimes) {
                if (entry.parentSessionID !== sessionID) continue
                if (yield* DagLocation.ownsWorkflow(dagID, ctx.directory)) continue
                yield* entry.evalLock.withPermits(1)(
                  Effect.gen(function* () {
                    for (const [nodeID, fiber] of entry.fibers) {
                      const node = yield* store.getNode(dagID, nodeID)
                      yield* abortChild(nodeID, node?.childSessionId ?? null).pipe(Effect.ignore)
                      yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                      const watcher = entry.watchers.get(nodeID)
                      if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                    }
                    entry.fibers.clear()
                    entry.watchers.clear()
                    runtimes.delete(dagID)
                    // The dag automation-lease registration is deliberately kept:
                    // it is keyed by (session, workflow), not by directory, and
                    // the lease service is process-wide. The workflow is still
                    // live, the new owner's adoption re-registers the same key
                    // idempotently, and unregistering here could land AFTER that
                    // adoption and strip the lease from a running workflow. The
                    // terminal handlers release it (this instance through its
                    // no-entry, project-scoped path).
                  }),
                )
              }
              // New owner: the re-stamp moved ownership HERE.
              if (yield* DagLocation.ownsSession(sessionID, ctx.directory)) {
                // Adopt every non-terminal workflow of the moved session through
                // the ordinary recovery path. The old owner just cancelled its
                // children and interrupted its fibers, so without adoption the
                // durable rows stay running/paused/stepping with dead attempts
                // and nothing ever schedules them again. recoverWorkflow keeps
                // its own guards (directory ownership, runtimes/recovering
                // reservations, tryClaimAdoption) and reconciles dead attempts
                // with attempt identity, pausing on invented failures.
                const moved = yield* store.listBySession(sessionID)
                for (const wf of moved) {
                  if (!["running", "paused", "stepping"].includes(wf.status)) continue
                  if (runtimes.has(wf.id) || recovering.has(wf.id)) continue
                  yield* recoverWorkflow(wf).pipe(guarded("SessionMovedAdoption"), Effect.forkScoped)
                }
                // Wake rows that were wedged (mixed stamps → no owner) are now
                // deliverable.
                yield* tryDeliverWake(sessionID).pipe(Effect.ignore, Effect.forkScoped)
              }
            }).pipe(guarded("SessionMoved")),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        // Install all live event handlers before spawning recovery watchers so
        // a child that settles immediately cannot leave the runtime stale.
        // Orphan-pending sweep first: the WorkflowStarted it publishes for the
        // terminalization leg is rejected by the handler's status guard above
        // (the row is already failed once the event arrives), never adopted.
        const pendingWfs = yield* store.listByStatus("pending").pipe(Effect.orDie)
        for (const wf of pendingWfs) {
          yield* recoverOrphanPending(wf).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DagLoop orphan pending recovery failed for workflow", { dagID: wf.id, cause }),
            ),
          )
        }
        const runningWfs = yield* store.listByStatus("running").pipe(Effect.orDie)
        const pausedWfs = yield* store.listByStatus("paused").pipe(Effect.orDie)
        const steppingWfs = yield* store.listByStatus("stepping").pipe(Effect.orDie)
        for (const wf of [...runningWfs, ...pausedWfs, ...steppingWfs]) {
          yield* recoverWorkflow(wf).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DagLoop recovery failed for workflow", { dagID: wf.id, cause }),
            ),
          )
        }
        yield* remindPausedWorkflows

        // Terminal rows can survive a process crash after projection but before
        // parent delivery. Re-enter the normal serialized drain for every
        // affected parent session without waiting for a new status event.
        // Store failures here are defects (the store's error channel is never);
        // absorb them with a warning so layer construction survives, but never
        // silently — a swallowed failure means wake redelivery is lost until
        // the next process restart.
        const pendingWakeSessions = yield* store
          .getSessionsWithUnreportedWakes()
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DagLoop failed to list sessions with unreported wakes", { cause }).pipe(
                Effect.as([] as string[]),
              ),
            ),
          )
        for (const sessionID of pendingWakeSessions) {
          // Cross-instance guard via the execution-location authority: wake
          // redelivery is store-global. Only drain sessions whose workflows
          // belong to this instance's DIRECTORY — sibling worktrees of the
          // same project share the project id and must not deliver each
          // other's wakes.
          if (!(yield* DagLocation.ownsSession(sessionID, ctx.directory))) continue
          // The wake snapshot's own workflow rows carry a second ownership
          // proof — only drain sessions whose unreported workflows belong to
          // this project.
          const snapshot = yield* store
            .getWakeSnapshot(sessionID)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("DagLoop failed to read wake snapshot", { sessionID, cause }).pipe(
                  Effect.as({ nodes: [], workflows: [] } satisfies DagStore.WakeSnapshot),
                ),
              ),
            )
          if (!snapshot.workflows.some((wf) => wf.projectId === ctx.project.id)) continue
          // GOAL-FP-01-01: register only NON-terminal workflows. Terminal
          // workflows with wake_reported=true would otherwise be re-registered
          // on every restart and never unregistered (the only unregister for
          // them lives in the wake-delivery SUCCESS path, whose batch only
          // carries unreported workflows) — permanently leaking a dag
          // registration and blocking the goal. Terminal-but-unreported
          // workflows are safe to skip here too: tryDeliverWake registers
          // every workflow in its batch itself right before claiming the wake
          // lease, so wake redelivery does not depend on this sweep.
          yield* Effect.forEach(
            snapshot.workflows.filter((workflow) => !isWorkflowTerminalStatus(workflow.status as never)),
            (workflow) =>
              automation.register(SessionID.make(sessionID), { kind: "dag", id: workflow.id }),
            { discard: true },
          )
          yield* tryDeliverWake(sessionID).pipe(Effect.forkScoped)
        }

        return {}
      }),
    )

    const init = Effect.fn("DagLoop.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ init })
  }),
)

export const layer = serviceLayer.pipe(Layer.provide(SessionAutomationLease.defaultLayer))

export const defaultLayer = layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(DagStore.defaultLayer),
  Layer.provide(DagMessages.defaultLayer),
  Layer.provide(Dag.defaultLayer),
  Layer.provide(Agent.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
  Layer.provide(Permission.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

export const node = LayerNode.make(layer, [
  Database.node,
  EventV2Bridge.node,
  DagStore.node,
  DagMessages.node,
  Dag.node,
  Agent.node,
  Session.node,
  SessionPrompt.node,
  Permission.node,
  SessionStatus.node,
])
