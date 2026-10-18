export * as SessionLifecycleHooks from "./lifecycle-hooks"

import { Cause, Context, DateTime, Effect, Option, Schema } from "effect"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import type { Database } from "../database/database"
import { eq, and, desc, sql } from "drizzle-orm"
import { SessionTable, SessionMessageTable, SessionInputTable, MessageTable } from "./sql"
import { SessionInput } from "./input"
import { SessionConversationHooks } from "./conversation-hooks"
import { Prompt } from "./prompt"
import { KeyedMutex } from "../effect/keyed-mutex"

export interface Started {
  readonly additionalContext?: string
  readonly initialUserMessage?: string
}
export interface Interface {
  readonly setMetadata: (input: {
    sessionID: SessionSchema.ID
    metadata: Record<string, unknown>
  }) => Effect.Effect<void>
  readonly start: (input: {
    sessionID: SessionSchema.ID
    source: "startup" | "resume" | "compact"
  }) => Effect.Effect<Started>
  readonly blocked?: (input: { sessionID: SessionSchema.ID; reason: string }) => Effect.Effect<void>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionLifecycleHooks") {}
const mutex = KeyedMutex.makeUnsafe<string>()
export const withLock = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) => mutex.withLock(id)(effect)
export const start = Effect.fn("SessionLifecycleHooks.start")(function* (input: Parameters<Interface["start"]>[0]) {
  const hooks = Option.getOrUndefined(yield* Effect.serviceOption(Service))
  if (!hooks) return {} as Started
  return yield* hooks
    .start(input)
    .pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed<Started>({}),
      ),
    )
})
/** Synthetic hook context survives the first system-context epoch; it is not a user admission. */
export const landContext = Effect.fn("SessionLifecycleHooks.landContext")(function* (
  events: EventV2.Interface,
  input: { sessionID: SessionSchema.ID; text?: string },
) {
  if (!input.text) return
  yield* events.publish(SessionEvent.Synthetic, {
    sessionID: input.sessionID,
    messageID: SessionMessage.ID.create(),
    timestamp: yield* DateTime.now,
    text: input.text,
  })
})

type DB = Database.Interface["db"]
export const metadata = (db: DB, id: SessionSchema.ID) =>
  db
    .select({ metadata: SessionTable.metadata })
    .from(SessionTable)
    .where(eq(SessionTable.id, id))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.metadata ?? {}),
    )
const saveMetadata = (id: SessionSchema.ID, value: Record<string, unknown>) =>
  Effect.gen(function* () {
    const hooks = Option.getOrUndefined(yield* Effect.serviceOption(Service))
    if (!hooks) return yield* Effect.die(new Error("Initial session hook metadata requires the lifecycle host"))
    yield* hooks.setMetadata({ sessionID: id, metadata: value })
    return undefined
  })
/** Admit a real initial user through the same host prompt guard, never as synthetic context. */
export const landInitial = Effect.fn("SessionLifecycleHooks.landInitial")(function* (
  db: DB,
  events: EventV2.Interface,
  input: { sessionID: SessionSchema.ID; text?: string },
) {
  if (!input.text) return false
  const [admitted, user, legacyUser] = yield* Effect.all([
    db
      .select({ id: SessionInputTable.id })
      .from(SessionInputTable)
      .where(eq(SessionInputTable.session_id, input.sessionID))
      .limit(1)
      .get()
      .pipe(Effect.orDie),
    db
      .select({ id: SessionMessageTable.id })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.type, "user")))
      .limit(1)
      .get()
      .pipe(Effect.orDie),
    db
      .select({ id: MessageTable.id })
      .from(MessageTable)
      .where(
        and(eq(MessageTable.session_id, input.sessionID), sql`json_extract(${MessageTable.data}, '$.role') = 'user'`),
      )
      .limit(1)
      .get()
      .pipe(Effect.orDie),
  ])
  if (admitted || user || legacyUser) return false
  const prompt = Prompt.make({ text: input.text, hookMode: "noninteractive" })
  // Admission runs before the row is persisted, so allocate the same id the
  // durable input below will use.
  const messageID = SessionMessage.ID.create()
  const conversation = Option.getOrUndefined(yield* Effect.serviceOption(SessionConversationHooks.Service))
  if (conversation) {
    let allowed = true
    const decision = yield* conversation.admit({ sessionID: input.sessionID, messageID, prompt }).pipe(
      Effect.catchTag("SessionConversationHookBlocked", (error) =>
        Effect.gen(function* () {
          allowed = false
          const lifecycle = Option.getOrUndefined(yield* Effect.serviceOption(Service))
          if (lifecycle?.blocked) yield* lifecycle.blocked({ sessionID: input.sessionID, reason: error.reason })
          return undefined
        }),
      ),
    )
    if (!allowed) return false
    yield* landContext(events, { sessionID: input.sessionID, text: decision?.additionalContext })
  }
  yield* saveMetadata(input.sessionID, { ...(yield* metadata(db, input.sessionID)), hookV2Initial: { messageID } })
  yield* SessionInput.admit(db, events, { id: messageID, sessionID: input.sessionID, prompt, delivery: "queue" })
  return true
})
export const initialActive = Effect.fn("SessionLifecycleHooks.initialActive")(function* (db: DB, id: SessionSchema.ID) {
  const value = (yield* metadata(db, id)).hookV2Initial
  if (!value || typeof value !== "object" || !("messageID" in value) || typeof value.messageID !== "string")
    return false
  const initial = yield* SessionInput.find(db, SessionMessage.ID.make(value.messageID))
  if (!initial || initial.sessionID !== id) return false
  if (initial.promotedSeq === undefined) return true
  const last = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, id), eq(SessionMessageTable.type, "assistant")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!last || last.seq <= initial.promotedSeq) return true
  const message = yield* Schema.decodeUnknownEffect(SessionMessage.Assistant)({
    ...last.data,
    id: last.id,
    type: last.type,
  }).pipe(Effect.orDie)
  return (
    !message.time.completed ||
    message.finish === "tool-calls" ||
    message.content.some(
      (part) => part.type === "tool" && (part.state.status === "running" || part.state.status === "pending"),
    )
  )
})
export const deliveryIntent = Effect.fn("SessionLifecycleHooks.deliveryIntent")(function* (
  db: DB,
  _events: EventV2.Interface,
  input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
    requested: SessionInput.Delivery
    prior?: SessionInput.Admitted
  },
) {
  const meta = yield* metadata(db, input.sessionID)
  if (!meta.hookV2Initial) return { delivery: input.requested, conflict: false }
  const intents =
    meta.hookV2InitialDeliveries && typeof meta.hookV2InitialDeliveries === "object"
      ? (meta.hookV2InitialDeliveries as Record<string, unknown>)
      : {}
  const recorded = intents[input.messageID]
  if (input.prior && recorded !== undefined)
    return { delivery: input.prior.delivery, conflict: recorded !== input.requested }
  const active = yield* initialActive(db, input.sessionID)
  if (!active) return { delivery: input.requested, conflict: false }
  if (!input.prior)
    yield* saveMetadata(input.sessionID, {
      ...meta,
      hookV2InitialDeliveries: { ...intents, [input.messageID]: input.requested },
    })
  return { delivery: "queue" as const, conflict: false }
})
