// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { SessionV1 } from "@graphagent/core/v1/session"
import { STOP_REASON_VALUES, type Stop, type StopReason } from "@graphagent/schema/stop-reason"
import { REASONING_STATE_MESSAGE } from "@/provider/error"
import { SessionRetry } from "@/session/retry"
import { StopCondition } from "@/session/stop-condition"
import type { TurnOutcome } from "@/session/turn/decide"

/**
 * Pure tests for the unified stop condition (#1327).
 *
 * Nothing here builds a Layer, an AppLayer or a database: every input is a plain
 * object and every function under test is pure.
 */

type Err = SessionRetry.Err
type Input = StopCondition.Input
type Verdict = StopCondition.Verdict

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T

const NOW = Date.parse("2026-11-18T00:00:00Z")

function apiError(init: {
  message?: string
  statusCode?: number
  isRetryable?: boolean
  headers?: Record<string, string>
  responseBody?: string
  metadata?: Record<string, string>
}): Err {
  return new SessionV1.APIError({
    message: init.message ?? "boom",
    isRetryable: init.isRetryable ?? false,
    statusCode: init.statusCode,
    responseHeaders: init.headers,
    responseBody: init.responseBody,
    metadata: init.metadata,
  }).toObject()
}

function statusError(statusCode: number, headers?: Record<string, string>): Err {
  return apiError({ message: `status ${statusCode}`, statusCode, headers })
}

function wrap(message: unknown): Err {
  return { name: "", data: { message } }
}

describe("StopCondition.failureOf", () => {
  const cases: ReadonlyArray<{ name: string; error: Err; kind: StopCondition.FailureKind }> = [
    { name: "429", error: statusError(429), kind: "transient" },
    { name: "503", error: statusError(503), kind: "transient" },
    { name: "500", error: statusError(500), kind: "transient" },
    {
      name: "network error flagged retryable",
      error: apiError({ message: "fetch failed", isRetryable: true }),
      kind: "transient",
    },
    { name: "network error named only by its message", error: wrap("socket hang up"), kind: "transient" },
    {
      name: "incomplete protocol response",
      error: new SessionRetry.IncompleteResponseError({ message: SessionRetry.INCOMPLETE_RESPONSE_MESSAGE }).toObject(),
      kind: "transient",
    },
    {
      name: "a 4xx carrying a transient flag",
      error: apiError({ message: "try again later", statusCode: 400, isRetryable: true }),
      kind: "transient",
    },
    { name: "an unrecognised error", error: wrap("something odd happened"), kind: "transient" },
    { name: "401", error: statusError(401), kind: "permanent" },
    { name: "403", error: statusError(403), kind: "permanent" },
    { name: "a deterministic 400", error: statusError(400), kind: "permanent" },
    { name: "a deterministic 404", error: statusError(404), kind: "permanent" },
    { name: "402", error: statusError(402), kind: "permanent" },
    {
      name: "a 429 whose body reports the plan limit",
      error: apiError({
        message: "status 429",
        statusCode: 429,
        responseBody: '{"error":{"code":"1308","message":"已达到 5 小时的使用上限"}}',
      }),
      kind: "permanent",
    },
    {
      name: "a quota error flagged retryable on the wire",
      error: apiError({
        message: "Too Many Requests",
        statusCode: 429,
        isRetryable: true,
        metadata: { code: "insufficient_quota" },
      }),
      kind: "permanent",
    },
    {
      name: "the per-minute allocation reported as insufficient_quota",
      error: apiError({
        message: "Allocated quota exceeded, please increase your quota limit.",
        statusCode: 429,
        responseBody: '{"error":{"code":"insufficient_quota","message":"Allocated quota exceeded"}}',
      }),
      kind: "transient",
    },
    {
      name: "a native content-policy refusal",
      error: apiError({ message: "blocked", statusCode: 400, metadata: { code: "ContentPolicy" } }),
      kind: "permanent",
    },
    {
      name: "a 400 the table names as invalid",
      error: apiError({ statusCode: 400, responseBody: '{"error":{"type":"invalid_request_error"}}' }),
      kind: "permanent",
    },
    {
      name: "a 400 the table names as invalid, carrying a transient signal",
      error: apiError({
        statusCode: 400,
        responseBody: '{"error":{"type":"invalid_request_error","message":"upstream connection refused"}}',
      }),
      kind: "transient",
    },
    {
      name: "a provider auth error",
      error: new SessionV1.AuthError({ providerID: "test", message: "bad key" }).toObject(),
      kind: "permanent",
    },
    {
      name: "another terminal error (content filter)",
      error: new SessionV1.ContentFilterError({ message: "blocked" }).toObject(),
      kind: "permanent",
    },
    { name: "413", error: statusError(413), kind: "context" },
    {
      name: "a context overflow error",
      error: new SessionV1.ContextOverflowError({ message: "too long" }).toObject(),
      kind: "context",
    },
    {
      name: "rejected reasoning state",
      error: apiError({ message: REASONING_STATE_MESSAGE, statusCode: 400 }),
      kind: "reasoning_state",
    },
  ]

  for (const item of cases) {
    test(`${item.name} is ${item.kind}`, () => {
      expect(StopCondition.failureOf(item.error, "test", NOW).kind).toBe(item.kind)
    })
  }

  test("is transient for exactly what SessionRetry reports as retryable, plus the unrecognised", () => {
    for (const item of cases) {
      const decision = SessionRetry.classify(item.error, "test")
      const transient = StopCondition.failureOf(item.error, "test", NOW).kind === "transient"
      expect(transient).toBe(SessionRetry.retryable(item.error, "test") !== undefined || decision.branch === "fallback")
    }
  })

  test("carries the error name, status and message, and no hint unless the server gave one", () => {
    expect(StopCondition.failureOf(statusError(429), "test", NOW)).toStrictEqual({
      kind: "transient",
      code: "APIError",
      status: 429,
      message: "status 429",
    })
    expect(StopCondition.failureOf(wrap("something odd happened"), "test", NOW)).toStrictEqual({
      kind: "transient",
      code: "",
      message: "something odd happened",
    })
    expect(StopCondition.failureOf(statusError(401), "test", NOW)).toStrictEqual({
      kind: "permanent",
      code: "APIError",
      status: 401,
      message: "status 401",
    })
  })

  test("reads the server's retry hint", () => {
    const hint = (headers: Record<string, string>) =>
      StopCondition.failureOf(statusError(429, headers), "test", NOW).retry_after_ms
    expect(hint({ "retry-after-ms": "1500" })).toBe(1500)
    expect(hint({ "retry-after": "30" })).toBe(30_000)
    expect(hint({ "retry-after": "1.5" })).toBe(1500)
    expect(hint({ "retry-after": new Date(NOW + 90_000).toUTCString() })).toBe(90_000)
    // The millisecond header wins over the seconds one.
    expect(hint({ "retry-after-ms": "2500", "retry-after": "30" })).toBe(2500)
    expect(hint({ "retry-after": "0" })).toBe(0)
  })

  test("ignores a hint it cannot use", () => {
    const failure = (headers?: Record<string, string>) =>
      StopCondition.failureOf(statusError(429, headers), "test", NOW)
    const unusable: Array<Record<string, string> | undefined> = [
      undefined,
      {},
      { "x-request-id": "r1" },
      { "retry-after": "soon" },
      { "retry-after": "-5" },
      { "retry-after-ms": "never" },
      { "retry-after": new Date(NOW - 60_000).toUTCString() },
    ]
    for (const headers of unusable) expect(failure(headers)).not.toHaveProperty("retry_after_ms")
    expect(StopCondition.failureOf(wrap("rate limit"), "test", NOW)).not.toHaveProperty("retry_after_ms")
  })
})

describe("StopCondition.nextRecovery", () => {
  const transient: StopCondition.LadderFailure = { kind: "transient", code: "APIError", status: 503, message: "down" }
  const permanent: StopCondition.LadderFailure = { kind: "permanent", code: "APIError", status: 401, message: "no" }
  const reasoning: StopCondition.LadderFailure = { kind: "reasoning_state", code: "APIError", message: "bad state" }

  /** Calls the ladder the way a caller does: count each action issued, until it gives up. */
  function walk(failure: StopCondition.LadderFailure, step: StopCondition.RecoveryStep) {
    let chain: StopCondition.Chain = { attempts: 0, reset: 0, probes: 0 }
    const out: StopCondition.Recovery[] = []
    for (let i = 0; i < 12; i++) {
      const next = StopCondition.nextRecovery(chain, failure, step)
      out.push(next)
      if (next.type === "give_up") break
      chain = {
        attempts: chain.attempts + (next.type === "retry" ? 1 : 0),
        reset: chain.reset + (next.type === "reset" ? 1 : 0),
        probes: chain.probes + (next.type === "probe" ? 1 : 0),
      }
    }
    return out
  }

  test("transient: 2 retries, then probes at 60 s, 300 s and 900 s, then give up", () => {
    expect(walk(transient, "round")).toStrictEqual([
      { type: "retry" },
      { type: "retry" },
      { type: "probe", after_ms: 60_000 },
      { type: "probe", after_ms: 300_000 },
      { type: "probe", after_ms: 900_000 },
      { type: "give_up" },
    ])
  })

  test("the analysis step climbs the same transient ladder", () => {
    expect(walk(transient, "analysis")).toStrictEqual(walk(transient, "round"))
  })

  test("a longer retry_after_ms wins, and no probe waits past 1800 s", () => {
    const spent = { attempts: 2, reset: 0, probes: 0 }
    const probe = (retry_after_ms: number, probes = 0) =>
      StopCondition.nextRecovery({ ...spent, probes }, { ...transient, retry_after_ms }, "round")
    expect(probe(1_200_000)).toStrictEqual({ type: "probe", after_ms: 1_200_000 })
    expect(probe(7_200_000)).toStrictEqual({ type: "probe", after_ms: 1_800_000 })
    // A shorter hint never shortens the schedule.
    expect(probe(10_000)).toStrictEqual({ type: "probe", after_ms: 60_000 })
    expect(probe(10_000, 2)).toStrictEqual({ type: "probe", after_ms: 900_000 })
    // The hint applies to every probe, not only the first.
    expect(probe(1_200_000, 1)).toStrictEqual({ type: "probe", after_ms: 1_200_000 })
    // The hint never stretches level two, which redispatches at once.
    expect(
      StopCondition.nextRecovery(
        { attempts: 0, reset: 0, probes: 0 },
        { ...transient, retry_after_ms: 7_200_000 },
        "round",
      ),
    ).toStrictEqual({
      type: "retry",
    })
    // An unusable hint falls back to the schedule.
    expect(probe(Number.NaN)).toStrictEqual({ type: "probe", after_ms: 60_000 })
  })

  test("reasoning_state: one reset, then give up", () => {
    expect(walk(reasoning, "round")).toStrictEqual([{ type: "reset" }, { type: "give_up" }])
  })

  test("an analysis has no reset: reasoning_state gives up at once, and no step ever resets a transient", () => {
    expect(walk(reasoning, "analysis")).toStrictEqual([{ type: "give_up" }])
    for (const failure of [transient, permanent, reasoning]) {
      expect(walk(failure, "analysis").some((action) => action.type === "reset")).toBe(false)
    }
  })

  test("permanent gives up at the first failure", () => {
    expect(walk(permanent, "round")).toStrictEqual([{ type: "give_up" }])
    expect(walk(permanent, "analysis")).toStrictEqual([{ type: "give_up" }])
  })

  test("the counts are independent: a spent reset does not use up a transient's retries, and the reverse", () => {
    expect(StopCondition.nextRecovery({ attempts: 0, reset: 1, probes: 0 }, transient, "round")).toStrictEqual({
      type: "retry",
    })
    expect(StopCondition.nextRecovery({ attempts: 2, reset: 0, probes: 3 }, reasoning, "round")).toStrictEqual({
      type: "reset",
    })
  })

  test("the limits are the ones the spec fixes", () => {
    expect(StopCondition.RECOVERY_RETRY_LIMIT).toBe(2)
    expect(StopCondition.RECOVERY_RESET_LIMIT).toBe(1)
    expect(StopCondition.PROBE_DELAYS_MS).toEqual([60_000, 300_000, 900_000])
    expect(StopCondition.PROBE_MAX_DELAY_MS).toBe(1_800_000)
    expect(StopCondition.NO_PROGRESS_LIMIT).toBe(3)
  })
})

describe("StopCondition.budgetExhausted", () => {
  test("is round >= max_rounds", () => {
    expect(StopCondition.budgetExhausted(9, 10)).toBe(false)
    expect(StopCondition.budgetExhausted(10, 10)).toBe(true)
    expect(StopCondition.budgetExhausted(11, 10)).toBe(true)
  })
})

// ---- evaluate ---------------------------------------------------------------

function input(overrides: Partial<Input> = {}): Input {
  return {
    human_turn: false,
    new_human_message: false,
    review_round: false,
    running_waitable: false,
    round: 1,
    max_rounds: 10,
    no_progress_streak: 0,
    chain: { attempts: 0, reset: 0, probes: 0 },
    ...overrides,
  }
}

const stop = (value: Stop): Verdict => ({ type: "stop", ...value })
const ANALYZE: Verdict = { type: "analyze" }
const WAIT: Verdict = { type: "wait" }
const NONE: Verdict = { type: "none" }
const NEXT: Verdict = { type: "dispatch", round: "next" }
const REVIEW: Verdict = { type: "dispatch", round: "review" }
const recover = (action: StopCondition.RecoverAction): Verdict => ({ type: "recover", action })

const transient: StopCondition.Failure = {
  kind: "transient",
  code: "APIError",
  status: 503,
  message: "Service unavailable",
}
const permanent: StopCondition.Failure = {
  kind: "permanent",
  code: "ProviderAuthError",
  status: 401,
  message: "Bad key",
}
const reasoning: StopCondition.Failure = {
  kind: "reasoning_state",
  code: "APIError",
  status: 400,
  message: "Reasoning rejected",
}
const context: StopCondition.Failure = { kind: "context", code: "ContextOverflowError", message: "Too long" }
const offline: StopCondition.Failure = { kind: "transient", code: "APIError", message: "fetch failed" }

const UNAVAILABLE_503 = stop({
  reason: "provider_unavailable",
  detail: { code: "APIError", status: 503, message: "Service unavailable" },
})
const UNAVAILABLE_401 = stop({
  reason: "provider_unavailable",
  detail: { code: "ProviderAuthError", status: 401, message: "Bad key" },
})

const error = (code = "APIError"): TurnOutcome => ({ type: "error", code, retryable: true })
const completed: TurnOutcome = { type: "completed" }
const alive = { alive: true, expired: false, reviewed: false }
const expired = { alive: true, expired: true, reviewed: false }

interface Case {
  readonly name: string
  readonly input: Partial<Input>
  readonly expected: Verdict
}

/** Rule 4: every TurnOutcome has its own rows. A new outcome without a key here fails to compile. */
const TURN_CASES = {
  completed: [{ name: "passes to the analysis", input: { turn: completed }, expected: ANALYZE }],
  length: [{ name: "a cut-off answer is not a failure", input: { turn: { type: "length" } }, expected: ANALYZE }],
  tool_budget_exhausted: [
    {
      name: "an exhausted tool budget is not a failure",
      input: { turn: { type: "tool_budget_exhausted" } },
      expected: ANALYZE,
    },
  ],
  interrupted: [
    {
      name: "a restart's leftover is an ordinary boundary",
      input: { turn: { type: "interrupted" } },
      expected: ANALYZE,
    },
  ],
  cancelled: [
    {
      name: "a user abort arrives as an interrupt action",
      input: { turn: { type: "cancelled", reason: "user" }, user_action: "interrupt" },
      expected: stop({ reason: "user_interrupted" }),
    },
    {
      name: "any other cancel is an ordinary boundary",
      input: { turn: { type: "cancelled", reason: undefined } },
      expected: ANALYZE,
    },
  ],
  error: [
    {
      name: "no failure and an unclassified code: internal_error with that code",
      input: { turn: error("TypeError") },
      expected: stop({
        reason: "internal_error",
        detail: { code: "TypeError", message: "The turn failed without a provider error to classify" },
      }),
    },
    {
      name: "no failure and code context_overflow: context_exhausted",
      input: { turn: error("context_overflow") },
      expected: stop({ reason: "context_exhausted" }),
    },
    {
      name: "a context failure: context_exhausted",
      input: { turn: error(), failure: context },
      expected: stop({ reason: "context_exhausted" }),
    },
    {
      name: "a context failure stops even a human turn",
      input: { turn: error(), failure: context, human_turn: true },
      expected: stop({ reason: "context_exhausted" }),
    },
    {
      name: "a human turn with a transient failure: provider_unavailable, not recover",
      input: { turn: error(), failure: transient, human_turn: true },
      expected: UNAVAILABLE_503,
    },
    {
      name: "a human turn with a permanent failure: provider_unavailable",
      input: { turn: error(), failure: permanent, human_turn: true },
      expected: UNAVAILABLE_401,
    },
    {
      name: "a human turn with rejected reasoning: provider_unavailable, not reset",
      input: { turn: error(), failure: reasoning, human_turn: true },
      expected: stop({
        reason: "provider_unavailable",
        detail: { code: "APIError", status: 400, message: "Reasoning rejected" },
      }),
    },
    {
      name: "a failure without a status leaves it out of the detail",
      input: { turn: error(), failure: offline, human_turn: true },
      expected: stop({ reason: "provider_unavailable", detail: { code: "APIError", message: "fetch failed" } }),
    },
    {
      name: "an automatic turn with a transient failure: recover(retry)",
      input: { turn: error(), failure: transient },
      expected: recover({ type: "retry" }),
    },
    {
      name: "level two spent: recover(probe) at 60 s",
      input: { turn: error(), failure: transient, chain: { attempts: 2, reset: 0, probes: 0 } },
      expected: recover({ type: "probe", after_ms: 60_000 }),
    },
    {
      name: "the probe honours the server's hint",
      input: {
        turn: error(),
        failure: { ...transient, retry_after_ms: 1_200_000 },
        chain: { attempts: 2, reset: 0, probes: 1 },
      },
      expected: recover({ type: "probe", after_ms: 1_200_000 }),
    },
    {
      name: "the ladder is spent: provider_unavailable",
      input: { turn: error(), failure: transient, chain: { attempts: 2, reset: 0, probes: 3 } },
      expected: UNAVAILABLE_503,
    },
    {
      name: "an automatic permanent failure: provider_unavailable at once",
      input: { turn: error(), failure: permanent },
      expected: UNAVAILABLE_401,
    },
    {
      name: "an automatic turn with rejected reasoning: recover(reset)",
      input: { turn: error(), failure: reasoning },
      expected: recover({ type: "reset" }),
    },
    {
      name: "rejected reasoning after its reset: provider_unavailable",
      input: { turn: error(), failure: reasoning, chain: { attempts: 0, reset: 1, probes: 0 } },
      expected: stop({
        reason: "provider_unavailable",
        detail: { code: "APIError", status: 400, message: "Reasoning rejected" },
      }),
    },
  ],
  context_overflow: [
    {
      name: "context_exhausted",
      input: { turn: { type: "context_overflow" } },
      expected: stop({ reason: "context_exhausted" }),
    },
  ],
  content_filter: [
    {
      name: "content_refused",
      input: { turn: { type: "content_filter" } },
      expected: stop({ reason: "content_refused" }),
    },
  ],
  structured_missing: [
    {
      name: "internal_error: a loop turn never asks for structured output",
      input: { turn: { type: "structured_missing" } },
      expected: stop({
        reason: "internal_error",
        detail: {
          code: "structured_missing",
          message: "A loop turn ended without the structured output it never asked for",
        },
      }),
    },
  ],
  blocked: [
    {
      name: "none: it was refused before it began, so it is not a loop turn",
      input: { turn: { type: "blocked", by: "hook", code: "stale_rewake" } },
      expected: NONE,
    },
    {
      name: "none even when a rejection is also reported",
      input: { turn: { type: "blocked", by: "hook", code: "stale_rewake" }, user_rejected: true },
      expected: NONE,
    },
  ],
} satisfies Record<TurnOutcome["type"], Case[]>

export type EveryTurnOutcomeHasCases = Assert<Equal<keyof typeof TURN_CASES, TurnOutcome["type"]>>

const MESSAGE = "msg_basis"

/** Rule 7: the nine analysis results, five conclusions and four failures. */
const ANALYSIS_CASES = {
  continue: [
    { name: "keeps going: dispatch(next)", input: { analysis: { type: "continue", advanced: true } }, expected: NEXT },
    {
      name: "keeps going without progress below the streak limit",
      input: { analysis: { type: "continue", advanced: false }, no_progress_streak: 2 },
      expected: NEXT,
    },
    {
      name: "a declared await waits",
      input: { analysis: { type: "continue", advanced: true }, declaration: "await" },
      expected: WAIT,
    },
    {
      name: "a new human message and a declared await: analysis first, then wait",
      input: { analysis: { type: "continue", advanced: true }, new_human_message: true, declaration: "await" },
      expected: WAIT,
    },
    {
      name: "a live, unexpired wait stays put",
      input: { analysis: { type: "continue", advanced: true }, waiting: alive },
      expected: NONE,
    },
    {
      name: "after a review round with no progress: wait_expired",
      input: { analysis: { type: "continue", advanced: false }, review_round: true },
      expected: stop({ reason: "wait_expired" }),
    },
    {
      name: "after a review round with progress: dispatch(next)",
      input: { analysis: { type: "continue", advanced: true }, review_round: true },
      expected: NEXT,
    },
    {
      name: "the third no-progress analysis: no_progress",
      input: { analysis: { type: "continue", advanced: false }, no_progress_streak: 3 },
      expected: stop({ reason: "no_progress" }),
    },
    {
      name: "the round limit: budget_exhausted",
      input: { analysis: { type: "continue", advanced: true }, round: 10, max_rounds: 10 },
      expected: stop({ reason: "budget_exhausted" }),
    },
  ],
  done: [{ name: "completed", input: { analysis: { type: "done" } }, expected: stop({ reason: "completed" }) }],
  blocked: [
    {
      name: "with a running watch or task: wait",
      input: { analysis: { type: "blocked" }, running_waitable: true },
      expected: WAIT,
    },
    {
      name: "with nothing running: needs_user, open_question",
      input: { analysis: { type: "blocked" } },
      expected: stop({ reason: "needs_user", detail: { code: "open_question" } }),
    },
  ],
  goal_changed: [
    {
      name: "goal_changed, inferred, naming its message",
      input: { analysis: { type: "goal_changed", basis_message_id: MESSAGE } },
      expected: stop({ reason: "goal_changed", detail: { code: "inferred", basis_message_id: MESSAGE } }),
    },
  ],
  user_stop: [
    {
      name: "user_stopped, naming its message",
      input: { analysis: { type: "user_stop", basis_message_id: MESSAGE } },
      expected: stop({ reason: "user_stopped", detail: { basis_message_id: MESSAGE } }),
    },
  ],
  "failed:provider": [
    {
      name: "a transient failure: recover(retry) on the analysis step",
      input: { analysis: { type: "failed", cause: "provider" }, failure: transient },
      expected: recover({ type: "retry" }),
    },
    {
      name: "a transient failure after level two: recover(probe)",
      input: {
        analysis: { type: "failed", cause: "provider" },
        failure: transient,
        chain: { attempts: 2, reset: 0, probes: 0 },
      },
      expected: recover({ type: "probe", after_ms: 60_000 }),
    },
    {
      name: "a context failure: context_exhausted",
      input: { analysis: { type: "failed", cause: "provider" }, failure: context },
      expected: stop({ reason: "context_exhausted" }),
    },
    {
      name: "rejected reasoning: provider_unavailable, an analysis has no reset",
      input: { analysis: { type: "failed", cause: "provider" }, failure: reasoning },
      expected: stop({
        reason: "provider_unavailable",
        detail: { code: "APIError", status: 400, message: "Reasoning rejected" },
      }),
    },
    {
      name: "a permanent failure: provider_unavailable",
      input: { analysis: { type: "failed", cause: "provider" }, failure: permanent },
      expected: UNAVAILABLE_401,
    },
    {
      name: "the ladder spent: provider_unavailable",
      input: {
        analysis: { type: "failed", cause: "provider" },
        failure: transient,
        chain: { attempts: 2, reset: 0, probes: 3 },
      },
      expected: UNAVAILABLE_503,
    },
    {
      name: "a human turn does not apply to an analysis",
      input: { analysis: { type: "failed", cause: "provider" }, failure: transient, human_turn: true },
      expected: recover({ type: "retry" }),
    },
    {
      name: "no classified failure: internal_error",
      input: { analysis: { type: "failed", cause: "provider" } },
      expected: stop({
        reason: "internal_error",
        detail: { code: "missing_failure", message: "The analysis failed on a provider error that was not classified" },
      }),
    },
  ],
  "failed:invalid_output": [
    {
      name: "analysis_failed, invalid_output",
      input: { analysis: { type: "failed", cause: "invalid_output" } },
      expected: stop({ reason: "analysis_failed", detail: { code: "invalid_output" } }),
    },
  ],
  "failed:limit": [
    {
      name: "analysis_failed, limit",
      input: { analysis: { type: "failed", cause: "limit" } },
      expected: stop({ reason: "analysis_failed", detail: { code: "limit" } }),
    },
  ],
  "failed:cancelled": [
    {
      name: "none: the caller re-triggers the boundary",
      input: { analysis: { type: "failed", cause: "cancelled" } },
      expected: NONE,
    },
  ],
} satisfies Record<
  Exclude<StopCondition.Analysis["type"], "failed"> | `failed:${StopCondition.AnalysisFailure}`,
  Case[]
>

export type EveryAnalysisResultHasCases = Assert<
  Equal<
    keyof typeof ANALYSIS_CASES,
    Exclude<StopCondition.Analysis["type"], "failed"> | `failed:${StopCondition.AnalysisFailure}`
  >
>

/** Rules 1, 2, 3 and 5, and the guard order. */
const USER_AND_SIGNAL_CASES: Case[] = [
  { name: "/loop stop", input: { user_action: "stop" }, expected: stop({ reason: "user_stopped" }) },
  { name: "ESC", input: { user_action: "interrupt" }, expected: stop({ reason: "user_interrupted" }) },
  {
    name: "/loop <new description>",
    input: { user_action: "replace" },
    expected: stop({ reason: "goal_changed", detail: { code: "explicit" } }),
  },
  { name: "/loop done", input: { user_action: "done" }, expected: stop({ reason: "completed" }) },
  { name: "archived", input: { archived: true }, expected: stop({ reason: "session_archived" }) },
  {
    name: "a hook that asked to stop",
    input: { hook_stop: { message: "policy says stop" } },
    expected: stop({ reason: "hook_stopped", detail: { message: "policy says stop" } }),
  },
  {
    name: "a refused permission prompt or question",
    input: { user_rejected: true, turn: completed },
    expected: stop({ reason: "needs_user", detail: { code: "rejected" } }),
  },
  {
    name: "user stop beats a provider failure reported at the same time",
    input: { user_action: "stop", turn: error(), failure: transient },
    expected: stop({ reason: "user_stopped" }),
  },
  {
    name: "user stop beats everything else",
    input: { user_action: "stop", archived: true, hook_stop: { message: "x" }, user_rejected: true },
    expected: stop({ reason: "user_stopped" }),
  },
  {
    name: "archived beats a hook stop",
    input: { archived: true, hook_stop: { message: "x" } },
    expected: stop({ reason: "session_archived" }),
  },
  {
    name: "a hook stop beats the turn result",
    input: { hook_stop: { message: "x" }, turn: { type: "content_filter" } },
    expected: stop({ reason: "hook_stopped", detail: { message: "x" } }),
  },
  {
    name: "the turn result beats a rejection",
    input: { turn: { type: "content_filter" }, user_rejected: true },
    expected: stop({ reason: "content_refused" }),
  },
  {
    name: "a rejection beats an analysis result",
    input: { user_rejected: true, analysis: { type: "continue", advanced: true } },
    expected: stop({ reason: "needs_user", detail: { code: "rejected" } }),
  },
  {
    name: "done wins over the round limit",
    input: { analysis: { type: "done" }, round: 10, max_rounds: 10 },
    expected: stop({ reason: "completed" }),
  },
  {
    name: "no_progress is checked before the round limit",
    input: { analysis: { type: "continue", advanced: false }, no_progress_streak: 3, round: 10, max_rounds: 10 },
    expected: stop({ reason: "no_progress" }),
  },
  {
    name: "wait_expired is checked before no_progress",
    input: { analysis: { type: "continue", advanced: false }, review_round: true, no_progress_streak: 3 },
    expected: stop({ reason: "wait_expired" }),
  },
  {
    name: "a declared await comes before a live wait and the guardrails",
    input: {
      analysis: { type: "continue", advanced: false },
      declaration: "await",
      waiting: alive,
      review_round: true,
      no_progress_streak: 3,
      round: 10,
      max_rounds: 10,
    },
    expected: WAIT,
  },
]

/** Rule 6: the boundary has not been analyzed yet. */
const BOUNDARY_CASES: Case[] = [
  {
    name: "a new human message is analyzed even when the agent declared await",
    input: { new_human_message: true, declaration: "await", turn: completed },
    expected: ANALYZE,
  },
  {
    name: "a declared await with no new message waits",
    input: { declaration: "await", turn: completed },
    expected: WAIT,
  },
  { name: "waiting on a live, unexpired object does nothing", input: { waiting: alive }, expected: NONE },
  {
    name: "an expired wait with no review round yet: dispatch(review)",
    input: { waiting: expired },
    expected: REVIEW,
  },
  {
    name: "an expired wait at the round limit: budget_exhausted",
    input: { waiting: expired, round: 10, max_rounds: 10 },
    expected: stop({ reason: "budget_exhausted" }),
  },
  {
    name: "an expired wait whose review round already ran is analyzed",
    input: { waiting: { alive: true, expired: true, reviewed: true } },
    expected: ANALYZE,
  },
  {
    name: "a wait whose object has ended is analyzed",
    input: { waiting: { alive: false, expired: false, reviewed: false } },
    expected: ANALYZE,
  },
  { name: "nothing special: analyze", input: { turn: completed }, expected: ANALYZE },
  { name: "a periodic scan with no turn: analyze", input: {}, expected: ANALYZE },
  {
    name: "a done declaration is only evidence for the analysis",
    input: { declaration: "done", turn: completed },
    expected: ANALYZE,
  },
  {
    name: "a blocked declaration is only evidence for the analysis",
    input: { declaration: "blocked", turn: completed },
    expected: ANALYZE,
  },
]

function run(item: Case): Verdict {
  return StopCondition.evaluate(input(item.input))
}

function register(title: string, cases: ReadonlyArray<Case>) {
  describe(title, () => {
    for (const item of cases) test(item.name, () => expect(run(item)).toStrictEqual(item.expected))
  })
}

describe("StopCondition.evaluate", () => {
  register("user actions, archiving, hooks, rejection and the order between them", USER_AND_SIGNAL_CASES)
  for (const [type, cases] of Object.entries(TURN_CASES)) register(`turn outcome ${type}`, cases)
  register("a boundary that has not been analyzed", BOUNDARY_CASES)
  for (const [type, cases] of Object.entries(ANALYSIS_CASES)) register(`analysis result ${type}`, cases)

  test("covers all ten turn outcomes, and cancelled twice", () => {
    expect(Object.keys(TURN_CASES).sort()).toEqual(
      [
        "blocked",
        "cancelled",
        "completed",
        "content_filter",
        "context_overflow",
        "error",
        "interrupted",
        "length",
        "structured_missing",
        "tool_budget_exhausted",
      ].sort(),
    )
    expect(TURN_CASES.cancelled.length).toBe(2)
  })

  test("covers all nine analysis results", () => {
    expect(Object.keys(ANALYSIS_CASES).length).toBe(9)
  })

  const ALL: Case[] = [
    ...USER_AND_SIGNAL_CASES,
    ...Object.values(TURN_CASES).flat(),
    ...BOUNDARY_CASES,
    ...Object.values(ANALYSIS_CASES).flat(),
  ]

  test("every one of the 15 reasons is produced by some case", () => {
    const produced = new Set<StopReason>()
    for (const item of ALL) {
      const verdict = run(item)
      if (verdict.type === "stop") produced.add(verdict.reason)
    }
    expect([...produced].sort()).toEqual([...STOP_REASON_VALUES].sort())
  })

  test("a stop carries a detail exactly when its reason has a detail row", () => {
    // The rows of the spec's reason table: these reasons define a `detail`, and only `user_stopped`'s may be absent.
    const required: StopReason[] = [
      "goal_changed",
      "needs_user",
      "provider_unavailable",
      "hook_stopped",
      "analysis_failed",
      "internal_error",
    ]
    const optional: StopReason[] = ["user_stopped"]
    const seen = new Set<StopReason>()
    for (const item of ALL) {
      const verdict = run(item)
      if (verdict.type !== "stop") continue
      if ("detail" in verdict) {
        expect([...required, ...optional]).toContain(verdict.reason)
        seen.add(verdict.reason)
      } else {
        expect(required).not.toContain(verdict.reason)
      }
    }
    expect([...seen].sort()).toEqual([...required, ...optional].sort())
  })

  test("a stop never carries `at`: the caller stamps the time", () => {
    for (const item of ALL) expect(run(item)).not.toHaveProperty("at")
  })

  test("does not mutate its input", () => {
    const frozen = Object.freeze(
      input({
        turn: error(),
        failure: Object.freeze({ ...transient }),
        chain: Object.freeze({ attempts: 2, reset: 0, probes: 1 }),
        waiting: Object.freeze({ ...expired }),
      }),
    )
    expect(StopCondition.evaluate(frozen)).toStrictEqual(recover({ type: "probe", after_ms: 300_000 }))
  })

  test("the same input always gives the same verdict", () => {
    for (const item of ALL) expect(run(item)).toStrictEqual(run(item))
  })
})

describe("the module stays pure", () => {
  test("imports only the schema vocabulary, the retry classifier and the turn outcome type", () => {
    const source = readFileSync(new URL("../../src/session/stop-condition.ts", import.meta.url), "utf8")
    const specifiers = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1])
    expect(specifiers.sort()).toEqual(
      [
        "./retry",
        "./stop-condition",
        "./turn/decide",
        "@/provider/error",
        "@/util/record",
        "@graphagent/schema/stop-reason",
      ].sort(),
    )
    // The turn outcome is a type only, so loading this module never loads the turn machine.
    expect(source).toMatch(/^import type \{ TurnOutcome \} from "\.\/turn\/decide"$/m)
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(/)
  })
})
