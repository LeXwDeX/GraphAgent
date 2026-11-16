// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { Database } from "@graphagent/core/database/database"
import { ReminderTable } from "@graphagent/core/lifecycle/reminder.sql"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { SessionID } from "@graphagent/schema/session-id"

/**
 * #1072: the `reminder` table is part of the v2.0 baseline. A reminder follows
 * its session (deleting the session deletes it), only the user creates one, and
 * the clock's two queries are served by the status/fire_at index.
 */

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped))

const seedSession = (id: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionID.make(id),
        project_id: Project.ID.global,
        slug: id,
        directory: AbsolutePath.make("/project"),
        title: id,
        version: "test",
      })
      .run()
  })

const reminder = (id: string, sessionID: string, extra: Partial<typeof ReminderTable.$inferInsert> = {}) => ({
  id,
  session_id: sessionID,
  text: "check the L5 smoke test",
  fire_at: 1_000,
  status: "scheduled",
  created_at: 1,
  updated_at: 1,
  ...extra,
})

describe("reminder table", () => {
  test("the baseline creates it with the clock's index and a user-only creator", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const columns = yield* db.all<{ name: string; notnull: number; dflt_value: string | null }>(
          sql`PRAGMA table_info(reminder)`,
        )
        expect(columns.map((column) => column.name)).toEqual([
          "id",
          "session_id",
          "text",
          "fire_at",
          "every_ms",
          "status",
          "creator",
          "delivery",
          "delivered_at",
          "created_at",
          "updated_at",
        ])
        // A one-shot reminder has no interval, and nothing has been delivered yet.
        for (const name of ["every_ms", "delivery", "delivered_at"])
          expect(
            columns.find((column) => column.name === name),
            name,
          ).toMatchObject({ notnull: 0 })
        expect(columns.find((column) => column.name === "creator")).toMatchObject({ notnull: 1, dflt_value: "'user'" })
        const indexes = yield* db.all<{ name: string }>(
          sql`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reminder' AND name LIKE 'reminder_%' ORDER BY name`,
        )
        expect(indexes.map((index) => index.name)).toEqual(["reminder_session_idx", "reminder_status_fire_at_idx"])
      }),
    )
  })

  test("only the user can be the creator", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* seedSession("ses_reminder_creator")
        yield* db.insert(ReminderTable).values(reminder("rmd_user", "ses_reminder_creator")).run()
        const row = yield* db.select().from(ReminderTable).where(eq(ReminderTable.id, "rmd_user")).get()
        expect(row?.creator).toBe("user")

        const agent = yield* Effect.exit(
          db
            .insert(ReminderTable)
            .values(reminder("rmd_agent", "ses_reminder_creator", { creator: "agent" }))
            .run(),
        )
        expect(Exit.isFailure(agent)).toBe(true)
      }),
    )
  })

  test("a reminder is deleted with its session and never outlives it", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* seedSession("ses_reminder_cascade")
        yield* seedSession("ses_reminder_other")
        yield* db
          .insert(ReminderTable)
          .values([
            reminder("rmd_one", "ses_reminder_cascade"),
            reminder("rmd_every", "ses_reminder_cascade", { every_ms: 3_600_000, status: "due" }),
            reminder("rmd_other", "ses_reminder_other"),
          ])
          .run()

        yield* db
          .delete(SessionTable)
          .where(eq(SessionTable.id, SessionID.make("ses_reminder_cascade")))
          .run()

        expect((yield* db.select({ id: ReminderTable.id }).from(ReminderTable)).map((row) => row.id)).toEqual([
          "rmd_other",
        ])

        // A reminder for a session that does not exist cannot be created at all.
        const orphan = yield* Effect.exit(db.insert(ReminderTable).values(reminder("rmd_orphan", "ses_missing")).run())
        expect(Exit.isFailure(orphan)).toBe(true)
      }),
    )
  })
})
