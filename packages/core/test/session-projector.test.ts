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
import { SessionStepTable, ToolOutcomeTable } from "@graphagent/core/session/outcome.sql"
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

function assistantMessage(id: string) {
  return {
    id: SessionV1.MessageID.make(id),
    sessionID,
    role: "assistant" as const,
    time: { created: 1 },
    parentID: SessionV1.MessageID.make("msg_parent"),
    modelID: userModel.modelID,
    providerID: userModel.providerID,
    mode: "build",
    agent: "build",
    path: { cwd: "/project", root: "/project" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function toolPart(id: string, messageID: string, tool: string, state: SessionV1.ToolState): SessionV1.ToolPart {
  return {
    id: SessionV1.PartID.make(id),
    messageID: SessionV1.MessageID.make(messageID),
    sessionID,
    type: "tool",
    callID: `call_${id}`,
    tool,
    state,
  }
}

const finished = (metadata: Record<string, unknown> = {}, input: Record<string, unknown> = {}) =>
  ({ status: "completed", input, output: "ok", title: "t", metadata, time: { start: 1, end: 2 } }) as const

const failedState = (metadata?: Record<string, unknown>, input: Record<string, unknown> = {}) =>
  ({ status: "error", input, error: "boom", metadata, time: { start: 1, end: 2 } }) as const

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
        role: "root" as const,
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
        role: "root" as const,
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
        role: "root" as const,
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
          target_fingerprint: { kind: "none" },
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

  describe("tool_outcome", () => {
    const seed = Effect.gen(function* () {
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
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: assistantMessage("msg_outcome") })
      return { db, events }
    })

    const publishPart = (events: EventV2.Interface, part: SessionV1.ToolPart) =>
      events.publish(SessionV1.Event.PartUpdated, { sessionID, time: 2, part })

    const outcomes = (db: Database.Interface["db"]) => db.select().from(ToolOutcomeTable).all().pipe(Effect.orDie)

    it.effect("books a finished tool part under the model of its assistant message", () =>
      Effect.gen(function* () {
        const { db, events } = yield* seed
        yield* publishPart(
          events,
          toolPart("prt_ok", "msg_outcome", "edit", finished({ corrections: ["fuzzy_match"] })),
        )
        yield* publishPart(
          events,
          toolPart("prt_err", "msg_outcome", "bash", failedState({ outcome: "denied", truncated: true })),
        )

        const rows = (yield* outcomes(db)).sort((a, b) => a.part_id.localeCompare(b.part_id))
        expect(rows).toEqual([
          {
            part_id: SessionV1.PartID.make("prt_err"),
            session_id: sessionID,
            provider_id: "provider",
            model_id: "model",
            tool: "bash",
            outcome: "denied",
            corrections: [],
            truncated: true,
          },
          {
            part_id: SessionV1.PartID.make("prt_ok"),
            session_id: sessionID,
            provider_id: "provider",
            model_id: "model",
            tool: "edit",
            outcome: "ok",
            corrections: ["fuzzy_match"],
            truncated: false,
          },
        ])
      }),
    )

    it.effect("leaves running and pending tool parts out", () =>
      Effect.gen(function* () {
        const { db, events } = yield* seed
        yield* publishPart(
          events,
          toolPart("prt_run", "msg_outcome", "edit", { status: "running", input: {}, time: { start: 1 } }),
        )
        yield* publishPart(
          events,
          toolPart("prt_pend", "msg_outcome", "edit", { status: "pending", input: {}, raw: "" }),
        )
        expect(yield* outcomes(db)).toEqual([])
      }),
    )

    it.effect("a repeated projection rewrites the row instead of adding one", () =>
      Effect.gen(function* () {
        const { db, events } = yield* seed
        const id = "prt_again"
        yield* publishPart(
          events,
          toolPart(id, "msg_outcome", "edit", { status: "running", input: {}, time: { start: 1 } }),
        )
        yield* publishPart(events, toolPart(id, "msg_outcome", "edit", finished()))
        yield* publishPart(events, toolPart(id, "msg_outcome", "edit", finished()))
        expect(yield* outcomes(db)).toHaveLength(1)

        yield* publishPart(events, toolPart(id, "msg_outcome", "edit", finished({ corrections: ["args_repaired"] })))
        const rows = yield* outcomes(db)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ outcome: "ok", corrections: ["args_repaired"] })
      }),
    )

    it.effect("books a hook denial, an old invalid part and an aborted call", () =>
      Effect.gen(function* () {
        const { db, events } = yield* seed
        yield* publishPart(events, toolPart("prt_hook", "msg_outcome", "mcp_probe", finished({ hookDenied: true })))
        yield* publishPart(
          events,
          toolPart("prt_invalid", "msg_outcome", "invalid", finished({}, { tool: "wrtie", error: "bad" })),
        )
        yield* publishPart(
          events,
          toolPart("prt_abort", "msg_outcome", "bash", failedState({ interrupted: true, outcome: "aborted" })),
        )

        const byPart = Object.fromEntries((yield* outcomes(db)).map((row) => [row.part_id, row]))
        expect(byPart["prt_hook"]).toMatchObject({ tool: "mcp_probe", outcome: "denied" })
        expect(byPart["prt_invalid"]).toMatchObject({ tool: "wrtie", outcome: "validation_error" })
        expect(byPart["prt_abort"]).toMatchObject({ tool: "bash", outcome: "aborted" })
      }),
    )

    it.effect("removing the part, or its message, removes the row", () =>
      Effect.gen(function* () {
        const { db, events } = yield* seed
        yield* publishPart(events, toolPart("prt_gone", "msg_outcome", "edit", finished()))
        yield* publishPart(events, toolPart("prt_stays", "msg_outcome", "edit", finished()))
        expect(yield* outcomes(db)).toHaveLength(2)

        yield* events.publish(SessionV1.Event.PartRemoved, {
          sessionID,
          messageID: SessionV1.MessageID.make("msg_outcome"),
          partID: SessionV1.PartID.make("prt_gone"),
        })
        expect((yield* outcomes(db)).map((row) => row.part_id)).toEqual([SessionV1.PartID.make("prt_stays")])

        yield* events.publish(SessionV1.Event.MessageRemoved, {
          sessionID,
          messageID: SessionV1.MessageID.make("msg_outcome"),
        })
        expect(yield* outcomes(db)).toEqual([])
      }),
    )

    it.effect("a tool part under a message without a model leaves no row", () =>
      Effect.gen(function* () {
        const { db, events } = yield* seed
        yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: userMessage("msg_user_tool") })
        yield* publishPart(events, toolPart("prt_user", "msg_user_tool", "edit", finished()))
        expect(yield* outcomes(db)).toEqual([])
      }),
    )

    it.effect("a session delete removes its rows", () =>
      Effect.gen(function* () {
        const { db, events } = yield* seed
        yield* publishPart(events, toolPart("prt_cascade", "msg_outcome", "edit", finished()))
        expect(yield* outcomes(db)).toHaveLength(1)
        yield* events.publish(SessionV1.Event.Deleted, {
          sessionID,
          info: {
            id: sessionID,
            projectID: Project.ID.global,
            slug: "test",
            role: "root" as const,
            directory: "/project",
            title: "test",
            version: "test",
            time: { created: 1, updated: 1 },
          },
        })
        expect(yield* outcomes(db)).toEqual([])
      }),
    )
  })

  describe("session_step", () => {
    const metrics = { prepareMs: 12, requestMs: 340, ttftMs: 90, toolCalls: 3, toolErrors: 1, retries: 2 }

    const stepFinish = (id: string, messageID: string, withMetrics?: typeof metrics): SessionV1.StepFinishPart => ({
      id: SessionV1.PartID.make(id),
      messageID: SessionV1.MessageID.make(messageID),
      sessionID,
      type: "step-finish",
      reason: "stop",
      cost: 3,
      tokens: { input: 5, output: 7, reasoning: 11, cache: { read: 13, write: 17 } },
      ...(withMetrics ? { metrics: withMetrics } : {}),
    })

    const seed = Effect.gen(function* () {
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
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: assistantMessage("msg_step") })
      return { db, events }
    })

    const publishPart = (events: EventV2.Interface, part: SessionV1.StepFinishPart) =>
      events.publish(SessionV1.Event.PartUpdated, { sessionID, time: 2, part })

    const steps = (db: Database.Interface["db"]) => db.select().from(SessionStepTable).all().pipe(Effect.orDie)

    it.effect("books a step-finish part's metrics under the model of its assistant message", () =>
      Effect.gen(function* () {
        const { db, events } = yield* seed
        yield* publishPart(events, stepFinish("prt_step", "msg_step", metrics))

        expect(yield* steps(db)).toEqual([
          {
            part_id: SessionV1.PartID.make("prt_step"),
            session_id: sessionID,
            provider_id: "provider",
            model_id: "model",
            prepare_ms: 12,
            request_ms: 340,
            ttft_ms: 90,
            tool_calls: 3,
            tool_errors: 1,
            retries: 2,
          },
        ])
      }),
    )

    it.effect("leaves a step-finish part without metrics out, and its usage still counts", () =>
      Effect.gen(function* () {
        const { db, events } = yield* seed
        yield* publishPart(events, stepFinish("prt_old", "msg_step"))
        expect(yield* steps(db)).toEqual([])
        expect(yield* db.select().from(SessionTable).get().pipe(Effect.orDie)).toMatchObject({
          cost: 3,
          tokens_input: 5,
        })
      }),
    )

    it.effect("a repeated projection rewrites the row and counts the usage once", () =>
      Effect.gen(function* () {
        const { db, events } = yield* seed
        yield* publishPart(events, stepFinish("prt_again", "msg_step", metrics))
        yield* publishPart(events, stepFinish("prt_again", "msg_step", metrics))
        expect(yield* steps(db)).toHaveLength(1)

        yield* publishPart(events, stepFinish("prt_again", "msg_step", { ...metrics, retries: 5, toolErrors: 0 }))
        const rows = yield* steps(db)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ retries: 5, tool_errors: 0, request_ms: 340 })
        // Usage is owned by `applyUsage`: three projections of one part leave one part's worth.
        expect(yield* db.select().from(SessionTable).get().pipe(Effect.orDie)).toMatchObject({
          cost: 3,
          tokens_input: 5,
          tokens_output: 7,
        })
      }),
    )

    it.effect("a step under a message without a model leaves no row", () =>
      Effect.gen(function* () {
        const { db, events } = yield* seed
        yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: userMessage("msg_user_step") })
        yield* publishPart(events, stepFinish("prt_user", "msg_user_step", metrics))
        expect(yield* steps(db)).toEqual([])
      }),
    )

    it.effect("a tool part and a step-finish part of one message keep to their own tables", () =>
      Effect.gen(function* () {
        const { db, events } = yield* seed
        yield* publishPart(events, stepFinish("prt_both_step", "msg_step", metrics))
        yield* events.publish(SessionV1.Event.PartUpdated, {
          sessionID,
          time: 2,
          part: toolPart("prt_both_tool", "msg_step", "edit", finished()),
        })
        expect((yield* steps(db)).map((row) => row.part_id)).toEqual([SessionV1.PartID.make("prt_both_step")])
        const outcomes = yield* db.select().from(ToolOutcomeTable).all().pipe(Effect.orDie)
        expect(outcomes.map((row) => row.part_id)).toEqual([SessionV1.PartID.make("prt_both_tool")])
      }),
    )

    it.effect("removing the part, its message, or the session removes the row", () =>
      Effect.gen(function* () {
        const { db, events } = yield* seed
        yield* publishPart(events, stepFinish("prt_gone", "msg_step", metrics))
        yield* publishPart(events, stepFinish("prt_stays", "msg_step", metrics))
        expect(yield* steps(db)).toHaveLength(2)

        yield* events.publish(SessionV1.Event.PartRemoved, {
          sessionID,
          messageID: SessionV1.MessageID.make("msg_step"),
          partID: SessionV1.PartID.make("prt_gone"),
        })
        expect((yield* steps(db)).map((row) => row.part_id)).toEqual([SessionV1.PartID.make("prt_stays")])

        yield* events.publish(SessionV1.Event.MessageRemoved, {
          sessionID,
          messageID: SessionV1.MessageID.make("msg_step"),
        })
        expect(yield* steps(db)).toEqual([])

        yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: assistantMessage("msg_step_two") })
        yield* publishPart(events, stepFinish("prt_cascade", "msg_step_two", metrics))
        expect(yield* steps(db)).toHaveLength(1)
        yield* events.publish(SessionV1.Event.Deleted, {
          sessionID,
          info: {
            id: sessionID,
            projectID: Project.ID.global,
            slug: "test",
            role: "root" as const,
            directory: "/project",
            title: "test",
            version: "test",
            time: { created: 1, updated: 1 },
          },
        })
        expect(yield* steps(db)).toEqual([])
      }),
    )
  })
})
