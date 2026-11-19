// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagLoop from "./loop"

import { Cause, Effect, Layer, Context, Stream, Semaphore, Fiber, Option, DateTime, Scope } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { DagEvent } from "@graphagent/schema/dag-event"
import { DagLease } from "@graphagent/core/dag/lease"
import { DagStore } from "@graphagent/core/dag/store"
import { DagMessages } from "@graphagent/core/dag/messages"
import { Database } from "@graphagent/core/database/database"
import { DagLocation } from "../location"
import { WorkflowRuntime, toSchedulingNodes } from "@graphagent/core/dag/core/scheduling"
import {
  isTransitionRejection,
  isWorkflowTerminalStatus,
  isTerminalWorkflowStatusValue,
} from "@graphagent/core/dag/core/types"
import { Dag, parseWorkflowConfig } from "../dag"
import { staleUpstreamNodes, staleUpstreamNote } from "../recovery-plan"
import { DagFanOut } from "../fan-out"
import { projectBriefForNode } from "../admission"
import {
  reviewImplementationFingerprint,
  reviewContractForNode,
  validateReviewExecutionInput,
  targetSensitiveNode,
  workspaceWritesOf,
} from "../review-lifecycle"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionInbox } from "@/session/inbox"
import { ExclusiveRegistry } from "@/session/engine-process"
import { AgentScheduler } from "@/session/agent-scheduler"
import { renderTemplate } from "../templates/resolve"
import { upstreamBlock } from "../templates/envelope"
import { DagConfig } from "../config"
import { DagSection } from "@/config/dag-section"
import { spawnNode } from "./spawn"
import { DagComposeExpansion } from "./compose-expansion"
import { UpstreamBound } from "./upstream-bound"
import { collectChangeFacts, renderChangeFacts } from "./change-facts"
import { evaluateCondition, resolveInputMapping, resolveInputMappingChecked, parseInputMappingReference } from "./eval"
import {
  reconcileWorkflow,
  makeSessionStatusChecker,
  makeLastAssistantTextReader,
  makeLastAssistantMessageReader,
} from "./recovery"
import { Checkpoint } from "./checkpoint"
import { childAbort } from "./child-failure-reason"
import { boundedCancel } from "@/session/child/cancel"
import { normalizeOutput } from "./verdict"
import { verifyOutputFileRef, isManagedOutputFileRef } from "./output-ref"
import { artifactPermissionBase, makeArtifactSourceAuthorizer } from "./artifact-permissions"
import { Permission } from "@/permission"
import { Truncate } from "@/tool/truncate"
import { HookStartContext } from "@/hook/start-context"
import { HookLifecycle } from "@/hook/lifecycle"
import { DagDelivery } from "./delivery"
import { RunnerLease } from "./runner-lease"
import { RunnerPort } from "./runner-port"
import { DagReconciler } from "./reconciler"
import { workflowWorktreeSettlementPending } from "./worktree-completion"
import { Logging } from "@graphagent/core/observability/logging"
import {
  allowedVerdictHint,
  guarded,
  makeForkWakeAfter,
  settledWithoutOutputPlaceholder,
  type WorkflowEntry,
} from "./entry"
import type { DagLoopContext } from "./context"
import { DagLoopControlHandlers } from "./control-handlers"
import { DagLoopGates } from "./gates"
import { DagLoopLifecycleHandlers } from "./lifecycle-handlers"
import { DagLoopMessageContinuation } from "./message-continuation"
import { DagLoopReplanHandler } from "./replan-handler"
import { DagLoopTeardown } from "./teardown"

export { PAUSED_REMINDER_DELAY_MS, isPausedReminderDue, wakeBatchIdentity } from "./delivery"

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/DagLoop") {}

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
    const childRuns = yield* promptSvc.children
    const permissionSvc = Option.getOrUndefined(yield* Effect.serviceOption(Permission.Service))
    // #1453: spills an oversized upstream string to disk. Optional: without it a value is handed over whole.
    const truncate = Option.getOrUndefined(yield* Effect.serviceOption(Truncate.Service))
    const statusSvc = yield* SessionStatus.Service
    // The shared per-instance inbox: it owns the one idle subscription and is
    // the only way a wake or a queued agent message reaches the parent session
    // (#1344). Every graph that builds DagLoop provides one.
    const inbox = yield* SessionInbox.Service
    const automation = yield* ExclusiveRegistry.Service
    const scheduler = yield* AgentScheduler.Service
    const database = yield* Database.Service
    const { leases, runnerID } = yield* RunnerLease.resolve(database)

    const state = yield* InstanceState.make(
      Effect.fn("DagLoop.state")(function* (ctx) {
        const stateScope = yield* Scope.Scope
        const runtimes = new Map<string, WorkflowEntry>()
        // ADR-0008: this instance's runner leases. Made before any fiber is
        // forked below, so its release at exit runs after they are interrupted.
        // The eviction and the reconciler are made below, once what they need exists; the first tick is a period away.
        let evictEntry:
          ((dagID: string, entry: WorkflowEntry, stillLost?: Effect.Effect<boolean>) => Effect.Effect<void>) | undefined
        // ADR-0008 decision 6: the renewal tick starts the instance's reconcile round, in a fiber of its own.
        let reconciler: DagReconciler.Interface | undefined
        const runnerLease = yield* RunnerLease.make({
          leases,
          runnerID,
          entries: runtimes,
          evict: (dagID, entry, stillLost) => evictEntry?.(dagID, entry, stillLost) ?? Effect.void,
          round: (input) => reconciler?.round(input) ?? Effect.void,
          // A lease found lost (a renewal, a spawn's re-read) is news for the reconciler (Amendment 3, 4b-C): it
          // evicts the entry when another holder shows, and retires one of a workflow that ended (row 1).
          reconcile: (dagID) => reconciler?.reconcileAfter(dagID) ?? Effect.void,
        })
        // ADR-0008 decision 5: runner writes go through the port of the entry (or of the claim, before its
        // entry exists). A refused token drops the workflow: nothing to drop while there is no entry yet,
        // and the adoption ends at its own `confirm`.
        const portFor = (dagID: string, token: DagLease.Token) =>
          RunnerPort.make({ dag, token, lost: runnerLease.refused(dagID, token) })
        // D7: all delivery scheduling (wake + agent mailbox) lives in
        // DagDelivery, the `dag.delivery` source of the inbox. Every event
        // source below only nudges the session through the inbox; the nudge is
        // forked (`inbox.nudge` resolves after the drain it joins), so a handler
        // never waits for a delivery.
        const nudge = DagDelivery.nudger(inbox, stateScope)

        // #1344: what the modules split out of this closure share (DagLoopContext).
        const loop: DagLoopContext.Context = {
          events,
          store,
          dag,
          messageSvc,
          agentSvc,
          sessionSvc,
          promptSvc,
          childRuns,
          permissionSvc,
          automation,
          scheduler,
          ctx,
          stateScope,
          runtimes,
          runnerLease,
          nudge,
        }
        const { checkpointDisposition, enforceCheckpointGate, convergeSkippedNodes, checkCompletion } =
          DagLoopGates.make(loop)

        const startMessageContinuations = DagLoopMessageContinuation.make(loop)
        const { failUnusableWorkspace, abortChild, settleWorkflowTerminal, retireTerminal } = DagLoopTeardown.make(loop)
        // Forward reference for the condition-skip rescan inside spawnReady.
        let rescanReady: (dagID: string) => Effect.Effect<void, Error, Scope.Scope> = () => Effect.void

        const spawnReady = Effect.fn("DagLoop.spawnReady")(function* (dagID: string) {
          const entry = runtimes.get(dagID)
          if (!entry) return
          // Every runner write of this round goes through the entry's port (ADR-0008 decision 5).
          const port = entry.port
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
          // #948: a workflow whose execution directory vanished must fail
          // before any template render, artifact read, or child spawn touches
          // that path. Drop the entry so no later stimulus resumes scheduling.
          const durableWorkflow = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
          if (durableWorkflow) {
            const location = DagLocation.resolveExecution(durableWorkflow)
            if (location._tag !== "ok") {
              // Keep the runtime entry alive through terminalization: the
              // WorkflowFailed handler needs it to abort running sibling
              // children and interrupt their fibers, then drops the entry.
              // Removing it here would orphan those attempts.
              const outcome = yield* failUnusableWorkspace(durableWorkflow, location)
              if (outcome === "failed") return
              // ignored = a concurrent Moved re-stamped the row to a valid
              // directory (continue scheduling) or another actor terminalized
              // it (the terminal handler owns cleanup).
              const current = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
              if (
                !current ||
                isTerminalWorkflowStatusValue(current.status) ||
                DagLocation.resolveExecution(current)._tag !== "ok" ||
                // A move to a DIFFERENT directory transfers execution
                // ownership; the new owner adopts, this stale entry must stop.
                DagLocation.canonicalDirectory(current.directory) !== DagLocation.canonicalDirectory(ctx.directory)
              )
                return
            }
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
          // #943: config defaults resolve against the bound workspace, not the
          // owner directory. Cache per directory so a node-level override does
          // not re-read the file for every spawn in this round.
          const executionBase = entry.executionDirectory ?? ctx.directory
          const dagConfigs = new Map<string, DagConfig.Dag>()
          const loadDagConfig = (directory: string) => {
            const cached = dagConfigs.get(directory)
            if (cached) return Effect.succeed(cached)
            return DagSection.dagSection(directory).pipe(
              Effect.tap((loaded) => Effect.sync(() => dagConfigs.set(directory, loaded))),
            )
          }
          // DAG settings are read once per scheduling round (lazy, like
          // templates) so edits apply to the next round without a restart.
          const dagConfig: DagConfig.Dag = ready.length > 0 ? yield* loadDagConfig(executionBase) : {}
          // A condition_false skip settles a node inside this round, after the
          // ready set was computed. Its NodeSkipped handler sees the node
          // already settled and does not reschedule, so a mixed fan-in it just
          // unlocked (e.g. a review decision over skipped lanes plus a
          // completed verification) would stay pending forever. Rescan once
          // the round is done; step mode keeps its one-node-per-step contract.
          let rescan = false
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
              yield* port
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
                // Shares the replan-verdict gate's normalizeOutput
                // normalization in the NodeCompleted handler below (issue
                // #322). Non-JSON strings fall back to the raw value:
                // whole-output equality still works, field paths stay
                // undefined (documented condition_false), and numeric
                // comparisons keep their loud failure.
                outputs[dep] = { output: normalizeOutput(depNode.output) }
              }
              const condResult = evaluateCondition(nodeConfig.condition, outputs)
              if (!condResult.ok) {
                yield* port
                  .nodeFailed(dagID, nodeID, condResult.error, "exec_failed", admissionAttempt)
                  .pipe(Effect.ignore)
                continue
              }
              if (!condResult.value) {
                const skipped = yield* port.nodeSkipped(dagID, nodeID, "condition_false", admissionAttempt).pipe(
                  Effect.as(true),
                  Effect.catchIf(isTransitionRejection, () => Effect.succeed(false)),
                )
                // Keep the in-memory graph in lockstep only after the durable
                // guarded write succeeds. This still exposes the skip cascade
                // synchronously while WorkflowStepped holds evalLock.
                if (skipped) {
                  entry.runtime.markSkipped(nodeID)
                  yield* convergeSkippedNodes(dagID, entry)
                  rescan = true
                }
                continue
              }
            }

            // A fan-out writer is never spawned as authored: it is replaced
            // through the durable extend path first (parallel writers plus an
            // aggregator under its id, or itself without the marker), and the
            // WorkflowReplanned handler schedules the reshaped graph. The
            // marker lives in the persisted definition, so a crash before the
            // extend commits simply expands again on the next round.
            if (nodeConfig.fan_out !== undefined) {
              const source = nodesSnapshot.find((candidate) => candidate.id === nodeConfig.fan_out)
              const plan = DagFanOut.planFanOut(
                nodeConfig,
                source?.status === "completed" ? source.output : undefined,
                new Set(nodesSnapshot.map((candidate) => candidate.id)),
              )
              const fence = { nodeID, attempt: admissionAttempt }
              const applied = yield* port.extend(dagID, plan.kind === "expand" ? plan.nodes : [plan.node], fence).pipe(
                Effect.as(plan),
                Effect.catch((error) => {
                  if (plan.kind !== "expand" || isTransitionRejection(error)) return Effect.fail(error)
                  const declined = DagFanOut.declineFanOut(
                    nodeConfig,
                    `the expanded graph was rejected: ${error.message}`,
                  )
                  return port.extend(dagID, [declined.node], fence).pipe(Effect.as<DagFanOut.FanOutPlan>(declined))
                }),
                // A stale fence means the parent reshaped this writer first;
                // its WorkflowReplanned handler schedules the current graph.
                Effect.catch((error) =>
                  isTransitionRejection(error)
                    ? Effect.succeed(undefined)
                    : port
                        .nodeFailed(
                          dagID,
                          nodeID,
                          `Fan-out expansion failed: ${error.message}`,
                          "exec_failed",
                          admissionAttempt,
                        )
                        .pipe(Effect.ignore, Effect.as(undefined)),
                ),
              )
              if (applied?.kind === "single" && applied.reason) {
                yield* Effect.logWarning("DAG fan-out declined; running the writer serially", {
                  dagID,
                  nodeID,
                  reason: applied.reason,
                })
              }
              return
            }

            // #1158: a compose slot is not spawned as authored either. Its split node's plan replaces it
            // through the same durable extend path: one read-only child per plan item and a join node under
            // its id, or one fallback worker, or a `compose_capacity` failure of the slot. Marker and plan
            // are persisted, so a crash before the extend commits plans again and gets the same ids.
            if (nodeConfig.expand !== undefined) {
              yield* DagComposeExpansion.expand({
                port,
                agents: agentSvc,
                dagID,
                slot: nodeConfig,
                nodes: nodesSnapshot,
                graph: entry.config?.nodes ?? [],
                attempt: admissionAttempt,
              })
              return
            }

            // #1158: the join node an expansion left behind is checked before any model is asked. Its children
            // must have left it something to join, and one that finds a required item missing, or nothing at
            // all, fails here with its own `required` deciding what that costs (an optional one hands its
            // dependents the failure as their placeholder).
            if (nodeConfig.join !== undefined) {
              const mayRun = yield* DagComposeExpansion.admitJoin({
                port,
                dagID,
                node: nodeConfig,
                nodes: nodesSnapshot,
                attempt: admissionAttempt,
              })
              if (!mayRun) continue
            }

            const promptParts: { type: "text"; text: string }[] = []

            let resolvedMapping: Record<string, unknown> = {}
            const inputMapping =
              nodeConfig.input_mapping ??
              Object.fromEntries(node.dependsOn.map((dependency) => [dependency, dependency]))
            const sourceIDs = new Set([
              ...node.dependsOn,
              ...Object.values(inputMapping).flatMap((source) => {
                const reference = parseInputMappingReference(source)
                return reference.ok ? [reference.nodeID] : []
              }),
            ])
            const inputSources = nodesSnapshot.filter(
              (source) => sourceIDs.has(source.id) && source.status === "completed",
            )
            const artifactsValid = yield* Effect.forEach(
              inputSources,
              (source) => verifyOutputFileRef(source.capturedOutput),
              { discard: true },
            ).pipe(
              Effect.as(true),
              Effect.catch((error) =>
                port
                  .nodeFailed(
                    dagID,
                    nodeID,
                    `Input artifact verification failed: ${error.message}`,
                    "exec_failed",
                    admissionAttempt,
                  )
                  .pipe(Effect.as(false)),
              ),
            )
            if (!artifactsValid) continue
            if (nodeConfig.input_mapping) {
              const resolved = resolveInputMappingChecked(inputMapping, (dependency) => {
                const source = nodesSnapshot.find((candidate) => candidate.id === dependency)
                if (source?.status === "completed") return { found: true, output: source.output }
                // A source that settled without output can only reach this
                // point through the scheduling rules that unlock dependents
                // anyway (an optional failure, or a skipped/aborted mixed
                // fan-in). Give the consumer the same explicit placeholder
                // the default mapping uses rather than failing it — e.g. one
                // crashed review lane must not fail the review decision.
                const placeholder = settledWithoutOutputPlaceholder(source)
                return placeholder === undefined ? { found: false } : { found: false, placeholder }
              })
              if (!resolved.ok) {
                yield* port
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
                if (depNode.status === "completed") return `Dependency "${depId}" completed without output`
                return settledWithoutOutputPlaceholder(depNode) ?? null
              })
            }

            if (nodeConfig) {
              const reviewInput = validateReviewExecutionInput(nodeConfig, resolvedMapping)
              if (!reviewInput.valid) {
                yield* port
                  .nodeFailed(
                    dagID,
                    nodeID,
                    `Review input contract failed: ${reviewInput.errors.join("; ")}`,
                    "verdict_fail",
                    admissionAttempt,
                  )
                  .pipe(Effect.ignore)
                continue
              }
            }

            // #1453: the prompt gets the head of an oversized upstream string and a pointer to the rest. The review
            // input above was judged on the whole text, and so is the fingerprint handed to the spawn below.
            const injected = yield* UpstreamBound.bound(resolvedMapping, truncate?.save)

            // #943: a node workspace overrides the workflow workspace for
            // prompt assets, DAG settings and the child session.
            const nodeDirectory = nodeConfig.workspace ?? executionBase
            const nodeDagConfig = nodeDirectory === executionBase ? dagConfig : yield* loadDagConfig(nodeDirectory)
            const resolved = yield* nodeConfig?.prompt_template
              ? renderTemplate(nodeConfig.prompt_template, nodeDirectory, injected).pipe(
                  Effect.tap((result) =>
                    result.text.trim() === ""
                      ? Effect.logWarning("DAG node resolved template is empty", { dagID, nodeID })
                      : Effect.void,
                  ),
                  Effect.map((result) => ({ ok: true as const, ...result })),
                  Effect.catch((err: unknown) =>
                    Effect.gen(function* () {
                      yield* port
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
              yield* port
                .nodeFailed(
                  dagID,
                  nodeID,
                  `Unresolved template placeholders: ${resolved.unresolvedPlaceholders.join(", ")}`,
                  "verdict_fail",
                  admissionAttempt,
                )
                .pipe(Effect.ignore)
              continue
            }

            promptParts.push({ type: "text", text: resolved.text })
            const recoveryContext = nodeConfig.recovery && nodeConfig.prompt_template?.input?.__workflow_recovery
            if (recoveryContext) {
              promptParts.push({
                type: "text",
                text: `\n\nRecovery context:\n${upstreamBlock("recovery", recoveryContext)}${staleUpstreamNote(staleUpstreamNodes(recoveryContext))}`,
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
              Object.entries(injected).filter(([key]) => !interpolatedKeys.has(key)),
            )
            if (Object.keys(remainingContext).length > 0) {
              promptParts.push({ type: "text", text: `\n\nContext:\n${upstreamBlock("context", remainingContext)}` })
            }

            // #1455: a judging node is told which paths the engine recorded for the writers upstream, beside
            // what those writers reported, so completion rests on facts the engine measured.
            const changeFacts = collectChangeFacts({ node, nodeConfig, nodes: nodesSnapshot, directory: nodeDirectory })
            if (changeFacts) promptParts.push({ type: "text", text: `\n\n${renderChangeFacts(changeFacts)}` })

            if (nodeConfig?.output_schema) {
              promptParts.push({
                type: "text",
                text: `\n\n[OUTPUT CONTRACT] End with exactly one JSON value matching this schema:\n${JSON.stringify(nodeConfig.output_schema, null, 2)}\nUse your final assistant answer only: no Markdown fence or surrounding prose. The runtime validates and captures it automatically. Do not send the final result through agent.send. File changes and other side effects are not rolled back if validation fails.${allowedVerdictHint(nodeConfig.output_schema)}`,
              })
            }
            if (!nodeConfig?.output_schema) {
              promptParts.push({
                type: "text",
                text: "\n\n[FINAL ANSWER] End with your complete final answer. It is captured automatically; do not also report it through agent.send. Use agent.send for questions, decisions and collaboration.",
              })
            }

            // A rejected or pre-admission-failed spawn returns placeholder
            // fibers. They must never replace the tables: a queued attempt
            // rebuilt as pending can be re-admitted while its original fiber
            // is still live, and that original attempt owns the node.
            let admitted = false
            yield* spawnNode(
              { limit: { kind: "workflow", workflowID: dagID }, cap: entry.concurrency },
              {
                dagID,
                nodeID,
                node,
                graphRev: entry.graphRev,
                // ADR-0008 decision 2: the spawn re-reads the lease before its
                // child session exists; a lost lease evicts the workflow.
                leaseHeld: runnerLease.verify(dagID, entry),
                onAdmitted: Effect.gen(function* () {
                  admitted = true
                  entry.runtime.markRunning(nodeID)
                  const oldFiber = entry.fibers.get(nodeID)
                  const oldWatcher = entry.watchers.get(nodeID)
                  yield* abortChild(
                    dagID,
                    nodeID,
                    node.childSessionId,
                    "dag.loop.admission.replace",
                    childAbort("attempt-replaced", "dag-loop"),
                  ).pipe(Effect.ignore)
                  if (oldFiber) yield* Fiber.interrupt(oldFiber).pipe(Effect.ignore)
                  // Interrupt the old watcher before installing a new one. The
                  // old self-renewing watcher would otherwise become unreachable
                  // after the map overwrite and keep escalating stale deadlines.
                  if (oldWatcher) yield* Fiber.interrupt(oldWatcher).pipe(Effect.ignore)
                }),
                parentSessionID: entry.parentSessionID,
                directory: ctx.directory,
                executionDirectory: nodeDirectory,
                ...(nodeConfig?.isolation ? { isolation: nodeConfig.isolation } : {}),
                ...(entry.config?.isolation === "worktree" ? { workflowIsolation: "worktree" as const } : {}),
                inputArtifacts: inputSources.map((source) => source.capturedOutput).filter(isManagedOutputFileRef),
                promptParts,
                outputSchema: nodeConfig?.output_schema as Record<string, unknown> | undefined,
                timeoutMs: nodeConfig?.worker_config?.timeout_ms,
                reportToParent: nodeConfig?.report_to_parent,
                reviewImplementationFingerprint: nodeConfig
                  ? reviewImplementationFingerprint(nodeConfig, resolvedMapping)
                  : undefined,
                // #944: nodes that judge the working tree (block-compiled review
                // lanes, verify, synthesize, or conventional review nodes) record
                // a target fingerprint so a mid-run change marks them stale.
                targetSensitive: targetSensitiveNode(nodeConfig, node.workerType),
                // #1030 D9-h: the node's effective workspace-write policy,
                // defaulted from its worker type when the spec does not say.
                workspaceWrites: workspaceWritesOf(nodeConfig, node.workerType),
                verdictEvidence: nodesSnapshot
                  .filter((source) => node.dependsOn.includes(source.id) && source.status === "completed")
                  .map((source) => ({ nodeID: source.id, output: source.output })),
                // #1031 M6: a block-compiled arbitration resolves prior
                // findings and, under the strict gate, may only ACCEPT when
                // every lens/skeptic lane completed.
                ...(nodeConfig?.review_arbitration
                  ? {
                      reviewArbitration: true as const,
                      ...(nodeConfig.prior_findings !== undefined
                        ? { priorFindings: nodeConfig.prior_findings }
                        : {}),
                      strictReviewGate:
                        entry.config?.mode === "deep" || entry.config?.review_gate === "strict",
                      incompleteReviewLanes: (entry.config?.nodes ?? [])
                        .filter(
                          (definition) =>
                            definition.review_lane !== undefined
                            && node.dependsOn.includes(definition.id)
                            && !nodesSnapshot.some(
                              (row) => row.id === definition.id && row.status === "completed",
                            ),
                        )
                        .map((definition) => definition.id),
                    }
                  : {}),
                fallbackModel: DagConfig.tierModel(nodeDagConfig, {
                  required: node.required,
                  workerType: node.workerType,
                  definition: nodeConfig,
                  graph: entry.config?.nodes,
                }),
                variant: nodeDagConfig.thinking_depth,
                maxTimeoutExtensions:
                  entry.config?.max_timeout_extensions ?? Dag.DEFAULT_WORKFLOW_CONFIG.maxTimeoutExtensions,
              },
            ).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  if (!admitted) return
                  entry.fibers.set(nodeID, result.fiber)
                  entry.watchers.set(nodeID, result.watcherFiber)
                  entry.attemptChild.set(result.fiber, result.childSessionID)
                }),
              ),
              Effect.provideService(Dag.Service, port),
              Effect.provideService(Agent.Service, agentSvc),
              Effect.provideService(Session.Service, sessionSvc),
              Effect.provideService(SessionPrompt.Service, promptSvc),
              Effect.provideService(AgentScheduler.Service, scheduler),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : port.nodeFailed(dagID, nodeID, Cause.pretty(cause), "exec_failed", admissionAttempt),
              ),
              Effect.ignore,
            )
          }
          if (rescan && !entry.runtime.isStepMode()) yield* rescanReady(dagID)
        })
        rescanReady = spawnReady

        const checkSessionStatus = makeSessionStatusChecker(sessionSvc)
        // #345: schemaless recovered nodes settle with the child's last
        // assistant text, mirroring the live spawn path.
        const lastAssistantText = makeLastAssistantTextReader(sessionSvc)
        const lastAssistantMessage = makeLastAssistantMessageReader(sessionSvc)

        // ADR-0008 decision 2: a lost runner lease evicts the entry and writes
        // nothing for the workflow (runner-lease.ts). It cancels the children the
        // entry's own attempts recorded (`attemptChild`); the node row may
        // already name an attempt of the runner that took the lease over.
        evictEntry = RunnerLease.evictor({
          entries: runtimes,
          abort: (dagID, nodeID, childSessionID) =>
            abortChild(dagID, nodeID, childSessionID, "dag.loop.leaseLost", childAbort("lease-lost", "dag-lease")).pipe(
              Effect.ignore,
            ),
          unregister: (entry, dagID) =>
            automation.unregister(SessionID.make(entry.parentSessionID), { kind: "dag", id: dagID }),
        })

        const forkWakeAfter = makeForkWakeAfter(nudge)

        // The `adopt` action of the reconciler (decision 6, row 10) and the one place that creates a runtime entry.
        // `observed` is older than the claim: the adoption works from the row it reads once it holds the claim.
        const recoverWorkflow = Effect.fn("DagLoop.recoverWorkflow")(function* (observed: DagStore.WorkflowRow) {
          // Cross-instance guard: DagLoop is per-directory InstanceState but the
          // event bus and store are process-global. Only the instance whose
          // DIRECTORY owns the workflow may adopt it — otherwise a
          // multi-directory server spawns children under a foreign directory
          // context. The execution-location authority (dag/location.ts)
          // re-reads the durable row: the project id is a fast-reject, the
          // stamped directory is the deciding guard.
          if (!(yield* DagLocation.ownsWorkflow(observed.id, ctx.directory))) return
          const dagID = observed.id
          // Idempotency guard: the single flight of the reconciler keeps two adoptions from reconciling twice and
          // overwriting the entry (orphaning the first entry's fibers from every interrupt sweep); an entry that is
          // there already is left alone as the last line of defense.
          if (runtimes.has(dagID)) return
          let claimed: DagLease.Token | undefined
          // Effect.onExit gives the claim back even when a fiber interrupt cuts
          // the adoption sequence — a finally block does not survive interruption.
          yield* Effect.gen(function* () {
            // ADR-0008 decision 6: the claim comes first. Another runner's live
            // lease ends the adoption before any of its nodes is judged lost.
            const token = yield* runnerLease.claim(dagID)
            if (!token) return
            claimed = token
            // The row given is as old as the observation: adopt from the one read now (status, config, graph
            // revision, execution directory). A workflow that ended or was deleted since is not adopted.
            const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
            if (wf === undefined || isTerminalWorkflowStatusValue(wf.status)) return
            // ADR-0008 decision 4: the node-level reconciliation, its recovery pause and the checkpoint gate
            // are runner writes under this claim, ahead of the entry that will carry the same port.
            const port = portFor(dagID, token)
            const config = parseWorkflowConfig(wf.config)
            const recovery = yield* reconcileWorkflow(
              dagID,
              checkSessionStatus,
              (sid) =>
                Logging.backgroundDebug("lifecycle.dag.execution.aborted", {
                  source: "dag.recovery.cancel",
                  workflowID: dagID,
                  childSessionID: sid,
                }).pipe(
                  Effect.andThen(
                    boundedCancel(
                      promptSvc.cancel(sid as never, { reason: childAbort("recovery", "recovery") }),
                      "dag.recovery.cancel",
                    ).pipe(Effect.forkIn(stateScope, { startImmediately: true }), Effect.asVoid),
                  ),
                ),
              // null (not undefined) marks an unparseable row so recovery
              // fails such nodes loudly instead of undefined-completing them.
              config ?? null,
              lastAssistantText,
              wf.executionDirectory ?? wf.directory,
              (executionDirectory) => {
                const { worktree, boundary } = artifactPermissionBase(ctx.directory, ctx.worktree, executionDirectory)
                return makeArtifactSourceAuthorizer(sessionSvc, agentSvc, worktree, permissionSvc, boundary)
              },
              lastAssistantMessage,
            ).pipe(Effect.provideService(Dag.Service, port), (self) =>
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
                const attemptPause = port.pause(dagID).pipe(
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
            const checkpointState = checkpoint ? yield* checkpointDisposition(dagID, checkpoint, port) : undefined
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
            const isPaused = currentWorkflow?.status === "paused" || pausedForRecovery || pausedForCheckpoint
            const isStepping = currentWorkflow?.status === "stepping" && !isPaused
            if (isPaused) runtime.setPaused(true)
            if (isStepping) runtime.setStepMode(true)
            const entry: WorkflowEntry = {
              token,
              port,
              runtime,
              concurrency: maxConcurrency,
              evalLock: Semaphore.makeUnsafe(1),
              parentSessionID: wf.sessionId,
              config,
              executionDirectory: currentWorkflow?.executionDirectory ?? wf.executionDirectory ?? wf.directory,
              graphRev: currentWorkflow?.graphRev ?? wf.graphRev,
              fibers: new Map(),
              watchers: new Map(),
              attemptChild: new WeakMap(),
              messageContinuations: new Set(recovery.continuations ?? []),
              vetoHold: checkpointState === "held",
            }
            // P2-E deletion-race re-check: the SessionV1.Event.Deleted sweep
            // only removes entries already published into `runtimes`. If the
            // FK cascade deleted this workflow's row while reconciliation ran,
            // publishing now would leak an inert entry the sweep can no longer
            // reach.
            if (!(yield* DagLocation.ownsWorkflow(dagID, ctx.directory))) return
            // #270 atomic-admission fence (C3): the durable read above and the
            // runtimes publish below are still two statements — a deletion can
            // commit between them. One statement re-reads the lease with its
            // workflow (must exist, be non-terminal, still be this claim): a
            // cascade or takeover committed in that window aborts the adoption.
            if (!(yield* runnerLease.confirm(dagID, token))) return
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
              yield* nudge(wf.sessionId)
            }
          }).pipe(
            // No entry at the end: give the claim back instead of letting it run out.
            Effect.onExit(() => runnerLease.abandon(dagID, claimed)),
          )
        })

        // ADR-0008 decision 6: this instance's reconciler. Startup and the renewal tick run its rounds (`reconcile`;
        // the tick's in a fiber of its own, so the renewals never wait for it), and the event triggers below (a first
        // wave, a replan with no entry, a session move) and a lease found lost (the renewal, a spawn's re-read: wired
        // into `runnerLease` above) call `reconcileAfter`, which re-evaluates behind an evaluation under way instead
        // of joining it. Every adoption runs in an evaluation, which is single-flight per workflow. It also disposes of
        // the orphan `pending` rows an older version left behind (`Dag.create` is one transaction now): after a grace
        // period, claim, then fail them in one command. It reads every observation's clock into the instance's clock
        // watch, which the lease owns (decision 2).
        const evictMoved = DagReconciler.movedEvictor({
          entries: runtimes,
          store,
          abort: (dagID, nodeID, childSessionID) =>
            abortChild(
              dagID,
              nodeID,
              childSessionID,
              "dag.loop.locationMoved",
              childAbort("location-moved", "dag-location"),
            ).pipe(Effect.ignore),
        })
        reconciler = DagReconciler.make({
          store,
          leases,
          runnerID,
          directory: ctx.directory,
          entries: runtimes,
          lease: runnerLease,
          noteClock: runnerLease.noteClock,
          portFor,
          // The scope is the instance's, as it is for the startup scan: a round runs in a fiber of its own.
          adopt: (wf) => recoverWorkflow(wf).pipe(Effect.provideService(Scope.Scope, stateScope), Effect.orDie),
          failUnusable: failUnusableWorkspace,
          evictMoved,
          // Row 1: the entry of a workflow that ended, which no terminal handler here is going to hear of when another
          // process ended it.
          retire: (dagID, entry) =>
            retireTerminal(dagID, entry, "reconcile").pipe(
              Effect.flatMap((retired) =>
                retired
                  ? Effect.logInfo("DagLoop retired the runtime entry of a workflow that ended", { dagID })
                  : Effect.void,
              ),
            ),
        })
        const { reconcileAfter } = reconciler

        yield* DagLoopControlHandlers.subscribeStarted(loop, { reconcileAfter })

        for (const def of [DagEvent.NodeCompleted, DagEvent.NodeSkipped, DagEvent.NodeAborted]) {
          // A completed node is an output-producing success; a skipped node is a
          // terminal no-output state that must stay distinguishable so pure-skip
          // descendants cascade instead of running (D13).
          const settle =
            def === DagEvent.NodeSkipped || def === DagEvent.NodeAborted
              ? (entry: WorkflowEntry, nodeID: string) => entry.runtime.markSkipped(nodeID)
              : (entry: WorkflowEntry, nodeID: string) => entry.runtime.markSatisfied(nodeID)
          yield* events.subscribe(def).pipe(
            Stream.filter((e) => runtimes.has(e.data.dagID as string)),
            Stream.runForEach((evt) =>
              Effect.gen(function* () {
                const dagID = evt.data.dagID as string
                const entry = runtimes.get(dagID)
                if (!entry) return
                yield* entry.evalLock
                  .withPermits(1)(
                    Effect.gen(function* () {
                      const nodeID = evt.data.nodeID as string
                      // Same DB cross-check as the NodeFailed handler: projection
                      // is transactional with publish, so a row that no longer
                      // matches the event's terminal status means a later
                      // restart/replan reset it — drop the stale event without
                      // touching the new generation's fiber.
                      const expected =
                        def === DagEvent.NodeSkipped
                          ? "skipped"
                          : def === DagEvent.NodeAborted
                            ? "aborted"
                            : "completed"
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
                            const reason = "reason" in evt.data ? evt.data.reason : undefined
                            const abort =
                              reason === "agent_complete"
                                ? childAbort("workflow-complete", "dag-loop")
                                : reason === "workflow_failed"
                                  ? childAbort("workflow-failed", "dag-loop")
                                  : childAbort("control-cancel", "parent-control")
                            yield* abortChild(
                              dagID,
                              nodeID,
                              node?.childSessionId ?? null,
                              "dag.loop.nodeSkipped.cancel-race",
                              abort,
                            ).pipe(Effect.ignore)
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
                        yield* Effect.logDebug("DagLoop dropped stale node terminal event", {
                          dagID,
                          nodeID,
                          expected,
                          dbStatus: node?.status ?? "missing",
                        })
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
                  )
                  .pipe(
                    // P1-2: trigger wake check directly on node terminal — the
                    // parent session may already be idle (no new idle event will
                    // fire), so we can't rely on the idle subscription alone.
                    Effect.onExit(forkWakeAfter(entry.parentSessionID)),
                  )
              }).pipe(
                guarded(
                  def === DagEvent.NodeSkipped
                    ? "NodeSkipped"
                    : def === DagEvent.NodeAborted
                      ? "NodeAborted"
                      : "NodeCompleted",
                ),
              ),
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
              // Attribute the child interruption to the canceller: a replan
              // owns graph rewrites, an agent control call owns a single
              // attempt. The projection already distinguishes the two rows.
              const origin =
                evt.data.source === "control"
                  ? childAbort("control-cancel", "parent-control")
                  : childAbort("replan", "dag-replan")
              yield* entry.evalLock.withPermits(1)(
                Effect.gen(function* () {
                  const fiber = entry.fibers.get(nodeID)
                  const node = yield* store.getNode(dagID, nodeID)
                  yield* abortChild(dagID, nodeID, node?.childSessionId ?? null, "dag.loop.nodeCancelled", origin).pipe(
                    Effect.ignore,
                  )
                  if (fiber) {
                    yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                    entry.fibers.delete(nodeID)
                  }
                  const watcher = entry.watchers.get(nodeID)
                  if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                  entry.watchers.delete(nodeID)
                  entry.runtime.markUnsatisfied(nodeID)
                  // A control cancellation can ready an optional node's
                  // dependents. Without a scheduling round they would stay
                  // pending and the workflow would remain running forever;
                  // mirror the NodeFailed handler (spawnReady also converges
                  // skip cascades before dispatching).
                  if (!entry.runtime.isStepMode()) yield* spawnReady(dagID)
                  yield* checkCompletion(dagID)
                }),
              )
            }).pipe(guarded("NodeCancelled")),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        // D12 budget requeue: the node row is pending again, so the in-memory
        // graph must be rebuilt from the durable rows before any later schema
        // event (typically WorkflowResumed, which arrives in the same requeue
        // transaction). Rebuilding also drops the failed-unsatisfied seed that
        // would otherwise keep the node unready. Whichever handler wins the
        // race re-checks the durable status: a requeue on a paused workflow
        // (the budget-raise order) schedules nothing here and leaves dispatch
        // to WorkflowResumed.
        yield* events.subscribe(DagEvent.NodeRequeued).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              const entry = runtimes.get(dagID)
              if (!entry) return
              yield* entry.evalLock.withPermits(1)(
                Effect.gen(function* () {
                  if (runtimes.get(dagID) !== entry) return
                  const workflow = yield* store.getWorkflow(dagID)
                  if (!workflow || isTerminalWorkflowStatusValue(workflow.status)) return
                  // D12 budget raise: the requeue can beat the NodeFailed
                  // handler that cancels the failed attempt. The row is pending
                  // again by now, so that handler drops its event as stale and
                  // the old child would keep running unowned. A pending node
                  // that still holds a runtime fiber/watcher is exactly that
                  // stale attempt: interrupt it before the rebuild can schedule
                  // the replacement (spawn's onInterrupt cancels the child).
                  const requeued = yield* store.getNode(dagID, evt.data.nodeID as string)
                  if (requeued?.status === "pending") {
                    const fiber = entry.fibers.get(requeued.id)
                    const watcher = entry.watchers.get(requeued.id)
                    entry.fibers.delete(requeued.id)
                    entry.watchers.delete(requeued.id)
                    if (fiber) yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                    if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                  }
                  entry.vetoHold = false
                  entry.runtime.setPaused(workflow.status === "paused")
                  entry.runtime.setStepMode(workflow.status === "stepping")
                  entry.runtime.rebuildGraph(toSchedulingNodes(yield* store.getCurrentNodes(dagID)))
                  if (workflow.status === "running" && !entry.runtime.isStepMode()) yield* spawnReady(dagID)
                  yield* checkCompletion(dagID)
                }),
              )
            }).pipe(guarded("NodeRequeued")),
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
              yield* entry.evalLock
                .withPermits(1)(
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
                      yield* abortChild(
                        dagID,
                        nid,
                        node.childSessionId ?? null,
                        "dag.loop.nodeFailed.cleanup",
                        childAbort("failure-cleanup", "dag-loop"),
                      ).pipe(Effect.ignore)
                      if (fiber) yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                      if (watcher) yield* Fiber.interrupt(watcher).pipe(Effect.ignore)
                      entry.runtime.markUnsatisfied(nid)
                      if (!entry.runtime.isStepMode()) yield* spawnReady(dagID)
                    }
                    if (node?.status !== "failed") {
                      yield* Effect.logDebug("DagLoop dropped stale NodeFailed", {
                        dagID,
                        nodeID: nid,
                        dbStatus: node?.status ?? "missing",
                      })
                    }
                    // In stepMode, checkCompletion (which can trigger autonomous
                    // fail/complete) still runs, but spawnReady is skipped —
                    // stepping must NOT auto-advance after a node fails.
                    yield* checkCompletion(dagID)
                  }),
                )
                .pipe(Effect.onExit(forkWakeAfter(entry.parentSessionID)))
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
              yield* nudge(entry.parentSessionID)
            }).pipe(guarded("NodeTimeoutEscalated")),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        yield* DagLoopControlHandlers.subscribeControl(loop, { spawnReady, convergeSkippedNodes, checkCompletion })

        yield* DagLoopReplanHandler.subscribe(loop, { abortChild, spawnReady, checkCompletion, reconcileAfter })

        yield* DagLoopLifecycleHandlers.subscribeTerminal(loop, { retireTerminal, settleWorkflowTerminal })

        // D7: one delivery scheduler owns the durable wake ledger and the
        // agent mailbox ledger (see DagDelivery). The inbox drain calls
        // `deliver`; node-terminal handlers, pause recovery, escalation,
        // moves, and the startup sweep nudge the inbox, which serializes them
        // per session with every other source. Delivery keeps the fixed
        // order — wake first, mailbox second — and returns true only when it
        // consumed the boundary.
        const delivery = yield* DagDelivery.make({
          directory: ctx.directory,
          projectID: ctx.project.id,
          scope: stateScope,
          store,
          sessions: sessionSvc,
          prompts: promptSvc,
          status: statusSvc,
          automation,
          database,
          events,
          messages: messageSvc,
          inbox,
          entries: (dagID) => runtimes.get(dagID),
          lastAssistantMessage,
        })
        // The idle subscription lives in SessionInbox (one per instance); this
        // delivery registers itself as the `dag.delivery` source there. The
        // remaining event handlers below nudge the inbox.

        yield* DagLoopLifecycleHandlers.subscribeSession(loop, { abortChild, reconcileAfter })

        // Install all live event handlers before spawning recovery watchers so
        // a child that settles immediately cannot leave the runtime stale.
        // The first reconcile round: orphan `pending` rows first (the
        // WorkflowStarted of their terminalization finds them failed, never
        // adopted), then every running/paused/stepping workflow is adopted or
        // left to its holder.
        yield* reconciler.round({ afterClockJump: false })
        // Re-scan after recovery adopted the durable rows: the construction
        // scan ran before adoption, so this is where paused reminders become
        // deliverable against the reconciled runtimes.
        yield* delivery.scan()

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
          // #1030 D9-g: a crash can land between the terminal transition and
          // the settlement projection. Delivery is gated on that pointer, so
          // settle the durable terminal rows before the first wake scan (the
          // seam is idempotent and owner-gated; a not-owned row is a no-op).
          for (const workflow of snapshot.workflows) {
            if (!isTerminalWorkflowStatusValue(workflow.status)) continue
            if (!workflowWorktreeSettlementPending(workflow, parseWorkflowConfig(workflow.config))) continue
            yield* settleWorkflowTerminal(workflow.id)
          }
          // GOAL-FP-01-01: register only NON-terminal workflows. Terminal
          // workflows with wake_reported=true would otherwise be re-registered
          // on every restart and never unregistered (the only unregister for
          // them lives in the wake-delivery SUCCESS path, whose batch only
          // carries unreported workflows) — permanently leaking a dag
          // registration and blocking the goal. Terminal-but-unreported
          // workflows are safe to skip here too: the delivery drain registers
          // every workflow in its batch itself right before claiming the wake
          // lease, so wake redelivery does not depend on this sweep.
          yield* Effect.forEach(
            snapshot.workflows.filter((workflow) => !isWorkflowTerminalStatus(workflow.status as never)),
            (workflow) => automation.register(SessionID.make(sessionID), { kind: "dag", id: workflow.id }),
            { discard: true },
          )
          yield* nudge(sessionID)
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

export const layer = serviceLayer.pipe(Layer.provide(ExclusiveRegistry.defaultLayer))

export const defaultLayer = layer.pipe(
  // The shared per-instance inbox owns the idle subscription. It is the
  // innermost provide so its own EventV2Bridge/SessionStatus defaults are
  // built in the same memoMap graph as the rest of this layer's deps.
  Layer.provide(SessionInbox.defaultLayer),
  Layer.provide(AgentScheduler.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(DagStore.defaultLayer),
  Layer.provide(DagLease.defaultLayer),
  Layer.provide(DagMessages.defaultLayer),
  Layer.provide(Dag.defaultLayer),
  Layer.provide(Agent.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
  Layer.provide(Permission.defaultLayer),
  Layer.provide(Truncate.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(HookStartContext.defaultLayer),
  Layer.provide(HookLifecycle.defaultLayer),
)

export const node = LayerNode.make(layer, [
  Database.node,
  EventV2Bridge.node,
  DagStore.node,
  DagLease.node,
  DagMessages.node,
  Dag.node,
  Agent.node,
  AgentScheduler.node,
  Session.node,
  SessionPrompt.node,
  Permission.node,
  Truncate.node,
  SessionStatus.node,
  SessionInbox.node,
  HookStartContext.node,
  HookLifecycle.node,
])
