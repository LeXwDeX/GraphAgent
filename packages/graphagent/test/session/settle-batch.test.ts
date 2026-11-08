import { describe, expect } from "bun:test"
import { asc, desc, eq } from "drizzle-orm"
import { Deferred, Effect, Layer, Stream } from "effect"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { EventTable } from "@graphagent/core/event/sql"
import { SessionProjector } from "@graphagent/core/session/projector"
import { SessionV1 } from "@graphagent/core/v1/session"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { BackgroundJob } from "@/background/job"
import { Dag } from "@/dag/dag"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Goal } from "@/goal/goal"
import { SessionAutomationLease } from "@/session/automation-lease"
import { MessageID, PartID } from "@/session/schema"
import { Session as SessionNs } from "@/session/session"
import { Storage } from "@/storage/storage"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { countingDatabaseLayer, countingEventLayer, reset, snapshot } from "../lib/engine-probe"

// H5/HS4 c: `Session.settle` must publish the step-finish part, the assistant
// message and the optional patch part as ONE durable transaction. The layer
// mirrors test/session/fork-batch.test.ts: the bare Session.layer composed
// against the counting database and event bus from engine-probe, because
// Session.defaultLayer self-provides Database and EventV2Bridge and would
// bypass the counters.
const dbLayer = countingDatabaseLayer
const eventLayer = countingEventLayer(EventV2.layer.pipe(Layer.provide(dbLayer)))
const bridgeLayer = EventV2Bridge.layer.pipe(Layer.provide(eventLayer))
const projectorLayer = SessionProjector.layer.pipe(Layer.provide(eventLayer), Layer.provide(dbLayer))

const it = testEffect(
  Layer.mergeAll(
    dbLayer,
    eventLayer,
    bridgeLayer,
    SessionNs.layer.pipe(
      Layer.provide(Storage.defaultLayer),
      Layer.provide(dbLayer),
      Layer.provide(bridgeLayer),
      Layer.provide(projectorLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
      Layer.provide(Goal.defaultLayer),
      Layer.provide(SessionAutomationLease.defaultLayer),
      Layer.provide(Dag.defaultLayer),
    ),
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  ),
)

const userInfo = (sessionID: string, id: string) =>
  ({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "user",
    model: { providerID: "test", modelID: "test" },
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- persisted test fixture mirrors the V1 schema shape
  }) as unknown as SessionV1.Info

const assistantInfo = (sessionID: string, id: string, parentID: string) =>
  ({
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: "test",
    providerID: "test",
    mode: "",
    agent: "assistant",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- persisted test fixture mirrors the V1 schema shape
  }) as unknown as SessionV1.Info

const textPart = (sessionID: string, messageID: string, text: string) =>
  ({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "text",
    text,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- persisted test fixture mirrors the V1 schema shape
  }) as unknown as SessionV1.Part

describe("Session.settle batch (HS4 c)", () => {
  it.instance("commits the message and every part in one transaction with a contiguous sequence", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const { db } = yield* Database.Service

      const info = yield* Effect.acquireRelease(session.create({ title: "settle" }), (created) =>
        session.remove(created.id).pipe(Effect.ignore),
      )
      const user = userInfo(info.id, MessageID.ascending())
      yield* session.updateMessage(user)
      // The settle payload mirrors the processor: it publishes the assistant
      // message's final state (completed timestamp, accumulated cost), which
      // differs from the step-start row, so the duplicate gate appends it.
      const assistant = assistantInfo(info.id, MessageID.ascending(), user.id)
      yield* session.updateMessage(assistant)
      const completed = {
        ...assistant,
        time: { ...assistant.time, completed: Date.now() },
        cost: 0.01,
      } as SessionV1.Info
      const part1 = textPart(info.id, assistant.id, "first")
      const part2 = textPart(info.id, assistant.id, "second")
      const before = yield* db
        .select({ seq: EventTable.seq })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, info.id))
        .orderBy(desc(EventTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)

      reset()
      yield* session.settle({ messages: [user], parts: [part1, part2] })
      const counts = snapshot()

      // One BEGIN IMMEDIATE/COMMIT for the whole batch. A per-event publish
      // would have produced three commits, and the fork copy path's nested
      // savepoints would show up here too.
      expect(counts.commits).toBe(1)
      expect(counts["events.durable"]).toBe(3)

      const rows = yield* db
        .select({ seq: EventTable.seq, type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, info.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      const batch = rows.filter((row) => row.seq > (before?.seq ?? -1))
      // Messages precede their parts inside the batch so a part projector can
      // always find its parent row.
      expect(batch.map((row) => row.type)).toEqual([
        "message.updated.1",
        "message.part.updated.1",
        "message.part.updated.1",
      ])
      const firstSeq = batch[0]?.seq ?? -1
      expect(batch.map((row) => row.seq)).toEqual([firstSeq, firstSeq + 1, firstSeq + 2])
      // Parts carry the single timestamp of the settle call.
      const times = batch.slice(1).map((row) => (row.data as { time: number }).time)
      expect(times[0]).toBe(times[1])
    }),
  )

  it.instance("hands the caller's part objects to the bus without a defensive clone", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const info = yield* Effect.acquireRelease(session.create({ title: "settle-reference" }), (created) =>
        session.remove(created.id).pipe(Effect.ignore),
      )
      const user = userInfo(info.id, MessageID.ascending())
      yield* session.updateMessage(user)
      const part1 = textPart(info.id, user.id, "first")
      const part2 = textPart(info.id, user.id, "second")
      const seen: Array<(typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]> = []
      const done = yield* Deferred.make<ReadonlyArray<(typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]>>()
      yield* events.subscribe(SessionV1.Event.PartUpdated).pipe(
        Stream.runForEach((payload) => {
          if (payload.data.sessionID !== info.id) return Effect.void
          seen.push(payload.data.part)
          return seen.length === 2 ? Deferred.succeed(done, [...seen]).pipe(Effect.asVoid) : Effect.void
        }),
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* session.settle({ messages: [user], parts: [part1, part2] })
      const published = yield* awaitWithTimeout(Deferred.await(done), "settle did not publish both parts")

      // Reference identity proves the settle path skipped structuredClone; the
      // projector consumed the same objects the caller handed over.
      expect(published[0]).toBe(part1)
      expect(published[1]).toBe(part2)
    }),
  )

  it.instance("publishes nothing when the batch is empty", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      yield* Effect.acquireRelease(session.create({ title: "settle-empty" }), (created) =>
        session.remove(created.id).pipe(Effect.ignore),
      )

      reset()
      yield* session.settle({})
      const counts = snapshot()
      expect(counts.commits).toBe(0)
      expect(counts["events.durable"]).toBe(0)
    }),
  )
})
