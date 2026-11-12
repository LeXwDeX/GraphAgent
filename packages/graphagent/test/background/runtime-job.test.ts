// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { BackgroundJob } from "@/background/job"
import { RuntimeJobRecovery } from "@/background/recovery"
import { persistTransition, runtimeJobProcessID } from "@/background/persist"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Lifecycle } from "@/lifecycle/service"
import { SessionID } from "@/session/schema"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { RuntimeJobTable } from "@graphagent/core/lifecycle/runtime-job.sql"
import { LifecycleEvent } from "@graphagent/schema/lifecycle-event"
import { eq } from "drizzle-orm"
import { Effect, Layer, Ref, Stream } from "effect"
import { testEffect } from "../lib/effect"

/**
 * Issue #1069 P5: the durable job observation and its restart recovery. The
 * registry stays the live owner; these tests cover the persisted projection
 * and the startup pass that fails rows an earlier process could not finish.
 */

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
const lifecycle = Lifecycle.layer.pipe(Layer.provide(bridge))
const recovery = RuntimeJobRecovery.layer.pipe(Layer.provide(Layer.mergeAll(database, lifecycle)))
const it = testEffect(Layer.mergeAll(database, events, bridge, lifecycle, recovery, BackgroundJob.layer))

const watchLifecycle = Effect.fnUntraced(function* () {
  const service = yield* EventV2.Service
  const seen = yield* Ref.make<EventV2.Payload<typeof LifecycleEvent.Transitioned>[]>([])
  yield* service.all().pipe(
    Stream.filter((event) => event.type === LifecycleEvent.Transitioned.type),
    Stream.runForEach((event) =>
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- filter narrowed the event type but not the payload generic.
      Ref.update(seen, (list) => [...list, event as EventV2.Payload<typeof LifecycleEvent.Transitioned>]),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )
  return seen
})

const base = {
  id: "job_persisted",
  type: "watch",
  sessionID: "ses_owner",
  parentSessionID: "ses_parent",
  title: "persisted job",
  metadata: { sessionId: "ses_owner", parentSessionId: "ses_parent" },
  started_at: 1000,
}

describe("runtime_job persistence", () => {
  it.effect("upserts one complete row per transition and resets a reused id", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const read = () =>
        db
          .select()
          .from(RuntimeJobTable)
          .where(eq(RuntimeJobTable.id, base.id))
          .get()

      yield* persistTransition(db, { ...base, from: null, to: "running" })
      expect(yield* read()).toMatchObject({
        id: base.id,
        type: "watch",
        status: "running",
        process_id: runtimeJobProcessID,
        session_id: "ses_owner",
        parent_session_id: "ses_parent",
        title: "persisted job",
        result: null,
        error: null,
        delivered_at: null,
        settled_at: null,
        started_at: 1000,
      })

      yield* persistTransition(db, { ...base, from: "running", to: "settling" })
      const settling = yield* read()
      expect(settling).toMatchObject({ status: "settling", settled_at: null })
      expect(settling?.delivered_at).not.toBeNull()

      yield* persistTransition(db, { ...base, from: "settling", to: "completed", output: "done" })
      const completed = yield* read()
      expect(completed).toMatchObject({ status: "completed", result: "done", error: null })
      expect(completed?.settled_at).not.toBeNull()
      expect(completed?.delivered_at).toBe(settling?.delivered_at)

      // A terminal id may be reused for a new job; its terminal facts must not
      // leak into the new row.
      yield* persistTransition(db, { ...base, from: null, to: "running", started_at: 2000 })
      expect(yield* read()).toMatchObject({
        status: "running",
        result: null,
        error: null,
        delivered_at: null,
        settled_at: null,
        started_at: 2000,
      })
    }),
  )

  it.effect("records a failed settle and cancellation as terminal rows", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* persistTransition(db, { ...base, id: "job_failed", from: null, to: "running" })
      yield* persistTransition(db, { ...base, id: "job_failed", from: "running", to: "error", error: "boom" })
      expect(
        yield* db
          .select()
          .from(RuntimeJobTable)
          .where(eq(RuntimeJobTable.id, "job_failed"))
          .get(),
      ).toMatchObject({ status: "error", error: "boom", result: null })

      yield* persistTransition(db, { ...base, id: "job_cancelled", from: null, to: "running" })
      yield* persistTransition(db, { ...base, id: "job_cancelled", from: "running", to: "cancelled" })
      const cancelled = yield* db
        .select()
        .from(RuntimeJobTable)
        .where(eq(RuntimeJobTable.id, "job_cancelled"))
        .get()
      expect(cancelled).toMatchObject({ status: "cancelled" })
      expect(cancelled?.settled_at).not.toBeNull()
    }),
  )
})

describe("runtime_job through the real registry", () => {
  // The writers (task, watch_pr, shell) record `sessionID` / `parentSessionID`;
  // the registry's own transitions must read those keys, or every durable row
  // and lifecycle event loses the session identity.
  it.instance("persists and publishes the session identities a started job records", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const seen = yield* watchLifecycle()
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        id: "job_keys",
        type: "watch_pr",
        metadata: { sessionID: "ses_owner", parentSessionID: "ses_parent" },
        run: Effect.succeed("done"),
      })
      yield* jobs.wait({ id: job.id })

      const row = yield* db.select().from(RuntimeJobTable).where(eq(RuntimeJobTable.id, "job_keys")).get()
      expect(row).toMatchObject({
        status: "completed",
        session_id: "ses_owner",
        parent_session_id: "ses_parent",
        result: "done",
      })

      yield* Effect.sleep("20 millis")
      const observed = (yield* Ref.get(seen)).map((event) => event.data).filter((data) => data.stateID === "job_keys")
      expect(observed.map((data) => data.to)).toEqual(["running", "completed"])
      expect(observed.map((data) => data.sessionID)).toEqual([SessionID.make("ses_owner"), SessionID.make("ses_owner")])
    }),
  )
})

describe("runtime_job startup recovery", () => {
  it.live("fails rows left by an earlier process and publishes their transition", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const seen = yield* watchLifecycle()
      const insert = (id: string, status: string, processID: string | null) =>
        db
          .insert(RuntimeJobTable)
          .values({
            id,
            type: "watch",
            process_id: processID,
            session_id: "ses_owner",
            status,
            started_at: 1000,
            updated_at: 1000,
          })
          .run()

      yield* insert("job_running", "running", "proc_dead")
      yield* insert("job_settling", "settling", "proc_dead")
      yield* insert("job_completed", "completed", "proc_dead")
      yield* insert("job_live", "running", runtimeJobProcessID)

      const service = yield* RuntimeJobRecovery.Service
      expect(yield* service.recoverOnce()).toBe(2)
      // Convergent: a second instance or a later pass finds no leftovers.
      expect(yield* service.recoverOnce()).toBe(0)

      const rows = yield* db.select().from(RuntimeJobTable).all()
      const byId = new Map(rows.map((row) => [row.id, row]))
      expect(byId.get("job_running")).toMatchObject({ status: "error", error: "process_restart" })
      expect(byId.get("job_settling")).toMatchObject({ status: "error", error: "process_restart" })
      expect(byId.get("job_running")?.settled_at).not.toBeNull()
      expect(byId.get("job_settling")?.settled_at).not.toBeNull()
      expect(byId.get("job_completed")?.status).toBe("completed")
      expect(byId.get("job_live")?.status).toBe("running")

      yield* Effect.sleep("20 millis")
      const captured = (yield* Ref.get(seen))
        .map((event) => event.data)
        .toSorted((a, b) => a.stateID.localeCompare(b.stateID))
      expect(captured).toMatchObject([
        { domain: "job", stateID: "job_running", from: "running", to: "error", phase: "failed", reason: "process_restart" },
        {
          domain: "job",
          stateID: "job_settling",
          from: "settling",
          to: "error",
          phase: "failed",
          reason: "process_restart",
        },
      ])
    }),
  )
})
