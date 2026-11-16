// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { Duration, Effect, Option } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Lifecycle } from "@/lifecycle/service"
import { ReminderStore } from "@/reminder/store"
import { EngineProcess } from "@/session/engine-process"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import {
  base,
  DIRECTORY,
  insertReminder,
  noticeText,
  readReminder,
  recordingPrompts,
  resetLive,
  seedSession,
  sourceHarness,
  unique,
} from "./reminder.fixture"

/**
 * #1072: the `reminder` inbox source. The rows are real (in-memory database,
 * foreign keys on); the admission port is a recording stub that commits the
 * delivery mark in a real transaction. Direct claims cover the ledger; the
 * delivery boundary and the restart are driven through the real inbox in
 * `delivery.test.ts`.
 */

const it = testEffect(base)

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const OTHER_DIRECTORY = "/tmp/reminder-source-other"

const recordingLifecycle = () => {
  const transitions: Array<Parameters<Lifecycle.Interface["transition"]>[0]> = []
  const lifecycle = Lifecycle.Service.of({
    transition: (request) =>
      Effect.sync(() => {
        transitions.push(request)
        return { published: true }
      }),
    get: () => Effect.succeed(Option.none()),
    register: () => Effect.void,
  })
  return { transitions, lifecycle }
}

/** A clock wake-up that counts how often it was asked for. */
const countWakeUps = Effect.acquireRelease(
  Effect.sync(() => {
    const wakes = { count: 0 }
    const wake = () => {
      wakes.count += 1
    }
    EngineProcess.reminder.clocks.add(wake)
    return { wakes, wake }
  }),
  ({ wake }) =>
    Effect.sync(() => {
      EngineProcess.reminder.clocks.delete(wake)
    }),
)

describe("reminder source delivery", () => {
  it.effect("delivers one owed reminder at the idle boundary, marks the row and never repeats", () =>
    Effect.gen(function* () {
      yield* resetLive
      const sessionID = yield* seedSession(unique("ses_remsrc_deliver"))
      yield* insertReminder({ id: "rmd_deliver", session_id: sessionID, status: "due", fire_at: 1_000 })
      const recording = yield* recordingPrompts((yield* Database.Service).db)
      const source = yield* sourceHarness(DIRECTORY, recording.prompts)

      expect(yield* source.claim(sessionID)).toBe(true)
      expect(recording.admitted).toHaveLength(1)
      const admitted = recording.admitted[0]
      expect(admitted.input.agent).toBe("build")
      expect(admitted.input.parts).toMatchObject([
        {
          type: "text",
          synthetic: true,
          metadata: {
            reminder: { reminderID: "rmd_deliver", fireAt: 1_000, creator: "user", delayedMinutes: 0 },
          },
        },
      ])
      // The notice relays the user's text unchanged, as its last block.
      expect(noticeText(admitted)).toContain("[Reminder rmd_deliver]")
      expect(noticeText(admitted).endsWith("\n\ncheck the L5 smoke test")).toBe(true)
      // A notice never joins a running turn: the admission asks for the idle
      // boundary under the claim-time cancellation fence, keyed by occurrence.
      expect(admitted.extras).toMatchObject({
        when: "idle",
        origin: { kind: "inbox", source: "reminder", key: "rmd_deliver:1000" },
      })
      expect(admitted.options).toEqual({ continueToolBudget: true })
      // Delivery settles the ledger in the same transaction as the message.
      expect(yield* readReminder("rmd_deliver")).toMatchObject({
        status: "delivered",
        fire_at: 1_000,
        delivery: "rmd_deliver:1000",
        delivered_at: 0,
      })

      // The durable mark is the delivery's identity: a second claim writes nothing.
      expect(yield* source.claim(sessionID)).toBe(false)
      expect(recording.admitted).toHaveLength(1)
    }),
  )

  it.effect("annotates a delivery that reaches the session late with how late it is", () =>
    Effect.gen(function* () {
      yield* resetLive
      const sessionID = yield* seedSession(unique("ses_remsrc_late"))
      yield* insertReminder({ id: "rmd_late", session_id: sessionID, status: "due", fire_at: 0 })
      yield* TestClock.adjust(Duration.minutes(30))
      const recording = yield* recordingPrompts((yield* Database.Service).db)
      const source = yield* sourceHarness(DIRECTORY, recording.prompts)

      expect(yield* source.claim(sessionID)).toBe(true)
      expect(noticeText(recording.admitted[0])).toContain("(delayed 30 minutes)")
      expect(recording.admitted[0].input.parts[0]).toMatchObject({ metadata: { reminder: { delayedMinutes: 30 } } })
      expect(noticeText(recording.admitted[0]).endsWith("\n\ncheck the L5 smoke test")).toBe(true)
    }),
  )

  it.effect("a repeating reminder returns to scheduled with its next occurrence and is delivered once", () =>
    Effect.gen(function* () {
      yield* resetLive
      const { wakes } = yield* countWakeUps
      const sessionID = yield* seedSession(unique("ses_remsrc_repeat"))
      // 10:00, 11:00 and 12:00 came due while nothing ran; the latest, 12:00, is owed.
      yield* insertReminder({
        id: "rmd_repeat",
        session_id: sessionID,
        status: "due",
        fire_at: 2 * HOUR,
        every_ms: HOUR,
      })
      yield* TestClock.adjust(Duration.minutes(150))
      const recording = yield* recordingPrompts((yield* Database.Service).db)
      const source = yield* sourceHarness(DIRECTORY, recording.prompts)

      expect(yield* source.claim(sessionID)).toBe(true)
      expect(recording.admitted).toHaveLength(1)
      expect(noticeText(recording.admitted[0])).toContain("(delayed 30 minutes)")
      expect(noticeText(recording.admitted[0])).toContain("repeats every 1h")
      expect(recording.admitted[0].extras).toMatchObject({ origin: { key: "rmd_repeat:7200000" } })
      // Back to waiting, on the schedule's own phase: 13:00, not 13:30.
      expect(yield* readReminder("rmd_repeat")).toMatchObject({
        status: "scheduled",
        fire_at: 3 * HOUR,
        every_ms: HOUR,
        delivery: "rmd_repeat:7200000",
        delivered_at: 150 * MINUTE,
      })
      // The clock must recompute: the next occurrence moved.
      expect(wakes.count).toBe(1)

      // Exactly once: nothing is owed now.
      expect(yield* source.claim(sessionID)).toBe(false)
      expect(recording.admitted).toHaveLength(1)
    }),
  )

  it.effect("a one-shot delivery does not wake the clock: nothing moved that it waits for", () =>
    Effect.gen(function* () {
      yield* resetLive
      const { wakes } = yield* countWakeUps
      const sessionID = yield* seedSession(unique("ses_remsrc_nowake"))
      yield* insertReminder({ id: "rmd_nowake", session_id: sessionID, status: "due" })
      const recording = yield* recordingPrompts((yield* Database.Service).db)
      const source = yield* sourceHarness(DIRECTORY, recording.prompts)
      expect(yield* source.claim(sessionID)).toBe(true)
      expect(wakes.count).toBe(0)
    }),
  )

  it.effect("publishes the settled lifecycle edge: delivered for a one-shot, scheduled for a repeating reminder", () =>
    Effect.gen(function* () {
      yield* resetLive
      const sessionID = yield* seedSession(unique("ses_remsrc_edge"))
      yield* insertReminder({ id: "rmd_edge_once", session_id: sessionID, status: "due", fire_at: 1_000 })
      yield* insertReminder({
        id: "rmd_edge_every",
        session_id: sessionID,
        status: "due",
        fire_at: 2_000,
        every_ms: HOUR,
      })
      const recording = yield* recordingPrompts((yield* Database.Service).db)
      const { transitions, lifecycle } = recordingLifecycle()
      // The port is captured at make, not looked up from the claim's context:
      // the claim runs in the inbox's captured graph, where Lifecycle is absent.
      const source = yield* sourceHarness(DIRECTORY, recording.prompts, lifecycle)

      expect(yield* source.claim(sessionID)).toBe(true)
      expect(transitions).toEqual([
        {
          ref: { domain: "reminder", id: "rmd_edge_once" },
          expect: "due",
          to: "delivered",
          reason: "delivered",
          sessionID,
        },
        {
          ref: { domain: "reminder", id: "rmd_edge_every" },
          expect: "due",
          to: "scheduled",
          reason: "delivered",
          sessionID,
        },
      ])
    }),
  )
})

describe("reminder source ledger", () => {
  it.effect("a startup scan finds an owed row and drains its session", () =>
    Effect.gen(function* () {
      yield* resetLive
      const sessionID = yield* seedSession(unique("ses_remsrc_restart"))
      // The row survived a crash: nobody delivered it, and the process that
      // moved it to due is gone.
      yield* insertReminder({ id: "rmd_restart", session_id: sessionID, status: "due" })
      const recording = yield* recordingPrompts((yield* Database.Service).db)
      const source = yield* sourceHarness(DIRECTORY, recording.prompts)

      expect(source.drains).toEqual([sessionID])
      // No live marker exists after a restart: the scan is what makes the hint true.
      expect(source.source()?.hint(sessionID)).toBe(true)
      expect(yield* source.claim(sessionID)).toBe(true)
      expect(recording.admitted).toHaveLength(1)
      expect((yield* readReminder("rmd_restart"))?.delivery).toBe("rmd_restart:1000")
    }),
  )

  it.effect("the tick's scan reports only the sessions of its directory that are owed", () =>
    Effect.gen(function* () {
      yield* resetLive
      const owed = yield* seedSession(unique("ses_remsrc_scan_owed"))
      const waiting = yield* seedSession(unique("ses_remsrc_scan_waiting"))
      const foreign = yield* seedSession(unique("ses_remsrc_scan_foreign"), OTHER_DIRECTORY)
      yield* insertReminder({ id: "rmd_scan_owed", session_id: owed, status: "due" })
      yield* insertReminder({ id: "rmd_scan_owed_two", session_id: owed, status: "due" })
      yield* insertReminder({ id: "rmd_scan_waiting", session_id: waiting, status: "scheduled" })
      yield* insertReminder({ id: "rmd_scan_done", session_id: waiting, status: "delivered" })
      yield* insertReminder({ id: "rmd_scan_foreign", session_id: foreign, status: "due" })
      const recording = yield* recordingPrompts((yield* Database.Service).db)
      const source = yield* sourceHarness(DIRECTORY, recording.prompts)

      expect(yield* source.source()!.scan!({ directory: DIRECTORY })).toEqual([owed])
      expect(yield* source.source()!.scan!({ directory: OTHER_DIRECTORY })).toEqual([foreign])
    }),
  )

  it.effect("two claims racing for one owed reminder keep exactly one message", () =>
    Effect.gen(function* () {
      yield* resetLive
      const sessionID = yield* seedSession(unique("ses_remsrc_race"))
      yield* insertReminder({ id: "rmd_race", session_id: sessionID, status: "due" })
      const recording = yield* recordingPrompts((yield* Database.Service).db, { barrier: 2 })
      const source = yield* sourceHarness(DIRECTORY, recording.prompts)

      const results = yield* Effect.forEach([1, 2], () => source.claim(sessionID), { concurrency: "unbounded" })
      expect(results.filter((won) => won)).toHaveLength(1)
      expect(results.filter((won) => !won)).toHaveLength(1)
      expect(recording.admitted).toHaveLength(1)
      expect((yield* readReminder("rmd_race"))?.delivery).toBe("rmd_race:1000")
    }),
  )

  it.effect("delivers nothing for rows that are not owed, are another directory's or belong to no session", () =>
    Effect.gen(function* () {
      yield* resetLive
      const sessionID = yield* seedSession(unique("ses_remsrc_filter"))
      const foreign = yield* seedSession(unique("ses_remsrc_filter_foreign"), OTHER_DIRECTORY)
      // Still waiting for its time, already finished, or cancelled: nothing is owed.
      yield* insertReminder({ id: "rmd_filter_scheduled", session_id: sessionID, status: "scheduled" })
      yield* insertReminder({ id: "rmd_filter_delivered", session_id: sessionID, status: "delivered" })
      yield* insertReminder({ id: "rmd_filter_cancelled", session_id: sessionID, status: "cancelled" })
      // Owed, but to a session another instance owns.
      yield* insertReminder({ id: "rmd_filter_foreign", session_id: foreign, status: "due" })
      const recording = yield* recordingPrompts((yield* Database.Service).db)
      const source = yield* sourceHarness(DIRECTORY, recording.prompts)

      expect(yield* source.claim(sessionID)).toBe(false)
      expect(yield* source.claim(foreign)).toBe(false)
      // A session that is gone has no rows and no claim.
      expect(yield* source.claim(SessionID.make(unique("ses_remsrc_gone")))).toBe(false)
      expect(recording.admitted).toHaveLength(0)
      expect(yield* readReminder("rmd_filter_foreign")).toMatchObject({ status: "due", delivery: null })
    }),
  )

  it.effect("a failed message write leaves the reminder owed for the next claim", () =>
    Effect.gen(function* () {
      yield* resetLive
      const sessionID = yield* seedSession(unique("ses_remsrc_fail"))
      yield* insertReminder({ id: "rmd_fail", session_id: sessionID, status: "due", every_ms: HOUR })
      const recording = yield* recordingPrompts((yield* Database.Service).db, { failAfterMark: true })
      const source = yield* sourceHarness(DIRECTORY, recording.prompts)

      expect(yield* Effect.flip(source.claim(sessionID))).toBeDefined()
      // The mark rolled back with the message: the occurrence is still owed, unmoved.
      expect(yield* readReminder("rmd_fail")).toMatchObject({
        status: "due",
        fire_at: 1_000,
        delivery: null,
        delivered_at: null,
      })
    }),
  )

  it.effect("a busy session keeps the reminder owed, then the next boundary delivers it once", () =>
    Effect.gen(function* () {
      yield* resetLive
      const sessionID = yield* seedSession(unique("ses_remsrc_busy"))
      yield* insertReminder({ id: "rmd_busy", session_id: sessionID, status: "due" })
      let running = true
      const recording = yield* recordingPrompts((yield* Database.Service).db, { busy: () => running })
      const source = yield* sourceHarness(DIRECTORY, recording.prompts)

      // A turn started between the claim and the admission: nothing committed.
      expect(yield* source.claim(sessionID)).toBe(false)
      expect(recording.admitted).toHaveLength(0)
      expect(yield* readReminder("rmd_busy")).toMatchObject({ status: "due", delivery: null })
      // Still reachable by the next idle boundary, without waiting for the tick.
      expect(source.source()?.hint(sessionID)).toBe(true)

      running = false
      expect(yield* source.claim(sessionID)).toBe(true)
      expect(recording.admitted).toHaveLength(1)
      expect(yield* source.claim(sessionID)).toBe(false)
      expect(recording.admitted).toHaveLength(1)
    }),
  )

  it.effect("several owed reminders are delivered one per boundary, never into the turn the first one started", () =>
    Effect.gen(function* () {
      yield* resetLive
      const sessionID = yield* seedSession(unique("ses_remsrc_many"))
      yield* insertReminder({ id: "rmd_many_a", session_id: sessionID, status: "due", fire_at: 1_000 })
      yield* insertReminder({ id: "rmd_many_b", session_id: sessionID, status: "due", fire_at: 2_000 })
      // The first admission starts a turn: every later one in the claim finds the session busy.
      let turnRunning = true
      const recording = yield* recordingPrompts((yield* Database.Service).db, {
        busy: (admitted) => admitted >= 1 && turnRunning,
      })
      const source = yield* sourceHarness(DIRECTORY, recording.prompts)

      expect(yield* source.claim(sessionID)).toBe(true)
      expect(recording.admitted.map((record) => record.extras?.origin)).toMatchObject([{ key: "rmd_many_a:1000" }])
      expect(yield* readReminder("rmd_many_b")).toMatchObject({ status: "due" })
      // The second is still owed to the session, and reachable at the next boundary.
      expect(source.source()?.hint(sessionID)).toBe(true)

      turnRunning = false
      expect(yield* source.claim(sessionID)).toBe(true)
      expect(recording.admitted.map((record) => record.extras?.origin)).toMatchObject([
        { key: "rmd_many_a:1000" },
        { key: "rmd_many_b:2000" },
      ])
      // Delivered everything: the marker is cleared and the hint says so.
      expect(source.source()?.hint(sessionID)).toBe(false)
    }),
  )
})

describe("reminder source cancellation", () => {
  it.effect("a reminder cancelled before the claim is never delivered", () =>
    Effect.gen(function* () {
      yield* resetLive
      const { db } = yield* Database.Service
      const sessionID = yield* seedSession(unique("ses_remsrc_cancel_before"))
      yield* insertReminder({ id: "rmd_cancel_before", session_id: sessionID, status: "due" })
      const recording = yield* recordingPrompts(db)
      const source = yield* sourceHarness(DIRECTORY, recording.prompts)

      expect(yield* ReminderStore.cancelLive(db, sessionID, "rmd_cancel_before", 5)).toMatchObject({
        before: { status: "due" },
        after: { status: "cancelled" },
      })
      expect(yield* source.claim(sessionID)).toBe(false)
      expect(recording.admitted).toHaveLength(0)
      expect(yield* readReminder("rmd_cancel_before")).toMatchObject({ status: "cancelled", delivery: null })
    }),
  )

  it.effect("a one-shot reminder that was delivered can no longer be cancelled, a repeating one still can", () =>
    Effect.gen(function* () {
      yield* resetLive
      const { db } = yield* Database.Service
      const sessionID = yield* seedSession(unique("ses_remsrc_cancel_after"))
      yield* insertReminder({ id: "rmd_cancel_once", session_id: sessionID, status: "due" })
      yield* insertReminder({
        id: "rmd_cancel_every",
        session_id: sessionID,
        status: "due",
        fire_at: 2_000,
        every_ms: HOUR,
      })
      const recording = yield* recordingPrompts(db)
      const source = yield* sourceHarness(DIRECTORY, recording.prompts)
      expect(yield* source.claim(sessionID)).toBe(true)
      expect(recording.admitted).toHaveLength(2)

      expect(yield* ReminderStore.cancelLive(db, sessionID, "rmd_cancel_once", 5)).toBeUndefined()
      expect(yield* readReminder("rmd_cancel_once")).toMatchObject({ status: "delivered" })
      // The repeating one is waiting for its next occurrence: cancelling it ends the repeat.
      expect(yield* ReminderStore.cancelLive(db, sessionID, "rmd_cancel_every", 5)).toMatchObject({
        before: { status: "scheduled" },
        after: { status: "cancelled" },
      })
      expect(yield* readReminder("rmd_cancel_every")).toMatchObject({ status: "cancelled" })
    }),
  )
})

describe("reminder source hint", () => {
  it.effect("answers from memory: a due marker or a session a scan found, and clears both once nothing is owed", () =>
    Effect.gen(function* () {
      yield* resetLive
      const sessionID = yield* seedSession(unique("ses_remsrc_hint"))
      const recording = yield* recordingPrompts((yield* Database.Service).db)
      const source = yield* sourceHarness(DIRECTORY, recording.prompts)
      const hint = source.source()!.hint

      expect(hint(sessionID)).toBe(false)
      // The clock of this process saw a reminder come due.
      EngineProcess.reminder.due.add(sessionID)
      expect(hint(sessionID)).toBe(true)
      // A false positive: nothing is owed, so one claim finds that out and clears the marker.
      expect(yield* source.claim(sessionID)).toBe(false)
      expect(hint(sessionID)).toBe(false)
      expect(EngineProcess.reminder.due.has(sessionID)).toBe(false)
    }),
  )

  it.effect("drops the marker of a session that no longer exists", () =>
    Effect.gen(function* () {
      yield* resetLive
      const gone = unique("ses_remsrc_hint_gone")
      const recording = yield* recordingPrompts((yield* Database.Service).db)
      const source = yield* sourceHarness(DIRECTORY, recording.prompts)
      EngineProcess.reminder.due.add(gone)
      expect(yield* source.claim(SessionID.make(gone))).toBe(false)
      expect(EngineProcess.reminder.due.has(gone)).toBe(false)
    }),
  )
})
