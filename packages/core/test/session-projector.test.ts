import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { ModelV2 } from "@graphagent/core/model"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { ProviderV2 } from "@graphagent/core/provider"
import { AbsolutePath, RelativePath } from "@graphagent/core/schema"
import { SessionV1 } from "@graphagent/core/v1/session"
import { SessionID } from "@graphagent/schema/session-id"
import { SessionEvent } from "@graphagent/core/session/event"
import { SessionProjector } from "@graphagent/core/session/projector"
import { MessageTable, PartTable, SessionTable } from "@graphagent/core/session/sql"
import { WorkflowTable } from "@graphagent/core/dag/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.mergeAll(Database.defaultLayer, EventV2.defaultLayer, SessionProjector.defaultLayer))
const sessionID = SessionID.make("ses_projector_test")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const userModel = { providerID: ProviderV2.ID.make("provider"), modelID: ModelV2.ID.make("model") }

function seedProject() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
  })
}

function userMessage(id: string, time: { created: number; consumed?: number } = { created: 1 }) {
  return {
    id: SessionV1.MessageID.make(id),
    sessionID,
    role: "user" as const,
    agent: "build",
    model: userModel,
    time,
  }
}

describe("SessionProjector", () => {
  it.effect("projects created, updated, and deleted session rows", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedProject()
      const events = yield* EventV2.Service
      const info = {
        id: sessionID,
        projectID: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        time: { created: 1, updated: 1 },
      }

      yield* events.publish(SessionV1.Event.Created, { sessionID, info })
      expect((yield* db.select().from(SessionTable).get().pipe(Effect.orDie))?.title).toBe("test")

      yield* events.publish(SessionV1.Event.Updated, { sessionID, info: { ...info, title: "renamed" } })
      expect((yield* db.select().from(SessionTable).get().pipe(Effect.orDie))?.title).toBe("renamed")

      yield* events.publish(SessionV1.Event.Deleted, { sessionID, info })
      expect(yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("skips part updates whose parent message no longer exists", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedProject()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      // A revert cleanup can delete a message while an interrupted stream still
      // flushes a part update for it — projection must ignore the orphan part
      // instead of dying on the foreign key constraint.
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID: SessionID.make(sessionID),
        time: 1,
        part: {
          type: "step-start",
          id: SessionV1.PartID.make("prt_orphan"),
          messageID: SessionV1.MessageID.make("msg_missing"),
          sessionID: SessionID.make(sessionID),
        },
      })
      expect(yield* db.select().from(PartTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("preserves consumed time across stale user message updates", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedProject()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionV1.MessageID.make("msg_consumed")
      const base = userMessage("msg_consumed")

      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: SessionID.make(sessionID),
        info: { ...base, time: { created: 1, consumed: 20 } },
      })
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: SessionID.make(sessionID),
        info: { ...base, time: { created: 1 } },
      })
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: SessionID.make(sessionID),
        info: { ...base, time: { created: 1, consumed: 10 } },
      })

      const row = yield* db.select({ data: MessageTable.data }).from(MessageTable).where(eq(MessageTable.id, id)).get()
      expect(row?.data).toMatchObject({ role: "user", time: { created: 1, consumed: 20 } })

      const zeroID = SessionV1.MessageID.make("msg_consumed_zero")
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: SessionID.make(sessionID),
        info: { ...base, id: zeroID, time: { created: 1, consumed: 0 } },
      })
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: SessionID.make(sessionID),
        info: { ...base, id: zeroID, time: { created: 1 } },
      })
      const zero = yield* db
        .select({ data: MessageTable.data })
        .from(MessageTable)
        .where(eq(MessageTable.id, zeroID))
        .get()
      expect(zero?.data).toMatchObject({ role: "user", time: { created: 1, consumed: 0 } })
    }),
  )

  it.effect("adds and rolls back step-finish usage on session totals", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedProject()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const messageID = SessionV1.MessageID.make("msg_usage")
      const partID = SessionV1.PartID.make("prt_usage")

      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: SessionID.make(sessionID),
        info: userMessage("msg_usage"),
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID: SessionID.make(sessionID),
        time: 2,
        part: {
          type: "step-finish",
          id: partID,
          messageID,
          sessionID: SessionID.make(sessionID),
          reason: "stop",
          cost: 3,
          tokens: { input: 5, output: 7, reasoning: 11, cache: { read: 13, write: 17 } },
        },
      })

      const projected = yield* db.select().from(SessionTable).get().pipe(Effect.orDie)
      expect(projected).toMatchObject({
        cost: 3,
        tokens_input: 5,
        tokens_output: 7,
        tokens_reasoning: 11,
        tokens_cache_read: 13,
        tokens_cache_write: 17,
      })

      yield* events.publish(SessionV1.Event.PartRemoved, {
        sessionID: SessionID.make(sessionID),
        messageID,
        partID,
      })
      const rolledBack = yield* db.select().from(SessionTable).get().pipe(Effect.orDie)
      expect(rolledBack).toMatchObject({
        cost: 0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
      })
    }),
  )

  it.effect("keeps usage counters when a stale session update is projected", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedProject()
      const events = yield* EventV2.Service
      const info = {
        id: sessionID,
        projectID: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        time: { created: 1, updated: 1 },
      }

      yield* events.publish(SessionV1.Event.Created, { sessionID, info })
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: SessionID.make(sessionID),
        info: userMessage("msg_usage_race"),
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID: SessionID.make(sessionID),
        time: 2,
        part: {
          type: "step-finish",
          id: SessionV1.PartID.make("prt_usage_race"),
          messageID: SessionV1.MessageID.make("msg_usage_race"),
          sessionID: SessionID.make(sessionID),
          reason: "stop",
          cost: 3,
          tokens: { input: 5, output: 7, reasoning: 11, cache: { read: 13, write: 17 } },
        },
      })

      // Session.patch snapshots the session before the usage event; projecting
      // that stale snapshot must not rewind the counters maintained by
      // applyUsage.
      yield* events.publish(SessionV1.Event.Updated, { sessionID, info: { ...info, title: "renamed" } })

      expect(yield* db.select().from(SessionTable).get().pipe(Effect.orDie)).toMatchObject({
        title: "renamed",
        cost: 3,
        tokens_input: 5,
        tokens_output: 7,
        tokens_reasoning: 11,
        tokens_cache_read: 13,
        tokens_cache_write: 17,
      })
    }),
  )

  it.effect("projects DAG mode columns and leaves them untouched on stale updates", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedProject()
      const events = yield* EventV2.Service
      const info = {
        id: sessionID,
        projectID: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        time: { created: 1, updated: 1 },
        dagMode: "on" as const,
        dagBudgetTokens: 1000,
      }

      yield* events.publish(SessionV1.Event.Created, { sessionID, info })
      expect(yield* db.select().from(SessionTable).get().pipe(Effect.orDie)).toMatchObject({
        dag_mode: "on",
        dag_budget_tokens: 1000,
      })

      // An update that predates the column (no dagMode/dagBudgetTokens) must
      // not reset the stored values.
      yield* events.publish(SessionV1.Event.Updated, {
        sessionID,
        info: { ...info, title: "renamed", dagMode: undefined, dagBudgetTokens: undefined },
      })
      expect(yield* db.select().from(SessionTable).get().pipe(Effect.orDie)).toMatchObject({
        title: "renamed",
        dag_mode: "on",
        dag_budget_tokens: 1000,
      })
    }),
  )

  it.effect("switches the session agent and model", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedProject()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(SessionV1.Event.AgentSwitched, {
        sessionID: SessionID.make(sessionID),
        agent: "review",
        timestamp: 2,
      })
      yield* events.publish(SessionV1.Event.ModelSwitched, {
        sessionID: SessionID.make(sessionID),
        model,
        timestamp: 3,
      })

      expect(yield* db.select().from(SessionTable).get().pipe(Effect.orDie)).toMatchObject({
        agent: "review",
        model,
      })
    }),
  )

  it.effect("re-stamps session and workflow directories when a session moves", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedProject()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(WorkflowTable)
        .values({
          id: "dag_moved",
          project_id: Project.ID.global,
          session_id: sessionID,
          directory: "/project",
          title: "Moved",
          status: "running",
          config: "{}",
          seq: 0,
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        timestamp: DateTime.makeUnsafe(5),
        location: { directory: AbsolutePath.make("/moved") },
        subdirectory: RelativePath.make("nested"),
      })

      expect(yield* db.select().from(SessionTable).get().pipe(Effect.orDie)).toMatchObject({
        directory: "/moved",
        path: "nested",
      })
      expect(yield* db.select().from(WorkflowTable).get().pipe(Effect.orDie)).toMatchObject({
        directory: "/moved",
      })
    }),
  )
})
