// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { DagStore } from "@graphagent/core/dag/store"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { EventSequenceTable, EventTable } from "@graphagent/core/event/sql"
import { DagEvent } from "@graphagent/schema/dag-event"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const store = DagStore.layer.pipe(Layer.provide(database))
const it = testEffect(Layer.merge(database, store))

function durableType(definition: { readonly type: string; readonly durable?: { readonly version: number } }) {
  if (!definition.durable) throw new Error(`Event is not durable: ${definition.type}`)
  return EventV2.versionedType(definition.type, definition.durable.version)
}

describe("DagStore checkpoint control sequence", () => {
  it.effect("returns only the latest explicit checkpoint-disposition control", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const dagStore = yield* DagStore.Service
      const dagID = "dag-checkpoint-control"
      yield* db.insert(EventSequenceTable).values({ aggregate_id: dagID, seq: 12 }).run().pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values([
          {
            id: EventV2.ID.create(),
            aggregate_id: dagID,
            seq: 4,
            type: EventV2.versionedType(DagEvent.WorkflowPaused.type, 1),
            data: {},
          },
          {
            id: EventV2.ID.create(),
            aggregate_id: dagID,
            seq: 5,
            type: durableType(DagEvent.WorkflowResumed),
            data: {},
          },
          {
            id: EventV2.ID.create(),
            aggregate_id: dagID,
            seq: 8,
            type: durableType(DagEvent.WorkflowStepped),
            data: {},
          },
          {
            id: EventV2.ID.create(),
            aggregate_id: dagID,
            seq: 9,
            type: durableType(DagEvent.WorkflowReplanned),
            data: {},
          },
          {
            id: EventV2.ID.create(),
            aggregate_id: dagID,
            seq: 12,
            type: EventV2.versionedType(DagEvent.NodeCompleted.type, 1),
            data: {},
          },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db.insert(EventSequenceTable).values({ aggregate_id: "dag-pause-only", seq: 3 }).run().pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values({
          id: EventV2.ID.create(),
          aggregate_id: "dag-pause-only",
          seq: 3,
          type: EventV2.versionedType(DagEvent.WorkflowPaused.type, 1),
          data: {},
        })
        .run()
        .pipe(Effect.orDie)

      expect(yield* dagStore.getLatestCheckpointControlSeq(dagID)).toBe(9)
      expect(yield* dagStore.getLatestCheckpointControlSeq("dag-pause-only")).toBeUndefined()
      expect(yield* dagStore.getLatestCheckpointControlSeq("dag-without-controls")).toBeUndefined()
    }),
  )

  it.effect("reads the reason from the latest durable WorkflowFailed event", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const dagStore = yield* DagStore.Service
      const dagID = "dag-failure-reason"
      yield* db.insert(EventSequenceTable).values({ aggregate_id: dagID, seq: 4 }).run().pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values([
          {
            id: EventV2.ID.create(),
            aggregate_id: dagID,
            seq: 2,
            type: durableType(DagEvent.WorkflowFailed),
            data: { reason: "workspace_missing: old" },
          },
          {
            id: EventV2.ID.create(),
            aggregate_id: dagID,
            seq: 3,
            type: durableType(DagEvent.WorkflowFailed),
            data: { reason: "workspace_unstamped: latest" },
          },
          {
            id: EventV2.ID.create(),
            aggregate_id: dagID,
            seq: 4,
            type: EventV2.versionedType(DagEvent.NodeCompleted.type, 1),
            data: {},
          },
        ])
        .run()
        .pipe(Effect.orDie)

      expect(yield* dagStore.getWorkflowFailureReason!(dagID)).toBe("workspace_unstamped: latest")
      expect(yield* dagStore.getWorkflowFailureReason!("dag-without-failure")).toBeUndefined()
    }),
  )

  it.effect("returns the latest durable retarget and ignores replans without one", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const dagStore = yield* DagStore.Service
      const dagID = "dag-retarget-audit"
      const replanned = (seq: number, retarget?: Record<string, unknown>) => ({
        id: EventV2.ID.create(),
        aggregate_id: dagID,
        seq,
        type: durableType(DagEvent.WorkflowReplanned),
        data: {
          dagID,
          added: 0,
          removed: 0,
          replaced: 0,
          restarted: 1,
          timestamp: 1,
          ...(retarget ? { retarget } : {}),
        },
      })
      yield* db.insert(EventSequenceTable).values({ aggregate_id: dagID, seq: 5 }).run().pipe(Effect.orDie)
      yield* db
        .insert(EventSequenceTable)
        .values({ aggregate_id: "dag-retarget-malformed", seq: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values([
          replanned(2, { fromDirectory: "/old", toDirectory: "/new", reason: "older", nodes: ["review"] }),
          replanned(4),
          replanned(5, { reason: "latest", nodes: ["review"] }),
          {
            id: EventV2.ID.create(),
            aggregate_id: "dag-retarget-malformed",
            seq: 1,
            type: durableType(DagEvent.WorkflowReplanned),
            data: { dagID: "dag-retarget-malformed", retarget: { nodes: "not-an-array" } },
          },
        ])
        .run()
        .pipe(Effect.orDie)

      expect(yield* dagStore.getLatestRetarget!(dagID)).toEqual({
        seq: 5,
        retarget: { reason: "latest", nodes: [DagEvent.NodeID.make("review")] },
      })
      expect(yield* dagStore.getLatestRetarget!("dag-retarget-malformed")).toBeUndefined()
      expect(yield* dagStore.getLatestRetarget!("dag-without-retarget")).toBeUndefined()
    }),
  )
})
