// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * DAG node spawn — reuses the `task` tool's spawn path.
 *
 * A ready node spawns a real child Session through the same contract as task.ts:
 * Agent.Service.get → Session.Service.create(parentID) → deriveSubagentSessionPermission → promptOps.prompt.
 *
 * Admission model (P0-2): the node is durably QUEUED at dispatch — the child
 * session and NodeStarted only materialize INSIDE the concurrency permit, so a
 * 100-node fan-out no longer creates 100 sessions and shows 100 "running"
 * rows while true concurrency is 5. The admission deadline is fixed when the
 * node is admitted (deadline = admission time + timeout_ms) and is NOT
 * adjusted by running-node extensions (F4): the replan/extend handler re-times
 * RUNNING nodes only, so a queued node's pre-permit wait keeps its admission
 * deadline — queue wait counts toward the node's budget, and an expired
 * queued node fails directly via the pre-permit timeout path (no progress to
 * protect). A queued node absent from a plain replan fragment is superseded
 * (cancelled) by planReplan; the additive extend path re-admits it with a
 * fresh admission deadline.
 *
 * Completion model (mirrors task.ts:210-221): a node completes when its child
 * session's prompt() resolves; it fails when prompt() fails. The completion
 * signal (NodeCompleted / NodeFailed) is published from inside the forked
 * execution fiber, preserving concurrency.
 *
 * Output (Level 1): the final text part of the prompt result, same extraction
 * as task.ts. Structured field-level output for input_mapping/condition
 * (Level 2) is a documented boundary — see eval.ts.
 */

import path from "node:path"
import type { TriggerResult } from "@/hook/trigger-result"
import { HookTurnContext } from "@/hook/turn-context"
import { BackgroundJob } from "@/background/job"
import { HookLifecycle } from "@/hook/lifecycle"
import { SettingsHook } from "@/hook"
import { HookStartContext } from "@/hook/start-context"
import { Logging } from "@graphagent/core/observability/logging"
import { Effect, Scope, Fiber, Option, Clock, Cause, Exit } from "effect"
import { Database } from "@graphagent/core/database/database"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { deriveSubagentSessionPermission, subagentDefaultDeniedTools } from "@/agent/subagent-permissions"
import { SessionPrompt } from "@/session/prompt"
import type { ChildRunHandle } from "@/session/child/run"
import { AgentScheduler } from "@/session/agent-scheduler"
import type { LimitKey } from "@/session/agent-scheduler-state"
import { Dag, type NodeExecutionAttempt, isStaleMessageInput } from "../dag"
import { isReviewWorker, type VerdictEvidence } from "../review-lifecycle"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagModel } from "../model"
import { DagLocation } from "../location"
import { DagIsolation } from "../isolation"
import { childAbort, childFailureReason } from "./child-failure-reason"
import { InstanceRef } from "@/effect/instance-ref"
import {
  isTransitionRejection,
  isNodeTerminalStatus,
  isTerminalWorkflowStatusValue,
} from "@graphagent/core/dag/core/types"
import type { DagStore } from "@graphagent/core/dag/store"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { registerCaptureSlot, clearCaptureSlot, settleCapturedOutput, settlePlainTextOutput } from "./capture"
import { captureFinalResponse, finalAssistantText, outputLimitReason, repairPrompt } from "./final-response"
import { commitOutputFileRef, reportAreaDirective, verifyOutputFileRef, type ManagedOutputFileRef } from "./output-ref"
import { artifactPermissionBase, artifactReadPermissions, makeArtifactSourceAuthorizer } from "./artifact-permissions"
import { completeIsolatedNode } from "./worktree-completion"
import { Permission } from "@/permission"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { DagEvent } from "@graphagent/schema/dag-event"

type PromptParts = SessionPrompt.PromptInput["parts"]
type TargetFingerprint = ReturnType<typeof DagLocation.fingerprintTarget>

/** #949: the system context a spawned node receives about its execution
 * location. The value is stable for the attempt: HEAD and the target
 * fingerprint are snapshotted before the first prompt. */
export function dagExecutionContext(
  directory: string | undefined,
  head: string | undefined,
  targetFingerprint?: TargetFingerprint,
) {
  if (!directory) return undefined
  return [
    "<dag-execution-context>",
    `  Execution directory: ${directory}`,
    `  HEAD at start: ${head ?? "unknown (not a git repository, or no commit yet)"}`,
    ...(targetFingerprint
      ? [
          `  Target fingerprint: ${
            targetFingerprint.kind === "none" ? "none (not a git repository)" : targetFingerprint.value
          }`,
        ]
      : []),
    "</dag-execution-context>",
  ].join("\n")
}

export interface NodeSpawnInput {
  dagID: string
  nodeID: string
  node: DagStore.NodeRow
  /** Config generation paired with the node snapshot during scheduler admission. */
  graphRev?: number
  /** Runs after durable admission succeeds and before any watcher or execution fiber starts. */
  onAdmitted?: Effect.Effect<void, never>
  parentSessionID: string
  promptParts: PromptParts
  /** DAG-LOC-01 owner directory — decides workflow ownership. Used as the
   * execution fallback only when executionDirectory is omitted. */
  directory?: string
  /** #943: resolved node execution directory (absolute realpath). Omit to keep
   * executing in the owner directory. Keys the report area and child instance. */
  executionDirectory?: string
  /** #946: create a fresh worktree of the execution target for this attempt.
   * Validation guarantees a clean git target and a writer-capable worker. */
  isolation?: "worktree"
  /** Verified completed dependency artifacts, scoped to this child session. */
  inputArtifacts?: ManagedOutputFileRef[]
  outputSchema?: Record<string, unknown>
  timeoutMs?: number
  reportToParent?: boolean
  reviewImplementationFingerprint?: string
  /** #944: the node judges the working tree (review worker or review block).
   * Omitted callers fall back to the review-worker check. */
  targetSensitive?: boolean
  /** Completed direct dependency outputs an ACCEPT verdict must account for. */
  verdictEvidence?: readonly VerdictEvidence[]
  /** dag.jsonc tier default — authoritative unless a persisted legacy node model exists. */
  fallbackModel?: { modelID: string; providerID: string }
  /** dag.jsonc thinking_depth — forwarded as the prompt variant (no-op unless the model defines it). */
  variant?: string
  /** Workflow-level timeout extension cap (defaults to DEFAULT_WORKFLOW_CONFIG.maxTimeoutExtensions). */
  maxTimeoutExtensions?: number
}

export interface NodeSpawnResult {
  fiber: Fiber.Fiber<unknown, unknown>
  /** Deadline watcher fiber — rebuilt by the replan handler when the deadline is extended. */
  watcherFiber: Fiber.Fiber<unknown, unknown>
}

export interface DeadlineWatcherInput {
  dagID: string
  nodeID: string
  /** Durable attempt captured when this watcher was created. */
  attempt?: NodeExecutionAttempt
  /**
   * The node's effective execution timeout. Doubles as the escalation
   * interval (S1): after escalating, the watcher waits one timeout period
   * before re-reading — an extended deadline (replan adjudication) moves the
   * row's deadline into the future and the loop sleeps until it; an untouched
   * deadline escalates again, driving the count toward the extension cap.
   */
  timeoutMs?: number
  /** Workflow-level timeout extension cap (defaults to DEFAULT_WORKFLOW_CONFIG.maxTimeoutExtensions). */
  maxTimeoutExtensions?: number
}

/**
 * Deadline watcher (timeout = signal, not failure). Sleeps until the node's
 * absolute deadline, then reads the durable row:
 * - node no longer running → exit (cancelled/restarted/completed)
 * - deadline extended on the row (replan with a new timeout_ms) → re-sleep
 * - extension cap exhausted → cancel the child + nodeFailed("timeout")
 * - otherwise → publish NodeTimeoutEscalated (node stays RUNNING)
 * The row is the single source of truth, so a watcher that survives its
 * execution fiber (interrupt misses) self-heals on the next wake-up.
 *
 * S1: the watcher self-renews — it does NOT exit after escalating. It waits
 * one escalate interval and re-reads the row: a replan that extended the
 * deadline (a NEW worker_config.timeout_ms — nodeExtendTimeout recomputes
 * from now per §3.7) is picked up on the next read; a deadline the main agent
 * never adjudicated escalates AGAIN, so the extension count climbs toward the
 * cap and supervision stays bounded even when no replan ever arrives. F5: a
 * queued/pending/paused node past its deadline still polls instead of
 * exiting — the node may yet acquire the permit inside its admission window
 * (edge-deadline permit) and start running under supervision.
 */
export function makeDeadlineWatcher(
  input: DeadlineWatcherInput,
): Effect.Effect<void, never, Dag.Service | SessionPrompt.Service> {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const promptSvc = yield* SessionPrompt.Service
    const childRuns = yield* promptSvc.children
    const escalateIntervalMs = Math.max(1_000, input.timeoutMs ?? Dag.DEFAULT_WORKFLOW_CONFIG.nodeTimeoutMs)
    // Read the durable row. Transient store failures (SQLite lock blips,
    // connection hiccups) must NOT end supervision — a single failed read
    // would otherwise permanently orphan the node's timeout path — so the
    // read retries with a short backoff (R13) and only gives up after every
    // attempt fails. Effect.exit captures both effect failures and defects.
    const readNode = Effect.gen(function* () {
      for (let attemptNo = 0; attemptNo <= 3; attemptNo++) {
        const outcome = yield* dag.store.getNode(input.dagID, input.nodeID).pipe(Effect.exit)
        if (Exit.isSuccess(outcome)) return outcome.value
        if (attemptNo < 3) yield* Effect.sleep(500)
      }
      yield* Effect.logWarning("DAG deadline watcher giving up after store read retries", {
        dagID: input.dagID,
        nodeID: input.nodeID,
      })
      return undefined
    })
    // DAG-LOC-01 (P2-C + review P2): revalidate ownership before the write
    // section — escalation and cap-enforcement writes must not land on a
    // workflow whose durable identity was repainted (identity migration) or
    // whose rows were cascade-deleted. Losing ownership ends this watcher's
    // mandate; the instance that owns the repainted workflow supervises it.
    // The check only runs when it can DISPROVE ownership (instance context
    // and Database both present — always true for watchers forked from
    // DagLoop): absent either, supervision must not end (R13).
    //
    // Review P2: this read follows the same exit+retry pattern as readNode
    // above — a transient store defect must be treated as "cannot disprove
    // ownership" (continue supervising), never as a reason to end the
    // mandate. Unretried, it is the watcher's only store read without R13
    // protection: a defect dies through the outer catchCause, which logs and
    // completes the fiber — permanently ending deadline supervision for a
    // still-running node (no escalation, no cap, unbounded run; nothing
    // re-forks the watcher).
    const ownershipLost = Effect.gen(function* () {
      const instance = yield* InstanceRef
      const db = yield* Effect.serviceOption(Database.Service)
      if (!instance || db._tag === "None") return false
      for (let attemptNo = 0; attemptNo <= 3; attemptNo++) {
        const outcome = yield* DagLocation.ownsWorkflow(input.dagID, instance.directory).pipe(Effect.exit)
        if (Exit.isSuccess(outcome)) return !outcome.value
        if (attemptNo < 3) yield* Effect.sleep(500)
      }
      yield* Effect.logWarning(
        "DAG deadline watcher ownership revalidation failed after store retries — keeping supervision",
        { dagID: input.dagID, nodeID: input.nodeID },
      )
      return false
    })
    for (;;) {
      const node = yield* readNode
      if (!node) {
        // Store read failed after all retries — do NOT exit (the watcher
        // "must not end supervision"). Sleep with a longer backoff and
        // retry the read in the next loop iteration; a transient store
        // outage should not permanently orphan the node's timeout path.
        yield* Effect.sleep(5_000)
        continue
      }
      if (
        input.attempt &&
        (node.replanAttempts !== input.attempt.replanAttempts ||
          (input.attempt.childSessionID !== undefined && node.childSessionId !== input.attempt.childSessionID))
      )
        return
      if (isNodeTerminalStatus(node.status as never)) return
      if (yield* ownershipLost) return
      const now = yield* Clock.currentTimeMillis
      const deadline = node.deadlineMs
      if (node.status !== "running") {
        // Pre-running wait (F5): a queued/pending/paused node past its
        // deadline may still acquire the permit inside its admission window —
        // do not abandon supervision; poll until it starts, terminalizes, or
        // the pre-permit timeout path fails it.
        yield* Effect.sleep(sleepUntilDeadlineMs(deadline, now, 1_000))
        continue
      }
      if (deadline === null || deadline > now) {
        // A replan can replace a long deadline with a shorter one while this
        // watcher sleeps. Bound the sleep so the durable row is re-read soon
        // enough to enforce the new deadline without forking another watcher.
        yield* Effect.sleep(Math.min(sleepUntilDeadlineMs(deadline, now, 10), 1_000))
        continue
      }
      const extensions = node.timeoutExtensions
      const maxExtensions = input.maxTimeoutExtensions ?? Dag.DEFAULT_WORKFLOW_CONFIG.maxTimeoutExtensions
      if (extensions >= maxExtensions) {
        // Enforcing the cap IS the watcher's contract (§5-5), so a transient
        // failure here must retry rather than end supervision: returning would
        // leave a RUNNING node past its cap with nobody left to fail it. A
        // rejected guard means someone else already terminalized the node,
        // which counts as done.
        const usedMs = node.startedAt === null ? undefined : Math.max(0, now - node.startedAt)
        const reason =
          `timeout extensions exhausted (${extensions}/${maxExtensions}); timed out at the cap` +
          (usedMs === undefined ? "" : ` after ${usedMs}ms`) +
          ` (configured cap ${maxExtensions})`
        const attempt = {
          replanAttempts: node.replanAttempts,
          ...(node.childSessionId ? { childSessionID: node.childSessionId } : {}),
        }
        const outcome = yield* dag.nodeFailed(input.dagID, input.nodeID, reason, "timeout", attempt).pipe(
          Effect.as("failed" as const),
          Effect.catchIf(isTransitionRejection, () =>
            Effect.logWarning(
              "nodeFailed (timeout extensions exhausted) guard rejected — node attempt is no longer current",
            ).pipe(Effect.as("stale" as const)),
          ),
          Effect.exit,
        )
        if (Exit.isSuccess(outcome)) {
          if (outcome.value === "stale") return
          if (node.childSessionId) {
            yield* Logging.backgroundDebug("lifecycle.dag.execution.aborted", {
              source: "dag.deadlineWatcher.cap",
              workflowID: input.dagID,
              nodeID: input.nodeID,
              replanAttempts: node.replanAttempts,
              childSessionID: node.childSessionId,
            })
            // End the attempt's run and cancel its turn in one call. A session
            // this process has no active run for (a later process's row, an
            // already-finished attempt) still gets the turn cancellation.
            const cancelled = yield* childRuns.cancelActive(SessionID.make(node.childSessionId), {
              kind: "engine",
              reason: "deadline-cap",
              actor: "deadline-watcher",
            })
            if (cancelled === "not_active")
              yield* promptSvc.cancel(node.childSessionId as never, {
                reason: childAbort("deadline-cap", "deadline-watcher"),
              })
          }
          return
        }
        if (Cause.hasInterrupts(outcome.cause)) return yield* Effect.failCause(outcome.cause)
        yield* Effect.logWarning("DAG deadline watcher cap enforcement failed — retrying", {
          dagID: input.dagID,
          nodeID: input.nodeID,
          cause: outcome.cause,
        })
        yield* Effect.sleep(escalateIntervalMs)
        continue
      }
      // The escalate write takes the workflow lock and publishes a durable
      // event, so it can fail with a typed Error (lock contention) or die (a
      // publish defect). Neither may end supervision: an exited watcher stops
      // escalating, the extension count stops climbing, `extensions >=
      // maxExtensions` never becomes true, and the node occupies a concurrency
      // slot unbounded. Log and fall through to the sleep — the next iteration
      // re-reads the row and escalates again. Mirrors the read path's R13
      // hardening above, which the write path previously lacked.
      // The deadline this watcher OBSERVED may be stale — it was read WITHOUT
      // the workflow lock (readNode above). nodeTimeoutEscalated re-reads the
      // node under the lock and suppresses the escalation when the deadline has
      // moved past this observed value (ticket B — spurious T8 suppression),
      // so a budget unit is only charged when the node is genuinely still
      // overdue. Pass node.deadlineMs, the value this snapshot read.
      const attempt = {
        replanAttempts: node.replanAttempts,
        ...(node.childSessionId ? { childSessionID: node.childSessionId } : {}),
      }
      const escalated = yield* dag
        .nodeTimeoutEscalated(
          input.dagID,
          input.nodeID,
          node.childSessionId as never,
          extensions + 1,
          node.deadlineMs,
          attempt,
        )
        .pipe(
          Effect.catchIf(isTransitionRejection, () =>
            Effect.logWarning("nodeTimeoutEscalated guard rejected — node already terminal"),
          ),
          Effect.exit,
        )
      if (Exit.isFailure(escalated)) {
        if (Cause.hasInterrupts(escalated.cause)) return yield* Effect.failCause(escalated.cause)
        yield* Effect.logWarning("DAG deadline watcher escalation failed — keeping supervision and retrying", {
          dagID: input.dagID,
          nodeID: input.nodeID,
          cause: escalated.cause,
        })
      }
      // Self-renew (S1): stay alive after escalating. Wait one escalate
      // interval, then loop — the re-read sees an extended deadline (replan
      // adjudication via nodeExtendTimeout) and sleeps until it, or sees a
      // still-past deadline and escalates AGAIN. Repeated escalation is what
      // drives the count toward the cap, so a main agent that never replans
      // cannot leave the node running unbounded.
      yield* Effect.sleep(escalateIntervalMs)
    }
  }).pipe(
    // Last-resort net for defects outside the loop's own handling. Use
    // hasInterrupts, not interruptors: the latter collects DEFINED fiber IDs
    // and silently ignores interrupt reasons carrying none, which would
    // misclassify such an interrupt as an error.
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.void
        : Effect.logWarning("DAG deadline watcher exited with an error", { cause }),
    ),
  )
}

/**
 * How long the deadline watcher sleeps before re-reading the node row. With no
 * deadline yet, poll fast (100ms) so a late deadline write is seen quickly;
 * with a future deadline, sleep exactly until it (min 10ms); once past the
 * deadline, back off by overdueMs before the next read.
 */
function sleepUntilDeadlineMs(deadlineMs: number | null, now: number, overdueMs: number) {
  if (deadlineMs === null) return 100
  if (deadlineMs > now) return Math.max(deadlineMs - now, 10)
  return overdueMs
}

export function spawnNode(
  schedule: { readonly limit: LimitKey; readonly cap: number },
  input: NodeSpawnInput,
): Effect.Effect<
  NodeSpawnResult,
  Error,
  Dag.Service | Agent.Service | Session.Service | SessionPrompt.Service | AgentScheduler.Service | Scope.Scope
> {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const agentService = yield* Agent.Service
    const sessions = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
    // The parent's scoped view registers and drives this node's run; the full
    // view is for cancellation by child session, whose run id the engine-side
    // cancellation points do not know.
    const childRuns = yield* promptSvc.children
    const children = childRuns.forParent(SessionID.make(input.parentSessionID))
    const scheduler = yield* AgentScheduler.Service
    const configService = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
    const permissionSvc = Option.getOrUndefined(yield* Effect.serviceOption(Permission.Service))
    const scope = yield* Scope.Scope
    const hooks = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
    const hookLifecycle = Option.getOrUndefined(yield* Effect.serviceOption(HookLifecycle.Service))
    const hookStart = Option.getOrUndefined(yield* Effect.serviceOption(HookStartContext.Service))
    const admissionAttempt = {
      replanAttempts: input.node.replanAttempts,
      nodeSeq: input.node.seq,
      ...(input.graphRev !== undefined ? { graphRev: input.graphRev } : {}),
    } satisfies NodeExecutionAttempt
    const executionAttempt = {
      replanAttempts: input.node.replanAttempts,
    } satisfies NodeExecutionAttempt

    // Pre-admission failures settle here and return an empty fiber (same
    // shape as the !admitted path below) instead of Effect.fail — failing
    // would make the caller's catchCause publish a second, guard-rejected
    // NodeFailed (noise).
    const failWithoutFiber = (reason: string, label: string) =>
      Effect.gen(function* () {
        yield* dag
          .nodeFailed(input.dagID, input.nodeID, reason, "exec_failed", admissionAttempt)
          .pipe(
            Effect.catchIf(isTransitionRejection, () =>
              Effect.logWarning(`nodeFailed (${label}) guard rejected — node already terminal`),
            ),
          )
        return {
          fiber: yield* Effect.forkIn(scope)(Effect.void),
          watcherFiber: yield* Effect.forkIn(scope)(Effect.void),
        }
      })

    const agent = yield* agentService
      .get(input.node.workerType)
      .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    if (!agent) {
      return yield* failWithoutFiber(`unknown worker_type: ${input.node.workerType}`, "unknown worker_type")
    }

    const parentOutcome = yield* sessions.get(SessionID.make(input.parentSessionID)).pipe(Effect.exit)
    if (Exit.isFailure(parentOutcome)) {
      if (Cause.hasInterrupts(parentOutcome.cause)) return yield* Effect.failCause(parentOutcome.cause)
      return yield* failWithoutFiber(Cause.pretty(parentOutcome.cause), "parent session lookup")
    }
    const parent = parentOutcome.value
    const persistedNodeModel =
      input.node.modelId && input.node.modelProviderId
        ? Dag.normalizeModel({
            modelID: input.node.modelId,
            providerID: input.node.modelProviderId,
          })
        : undefined
    const nodeModel = persistedNodeModel
      ? {
          modelID: persistedNodeModel.modelID,
          providerID: persistedNodeModel.providerID,
        }
      : undefined
    const resolvedModel = DagModel.resolve({
      node: nodeModel,
      tier: input.fallbackModel,
      agent: agent.model,
      parent: parent.model ? { modelID: parent.model.id, providerID: parent.model.providerID } : undefined,
    })
    if (!resolvedModel) {
      return yield* failWithoutFiber(`no model configured for agent: ${agent.name}`, "no model")
    }
    const model = {
      modelID: ModelV2.ID.make(resolvedModel.modelID),
      providerID: ProviderV2.ID.make(resolvedModel.providerID),
    }

    // Same effective request budget as the LLM request path, resolved lazily so diagnostics
    // never change the spawn service requirements when provider/config services are absent.
    const resolveOutputCap = Effect.gen(function* () {
      const provider = Option.getOrUndefined(yield* Effect.serviceOption(Provider.Service))
      const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
      const flags = Option.getOrUndefined(yield* Effect.serviceOption(RuntimeFlags.Service))
      if (!provider || !config || !flags) return undefined
      const resolved = Option.getOrUndefined(
        yield* provider.getModel(model.providerID, model.modelID).pipe(Effect.option),
      )
      if (!resolved) return undefined
      return ProviderTransform.maxOutputTokens(
        resolved,
        flags.outputTokenMax,
        ProviderTransform.configuredOutputLimit(yield* config.get(), resolved),
      )
    })

    const childPermission = [
      ...deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: agent,
      }),
    ]
    const instance = yield* Effect.serviceOption(InstanceRef)
    const ambient = Option.isSome(instance) ? instance.value : undefined
    // #943: the node's execution directory is explicit. Callers that
    // omit it keep the owner/ambient behavior unchanged, including non-git
    // directories (no worktree requirement here).
    const executionDirectory = input.executionDirectory ?? input.directory ?? ambient?.directory
    const executionReal = executionDirectory ? DagLocation.canonicalDirectory(executionDirectory) : undefined
    const ambientReal = ambient?.directory ? DagLocation.canonicalDirectory(ambient.directory) : undefined
    const directory = ambient?.directory ?? executionDirectory ?? process.cwd()
    const { worktree, boundary } = artifactPermissionBase(
      directory,
      ambient?.worktree ?? directory,
      executionReal ?? directory,
    )
    if (input.inputArtifacts?.length) {
      if (worktree)
        childPermission.push(
          ...artifactReadPermissions(input.inputArtifacts, worktree, agent.permission, childPermission),
        )
    }
    // The same tool denials the task tool applies (Issue #1026, PR4): the
    // per-agent defaults and the global `primary_tools` restriction. DAG
    // nodes previously missed both, so a node could use a tool its worker
    // agent denies. Deduplicated exactly like task.ts.
    const cfg = configService ? yield* configService.get() : undefined
    const scriptedDenies = [
      ...subagentDefaultDeniedTools(agent).map((permission) => ({
        permission,
        pattern: "*" as const,
        action: "deny" as const,
      })),
      ...(cfg?.experimental?.primary_tools?.map((permission) => ({
        permission,
        pattern: "*" as const,
        action: "deny" as const,
      })) ?? []),
    ]
    childPermission.push(
      ...scriptedDenies.filter(
        (deny) =>
          !childPermission.some(
            (rule) =>
              rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
          ),
      ),
    )
    // Child prompts and their tools resolve `InstanceState` from the fiber.
    // A bound workspace must therefore execute inside that directory's
    // instance, not the owner's ambient one. The module is imported lazily:
    // InstanceStore tears down instance-scoped services and its static import
    // closes a bootstrap → DAG → spawn cycle (same pattern as session.ts).
    // Harness runtimes without InstanceStore keep the old direct path; the
    // directory assertion below still catches a child that ignored it.
    const { InstanceStore } = yield* Effect.promise(() => import("@/project/instance-store"))
    const instanceStore = Option.getOrUndefined(yield* Effect.serviceOption(InstanceStore.Service))
    const inInstance = <A, E, R>(
      directory: string | undefined,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => {
      const real = directory ? DagLocation.canonicalDirectory(directory) : undefined
      return instanceStore && real && real !== ambientReal
        ? instanceStore.provide({ directory: real, trustProject: ambient?.trustProject === true }, effect)
        : effect
    }

    // Resolve timeout and compute the absolute deadline at ADMISSION time
    // (P0-2). The deadline is persisted on the durable queued row so
    // crash-recovery can inherit it; queue wait counts toward the budget.
    const timeoutMs = input.timeoutMs ?? Dag.DEFAULT_WORKFLOW_CONFIG.nodeTimeoutMs
    const spawnTime = yield* Clock.currentTimeMillis
    const deadlineMs = spawnTime + timeoutMs

    // If a concurrent replan(cancel/restart) terminalized the node during the
    // async window above (agent/model resolution), the queued guard rejects.
    // The winning control op is the sole terminalization — no spurious
    // NodeFailed, no execution fiber.
    const admitted = yield* dag.nodeQueued(input.dagID, input.nodeID, deadlineMs, admissionAttempt).pipe(
      Effect.as(true),
      Effect.catchIf(isTransitionRejection, () =>
        Effect.logWarning(`Node ${input.nodeID} admission was rejected — no execution attempt started`).pipe(
          Effect.as(false),
        ),
      ),
    )
    if (!admitted) {
      const fiber = yield* Effect.forkIn(scope)(Effect.void)
      const watcherFiber = yield* Effect.forkIn(scope)(Effect.void)
      return { fiber, watcherFiber }
    }
    if (input.onAdmitted) yield* input.onAdmitted

    // Assigned inside the fiber once the child session materializes; read by
    // the ensuring/onInterrupt cleanups below.
    let childSessionID: string | undefined
    // The attempt's child run, registered after the child session exists and
    // before NodeStarted; read by every terminal path and the fiber's cleanup.
    let run: ChildRunHandle | undefined
    // Lazy, like InstanceStore: Worktree statically imports the instance
    // chain, so a static import here closes bootstrap → DAG → spawn → worktree.
    const { Worktree } = yield* Effect.promise(() => import("@/worktree"))
    const worktreeSvc = Option.getOrUndefined(yield* Effect.serviceOption(Worktree.Service))
    // #946: the isolated worktree for this attempt and whether its lifecycle
    // was already settled (completed with a patch, or kept after failure).
    // Unsettled creations are removed by the ensuring cleanup.
    let isolatedWorktree: DagEvent.NodeWorktree | undefined
    let worktreeHandled = false
    // Set only after NodeStarted is durably published. Before that point no
    // row references the worktree, so every exit path (including a rejected
    // admission or a terminalized node) must remove it.
    let started = false
    const hookOrigin = agent.hookOrigin ? `agent:${agent.hookOrigin}` : `agent-config:${agent.name}`

    // Forked first so the execution fiber's cleanup closures can capture it.
    const watcherFiber = yield* Effect.forkIn(scope)(
      makeDeadlineWatcher({
        dagID: input.dagID,
        nodeID: input.nodeID,
        attempt: executionAttempt,
        timeoutMs,
        maxTimeoutExtensions: input.maxTimeoutExtensions,
      }),
    )

    const fiber = yield* Effect.forkIn(scope)(
      Effect.gen(function* () {
        // P1(#1): Acquire permit with a deadline-bounded timeout so the node
        // doesn't wait unbounded in the scheduler queue. If the deadline
        // elapses while waiting, fail immediately.
        const queueTime = yield* Clock.currentTimeMillis
        const queueRemaining = deadlineMs - queueTime
        if (queueRemaining <= 0) {
          yield* dag
            .nodeFailed(
              input.dagID,
              input.nodeID,
              `node exceeded timeout before acquiring execution permit`,
              "timeout",
              executionAttempt,
            )
            .pipe(
              Effect.catchIf(isTransitionRejection, () =>
                Effect.logWarning("nodeFailed (pre-permit timeout) guard rejected — node already terminal"),
              ),
            )
          return
        }
        // Race permit acquisition against the remaining queue budget. The
        // scheduler wait itself is unbounded: this option is the single
        // timeout path, and an interrupt cancels the queued reservation
        // through the permit's acquireRelease.
        let slot: AgentScheduler.SlotPermit | undefined
        const permitAcquired = yield* Effect.gen(function* () {
          slot = yield* scheduler.childSlot(schedule.limit, schedule.cap, {
            rootSessionID: input.parentSessionID,
          })
        }).pipe(Effect.timeoutOption(queueRemaining))
        if (Option.isNone(permitAcquired)) {
          yield* dag
            .nodeFailed(
              input.dagID,
              input.nodeID,
              `node exceeded timeout while waiting for execution permit`,
              "timeout",
              executionAttempt,
            )
            .pipe(
              Effect.catchIf(isTransitionRejection, () =>
                Effect.logWarning("nodeFailed (permit-wait timeout) guard rejected — node already terminal"),
              ),
            )
          return
        }
        yield* Effect.gen(function* () {
          // #379 pause fence: scheduler admission is the only pause gate, so a
          // node queued before control(pause) still holds a spawn fiber that
          // would materialize its child session the moment a permit frees —
          // contradicting the documented pause contract ("prevents new nodes
          // from spawning"). Hold the fiber here while the durable workflow
          // row reads `paused`: the node stays queued (never terminalized) and
          // the fiber proceeds on control(resume). A workflow that was deleted
          // or terminalized during the wait falls through to the adoption
          // fence / nodeStarted guard below, which already no-op dead targets.
          // The status read fails open (unreadable ⇒ treat as not paused):
          // the adoption fence below is the authoritative revalidation, so a
          // transient store blip must not kill the spawn fiber here.
          // Effect.suspend defers the call so even a store facade lacking the
          // method surfaces as a captured defect instead of a synchronous throw.
          const readPauseStatus = Effect.exit(Effect.suspend(() => dag.store.getWorkflow(input.dagID))).pipe(
            Effect.map((outcome) => (Exit.isSuccess(outcome) ? outcome.value?.status : undefined)),
          )
          if ((yield* readPauseStatus) === "paused") {
            yield* Effect.logWarning(
              `Workflow ${input.dagID} paused while node ${input.nodeID} was queued — releasing its child slot until resume`,
            )
            // A paused node must not keep a child-run slot: another workflow
            // and the foreground task pool have to be able to run while this
            // one is paused. Resume re-queues the node for a fresh slot.
            if (slot) yield* slot.release
            while ((yield* readPauseStatus) === "paused") {
              yield* Effect.sleep(250)
            }
            slot = yield* scheduler.childSlot(schedule.limit, schedule.cap, {
              rootSessionID: input.parentSessionID,
            })
          }
          // #270 window-2 spawn-admission fence (C4): the node was durably
          // admitted (nodeQueued above) but the child session is about to
          // materialize — a deletion cascade (Session.remove → FK) committed in
          // that window must fence the spawn instead of letting it create an
          // orphan child for a dead workflow. Re-admit ATOMICALLY right before
          // sessions.create: the claim matches only while the workflow row exists
          // and is non-terminal, so a committed deletion matches zero rows and the
          // spawn aborts before any child session exists (no post-deletion spawn
          // survives). This is the revalidation that closes the spawn window the
          // nodeQueued guard alone leaves open between its read and its publish.
          if (!(yield* dag.store.tryClaimAdoption(input.dagID))) return
          // #948: model resolution, permit acquisition, and the pause hold all
          // happen before this point, so the scheduling-round workspace check
          // can be stale. Revalidate the shared execution verdict before the
          // child session exists; a disappeared workspace fails the WORKFLOW,
          // not this node, and never cascades into per-node errors.
          //
          // The check is fail-closed whenever this spawn has execution context
          // (the loop always passes the workflow directory). A read error or a
          // vanished row must not create a child. Only a context-free direct
          // call (unit harness) keeps the old permissive seam.
          const expectedDirectory = input.directory ?? (Option.isSome(instance) ? instance.value?.directory : undefined)
          const expectedProject = Option.isSome(instance) ? instance.value?.project?.id : undefined
          const readWorkspace = Effect.fn("DagRuntime.spawn.readWorkspace")(function* () {
            for (let attempt = 0; attempt <= 2; attempt++) {
              const outcome = yield* Effect.exit(Effect.suspend(() => dag.store.getWorkflow(input.dagID)))
              if (Exit.isSuccess(outcome)) return outcome.value
              if (attempt < 2) yield* Effect.sleep(100)
            }
            // Only a call with execution context is fail-closed. Context-free
            // unit harnesses keep the historical permissive seam.
            if (!expectedDirectory && !expectedProject) return undefined
            return yield* Effect.fail(new Error(`DAG spawn could not read workflow ${input.dagID} after retries`))
          })
          const ownsExpectedLocation = (workflow: DagStore.WorkflowRow) =>
            (!expectedDirectory ||
              (workflow.directory !== null &&
                DagLocation.canonicalDirectory(workflow.directory) ===
                  DagLocation.canonicalDirectory(expectedDirectory))) &&
            (!expectedProject || workflow.projectId === expectedProject)
          const hasExecutionContext = expectedDirectory !== undefined || expectedProject !== undefined
          const spawnable = yield* Effect.gen(function* () {
            const current = yield* readWorkspace()
            if (!current) {
              if (hasExecutionContext) return yield* Effect.fail(new Error(`DAG spawn lost workflow ${input.dagID}`))
              return true
            }
            const failWorkspace = (reason: string) =>
              dag
                .failUnrecoverable(input.dagID, reason)
                .pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterrupts(cause)
                      ? Effect.interrupt
                      : Effect.logWarning(
                          "DAG spawn could not terminalize a workflow with an unusable execution directory",
                          { dagID: input.dagID, nodeID: input.nodeID, cause },
                        ),
                  ),
                )
            const location = DagLocation.resolveExecution(current)
            if (location._tag === "ok") {
              if (!ownsExpectedLocation(current)) return false
              // #943: a node-level workspace is revalidated here too. The
              // workflow row check above covers the bound workflow directory;
              // the node override can point at a different worktree that was
              // removed or replaced since the graph was persisted.
              if (
                input.executionDirectory &&
                expectedDirectory &&
                DagLocation.canonicalDirectory(input.executionDirectory) !==
                  DagLocation.canonicalDirectory(expectedDirectory)
              ) {
                const nodeWorkspace = DagLocation.resolveWorkspace(input.executionDirectory, expectedDirectory)
                if (nodeWorkspace._tag === "invalid") {
                  yield* failWorkspace(`workspace_invalid: ${nodeWorkspace.reason}`)
                  return false
                }
              }
              return true
            }
            yield* failWorkspace(DagLocation.executionFailureReason(location))
            const settled = yield* Effect.exit(Effect.suspend(() => dag.store.getWorkflow(input.dagID)))
            return (
              Exit.isSuccess(settled) &&
              !!settled.value &&
              !isTerminalWorkflowStatusValue(settled.value.status) &&
              DagLocation.resolveExecution(settled.value)._tag === "ok" &&
              ownsExpectedLocation(settled.value)
            )
          })
          if (!spawnable) return
          // A permit or pause wait may outlive the scheduling-round check.
          // Validate again before the child can consume or read its inputs.
          yield* Effect.forEach(input.inputArtifacts ?? [], verifyOutputFileRef, { discard: true })
          // #946: a failed isolated attempt keeps its worktree for inspection.
          const nodeFailure = (reason: string, trigger: string, attempt?: NodeExecutionAttempt, errorClass?: string) =>
            Effect.suspend(() => {
              if (isolatedWorktree) {
                worktreeHandled = true
                isolatedWorktree = { ...isolatedWorktree, state: "kept" }
              }
              // Settle first: the attempt is over even when the durable
              // transition below is rejected as stale (a cancellation then
              // already won the run's compare-and-swap).
              return (run === undefined ? Effect.void : run.settle({ type: "error", message: reason })).pipe(
                Effect.andThen(
                  dag.nodeFailed(input.dagID, input.nodeID, reason, trigger, attempt, errorClass, isolatedWorktree),
                ),
              )
            })
          // #946: isolate at the same point the child session materializes, so
          // a large fan-out never holds more worktrees than max_concurrency.
          let nodeDirectory = executionDirectory
          if (input.isolation === "worktree") {
            if (!worktreeSvc) {
              yield* nodeFailure("worktree isolation requires the Worktree service", "exec_failed")
              return
            }
            if (!executionDirectory) {
              yield* nodeFailure("worktree isolation requires an execution directory", "exec_failed")
              return
            }
            const created = yield* inInstance(
              executionDirectory,
              worktreeSvc.create({ name: `dag-${input.dagID}-${input.nodeID}` }),
            ).pipe(Effect.result)
            if (created._tag === "Failure") {
              yield* nodeFailure(`worktree create failed: ${created.failure.message}`, "exec_failed")
              return
            }
            const info = created.success
            const head = DagLocation.gitHead(info.directory)
            isolatedWorktree = {
              directory: info.directory,
              ...(info.branch ? { branch: info.branch } : {}),
              ...(head ? { baseHead: head } : {}),
              touchedPaths: [],
              state: "active",
              conflictsWith: [],
            }
            worktreeHandled = false
            nodeDirectory = info.directory
          }
          // #946: a non-isolated writer shares the checkout, so only paths it
          // changed after spawn count as its work. Existing edits belong to the
          // user or an earlier attempt and must not be attributed or warned.
          const initialTouched =
            !input.isolation && nodeDirectory ? new Set(DagIsolation.touchedPaths(nodeDirectory)) : undefined
          const nodeExecutionReal = nodeDirectory ? DagLocation.canonicalDirectory(nodeDirectory) : undefined
          const nodeExecution = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
            inInstance(nodeExecutionReal, effect)
          // Permit acquired — only NOW materialize the child session and mark
          // the node running (P0-2). Before this point the node is durably
          // "queued" with no session: a 100-node fan-out holds at most
          // max_concurrency live sessions.
          const childSession = yield* sessions.create({
            parentID: SessionID.make(input.parentSessionID),
            title: `${input.node.name} (DAG node)`,
            agent: agent.name,
            model: { id: model.modelID, providerID: model.providerID },
            permission: childPermission,
            ...(nodeDirectory ? { directory: nodeDirectory } : {}),
          })
          childSessionID = childSession.id as string
          // #943: a child that silently falls back to the ambient instance
          // would run in the wrong checkout — exactly the incident this binds
          // away. An omitted session directory resolves to the ambient one;
          // test harnesses that model only that ambient path therefore pass,
          // while any real fallback to a different directory fails loudly.
          const childDirectory = childSession.directory ?? ambient?.directory
          if (
            nodeExecutionReal &&
            (!childDirectory || DagLocation.canonicalDirectory(childDirectory) !== nodeExecutionReal)
          ) {
            return yield* Effect.die(
              new Error(
                `DAG child session ${childSession.id} has directory "${childDirectory ?? "<missing>"}" but the node is bound to "${nodeDirectory}"`,
              ),
            )
          }

          // #949: snapshot where this attempt runs and the HEAD it starts from.
          // Both are optional: non-git directories have no HEAD.
          const baseHead = nodeDirectory ? DagLocation.gitHead(nodeDirectory) : undefined
          // #944: target-sensitive nodes also snapshot the tree identity before
          // nodeStarted, so the completion check has a bound reference.
          const targetFingerprint =
            (input.targetSensitive ?? isReviewWorker(input.node.workerType)) && nodeDirectory
              ? DagLocation.fingerprintTarget(nodeDirectory)
              : undefined

          // Register the attempt's run before the durable start: the Stop
          // delegation, the cancellation points and the recovery adopt all
          // read it. A terminalized admission cancels it below. `queued` until
          // nodeStarted accepts (markRunning); a DAG result is delivered by the
          // DAG itself, so the run is not a result-ledger run.
          run = yield* children.start({
            childSessionID: childSession.id,
            owner: {
              kind: "dag_node",
              workflowID: input.dagID,
              nodeID: input.nodeID,
              attempt: input.node.replanAttempts,
            },
            detached: false,
            permission: { ask: "auto" },
          })
          // A concurrent replan(cancel/restart) may have terminalized the node
          // while it waited for the permit. nodeStarted's guard rejects; cancel
          // the just-created child session and stop — the winning control op is
          // the sole terminalization, no spurious NodeFailed.
          const terminalized = yield* dag
            .nodeStarted(
              input.dagID,
              input.nodeID,
              childSession.id,
              deadlineMs,
              input.reportToParent,
              executionAttempt,
              nodeDirectory,
              baseHead,
              targetFingerprint,
              isolatedWorktree,
            )
            .pipe(
              Effect.map(() => false),
              Effect.catchIf(isTransitionRejection, () =>
                Effect.gen(function* () {
                  yield* Logging.backgroundDebug("lifecycle.dag.execution.aborted", {
                    source: "dag.spawn.queueWait.terminalized",
                    workflowID: input.dagID,
                    nodeID: input.nodeID,
                    replanAttempts: input.node.replanAttempts,
                    childSessionID: childSession.id,
                  })
                  if (run)
                    yield* children.cancel(run.id, {
                      kind: "engine",
                      reason: "admission-rejected",
                      actor: "dag-loop",
                    })
                  else
                    yield* promptSvc.cancel(childSession.id, {
                      reason: childAbort("admission-rejected", "dag-loop"),
                    })
                  yield* Effect.logWarning(
                    `Node ${input.nodeID} was terminalized during queue wait — child session cancelled, no spurious failure published`,
                  )
                  return true
                }),
              ),
              Effect.onError(() =>
                Logging.backgroundDebug("lifecycle.dag.execution.aborted", {
                  source: "dag.spawn.queueWait.error",
                  workflowID: input.dagID,
                  nodeID: input.nodeID,
                  replanAttempts: input.node.replanAttempts,
                  childSessionID: childSession.id,
                }).pipe(
                  Effect.andThen(
                    run
                      ? children.cancel(run.id, { kind: "engine", reason: "admission-error", actor: "dag-loop" })
                      : promptSvc.cancel(childSession.id, { reason: childAbort("admission-error", "dag-loop") }),
                  ),
                ),
              ),
            )
          if (terminalized) return
          // The durable row now references this worktree; failures keep it and
          // completion removes it. Before this point no row does, so cleanup
          // must remove it.
          started = true

          const settlementAttempt = {
            replanAttempts: input.node.replanAttempts,
            childSessionID: childSession.id,
          } satisfies NodeExecutionAttempt
          // queued -> running. False means the run was cancelled while the
          // node awaited its permit: fail the attempt, and let the guard
          // reject it when the cancellation's control op already did.
          if (run && !(yield* run.markRunning)) {
            yield* nodeFailure("child run ended before the attempt started", "exec_failed", settlementAttempt)
            return
          }

          // #946: warn when a non-isolated writer overlaps another writer's
          // touched paths without an ordering edge. The durable view computes
          // the same overlap for `workflow status`.
          const warnParallelOverlap = (paths: readonly string[]) =>
            Effect.gen(function* () {
              if (paths.length === 0) return
              const nodes = yield* Effect.suspend(() => dag.store.getCurrentNodes(input.dagID)).pipe(
                Effect.catchCause(() => Effect.succeed([] as DagStore.NodeRow[])),
              )
              const overlaps = DagIsolation.parallelOverlaps(
                nodes.map((candidate) => ({
                  id: candidate.id,
                  touchedPaths: candidate.id === input.nodeID ? paths : (candidate.touchedPaths ?? []),
                  dependsOn: candidate.dependsOn,
                  isolated: candidate.id === input.nodeID ? false : candidate.worktreeState != null,
                })),
              )
              if (overlaps.length === 0) return
              yield* Effect.logWarning(
                `non-isolated DAG writers changed the same paths: ${overlaps
                  .map((overlap) => `${overlap.nodes.join(" <> ")} (${overlap.paths.join(", ")})`)
                  .join("; ")}`,
              )
            })

          // #946: one completion seam. Isolated nodes commit, write a patch
          // under the shared report area, remove their worktree on success and
          // report conflicts; non-isolated nodes record their touched paths.
          const complete = (
            output: unknown,
            attempt: NodeExecutionAttempt,
            capturedOutput?: unknown,
          ): Effect.Effect<void, unknown> =>
            Effect.gen(function* () {
              let touchedPaths: string[] = []
              let metadata = isolatedWorktree
              if (metadata) {
                const completion = yield* completeIsolatedNode({
                  worktree: metadata,
                  ownerDirectory: executionDirectory ?? metadata.directory,
                  projectID: expectedProject ?? workflow?.projectId ?? "global",
                  dagID: input.dagID,
                  nodeID: input.nodeID,
                  message: `dag: ${input.nodeID} (${input.dagID})`,
                  remove: (directory) =>
                    worktreeSvc
                      ? inInstance(executionDirectory, worktreeSvc.remove({ directory }))
                      : Effect.succeed(false),
                })
                if (!completion.ok) {
                  yield* nodeFailure(`worktree completion failed: ${completion.reason}`, "exec_failed", attempt)
                  return
                }
                metadata = completion.worktree
                touchedPaths = completion.touchedPaths
                isolatedWorktree = metadata
                worktreeHandled = true
              } else if (nodeDirectory) {
                touchedPaths = DagIsolation.touchedPaths(nodeDirectory).filter((path) => !initialTouched?.has(path))
                yield* warnParallelOverlap(touchedPaths)
              }
              yield* dag.nodeCompleted(
                input.dagID,
                input.nodeID,
                output,
                attempt,
                capturedOutput,
                metadata,
                touchedPaths,
              )
              // The attempt's run ended with its durable completion; a
              // cancellation that already won the swap keeps its outcome.
              if (run) yield* run.settle({ type: "completed" })
            })

          if (input.outputSchema) registerCaptureSlot(childSession.id, input.outputSchema)

          // The prompt runs WITHOUT a timeout — the deadline watcher owns the
          // timeout path (escalate signal vs exhausted-force-cancel). A timeout
          // never interrupts the child session mid-work; it only notifies the
          // main agent, which adjudicates (extend / cancel / replan).
          const messageService = yield* Effect.serviceOption(DagMessages.Service)
          const workflow = Option.isSome(messageService) ? yield* dag.store.getWorkflow(input.dagID) : undefined
          const caller = workflow?.directory
            ? { projectID: workflow.projectId, directory: childSession.directory, sessionID: childSession.id }
            : undefined
          // Best-effort local fence before another model prompt in the same child
          // session. The durable row is read without the workflow lock, so a
          // concurrent control op can still land between this read and the
          // prompt; settlement attempt guards reject such a stale result. A
          // paused workflow holds the continuation until resume; cancellation,
          // deletion and attempt replacement abandon it without publishing a
          // failure — their owner settles the attempt.
          const awaitContinuationAdmission = Effect.gen(function* () {
            const isCurrent = (candidate: DagStore.NodeRow | undefined) =>
              candidate !== undefined &&
              candidate.status === "running" &&
              candidate.childSessionId === childSession.id &&
              candidate.replanAttempts === settlementAttempt.replanAttempts
            let node = yield* dag.store.getNode(input.dagID, input.nodeID)
            if (!isCurrent(node)) return false
            let currentWorkflow = yield* dag.store.getWorkflow(input.dagID)
            // A paused workflow must not keep a child-run slot while this
            // continuation waits for resume, exactly like a queued spawn. The
            // slot is taken again once the workflow resumes and the attempt is
            // still current; every abandonment path above returns first.
            let releasedForPause = false
            for (;;) {
              const paused = currentWorkflow?.status === "paused"
              const overdue =
                node !== undefined && node.deadlineMs !== null && (yield* Clock.currentTimeMillis) >= node.deadlineMs
              if (!paused && !overdue) break
              if (paused && slot && !releasedForPause) {
                yield* Effect.logWarning(
                  `Workflow ${input.dagID} paused while node ${input.nodeID} waited for continuation admission — releasing its child slot until resume`,
                )
                yield* slot.release
                releasedForPause = true
              }
              yield* Effect.sleep(250)
              currentWorkflow = yield* dag.store.getWorkflow(input.dagID)
              node = yield* dag.store.getNode(input.dagID, input.nodeID)
              if (!isCurrent(node)) return false
              if (!currentWorkflow || !["running", "stepping", "paused"].includes(currentWorkflow.status)) return false
            }
            if (releasedForPause) {
              slot = yield* scheduler.childSlot(schedule.limit, schedule.cap, {
                rootSessionID: input.parentSessionID,
              })
            }
            return !!currentWorkflow && ["running", "stepping"].includes(currentWorkflow.status)
          })
          const claimResubmission = Effect.gen(function* () {
            if (Option.isNone(messageService) || !caller) return true
            const revision = yield* messageService.value.revisions(caller)
            const claim = revision.ok
              ? yield* messageService.value.claimResultNudge(caller, revision.value.accepted)
              : revision
            if (claim.ok && claim.value) return true
            if (!claim.ok && claim.reason === "stale_input")
              return yield* new Dag.StaleMessageInputError({
                dagID: input.dagID,
                nodeID: input.nodeID,
                reason: claim.reason,
              })
            yield* nodeFailure(
              `structured result resubmission was not admitted: ${claim.ok ? "resubmission already requested" : claim.reason}`,
              "exec_failed",
              {
                ...settlementAttempt,
                ...(claim.ok && revision.ok ? { expectedAcceptedRevision: revision.value.accepted } : {}),
              },
            )
            return false
          })
          if (hooks?.registerScoped && agent.hooks !== undefined)
            yield* hooks.registerScoped(childSession.id, {
              kind: "agent",
              origin: hookOrigin,
              source: agent.hookSource,
              hooks: agent.hooks,
              child: true,
            })
          // The clean Stop of this child is the DAG's to deliver after the
          // attempt settles; `ChildRegistry.delegateStop` sees the active
          // dag_node run registered above.
          const hookAttempt = DagMessages.nodeAttemptID(childSession.id, settlementAttempt.replanAttempts)
          if (hooks && (!hookLifecycle || (yield* hookLifecycle.claimChildStart(childSession.id, hookAttempt)))) {
            const started = yield* hooks.trigger(
              { event: "SubagentStart", agentID: childSession.id, agentType: agent.name },
              { sessionID: parent.id },
            )
            yield* SettingsHook.landSystemMessages(started, { sessionID: childSession.id })
            if (hookStart) for (const text of started.additionalContexts) yield* hookStart.append(childSession.id, text)
          }
          const reportDirective = yield* reportAreaDirective(expectedProject ?? workflow?.projectId)
          const parts: PromptParts = reportDirective
            ? [...input.promptParts, { type: "text", text: reportDirective }]
            : input.promptParts
          // #949: the child must be able to tell where it runs and which HEAD
          // it started from. Only the DAG path injects this; the shared
          // environment prompt keeps its existing content.
          const executionContext = dagExecutionContext(nodeDirectory, baseHead, targetFingerprint)
          // Every prompt to the child goes through its run: it is admitted as
          // the delegation it is, under the run's credential.
          let result = yield* nodeExecution(
            children.prompt({
              messageID: MessageID.ascending(),
              sessionID: childSession.id,
              model,
              agent: agent.name,
              ...(executionContext ? { system: executionContext } : {}),
              ...(input.variant ? { variant: input.variant } : {}),
              parts,
            }),
          )
          // A stale-input continuation is still the same live attempt.
          // The finalizer is installed before settlement can publish a terminal
          // event: NodeFailed consumers interrupt this execution fiber. It runs
          // after durable settlement even on that interruption, while scoped hooks
          // and transcripts remain available. Notification feedback cannot reopen
          // a settled node; foreground task-tool Stop continuations are unchanged.
          // Hook runners retain their configured timeouts inside this finalizer.
          const notifyStop = Effect.gen(function* () {
            if (!hooks) return
            const terminal = yield* dag.store.getNode(input.dagID, input.nodeID)
            if (
              result.info.role === "assistant" &&
              !result.info.error &&
              terminal?.childSessionId === childSession.id &&
              !terminal.superseded &&
              terminal.replanAttempts === settlementAttempt.replanAttempts &&
              ["completed", "failed"].includes(terminal.status) &&
              (!hookLifecycle || (yield* hookLifecycle.claimChildStop(childSession.id, hookAttempt)))
            ) {
              if (hooks.registerScoped && agent.hooks !== undefined)
                yield* hooks.registerScoped(childSession.id, {
                  kind: "agent",
                  origin: hookOrigin,
                  source: agent.hookSource,
                  hooks: agent.hooks,
                  child: true,
                })
              const messages = yield* sessions.messages({ sessionID: childSession.id }).pipe(Effect.orDie)
              const backgroundJobs = yield* Effect.serviceOption(BackgroundJob.Service)
              const stopped: TriggerResult = yield* hooks
                .trigger(
                  {
                    event: "SubagentStop",
                    stopHookActive: false,
                    agentID: childSession.id,
                    agentType: agent.name,
                    lastAssistantMessage:
                      result.parts
                        .filter((p) => p.type === "text")
                        .map((p) => p.text)
                        .join("") || undefined,
                    backgroundTasks: Option.isSome(backgroundJobs)
                      ? yield* HookTurnContext.backgroundTasks(parent.id, {
                          jobs: backgroundJobs.value,
                          workflows: dag.store,
                        })
                      : [],
                    sessionCrons: [],
                  },
                  { sessionID: parent.id },
                )
                .pipe(Effect.catch(() => Effect.succeed({ additionalContexts: [], systemMessages: [] })))
              yield* SettingsHook.landSystemMessages(
                {
                  ...stopped,
                  systemMessages: [
                    ...new Set([
                      ...stopped.systemMessages,
                      ...(stopped.blocked?.reason ? [stopped.blocked.reason] : []),
                      ...(stopped.stopReason ? [stopped.stopReason] : []),
                    ]),
                  ],
                },
                { sessionID: childSession.id },
              )
              const user = messages.findLast((message) => message.info.role === "user")
              if (user)
                for (const text of stopped.additionalContexts)
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: user.info.id,
                    sessionID: childSession.id,
                    type: "text",
                    text,
                    synthetic: true,
                  })
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("DAG Stop notification failed after settlement", { cause }),
            ),
          )
          yield* Effect.gen(function* () {
            // Issue #888: one bounded same-session length continuation per attempt. A later
            // loop iteration (stale-input or resubmission continuation) must not re-arm it.
            let continuedFromLength = false
            for (;;) {
              let inputSnapshot =
                Option.isSome(messageService) && caller
                  ? yield* messageService.value.snapshotForTurn(caller, result.info.id)
                  : undefined
              let snapshotID = inputSnapshot?.ok ? inputSnapshot.value?.id : undefined
              const settled = yield* Effect.gen(function* () {
                if (result.info.role !== "assistant") {
                  yield* nodeFailure(
                    "child model turn stopped before a successful result",
                    "exec_failed",
                    settlementAttempt,
                  )
                  return
                }
                if (result.info.error) {
                  yield* nodeFailure(
                    childFailureReason("child model turn stopped before a successful result", result.info.error),
                    "exec_failed",
                    settlementAttempt,
                  )
                  return
                }
                if (result.info.finish === "length" && !continuedFromLength) {
                  if (!(yield* awaitContinuationAdmission)) return
                  result = yield* nodeExecution(
                    children.prompt(
                      {
                        messageID: MessageID.ascending(),
                        sessionID: childSession.id,
                        model,
                        agent: agent.name,
                        ...(input.variant ? { variant: input.variant } : {}),
                        parts: [
                          {
                            type: "text",
                            text: "Your previous turn hit the output token limit. Do not redo the work; finish and emit only the final response now.",
                          },
                        ],
                      },
                      { continueToolBudget: true },
                    ),
                  )
                  continuedFromLength = true
                  if (Option.isSome(messageService) && caller) {
                    inputSnapshot = yield* messageService.value.snapshotForTurn(caller, result.info.id)
                    snapshotID = inputSnapshot?.ok ? inputSnapshot.value?.id : undefined
                  }
                  if (result.info.role !== "assistant") {
                    yield* nodeFailure(
                      "child model turn stopped before a successful result",
                      "exec_failed",
                      settlementAttempt,
                    )
                    return
                  }
                  if (result.info.error) {
                    yield* nodeFailure(
                      childFailureReason("child model turn stopped before a successful result", result.info.error),
                      "exec_failed",
                      settlementAttempt,
                    )
                    return
                  }
                }
                const lengthReason = Effect.gen(function* () {
                  return outputLimitReason({
                    cap: yield* resolveOutputCap,
                    output: result.info.role === "assistant" ? result.info.tokens.output : 0,
                    reasoning: result.info.role === "assistant" ? result.info.tokens.reasoning : 0,
                    continued: continuedFromLength,
                  })
                })
                if (input.outputSchema) {
                  if (Option.isSome(messageService) && caller && !snapshotID)
                    yield* new Dag.StaleMessageInputError({
                      dagID: input.dagID,
                      nodeID: input.nodeID,
                      reason: "unassociated",
                    })
                  let captured = yield* captureFinalResponse({
                    store: dag.store,
                    sessionID: childSession.id,
                    message: result,
                    snapshotID,
                    caller,
                    guard: {
                      workflowID: input.dagID,
                      nodeID: input.nodeID,
                      attemptID: DagMessages.nodeAttemptID(childSession.id, settlementAttempt.replanAttempts),
                    },
                  })
                  const lengthLimited = result.info.role === "assistant" && result.info.finish === "length"
                  // A near-miss on a present field gets one bounded correction
                  // turn in the same attempt. Structural failures (unparseable,
                  // missing fields, wrong root type) keep failing immediately.
                  if (!captured.ok && captured.fix && !lengthLimited) {
                    if (!(yield* claimResubmission)) return
                    const repair = captured.fix
                    result = yield* nodeExecution(
                      children.prompt(
                        {
                          messageID: MessageID.ascending(),
                          sessionID: childSession.id,
                          model,
                          agent: agent.name,
                          ...(input.variant ? { variant: input.variant } : {}),
                          parts: [{ type: "text", text: repairPrompt(repair) }],
                        },
                        { continueToolBudget: true },
                      ),
                    )
                    if (Option.isSome(messageService) && caller) {
                      inputSnapshot = yield* messageService.value.snapshotForTurn(caller, result.info.id)
                      snapshotID = inputSnapshot?.ok ? inputSnapshot.value?.id : undefined
                      if (!snapshotID)
                        yield* new Dag.StaleMessageInputError({
                          dagID: input.dagID,
                          nodeID: input.nodeID,
                          reason: "unassociated",
                        })
                    }
                    captured = yield* captureFinalResponse({
                      store: dag.store,
                      sessionID: childSession.id,
                      message: result,
                      snapshotID,
                      caller,
                      guard: {
                        workflowID: input.dagID,
                        nodeID: input.nodeID,
                        attemptID: DagMessages.nodeAttemptID(childSession.id, settlementAttempt.replanAttempts),
                      },
                    })
                  }
                  if (!captured.ok && (captured.code === "stale_input" || captured.code === "unassociated"))
                    yield* new Dag.StaleMessageInputError({
                      dagID: input.dagID,
                      nodeID: input.nodeID,
                      reason: captured.code,
                    })
                  const settlement = captured.ok
                    ? settleCapturedOutput(
                        captured.output,
                        input.reviewImplementationFingerprint,
                        "",
                        true,
                        input.verdictEvidence,
                      )
                    : ({
                        kind: "fail",
                        reason: lengthLimited ? yield* lengthReason : captured.reason,
                      } as const)
                  // A captured-but-invalid payload is a schema failure, not a
                  // genuine REJECT/FAIL verdict. The length cap keeps its own
                  // existing classification.
                  const schemaInvalid = !captured.ok && captured.schemaInvalid === true && !lengthLimited
                  yield* (
                    settlement.kind === "complete"
                      ? complete(settlement.output, {
                          ...settlementAttempt,
                          inputSnapshotID: snapshotID,
                        })
                      : nodeFailure(
                          settlement.reason,
                          "verdict_fail",
                          {
                            ...settlementAttempt,
                            inputSnapshotID: snapshotID,
                          },
                          schemaInvalid ? "schema_invalid" : undefined,
                        )
                  ).pipe(
                    Effect.catchIf(isTransitionRejection, () =>
                      Effect.logWarning("final-response settlement guard rejected — node already terminal"),
                    ),
                  )
                } else {
                  const final = finalAssistantText(result, true)
                  const settlement = settlePlainTextOutput(final.ok ? final.text : undefined)
                  if (settlement.kind === "fail") {
                    yield* nodeFailure(
                      result.info.finish === "length" ? yield* lengthReason : settlement.reason,
                      "verdict_fail",
                      {
                        ...settlementAttempt,
                        inputSnapshotID: snapshotID,
                      },
                    ).pipe(
                      Effect.catchIf(isTransitionRejection, () =>
                        Effect.logWarning("nodeFailed (empty output) guard rejected — node already terminal"),
                      ),
                    )
                    return
                  }
                  const rawText = settlement.output
                  const fileRef = yield* commitOutputFileRef(
                    rawText,
                    {
                      workflow_id: input.dagID,
                      node_id: input.nodeID,
                      child_session_id: childSession.id,
                      replan_attempt: settlementAttempt.replanAttempts,
                      graph_rev: input.graphRev,
                    },
                    (source, symlink, canonical) =>
                      makeArtifactSourceAuthorizer(sessions, agentService, worktree, permissionSvc, boundary)(
                        childSession.id,
                        source,
                        agent.name,
                        symlink,
                        canonical,
                      ),
                  )
                  if (fileRef && childSessionID) {
                    // Receipt persistence precedes completion. A crash between the
                    // two writes is recovered from this receipt, never the source.
                    const capture = dag.store.setCapturedOutput(childSessionID, fileRef, snapshotID)
                    if (Option.isSome(messageService) && caller) {
                      const receipt = yield* messageService.value.guard(
                        caller,
                        {
                          workflowID: input.dagID,
                          nodeID: input.nodeID,
                          attemptID: DagMessages.nodeAttemptID(childSession.id, settlementAttempt.replanAttempts),
                          snapshotID,
                          close: false,
                        },
                        capture,
                      )
                      if (!receipt.ok) {
                        if (receipt.reason === "stale_input" || receipt.reason === "unassociated")
                          yield* new Dag.StaleMessageInputError({
                            dagID: input.dagID,
                            nodeID: input.nodeID,
                            reason: receipt.reason,
                          })
                        return
                      }
                    } else yield* capture
                  }
                  yield* complete(
                    fileRef?.path ?? rawText,
                    { ...settlementAttempt, inputSnapshotID: snapshotID },
                    fileRef,
                  ).pipe(
                    Effect.catchIf(isTransitionRejection, () =>
                      Effect.logWarning("nodeCompleted guard rejected — node already terminal"),
                    ),
                  )
                }
              }).pipe(
                Effect.as(true),
                Effect.catchIf(isStaleMessageInput, () => Effect.succeed(false)),
              )
              if (settled) break
              // Re-enter the same session using its persisted transcript. Completed tools are
              // retained, and only newly accepted input is added at the model boundary.
              if (inputSnapshot?.ok && inputSnapshot.value?.stopReason) {
                yield* nodeFailure(
                  `message continuation blocked: ${inputSnapshot.value.stopReason}`,
                  "exec_failed",
                  settlementAttempt,
                )
                break
              }
              if (input.outputSchema) registerCaptureSlot(childSession.id, input.outputSchema)
              if (!(yield* awaitContinuationAdmission)) break
              const revisions =
                Option.isSome(messageService) && caller ? yield* messageService.value.revisions(caller) : undefined
              if (revisions?.ok && revisions.value.queued === 0 && revisions.value.undeliverable > 0) {
                yield* nodeFailure(
                  "new agent input is unavailable; continuation was not admitted",
                  "exec_failed",
                  settlementAttempt,
                )
                break
              }
              result = yield* nodeExecution(promptSvc.loop({ sessionID: childSession.id }, { kind: "child_run" }))
            }
          }).pipe(
            Effect.ensuring(notifyStop),
            // A control op that abandons the attempt (replan, pause-replace,
            // deletion) breaks the continuation loop without a durable
            // settlement; the run must not stay active for the next adopt.
            Effect.ensuring(
              Effect.suspend(() =>
                run === undefined ? Effect.void : run.settle({ type: "interrupted", reason: "attempt-abandoned" }),
              ),
            ),
          )
        }).pipe(Effect.ensuring(Effect.suspend(() => (slot ? slot.release : Effect.void))))
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            // The prompt finished (or this fiber was interrupted) — the
            // deadline watcher has no further job.
            yield* Fiber.interrupt(watcherFiber).pipe(Effect.ignore)
            if (childSessionID) {
              clearCaptureSlot(childSessionID)
              if (hooks?.unregisterScoped) yield* hooks.unregisterScoped(childSessionID, hookOrigin)
            }
            // #946: a worktree whose NodeStarted never published has no
            // durable row and must not leak — including the terminalized
            // admission return above, which has a child session but no row.
            // Once NodeStarted published, failure keeps the worktree for
            // inspection and the catchCause below records it as kept.
            if (isolatedWorktree && !worktreeHandled && !started && worktreeSvc) {
              const directory = isolatedWorktree.directory
              const removed = yield* inInstance(executionDirectory, worktreeSvc.remove({ directory })).pipe(
                Effect.result,
                Effect.catchCause((cause) =>
                  Cause.hasInterrupts(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning("failed to remove an unsettled DAG worktree", {
                        dagID: input.dagID,
                        nodeID: input.nodeID,
                        directory,
                        cause,
                      }).pipe(Effect.as({ _tag: "Failure" as const })),
                ),
              )
              if (removed._tag === "Success" && removed.success) isolatedWorktree = undefined
            }
          }),
        ),
        // The fiber can be interrupted between session creation and node
        // settlement (replan cancel/restart, workflow-terminal cleanup). In
        // the pre-NodeStarted window the durable row does not reference the
        // session yet, so the caller's abortChild cannot reach it — cancel
        // the child here.
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            yield* Logging.backgroundDebug("lifecycle.dag.execution.interrupted", {
              source: "dag.spawn.onInterrupt",
              workflowID: input.dagID,
              nodeID: input.nodeID,
              replanAttempts: input.node.replanAttempts,
              childSessionID,
            })
            if (childSessionID) {
              // Cancel the run first (it ends cancelled and its session turn
              // is cancelled in the background); a session whose run this
              // process no longer holds still gets the turn cancellation.
              const cancelled = yield* childRuns.cancelActive(SessionID.make(childSessionID), {
                kind: "engine",
                reason: "runtime-interrupt",
                actor: "runtime-scope",
              })
              if (cancelled === "not_active")
                yield* promptSvc.cancel(SessionID.make(childSessionID), {
                  reason: childAbort("runtime-interrupt", "runtime-scope"),
                })
            }
            // A started attempt keeps its worktree for inspection; a
            // pre-NodeStarted attempt was already removed by the ensuring
            // cleanup above.
            if (started && isolatedWorktree) worktreeHandled = true
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.hasInterrupts(cause)) return
            if (run) yield* run.settle({ type: "error", message: Cause.pretty(cause) })
            const attempt = childSessionID
              ? { replanAttempts: input.node.replanAttempts, childSessionID }
              : executionAttempt
            if (isolatedWorktree) {
              worktreeHandled = true
              isolatedWorktree = { ...isolatedWorktree, state: "kept" }
            }
            yield* dag
              .nodeFailed(
                input.dagID,
                input.nodeID,
                Cause.pretty(cause),
                "exec_failed",
                attempt,
                undefined,
                isolatedWorktree,
              )
              .pipe(
                Effect.catchIf(isTransitionRejection, () =>
                  Effect.logWarning("nodeFailed guard rejected — node already terminal"),
                ),
              )
          }),
        ),
      ),
    )

    return { fiber, watcherFiber }
  })
}
