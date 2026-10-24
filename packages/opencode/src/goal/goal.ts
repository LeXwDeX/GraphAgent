export * as Goal from "./goal"

import { Effect, Layer, Context, Schema, Fiber, Cause, Exit } from "effect"
import { desc, eq, sql } from "drizzle-orm"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GoalState } from "./state"
import { GoalOutcomeTable, GoalStateTable } from "@opencode-ai/core/goal/sql"
import { GoalEvent } from "./events"
import { GoalPrompts } from "./prompts"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionAutomationLease } from "@/session/automation-lease"
import { SessionLocation } from "@/session/location"
import { DagLocation } from "@/dag/location"

/**
 * DAG-LOC-01 (P2-A) — goal-side execution-location ownership.
 *
 * The DAG-side authority keys ownership on the workflow row, which is
 * vacuously true for goal-only sessions (no workflow rows). The goal loop
 * therefore needs a REAL directory check: the durable session row's
 * directory (SessionTable — legal here, the goal module is outside the dag
 * trees) must match the calling instance's directory, same canonicalization
 * as the workflow-keyed authority. Vacuous-own remains ONLY where no
 * durable answer exists: a missing session row (synthetic test sessions /
 * already-deleted sessions whose goal state is gone with them) or a runtime
 * graph without the Database service (goal e2e fixtures; production always
 * carries it).
 */
export const ownsSession = (sessionID: SessionID, directory: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const durable = yield* SessionLocation.sessionDirectory(sessionID)
    if (durable._tag === "None") return true
    return DagLocation.canonicalDirectory(durable.value) === DagLocation.canonicalDirectory(directory)
  })

export type RemoveSubgoalResult =
  | { tag: "ok"; removed: string; state: GoalState.Info }
  | { tag: "noState" }
  | { tag: "outOfBounds"; size: number }

export type TurnControl =
  | { readonly action: "create"; readonly text: string; readonly maxTurns?: number }
  | { readonly action: "resume"; readonly maxTurns?: number }
  | { readonly action: "pause"; readonly reason: string }

export type TurnControlResult =
  | { readonly changed: true; readonly state: GoalState.Info }
  | { readonly changed: false; readonly reason: string }

export interface Interface {
  /** Controls issued inside a model turn; never starts or interrupts a prompt. */
  readonly controlDuringTurn: (sessionID: SessionID, input: TurnControl) => Effect.Effect<TurnControlResult>
  readonly load: (sessionID: SessionID) => Effect.Effect<GoalState.Info | undefined>
  /**
   * GOAL-FP-01-04: durable session ids whose goal_state row is still "active"
   * AND whose session belongs to `directory` — the startup-resume scan input
   * for GoalLoop.init. The session table is the directory authority
   * (goal_state has no directory column), so one instance's scan can never
   * drive another instance's goals. Best-effort: rows whose payload fails to
   * decode are skipped with a logged warning, not fatal.
   */
  readonly listActiveSessions: (directory: string) => Effect.Effect<ReadonlyArray<SessionID>, Error>
  readonly lastOutcome: (sessionID: SessionID) => Effect.Effect<GoalState.Info | undefined>
  readonly set: (sessionID: SessionID, goal: string, maxTurns?: number) => Effect.Effect<GoalState.Info>
  readonly pause: (sessionID: SessionID, reason: string) => Effect.Effect<GoalState.Info | undefined>
  readonly resume: (sessionID: SessionID, maxTurns?: number) => Effect.Effect<GoalState.Info | undefined>
  readonly clear: (sessionID: SessionID) => Effect.Effect<GoalState.Info | undefined>
  /** Session-deletion cleanup: remove goal_state AND all goal_outcome rows. */
  readonly purgeSession: (sessionID: SessionID) => Effect.Effect<void>
  readonly markDone: (sessionID: SessionID, reason: string) => Effect.Effect<GoalState.Info | undefined>
  readonly addSubgoal: (sessionID: SessionID, subgoal: string) => Effect.Effect<GoalState.Info | undefined>
  readonly removeSubgoal: (
    sessionID: SessionID,
    /** 1-based index of the subgoal to remove (1 = first subgoal). */
    index: number,
  ) => Effect.Effect<RemoveSubgoalResult>
  readonly clearSubgoals: (sessionID: SessionID) => Effect.Effect<GoalState.Info | undefined>
  readonly statusLine: (sessionID: SessionID) => Effect.Effect<string | undefined>
  readonly dispatch: (sessionID: SessionID, args: string) => Effect.Effect<{
    type: "message" | "kick"
    text: string
    announce?: string
  }>
  readonly dispatchSubgoal: (sessionID: SessionID, args: string) => Effect.Effect<{
    type: "message"
    text: string
  }>
  readonly updateAfterJudge: (
    sessionID: SessionID,
    verdict: GoalState.Verdict,
    reason: string,
    parseFailed: boolean,
    /** GOAL-FP-01-07: the pre-judge state identity is part of the contract —
     * a judge result is only applied when the durable row still carries this
     * goalID+revision pair. Required (not optional): an omitted expected would
     * let a stale loop result mutate whatever goal replaced the judged one. */
    expected: { readonly goalID: string; readonly revision: number },
    /** issue #285: the assistant message ID judged for this evaluation.
     * Persisted on continue commits as the DURABLE crash-recovery gate — the
     * boot scan skips a window still ending on this boundary (the
     * process-local evaluatedRevisions map cannot survive a crash).
     * GOAL-03: never persisted when `parseFailed` — a judge that produced no
     * verdict judged no boundary. */
    judged?: string,
  ) => Effect.Effect<
    | {
        state: GoalState.Info
        shouldContinue: boolean
        message: string
      }
    | undefined
  >
    readonly registerLoopFiber: (sessionID: SessionID, fiber: Fiber.Fiber<unknown, unknown>) => Effect.Effect<void>
    readonly clearLoopFiber: (sessionID: SessionID) => Effect.Effect<void>
    /**
     * Identity-scoped loop-fiber cleanup. Removes the fibers-Map entry for
     * `sessionID` ONLY if it currently still points at `fiber` (a newer idle
     * event may have already registered a fresh fiber via registerLoopFiber,
     * which interrupts and overwrites). MUST NOT interrupt the fiber — callers
     * invoke this once the fiber has already completed its work (natural
     * completion via the GoalLoop idle watcher). Without the identity check, a
     * naturally-completing old fiber would evict a freshly-registered new fiber
     * and silently stall the goal loop.
     */
    readonly clearLoopFiberIf: (
      sessionID: SessionID,
      fiber: Fiber.Fiber<unknown, unknown>,
    ) => Effect.Effect<void>
    /**
     * Terminal cleanup for the "done" transition: publishes goal.updated(status=done)
     * with a transient snapshot, deletes the row, then publishes goal.cleared.
     *
     * Safe to call from ANY context — including inside the loop fiber itself
     * (loop.ts done branch) — because it does NOT manage the fiber map. Callers
     * that need to stop a running loop from outside (user slash commands,
     * goal.complete tool calls) should call `clearFiber()` FIRST, e.g. markDone.
     *
     * Constructing the done-state snapshot (instead of publishing the raw
     * row, whose status is still "active") preserves the documented bus
     * contract: goal.updated(done) → goal.cleared.
     */
    readonly deleteAndPublishDone: (sessionID: SessionID, reason: string) => Effect.Effect<GoalState.Info | undefined>
    /**
     * Pause transition that does NOT touch the fiber map. Mirrors
     * deleteAndPublishDone's safety property: safe to call from inside the
     * loop fiber (loop.ts shouldPreempt branch) because goal.pause()
     * internally calls clearFiber which would self-interrupt before
     * publishGoal(paused) reaches the event bus.
     *
     * Callers that need to stop a running loop from outside (user slash
     * commands) should call `pause()` instead — it interrupts the loop
     * fiber AND publishes the paused event.
     *
     * `expected` binds a delayed loop decision to the Goal instance and
     * revision it observed; a mismatch is a no-op.
     */
    readonly pauseAndPublish: (
      sessionID: SessionID,
      reason: string,
      expected?: { readonly goalID: string; readonly revision: number },
    ) => Effect.Effect<GoalState.Info | undefined>
    /**
     * #892: durably reserve one automatic recovery action for the current
     * failure chain (one serialized read/decide/save transition).
     *
     * "retry" permits at most two dispatched retry turns; "reset" permits at
     * most one reasoning-state reset. The returned state carries the new
     * revision that later version-bound pauses must use. A failed identity or
     * revision match is `stale` and mutates nothing.
     */
    readonly claimRecovery: (
      sessionID: SessionID,
      expected: { readonly goalID: string; readonly revision: number },
      kind: "retry" | "reset",
      boundary: string,
    ) => Effect.Effect<
      | { readonly tag: "allowed"; readonly state: GoalState.Info }
      | { readonly tag: "exhausted"; readonly state: GoalState.Info }
      | { readonly tag: "stale" }
    >
    /**
     * Goal-turn provenance (GOAL-TURN-SCOPE). Marks the session's CURRENT
     * turn as goal-driven (kick / judge continuation / resume-kick) so
     * SessionPrompt.cancel can map a user ESC on a goal turn into a goal
     * pause instead of letting the idle event auto-resurrect the goal.
     * The mark is process-local InstanceState: cleared when the turn ends
     * (afterIdle entry, pause, clear, markDone) and safe to overwrite.
     */
    readonly markTurnDriven: (sessionID: SessionID) => Effect.Effect<void>
    /** Clears the goal-turn mark. No-op when not marked. */
    readonly clearTurnDriven: (sessionID: SessionID) => Effect.Effect<void>
    /**
     * ESC-on-goal-turn transition: pauses the goal (durable row + event) AND
     * releases the automation registration AND clears the turn mark — one
     * seam so SessionPrompt.cancel stays free of lease plumbing. No-op (returns
     * undefined) when the goal is not active. Never fails: pause failures are
     * logged and swallowed so a cancel path can always proceed.
     *
     * GOAL-02: when the pause exhausts its retries, durable row and lease
     * both still say "active" — the turn mark is RETAINED so the three
     * authorities agree and a repeat ESC retries the pause. The mark is
     * cleared on a successfully persisted pause; a successful NO-OP (goal
     * already paused/cleared when ESC lands) silently retires the stale mark
     * — no durable authority claims the goal as active.
     */
    readonly pauseForUserCancel: (sessionID: SessionID, reason: string) => Effect.Effect<GoalState.Info | undefined>
    /** True for a marked active goal; stale inactive marks are retired, unreadable state keeps the mark. */
    readonly isTurnDriven: (sessionID: SessionID) => Effect.Effect<boolean>
  }

export class Service extends Context.Service<Service, Interface>()("@opencode/Goal") {}

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service
    const sessionStatus = yield* SessionStatus.Service
    const automation = yield* SessionAutomationLease.Service

    // Unified event publisher — every state change publishes goal.updated
    // with the full snapshot, identical to Todo's todo.updated pattern.
    const publishGoal = (sessionID: SessionID, state: GoalState.Info) =>
      events.publish(GoalEvent.Updated, {
        sessionID,
        goal: {
          goal: state.goal,
          status: state.status,
          turnsUsed: state.turns_used,
          maxTurns: state.max_turns,
          subgoals: state.subgoals ?? [],
          ...(state.paused_reason !== undefined ? { pausedReason: state.paused_reason } : {}),
        },
      })

    const fibers = new Map<SessionID, Fiber.Fiber<unknown, unknown>>()

    // GOAL-TURN-SCOPE: process-local provenance of the CURRENT goal-driven
    // turn. Keyed by session; set at every goal dispatch (kick in prompt.ts,
    // continuation in loop.ts), cleared at turn end (afterIdle entry) and at
    // every terminal transition (pause/clear/markDone). On ESC-cancel the
    // clear happens when the pause persisted OR the cancel is a successful
    // no-op (goal already inactive — nothing claims it as active); only if
    // the pause exhausts its retries is the mark RETAINED so it agrees with
    // the still-active durable row and lease (GOAL-02). A stale mark is
    // retired by isTurnDriven after checking the durable goal row. Read
    // failures retain the mark so ESC can retry a failed pause.
    const turnDriven = new Set<SessionID>()

    const markTurnDriven = Effect.fnUntraced(function* (sessionID: SessionID) {
      turnDriven.add(sessionID)
    })

    const clearTurnDriven = Effect.fnUntraced(function* (sessionID: SessionID) {
      turnDriven.delete(sessionID)
    })

    const isTurnDriven = Effect.fnUntraced(function* (sessionID: SessionID) {
      if (!turnDriven.has(sessionID)) return false
      // Revalidate leaked marks against durable state before routing ESC.
      const state = yield* loadState(sessionID).pipe(Effect.exit)
      if (Exit.isFailure(state)) {
        if (Cause.hasInterrupts(state.cause)) return yield* Effect.interrupt
        // A store failure cannot prove the goal inactive. Keep ESC provenance
        // so pauseForUserCancel can retry once the store recovers.
        return true
      }
      if (!state.value || state.value.status !== "active") {
        turnDriven.delete(sessionID)
        return false
      }
      return true
    })

    // ESC-on-goal-turn: durable pause + lease release + mark clear. Called
    // from SessionPrompt.cancel so a user ESC on a goal turn pauses the goal
    // instead of letting the post-cancel idle event resurrect it with an
    // unwanted continuation.
    //
    // GOAL-FP-01-19: a transient DB failure must not silently lose the pause
    // — the mark would clear, the pause never persist, and the next idle
    // would resurrect the goal against the user's explicit intent
    // (shouldPreempt cannot catch it: ESC adds no user message). Retry the
    // pause twice with a short backoff; if it still fails, log LOUDLY — the
    // goal may resurrect, but it will never do so invisibly.
    // GOAL-02: an exhausted failure path keeps durable row, lease, and the
    // turn mark consistent (all still "active/owned/driven") — see the
    // failure branch below.
    const pauseForUserCancel = Effect.fnUntraced(function* (sessionID: SessionID, reason: string) {
      let paused: GoalState.Info | undefined
      let lastCause: Cause.Cause<never> | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        const exit = yield* pauseAndPublish(sessionID, reason).pipe(Effect.exit)
        if (Exit.isSuccess(exit)) {
          paused = exit.value
          // Classify by the FINAL attempt: an early transient failure followed
          // by a successful outcome (e.g. a concurrent pauser lands between
          // retries) is a success/no-op, not retry exhaustion — drop the
          // stale cause so the branches below read the real outcome.
          lastCause = undefined
          break
        }
        lastCause = exit.cause
        if (attempt < 2) yield* Effect.sleep("50 millis")
      }
      if (paused) {
        yield* automation.unregister(sessionID, { kind: "goal", id: paused.goal_id ?? "legacy" }).pipe(
          Effect.ignore,
        )
        turnDriven.delete(sessionID)
      } else if (lastCause) {
        // GOAL-02: genuine retry exhaustion — the pause could not be
        // persisted, the durable row is still "active" and the lease
        // registration is still in place, so the process-local mark must
        // AGREE with both: keep it. Pre-fix it was deleted unconditionally,
        // which disagreed with the durable authorities (goal still owns the
        // session as active) and lost the ESC provenance on the resurrected
        // turn — the user's second ESC would no longer route through this
        // goal-pause fast path, because SessionPrompt.cancel maps ESC to a
        // goal pause only for marked turns. With the mark retained, every
        // repeat ESC retries the pause until the store recovers.
        yield* Effect.logError(
          "goal pause on cancel failed after retries — goal stays active and turn-driven; a repeat ESC retries the pause",
          { sessionID, cause: Cause.pretty(lastCause) },
        )
      } else {
        // Successful NO-OP: pauseAndPublish found no active goal (row absent
        // or already paused/cleared — e.g. an auto-pause committed between
        // the mark and this ESC). No durable authority claims the goal as
        // active, so there is nothing to retain the mark for and no failure
        // to report — retire the stale mark silently.
        turnDriven.delete(sessionID)
      }
      return paused
    })

    const registerFiber = Effect.fnUntraced(function* (
      sessionID: SessionID,
      fiber: Fiber.Fiber<unknown, unknown>,
    ) {
      const existing = fibers.get(sessionID)
      if (existing) yield* Fiber.interrupt(existing)
      fibers.set(sessionID, fiber)
    })

    const clearFiber = Effect.fnUntraced(function* (sessionID: SessionID) {
      const existing = fibers.get(sessionID)
      if (existing) {
        yield* Fiber.interrupt(existing)
        fibers.delete(sessionID)
      }
    })

    // Identity-scoped self-clean for naturally-completing loop fibers. Deletes
    // the map entry only when it still references THIS fiber — a subsequent
    // idle event's registerFiber may have already interrupted the old fiber and
    // installed a new one, and deleting unconditionally would evict the new
    // fiber. Never interrupts: the calling fiber has already finished its work.
    const clearFiberIf = Effect.fnUntraced(function* (
      sessionID: SessionID,
      fiber: Fiber.Fiber<unknown, unknown>,
    ) {
      if (fibers.get(sessionID) === fiber) {
        fibers.delete(sessionID)
      }
    })

    // D-3 discipline outside the startup scan: an undecodable goal_state row
    // (corruption, or a payload from a newer schema) must not make every
    // reader die. Callers that can treat it as "no goal" use this lenient
    // decode and LOG the skip; loadState stays strict for user-facing reads.
    const decodePayload = (payload: string) => {
      try {
        return { ok: true as const, state: Schema.decodeUnknownSync(GoalState.Info)(JSON.parse(payload)) }
      } catch (error) {
        return { ok: false as const, error }
      }
    }

    function loadState(sessionID: SessionID) {
      return db
        .select()
        .from(GoalStateTable)
        .where(eq(GoalStateTable.session_id, sessionID))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => {
            if (!row) return undefined
            return Schema.decodeUnknownSync(GoalState.Info)(JSON.parse(row.payload))
          }),
        )
    }

    type Transition<A> =
      | { readonly tag: "noop"; readonly value: A }
      | { readonly tag: "save"; readonly state: GoalState.Info; readonly value: A }
      | {
          readonly tag: "delete"
          readonly terminal?: GoalState.Info
          /** GOAL-FP-01-16: also delete every goal_outcome row for the session
           * in the same transaction (session deletion, not a plain clear). */
          readonly deleteOutcomes?: boolean
          readonly value: A
        }

    // The only durable Goal mutation seam. The immediate transaction makes the
    // read + decision + write/delete one serializable state transition, so a
    // stale loop result cannot overwrite a concurrent pause or resurrect a row
    // deleted by clear. Events are emitted after commit but inside the same
    // uninterruptible region; durable state always leads presentation state.
    const transition = <A>(
      sessionID: SessionID,
      decide: (state: GoalState.Info | undefined) => Transition<A>,
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          // Whether the transaction actually removed a goal row. A delete
          // decision on a session with no row is a no-op and must not publish
          // goal.cleared — that event is the presentation contract for a real
          // removal, not for a command that found nothing to remove.
          let deletedRow = false
          const result = yield* db
            .transaction(
              (tx) =>
                Effect.gen(function* () {
                  const row = yield* tx
                    .select()
                    .from(GoalStateTable)
                    .where(eq(GoalStateTable.session_id, sessionID))
                    .get()
                  const decoded = row ? decodePayload(row.payload) : undefined
                  // An undecodable row reads as "no goal" so clear/purge can
                  // still remove it; any other mutation of it fails as before
                  // rather than overwriting data this build cannot read.
                  const next = decide(decoded?.ok ? decoded.state : undefined)
                  if (decoded && !decoded.ok) {
                    if (next.tag !== "delete") throw decoded.error
                    yield* Effect.logWarning(`goal transition deleting undecodable goal_state row for ${sessionID}`, {
                      error: String(decoded.error),
                    })
                  }
                  if (next.tag === "save") {
                    const payload = JSON.stringify(Schema.encodeSync(GoalState.Info)(next.state))
                    if (row) {
                      yield* tx
                        .update(GoalStateTable)
                        .set({ payload, updated_at: Math.max(Date.now(), row.updated_at + 1) })
                        .where(eq(GoalStateTable.session_id, sessionID))
                        .run()
                    } else {
                      yield* tx
                        .insert(GoalStateTable)
                        .values({ session_id: sessionID, payload, updated_at: Date.now() })
                        .run()
                    }
                  }
                  if (next.tag === "delete" && row) {
                    deletedRow = true
                    if (next.terminal) {
                      const payload = JSON.stringify(Schema.encodeSync(GoalState.Info)(next.terminal))
                      const goalID =
                        next.terminal.goal_id && next.terminal.goal_id !== "legacy"
                          ? next.terminal.goal_id
                          : `${sessionID}:legacy:${next.terminal.created_at}`
                      yield* tx
                        .insert(GoalOutcomeTable)
                        .values({
                          goal_id: goalID,
                          session_id: sessionID,
                          payload,
                          completed_at: Date.now(),
                        })
                        .onConflictDoUpdate({
                          target: GoalOutcomeTable.goal_id,
                          set: { payload, completed_at: Date.now() },
                        })
                        .run()
                    }
                    yield* tx
                      .delete(GoalStateTable)
                      .where(eq(GoalStateTable.session_id, sessionID))
                      .run()
                  }
                  if (next.tag === "delete" && next.deleteOutcomes) {
                    yield* tx
                      .delete(GoalOutcomeTable)
                      .where(eq(GoalOutcomeTable.session_id, sessionID))
                      .run()
                  }
                  return next
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie)
          if (result.tag === "save") yield* publishGoal(sessionID, result.state)
          if (result.tag === "delete" && deletedRow) {
            if (result.terminal) yield* publishGoal(sessionID, result.terminal)
            yield* events.publish(GoalEvent.Cleared, { sessionID })
          }
          return result.value
        }),
      )

    const matchesExpected = (
      state: GoalState.Info,
      expected: { readonly goalID: string; readonly revision: number },
    ) => (state.goal_id ?? "legacy") === expected.goalID && (state.revision ?? 0) === expected.revision

    const deleteAndPublishDone = Effect.fnUntraced(function* (sessionID: SessionID, reason: string) {
      return yield* transition<GoalState.Info | undefined>(sessionID, (state) => {
        if (!state) return { tag: "noop", value: undefined }
        const doneState = GoalState.advance(state, {
          status: "done",
          last_verdict: "done",
          last_reason: reason,
        })
        return { tag: "delete", terminal: doneState, value: state }
      })
    })

    const load = Effect.fn("Goal.load")(function* (sessionID: SessionID) {
      return yield* loadState(sessionID)
    })

    // GOAL-FP-01-04: startup-resume scan accessor. GoalLoop is event-driven;
    // after a restart nothing emits idle for sessions whose goal was active
    // when the process died, so GoalLoop.init queries this durable set and
    // re-triggers its existing idle evaluation path. Only "active" rows are
    // returned — paused rows are user-visible and terminal rows are deleted
    // by transition.
    //
    // D-1: scoped to the instance's own directory. goal_state has no
    // directory column; the session table is the directory authority, so the
    // query joins goal_state.session_id → session.id and filters on
    // session.directory — the scan can never evaluate, commit, pause, or
    // drive another instance's sessions. Goal rows whose session row is
    // missing are dropped by the inner join (invisible to the scan, same as
    // other instances' rows).
    //
    // D-3: a row whose payload cannot be decoded is skipped defensively (the
    // scan is best-effort; the session's own idle event or /goal resume
    // remains available) but the skip is LOGGED with the session id and the
    // decode error — a silently-dormant goal is not diagnosable.
    const listActiveSessions = Effect.fn("Goal.listActiveSessions")(function* (directory: string) {
      const rows = yield* db
        .select({ session_id: GoalStateTable.session_id, payload: GoalStateTable.payload })
        .from(GoalStateTable)
        .innerJoin(SessionTable, sql`${GoalStateTable.session_id} = ${SessionTable.id}`)
        .where(eq(SessionTable.directory, directory))
        .all()
      const active: SessionID[] = []
      for (const row of rows) {
        let state: GoalState.Info
        try {
          state = Schema.decodeUnknownSync(GoalState.Info)(JSON.parse(row.payload))
        } catch (error) {
          yield* Effect.logWarning(
            `goal startup scan skipped undecodable goal_state row for ${row.session_id}`,
            { error: String(error) },
          )
          continue
        }
        if (state.status === "active") active.push(SessionID.make(row.session_id))
      }
      return active
    })

    const lastOutcome = Effect.fn("Goal.lastOutcome")(function* (sessionID: SessionID) {
      const row = yield* db
        .select()
        .from(GoalOutcomeTable)
        .where(eq(GoalOutcomeTable.session_id, sessionID))
        .orderBy(desc(GoalOutcomeTable.completed_at))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return Schema.decodeUnknownSync(GoalState.Info)(JSON.parse(row.payload))
    })

    const initialState = (goal: string, maxTurns?: number) => {
      const now = Date.now()
      return new GoalState.Info({
        goal_id: Bun.randomUUIDv7(),
        revision: GoalState.nni(0),
        goal,
        status: "active",
        turns_used: GoalState.nni(0),
        max_turns: GoalState.nni(maxTurns ?? GoalPrompts.DEFAULT_MAX_TURNS),
        created_at: now,
        last_turn_at: now,
        consecutive_parse_failures: GoalState.nni(0),
        subgoals: [],
      })
    }

    const set = Effect.fn("Goal.set")(function* (sessionID: SessionID, goal: string, maxTurns?: number) {
      const state = initialState(goal, maxTurns)
      // GOAL-FP-01-08: the overwrite must stay consistent with the lease. The
      // previous id is captured from the SAME seam read that decides the
      // overwrite, and unregistered before the new id is registered — a stale
      // id left in the registration set would be returned by owner() and
      // reject the new goal's claim (loop silently starved until /goal clear).
      const result = yield* transition(sessionID, (previous) => ({
        tag: "save",
        state,
        value: { state, previousGoalID: previous?.goal_id ?? "legacy" },
      }))
      if (result.previousGoalID !== (result.state.goal_id ?? "legacy")) {
        yield* automation.unregister(sessionID, { kind: "goal", id: result.previousGoalID })
      }
      yield* automation.register(sessionID, { kind: "goal", id: result.state.goal_id ?? "legacy" })
      return result.state
    })

    const pause = Effect.fn("Goal.pause")(function* (sessionID: SessionID, reason: string) {
      const updated = yield* transition(sessionID, (state) => {
        if (!state || state.status !== "active") return { tag: "noop", value: undefined }
        const next = GoalState.advance(state, {
          status: "paused",
          paused_reason: reason,
          last_turn_at: Date.now(),
        })
        return { tag: "save", state: next, value: next }
      })
      if (!updated) return undefined
      yield* automation.unregister(sessionID, { kind: "goal", id: updated.goal_id ?? "legacy" })
      yield* clearFiber(sessionID)
      turnDriven.delete(sessionID)
      return updated
    })

    // Loop-fiber-safe pause: same DB + event effects as pause(), but skips
    // clearFiber so it can be called from inside the loop fiber itself
    // (loop.ts shouldPreempt branch). The fiber naturally terminates when
    // afterIdle returns; no explicit interrupt needed.
    //
    // Wrapped in Effect.uninterruptible (F1): the save → publish sequence
    // is atomic, so an interrupt landing between persisting the paused row
    // and publishing goal.updated(paused) can never leave a paused DB row
    // with no corresponding event on the bus.
    const pauseAndPublish = Effect.fnUntraced(function* (
      sessionID: SessionID,
      reason: string,
      expected?: { readonly goalID: string; readonly revision: number },
    ) {
      return yield* transition(sessionID, (state) => {
        if (!state || state.status !== "active" || (expected && !matchesExpected(state, expected)))
          return { tag: "noop", value: undefined }
        const updated = GoalState.advance(state, {
          status: "paused",
          paused_reason: reason,
          last_turn_at: Date.now(),
        })
        return { tag: "save", state: updated, value: updated }
      })
    })

    // #892: one automatic recovery chain is bounded by durable counters. A
    // user resume explicitly starts a new chain, so its budgets reset with the
    // paused state; retries/resets themselves never do.
    const claimRecovery = Effect.fn("Goal.claimRecovery")(function* (
      sessionID: SessionID,
      expected: { readonly goalID: string; readonly revision: number },
      kind: "retry" | "reset",
      boundary: string,
    ) {
      type Claim =
        | { readonly tag: "allowed"; readonly state: GoalState.Info }
        | { readonly tag: "exhausted"; readonly state: GoalState.Info }
        | { readonly tag: "stale" }
      return yield* transition<Claim>(sessionID, (state) => {
        if (!state || state.status !== "active" || !matchesExpected(state, expected))
          return { tag: "noop", value: { tag: "stale" as const } }
        const recovery = state.recovery ?? {
          attempts: GoalState.nni(0),
          reset: false,
          boundary,
        }
        if (kind === "retry" && recovery.attempts >= 2)
          return { tag: "noop", value: { tag: "exhausted" as const, state } }
        if (kind === "reset" && recovery.reset)
          return { tag: "noop", value: { tag: "exhausted" as const, state } }
        const next = GoalState.advance(state, {
          recovery: {
            attempts: kind === "retry" ? GoalState.nni(recovery.attempts + 1) : recovery.attempts,
            reset: kind === "reset" ? true : recovery.reset,
            boundary,
          },
        })
        return { tag: "save", state: next, value: { tag: "allowed" as const, state: next } }
      })
    })

    const resume = Effect.fn("Goal.resume")(function* (sessionID: SessionID, maxTurns?: number) {
      const updated = yield* transition(sessionID, (state) => {
        if (!state || state.status !== "paused") return { tag: "noop", value: undefined }
        if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns <= state.turns_used))
          return { tag: "noop", value: undefined }
        const updated = GoalState.advance(state, {
          status: "active",
          max_turns: GoalState.nni(maxTurns ?? state.max_turns),
          consecutive_parse_failures: GoalState.nni(0),
          recovery: undefined,
          paused_reason: undefined,
          last_turn_at: Date.now(),
        })
        return { tag: "save", state: updated, value: updated }
      })
      if (updated)
        yield* automation.register(sessionID, { kind: "goal", id: updated.goal_id ?? "legacy" })
      return updated
    })

    const controlDuringTurn = Effect.fn("Goal.controlDuringTurn")(function* (
      sessionID: SessionID,
      input: TurnControl,
    ) {
      if (input.action !== "pause") {
        const session = yield* db
          .select({ parentID: SessionTable.parent_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (session?.parentID) {
          return {
            changed: false as const,
            reason: "Only the main conversation can create or resume autonomous goals. Return progress to the parent task.",
          }
        }
      }
      const reject = (reason: string): Transition<TurnControlResult> => ({
        tag: "noop",
        value: { changed: false, reason },
      })
      // Finish lease and provenance updates even if cancellation follows the commit.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const result = yield* transition<TurnControlResult>(sessionID, (current) => {
            if (
              input.action !== "pause" &&
              input.maxTurns !== undefined &&
              (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1)
            )
              return reject("max_turns must be a positive safe integer.")

            let next: GoalState.Info
            if (input.action === "create") {
              if (!input.text.trim()) return reject("text is required to create a goal.")
              if (current)
                return reject("A goal already exists. Resume it or let the user clear it before creating another.")
              next = initialState(input.text.trim(), input.maxTurns)
            } else if (input.action === "resume") {
              if (!current || current.status !== "paused") return reject("No paused goal to resume.")
              const maxTurns = input.maxTurns ?? current.max_turns
              if (maxTurns <= current.turns_used)
                return reject(
                  `Goal budget exhausted. An explicitly authorized max_turns greater than ${current.turns_used} is required.`,
                )
              next = GoalState.advance(current, {
                status: "active",
                max_turns: GoalState.nni(maxTurns),
                consecutive_parse_failures: GoalState.nni(0),
                recovery: undefined,
                paused_reason: undefined,
                last_turn_at: Date.now(),
              })
            } else {
              if (!input.reason.trim()) return reject("reason is required to pause a goal.")
              if (!current || current.status !== "active") return reject("No active goal to pause.")
              next = GoalState.advance(current, {
                status: "paused",
                paused_reason: input.reason.trim(),
                last_turn_at: Date.now(),
              })
            }
            return { tag: "save", state: next, value: { changed: true, state: next } }
          })
          if (!result.changed) return result
          const owner = { kind: "goal" as const, id: result.state.goal_id ?? "legacy" }
          if (result.state.status === "paused") {
            yield* automation.unregister(sessionID, owner)
            turnDriven.delete(sessionID)
            // The loop may be waiting for this tool's turn. Let it return
            // normally; the paused row prevents further continuation.
          } else {
            yield* automation.register(sessionID, owner)
            turnDriven.add(sessionID)
          }
          return result
        }),
      )
    })

    const clear = Effect.fn("Goal.clear")(function* (sessionID: SessionID) {
      const cleared = yield* transition(sessionID, (state) => ({ tag: "delete", value: state }))
      if (cleared)
        yield* automation.unregister(sessionID, { kind: "goal", id: cleared.goal_id ?? "legacy" })
      yield* clearFiber(sessionID)
      turnDriven.delete(sessionID)
      return cleared
    })

    // GOAL-FP-01-05/-16: session-deletion cleanup. `clear` keeps the
    // goal_outcome history (lastOutcome readers), but a deleted session has no
    // readers — its outcome rows are garbage and must go in the SAME durable
    // transition as the goal_state row so the pair cannot be split by a crash.
    const purgeSession = Effect.fn("Goal.purgeSession")(function* (sessionID: SessionID) {
      const cleared = yield* transition(sessionID, (state) => ({
        tag: "delete",
        deleteOutcomes: true,
        value: state,
      }))
      if (cleared)
        yield* automation.unregister(sessionID, { kind: "goal", id: cleared.goal_id ?? "legacy" })
      yield* clearFiber(sessionID)
      turnDriven.delete(sessionID)
    })

    const markDone = Effect.fn("Goal.markDone")(function* (sessionID: SessionID, reason: string) {
      // User/tool-initiated completion: stop the running loop fiber, then
      // perform terminal cleanup (publish done-updated → delete → publish cleared).
      // State transitions are budget-neutral — turns_used counts continuation
      // dispatches only (see spec: turn-budget-counts-continuation-dispatches-only),
      // so markDone does NOT increment. deleteAndPublishDone loads the current
      // row (preserving whatever turns_used a prior continue dispatch set) and
      // re-renders the done snapshot from it.
      yield* clearFiber(sessionID)
      const completed = yield* deleteAndPublishDone(sessionID, reason)
      if (completed)
        yield* automation.unregister(sessionID, { kind: "goal", id: completed.goal_id ?? "legacy" })
      turnDriven.delete(sessionID)
      return completed
    })

    const addSubgoal = Effect.fn("Goal.addSubgoal")(function* (sessionID: SessionID, subgoal: string) {
      return yield* transition(sessionID, (state) => {
        if (!state) return { tag: "noop", value: undefined }
        const updated = GoalState.advance(state, {
          subgoals: [...(state.subgoals ?? []), subgoal],
          last_turn_at: Date.now(),
        })
        return { tag: "save", state: updated, value: updated }
      })
    })

    const removeSubgoal = Effect.fn("Goal.removeSubgoal")(function* (sessionID: SessionID, index: number) {
      return yield* transition<RemoveSubgoalResult>(sessionID, (state) => {
        if (!state) return { tag: "noop", value: { tag: "noState" as const } }
        const subgoals = state.subgoals ?? []
        const idx = index - 1
        if (idx < 0 || idx >= subgoals.length)
          return { tag: "noop", value: { tag: "outOfBounds" as const, size: subgoals.length } }
        const removed = subgoals[idx]
        const updated = GoalState.advance(state, {
          subgoals: subgoals.filter((_, i) => i !== idx),
          last_turn_at: Date.now(),
        })
        return { tag: "save", state: updated, value: { tag: "ok" as const, removed, state: updated } }
      })
    })

    const clearSubgoals = Effect.fn("Goal.clearSubgoals")(function* (sessionID: SessionID) {
      return yield* transition(sessionID, (state) => {
        if (!state) return { tag: "noop", value: undefined }
        const updated = GoalState.advance(state, {
          subgoals: [],
          last_turn_at: Date.now(),
        })
        return { tag: "save", state: updated, value: updated }
      })
    })

    const statusLine = Effect.fn("Goal.statusLine")(function* (sessionID: SessionID) {
      const state = yield* loadState(sessionID)
      if (!state) return undefined
      const subgoals = state.subgoals ?? []
      const sub = subgoals.length > 0 ? `，${subgoals.length} 个子目标` : ""
      if (state.status === "active") {
        // GOAL-TURN-SCOPE observability: a goal-driven turn in flight reads as
        // "执行中" so a long first turn (turns_used still 0/N) does not look
        // like a dead 0/N counter.
        if (turnDriven.has(sessionID)) {
          const busy = yield* sessionStatus.get(sessionID)
          if (busy.type === "busy")
            return `⊙ 目标（执行中，${state.turns_used}/${state.max_turns} 轮${sub}）：${state.goal}`
        }
        return `⊙ 目标（进行中，${state.turns_used}/${state.max_turns} 轮${sub}）：${state.goal}`
      }
      if (state.status === "paused") {
        const reason = state.paused_reason ? ` — ${state.paused_reason}` : ""
        return `⏸ 目标（已暂停，${state.turns_used}/${state.max_turns} 轮${reason}）：${state.goal}`
      }
      if (state.status === "done")
        return `✓ 目标已完成（${state.turns_used}/${state.max_turns} 轮）：${state.goal}`
      return undefined
    })

    const updateAfterJudge = Effect.fn("Goal.updateAfterJudge")(function* (
      sessionID: SessionID,
      verdict: GoalState.Verdict,
      reason: string,
      parseFailed: boolean,
      expected: { readonly goalID: string; readonly revision: number },
      judged?: string,
    ) {
      return yield* transition(sessionID, (state) => {
        if (!state || state.status !== "active" || !matchesExpected(state, expected))
          return { tag: "noop", value: undefined }

        const now = Date.now()
        const newParseFailures = parseFailed ? state.consecutive_parse_failures + 1 : 0
        if (verdict === "done") {
          const updated = GoalState.advance(state, {
            status: "done",
            last_turn_at: now,
            last_verdict: "done",
            last_reason: reason,
            consecutive_parse_failures: GoalState.nni(newParseFailures),
          })
          return {
            tag: "delete",
            terminal: updated,
            value: {
              state: updated,
              shouldContinue: false,
              message: `✓ 目标已达成：${reason}`,
            },
          }
        }

        if (verdict === "blocked") {
          const updated = GoalState.advance(state, {
            status: "paused",
            last_turn_at: now,
            last_verdict: "blocked",
            last_reason: reason,
            paused_reason: reason,
            consecutive_parse_failures: GoalState.nni(newParseFailures),
          })
          return {
            tag: "save",
            state: updated,
            value: {
              state: updated,
              shouldContinue: false,
              message: `⏸ 目标已阻塞 — ${reason}`,
            },
          }
        }

        // GOAL-03: a judge that never produced a verdict (transport error or
        // unparseable output) evaluated no turn — budget-neutral: it must not
        // consume one of the user's max_turns, and it must not stamp
        // last_judged_msg (the boundary was never judged; a crash after this
        // commit must re-judge the same boundary, and that re-judgment — not
        // this failed attempt — may consume the budget slot). Pre-fix a flaky
        // judge burned budget on unevaluated turns while intermittent
        // successes kept the parse-failure counter resetting. The counter
        // itself still climbs here, so MAX_CONSECUTIVE_PARSE_FAILURES
        // auto-pause is unaffected.
        const turnsUsed = parseFailed ? state.turns_used : GoalState.nni(state.turns_used + 1)
        const pauseReason =
          newParseFailures >= GoalPrompts.MAX_CONSECUTIVE_PARSE_FAILURES
            ? `judge 模型连续 ${newParseFailures} 次未返回有效判定；最近失败：${reason}。请检查模型配置或换用更可靠的模型，然后 /goal resume。`
            : turnsUsed >= state.max_turns
              ? `已用 ${turnsUsed}/${state.max_turns} 轮预算。/goal clear 停止；/goal resume 会重启一整轮执行（本轮内完成才会计为达成，否则仍会被再次暂停）。`
              : undefined
        const updated = GoalState.advance(state, {
          status: pauseReason ? "paused" : "active",
          turns_used: turnsUsed,
          last_turn_at: now,
          last_verdict: "continue",
          last_reason: reason,
          paused_reason: pauseReason,
          consecutive_parse_failures: GoalState.nni(newParseFailures),
          // #892: a committed non-summary work turn ends the automatic
          // recovery chain; summaries never reach this transition.
          recovery: undefined,
          // issue #285: record the judged boundary for the durable scan gate.
          // GOAL-03: only a judge that actually returned a verdict judged the
          // boundary (see turnsUsed above).
          ...(judged !== undefined && !parseFailed ? { last_judged_msg: judged } : {}),
        })
        return {
          tag: "save",
          state: updated,
          value: {
            state: updated,
            shouldContinue: !pauseReason,
            message: pauseReason
              ? `⏸ 目标已暂停 — ${pauseReason}`
              : `↻ 继续推进目标（${updated.turns_used}/${updated.max_turns}）：${reason}`,
          },
        }
      })
    })

    const dispatch = Effect.fn("Goal.dispatch")(function* (sessionID: SessionID, args: string) {
      const trimmed = args.trim()
      const budget = /^(?:(resume)\s+)?--max-turns(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i.exec(trimmed)
      const maxTurns = budget ? Number(budget[2]) : undefined
      const invalidBudget =
        budget &&
        (!/^\d+$/.test(budget[2] ?? "") ||
          !Number.isSafeInteger(maxTurns) ||
          (maxTurns ?? 0) < 1 ||
          (budget[1] ? !!budget[3] : !budget[3]?.trim()))
      if (invalidBudget || (!budget && /^(?:resume\s+)?--/i.test(trimmed))) {
        return {
          type: "message" as const,
          text: "轮预算必须是正整数。用法：/goal --max-turns <N> <目标> 或 /goal resume --max-turns <N>。",
        }
      }
      const text = budget && !budget[1] ? (budget[3] ?? "").trim() : trimmed
      const lower = budget ? (budget[1] ? "resume" : undefined) : trimmed.toLowerCase()

      const isControlCommand =
        lower === "" ||
        lower === "status" ||
        lower === "pause" ||
        lower === "resume" ||
        lower === "clear" ||
        lower === "stop" ||
        lower === "done"
      if (!isControlCommand) {
        const status = yield* sessionStatus.get(sessionID)
        if (status.type === "busy") {
          return {
            type: "message" as const,
            text: "Session 正在执行中。请先 /stop 中断后再设定新目标。",
          }
        }
        // Known TOCTOU: `get` above then goal.set + continuation dispatch below
        // is not atomic — the session could flip to busy in between. Accepted:
        // the loop's idle gating and judge-preempt guard handle that case
        // gracefully; an atomic check-and-set would need a session-level lock
        // outside this module's scope.
      }

      if (lower === "" || lower === "status") {
        const line = yield* statusLine(sessionID)
        return { type: "message" as const, text: line ?? "没有活跃的目标。使用 /goal <text> 设定一个目标。" }
      }

      if (lower === "pause") {
        const result = yield* pause(sessionID, "user-paused")
        return {
          type: "message" as const,
          text: result
            ? `⏸ 目标已暂停。/goal resume 继续。`
            : "没有活跃的目标可以暂停。",
        }
      }

      if (lower === "resume") {
        // Busy guard, symmetric with the set-new-goal guard above. `resume` is a
        // control command so it bypasses the generic busy check; without this,
        // resuming a goal on a busy session would return `kick`, prompting
        // prompt.ts to start a second agent loop concurrently with the running
        // one. Keep the goal paused and ask the user to /stop first instead.
        const resumeStatus = yield* sessionStatus.get(sessionID)
        if (resumeStatus.type === "busy") {
          return {
            type: "message" as const,
            text: "Session 正在执行中。请先 /stop 中断后再 /goal resume。",
          }
        }
        if (maxTurns !== undefined) {
          const current = yield* loadState(sessionID)
          if (current?.status === "paused" && maxTurns <= current.turns_used)
            return { type: "message" as const, text: `总轮预算必须大于已用的 ${current.turns_used} 轮。` }
        }
        const result = yield* resume(sessionID, maxTurns)
        if (!result) return { type: "message" as const, text: "没有已暂停的目标可以恢复。" }
        // Warning UX for budget-exhaustion pauses: we kept turns_used intact
        // (see resume()), so a goal paused because turns >= max will resume
        // only to get immediately re-paused by the next judge iteration.
        // Without a warning the user sees "已恢复" then the same pause
        // text a second later, which looks like resume didn't work.
        const announceMsg =
          result.turns_used >= result.max_turns
            ? `⚠ 目标已恢复，但轮预算已耗尽（${result.turns_used}/${result.max_turns} 轮）。resume 会重启一整轮执行：本轮内任务完成才会计为达成，否则 judge 会再次暂停。再次暂停后可用 /goal resume --max-turns ${result.turns_used + GoalPrompts.DEFAULT_MAX_TURNS} 增加总轮预算。`
            : undefined
        return {
          type: "kick" as const,
          text: result.goal,
          announce: announceMsg,
        }
      }

      if (lower === "done") {
        // /goal done is explicit "I finished this" — distinct from
        // /goal clear (/stop), which just tears it down without marking
        // completion. Both remove the row because done is transient.
        const completed = yield* markDone(sessionID, "/goal done")
        return {
          type: "message" as const,
          text: completed ? "✓ 目标已标记为完成并清除。" : "没有活跃的目标可以完成。",
        }
      }

      if (lower === "clear" || lower === "stop") {
        const cleared = yield* clear(sessionID)
        return {
          type: "message" as const,
          text: cleared ? "目标已清除。" : "没有活跃的目标可以清除。",
        }
      }

      const existing = yield* loadState(sessionID)
      if (existing) {
        if (existing.status === "active") {
          return {
            type: "message" as const,
            text: "已有活跃目标。请先 /goal clear 再设定新目标。",
          }
        }
        if (existing.status === "paused") {
          return {
            type: "message" as const,
            text: `有暂停的目标（${existing.turns_used}/${existing.max_turns} 轮）。使用 /goal resume 继续，/goal clear 后再设定新目标。`,
          }
        }
        // done row leftover (loop.ts usually auto-clears; defensive guard)
        yield* clear(sessionID)
      }
      const state = yield* set(sessionID, text, maxTurns ?? GoalPrompts.DEFAULT_MAX_TURNS)
      return {
        type: "kick" as const,
        text: state.goal,
        announce: `⊙ 目标已设定（${state.max_turns} 轮预算）：${state.goal}`,
      }
    })

    const dispatchSubgoal = Effect.fn("Goal.dispatchSubgoal")(function* (sessionID: SessionID, args: string) {
      const trimmed = args.trim()
      const lower = trimmed.toLowerCase()

      if (lower === "" || lower === "list") {
        const state = yield* loadState(sessionID)
        const subgoals = state?.subgoals ?? []
        if (!state || subgoals.length === 0)
          return { type: "message" as const, text: "没有子目标。使用 /subgoal add <text> 添加。" }
        const lines = subgoals.map((s, i) => `${i + 1}. ${s}`)
        return { type: "message" as const, text: `子目标：\n${lines.join("\n")}` }
      }

      if (lower === "clear") {
        const result = yield* clearSubgoals(sessionID)
        return {
          type: "message" as const,
          text: result ? "子目标已清除。" : "没有活跃的目标。",
        }
      }

      if (lower.startsWith("remove ") || lower.startsWith("rm ")) {
        const indexStr = trimmed.replace(/^(?:remove|rm)\s+/i, "")
        const index = parseInt(indexStr, 10)
        if (isNaN(index) || index < 1) return { type: "message" as const, text: "用法：/subgoal remove <编号>" }
        const result = yield* removeSubgoal(sessionID, index)
        if (result.tag === "noState") return { type: "message" as const, text: "没有活跃的目标。" }
        if (result.tag === "outOfBounds") {
          return {
            type: "message" as const,
            text:
              result.size === 0
                ? "当前没有子目标。"
                : `索引越界：当前只有 ${result.size} 个子目标，#1 至 #${result.size}。`,
          }
        }
        return { type: "message" as const, text: `子目标 #${index} 已移除：${result.removed}` }
      }

      if (lower.startsWith("add ")) {
        const subgoal = trimmed.slice(4).trim()
        if (!subgoal) return { type: "message" as const, text: "用法：/subgoal add <text>" }
        const result = yield* addSubgoal(sessionID, subgoal)
        return {
          type: "message" as const,
          text: result ? `子目标已添加：${subgoal}` : "没有活跃的目标。先使用 /goal <text> 设定一个目标。",
        }
      }

      const result = yield* addSubgoal(sessionID, trimmed)
      return {
        type: "message" as const,
        text: result ? `子目标已添加：${trimmed}` : "没有活跃的目标。先使用 /goal <text> 设定一个目标。",
      }
    })

    // The lease and Goal use this same shared durable store. Install once for
    // this Goal layer's scope; its finalizer removes the resolver and stale
    // registrations if the lease's DAG consumers outlive the Goal service.
    // The resolver only reads DB state, never takes another lease lock, so
    // updateAfterJudge remains safe inside automation.use's existing lock.
    // An undecodable row is not an active goal: the lease runs this on every
    // claim/use/register, so a decode throw would kill DAG automation for the
    // session too. Database read failures still die (fail closed).
    yield* automation.installGoalAuthority((sessionID) =>
      db
        .select({ payload: GoalStateTable.payload })
        .from(GoalStateTable)
        .where(eq(GoalStateTable.session_id, sessionID))
        .get()
        .pipe(
          Effect.orDie,
          Effect.flatMap((row) => {
            if (!row) return Effect.succeed(undefined)
            const decoded = decodePayload(row.payload)
            if (decoded.ok)
              return Effect.succeed(decoded.state.status === "active" ? (decoded.state.goal_id ?? "legacy") : undefined)
            return Effect.logWarning(`goal authority treats undecodable goal_state row for ${sessionID} as inactive`, {
              error: String(decoded.error),
            }).pipe(Effect.as(undefined))
          }),
        ),
    )

    return Service.of({
      controlDuringTurn,
      load,
      listActiveSessions,
      lastOutcome,
      set,
      pause,
      resume,
      clear,
      purgeSession,
      markDone,
      addSubgoal,
      removeSubgoal,
      clearSubgoals,
      statusLine,
      dispatch,
      dispatchSubgoal,
      updateAfterJudge,
      registerLoopFiber: registerFiber,
      clearLoopFiber: clearFiber,
      clearLoopFiberIf: clearFiberIf,
      deleteAndPublishDone,
      pauseAndPublish,
      claimRecovery,
      markTurnDriven,
      clearTurnDriven,
      isTurnDriven,
      pauseForUserCancel,
    })
  }),
)

export const layer = serviceLayer.pipe(Layer.provide(SessionAutomationLease.defaultLayer))

export const defaultLayer = layer.pipe(
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

export const node = LayerNode.make(layer, [
  EventV2Bridge.node,
  Database.node,
  SessionStatus.node,
])
