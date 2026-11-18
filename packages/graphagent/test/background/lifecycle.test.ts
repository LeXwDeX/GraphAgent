// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect } from "bun:test"
import { BackgroundJob } from "@/background/job"
import { BackgroundLifecycle } from "@/background/lifecycle"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Lifecycle } from "@/lifecycle/service"
import type { InstanceContext } from "@/project/instance-context"
import { ChildRegistry } from "@/session/child/registry"
import { SessionID } from "@/session/schema"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { ref } from "@graphagent/core/lifecycle/state"
import { RuntimeJobTable } from "@graphagent/core/lifecycle/runtime-job.sql"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { Session } from "@graphagent/schema/session"
import { Effect, Layer, Option } from "effect"
import { testEffect } from "../lib/effect"

/**
 * #1069 P7: the job-domain resolver must expose the live registry through
 * `Lifecycle.get` without becoming a second state store.
 */

const job = (id: string, status: BackgroundJob.Status): BackgroundJob.Info =>
  ({ id, type: "test", status, started_at: 0 }) as BackgroundJob.Info

/** The child runs the task jobs below are carried by, in this process (#1407). */
const run = (name: string) =>
  ChildRegistry.create({
    id: `crun_lifecycle_${name}`,
    childSessionID: SessionID.make(`ses_lifecycle_${name}`),
    parentSessionID: SessionID.make("ses_lifecycle_parent"),
    ownerKind: "task",
    ownerKey: { kind: "task" },
    permission: { ask: "user" },
    detached: true,
    directory: undefined,
    owner: {},
  })
const waiting = run("waiting")
const begun = run("begun")

// The registry is the process's: the runs are in it for this file's tests only.
beforeAll(() => {
  ChildRegistry.register(waiting)
  ChildRegistry.register(begun)
  ChildRegistry.begin(begun, 4_200)
})
afterAll(() => {
  for (const entry of [waiting, begun]) {
    ChildRegistry.end(entry, { type: "completed" })
    ChildRegistry.driverStopped(entry)
    ChildRegistry.persisted(entry)
  }
})

/** A task job as the task tool starts it: carried by the child run named in its metadata. */
const taskJob = (id: string, runID: string): BackgroundJob.Info => ({
  id,
  type: "task",
  status: "running",
  started_at: 1_000,
  metadata: { childRunID: runID, sessionID: id },
})

const jobs = Layer.mock(BackgroundJob.Service, {
  get: (id) =>
    Effect.succeed(
      id === "job_running"
        ? job(id, "running")
        : id === "job_done"
          ? job(id, "completed")
          : id === "job_failed"
            ? job(id, "error")
            : id === "job_task_waiting"
              ? taskJob(id, waiting.id)
              : id === "job_task_begun"
                ? taskJob(id, begun.id)
                : undefined,
    ),
})

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))

const base = Layer.mergeAll(database, events, bridge, jobs, Lifecycle.layer.pipe(Layer.provide(bridge)))

const it = testEffect(Layer.mergeAll(base, BackgroundLifecycle.layer.pipe(Layer.provide(base))))

describe("background lifecycle resolver", () => {
  it.live("reports a live job as non-terminal running state", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      const observed = Option.getOrUndefined(yield* lifecycle.get(ref("job", "job_running")))
      expect(observed?.value).toBe("running")
      expect(observed?.phase).toBe("running")
      expect(observed?.terminal).toBe(false)
      expect(observed?.source).toBe("live")
    }),
  )

  it.live("reports a task job whose run waits for its slot as queued, with the moment it started waiting (#1407)", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      const observed = Option.getOrUndefined(yield* lifecycle.get(ref("job", "job_task_waiting")))
      expect(observed).toMatchObject({
        domain: "job",
        id: "job_task_waiting",
        value: "queued",
        phase: "pending",
        terminal: false,
        settled: false,
        source: "live",
        since: 1_000,
      })
    }),
  )

  it.live("reports a task job whose run holds its slot as running, since the run began", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      const observed = Option.getOrUndefined(yield* lifecycle.get(ref("job", "job_task_begun")))
      expect(observed).toMatchObject({ value: "running", phase: "running", terminal: false, since: 4_200 })
      // A job no run carries is running since it started; only a server that tells the queue says `since` at all.
      const plain = Option.getOrUndefined(yield* lifecycle.get(ref("job", "job_running")))
      expect(plain).toMatchObject({ value: "running", since: 0 })
    }),
  )

  it.live("a job that has ended says how, with no time of its own", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      const done = Option.getOrUndefined(yield* lifecycle.get(ref("job", "job_done")))
      expect(done).toBeDefined()
      expect(Object.hasOwn(done ?? {}, "since")).toBe(false)
    }),
  )

  it.live("reports terminal jobs with their vocabulary phase", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      const completed = Option.getOrUndefined(yield* lifecycle.get(ref("job", "job_done")))
      expect(completed?.value).toBe("completed")
      expect(completed?.phase).toBe("succeeded")
      expect(completed?.terminal).toBe(true)
      const failed = Option.getOrUndefined(yield* lifecycle.get(ref("job", "job_failed")))
      expect(failed?.phase).toBe("failed")
      expect(failed?.terminal).toBe(true)
    }),
  )

  it.live("returns none for a job the registry no longer holds", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      expect(Option.isNone(yield* lifecycle.get(ref("job", "job_missing")))).toBe(true)
    }),
  )
})

/**
 * After a restart the live registry is empty and the durable `runtime_job` row
 * is the only record of a job. The resolver answers from it, scoped to the
 * directory that owns the job's session, and always prefers the live registry.
 */

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: the resolver reads only the directory.
const own = { directory: "/own" } as unknown as InstanceContext
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: the resolver reads only the directory.
const other = { directory: "/other" } as unknown as InstanceContext

const insertSession = (id: string, directory: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: Session.ID.make(id),
        project_id: Project.ID.global,
        slug: id,
        directory: AbsolutePath.make(directory),
        title: id,
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })

const insertJob = (row: Partial<typeof RuntimeJobTable.$inferInsert> & { id: string }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(RuntimeJobTable)
      .values({ type: "watch_pr", status: "error", started_at: 1, updated_at: 1, ...row })
      .run()
      .pipe(Effect.orDie)
  })

describe("background lifecycle resolver after a restart", () => {
  it.live("answers from the durable row when the registry no longer holds the job", () =>
    Effect.gen(function* () {
      yield* insertSession("ses_job_own", "/own")
      yield* insertJob({
        id: "job_restarted",
        process_id: "proc_dead",
        session_id: "ses_job_own",
        status: "error",
        error: "process_restart",
      })
      const lifecycle = yield* Lifecycle.Service

      const observed = Option.getOrUndefined(
        yield* lifecycle.get(ref("job", "job_restarted")).pipe(Effect.provideService(InstanceRef, own)),
      )
      expect(observed).toMatchObject({
        domain: "job",
        id: "job_restarted",
        value: "error",
        phase: "failed",
        terminal: true,
        settled: false,
        source: "persisted",
      })
    }),
  )

  it.live("reports a job of a task's child session through its parent session", () =>
    Effect.gen(function* () {
      // The child session row is gone; the caller's session still locates the job.
      yield* insertSession("ses_job_parent", "/own")
      yield* insertJob({
        id: "job_child",
        process_id: "proc_dead",
        session_id: "ses_job_gone",
        parent_session_id: "ses_job_parent",
        status: "completed",
      })
      const lifecycle = yield* Lifecycle.Service

      const observed = Option.getOrUndefined(
        yield* lifecycle.get(ref("job", "job_child")).pipe(Effect.provideService(InstanceRef, own)),
      )
      expect(observed?.value).toBe("completed")
      expect(observed?.source).toBe("persisted")
    }),
  )

  it.live("hides a durable job whose session belongs to another directory or to none", () =>
    Effect.gen(function* () {
      yield* insertSession("ses_job_foreign", "/other")
      yield* insertJob({ id: "job_foreign", session_id: "ses_job_foreign" })
      yield* insertJob({ id: "job_sessionless" })
      yield* insertJob({ id: "job_orphan_session", session_id: "ses_never_created" })
      const lifecycle = yield* Lifecycle.Service

      const read = (id: string, instance: InstanceContext) =>
        lifecycle.get(ref("job", id)).pipe(Effect.provideService(InstanceRef, instance))
      expect(Option.isNone(yield* read("job_foreign", own))).toBe(true)
      expect(Option.isSome(yield* read("job_foreign", other))).toBe(true)
      expect(Option.isNone(yield* read("job_sessionless", own))).toBe(true)
      expect(Option.isNone(yield* read("job_orphan_session", own))).toBe(true)
    }),
  )

  it.live("prefers the live registry over a stale durable row", () =>
    Effect.gen(function* () {
      yield* insertSession("ses_job_live", "/own")
      yield* insertJob({ id: "job_running", session_id: "ses_job_live", status: "completed" })
      const lifecycle = yield* Lifecycle.Service

      const observed = Option.getOrUndefined(
        yield* lifecycle.get(ref("job", "job_running")).pipe(Effect.provideService(InstanceRef, own)),
      )
      expect(observed?.value).toBe("running")
      expect(observed?.source).toBe("live")
    }),
  )

  it.live("treats a row with an unknown status as no state instead of failing the read", () =>
    Effect.gen(function* () {
      yield* insertSession("ses_job_odd", "/own")
      yield* insertJob({ id: "job_odd_status", session_id: "ses_job_odd", status: "archived" })
      const lifecycle = yield* Lifecycle.Service

      expect(
        Option.isNone(yield* lifecycle.get(ref("job", "job_odd_status")).pipe(Effect.provideService(InstanceRef, own))),
      ).toBe(true)
    }),
  )
})
