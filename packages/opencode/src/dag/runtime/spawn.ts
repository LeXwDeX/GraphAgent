// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

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

import { HookLifecycle } from "@/hook/lifecycle"
import { SettingsHook } from "@/hook/settings"
import { HookTranscript } from "@/hook/transcript"
import { HookStartContext } from "@/hook/start-context"
import { Logging } from "@opencode-ai/core/observability/logging"
import { Effect, Semaphore, Scope, Fiber, Option, Clock, Cause, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "@/session/schema"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { SessionPrompt } from "@/session/prompt"
import { Dag, type NodeExecutionAttempt, isStaleMessageInput } from "../dag"
import type { ResultProtocol } from "../dag"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { DagModel } from "../model"
import { DagLocation } from "../location"
import { childFailureReason } from "./child-failure-reason"
import { InstanceRef } from "@/effect/instance-ref"
import { isTransitionRejection, isNodeTerminalStatus } from "@opencode-ai/core/dag/core/types"
import type { DagStore } from "@opencode-ai/core/dag/store"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import {
  registerCaptureSlot,
  clearCaptureSlot,
  registerFinalResponseSession,
  clearFinalResponseSession,
  settleCapturedOutput,
  settlePlainTextOutput,
} from "./capture"
import { captureFinalResponse, finalAssistantText } from "./final-response"
import {
  commitOutputFileRef,
  ensureReportAreaGitignore,
  verifyOutputFileRef,
  type ManagedOutputFileRef,
} from "./output-ref"
import { artifactReadPermissions, makeArtifactSourceAuthorizer } from "./artifact-permissions"
import { Permission } from "@/permission"

type PromptParts = SessionPrompt.PromptInput["parts"]

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
  /** Workflow execution directory — keys the report-area gitignore guarantee (Train B, B4). */
  directory?: string
  /** Verified completed dependency artifacts, scoped to this child session. */
  inputArtifacts?: ManagedOutputFileRef[]
  outputSchema?: Record<string, unknown>
  /** Missing means the persisted submit_result protocol for direct legacy callers. */
  resultProtocol?: ResultProtocol
  timeoutMs?: number
  reportToParent?: boolean
  reviewImplementationFingerprint?: string
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
        const attempt = {
          replanAttempts: node.replanAttempts,
          ...(node.childSessionId ? { childSessionID: node.childSessionId } : {}),
        }
        const outcome = yield* dag
          .nodeFailed(
            input.dagID,
            input.nodeID,
            `timeout extensions exhausted (${extensions}/${maxExtensions})`,
            "timeout",
            attempt,
          )
          .pipe(
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
          if (node.childSessionId) yield* promptSvc.cancel(node.childSessionId as never).pipe(Effect.ignore)
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
  semaphore: Semaphore.Semaphore,
  input: NodeSpawnInput,
): Effect.Effect<
  NodeSpawnResult,
  Error,
  Dag.Service | Agent.Service | Session.Service | SessionPrompt.Service | Scope.Scope
> {
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const agentService = yield* Agent.Service
    const sessions = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
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

    const childPermission = [
      ...deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: agent,
      }),
    ]
    const instance = yield* Effect.serviceOption(InstanceRef)
    const worktree =
      (Option.isSome(instance) ? instance.value?.worktree : undefined) ?? input.directory ?? process.cwd()
    if (input.inputArtifacts?.length) {
      if (worktree)
        childPermission.push(
          ...artifactReadPermissions(input.inputArtifacts, worktree, agent.permission, childPermission),
        )
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
        // doesn't wait unbounded in the semaphore queue. If the deadline
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
        // Race permit acquisition against the remaining queue budget
        const permitAcquired = yield* Effect.gen(function* () {
          yield* semaphore.take(1)
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
              `Workflow ${input.dagID} paused while node ${input.nodeID} was queued — holding spawn until resume`,
            )
            while ((yield* readPauseStatus) === "paused") {
              yield* Effect.sleep(250)
            }
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
          // A permit or pause wait may outlive the scheduling-round check.
          // Validate again before the child can consume or read its inputs.
          yield* Effect.forEach(input.inputArtifacts ?? [], verifyOutputFileRef, { discard: true })
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
          })
          childSessionID = childSession.id as string

          // A concurrent replan(cancel/restart) may have terminalized the node
          // while it waited for the permit. nodeStarted's guard rejects; cancel
          // the just-created child session and stop — the winning control op is
          // the sole terminalization, no spurious NodeFailed.
          const terminalized = yield* dag
            .nodeStarted(input.dagID, input.nodeID, childSession.id, deadlineMs, input.reportToParent, executionAttempt)
            .pipe(
              Effect.map(() => false),
              Effect.catchIf(isTransitionRejection, () =>
                Effect.gen(function* () {
                  yield* promptSvc.cancel(childSession.id).pipe(Effect.catch(() => Effect.void))
                  yield* Effect.logWarning(
                    `Node ${input.nodeID} was terminalized during queue wait — child session cancelled, no spurious failure published`,
                  )
                  return true
                }),
              ),
              Effect.onError(() => promptSvc.cancel(childSession.id).pipe(Effect.ignore)),
            )
          if (terminalized) return

          const settlementAttempt = {
            replanAttempts: input.node.replanAttempts,
            childSessionID: childSession.id,
          } satisfies NodeExecutionAttempt

          if (input.resultProtocol === "final_response") registerFinalResponseSession(childSession.id)
          if (input.outputSchema) registerCaptureSlot(childSession.id, input.outputSchema)

          // The prompt runs WITHOUT a timeout — the deadline watcher owns the
          // timeout path (escalate signal vs exhausted-force-cancel). A timeout
          // never interrupts the child session mid-work; it only notifies the
          // main agent, which adjudicates (extend / cancel / replan).
          const messageService = yield* Effect.serviceOption(DagMessages.Service)
          const workflow = Option.isSome(messageService) ? yield* dag.store.getWorkflow(input.dagID) : undefined
          const caller = workflow?.directory
            ? { projectID: workflow.projectId, directory: workflow.directory, sessionID: childSession.id }
            : undefined
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
            yield* dag.nodeFailed(
              input.dagID,
              input.nodeID,
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
          const hookAttempt = DagMessages.nodeAttemptID(childSession.id, settlementAttempt.replanAttempts)
          if (hooks && (!hookLifecycle || (yield* hookLifecycle.claimChildStart(childSession.id, hookAttempt)))) {
            const transcriptPath = yield* HookTranscript.materialize({
              sessionID: parent.id,
              directory: parent.directory,
              messages: yield* sessions.messages({ sessionID: parent.id }).pipe(Effect.orDie),
            }).pipe(Effect.orDie)
            const started = yield* hooks.trigger(
              { event: "SubagentStart", agentID: childSession.id, agentType: agent.name },
              { sessionID: parent.id, transcriptPath },
            )
            yield* SettingsHook.landSystemMessages(started, { sessionID: parent.id })
            if (hookStart) for (const text of started.additionalContexts) yield* hookStart.append(childSession.id, text)
          }
          let result = yield* promptSvc.prompt(
            {
              messageID: MessageID.ascending(),
              sessionID: childSession.id,
              model,
              agent: agent.name,
              ...(input.variant ? { variant: input.variant } : {}),
              parts: input.promptParts,
            },
            { internalDelegation: true },
          )
          for (;;) {
            let inputSnapshot =
              Option.isSome(messageService) && caller
                ? yield* messageService.value.snapshotForTurn(caller, result.info.id)
                : undefined
            const snapshotID = inputSnapshot?.ok ? inputSnapshot.value?.id : undefined
            const settled = yield* Effect.gen(function* () {
              if (result.info.role !== "assistant") {
                yield* dag.nodeFailed(
                  input.dagID,
                  input.nodeID,
                  "child model turn stopped before a successful result",
                  "exec_failed",
                  settlementAttempt,
                )
                return
              }
              if (result.info.error) {
                yield* dag.nodeFailed(
                  input.dagID,
                  input.nodeID,
                  childFailureReason("child model turn stopped before a successful result", result.info.error),
                  "exec_failed",
                  settlementAttempt,
                )
                return
              }
              if (input.outputSchema && input.resultProtocol === "final_response") {
                if (Option.isSome(messageService) && caller && !snapshotID)
                  yield* new Dag.StaleMessageInputError({
                    dagID: input.dagID,
                    nodeID: input.nodeID,
                    reason: "unassociated",
                  })
                const captured = yield* captureFinalResponse({
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
                if (!captured.ok && (captured.code === "stale_input" || captured.code === "unassociated"))
                  yield* new Dag.StaleMessageInputError({
                    dagID: input.dagID,
                    nodeID: input.nodeID,
                    reason: captured.code,
                  })
                const settlement = captured.ok
                  ? settleCapturedOutput(captured.output, input.reviewImplementationFingerprint, "", true)
                  : ({ kind: "fail", reason: captured.reason } as const)
                yield* (
                  settlement.kind === "complete"
                    ? dag.nodeCompleted(input.dagID, input.nodeID, settlement.output, {
                        ...settlementAttempt,
                        inputSnapshotID: snapshotID,
                      })
                    : dag.nodeFailed(input.dagID, input.nodeID, settlement.reason, "verdict_fail", {
                        ...settlementAttempt,
                        inputSnapshotID: snapshotID,
                      })
                ).pipe(
                  Effect.catchIf(isTransitionRejection, () =>
                    Effect.logWarning("final-response settlement guard rejected — node already terminal"),
                  ),
                )
              } else if (input.outputSchema) {
                const readSettlement = Effect.fn("DagRuntime.spawn.readSettlement")(function* () {
                  const updatedNode = yield* dag.store.getNode(input.dagID, input.nodeID).pipe(Effect.orDie)
                  if (
                    !updatedNode ||
                    updatedNode.replanAttempts !== settlementAttempt.replanAttempts ||
                    updatedNode.childSessionId !== settlementAttempt.childSessionID
                  )
                    return undefined
                  const captured = updatedNode?.capturedOutput
                  return {
                    neverCalled: !(updatedNode.capturedOutputPresent ?? (captured !== undefined && captured !== null)),
                    snapshotID: updatedNode.capturedSnapshotID ?? undefined,
                    // Single settlement authority shared with crash recovery
                    // (capture.ts settleCapturedOutput).
                    settlement: settleCapturedOutput(
                      captured,
                      input.reviewImplementationFingerprint,
                      "",
                      updatedNode.capturedOutputPresent,
                    ),
                  }
                })
                clearCaptureSlot(childSession.id)
                let verdict = yield* readSettlement()
                if (!verdict) return
                // Issue #436 minimal step: a child that ended its whole turn
                // without ever calling submit_result gets exactly one nudge
                // turn in the same session — the work is already done, only the
                // structured hand-back is missing. A captured-but-invalid payload
                // is NOT nudged: that is a deterministic contract violation and
                // a retry would only re-bill the same mistake.
                if (verdict.settlement.kind === "fail" && verdict.neverCalled) {
                  if (!(yield* claimResubmission)) return
                  registerCaptureSlot(childSession.id, input.outputSchema)
                  result = yield* promptSvc.prompt(
                    {
                      messageID: MessageID.ascending(),
                      sessionID: childSession.id,
                      model,
                      agent: agent.name,
                      ...(input.variant ? { variant: input.variant } : {}),
                      parts: [
                        {
                          type: "text",
                          text: `You ended your turn without calling the submit_result tool, so this node recorded no structured output. Do not redo the work. If tools remain available, call submit_result with your full result matching the schema from your instructions. This follow-up retains your existing tool-call budget. If tools are disabled because that budget is exhausted, report the blocker in text; the node cannot succeed without a submitted result.`,
                        },
                      ],
                    },
                    { continueToolBudget: true, internalDelegation: true },
                  )
                  inputSnapshot =
                    Option.isSome(messageService) && caller
                      ? yield* messageService.value.snapshotForTurn(caller, result.info.id)
                      : undefined
                  clearCaptureSlot(childSession.id)
                  verdict = yield* readSettlement()
                  if (!verdict) return
                }
                const settlement = verdict.settlement
                yield* (
                  settlement.kind === "complete"
                    ? dag.nodeCompleted(input.dagID, input.nodeID, settlement.output, {
                        ...settlementAttempt,
                        inputSnapshotID: verdict.snapshotID,
                      })
                    : dag.nodeFailed(input.dagID, input.nodeID, settlement.reason, "verdict_fail", settlementAttempt)
                ).pipe(
                  Effect.catchIf(isTransitionRejection, () =>
                    Effect.logWarning(
                      `${settlement.kind === "complete" ? "nodeCompleted" : "nodeFailed (verdict_fail)"} guard rejected — node already terminal`,
                    ),
                  ),
                )
              } else {
                const final = finalAssistantText(result, true)
                const settlement = settlePlainTextOutput(final.ok ? final.text : undefined)
                if (settlement.kind === "fail") {
                  yield* dag
                    .nodeFailed(input.dagID, input.nodeID, settlement.reason, "verdict_fail", {
                      ...settlementAttempt,
                      ...(input.resultProtocol === "final_response" ? { inputSnapshotID: snapshotID } : {}),
                    })
                    .pipe(
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
                  (source) =>
                    makeArtifactSourceAuthorizer(
                      sessions,
                      agentService,
                      worktree,
                      permissionSvc,
                    )(childSession.id, source, agent.name),
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
                  if (input.directory) yield* ensureReportAreaGitignore(input.directory, fileRef.source_path)
                }
                yield* dag
                  .nodeCompleted(
                    input.dagID,
                    input.nodeID,
                    fileRef?.path ?? rawText,
                    { ...settlementAttempt, inputSnapshotID: snapshotID },
                    fileRef,
                  )
                  .pipe(
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
              yield* dag.nodeFailed(
                input.dagID,
                input.nodeID,
                `message continuation blocked: ${inputSnapshot.value.stopReason}`,
                "exec_failed",
                settlementAttempt,
              )
              break
            }
            if (input.outputSchema) registerCaptureSlot(childSession.id, input.outputSchema)
            let current = yield* dag.store.getNode(input.dagID, input.nodeID)
            if (
              !current ||
              current.status !== "running" ||
              current.childSessionId !== childSession.id ||
              current.replanAttempts !== settlementAttempt.replanAttempts
            )
              break
            let currentWorkflow = yield* dag.store.getWorkflow(input.dagID)
            while (
              currentWorkflow?.status === "paused" ||
              (current.deadlineMs !== null && (yield* Clock.currentTimeMillis) >= current.deadlineMs)
            ) {
              yield* Effect.sleep(250)
              currentWorkflow = yield* dag.store.getWorkflow(input.dagID)
              current = yield* dag.store.getNode(input.dagID, input.nodeID)
              if (
                !current ||
                current.status !== "running" ||
                current.childSessionId !== childSession.id ||
                current.replanAttempts !== settlementAttempt.replanAttempts
              )
                return
              if (!currentWorkflow || !["running", "stepping", "paused"].includes(currentWorkflow.status)) return
            }
            if (!currentWorkflow || !["running", "stepping"].includes(currentWorkflow.status)) break
            const revisions =
              Option.isSome(messageService) && caller ? yield* messageService.value.revisions(caller) : undefined
            if (revisions?.ok && revisions.value.queued === 0 && revisions.value.undeliverable > 0) {
              yield* dag.nodeFailed(
                input.dagID,
                input.nodeID,
                "new agent input is unavailable; continuation was not admitted",
                "exec_failed",
                settlementAttempt,
              )
              break
            }
            let nudge = !!(
              input.outputSchema &&
              input.resultProtocol !== "final_response" &&
              revisions?.ok &&
              revisions.value.queued === 0
            )
            if (nudge) {
              const admitted = yield* claimResubmission.pipe(
                Effect.catchIf(isStaleMessageInput, () => Effect.succeed(undefined)),
              )
              if (admitted === false) break
              nudge = admitted === true
            }
            result = nudge
              ? yield* promptSvc.prompt(
                  {
                    messageID: MessageID.ascending(),
                    sessionID: childSession.id,
                    model,
                    agent: agent.name,
                    ...(input.variant ? { variant: input.variant } : {}),
                    parts: [
                      {
                        type: "text",
                        text: "Runtime continuation: the earlier structured result belongs to an older input snapshot. Review the recorded agent messages and submit an updated result. Keep completed tool evidence and do not repeat completed writes.",
                      },
                    ],
                  },
                  { internalDelegation: true },
                )
              : yield* promptSvc.loop({ sessionID: childSession.id })
          }
        }).pipe(Effect.ensuring(semaphore.release(1)))
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            // The prompt finished (or this fiber was interrupted) — the
            // deadline watcher has no further job.
            yield* Fiber.interrupt(watcherFiber).pipe(Effect.ignore)
            if (childSessionID) {
              clearCaptureSlot(childSessionID)
              clearFinalResponseSession(childSessionID)
              if (hooks?.unregisterScoped) yield* hooks.unregisterScoped(childSessionID, hookOrigin)
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
            if (childSessionID) yield* promptSvc.cancel(SessionID.make(childSessionID)).pipe(Effect.ignore)
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.hasInterrupts(cause)) return
            const attempt = childSessionID
              ? { replanAttempts: input.node.replanAttempts, childSessionID }
              : executionAttempt
            yield* dag
              .nodeFailed(input.dagID, input.nodeID, Cause.pretty(cause), "exec_failed", attempt)
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
