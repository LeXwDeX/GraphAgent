import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { adoptReasoning } from "@/session/reasoning-adoption"
import { ProviderTest } from "../fake/provider"
import { ProviderTransform } from "@/provider/transform"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Schema, DateTime, Deferred, Effect, Exit, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { Goal } from "@/goal/goal"
import { SessionAutomationLease } from "@/session/automation-lease"
import { Dag } from "@/dag/dag"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Storage } from "@/storage/storage"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"

const it = testEffect(
  Layer.mergeAll(
    SessionNs.layer.pipe(
      Layer.provide(Storage.defaultLayer),
      Layer.provide(Database.defaultLayer),
      Layer.provideMerge(EventV2Bridge.defaultLayer),
      Layer.provide(SessionProjector.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
      Layer.provide(Goal.defaultLayer),
      Layer.provide(SessionAutomationLease.defaultLayer),
      Layer.provide(Dag.defaultLayer),
    ),
    Database.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)

describe("session.created event", () => {
  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = yield* events.listen((event) => {
        if (event.type === SessionNs.Event.Created.type)
          Deferred.doneUnsafe(
            received,
            Effect.succeed((event.data as typeof SessionNs.Event.Created.data.Type).info as SessionNs.Info),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubscribe = yield* source.listen((event) => {
        if (event.type === SessionNs.Event.Created.type) push("created")
        if (event.type === SessionNs.Event.Updated.type) push("updated")
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const info = yield* session.create({})
      yield* session.setTitle({ sessionID: info.id, title: "updated" })
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )

  it.instance("emits legacy global sync payload", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<{ syncEvent: EventV2.SerializedEvent }>()
      const listener = (event: { payload: { type?: string; syncEvent?: EventV2.SerializedEvent } }) => {
        if (event.payload.type === "sync" && event.payload.syncEvent)
          Deferred.doneUnsafe(received, Effect.succeed({ syncEvent: event.payload.syncEvent }))
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const info = yield* session.create({})
      const event = yield* awaitDeferred(received, "timed out waiting for legacy global sync event")

      expect(event.syncEvent).toMatchObject({
        type: EventV2.versionedType(SessionNs.Event.Created.type, 1),
        seq: 0,
        aggregateID: info.id,
        data: { sessionID: info.id },
      })

      yield* session.remove(info.id)
    }),
  )
})

describe("step-finish token propagation via event", () => {
  it.instance(
    "non-zero tokens propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({})

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)

        // Event subscribers receive readonly Schema.Type payloads; `SessionV1.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<SessionV1.Part>()
        const unsub = yield* events.listen((event) => {
          if (event.type === MessageV2.Event.PartUpdated.type)
            Deferred.doneUnsafe(
              received,
              Effect.succeed((event.data as typeof MessageV2.Event.PartUpdated.data.Type).part as SessionV1.Part),
            )
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as SessionV1.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(receivedPart).not.toBe(partInput)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("Session", () => {
  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )

  it.instance("persists metadata and copies it on fork by default", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const meta = { source: "sdk", trace: { id: "abc" } }
      const created = yield* Effect.acquireRelease(session.create({ title: "with-meta", metadata: meta }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(saved.metadata).toEqual({ ...meta, hookTitleSource: "custom" })
      expect(fork.metadata).toEqual({ ...meta, hookTitleSource: "custom" })
      expect(meta).toEqual({ source: "sdk", trace: { id: "abc" } })
      expect(fork.metadata).not.toBe(meta)
    }),
  )

  it.instance("records explicit title provenance without unrelated user metadata", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "empty-meta" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)

      expect(created.metadata).toEqual({ hookTitleSource: "custom" })
      expect(saved.metadata).toEqual({ hookTitleSource: "custom" })
    }),
  )
})

describe("adopted reasoning", () => {
  const seed = Effect.fnUntraced(function* () {
    const session = yield* SessionNs.Service
    const chat = yield* session.create({})
    const info: SessionV1.Assistant = {
      id: MessageID.ascending(),
      sessionID: chat.id,
      parentID: MessageID.ascending(),
      role: "assistant",
      agent: "build",
      modelID: ModelV2.ID.make("model"),
      providerID: ProviderV2.ID.make("provider"),
      mode: "build",
      path: { cwd: chat.directory, root: chat.directory },
      time: { created: 1, completed: 2 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    yield* session.updateMessage(info)
    const reasoning: SessionV1.ReasoningPart = {
      id: PartID.ascending(),
      sessionID: chat.id,
      messageID: info.id,
      type: "reasoning",
      text: "original private reasoning",
      time: { start: 1, end: 2 },
    }
    const events = yield* EventV2Bridge.Service
    const assistantMessageID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID: chat.id,
      assistantMessageID,
      agent: "build",
      model: { id: info.modelID, providerID: info.providerID },
      timestamp: DateTime.makeUnsafe(1),
    })
    yield* events.publish(SessionEvent.Reasoning.Started, {
      sessionID: chat.id,
      assistantMessageID,
      reasoningID: "r1",
      timestamp: DateTime.makeUnsafe(1),
    })
    yield* events.publish(SessionEvent.Reasoning.Ended, {
      sessionID: chat.id,
      assistantMessageID,
      reasoningID: "r1",
      text: reasoning.text,
      timestamp: DateTime.makeUnsafe(2),
    })
    reasoning.v2 = { messageID: assistantMessageID, reasoningID: "r1" }
    yield* session.updatePart(reasoning)
    const after = "采用后的思考"
    const adopt = (part: SessionV1.ReasoningPart = reasoning, canAdopt = Effect.succeed(true)) =>
      adoptReasoning({
        sessionID: chat.id,
        part,
        replacement: { messageID: info.id, partID: part.id, before: part.text, after },
        canAdopt,
      })
    return { session, chat, info, reasoning, after, adopt }
  })

  it.instance("updates subscribers, reloaded history and model context to the same adopted text", () =>
    Effect.gen(function* () {
      const { session, chat, info, reasoning, after, adopt } = yield* seed()
      const events = yield* EventV2Bridge.Service
      const received = yield* Deferred.make<SessionV1.Part>()
      const unsub = yield* events.listen((event) => {
        if (event.type === SessionV1.Event.PartUpdated.type) {
          const part = Schema.decodeUnknownSync(SessionV1.Event.PartUpdated.data)(event.data).part
          if (part.type === "reasoning" && part.distillation)
            Deferred.doneUnsafe(received, Effect.succeed(part as SessionV1.Part))
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      expect((yield* adopt())?.text).toBe(after)
      expect(yield* awaitDeferred(received, "adoption event missing")).toMatchObject({ id: reasoning.id, text: after })
      const reloaded = yield* session.messages({ sessionID: chat.id })
      const part = reloaded
        .find((message) => message.info.id === info.id)
        ?.parts.find((part) => part.id === reasoning.id)
      expect(part).toMatchObject({ text: after, distillation: { originalText: reasoning.text } })
      const { db } = yield* Database.Service
      const mirror = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, SessionMessage.ID.make(reasoning.v2!.messageID)))
        .get()
        .pipe(Effect.orDie)
      expect(JSON.stringify(mirror?.data)).toContain(after)
      const model = ProviderTest.model({ id: info.modelID, providerID: info.providerID })
      const plain = yield* MessageV2.toModelMessagesEffect(reloaded, model, {
        reasoningDistillationEnabled: true,
      })
      expect(JSON.stringify(plain)).toContain(after)
      expect(JSON.stringify(plain)).not.toContain(reasoning.text)
      expect(JSON.stringify(plain)).not.toContain("sourceFingerprint")
      const interleaved = {
        ...model,
        capabilities: { ...model.capabilities, interleaved: { field: "reasoning_content" as const } },
      }
      const transformed = ProviderTransform.message(structuredClone(plain), interleaved, {})
      expect(JSON.stringify(transformed)).toContain(`"reasoning_content":"${after}"`)
      // A distilled part is never rewritten again.
      if (part?.type !== "reasoning") throw new Error("missing adopted reasoning")
      expect(yield* adopt(part)).toBeUndefined()
      yield* session.remove(chat.id)
    }),
  )

  it.instance("rejects stale or streaming sources without replacing history", () =>
    Effect.gen(function* () {
      const { session, chat, reasoning, adopt } = yield* seed()
      const changed = { ...reasoning, text: "a newer source" }
      yield* session.updatePart(changed)
      expect(yield* adopt()).toBeUndefined()
      expect(
        yield* session.getPart({ sessionID: chat.id, messageID: reasoning.messageID, partID: reasoning.id }),
      ).toMatchObject({ text: changed.text })
      const pending = { ...reasoning, time: { start: 1 } }
      yield* session.updatePart(pending)
      expect(yield* adopt(pending)).toBeUndefined()
      yield* session.remove(chat.id)
    }),
  )

  it.instance("rejects a part whose v2 mirror changed without touching either copy", () =>
    Effect.gen(function* () {
      const { session, chat, info, reasoning, adopt } = yield* seed()
      const events = yield* EventV2Bridge.Service
      yield* events.publish(SessionEvent.Reasoning.Ended, {
        sessionID: chat.id,
        assistantMessageID: SessionMessage.ID.make(reasoning.v2!.messageID),
        reasoningID: "r1",
        text: "mirror moved on",
        timestamp: DateTime.makeUnsafe(3),
      })
      expect(yield* adopt()).toBeUndefined()
      expect(yield* session.getPart({ sessionID: chat.id, messageID: info.id, partID: reasoning.id })).toEqual(
        reasoning,
      )
      yield* session.remove(chat.id)
    }),
  )
  it.instance("rejects adoption once a later assistant attempt exists", () =>
    Effect.gen(function* () {
      const { session, chat, info, reasoning, adopt } = yield* seed()
      // Another process persisted the next attempt; its request may already carry the original reasoning.
      yield* session.updateMessage({ ...info, id: MessageID.ascending(), time: { created: 3 } })
      expect(yield* adopt()).toBeUndefined()
      expect(yield* session.getPart({ sessionID: chat.id, messageID: info.id, partID: reasoning.id })).toEqual(
        reasoning,
      )
      yield* session.remove(chat.id)
    }),
  )
  it.instance("adopts a part whose assistant turn has an earlier continuation attempt", () =>
    Effect.gen(function* () {
      const { session, chat, info, reasoning, after, adopt } = yield* seed()
      const events = yield* EventV2Bridge.Service
      // Each continuation of one assistant turn persists its own V2 attempt. The part belongs to the second
      // attempt, so the first attempt's row is earlier and cannot have carried it. The first id sorts after the
      // second and both share a timestamp, so only the per-session seq proves which row is earlier: ids are not
      // comparable across processes and producer clocks can tie or skew.
      const first = SessionMessage.ID.make("msg_zzzz")
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: chat.id,
        assistantMessageID: first,
        agent: "build",
        model: { id: info.modelID, providerID: info.providerID },
        timestamp: DateTime.makeUnsafe(4),
      })
      const second = SessionMessage.ID.make("msg_aaaa")
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: chat.id,
        assistantMessageID: second,
        agent: "build",
        model: { id: info.modelID, providerID: info.providerID },
        timestamp: DateTime.makeUnsafe(4),
      })
      yield* events.publish(SessionEvent.Reasoning.Started, {
        sessionID: chat.id,
        assistantMessageID: second,
        reasoningID: "r1",
        timestamp: DateTime.makeUnsafe(4),
      })
      yield* events.publish(SessionEvent.Reasoning.Ended, {
        sessionID: chat.id,
        assistantMessageID: second,
        reasoningID: "r1",
        text: reasoning.text,
        timestamp: DateTime.makeUnsafe(5),
      })
      const continued: SessionV1.ReasoningPart = { ...reasoning, v2: { messageID: second, reasoningID: "r1" } }
      yield* session.updatePart(continued)
      expect((yield* adopt(continued))?.text).toBe(after)
      yield* session.remove(chat.id)
    }),
  )
  it.instance("a disabled switch blocks an already prepared adoption", () =>
    Effect.gen(function* () {
      const { session, chat, reasoning, adopt } = yield* seed()
      expect(yield* adopt(reasoning, Effect.succeed(false))).toBeUndefined()
      expect(
        yield* session.getPart({ sessionID: chat.id, messageID: reasoning.messageID, partID: reasoning.id }),
      ).toEqual(reasoning)
    }),
  )
})
