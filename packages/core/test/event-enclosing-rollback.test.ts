// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1029: does a subscriber see an event whose enclosing transaction
 * rolls back?
 *
 * `publish` commits through `db.transaction`. Inside an enclosing transaction
 * (a `DagTransact` body, a DagMessages fence, a settlement) that call is a
 * savepoint, and `publish` used to `notify` as soon as the savepoint was
 * released, not after the OUTERMOST commit. When the enclosing transaction then
 * rolled back, the event was in no table, but `subscribe`, `all` (the
 * EventV2Bridge forwards it to GlobalBus), `listen` and the DAG loop's handlers
 * had already received it: a phantom event. PR0 registered the probe as a known
 * defect; PR3a moves delivery behind the outermost commit, the route the
 * `onCommitted` observers and the mailbox `changed` stream already take, and
 * the probe is a plain test. The second half of the file pins the delivery
 * contract: nothing before the outermost COMMIT, publish order after it, a
 * rolled-back savepoint's events dropped, and no change outside a transaction.
 */

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { EventTable } from "@graphagent/core/event/sql"
import { DagEvent } from "@graphagent/schema/dag-event"
import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"

const Message = EventV2.define({
  type: "test.rollback.message",
  durable: { version: 1, aggregate: "id" },
  schema: { id: Schema.String, text: Schema.String },
})

const eventLayer = Layer.mergeAll(EventV2.layerWith().pipe(Layer.provide(Database.defaultLayer)), Database.defaultLayer)
const it = testEffect(eventLayer)

const textOf = (event: EventV2.Payload) => Schema.decodeUnknownSync(Message.data)(event.data).text

/**
 * Publish inside a transaction that rolls back, then a committed sentinel.
 * Subscribers are FIFO, so once both have seen the sentinel they have seen
 * everything the rolled-back publish delivered: no sleeping, no race.
 */
const rolledBackPublish = Effect.gen(function* () {
  const events = yield* EventV2.Service
  const { db } = yield* Database.Service
  const seen = { subscribe: new Array<string>(), all: new Array<string>() }
  const sawSubscribe = yield* Deferred.make<void>()
  const sawAll = yield* Deferred.make<void>()
  const collect = (into: string[], done: Deferred.Deferred<void>) => (event: EventV2.Payload) =>
    Effect.sync(() => into.push(textOf(event))).pipe(
      Effect.andThen(textOf(event) === "sentinel" ? Deferred.succeed(done, undefined) : Effect.void),
    )
  yield* events
    .subscribe(Message)
    .pipe(Stream.runForEach(collect(seen.subscribe, sawSubscribe)), Effect.forkScoped({ startImmediately: true }))
  yield* events.all().pipe(Stream.runForEach(collect(seen.all, sawAll)), Effect.forkScoped({ startImmediately: true }))

  const phantomID = EventV2.ID.create()
  const sentinelID = EventV2.ID.create()
  const outer = yield* Effect.exit(
    db.transaction(() =>
      Effect.gen(function* () {
        yield* events.publish(Message, { id: phantomID, text: "phantom" })
        return yield* Effect.die("outer rollback")
      }),
    ),
  )
  yield* events.publish(Message, { id: sentinelID, text: "sentinel" })
  yield* Deferred.await(sawSubscribe)
  yield* Deferred.await(sawAll)

  const rows = yield* db.select({ aggregateID: EventTable.aggregate_id }).from(EventTable).all()
  return { outer, seen, durable: rows.map((row) => row.aggregateID), sentinelID }
})

describe("EventV2 enclosing-transaction rollback", () => {
  it.effect("control: the rolled-back publish leaves no durable event, a committed one reaches the subscribers", () =>
    Effect.gen(function* () {
      const { outer, seen, durable, sentinelID } = yield* rolledBackPublish

      expect(outer._tag).toBe("Failure")
      // Only the sentinel was committed.
      expect(durable).toEqual([sentinelID])
      expect(seen.subscribe).toContain("sentinel")
      expect(seen.all).toContain("sentinel")
    }),
  )

  // Expected: a publish whose enclosing transaction rolls back is never
  // delivered. Before PR3a `subscribe` and `all` both received "phantom".
  it.effect("subscribers do not receive an event published in a transaction that rolls back", () =>
    Effect.gen(function* () {
      const { seen } = yield* rolledBackPublish

      expect(seen.subscribe).toEqual(["sentinel"])
      expect(seen.all).toEqual(["sentinel"])
    }),
  )
})

// -- delivery follows the OUTERMOST commit (Issue #1029, PR3a) ----------------

const Local = EventV2.define({ type: "test.rollback.local", schema: { text: Schema.String } })

const Sentinel = EventV2.define({
  type: "test.rollback.sentinel",
  durable: { version: 1, aggregate: "id" },
  schema: { id: Schema.String, text: Schema.String },
})

/** The text of any test event, durable or not. */
const anyText = (event: EventV2.Payload) =>
  Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(event.data).text

/** A count that consumers raise and a test can wait on without polling: `reached(n)` completes once it is at least n. */
const counter = Effect.gen(function* () {
  let value = 0
  const waiters = new Array<{ readonly target: number; readonly done: Deferred.Deferred<void> }>()
  const bump = Effect.gen(function* () {
    value += 1
    for (const waiter of waiters) if (value >= waiter.target) yield* Deferred.succeed(waiter.done, undefined)
  })
  const reached = (target: number) =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<void>()
      // Looking and registering is one synchronous step, so no bump can fall between them.
      if (value >= target) yield* Deferred.succeed(done, undefined)
      else waiters.push({ target, done })
      yield* Deferred.await(done)
    })
  return { bump, reached }
})

/**
 * Watchers on every delivery path: the typed stream of `Message`, the all-events
 * stream and the deprecated `listen` callbacks. `finish` publishes a committed
 * sentinel and returns once every watcher has what the all-events stream had by
 * then. That stream is FIFO, so what it has seen when the sentinel arrives is
 * everything delivered before it. The typed stream and the `listen` callbacks
 * are consumed on fibers of their own, with no order across events guaranteed,
 * so each signals its own progress and `finish` waits for it to catch up
 * instead of assuming when it runs.
 */
const watching = Effect.gen(function* () {
  const events = yield* EventV2.Service
  const seen = { typed: new Array<string>(), all: new Array<string>(), listen: new Array<string>() }
  const sawSentinel = yield* Deferred.make<void>()
  const typedTook = yield* counter
  const listenTook = yield* counter
  let messagesInAll = 0
  yield* events.subscribe(Message).pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => void seen.typed.push(anyText(event))).pipe(Effect.andThen(typedTook.bump)),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )
  yield* events.all().pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        seen.all.push(anyText(event))
        if (event.type === Message.type) messagesInAll += 1
      }).pipe(Effect.andThen(anyText(event) === "sentinel" ? Deferred.succeed(sawSentinel, undefined) : Effect.void)),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )
  yield* events.listen((event) =>
    Effect.sync(() => void seen.listen.push(anyText(event))).pipe(Effect.andThen(listenTook.bump)),
  )
  const finish = Effect.gen(function* () {
    yield* events.publish(Sentinel, { id: EventV2.ID.create(), text: "sentinel" })
    yield* Deferred.await(sawSentinel)
    yield* typedTook.reached(messagesInAll)
    yield* listenTook.reached(seen.all.length)
  })
  return { events, seen, finish }
})

describe("EventV2 delivery waits for the outermost commit", () => {
  it.effect("delivers an enclosing transaction's events only after it commits, in publish order", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const { events, seen, finish } = yield* watching
      const id = EventV2.ID.create()

      yield* db.transaction(() =>
        Effect.gen(function* () {
          // `afterCommit` callbacks run in registration order once the transaction commits, and a delivery is one of
          // them. A marker registered ahead of every publish therefore goes out at the commit, ahead of every delivery:
          // an event delivered when it was published would be queued before the marker instead.
          yield* db.$client.afterCommit(events.publish(Local, { text: "commit" }))
          yield* events.publish(Message, { id, text: "first" })
          yield* events.publish(Local, { text: "second" })
          yield* events.publishMany([
            { definition: Message, data: { id, text: "third" } },
            { definition: Message, data: { id, text: "fourth" } },
          ])
        }),
      )

      yield* finish
      expect(seen.all).toEqual(["commit", "first", "second", "third", "fourth", "sentinel"])
      expect(seen.typed).toEqual(["first", "third", "fourth"])
      expect(seen.listen.slice().sort()).toEqual(["commit", "first", "fourth", "second", "sentinel", "third"])
    }),
  )

  it.effect("delivers a batch published inside a rolled-back transaction to nobody", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const { events, seen, finish } = yield* watching
      const id = EventV2.ID.create()

      const outer = yield* Effect.exit(
        db.transaction(() =>
          Effect.gen(function* () {
            yield* events.publishMany([
              { definition: Message, data: { id, text: "batched-1" } },
              { definition: Message, data: { id, text: "batched-2" } },
            ])
            yield* events.publish(Local, { text: "local" })
            return yield* Effect.die("outer rollback")
          }),
        ),
      )
      yield* finish

      expect(outer._tag).toBe("Failure")
      expect(seen.all).toEqual(["sentinel"])
      expect(seen.typed).toEqual([])
      expect(seen.listen).toEqual(["sentinel"])
    }),
  )

  it.effect("drops a rolled-back savepoint's events and keeps the enclosing transaction's", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const { events, seen, finish } = yield* watching
      const id = EventV2.ID.create()

      yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* events.publish(Message, { id, text: "kept-1" })
          yield* db
            .transaction(() =>
              Effect.gen(function* () {
                yield* events.publish(Message, { id, text: "dropped" })
                return yield* Effect.die("inner rollback")
              }),
            )
            .pipe(Effect.exit)
          yield* events.publish(Message, { id, text: "kept-2" })
        }),
      )
      yield* finish

      expect(seen.all).toEqual(["kept-1", "kept-2", "sentinel"])
      expect(seen.typed).toEqual(["kept-1", "kept-2"])
      expect(seen.listen.slice().sort()).toEqual(["kept-1", "kept-2", "sentinel"])
    }),
  )

  it.effect("delivers a replay's events only after the enclosing transaction commits", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const delivered = new Array<string>()
      const sawSentinel = yield* Deferred.make<void>()
      yield* events.all().pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => delivered.push(event.type)).pipe(
            Effect.andThen(event.type === Sentinel.type ? Deferred.succeed(sawSentinel, undefined) : Effect.void),
          ),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      const replayed = (dagID: string) => ({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DagEvent.WorkflowPaused.type, 1),
        aggregateID: dagID,
        seq: 0,
        data: { dagID, timestamp: 0 },
      })

      // Rolled back: no delivery.
      yield* Effect.exit(
        db.transaction(() =>
          Effect.gen(function* () {
            yield* events.replay(replayed(DagEvent.DagID.create()), { publish: true })
            return yield* Effect.die("outer rollback")
          }),
        ),
      )
      // Committed: delivered once the transaction is over, not before. The marker goes out at the commit, ahead of
      // the replay's delivery, which was registered after it.
      yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* db.$client.afterCommit(events.publish(Local, { text: "commit" }))
          yield* events.replay(replayed(DagEvent.DagID.create()), { publish: true })
        }),
      )
      // The stream is FIFO: once the sentinel, published after both, has arrived, so has everything before it.
      yield* events.publish(Sentinel, { id: EventV2.ID.create(), text: "sentinel" })
      yield* Deferred.await(sawSentinel)
      expect(delivered).toEqual([Local.type, DagEvent.WorkflowPaused.type, Sentinel.type])
    }),
  )

  it.effect(
    "control: a publish outside any transaction is delivered at once, ahead of what is published after it",
    () =>
      Effect.gen(function* () {
        const { events, seen, finish } = yield* watching

        yield* events.publish(Message, { id: EventV2.ID.create(), text: "plain" })
        yield* events.publish(Local, { text: "plain-local" })
        yield* finish

        expect(seen.all).toEqual(["plain", "plain-local", "sentinel"])
        expect(seen.typed).toEqual(["plain"])
        expect(seen.listen.slice().sort()).toEqual(["plain", "plain-local", "sentinel"])
      }),
  )

  it.effect("control: a failing publish outside any transaction delivers nothing", () =>
    Effect.gen(function* () {
      const { events, seen, finish } = yield* watching
      yield* events.project(Message, () => Effect.die("projector failed"))

      const exit = yield* Effect.exit(events.publish(Message, { id: EventV2.ID.create(), text: "never" }))
      yield* finish

      expect(exit._tag).toBe("Failure")
      expect(seen.all).toEqual(["sentinel"])
    }),
  )
})
