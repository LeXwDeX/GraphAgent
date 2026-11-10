// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { SessionProjector } from "@graphagent/core/session/projector"
import { SessionTable } from "@graphagent/core/session/sql"
import { SessionTurnTable } from "@graphagent/core/session/turn.sql"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { eq } from "drizzle-orm"
import { Effect, Layer, Option } from "effect"
import { BackgroundJob } from "@/background/job"
import { Dag } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Goal } from "@/goal/goal"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ExclusiveRegistry } from "@/session/engine-process"
import { Session as SessionNs } from "@/session/session"
import { lastOutcomeOf } from "@/session/turns"
import { Storage } from "@/storage/storage"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * Issue #1019 PR8: turn rows belong to the session that ran them. `Session.fork`
 * copies transcript messages, not execution bookkeeping, so the fork must start
 * with zero `session_turn` rows and no last outcome even when its source has
 * one. This uses the real Session service and fork implementation; the
 * bookkeeping-level fork case in turns.test.ts only seeds rows by hand.
 */

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
      Layer.provide(ExclusiveRegistry.defaultLayer),
      Layer.provide(Dag.defaultLayer),
    ),
    Database.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  ),
)

const turnRows = (db: Database.Interface["db"], sessionID: string) =>
  db.select().from(SessionTurnTable).where(eq(SessionTurnTable.session_id, sessionID)).all().pipe(Effect.orDie)

describe("Session.fork turn rows", () => {
  it.instance("does not copy session_turn rows or a last outcome into the fork", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const { db } = yield* Database.Service
      const original = yield* Effect.acquireRelease(sessions.create({ title: "fork turn source" }), (info) =>
        sessions.remove(info.id).pipe(Effect.ignore),
      )
      yield* db
        .insert(SessionTurnTable)
        .values({
          id: `turn_${original.id}`,
          session_id: original.id,
          origin: JSON.stringify({ kind: "user", via: "prompt" }),
          state: "ended",
          outcome: { type: "completed" },
          steps: 1,
          runner_id: "1",
          time_started: 1,
          time_ended: 2,
        })
        .run()
        .pipe(Effect.orDie)
      // The parent row must exist for the session; the turn row above proves
      // the source has execution history before the fork.
      const sourceRows = yield* db.select().from(SessionTable).where(eq(SessionTable.id, original.id)).all()
      expect(sourceRows).toHaveLength(1)

      const fork = yield* Effect.acquireRelease(sessions.fork({ sessionID: original.id }), (info) =>
        sessions.remove(info.id).pipe(Effect.ignore),
      )

      expect(yield* turnRows(db, fork.id)).toHaveLength(0)
      const outcome = yield* lastOutcomeOf({ db, sessions }, fork.id)
      expect(Option.isNone(outcome)).toBe(true)
      // The source keeps its own row: the fork neither copies nor moves it.
      expect(yield* turnRows(db, original.id)).toHaveLength(1)
    }),
  )
})