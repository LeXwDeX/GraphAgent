// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

// Consumer-only DAG hold for the non-interactive `opencode run` loop (issue 614).
//
// Today the loop breaks on the FIRST session.status=idle of the target session,
// so a workflow started in that turn keeps running server-side while the CLI
// exits and the eventual wake reply is silently lost. The durable dag.* events
// are not on the client wire and `wake_reported` is not part of the
// dag.bySession DTO, so the consumer cannot subscribe to completion — it can
// only poll. This module is that poll: a pure four-condition break rule plus a
// thin wrapper the run loop calls on the busy/idle transitions it already
// observes.
//
// A session turn is NOT one busy event: the prompt loop re-emits
// session.status=busy at the top of every model step, so the wrapper sees N
// busy events per turn. Per-turn state therefore resets only on the FIRST busy
// after an idle (the true idle→busy transition); later busies within the same
// turn keep sampling the workflow snapshot and can only ever strengthen the
// latch — never clear it mid-turn.
//
// Tracked state:
//   busyIds    — every workflow id observed by any poll so far (accumulates)
//   busyActive — some poll observed a workflow in {pending, running} since the
//                last idle→busy transition
//
// Break on idle iff ALL hold:
//   1. poll(now) shows no workflow in {pending, running}
//   2. busyActive === false (active work seen this turn means a wake is owed
//      even if the poll is already quiescent)
//   3. every id in poll(now) was already known (a first-seen workflow id means
//      a wake for it may still be in flight — covers workflows that
//      terminalize within turn one and chained DAGs started during a wake turn)
//   4. every completed final-response workflow has its answer receipt in the
//      parent transcript and a newly delivered answer has been emitted by this
//      run (multiple completions may be delivered separately)
//
// Degradation is deliberately silent and matches pre-614 behavior for the DAG
// list itself:
//   - a DAG list failure at idle breaks the loop (today's exit, no error surfaced)
//   - a poll failure while busy leaves the state untouched
// A report receipt read failure stays pending, since breaking could hide a
// completed workflow's answer from the parent transcript.
// Paused and stepping workflows are not active statuses, so they never hold the
// loop open by themselves — the CLI exits as it does today once quiescent and
// known. There is no timer and no reconnect: an engine stall is bounded by the
// engine watchdog, and a visible hang is accepted over silent wake loss.

import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { parseWorkflowConfig } from "@/dag/dag"
import { reportIdentity } from "@/dag/report-identity"
import { isRecord } from "@/util/record"

export type DagWorkflowSnapshot = {
  readonly id: string
  readonly status: string
  /** The completion episode still lacks its parent answer receipt. */
  readonly awaitingReport?: boolean
  /** The receipt state could not be established and must be retried at startup. */
  readonly receiptUnknown?: boolean
}

export type DagHoldDecision = "hold" | "break"

export type DagHoldState = {
  /** Workflow ids observed by any poll so far (accumulates across turns). */
  readonly busyIds: Set<string>
  /** Active work observed since the last idle→busy transition. */
  busyActive: boolean
  /** True between the first busy of a turn and the turn's idle event. */
  inTurn: boolean
}

/** Terminal-adjacent statuses that do not keep the loop alive. The complement
 * of the workflow terminal set lives in core; the hold only needs its own
 * active pair. */
export function isDagActiveStatus(status: string): boolean {
  return status === "pending" || status === "running"
}

export function initialDagHoldState(): DagHoldState {
  return { busyIds: new Set(), busyActive: false, inTurn: false }
}

function foldSnapshot(state: DagHoldState, snapshot: readonly DagWorkflowSnapshot[]): void {
  for (const workflow of snapshot) state.busyIds.add(workflow.id)
  if (snapshot.some((workflow) => isDagActiveStatus(workflow.status))) state.busyActive = true
}

/** A busy event of the target session. Only the FIRST busy after an idle is a
 * turn boundary; repeated busies within the turn must not clear the latch. */
export function observeDagHoldBusy(state: DagHoldState, snapshot: readonly DagWorkflowSnapshot[]): void {
  if (!state.inTurn) {
    state.inTurn = true
    state.busyActive = false
  }
  foldSnapshot(state, snapshot)
}

/** The idle event of the target session: evaluate the break rule against the
 * PRE-update state, then fold the snapshot in. A workflow id that appears for
 * the first time in this snapshot must read as unknown even though the fold
 * adds it right after. */
export function applyDagHoldSnapshot(state: DagHoldState, snapshot: readonly DagWorkflowSnapshot[]): DagHoldDecision {
  const active = snapshot.some((workflow) => isDagActiveStatus(workflow.status))
  const awaitingReport = snapshot.some((workflow) => workflow.awaitingReport === true)
  const known = snapshot.every((workflow) => state.busyIds.has(workflow.id))
  const decision: DagHoldDecision = !active && !state.busyActive && known && !awaitingReport ? "break" : "hold"
  state.inTurn = false
  foldSnapshot(state, snapshot)
  return decision
}

export type DagHoldPoll = () => Promise<readonly DagWorkflowSnapshot[] | undefined>

export type DagHold = {
  /** session.status=busy for the target session: sample the workflow snapshot
   * (failures ignored) and latch per-turn active state. */
  readonly onBusy: () => Promise<void>
  /** session.status=idle for the target session: poll and decide. A failed
   * poll breaks — exactly the pre-614 exit, silently. */
  readonly onIdle: () => Promise<DagHoldDecision>
  /** Record a finished answer text part after this run emits it to the user. */
  readonly onText: (part: {
    id: string
    sessionID: string
    messageID: string
    text?: string
    metadata?: Record<string, unknown>
  }) => void
  /** The current command/prompt user message entered this event stream. */
  readonly onUserMessage: (messageID: string) => void
}

export function createDagHold(
  poll: DagHoldPoll,
  onText: DagHold["onText"] = () => {},
  requestedMessageID?: string,
): DagHold {
  const state = initialDagHoldState()
  let requestObserved = requestedMessageID === undefined
  return {
    onBusy: async () => {
      const snapshot = await poll().catch(() => undefined)
      if (snapshot) observeDagHoldBusy(state, snapshot)
    },
    onIdle: async () => {
      const snapshot = await poll().catch(() => undefined)
      const decision = snapshot ? applyDagHoldSnapshot(state, snapshot) : "break"
      return requestObserved ? decision : "hold"
    },
    onText,
    onUserMessage: (messageID) => {
      if (messageID === requestedMessageID) requestObserved = true
    },
  }
}

// Match the runtime gate; invalid persisted configs cannot produce direct receipts.
function finalResponseConfig(raw: string): boolean {
  return parseWorkflowConfig(raw)?.result_protocol === "final_response"
}

type ReportObservation = {
  readonly baseline: ReadonlySet<string>
  readonly emitted: ReadonlySet<string>
}

function episodeKey(sessionID: string, workflowID: string, seq: number): string {
  return JSON.stringify([sessionID, workflowID, seq])
}

function answerKey(sessionID: string, messageID: string, partID: string, workflowID: string, seq: number): string {
  return JSON.stringify([sessionID, messageID, partID, workflowID, seq])
}

function answerWasEmitted(part: Parameters<DagHold["onText"]>[0]): string | undefined {
  if (!isRecord(part.metadata)) return undefined
  const delivery = part.metadata.dag_delivery
  if (!isRecord(delivery) || delivery.kind !== "answer") return undefined
  if (typeof delivery.workflow_id !== "string" || typeof delivery.completion_seq !== "number") return undefined
  return answerKey(part.sessionID, part.messageID, part.id, delivery.workflow_id, delivery.completion_seq)
}

function isNotFoundError(error: unknown): boolean {
  return (
    isRecord(error) && error.name === "NotFoundError" && isRecord(error.data) && typeof error.data.message === "string"
  )
}

function responseStatus(response: unknown): number | undefined {
  if (!isRecord(response) || typeof response.status !== "number") return undefined
  return response.status
}

/** Poll implementation over the in-process SDK client (GET /dag/session/:id —
 * session-scoped, project-ownership enforced server-side). A completed final
 * response remains pending until its exact answer receipt is visible. */
export async function dagWorkflowsBySession(
  client: OpencodeClient,
  sessionID: string,
  verifiedReceipts: Set<string> = new Set(),
  observation?: ReportObservation,
  signal?: AbortSignal,
): Promise<readonly DagWorkflowSnapshot[] | undefined> {
  const response = await client.dag.bySession({ sessionID }, signal ? { signal } : undefined)
  if (response.error) return undefined
  return Promise.all(
    (response.data ?? []).map(async (workflow): Promise<DagWorkflowSnapshot> => {
      const basic = { id: workflow.id, status: workflow.status }
      if (workflow.status !== "completed" || !finalResponseConfig(workflow.config)) return basic
      if (typeof workflow.seq !== "number" || !Number.isSafeInteger(workflow.seq))
        return { ...basic, awaitingReport: true, receiptUnknown: true }
      const seq = workflow.seq
      if (typeof workflow.time_updated !== "number" || !Number.isFinite(workflow.time_updated))
        return { ...basic, awaitingReport: true, receiptUnknown: true }
      const completedAt = workflow.completed_at
      if (completedAt !== undefined && (typeof completedAt !== "number" || !Number.isFinite(completedAt)))
        return { ...basic, awaitingReport: true, receiptUnknown: true }
      const identity = reportIdentity({
        sessionId: sessionID,
        id: workflow.id,
        seq,
        completedAt: completedAt ?? null,
        timeUpdated: workflow.time_updated,
      })
      const episode = episodeKey(sessionID, workflow.id, seq)
      const awaitingEmission = () =>
        observation !== undefined &&
        !observation.baseline.has(episode) &&
        !observation.emitted.has(answerKey(sessionID, identity.messageID, identity.answerID, workflow.id, seq))
      if (verifiedReceipts.has(episode)) return { ...basic, awaitingReport: awaitingEmission() }
      try {
        const receipt = await client.session.message(
          { sessionID, messageID: identity.messageID },
          signal ? { signal } : undefined,
        )
        const found =
          !receipt.error &&
          receipt.data?.info.id === identity.messageID &&
          receipt.data.parts.some((part) => {
            if (part.type !== "text" || part.id !== identity.answerID || !isRecord(part.metadata)) return false
            const delivery = part.metadata.dag_delivery
            return (
              isRecord(delivery) &&
              delivery.workflow_id === workflow.id &&
              delivery.completion_seq === seq &&
              delivery.kind === "answer"
            )
          })
        if (found) verifiedReceipts.add(episode)
        const missing = isNotFoundError(receipt.error) || responseStatus(receipt.response) === 404
        return { ...basic, awaitingReport: !found || awaitingEmission(), receiptUnknown: !!receipt.error && !missing }
      } catch {
        return { ...basic, awaitingReport: true, receiptUnknown: true }
      }
    }),
  )
}

/** Cache only verified receipts for this one CLI run. New completion seqs are
 * still read, while historic completions cost one read at most. */
export function makeDagWorkflowPoll(client: OpencodeClient, sessionID: string): DagHoldPoll {
  const verifiedReceipts = new Set<string>()
  return () => dagWorkflowsBySession(client, sessionID, verifiedReceipts)
}

const STARTUP_BASELINE_ATTEMPTS = 5
const STARTUP_BASELINE_TIMEOUT_MS = 3_000
const STARTUP_BASELINE_RETRY_DELAYS_MS = [100, 200, 400, 800] as const

async function startupBaseline(client: OpencodeClient, sessionID: string): Promise<Set<string>> {
  let lastFailure: unknown
  for (let attempt = 0; attempt < STARTUP_BASELINE_ATTEMPTS; attempt++) {
    const verifiedReceipts = new Set<string>()
    try {
      const snapshot = await dagWorkflowsBySession(
        client,
        sessionID,
        verifiedReceipts,
        undefined,
        AbortSignal.timeout(STARTUP_BASELINE_TIMEOUT_MS),
      )
      if (snapshot && !snapshot.some((workflow) => workflow.receiptUnknown)) return verifiedReceipts
      lastFailure = new Error(
        snapshot ? "receipt state is temporarily unknown" : "workflow list is temporarily unavailable",
      )
    } catch (error) {
      lastFailure = error
    }
    const delay = STARTUP_BASELINE_RETRY_DELAYS_MS[attempt]
    if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay))
  }
  throw new Error(`Unable to establish the DAG startup baseline after ${STARTUP_BASELINE_ATTEMPTS} attempts`, {
    cause: lastFailure,
  })
}

/** Subscribe first, then await this baseline before starting the prompt. A
 * historic answer already present at startup need not be replayed by the
 * current stream; every later completion must both persist and be emitted. */
export async function createDagRunHold(
  client: OpencodeClient,
  sessionID: string,
  requestedMessageID?: string,
): Promise<DagHold> {
  const verifiedReceipts = await startupBaseline(client, sessionID)
  const baseline = new Set(verifiedReceipts)
  const emitted = new Set<string>()
  const poll = () => dagWorkflowsBySession(client, sessionID, verifiedReceipts, { baseline, emitted })
  return createDagHold(
    poll,
    (part) => {
      const key = answerWasEmitted(part)
      if (key) emitted.add(key)
    },
    requestedMessageID,
  )
}

export * as DagHold from "./dag-hold"
