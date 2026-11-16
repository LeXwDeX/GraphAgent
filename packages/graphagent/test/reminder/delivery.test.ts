// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { Project } from "@graphagent/core/project"
import { Duration, Effect, Layer, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { InstanceRef } from "@/effect/instance-ref"
import { Lifecycle } from "@/lifecycle/service"
import type { InstanceContext } from "@/project/instance-context"
import { ReminderSource } from "@/reminder/source"
import { EngineProcess } from "@/session/engine-process"
import { SessionInbox } from "@/session/inbox"
import { SessionStatus } from "@/session/status"
import { testEffect } from "../lib/effect"
import {
  bridge,
  database,
  DIRECTORY,
  edges,
  events,
  eventually,
  insertReminder,
  noticeText,
  readReminder,
  recordingPrompts,
  resetLive,
  seedSession,
  settle,
  stubNudge,
  unique,
  watchLifecycle,
  withClock,
} from "./reminder.fixture"

/**
 * #1072: delivery at the turn boundary and after a restart. The real inbox owns
 * the idle subscription and the `turn_boundary` gate, the real clock moves the
 * reminders, and the source is the production one over a recording admission
 * port. A restart is a new clock and a new source over the same database.
 */

const lifecycleLayer = Lifecycle.layer.pipe(Layer.provide(bridge))
const status = SessionStatus.layer.pipe(Layer.provide(bridge))
const inboxLayer = SessionInbox.layer.pipe(Layer.provideMerge(bridge), Layer.provideMerge(status))
const it = testEffect(Layer.mergeAll(database, events, bridge, lifecycleLayer, inboxLayer))

// `it.effect` runs under TestClock (the tick needs it) and has no ambient
// instance, so the test supplies one.
const instance: InstanceContext = {
  directory: DIRECTORY,
  worktree: DIRECTORY,
  root: DIRECTORY,
  project: { id: Project.ID.global, worktree: DIRECTORY, time: { created: 0, updated: 0 }, sandboxes: [] },
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Registers the production source in the real inbox, like instance bootstrap does, and arms the tick. */
const startInstance = (prompts: Parameters<typeof ReminderSource.make>[0]["prompts"]) =>
  Effect.gen(function* () {
    const inbox = yield* SessionInbox.Service
    const { db } = yield* Database.Service
    yield* ReminderSource.make({
      db,
      inbox,
      prompts,
      lifecycle: yield* Lifecycle.Service,
      directory: DIRECTORY,
      scope: yield* Scope.Scope,
    })
    yield* inbox.init()
    return inbox
  })

describe("reminder delivery boundary", () => {
  it.effect("a reminder that comes due mid-turn is delivered once, when the turn ends", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        yield* resetLive
        const sessionStatus = yield* SessionStatus.Service
        const { db } = yield* Database.Service
        const seen = yield* watchLifecycle()
        const sessionID = yield* seedSession(unique("ses_remdel_boundary"))
        const recording = yield* recordingPrompts(db)
        const inbox = yield* startInstance(recording.prompts)
        yield* clock.init()

        // The session is working when the reminder comes due.
        yield* sessionStatus.set(sessionID, { type: "busy" })
        const { id } = yield* clock.create({ sessionID, text: "check the L5 smoke test", fireAt: 5 * MINUTE })
        yield* TestClock.adjust(Duration.minutes(5))
        yield* eventually(
          readReminder(id).pipe(Effect.map((row) => (row?.status === "due" ? row : undefined))),
          "the reminder to come due",
        )

        // Neither the clock's nudge, a drain nor the forced 30 s tick injects into the running turn.
        yield* inbox.drain(sessionID)
        yield* TestClock.adjust(Duration.seconds(30))
        yield* settle
        expect(recording.admitted).toHaveLength(0)
        expect(yield* readReminder(id)).toMatchObject({ status: "due", delivery: null })

        // The turn ends: the idle event is the delivery boundary.
        yield* sessionStatus.set(sessionID, { type: "idle" })
        yield* eventually(
          Effect.sync(() => (recording.admitted.length === 1 ? true : undefined)),
          "the idle boundary to deliver the reminder",
        )
        expect(noticeText(recording.admitted[0]).endsWith("\n\ncheck the L5 smoke test")).toBe(true)
        expect(recording.admitted[0].extras).toMatchObject({
          when: "idle",
          origin: { kind: "inbox", source: "reminder", key: `${id}:${5 * MINUTE}` },
        })
        expect(yield* readReminder(id)).toMatchObject({ status: "delivered", delivery: `${id}:${5 * MINUTE}` })
        // The live marker is gone with the debt: the hint no longer asks for a claim.
        expect(EngineProcess.reminder.due.has(sessionID)).toBe(false)

        // Exactly once: a later drain and tick find nothing owed.
        yield* inbox.drain(sessionID)
        yield* TestClock.adjust(Duration.seconds(30))
        yield* settle
        expect(recording.admitted).toHaveLength(1)

        yield* eventually(
          edges(seen, id).pipe(Effect.map((list) => (list.length >= 3 ? list : undefined))),
          "the settled edge",
        )
        expect(yield* edges(seen, id)).toMatchObject([
          { to: "scheduled", phase: "pending", reason: "created" },
          { from: "scheduled", to: "due", phase: "settling", reason: "due" },
          { from: "due", to: "delivered", phase: "succeeded", reason: "delivered" },
        ])
      }),
    ).pipe(Effect.provideService(InstanceRef, instance)),
  )

  it.effect("a reminder that comes due while the session is idle is delivered at once", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        yield* resetLive
        const { db } = yield* Database.Service
        const sessionID = yield* seedSession(unique("ses_remdel_idle"))
        const recording = yield* recordingPrompts(db)
        yield* startInstance(recording.prompts)
        yield* clock.init()

        const { id } = yield* clock.create({ sessionID, text: "stand up", fireAt: 10 * MINUTE })
        yield* TestClock.adjust(Duration.minutes(10))
        yield* eventually(
          Effect.sync(() => (recording.admitted.length === 1 ? true : undefined)),
          "the idle session to receive the reminder",
        )
        expect(noticeText(recording.admitted[0])).not.toContain("delayed")
        expect(yield* readReminder(id)).toMatchObject({ status: "delivered" })
      }),
    ).pipe(Effect.provideService(InstanceRef, instance)),
  )

  // A nudge is the inbox's drain; behind a DAG delivery claim it can wait for an admitted turn for
  // minutes. The clock must not wait with it: the other sessions' reminders still come due and reach
  // their sessions, and the stuck one is not lost, the inbox's own tick delivers it.
  it.effect("a nudge that never returns does not hold up another session's reminder", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        yield* resetLive
        const { db } = yield* Database.Service
        const hung = yield* seedSession(unique("ses_remdel_hung"))
        const other = yield* seedSession(unique("ses_remdel_other"))
        const recording = yield* recordingPrompts(db)
        yield* startInstance(recording.prompts)
        // The real inbox hook, except that the hung session's nudge never comes back.
        const inboxNudge = EngineProcess.inbox.nudge
        yield* stubNudge((sessionID) => (sessionID === hung ? Effect.never : (inboxNudge?.(sessionID) ?? Effect.void)))
        // Oldest first: the clock reaches the hung session's reminder before the other one.
        yield* insertReminder({ id: "rmd_del_a_hung", session_id: hung, fire_at: 1_000, text: "stuck for now" })
        yield* insertReminder({ id: "rmd_del_b_other", session_id: other, fire_at: 2_000, text: "must still arrive" })
        yield* clock.init()
        yield* TestClock.adjust(Duration.seconds(5))

        yield* eventually(
          Effect.sync(() => (recording.admitted.length >= 1 ? true : undefined)),
          "the other session's reminder to be delivered behind a hung nudge",
        )
        expect(recording.admitted).toHaveLength(1)
        expect(noticeText(recording.admitted[0]).endsWith("\n\nmust still arrive")).toBe(true)
        expect(yield* readReminder("rmd_del_b_other")).toMatchObject({ status: "delivered" })
        // The stuck reminder is owed, not lost: it came due and waits for the inbox's own backstop.
        expect(yield* readReminder("rmd_del_a_hung")).toMatchObject({ status: "due", delivery: null })

        yield* TestClock.adjust(Duration.seconds(30))
        yield* eventually(
          Effect.sync(() => (recording.admitted.length === 2 ? true : undefined)),
          "the inbox tick to deliver the reminder whose nudge hung",
        )
        expect(noticeText(recording.admitted[1]).endsWith("\n\nstuck for now")).toBe(true)
        expect(yield* readReminder("rmd_del_a_hung")).toMatchObject({ status: "delivered" })
        yield* resetLive
      }),
    ).pipe(Effect.provideService(InstanceRef, instance)),
  )

  it.effect("a repeating reminder keeps firing at its interval until it is cancelled", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        yield* resetLive
        const { db } = yield* Database.Service
        const sessionID = yield* seedSession(unique("ses_remdel_repeat"))
        const recording = yield* recordingPrompts(db)
        yield* startInstance(recording.prompts)
        yield* clock.init()

        const { id } = yield* clock.create({ sessionID, text: "look at the logs", fireAt: HOUR, everyMs: HOUR })
        for (const n of [1, 2, 3]) {
          yield* TestClock.adjust(Duration.hours(1))
          yield* eventually(
            Effect.sync(() => (recording.admitted.length === n ? true : undefined)),
            `notice ${n} of the repeating reminder`,
          )
          expect(recording.admitted[n - 1].extras).toMatchObject({ origin: { key: `${id}:${n * HOUR}` } })
          // Back to waiting for the next occurrence, on the schedule's own phase.
          expect(yield* readReminder(id)).toMatchObject({ status: "scheduled", fire_at: (n + 1) * HOUR })
          expect(noticeText(recording.admitted[n - 1])).toContain("repeats every 1h")
        }

        // Cancelling ends it: no further occurrence is delivered.
        expect(yield* clock.cancel({ sessionID, id })).toMatchObject({ status: "cancelled" })
        yield* TestClock.adjust(Duration.hours(3))
        yield* settle
        expect(recording.admitted).toHaveLength(3)
        expect(yield* readReminder(id)).toMatchObject({ status: "cancelled" })
      }),
    ).pipe(Effect.provideService(InstanceRef, instance)),
  )

  it.effect("a reminder cancelled while its turn is running is never delivered", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        yield* resetLive
        const sessionStatus = yield* SessionStatus.Service
        const { db } = yield* Database.Service
        const sessionID = yield* seedSession(unique("ses_remdel_cancel"))
        const recording = yield* recordingPrompts(db)
        yield* startInstance(recording.prompts)
        yield* clock.init()

        yield* sessionStatus.set(sessionID, { type: "busy" })
        const { id } = yield* clock.create({ sessionID, text: "never delivered", fireAt: 5 * MINUTE })
        yield* TestClock.adjust(Duration.minutes(5))
        yield* eventually(
          readReminder(id).pipe(Effect.map((row) => (row?.status === "due" ? row : undefined))),
          "the reminder to come due",
        )
        // Owed, but not yet delivered: the user cancels it before the turn ends.
        expect(yield* clock.cancel({ sessionID, id })).toMatchObject({ status: "cancelled" })

        yield* sessionStatus.set(sessionID, { type: "idle" })
        yield* TestClock.adjust(Duration.seconds(30))
        yield* settle
        expect(recording.admitted).toHaveLength(0)
        expect(yield* readReminder(id)).toMatchObject({ status: "cancelled", delivery: null })
      }),
    ).pipe(Effect.provideService(InstanceRef, instance)),
  )
})

describe("reminder restart", () => {
  it.effect(
    "reminders that came due while the process was down are delivered once on the next start, marked late, and only once",
    () =>
      Effect.gen(function* () {
        yield* resetLive
        const { db } = yield* Database.Service
        const sessionID = yield* seedSession(unique("ses_remdel_restart"))

        // Process one creates the reminders, then ends: its clock and instance are gone.
        const [once, every] = yield* withClock((clock) =>
          Effect.gen(function* () {
            const once = yield* clock.create({ sessionID, text: "check the L5 smoke test", fireAt: 5 * MINUTE })
            const every = yield* clock.create({
              sessionID,
              text: "look at the logs",
              fireAt: 10 * MINUTE,
              everyMs: HOUR,
            })
            return [once, every] as const
          }),
        )
        // Two hours pass with nothing running; the live state of the old process is gone.
        yield* TestClock.adjust(Duration.hours(2))
        yield* resetLive
        expect(yield* readReminder(once.id)).toMatchObject({ status: "scheduled" })

        // Process two starts: its clock moves what came due, then its instance delivers it.
        const recording = yield* withClock((clock) =>
          Effect.gen(function* () {
            yield* clock.init()
            yield* eventually(
              readReminder(once.id).pipe(Effect.map((row) => (row?.status === "due" ? row : undefined))),
              "the first pass to move the missed reminders",
            )
            // The instance was not loaded yet: the nudge had no route, and the row is what is left.
            const recording = yield* recordingPrompts(db)
            yield* startInstance(recording.prompts)
            yield* eventually(
              Effect.sync(() => (recording.admitted.length === 2 ? true : undefined)),
              "the startup scan to deliver both reminders",
            )
            return recording
          }),
        )

        // One notice each, in the order they came due; a repeating one only for its latest missed occurrence.
        const [first, second] = recording.admitted
        expect(noticeText(first)).toContain("[Reminder " + once.id + "]")
        expect(noticeText(first)).toContain("(delayed 115 minutes)")
        expect(noticeText(first).endsWith("\n\ncheck the L5 smoke test")).toBe(true)
        expect(noticeText(second)).toContain("[Reminder " + every.id + "]")
        // Every hour from minute 10: occurrences at minutes 10 and 70 came due before the restart at
        // minute 120. Only the latest, minute 70, is owed, and it is 50 minutes late.
        expect(noticeText(second)).toContain("(delayed 50 minutes)")
        expect(second.extras).toMatchObject({ origin: { key: `${every.id}:${70 * MINUTE}` } })
        expect(yield* readReminder(once.id)).toMatchObject({ status: "delivered" })
        // The next occurrence stays on the schedule: 130 minutes, not two hours plus an interval.
        expect(yield* readReminder(every.id)).toMatchObject({ status: "scheduled", fire_at: 130 * MINUTE })

        // Process three starts: the ledger says everything was delivered, so nothing is delivered again.
        const again = yield* withClock((clock) =>
          Effect.gen(function* () {
            yield* clock.init()
            const recording = yield* recordingPrompts(db)
            yield* startInstance(recording.prompts)
            yield* TestClock.adjust(Duration.seconds(30))
            yield* settle
            return recording
          }),
        )
        expect(again.admitted).toHaveLength(0)
        expect(recording.admitted).toHaveLength(2)
      }).pipe(Effect.provideService(InstanceRef, instance)),
  )

  it.effect("an instance that starts before the clock moves the reminder is nudged and delivers it", () =>
    Effect.gen(function* () {
      yield* resetLive
      const { db } = yield* Database.Service
      const sessionID = yield* seedSession(unique("ses_remdel_nudge"))
      const created = yield* withClock((clock) =>
        clock.create({ sessionID, text: "after the restart", fireAt: 20 * MINUTE }),
      )
      yield* TestClock.adjust(Duration.minutes(45))
      yield* resetLive

      const recording = yield* recordingPrompts(db)
      yield* startInstance(recording.prompts)
      yield* withClock((clock) =>
        Effect.gen(function* () {
          yield* clock.init()
          yield* eventually(
            Effect.sync(() => (recording.admitted.length === 1 ? true : undefined)),
            "the clock's nudge to deliver the reminder",
          )
        }),
      )
      expect(noticeText(recording.admitted[0])).toContain("(delayed 25 minutes)")
      expect(yield* readReminder(created.id)).toMatchObject({ status: "delivered" })
    }).pipe(Effect.provideService(InstanceRef, instance)),
  )
})
