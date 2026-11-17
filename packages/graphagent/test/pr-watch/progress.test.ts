// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { PrWatchTable } from "@graphagent/core/lifecycle/pr-watch.sql"
import type { PrWatchEvent } from "@graphagent/schema/pr-watch-event"
import { Context, Duration, Effect, Layer, Ref } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Lifecycle } from "@/lifecycle/service"
import { parseRequest, type CommandResult, type Runner, type Snapshot } from "@/pr-watch/forge"
import { PrWatchPoller } from "@/pr-watch/poller"
import { PrWatchProgress } from "@/pr-watch/progress"
import { EngineProcess } from "@/session/engine-process"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

/**
 * #1036: `pr.watch.updated` progress. The poller is driven pass by pass over
 * an in-memory database with a scripted forge, and every published event is
 * captured from GlobalBus; the read side (`list`) is asserted against rows.
 */

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
const lifecycle = Lifecycle.layer.pipe(Layer.provide(bridge))

class ForgeScript extends Context.Service<
  ForgeScript,
  { readonly ref: Ref.Ref<Runner>; readonly calls: Ref.Ref<number> }
>()("@graphagent/test/PrWatchProgressForgeScript") {}

const script = Layer.effect(
  ForgeScript,
  Effect.gen(function* () {
    const ref = yield* Ref.make<Runner>(() => Effect.succeed({ code: 127, stdout: "", stderr: "no runner" }))
    const calls = yield* Ref.make(0)
    return ForgeScript.of({ ref, calls })
  }),
)

const forge = Layer.effect(
  PrWatchPoller.ForgeRunner,
  Effect.gen(function* () {
    const source = yield* ForgeScript
    const run: Runner = (command, args) =>
      Ref.update(source.calls, (n) => n + 1).pipe(
        Effect.andThen(Ref.get(source.ref)),
        Effect.flatMap((runner) => runner(command, args)),
      )
    return PrWatchPoller.ForgeRunner.of({ run })
  }),
).pipe(Layer.provide(script))

const base = Layer.mergeAll(database, events, bridge, lifecycle, script)
const it = testEffect(Layer.mergeAll(base, forge, PrWatchPoller.layer.pipe(Layer.provide(Layer.mergeAll(base, forge)))))

const request = parseRequest("https://github.com/acme/widgets/pull/42", new Set(["github.com"]))

const snapshot = (input: Partial<Snapshot> = {}): Snapshot => ({
  state: "open",
  head: "a",
  review: "REVIEW_REQUIRED",
  checks: { total: 2, pending: 2, failed: 0, passed: 0 },
  ...input,
})

const github = (value: Snapshot): CommandResult => ({
  code: 0,
  stdout: JSON.stringify({
    state: value.state === "merged" ? "MERGED" : value.state === "closed" ? "CLOSED" : "OPEN",
    headRefOid: value.head,
    reviewDecision: value.review,
    statusCheckRollup: [
      ...Array.from({ length: value.checks.passed }, () => ({
        __typename: "CheckRun",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      })),
      ...Array.from({ length: value.checks.pending }, () => ({ __typename: "CheckRun", status: "IN_PROGRESS" })),
      ...Array.from({ length: value.checks.failed }, () => ({
        __typename: "CheckRun",
        status: "COMPLETED",
        conclusion: "FAILURE",
      })),
    ],
  }),
  stderr: "",
})

const use = (results: CommandResult[]) =>
  Effect.gen(function* () {
    const source = yield* ForgeScript
    let index = 0
    yield* Ref.set(source.ref, () =>
      Effect.sync(() => {
        const result = results[Math.min(index, results.length - 1)]
        index++
        return result
      }),
    )
  })

// Every `pr.watch.updated` published on GlobalBus during one test.
let published: PrWatchEvent.Entry[] = []
const listener = (event: GlobalEvent) => {
  if (event.payload?.type === "pr.watch.updated") published.push(event.payload.properties)
}
beforeEach(() => {
  published = []
  EngineProcess.prWatch.progress.clear()
  GlobalBus.on("event", listener)
})
afterEach(() => {
  GlobalBus.off("event", listener)
  EngineProcess.prWatch.progress.clear()
  EngineProcess.prWatch.watches.clear()
})

const of = (id: string) => published.filter((entry) => entry.watchID === id)

const pass = Effect.gen(function* () {
  const poller = yield* PrWatchPoller.Service
  yield* TestClock.adjust(Duration.millis(PrWatchPoller.POLL_INTERVAL_MS))
  return yield* poller.pollOnce()
})

describe("pr.watch.updated from the poller", () => {
  it.effect("publishes ten identical snapshots once and every count change once, with no extra forge reads", () =>
    Effect.gen(function* () {
      const forgeScript = yield* ForgeScript
      const same = github(snapshot())
      const progressed = github(snapshot({ checks: { total: 2, pending: 1, failed: 0, passed: 1 } }))
      yield* use([...Array.from({ length: 10 }, () => same), progressed, progressed])
      const poller = yield* PrWatchPoller.Service
      const { id } = yield* poller.register({ sessionID: "ses_progress_dedupe", request })

      // Registration publishes the watch before any read.
      expect(of(id)).toMatchObject([{ phase: "watching", sessionID: "ses_progress_dedupe", number: 42 }])
      expect(of(id)[0].checks).toBeUndefined()

      expect(yield* poller.pollOnce()).toBe(1)
      for (let i = 0; i < 9; i++) expect(yield* pass).toBe(1)
      // Ten reads of the same snapshot: one event carries the first counts.
      expect(yield* Ref.get(forgeScript.calls)).toBe(10)
      expect(of(id)).toHaveLength(2)
      expect(of(id)[1]).toMatchObject({
        phase: "watching",
        head: "a",
        review: "REVIEW_REQUIRED",
        checks: { total: 2, pending: 2, failed: 0, passed: 0 },
      })

      expect(yield* pass).toBe(1)
      expect(yield* pass).toBe(1)
      expect(yield* Ref.get(forgeScript.calls)).toBe(12)
      expect(of(id)).toHaveLength(3)
      expect(of(id)[2].checks).toEqual({ total: 2, pending: 1, failed: 0, passed: 1 })
    }),
  )

  it.effect("reports an observed outcome as delivering with a pending delivery and the final counts", () =>
    Effect.gen(function* () {
      yield* use([github(snapshot({ checks: { total: 2, pending: 0, failed: 1, passed: 1 } }))])
      const poller = yield* PrWatchPoller.Service
      const { id } = yield* poller.register({ sessionID: "ses_progress_failure", request })
      yield* poller.pollOnce()
      expect(of(id).at(-1)).toMatchObject({
        phase: "delivering",
        outcome: "failure",
        checks: { total: 2, pending: 0, failed: 1, passed: 1 },
        delivery: { state: "pending" },
      })
    }),
  )

  it.effect("rebaselines silently onto a new head but publishes the head change", () =>
    Effect.gen(function* () {
      yield* use([github(snapshot()), github(snapshot({ head: "b" }))])
      const poller = yield* PrWatchPoller.Service
      const { id } = yield* poller.register({ sessionID: "ses_progress_head", request })
      yield* poller.pollOnce()
      yield* pass
      expect(of(id).at(-1)).toMatchObject({ phase: "watching", head: "b" })
      expect(of(id).at(-1)?.outcome).toBeUndefined()
    }),
  )

  it.effect("reports the deadline as a pending notice without reading the forge", () =>
    Effect.gen(function* () {
      const forgeScript = yield* ForgeScript
      const poller = yield* PrWatchPoller.Service
      const { id } = yield* poller.register({ sessionID: "ses_progress_deadline", request, deadlineSeconds: 10 })
      yield* TestClock.adjust(Duration.seconds(11))
      yield* poller.pollOnce()
      expect(yield* Ref.get(forgeScript.calls)).toBe(0)
      expect(of(id).at(-1)).toMatchObject({ phase: "delivering", outcome: "deadline", delivery: { state: "pending" } })
    }),
  )

  it.effect("reports cancellation and session retirement without a delivery", () =>
    Effect.gen(function* () {
      const poller = yield* PrWatchPoller.Service
      const first = yield* poller.register({ sessionID: "ses_progress_cancel", request })
      yield* poller.cancel({ sessionID: "ses_progress_cancel", ref: first.id })
      expect(of(first.id).at(-1)).toMatchObject({ phase: "cancelled" })
      expect(of(first.id).at(-1)?.delivery).toBeUndefined()

      const second = yield* poller.register({ sessionID: "ses_progress_retire", request })
      expect(yield* poller.retireSession("ses_progress_retire")).toBe(1)
      expect(of(second.id).at(-1)).toMatchObject({ phase: "cancelled" })
    }),
  )

  it.effect("never publishes control characters from the forge review", () =>
    Effect.gen(function* () {
      yield* use([github(snapshot({ review: "\u001b[31mAPPROVED\u0007" }))])
      const poller = yield* PrWatchPoller.Service
      const { id } = yield* poller.register({ sessionID: "ses_progress_review", request })
      yield* poller.pollOnce()
      const review = of(id).at(-1)?.review ?? ""
      expect(review).toBe("31mAPPROVED")
      expect(/[\u0000-\u001f\u007f]/.test(review)).toBe(false)
    }),
  )
})

const entry = (input: Partial<PrWatchEvent.Entry> & { watchID: string }): PrWatchEvent.Entry => ({
  sessionID: SessionID.make("ses_progress_entry"),
  url: "https://github.com/acme/widgets/pull/42",
  provider: "github",
  number: 42,
  phase: "watching",
  startedAt: 0,
  updatedAt: 0,
  deadlineAt: 3_600_000,
  ...input,
})

describe("progress cache", () => {
  it.effect("dedupes on every displayed field but not on updatedAt", () =>
    Effect.sync(() => {
      const checks = { total: 1, pending: 1, failed: 0, passed: 0 }
      expect(PrWatchProgress.record(entry({ watchID: "w_sig", checks }), { now: 0 })).toBe(true)
      expect(PrWatchProgress.record(entry({ watchID: "w_sig", checks, updatedAt: 15_000 }), { now: 15_000 })).toBe(
        false,
      )
      // An entry without counts keeps the last ones, so it is still a duplicate.
      expect(PrWatchProgress.record(entry({ watchID: "w_sig", updatedAt: 30_000 }), { now: 30_000 })).toBe(false)
      expect(PrWatchProgress.record(entry({ watchID: "w_sig", review: "APPROVED" }), { now: 30_000 })).toBe(true)
      expect(published.map((value) => value.watchID)).toEqual(["w_sig", "w_sig"])
    }),
  )

  it.effect("prunes a finished entry ten minutes after its last update, lazily", () =>
    Effect.sync(() => {
      PrWatchProgress.record(entry({ watchID: "w_done", phase: "cancelled", updatedAt: 1_000 }), { now: 1_000 })
      PrWatchProgress.record(entry({ watchID: "w_live", deadlineAt: 10 * 3_600_000 }), { now: 1_000 })
      PrWatchProgress.prune(1_000 + PrWatchProgress.RETAIN_MS)
      expect(EngineProcess.prWatch.progress.has("w_done")).toBe(true)
      PrWatchProgress.prune(1_001 + PrWatchProgress.RETAIN_MS)
      expect(EngineProcess.prWatch.progress.has("w_done")).toBe(false)
      expect(EngineProcess.prWatch.progress.has("w_live")).toBe(true)
    }),
  )

  it.effect("lists live and recently ended rows, filling counts and notice details from the cache", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* TestClock.adjust(Duration.minutes(30))
      const now = 30 * 60_000
      const insert = (values: Partial<typeof PrWatchTable.$inferInsert> & { id: string }) =>
        db
          .insert(PrWatchTable)
          .values({
            forge: "github",
            host: "github.com",
            url: `https://github.com/acme/widgets/pull/${values.number ?? 1}`,
            repo: "acme/widgets",
            number: 1,
            session_id: "ses_progress_list",
            phase: "watching",
            next_poll_at: now + 15_000,
            deadline_at: now + 3_600_000,
            created_at: now - 60_000,
            updated_at: now,
            ...values,
          })
          .run()
          .pipe(Effect.orDie)
      yield* insert({ id: "w_list_live", number: 1, head: "a", created_at: now - 1_000 })
      yield* insert({
        id: "w_list_done",
        number: 2,
        phase: "succeeded",
        outcome: "success",
        delivery: "w_list_done:success:a",
        updated_at: now - 60_000,
        created_at: now - 120_000,
      })
      yield* insert({ id: "w_list_old", number: 3, phase: "cancelled", updated_at: now - 11 * 60_000 })
      yield* insert({ id: "w_list_foreign", number: 4, session_id: "ses_progress_other" })
      PrWatchProgress.record(
        entry({
          watchID: "w_list_live",
          sessionID: SessionID.make("ses_progress_list"),
          checks: { total: 3, pending: 1, failed: 0, passed: 2 },
        }),
        { now },
      )
      PrWatchProgress.record(
        entry({
          watchID: "w_list_done",
          phase: "succeeded",
          updatedAt: now - 59_999,
          delivery: { state: "delivered", deliveredAt: now - 59_999, noticeMessageID: "msg_notice" },
        }),
        { now },
      )

      const listed = yield* PrWatchProgress.list(db, SessionID.make("ses_progress_list"))
      expect(listed.map((value) => value.watchID)).toEqual(["w_list_live", "w_list_done"])
      expect(listed[0]).toMatchObject({ phase: "watching", head: "a", checks: { total: 3, passed: 2 } })
      expect(listed[0].delivery).toBeUndefined()
      expect(listed[1]).toMatchObject({
        phase: "succeeded",
        outcome: "success",
        delivery: { state: "delivered", deliveredAt: now - 59_999, noticeMessageID: "msg_notice" },
      })

      // Without the cache (a restart), the row alone answers.
      EngineProcess.prWatch.progress.clear()
      const cold = yield* PrWatchProgress.list(db, SessionID.make("ses_progress_list"))
      expect(cold[0].checks).toBeUndefined()
      expect(cold[1].delivery).toEqual({ state: "delivered", deliveredAt: now - 60_000 })
    }),
  )
})
