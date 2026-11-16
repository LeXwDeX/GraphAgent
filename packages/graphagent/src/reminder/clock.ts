// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Cause, Clock, Context, Deferred, Duration, Effect, Fiber, Layer, Scope } from "effect"
import { randomUUID } from "node:crypto"
import { Lifecycle } from "@/lifecycle/service"
import { EngineProcess } from "@/session/engine-process"
import { SessionID } from "@/session/schema"
import { ReminderSchedule } from "./schedule"
import { ReminderStore as Store } from "./store"

/**
 * The process-level clock of user reminders (#1072).
 *
 * A reminder is a durable row (`reminder`); this layer owns the one thing the
 * row cannot do for itself: waking at the right time. It keeps no state except
 * the pointer of its single timer, which sleeps until the earliest scheduled
 * `fire_at`. Creating, cancelling or advancing a reminder wakes it to recompute
 * (`wakeClocks`), and a bounded sleep keeps a clock jump or a sleeping machine
 * from parking it far past the next reminder.
 *
 * When a reminder's time comes the clock does one thing: it moves the row from
 * `scheduled` to `due` with a compare-and-swap, publishes the lifecycle edge
 * and nudges the inbox. Delivery is the `reminder` inbox source's: it writes
 * the notice at a turn boundary and settles the row. Several layer graphs of
 * one process, and several processes, share the database, so the per-row CAS
 * (not a singleton) is what keeps one transition and one notice per reminder.
 *
 * Process start is the same pass as every other wake-up: reminders that came
 * due while nothing was running are still `scheduled` with a past `fire_at`,
 * so the first pass moves them to `due` (a repeating one is moved to its
 * latest missed occurrence and delivered once), and the source delivers what
 * earlier processes left `due`.
 */

/** The longest one sleep may last, with or without a reminder pending. */
const MAX_SLEEP_MS = 60_000
/** A pass that left a due reminder behind (a failed write) retries after this, never in a hot loop. */
const RETRY_MS = 1_000
const BATCH_LIMIT = 32
/** Attempts at drawing an unused id before giving up; a collision needs 32 bits to agree. */
const ID_ATTEMPTS = 5

/** One reminder as the command and the list show it. */
export interface Info {
  readonly id: string
  readonly sessionID: string
  readonly text: string
  /** The occurrence the reminder waits for or owes. */
  readonly fireAt: number
  /** The repeat interval, or null for a one-shot reminder. */
  readonly everyMs: number | null
  readonly status: string
  readonly createdAt: number
}

export interface CreateInput {
  readonly sessionID: string
  readonly text: string
  readonly fireAt: number
  /** Repeat interval in milliseconds; at least `ReminderSchedule.MIN_EVERY_MS`. */
  readonly everyMs?: number
}

export interface Interface {
  /**
   * Durably creates a reminder for a session and wakes the clock. There is no
   * creator argument: a reminder is always the user's.
   */
  readonly create: (input: CreateInput) => Effect.Effect<Info>
  /** The session's reminders that can still fire or are owed, soonest first. */
  readonly list: (sessionID: string) => Effect.Effect<ReadonlyArray<Info>>
  /**
   * Cancels a live reminder of the session: a guarded write to `cancelled`
   * plus the lifecycle edge. An unknown, foreign or finished reminder reads as
   * undefined.
   */
  readonly cancel: (input: { readonly sessionID: string; readonly id: string }) => Effect.Effect<Info | undefined>
  /** One pass over the reminders whose time has come. Exported for deterministic tests. */
  readonly promoteOnce: () => Effect.Effect<number>
  /** Starts the clock's loop (idempotent; the startup layer calls it at construction). */
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/ReminderClock") {}

/** Wakes every clock of this process so none sleeps past a changed next wake-up time. */
export const wakeClocks = (): void => {
  for (const wake of EngineProcess.reminder.clocks) wake()
}

const infoOf = (row: Store.Row): Info => ({
  id: row.id,
  sessionID: row.session_id,
  text: row.text,
  fireAt: row.fire_at,
  everyMs: row.every_ms,
  status: row.status,
  createdAt: row.created_at,
})

export const make = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const lifecycle = yield* Lifecycle.Service
  const scope = yield* Scope.Scope

  // One wake-up gate per loop iteration. A change completes the current gate so
  // the loop recomputes its sleep at once; a wake lost in a race is harmless
  // because every iteration re-reads the earliest scheduled reminder.
  let gate: Deferred.Deferred<void> | undefined
  let loop: Fiber.Fiber<void> | undefined

  const wakeUp = () => {
    if (gate !== undefined) Deferred.doneUnsafe(gate, Effect.void)
  }
  EngineProcess.reminder.clocks.add(wakeUp)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      EngineProcess.reminder.clocks.delete(wakeUp)
    }),
  )

  const publish = (id: string, from: string | null, to: string, reason: string, sessionID: string) =>
    lifecycle.transition({ ref: { domain: "reminder", id }, expect: from, to, reason, sessionID })

  /**
   * Wakes the inbox that owns the reminder's session after a reminder came due.
   * The inbox installs its own idle gate on this route, so a nudge that lands
   * mid-turn is dropped and the turn-end idle event delivers the notice; no
   * loaded instance only means the durable row waits for the instance's startup
   * scan or its 30s tick.
   */
  const nudge = (sessionID: string) =>
    Effect.suspend(() => {
      const route = EngineProcess.inbox.nudge
      if (!route) return Effect.void
      return route(SessionID.make(sessionID)).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.void
            : Effect.logWarning("ReminderClock delivery nudge failed", { sessionID, cause: Cause.pretty(cause) }),
        ),
      )
    })

  const promoteOne = Effect.fnUntraced(function* (row: Store.Row, now: number) {
    const updated = yield* Store.promote(db, row, now)
    // The reminder is due whoever moved it: another clock may have won the
    // swap, and this process may host the instance that delivers it.
    EngineProcess.reminder.due.add(row.session_id)
    if (!updated) return false
    yield* publish(updated.id, "scheduled", "due", "due", updated.session_id)
    yield* nudge(updated.session_id)
    return true
  })

  const promoteOnce = Effect.fn("ReminderClock.promoteOnce")(function* () {
    const now = yield* Clock.currentTimeMillis
    const rows = yield* Store.dueRows(db, now, BATCH_LIMIT)
    let promoted = 0
    for (const row of rows) {
      // A defect inside one row only costs that row this pass; the loop reads
      // it again after `RETRY_MS`. Interrupts still unwind.
      const moved = yield* promoteOne(row, now).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("ReminderClock could not promote a reminder", {
                reminderID: row.id,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
        ),
      )
      if (moved) promoted++
    }
    return promoted
  })

  /** One pass and the sleep that follows it. */
  const tick = Effect.gen(function* () {
    const promoted = yield* promoteOnce()
    const now = yield* Clock.currentTimeMillis
    const next = yield* Store.nextFireAt(db)
    // More due reminders than one batch: go again at once. One that is still
    // due after a pass failed to move: back off instead of spinning.
    if (promoted >= BATCH_LIMIT) return 0
    if (next === undefined) return MAX_SLEEP_MS
    if (next <= now) return RETRY_MS
    return Math.min(next - now, MAX_SLEEP_MS)
  })

  const loopEffect = Effect.gen(function* () {
    for (;;) {
      const current = yield* Deferred.make<void>()
      gate = current
      // The whole tick is guarded: a dead database or a bad row degrades to a
      // logged interval skip, never a dead loop. Scope disposal still unwinds.
      const wait = yield* tick.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("ReminderClock tick failed — retrying next interval", { cause }).pipe(
                Effect.as(MAX_SLEEP_MS),
              ),
        ),
      )
      yield* Effect.raceFirst(Effect.sleep(Duration.millis(wait)), Deferred.await(current))
    }
  })

  const init = Effect.fn("ReminderClock.init")(function* () {
    if (loop) return
    loop = yield* loopEffect.pipe(Effect.forkIn(scope))
  })

  const create = Effect.fn("ReminderClock.create")(function* (input: CreateInput) {
    if (input.everyMs !== undefined && input.everyMs < ReminderSchedule.MIN_EVERY_MS)
      return yield* Effect.die(
        new Error(`a repeating reminder needs an interval of at least ${ReminderSchedule.MIN_EVERY_MS}ms`),
      )
    const now = yield* Clock.currentTimeMillis
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
      const id = `rmd_${randomUUID().slice(0, 8)}`
      const row = yield* Store.insert(db, {
        id,
        session_id: input.sessionID,
        text: input.text,
        fire_at: input.fireAt,
        every_ms: input.everyMs ?? null,
        status: "scheduled",
        creator: "user",
        created_at: now,
        updated_at: now,
      })
      if (!row) continue
      yield* publish(id, null, "scheduled", "created", input.sessionID)
      wakeClocks()
      return infoOf(row)
    }
    return yield* Effect.die(new Error("reminder id collision"))
  })

  const list = Effect.fn("ReminderClock.list")(function* (sessionID: string) {
    return (yield* Store.liveOf(db, sessionID)).map(infoOf)
  })

  const cancel = Effect.fn("ReminderClock.cancel")(function* (input: {
    readonly sessionID: string
    readonly id: string
  }) {
    const now = yield* Clock.currentTimeMillis
    const done = yield* Store.cancelLive(db, input.sessionID, input.id, now)
    if (!done) return undefined
    yield* publish(done.after.id, done.before.status, "cancelled", "cancelled", input.sessionID)
    // The earliest scheduled reminder may be the one that just went away.
    wakeClocks()
    return infoOf(done.after)
  })

  return Service.of({ create, list, cancel, promoteOnce, init })
})

/** Bare service without process-start side effects; tests provide Database and Lifecycle. */
export const layer = Layer.effect(Service, make)

const startupLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const service = yield* make
    yield* service.init()
    return service
  }),
)

export const defaultLayer = startupLayer.pipe(
  Layer.provide(Layer.mergeAll(Database.defaultLayer, Lifecycle.defaultLayer)),
)

export const node = LayerNode.make(startupLayer, [Database.node, Lifecycle.node])

export * as ReminderClock from "./clock"
