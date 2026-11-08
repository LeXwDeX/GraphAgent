// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

export * as DagMessages from "./messages"

import { randomUUID } from "node:crypto"
import { resolve as resolvePath } from "node:path"
import { sql } from "drizzle-orm"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { Context, Effect, Layer, PubSub, Stream } from "effect"
import { SqlError } from "effect/sql/SqlError"
import { Database } from "../database/database"
import { LayerNode } from "../effect/layer-node"
import { Identifier } from "../id/id"

export interface Caller {
  projectID: string
  directory: string
  sessionID: string
}
export interface Endpoint {
  id: string
  kind: "main" | "node"
  sessionID: string
  workflowID?: string
  nodeID?: string
  attemptID?: string
}
export interface Send {
  workflowID: string
  nodeID?: string
  attemptID?: string
  idempotencyKey: string
  content: string
  replyTo?: string
}
export interface Message {
  id: string
  workflowID: string
  sender: Endpoint
  recipient: Endpoint
  recipientSequence: number
  acceptedRevision: number
  content: string
  replyTo?: string
  state: "queued" | "delivered" | "undeliverable"
  reason?: string
  snapshotID?: string
  transcriptID: string
  partID: string
  timeCreated: number
}
export interface Snapshot {
  id: string
  mailboxID: string
  logicalTurnID: string
  revision: number
  messages: Message[]
  associated: boolean
  stopReason?: string
}
export type Rejection = {
  ok: false
  reason:
    | "unauthorized"
    | "closed"
    | "stale_attempt"
    | "conflict"
    | "capacity"
    | "invalid"
    | "stale_input"
    | "unassociated"
    | "stopped"
}
export type Result<A> = { ok: true; value: A } | Rejection
export interface Guard {
  workflowID: string
  nodeID: string
  attemptID: string
  snapshotID?: string
  close?: boolean
  /** Conditional failure applies only to this accepted revision, checked in the settlement transaction. */
  expectedAcceptedRevision?: number
  /** Response-derived failure must still own its original associated input snapshot. */
  requireCurrentInput?: boolean
  /** Failure/cancellation outranks pending input unless explicitly made conditional. */
  failureReason?: string
}
export interface Metadata {
  endpoint: Endpoint
  accepted: number
  snapshot: number
  snapshotID?: string
  queued: number
  delivered: number
  undeliverable: number
  closedReason?: string
  /** Latest durable message timestamp for this mailbox (optionally workflow-scoped). */
  lastMessageAt?: number
}
/** One committed mailbox change, published after the mutating transaction commits. */
export interface Change {
  /** Absent for a main (parent-session) mailbox, whose row carries no workflow. */
  workflowID?: string
  nodeID?: string
  recipientSessionID: string
  /** Recipient session directory, for routing the process-level stream to an instance. */
  directory: string
  kind: "queued" | "delivered" | "undeliverable" | "closed"
  /** Post-commit `agent_mailbox.change_seq`; monotonic per mailbox and stable for replay. */
  mailboxVersion: number
}
export interface Interface {
  /**
   * Process-scoped mailbox change stream. Every mailbox mutation publishes
   * exactly one event only after its transaction commits; a rollback or a
   * no-op publishes nothing. Consumers treat events as invalidation nudges.
   */
  readonly changed: Stream.Stream<Change>
  /** Host-only event/projection boundary. No provider or other remote I/O inside commit. */
  /**
   * Run `commit` in the workflow's immediate transaction, then close any
   * still-live mailbox. `reason` may be computed from the committed result so
   * a transition that resolves to a no-op does not close a live channel.
   */
  fenceWorkflow: <A, E, R>(
    workflowID: string,
    reason: string | undefined | ((result: A) => string | undefined),
    commit: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  resolve: (caller: Caller, workflowID: string, nodeID?: string) => Effect.Effect<Result<Endpoint>>
  /** Authenticate the caller's current mailbox identity without reading or creating messages. */
  identify: (caller: Caller, workflowID?: string) => Effect.Effect<Result<Endpoint>>
  send: (caller: Caller, request: Send) => Effect.Effect<Result<Message>>
  receive: (
    caller: Caller,
    input?: { workflowID?: string; afterSequence?: number; limit?: number; queuedOnly?: boolean },
  ) => Effect.Effect<Result<Message[]>>
  metadata: (caller: Caller, workflowID: string, nodeID?: string, attemptID?: string) => Effect.Effect<Result<Metadata>>
  freeze: (caller: Caller, logicalTurnID: string) => Effect.Effect<Result<Snapshot>>
  /** Call only after assembling actual input; persisted transcript parts are verified here. */
  associate: (caller: Caller, snapshotID: string) => Effect.Effect<Result<Snapshot>>
  /** Latest frozen turn, including preparation failures before actual input association. */
  latestSnapshot: (caller: Caller) => Effect.Effect<Result<Snapshot | undefined>>
  /** One durable result resubmission per accepted revision of the exact node attempt. */
  claimResultNudge: (caller: Caller, acceptedRevision: number) => Effect.Effect<Result<boolean>>
  snapshotForTurn: (caller: Caller, logicalTurnID: string) => Effect.Effect<Result<Snapshot | undefined>>
  snapshotByID: (caller: Caller, snapshotID: string) => Effect.Effect<Result<Snapshot | undefined>>
  discardPending: (caller: Caller, reason: string) => Effect.Effect<void>
  markStopped: (caller: Caller, snapshotID: string, reason: string) => Effect.Effect<void>
  guard: <A, E, R>(caller: Caller, input: Guard, commit: Effect.Effect<A, E, R>) => Effect.Effect<Result<A>, E, R>
  closeSession: (sessionID: string, reason: string) => Effect.Effect<void>
  closeWorkflow: (workflowID: string, reason: string) => Effect.Effect<void>
  reconcile: (caller: Caller) => Effect.Effect<void>
  revisions: (caller: Caller) => Effect.Effect<Result<Metadata>>
  /** Latest message timestamp for the caller's mailbox, optionally scoped to one workflow. */
  latestMessageAt?: (caller: Caller, workflowID?: string) => Effect.Effect<Result<number | undefined>>
  pendingRecipients: (scope: {
    projectID: string
    directory: string
    limit?: number
    afterSessionID?: string
  }) => Effect.Effect<Endpoint[]>
}
export class Service extends Context.Service<Service, Interface>()("@graphagent/v2/DagMessages") {}

type DB = Database.Interface["db"]
type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0]
type Workflow = { id: string; project_id: string; session_id: string; directory: string; execution_directory: string | null; status: string }
type Node = {
  id: string
  workflow_id: string
  child_session_id: string | null
  directory: string | null
  status: string
  superseded: number
  replan_attempts: number
}
type Session = { id: string; project_id: string; directory: string; time_created: number; parent_id: string | null }
type Mailbox = {
  id: string
  session_id: string
  workflow_id: string | null
  node_id: string | null
  attempt_id: string | null
  revision: number
  closed_reason: string | null
  result_nudge_revision: number
}
type StoredMessage = {
  id: string
  workflow_id: string
  sender: string
  recipient: string
  request: string
  content: string
  reply_to: string | null
  recipient_sequence: number
  accepted_revision: number
  state: Message["state"]
  reason: string | null
  snapshot_id: string | null
  transcript_id: string
  part_id: string
  time_created: number
}
type StoredSnapshot = {
  id: string
  mailbox_id: string
  logical_turn_id: string
  revision: number
  message_ids: string
  associated: number
  stop_reason: string | null
}
const success = <A>(value: A): Result<A> => ({ ok: true, value })
const reject = (reason: Rejection["reason"]): Rejection => ({ ok: false, reason })
const liveWorkflow = (status: string) => ["pending", "running", "paused", "stepping"].includes(status)
const liveNode = (node: Node) => !node.superseded && node.status === "running" && !!node.child_session_id
export const nodeAttemptID = (sessionID: string, replanAttempts: number) => `${sessionID}:${replanAttempts}`
const attempt = (node: Node) => nodeAttemptID(node.child_session_id ?? "", node.replan_attempts)
const mapMessage = (r: StoredMessage): Message => ({
  id: r.id,
  workflowID: r.workflow_id,
  sender: JSON.parse(r.sender),
  recipient: JSON.parse(r.recipient),
  recipientSequence: r.recipient_sequence,
  acceptedRevision: r.accepted_revision,
  content: r.content,
  replyTo: r.reply_to ?? undefined,
  state: r.state,
  reason: r.reason ?? undefined,
  snapshotID: r.snapshot_id ?? undefined,
  transcriptID: r.transcript_id,
  partID: r.part_id,
  timeCreated: r.time_created,
})

/** Model-visible provenance. Agent content carries no human authorization. */
export const renderMessage = (message: Message): string =>
  JSON.stringify({
    kind: "dag_agent_message",
    workflow_id: message.workflowID,
    sender: message.sender,
    recipient: message.recipient,
    message_id: message.id,
    content: message.content,
  })

/** The IMMEDIATE transaction obtains SQLite's write reservation before any authority read.
 * Every acceptance, freeze, association and settlement uses this boundary. Other SQL writes
 * in the same Effect fiber (including Event.publish/projectors) reuse that transaction.
 * Messages/snapshots are source tables: DAG event replay must leave them intact.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const client = db.$client
    // Process-scoped change stream: mutations collect events inside their
    // transaction and publish only after COMMIT. Unlike durable Event rows,
    // these are invalidation nudges — a lost event costs a rescan, never state.
    const changed = yield* PubSub.unbounded<Change>()
    yield* Effect.addFinalizer(() => PubSub.shutdown(changed))
    const publish = (changes: readonly Change[]) =>
      Effect.forEach(changes, (change) => PubSub.publish(changed, change), { discard: true })
    // Registered on the innermost transaction level, so the client runs it
    // after the *outermost* COMMIT — a released savepoint hands its callbacks
    // to the enclosing level — and discards it when that transaction rolls
    // back. Publishing after `db.transaction` returns instead would emit
    // events of a nested level whose enclosing transaction later rolls back.
    const afterCommit = (changes: readonly Change[]) =>
      changes.length === 0 ? Effect.void : client.afterCommit(publish(changes))
    const transaction = <A, E, R>(body: (tx: Tx, changes: Change[]) => Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const changes: Change[] = []
        return db
          .transaction((tx) => body(tx, changes).pipe(Effect.tap(() => afterCommit(changes))), {
            behavior: "immediate",
          })
          .pipe(Effect.orDie)
      })
    const read = <A, E, R>(body: (tx: Tx) => Effect.Effect<A, E, R>) => db.transaction(body).pipe(Effect.orDie)
    const workflow = (tx: Tx, id: string) => tx.get<Workflow>(sql`SELECT * FROM workflow WHERE id = ${id}`)
    const node = (tx: Tx, workflowID: string, nodeID: string) =>
      tx.get<Node>(sql`SELECT * FROM workflow_node WHERE workflow_id = ${workflowID} AND id = ${nodeID}`)
    const session = (tx: Tx, id: string) =>
      tx.get<Session>(sql`SELECT id, project_id, directory, time_created, parent_id FROM session WHERE id = ${id}`)
    const authorizedSession = (caller: Caller, s: Session | undefined) =>
      !!s && s.project_id === caller.projectID && resolvePath(s.directory) === resolvePath(caller.directory)
    const workflowParent = (tx: Tx, wf: Workflow) =>
      Effect.gen(function* () {
        const parent = yield* session(tx, wf.session_id)
        return parent &&
          wf.directory &&
          parent.project_id === wf.project_id &&
          resolvePath(parent.directory) === resolvePath(wf.directory)
          ? parent
          : undefined
      })
    const boundChild = (wf: Workflow, n: Node, s: Session | undefined) => {
      const directory = n.directory ?? wf.execution_directory ?? wf.directory
      return (
        !!s &&
        !!directory &&
        s.id === n.child_session_id &&
        s.project_id === wf.project_id &&
        s.parent_id === wf.session_id &&
        resolvePath(s.directory) === resolvePath(directory)
      )
    }
    const main = (s: Session): Endpoint => ({
      id: JSON.stringify(["main", s.id, s.time_created]),
      kind: "main",
      sessionID: s.id,
    })
    const child = (n: Node): Endpoint => ({
      id: JSON.stringify(["node", n.workflow_id, n.id, n.child_session_id, n.replan_attempts]),
      kind: "node",
      sessionID: n.child_session_id!,
      workflowID: n.workflow_id,
      nodeID: n.id,
      attemptID: attempt(n),
    })
    const owner = (tx: Tx, caller: Caller, wf: Workflow) =>
      Effect.gen(function* () {
        const s = yield* session(tx, caller.sessionID)
        if (!authorizedSession(caller, s) || wf.project_id !== caller.projectID || !(yield* workflowParent(tx, wf)))
          return undefined
        if (wf.session_id === caller.sessionID) return main(s!)
        const n = yield* tx.get<Node>(
          sql`SELECT * FROM workflow_node WHERE workflow_id = ${wf.id} AND child_session_id = ${caller.sessionID}`,
        )
        return n && !n.superseded && n.status !== "pending" && n.status !== "queued" && boundChild(wf, n, s)
          ? child(n)
          : undefined
      })
    const self = (tx: Tx, caller: Caller) =>
      Effect.gen(function* () {
        const s = yield* session(tx, caller.sessionID)
        if (!authorizedSession(caller, s)) return undefined
        const n = yield* tx.get<Node>(
          sql`SELECT * FROM workflow_node WHERE child_session_id = ${caller.sessionID} LIMIT 1`,
        )
        if (!n) {
          const historical = yield* tx.get<{ id: string }>(
            sql`SELECT id FROM agent_mailbox WHERE session_id = ${caller.sessionID} AND node_id IS NOT NULL LIMIT 1`,
          )
          return historical ? undefined : main(s!)
        }
        const wf = yield* workflow(tx, n.workflow_id)
        return wf && (yield* owner(tx, caller, wf))
      })
    const mailbox = (tx: Tx, endpoint: Endpoint) =>
      Effect.gen(function* () {
        yield* tx.run(sql`INSERT INTO agent_mailbox (id,session_id,workflow_id,node_id,attempt_id,revision,time_created)
      VALUES (${endpoint.id},${endpoint.sessionID},${endpoint.workflowID ?? null},${endpoint.nodeID ?? null},${endpoint.attemptID ?? null},0,${Date.now()}) ON CONFLICT(id) DO NOTHING`)
        return (yield* tx.get<Mailbox>(sql`SELECT * FROM agent_mailbox WHERE id = ${endpoint.id}`))!
      })
    const snapshot = (tx: Tx, row: StoredSnapshot) =>
      Effect.gen(function* () {
        const messages: Message[] = []
        const ids: unknown = JSON.parse(row.message_ids)
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new Error("Invalid message snapshot")
        for (const id of ids) {
          const m = yield* tx.get<StoredMessage>(sql`SELECT * FROM agent_message WHERE id = ${id}`)
          if (!m) throw new Error(`Message snapshot ${row.id} refers to missing message ${id}`)
          messages.push(mapMessage(m))
        }
        return {
          id: row.id,
          mailboxID: row.mailbox_id,
          logicalTurnID: row.logical_turn_id,
          revision: row.revision,
          messages,
          associated: !!row.associated,
          stopReason: row.stop_reason ?? undefined,
        }
      })
    const directory = (tx: Tx, sessionID: string) =>
      tx.get<{ directory: string }>(sql`SELECT directory FROM session WHERE id = ${sessionID}`)
    const change = (
      box: Pick<Mailbox, "session_id" | "workflow_id" | "node_id">,
      directory: string | undefined,
      kind: Change["kind"],
      mailboxVersion: number,
    ): Change => ({
      ...(box.workflow_id ? { workflowID: box.workflow_id } : {}),
      ...(box.node_id ? { nodeID: box.node_id } : {}),
      recipientSessionID: box.session_id,
      directory: directory ?? "",
      kind,
      mailboxVersion,
    })
    /** Bump the mailbox version and queue its post-commit event. */
    const record = (tx: Tx, box: Mailbox, kind: Change["kind"], changes: Change[]) =>
      Effect.gen(function* () {
        const updated = yield* tx.get<{ change_seq: number }>(
          sql`UPDATE agent_mailbox SET change_seq = change_seq + 1 WHERE id = ${box.id} RETURNING change_seq`,
        )
        if (!updated) return
        const session = yield* directory(tx, box.session_id)
        changes.push(change(box, session?.directory, kind, updated.change_seq))
      })
    const undeliverable = (tx: Tx, mailboxID: string, reason: string) =>
      tx.all<{ id: string }>(
        sql`UPDATE agent_message SET state = 'undeliverable', reason = ${reason} WHERE recipient_id = ${mailboxID} AND state = 'queued' RETURNING id`,
      )
    const close = (tx: Tx, ids: string[], reason: string, changes: Change[]) =>
      Effect.gen(function* () {
        for (const id of ids) {
          const box = yield* tx.get<Mailbox>(sql`SELECT * FROM agent_mailbox WHERE id = ${id}`)
          if (!box) continue
          const released = yield* undeliverable(tx, id, reason)
          // A repeat close with nothing left to release is a no-op.
          if (box.closed_reason !== null && released.length === 0) continue
          yield* tx.run(
            sql`UPDATE agent_mailbox SET closed_reason = COALESCE(closed_reason,${reason}) WHERE id = ${id}`,
          )
          yield* record(tx, box, "closed", changes)
        }
      })
    const metadata = (tx: Tx, endpoint: Endpoint, workflowID?: string) =>
      Effect.gen(function* () {
        const b = yield* tx.get<Mailbox>(sql`SELECT * FROM agent_mailbox WHERE id = ${endpoint.id}`)
        const snap = yield* tx.get<{ id: string; revision: number }>(
          sql`SELECT id,revision FROM agent_input_snapshot WHERE mailbox_id = ${endpoint.id} AND associated = 1 ORDER BY revision DESC,time_created DESC,rowid DESC LIMIT 1`,
        )
        const rows = yield* tx.all<{ state: string; n: number }>(
          sql`SELECT state,COUNT(*) AS n FROM agent_message WHERE recipient_id = ${endpoint.id} GROUP BY state`,
        )
        const latest = yield* tx.get<{ at: number | null }>(
          sql`SELECT MAX(time_created) AS at FROM agent_message WHERE recipient_id = ${endpoint.id} ${workflowID ? sql`AND workflow_id = ${workflowID}` : sql``}`,
        )
        const counts = Object.fromEntries(rows.map((r) => [r.state, r.n]))
        return {
          endpoint,
          accepted: b?.revision ?? 0,
          snapshot: snap?.revision ?? 0,
          snapshotID: snap?.id,
          queued: counts.queued ?? 0,
          delivered: counts.delivered ?? 0,
          undeliverable: counts.undeliverable ?? 0,
          closedReason: b?.closed_reason ?? undefined,
          lastMessageAt: latest?.at ?? undefined,
        }
      })
    return Service.of({
      changed: Stream.fromPubSub(changed),
      identify: (caller, workflowID) =>
        read((tx) =>
          Effect.gen(function* () {
            const endpoint = yield* self(tx, caller)
            if (!endpoint) return reject("unauthorized")
            if (workflowID) {
              const wf = yield* workflow(tx, workflowID)
              if (!wf || !(yield* owner(tx, caller, wf))) return reject("unauthorized")
            }
            return success(endpoint)
          }),
        ),
      fenceWorkflow: (workflowID, reason, commit) =>
        Effect.suspend(() => {
          const changes: Change[] = []
          return db
            .transaction(
              (tx) =>
                Effect.gen(function* () {
                  const result = yield* commit
                  const finalReason = typeof reason === "function" ? reason(result) : reason
                  const boxes = yield* tx.all<Mailbox>(
                    sql`SELECT * FROM agent_mailbox WHERE workflow_id = ${workflowID} AND closed_reason IS NULL`,
                  )
                  const wf = yield* workflow(tx, workflowID)
                  for (const box of boxes) {
                    const n = box.node_id ? yield* node(tx, workflowID, box.node_id) : undefined
                    // A session-level box has no attempt to invalidate. Close it
                    // only on an explicit terminal reason; a no-op commit (for
                    // example a concurrently moved workflow) must leave a live
                    // parent mailbox open.
                    const invalidAttempt =
                      box.node_id !== null &&
                      (!wf || !liveWorkflow(wf.status) || !n || !liveNode(n) || attempt(n) !== box.attempt_id)
                    if (finalReason || invalidAttempt)
                      yield* close(
                        tx,
                        [box.id],
                        finalReason ??
                          (n && attempt(n) !== box.attempt_id
                            ? "attempt_replaced"
                            : n?.superseded
                              ? "cancelled"
                              : "closed"),
                        changes,
                      )
                  }
                  return result
                }).pipe(Effect.tap(() => afterCommit(changes))),
              { behavior: "immediate" },
            )
            .pipe(
              Effect.catch((error) =>
                error instanceof SqlError || error instanceof EffectDrizzleQueryError
                  ? Effect.die(error)
                  : Effect.fail(error),
              ),
            )
        }),
      resolve: (caller, workflowID, nodeID) =>
        transaction((tx) =>
          Effect.gen(function* () {
            const wf = yield* workflow(tx, workflowID)
            const sender = wf && (yield* owner(tx, caller, wf))
            if (!wf || !sender || (sender.kind === "node" && nodeID && sender.nodeID !== nodeID))
              return reject("unauthorized")
            if (!nodeID) {
              const s = yield* session(tx, wf.session_id)
              return s ? success(main(s)) : reject("closed")
            }
            const n = yield* node(tx, workflowID, nodeID)
            return n?.child_session_id ? success(child(n)) : reject("stale_attempt")
          }),
        ),
      send: (caller, request) =>
        transaction((tx, changes) =>
          Effect.gen(function* () {
            if (
              !request.idempotencyKey ||
              request.idempotencyKey.length > 128 ||
              !request.content ||
              Buffer.byteLength(request.content) > 16384
            )
              return reject("invalid")
            const wf = yield* workflow(tx, request.workflowID)
            const sender = wf && (yield* owner(tx, caller, wf))
            if (!wf || !sender || (sender.kind === "node" && request.nodeID)) return reject("unauthorized")
            const canonical = JSON.stringify([
              request.workflowID,
              request.nodeID ?? null,
              request.attemptID ?? null,
              request.content,
              request.replyTo ?? null,
            ])
            const old = yield* tx.get<StoredMessage>(
              sql`SELECT * FROM agent_message WHERE sender_id = ${sender.id} AND idempotency_key = ${request.idempotencyKey}`,
            )
            if (old) return old.request === canonical ? success(mapMessage(old)) : reject("conflict")
            if (!liveWorkflow(wf.status)) return reject("closed")
            if (sender.kind === "node") {
              const n = yield* node(tx, wf.id, sender.nodeID!)
              if (!n || !liveNode(n)) return reject("closed")
            }
            let recipient: Endpoint
            if (request.nodeID) {
              const n = yield* node(tx, wf.id, request.nodeID)
              if (!n || !request.attemptID || attempt(n) !== request.attemptID) return reject("stale_attempt")
              if (!liveNode(n)) return reject("closed")
              const targetSession = yield* session(tx, n.child_session_id!)
              if (!boundChild(wf, n, targetSession)) return reject("closed")
              recipient = child(n)
            } else {
              if (sender.kind !== "node") return reject("unauthorized")
              const s = yield* workflowParent(tx, wf)
              if (!s) return reject("closed")
              recipient = main(s)
            }
            if (request.replyTo) {
              const reply = yield* tx.get<{ sender_id: string; recipient_id: string; workflow_id: string }>(
                sql`SELECT sender_id,recipient_id,workflow_id FROM agent_message WHERE id = ${request.replyTo}`,
              )
              if (!reply || reply.workflow_id !== wf.id || ![reply.sender_id, reply.recipient_id].includes(sender.id))
                return reject("unauthorized")
            }
            const sourceBox = yield* mailbox(tx, sender)
            const box = yield* mailbox(tx, recipient)
            if (box.closed_reason || sourceBox.closed_reason) return reject("closed")
            const queued = yield* tx.get<{ n: number }>(
              sql`SELECT COUNT(*) AS n FROM agent_message WHERE recipient_id = ${recipient.id} AND state = 'queued'`,
            )
            if (queued!.n >= 64) return reject("capacity")
            const revised = yield* tx.get<{ revision: number; change_seq: number }>(
              sql`UPDATE agent_mailbox SET revision = revision + 1, change_seq = change_seq + 1 WHERE id = ${recipient.id} AND closed_reason IS NULL AND revision = ${box.revision} RETURNING revision, change_seq`,
            )
            if (!revised) return reject("closed")
            const id = `agm_${randomUUID()}`
            yield* tx.run(sql`INSERT INTO agent_message (id,workflow_id,sender_id,recipient_id,recipient_session_id,sender,recipient,idempotency_key,request,content,reply_to,recipient_sequence,accepted_revision,state,transcript_id,part_id,time_created)
        VALUES (${id},${wf.id},${sender.id},${recipient.id},${recipient.sessionID},${JSON.stringify(sender)},${JSON.stringify(recipient)},${request.idempotencyKey},${canonical},${request.content},${request.replyTo ?? null},${revised.revision},${revised.revision},'queued',${Identifier.ascending("message")},${Identifier.ascending("part")},${Date.now()})`)
            const target = yield* directory(tx, box.session_id)
            changes.push(change(box, target?.directory, "queued", revised.change_seq))
            return success(
              mapMessage((yield* tx.get<StoredMessage>(sql`SELECT * FROM agent_message WHERE id = ${id}`))!),
            )
          }),
        ),
      receive: (caller, input = {}) =>
        transaction((tx) =>
          Effect.gen(function* () {
            const endpoint = yield* self(tx, caller)
            if (!endpoint) return reject("unauthorized")
            const limit = Math.min(64, Math.max(1, Math.floor(input.limit ?? 20)))
            if (
              !Number.isFinite(limit) ||
              !Number.isSafeInteger(input.afterSequence ?? 0) ||
              (input.afterSequence ?? 0) < 0
            )
              return reject("invalid")
            if (input.workflowID) {
              const wf = yield* workflow(tx, input.workflowID)
              if (!wf || !(yield* owner(tx, caller, wf))) return reject("unauthorized")
            }
            const rows = yield* tx.all<StoredMessage>(
              sql`SELECT * FROM agent_message WHERE recipient_id = ${endpoint.id} AND recipient_sequence > ${input.afterSequence ?? 0} ${input.workflowID ? sql`AND workflow_id = ${input.workflowID}` : sql``} ${input.queuedOnly ? sql`AND state = 'queued'` : sql``} ORDER BY recipient_sequence LIMIT ${limit}`,
            )
            return success(rows.map(mapMessage))
          }),
        ),
      metadata: (caller, workflowID, nodeID, attemptID) =>
        transaction((tx) =>
          Effect.gen(function* () {
            const wf = yield* workflow(tx, workflowID)
            const sender = wf && (yield* owner(tx, caller, wf))
            if (!wf || !sender || (sender.kind === "node" && nodeID && sender.nodeID !== nodeID))
              return reject("unauthorized")
            if (!nodeID) {
              const s = yield* session(tx, wf.session_id)
              return s ? success(yield* metadata(tx, main(s), workflowID)) : reject("closed")
            }
            const n = yield* node(tx, workflowID, nodeID)
            if (attemptID && sender.kind === "main") {
              const old = yield* tx.get<Mailbox>(
                sql`SELECT * FROM agent_mailbox WHERE workflow_id = ${workflowID} AND node_id = ${nodeID} AND attempt_id = ${attemptID} LIMIT 1`,
              )
              if (old)
                return success(
                  yield* metadata(
                    tx,
                    {
                      id: old.id,
                      kind: "node",
                      sessionID: old.session_id,
                      workflowID,
                      nodeID,
                      attemptID,
                    },
                    workflowID,
                  ),
                )
            }
            if (!n?.child_session_id) return reject("stale_attempt")
            if (!attemptID || attemptID === attempt(n)) return success(yield* metadata(tx, child(n), workflowID))
            return reject(sender.kind === "main" ? "stale_attempt" : "unauthorized")
          }),
        ),
      freeze: (caller, logicalTurnID) =>
        transaction((tx) =>
          Effect.gen(function* () {
            if (!logicalTurnID || logicalTurnID.length > 256) return reject("invalid")
            const endpoint = yield* self(tx, caller)
            if (!endpoint) return reject("unauthorized")
            const box = yield* mailbox(tx, endpoint)
            const old = yield* tx.get<StoredSnapshot>(
              sql`SELECT * FROM agent_input_snapshot WHERE mailbox_id = ${box.id} AND logical_turn_id = ${logicalTurnID}`,
            )
            if (old) return success(yield* snapshot(tx, old))
            if (box.closed_reason) return reject("closed")
            const rows = yield* tx.all<StoredMessage>(
              sql`SELECT * FROM agent_message WHERE recipient_id = ${box.id} AND state = 'queued' ORDER BY recipient_sequence LIMIT 64`,
            )
            const id = `ags_${randomUUID()}`
            yield* tx.run(
              sql`INSERT INTO agent_input_snapshot (id,mailbox_id,logical_turn_id,revision,message_ids,associated,time_created) VALUES (${id},${box.id},${logicalTurnID},${box.revision},${JSON.stringify(rows.map((m) => m.id))},0,${Date.now()})`,
            )
            return success(
              yield* snapshot(
                tx,
                (yield* tx.get<StoredSnapshot>(sql`SELECT * FROM agent_input_snapshot WHERE id = ${id}`))!,
              ),
            )
          }),
        ),
      associate: (caller, snapshotID) =>
        transaction((tx, changes) =>
          Effect.gen(function* () {
            const endpoint = yield* self(tx, caller)
            if (!endpoint) return reject("unauthorized")
            const box = yield* tx.get<Mailbox>(sql`SELECT * FROM agent_mailbox WHERE id = ${endpoint.id}`)
            const row = yield* tx.get<StoredSnapshot>(
              sql`SELECT * FROM agent_input_snapshot WHERE id = ${snapshotID} AND mailbox_id = ${endpoint.id}`,
            )
            if (!row) return reject("unauthorized")
            const frozen = yield* snapshot(tx, row)
            if (row.associated) return success(frozen)
            for (const m of frozen.messages) {
              if (m.state === "undeliverable") return reject("closed")
              const part = yield* tx.get<{ data: string }>(
                sql`SELECT data FROM part WHERE id = ${m.partID} AND message_id = ${m.transcriptID} AND session_id = ${caller.sessionID}`,
              )
              if (!part) return reject("unassociated")
              const data: unknown = JSON.parse(part.data)
              if (
                !data ||
                typeof data !== "object" ||
                !("type" in data) ||
                !("text" in data) ||
                data.type !== "text" ||
                data.text !== renderMessage(m)
              )
                return reject("unassociated")
            }
            yield* tx.run(sql`UPDATE agent_input_snapshot SET associated = 1 WHERE id = ${row.id}`)
            for (const m of frozen.messages)
              yield* tx.run(
                sql`UPDATE agent_message SET state = 'delivered', snapshot_id = ${row.id}, time_delivered = ${Date.now()} WHERE id = ${m.id} AND state = 'queued'`,
              )
            if (box) yield* record(tx, box, "delivered", changes)
            return success(yield* snapshot(tx, { ...row, associated: 1 }))
          }),
        ),
      claimResultNudge: (caller, acceptedRevision) =>
        transaction((tx) =>
          Effect.gen(function* () {
            if (!Number.isSafeInteger(acceptedRevision) || acceptedRevision < 0) return reject("invalid")
            const endpoint = yield* self(tx, caller)
            if (!endpoint || endpoint.kind !== "node") return reject("unauthorized")
            const wf = yield* workflow(tx, endpoint.workflowID!)
            const n = yield* node(tx, endpoint.workflowID!, endpoint.nodeID!)
            if (!wf || !liveWorkflow(wf.status)) return reject("closed")
            if (!n || !liveNode(n) || attempt(n) !== endpoint.attemptID) return reject("stale_attempt")
            const box = yield* mailbox(tx, endpoint)
            if (box.closed_reason) return reject("closed")
            if (box.revision !== acceptedRevision) return reject("stale_input")
            const latest = yield* tx.get<StoredSnapshot>(
              sql`SELECT * FROM agent_input_snapshot WHERE mailbox_id = ${box.id} ORDER BY rowid DESC LIMIT 1`,
            )
            if (latest?.stop_reason) return reject("stopped")
            const claimed = yield* tx.get(
              sql`UPDATE agent_mailbox SET result_nudge_revision = ${acceptedRevision} WHERE id = ${box.id} AND revision = ${acceptedRevision} AND closed_reason IS NULL AND result_nudge_revision <> ${acceptedRevision} RETURNING id`,
            )
            return success(!!claimed)
          }),
        ),
      latestSnapshot: (caller) =>
        transaction((tx) =>
          Effect.gen(function* () {
            const endpoint = yield* self(tx, caller)
            if (!endpoint) return reject("unauthorized")
            const row = yield* tx.get<StoredSnapshot>(
              sql`SELECT * FROM agent_input_snapshot WHERE mailbox_id = ${endpoint.id} ORDER BY rowid DESC LIMIT 1`,
            )
            return success(row ? yield* snapshot(tx, row) : undefined)
          }),
        ),
      snapshotForTurn: (caller, logicalTurnID) =>
        transaction((tx) =>
          Effect.gen(function* () {
            const endpoint = yield* self(tx, caller)
            if (!endpoint) return reject("unauthorized")
            const row = yield* tx.get<StoredSnapshot>(
              sql`SELECT * FROM agent_input_snapshot WHERE mailbox_id = ${endpoint.id} AND logical_turn_id = ${logicalTurnID}`,
            )
            return success(row ? yield* snapshot(tx, row) : undefined)
          }),
        ),
      snapshotByID: (caller, snapshotID) =>
        transaction((tx) =>
          Effect.gen(function* () {
            const endpoint = yield* self(tx, caller)
            if (!endpoint) return reject("unauthorized")
            const row = yield* tx.get<StoredSnapshot>(
              sql`SELECT * FROM agent_input_snapshot WHERE mailbox_id = ${endpoint.id} AND id = ${snapshotID}`,
            )
            return success(row ? yield* snapshot(tx, row) : undefined)
          }),
        ),
      discardPending: (caller, reason) =>
        transaction((tx, changes) =>
          Effect.gen(function* () {
            const endpoint = yield* self(tx, caller)
            if (!endpoint) return
            const released = yield* undeliverable(tx, endpoint.id, reason)
            if (released.length === 0) return
            const box = yield* tx.get<Mailbox>(sql`SELECT * FROM agent_mailbox WHERE id = ${endpoint.id}`)
            if (box) yield* record(tx, box, "undeliverable", changes)
          }),
        ),
      markStopped: (caller, snapshotID, reason) =>
        transaction((tx) =>
          Effect.gen(function* () {
            const endpoint = yield* self(tx, caller)
            if (!endpoint) return
            yield* tx.run(
              sql`UPDATE agent_input_snapshot SET stop_reason = CASE WHEN stop_reason IS NULL OR stop_reason = 'budget_exhausted' THEN ${reason} ELSE stop_reason END WHERE id = ${snapshotID} AND mailbox_id = ${endpoint.id}`,
            )
          }),
        ),
      guard: (caller, input, commit) =>
        Effect.suspend(() => {
          const changes: Change[] = []
          return db
            .transaction(
              (tx) =>
                Effect.gen(function* () {
                  const wf = yield* workflow(tx, input.workflowID)
                  const sender = wf && (yield* owner(tx, caller, wf))
                  if (!wf || !sender) return reject("unauthorized")
                  const n = yield* node(tx, wf.id, input.nodeID)
                  if (
                    !n ||
                    !liveNode(n) ||
                    attempt(n) !== input.attemptID ||
                    (sender.kind === "node" && sender.nodeID !== n.id)
                  )
                    return reject("stale_attempt")
                  const childSession = yield* session(tx, n.child_session_id!)
                  if (
                    !boundChild(wf, n, childSession) &&
                    !(!childSession && sender.kind === "main" && input.failureReason && input.close !== false)
                  )
                    return reject("unauthorized")
                  if (!liveWorkflow(wf.status)) return reject("closed")
                  const endpoint = child(n)
                  const box = yield* mailbox(tx, endpoint)
                  if (box.closed_reason) return reject("closed")
                  if (input.expectedAcceptedRevision !== undefined && box.revision !== input.expectedAcceptedRevision)
                    return reject("stale_input")
                  const frozen = input.snapshotID
                    ? yield* tx.get<StoredSnapshot>(
                        sql`SELECT * FROM agent_input_snapshot WHERE id = ${input.snapshotID} AND mailbox_id = ${box.id}`,
                      )
                    : undefined
                  const checkSnapshot = !input.failureReason || input.requireCurrentInput === true
                  if (
                    checkSnapshot &&
                    ((!frozen && (box.revision > 0 || input.snapshotID !== undefined)) ||
                      (frozen && frozen.revision !== box.revision))
                  )
                    return reject("stale_input")
                  if (checkSnapshot && frozen && !frozen.associated) return reject("unassociated")
                  if (checkSnapshot && frozen?.stop_reason && frozen.stop_reason !== "budget_exhausted")
                    return reject("stopped")
                  // close:false claims the result without closing the channel, so it publishes nothing.
                  if (input.close === false) {
                    const claimed = yield* tx.get<{ id: string }>(
                      sql`UPDATE agent_mailbox SET closed_reason = NULL WHERE id = ${box.id} AND revision = ${box.revision} AND closed_reason IS NULL RETURNING id`,
                    )
                    if (!claimed) return reject("stale_input")
                    return success(yield* commit)
                  }
                  const claimed = yield* tx.get<{ change_seq: number }>(
                    sql`UPDATE agent_mailbox SET closed_reason = ${input.failureReason ?? "completed"}, change_seq = change_seq + 1 WHERE id = ${box.id} AND revision = ${box.revision} AND closed_reason IS NULL RETURNING change_seq`,
                  )
                  if (!claimed) return reject("stale_input")
                  if (input.failureReason) yield* undeliverable(tx, box.id, input.failureReason)
                  const target = yield* directory(tx, box.session_id)
                  changes.push(change(box, target?.directory, "closed", claimed.change_seq))
                  return success(yield* commit)
                }).pipe(Effect.tap(() => afterCommit(changes))),
              { behavior: "immediate" },
            )
            .pipe(
              Effect.catch((error) =>
                error instanceof SqlError || error instanceof EffectDrizzleQueryError
                  ? Effect.die(error)
                  : Effect.fail(error),
              ),
            )
        }),
      closeSession: (sessionID, reason) =>
        transaction((tx, changes) =>
          Effect.gen(function* () {
            // Materialize a tombstone even if this session never received a message.
            const s = yield* session(tx, sessionID)
            if (s) yield* mailbox(tx, main(s))
            const boxes = yield* tx.all<{ id: string }>(
              sql`SELECT id FROM agent_mailbox WHERE session_id = ${sessionID}`,
            )
            yield* close(
              tx,
              boxes.map((b) => b.id),
              reason,
              changes,
            )
          }),
        ),
      closeWorkflow: (workflowID, reason) =>
        transaction((tx, changes) =>
          Effect.gen(function* () {
            const boxes = yield* tx.all<{ id: string }>(
              sql`SELECT id FROM agent_mailbox WHERE workflow_id = ${workflowID}`,
            )
            yield* close(
              tx,
              boxes.map((b) => b.id),
              reason,
              changes,
            )
          }),
        ),
      reconcile: (caller) =>
        transaction((tx, changes) => {
          return Effect.gen(function* () {
            const current = yield* session(tx, caller.sessionID)
            if (!authorizedSession(caller, current)) return
            const boxes = yield* tx.all<Mailbox>(
              sql`SELECT * FROM agent_mailbox WHERE closed_reason IS NULL AND (session_id = ${caller.sessionID} OR workflow_id IN (SELECT id FROM workflow WHERE session_id = ${caller.sessionID} AND project_id = ${caller.projectID}))`,
            )
            for (const b of boxes) {
              if (!b.workflow_id || !b.node_id) continue
              const wf = yield* workflow(tx, b.workflow_id)
              if (
                wf &&
                (wf.project_id !== caller.projectID ||
                  !(yield* workflowParent(tx, wf)) ||
                  (caller.sessionID !== wf.session_id &&
                    (b.session_id !== caller.sessionID || current!.parent_id !== wf.session_id)))
              )
                continue
              const n = yield* node(tx, b.workflow_id, b.node_id)
              if (!wf || !liveWorkflow(wf.status) || !n || !liveNode(n) || attempt(n) !== b.attempt_id)
                yield* close(
                  tx,
                  [b.id],
                  n && attempt(n) !== b.attempt_id
                    ? "attempt_replaced"
                    : wf?.status === "cancelled" || n?.superseded
                      ? "cancelled"
                      : "closed",
                  changes,
                )
            }
          })
        }),
      revisions: (caller) =>
        transaction((tx) =>
          Effect.gen(function* () {
            const endpoint = yield* self(tx, caller)
            if (!endpoint) return reject("unauthorized")
            return success(yield* metadata(tx, endpoint))
          }),
        ),
      latestMessageAt: (caller, workflowID) =>
        transaction((tx) =>
          Effect.gen(function* () {
            if (workflowID) {
              const wf = yield* workflow(tx, workflowID)
              if (!wf || !(yield* owner(tx, caller, wf))) return reject("unauthorized")
            }
            const endpoint = yield* self(tx, caller)
            if (!endpoint) return reject("unauthorized")
            const latest = yield* tx.get<{ at: number | null }>(
              sql`SELECT MAX(time_created) AS at FROM agent_message WHERE recipient_id = ${endpoint.id} ${workflowID ? sql`AND workflow_id = ${workflowID}` : sql``}`,
            )
            return success(latest?.at ?? undefined)
          }),
        ),
      // Polled every 250ms per directory: a read-only scan must not take the
      // write reservation that stream persistence and acceptance compete for.
      pendingRecipients: (scope) =>
        read((tx) =>
          Effect.gen(function* () {
            const limit = Math.min(64, Math.max(1, Math.floor(scope.limit ?? 20)))
            if (!Number.isFinite(limit)) return []
            // Filter ownership before the LIMIT, so another worktree cannot starve this scan.
            // Only parent mailboxes need idle admission; node continuations use their running loop.
            const directory = resolvePath(scope.directory).replaceAll("\\", "/")
            const rows = yield* tx.all<Session>(
              sql`SELECT s.id,s.project_id,s.directory,s.time_created,s.parent_id FROM session s INNER JOIN agent_mailbox b ON b.session_id = s.id WHERE s.project_id = ${scope.projectID} AND s.directory = ${directory} AND s.id > ${scope.afterSessionID ?? ""} AND b.workflow_id IS NULL AND b.closed_reason IS NULL AND EXISTS (SELECT 1 FROM agent_message m WHERE m.recipient_id = b.id AND m.state = 'queued') ORDER BY s.id LIMIT ${limit}`,
            )
            return rows
              .filter((s) => resolvePath(s.directory) === resolvePath(scope.directory))
              .slice(0, limit)
              .map(main)
          }),
        ),
    })
  }),
)
export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
export const node = LayerNode.make(layer, [Database.node])
