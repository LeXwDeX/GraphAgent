import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../../src/database/database"
import { EventV2 } from "../../src/event"
import { EventTable } from "../../src/event/sql"
import { Project } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { AbsolutePath } from "../../src/schema"
import { ModelV2 } from "../../src/model"
import { ProviderV2 } from "../../src/provider"
import { SessionSchema } from "../../src/session/schema"
import { SessionMessage } from "../../src/session/message"
import { SessionProjector } from "../../src/session/projector"
import { SessionStore } from "../../src/session/store"
import { SessionMessageTable, SessionTable } from "../../src/session/sql"
import { adoptReasoning } from "../../src/session/reasoning-distillation/adopt"
import { toLLMMessages } from "../../src/session/runner/to-llm-message"
import { NO_USEFUL_REASONING_TEXT } from "../../src/session/reasoning-distillation/organize"
import { LLM, Model } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(Database.defaultLayer, EventV2.defaultLayer, SessionProjector.defaultLayer, SessionStore.defaultLayer),
)
const model = Model.make({ id: "model", provider: "provider", route: OpenAIChat.route })

/** A complete provider tool-call envelope, rendered as observed in stored DeepSeek sessions (Issue #824). */
const envelope = [
  "<｜｜DSML｜｜ calls>",
  '<｜｜DSML｜｜ invoke name="bash">',
  '<｜｜DSML｜｜ parameter name="command" string="true">git status --short</｜｜DSML｜｜ parameter>',
  "</｜｜DSML｜｜ invoke>",
  "</｜｜DSML｜｜ calls>",
].join("\n")

const seed = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const store = yield* SessionStore.Service
  const sessionID = SessionSchema.ID.make("ses_adoption")
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "adoption",
      directory: "/project",
      title: "adoption",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  const user: SessionMessage.User = {
    id: SessionMessage.ID.make("msg_adoption_user"),
    type: "user",
    text: "start",
    time: { created: DateTime.makeUnsafe(0) },
  }
  const { id: _userID, type: userType, ...userData } = Schema.encodeSync(SessionMessage.User)(user)
  yield* db
    .insert(SessionMessageTable)
    .values({
      id: user.id,
      type: userType,
      data: userData,
      session_id: sessionID,
      seq: 0,
      time_created: 0,
    })
    .run()
    .pipe(Effect.orDie)
  const message: SessionMessage.Assistant = {
    id: SessionMessage.ID.make("msg_adoption"),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
    content: [
      { type: "reasoning", id: "r1", text: "first original" },
      { type: "text", id: "t1", text: "answer unchanged" },
      { type: "reasoning", id: "r2", text: "second original" },
    ],
  }
  const { id: _id, type, ...data } = Schema.encodeSync(SessionMessage.Assistant)(message)
  yield* db
    .insert(SessionMessageTable)
    .values({ id: message.id, type, data, session_id: sessionID, seq: 1, time_created: 1 })
    .run()
    .pipe(Effect.orDie)
  const part = (id: string) => {
    const found = message.content.find((item) => item.id === id)
    if (!found || found.type !== "reasoning") throw new Error(`missing reasoning ${id}`)
    return found
  }
  const adopt = (
    id: "r1" | "r2",
    after: string,
    options: { source?: SessionMessage.AssistantReasoning; canAdopt?: Effect.Effect<boolean> } = {},
  ) => {
    const source = options.source ?? part(id)
    return adoptReasoning({
      events,
      db,
      sessionID,
      messageID: message.id,
      part: source,
      replacement: { messageID: message.id, partID: id, before: source.text, after },
      canAdopt: options.canAdopt ?? Effect.succeed(true),
    })
  }
  return { db, events, store, sessionID, user, message, adopt }
})

describe("durable reasoning adoption", () => {
  it.effect("persists each accepted part and reloads the same text into model context without provenance leakage", () =>
    Effect.gen(function* () {
      const { store, message, adopt } = yield* seed()
      expect(yield* adopt("r1", "first adopted")).toBe(true)
      expect(yield* adopt("r2", "second adopted")).toBe(true)
      const stored = yield* store.message(message.id)
      expect(stored?.message).toMatchObject({
        content: [
          { type: "reasoning", id: "r1", text: "first adopted", distillation: { originalText: "first original" } },
          { type: "text", id: "t1", text: "answer unchanged" },
          { type: "reasoning", id: "r2", text: "second adopted", distillation: { originalText: "second original" } },
        ],
      })
      if (!stored) throw new Error("missing stored message")
      const enabled = toLLMMessages([stored.message], model, { reasoningDistillationEnabled: true })
      expect(JSON.stringify(enabled)).not.toContain("original")
      expect(JSON.stringify(enabled)).toContain("first adopted")
      const switched = toLLMMessages(
        [stored.message],
        Model.make({ id: "other", provider: model.provider, route: model.route }),
        { reasoningDistillationEnabled: true },
      )
      expect(JSON.stringify(switched)).toContain("first adopted")
      expect(JSON.stringify(switched)).not.toContain("original")
      const disabled = toLLMMessages([stored.message], model)
      expect(JSON.stringify(disabled)).toContain("first original")
      expect(JSON.stringify(disabled)).not.toContain("first adopted")
      // A distilled part is never rewritten again.
      const r1 = stored.message.type === "assistant" ? stored.message.content[0] : undefined
      if (r1?.type !== "reasoning") throw new Error("missing r1")
      expect(yield* adopt("r1", "again", { source: r1 })).toBe(false)
    }),
  )

  it.effect("rejects a part whose persisted source has changed without emitting events", () =>
    Effect.gen(function* () {
      const { db, store, message, adopt } = yield* seed()
      const changed = {
        ...message,
        content: message.content.map((part) => (part.id === "r2" ? { ...part, text: "newer second" } : part)),
      }
      const { id: _id, type: _type, ...data } = Schema.encodeSync(SessionMessage.Assistant)(changed)
      yield* db
        .update(SessionMessageTable)
        .set({ data })
        .where(eq(SessionMessageTable.id, message.id))
        .run()
        .pipe(Effect.orDie)
      expect(yield* adopt("r2", "second adopted")).toBe(false)
      expect((yield* store.message(message.id))?.message).toEqual(changed)
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("an all-noise placeholder keeps the provider reasoning field present", () =>
    Effect.gen(function* () {
      const { store, message, adopt } = yield* seed()
      expect(yield* adopt("r1", NO_USEFUL_REASONING_TEXT.zh)).toBe(true)
      const stored = yield* store.message(message.id)
      if (!stored || stored.message.type !== "assistant") throw new Error("missing stored assistant message")
      expect(stored.message.content[0]).toMatchObject({
        text: NO_USEFUL_REASONING_TEXT.zh,
        distillation: { originalText: "first original" },
      })
      const request = LLM.request({
        model,
        messages: toLLMMessages([stored.message], model, { reasoningDistillationEnabled: true }),
      })
      const body = yield* request.model.route.body.from(request).pipe(Effect.orDie)
      const wire = JSON.stringify(body)
      expect(wire).toContain(`"reasoning_content":"${NO_USEFUL_REASONING_TEXT.zh}second original"`)
      expect(wire).not.toContain("first original")
    }),
  )

  it.effect("checks adoptability again inside the adoption transaction", () =>
    Effect.gen(function* () {
      const { db, store, message, adopt } = yield* seed()
      expect(yield* adopt("r1", "first adopted", { canAdopt: Effect.succeed(false) })).toBe(false)
      expect((yield* store.message(message.id))?.message).toEqual(message)
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("rejects a distilled tool-call envelope, keeps the source, and writes no provenance", () =>
    Effect.gen(function* () {
      const { db, store, message, adopt } = yield* seed()
      expect(yield* adopt("r1", envelope)).toBe(false)
      expect((yield* store.message(message.id))?.message).toEqual(message)
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("rejects adoption after a revert or a later assistant attempt, but not after a later user message", () =>
    Effect.gen(function* () {
      const { db, store, sessionID, user, message, adopt } = yield* seed()
      yield* db
        .update(SessionTable)
        .set({ revert: { messageID: user.id } })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      expect(yield* adopt("r1", "first adopted")).toBe(false)
      expect((yield* store.message(message.id))?.message).toEqual(message)
      yield* db
        .update(SessionTable)
        .set({ revert: null })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const insert = (value: SessionMessage.Message, seq: number) => {
        const { id: _id, type: _type, ...data } = Schema.encodeSync(SessionMessage.Message)(value)
        return db
          .insert(SessionMessageTable)
          .values({ id: value.id, type: value.type, data, session_id: sessionID, seq, time_created: seq + 1 })
          .run()
          .pipe(Effect.orDie)
      }
      // A queued user message is not a send attempt; the barrier still decides.
      yield* insert({ ...user, id: SessionMessage.ID.make("msg_next_user"), text: "next" }, 2)
      expect(yield* adopt("r1", "first adopted")).toBe(true)
      // Another process persisted a later assistant attempt: its request may carry the original.
      yield* insert({ ...message, id: SessionMessage.ID.make("msg_later_attempt") }, 3)
      expect(yield* adopt("r2", "second adopted")).toBe(false)
      expect(JSON.stringify((yield* store.message(message.id))?.message)).toContain("second original")
    }),
  )
})
