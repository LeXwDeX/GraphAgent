// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Duration, Effect, Exit } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { EngineProcess } from "@/session/engine-process"
import { testEffect } from "../lib/effect"
import {
  base,
  edges,
  eventually,
  insertReminder,
  readReminder,
  recordNudges,
  resetLive,
  seedSession,
  settle,
  stubNudge,
  unique,
  watchLifecycle,
  withClock,
} from "./reminder.fixture"

/**
 * #1072: the process-level reminder clock. The durable row is the authority, so
 * every behavior is asserted against the `reminder` table and the published
 * lifecycle edges, not against clock-local state. The clock itself keeps one
 * timer; each test builds its own in its own scope under TestClock.
 */

const it = testEffect(base)

const MINUTE = 60_000
const HOUR = 60 * MINUTE

describe("reminder creation", () => {
  it.effect("writes a durable row for the user, publishes creation and lists it", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        const seen = yield* watchLifecycle()
        const sessionID = yield* seedSession(unique("ses_rem_create"))

        const once = yield* clock.create({ sessionID, text: "check the L5 smoke test", fireAt: 30 * MINUTE })
        const every = yield* clock.create({ sessionID, text: "look at the logs", fireAt: 10 * MINUTE, everyMs: HOUR })

        expect(once).toMatchObject({
          sessionID,
          text: "check the L5 smoke test",
          fireAt: 30 * MINUTE,
          everyMs: null,
          status: "scheduled",
        })
        expect(once.id).toMatch(/^rmd_[0-9a-f]{8}$/)
        expect(yield* readReminder(once.id)).toMatchObject({
          session_id: sessionID,
          text: "check the L5 smoke test",
          fire_at: 30 * MINUTE,
          every_ms: null,
          status: "scheduled",
          creator: "user",
          delivery: null,
          delivered_at: null,
        })
        expect(yield* readReminder(every.id)).toMatchObject({ every_ms: HOUR, creator: "user" })

        // Soonest first, and only this session's.
        expect((yield* clock.list(sessionID)).map((info) => info.id)).toEqual([every.id, once.id])
        expect(yield* clock.list(yield* seedSession(unique("ses_rem_other")))).toEqual([])

        yield* eventually(
          edges(seen, once.id).pipe(Effect.map((list) => (list.length >= 1 ? list : undefined))),
          "the creation edge",
        )
        expect(yield* edges(seen, once.id)).toMatchObject([
          { domain: "reminder", from: undefined, to: "scheduled", phase: "pending", reason: "created", sessionID },
        ])
      }),
    ),
  )

  it.effect("refuses a repeat interval under five minutes before anything is written", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(unique("ses_rem_short"))
        const exit = yield* Effect.exit(
          clock.create({ sessionID, text: "too often", fireAt: 1_000, everyMs: 4 * MINUTE }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* clock.list(sessionID)).toEqual([])
        // Exactly five minutes is the shortest allowed interval.
        expect(yield* clock.create({ sessionID, text: "often", fireAt: 1_000, everyMs: 5 * MINUTE })).toMatchObject({
          everyMs: 5 * MINUTE,
        })
      }),
    ),
  )
})

describe("reminder cancellation", () => {
  it.effect("stops a live reminder once, with one edge, and only for its own session", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        const seen = yield* watchLifecycle()
        const sessionID = yield* seedSession(unique("ses_rem_cancel"))
        const foreign = yield* seedSession(unique("ses_rem_foreign"))
        const { id } = yield* clock.create({ sessionID, text: "never", fireAt: 10 * MINUTE })

        // Another session cannot cancel it, and an unknown id is not a reminder.
        expect(yield* clock.cancel({ sessionID: foreign, id })).toBeUndefined()
        expect(yield* clock.cancel({ sessionID, id: "rmd_unknown" })).toBeUndefined()
        expect(yield* readReminder(id)).toMatchObject({ status: "scheduled" })

        expect(yield* clock.cancel({ sessionID, id })).toMatchObject({ id, status: "cancelled" })
        expect(yield* readReminder(id)).toMatchObject({ status: "cancelled" })
        expect(yield* clock.list(sessionID)).toEqual([])
        // A second cancel finds nothing live to stop.
        expect(yield* clock.cancel({ sessionID, id })).toBeUndefined()

        yield* eventually(
          edges(seen, id).pipe(Effect.map((list) => (list.length >= 2 ? list : undefined))),
          "the cancellation edge",
        )
        expect(yield* edges(seen, id)).toMatchObject([
          { to: "scheduled", reason: "created" },
          { from: "scheduled", to: "cancelled", phase: "cancelled", reason: "cancelled" },
        ])
      }),
    ),
  )

  it.effect("cancels a reminder that is already due and owed", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(unique("ses_rem_cancel_due"))
        yield* insertReminder({ id: "rmd_owed", session_id: sessionID, status: "due" })
        expect((yield* clock.list(sessionID)).map((info) => [info.id, info.status])).toEqual([["rmd_owed", "due"]])
        expect(yield* clock.cancel({ sessionID, id: "rmd_owed" })).toMatchObject({ status: "cancelled" })
        expect(yield* readReminder("rmd_owed")).toMatchObject({ status: "cancelled" })
      }),
    ),
  )

  it.effect("never lists or cancels a finished reminder", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(unique("ses_rem_finished"))
        yield* insertReminder({ id: "rmd_delivered", session_id: sessionID, status: "delivered" })
        yield* insertReminder({ id: "rmd_cancelled", session_id: sessionID, status: "cancelled" })
        expect(yield* clock.list(sessionID)).toEqual([])
        expect(yield* clock.cancel({ sessionID, id: "rmd_delivered" })).toBeUndefined()
        expect(yield* clock.cancel({ sessionID, id: "rmd_cancelled" })).toBeUndefined()
        expect(yield* readReminder("rmd_delivered")).toMatchObject({ status: "delivered" })
      }),
    ),
  )
})

describe("reminder clock loop", () => {
  it.effect("sleeps until the earliest fire_at, then moves that reminder to due and nudges the inbox", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        yield* resetLive
        const { nudged } = yield* recordNudges
        const seen = yield* watchLifecycle()
        const sessionID = yield* seedSession(unique("ses_rem_loop"))
        const later = yield* clock.create({ sessionID, text: "later", fireAt: 10 * MINUTE })
        const sooner = yield* clock.create({ sessionID, text: "sooner", fireAt: 5 * MINUTE })
        yield* clock.init()

        yield* TestClock.adjust(Duration.minutes(4))
        yield* settle
        expect(yield* readReminder(sooner.id)).toMatchObject({ status: "scheduled" })

        yield* TestClock.adjust(Duration.minutes(1))
        const due = yield* eventually(
          readReminder(sooner.id).pipe(Effect.map((row) => (row?.status === "due" ? row : undefined))),
          "the earlier reminder to come due",
        )
        expect(due).toMatchObject({ fire_at: 5 * MINUTE, delivery: null })
        // Only that one: the later reminder keeps waiting for its own time.
        expect(yield* readReminder(later.id)).toMatchObject({ status: "scheduled" })
        expect(EngineProcess.reminder.due.has(sessionID)).toBe(true)
        expect(nudged).toEqual([sessionID])

        yield* TestClock.adjust(Duration.minutes(5))
        yield* eventually(
          readReminder(later.id).pipe(Effect.map((row) => (row?.status === "due" ? row : undefined))),
          "the later reminder to come due",
        )
        yield* eventually(
          edges(seen, sooner.id).pipe(Effect.map((list) => (list.length >= 2 ? list : undefined))),
          "the due edge",
        )
        expect(yield* edges(seen, sooner.id)).toMatchObject([
          { to: "scheduled", reason: "created" },
          { from: "scheduled", to: "due", phase: "settling", reason: "due", sessionID },
        ])
        yield* resetLive
      }),
    ),
  )

  it.effect("a reminder created while the clock sleeps wakes it to recompute", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        yield* resetLive
        const sessionID = yield* seedSession(unique("ses_rem_wake"))
        // No reminder yet: the loop is asleep for its longest interval.
        yield* clock.init()
        yield* settle

        const { id } = yield* clock.create({ sessionID, text: "soon", fireAt: 10_000 })
        yield* TestClock.adjust(Duration.seconds(10))
        // Ten seconds is far inside the longest sleep: only the wake-up gets it here on time.
        yield* eventually(
          readReminder(id).pipe(Effect.map((row) => (row?.status === "due" ? row : undefined))),
          "the new reminder to come due on time",
        )
        yield* resetLive
      }),
    ),
  )

  it.effect("a cancelled reminder is never moved to due", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        yield* resetLive
        const { nudged } = yield* recordNudges
        const sessionID = yield* seedSession(unique("ses_rem_cancel_loop"))
        const { id } = yield* clock.create({ sessionID, text: "cancelled", fireAt: 10_000 })
        yield* clock.init()
        yield* clock.cancel({ sessionID, id })

        yield* TestClock.adjust(Duration.minutes(5))
        yield* settle
        expect(yield* readReminder(id)).toMatchObject({ status: "cancelled" })
        expect(nudged).toEqual([])
        expect(EngineProcess.reminder.due.has(sessionID)).toBe(false)
      }),
    ),
  )

  it.effect("two clocks racing for one reminder move it once", () =>
    Effect.gen(function* () {
      yield* resetLive
      const { nudged } = yield* recordNudges
      const seen = yield* watchLifecycle()
      const sessionID = yield* seedSession(unique("ses_rem_race"))
      yield* insertReminder({ id: "rmd_race", session_id: sessionID, fire_at: 0 })

      const moved = yield* withClock((first) =>
        withClock((second) => Effect.all([first.promoteOnce(), second.promoteOnce()], { concurrency: "unbounded" })),
      )
      expect(moved.toSorted((a, b) => a - b)).toEqual([0, 1])
      expect(yield* readReminder("rmd_race")).toMatchObject({ status: "due" })
      yield* settle
      expect((yield* edges(seen, "rmd_race")).filter((edge) => edge.to === "due")).toHaveLength(1)
      expect(nudged).toEqual([sessionID])
      yield* resetLive
    }),
  )
})

describe("reminder clock delivery nudge", () => {
  // A nudge is the inbox's drain, and a drain waits for the claims ahead of it: a DAG delivery claim
  // waits for the turn it admitted, up to its seven minute lease. The clock must never wait for
  // delivery, or every reminder behind a stuck drain, of any session or directory, stays `scheduled`
  // and the inbox's fallback scan (which only looks for `due` rows) cannot rescue it.
  it.effect("a nudge that never returns does not hold up the reminders behind it", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        yield* resetLive
        const hung = yield* seedSession(unique("ses_rem_hung"))
        const elsewhere = yield* seedSession(unique("ses_rem_elsewhere"), "/tmp/reminder-tests-elsewhere")
        const nudged: string[] = []
        yield* stubNudge((sessionID) =>
          sessionID === hung
            ? Effect.never
            : Effect.sync(() => {
                nudged.push(sessionID)
              }),
        )
        const first = yield* clock.create({ sessionID: hung, text: "first", fireAt: 5 * MINUTE })
        const second = yield* clock.create({ sessionID: elsewhere, text: "second", fireAt: 10 * MINUTE })
        yield* clock.init()

        yield* TestClock.adjust(Duration.minutes(5))
        yield* eventually(
          readReminder(first.id).pipe(Effect.map((row) => (row?.status === "due" ? row : undefined))),
          "the first reminder to come due",
        )

        // The first reminder's nudge is stuck in the inbox. The clock still wakes for the next one.
        yield* TestClock.adjust(Duration.minutes(5))
        yield* eventually(
          readReminder(second.id).pipe(Effect.map((row) => (row?.status === "due" ? row : undefined))),
          "the reminder behind a hung nudge to come due",
        )
        expect(nudged).toEqual([elsewhere])
        yield* resetLive
      }),
    ),
  )

  it.effect("one pass moves every due reminder, however long the first one's nudge takes", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        yield* resetLive
        const hung = yield* seedSession(unique("ses_rem_pass_hung"))
        const other = yield* seedSession(unique("ses_rem_pass_other"))
        yield* stubNudge((sessionID) => (sessionID === hung ? Effect.never : Effect.void))
        // Oldest first: the pass reaches the hung session's reminder before the other one.
        yield* insertReminder({ id: "rmd_pass_a_hung", session_id: hung, fire_at: 0 })
        yield* insertReminder({ id: "rmd_pass_b_other", session_id: other, fire_at: 0 })

        const pass = yield* Effect.forkScoped(clock.promoteOnce())
        yield* eventually(
          readReminder("rmd_pass_b_other").pipe(Effect.map((row) => (row?.status === "due" ? row : undefined))),
          "the second reminder of the pass to come due",
        )
        expect(yield* readReminder("rmd_pass_a_hung")).toMatchObject({ status: "due" })
        // The pass is over: it did not wait for either nudge.
        const exit = yield* eventually(
          Effect.sync(() => pass.pollUnsafe()),
          "the pass to end without waiting for delivery",
        )
        expect(Exit.isSuccess(exit) ? exit.value : undefined).toBe(2)
        yield* resetLive
      }),
    ),
  )

  it.effect("a nudge that fails is logged and the clock goes on", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        yield* resetLive
        const dies = yield* seedSession(unique("ses_rem_nudge_dies"))
        const throws = yield* seedSession(unique("ses_rem_nudge_throws"))
        const fine = yield* seedSession(unique("ses_rem_nudge_fine"))
        const nudged: string[] = []
        yield* stubNudge((sessionID) => {
          // A hook that throws before it returns an effect, and one whose effect dies.
          if (sessionID === throws) throw new Error("the nudge hook threw")
          if (sessionID === dies) return Effect.die(new Error("the nudge died"))
          return Effect.sync(() => {
            nudged.push(sessionID)
          })
        })
        yield* insertReminder({ id: "rmd_nudge_a_dies", session_id: dies, fire_at: 0 })
        yield* insertReminder({ id: "rmd_nudge_b_throws", session_id: throws, fire_at: 0 })
        yield* insertReminder({ id: "rmd_nudge_c_fine", session_id: fine, fire_at: 0 })

        expect(yield* clock.promoteOnce()).toBe(3)
        yield* settle
        for (const id of ["rmd_nudge_a_dies", "rmd_nudge_b_throws", "rmd_nudge_c_fine"])
          expect(yield* readReminder(id), id).toMatchObject({ status: "due" })
        expect(nudged).toEqual([fine])
        yield* resetLive
      }),
    ),
  )

  it.effect("a pending nudge ends with the clock's scope and leaves no fiber behind", () =>
    Effect.gen(function* () {
      yield* resetLive
      const sessionID = yield* seedSession(unique("ses_rem_nudge_scope"))
      const fibers = { started: 0, interrupted: 0 }
      yield* stubNudge(() =>
        Effect.suspend(() => {
          fibers.started += 1
          return Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                fibers.interrupted += 1
              }),
            ),
          )
        }),
      )
      yield* insertReminder({ id: "rmd_nudge_scope", session_id: sessionID, fire_at: 0 })

      yield* withClock((clock) =>
        Effect.gen(function* () {
          const pass = yield* Effect.forkScoped(clock.promoteOnce())
          yield* eventually(
            Effect.sync(() => pass.pollUnsafe()),
            "the pass to end without waiting for delivery",
          )
          // The nudge is running, unawaited, and nothing has stopped it.
          expect(fibers).toEqual({ started: 1, interrupted: 0 })
        }),
      )

      // The clock's scope closed: the nudge went with it, nothing is left running.
      expect(fibers).toEqual({ started: 1, interrupted: 1 })
      yield* resetLive
    }),
  )
})

describe("reminder clock restart", () => {
  it.effect("reminders that came due while nothing ran are moved to due by the first pass", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        yield* resetLive
        const seen = yield* watchLifecycle()
        const sessionID = yield* seedSession(unique("ses_rem_restart"))
        // Left by an earlier process: still `scheduled`, with a `fire_at` in the past.
        yield* insertReminder({ id: "rmd_missed_once", session_id: sessionID, fire_at: 10_000 })
        yield* insertReminder({
          id: "rmd_missed_every",
          session_id: sessionID,
          fire_at: 10_000,
          every_ms: HOUR,
        })
        yield* insertReminder({ id: "rmd_future", session_id: sessionID, fire_at: 5 * HOUR })

        // The process starts two and a half hours later.
        yield* TestClock.adjust(Duration.minutes(150))
        yield* clock.init()

        yield* eventually(
          readReminder("rmd_missed_every").pipe(Effect.map((row) => (row?.status === "due" ? row : undefined))),
          "the first pass over the missed reminders",
        )
        expect(yield* readReminder("rmd_missed_once")).toMatchObject({ status: "due", fire_at: 10_000 })
        // 10:00, 11:00 and 12:00 were missed: only the latest occurrence is owed, once.
        expect(yield* readReminder("rmd_missed_every")).toMatchObject({
          status: "due",
          fire_at: 10_000 + 2 * HOUR,
          every_ms: HOUR,
        })
        expect(yield* readReminder("rmd_future")).toMatchObject({ status: "scheduled", fire_at: 5 * HOUR })
        expect(EngineProcess.reminder.due.has(sessionID)).toBe(true)

        yield* eventually(
          edges(seen, "rmd_missed_once").pipe(Effect.map((list) => (list.length >= 1 ? list : undefined))),
          "the due edge of the missed reminder",
        )
        expect(yield* edges(seen, "rmd_missed_once")).toMatchObject([
          { from: "scheduled", to: "due", phase: "settling", reason: "due", sessionID },
        ])
        yield* resetLive
      }),
    ),
  )

  it.effect("leaves a reminder an earlier process already moved to due exactly as it is", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(unique("ses_rem_owed"))
        yield* insertReminder({ id: "rmd_already_due", session_id: sessionID, fire_at: 0, status: "due" })
        yield* clock.init()
        yield* TestClock.adjust(Duration.minutes(5))
        yield* settle
        expect(yield* readReminder("rmd_already_due")).toMatchObject({ status: "due", fire_at: 0, delivery: null })
      }),
    ),
  )
})

describe("reminder clock scope", () => {
  it.effect("releases its wake-up registration and stops its loop with its scope", () =>
    Effect.gen(function* () {
      yield* resetLive
      const registered = EngineProcess.reminder.clocks.size
      const sessionID = yield* seedSession(unique("ses_rem_scope"))

      yield* withClock((clock) =>
        Effect.gen(function* () {
          yield* clock.init()
          expect(EngineProcess.reminder.clocks.size).toBe(registered + 1)
        }),
      )
      // The scope closed: the clock no longer asks to be woken.
      expect(EngineProcess.reminder.clocks.size).toBe(registered)

      // Nothing runs the loop any more: a reminder that came due stays scheduled.
      yield* insertReminder({ id: "rmd_unwatched", session_id: sessionID, fire_at: 1_000 })
      yield* TestClock.adjust(Duration.minutes(5))
      yield* settle
      expect(yield* readReminder("rmd_unwatched")).toMatchObject({ status: "scheduled" })
      expect(EngineProcess.reminder.due.has(sessionID)).toBe(false)
    }),
  )

  it.effect("does not start its loop until init, and init is idempotent", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        yield* resetLive
        const sessionID = yield* seedSession(unique("ses_rem_init"))
        yield* insertReminder({ id: "rmd_before_init", session_id: sessionID, fire_at: 1_000 })
        yield* TestClock.adjust(Duration.minutes(5))
        yield* settle
        expect(yield* readReminder("rmd_before_init")).toMatchObject({ status: "scheduled" })

        yield* clock.init()
        yield* clock.init()
        yield* eventually(
          readReminder("rmd_before_init").pipe(Effect.map((row) => (row?.status === "due" ? row : undefined))),
          "the reminder to come due after init",
        )
        yield* resetLive
      }),
    ),
  )
})
