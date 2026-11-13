// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "@graphagent/core/database/database"
import type { SessionAdmission } from "@graphagent/core/session/admission"
import { SessionTurnTable } from "@graphagent/core/session/turn.sql"
import { SessionV1 } from "@graphagent/core/v1/session"
import { and, desc, eq } from "drizzle-orm"
import { Cause, Deferred, Effect, Exit, Option, type Scope } from "effect"
import { randomUUID } from "node:crypto"
import type { Goal } from "@/goal/goal"
import type { RewakeToken, SettingsHook } from "@/hook"
import { SessionAbortReason } from "./abort-reason"
import { SessionCancellation } from "./cancellation"
import { EngineProcess } from "./engine-process"
import type { PromptLockWitness, Request, RunRequestWitness } from "./locks"
import { MessageV2 } from "./message-v2"
import type { PromptError, PromptInput } from "./prompt"
import type { SessionRunState } from "./run-state"
import type { MessageID, SessionID } from "./schema"
import type { Session } from "./session"
import type { TurnOutcome } from "./turn/decide"

export type { TurnOutcome }

/**
 * Session turns (Issue #1019, PR8).
 *
 * A turn is one invocation of the session loop machine. Its durable row in
 * `session_turn` is written exactly twice: an INSERT when the runner actually
 * starts the work, and an `ended` UPDATE from the work's exit finalizer. The
 * finalizer also runs when the turn is interrupted, when admission refuses it
 * before the machine starts (for example a stale Stop-hook rewake), or when the
 * work fails. Requests that only queue input behind a running turn are
 * `joined` and own no second row; idle admission that finds the session busy is
 * `skipped_busy`.
 */

export type TurnOrigin =
  | { readonly kind: "user"; readonly via: "prompt" | "command" | "shell" | "resume" }
  | { readonly kind: "inbox"; readonly source: string; readonly key: string }
  /** Equivalent to today's `internalDelegation`; H3 owns the durable ChildRunID. */
  | { readonly kind: "child_run"; readonly childRunID?: string }
  /** Hook re-entries. The draft union omitted them; Issue #1019 maps tokens here. */
  | { readonly kind: "hook"; readonly via: "rewake" | "followup" }

export type TurnStatus = "running" | "ended"

export interface AdmissionOptions {
  /** Internal follow-ups retain the current input's tool budget. */
  readonly continueToolBudget?: boolean
  /** A previously persisted followup is already past initial-hook admission. */
  readonly skipHookStart?: boolean
  /**
   * Task and DAG runtimes feeding their own child session (initial prompt, Stop continuation, nudge, recovery).
   * Such input is not a user submission, so UserPromptSubmit does not run. Never part of a public body: only
   * runtime callers set it, and a persisted hook followup carries it in `HookPendingInput.internalDelegation`.
   * A report back to a parent session, a DAG wake, a goal continuation and agent messages are not delegation.
   */
  readonly internalDelegation?: true
  /**
   * SettingsHook rewake token riding on an async Stop-hook rewake. When set,
   * admission re-validates the chain before commit and the run path
   * re-validates before runLoop, refusing callbacks whose chain was reset
   * (cancel, newer prompt, SessionEnd) after their completion check. Only the
   * hook rewake paths set this; plain user prompts never do.
   */
  readonly rewakeToken?: RewakeToken
}

/** Admission-guarded commit: fails with Blocked when the session was cancelled first. */
export type AdmissionCommit = <B, E, R>(
  body: Effect.Effect<B, E, R>,
) => Effect.Effect<B, E | SessionAdmission.Blocked, R>

/** Result of admitting one prompt: the persisted message and whether a turn should run. */
export interface Admission {
  readonly message: SessionV1.WithParts
  readonly run: boolean
}

/** Two-phase idle admission reserved by `prepare`, activated by its owner. */
export interface IdleAdmission {
  /** Defined only when this admission will run the loop machine. */
  readonly turn: TurnHandle | undefined
  readonly run: boolean
  /** The user message this admission committed; carries the identity `submit` reports. */
  readonly message?: SessionV1.WithParts
  readonly activate: Effect.Effect<void>
  readonly result: Effect.Effect<SessionV1.WithParts>
  readonly abort: Effect.Effect<void>
}

/** Model selection captured before a command's persistent write, used to detect a later switch. */
export interface ModelSelection {
  readonly providerID: string | undefined
  readonly modelID: string | undefined
  readonly variant: string | undefined
}

export type ModelBaseline = ModelSelection & { readonly epoch: number | undefined }

/** One running turn. `result` settles even when the turn fails or is interrupted. */
export interface TurnHandle {
  readonly id: string
  readonly sessionID: SessionID
  readonly origin: TurnOrigin
  readonly result: Effect.Effect<TurnOutcome>
  readonly status: Effect.Effect<TurnStatus>
  readonly cancel: (reason?: SessionAbortReason.Info) => Effect.Effect<void>
}

/**
 * The draft's three admission states, plus `not_started` for an admission that
 * committed its message without running a turn (`noReply`, a blocking hook, a
 * stale rewake refused before the machine). Those are not "busy" and must not
 * be reported as such.
 *
 * `started` means this request owns the loop machine that will write the turn
 * row. That includes a request queued behind a running shell command: the
 * runner starts the queued work after the shell ends, and its `track` inserts
 * the row.
 *
 * `joined` means the request attached to work this call will never run: a
 * running turn (its handle is the one named by `turn`) or another request's
 * queued run. Its own handle is discarded before `track`, so neither a row nor
 * a settlement is written for it.
 */
export type TurnAdmission =
  | { readonly kind: "started"; readonly turn: TurnHandle }
  | { readonly kind: "joined"; readonly turn: TurnHandle; readonly messageID: MessageID }
  | { readonly kind: "skipped_busy"; readonly turn?: TurnHandle }
  | { readonly kind: "not_started"; readonly reason: string }

export interface TurnStart {
  readonly admission: TurnAdmission
  /** The user message this admission committed, when it committed one. */
  readonly message?: SessionV1.WithParts
  /** The message the caller historically received from `prompt`/`loop`. */
  readonly wait: Effect.Effect<SessionV1.WithParts>
}

export interface TurnStartOptions {
  readonly origin: TurnOrigin
  readonly when: "now" | "idle"
  readonly admissionOptions?: AdmissionOptions
  readonly commitAdmission?: AdmissionCommit
  readonly modelBaseline?: ModelBaseline
  readonly persistAdmission?: Effect.Effect<void, unknown>
  /**
   * A cancellation request the caller already registered, usually fenced by the
   * epoch it observed at its claim (`SessionCancellation.requestIfEpoch`, as
   * `admitNowUnderFence` does). `start` then runs under it instead of opening a
   * request of its own, so an ESC that lands after the caller's claim ends the
   * admission before anything is committed. The caller releases it.
   */
  readonly request?: ReturnType<typeof SessionCancellation.request>
}

/**
 * What an immediate admission carries beyond its options: the origin an inbox
 * source stamps on the turn it starts (otherwise `originFor` derives one from
 * the options), and a cancellation request the caller already holds.
 */
export type AdmissionExtras = Partial<Pick<TurnStartOptions, "origin" | "request">>

/** What the loop machine reports at its exit; `Turns` persists it. */
export interface TurnExecution {
  readonly message: SessionV1.WithParts
  readonly outcome: TurnOutcome
  readonly steps: number
  readonly userMessageID: MessageID | undefined
  readonly lastAssistantID: MessageID | undefined
}

/** A turn whose ended row was written; published after the write commits. */
export interface TurnSettled {
  readonly sessionID: SessionID
  readonly turnID: string
  readonly outcome: TurnOutcome
  readonly steps: number
  readonly timeEnded: number
}

export interface TurnDeps {
  readonly db: Database.Interface["db"]
  readonly sessions: Session.Interface
  readonly state: SessionRunState.Interface
  /** Long-lived scope that owns the admission watchers (one fiber per admission). */
  readonly scope: Scope.Scope
  readonly withRunRequest: <A, E, R>(
    sessionID: SessionID,
    use: (request: Request, witness: RunRequestWitness) => Effect.Effect<A, E, R>,
    admitted?: Request,
  ) => Effect.Effect<A, E, R>
  readonly withPromptLock: <A, E, R>(
    witness: RunRequestWitness,
    sessionID: SessionID,
    use: (witness: PromptLockWitness) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  readonly goal: Goal.Interface | undefined
  readonly settingsHook: SettingsHook.Interface | undefined
  /** Runs after the ended row is written, before the handle settles. */
  readonly onSettled: (settled: TurnSettled) => Effect.Effect<void>
  readonly admitPrompt: (
    input: PromptInput,
    persistAdmission?: Effect.Effect<void, unknown>,
    options?: AdmissionOptions,
    commitAdmission?: AdmissionCommit,
    modelBaseline?: ModelBaseline,
  ) => Effect.Effect<Admission, PromptError | SessionAdmission.Blocked>
  readonly fenceRewake: (
    sessionID: SessionID,
    options: AdmissionOptions | undefined,
    message: SessionV1.WithParts,
  ) => Effect.Effect<boolean>
  /** Raw loop-machine invocation; `Turns` owns the durable turn row around it. */
  readonly runLoop: (sessionID: SessionID) => Effect.Effect<TurnExecution>
  readonly lastAssistant: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts>
  readonly cancel: (
    sessionID: SessionID,
    options?: { readonly reason?: SessionAbortReason.Info },
  ) => Effect.Effect<void>
}

export interface Interface {
  readonly start: (
    input: PromptInput,
    options: TurnStartOptions,
  ) => Effect.Effect<TurnStart, PromptError | SessionAdmission.Blocked>
  /** Idle two-phase admission; `admitIdleUnderFence` activates it under the exclusive registry. */
  readonly prepare: (
    input: PromptInput,
    options?: AdmissionOptions,
    persistAdmission?: Effect.Effect<void, unknown>,
    request?: ReturnType<typeof SessionCancellation.request>,
  ) => Effect.Effect<Option.Option<IdleAdmission>, PromptError>
  readonly current: (sessionID: SessionID) => Effect.Effect<Option.Option<TurnHandle>>
  readonly lastOutcome: (sessionID: SessionID) => Effect.Effect<Option.Option<TurnOutcome>>
  /** Centralizes the ESC epoch bump and its rewake-generation reset. */
  readonly beginCancel: (sessionID: SessionID) => Effect.Effect<ReturnType<typeof SessionCancellation.begin>>
  /** Track one explicit loop run (resume/loop paths that bypass `start`). */
  readonly run: (
    sessionID: SessionID,
    origin: TurnOrigin,
    work: Effect.Effect<TurnExecution>,
  ) => Effect.Effect<TurnExecution>
  readonly track: <A extends TurnExecution>(handle: TurnHandle, work: Effect.Effect<A>) => Effect.Effect<A>
  /**
   * Watch one admission to completion and settle its handle if `track` never
   * ran (the runner joined or discarded the queued work). Idempotent with
   * `track`'s own settlement. Forked on the long-lived scope so the handle
   * settles even when its caller stops awaiting the admission result.
   */
  readonly watch: (handle: TurnHandle, admission: Effect.Effect<unknown>) => Effect.Effect<void>
  /** Settle a handle once; later calls are no-ops. */
  readonly settle: (handle: TurnHandle, outcome: TurnOutcome) => Effect.Effect<void>
  readonly begin: (sessionID: SessionID, origin: TurnOrigin, userMessageID?: MessageID) => TurnHandle
}

/** Map current admission options onto the turn origin vocabulary. */
export function originFor(options?: AdmissionOptions): TurnOrigin {
  if (options?.internalDelegation === true) return { kind: "child_run" }
  if (options?.rewakeToken !== undefined) return { kind: "hook", via: "rewake" }
  return { kind: "user", via: "prompt" }
}

interface InternalHandle extends TurnHandle {
  readonly outcome: Deferred.Deferred<TurnOutcome>
  readonly live: { status: TurnStatus }
  readonly userMessageID: MessageID | undefined
}

function originRef(origin: TurnOrigin): string | null {
  switch (origin.kind) {
    case "user":
      return origin.via
    case "inbox":
      return origin.key
    case "child_run":
      return origin.childRunID ?? null
    case "hook":
      return origin.via
    default:
      return null
  }
}

function blockedExecution(message: SessionV1.WithParts): TurnExecution {
  return {
    message,
    outcome: { type: "blocked", by: "hook", code: "stale_rewake" },
    steps: 0,
    userMessageID: message.info.role === "user" ? message.info.id : undefined,
    lastAssistantID: message.info.role === "user" ? undefined : message.info.id,
  }
}

function outcomeOfExit(exit: Exit.Exit<unknown>, sessionID: SessionID): TurnOutcome {
  if (Exit.isSuccess(exit)) return { type: "completed" }
  if (Cause.hasInterruptsOnly(exit.cause))
    return { type: "cancelled", reason: SessionAbortReason.peek(sessionID)?.reason }
  const defect = Cause.squash(exit.cause)
  const code =
    SessionV1.ContextOverflowError.isInstance(defect) ||
    (defect instanceof Error && defect.name === "ContextOverflowError")
      ? "context_overflow"
      : defect instanceof Error && defect.name
        ? defect.name
        : "internal"
  return { type: "error", code, retryable: false }
}

function storedOutcome(value: Record<string, unknown> | null | undefined): Option.Option<TurnOutcome> {
  if (!value || typeof value !== "object" || typeof value.type !== "string") return Option.none()
  switch (value.type) {
    case "completed":
    case "length":
    case "tool_budget_exhausted":
    case "structured_missing":
    case "content_filter":
    case "context_overflow":
    case "interrupted":
      return Option.some({ type: value.type })
    case "cancelled":
      return Option.some({
        type: "cancelled",
        reason: typeof value.reason === "string" ? value.reason : undefined,
      })
    case "error":
      return Option.some({
        type: "error",
        code: typeof value.code === "string" ? value.code : "internal",
        retryable: value.retryable === true,
      })
    case "blocked":
      return typeof value.by === "string" && typeof value.code === "string"
        ? Option.some({ type: "blocked", by: value.by, code: value.code })
        : Option.none()
    default:
      return Option.none()
  }
}

/**
 * True when the process named by a `runner_id` can still own a running row.
 * The identity is `pid:nonce` (Issue #1026): the nonce is drawn once per
 * process start, so
 *   - this process's nonce means this process, alive;
 *   - this process's pid with another nonce is an earlier life of the pid (a
 *     container restarts as pid 1) and is dead, however alive the pid looks;
 *   - another pid is probed with `kill(pid, 0)`.
 * A bare pid carries no nonce, so it can never be this process: it is an
 * earlier life when the pid is ours and a probe otherwise.
 */
export function runnerAlive(runnerID: string | null | undefined): boolean {
  if (!runnerID) return false
  const [pidText, nonce, ...extra] = runnerID.split(":")
  const pid = Number(pidText)
  if (!/^\d+$/.test(pidText) || !Number.isInteger(pid) || pid <= 0) return false
  if (extra.length > 0 || nonce === "") return false
  if (pid === EngineProcess.runner.pid) return nonce === EngineProcess.runner.nonce
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM"
  }
}

/**
 * Turn orphan recovery: any `running` row whose runner is gone is written to
 * `ended/interrupted`. Called before the instance finishes starting, so no
 * live loop can be racing it in this process. Rows owned by another live
 * process stay untouched.
 */
export function recover(database: Database.Interface): Effect.Effect<void> {
  return Effect.gen(function* () {
    const rows = yield* database.db
      .select({ id: SessionTurnTable.id, runner_id: SessionTurnTable.runner_id })
      .from(SessionTurnTable)
      .where(eq(SessionTurnTable.state, "running"))
      .all()
      .pipe(Effect.orDie)
    const endedAt = Date.now()
    yield* Effect.forEach(
      rows,
      (row) => {
        if (runnerAlive(row.runner_id)) return Effect.void
        return database.db
          .update(SessionTurnTable)
          .set({ state: "ended", outcome: { type: "interrupted" }, time_ended: endedAt })
          .where(eq(SessionTurnTable.id, row.id))
          .run()
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("session turn recovery write failed", { turnID: row.id, cause }),
            ),
          )
      },
      { concurrency: 1, discard: true },
    )
  })
}

export interface LookupDeps {
  readonly db: Database.Interface["db"]
  readonly sessions: Session.Interface
}

/**
 * The most recent ended turn that still describes live history. A row whose
 * user message is gone (revert/fork/removal) is skipped, and so is a row whose
 * user message sits inside a pending revert range.
 */
export function lastOutcomeOf(deps: LookupDeps, sessionID: SessionID): Effect.Effect<Option.Option<TurnOutcome>> {
  return Effect.gen(function* () {
    const rows = yield* deps.db
      .select()
      .from(SessionTurnTable)
      .where(and(eq(SessionTurnTable.session_id, sessionID), eq(SessionTurnTable.state, "ended")))
      .orderBy(desc(SessionTurnTable.time_started))
      .limit(32)
      .all()
      .pipe(Effect.orDie)
    if (rows.length === 0) return Option.none<TurnOutcome>()
    const session = yield* deps.sessions.get(sessionID).pipe(Effect.option)
    if (Option.isNone(session)) return Option.none<TurnOutcome>()
    const revert = session.value.revert
    const wanted = new Set<string>(rows.flatMap((row) => (row.user_message_id ? [row.user_message_id] : [])))
    if (revert) wanted.add(String(revert.messageID))
    const byID = yield* deps.sessions.getMessageInfos({ sessionID, messageIDs: [...wanted] })
    const revertInfo = revert ? byID.get(String(revert.messageID)) : undefined
    for (const row of rows) {
      const userID = row.user_message_id
      if (!userID) continue
      const user = byID.get(userID)
      if (!user) continue
      if (revert && revertInfo && !MessageV2.before(user, revertInfo)) continue
      const outcome = storedOutcome(row.outcome)
      if (Option.isSome(outcome)) return outcome
    }
    return Option.none<TurnOutcome>()
  })
}

/**
 * Delete turn rows whose anchor message the revert cleanup is about to remove
 * (or already removed). Runs before `SessionRevert.cleanup` so the same
 * message snapshot decides both deletions; the revert layer keeps no Database
 * dependency of its own.
 */
export function dropReverted(deps: LookupDeps, session: Session.Info): Effect.Effect<void> {
  const revert = session.revert
  if (!revert) return Effect.void
  return Effect.gen(function* () {
    const rows = yield* deps.db
      .select({
        id: SessionTurnTable.id,
        user_message_id: SessionTurnTable.user_message_id,
        last_assistant_id: SessionTurnTable.last_assistant_id,
      })
      .from(SessionTurnTable)
      .where(eq(SessionTurnTable.session_id, session.id))
      .all()
      .pipe(Effect.orDie)
    if (rows.length === 0) return
    const wanted = new Set<string>([String(revert.messageID)])
    for (const row of rows) {
      const anchor = row.user_message_id ?? row.last_assistant_id
      if (anchor) wanted.add(anchor)
    }
    const byID = yield* deps.sessions.getMessageInfos({ sessionID: session.id, messageIDs: [...wanted] })
    const revertInfo = byID.get(String(revert.messageID))
    if (!revertInfo) return
    yield* Effect.forEach(
      rows,
      (row) => {
        const anchor = row.user_message_id ?? row.last_assistant_id
        if (!anchor) return Effect.void
        const info = byID.get(anchor)
        // A surviving message at or after the revert boundary is reverted;
        // a missing one was already removed by an earlier cleanup.
        if (info && MessageV2.before(info, revertInfo)) return Effect.void
        return deps.db.delete(SessionTurnTable).where(eq(SessionTurnTable.id, row.id)).run().pipe(Effect.orDie)
      },
      { concurrency: 1, discard: true },
    )
  })
}

/** Handle bookkeeping that `makeTurns` shares with idle admission. */
interface TurnFlow {
  readonly begin: Interface["begin"]
  readonly track: Interface["track"]
  readonly watch: Interface["watch"]
}

/**
 * Idle admission in two phases, preserving the pre-PR8 protocol: reserve an
 * idle runner, commit the message under a cancellation-guarded transaction,
 * then let the owner activate the work. A busy session, an invalidated
 * request, or an admission failure leaves no `session_turn` row.
 */
function makePrepareIdle(deps: TurnDeps, flow: TurnFlow) {
  const { begin, track, watch } = flow
  return Effect.fn("Turns.prepare")(function* (
    input: PromptInput,
    options: AdmissionOptions | undefined,
    persistAdmission: Effect.Effect<void, unknown> | undefined,
    request: ReturnType<typeof SessionCancellation.request> | undefined,
  ) {
    return yield* deps.withRunRequest(
      input.sessionID,
      (req, witness) =>
        deps.withPromptLock(witness, input.sessionID, () =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              if (!req.valid()) return Option.none<IdleAdmission>()
              const activation = yield* Deferred.make<void>()
              const gate = yield* Deferred.make<Exit.Exit<Admission, PromptError>>()
              const handle = begin(input.sessionID, originFor(options))
              const work = Effect.gen(function* () {
                yield* Deferred.await(activation)
                if (!req.current()) return yield* Effect.interrupt
                const admitted = yield* Deferred.await(gate)
                if (Exit.isFailure(admitted)) return yield* Effect.failCause(admitted.cause)
                if (!admitted.value.run) return admitted.value.message
                return yield* track(
                  handle,
                  Effect.gen(function* () {
                    if (!(yield* deps.fenceRewake(input.sessionID, options, admitted.value.message)))
                      return blockedExecution(admitted.value.message)
                    return yield* deps.runLoop(input.sessionID)
                  }),
                ).pipe(Effect.map((turn) => turn.message))
              }).pipe(Effect.orDie)
              const wait = yield* deps.state.startIfIdle(
                input.sessionID,
                deps.lastAssistant(input.sessionID),
                work,
                request,
              )
              if (Option.isNone(wait)) return Option.none<IdleAdmission>()
              // A cancel can interrupt the forked work before it activates;
              // the watcher keeps the reserved handle from staying `running`.
              yield* watch(handle, wait.value)

              const admitted = yield* restore(
                deps
                  .admitPrompt(input, persistAdmission, options, (body) =>
                    Effect.suspend(() => (req.valid() ? body : Effect.interrupt)),
                  )
                  .pipe(Effect.catchTag("SessionConversationHookBlocked", (error) => Effect.die(error))),
              ).pipe(Effect.exit)
              yield* Deferred.succeed(gate, admitted)
              if (Exit.isFailure(admitted)) {
                yield* Deferred.succeed(activation, undefined)
                if (!req.valid() && Cause.hasInterruptsOnly(admitted.cause)) return Option.none<IdleAdmission>()
                return yield* Effect.failCause(admitted.cause)
              }
              return Option.some({
                turn: admitted.value.run ? handle : undefined,
                run: admitted.value.run,
                message: admitted.value.message,
                activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
                result: wait.value,
                abort: deps.state.cancel(input.sessionID),
              } satisfies IdleAdmission)
            }),
          ),
        ),
      request,
    )
  })
}

export function makeTurns(deps: TurnDeps): Interface {
  const currents = new Map<SessionID, InternalHandle>()
  // The public handle type hides bookkeeping fields; `track` recovers them
  // without asserting a shape callers could not have built themselves.
  const internals = new WeakMap<TurnHandle, InternalHandle>()

  const begin = (sessionID: SessionID, origin: TurnOrigin, userMessageID?: MessageID): InternalHandle => {
    const outcome = Deferred.makeUnsafe<TurnOutcome>()
    const live: { status: TurnStatus } = { status: "running" }
    const handle: InternalHandle = {
      id: randomUUID(),
      sessionID,
      origin,
      outcome,
      live,
      userMessageID,
      result: Deferred.await(outcome),
      status: Effect.sync(() => live.status),
      cancel: (reason) =>
        Effect.suspend(() =>
          live.status === "ended" ? Effect.void : deps.cancel(sessionID, reason ? { reason } : undefined),
        ),
    }
    internals.set(handle, handle)
    return handle
  }

  // One settlement per handle. `track` settles from the work's exit handler
  // under its mask; `watch` settles from the admission result when the work
  // was never tracked (cancelled in the shell queue, or joined). The status
  // flip keeps the two paths from double-settling the deferred.
  const settle = (turn: TurnHandle, outcome: TurnOutcome): Effect.Effect<void> => {
    const handle = internals.get(turn)
    if (!handle) throw new Error(`unknown turn handle ${turn.id}`)
    return Effect.sync(() => {
      if (handle.live.status === "ended") return false
      handle.live.status = "ended"
      if (currents.get(handle.sessionID) === handle) currents.delete(handle.sessionID)
      return true
    }).pipe(
      Effect.flatMap((settled) => (settled ? Deferred.succeed(handle.outcome, outcome) : Effect.void)),
      Effect.uninterruptible,
      Effect.asVoid,
    )
  }

  const settleCancelled = (handle: InternalHandle) =>
    settle(handle, { type: "cancelled", reason: SessionAbortReason.peek(handle.sessionID)?.reason })

  const watch = (turn: TurnHandle, admission: Effect.Effect<unknown>): Effect.Effect<void> => {
    const handle = internals.get(turn)
    if (!handle) throw new Error(`unknown turn handle ${turn.id}`)
    return Effect.suspend(() => {
      if (handle.live.status === "ended") return Effect.void
      return Effect.forkIn(admission.pipe(Effect.exit, Effect.andThen(settleCancelled(handle))), deps.scope).pipe(
        Effect.asVoid,
      )
    })
  }

  const track = <A extends TurnExecution>(turn: TurnHandle, work: Effect.Effect<A>): Effect.Effect<A> => {
    const handle = internals.get(turn)
    if (!handle) throw new Error(`unknown turn handle ${turn.id}`)
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* deps.db
          .insert(SessionTurnTable)
          .values({
            id: handle.id,
            session_id: handle.sessionID,
            origin: JSON.stringify(handle.origin),
            origin_ref: originRef(handle.origin),
            state: "running",
            user_message_id: handle.userMessageID ?? null,
            runner_id: EngineProcess.runner.id,
            time_started: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)
        currents.set(handle.sessionID, handle)
        // Restore interruptibility for the machine. The exit handler below is
        // back inside the mask, so the second write completes even when the
        // runner was cancelled and this fiber is being interrupted.
        const exit = yield* restore(work).pipe(Effect.exit)
        const result = Exit.isSuccess(exit) ? exit.value : undefined
        const outcome = result?.outcome ?? outcomeOfExit(exit, handle.sessionID)
        const steps = result?.steps ?? 0
        const timeEnded = Date.now()
        const wrote = yield* deps.db
          .update(SessionTurnTable)
          .set({
            state: "ended",
            outcome,
            user_message_id: result?.userMessageID ?? handle.userMessageID ?? null,
            last_assistant_id: result?.lastAssistantID ?? null,
            steps,
            time_ended: timeEnded,
          })
          .where(eq(SessionTurnTable.id, handle.id))
          .run()
          .pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("session turn end write failed", { turnID: handle.id, cause }).pipe(Effect.as(false)),
            ),
          )
        // Publish only once the ended row exists: a late observer must never
        // see a settlement for a turn it cannot read back.
        if (wrote) {
          yield* deps
            .onSettled({ sessionID: handle.sessionID, turnID: handle.id, outcome, steps, timeEnded })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("session turn settled hook failed", { turnID: handle.id, cause }),
              ),
            )
        }
        yield* settle(handle, outcome)
        return yield* exit
      }),
    )
  }

  const run = (sessionID: SessionID, origin: TurnOrigin, work: Effect.Effect<TurnExecution>) =>
    Effect.suspend(() => track(begin(sessionID, origin), work))

  const prepare = makePrepareIdle(deps, { begin, track, watch })

  const start = Effect.fn("Turns.start")(function* (input: PromptInput, options: TurnStartOptions) {
    if (options.when === "idle") {
      const prepared = yield* prepare(input, options.admissionOptions, options.persistAdmission, options.request)
      if (Option.isNone(prepared)) {
        return {
          admission: { kind: "skipped_busy" },
          wait: deps.lastAssistant(input.sessionID),
        } satisfies TurnStart
      }
      const idle = prepared.value
      yield* idle.activate.pipe(Effect.onError(() => idle.abort))
      if (!idle.run || !idle.turn) {
        return {
          admission: { kind: "not_started", reason: "admission_declined" },
          message: idle.message,
          wait: idle.result,
        } satisfies TurnStart
      }
      return {
        admission: { kind: "started", turn: idle.turn },
        message: idle.message,
        wait: idle.result,
      } satisfies TurnStart
    }

    // Under the caller's request when it brought one (see `TurnStartOptions.request`), else under a fresh one.
    const withRunRequest: TurnDeps["withRunRequest"] = (sessionID, use) =>
      deps.withRunRequest(sessionID, use, options.request)
    return yield* withRunRequest(input.sessionID, (request, witness) =>
      deps.withPromptLock(witness, input.sessionID, () =>
        Effect.gen(function* () {
          if (!request.valid()) return yield* Effect.interrupt
          if (deps.goal && input.noReply !== true) yield* deps.goal.clearTurnDriven(input.sessionID)
          const admitted = yield* deps.admitPrompt(
            input,
            options.persistAdmission,
            options.admissionOptions,
            options.commitAdmission,
            options.modelBaseline,
          )
          if (!admitted.run) {
            return {
              admission: { kind: "not_started", reason: "admission_declined" },
              message: admitted.message,
              wait: Effect.succeed(admitted.message),
            } satisfies TurnStart
          }
          // The handle is created before runner classification so the row is
          // inserted by the work fiber itself: a request that joins an
          // already-running turn never writes one.
          const handle = begin(input.sessionID, options.origin, admitted.message.info.id)
          const tracked = track(
            handle,
            Effect.gen(function* () {
              if (!(yield* deps.fenceRewake(input.sessionID, options.admissionOptions, admitted.message)))
                return blockedExecution(admitted.message)
              return yield* deps.runLoop(input.sessionID)
            }),
          )
          const classified = yield* deps.state.ensureRunningHandleClassified(
            input.sessionID,
            deps.lastAssistant(input.sessionID),
            tracked.pipe(Effect.map((turn) => turn.message)),
            request,
          )
          if (classified.kind === "skipped") {
            return {
              admission: { kind: "skipped_busy" },
              message: admitted.message,
              wait: classified.result,
            } satisfies TurnStart
          }
          // Settle a handle whose queued work is discarded before `track`
          // (cancel while it waits behind a shell, or a join that abandoned
          // this request's work). `track` owns the normal settlement.
          yield* watch(handle, classified.result)
          if (classified.kind === "joined") {
            const current = currents.get(input.sessionID)
            return {
              admission: { kind: "joined", turn: current ?? handle, messageID: admitted.message.info.id },
              message: admitted.message,
              wait: classified.result,
            } satisfies TurnStart
          }
          // `queued` (behind a shell) starts this request's own turn later, so
          // it is reported as `started`: that work will insert the row.
          return {
            admission: { kind: "started", turn: handle },
            message: admitted.message,
            wait: classified.result,
          } satisfies TurnStart
        }),
      ),
    )
  })

  const current = (sessionID: SessionID) =>
    Effect.sync(() => {
      const value = currents.get(sessionID)
      return value ? Option.some<TurnHandle>(value) : Option.none<TurnHandle>()
    })

  const lastOutcome = (sessionID: SessionID) => lastOutcomeOf({ db: deps.db, sessions: deps.sessions }, sessionID)

  const beginCancel = (sessionID: SessionID) =>
    Effect.gen(function* () {
      const cancellation = yield* Effect.sync(() => SessionCancellation.begin(sessionID))
      // The cancellation epoch already invalidates pending Stop rewakes; the
      // generation bump is the second half of the same reset and clears the
      // continuation budget for the next real prompt.
      if (deps.settingsHook?.bumpRewakeGeneration)
        yield* deps.settingsHook.bumpRewakeGeneration(sessionID).pipe(Effect.ignore)
      return cancellation
    })

  return { start, prepare, current, lastOutcome, beginCancel, run, track, watch, settle, begin }
}

export * as Turns from "./turns"
