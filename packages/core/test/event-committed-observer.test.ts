// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { DagEvent } from "@graphagent/schema/dag-event"
import { DateTime, Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"

// `onCommitted` is the write-through seam for in-process caches: observers run
// after the durable publish transaction commits, before `publish` returns, and
// only for live durable events. Replays, #523 deduped appends, non-durable
// events, and rolled-back transactions never reach an observer. Observers are
// keyed so a layer rebuilt against the same bus replaces its registration
// instead of subscribing twice.

const SyncMessage = EventV2.define({
  type: "test.observer.sync",
  durable: {
    version: 1,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

const LocalMessage = EventV2.define({
  type: "test.observer.local",
  schema: {
    text: Schema.String,
  },
})

const eventLayer = Layer.mergeAll(EventV2.layerWith().pipe(Layer.provide(Database.defaultLayer)), Database.defaultLayer)
const it = testEffect(eventLayer)

const collect = () => {
  const received = new Array<EventV2.Payload>()
  const observer = (event: EventV2.Payload) =>
    Effect.sync(() => {
      received.push(event)
    })
  return { received, observer }
}

describe("EventV2.onCommitted", () => {
  it.effect("runs after the publish commits and before publish returns", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { received, observer } = collect()
      yield* events.onCommitted("test", observer)

      const event = yield* events.publish(SyncMessage, { id: EventV2.ID.create(), text: "hello" })

      expect(received).toHaveLength(1)
      expect(received[0]).toEqual(event)
      expect(received[0]?.durable?.seq).toBe(0)
      expect(received[0]?.durable?.aggregateID).toBe(event.data.id)
    }),
  )

  it.effect("does not fire for non-durable events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { received, observer } = collect()
      yield* events.onCommitted("test", observer)

      yield* events.publish(LocalMessage, { text: "hello" })

      expect(received).toHaveLength(0)
    }),
  )

  it.effect("does not fire when #523 drops a consecutive duplicate append", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { received, observer } = collect()
      yield* events.onCommitted("test", observer)
      const id = EventV2.ID.create()

      const first = yield* events.publish(SyncMessage, { id, text: "hello" })
      const second = yield* events.publish(SyncMessage, { id, text: "hello" })

      expect(second.durable).toBeUndefined()
      expect(received).toHaveLength(1)
      expect(received[0]).toEqual(first)
    }),
  )

  it.effect("does not fire for replays", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { received, observer } = collect()
      yield* events.onCommitted("test", observer)
      const aggregateID = DagEvent.DagID.create()

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DagEvent.WorkflowPaused.type, 1),
        aggregateID,
        seq: 0,
        data: { dagID: aggregateID, timestamp: 0, reason: "replayed" },
      })

      expect(received).toHaveLength(0)
    }),
  )

  it.effect("does not fire when a projector fails and the transaction rolls back", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { received, observer } = collect()
      yield* events.onCommitted("test", observer)
      yield* events.project(SyncMessage, () => Effect.die("projector failed"))

      const exit = yield* Effect.exit(events.publish(SyncMessage, { id: EventV2.ID.create(), text: "hello" }))

      expect(exit._tag).toBe("Failure")
      expect(received).toHaveLength(0)
    }),
  )

  it.effect("does not fire when the local commit hook fails and the transaction rolls back", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { received, observer } = collect()
      yield* events.onCommitted("test", observer)

      const exit = yield* Effect.exit(
        events.publish(
          SyncMessage,
          { id: EventV2.ID.create(), text: "hello" },
          { commit: () => Effect.die("commit failed") },
        ),
      )

      expect(exit._tag).toBe("Failure")
      expect(received).toHaveLength(0)
    }),
  )

  it.effect("does not fire when an enclosing transaction rolls back the publish", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const { received, observer } = collect()
      yield* events.onCommitted("test", observer)

      const exit = yield* Effect.exit(
        db.transaction(() =>
          Effect.gen(function* () {
            yield* events.publish(SyncMessage, { id: EventV2.ID.create(), text: "hello" })
            return yield* Effect.die("outer rollback")
          }),
        ),
      )

      expect(exit._tag).toBe("Failure")
      expect(received).toHaveLength(0)
    }),
  )

  it.effect("fires once per batch entry in entry order and skips a deduped entry", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { received, observer } = collect()
      yield* events.onCommitted("test", observer)
      const id = EventV2.ID.create()

      yield* events.publishMany([
        { definition: SyncMessage, data: { id, text: "one" } },
        { definition: SyncMessage, data: { id, text: "two" } },
        { definition: SyncMessage, data: { id, text: "one" } },
        { definition: SyncMessage, data: { id, text: "three" } },
        { definition: SyncMessage, data: { id, text: "three" } },
      ])

      // A → B → A appends even when the payload repeats; only a consecutive
      // duplicate of the latest appended event is deduped.
      expect(received.map((event) => (event.data as { text: string }).text)).toEqual(["one", "two", "one", "three"])
      expect(received.map((event) => event.durable?.seq)).toEqual([0, 1, 2, 3])
    }),
  )

  it.effect("survives an observer defect and keeps running the remaining observers", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      yield* events.onCommitted("first", () => Effect.sync(() => received.push("first")))
      yield* events.onCommitted("broken", () => Effect.die("observer failed"))
      yield* events.onCommitted("last", () => Effect.sync(() => received.push("last")))

      const event = yield* events.publish(SyncMessage, { id: EventV2.ID.create(), text: "hello" })

      expect(event.durable?.seq).toBe(0)
      expect(received).toEqual(["first", "last"])
    }),
  )

  it.effect("keeps one observer per key", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      yield* events.onCommitted("shared", () => Effect.sync(() => received.push("first")))
      yield* events.onCommitted("shared", () => Effect.sync(() => received.push("second")))

      yield* events.publish(SyncMessage, { id: EventV2.ID.create(), text: "hello" })

      expect(received).toEqual(["second"])
    }),
  )
})