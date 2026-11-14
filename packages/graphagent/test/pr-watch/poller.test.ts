// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { PrWatchTable } from "@graphagent/core/lifecycle/pr-watch.sql"
import { LifecycleEvent } from "@graphagent/schema/lifecycle-event"
import { and, eq } from "drizzle-orm"
import { Context, Duration, Effect, Layer, Ref, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Lifecycle } from "@/lifecycle/service"
import { parseRequest, type Runner, type Snapshot } from "@/pr-watch/forge"
import { PrWatchPoller } from "@/pr-watch/poller"
import { EngineProcess } from "@/session/engine-process"
import { testEffect } from "../lib/effect"

/**
 * #1071 PR2: the process-level poller. Durable rows are the authority, so
 * every behavior here is asserted against the `pr_watch` table and the
 * published lifecycle events, not against service-local state.
 */

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
const lifecycle = Lifecycle.layer.pipe(Layer.provide(bridge))

class ForgeScript extends Context.Service<
  ForgeScript,
  {
    readonly ref: Ref.Ref<Runner>
    readonly use: (runner: Runner) => Effect.Effect<void>
  }
>()("@graphagent/test/PrWatchForgeScript") {}

const script = Layer.effect(
  ForgeScript,
  Effect.gen(function* () {
    const ref = yield* Ref.make<Runner>(() => Effect.succeed({ code: 127, stdout: "", stderr: "no runner" }))
    return ForgeScript.of({ ref, use: (runner) => Ref.set(ref, runner) })
  }),
)

const forge = Layer.effect(
  PrWatchPoller.ForgeRunner,
  Effect.gen(function* () {
    const source = yield* ForgeScript
    const run: Runner = (command, args) => Effect.flatMap(Ref.get(source.ref), (runner) => runner(command, args))
    return PrWatchPoller.ForgeRunner.of({ run })
  }),
).pipe(Layer.provide(script))

const base = Layer.mergeAll(database, events, bridge, lifecycle, script)
const it = testEffect(
  Layer.mergeAll(base, forge, PrWatchPoller.layer.pipe(Layer.provide(Layer.mergeAll(base, forge)))),
)

const request = parseRequest("https://github.com/acme/widgets/pull/42", new Set(["github.com"]))

const snapshot = (input: Partial<Snapshot> & Pick<Snapshot, "head">): Snapshot => ({
  state: "open",
  review: "NONE",
  checks: { total: 1, pending: 1, failed: 0, passed: 0 },
  ...input,
})

const githubResult = (value: Snapshot): { code: number; stdout: string; stderr: string } => ({
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

const sequenceRunner = (sequence: Array<{ code: number; stdout: string; stderr: string }>): Runner => {
  let index = 0
  return () =>
    Effect.suspend(() => {
      const result = sequence[Math.min(index, sequence.length - 1)]
      index++
      return Effect.succeed(result)
    })
}

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

const transitions = (seen: Ref.Ref<EventV2.Payload<typeof LifecycleEvent.Transitioned>[]>, id: string) =>
  Ref.get(seen).pipe(
    Effect.map((list) => list.map((event) => event.data).filter((data) => data.stateID === id)),
  )

const readRow = (id: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db.select().from(PrWatchTable).where(eq(PrWatchTable.id, id)).get().pipe(Effect.orDie)
  })

const insertWatch = (row: Partial<typeof PrWatchTable.$inferInsert> & { id: string }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(PrWatchTable)
      .values({
        forge: "github",
        host: "github.com",
        url: `https://github.com/acme/widgets/pull/${Math.abs(row.id.length * 7919) % 1000}`,
        repo: "acme/widgets",
        number: 1,
        session_id: `ses_${row.id}`,
        phase: "watching",
        next_poll_at: 0,
        deadline_at: Date.now() + 3_600_000,
        created_at: 0,
        updated_at: 0,
        ...row,
      })
      .run()
      .pipe(Effect.orDie)
  })

/** Yield until the forked poller fiber has published the state under test. */
const eventually = <A, E, R>(self: Effect.Effect<A | undefined, E, R>, label: string): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let i = 0; i < 2_000; i++) {
      const value = yield* self
      if (value !== undefined) return value
      yield* Effect.yieldNow
    }
    throw new Error(`timed out waiting for ${label}`)
  })

const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true })

describe("pr_watch registration", () => {
  it.effect("inserts one due row, publishes creation and makes it live", () =>
    Effect.gen(function* () {
      const seen = yield* watchLifecycle()
      const poller = yield* PrWatchPoller.Service
      const { id, created } = yield* poller.register({ sessionID: "ses_register", request, deadlineSeconds: 60 })

      expect(created).toBe(true)
      const row = yield* readRow(id)
      expect(row).toMatchObject({
        forge: "github",
        host: "github.com",
        url: request.url,
        repo: "acme/widgets",
        number: 42,
        session_id: "ses_register",
        head: null,
        phase: "watching",
        next_poll_at: 0,
        deadline_at: 60_000,
        outcome: null,
        process_id: PrWatchPoller.prWatchProcessID,
      })
      expect(EngineProcess.prWatch.watches.get(id)).toMatchObject({ phase: "watching", sessionID: "ses_register" })

      yield* eventually(
        transitions(seen, id).pipe(Effect.map((list) => (list.length >= 1 ? list : undefined))),
        "the creation transition",
      )
      expect(yield* transitions(seen, id)).toMatchObject([
        { domain: "pr_watch", from: undefined, to: "watching", phase: "waiting", reason: "registered" },
      ])
      EngineProcess.prWatch.watches.delete(id)
    }),
  )

  it.effect("deduplicates a live watch by session and URL", () =>
    Effect.gen(function* () {
      const poller = yield* PrWatchPoller.Service
      const first = yield* poller.register({ sessionID: "ses_dedupe", request })
      const second = yield* poller.register({ sessionID: "ses_dedupe", request })
      expect(second).toEqual({ id: first.id, created: false })

      const { db } = yield* Database.Service
      const rows = yield* db
        .select()
        .from(PrWatchTable)
        .where(and(eq(PrWatchTable.session_id, "ses_dedupe"), eq(PrWatchTable.url, request.url)))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toHaveLength(1)

      // The unique index is per session: another session watching the same
      // URL is a separate watch with its own row.
      const other = yield* poller.register({ sessionID: "ses_dedupe_other", request })
      expect(other.created).toBe(true)
      expect(other.id).not.toBe(first.id)
      EngineProcess.prWatch.watches.delete(first.id)
      EngineProcess.prWatch.watches.delete(other.id)
    }),
  )

  it.effect("replaces a terminal row for the same session and URL", () =>
    Effect.gen(function* () {
      yield* insertWatch({ id: "watch_finished", session_id: "ses_replace", url: request.url, phase: "succeeded" })
      const poller = yield* PrWatchPoller.Service
      const { id, created } = yield* poller.register({ sessionID: "ses_replace", request })
      expect(created).toBe(true)
      expect(id).not.toBe("watch_finished")
      expect(yield* readRow("watch_finished")).toBeUndefined()
      expect(yield* readRow(id)).toMatchObject({ phase: "watching", session_id: "ses_replace", url: request.url })
      EngineProcess.prWatch.watches.delete(id)
    }),
  )

  it.effect("finds a watch by id or URL and lists only the session's live watches", () =>
    Effect.gen(function* () {
      const poller = yield* PrWatchPoller.Service
      const { id } = yield* poller.register({ sessionID: "ses_lookup", request })
      // A terminal row is still findable by its own identity, but not listed.
      yield* insertWatch({ id: "watch_done", session_id: "ses_lookup", phase: "succeeded" })

      expect(yield* poller.query({ sessionID: "ses_lookup", ref: id })).toMatchObject([
        { id, url: request.url, phase: "watching", deadlineAt: expect.any(Number) },
      ])
      expect(yield* poller.query({ sessionID: "ses_lookup", ref: request.url })).toMatchObject([{ id }])
      expect(yield* poller.query({ sessionID: "ses_lookup" })).toMatchObject([{ id, phase: "watching" }])
      expect(yield* poller.query({ sessionID: "ses_lookup", ref: "watch_done" })).toMatchObject([
        { id: "watch_done", phase: "succeeded" },
      ])
      // Another session never reads this watch.
      expect(yield* poller.query({ sessionID: "ses_other" })).toEqual([])
      EngineProcess.prWatch.watches.delete(id)
    }),
  )

  it.effect("cancels a live watch with one lifecycle edge and refuses a terminal one", () =>
    Effect.gen(function* () {
      const seen = yield* watchLifecycle()
      const poller = yield* PrWatchPoller.Service
      const { id } = yield* poller.register({ sessionID: "ses_cancel", request })

      expect(yield* poller.cancel({ sessionID: "ses_cancel", ref: id })).toMatchObject({
        id,
        phase: "cancelled",
      })
      expect(yield* readRow(id)).toMatchObject({ phase: "cancelled", next_poll_at: null })
      // A second cancel has nothing live to stop and publishes nothing.
      expect(yield* poller.cancel({ sessionID: "ses_cancel", ref: id })).toBeUndefined()
      expect(EngineProcess.prWatch.watches.has(id)).toBe(false)

      yield* insertWatch({ id: "watch_terminal", session_id: "ses_cancel", phase: "succeeded" })
      expect(yield* poller.cancel({ sessionID: "ses_cancel", ref: "watch_terminal" })).toBeUndefined()

      yield* eventually(
        transitions(seen, id).pipe(Effect.map((list) => (list.length >= 2 ? list : undefined))),
        "the cancellation transition",
      )
      expect(yield* transitions(seen, id)).toMatchObject([
        { to: "watching", reason: "registered" },
        { from: "watching", to: "cancelled", reason: "cancelled" },
      ])
    }),
  )
})

describe("pr_watch polling", () => {
  it.effect("observes a settled check run and moves the row to delivering", () =>
    Effect.gen(function* () {
      const seen = yield* watchLifecycle()
      const source = yield* ForgeScript
      yield* source.use(
        sequenceRunner([githubResult(snapshot({ head: "a", checks: { total: 1, pending: 0, failed: 0, passed: 1 } }))]),
      )
      const poller = yield* PrWatchPoller.Service
      const { id } = yield* poller.register({ sessionID: "ses_success", request })

      expect(yield* poller.pollOnce()).toBe(1)
      const row = yield* readRow(id)
      expect(row).toMatchObject({
        head: "a",
        baseline_review: "NONE",
        phase: "delivering",
        outcome: "success",
        next_poll_at: null,
      })
      expect(EngineProcess.prWatch.watches.get(id)).toMatchObject({ phase: "delivering" })

      yield* eventually(
        transitions(seen, id).pipe(Effect.map((list) => (list.length >= 2 ? list : undefined))),
        "the delivery transition",
      )
      expect(yield* transitions(seen, id)).toMatchObject([
        { to: "watching", reason: "registered" },
        { from: "watching", to: "delivering", phase: "settling", reason: "success" },
      ])
      EngineProcess.prWatch.watches.delete(id)
    }),
  )

  it.effect("keeps watching while checks are pending", () =>
    Effect.gen(function* () {
      const source = yield* ForgeScript
      yield* source.use(sequenceRunner([githubResult(snapshot({ head: "a" })), githubResult(snapshot({ head: "a" }))]))
      const poller = yield* PrWatchPoller.Service
      const { id } = yield* poller.register({ sessionID: "ses_pending", request })

      yield* poller.pollOnce()
      expect(yield* readRow(id)).toMatchObject({ head: "a", phase: "watching", next_poll_at: 15_000, outcome: null })

      // A second pass inside the same interval must not read the forge.
      expect(yield* poller.pollOnce()).toBe(0)
      expect(yield* readRow(id)).toMatchObject({ head: "a", phase: "watching" })
      EngineProcess.prWatch.watches.delete(id)
    }),
  )

  it.effect("follows a new head by rebaselining instead of terminating", () =>
    Effect.gen(function* () {
      const seen = yield* watchLifecycle()
      const source = yield* ForgeScript
      yield* source.use(
        sequenceRunner([
          githubResult(snapshot({ head: "b" })),
          githubResult(snapshot({ head: "b", checks: { total: 1, pending: 0, failed: 0, passed: 1 } })),
        ]),
      )
      yield* insertWatch({ id: "watch_head", session_id: "ses_head", head: "a", baseline_review: "NONE" })
      const poller = yield* PrWatchPoller.Service

      yield* poller.pollOnce()
      const rebaselined = yield* readRow("watch_head")
      expect(rebaselined).toMatchObject({
        head: "b",
        baseline_review: "NONE",
        phase: "watching",
        next_poll_at: 15_000,
        outcome: null,
      })
      // The head change is not a terminal outcome.
      yield* settle
      expect(yield* transitions(seen, "watch_head")).toHaveLength(0)

      yield* TestClock.adjust(Duration.seconds(15))
      yield* poller.pollOnce()
      expect(yield* readRow("watch_head")).toMatchObject({ head: "b", phase: "delivering", outcome: "success" })
      EngineProcess.prWatch.watches.delete("watch_head")
    }),
  )

  it.effect("turns an overdue watch into a delivered deadline notice without reading the forge", () =>
    Effect.gen(function* () {
      const seen = yield* watchLifecycle()
      let reads = 0
      const source = yield* ForgeScript
      yield* source.use(() =>
        Effect.sync(() => {
          reads++
          return { code: 0, stdout: "{}", stderr: "" }
        }),
      )
      yield* insertWatch({ id: "watch_overdue", session_id: "ses_overdue", deadline_at: 0, next_poll_at: 600_000 })
      const poller = yield* PrWatchPoller.Service

      expect(yield* poller.pollOnce()).toBe(1)
      expect(reads).toBe(0)
      // The deadline is a notice, not a silent terminal write: the row takes
      // the delivery path so the session hears that the watch ended.
      expect(yield* readRow("watch_overdue")).toMatchObject({
        phase: "delivering",
        outcome: "deadline",
        next_poll_at: null,
      })
      expect(EngineProcess.prWatch.watches.get("watch_overdue")).toMatchObject({ phase: "delivering" })
      yield* eventually(
        transitions(seen, "watch_overdue").pipe(Effect.map((list) => (list.length >= 1 ? list : undefined))),
        "the deadline delivery transition",
      )
      expect(yield* transitions(seen, "watch_overdue")).toMatchObject([
        { from: "watching", to: "delivering", phase: "settling", reason: "deadline" },
      ])
      EngineProcess.prWatch.watches.delete("watch_overdue")
    }),
  )

  it.effect("retries a failed forge read until the deadline", () =>
    Effect.gen(function* () {
      const source = yield* ForgeScript
      yield* source.use(sequenceRunner([{ code: 127, stdout: "", stderr: "not found" }]))
      const poller = yield* PrWatchPoller.Service
      const { id } = yield* poller.register({ sessionID: "ses_unavailable", request })

      yield* poller.pollOnce()
      expect(yield* readRow(id)).toMatchObject({
        head: null,
        phase: "watching",
        next_poll_at: 15_000,
        outcome: null,
      })
      EngineProcess.prWatch.watches.delete(id)
    }),
  )

  it.effect("reschedules a claimed row whose poll dies before advancing it", () =>
    Effect.gen(function* () {
      const source = yield* ForgeScript
      // The forge runner itself defects: the claim was already written, so a
      // poll that only caught and logged would strand the row with a NULL
      // next_poll_at, invisible to the due scan until its deadline.
      yield* source.use(() => Effect.die(new Error("forge runner exploded")))
      yield* insertWatch({ id: "watch_defect", session_id: "ses_defect", next_poll_at: 0 })
      const poller = yield* PrWatchPoller.Service

      expect(yield* poller.pollOnce()).toBe(1)
      expect(yield* readRow("watch_defect")).toMatchObject({
        phase: "watching",
        process_id: PrWatchPoller.prWatchProcessID,
        next_poll_at: 15_000,
      })
      // The row is now due again at the ordinary cadence instead of stalling.
      yield* TestClock.adjust(Duration.seconds(15))
      expect(yield* poller.pollOnce()).toBe(1)
      EngineProcess.prWatch.watches.delete("watch_defect")
    }),
  )
})

describe("pr_watch session retirement", () => {
  it.effect("retires every live watch of a deleted session and leaves the others alone", () =>
    Effect.gen(function* () {
      const seen = yield* watchLifecycle()
      yield* insertWatch({
        id: "watch_retire_watching",
        session_id: "ses_gone",
        process_id: PrWatchPoller.prWatchProcessID,
      })
      yield* insertWatch({
        id: "watch_retire_delivering",
        session_id: "ses_gone",
        phase: "delivering",
        outcome: "success",
        process_id: PrWatchPoller.prWatchProcessID,
      })
      yield* insertWatch({ id: "watch_retire_done", session_id: "ses_gone", phase: "succeeded" })
      yield* insertWatch({ id: "watch_retire_other", session_id: "ses_kept" })
      EngineProcess.prWatch.watches.set("watch_retire_watching", {
        phase: "watching",
        sessionID: "ses_gone",
        observedAt: 0,
      })
      EngineProcess.prWatch.watches.set("watch_retire_delivering", {
        phase: "delivering",
        sessionID: "ses_gone",
        observedAt: 0,
      })

      const poller = yield* PrWatchPoller.Service
      expect(yield* poller.retireSession("ses_gone")).toBe(2)
      // Live watches stop polling and stop being owed to the session; a
      // terminal row and another session's watch are untouched.
      expect(yield* readRow("watch_retire_watching")).toMatchObject({ phase: "cancelled", next_poll_at: null })
      expect(yield* readRow("watch_retire_delivering")).toMatchObject({ phase: "cancelled", next_poll_at: null })
      expect(yield* readRow("watch_retire_done")).toMatchObject({ phase: "succeeded" })
      expect(yield* readRow("watch_retire_other")).toMatchObject({ phase: "watching" })
      expect(EngineProcess.prWatch.watches.has("watch_retire_watching")).toBe(false)
      expect(EngineProcess.prWatch.watches.has("watch_retire_delivering")).toBe(false)
      expect(yield* poller.retireSession("ses_gone")).toBe(0)

      yield* eventually(
        transitions(seen, "watch_retire_watching").pipe(
          Effect.map((list) => (list.length >= 1 ? list : undefined)),
        ),
        "the retirement transition",
      )
      expect(yield* transitions(seen, "watch_retire_watching")).toMatchObject([
        { from: "watching", to: "cancelled", reason: "session deleted" },
      ])
    }),
  )
})

describe("pr_watch poll loop", () => {
  it.effect("wakes for a registration and polls again at the recorded interval", () =>
    Effect.gen(function* () {
      const source = yield* ForgeScript
      yield* source.use(
        sequenceRunner([
          githubResult(snapshot({ head: "a" })),
          githubResult(snapshot({ head: "a", checks: { total: 1, pending: 0, failed: 0, passed: 1 } })),
        ]),
      )
      const poller = yield* PrWatchPoller.Service
      yield* poller.init()
      const { id } = yield* poller.register({ sessionID: "ses_loop", request })

      const pending = yield* eventually(
        readRow(id).pipe(Effect.map((row) => (row?.head === "a" ? row : undefined))),
        "the registration to be polled",
      )
      expect(pending).toMatchObject({ phase: "watching", next_poll_at: 15_000 })

      yield* TestClock.adjust(Duration.seconds(15))
      const observed = yield* eventually(
        readRow(id).pipe(Effect.map((row) => (row?.phase === "delivering" ? row : undefined))),
        "the interval poll to observe success",
      )
      expect(observed).toMatchObject({ outcome: "success" })
      EngineProcess.prWatch.watches.delete(id)
    }),
  )

  it.effect("periodically takes over a watch whose owner died after startup", () =>
    Effect.gen(function* () {
      const source = yield* ForgeScript
      yield* source.use(sequenceRunner([{ code: 127, stdout: "", stderr: "not found" }]))
      const poller = yield* PrWatchPoller.Service
      yield* poller.init()
      // Complete the first loop iteration so the periodic recovery interval
      // starts from a known point.
      const { id } = yield* poller.register({ sessionID: "ses_periodic", request })
      yield* eventually(
        readRow(id).pipe(Effect.map((row) => (row?.next_poll_at === 15_000 ? row : undefined))),
        "the first loop poll",
      )

      // A row claimed by a process that died mid-poll: next_poll_at is NULL,
      // so the due scan never selects it and only recovery can resume it.
      yield* insertWatch({ id: "watch_orphaned", process_id: "proc_dead", next_poll_at: null })
      yield* TestClock.adjust(Duration.millis(PrWatchPoller.RECOVER_INTERVAL_MS))

      const taken = yield* eventually(
        readRow("watch_orphaned").pipe(
          Effect.map((row) => (row?.process_id === PrWatchPoller.prWatchProcessID ? row : undefined)),
        ),
        "the periodic takeover of the dead owner's watch",
      )
      expect(taken.phase).toBe("watching")
      expect(taken.next_poll_at).not.toBeNull()
      EngineProcess.prWatch.watches.delete(id)
      EngineProcess.prWatch.watches.delete("watch_orphaned")
    }),
  )
})

describe("pr_watch restart takeover", () => {
  it.live("resumes watches whose owner process is gone and is convergent", () =>
    Effect.gen(function* () {
      yield* insertWatch({ id: "watch_dead", process_id: "proc_dead", next_poll_at: null })
      yield* insertWatch({ id: "watch_dead_future", process_id: "proc_dead", next_poll_at: 900_000 })
      // This process's own fresh claim belongs to a live poller fiber: the
      // lease has not expired, so the takeover pass must leave it alone.
      yield* insertWatch({
        id: "watch_live_owner",
        process_id: PrWatchPoller.prWatchProcessID,
        next_poll_at: null,
        updated_at: Date.now(),
      })
      // The same process's claim from before the lease: the fiber that made
      // it died without rescheduling, so the pass is the only recovery.
      yield* insertWatch({
        id: "watch_own_stale",
        process_id: PrWatchPoller.prWatchProcessID,
        next_poll_at: null,
        updated_at: Date.now() - PrWatchPoller.CLAIM_LEASE_MS - 1_000,
      })
      yield* insertWatch({ id: "watch_done", process_id: "proc_dead", phase: "succeeded" })
      yield* insertWatch({ id: "watch_delivering", process_id: "proc_dead", phase: "delivering", next_poll_at: null })

      const poller = yield* PrWatchPoller.Service
      expect(yield* poller.recoverOnce()).toBe(4)
      expect(yield* poller.recoverOnce()).toBe(0)

      const dead = yield* readRow("watch_dead")
      expect(dead).toMatchObject({ process_id: PrWatchPoller.prWatchProcessID, phase: "watching" })
      expect(dead?.next_poll_at).not.toBeNull()
      expect(yield* readRow("watch_dead_future")).toMatchObject({
        process_id: PrWatchPoller.prWatchProcessID,
        next_poll_at: 900_000,
      })
      expect(yield* readRow("watch_live_owner")).toMatchObject({
        process_id: PrWatchPoller.prWatchProcessID,
        next_poll_at: null,
      })
      expect((yield* readRow("watch_own_stale"))?.next_poll_at).not.toBeNull()
      expect(yield* readRow("watch_done")).toMatchObject({ process_id: "proc_dead", phase: "succeeded" })
      expect(yield* readRow("watch_delivering")).toMatchObject({
        process_id: PrWatchPoller.prWatchProcessID,
        phase: "delivering",
      })
      EngineProcess.prWatch.watches.delete("watch_dead")
      EngineProcess.prWatch.watches.delete("watch_dead_future")
      EngineProcess.prWatch.watches.delete("watch_own_stale")
      EngineProcess.prWatch.watches.delete("watch_delivering")
    }),
  )

  it.live("polls a taken-over watch on the next pass", () =>
    Effect.gen(function* () {
      const source = yield* ForgeScript
      yield* source.use(sequenceRunner([githubResult(snapshot({ head: "a" }))]))
      yield* insertWatch({ id: "watch_resume", process_id: "proc_dead", next_poll_at: null })
      const poller = yield* PrWatchPoller.Service

      expect(yield* poller.recoverOnce()).toBe(1)
      expect(yield* poller.pollOnce()).toBe(1)
      const resumed = yield* readRow("watch_resume")
      expect(resumed).toMatchObject({ head: "a", phase: "watching" })
      expect(resumed?.next_poll_at).toBeGreaterThan(Date.now())
      EngineProcess.prWatch.watches.delete("watch_resume")
    }),
  )
})