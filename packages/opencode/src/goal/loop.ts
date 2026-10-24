export * as GoalLoop from "./loop"

import { Effect, Layer, Context, Option, Stream, Scope, Fiber, Cause, Duration } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { ProviderError } from "@/provider/error"
import { SessionCompaction } from "@/session/compaction"
import { SessionRetry } from "@/session/retry"
import { Goal } from "./goal"
import { GoalState } from "./state"
import { GoalJudge } from "./judge"
import { GoalPrompts } from "./prompts"
import { generateText } from "ai"
import { MessageID, SessionID } from "@/session/schema"
import { SessionAutomationLease } from "@/session/automation-lease"
import { NotFoundError } from "@/storage/storage"

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GoalLoop") {}

/**
 * Test-only injection point for the judge LLM call. When provided in the
 * Effect context, `afterIdle` uses `call` instead of the production
 * Provider → generateText path, so e2e tests can script judge verdicts
 * (continue→done) with no network or Provider credentials. Production never
 * provides it, so the Provider path is byte-for-byte unchanged.
 */
export type JudgeCallLLM = GoalJudge.CallLLM

export interface GoalLoopJudgeLLMInterface {
  readonly call: JudgeCallLLM
}

export class GoalLoopJudgeLLM extends Context.Service<GoalLoopJudgeLLM, GoalLoopJudgeLLMInterface>()(
  "@opencode/GoalLoop/JudgeLLM",
) {}

/**
 * Pure predicate: returns true when the most recent user message in `msgs`
 * is newer than the most recent assistant message.
 *
 * Used by GoalLoop.afterIdle as a strict-preempt guard: if the user has
 * inserted a new turn after the last assistant response, we must abandon
 * the pending continuation and pause the goal instead of re-prompting.
 *
 * Defensive fallback: if either side is missing, returns false (no preempt).
 *
 * Operates on MessageV2 shape (`info.time.created`).
 */
export function shouldPreempt(
  msgs: ReadonlyArray<{
    info: { role: "user" | "assistant"; time: { created: number } }
    parts?: ReadonlyArray<{ type: string; ignored?: boolean }>
  }>,
): boolean {
  let lastUserAt = -1
  let lastAsstAt = -1
  for (const m of msgs) {
    if (MessageV2.isIgnoredUser(m)) continue
    const t = m.info.time?.created
    if (typeof t !== "number") continue
    if (m.info.role === "user" && t > lastUserAt) lastUserAt = t
    else if (m.info.role === "assistant" && t > lastAsstAt) lastAsstAt = t
  }
  if (lastUserAt < 0 || lastAsstAt < 0) return false
  return lastUserAt > lastAsstAt
}

/**
 * Pure predicate for the zombie-goal freshness guard (D6). Returns true when a
 * goal is "orphaned": active, has run zero continuations (turns_used === 0),
 * was created more than FRESHNESS_THRESHOLD ago, and the initial kick never
 * produced an assistant message (provider error, model refusal, empty response).
 *
 * Used by GoalLoop.afterIdle to convert the silent orphan state into a visible,
 * recoverable pause. Without it, every subsequent afterIdle would abort at the
 * `if (!lastAssistant) return` line and the goal would sit permanently "active"
 * with no progress.
 *
 * `now` defaults to Date.now() for production; tests pass an explicit value for
 * determinism.
 */
export function isStaleZombie(
  state: { status: string; turns_used: number; created_at: number },
  hasAssistant: boolean,
  now: number = Date.now(),
): boolean {
  return (
    state.status === "active" &&
    state.turns_used === 0 &&
    !hasAssistant &&
    now - state.created_at > GoalPrompts.FRESHNESS_THRESHOLD
  )
}

// GOAL-04: the startup scan's single retry window for sessions busy at scan
// time. Short by design: a genuinely running turn ends with its own idle
// event, which the (already armed) idle subscription drives — the retry only
// covers the bootstrap→scan status race and gives the skip a visible,
// bounded end instead of a silent drop.
const SCAN_BUSY_RETRY_DELAY = "2 seconds"

const PREEMPT_PAUSE_REASON = "最新的用户消息尚未得到回复，目标已暂停。使用 /goal resume 继续。"

type AssistantError = NonNullable<SessionV1.Assistant["error"]>
type ExpectedGoal = { readonly goalID: string; readonly revision: number }

// A reset admission was invalidated between prepare and commit (goal replaced,
// user takeover, or a newer assistant boundary). The admission transaction is
// rolled back; the caller must not pause whatever goal now owns the session.
class RecoveryFenceLost extends Error {}

const expectedOf = (state: { readonly goal_id?: string; readonly revision?: number }): ExpectedGoal => ({
  goalID: state.goal_id ?? "legacy",
  revision: state.revision ?? 0,
})

// Safe, bounded diagnostic for a visible pause. Never include the provider
// response body: it can be large and may contain request material.
function describeError(error: AssistantError): string {
  const data = typeof error.data === "object" && error.data !== null ? (error.data as Record<string, unknown>) : {}
  const message = typeof data.message === "string" ? data.message.replace(/\s+/g, " ").trim().slice(0, 160) : ""
  const status = typeof data.statusCode === "number" ? ` ${data.statusCode}` : ""
  return message ? `${error.name}${status}: ${message}` : `${error.name}${status}`
}

// A compaction summary is a transcript record, never a work boundary: it must
// not hide an earlier failed turn, clear a recovery budget, or be judged.
function workAssistant(messages: ReadonlyArray<SessionV1.WithParts>) {
  return [...messages].reverse().find((message) => message.info.role === "assistant" && !message.info.summary)
}

function isAPIError(error: AssistantError): error is SessionV1.APIError {
  return SessionV1.APIError.isInstance(error)
}

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const sessions = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
    const provider = yield* Provider.Service
    const goal = yield* Goal.Service
    const status = yield* SessionStatus.Service
    const automation = yield* SessionAutomationLease.Service

    const workMessages = Effect.fn("GoalLoop.workMessages")(function* (sessionID: SessionID, limit = 20) {
      let count = limit
      for (;;) {
        const messages = yield* sessions.messages({ sessionID, limit: count })
        const work = messages.filter((message) => !MessageV2.isIgnoredUser(message))
        if (work.length >= limit || messages.length < count) return work.slice(-limit)
        count *= 2
      }
    })

    // `expected` binds a delayed decision to the Goal instance/revision it
    // observed. Recovery paths always pass it: a stale failure must never
    // pause a replacement goal.
    const pauseGoal = Effect.fnUntraced(function* (sessionID: SessionID, reason: string, expected?: ExpectedGoal) {
      const paused = yield* goal.pauseAndPublish(sessionID, reason, expected)
      if (paused) yield* automation.unregister(sessionID, { kind: "goal", id: paused.goal_id ?? "legacy" })
      return paused
    })

    // Only announce a pause that this evaluation actually committed. A stale
    // expected identity makes pauseAndPublish a no-op, and a no-op must not
    // inject a misleading "paused" line into the replacement goal's turn.
    const visiblePause = Effect.fnUntraced(function* (sessionID: SessionID, reason: string, expected?: ExpectedGoal) {
      const paused = yield* pauseGoal(sessionID, reason, expected).pipe(
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
      if (!paused) return false
      yield* promptSvc
        .prompt({ sessionID, noReply: true, parts: [{ type: "text", text: `⏸ 目标已暂停 — ${reason}` }] })
        .pipe(Effect.ignore)
      return true
    })

    // Pause ONLY the exact Goal revision this recovery observed or claimed.
    // Never reload a fresher revision as authority: a manual pause/resume/edit
    // on the same goal after the observed failure must not be overwritten by a
    // delayed decision. Callers that committed their own recovery claim pass
    // that claim's revision explicitly.
    const pauseAfterFailure = Effect.fnUntraced(function* (
      sessionID: SessionID,
      reason: string,
      expected: ExpectedGoal,
    ) {
      return yield* visiblePause(sessionID, reason, expected)
    })

    // A recovery failure can surface after the admission transaction rolled
    // back a locally observed claim. Read durable state only to choose between
    // the TWO identities this evaluation is authorized to pause: the entrance
    // observation and its own committed claim. Any other revision is a user
    // resume/edit/replacement and must not be overwritten.
    const pauseOwnedFailure = Effect.fnUntraced(function* (
      sessionID: SessionID,
      reason: string,
      entrance: ExpectedGoal,
      claim: GoalState.Info | undefined,
    ) {
      const current = yield* goal.load(sessionID)
      if (!current || current.status !== "active") return false
      const matches = (expected: ExpectedGoal) =>
        (current.goal_id ?? "legacy") === expected.goalID && (current.revision ?? 0) === expected.revision
      if (matches(entrance)) return yield* visiblePause(sessionID, reason, entrance)
      if (!claim) return false
      const claimed = { goalID: claim.goal_id ?? "legacy", revision: claim.revision ?? 0 }
      if (!matches(claimed)) return false
      // A bare goal_id+revision collision is not proof this claim committed: a
      // same-goal edit can advance a rolled-back revision to the same number.
      // Only the reset marker (same failed boundary, reset still set, same
      // attempts) proves the durable row is this evaluation's reset claim.
      const durable = current.recovery
      const claimedRecovery = claim.recovery
      if (durable?.reset !== true || !claimedRecovery) return false
      if (durable.boundary !== claimedRecovery.boundary || durable.attempts !== claimedRecovery.attempts)
        return false
      return yield* visiblePause(sessionID, reason, claimed)
    })

    // #892: an assistant turn that ended with an error is never progress. The
    // caller consults this before the judge and synthetic continue paths.
    // Return "retry" only after a bounded backoff and a fresh identity/idle
    // check; every terminal outcome is a visible pause (or a silent stop for
    // user aborts, whose cancel path already pauses the goal).
    const handleAssistantError = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      state: GoalState.Info
      messages: ReadonlyArray<SessionV1.WithParts>
      assistant: SessionV1.WithParts
      lease: SessionAutomationLease.Token
    }) {
      const info = input.assistant.info
      if (info.role !== "assistant") return "none" as const
      const error = info.error
      if (!error) return "none" as const
      if (SessionV1.AbortedError.isInstance(error)) return "stop" as const

      const expected = expectedOf(input.state)
      const failed = info.id

      // One reasoning reset per recovery chain. The claim is persisted inside
      // the admission transaction below, so a lost goal/user takeover consumes
      // no reset budget and can never continue a replacement goal.
      if (isAPIError(error) && ProviderError.isReasoningStateFailure(error.data)) {
        const compaction = Option.getOrUndefined(yield* Effect.serviceOption(SessionCompaction.Service))
        const user = [...input.messages].reverse().find((message) => message.info.role === "user")
        if (!compaction || !user || user.info.role !== "user") {
          yield* visiblePause(
            input.sessionID,
            `自动重置推理状态不可用（${describeError(error)}）。使用 /goal resume 重试。`,
            expected,
          )
          return "stop" as const
        }
        if ((yield* status.get(input.sessionID)).type !== "idle") return "stop" as const
        // Re-check user takeover at the reset boundary: the entry snapshot may
        // be stale by the time the reset path resolves its services.
        const before = yield* workMessages(input.sessionID).pipe(
          Effect.catchIf(
            (e) => NotFoundError.isInstance(e),
            () => Effect.succeed([] as SessionV1.WithParts[]),
          ),
        )
        if (shouldPreempt(before) || workAssistant(before)?.info.id !== failed) return "stop" as const

        // The compaction marker must be the newest user message so the normal
        // prompt loop identifies its compaction task and parent correctly. The
        // supported production shape is an automatic compaction (marker only)
        // that appends its own synthetic continuation after the summary; a
        // manual marker leaves a summary-only turn and NO continuation.
        const admissionMessageID = MessageID.ascending()
        const continuationText = GoalPrompts.renderContinuation({
          goal: input.state.goal,
          subgoals: input.state.subgoals ?? [],
          turnsUsed: input.state.turns_used,
          maxTurns: input.state.max_turns,
          lastJudgeReason: input.state.last_reason,
        })
        let claim:
          | { readonly tag: "allowed"; readonly state: GoalState.Info }
          | { readonly tag: "exhausted"; readonly state: GoalState.Info }
          | { readonly tag: "stale" }
          | undefined
        // GOAL-TURN-SCOPE: mark BEFORE the admission fence activates the
        // runner. An ESC in the activation gap must map to a goal pause; the
        // mark is speculative and cleared below when admission is denied or
        // the turn fails/interrupts.
        yield* goal.markTurnDriven(input.sessionID)
        const admitted = yield* automation
          .handoff(
            input.lease,
            promptSvc.prepareIfIdle(
              {
                sessionID: input.sessionID,
                messageID: admissionMessageID,
                parts: [{ type: "text", text: continuationText, synthetic: true }],
              },
              Effect.gen(function* () {
                // prepareIfIdle already holds the prompt lock and confirmed
                // idle. Re-read durable identity immediately before the atomic
                // message commit: a replacement goal or user takeover must
                // roll back the whole admission, not consume reset budget.
                const current = yield* goal.load(input.sessionID)
                if (
                  !current ||
                  current.status !== "active" ||
                  (current.goal_id ?? "legacy") !== expected.goalID ||
                  (current.revision ?? 0) !== expected.revision
                ) {
                  throw new RecoveryFenceLost()
                }
                const latestMessages = yield* workMessages(input.sessionID).pipe(
                  Effect.catchCause(() => Effect.succeed([] as SessionV1.WithParts[])),
                )
                if (
                  shouldPreempt(latestMessages.filter((message) => message.info.id !== admissionMessageID)) ||
                  workAssistant(latestMessages)?.info.id !== failed
                ) {
                  throw new RecoveryFenceLost()
                }
                const observed = yield* goal.claimRecovery(input.sessionID, expected, "reset", failed)
                if (observed.tag !== "allowed") {
                  claim = observed
                  throw new RecoveryFenceLost()
                }
                claim = observed
                const owner = user.info
                if (owner.role !== "user") throw new RecoveryFenceLost()
                yield* compaction.create({
                  sessionID: input.sessionID,
                  agent: owner.agent,
                  model: owner.model,
                  auto: true,
                })
              }),
              { continueToolBudget: true },
            ),
          )
          .pipe(
            Effect.catchCause((cause) => {
              const clear = goal.clearTurnDriven(input.sessionID)
              if (Cause.hasInterrupts(cause))
                return clear.pipe(Effect.andThen(Effect.failCause(cause)))
              if (Cause.squash(cause) instanceof RecoveryFenceLost)
                return clear.pipe(Effect.as(Option.none()))
              // The admission transaction may have rolled back the local
              // `claim` after the nested transition savepoint returned. Read
              // durable state and pause only the entrance identity or this
              // evaluation's own claimed identity; never an arbitrary fresh
              // revision (that would overwrite a same-goal user resume/edit).
              const observedClaim = claim
              if (!observedClaim) return clear.pipe(Effect.andThen(Effect.failCause(cause)))
              const claimState = observedClaim.tag === "allowed" ? observedClaim.state : undefined
              return clear.pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    const reason = `自动压缩失败（${describeError(error)}）。使用 /goal resume 重试。`
                    yield* Effect.logWarning("goal reasoning reset failed", {
                      sessionID: input.sessionID,
                      cause: Cause.pretty(cause),
                    })
                    yield* pauseOwnedFailure(input.sessionID, reason, expected, claimState).pipe(
                      Effect.catchCause((pauseCause) =>
                        Effect.logWarning("goal reset rollback pause check failed", {
                          sessionID: input.sessionID,
                          cause: Cause.pretty(pauseCause),
                        }),
                      ),
                    )
                  }),
                ),
                Effect.as(Option.none()),
              )
            }),
          )

        if (Option.isNone(admitted)) {
          // Admission was denied or invalidated. Clear the speculative mark
          // even if the catch above already did (idempotent).
          yield* goal.clearTurnDriven(input.sessionID)
          if (claim?.tag === "exhausted")
            yield* visiblePause(
              input.sessionID,
              `自动重置推理状态后再次失败（${describeError(error)}）。使用 /goal resume 重试。`,
              expectedOf(claim.state),
            )
          return "stop" as const
        }
        yield* admitted.value.pipe(
          Effect.catchCause((cause) => {
            const clear = goal.clearTurnDriven(input.sessionID)
            if (Cause.hasInterrupts(cause)) return clear.pipe(Effect.asVoid)
            return clear.pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  const reason = `自动压缩失败（${describeError(error)}）。使用 /goal resume 重试。`
                  yield* Effect.logWarning("goal reasoning reset failed", {
                    sessionID: input.sessionID,
                    cause: Cause.pretty(cause),
                  })
                  yield* visiblePause(
                    input.sessionID,
                    reason,
                    claim?.tag === "allowed" ? expectedOf(claim.state) : expected,
                  )
                }),
              ),
            )
          }),
        )
        return "stop" as const
      }

      if (!isAPIError(error)) {
        yield* visiblePause(
          input.sessionID,
          `上一轮请求失败（${describeError(error)}）。使用 /goal resume 重试。`,
          expected,
        )
        return "stop" as const
      }
      const retry = SessionRetry.retryable(error, info.providerID)
      if (!retry) {
        yield* visiblePause(
          input.sessionID,
          `上一轮请求失败（${describeError(error)}）。使用 /goal resume 重试。`,
          expected,
        )
        return "stop" as const
      }

      // Durable retry budget: two dispatched retries per recovery chain,
      // independent of transcript length, restart, and other error classes.
      const claimed = yield* goal.claimRecovery(input.sessionID, expected, "retry", failed)
      if (claimed.tag === "stale") return "stop" as const
      if (claimed.tag === "exhausted") {
        yield* visiblePause(
          input.sessionID,
          `上一轮请求连续失败 3 次（${describeError(error)}）。使用 /goal resume 重试。`,
          expectedOf(claimed.state),
        )
        return "stop" as const
      }
      // attempts is the count INCLUDING this reservation: first failure -> 1.
      yield* Effect.sleep(Duration.millis(SessionRetry.delay(claimed.state.recovery?.attempts ?? 1, error)))
      const current = yield* goal.load(input.sessionID)
      if (
        !current ||
        current.status !== "active" ||
        (current.goal_id ?? "legacy") !== expected.goalID ||
        (current.revision ?? 0) !== (claimed.state.revision ?? 0)
      )
        return "stop" as const
      if ((yield* status.get(input.sessionID)).type !== "idle") return "stop" as const
      const fresh = yield* workMessages(input.sessionID).pipe(
        Effect.catchIf(
          (e) => NotFoundError.isInstance(e),
          () => Effect.succeed([] as SessionV1.WithParts[]),
        ),
      )
      if (workAssistant(fresh)?.info.id !== failed) return "stop" as const
      if (shouldPreempt(fresh)) {
        yield* visiblePause(input.sessionID, PREEMPT_PAUSE_REASON, expectedOf(claimed.state))
        return "stop" as const
      }
      return "retry" as const
    })
    // GOAL-FP-01-04 (D-1): the instance directory the scan scopes to. The
    // state builder runs under the ScopedCache layer-build environment,
    // which does NOT include InstanceRef in production — resolving
    // InstanceState.directory inside the builder would die with "InstanceRef
    // not provided". init resolves it from its CALLER's context (instance
    // boot provides InstanceRef) and hands it to the builder through this
    // ref, set BEFORE the first InstanceState.get so the builder always
    // reads a populated value.
    const scanDirectoryRef: { current: string } = { current: "" }

    const state = yield* InstanceState.make(
      Effect.fn("GoalLoop.state")(function* (ctx) {
        yield* events.subscribe(SessionStatus.Event.Status).pipe(
          Stream.filter((evt) => evt.data.status.type === "idle"),
          // D4 (fiber lifecycle): triggerEvaluation below carries the full
          // discipline (active-goal pre-check, fork, fiber registration,
          // identity-scoped self-clean), shared verbatim with the
          // GOAL-FP-01-04 startup scan so both drivers use one path.
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const sid = evt.data.sessionID
              // DAG-LOC-01 execution-location guard: idle Status events are
              // store-global. Only the instance whose DIRECTORY owns the
              // session may drive its goal loop — the real session-row check
              // (Goal.ownsSession reads SessionTable.directory; the workflow-
              // keyed DAG authority is vacuous for goal-only sessions, P2-A).
              // Sessions without a durable row are owned vacuously (synthetic
              // test sessions; a deleted session's goal state is gone with it).
              if (!(yield* Goal.ownsSession(sid, ctx.directory))) return
              yield* triggerEvaluation(sid)
              // P2-B subscription survival: this handler now contains the
              // first defect-capable durable reads in the goal idle path
              // (Goal.ownsSession / goal.load both orDie). In effect v4,
              // Effect.ignore absorbs failures, defects AND interruptions —
              // an error here would vanish without a trace, leaving skipped
              // evaluations permanently invisible. catchCause keeps the same
              // absorption but LOGS at the boundary, so a store defect
              // degrades to a logged, skipped evaluation — never a silent one.
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("GoalLoop idle handler failed", { sessionID: evt.data.sessionID, cause }),
              ),
            ),
          ),
          Effect.forkScoped,
        )
        // GOAL-FP-01-04: the startup resume scan. The durable snapshot is
        // captured HERE — at instance boot (the builder runs at the first
        // InstanceState.get, i.e. init), awaited — not inside the forked
        // scan fiber: a fiber delayed by scheduling could query AFTER this
        // process already evaluated a goal (the session's own idle event),
        // and re-evaluating that same turn boundary would double-commit
        // turns (the R1 turns-inflation harm). Querying at boot means only
        // goals that were active BEFORE this process started are ever
        // scanned. The builder context is also the layer-build context — the
        // one the idle subscription above sees — so the scan's evaluation
        // fibers resolve the same services.
        //
        // D-2: catchCause (unlike tapError/orElseSucceed) catches Fail AND
        // Defect, so ANY query failure degrades to no-scan + a log and can
        // never kill the builder — which would close the ScopedCache entry
        // scope and take the idle subscription down with it.
        //
        // S-2: defensive read. The ref being set before the first state get
        // is an invariant of the init→builder chain, not of the type system —
        // if any future path builds this state without init setting the ref
        // first, scanning with the empty value would silently match no
        // session (a quiet no-op that looks healthy). Fail LOUD instead:
        // log an error and skip the scan. The idle subscription above stays
        // armed either way, so the event-driven path is unaffected.
        if (!scanDirectoryRef.current) {
          yield* Effect.logError("goal startup scan skipped: instance directory not resolved before state build")
          return {}
        }
        const snapshot = yield* goal.listActiveSessions(scanDirectoryRef.current).pipe(
          Effect.catchCause((cause) => {
            const empty: ReadonlyArray<SessionID> = []
            return Effect.logWarning("goal startup scan query failed", {
              directory: scanDirectoryRef.current,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(empty))
          }),
        )
        // The per-session triggers are forked after the subscription is
        // armed and into the same scope; failures are logged, never fatal to
        // init.
        yield* scanForActiveGoals(snapshot).pipe(
          Effect.catchCause((cause) =>
            // GOAL-04: instance disposal interrupts this forked scan fiber —
            // the bounded retry sleep widened that window. Same F1 discipline
            // as triggerEvaluation: interrupts stay silent, real failures log.
            Cause.hasInterrupts(cause)
              ? Effect.void
              : Effect.logWarning("goal startup scan failed", { cause: Cause.pretty(cause) }),
          ),
          Effect.forkScoped,
        )
        return {}
      }),
    )

    // D-4 (GOAL-FP-01-04 follow-up): per-process record of which goal
    // revision this process already evaluated. Written by afterIdle at TWO
    // sites: every successful updateAfterJudge commit, and the GOAL-01
    // boundary-gate hit (where the drive is restored WITHOUT a commit — the
    // map then marks the revision as drive-restored, so a duplicate scan
    // trigger on the same revision skips). Consulted ONLY by the startup-scan
    // path (scanResume) — the idle path must keep re-evaluating the same
    // revision across new turn boundaries, so the gate never applies to it.
    // Lifecycle mirrors the fibers map: overwritten by every write, deleted
    // at the same terminal points where afterIdle unregisters the goal
    // automation.
    const evaluatedRevisions = new Map<SessionID, number>()
    const inFlight = new Map<SessionID, string>()

    const afterIdle = Effect.fn("GoalLoop.afterIdle")(function* (sessionID: SessionID, scanResume?: boolean) {
      // GOAL-TURN-SCOPE: the goal-driven turn that produced this idle has
      // ended. Clear the mark up front; the continuation branch below re-marks
      // when it dispatches the next turn. This also retires a stale mark when
      // the idle came from an unrelated (non-goal) turn.
      yield* goal.clearTurnDriven(sessionID)
      const goalState = yield* goal.load(sessionID)
      if (!goalState || goalState.status !== "active") return
      // D-4 entry gate (scan path only): the boot snapshot may have gone
      // stale between triggerEvaluation's load and this entry load — an idle
      // evaluation could have committed a new revision in between, and this
      // scan evaluation would then double-commit the SAME boundary
      // (matchesExpected passes because this entry load already sees the
      // newer revision). If this process already evaluated the CURRENT
      // revision, the scan trigger is stale — skip.
      if (scanResume && evaluatedRevisions.get(sessionID) === (goalState.revision ?? 0)) return
      // A committed work boundary survives restart and control-command idle events.
      // Reuse its verdict without charging another turn, but restore a continuation
      // lost to a crash or invalidated by a subgoal edit.
      let suppressJudge = false
      if (goalState.last_judged_msg) {
        const win = yield* workMessages(sessionID).pipe(
          Effect.catchIf(
            (e) => NotFoundError.isInstance(e),
            () => Effect.succeed([] as SessionV1.WithParts[]),
          ),
        )
        const lastSeen = workAssistant(win)
        if (lastSeen && lastSeen.info.id === goalState.last_judged_msg) suppressJudge = true
      }
      const goalOwner = { kind: "goal" as const, id: goalState.goal_id ?? "legacy" }
      yield* automation.register(sessionID, goalOwner)
      const observedLease = Option.getOrUndefined(yield* automation.claim(sessionID, goalOwner))
      if (!observedLease) return

      // Zombie-goal freshness guard (D6). If the goal is active but has run
      // zero continuations and is older than FRESHNESS_THRESHOLD, the initial
      // kick may have failed silently (provider error, model refusal, empty
      // response). Without this guard every subsequent afterIdle aborts at the
      // `if (!lastAssistant) return` line below, leaving the goal permanently
      // "active" with no progress — a silent orphan. Convert that into a
      // visible, recoverable pause so the user can /goal resume.
      //
      // The probe loads only 1 message (not the full 20) so we don't pay for
      // the whole message window just to discover staleness; the stale path
      // returns early so the limit:20 load below never runs when the guard
      // fires. Uses pauseAndPublish (fiber-safe) — NOT goal.pause — because
      // we ARE the loop fiber tracked in the fibers map (same self-interrupt
      // hazard discipline as the done / shouldPreempt branches below).
      if (goalState.turns_used === 0 && Date.now() - goalState.created_at > GoalPrompts.FRESHNESS_THRESHOLD) {
        const probeMsgs = yield* workMessages(sessionID, 1).pipe(
          Effect.catchIf(
            (e) => NotFoundError.isInstance(e),
            () => Effect.succeed([] as SessionV1.WithParts[]),
          ),
        )
        const hasAssistant = workAssistant(probeMsgs) !== undefined
        if (isStaleZombie(goalState, hasAssistant)) {
          yield* pauseGoal(
            sessionID,
            `initial kick produced no assistant response within ${GoalPrompts.FRESHNESS_THRESHOLD / 1000}s — likely provider error or model refusal. Use /goal resume to retry.`,
          ).pipe(Effect.ignore)
          return
        }
      }

      // A session whose row is gone (deleted mid-goal, or a synthetic
      // session) fails page() with NotFoundError. Treat it as an empty window
      // (same pattern as MessageV2.stream) so the no-lastAssistant branch
      // below pauses visibly instead of this typed failure escaping and
      // leaving the goal permanently "active".
      const msgs = yield* workMessages(sessionID).pipe(
        Effect.catchIf(
          (e) => NotFoundError.isInstance(e),
          () => Effect.succeed([] as SessionV1.WithParts[]),
        ),
      )
      const lastAssistant = workAssistant(msgs)
      if (!lastAssistant) {
        // No assistant message in the last 20 — the conversation may have
        // been compacted or the initial kick failed after the stale-zombie
        // guard window. Pause visibly instead of silently stalling.
        const pauseMsg = "近期消息中无 assistant 回复，目标已暂停。使用 /goal resume 重试。"
        yield* visiblePause(sessionID, pauseMsg, expectedOf(goalState))
        return
      }
      // #892: an errored assistant turn is not tool progress. Decide before
      // the judge / synthetic-continue paths. A user message newer than the
      // failure is user preemption: leave it to the existing preempt branch.
      const lastError = lastAssistant.info.role === "assistant" ? lastAssistant.info.error : undefined
      const errorOutcome =
        !lastError || shouldPreempt(msgs)
          ? ("none" as const)
          : yield* handleAssistantError({
              sessionID,
              state: goalState,
              messages: msgs,
              assistant: lastAssistant,
              lease: observedLease,
            }).pipe(
              Effect.catchCause((cause) => {
                // Recovery defects (e.g. a failed compaction write) must not
                // vanish into the fiber's log-only boundary. Interrupts and
                // disposal stay silent: they are never retried or paused here.
                if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
                const reason = `上一轮请求失败后无法恢复（${describeError(lastError)}）。使用 /goal resume 重试。`
                return Effect.logWarning("goal error recovery failed", {
                  sessionID,
                  cause: Cause.pretty(cause),
                }).pipe(
                  Effect.andThen(pauseAfterFailure(sessionID, reason, expectedOf(goalState))),
                  Effect.as("stop" as const),
                )
              }),
            )
      if (errorOutcome === "stop") return
      // GOAL-01: on a boundary-gate hit the judge call and its commit are
      // skipped wholesale (see suppressJudge above) — execution falls through
      // to the shared continuation dispatch below. A retryable error recovery
      // also skips the judge: there is no new work output to classify, and
      // the retry must not consume a goal turn.
      const skipJudge = suppressJudge || errorOutcome === "retry"
      if (!skipJudge) {
        // A user message newer than the judged reply (noReply prompt, a
        // command turn, ESC before any reply, a blocked submit) means the
        // reply is no longer the work boundary: skip the judge and let the
        // idle-fenced commit below pause the goal visibly instead of
        // discarding a verdict and leaving the goal active with no driver.
        const preempted = shouldPreempt(msgs)
        const responseText = lastAssistant.parts
          .filter((p): p is Extract<(typeof lastAssistant.parts)[number], { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("\n")
          .slice(-4000)
        // When the last assistant turn produced no text (pure tool calls,
        // reasoning-only, or a submit_result with no prose), the goal should
        // NOT silently stall — the agent is making progress via tools. Skip
        // the judge (there is nothing to classify) and continue directly,
        // using a synthetic "continue" verdict so the loop dispatches the
        // next turn. Previously this was a bare `return` that left the goal
        // permanently "active" with no continuation — the agent appeared to
        // stop working on its own.
        const callLLM = Option.getOrUndefined(yield* Effect.serviceOption(GoalLoopJudgeLLM))
        const judgeText = preempted ? "" : responseText
        const verdict = judgeText
          ? yield* GoalJudge.run(
              goalState.goal,
              judgeText,
              goalState.subgoals ?? [],
              // Judge LLM call: prefer the test-injected callable so e2e tests
              // can script verdicts without Provider/network; otherwise build the
              // production Provider → generateText path.
              callLLM?.call ??
                ((opts) =>
                  Effect.gen(function* () {
                    const defaultM = yield* provider.defaultModel()
                    const small = yield* provider.getSmallModel(defaultM.providerID)
                    const model = small ?? (yield* provider.getModel(defaultM.providerID, defaultM.modelID))
                    const language = yield* provider.getLanguage(model)
                    yield* Effect.logInfo("goal judge request", {
                      sessionID,
                      "goal.judge.provider_id": model.providerID,
                      "goal.judge.model_id": model.id,
                      "goal.judge.attempt": opts.attempt,
                      "goal.judge.max_output_tokens": opts.maxTokens,
                      "goal.judge.timeout_seconds": opts.timeout,
                    })
                    const result = yield* Effect.tryPromise({
                      try: (signal) =>
                        generateText({
                          model: language,
                          system: opts.system,
                          prompt: opts.user,
                          temperature: opts.temperature,
                          maxOutputTokens: opts.maxTokens,
                          maxRetries: 0,
                          abortSignal: signal,
                        }),
                      catch: (e) => (e instanceof Error ? e : new Error("judge LLM call failed")),
                    }).pipe(Effect.timeout(`${opts.timeout} seconds`))
                    return {
                      text: result.text,
                      finishReason: result.finishReason,
                      outputTokens: result.usage.outputTokens,
                      reasoningTokens: result.usage.reasoningTokens,
                      sessionID,
                      providerID: model.providerID,
                      modelID: model.id,
                    }
                  })),
            )
          : preempted
            ? undefined
            : {
                verdict: "continue" as const,
                reason: "上一轮无文本输出（纯工具调用），跳过判定直接继续",
                parseFailed: false,
              }

        const expected = { goalID: goalState.goal_id ?? "legacy", revision: goalState.revision ?? 0 }
        const committed = Option.getOrUndefined(
          yield* automation
            .use(
              observedLease,
              promptSvc
                .withIdle(
                  sessionID,
                  Effect.gen(function* () {
                    const current = yield* workMessages(sessionID)
                    // Under the idle admission fence a newer user message is
                    // not a running turn: it is waiting for a reply that will
                    // not come (a real prompt admitted before this fence has
                    // made the Session busy). Pause, bound to the observed
                    // Goal instance and revision.
                    if (shouldPreempt(current))
                      return { preempted: yield* goal.pauseAndPublish(sessionID, PREEMPT_PAUSE_REASON, expected) }
                    const latest = workAssistant(current)
                    if (!verdict || latest?.info.id !== lastAssistant.info.id) return undefined
                    return {
                      update: yield* goal.updateAfterJudge(
                        sessionID,
                        verdict.verdict,
                        verdict.reason,
                        verdict.parseFailed,
                        expected,
                        lastAssistant.info.id,
                      ),
                    }
                  }),
                )
                .pipe(Effect.map(Option.getOrUndefined)),
            )
            .pipe(
              Effect.catchIf(
                (error) => NotFoundError.isInstance(error),
                () =>
                  pauseAfterFailure(sessionID, "评审期间会话消息已不可用，目标已暂停", expectedOf(goalState)).pipe(
                    Effect.as(Option.none()),
                  ),
              ),
            ),
        )
        if (committed && "preempted" in committed) {
          if (!committed.preempted) return
          yield* automation.unregister(sessionID, goalOwner)
          evaluatedRevisions.delete(sessionID)
          yield* promptSvc
            .prompt({
              sessionID,
              noReply: true,
              parts: [{ type: "text", text: `⏸ 目标已暂停 — ${PREEMPT_PAUSE_REASON}` }],
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("goal pause message delivery failed", { sessionID, cause: Cause.pretty(cause) }),
              ),
            )
          return
        }
        const updateResult = committed?.update
        if (!updateResult || !verdict) return

        // D-4: record the committed revision as evaluated-by-this-process
        // (every verdict — continue, done, blocked — is a completed
        // evaluation of the pre-commit state).
        evaluatedRevisions.set(sessionID, updateResult.state.revision ?? 0)

        if (!updateResult.shouldContinue) {
          yield* automation.unregister(sessionID, goalOwner)
          evaluatedRevisions.delete(sessionID)
          if (verdict.verdict === "done") {
            // GOAL-FP-01-15: the done transition has already committed when this
            // prompt runs (durable state leads presentation — the row is gone
            // and goal.updated(done)/goal.cleared are published), so a failure
            // here loses only the transcript line, never the state. Never
            // swallow it silently — log it so a lost confirmation is
            // diagnosable. No retry: a retried prompt could re-inject a "done"
            // line after the goal was re-created.
            yield* promptSvc
              .prompt({
                sessionID,
                noReply: true,
                parts: [{ type: "text", text: updateResult.message }],
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("goal done message delivery failed", {
                    sessionID,
                    cause: Cause.pretty(cause),
                  }),
                ),
              )
          } else {
            // Auto-pause branch: updateAfterJudge paused the goal due to
            // judge-parse-failure or budget exhaustion (verdict.verdict is
            // still "continue"). Without surfacing the message here, these
            // automatic pauses would be invisible to the user — updateAfterJudge
            // already saved the paused state and published goal.updated, but
            // nothing rendered the "⏸ 目标已暂停 — …" line into the transcript.
            // Emit it as a noReply part so it shows up without spawning a new
            // agent turn; the fiber then naturally terminates (no clearFiber
            // needed, see updateAfterJudge).
            yield* promptSvc
              .prompt({
                sessionID,
                noReply: true,
                parts: [{ type: "text", text: updateResult.message }],
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("goal pause message delivery failed", {
                    sessionID,
                    cause: Cause.pretty(cause),
                  }),
                ),
              )
          }
          return
        }
      } else if (suppressJudge) {
        // GOAL-01 gate hit: mark the current revision as drive-restored so a
        // duplicate scan trigger on the SAME revision is skipped by the D-4
        // gate above (at most one continuation per revision per process).
        evaluatedRevisions.set(sessionID, goalState.revision ?? 0)
      }

      const currentStatus = yield* status.get(sessionID)
      if (currentStatus.type !== "idle") return

      // Reload messages before dispatch — the pre-judge snapshot may be stale
      // (the user can send messages during the 5-30s judge latency, or during
      // the GOAL-01 judge-less fall-through).
      // Same vanished-session tolerance as the pre-judge window: NotFoundError
      // becomes an empty window (shouldPreempt is defensively false for it),
      // never a typed failure escaping the fork.
      const freshMsgs = yield* workMessages(sessionID).pipe(
        Effect.catchIf(
          (e) => NotFoundError.isInstance(e),
          () => Effect.succeed([] as SessionV1.WithParts[]),
        ),
      )

      if (shouldPreempt(freshMsgs)) {
        // Same self-interrupt hazard as the done branch above: we ARE the
        // fiber tracked in the fibers map, so goal.pause() (which internally
        // calls clearFiber) would interrupt ourselves before
        // publishGoal(paused) reaches the event bus. Use pauseAndPublish
        // which skips fiber management — the fiber naturally terminates
        // when this function returns.
        yield* pauseGoal(sessionID, "当前轮被中断", expectedOf(goalState)).pipe(Effect.ignore) // user preempted
        return
      }

      const reloadedState = yield* goal.load(sessionID)
      if (!reloadedState || reloadedState.status !== "active") return

      // Synthetic user text reaches the model while preserving its automation
      // provenance: Memory must not treat this as human input or expire the
      // current user's retrieved context. Goal events carry visible progress;
      // the full continuation does not need a repeated user-message bubble.
      const continuationText = GoalPrompts.renderContinuation({
        goal: reloadedState.goal,
        subgoals: reloadedState.subgoals ?? [],
        turnsUsed: reloadedState.turns_used,
        maxTurns: reloadedState.max_turns,
        lastJudgeReason: reloadedState.last_reason,
      })

      // Continuation dispatch can fail (provider fault, session write error,
      // …). Previously the error escaped to the fork-point Effect.ignore and
      // was swallowed, leaving the goal silently `active` with no idle event
      // to drive the next turn — a permanent, invisible stall. Catch the full
      // cause (recoverable failures + defects) and transition to a recoverable
      // paused state via the fiber-safe pauseAndPublish (goal.pause would
      // clearFiber — us — mid-publish; see the preempt branches above).
      const continuationLease = Option.getOrUndefined(yield* automation.claim(sessionID, goalOwner))
      if (!continuationLease) return
      yield* Effect.gen(function* () {
        // GOAL-TURN-SCOPE: mark BEFORE admission so the goal-turn provenance is
        // already visible the instant the continuation can start — no window
        // where an httpapi cancel slips between admit and mark. If admission
        // is refused (session not idle), clear the speculative mark.
        yield* goal.markTurnDriven(sessionID)
        // The judge continues the same user input; a manual new/resume command
        // admits a new input and owns its fresh budget in SessionPrompt.
        const admitted = yield* SessionPrompt.admitIfIdle(
          promptSvc,
          automation,
          continuationLease,
          { sessionID, parts: [{ type: "text", text: continuationText, synthetic: true }] },
          { continueToolBudget: true },
        )
        if (Option.isNone(admitted)) {
          yield* goal.clearTurnDriven(sessionID)
          return
        }
        yield* admitted.value
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            // F1: Only pause for non-interrupt causes. An interrupt (user
            // pressed ESC during continuation) is safe to drop because
            // SessionPrompt.cancel pauses goal-driven turns SYNCHRONOUSLY via
            // goal.pauseForUserCancel (prompt.ts) BEFORE state.cancel lets the
            // interrupt propagate — by the time this catchCause observes the
            // cause, the goal is already paused, and pausing again HERE would
            // double-publish. The session still ALWAYS re-emits idle
            // afterwards, which re-drives this loop: SessionRunState.cancel
            // (run-state.ts) and the runner's onIdle callback both call
            // status.set(idle), and SessionStatus.set (status.ts) publishes
            // the Status+Idle event pair unconditionally — even when the
            // session was already idle. On that next cycle shouldPreempt is
            // only the DB-failure fallback for a pauseForUserCancel that could
            // not persist. Real dispatch failures (provider fault, session
            // write error) still get the recoverable pause below.
            // F1: hasInterrupts is a structural check; Cause.interruptors only
            // collects DEFINED fiber ids and silently ignores interrupts
            // carrying none (e.g. Cause.interrupt()), which would otherwise be
            // misclassified as a dispatch failure and spuriously paused here.
            if (Cause.hasInterrupts(cause)) {
              yield* Effect.logInfo(
                "goal continuation interrupted (likely user ESC) — not pausing; cancel path already paused the goal",
              )
              return Option.none()
            }
            const errMsg = `continuation dispatch failed: ${Cause.pretty(cause)}`
            yield* Effect.logWarning("goal continuation dispatch failed", { error: Cause.pretty(cause) })
            // GOAL-FP-01-12: symmetric with every other pause site — the
            // unregister must be part of the failure transition, not
            // deferred to the trailing afterDispatch load (which a defect or
            // a concurrent replacement can skip, leaking the registration
            // until /goal clear). pauseGoal keeps the fiber-safe
            // pauseAndPublish (goal.pause would clearFiber — us —
            // mid-publish) and releases the lease registration inline.
            yield* pauseAfterFailure(sessionID, errMsg, expectedOf(reloadedState))
            return Option.none()
          }),
        ),
      )
      const afterDispatch = yield* goal.load(sessionID)
      if (!afterDispatch || afterDispatch.status !== "active") {
        yield* automation.unregister(sessionID, goalOwner)
        evaluatedRevisions.delete(sessionID)
      }

      // NOTE: We deliberately DO NOT call goal.clearLoopFiber here. The
      // promptSvc.prompt above triggers a fresh agent loop, which when it
      // goes idle will cause the SessionStatus idle subscription to fork
      // a NEW afterIdle fiber and registerLoopFiber will auto-override the
      // (naturally completed) current fiber in the map. An explicit
      // clearLoopFiber from within ourselves would race with that override
      // and could interrupt the newly registered fiber C, silently
      // stalling the goal loop.
    })

    // Shared evaluation trigger for BOTH the idle-event subscription above
    // and the GOAL-FP-01-04 startup scan below — no second evaluation path.
    //
    // D4 (fiber lifecycle): do NOT fork or register a fiber for sessions
    // without an active goal. Without this pre-check the fibers Map grows
    // once per idle event for every session that ever went idle — including
    // ones that never set a goal. afterIdle re-checks goal state internally
    // too; that internal check stays as a TOCTOU guard (goal could be cleared
    // between this load and the fork). v1.17.11: idle has no cause field;
    // afterIdle handles abort detection via shouldPreempt (user message after
    // cancel).
    //
    // D4 self-clean: when the afterIdle fiber completes naturally, remove it
    // from the fibers Map IF it is still the registered one. A newer idle
    // event may have already registered a fresh fiber (registerLoopFiber
    // interrupts + overwrites the old one); clearLoopFiberIf's identity check
    // avoids evicting the new fiber. The watcher never interrupts and
    // completes right after its target, so it does not accumulate.
    const triggerEvaluation = Effect.fnUntraced(function* (sessionID: SessionID, scanResume?: boolean) {
      const scope = yield* Scope.Scope
      const goalState = yield* goal.load(sessionID)
      if (!goalState || goalState.status !== "active") return
      const messages = yield* workMessages(sessionID).pipe(
        Effect.catchIf(
          (e) => NotFoundError.isInstance(e),
          () => Effect.succeed([] as SessionV1.WithParts[]),
        ),
      )
      const last = workAssistant(messages)
      const boundary = `${goalState.goal_id}:${goalState.revision}:${last?.info.id}`
      if (inFlight.get(sessionID) === boundary) return
      // D-4 gate (scan path only): skip when this process already evaluated
      // the CURRENT revision — the boot snapshot went stale after a
      // legitimate evaluation (e.g. the session's own idle event ran before
      // the scan fiber). This replaces the boot-snapshot revision
      // comparison: unlike that gate, a revision bumped by a non-evaluation
      // touch (pause/resume/subgoal edit — including one made by another
      // process before this boot) does NOT suppress the resume, which is
      // correct — the goal still awaits its evaluation. The idle
      // subscription never passes scanResume, so this only narrows the scan.
      // afterIdle re-checks at its own entry load (see there) to close the
      // window between this load and the fork.
      if (scanResume && evaluatedRevisions.get(sessionID) === (goalState.revision ?? 0)) return
      // GOAL-FP-01-17: never Effect.ignore here. A typed failure escaping
      // afterIdle (e.g. a messages read against a vanished session row) used
      // to vanish into ignore and left the goal permanently "active" with
      // zero logs — an invisible stall. Interrupts (fiber replacement by a
      // newer idle, scope disposal) stay silent: they are the normal
      // overwrite path, same F1 discipline as the continuation catch below.
      inFlight.set(sessionID, boundary)
      const fiber = yield* afterIdle(sessionID, scanResume).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (inFlight.get(sessionID) === boundary) inFlight.delete(sessionID)
          }),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.void
            : Effect.logWarning("goal afterIdle failed", { sessionID, cause: Cause.pretty(cause) }),
        ),
        Effect.forkIn(scope),
      )
      yield* goal.registerLoopFiber(sessionID, fiber)
      yield* Fiber.await(fiber).pipe(
        Effect.flatMap(() => goal.clearLoopFiberIf(sessionID, fiber)),
        Effect.ignore,
        Effect.forkIn(scope),
      )
    })

    // GOAL-FP-01-04: startup resume scan. GoalLoop is purely event-driven —
    // the idle subscription above is the only driver, and no component emits
    // idle for sessions that already existed at startup. An active goal that
    // survived a crash therefore sleeps until the next user interaction (the
    // D6 zombie guard also never fires: it runs inside afterIdle). The scan
    // restores the automation obligation: for each session in the boot
    // snapshot, trigger the EXISTING idle evaluation path.
    //
    // - Mutual exclusion: the lease claim is the sole authority. A session
    //   whose owner is dag is rejected by claim inside afterIdle exactly as
    //   on a real idle, and the blocked-claim re-trigger (GOAL-FP-01-02)
    //   re-evaluates it once the dag releases — the rejected trigger is
    //   harmless and self-healing.
    // - Busy sessions: the SessionStatus gate below mirrors the
    //   automation-lease re-trigger gate; a session mid-turn is skipped and
    //   will be driven by its own turn-end idle event. At startup the status
    //   map is empty (get defaults to idle), so this only filters sessions
    //   that genuinely flipped busy between bootstrap and the scan.
    //   GOAL-04: the skip is never silent — deferred sessions are logged and
    //   retried once after SCAN_BUSY_RETRY_DELAY, and a final busy state is
    //   abandoned with an explicit warning.
    // - Crash window (query → trigger): terminal changes are absorbed by the
    //   active-status re-check; non-terminal changes (already evaluated in
    //   this process) by the D-4 record gate in triggerEvaluation/afterIdle.
    // - Failures: per-session catchCause (covers Fail AND Defect) so one bad
    //   session never kills the rest of the scan; the whole scan is forked,
    //   so a failure can never kill init.
    const scanForActiveGoals = Effect.fnUntraced(function* (snapshot: ReadonlyArray<SessionID>) {
      const deferred: SessionID[] = []
      for (const sessionID of snapshot) {
        const current = yield* status.get(sessionID)
        if (current.type !== "idle") {
          // GOAL-04: never skip silently. Pre-fix this was a bare `continue`
          // — no log, no retry obligation — leaving the goal persistently
          // active but dormant with nothing to diagnose. Record the session
          // for the bounded retry below.
          deferred.push(sessionID)
          continue
        }
        yield* triggerEvaluation(sessionID, true).pipe(
          Effect.catchCause((cause) =>
            // F1 discipline (same as the outer scan handler): instance
            // disposal interrupts these per-session effects silently.
            Cause.hasInterrupts(cause)
              ? Effect.void
              : Effect.logWarning("goal startup scan failed for session", {
                  sessionID,
                  cause: Cause.pretty(cause),
                }),
          ),
        )
      }
      if (deferred.length === 0) return
      yield* Effect.logInfo("goal startup scan deferred busy sessions", {
        sessions: deferred.join(","),
      })
      // GOAL-04 retry obligation: one bounded re-check in this same scan
      // fiber (already forked + supervised, so the sleep can never kill
      // init). Sessions still busy after the window are left to their own
      // turn-end idle event — the idle subscription is armed and drives them
      // then; a session whose turn never emits idle is a runner defect
      // outside the goal module, but the warning makes the abandonment
      // visible instead of silent.
      yield* Effect.sleep(SCAN_BUSY_RETRY_DELAY)
      for (const sessionID of deferred) {
        const current = yield* status.get(sessionID)
        if (current.type !== "idle") {
          yield* Effect.logWarning(
            "goal startup scan gave up on busy session — its own idle event remains the driver",
            { sessionID, status: current.type },
          )
          continue
        }
        yield* triggerEvaluation(sessionID, true).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.void
              : Effect.logWarning("goal startup scan retry failed for session", {
                  sessionID,
                  cause: Cause.pretty(cause),
                }),
          ),
        )
      }
    })

    const init = Effect.fn("GoalLoop.init")(function* () {
      // Resolve the scan's directory scope BEFORE the first state get — the
      // builder (which runs inside that get) reads it from the ref. This
      // context carries InstanceRef (instance boot provides it); the
      // builder's does not.
      scanDirectoryRef.current = yield* InstanceState.directory
      yield* InstanceState.get(state)
    })

    return Service.of({ init })
  }),
)

export const layer = serviceLayer.pipe(Layer.provide(SessionAutomationLease.defaultLayer))

// GoalLoop.defaultLayer self-provides its construction deps. Because
// Layer.provideMerge(self, layer) requires `layer` (GoalLoop) to be
// self-contained — self's context is NOT fed into layer — every dep in the
// chain must be provided here, transitively. memoMap dedups these with the
// AppLayer's own instances so no duplicate services are created.
export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
  Layer.provide(SessionCompaction.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Goal.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

export const node = LayerNode.make(layer, [
  EventV2Bridge.node,
  Session.node,
  SessionPrompt.node,
  SessionCompaction.node,
  Provider.node,
  Goal.node,
  SessionStatus.node,
])
