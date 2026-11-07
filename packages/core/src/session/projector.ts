export * as SessionProjector from "./projector"

import { and, eq, sql } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { EventV2, type Definition, type Subscriber } from "../event"
import { LayerNode } from "../effect/layer-node"
import { SessionEvent } from "./event"
import { SessionV1 } from "../v1/session"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { WorkspaceV2 } from "../workspace"
import { WorkflowTable } from "../dag/sql"
import { MessageTable, PartTable, SessionTable } from "./sql"
import type { DeepMutable } from "../schema"
import { SessionMessageID } from "./message-id"

type DatabaseService = Database.Interface["db"]

export class SessionAlreadyProjected extends Error {}

type Usage = {
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

function usage(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"] | unknown): Usage | undefined {
  if (typeof part !== "object" || part === null) return undefined
  const value = part as Record<string, unknown>
  if (value.type !== "step-finish") return undefined
  if (!("cost" in value) || !("tokens" in value)) return undefined
  return { cost: value.cost as Usage["cost"], tokens: value.tokens as Usage["tokens"] }
}

function sessionRow(info: SessionV1.SessionInfo): typeof SessionTable.$inferInsert {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID ?? null,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? { input: 0 }).input,
    tokens_output: (info.tokens ?? { output: 0 }).output,
    tokens_reasoning: (info.tokens ?? { reasoning: 0 }).reasoning,
    tokens_cache_read: (info.tokens ?? { cache: { read: 0 } }).cache.read,
    tokens_cache_write: (info.tokens ?? { cache: { write: 0 } }).cache.write,
    revert: info.revert ? { ...info.revert, messageID: SessionMessageID.ID.make(info.revert.messageID) } : null,
    permission: info.permission ? [...info.permission] : undefined,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
    dag_mode: info.dagMode,
    dag_budget_tokens: info.dagBudgetTokens,
  }
}

/**
 * #1010 (E0): usage counters (`cost` and `tokens_*`) are owned exclusively by
 * `applyUsage`, which increments them from step-finish parts. The Updated
 * projection must never copy the event's snapshot of those columns over the
 * row: a Session.patch racing an in-flight usage update would otherwise
 * rewind the counters to stale values.
 */
function sessionUpdatedRow(info: SessionV1.SessionInfo) {
  const {
    cost: _cost,
    tokens_input: _tokensInput,
    tokens_output: _tokensOutput,
    tokens_reasoning: _tokensReasoning,
    tokens_cache_read: _tokensCacheRead,
    tokens_cache_write: _tokensCacheWrite,
    ...rest
  } = sessionRow(info)
  return rest
}

function messageData(
  info: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["info"],
): typeof MessageTable.$inferInsert.data {
  const { id: _, sessionID: __, ...rest } = info
  return rest as DeepMutable<typeof rest>
}

function partData(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]): typeof PartTable.$inferInsert.data {
  const { id: _, messageID: __, sessionID: ___, ...rest } = part
  return rest as DeepMutable<typeof rest>
}

function applyUsage(
  db: DatabaseService,
  sessionID: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["sessionID"],
  value: Usage,
  sign = 1,
) {
  return db
    .update(SessionTable)
    .set({
      cost: sql`${SessionTable.cost} + ${value.cost * sign}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input * sign}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output * sign}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning * sign}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read * sign}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write * sign}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    // A layer can be built more than once against the same bus (e.g. a node
    // graph and a default layer resolving it through different memo maps).
    // Keying the registrations keeps the projection single-shot per bus.
    const project = <D extends Definition>(definition: D, projector: Subscriber<D>) =>
      events.project(definition, projector, "projector/session")
    yield* project(SessionV1.Event.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values(sessionRow(event.data.info))
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
        if (event.data.info.workspaceID) {
          yield* db
            .update(WorkspaceTable)
            .set({ time_used: Date.now() })
            .where(eq(WorkspaceTable.id, event.data.info.workspaceID))
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )
    yield* project(SessionV1.Event.Updated, (event) =>
      db
        .update(SessionTable)
        .set(sessionUpdatedRow(event.data.info))
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            directory: event.data.location.directory,
            path: event.data.subdirectory,
            workspace_id: event.data.location.workspaceID ? WorkspaceV2.ID.make(event.data.location.workspaceID) : null,
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        // #269 atomic-adoption resolution: the execution-location stamp must move
        // WITH the session in one transaction. Re-stamp every durable workflow
        // row of the session to the payload-sourced destination directory (NO
        // SessionTable read — the Moved payload carries it). This runs inside the
        // same durable publish transaction as the SessionTable update, so there is
        // never a window where the session's rows carry mixed stamps (fail-closed
        // ownership would otherwise wedge every wake for the session). This is the
        // second whitelisted directory writer (see WorkflowTable.directory): the
        // create-time INSERT is the first; only SessionEvent.Moved may re-stamp.
        yield* db
          .update(WorkflowTable)
          .set({ directory: event.data.location.directory })
          .where(eq(WorkflowTable.session_id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* project(SessionV1.Event.Deleted, (event) =>
      db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie),
    )
    yield* project(SessionV1.Event.MessageUpdated, (event) =>
      Effect.gen(function* () {
        const time_created = event.data.info.time.created
        const id = event.data.info.id
        const sessionID = event.data.info.sessionID
        const data = messageData(event.data.info)
        // A consumed user message is an immutable request-admission receipt. Background
        // work can still hold an older User object and publish MessageUpdated later, so
        // preserve the greatest recorded timestamp instead of allowing a stale whole-JSON
        // replacement to make an already claimed prompt editable again.
        if (data.role === "user") {
          const previous = yield* db
            .select({ data: MessageTable.data })
            .from(MessageTable)
            .where(and(eq(MessageTable.id, id), eq(MessageTable.session_id, sessionID)))
            .get()
            .pipe(Effect.orDie)
          if (previous?.data.role === "user") {
            const nextTime = data.time as SessionV1.User["time"]
            const previousTime = previous.data.time as SessionV1.User["time"]
            if (nextTime.consumed !== undefined || previousTime.consumed !== undefined) {
              data.time = {
                ...nextTime,
                consumed: Math.max(nextTime.consumed ?? 0, previousTime.consumed ?? 0),
              }
            }
          }
        }
        yield* db
          .insert(MessageTable)
          .values({ id, session_id: sessionID, time_created, data })
          .onConflictDoUpdate({ target: MessageTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* project(SessionV1.Event.MessageRemoved, (event) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.message_id, event.data.messageID), eq(PartTable.session_id, event.data.sessionID)))
          .all()
          .pipe(Effect.orDie)
        for (const row of rows) {
          const previous = usage(row.data)
          if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        }
        yield* db
          .delete(MessageTable)
          .where(and(eq(MessageTable.id, event.data.messageID), eq(MessageTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* project(SessionV1.Event.PartRemoved, (event) =>
      Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .get()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        yield* db
          .delete(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* project(SessionV1.Event.PartUpdated, (event) =>
      Effect.gen(function* () {
        const id = event.data.part.id
        const messageID = event.data.part.messageID
        const sessionID = event.data.part.sessionID
        const data = partData(event.data.part)
        // A part update can race with revert cleanup deleting its parent message
        // (e.g. an interrupted stream flushing a step-start after resend). The
        // message is gone, so the part is moot — skip instead of dying on the
        // foreign key constraint. Warn so genuine ordering bugs remain observable.
        const message = yield* db
          .select({ id: MessageTable.id })
          .from(MessageTable)
          .where(eq(MessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        if (!message) {
          yield* Effect.logWarning("part update skipped: parent message no longer exists", {
            messageID,
            partType: event.data.part.type,
            sessionID,
          })
          return
        }
        const row = yield* db.select().from(PartTable).where(eq(PartTable.id, id)).get().pipe(Effect.orDie)
        yield* db
          .insert(PartTable)
          .values({ id, message_id: messageID, session_id: sessionID, time_created: event.data.time, data })
          .onConflictDoUpdate({ target: PartTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        const next = usage(event.data.part)
        if (previous) yield* applyUsage(db, row.session_id, previous, -1)
        if (next) yield* applyUsage(db, sessionID, next)
      }),
    )
    yield* project(SessionV1.Event.AgentSwitched, (event) =>
      db
        .update(SessionTable)
        .set({ agent: event.data.agent, time_updated: event.data.timestamp })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* project(SessionV1.Event.ModelSwitched, (event) =>
      db
        .update(SessionTable)
        .set({ model: event.data.model, time_updated: event.data.timestamp })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer), Layer.provide(Database.defaultLayer))
export const node = LayerNode.make(layer, [EventV2.node, Database.node])
