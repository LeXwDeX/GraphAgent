// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagStore } from "@graphagent/core/dag/store"
import { isTerminalWorkflowStatusValue } from "@graphagent/core/dag/core/types"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Hash } from "@graphagent/core/util/hash"
import { nodeLocationView } from "./location"
import {
  bumpPollState,
  POLL_DELAY_MS,
  prunePollState,
  withPollReadSlot,
  type PollEntry,
} from "./poll-state"

export interface ObserveInput {
  sessionID: string
  workflow_id: string
  node_id?: string
  attempt_id?: string
  limit?: number
  cursor?: string
}
export interface SendInput {
  sessionID: string
  workflow_id: string
  recipient: "node" | "parent"
  node_id?: string
  attempt_id?: string
  idempotency_key: string
  content: string
  reply_to?: string
}
export interface ReceiveInput {
  sessionID: string
  workflow_id?: string
  after_sequence?: number
  limit?: number
  wait_ms?: number
  signal?: AbortSignal
}
export interface Interface {
  observe: (input: ObserveInput) => Effect.Effect<unknown>
  send: (input: SendInput) => Effect.Effect<unknown>
  receive: (input: ReceiveInput) => Effect.Effect<unknown>
}
export class Service extends Context.Service<Service, Interface>()("@graphagent/DagAgentMessages") {}

class ObservationCursor extends Schema.Class<ObservationCursor>("AgentObservationCursor")({
  workflowID: Schema.String,
  nodeID: Schema.optional(Schema.String),
  attemptID: Schema.optional(Schema.String),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}
const CursorJSON = Schema.fromJsonString(ObservationCursor)
const parseCursor = Schema.decodeUnknownResult(CursorJSON)
const maxPreview = 2_000
const ACTIVE_WORKFLOW_STATUS = new Set(["pending", "running", "stepping"])
const isActiveWorkflow = (status: string) => ACTIVE_WORKFLOW_STATUS.has(status)
const limited = (retryAfterMs: number) => ({
  ok: false as const,
  reason: "rate_limited" as const,
  read_performed: false as const,
  retry_after_ms: retryAfterMs,
  hint: "This request did not check for new messages or state. Retry after retry_after_ms using the original cursor.",
})
const emptyFields = (count: number, hint: string, readPerformed?: boolean) => ({
  ...(count >= 3
    ? {
        retry_after_ms: POLL_DELAY_MS,
        ...(readPerformed !== undefined ? { read_performed: readPerformed } : {}),
      }
    : {}),
  next_wake_hint: count >= 3 ? `${hint} Retry after retry_after_ms.` : hint,
  empty_polls: count,
})
// Factual timestamp only; it does not promise that any wake will occur.
const relevantField = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) ? { last_relevant_change_at: new Date(value).toISOString() } : {}
const latestRelevant = (...times: Array<number | undefined>) => {
  let latest: number | undefined
  for (const time of times) {
    if (time !== undefined && Number.isFinite(time) && (latest === undefined || time > latest)) latest = time
  }
  return latest
}
const preview = (value: unknown) => {
  if (value === undefined) return undefined
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return { text: text.slice(0, maxPreview), truncated: text.length > maxPreview }
}
const wireMessage = (message: DagMessages.Message) => ({
  message_id: message.id,
  workflow_id: message.workflowID,
  sender: message.sender,
  recipient: message.recipient,
  recipient_sequence: message.recipientSequence,
  accepted_revision: message.acceptedRevision,
  content: message.content,
  reply_to: message.replyTo,
  state: message.state,
  reason: message.reason,
  snapshot_id: message.snapshotID,
  time_created: message.timeCreated,
  // #949: ISO twin of time_created. Additive — existing consumers keep the
  // numeric field they already read.
  created_at: new Date(message.timeCreated).toISOString(),
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const messages = yield* DagMessages.Service
    const store = yield* DagStore.Service
    const sessions = yield* Session.Service
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        const disposed = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() => Deferred.succeed(disposed, undefined))
        return { disposed, emptyPolls: new Map<string, PollEntry>() }
      }),
    )
    const caller = (sessionID: string) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        return { projectID: instance.project.id, directory: instance.directory, sessionID }
      })

    // Durable DagStore predicates: never infer pending wakes from transient flags.
    const hasPendingWake = (workflow: DagStore.WorkflowRow) =>
      Effect.gen(function* () {
        const workflows = yield* store.getUnreportedWakeWorkflows(workflow.sessionId)
        if (workflows.some((row) => row.id === workflow.id)) return true
        const unreported = yield* store.getUnreportedWakeNodes(workflow.sessionId)
        return unreported.some((node) => node.workflowId === workflow.id)
      })
    const currentAttemptHint = (node: DagStore.NodeRow, endpoint: DagMessages.Endpoint) => {
      if (!node.childSessionId) return undefined
      const attemptID = DagMessages.nodeAttemptID(node.childSessionId, node.replanAttempts)
      if (node.status !== "running" || endpoint.attemptID !== attemptID) return undefined
      return "No new messages. Parent replies are processed only while this attempt is running and this session can continue; model processing is not guaranteed."
    }
    const deliveryHint = (
      identity: DagMessages.Caller,
      workflowID: string | undefined,
      current: DagStore.WorkflowRow | undefined,
      nodes: DagStore.NodeRow[] | undefined,
    ) =>
      Effect.gen(function* () {
        const own = yield* messages.revisions(identity)
        if (!own.ok) return own
        const endpoint = own.value.endpoint
        const scope = workflowID ?? endpoint.workflowID
        const scopedCurrent = workflowID ? current : scope ? yield* store.getWorkflow(scope) : undefined
        const scopedNodes = workflowID ? (nodes ?? []) : scope ? yield* store.getNodes(scope) : []
        // Classify the endpoint first: a child must never inherit the parent's
        // durable-wake hint. Its own attempt status decides the hint.
        if (endpoint.kind === "node") {
          const node = scopedNodes.find(
            (row) => !row.superseded && row.childSessionId === identity.sessionID,
          )
          // Without durable node evidence, do not infer staleness from a missing row.
          if (!node)
            return {
              ok: true as const,
              value:
                "No new messages. A message can be delivered automatically when this session can continue; model processing is not guaranteed.",
            }
          const running = currentAttemptHint(node, endpoint)
          return {
            ok: true as const,
            value:
              running ??
              "No new messages. This attempt is no longer current, so parent replies are not processed for it.",
          }
        }
        if (scope && scopedCurrent && isTerminalWorkflowStatusValue(scopedCurrent.status)) {
          return {
            ok: true as const,
            value: (yield* hasPendingWake(scopedCurrent))
              ? "No new messages. Workflow is terminal but a durable wake is pending; delivery is attempted only if the owning instance is running, directory ownership matches, and the session becomes idle; delivery is not guaranteed, and model processing is not guaranteed. Assistant errors can suppress mailbox delivery until new context is admitted."
              : "No new messages. Workflow is terminal and no durable wake is pending; no further wake is assured.",
          }
        }
        if (scope && scopedCurrent) {
          if (identity.sessionID !== scopedCurrent.sessionId)
            return {
              ok: true as const,
              value: "No new messages. This attempt is no longer current, so parent replies are not processed for it.",
            }
          const eligible = yield* hasPendingWake(scopedCurrent)
          return {
            ok: true as const,
            value: eligible
              ? "No new messages. A durable reporting-checkpoint, escalation, or timeout-extension wake is pending; delivery is attempted only if the owning instance is running, directory ownership matches, and the session becomes idle; delivery is not guaranteed, and model processing is not guaranteed. Assistant errors can suppress mailbox delivery until new context is admitted."
              : "No new messages; no durable reporting-checkpoint, escalation, or timeout-extension wake is pending; no future wake is assured, and model processing is not guaranteed. Assistant errors can suppress mailbox delivery until new context is admitted.",
          }
        }
        const pending = (yield* store.getUnreportedWakeWorkflows(identity.sessionID)).length > 0 ||
          (yield* store.getUnreportedWakeNodes(identity.sessionID)).length > 0
        return {
          ok: true as const,
          value: pending
            ? "No new messages. A durable wake is pending; delivery is attempted only if the owning instance is running, directory ownership matches, and the session becomes idle. Model processing is not guaranteed. Assistant errors can suppress mailbox delivery until new context is admitted."
            : "No new messages; no durable wake is pending and no future wake is assured. Assistant errors can suppress mailbox delivery until new context is admitted.",
        }
      })

    const lastRelevantChange = (
      identity: DagMessages.Caller,
      workflowID: string | undefined,
      workflowTime: number | undefined,
      mailboxTimes: number[] = [],
    ) =>
      Effect.gen(function* () {
        const nodeTime = workflowID && store.getLastNodeChange ? yield* store.getLastNodeChange(workflowID) : undefined
        if (messages.latestMessageAt) {
          const mailbox = yield* messages.latestMessageAt(identity, workflowID)
          if (!mailbox.ok) return mailbox
          return { ok: true as const, value: latestRelevant(workflowTime, nodeTime, mailbox.value, ...mailboxTimes) }
        }
        return { ok: true as const, value: latestRelevant(workflowTime, nodeTime, ...mailboxTimes) }
      })

    return Service.of({
      observe: Effect.fn("DagAgentMessages.observe")(function* (input) {
        const identity = yield* caller(input.sessionID)
        if (input.attempt_id && !input.node_id) return { ok: false, reason: "invalid" }
        const permission = yield* messages.resolve(identity, input.workflow_id)
        if (!permission.ok) return permission
        const own = yield* messages.identify(identity, input.workflow_id)
        if (!own.ok) return own
        const workflow = yield* store.getWorkflow(input.workflow_id)
        if (!workflow) return { ok: false, reason: "unauthorized" }
        // Only the owner observes the graph; a node can inspect its own attempt.
        if (workflow.sessionId !== input.sessionID) {
          const self = (yield* store.getNodes(input.workflow_id)).find((row) => row.childSessionId === input.sessionID)
          if (!self || input.node_id !== self.id) return { ok: false, reason: "unauthorized" }
        }
        let offset = 0
        if (input.cursor !== undefined) {
          const parsed = parseCursor(input.cursor)
          if (
            parsed._tag === "Failure" ||
            parsed.success.workflowID !== input.workflow_id ||
            parsed.success.nodeID !== input.node_id ||
            parsed.success.attemptID !== input.attempt_id
          ) {
            return { ok: false, reason: "invalid_cursor" }
          }
          offset = parsed.success.offset
        }
        const limit = input.limit ?? 20
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return { ok: false, reason: "invalid" }
        const instanceState = yield* InstanceState.get(state)
        const polls = instanceState.emptyPolls
        prunePollState(polls)
        const cursorKey = input.cursor === undefined ? "none" : Hash.sha256(input.cursor)
        const pollKey = JSON.stringify(["observe", own.value.id, input.workflow_id, input.node_id, input.attempt_id, limit, cursorKey])
        const outcome = yield* withPollReadSlot(polls, pollKey, POLL_DELAY_MS, () => 0, () =>
          Effect.gen(function* () {
            // Re-check authority after the cooldown: ownership may have moved
            // while this call was queued or delayed.
            const delayedPermission = yield* messages.resolve(identity, input.workflow_id)
            if (!delayedPermission.ok) return delayedPermission
            const all = (yield* store.getNodes(input.workflow_id))
              .filter((row) => !input.node_id || row.id === input.node_id)
              .toSorted((a, b) => a.id.localeCompare(b.id))
            const mailboxTimes: number[] = []
            let authorityLost = false
            const nodes = yield* Effect.forEach(all.slice(offset, offset + limit), (row) =>
              Effect.gen(function* () {
                const observedAttempt = row.childSessionId
                  ? DagMessages.nodeAttemptID(row.childSessionId, row.replanAttempts)
                  : undefined
                const revisions = yield* messages.metadata(
                  identity,
                  input.workflow_id,
                  row.id,
                  input.attempt_id ?? observedAttempt,
                )
                if (revisions.ok && revisions.value.lastMessageAt !== undefined)
                  mailboxTimes.push(revisions.value.lastMessageAt)
                if (!revisions.ok && revisions.reason === "unauthorized") {
                  authorityLost = true
                  return undefined
                }
                if (input.attempt_id && !revisions.ok) return undefined
                // An authorization or attempt race cannot fall back to an unverified
                // child session from a separate projection read.
                const childSessionID = revisions.ok ? revisions.value.endpoint.sessionID : undefined
                const historical = row.superseded || (!!input.attempt_id && input.attempt_id !== observedAttempt)
                const transcript = childSessionID
                  ? yield* sessions
                      .messages({ sessionID: SessionID.make(childSessionID), limit: 3 })
                      .pipe(Effect.catch(() => Effect.succeed([])))
                  : []
                const tools = transcript
                  .flatMap((message) => message.parts)
                  .filter((part) => part.type === "tool")
                  .slice(-10)
                  .map((part) => ({ tool: part.tool, status: part.state.status }))
                const progress = transcript
                  .toSorted((a, b) => a.info.time.created - b.info.time.created)
                  .flatMap((message) => (message.info.role === "assistant" ? message.parts : []))
                  .flatMap((part) => (part.type === "text" && !part.synthetic ? [part] : []))
                  .slice(-1)
                  .map((part) => preview(part.text))[0]
                return {
                  node_id: row.id,
                  name: row.name,
                  status: historical
                    ? revisions.ok
                      ? (revisions.value.closedReason ?? "historical")
                      : "historical"
                    : row.status,
                  historical,
                  attempt_id: revisions.ok ? revisions.value.endpoint.attemptID : undefined,
                  accepted_input_revision: revisions?.ok ? revisions.value.accepted : 0,
                  snapshot_revision: revisions?.ok ? revisions.value.snapshot : 0,
                  message_counts: revisions?.ok
                    ? {
                        queued: revisions.value.queued,
                        delivered: revisions.value.delivered,
                        undeliverable: revisions.value.undeliverable,
                      }
                    : { queued: 0, delivered: 0, undeliverable: 0 },
                  projection_sequence: row.seq,
                  closed_reason: revisions.ok ? revisions.value.closedReason : undefined,
                  // #949: where this attempt ran, the HEAD it started from,
                  // and when the row last changed. Absent until the attempt
                  // records them.
                  ...nodeLocationView(row),
                  progress,
                  output:
                    !historical && (row.status === "completed" || row.output !== null)
                      ? preview(row.output)
                      : undefined,
                  tools,
                }
              }),
            )
            if (authorityLost) return { ok: false, reason: "unauthorized" }
            // Refresh after the scan so status and timestamps are not stale
            // after a queued or rate-limited read.
            const current = yield* store.getWorkflow(input.workflow_id)
            if (!current) return { ok: false, reason: "unauthorized" }
            const visible = nodes.filter((node) => node !== undefined)
            const active = isActiveWorkflow(current.status)
            const change = Hash.sha256(JSON.stringify({
              status: current.status,
              graph: current.graphRev,
              nodes: visible.map(({ last_activity_at: _activity, ...node }) => node),
              all: all.map((row) => [row.id, row.seq, row.status, row.superseded]),
            }))
            const emptyPolls = bumpPollState(
              polls,
              pollKey,
              active,
              Date.now(),
              change,
            )
            const selected = input.node_id ? all[0] : undefined
            // A node row timestamp is only safe without an exact attempt filter:
            // with attempt_id, a replan can replace the row between getNodes and
            // getNodeTime, so only the authorized attempt mailbox time is used.
            const nodeTime =
              input.node_id && !input.attempt_id && selected && store.getNodeTime
                ? yield* store.getNodeTime(input.workflow_id, selected.id)
                : undefined
            const relevant = input.node_id
              ? { ok: true as const, value: latestRelevant(nodeTime, ...mailboxTimes) }
              : yield* lastRelevantChange(identity, input.workflow_id, current.timeUpdated, mailboxTimes)
            if (!relevant.ok) return relevant
            const terminal = isTerminalWorkflowStatusValue(current.status)
            const hint =
              (visible.length === 0 || emptyPolls > 1) && (active || terminal)
                ? yield* deliveryHint(identity, input.workflow_id, current, all)
                : undefined
            if (hint && !hint.ok) return hint
            // Re-check after every query, before exposing protected workflow state.
            const finalPermission = yield* messages.resolve(identity, input.workflow_id)
            if (!finalPermission.ok) return finalPermission
            return {
              ok: true,
              workflow_id: current.id,
              status: current.status,
              graph_rev: current.graphRev,
              projection_sequence: current.seq,
              observed_at: Date.now(),
              freshness: "durable_reads_nonatomic",
              nodes: visible,
              next_cursor:
                offset + limit < all.length
                  ? JSON.stringify({
                      workflowID: input.workflow_id,
                      nodeID: input.node_id,
                      attemptID: input.attempt_id,
                      offset: offset + limit,
                    })
                  : undefined,
              ...relevantField(relevant.value),
              ...(hint ? emptyFields(emptyPolls, visible.length ? hint.value.replace(/^No new messages[.;]/, "No relevant changes since the previous observation;") : hint.value) : {}),
            }
          }), (value) => value.ok,
        )
        if (outcome.kind === "rate_limited") {
          const finalPermission = yield* messages.resolve(identity, input.workflow_id)
          if (!finalPermission.ok) return finalPermission
          const finalIdentity = yield* messages.identify(identity, input.workflow_id)
          if (!finalIdentity.ok) return finalIdentity
          if (finalIdentity.value.id !== own.value.id) return { ok: false, reason: "unauthorized" }
          return limited(outcome.retryAfterMs)
        }
        return outcome.value
      }),
      send: Effect.fn("DagAgentMessages.send")(function* (input) {
        const result = yield* messages.send(yield* caller(input.sessionID), {
          workflowID: input.workflow_id,
          nodeID: input.recipient === "node" ? input.node_id : undefined,
          attemptID: input.recipient === "node" ? input.attempt_id : undefined,
          idempotencyKey: input.idempotency_key,
          content: input.content,
          replyTo: input.reply_to,
        })
        return result.ok ? { ok: true, ...wireMessage(result.value) } : result
      }),
      receive: Effect.fn("DagAgentMessages.receive")(function* (input) {
        if (input.signal?.aborted) return yield* Effect.interrupt
        const identity = yield* caller(input.sessionID)
        const requestedWait = input.wait_ms ?? 0
        const limit = input.limit ?? 20
        if (
          !Number.isSafeInteger(requestedWait) ||
          requestedWait < 0 ||
          requestedWait > 30_000 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 50
        ) {
          return { ok: false, reason: "invalid" }
        }
        if (input.after_sequence !== undefined && (!Number.isSafeInteger(input.after_sequence) || input.after_sequence < 0))
          return { ok: false, reason: "invalid" }
        if (input.workflow_id) {
          const permission = yield* messages.resolve(identity, input.workflow_id)
          if (!permission.ok) return permission
        }
        const instanceState = yield* InstanceState.get(state)
        const polls = instanceState.emptyPolls
        prunePollState(polls)
        const own = yield* messages.identify(identity, input.workflow_id)
        if (!own.ok) return own
        const pollKey = JSON.stringify(["receive", own.value.id, input.workflow_id, input.after_sequence, limit])
        const deadline = Date.now() + requestedWait
        const recheckPermission = () =>
          input.workflow_id ? messages.resolve(identity, input.workflow_id) : Effect.succeed({ ok: true } as const)
        const read = () =>
          messages.receive(identity, { workflowID: input.workflow_id, afterSequence: input.after_sequence, limit })
        const readOutcome = (entry: PollEntry, first: boolean) =>
          Effect.gen(function* () {
            const permission = yield* recheckPermission()
            if (!permission.ok) return { permission }
            const result = yield* read()
            if (!result.ok) return { result, received: [], active: true, count: entry.count }
            const received = result.value.filter(
              (message) => !input.workflow_id || message.workflowID === input.workflow_id,
            )
            const current = input.workflow_id ? yield* store.getWorkflow(input.workflow_id) : undefined
            const active =
              input.workflow_id === undefined || (current !== undefined && isActiveWorkflow(current.status))
            const count = first || received.length > 0
              ? bumpPollState(polls, pollKey, true, Date.now(), Hash.sha256(JSON.stringify([received, current?.status, current?.graphRev])))
              : (polls.get(pollKey)?.count ?? entry.count)
            return { result, received, active, count, time: current?.timeUpdated, observedAt: Date.now() }
          })
        const poll = Effect.gen(function* () {
          let firstRead = true
          let previous: Effect.Success<ReturnType<typeof readOutcome>> | undefined
          while (true) {
            const outcome = firstRead
              ? yield* withPollReadSlot(
                  polls,
                  pollKey,
                  POLL_DELAY_MS,
                  () => Math.max(0, deadline - Date.now()),
                  (entry) => readOutcome(entry, true),
                  (value) => !("permission" in value) && value.result.ok,
                )
              : yield* withPollReadSlot(polls, pollKey, 0, () => 0, (entry) => readOutcome(entry, false),
                  (value) => !("permission" in value) && value.result.ok)
            firstRead = false
            if (outcome.kind === "rate_limited" && !previous) {
              const permission = yield* recheckPermission()
              if (!permission.ok) return permission
              const finalIdentity = yield* messages.identify(identity, input.workflow_id)
              if (!finalIdentity.ok) return finalIdentity
              if (finalIdentity.value.id !== own.value.id) return { ok: false, reason: "unauthorized" }
              return limited(outcome.retryAfterMs)
            }
            const blockedAfterRead = outcome.kind === "rate_limited"
            const value = outcome.kind === "read" ? outcome.value : previous
            if (!value) return limited(POLL_DELAY_MS)
            if (blockedAfterRead) {
              const finalIdentity = yield* messages.identify(identity, input.workflow_id)
              if (!finalIdentity.ok) return finalIdentity
              if (finalIdentity.value.id !== own.value.id) return { ok: false, reason: "unauthorized" }
              // A read raced with contention or a cooldown. Report an explicit
              // retryable rejection instead of replaying stale messages/cursor
              // as if this request had observed them.
              return limited(outcome.retryAfterMs)
            }
            previous = value
            if ("permission" in value) return value.permission
            if (!value.result.ok) {
              const permission = yield* recheckPermission()
              if (!permission.ok) return permission
              return value.result
            }
            if (value.received.length > 0) {
              const current = value.count > 1 && input.workflow_id ? yield* store.getWorkflow(input.workflow_id) : undefined
              const nodes = value.count > 1 && input.workflow_id ? yield* store.getNodes(input.workflow_id) : undefined
              const relevant = value.count > 1
                ? yield* lastRelevantChange(identity, input.workflow_id, current?.timeUpdated, value.received.map((message) => message.timeCreated))
                : undefined
              if (relevant && !relevant.ok) return relevant
              const hint = value.count > 1 ? yield* deliveryHint(identity, input.workflow_id, current, nodes) : undefined
              if (hint && !hint.ok) return hint
              const permission = yield* recheckPermission()
              if (!permission.ok) return permission
              return {
                ok: true,
                messages: value.received.map(wireMessage),
                cursor: value.result.value.at(-1)?.recipientSequence ?? input.after_sequence ?? 0,
                observed_at: Date.now(),
                ...(relevant ? relevantField(relevant.value) : {}),
                ...(hint ? emptyFields(value.count, hint.value.replace(/^No new messages[.;]/, "No relevant changes since the previous read;"), true) : {}),
              }
            }
            if (!value.active || value.count >= 3 || Date.now() >= deadline) {
              // Refresh after the read so a terminal transition is not reported
              // from a stale status.
              const latest = input.workflow_id ? yield* store.getWorkflow(input.workflow_id) : undefined
              const active =
                input.workflow_id === undefined || (latest !== undefined && isActiveWorkflow(latest.status))
              const nodes = input.workflow_id ? yield* store.getNodes(input.workflow_id) : undefined
              const relevant = active
                ? yield* lastRelevantChange(identity, input.workflow_id, latest?.timeUpdated)
                : undefined
              if (relevant && !relevant.ok) return relevant
              const permission = yield* recheckPermission()
              if (!permission.ok) return permission
              const delivery = yield* deliveryHint(identity, input.workflow_id, latest, nodes)
              if (!delivery.ok) return delivery
              return {
                ok: true,
                messages: [],
                cursor: value.result.value.at(-1)?.recipientSequence ?? input.after_sequence ?? 0,
                observed_at: value.observedAt,
                ...(active ? relevantField(relevant?.value) : {}),
                ...emptyFields(
                  polls.get(pollKey)?.count ?? value.count,
                  delivery.value,
                  true,
                ),
              }
            }
            yield* Effect.sleep(Math.min(100, Math.max(0, deadline - Date.now())))
          }
        })
        const disposed = instanceState.disposed
        const abort = Effect.callback<never>((resume) => {
          const cancel = () => resume(Effect.interrupt)
          if (input.signal?.aborted) return cancel()
          input.signal?.addEventListener("abort", cancel, { once: true })
          return Effect.sync(() => input.signal?.removeEventListener("abort", cancel))
        })
        return yield* Effect.raceFirst(
          poll,
          Effect.raceFirst(abort, Deferred.await(disposed).pipe(Effect.andThen(Effect.interrupt))),
        )
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(DagMessages.defaultLayer),
  Layer.provide(DagStore.defaultLayer),
  Layer.provide(Session.defaultLayer),
)
export const node = LayerNode.make(layer, [DagMessages.node, DagStore.node, Session.node])
export * as DagAgentMessages from "./agent-messages"
