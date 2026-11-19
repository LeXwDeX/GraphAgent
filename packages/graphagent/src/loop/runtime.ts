// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The loop's turn driver (#1329).
 *
 * `LoopState` holds the loop, `LoopAnalysis` re-derives what the user wants after every round,
 * `StopCondition` is the one place that decides what happens next, and `LoopHost` is the session. This
 * module is what joins them: at every idle boundary of a session that has a live loop it collects the
 * boundary's signals, asks `StopCondition.evaluate`, and carries out the verdict.
 *
 * Verdict      Carried out as
 * analyze      mark `analyzing`, run the background analysis, commit it under a fence, decide again with it
 * dispatch     one write that counts the round, committed together with the round's message
 * wait         `waiting`, with the object being waited for
 * recover      retry or reset: dispatch the failed step again; probe: `waiting` until `probe_at`
 * stop         the stop record, then `stopped` or the terminal snapshot, as the reason's `ends` says
 * none         housekeeping only
 *
 * Everything that decides lives in `StopCondition` and `LoopDecision`; what this file adds is the order of
 * the effects and the fences that make them safe to interleave:
 *
 * - One decision per session runs at a time. A trigger that arrives meanwhile runs one more decision after
 *   it, so a boundary that appears while another is being finished is never missed.
 * - Every write carries the identity (`loop_id`, `revision`) the decision was made against; a write that no
 *   longer matches is dropped. A dispatch or a wake writes inside the admission of its message
 *   (`Request.commit`), so a refused message never counts a round, and a process that dies before the
 *   admission leaves the loop as it was.
 * - An analysis commits only if the loop and the boundary are still the ones it started at. A discarded
 *   result re-triggers the boundary through the host at once.
 * - A human message never pauses the loop. It waits for its reply (`Observation.preempted`), and the
 *   boundary that follows analyses it as a human message.
 *
 * Not wired in yet: nothing registers `claim` with the inbox, and the goal system still runs on its own.
 */
import { Cause, Clock, Context, Effect, Fiber, Layer, Scope } from "effect"
import { STOP_REASON_PROPS, type Stop } from "@graphagent/schema/stop-reason"
import type { SessionID } from "@/session/schema"
import { StopCondition } from "@/session/stop-condition"
import { LoopAnalysis } from "./analysis"
import { LoopDecision } from "./decision"
import { LoopHost } from "./host"
import { LoopMessage } from "./message"
import { LoopState } from "./state"

/** Decisions chained inside one trigger: an analysis, its verdict, and a retry after a failed analysis. */
const MAX_STEPS = 8

export interface ClaimContext {
  /** The cancellation epoch the inbox captured before the drain; a dispatch refuses if an ESC moved it. */
  readonly claimEpoch?: number
}

/** What a user action did. `unchanged`: the loop already was where the action leads. */
export type Acted =
  | { readonly tag: "none" }
  | { readonly tag: "unchanged"; readonly state: LoopState.Info }
  | { readonly tag: "stopped"; readonly state: LoopState.Info }
  | { readonly tag: "ended"; readonly state: LoopState.Info }

export interface ResumeInput {
  /** The new round limit. Must be above the current round. */
  readonly maxRounds?: number
}

export type Resumed =
  | { readonly tag: "resumed"; readonly state: LoopState.Info }
  | { readonly tag: "none" }
  | { readonly tag: "running"; readonly state: LoopState.Info }
  | { readonly tag: "invalid"; readonly state: LoopState.Info }

export interface WakeOptions {
  /**
   * `false` only flips the durable state: the caller is about to deliver its own prompt, whose turn-end
   * boundary drives what follows. Otherwise the loop starts the wake turn itself.
   */
  readonly evaluate?: boolean
}

export interface Interface {
  /**
   * The inbox claim: a boundary (or a nudge, or the periodic scan of a waiting loop) of this session. Takes it
   * when the session has a live loop (`active` or `waiting`) and decides in the background, in the caller's
   * scope; resolves to whether it took it.
   */
  readonly claim: (sessionID: SessionID, context?: ClaimContext) => Effect.Effect<boolean, never, Scope.Scope>
  /** The sessions of the directory the periodic scan must visit: those whose loop is `waiting`. */
  readonly scan: (directory: string) => Effect.Effect<ReadonlyArray<SessionID>>
  /** Startup recovery: decides every live loop of the directory once, as a boundary, in the caller's scope. */
  readonly init: (directory: string) => Effect.Effect<void, never, Scope.Scope>
  /** Resolves once no decision of the session is running. For tests and orderly shutdown. */
  readonly settled: (sessionID: SessionID) => Effect.Effect<void>
  /**
   * Starts a loop, ending a live one as `goal_changed`. Aborts an analysis in flight for the old loop. Sending
   * round 1's message is the caller's: it is an ordinary user message.
   */
  readonly start: (sessionID: SessionID, input: LoopState.CreateInput) => Effect.Effect<LoopState.Created>
  /** A user action on the live loop: `stop`, `interrupt` (ESC) or `done`. Aborts an analysis in flight. */
  readonly act: (sessionID: SessionID, action: "stop" | "interrupt" | "done") => Effect.Effect<Acted>
  /** `/loop clear`: ends the loop as `cancelled`; a stopped loop keeps its stop record. */
  readonly clear: (sessionID: SessionID) => Effect.Effect<LoopState.Info | undefined>
  /** The session was archived: the loop ends as `session_archived`. */
  readonly archive: (sessionID: SessionID) => Effect.Effect<LoopState.Info | undefined>
  /**
   * Resumes a `stopped` loop. Opens a new failure chain, zeroes the streak and widens the budget, then decides
   * the boundary again, seeing only the analysis and the counts: what stopped the loop is not applied twice.
   */
  readonly resume: (sessionID: SessionID, input?: ResumeInput) => Effect.Effect<Resumed, never, Scope.Scope>
  /**
   * An event for the object a waiting loop waits for. Counts a round, ends the wait and, unless
   * `evaluate` is `false`, starts a wake turn, all in the admission of the turn's message; an exhausted
   * round budget stops the loop instead. A wake the session refuses (a turn is running, a human message is
   * waiting for its reply) changes nothing: the loop keeps waiting, and the next decision finds the object over
   * (`LoopHost.health`) and reviews it, or the object's next event wakes it again. Resolves to whether the
   * event matched the wait.
   */
  readonly wake: (
    sessionID: SessionID,
    match: LoopDecision.WakeMatch,
    payload?: string,
    options?: WakeOptions,
  ) => Effect.Effect<boolean, never, Scope.Scope>
  /**
   * A new turn is starting, a human's or an automatic one. Aborts an analysis in flight and clears its mark and
   * the declaration of the boundary that is now over.
   */
  readonly turnStarted: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/LoopRuntime") {}

/** The decision of one session in flight, and what a trigger that arrives during it needs. */
interface Work {
  /** A trigger arrived while this ran: decide once more when it ends. */
  again: boolean
  /** The running analysis; aborting it makes `LoopAnalysis.run` resolve as cancelled. */
  analysis: AbortController | undefined
  fiber: Fiber.Fiber<void> | undefined
}

/** The result of an analysis, handed to the next step of the same decision. */
interface Carry {
  readonly analysis: StopCondition.Analysis
  readonly failure?: StopCondition.Failure
}

/** `undefined`: the decision is over. `retry`: decide again from the state. `analyzed`: decide again with a result. */
type Next = undefined | { readonly kind: "retry" } | { readonly kind: "analyzed"; readonly carry: Carry }

/** What a step has found out about the boundary it is deciding. */
interface Ctx {
  readonly sessionID: SessionID
  readonly work: Work
  readonly epoch: number
  readonly now: number
  readonly state: LoopState.Info
  readonly observation: LoopHost.Observation
  readonly boundary: LoopHost.Boundary
}

interface Exec extends Ctx {
  readonly chain: StopCondition.Chain
  readonly carry: Carry | undefined
  /** The wait seen at `now`, with the reason to tell the agent when it has ended. */
  readonly waited: { readonly waiting: StopCondition.Waiting; readonly reason: string } | undefined
  /** A running watch or task that may unblock the work; looked up only when the analysis said `blocked`. */
  readonly waitable: LoopState.Wait | undefined
}

interface Send {
  readonly sessionID: SessionID
  readonly state: LoopState.Info
  readonly kind: LoopHost.Kind
  readonly round: number
  readonly text: string
  readonly boundary?: string
  readonly reset?: boolean
  readonly epoch: number
  readonly commit: Effect.Effect<boolean>
}

const isLive = (state: LoopState.Info | undefined): state is LoopState.Info =>
  state !== undefined && (state.status === "active" || state.status === "waiting")

const queryOf = (state: LoopState.Info): LoopHost.Query => {
  const after = state.last_analyzed_msg ?? state.origin.message_id
  return { ...(after !== undefined ? { after } : {}), since: state.origin.created_at }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const loops = yield* LoopState.Service
    const analysis = yield* LoopAnalysis.Service
    const host = yield* LoopHost.Service

    const works = new Map<SessionID, Work>()
    /** Sessions whose next decision follows a resume. */
    const masked = new Set<SessionID>()

    const abortAnalysis = (sessionID: SessionID) => Effect.sync(() => works.get(sessionID)?.analysis?.abort())

    // ── stopping ────────────────────────────────────────────────

    /** The stop record, then `stopped` (the loop can resume) or the terminal snapshot (it cannot), per the reason's `ends`. */
    const stopLoop = Effect.fnUntraced(function* (sessionID: SessionID, fence: LoopState.Expected | undefined, stop: Stop) {
      const record = LoopState.stopRecord(stop, yield* Clock.currentTimeMillis)
      const ends = STOP_REASON_PROPS[stop.reason].ends
      if (ends === "no")
        return yield* loops.update(sessionID, fence, {
          status: "stopped",
          stop: record,
          analyzing: undefined,
          declaration: undefined,
          recovery: undefined,
        })
      return yield* loops.end(sessionID, fence, { status: ends, stop: record })
    })

    /** Stops the loop `loopID` as it is now, if it is still the session's loop: for decisions with no revision to hold. */
    const stopCurrent = Effect.fnUntraced(function* (sessionID: SessionID, loopID: string, stop: Stop) {
      const current = yield* loops.load(sessionID)
      if (current === undefined || current.loop_id !== loopID) return undefined
      return yield* stopLoop(sessionID, LoopState.expected(current), stop)
    })

    // ── dispatching ─────────────────────────────────────────────

    /**
     * Starts one turn with a loop message. Whatever the host answers, nothing here counts a round: `commit`
     * does, inside the admission. A defect while admitting stops the loop; an ESC since the epoch was observed
     * is a user interrupt.
     */
    const send = Effect.fnUntraced(function* (input: Send) {
      const { sessionID, state } = input
      const request: LoopHost.Request = {
        marker: { loopID: state.loop_id, round: input.round, kind: input.kind },
        text: input.text,
        ...(input.boundary !== undefined ? { boundary: input.boundary } : {}),
        ...(input.reset === true ? { reset: true } : {}),
        epoch: input.epoch,
        commit: input.commit,
      }
      const result = yield* host.dispatch(sessionID, request).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed({ ok: false as const, cause }),
        ),
      )
      if (!result.ok) {
        yield* Effect.logWarning("loop dispatch failed", { sessionID, cause: Cause.pretty(result.cause) })
        yield* stopCurrent(sessionID, state.loop_id, {
          reason: "internal_error",
          detail: { code: "dispatch_failed", message: "Starting the next turn failed" },
        })
        return
      }
      if (result.value === "cancelled") yield* stopCurrent(sessionID, state.loop_id, { reason: "user_interrupted" })
    })

    const dispatchRound = Effect.fnUntraced(function* (ctx: Exec, round: "next" | "review") {
      const { sessionID, state } = ctx
      const next = state.round + 1
      const note =
        round === "review" ? [ctx.waited?.reason ?? "", LoopMessage.REVIEW_NOTE].filter((line) => line !== "").join(" ") : undefined
      const text = LoopMessage.render({
        kind: round,
        round: next,
        maxRounds: state.max_rounds,
        ...(round === "next" && state.next_prompt !== undefined ? { prompt: state.next_prompt } : {}),
        ...(note !== undefined ? { note } : {}),
        origin: state.origin.prompt,
        ...(state.intent !== undefined ? { intent: state.intent } : {}),
      })
      const review = round === "review" && state.wait !== undefined ? { ...state.wait, reviewed: true } : undefined
      yield* send({
        sessionID,
        state,
        kind: round,
        round: next,
        text,
        ...(ctx.boundary.message !== undefined ? { boundary: ctx.boundary.message } : {}),
        epoch: ctx.epoch,
        commit: loops
          .update(sessionID, LoopState.expected(state), {
            round: next,
            status: "active",
            wait: review,
            next_prompt: undefined,
            declaration: undefined,
            analyzing: undefined,
            recovery: undefined,
          })
          .pipe(Effect.map((written) => written !== undefined)),
      })
      return undefined satisfies Next
    })

    /** Sends the failed step's round again. It does not count: the round was counted when it was first dispatched. */
    const redispatch = Effect.fnUntraced(function* (ctx: Ctx, recovery: LoopState.Recovery, reset: boolean) {
      const { sessionID, state } = ctx
      const rows = yield* loops.analyses(state.loop_id)
      const prompt = rows.at(-1)?.prompt
      yield* send({
        sessionID,
        state,
        kind: "recovery",
        round: state.round,
        text: LoopMessage.render({
          kind: "recovery",
          round: state.round,
          maxRounds: state.max_rounds,
          note: LoopMessage.RECOVERY_NOTE,
          ...(prompt !== undefined && prompt !== null ? { prompt } : {}),
          origin: state.origin.prompt,
          ...(state.intent !== undefined ? { intent: state.intent } : {}),
        }),
        ...(ctx.boundary.message !== undefined ? { boundary: ctx.boundary.message } : {}),
        reset,
        epoch: ctx.epoch,
        commit: loops
          .update(sessionID, LoopState.expected(state), {
            status: "active",
            recovery,
            declaration: undefined,
            analyzing: undefined,
          })
          .pipe(Effect.map((written) => written !== undefined)),
      })
      return undefined satisfies Next
    })

    // ── analysing ───────────────────────────────────────────────

    /**
     * Runs the background analysis of the boundary and commits it. The `analyzing` mark and the commit hold the
     * revision the mark produced, so any other write in between (a command, a stop, a new turn) drops the result.
     */
    const analyze = Effect.fnUntraced(function* (ctx: Ctx) {
      const { sessionID, state, boundary, observation, work } = ctx
      const message = boundary.message
      if (message === undefined) return undefined satisfies Next
      const marked = yield* loops.update(sessionID, LoopState.expected(state), {
        analyzing: { boundary: message, started_at: ctx.now },
      })
      if (marked === undefined) return undefined satisfies Next

      const controller = new AbortController()
      work.analysis = controller
      const rows = yield* loops.analyses(state.loop_id)
      const prior = LoopDecision.priorOf(state, rows)
      const declaration = LoopDecision.declarationOf(state)
      const outcome = yield* analysis
        .run({
          sessionID,
          firstDescription: state.origin.prompt,
          ...(prior !== undefined ? { prior } : {}),
          ...(declaration !== undefined ? { declaration } : {}),
          outcome: boundary.turn,
          humans: observation.humans,
          abort: controller.signal,
        })
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (work.analysis === controller) work.analysis = undefined
            }),
          ),
        )

      const failed = (cause: StopCondition.AnalysisFailure, failure?: StopCondition.Failure): Next => ({
        kind: "analyzed",
        carry: { analysis: { type: "failed", cause }, ...(failure !== undefined ? { failure } : {}) },
      })
      if (outcome.type === "failed") {
        const reason = outcome.failure
        switch (reason.kind) {
          case "cancelled":
            // Something else moved the loop on and says so itself; the boundary is decided again at once.
            yield* host.nudge(sessionID)
            return undefined satisfies Next
          case "provider":
            return failed(
              "provider",
              StopCondition.failureOf(
                reason.error,
                outcome.model?.providerID ?? boundary.error?.provider ?? "unknown",
                yield* Clock.currentTimeMillis,
              ),
            )
          case "invalid_output":
            return failed("invalid_output")
          case "limit":
            return failed("limit")
        }
      }

      // The fence: the boundary must be the one analysed, and the loop the one marked.
      const latest = yield* host.observe(sessionID, queryOf(state))
      if (latest.boundary?.message !== message) {
        yield* host.nudge(sessionID)
        return undefined satisfies Next
      }
      const lastRound = rows.at(-1)?.round ?? 0
      const streak = LoopDecision.streakAfter(
        state.no_progress_streak,
        LoopDecision.followsCountedRound(state, lastRound, boundary),
        outcome.result.progress.advanced,
      )
      const committed = yield* loops.commitAnalysis(sessionID, LoopState.expected(marked), {
        boundary: message,
        result: outcome.result,
        usage: outcome.usage,
        elapsedMs: outcome.elapsedMs,
        ...(streak !== undefined ? { noProgressStreak: streak } : {}),
      })
      if (committed === undefined) {
        // Replaced, stopped, advanced or marked again meanwhile: the result is stale, the boundary is not.
        yield* host.nudge(sessionID)
        return undefined satisfies Next
      }
      const mapped = LoopDecision.analysisOf(outcome.result)
      return mapped === undefined
        ? failed("invalid_output")
        : ({ kind: "analyzed", carry: { analysis: mapped } } satisfies Next)
    })

    // ── carrying out the other verdicts ─────────────────────────

    const enterWait = Effect.fnUntraced(function* (ctx: Exec) {
      const { sessionID, state } = ctx
      const declared = state.declaration?.kind === "await" ? state.wait : undefined
      const wait = declared ?? ctx.waitable
      if (wait === undefined) {
        yield* stopLoop(sessionID, LoopState.expected(state), {
          reason: "internal_error",
          detail: { code: "missing_wait", message: "The loop was to wait but names nothing to wait for" },
        })
        return undefined satisfies Next
      }
      yield* loops.update(sessionID, LoopState.expected(state), {
        status: "waiting",
        wait,
        declaration: undefined,
        analyzing: undefined,
        recovery: undefined,
      })
      return undefined satisfies Next
    })

    const recover = Effect.fnUntraced(function* (ctx: Exec, action: StopCondition.RecoverAction) {
      const { sessionID, state } = ctx
      const recovery = LoopDecision.recoveryAfter(ctx.chain, action, ctx.boundary, ctx.now)
      if (action.type === "probe") {
        // Level three: nothing runs until `probe_at`, and the loop is not waiting for an object.
        yield* loops.update(sessionID, LoopState.expected(state), {
          status: "waiting",
          wait: undefined,
          recovery,
          declaration: undefined,
          analyzing: undefined,
        })
        return undefined satisfies Next
      }
      if (ctx.carry?.analysis.type === "failed") {
        // The failed step is the analysis: record the attempt, then analyse again.
        const written = yield* loops.update(sessionID, LoopState.expected(state), { recovery, analyzing: undefined })
        return written === undefined ? (undefined satisfies Next) : ({ kind: "retry" } satisfies Next)
      }
      return yield* redispatch(ctx, recovery, action.type === "reset")
    })

    /** Nothing to do but tidy: the boundary is over, and a loop that keeps waiting is `waiting`. */
    const idle = Effect.fnUntraced(function* (ctx: Exec) {
      const { sessionID, state } = ctx
      const waiting = ctx.waited?.waiting
      const keeps = state.status === "active" && waiting !== undefined && waiting.alive && !waiting.expired
      if (state.declaration === undefined && !keeps) return undefined satisfies Next
      yield* loops.update(sessionID, LoopState.expected(state), {
        declaration: undefined,
        ...(keeps ? { status: "waiting" as const } : {}),
      })
      return undefined satisfies Next
    })

    const execute = Effect.fnUntraced(function* (ctx: Exec, verdict: StopCondition.Verdict) {
      switch (verdict.type) {
        case "analyze":
          return yield* analyze(ctx)
        case "dispatch":
          return yield* dispatchRound(ctx, verdict.round)
        case "wait":
          return yield* enterWait(ctx)
        case "recover":
          return yield* recover(ctx, verdict.action)
        case "stop":
          yield* stopLoop(ctx.sessionID, LoopState.expected(ctx.state), LoopDecision.stopOf(verdict))
          return undefined satisfies Next
        case "none":
          return yield* idle(ctx)
      }
      return undefined satisfies Next
    })

    // ── the self-healing probe ──────────────────────────────────

    /**
     * A waiting loop with `probe_at` decides nothing but this. A turn that worked since the failure ends the
     * chain and returns the loop to an ordinary boundary. One that failed leaves the plan as it is, spends no
     * probe and does not cancel one: the probe is still due at `probe_at`, and then redoes the failed step
     * without asking `evaluate`, at the latest boundary, whichever turn that was.
     */
    const probe = Effect.fnUntraced(function* (ctx: Ctx, recovery: LoopState.Recovery & { readonly probe_at: number }) {
      const { sessionID, state, boundary } = ctx
      if (LoopDecision.keyOf(boundary) !== recovery.boundary && LoopDecision.isOkTurn(boundary.turn)) {
        const active = yield* loops.update(sessionID, LoopState.expected(state), { status: "active", recovery: undefined })
        return active === undefined ? (undefined satisfies Next) : ({ kind: "retry" } satisfies Next)
      }
      if (ctx.now < recovery.probe_at) return undefined satisfies Next
      const next: LoopState.Recovery = { ...recovery, probe_at: undefined }
      const active = yield* loops.update(sessionID, LoopState.expected(state), { status: "active", recovery: next })
      if (active === undefined) return undefined satisfies Next
      const woken = { ...ctx, state: active }
      // The step that failed was the round when its turn ended on an error or left nothing to analyse; else the analysis.
      return boundary.turn.type === "error" || boundary.message === undefined
        ? yield* redispatch(woken, next, false)
        : yield* analyze(woken)
    })

    // ── one decision ────────────────────────────────────────────

    /** The analysis already committed for this boundary, rebuilt from the state, so a boundary is analysed once. */
    const committed = Effect.fnUntraced(function* (state: LoopState.Info, message: string) {
      if (state.last_verdict === undefined) return undefined
      const last = (yield* loops.analyses(state.loop_id)).at(-1)
      if (last === undefined || last.boundary !== message) return undefined
      return LoopDecision.toAnalysis(
        state.last_verdict,
        state.progress?.advanced ?? true,
        last.change_basis_message_id ?? undefined,
      )
    })

    const step = Effect.fnUntraced(function* (
      sessionID: SessionID,
      work: Work,
      epoch: number,
      mask: boolean,
      carry: Carry | undefined,
    ) {
      let state = yield* loops.load(sessionID)
      if (!isLive(state)) return undefined
      // This decision is the only one analysing the session, so a mark it did not set is left from before a
      // restart, or from a result that lost its fence.
      if (state.analyzing !== undefined && carry === undefined) {
        const cleared = yield* loops.update(sessionID, LoopState.expected(state), { analyzing: undefined })
        if (cleared === undefined) return undefined
        state = cleared
      }

      const now = yield* Clock.currentTimeMillis
      const observation = yield* host.observe(sessionID, queryOf(state))
      const boundary = observation.boundary
      // Only an idle boundary is decided, and not while a human message waits for its reply.
      if (!observation.idle || boundary === undefined || observation.preempted) return undefined
      // A loop started or replaced just now has not run its first round: the boundary in front is an older one.
      if (LoopDecision.precedesLoop(state.origin, boundary)) return undefined
      const ctx: Ctx = { sessionID, work, epoch, now, state, observation, boundary }

      const recovery = state.recovery
      if (state.status === "waiting" && recovery?.probe_at !== undefined && carry === undefined)
        return yield* probe(ctx, { ...recovery, probe_at: recovery.probe_at })

      const chain = LoopDecision.chainOf(recovery, boundary)
      const failure = carry !== undefined ? carry.failure : mask ? undefined : LoopDecision.turnFailure(boundary, now)
      const health = state.wait === undefined ? undefined : yield* host.health(sessionID, state.wait)
      const waited =
        state.wait === undefined || health === undefined ? undefined : LoopDecision.waitingOf(state.wait, now, health)
      let result = carry?.analysis
      if (result === undefined && boundary.message !== undefined && state.last_analyzed_msg === boundary.message) {
        const stored = yield* committed(state, boundary.message)
        // A continue whose prompt was already sent is waiting for its turn's boundary, not for another dispatch.
        if (stored?.type === "continue" && state.next_prompt === undefined) return undefined
        // A blocked analysis is carried out once. When it put the loop into a wait, the wait decides from then on:
        // replaying the verdict would set the wait afresh at every scan, so it would never expire, and would stop a
        // loop whose object is over for a question it has already turned into a wait, instead of reviewing it.
        const carriedOut = stored?.type === "blocked" && state.status === "waiting" && state.wait !== undefined
        result = carriedOut ? undefined : stored
      }
      // Only a blocked analysis asks whether something running may still unblock the work.
      const waitable = result?.type === "blocked" ? yield* host.waitable(sessionID, now) : undefined

      const verdict = StopCondition.evaluate(
        LoopDecision.inputOf({
          state,
          boundary,
          humans: observation.humans.length,
          ...(failure !== undefined ? { failure } : {}),
          ...(waited !== undefined ? { waiting: waited.waiting } : {}),
          runningWaitable: waitable !== undefined,
          ...(result !== undefined ? { analysis: result } : {}),
          chain,
          masked: mask,
        }),
      )
      return yield* execute({ ...ctx, chain, carry, waited, waitable }, verdict)
    })

    const decide = Effect.fnUntraced(function* (sessionID: SessionID, work: Work, epoch: number, mask: boolean) {
      let carry: Carry | undefined
      for (let index = 0; index < MAX_STEPS; index++) {
        const next = yield* step(sessionID, work, epoch, mask, carry)
        if (next === undefined) return
        carry = next.kind === "analyzed" ? next.carry : undefined
      }
      yield* Effect.logWarning("loop boundary did not settle", { sessionID })
    })

    // ── triggers ────────────────────────────────────────────────

    /** Runs the decision of the session in the caller's scope; a trigger during one makes it run once more. */
    const trigger = Effect.fnUntraced(function* (sessionID: SessionID, claimEpoch?: number) {
      const running = works.get(sessionID)
      if (running !== undefined) {
        running.again = true
        return
      }
      const scope = yield* Scope.Scope
      const work: Work = { again: false, analysis: undefined, fiber: undefined }
      works.set(sessionID, work)
      const release = () => {
        if (works.get(sessionID) === work) works.delete(sessionID)
      }
      // Unregistering and the `again` check are one synchronous step: a trigger lands before it or after, never between.
      const finished = Effect.sync(() => {
        if (work.again) {
          work.again = false
          return false
        }
        release()
        return true
      })
      const drive = Effect.gen(function* () {
        let epoch = claimEpoch
        let done = false
        while (!done) {
          const mask = masked.delete(sessionID)
          yield* decide(sessionID, work, epoch ?? (yield* host.epoch(sessionID)), mask)
          epoch = undefined
          done = yield* finished
        }
      })
      work.fiber = yield* drive.pipe(
        Effect.ensuring(Effect.sync(release)),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.void
            : Effect.logWarning("loop boundary failed", { sessionID, cause: Cause.pretty(cause) }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
    })

    const claim = Effect.fn("LoopRuntime.claim")(function* (sessionID: SessionID, context?: ClaimContext) {
      const state = yield* loops.load(sessionID).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("loop state unreadable", { sessionID, cause: Cause.pretty(cause) }).pipe(
                Effect.as(undefined),
              ),
        ),
      )
      if (!isLive(state)) return false
      yield* trigger(sessionID, context?.claimEpoch)
      return true
    })

    const scan = Effect.fn("LoopRuntime.scan")(function* (directory: string) {
      const live = yield* host.live(directory)
      return live.filter((item) => item.status === "waiting").map((item) => item.sessionID)
    })

    const init = Effect.fn("LoopRuntime.init")(function* (directory: string) {
      const live = yield* host.live(directory).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("loop startup scan failed", { directory, cause: Cause.pretty(cause) }).pipe(
                Effect.as([] as ReadonlyArray<LoopHost.Live>),
              ),
        ),
      )
      for (const item of live) yield* trigger(item.sessionID)
    })

    const settled = Effect.fn("LoopRuntime.settled")(function* (sessionID: SessionID) {
      while (true) {
        const work = works.get(sessionID)
        if (work === undefined) return
        if (work.fiber === undefined) yield* Effect.yieldNow
        else yield* Fiber.await(work.fiber)
      }
    })

    // ── commands and events ─────────────────────────────────────

    const start = Effect.fn("LoopRuntime.start")(function* (sessionID: SessionID, input: LoopState.CreateInput) {
      yield* abortAnalysis(sessionID)
      masked.delete(sessionID)
      return yield* loops.create(sessionID, input)
    })

    const act = Effect.fn("LoopRuntime.act")(function* (sessionID: SessionID, action: "stop" | "interrupt" | "done") {
      const state = yield* loops.load(sessionID)
      if (state === undefined) return { tag: "none" } as const satisfies Acted
      yield* abortAnalysis(sessionID)
      masked.delete(sessionID)
      // A stopped loop keeps the reason it stopped with; only `done` still has something to say.
      if (state.status === "stopped" && action !== "done") return { tag: "unchanged", state } as const satisfies Acted
      const verdict = StopCondition.evaluate(LoopDecision.actionInput(state, { user_action: action }))
      if (verdict.type !== "stop") return { tag: "unchanged", state } as const satisfies Acted
      const next = yield* stopLoop(sessionID, undefined, LoopDecision.stopOf(verdict))
      if (next === undefined) return { tag: "none" } as const satisfies Acted
      return { tag: next.status === "stopped" ? "stopped" : "ended", state: next } as const satisfies Acted
    })

    const clear = Effect.fn("LoopRuntime.clear")(function* (sessionID: SessionID) {
      const state = yield* loops.load(sessionID)
      if (state === undefined) return undefined
      yield* abortAnalysis(sessionID)
      masked.delete(sessionID)
      if (state.status === "stopped") return yield* loops.end(sessionID, undefined, { status: "cancelled" })
      return yield* loops.end(sessionID, undefined, {
        status: "cancelled",
        stop: LoopState.stopRecord({ reason: "user_stopped" }, yield* Clock.currentTimeMillis),
      })
    })

    const archive = Effect.fn("LoopRuntime.archive")(function* (sessionID: SessionID) {
      const state = yield* loops.load(sessionID)
      if (state === undefined) return undefined
      yield* abortAnalysis(sessionID)
      masked.delete(sessionID)
      const verdict = StopCondition.evaluate(LoopDecision.actionInput(state, { archived: true }))
      if (verdict.type !== "stop") return undefined
      return yield* stopLoop(sessionID, undefined, LoopDecision.stopOf(verdict))
    })

    const resume = Effect.fn("LoopRuntime.resume")(function* (sessionID: SessionID, input?: ResumeInput) {
      const state = yield* loops.load(sessionID)
      if (state === undefined) return { tag: "none" } as const satisfies Resumed
      if (state.status !== "stopped") return { tag: "running", state } as const satisfies Resumed
      const limit = input?.maxRounds
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= state.round))
        return { tag: "invalid", state } as const satisfies Resumed
      const resumed = yield* loops.update(sessionID, LoopState.expected(state), {
        status: "active",
        stop: undefined,
        recovery: undefined,
        no_progress_streak: 0,
        analyzing: undefined,
        declaration: undefined,
        // Without a new limit a loop that stopped at its budget is let through exactly one more round.
        max_rounds: limit ?? (state.round >= state.max_rounds ? state.round + 1 : state.max_rounds),
      })
      if (resumed === undefined) return { tag: "running", state } as const satisfies Resumed
      masked.add(sessionID)
      yield* trigger(sessionID)
      return { tag: "resumed", state: resumed } as const satisfies Resumed
    })

    const wake = Effect.fn("LoopRuntime.wake")(function* (
      sessionID: SessionID,
      match: LoopDecision.WakeMatch,
      payload?: string,
      options?: WakeOptions,
    ) {
      // Observed before the wake is decided, so an ESC after it fences the wake turn.
      const epoch = yield* host.epoch(sessionID)
      const state = yield* loops.load(sessionID)
      const wait = state?.wait
      if (state === undefined || wait === undefined || state.status !== "waiting" || state.recovery?.probe_at !== undefined)
        return false
      if (!LoopDecision.wakeMatches(wait, match)) return false
      if (wait.wakes >= wait.max_wakes) {
        // A matching event over a spent wake budget ends the wait now: the boundary reads it as expired.
        yield* trigger(sessionID)
        return false
      }
      // A wake counts a round, so it is bound by the budget like any other.
      if (StopCondition.budgetExhausted(state.round, state.max_rounds)) {
        yield* stopLoop(sessionID, LoopState.expected(state), { reason: "budget_exhausted" })
        return true
      }
      // The round, the end of the wait and the prompt it replaces change in one write.
      const flip = loops.update(sessionID, LoopState.expected(state), {
        round: state.round + 1,
        status: "active",
        wait: undefined,
        next_prompt: undefined,
        declaration: undefined,
        analyzing: undefined,
        recovery: undefined,
      })
      if (options?.evaluate === false) return (yield* flip) !== undefined
      // The write rides in the admission of the wake's message, like a dispatched round's: a message the host refuses
      // changes nothing, and a process that dies first leaves the loop as it was, with the prompt it still has to send.
      let moved = false
      yield* send({
        sessionID,
        state,
        kind: "wake",
        round: state.round + 1,
        text: LoopMessage.render({
          kind: "wake",
          round: state.round + 1,
          maxRounds: state.max_rounds,
          note: payload ?? `${wait.source}:${wait.ref?.id ?? wait.wait_id} finished.`,
          ...(state.next_prompt !== undefined ? { prompt: state.next_prompt } : {}),
          origin: state.origin.prompt,
          ...(state.intent !== undefined ? { intent: state.intent } : {}),
        }),
        epoch,
        commit: flip.pipe(
          Effect.map((written) => {
            moved = written === undefined
            return !moved
          }),
        ),
      })
      // The loop was written to between reading it and the admission: the event no longer matches this wait.
      return !moved
    })

    const turnStarted = Effect.fn("LoopRuntime.turnStarted")(function* (sessionID: SessionID) {
      yield* abortAnalysis(sessionID)
      const state = yield* loops.load(sessionID)
      if (state === undefined || (state.analyzing === undefined && state.declaration === undefined)) return
      yield* loops.update(sessionID, LoopState.expected(state), { analyzing: undefined, declaration: undefined })
    })

    return Service.of({ claim, scan, init, settled, start, act, clear, archive, resume, wake, turnStarted })
  }),
)

export * as LoopRuntime from "./runtime"
