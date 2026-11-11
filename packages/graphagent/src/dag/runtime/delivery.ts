// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagDelivery from "./delivery"

import { Cause, Clock, Effect, Option, Schema, Stream } from "effect"
import type { Context, Scope, Semaphore } from "effect"
import type { WorkflowRuntime } from "@graphagent/core/dag/core/scheduling"
import {
  ERROR_CLASS_BUDGET_EXHAUSTED,
  ERROR_CLASS_CANCELLED,
  displayState,
  isNodeTerminalStatus,
  isTerminalWorkflowStatusValue,
  isWorkflowTerminalStatus,
} from "@graphagent/core/dag/core/types"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagStore } from "@graphagent/core/dag/store"
import { Database } from "@graphagent/core/database/database"
import { Hash } from "@graphagent/core/util/hash"
import type { SessionV1 } from "@graphagent/core/v1/session"
import type { EventV2Bridge } from "@/event-v2-bridge"
import { SessionCancellation } from "@/session/cancellation"
import { SessionInbox } from "@/session/inbox"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { ExclusiveRegistry } from "@/session/engine-process"
import * as MessageV2 from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Dag, parseWorkflowConfig } from "../dag"
import { DagLocation } from "../location"
import { deliverReport, reportingCheckpoints, selectReportNode } from "./report-delivery"

const parseJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export const PAUSED_REMINDER_DELAY_MS = 5 * 60_000

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

function completionReportReference(workflow: DagStore.WorkflowRow) {
  return `[DAG Final Report] The final report for workflow "${workflow.title}" was delivered to the parent transcript before this turn (workflow_id="${workflow.id}", completion_seq=${workflow.seq}). Continue the plan from it: if it names bounded remaining work, act with the workflow tool (control replan / extend, or control extend_timeout for a running escalation); otherwise stop without restating the report.`
}

/** The runtime state the delivery boundary reads. The owning DagLoop passes a
 * live lookup so a workflow adopted or dropped after the delivery instance is
 * created is always judged from the current in-memory runtime. */
export interface Entry {
  readonly runtime: WorkflowRuntime
  readonly evalLock: Semaphore.Semaphore
  readonly fibers: ReadonlyMap<string, unknown>
}

export interface Environment {
  readonly directory: string
  readonly projectID: string
  readonly scope: Scope.Scope
  readonly store: DagStore.Interface
  readonly dag: Dag.Interface
  readonly sessions: Session.Interface
  readonly prompts: SessionPrompt.Interface
  readonly status: SessionStatus.Interface
  readonly automation: ExclusiveRegistry.Interface
  readonly database: Database.Interface
  readonly events: Context.Service.Shape<typeof EventV2Bridge.Service>
  readonly messages: DagMessages.Interface | undefined
  /** The per-instance inbox this delivery registers with. Absent in isolated
   * unit graphs; the idle trigger then falls back to the transitional scans. */
  readonly inbox: SessionInbox.Interface | undefined
  readonly entries: (dagID: string) => Entry | undefined
  readonly lastAssistantMessage: (childSessionID: string) => Effect.Effect<SessionV1.WithParts | undefined, Error>
}

export interface Interface {
  /** One serialized delivery attempt: durable wakes first, then the agent
   * mailbox. A wake admission ends the attempt; the turn-end idle event
   * triggers the next one. */
  readonly drain: (sessionID: string) => Effect.Effect<void>
  /** Claim form of `drain`: true only when a wake or mailbox admission
   * actually happened, so the inbox can fall through to the next source.
   * `claimEpoch` is the inbox drain's cancellation-epoch observation; an ESC
   * after that capture fences the wake admission instead of delivering into
   * it. */
  readonly deliver: (sessionID: string, claimEpoch?: number) => Effect.Effect<boolean, unknown>
  /** Fire-and-forget trigger: nudge is idempotent and safe to call for every
   * event source. The in-flight reservations coalesce concurrent attempts. */
  readonly nudge: (sessionID: string) => Effect.Effect<void>
  /** Fallback scan: paused-workflow reminders plus the transitional mailbox
   * poll. H2's per-instance inbox tick calls this until E2 removes the poll. */
  readonly scan: () => Effect.Effect<void>
  /** Durable scan for the inbox tick: sessions in this directory with an
   * unreported wake, a due paused reminder, or a queued main-mailbox message. */
  readonly scanSessions: () => Effect.Effect<ReadonlyArray<string>>
}

/** Pre-instance forward target. DagLoop's state builder installs a real
 * delivery before any event, recovery, or handler path can use it; these
 * no-ops only answer calls made while the instance is still constructing. */
export const unavailable: Interface = {
  drain: () => Effect.void,
  deliver: () => Effect.succeed(false),
  nudge: () => Effect.void,
  scan: () => Effect.void,
  scanSessions: () => Effect.succeed([] as ReadonlyArray<string>),
}

/**
 * Single DAG delivery scheduler (E1/D7). It owns both ledgers without
 * unifying them: the durable wake marker (`wake_reported`, admitted ==
 * delivered, #321) and `agent_message` (confirmed by `associate`, not by
 * admission). Ordering is wake first, mailbox second; the two in-flight
 * reservations below each exist exactly once, in this module.
 *
 * PR3 makes this module a `dag.delivery` inbox source (priority 5, idle_only)
 * and registers the hint-only `dag.mailbox.step` step source. The inbox owns
 * the one idle subscription; the 250ms mailbox poll, the 30s paused-reminder
 * sweep and the startup scan stay as transitional fallbacks until E2.
 */
export const make = Effect.fn("DagDelivery.make")(function* (environment: Environment): Effect.fn.Return<Interface> {
  const {
    directory,
    projectID,
    scope,
    store,
    dag,
    sessions,
    prompts,
    status,
    automation,
    database,
    events,
    messages,
    inbox,
    entries,
    lastAssistantMessage,
  } = environment

  // Same boundary as the DagLoop event handlers: a delivery handler must
  // never die, or its coalescing reservation would be lost for the process.
  const guarded =
    (event: string) =>
    <A, E, R>(self: Effect.Effect<A, E, R>) =>
      self.pipe(Effect.catchCause((cause) => Effect.logWarning("DagDelivery handler failed", { event, cause })))

  const wakeInFlight = new Set<string>()
  const wakePending = new Set<string>()
  // Cache the receipt only as an optimization. Exact durable message/part
  // lookup below survives a crash between admission and wake marking.
  const deliveredWakeSummaries = new Map<string, string>()

  const readWakeBatch = Effect.fn("DagDelivery.readWakeBatch")(function* (sessionID: string) {
    const snapshot = yield* store
      .getWakeSnapshot(sessionID)
      .pipe(Effect.catch(() => Effect.succeed({ nodes: [], workflows: [] } satisfies DagStore.WakeSnapshot)))
    const now = yield* Clock.currentTimeMillis
    const reportableWorkflows = snapshot.workflows.filter(
      (workflow) =>
        !workflow.wakeReported &&
        (isTerminalWorkflowStatusValue(workflow.status) || isPausedReminderDue(workflow, now)),
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
        .filter(
          (node) =>
            node.escalationPending || (node.timeoutExtensions > 0 && isNodeTerminalStatus(node.status as never)),
        )
        .map((node) => node.workflowId),
    )
    const workflowIDs = [
      ...new Set([
        ...snapshot.nodes.map((node) => node.workflowId),
        ...reportableWorkflows.map((workflow) => workflow.id),
      ]),
    ]
    const workflowsByID = new Map(snapshot.workflows.map((workflow) => [workflow.id, workflow]))
    const workflows = workflowIDs.map((workflowID) => workflowsByID.get(workflowID))
    // A completed final-response workflow either displays its final report
    // without a model turn, or owns reporting checkpoints and therefore
    // needs one completion turn. Durable node evidence decides: a delivery
    // leaf reports the final answer itself, while every other
    // `report_to_parent` node remains a parent checkpoint. Without a
    // completed delivery node there is no final answer, only a result
    // index: a gate (verify FAIL, review REJECT) skipped the delivery
    // path and settled the graph as completed so the parent can repair
    // or reopen it (#294). That outcome always needs a parent turn.
    const finalResponseCompletions = new Map<string, boolean>()
    for (const workflow of workflows) {
      if (!workflow || workflow.status !== "completed") continue
      const config = parseWorkflowConfig(workflow.config)
      if (!config) continue
      const nodes = yield* store.getCurrentNodes(workflow.id).pipe(Effect.orDie)
      finalResponseCompletions.set(
        workflow.id,
        reportingCheckpoints(config, nodes).length > 0 || !selectReportNode(config, nodes),
      )
    }
    const needsCompletionTurn = (workflowID: string) => finalResponseCompletions.get(workflowID) === true
    // A reporting checkpoint that completed while its downstream nodes
    // are still running is informative, not a stalled/actionable
    // boundary. It must reach the parent as its own coalesced batch
    // without entering the orchestrator-unresponsive net.
    const runningReportWorkflowIDs = new Set(
      snapshot.nodes
        // The snapshot predicate already limits wake-eligible rows to
        // completed/failed; escalation-only rows have wakeEligible=false.
        .filter((node) => node.wakeEligible)
        .filter((node) => {
          const workflow = workflowsByID.get(node.workflowId)
          if (workflow?.status !== "running") return false
          // Final-response workflows deliver progress checkpoints while
          // downstream work continues.
          const entry = entries(workflow.id)
          return !!entry && !entry.runtime.isPaused() && !entry.runtime.isStepMode()
        })
        .map((node) => node.workflowId),
    )
    const boundaryWorkflows = workflows.filter((workflow): workflow is DagStore.WorkflowRow => {
      if (!workflow) return false
      if (isWorkflowTerminalStatus(workflow.status as never)) return true
      const entry = entries(workflow.id)
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
    const atBoundary = new Set([...boundaryWorkflows.map((workflow) => workflow.id), ...runningReportWorkflowIDs])
    const batch = {
      // Display-only completion reports never consume node wakes. Their
      // delivery leaf is the report itself; leave every node row to its
      // own durable lifecycle instead of acking it under the display path.
      nodes: snapshot.nodes.filter(
        (node) => atBoundary.has(node.workflowId) && finalResponseCompletions.get(node.workflowId) !== false,
      ),
      workflows: reportableWorkflows.filter((workflow) => atBoundary.has(workflow.id)),
    } satisfies DagStore.WakeBatch
    const atDeliveryBoundary = new Set(boundaryWorkflows.map((workflow) => workflow.id))
    return {
      batch,
      completedReports: reportableWorkflows.filter(
        (workflow) => atDeliveryBoundary.has(workflow.id) && finalResponseCompletions.get(workflow.id) === false,
      ),
      completionReports: reportableWorkflows.filter(
        (workflow) => atDeliveryBoundary.has(workflow.id) && needsCompletionTurn(workflow.id),
      ),
      actionableDagIDs: new Set(
        boundaryWorkflows
          .filter((workflow) => !isWorkflowTerminalStatus(workflow.status as never))
          .map((workflow) => workflow.id),
      ),
      unresponsiveDagIDs: new Set(
        boundaryWorkflows
          .filter((workflow) => {
            const entry = entries(workflow.id)
            return workflow.status === "running" && !entry?.runtime.isPaused() && !entry?.runtime.isStepMode()
          })
          .map((workflow) => workflow.id),
      ),
    }
  })

  /**
   * #948 notification-only ownership. `ownsSession` ignores terminal
   * rows so a dead workflow cannot block a later valid workflow in the
   * same session. That leaves one gap: a terminal-only batch has no
   * execution owner. Gate it on each durable workflow directory
   * instead — this grants notification delivery only, never execution,
   * and never falls back to process.cwd.
   */
  const sessionNotificationOwned = Effect.fnUntraced(function* (sessionID: string) {
    const snapshot = yield* store
      .getWakeSnapshot(sessionID)
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.succeed({ nodes: [], workflows: [] } satisfies DagStore.WakeSnapshot),
        ),
      )
    const terminal = snapshot.workflows.filter(
      (workflow) => !workflow.wakeReported && isTerminalWorkflowStatusValue(workflow.status),
    )
    for (const workflow of terminal) {
      if (!(yield* DagLocation.ownsWorkflow(workflow.id, directory))) return false
    }
    return true
  })

  // Follow-up trigger for a display-only report: no turn ran, so no idle
  // event will arrive on its own. The inbox is the unified trigger port; the
  // live idle gate is still authoritative, and a skipped nudge is recovered
  // by the turn-end idle or the 30s tick.
  const notifyInboxAfterReport = (sessionID: string): Effect.Effect<void> =>
    inbox === undefined
      ? Effect.void
      : status.get(SessionID.make(sessionID)).pipe(
          Effect.flatMap((info) => (info.type === "idle" ? inbox.nudge(SessionID.make(sessionID)) : Effect.void)),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.void
              : Effect.logWarning("DAG display report inbox nudge failed", {
                  sessionID,
                  cause: Cause.pretty(cause),
                }),
          ),
        )

  let tryDeliverWake: (sessionID: string, claimEpoch?: number) => Effect.Effect<boolean> = () => Effect.succeed(false)
  const deliverWake = Effect.fn("DagDelivery.deliverWake")(function* (sessionID: string, claimEpoch?: number) {
    // Cross-instance guard via the execution-location authority: wake
    // delivery is store-global (idle Status events, node-terminal
    // handlers, the startup sweep). Only the instance whose DIRECTORY
    // owns the session's workflows may deliver its wakes — sibling
    // worktrees of the same project must ignore each other's idle
    // sessions. The guard also covers the workflow-terminal stimulus
    // after a session deletion (the durable rows are gone).
    if (!(yield* DagLocation.ownsSession(sessionID, directory))) return false
    if (!(yield* sessionNotificationOwned(sessionID))) return false
    if (wakeInFlight.has(sessionID)) {
      wakePending.add(sessionID)
      return false
    }
    wakeInFlight.add(sessionID)
    // A display-only completion report writes no turn, so no idle event
    // follows it. Remember the fact and re-trigger the inbox after this
    // wake reservation is released (the finalizer below); nudging while
    // wakeInFlight is set would only bounce off the reservation.
    let reportDelivered = false
    // Re-read after each stable batch so rows committed during delivery
    // remain a separate batch. The reservation is released by an Effect
    // finalizer, not a generator `finally`: Effect does not resume a
    // generator's `finally` when the fiber is interrupted (the lease
    // timeout below), fails, or dies, so a generator release would leak
    // the reservation and park every later wake in `wakePending`.
    return yield* Effect.gen(function* () {
      let admitted = false
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
              const entry = entries(dagID)
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
          return admitted
        }

        if ((yield* status.get(SessionID.make(sessionID))).type !== "idle") return admitted

        // Completed final-response workflows display their result without a model turn.
        // Other decisions in the same snapshot take precedence; their wake excludes
        // these completed reports so they cannot invite a duplicate summary.
        const completedIDs = new Set(plan.completedReports.map((workflow) => workflow.id))
        const decisions = {
          nodes: batch.nodes.filter((node) => !completedIDs.has(node.workflowId)),
          workflows: batch.workflows.filter((workflow) => !completedIDs.has(workflow.id)),
        } satisfies DagStore.WakeBatch
        if (plan.completedReports.length > 0 && decisions.nodes.length === 0 && decisions.workflows.length === 0) {
          for (const workflow of plan.completedReports) {
            const reportBatch = {
              nodes: [],
              workflows: batch.workflows.filter((row) => row.id === workflow.id),
            }
            if (reportBatch.workflows.length === 0) continue
            yield* automation.register(SessionID.make(sessionID), { kind: "dag", id: workflow.id })
            const lease = Option.getOrUndefined(yield* automation.claim(SessionID.make(sessionID), { kind: "dag" }))
            if (!lease) return admitted
            const config = parseWorkflowConfig(workflow.config)
            const reportNodes = yield* store.getCurrentNodes(workflow.id).pipe(Effect.orDie)
            const node =
              (config ? selectReportNode(config, reportNodes) : undefined) ??
              reportNodes.find((node) => node.status === "completed")
            const source = node?.childSessionId ? yield* lastAssistantMessage(node.childSessionId).pipe(Effect.orDie) : undefined
            const delivered = yield* automation.use(
              lease,
              prompts.withIdle(
                SessionID.make(sessionID),
                deliverReport({
                  workflow,
                  batch: reportBatch,
                  store,
                  sessions,
                  events,
                  directory,
                  source,
                }).pipe(Effect.provideService(Database.Service, database)),
              ),
            )
            if (Option.isNone(delivered) || Option.isNone(delivered.value) || !delivered.value.value) return admitted
            admitted = true
            yield* automation.unregister(SessionID.make(sessionID), { kind: "dag", id: workflow.id })
            reportDelivered = true
          }
          continue
        }
        if (completedIDs.size > 0) batch = decisions

        const wakeIdentity = wakeBatchIdentity(sessionID, batch)
        const durableReceipt =
          deliveredWakeSummaries.get(sessionID) === wakeIdentity.messageID
            ? undefined
            : yield* sessions.getPart({
                sessionID: SessionID.make(sessionID),
                messageID: wakeIdentity.messageID,
                partID: wakeIdentity.partID,
              })
        const alreadyAdmitted =
          deliveredWakeSummaries.get(sessionID) === wakeIdentity.messageID ||
          (durableReceipt?.type === "text" && durableReceipt.synthetic === true)

        // Preemption guard (task 3.3): abort if fresher user message exists
        const msgs = yield* sessions
          .messages({ sessionID: SessionID.make(sessionID), limit: 20 })
          .pipe(Effect.catch(() => Effect.succeed([])))
        let lastUserAt = -1
        let lastAsstAt = -1
        for (const m of msgs) {
          const t = m.info.time?.created
          if (typeof t !== "number") continue
          if (m.info.role === "user" && t > lastUserAt) lastUserAt = t
          else if (m.info.role === "assistant" && t > lastAsstAt) lastAsstAt = t
        }
        if (!alreadyAdmitted && lastUserAt > lastAsstAt) return admitted

        const failuresByWorkflow = new Map<string, string[]>()
        for (const workflow of batch.workflows) {
          if (workflow.status !== "failed") continue
          // Rev-view (v1.0.15 Train A): attribution is terminal
          // aggregation — only CURRENT-revision failures are attributed.
          // Cancelled rows are superseded by the NodeCancelled projection,
          // so getCurrentNodes already drops them; the errorClass filter
          // below is the explicit D12 defense layer for the same rows and
          // for budget-exhausted failures, which are not agent failures.
          const failedNodes = yield* store.getCurrentNodes(workflow.id).pipe(
            Effect.map((nodes) =>
              nodes.filter(
                (node): node is DagStore.NodeRow & { errorClass: string } =>
                  node.status === "failed" &&
                  node.errorClass !== null &&
                  node.errorClass !== ERROR_CLASS_CANCELLED &&
                  node.errorClass !== ERROR_CLASS_BUDGET_EXHAUSTED,
              ),
            ),
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("wake digest failed to read failed nodes", {
                  workflowId: workflow.id,
                  cause,
                })
                return [] as (DagStore.NodeRow & { errorClass: string })[]
              }),
            ),
          )
          if (failedNodes.length > 0) {
            failuresByWorkflow.set(
              workflow.id,
              failedNodes.map((node) =>
                `- "${node.name}" (${node.errorClass}): ${node.errorReason ?? "unknown error"}`.slice(0, 300),
              ),
            )
          }
        }
        const completionIDs = new Set(plan.completionReports.map((workflow) => workflow.id))
        // A completed workflow can still leave required work undone when a
        // gate skipped it; name those nodes so the turn acts on them.
        const incompleteByWorkflow = new Map<string, string[]>()
        for (const workflow of batch.workflows) {
          if (workflow.status !== "completed" || !completionIDs.has(workflow.id)) continue
          const incomplete = (yield* store.getCurrentNodes(workflow.id).pipe(Effect.orDie)).filter(
            (node) => node.required && node.status !== "completed",
          )
          if (incomplete.length > 0) {
            incompleteByWorkflow.set(
              workflow.id,
              incomplete.map((node) => {
                const state = displayState(node)
                const reason = state === "failed" && node.errorClass ? `: ${node.errorClass}` : ""
                return `- "${node.id}" (${state}${reason})`.slice(0, 300)
              }),
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
            if (displayState(node) === "escalated") {
              const at = new Date(node.timeUpdated ?? node.startedAt ?? Date.now()).toISOString()
              return `[DAG Node Timeout] RUNNING node "${node.name}" exceeded its execution deadline at ${at} (timeout escalation ${node.timeoutExtensions}) and is still executing. If the workflow's cumulative escalation cap is not exhausted, control(extend_timeout) { workflow_id, node_id, timeout_ms } grants more execution time WITHOUT a replan — it keeps the same child session and attempt, consumes no replan, rewrites no graph, and the deadline watcher picks up the new deadline on its next read. At the cap, extension of this attempt is refused and the watcher enforces the timeout verdict. The cumulative extension count is NOT reset (only a new attempt resets it). Use control(replan) with a NEW worker_config.timeout_ms when you must also change the graph; restart or cancel the node to stop the current attempt. Queued nodes are not extended: their admission deadline was fixed at permit acquisition and is not adjusted by extensions.`
            }
            const durableResult =
              typeof node.output === "string"
                ? node.output
                : (node.errorReason ?? (node.output == null ? "(no output)" : JSON.stringify(node.output)))
            const truncated = durableResult.length > 500
            const output = durableResult.slice(0, 500)
            const state = displayState(node)
            // D11: cancellation is identified only by the structured
            // display state; do not render it as "failed (cancelled)".
            const failureClass = state === "failed" && node.errorClass ? ` (${node.errorClass})` : ""
            // #949: every delivered result states when the node settled,
            // so the parent can answer "when did this arrive?".
            const at = new Date(node.completedAt ?? node.startedAt ?? node.timeUpdated ?? Date.now()).toISOString()
            const retrieval = truncated
              ? `\nComplete output: call workflow result with workflow_id="${node.workflowId}" and node_id="${node.id}".`
              : ""
            return `[DAG Node Result] Node "${node.name}" ${state}${failureClass}: ${output}\n[DAG Result Reference] workflow_id="${node.workflowId}" node_id="${node.id}" truncated=${truncated} at ${at}${retrieval}`
          }),
          ...batch.workflows.map((workflow) => {
            const failures = failuresByWorkflow.get(workflow.id)
            const incomplete = incompleteByWorkflow.get(workflow.id)
            const attribution = failures
              ? `\nFailed nodes:\n${failures.join("\n")}`
              : incomplete
                ? `\nRequired nodes not completed (no final answer was produced):\n${incomplete.join("\n")}\nRead the gate result, then repair and reopen the work with control extend, or start a bounded successor workflow; do not stop while in-scope work remains.`
                : ""
            return workflow.status === "paused"
              ? `[DAG Workflow paused] Workflow "${workflow.title}" has remained paused for five minutes. It is still paused and awaits an explicit control(replan), control(extend), control(resume), or control(cancel); no automatic transition was made.`
              : `[DAG Workflow ${workflow.status}] Workflow "${workflow.title}" has reached terminal status. (at ${new Date(workflow.completedAt ?? workflow.timeUpdated).toISOString()})${attribution}${completionIDs.has(workflow.id) ? `\n${completionReportReference(workflow)}` : ""}`
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
          return admitted
        }

        const wakeWorkflowIDs = new Set([
          ...batch.nodes.map((node) => node.workflowId),
          ...batch.workflows.map((workflow) => workflow.id),
        ])
        for (const workflowID of wakeWorkflowIDs) {
          yield* automation.register(SessionID.make(sessionID), { kind: "dag", id: workflowID })
        }
        const wakeLease = Option.getOrUndefined(yield* automation.claim(SessionID.make(sessionID), { kind: "dag" }))
        if (!wakeLease) return admitted

        // A completed workflow with reporting checkpoints keeps both its
        // final report and a parent turn. Deliver the report first so the
        // completion wake can reference durable, already-visible content;
        // the wake admission below marks the workflow completion row and
        // any pending checkpoint nodes in one transaction. A crash between
        // the two steps adopts the report receipt on retry.
        if (!alreadyAdmitted) {
          for (const workflow of plan.completionReports) {
            if (!batch.workflows.some((row) => row.id === workflow.id)) continue
            const config = parseWorkflowConfig(workflow.config)
            const reportNodes = yield* store.getCurrentNodes(workflow.id).pipe(Effect.orDie)
            const node =
              (config ? selectReportNode(config, reportNodes) : undefined) ??
              reportNodes.find((candidate) => candidate.status === "completed")
            const source = node?.childSessionId ? yield* lastAssistantMessage(node.childSessionId).pipe(Effect.orDie) : undefined
            const delivered = yield* automation.use(
              wakeLease,
              prompts.withIdle(
                SessionID.make(sessionID),
                deliverReport({
                  workflow,
                  batch: { nodes: [], workflows: [workflow] },
                  store,
                  sessions,
                  events,
                  directory,
                  source,
                  acknowledge: false,
                }).pipe(Effect.provideService(Database.Service, database)),
              ),
            )
            if (Option.isNone(delivered) || Option.isNone(delivered.value) || !delivered.value.value) return admitted
          }
        }

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
            const delivered = yield* SessionPrompt.admitIdleUnderFence(
              prompts,
              automation,
              wakeLease,
              {
                sessionID: SessionID.make(sessionID),
                messageID: wakeIdentity.messageID,
                parts: [{ id: wakeIdentity.partID, type: "text", text: summary, synthetic: true }],
              },
              { continueToolBudget: true },
              store.markWakeBatchReported(batch),
              claimEpoch,
            )
            // A fenced skip/cancel committed nothing: the durable receipt and
            // the wake rows stay as they are for the next trigger.
            if (delivered.tag !== "admitted") return false
            deliveredWakeSummaries.set(sessionID, wakeIdentity.messageID)
            wakeTurn = delivered.turn
          }

          // New admission already committed its mark atomically. An old
          // durable receipt from before this boundary can still be
          // acknowledged under the current exclusive registry.
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
        if (!didDeliver) return admitted
        admitted = true
      }
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          const retry = wakePending.delete(sessionID)
          wakeInFlight.delete(sessionID)
          // Both follow-ups run only after the reservation is gone: a retry
          // would otherwise bounce off `wakeInFlight`, and a report nudge
          // would be answered by a claim that skips mailbox work.
          const retryFiber = retry
            ? tryDeliverWake(sessionID).pipe(guarded("WakePendingRetry"), Effect.forkIn(scope), Effect.asVoid)
            : Effect.void
          const notifyFiber = reportDelivered
            ? notifyInboxAfterReport(sessionID).pipe(Effect.forkIn(scope), Effect.asVoid)
            : Effect.void
          return Effect.all([retryFiber, notifyFiber], { discard: true })
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
  tryDeliverWake = (sessionID, claimEpoch) =>
    deliverWake(sessionID, claimEpoch).pipe(
      Effect.timeoutOption("7 minutes"),
      Effect.flatMap(
        Option.match({
          onSome: (delivered) => Effect.succeed(delivered),
          onNone: () =>
            Effect.logWarning("DAG wake delivery lease expired; retry remains available", { sessionID }).pipe(
              Effect.as(false),
            ),
        }),
      ),
    )

  const mailboxInFlight = new Set<string>()
  const deliverAgentMessages = Effect.fn("DagDelivery.deliverAgentMessages")(
    function* (sessionID: string, inboxClaimEpoch?: number) {
      // An inbox drain passes the epoch observed before its sources ran; poll
      // and mailbox-change triggers have none, so those attempts capture their
      // own observation before any durable read.
      const claimEpoch = inboxClaimEpoch ?? SessionCancellation.epoch(sessionID)
      if (!messages || mailboxInFlight.has(sessionID)) return false
      mailboxInFlight.add(sessionID)
      return yield* Effect.gen(function* () {
        if ((yield* status.get(SessionID.make(sessionID))).type !== "idle") return false
        const caller = { projectID, directory, sessionID }
        const queued = yield* messages.receive(caller, { limit: 64, queuedOnly: true })
        if (!queued.ok) return false
        const message = queued.value.find((item) => item.state === "queued")
        if (!message || message.recipient.kind !== "main") return false
        const history = yield* sessions.messages({ sessionID: SessionID.make(sessionID), limit: 20 })
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
          if (!newContext) return false
        }
        // The mailbox lease is separate from workflow lifecycle ownership:
        // accepted node reports survive source completion and cancellation.
        const owner = { kind: "dag" as const, id: `agent-mailbox:${message.recipient.id}` }
        yield* automation.register(SessionID.make(sessionID), owner)
        return yield* Effect.gen(function* () {
          const token = yield* automation.claim(SessionID.make(sessionID), { kind: "dag" })
          if (Option.isNone(token)) return false
          const admitted = yield* SessionPrompt.admitIdleUnderFence(
            prompts,
            automation,
            token.value,
            {
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
            },
            undefined,
            undefined,
            claimEpoch,
          )
          // A fenced skip/cancel committed nothing: the agent message stays
          // queued and the next trigger retries it.
          if (admitted.tag !== "admitted") return false
          // Admission alone leaves delivery queued. SessionPrompt freezes
          // and associates the actual model input, then advances delivery.
          yield* automation.unregister(SessionID.make(sessionID), owner)
          yield* admitted.turn
          return true
        }).pipe(Effect.ensuring(automation.unregister(SessionID.make(sessionID), owner)))
      }).pipe(Effect.ensuring(Effect.sync(() => mailboxInFlight.delete(sessionID))))
    },
    Effect.timeoutOption("7 minutes"),
    Effect.map(Option.getOrElse(() => false)),
  )

  let mailboxCursor: string | undefined
  const pollAgentMailboxes = Effect.gen(function* () {
    if (!messages) return
    const recipients = yield* messages.pendingRecipients({
      projectID,
      directory,
      limit: 20,
      afterSessionID: mailboxCursor,
    })
    mailboxCursor = recipients.at(-1)?.sessionID
    for (const endpoint of recipients) {
      yield* deliverAgentMessages(endpoint.sessionID).pipe(guarded("AgentMailboxAdmission"), Effect.forkIn(scope))
    }
  }).pipe(guarded("AgentMailboxSweep"))

  // A parked workflow can outlive the parent turn that caused its pause.
  // The paused row's durable wake marker permits one reminder per pause
  // episode, including after restart. Scanning only starts delivery; the
  // regular idle/admission and directory ownership gates still apply.
  const remindPausedWorkflows = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const paused = yield* store.listByStatus("paused")
    const pausedSessions = new Set(
      paused.filter((workflow) => isPausedReminderDue(workflow, now)).map((workflow) => workflow.sessionId),
    )
    for (const sessionID of pausedSessions) {
      if (!(yield* DagLocation.ownsSession(sessionID, directory))) continue
      yield* tryDeliverWake(sessionID, SessionCancellation.epoch(sessionID)).pipe(
        guarded("PausedReminder"),
        Effect.forkIn(scope),
      )
    }
  }).pipe(guarded("PausedReminderSweep"))

  /** Fallback scan: paused reminders + the transitional 250ms mailbox poll. */
  const scan = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* pollAgentMailboxes
      yield* remindPausedWorkflows
    }).pipe(guarded("DagDeliveryScan"))

  /** Sessions this instance should try on the inbox tick. Store lists are
   * global; the directory guard keeps sibling worktrees out, and the drain's
   * own ownership gates remain authoritative. */
  const scanSessions = (): Effect.Effect<ReadonlyArray<string>> =>
    Effect.gen(function* () {
      const sessions = new Set<string>()
      // Each ledger degrades independently: one broken query must not hide
      // the other two from this tick. The final catch below covers the
      // ownership reads and the union itself.
      const wakes = yield* store.getSessionsWithUnreportedWakes().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("DagDelivery wake scan failed", { cause }).pipe(
            Effect.as([] as ReadonlyArray<string>),
          ),
        ),
      )
      for (const sessionID of wakes) {
        if (yield* DagLocation.ownsSession(sessionID, directory)) sessions.add(sessionID)
      }
      const now = yield* Clock.currentTimeMillis
      const paused = yield* store.listByStatus("paused").pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("DagDelivery paused scan failed", { cause }).pipe(
            Effect.as([] as ReadonlyArray<DagStore.WorkflowRow>),
          ),
        ),
      )
      for (const workflow of paused) {
        if (!isPausedReminderDue(workflow, now)) continue
        if (yield* DagLocation.ownsSession(workflow.sessionId, directory)) sessions.add(workflow.sessionId)
      }
      if (messages) {
        const recipients = yield* messages.pendingRecipients({ projectID, directory, limit: 64 }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("DagDelivery mailbox scan failed", { cause }).pipe(
              Effect.as([] as ReadonlyArray<DagMessages.Endpoint>),
            ),
          ),
        )
        for (const endpoint of recipients) sessions.add(endpoint.sessionID)
      }
      return [...sessions]
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("DagDelivery scanSessions failed", { cause }).pipe(
          Effect.as([] as ReadonlyArray<string>),
        ),
      ),
    )

  /** One serialized attempt: durable wakes first, mailbox second only when no
   * wake work remains. The boolean is the inbox claim's "did anything
   * happen". A wake reservation that is still held (or queued behind one)
   * must not fall through to the mailbox: that would turn wake-first into
   * mailbox-first and race the wake retry against a busy session. */
  const deliver = (sessionID: string, claimEpoch?: number): Effect.Effect<boolean, unknown> =>
    Effect.gen(function* () {
      const delivered = yield* tryDeliverWake(sessionID, claimEpoch)
      if (delivered) return true
      if (wakeInFlight.has(sessionID) || wakePending.has(sessionID)) return false
      // The mailbox attempt reuses the drain's epoch observation when the
      // caller has one, so an ESC during the wake attempt fences it too.
      return yield* deliverAgentMessages(sessionID, claimEpoch)
    })

  /** One serialized attempt: durable wakes first, mailbox second when no wake
   * was admitted. */
  const drain = (sessionID: string): Effect.Effect<void> =>
    deliver(sessionID).pipe(guarded("DeliveryDrain"), Effect.asVoid)

  /** Every event source only nudges; the in-flight reservations join repeats. */
  const nudge = (sessionID: string): Effect.Effect<void> =>
    drain(sessionID).pipe(guarded("DeliveryNudge"), Effect.forkIn(scope), Effect.asVoid)

  // H2 consumes `DagMessages.changed` for event-driven mailbox delivery.
  // Until then this module is the consumer: a queued message in this
  // instance's directory nudges the owning session's drain. The subscription
  // may be an unimplemented test mock; it must never kill the instance.
  if (messages) {
    yield* Effect.suspend(() => {
      const mailbox = messages
      return mailbox.changed.pipe(
        Stream.filter((change) => change.kind === "queued"),
        Stream.runForEach((change) =>
          change.directory !== "" && DagLocation.canonicalDirectory(change.directory) === DagLocation.canonicalDirectory(directory)
            ? nudge(change.recipientSessionID)
            : Effect.void,
        ),
      )
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("DagDelivery mailbox change stream unavailable", { cause }),
      ),
      Effect.forkIn(scope),
    )
  }

  // Transitional fallbacks until H2's per-instance inbox tick and E2 remove
  // them: an immediate scan at init, then the 250ms mailbox poll and the 30s
  // paused-reminder sweep.
  yield* scan()
  if (messages) {
    yield* Effect.forever(Effect.sleep(250).pipe(Effect.andThen(pollAgentMailboxes))).pipe(Effect.forkIn(scope))
  }
  yield* Effect.forever(Effect.sleep(30_000).pipe(Effect.andThen(remindPausedWorkflows))).pipe(Effect.forkIn(scope))

  if (inbox) {
    // Priority 5 runs before goal.continue (10): a DAG wake/mailbox item is
    // time-sensitive and must claim the boundary first. The hint is always
    // true because there is no cheap in-memory index that survives a restart;
    // ownership and the idle gate live in `deliver`/the inbox claim.
    yield* inbox.register({
      id: "dag.delivery",
      priority: 5,
      mode: "idle_only",
      hint: () => true,
      scan: () => scanSessions().pipe(Effect.map((ids) => ids.map((id) => SessionID.make(id)))),
      claim: (sessionID, ctx) => deliver(sessionID, ctx.claimEpoch),
    })
    // Hint-only for now: E1's freeze/associate remains the only delivery and
    // confirmation path. A false hint would skip `clearBoundaryApproval` and
    // let `check_step_input` keep resuming on queued revisions, so PR3
    // registers the port with a conservative true hint and no provider.
    yield* inbox.registerStep({ id: "dag.mailbox.step", hint: () => true })
  }

  return { drain, deliver, nudge, scan, scanSessions }
})
