// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1029, PR0 probe: does a subscriber see an event whose enclosing
 * transaction rolls back?
 *
 * `publish` commits through `db.transaction`. Inside an enclosing transaction
 * (a DagMessages fence, a settlement) that call is a savepoint, and `publish`
 * goes on to `notify` as soon as the savepoint is released, not after the
 * OUTERMOST commit. When the enclosing transaction then rolls back, the event
 * is in no table, but `subscribe`, `all` (the EventV2Bridge forwards it to
 * GlobalBus) and the DAG loop's handlers have already received it: a phantom
 * event. The `onCommitted` observers and the mailbox `changed` stream avoid
 * this by deferring through `afterCommit`; `notify` does not.
 *
 * The probe is a known defect, registered with `test.failing`: green while the
 * phantom exists, red once PR3a (the transaction wrapper, with the notify moved
 * behind the outermost commit) fixes it, which is the signal to make it a
 * plain test. `DAG_RACES_STRICT=1` runs it as a plain test to show the
 * failure.
 */

import { describe, expect, test } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { EventTable } from "@graphagent/core/event/sql"
import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import type { Scope } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { testEffect } from "./lib/effect"

const Message = EventV2.define({
  type: "test.rollback.message",
  durable: { version: 1, aggregate: "id" },
  schema: { id: Schema.String, text: Schema.String },
})

const eventLayer = Layer.mergeAll(EventV2.layerWith().pipe(Layer.provide(Database.defaultLayer)), Database.defaultLayer)
const it = testEffect(eventLayer)

const known = process.env["DAG_RACES_STRICT"] === "1" ? test : test.failing

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

const run = <A, E>(body: Effect.Effect<A, E, EventV2.Service | Database.Service | Scope.Scope>) =>
  Effect.runPromise(body.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(eventLayer, TestConsole.layer))))

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
  // delivered. Today `subscribe` and `all` both receive "phantom". Fixed by
  // PR3a.
  known("subscribers do not receive an event published in a transaction that rolls back", () =>
    run(
      Effect.gen(function* () {
        const { seen } = yield* rolledBackPublish

        expect(seen.subscribe).toEqual(["sentinel"])
        expect(seen.all).toEqual(["sentinel"])
      }),
    ),
  )
})
