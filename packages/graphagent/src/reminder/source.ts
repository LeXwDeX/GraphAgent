// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "@graphagent/core/database/database"
import { Cause, Clock, Effect, Option, type Scope } from "effect"
import { DagLocation } from "@/dag/location"
import { InstanceRef } from "@/effect/instance-ref"
import { Lifecycle } from "@/lifecycle/service"
import { EngineProcess } from "@/session/engine-process"
import type { InboxSource, Interface as InboxInterface } from "@/session/inbox"
import type { Interface as PromptInterface } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { admitNowUnderFence } from "@/session/turn/admit"
import type { AdmissionOptions, TurnOrigin } from "@/session/turns"
import { wakeClocks } from "./clock"
import { ReminderSchedule } from "./schedule"
import { ReminderStore as Store } from "./store"

/**
 * The `reminder` inbox source (#1072): delivery of the user reminders the
 * process-level clock moves to `due`.
 *
 * The ledger is the `reminder` table. The clock writes `status=due`; the
 * source delivers it exactly once by running the row's delivery mark inside
 * the admission transaction that commits the notice. The mark is a
 * compare-and-swap on the status and the occurrence (`fire_at`), so its key,
 * `<id>:<fire_at>`, can only be written once: a one-shot reminder becomes
 * `delivered`, a repeating one returns to `scheduled` with `fire_at` past now.
 * A row still `due` is owed to the session and survives a restart.
 *
 * Delivery is `turn_boundary`: a notice never enters a running turn. While the
 * session is busy the inbox's idle gate skips the claim and the row waits; the
 * turn-end idle event (or the 30s tick, once the session is idle) delivers it.
 * The admission itself asks for `when: "idle"` as well, so a turn that starts
 * between the claim and the admission reports `skipped_busy` with nothing
 * committed, and the row stays owed instead of joining that turn.
 *
 * Three things bring a row here, none exclusive: the clock's nudge when a
 * reminder comes due (`EngineProcess.inbox.nudge`), the 30s tick through
 * `Store.owedSessions`, and the startup scan for rows an earlier process left
 * owed.
 */

export interface Deps {
  readonly db: Database.Interface["db"]
  /** The inbox of the instance this source serves; `drain` is its in-instance nudge. */
  readonly inbox: Pick<InboxInterface, "register" | "drain">
  /** The admission port. */
  readonly prompts: Pick<PromptInterface, "admit">
  /**
   * The lifecycle transition port, captured where the app layer provides it
   * (init): the inbox's captured graph has no Lifecycle, so resolving it from
   * the claim's context would silently drop the settled edge on the turn-end
   * delivery path.
   */
  readonly lifecycle?: Pick<Lifecycle.Interface, "transition">
  /** Directory of the instance this source serves; only the sessions it owns are delivered. */
  readonly directory: string
  /** Owns the startup deliveries (one fiber per session with an owed reminder). */
  readonly scope: Scope.Scope
}

/**
 * After the DAG wake (5), before child results (8), forge notices (9) and the
 * goal continuation (10): a reminder is the user's own request, so it takes
 * the boundary first, and a goal evaluation must not start a turn of its own
 * while one is about to.
 */
const PRIORITY = 7

// A notice back into the session keeps the turn's tool budget, like every internal follow-up.
const OPTIONS: AdmissionOptions = { continueToolBudget: true }

const originOf = (row: Store.Row): TurnOrigin => ({
  kind: "inbox",
  source: "reminder",
  key: Store.idempotencyKey(row),
})

const softly = (label: string, fields: Record<string, unknown>) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) =>
    Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.logWarning(label, { ...fields, cause: Cause.pretty(cause) }),
  )

/**
 * Publishes the settled lifecycle edge after the delivery transaction
 * committed. The durable row already carries the status; the event is the
 * transient notification, so a failure here loses no state. The port comes from
 * `Deps` rather than the claim's ambient context for the reason given there.
 */
const publishDelivered = (lifecycle: Deps["lifecycle"], row: Store.Row) => {
  if (!lifecycle) return Effect.void
  return lifecycle
    .transition({
      ref: { domain: "reminder", id: row.id },
      expect: "due",
      // A repeating reminder goes back to waiting for its next occurrence.
      to: row.every_ms === null ? "delivered" : "scheduled",
      reason: "delivered",
      sessionID: SessionID.make(row.session_id),
    })
    .pipe(softly("reminder lifecycle transition failed", { reminderID: row.id }))
}

interface Ctx extends Deps {
  /** Canonical directory of the instance: what an owning session's directory must equal. */
  readonly here: string
}

/**
 * Delivers one owed reminder. True when this call committed it; false when
 * another delivery already had (the mark found the row moved), the session was
 * busy at the idle boundary, or a cancellation of the turn overtook the claim
 * and the next idle boundary retries it.
 */
const deliver = (ctx: Ctx, session: Store.SessionInfo, row: Store.Row, claimEpoch: number) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const key = Store.idempotencyKey(row)
    const sessionID = SessionID.make(row.session_id)
    const late = now - row.fire_at
    const input = {
      sessionID,
      ...(session.agent ? { agent: session.agent } : {}),
      parts: [
        {
          type: "text" as const,
          synthetic: true,
          text: ReminderSchedule.renderNotice({
            id: row.id,
            text: row.text,
            fireAt: row.fire_at,
            everyMs: row.every_ms,
            lateMs: late,
          }),
          metadata: {
            reminder: {
              reminderID: row.id,
              fireAt: row.fire_at,
              creator: row.creator,
              ...(row.every_ms === null ? {} : { everyMs: row.every_ms }),
              delayedMinutes: ReminderSchedule.lateMinutes(late),
            },
          },
        },
      ],
    }
    // The mark rides the transaction that commits the message: of two
    // deliveries racing for one row, the second finds it moved, fails here and
    // rolls its message back. A crash after the admission is safe for the same
    // reason, and so is a cancellation: it wins before the notice or loses to it.
    const mark = Effect.suspend(() => Store.markDelivered(ctx.db, row, key, now)).pipe(
      Effect.flatMap((won) => (won ? Effect.void : Effect.fail(new Error(`reminder ${row.id} is already delivered`)))),
    )
    // Reminders are root-session only (`/remind` refuses a child session), so
    // the admission needs no child-run credential.
    const fenced = yield* admitNowUnderFence(
      ctx.prompts,
      input,
      OPTIONS,
      mark,
      claimEpoch,
      originOf(row),
      undefined,
      "idle",
    )
    // With `when: "idle"` a missing message means the session was busy and
    // nothing committed: the row waits for the next idle boundary. A committed
    // message (started, joined, written) means the mark committed with it.
    if (fenced.tag === "admitted" && fenced.start.message !== undefined) {
      yield* publishDelivered(ctx.lifecycle, row)
      // A repeating reminder's `fire_at` moved: the clock recomputes its sleep.
      if (row.every_ms !== null) wakeClocks()
      return true
    }
    return false
  }).pipe(
    // The mark found the row moved (or the transaction failed for another
    // reason): the row decides.
    Effect.catchTag("SessionPromptAdmissionPersistFailed", (failure) =>
      Store.rowOf(ctx.db, row.id).pipe(
        Effect.flatMap((current) =>
          current === undefined || current.status !== "due" || current.fire_at !== row.fire_at
            ? Effect.succeed(false)
            : Effect.fail(failure),
        ),
      ),
    ),
  )

/**
 * Builds and registers the source in this instance's inbox, then delivers what
 * earlier processes left owed. Returns nothing: the source lives with the
 * instance's inbox, and the startup deliveries with `deps.scope`.
 */
export const make = Effect.fn("ReminderSource.make")(function* (deps: Deps) {
  const here = DagLocation.canonicalDirectory(deps.directory)
  const ctx: Ctx = { ...deps, here }
  // Sessions a scan found owed, or a claim could not finish. After a restart no
  // live marker exists, so the hint would say no.
  const pending = new Set<SessionID>()

  const claim: InboxSource["claim"] = (sessionID, claimCtx) =>
    Effect.gen(function* () {
      pending.delete(sessionID)
      // Idle events are store-global: only the instance whose directory owns the session delivers into it.
      const session = yield* Store.sessionOf(ctx.db, sessionID)
      if (!session) {
        // The session is gone, and its reminders went with it.
        EngineProcess.reminder.due.delete(sessionID)
        return false
      }
      if (DagLocation.canonicalDirectory(session.directory) !== ctx.here) return false
      const rows = yield* Store.owedOf(ctx.db, sessionID)
      let delivered = 0
      for (const row of rows) {
        if (yield* deliver(ctx, session, row, claimCtx.claimEpoch)) delivered++
      }
      if (delivered === rows.length) {
        // Nothing is owed any more (or never was: the hint was a false positive).
        EngineProcess.reminder.due.delete(sessionID)
      } else {
        // One this claim could not deliver (a turn started in the race, or an
        // ESC) must stay reachable by the next idle boundary; without this the
        // tick would be its only reminder.
        pending.add(sessionID)
      }
      return delivered > 0
    })

  yield* deps.inbox.register({
    id: "reminder",
    priority: PRIORITY,
    mode: "turn_boundary",
    // In memory and allowed to be a false positive: a reminder this process's
    // clock saw come due, or a session a scan found owed. Anything else waits
    // for the tick, which forces the claim.
    hint: (sessionID) => pending.has(sessionID) || EngineProcess.reminder.due.has(sessionID),
    scan: (scanCtx) => Store.owedSessions(ctx.db, scanCtx.directory),
    claim,
  })

  const owed = yield* Store.owedSessions(ctx.db, deps.directory).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.logWarning("reminder startup scan failed", {
            directory: deps.directory,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as<SessionID[]>([])),
    ),
  )
  for (const sessionID of owed) {
    pending.add(sessionID)
    yield* deps.inbox
      .drain(sessionID)
      .pipe(
        softly("reminder startup delivery failed", { sessionID }),
        Effect.forkIn(deps.scope, { startImmediately: true }),
        Effect.asVoid,
      )
  }
})

/**
 * Per-instance wiring, called from instance bootstrap before `SessionInbox.init`
 * (like `PrWatchSource.init`): resolves the admission port from the app layer
 * and registers the source. Skipped where the app layer is absent (standalone
 * graphs).
 */
export const init = Effect.fn("ReminderSource.init")(function* (input: {
  readonly inbox: Deps["inbox"]
  readonly database: Database.Interface
  readonly scope: Scope.Scope
}) {
  const instance = yield* InstanceRef
  if (!instance) return
  // Lazy for the same reason the inbox's `submit` is: `prompt.ts` pulls the whole engine.
  const { SessionPrompt } = yield* Effect.promise(() => import("@/session/prompt"))
  const prompts = Option.getOrUndefined(yield* Effect.serviceOption(SessionPrompt.Service))
  if (!prompts) return
  // Captured here, in the caller's (app layer) context, so a claim running in
  // the inbox's captured graph still has the lifecycle port.
  const lifecycle = Option.getOrUndefined(yield* Effect.serviceOption(Lifecycle.Service))
  yield* make({
    db: input.database.db,
    inbox: input.inbox,
    prompts,
    ...(lifecycle ? { lifecycle } : {}),
    directory: instance.directory,
    scope: input.scope,
  })
})

export * as ReminderSource from "./source"
