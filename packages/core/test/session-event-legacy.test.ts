// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { EventSequenceTable, EventTable } from "@graphagent/core/event/sql"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionProjector } from "@graphagent/core/session/projector"
import { SessionTable } from "@graphagent/core/session/sql"
import { SessionV1 } from "@graphagent/core/v1/session"
import { SessionID } from "@graphagent/schema/session-id"
import { testEffect } from "./lib/effect"

/**
 * Issue #1288: `SessionInfo` gained a required `role`, so the session events
 * that carry an info have it too. Payloads written before that have none: the
 * stored durable stream and a replay decode them through the definition's
 * `upgrade`, which derives the role the way `SessionRole` places a child with
 * no binding. A session aggregate stopped appending the log in #1016 (ADR 0002),
 * but the rows already stored stay readable.
 */

const it = testEffect(Layer.mergeAll(Database.defaultLayer, EventV2.defaultLayer, SessionProjector.defaultLayer))

/** A `SessionInfo` as it was stored before `role`. */
const legacyInfo = (id: SessionID, parentID?: SessionID) => ({
  id,
  projectID: Project.ID.global,
  slug: "legacy",
  directory: "/project",
  title: "legacy",
  version: "0.0.0",
  time: { created: 1, updated: 1 },
  ...(parentID ? { parentID } : {}),
})

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** The role of the `info` a session event carries. */
const roleOf = (data: unknown) => (isRecord(data) && isRecord(data.info) ? data.info.role : undefined)

const seedProject = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

describe("session events stored before the role field", () => {
  it.effect("a replay decodes a payload with no role as a root, or as a task_child when it has a parent", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* seedProject
      const root = SessionID.make("ses_legacy_replay_root")
      const child = SessionID.make("ses_legacy_replay_child")

      const created = yield* events
        .subscribe(SessionV1.Event.Created)
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SessionV1.Event.Created.type, 1),
          seq: 0,
          aggregateID: root,
          data: { sessionID: root, info: legacyInfo(root) },
        },
        { publish: true },
      )
      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SessionV1.Event.Created.type, 1),
          seq: 0,
          aggregateID: child,
          data: { sessionID: child, info: legacyInfo(child, root) },
        },
        { publish: true },
      )

      const delivered = Array.from(yield* Fiber.join(created)).map((event) => [
        event.data.info.id,
        event.data.info.role,
      ])
      expect(delivered).toEqual([
        [root, "root"],
        [child, "task_child"],
      ])
      // The role is no column: the projection writes the same rows as before.
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, child)).get().pipe(Effect.orDie)
      expect(row?.parent_id).toBe(root)
    }),
  )

  it.effect("the stored durable stream decodes the rows written before the role field", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = SessionID.make("ses_legacy_stream")
      const parent = SessionID.make("ses_legacy_stream_parent")
      yield* db.insert(EventSequenceTable).values({ aggregate_id: aggregateID, seq: 2 }).run().pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values([
          {
            id: EventV2.ID.create(),
            aggregate_id: aggregateID,
            seq: 0,
            type: EventV2.versionedType(SessionV1.Event.Created.type, 1),
            data: { sessionID: aggregateID, info: legacyInfo(aggregateID, parent) },
          },
          {
            id: EventV2.ID.create(),
            aggregate_id: aggregateID,
            seq: 1,
            type: EventV2.versionedType(SessionV1.Event.Updated.type, 1),
            data: { sessionID: aggregateID, info: { ...legacyInfo(aggregateID), title: "renamed" } },
          },
          {
            id: EventV2.ID.create(),
            aggregate_id: aggregateID,
            seq: 2,
            type: EventV2.versionedType(SessionV1.Event.Updated.type, 1),
            // A payload that already has its role keeps it.
            data: { sessionID: aggregateID, info: { ...legacyInfo(aggregateID, parent), role: "dag_node" } },
          },
        ])
        .run()
        .pipe(Effect.orDie)

      const stored = Array.from(yield* events.durable({ aggregateID }).pipe(Stream.take(3), Stream.runCollect))
      expect(stored.map((event) => roleOf(event.data))).toEqual(["task_child", "root", "dag_node"])
    }),
  )
})
