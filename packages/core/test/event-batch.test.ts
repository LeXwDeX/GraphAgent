import { describe, expect } from "bun:test"
import { Deferred, Duration, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { EventV2 } from "@graphagent/core/event"
import { Database } from "@graphagent/core/database/database"
import { EventSequenceTable, EventTable } from "@graphagent/core/event/sql"
import { Location } from "@graphagent/core/location"
import { AbsolutePath } from "@graphagent/core/schema"
import { Session } from "@graphagent/schema/session"
import { SessionV1 } from "@graphagent/schema/session-v1"
import { WorkspaceV2 } from "@graphagent/core/workspace"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location({ directory: AbsolutePath.make("project"), workspaceID: WorkspaceV2.ID.make("wrk_test") }),
  ),
)

const Message = EventV2.define({
  type: "batch.message",
  durable: {
    version: 1,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

const OtherMessage = EventV2.define({
  type: "batch.other",
  durable: {
    version: 1,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

const LiveMessage = EventV2.define({
  type: "batch.live",
  schema: {
    text: Schema.String,
  },
})

const DurableMessage = SessionV1.Event.MessageRemoved

const eventLayer = Layer.mergeAll(EventV2.layerWith().pipe(Layer.provide(Database.defaultLayer)), Database.defaultLayer)
const it = testEffect(eventLayer.pipe(Layer.provideMerge(locationLayer)))
const itWithoutLocation = testEffect(eventLayer)

const batch = (aggregateID: string, texts: string[]) =>
  texts.map((text) => ({ definition: Message, data: { id: aggregateID, text } }))

const rows = (aggregateID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, aggregateID))
      .orderBy(EventTable.seq)
      .all()
      .pipe(Effect.orDie)
  })

describe("EventV2.publishMany", () => {
  it.effect("produces the same final state as sequential publish", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const batchAggregate = EventV2.ID.create()
      const singleAggregate = EventV2.ID.create()

      const batched = yield* events.publishMany(batch(batchAggregate, ["a", "b", "c"]))
      yield* events.publish(Message, { id: singleAggregate, text: "a" })
      yield* events.publish(Message, { id: singleAggregate, text: "b" })
      yield* events.publish(Message, { id: singleAggregate, text: "c" })

      const batchRows = yield* rows(batchAggregate)
      const singleRows = yield* rows(singleAggregate)
      const summarize = (list: Array<{ seq: number; type: string; data: Record<string, unknown> }>) =>
        list.map(({ seq, type, data }) => ({ seq, type, text: (data as { text: string }).text }))
      expect(summarize(batchRows)).toEqual(summarize(singleRows))
      expect(
        batched.map((event) => [(event.data as { text: string }).text, event.durable?.seq]),
      ).toEqual([
        ["a", 0],
        ["b", 1],
        ["c", 2],
      ])
    }),
  )

  it.effect("assigns contiguous seq across batch boundaries", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(Message, { id: aggregateID, text: "seed" })
      yield* events.publishMany(batch(aggregateID, ["a", "b"]))
      yield* events.publishMany(batch(aggregateID, ["c"]))
      yield* events.publish(Message, { id: aggregateID, text: "tail" })

      expect((yield* rows(aggregateID)).map((row) => row.seq)).toEqual([0, 1, 2, 3, 4])
    }),
  )

  it.effect("runs projectors in entry order inside the transaction", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      yield* events.project(Message, (event) => Effect.sync(() => received.push(event)))
      const aggregateID = EventV2.ID.create()

      yield* events.publishMany(batch(aggregateID, ["a", "b", "c"]))

      expect(received.map((event) => [(event.data as { text: string }).text, event.durable?.seq])).toEqual([
        ["a", 0],
        ["b", 1],
        ["c", 2],
      ])
    }),
  )

  it.effect("runs per-event commit hooks in order inside the transaction", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const commits = new Array<number>()
      const aggregateID = EventV2.ID.create()

      yield* events.publishMany(
        batch(aggregateID, ["a", "b"]).map((entry, index) => ({
          ...entry,
          options: { commit: (seq) => Effect.sync(() => commits.push(seq * 10 + index)) },
        })),
      )

      expect(commits).toEqual([0, 11])
    }),
  )

  it.effect("rolls back the whole batch when a commit hook fails", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      const exit = yield* events
        .publishMany(
          batch(aggregateID, ["a", "b", "c"]).map((entry, index) => ({
            ...entry,
            options: index === 1 ? { commit: () => Effect.die("commit failed") } : undefined,
          })),
        )
        .pipe(Effect.exit)

      expect(String(exit)).toContain("commit failed")
      expect(yield* rows(aggregateID)).toEqual([])
    }),
  )

  it.effect("notifies typed and wildcard subscribers once per event", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      const typed = yield* events.subscribe(Message).pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped)
      const wildcard = yield* events.all().pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* events.publishMany(batch(aggregateID, ["a", "b", "c"]))

      expect(Array.from(yield* Fiber.join(typed)).map((event) => [(event.data as { text: string }).text, event.durable?.seq])).toEqual([
        ["a", 0],
        ["b", 1],
        ["c", 2],
      ])
      expect(
        Array.from(yield* Fiber.join(wildcard)).map((event) => [(event.data as { text: string }).text, event.durable?.seq]),
      ).toEqual([
        ["a", 0],
        ["b", 1],
        ["c", 2],
      ])
    }),
  )

  it.live("does not block the publish path on a slow listener", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      yield* events.listen(() => Effect.never)
      const aggregateID = EventV2.ID.create()

      const published = yield* events.publishMany(batch(aggregateID, ["a", "b"])).pipe(
        Effect.timeoutOption(Duration.millis(250)),
      )

      expect(Option.isSome(published)).toBeTrue()
      expect(yield* rows(aggregateID)).toHaveLength(2)
    }),
  )

  it.effect("isolates listener defects while other listeners still receive events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      const arrived = yield* Deferred.make<void>()
      yield* events.listen(() => Effect.die("listener defect"))
      yield* events.listen((event) =>
        Effect.sync(() => received.push(event.type)).pipe(Effect.andThen(Deferred.succeed(arrived, undefined))),
      )
      const aggregateID = EventV2.ID.create()

      const published = yield* events.publishMany(batch(aggregateID, ["a", "b"]))
      yield* Deferred.await(arrived)

      expect(published).toHaveLength(2)
      expect(received).toEqual([Message.type, Message.type])
    }),
  )

  it.effect("rejects events from different aggregates", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const exit = yield* events
        .publishMany([
          { definition: Message, data: { id: "agg-a", text: "a" } },
          { definition: Message, data: { id: "agg-b", text: "b" } },
        ])
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Batch events must belong to the same aggregate")
      expect(yield* rows("agg-a")).toEqual([])
      expect(yield* rows("agg-b")).toEqual([])
    }),
  )

  it.effect("rejects live-only definitions", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const exit = yield* events
        .publishMany([{ definition: LiveMessage, data: { text: "live" } }])
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Batch events require a durable definition")
    }),
  )

  it.effect("supports mixed definitions sharing one aggregate", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()

      const published = yield* events.publishMany([
        { definition: Message, data: { id: aggregateID, text: "a" } },
        { definition: OtherMessage, data: { id: aggregateID, text: "b" } },
      ])

      expect(published.map((event) => [event.type, event.durable?.seq])).toEqual([
        [Message.type, 0],
        [OtherMessage.type, 1],
      ])
      expect((yield* rows(aggregateID)).map((row) => [row.type, row.seq])).toEqual([
        [EventV2.versionedType(Message.type, 1), 0],
        [EventV2.versionedType(OtherMessage.type, 1), 1],
      ])
    }),
  )

  it.effect("returns no payloads for an empty batch", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      expect(yield* events.publishMany([])).toEqual([])
    }),
  )

  it.effect("keeps replay and readAfter compatible with batch-published events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const data = (text: string) => ({
        sessionID: aggregateID,
        messageID: SessionV1.MessageID.ascending(`msg_${text}`),
      })
      yield* events.publishMany([
        { definition: DurableMessage, data: data("a") },
        { definition: DurableMessage, data: data("b") },
        { definition: DurableMessage, data: data("c") },
      ])

      const fiber = yield* events
        .durable({ aggregateID, after: 2 })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* events.publishMany([
        { definition: DurableMessage, data: data("d") },
        { definition: DurableMessage, data: data("e") },
      ])
      const tail = Array.from(yield* Fiber.join(fiber))

      expect(tail.map((event) => [(event.data as { messageID: string }).messageID, event.durable?.seq])).toEqual([
        [data("d").messageID, 3],
        [data("e").messageID, 4],
      ])
      const replayed = yield* events.replayAll([
        ...(yield* rows(aggregateID)).map((row) => ({
          id: row.id,
          type: row.type,
          seq: row.seq,
          aggregateID,
          data: row.data,
        })),
      ])
      expect(replayed).toBe(aggregateID)
    }),
  )

  it.effect("stays sequence-safe under concurrent batch publication", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()

      const fiberA = yield* events.publishMany(batch(aggregateID, ["a", "b"])).pipe(Effect.forkScoped)
      const fiberB = yield* events.publishMany(batch(aggregateID, ["c", "d"])).pipe(Effect.forkScoped)
      yield* Fiber.join(fiberA)
      yield* Fiber.join(fiberB)

      expect((yield* rows(aggregateID)).map((row) => row.seq)).toEqual([0, 1, 2, 3])
    }),
  )

  itWithoutLocation.effect("attaches an explicit location to every batch event", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      const explicit = Location.Ref.make({
        directory: AbsolutePath.make("explicit"),
        workspaceID: WorkspaceV2.ID.make("wrk_explicit"),
      })

      const published = yield* events.publishMany(batch(aggregateID, ["a", "b"]), { location: explicit })

      expect(published.map((event) => event.location)).toEqual([explicit, explicit])
    }),
  )
})
