// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "@graphagent/core/database/database"
import { Cause, Clock, Effect, Option, type Scope } from "effect"
import { DagLocation } from "@/dag/location"
import { InstanceRef } from "@/effect/instance-ref"
import { Lifecycle } from "@/lifecycle/service"
import { ChildRegistry } from "@/session/child/registry"
import type { InboxSource, Interface as InboxInterface } from "@/session/inbox"
import type { Interface as PromptInterface } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { admitNowUnderFence } from "@/session/turn/admit"
import type { AdmissionOptions, TurnOrigin } from "@/session/turns"
import { EngineProcess } from "@/session/engine-process"
import { renderNotice, type Notice } from "./forge"
import { PrWatchStore as Store } from "./store"

/**
 * The `pr_watch` inbox source (#1071 PR3): delivery of the forge outcomes the
 * process-level poller records.
 *
 * The ledger is the `pr_watch` table. An observation moves its row to
 * `delivering` with the outcome; `delivery` stays empty until the notice
 * commits, and the mark — `delivery` plus the terminal phase — is written
 * inside the admission transaction. A row whose mark is still empty is owed to
 * the session and survives a restart; a marked row is settled and the resolver
 * no longer reports it as live.
 *
 * Delivery is `turn_boundary`: a notice never enters a running turn. While the
 * session is busy the inbox's idle gate skips the claim and the row waits; the
 * turn-end idle event (or the 30s tick, once the session is idle) delivers it.
 * The admission itself asks for `when: "idle"` as well, so a turn that starts
 * between the claim and the admission reports `skipped_busy` with nothing
 * committed, and the row stays owed instead of joining that turn.
 *
 * Three things bring a row here, none exclusive: the process-level poller's
 * nudge when it observes an outcome (`EngineProcess.inbox.nudge`), the 30s tick
 * through `Store.deliveringSessions`, and the startup scan for rows an earlier
 * process left owed.
 */

export interface Deps {
  readonly db: Database.Interface["db"]
  /** The inbox of the instance this source serves; `drain` is its in-instance nudge. */
  readonly inbox: Pick<InboxInterface, "register" | "drain">
  /** The admission port. */
  readonly prompts: Pick<PromptInterface, "admit">
  /** Directory of the instance this source serves; only the sessions it owns are delivered. */
  readonly directory: string
  /** Owns the startup deliveries (one fiber per session with an owed notice). */
  readonly scope: Scope.Scope
}

/**
 * After child results (8), before the goal continuation (10): a goal
 * evaluation must not start a turn of its own while a forge notice is about to.
 */
const PRIORITY = 9

// A notice back into the session keeps the turn's tool budget, like every internal follow-up.
const OPTIONS: AdmissionOptions = { continueToolBudget: true }

const originOf = (row: Store.Row): TurnOrigin => ({
  kind: "inbox",
  source: "pr_watch",
  key: Store.idempotencyKey(row),
})

const softly = (label: string, fields: Record<string, unknown>) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) =>
    Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.logWarning(label, { ...fields, cause: Cause.pretty(cause) }),
  )

/** A live entry means this process's poller may have a notice to deliver; a false positive only costs one claim. */
const maybeDelivering = () => [...EngineProcess.prWatch.watches.values()].some((watch) => watch.phase === "delivering")

/**
 * Flips a goal waiting on this watch back to active before the notice turn.
 * `evaluate: false`: the notice turn's own idle event drives the next goal
 * evaluation, exactly like the retired in-tool watch did. A runtime without
 * the goal loop (headless fixtures) simply skips it.
 */
const wakeGoal = (row: Store.Row, notice: Notice) =>
  Effect.gen(function* () {
    const { GoalLoop } = yield* Effect.promise(() => import("@/goal/loop"))
    const loops = Option.getOrUndefined(yield* Effect.serviceOption(GoalLoop.Service))
    if (!loops) return
    yield* loops.wake(
      SessionID.make(row.session_id),
      { source: "watch_pr", ids: [row.id, row.url] },
      renderNotice(notice),
      { evaluate: false },
    )
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.logWarning("pr watch goal wake failed", {
            watchID: row.id,
            cause: Cause.pretty(cause),
          }),
    ),
  )

/**
 * Publishes the terminal lifecycle edge after the delivery transaction
 * committed. The durable row already carries the phase; the event is the
 * transient notification, so a failure here loses no state.
 */
const publishSettled = (row: Store.Row, phase: "succeeded" | "failed") =>
  Effect.gen(function* () {
    const lifecycle = Option.getOrUndefined(yield* Effect.serviceOption(Lifecycle.Service))
    if (!lifecycle) return
    yield* lifecycle.transition({
      ref: { domain: "pr_watch", id: row.id },
      expect: "delivering",
      to: phase,
      reason: row.outcome ?? "delivered",
      sessionID: SessionID.make(row.session_id),
    })
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.logWarning("pr watch lifecycle transition failed", {
            watchID: row.id,
            cause: Cause.pretty(cause),
          }),
    ),
  )

interface Ctx extends Deps {
  /** Canonical directory of the instance: what an owning session's directory must equal. */
  readonly here: string
}

/**
 * Delivers one owed notice. True when this call committed it; false when
 * another delivery already had (the mark found the row delivered), the session
 * was busy at the idle boundary, or a cancellation overtook the claim and the
 * next idle boundary retries it.
 */
const deliver = (ctx: Ctx, session: Store.SessionInfo, row: Store.Row, claimEpoch: number) =>
  Effect.gen(function* () {
    const notice = Store.noticeOf(row)
    if (!notice) {
      // The poller only writes `delivering` with one of these outcomes; a row
      // that lost its outcome is left visible rather than silently consumed.
      yield* Effect.logWarning("pr watch row has no deliverable outcome", { watchID: row.id, outcome: row.outcome })
      return false
    }
    const now = yield* Clock.currentTimeMillis
    const key = Store.idempotencyKey(row)
    const phase = Store.settledPhase(notice.outcome)
    const text = renderNotice(notice)
    const sessionID = SessionID.make(row.session_id)
    // Wake before the admission, like the retired in-tool watch: the notice
    // turn's end-of-turn idle is what evaluates the goal. Waking afterwards
    // would race a turn that can end before this fiber resumes.
    yield* wakeGoal(row, notice)
    const input = {
      sessionID,
      ...(session.agent ? { agent: session.agent } : {}),
      parts: [
        {
          type: "text" as const,
          synthetic: true,
          text,
          metadata: {
            prWatch: {
              watchID: row.id,
              url: row.url,
              outcome: notice.outcome,
              ...(row.head ? { head: row.head } : {}),
            },
          },
        },
      ],
    }
    // The mark rides the transaction that commits the message: of two
    // deliveries racing for one row, the second finds it delivered, fails here
    // and rolls its message back. The terminal phase commits with it, so a
    // later resolver or restart reads a settled watch, not a delivering one.
    // A crash after the admission is safe for the same reason.
    const mark = Effect.suspend(() => Store.markDelivered(ctx.db, row.id, key, now, phase)).pipe(
      Effect.flatMap((won) => (won ? Effect.void : Effect.fail(new Error(`pr watch ${row.id} is already delivered`)))),
    )
    // The registering session is root-only (`watch_pr` is a ROOT_ONLY tool), so
    // the guard normally needs no credential; a child session would need its
    // live run credential, exactly like a child result.
    const credential = ChildRegistry.credentialOf(sessionID)
    const fenced = yield* admitNowUnderFence(
      ctx.prompts,
      input,
      OPTIONS,
      mark,
      claimEpoch,
      originOf(row),
      credential,
      "idle",
    )
    // With `when: "idle"` a missing message means the session was busy and
    // nothing committed: the row waits for the next idle boundary. A committed
    // message (started, joined, written) means the mark committed with it.
    if (fenced.tag === "admitted" && fenced.start.message !== undefined) {
      // The watch no longer owes anything: drop the live marker so the hint
      // and the resolver stop treating it as live, then publish the settled
      // edge the durable row already records.
      EngineProcess.prWatch.watches.delete(row.id)
      yield* publishSettled(row, phase)
      return true
    }
    return false
  }).pipe(
    // The mark found the row delivered (or the transaction failed for another
    // reason): the row decides.
    Effect.catchTag("SessionPromptAdmissionPersistFailed", (failure) =>
      Store.rowOf(ctx.db, row.id).pipe(
        Effect.flatMap((current) =>
          current === undefined || current.delivery !== null ? Effect.succeed(false) : Effect.fail(failure),
        ),
      ),
    ),
  )

/**
 * Builds and registers the source in this instance's inbox, then delivers what
 * earlier processes left owed. Returns nothing: the source lives with the
 * instance's inbox, and the startup deliveries with `deps.scope`.
 */
export const make = Effect.fn("PrWatchSource.make")(function* (deps: Deps) {
  const here = DagLocation.canonicalDirectory(deps.directory)
  const ctx: Ctx = { ...deps, here }
  // Sessions a scan found owed. After a restart no live marker exists, so the
  // hint would say no.
  const pending = new Set<SessionID>()

  const claim: InboxSource["claim"] = (sessionID, claimCtx) =>
    Effect.gen(function* () {
      pending.delete(sessionID)
      // Idle events are store-global: only the instance whose directory owns the session delivers into it.
      const session = yield* Store.sessionOf(ctx.db, sessionID)
      if (!session || DagLocation.canonicalDirectory(session.directory) !== ctx.here) return false
      const rows = yield* Store.undeliveredOf(ctx.db, sessionID)
      let delivered = false
      for (const row of rows) {
        const wrote = yield* deliver(ctx, session, row, claimCtx.claimEpoch)
        delivered = wrote || delivered
      }
      // An outcome observed by an earlier process has no live marker, and one
      // this claim could not deliver (a turn started in the race, or an ESC)
      // must stay reachable by the next idle boundary; without this the tick
      // would be its only reminder.
      if (!delivered && rows.length > 0) pending.add(sessionID)
      return delivered
    })

  yield* deps.inbox.register({
    id: "pr_watch",
    priority: PRIORITY,
    mode: "turn_boundary",
    // In memory and allowed to be a false positive: a live observation of this
    // process, or a session a scan found owed. Anything else waits for the
    // tick, which forces the claim.
    hint: (sessionID) => pending.has(sessionID) || maybeDelivering(),
    scan: (scanCtx) => Store.deliveringSessions(ctx.db, scanCtx.directory),
    claim,
  })

  const owed = yield* Store.deliveringSessions(ctx.db, deps.directory).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.logWarning("pr watch startup scan failed", {
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
        softly("pr watch startup delivery failed", { sessionID }),
        Effect.forkIn(deps.scope, { startImmediately: true }),
        Effect.asVoid,
      )
  }
})

/**
 * Per-instance wiring, called from instance bootstrap before `SessionInbox.init`
 * (like `ChildResults.init`): resolves the admission port from the app layer and
 * registers the source. Skipped where the app layer is absent (standalone graphs).
 */
export const init = Effect.fn("PrWatchSource.init")(function* (input: {
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
  yield* make({
    db: input.database.db,
    inbox: input.inbox,
    prompts,
    directory: instance.directory,
    scope: input.scope,
  })
})

export * as PrWatchSource from "./source"