// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Lifecycle } from "@/lifecycle/service"
import { PrWatchLifecycle } from "@/pr-watch/lifecycle"
import { EngineProcess } from "@/session/engine-process"
import type { InstanceContext } from "@/project/instance-context"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { PrWatchTable } from "@graphagent/core/lifecycle/pr-watch.sql"
import { ref } from "@graphagent/core/lifecycle/state"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { Session } from "@graphagent/schema/session"
import { Effect, Layer, Option } from "effect"
import { testEffect } from "../lib/effect"

/**
 * #1071 PR1: the pr_watch resolver answers from the durable row, scoped to the
 * directory that owns the watch's session. The live poller (a later PR) will
 * take precedence once it exists.
 */

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))

const base = Layer.mergeAll(database, events, bridge, Lifecycle.layer.pipe(Layer.provide(bridge)))

const it = testEffect(Layer.mergeAll(base, PrWatchLifecycle.layer.pipe(Layer.provide(base))))

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

const insertWatch = (row: Partial<typeof PrWatchTable.$inferInsert> & { id: string }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(PrWatchTable)
      .values({
        forge: "github",
        host: "github.com",
        url: `https://github.com/acme/repo/pull/${row.id}`,
        repo: "acme/repo",
        number: 1,
        session_id: "ses_missing",
        phase: "watching",
        deadline_at: 100,
        created_at: 1,
        updated_at: 1,
        ...row,
      })
      .run()
      .pipe(Effect.orDie)
  })

describe("pr_watch lifecycle resolver", () => {
  it.live("answers from the durable row with the vocabulary phase", () =>
    Effect.gen(function* () {
      yield* insertSession("ses_watch_own", "/own")
      yield* insertWatch({ id: "watch_live", session_id: "ses_watch_own", phase: "watching" })
      const lifecycle = yield* Lifecycle.Service

      const observed = Option.getOrUndefined(
        yield* lifecycle.get(ref("pr_watch", "watch_live")).pipe(Effect.provideService(InstanceRef, own)),
      )
      expect(observed).toMatchObject({
        domain: "pr_watch",
        id: "watch_live",
        value: "watching",
        phase: "waiting",
        terminal: false,
        settled: false,
        source: "persisted",
      })
    }),
  )

  it.live("reports terminal values with their terminal and settled flags", () =>
    Effect.gen(function* () {
      yield* insertSession("ses_watch_terminal", "/own")
      yield* insertWatch({ id: "watch_done", session_id: "ses_watch_terminal", phase: "succeeded" })
      yield* insertWatch({ id: "watch_expired", session_id: "ses_watch_terminal", phase: "expired" })
      yield* insertWatch({ id: "watch_cancelled", session_id: "ses_watch_terminal", phase: "cancelled" })
      const lifecycle = yield* Lifecycle.Service

      const succeeded = Option.getOrUndefined(
        yield* lifecycle.get(ref("pr_watch", "watch_done")).pipe(Effect.provideService(InstanceRef, own)),
      )
      expect(succeeded).toMatchObject({ phase: "succeeded", terminal: true, settled: true })

      const expired = Option.getOrUndefined(
        yield* lifecycle.get(ref("pr_watch", "watch_expired")).pipe(Effect.provideService(InstanceRef, own)),
      )
      expect(expired).toMatchObject({ phase: "failed", terminal: true, settled: false })

      const cancelled = Option.getOrUndefined(
        yield* lifecycle.get(ref("pr_watch", "watch_cancelled")).pipe(Effect.provideService(InstanceRef, own)),
      )
      expect(cancelled).toMatchObject({ phase: "cancelled", terminal: true, settled: false })
    }),
  )

  it.live("hides a watch whose session belongs to another directory or is gone", () =>
    Effect.gen(function* () {
      yield* insertSession("ses_watch_foreign", "/other")
      yield* insertWatch({ id: "watch_foreign", session_id: "ses_watch_foreign" })
      yield* insertWatch({ id: "watch_orphan_session", session_id: "ses_never_created" })
      const lifecycle = yield* Lifecycle.Service

      const read = (id: string, instance: InstanceContext) =>
        lifecycle.get(ref("pr_watch", id)).pipe(Effect.provideService(InstanceRef, instance))
      expect(Option.isNone(yield* read("watch_foreign", own))).toBe(true)
      expect(Option.isSome(yield* read("watch_foreign", other))).toBe(true)
      expect(Option.isNone(yield* read("watch_orphan_session", own))).toBe(true)
    }),
  )

  it.live("treats a row with an unknown phase as no state instead of failing the read", () =>
    Effect.gen(function* () {
      yield* insertSession("ses_watch_odd", "/own")
      yield* insertWatch({ id: "watch_odd_phase", session_id: "ses_watch_odd", phase: "archived" })
      const lifecycle = yield* Lifecycle.Service

      expect(
        Option.isNone(
          yield* lifecycle.get(ref("pr_watch", "watch_odd_phase")).pipe(Effect.provideService(InstanceRef, own)),
        ),
      ).toBe(true)
    }),
  )

  it.live("returns none for a watch that does not exist", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      expect(
        Option.isNone(yield* lifecycle.get(ref("pr_watch", "watch_missing")).pipe(Effect.provideService(InstanceRef, own))),
      ).toBe(true)
    }),
  )

  it.live("prefers the live poller phase and applies the same directory ownership", () =>
    Effect.gen(function* () {
      yield* insertSession("ses_watch_live", "/own")
      yield* insertSession("ses_watch_live_foreign", "/other")
      // The live marker is a cache of the durable row this process's poller
      // drives: both name this process and the same phase.
      yield* insertWatch({
        id: "watch_live_owned",
        session_id: "ses_watch_live",
        phase: "delivering",
        process_id: EngineProcess.runner.id,
      })
      yield* insertWatch({
        id: "watch_live_foreign",
        session_id: "ses_watch_live_foreign",
        phase: "delivering",
        process_id: EngineProcess.runner.id,
      })
      EngineProcess.prWatch.watches.set("watch_live_owned", {
        phase: "delivering",
        sessionID: "ses_watch_live",
        observedAt: 123,
      })
      EngineProcess.prWatch.watches.set("watch_live_foreign", {
        phase: "delivering",
        sessionID: "ses_watch_live_foreign",
        observedAt: 123,
      })
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const lifecycle = yield* Lifecycle.Service
          const live = Option.getOrUndefined(
            yield* lifecycle
              .get(ref("pr_watch", "watch_live_owned"))
              .pipe(Effect.provideService(InstanceRef, own)),
          )
          // The live entry answers with its observation time.
          expect(live).toMatchObject({
            value: "delivering",
            phase: "settling",
            terminal: false,
            source: "live",
            observedAt: 123,
          })
          expect(
            Option.isNone(
              yield* lifecycle
                .get(ref("pr_watch", "watch_live_foreign"))
                .pipe(Effect.provideService(InstanceRef, own)),
            ),
          ).toBe(true)
        }),
        Effect.sync(() => {
          EngineProcess.prWatch.watches.delete("watch_live_owned")
          EngineProcess.prWatch.watches.delete("watch_live_foreign")
        }),
      )
    }),
  )

  it.live("drops a live phase the durable row no longer agrees with", () =>
    Effect.gen(function* () {
      yield* insertSession("ses_watch_stale", "/own")
      // This process observed `watching`, then another process delivered the
      // watch and settled the durable row.
      yield* insertWatch({
        id: "watch_stale_terminal",
        session_id: "ses_watch_stale",
        phase: "succeeded",
        process_id: EngineProcess.runner.id,
      })
      EngineProcess.prWatch.watches.set("watch_stale_terminal", {
        phase: "watching",
        sessionID: "ses_watch_stale",
        observedAt: 123,
      })
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const lifecycle = yield* Lifecycle.Service
          const observed = Option.getOrUndefined(
            yield* lifecycle
              .get(ref("pr_watch", "watch_stale_terminal"))
              .pipe(Effect.provideService(InstanceRef, own)),
          )
          // The durable terminal value wins and the stale marker is evicted.
          expect(observed).toMatchObject({ value: "succeeded", source: "persisted", terminal: true })
          expect(EngineProcess.prWatch.watches.has("watch_stale_terminal")).toBe(false)
        }),
        Effect.sync(() => EngineProcess.prWatch.watches.delete("watch_stale_terminal")),
      )
    }),
  )

  it.live("drops a live phase another process now owns", () =>
    Effect.gen(function* () {
      yield* insertSession("ses_watch_other_owner", "/own")
      // Another process claimed the row (cancel, delivery or a poll) while
      // this process still holds its old observation.
      yield* insertWatch({
        id: "watch_other_owner",
        session_id: "ses_watch_other_owner",
        phase: "delivering",
        process_id: "999999:another-process",
      })
      EngineProcess.prWatch.watches.set("watch_other_owner", {
        phase: "delivering",
        sessionID: "ses_watch_other_owner",
        observedAt: 123,
      })
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const lifecycle = yield* Lifecycle.Service
          const observed = Option.getOrUndefined(
            yield* lifecycle
              .get(ref("pr_watch", "watch_other_owner"))
              .pipe(Effect.provideService(InstanceRef, own)),
          )
          expect(observed).toMatchObject({ value: "delivering", source: "persisted", phase: "settling" })
          expect(EngineProcess.prWatch.watches.has("watch_other_owner")).toBe(false)
        }),
        Effect.sync(() => EngineProcess.prWatch.watches.delete("watch_other_owner")),
      )
    }),
  )
})
