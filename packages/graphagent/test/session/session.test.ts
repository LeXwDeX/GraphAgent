import { adoptReasoning } from "@/session/reasoning-adoption"
import { ProviderTest } from "../fake/provider"
import { ProviderTransform } from "@/provider/transform"
import { ProviderV2 } from "@graphagent/core/provider"
import { ModelV2 } from "@graphagent/core/model"
import { describe, expect } from "bun:test"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { EventTable } from "@graphagent/core/event/sql"
import { eq } from "drizzle-orm"
import { SessionProjector } from "@graphagent/core/session/projector"
import { Schema, Deferred, Effect, Exit, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { Goal } from "@/goal/goal"
import { SessionAutomationLease } from "@/session/automation-lease"
import { Dag } from "@/dag/dag"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
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

describe("session agent and model switches", () => {
  it.instance("publishes durable switch events and updates only the switched columns", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "switch" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      const received = yield* Deferred.make<void>()
      const seen: EventV2.Payload[] = []
      const unsub = yield* events.listen((event) => {
        if (event.type !== SessionV1.Event.AgentSwitched.type && event.type !== SessionV1.Event.ModelSwitched.type)
          return Effect.void
        seen.push(event)
        if (seen.length === 2) Deferred.doneUnsafe(received, Effect.void)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const model = {
        id: ModelV2.ID.make("model-b"),
        providerID: ProviderV2.ID.make("provider-b"),
        variant: "high",
      }
      yield* session.setAgent({ sessionID: created.id, agent: "plan", timestamp: 1 })
      yield* session.setModelSelection({ sessionID: created.id, model, timestamp: 2 })
      yield* awaitDeferred(received, "timed out waiting for switch events")

      expect(seen.map((event) => event.type)).toEqual([
        SessionV1.Event.AgentSwitched.type,
        SessionV1.Event.ModelSwitched.type,
      ])
      expect(seen[0].data).toMatchObject({ sessionID: created.id, agent: "plan", timestamp: 1 })
      expect(seen[1].data).toMatchObject({ sessionID: created.id, model, timestamp: 2 })
      expect(seen[0].durable).toMatchObject({ aggregateID: created.id, version: 1 })
      expect(seen[1].durable).toMatchObject({ aggregateID: created.id, version: 1 })

      // Switching writes only its own column: the untouched title survives.
      const saved = yield* session.get(created.id)
      expect(saved.title).toBe("switch")
      expect(saved.agent).toBe("plan")
      expect(saved.model).toEqual(model)

      // Switches publish the V1 durable events only; no session.next.* row may be written.
      const { db } = yield* Database.Service
      const types = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .pipe(Effect.orDie)
      expect(types.filter((row) => row.type.startsWith("session.next."))).toEqual([])
    }),
  )

  it.instance("switches interleaved with a token increment keep title, cost and tokens", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "rename-me" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      yield* session.setTitle({ sessionID: created.id, title: "renamed" })

      const messageID = MessageID.ascending()
      yield* session.updateMessage({
        id: messageID,
        sessionID: created.id,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as SessionV1.Info)

      const model = { id: ModelV2.ID.make("model-b"), providerID: ProviderV2.ID.make("provider-b") }
      // The switch projections and the step-finish usage projection run
      // concurrently. Each one writes only its own columns, so no update can
      // clobber the title, cost or token counters written by another.
      yield* Effect.all(
        [
          session.updatePart({
            id: PartID.ascending(),
            messageID,
            sessionID: created.id,
            type: "step-finish",
            reason: "stop",
            cost: 0.25,
            tokens: { total: 1500, input: 500, output: 800, reasoning: 200, cache: { read: 100, write: 50 } },
          } satisfies SessionV1.StepFinishPart),
          session.setAgent({ sessionID: created.id, agent: "plan" }),
          session.setModelSelection({ sessionID: created.id, model }),
        ],
        { concurrency: "unbounded" },
      )

      const saved = yield* session.get(created.id)
      expect(saved.title).toBe("renamed")
      expect(saved.agent).toBe("plan")
      expect(saved.model).toMatchObject({ id: "model-b", providerID: "provider-b" })
      expect(saved.cost).toBe(0.25)
      expect(saved.tokens).toEqual({ input: 500, output: 800, reasoning: 200, cache: { read: 100, write: 50 } })
    }),
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

      expect(saved.metadata).toEqual({ ...meta, engine: "v1", hookTitleSource: "custom" })
      expect(fork.metadata).toEqual({ ...meta, engine: "v1", hookTitleSource: "custom" })
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

      expect(created.metadata).toEqual({ engine: "v1", hookTitleSource: "custom" })
      expect(saved.metadata).toEqual({ engine: "v1", hookTitleSource: "custom" })
    }),
  )

  it.instance("persists creation-time dagMode and leaves it unchanged on update", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "dag-on", dagMode: "on" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)

      expect(created.dagMode).toBe("on")
      expect(created.dagBudgetTokens).toBeNull()
      expect(saved.dagMode).toBe("on")
      expect(saved.dagBudgetTokens).toBeNull()

      const updated = yield* session.applyUpdate({ sessionID: created.id, title: "dag-on-renamed" })
      expect(updated.title).toBe("dag-on-renamed")
      expect(updated.dagMode).toBe("on")

      const defaulted = yield* Effect.acquireRelease(session.create({ title: "dag-default" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      expect(defaulted.dagMode).toBe("off")
      expect(defaulted.dagBudgetTokens).toBeNull()
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

  it.instance("adopts a source already sent by a later assistant attempt", () =>
    Effect.gen(function* () {
      const { session, chat, info, reasoning, after, adopt } = yield* seed()
      yield* session.updateMessage({ ...info, id: MessageID.ascending(), time: { created: 3 } })
      expect((yield* adopt())?.text).toBe(after)
      expect((yield* session.getPart({ sessionID: chat.id, messageID: info.id, partID: reasoning.id }))?.type).toBe(
        "reasoning",
      )
      yield* session.remove(chat.id)
    }),
  )

  it.instance("deleted source or session and adoption defects retain history without failing the turn", () =>
    Effect.gen(function* () {
      const { session, chat, reasoning, adopt } = yield* seed()
      expect(yield* adopt(reasoning, Effect.die(new Error("validation defect")))).toBeUndefined()
      expect(
        yield* session.getPart({ sessionID: chat.id, messageID: reasoning.messageID, partID: reasoning.id }),
      ).toEqual(reasoning)
      yield* session.remove(chat.id)
      expect(yield* adopt()).toBeUndefined()
    }),
  )

  it.instance("drops finished reasoning rewrites outside the compacted replay range", () =>
    Effect.gen(function* () {
      const { session, chat, info, reasoning, adopt } = yield* seed()
      const compactID = MessageID.ascending()
      yield* session.updateMessage({
        id: compactID,
        sessionID: chat.id,
        role: "user",
        agent: "build",
        model: { providerID: info.providerID, modelID: info.modelID },
        time: { created: 3 },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: compactID,
        type: "compaction",
        auto: true,
      })
      yield* session.updateMessage({
        ...info,
        id: MessageID.ascending(),
        parentID: compactID,
        summary: true,
        finish: "stop",
        time: { created: 4, completed: 5 },
      })
      expect(yield* adopt()).toBeUndefined()
      expect(
        yield* session.getPart({ sessionID: chat.id, messageID: reasoning.messageID, partID: reasoning.id }),
      ).toEqual(reasoning)
    }),
  )

  it.instance("a deleted reasoning source message is an ordinary adoption rejection", () =>
    Effect.gen(function* () {
      const { session, chat, info, adopt } = yield* seed()
      yield* session.removeMessage({ sessionID: chat.id, messageID: info.id })
      expect(yield* adopt()).toBeUndefined()
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
