// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- seeded rows use branded-ID `as never` shims.
// #1026: the inbox tick reads due paused reminders in SQL
// (`DagStore.getSessionsWithDueWakes`) instead of listing every paused row and
// filtering with `isPausedReminderDue`. The two must stay one predicate. This
// drives every status, wake marker and time offset around the boundary through
// both and requires the same sessions, so changing either side alone fails here.
import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { WorkflowTable } from "@graphagent/core/dag/sql"
import { DagStore } from "@graphagent/core/dag/store"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { isPausedReminderDue, PAUSED_REMINDER_DELAY_MS } from "@/dag/runtime/delivery"

const NOW = 10_000_000
const DUE_CUTOFF = NOW - PAUSED_REMINDER_DELAY_MS
const STATUSES = ["pending", "running", "paused", "stepping", "completed", "failed", "cancelled"]
// `time_updated` relative to the cutoff: far past, one short of it, on it (all due), then beyond it.
const OFFSETS = [-1_000_000, -1, 0, 1, 1_000_000]

const database = Database.layerFromPath(":memory:")
const layer = Layer.merge(database, DagStore.layer.pipe(Layer.provide(database)))

const cases = STATUSES.flatMap((status) =>
  [false, true].flatMap((wakeReported) =>
    OFFSETS.map((offset) => ({ status, wakeReported, timeUpdated: DUE_CUTOFF + offset })),
  ),
).map((row, index) => ({ ...row, session: `ses_${String(index).padStart(3, "0")}` }))

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: "project-1" as never, worktree: process.cwd() as never, sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values(
      cases.map((row) => ({
        id: row.session as never,
        project_id: "project-1" as never,
        slug: row.session,
        directory: process.cwd() as never,
        title: row.session,
        version: "test",
      })),
    )
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkflowTable)
    .values(
      cases.map((row) => ({
        id: `wf_${row.session}`,
        project_id: "project-1" as never,
        session_id: row.session as never,
        title: row.session,
        status: row.status,
        config: "{}",
        seq: 1,
        wake_reported: row.wakeReported,
        directory: "/project",
        target_fingerprint: { kind: "none" as const },
        time_updated: row.timeUpdated,
      })),
    )
    .run()
    .pipe(Effect.orDie)
})

describe("DagStore.getSessionsWithDueWakes against the JS predicates it replaces", () => {
  it("lists the same paused sessions as isPausedReminderDue and the same wake sessions as the startup list", async () => {
    const { due, expectedPaused, unreported } = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DagStore.Service
        yield* seed
        const rows = yield* store.listWorkflows()
        return {
          due: yield* store.getSessionsWithDueWakes({ pausedDueCutoff: DUE_CUTOFF }),
          // The previous tick: every workflow row, filtered in JS at `now`.
          expectedPaused: rows
            .filter((row) => isPausedReminderDue(row, NOW))
            .map((row) => row.sessionId)
            .sort(),
          unreported: yield* store.getSessionsWithUnreportedWakes(),
        }
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
    expect(cases).toHaveLength(STATUSES.length * 2 * OFFSETS.length)
    // The matrix reaches both outcomes: the due offsets of the one unreported paused status.
    expect(expectedPaused).toHaveLength(3)
    expect(due.paused).toEqual(expectedPaused)
    expect(due.wake).toEqual([...unreported].sort())
  })
})
