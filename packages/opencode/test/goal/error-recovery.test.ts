// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mocked service slices and seeded rows use `as never` shims.
import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Option } from "effect"
import { APICallError } from "ai"
import { GoalLoop, GoalLoopJudgeLLM } from "@/goal/loop"
import { Goal } from "@/goal/goal"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { SessionAutomationLease } from "@/session/automation-lease"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { NamedError } from "@opencode-ai/core/util/error"
import { Provider } from "@/provider/provider"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { TestLLMServer, httpError, reply } from "../lib/llm-server"
import { provideTmpdirServer } from "../fixture/fixture"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelV2 } from "@opencode-ai/core/model"
import { Database } from "@opencode-ai/core/database/database"

// #892: a failed assistant turn must not be mistaken for tool progress. These
// tests drive real idle/admission sequences: each admitted recovery dispatches
// the next scripted failure, so the loop consumes its durable budget rather
// than counting seeded transcript rows as dispatches.

const providerID = ProviderV2.ID.make("test")

type PromptCall = { readonly kind: "prompt" | "continue" | "loop"; readonly noReply?: boolean; readonly text?: string }
type CompactionCall = { readonly agent: string; readonly auto: boolean }
type CompactionState = { creates: number; attempts: number; loops: number; calls: CompactionCall[] }

const userMessage = (id: string, created: number, text = "ship the feature"): SessionV1.WithParts =>
  ({
    info: {
      id,
      role: "user",
      sessionID: "ses_test",
      time: { created },
      agent: "build",
      model: { providerID, modelID: "test-model" },
    },
    parts: [{ id: `${id}-part`, type: "text", text, sessionID: "ses_test", messageID: id }],
  }) as never

const assistantMessage = (input: {
  id: string
  created: number
  error?: SessionV1.Assistant["error"]
  summary?: boolean
  text?: string
}): SessionV1.WithParts =>
  ({
    info: {
      id: input.id,
      role: "assistant",
      sessionID: "ses_test",
      time: { created: input.created },
      providerID,
      modelID: "test-model",
      mode: "build",
      agent: "build",
      path: { cwd: "/test", root: "/test" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(input.summary ? { summary: true } : {}),
      ...(input.error ? { error: input.error } : {}),
    },
    parts: input.text
      ? [{ id: `${input.id}-part`, type: "text", text: input.text, sessionID: "ses_test", messageID: input.id }]
      : [],
  }) as never

const apiError = (input: {
  message: string
  statusCode?: number
  isRetryable?: boolean
  responseBody?: string
  retryAfterMs?: number
}): SessionV1.Assistant["error"] =>
  new SessionV1.APIError({
    message: input.message,
    statusCode: input.statusCode,
    isRetryable: input.isRetryable ?? false,
    responseBody: input.responseBody,
    ...(input.retryAfterMs === undefined ? {} : { responseHeaders: { "retry-after-ms": String(input.retryAfterMs) } }),
  }).toObject() as never

// Production conversion (#866): a 400 invalid_encrypted_content response is
// persisted as a non-retryable APIError that still carries the raw body.
const reasoningError = (): SessionV1.Assistant["error"] => {
  const body = JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "invalid_encrypted_content",
      message: "The encrypted content could not be verified.",
    },
  })
  return MessageV2.fromError(
    new APICallError({
      message: "invalid encrypted content",
      url: "https://example.com",
      requestBodyValues: {},
      statusCode: 400,
      responseHeaders: { "content-type": "application/json" },
      responseBody: body,
      isRetryable: true,
    }),
    { providerID },
  ) as never
}

const transportError = () => apiError({ message: "Connection reset by server", isRetryable: true, retryAfterMs: 20 })

function harness(input: {
  readonly messages: () => SessionV1.WithParts[]
  readonly prompts: PromptCall[]
  readonly withCompaction?: boolean
  readonly compactionFails?: boolean
  readonly onContinue?: (
    input: SessionPrompt.PromptInput,
  ) => Effect.Effect<SessionV1.WithParts, never, EventV2Bridge.Service>
  readonly beforeAdmission?: Effect.Effect<void>
  readonly onPrepare?: Effect.Effect<void>
  readonly onActivate?: Effect.Effect<void>
  readonly transactionalAdmission?: boolean
  readonly afterAdmissionRollback?: Effect.Effect<void>
}) {
  const judge = { calls: 0 }
  const compaction: CompactionState = { creates: 0, attempts: 0, loops: 0, calls: [] as CompactionCall[] }
  const admissions: SessionPrompt.PromptInput[] = []
  const sessionMock = Layer.succeed(Session.Service, {
    messages: () => Effect.sync(() => input.messages()),
  } as never)
  const status = (sessionID: SessionID) =>
    Effect.gen(function* () {
      const svc = yield* SessionStatus.Service
      return yield* svc.get(sessionID)
    })
  const defaultValue = () => Effect.succeed(assistantMessage({ id: `continue-${Date.now()}`, created: Date.now() }))
  const promptMock = Layer.succeed(SessionPrompt.Service, {
    prompt: (prompt: SessionPrompt.PromptInput) => {
      input.prompts.push({
        kind: "prompt",
        noReply: prompt.noReply,
        text: prompt.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
      })
      return Effect.succeed(assistantMessage({ id: "prompt-reply", created: Date.now() }))
    },
    promptIfIdle: (prompt: SessionPrompt.PromptInput) =>
      Effect.suspend(() => {
        input.prompts.push({ kind: "continue" })
        admissions.push(prompt)
        return (input.onContinue?.(prompt) ?? defaultValue()).pipe(Effect.map(Option.some))
      }),
    prepareIfIdle: (prompt: SessionPrompt.PromptInput, persistAdmission?: Effect.Effect<void>) =>
      Effect.gen(function* () {
        if (input.onPrepare) yield* input.onPrepare
        if ((yield* status(prompt.sessionID)).type !== "idle") return Option.none()
        if (input.beforeAdmission) yield* input.beforeAdmission
        if (persistAdmission) {
          if (input.transactionalAdmission) {
            const database = yield* Database.Service
            yield* database.db
              .transaction(() => persistAdmission, { behavior: "immediate" })
              .pipe(
                Effect.orDie,
                Effect.catchCause((cause) =>
                  (input.afterAdmissionRollback ?? Effect.void).pipe(Effect.andThen(Effect.failCause(cause))),
                ),
              )
          } else {
            yield* persistAdmission
          }
        }
        return Option.some({
          activate: input.onActivate ?? Effect.void,
          result: Effect.suspend(() => {
            input.prompts.push({ kind: "continue" })
            admissions.push(prompt)
            return input.onContinue?.(prompt) ?? defaultValue()
          }),
          abort: Effect.void,
        })
      }),
    withIdle: (sessionID: SessionID, work: Effect.Effect<unknown>) =>
      Effect.gen(function* () {
        if ((yield* status(sessionID)).type !== "idle") return Option.none()
        return Option.some(yield* work)
      }),
    loop: () => {
      input.prompts.push({ kind: "loop" })
      compaction.loops += 1
      return Effect.succeed(assistantMessage({ id: "loop-reply", created: Date.now() }))
    },
  } as never)
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.sync(() => {
          judge.calls += 1
          return JSON.stringify({ verdict: "continue", reason: "more work" })
        }),
    }),
  )
  const compactionMock = input.withCompaction
    ? Layer.succeed(SessionCompaction.Service, {
        create: (create: { agent: string; auto: boolean }) => {
          compaction.attempts += 1
          if (input.compactionFails) return Effect.die(new Error("compaction write failed"))
          return Effect.sync(() => {
            compaction.creates += 1
            compaction.calls.push({ agent: create.agent, auto: create.auto })
          })
        },
      } as never)
    : Layer.empty
  const layer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(promptMock),
    Layer.provide(Layer.succeed(Provider.Service, {} as never)),
    Layer.provide(judgeMock),
    Layer.provideMerge(compactionMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provideMerge(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
    Layer.provideMerge(SessionAutomationLease.defaultLayer),
    Layer.provideMerge(Database.defaultLayer),
  )
  return { layer, judge, compaction, admissions }
}

const reset = (prompts: PromptCall[], compaction: CompactionState) => {
  prompts.length = 0
  compaction.creates = 0
  compaction.attempts = 0
  compaction.loops = 0
  compaction.calls.length = 0
}

const idle = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    yield* events.publish(SessionStatus.Event.Status, { sessionID, status: { type: "idle" } })
  })

const paused = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    return yield* pollWithTimeout(
      Effect.gen(function* () {
        const current = yield* goal.load(sessionID)
        return current?.status === "paused" ? current : undefined
      }),
      "the goal was not paused",
      "8 seconds",
    )
  })

describe("GoalLoop — #892 failed assistant turns", () => {
  const prompts: PromptCall[] = []
  let window: SessionV1.WithParts[] = []
  let continuation = 0
  let gate: Deferred.Deferred<void> | undefined
  let gateReached: Deferred.Deferred<void> | undefined
  let beforeAdmission: Effect.Effect<void> | undefined
  let onPrepare: Effect.Effect<void> | undefined
  let onActivate: Effect.Effect<void> | undefined
  let onContinue:
    ((input: SessionPrompt.PromptInput) => Effect.Effect<SessionV1.WithParts, never, EventV2Bridge.Service>) | undefined
  const { layer, judge, compaction, admissions } = harness({
    messages: () => window,
    prompts,
    withCompaction: true,
    onContinue: (input) =>
      onContinue ? onContinue(input) : Effect.succeed(assistantMessage({ id: "ok", created: Date.now() })),
    beforeAdmission: Effect.suspend(() => beforeAdmission ?? Effect.void),
    onPrepare: Effect.suspend(() => onPrepare ?? Effect.void),
    onActivate: Effect.suspend(() => onActivate ?? Effect.void),
  })
  const it = testEffect(layer)

  const setup = (failure: SessionV1.Assistant["error"], extra: SessionV1.WithParts[] = []) =>
    Effect.gen(function* () {
      reset(prompts, compaction)
      admissions.length = 0
      judge.calls = 0
      continuation = 0
      gate = undefined
      gateReached = undefined
      beforeAdmission = undefined
      onPrepare = undefined
      onActivate = undefined
      onContinue = undefined
      window = [
        userMessage("user-1", Date.now() + 60_000),
        ...extra,
        assistantMessage({ id: "assistant-1", created: Date.now() + 60_100, error: failure }),
      ]
      const goal = yield* Goal.Service
      const loop = yield* GoalLoop.Service
      yield* loop.init()
      const sessionID = SessionID.descending()
      yield* goal.set(sessionID, "ship the feature", 10)
      yield* Effect.yieldNow
      return { goal, sessionID }
    })

  it.instance("a non-retryable APIError 400 pauses visibly, without a continuation or a goal turn", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup(apiError({ message: "invalid request", statusCode: 400 }))
      yield* idle(sessionID)
      const current = yield* paused(sessionID)
      expect(String(current.paused_reason)).toContain("APIError")
      expect(String(current.paused_reason)).toContain("400")
      expect(String(current.paused_reason)).toContain("/goal resume")
      expect(current.turns_used).toBe(0)
      expect(continuation).toBe(0)
      expect(prompts.some((call) => call.kind === "prompt" && call.noReply && call.text?.includes("目标已暂停"))).toBe(
        true,
      )
      expect(judge.calls).toBe(0)
      expect(compaction.creates).toBe(0)
      expect((yield* goal.load(sessionID))?.status).toBe("paused")
    }),
  )

  it.instance("UnknownError pauses visibly and names the error", () =>
    Effect.gen(function* () {
      const { sessionID } = yield* setup(new NamedError.Unknown({ message: "provider exploded" }).toObject() as never)
      yield* idle(sessionID)
      const current = yield* paused(sessionID)
      expect(String(current.paused_reason)).toContain("UnknownError")
      expect(String(current.paused_reason)).toContain("provider exploded")
      expect(current.turns_used).toBe(0)
      expect(continuation).toBe(0)
      expect(judge.calls).toBe(0)
    }),
  )

  it.instance("a user-aborted turn is not continued and not paused by the goal loop", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup(
        new SessionV1.AbortedError({ message: "aborted by user" }).toObject() as never,
      )
      yield* idle(sessionID)
      yield* Effect.sleep("300 millis")
      expect((yield* goal.load(sessionID))?.status).toBe("active")
      expect(prompts).toHaveLength(0)
      expect(judge.calls).toBe(0)
    }),
  )

  it.instance("three consecutive transport failures dispatch exactly two recovery turns, then pause", () =>
    Effect.gen(function* () {
      const { sessionID } = yield* setup(transportError())
      onContinue = () =>
        Effect.gen(function* () {
          continuation += 1
          const next = assistantMessage({
            id: `assistant-${continuation + 1}`,
            created: Date.now() + 60_200 + continuation,
            error: transportError(),
          })
          window = [...window, next]
          yield* idle(sessionID)
          return next
        })
      yield* idle(sessionID)
      const current = yield* paused(sessionID)
      expect(continuation).toBe(2)
      expect(String(current.paused_reason)).toContain("连续失败 3 次")
      expect(current.turns_used).toBe(0)
      expect(judge.calls).toBe(0)
      expect(compaction.creates).toBe(0)
    }),
  )

  it.instance("the durable retry budget survives a transcript longer than the work window", () =>
    Effect.gen(function* () {
      const noise = Array.from({ length: 25 }, (_, index) => [
        userMessage(`noise-user-${index}`, Date.now() + 1_000 + index * 2),
        assistantMessage({
          id: `noise-assistant-${index}`,
          created: Date.now() + 1_002 + index * 2,
          text: "progress",
        }),
      ]).flat()
      const { goal, sessionID } = yield* setup(transportError(), noise)
      let count = 0
      onContinue = () =>
        Effect.gen(function* () {
          count += 1
          const next = assistantMessage({
            id: `long-assistant-${count}`,
            created: Date.now() + 70_200 + count,
            error: transportError(),
          })
          window = [...window, next]
          yield* idle(sessionID)
          return next
        })
      yield* idle(sessionID)
      const current = yield* paused(sessionID)
      expect(count).toBe(2)
      expect(String(current.paused_reason)).toContain("连续失败 3 次")
      expect(current.turns_used).toBe(0)
      expect((yield* goal.load(sessionID))?.status).toBe("paused")
    }),
  )

  it.instance("a first retryable error waits for backoff, then retries without consuming a goal turn", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup(
        apiError({ message: "Connection reset by server", isRetryable: true, retryAfterMs: 120 }),
      )
      yield* idle(sessionID)
      yield* Effect.sleep("50 millis")
      expect(prompts.filter((call) => call.kind === "continue")).toHaveLength(0)
      yield* pollWithTimeout(
        Effect.sync(() => (prompts.filter((call) => call.kind === "continue").length === 1 ? true : undefined)),
        "the retry was never dispatched",
        "5 seconds",
      )
      const current = yield* goal.load(sessionID)
      expect(current?.status).toBe("active")
      expect(Number(current?.turns_used)).toBe(0)
      expect(judge.calls).toBe(0)
    }),
  )

  it.instance("a reasoning-state failure resets once through the automatic compaction continuation", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup(reasoningError())
      onContinue = () => {
        continuation += 1
        const next = assistantMessage({ id: "after-reset", created: Date.now() + 60_200, text: "recovered" })
        window = [...window, next]
        return Effect.succeed(next)
      }
      yield* idle(sessionID)
      yield* pollWithTimeout(
        Effect.sync(() => (prompts.filter((call) => call.kind === "continue").length > 0 ? true : undefined)),
        "the reasoning reset never dispatched a continuation",
        "5 seconds",
      )
      expect(compaction.creates).toBe(1)
      expect(compaction.calls[0]).toEqual({ agent: "build", auto: true })
      expect(compaction.loops).toBe(0)
      expect(judge.calls).toBe(0)
      const current = yield* goal.load(sessionID)
      expect(current?.status).toBe("active")
      expect(Number(current?.turns_used)).toBe(0)
      expect(admissions).toHaveLength(1)
    }),
  )

  it.instance("a second reasoning-state failure pauses instead of resetting again", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup(reasoningError())
      onContinue = () =>
        Effect.gen(function* () {
          continuation += 1
          const next = assistantMessage({
            id: "second-reasoning-failure",
            created: Date.now() + 60_200,
            error: reasoningError(),
          })
          window = [...window, next]
          yield* idle(sessionID)
          return next
        })
      yield* idle(sessionID)
      const current = yield* paused(sessionID)
      expect(continuation).toBe(1)
      expect(compaction.creates).toBe(1)
      expect(String(current.paused_reason)).toContain("自动重置推理状态后再次失败")
      expect(current.turns_used).toBe(0)
      expect(judge.calls).toBe(0)
      expect((yield* goal.load(sessionID))?.status).toBe("paused")
    }),
  )

  it.instance("an intervening transport failure does not reset the one-shot reasoning budget", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup(reasoningError())
      let phase = 0
      onContinue = () =>
        Effect.gen(function* () {
          continuation += 1
          phase += 1
          const next =
            phase === 1
              ? assistantMessage({
                  id: "intervening-transport",
                  created: Date.now() + 60_200,
                  error: transportError(),
                })
              : assistantMessage({
                  id: "later-reasoning",
                  created: Date.now() + 60_300,
                  error: reasoningError(),
                })
          window = [...window, next]
          yield* idle(sessionID)
          return next
        })
      yield* idle(sessionID)
      const current = yield* paused(sessionID)
      // One reset, then one retry for the intervening transport failure. The
      // later reasoning failure must reuse the already-spent reset budget.
      expect(continuation).toBe(2)
      expect(compaction.creates).toBe(1)
      expect(String(current.paused_reason)).toContain("自动重置推理状态后再次失败")
      expect(current.turns_used).toBe(0)
      expect(judge.calls).toBe(0)
      expect((yield* goal.load(sessionID))?.status).toBe("paused")
    }),
  )

  it.instance("a summary cannot hide the failed turn or count as successful work", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup(reasoningError())
      onContinue = () =>
        Effect.gen(function* () {
          continuation += 1
          const summary = assistantMessage({
            id: "summary-only",
            created: Date.now() + 60_200,
            summary: true,
            text: "compact summary",
          })
          window = [...window, summary]
          yield* idle(sessionID)
          return summary
        })
      yield* idle(sessionID)
      const current = yield* paused(sessionID)
      expect(continuation).toBe(1)
      expect(compaction.creates).toBe(1)
      expect(judge.calls).toBe(0)
      expect(current.turns_used).toBe(0)
      expect(String(current.paused_reason)).toContain("自动重置推理状态后再次失败")
      expect((yield* goal.load(sessionID))?.status).toBe("paused")
    }),
  )

  it.instance("a duplicate idle during backoff does not dispatch a second retry", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup(
        apiError({ message: "Connection reset by server", isRetryable: true, retryAfterMs: 200 }),
      )
      yield* idle(sessionID)
      yield* Effect.sleep("100 millis")
      yield* idle(sessionID)
      yield* Effect.sleep("1 second")
      expect(prompts.filter((call) => call.kind === "continue")).toHaveLength(1)
      expect(Number((yield* goal.load(sessionID))?.turns_used)).toBe(0)
    }),
  )

  it.instance("a user takeover during backoff is honored instead of sending the retry", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup(
        apiError({ message: "Connection reset by server", isRetryable: true, retryAfterMs: 300 }),
      )
      yield* idle(sessionID)
      yield* Effect.sleep("80 millis")
      window = [...window, userMessage("user-2", Date.now() + 80_000, "stop and do this instead")]
      const status = yield* SessionStatus.Service
      yield* status.set(sessionID, { type: "busy" })
      yield* Effect.sleep("1 second")
      expect(continuation).toBe(0)
      expect((yield* goal.load(sessionID))?.status).toBe("active")
    }),
  )

  it.instance("replacing the goal during backoff never pauses the replacement", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup(
        apiError({ message: "Connection reset by server", isRetryable: true, retryAfterMs: 300 }),
      )
      yield* idle(sessionID)
      yield* Effect.sleep("80 millis")
      const replacement = yield* goal.set(sessionID, "replacement goal", 10)
      yield* Effect.sleep("1 second")
      expect(continuation).toBe(0)
      const current = yield* goal.load(sessionID)
      expect(current?.goal_id).toBe(replacement.goal_id)
      expect(current?.status).toBe("active")
      expect(current?.goal).toBe("replacement goal")
    }),
  )

  it.instance("recovery budgets are durable Goal state and reset only on a user resume", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.descending()
      const initial = yield* goal.set(sessionID, "durable recovery", 10)
      const expected = { goalID: initial.goal_id ?? "legacy", revision: initial.revision ?? 0 }

      const first = yield* goal.claimRecovery(sessionID, expected, "retry", "failure-1")
      expect(first.tag).toBe("allowed")
      if (first.tag !== "allowed") throw new Error("first retry was not allowed")
      expect(first.state.recovery?.attempts).toBe(1)

      const second = yield* goal.claimRecovery(
        sessionID,
        { goalID: first.state.goal_id ?? "legacy", revision: first.state.revision ?? 0 },
        "retry",
        "failure-2",
      )
      expect(second.tag).toBe("allowed")
      if (second.tag !== "allowed") throw new Error("second retry was not allowed")
      expect(second.state.recovery?.attempts).toBe(2)

      const third = yield* goal.claimRecovery(
        sessionID,
        { goalID: second.state.goal_id ?? "legacy", revision: second.state.revision ?? 0 },
        "retry",
        "failure-3",
      )
      expect(third.tag).toBe("exhausted")

      const reset = yield* goal.claimRecovery(
        sessionID,
        { goalID: second.state.goal_id ?? "legacy", revision: second.state.revision ?? 0 },
        "reset",
        "reasoning-1",
      )
      expect(reset.tag).toBe("allowed")
      if (reset.tag !== "allowed") throw new Error("reset was not allowed")
      const secondReset = yield* goal.claimRecovery(
        sessionID,
        { goalID: reset.state.goal_id ?? "legacy", revision: reset.state.revision ?? 0 },
        "reset",
        "reasoning-2",
      )
      expect(secondReset.tag).toBe("exhausted")

      const stale = yield* goal.claimRecovery(sessionID, expected, "retry", "stale")
      expect(stale.tag).toBe("stale")
      expect((yield* goal.load(sessionID))?.recovery?.attempts).toBe(2)

      yield* goal.pause(sessionID, "user pause")
      const resumed = yield* goal.resume(sessionID)
      expect(resumed?.recovery).toBeUndefined()
      const afterResume = yield* goal.claimRecovery(
        sessionID,
        { goalID: resumed?.goal_id ?? "legacy", revision: resumed?.revision ?? 0 },
        "reset",
        "reasoning-after-resume",
      )
      expect(afterResume.tag).toBe("allowed")
    }),
  )

  it.instance("the goal-turn mark is visible before the reset admission activates", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup(reasoningError())
      let markedAtActivation: boolean | undefined
      onActivate = goal.isTurnDriven(sessionID).pipe(
        Effect.tap((marked) => Effect.sync(() => (markedAtActivation = marked))),
        Effect.asVoid,
      )
      onContinue = () => {
        const next = assistantMessage({ id: "after-reset", created: Date.now() + 60_200, text: "recovered" })
        window = [...window, next]
        return Effect.succeed(next)
      }
      yield* idle(sessionID)
      yield* pollWithTimeout(
        Effect.sync(() => (markedAtActivation === undefined ? undefined : true)),
        "the reset admission never activated",
        "5 seconds",
      )
      expect(markedAtActivation).toBe(true)
      expect((yield* goal.load(sessionID))?.status).toBe("active")
    }),
  )

  it.instance("a denied reset admission clears the speculative goal-turn mark", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup(reasoningError())
      const sessionStatus = yield* SessionStatus.Service
      let markedBeforeDeny: boolean | undefined
      onPrepare = Effect.gen(function* () {
        markedBeforeDeny = yield* goal.isTurnDriven(sessionID)
        yield* sessionStatus.set(sessionID, { type: "busy" })
      })
      yield* idle(sessionID)
      yield* pollWithTimeout(
        Effect.sync(() => (markedBeforeDeny === undefined ? undefined : true)),
        "the denied admission never prepared",
        "5 seconds",
      )
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const marked = yield* goal.isTurnDriven(sessionID)
          const current = yield* goal.load(sessionID)
          return !marked && current?.status === "active" ? true : undefined
        }),
        "a denied admission left the speculative mark behind",
        "5 seconds",
      )
      expect(markedBeforeDeny).toBe(true)
      expect(compaction.creates).toBe(0)
      expect(continuation).toBe(0)
    }),
  )

  it.instance("a manual pause/resume of the same goal during a failing reset is not overwritten", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup(reasoningError())
      gate = yield* Deferred.make<void>()
      gateReached = yield* Deferred.make<void>()
      onContinue = () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(gateReached!, undefined)
          yield* Deferred.await(gate!)
          return yield* Effect.die(new Error("reset continuation failed"))
        })
      yield* idle(sessionID)
      yield* pollWithTimeout(
        Effect.sync(() => (gateReached ? true : undefined)),
        "the reset continuation never started",
        "5 seconds",
      )
      // A manual pause unregisters the goal; keep the session busy so that
      // automation unregister cannot emit a fresh idle evaluation that would
      // race this test's assertion.
      const sessionStatus = yield* SessionStatus.Service
      yield* sessionStatus.set(sessionID, { type: "busy" })
      const paused = yield* goal.controlDuringTurn(sessionID, { action: "pause", reason: "manual pause" })
      if (!paused.changed) throw new Error("manual pause did not change the goal")
      const resumed = yield* goal.controlDuringTurn(sessionID, { action: "resume" })
      if (!resumed.changed) throw new Error("manual resume did not change the goal")
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.sleep("500 millis")
      const current = yield* goal.load(sessionID)
      expect(current?.goal_id).toBe(resumed.state.goal_id)
      expect(current?.status).toBe("active")
      expect(prompts.some((call) => call.text?.includes("自动压缩失败"))).toBe(false)
    }),
  )

  it.instance("replacing the goal during the reset admission rolls back the reset", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup(reasoningError())
      gate = yield* Deferred.make<void>()
      gateReached = yield* Deferred.make<void>()
      beforeAdmission = Effect.gen(function* () {
        yield* Deferred.succeed(gateReached!, undefined)
        yield* Deferred.await(gate!)
      })
      yield* idle(sessionID)
      yield* pollWithTimeout(
        Effect.sync(() => (gateReached ? true : undefined)),
        "the reset admission never reached its fence",
        "5 seconds",
      )
      const sessionStatus = yield* SessionStatus.Service
      yield* sessionStatus.set(sessionID, { type: "busy" })
      const replacement = yield* goal.set(sessionID, "replacement goal", 10)
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.sleep("500 millis")
      expect(compaction.creates).toBe(0)
      const current = yield* goal.load(sessionID)
      expect(current?.goal_id).toBe(replacement.goal_id)
      expect(current?.status).toBe("active")
      expect(current?.goal).toBe("replacement goal")
    }),
  )

  it.instance("a user takeover during the reset admission rolls back the reset", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup(reasoningError())
      gate = yield* Deferred.make<void>()
      gateReached = yield* Deferred.make<void>()
      beforeAdmission = Effect.gen(function* () {
        yield* Deferred.succeed(gateReached!, undefined)
        yield* Deferred.await(gate!)
      })
      yield* idle(sessionID)
      yield* pollWithTimeout(
        Effect.sync(() => (gateReached ? true : undefined)),
        "the reset admission never reached its fence",
        "5 seconds",
      )
      window = [...window, userMessage("user-takeover", Date.now() + 90_000, "I am taking over")]
      const status = yield* SessionStatus.Service
      yield* status.set(sessionID, { type: "busy" })
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.sleep("500 millis")
      expect(compaction.creates).toBe(0)
      expect((yield* goal.load(sessionID))?.status).toBe("active")
    }),
  )
})

describe("GoalLoop — #892 reasoning reset failure is visible", () => {
  const prompts: PromptCall[] = []
  let window: SessionV1.WithParts[] = []
  const { layer, judge, compaction } = harness({
    messages: () => window,
    prompts,
    withCompaction: true,
    compactionFails: true,
  })
  const it = testEffect(layer)

  it.instance("pauses visibly when the compaction write defects", () =>
    Effect.gen(function* () {
      reset(prompts, compaction)
      window = [
        userMessage("user-1", Date.now() + 60_000),
        assistantMessage({ id: "assistant-1", created: Date.now() + 60_001, error: reasoningError() }),
      ]
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      yield* loop.init()
      const sessionID = SessionID.descending()
      yield* goal.set(sessionID, "ship the feature", 10)
      yield* Effect.yieldNow
      yield* idle(sessionID)
      const current = yield* paused(sessionID)
      expect(String(current.paused_reason)).toContain("自动压缩失败")
      expect(prompts.filter((call) => call.kind === "continue")).toHaveLength(0)
      expect(judge.calls).toBe(0)
    }),
  )
})

describe("GoalLoop — #892 reasoning reset without a compaction service", () => {
  const prompts: PromptCall[] = []
  let window: SessionV1.WithParts[] = []
  const { layer, judge, compaction } = harness({ messages: () => window, prompts })
  const it = testEffect(layer)

  it.instance("pauses visibly instead of looping without a reset", () =>
    Effect.gen(function* () {
      reset(prompts, compaction)
      window = [
        userMessage("user-1", Date.now() + 60_000),
        assistantMessage({ id: "assistant-1", created: Date.now() + 60_001, error: reasoningError() }),
      ]
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      yield* loop.init()
      const sessionID = SessionID.descending()
      yield* goal.set(sessionID, "ship the feature", 10)
      yield* Effect.yieldNow
      yield* idle(sessionID)
      const current = yield* paused(sessionID)
      expect(String(current.paused_reason)).toContain("自动重置推理状态不可用")
      expect(compaction.creates).toBe(0)
      expect(judge.calls).toBe(0)
    }),
  )
})

const reasoningBody = {
  type: "error",
  error: {
    type: "invalid_request_error",
    code: "invalid_encrypted_content",
    message: "The encrypted content could not be verified.",
  },
}

const recoveryConfig = (url: string) => ({
  compaction: { auto: false, tail_turns: 2, preserve_recent_tokens: 200 },
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai",
      models: {
        "test-model": {
          id: "gpt-test",
          name: "Test Model",
          attachment: false,
          reasoning: true,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100_000, output: 10_000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

// Real production path: a fake upstream rejects replayed opaque reasoning with
// the production 400 body. The reset must compact, then send a continuation
// whose request omits the rejected ciphertext; a second rejection pauses with
// no second reset.
describe("GoalLoop — #892 real encrypted-reasoning rejection sequence", () => {
  const judgeCalls = { value: 0 }
  const it = testEffect(
    Layer.mergeAll(
      TestLLMServer.layer,
      GoalLoop.defaultLayer,
      SessionPrompt.defaultLayer,
      Session.defaultLayer,
      Goal.defaultLayer,
      EventV2Bridge.defaultLayer,
      SessionStatus.defaultLayer,
      SessionCompaction.defaultLayer,
      Provider.defaultLayer,
      Layer.succeed(GoalLoopJudgeLLM, {
        call: () =>
          Effect.sync(() => {
            judgeCalls.value += 1
            return JSON.stringify({ verdict: "continue", reason: "more work" })
          }),
      }),
      CrossSpawnSpawner.defaultLayer,
    ),
  )

  it.live("resets once with a clean continuation, then pauses on the second rejection", () =>
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          judgeCalls.value = 0
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const goal = yield* Goal.Service
          const loop = yield* GoalLoop.Service
          const chat = yield* sessions.create({ title: "encrypted reasoning recovery" })
          const ref = {
            providerID: ProviderV2.ID.make("test"),
            modelID: ModelV2.ID.make("test-model"),
          }
          yield* llm.push(reply().reason("think first").encryptedReason("rejected-cipher").text("first answer").stop())
          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "first question" }],
          })
          const first = yield* sessions.messages({ sessionID: chat.id })
          expect(JSON.stringify(first)).toContain("rejected-cipher")

          // The next continuation replays the encrypted reasoning and is
          // rejected by the fake upstream.
          yield* llm.pushMatch(
            (hit) => JSON.stringify(hit.body).includes("rejected-cipher"),
            httpError(400, reasoningBody),
          )
          // The automatic compaction summarizes without opaque reasoning.
          yield* llm.push(reply().text("compact summary: preserve standing goal intent 7f3a").stop())
          // The post-compaction continuation is clean but is rejected again;
          // the reset budget must already be spent, so this pauses.
          yield* llm.pushMatch(
            (hit) => !JSON.stringify(hit.body).includes("rejected-cipher"),
            httpError(400, reasoningBody),
          )

          yield* loop.init()
          yield* goal.set(chat.id, "preserve standing goal intent 7f3a", 10)
          yield* Effect.yieldNow
          const events = yield* EventV2Bridge.Service
          yield* events.publish(SessionStatus.Event.Status, { sessionID: chat.id, status: { type: "idle" } })

          // The first continuation replays the ciphertext and fails with 400.
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const messages = yield* sessions.messages({ sessionID: chat.id })
              return messages.some((message) => message.info.role === "assistant" && message.info.error)
                ? true
                : undefined
            }),
            "the first encrypted-reasoning rejection was not persisted",
            "10 seconds",
          )
          // Drive the goal evaluation with a deterministic idle event; the
          // production idle subscription still runs every real transition.
          yield* events.publish(SessionStatus.Event.Status, { sessionID: chat.id, status: { type: "idle" } })

          const baselineTurns = Number((yield* goal.load(chat.id))?.turns_used)

          // The reset must commit a real compaction marker and a summary
          // continuation before the clean post-summary request is sent.
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const messages = yield* sessions.messages({ sessionID: chat.id })
              return messages.some((message) => message.parts.some((part) => part.type === "compaction"))
                ? true
                : undefined
            }),
            "the reasoning reset did not create a compaction marker",
            "10 seconds",
          )
          // The clean continuation is rejected again. Wait for the second
          // persisted failure, then evaluate once more: the reset budget is
          // already spent, so this must pause without another compaction.
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const messages = yield* sessions.messages({ sessionID: chat.id })
              return messages.filter((message) => message.info.role === "assistant" && message.info.error).length >= 2
                ? true
                : undefined
            }),
            "the second encrypted-reasoning rejection was not persisted",
            "10 seconds",
          )
          yield* events.publish(SessionStatus.Event.Status, { sessionID: chat.id, status: { type: "idle" } })

          const paused = yield* pollWithTimeout(
            Effect.gen(function* () {
              const current = yield* goal.load(chat.id)
              return current?.status === "paused" ? current : undefined
            }),
            "the second rejection did not pause the goal",
            "15 seconds",
          )
          expect(String(paused.paused_reason)).toContain("自动重置推理状态后再次失败")
          // Recovery actions never consume a goal turn: only the initial
          // successful work turn is counted.
          expect(paused.turns_used).toBe(baselineTurns)

          const all = yield* sessions.messages({ sessionID: chat.id })
          const compactionParts = all.flatMap((message) => message.parts.filter((part) => part.type === "compaction"))
          expect(compactionParts).toHaveLength(1)
          expect(compactionParts[0]?.type === "compaction" ? compactionParts[0].auto : undefined).toBe(true)

          const bodies = (yield* llm.inputs).map((body) => JSON.stringify(body))
          const rejectedRequest = bodies.find((body) => body.includes("rejected-cipher"))
          expect(rejectedRequest).toBeDefined()
          expect(rejectedRequest).toContain("preserve standing goal intent 7f3a")
          expect(bodies.at(-1)).not.toContain("rejected-cipher")
          // The clean request follows the real compaction summary, proving the
          // reset produced a continuation rather than a summary-only no-op.
          expect(bodies.at(-1)).toContain("compact summary")
          // Autocompaction appends its generic continuation AFTER the existing
          // goal continuation; the summary must still carry the standing goal
          // intent so the model does not lose the objective.
          expect(bodies.at(-1)).toContain("preserve standing goal intent 7f3a")
          expect(bodies.at(-1)).toContain("Continue if you have next steps")
          expect(judgeCalls.value).toBeGreaterThan(0)
        }),
      { config: recoveryConfig },
    ),
  )
})

// Production transaction regression: reset admission runs claimRecovery and
// compaction.create inside SessionPrompt.createUserMessage's outer transaction.
// A compaction defect rolls back the nested claim savepoint, so the catch must
// pause the entrance revision, not a locally observed claim revision.
describe("GoalLoop — #892 reset admission rollback", () => {
  const prompts: PromptCall[] = []
  let window: SessionV1.WithParts[] = []
  let afterAdmissionRollback: Effect.Effect<void> | undefined
  const { layer, compaction } = harness({
    messages: () => window,
    prompts,
    withCompaction: true,
    compactionFails: true,
    transactionalAdmission: true,
    afterAdmissionRollback: Effect.suspend(() => afterAdmissionRollback ?? Effect.void),
  })
  const it = testEffect(layer)

  it.instance("a rolled-back reset claim pauses the entrance revision once and leaves the reset budget unused", () =>
    Effect.gen(function* () {
      reset(prompts, compaction)
      afterAdmissionRollback = undefined
      window = [
        userMessage("user-1", Date.now() + 60_000),
        assistantMessage({ id: "assistant-1", created: Date.now() + 60_001, error: reasoningError() }),
      ]
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      yield* loop.init()
      const sessionID = SessionID.descending()
      yield* goal.set(sessionID, "ship the feature", 10)
      yield* Effect.yieldNow

      yield* idle(sessionID)
      const current = yield* paused(sessionID)
      expect(String(current.paused_reason)).toContain("自动压缩失败")
      expect(current.turns_used).toBe(0)
      // The reset claim rolled back with the admission transaction.
      expect(current.recovery).toBeUndefined()
      expect(compaction.attempts).toBe(1)
      expect(prompts.filter((call) => call.kind === "prompt" && call.text?.includes("自动压缩失败"))).toHaveLength(1)

      // A paused goal must not automatically retry the reset on later idle.
      yield* idle(sessionID)
      yield* Effect.sleep("300 millis")
      expect(compaction.attempts).toBe(1)
      expect(prompts.filter((call) => call.kind === "prompt" && call.text?.includes("自动压缩失败"))).toHaveLength(1)

      // Explicit user resume is not overwritten and starts a fresh recovery
      // budget; the rolled-back claim did not consume the one reset.
      const resumed = yield* goal.resume(sessionID)
      expect(resumed?.status).toBe("active")
      expect(resumed?.recovery).toBeUndefined()
      yield* idle(sessionID)
      const again = yield* paused(sessionID)
      expect(String(again.paused_reason)).toContain("自动压缩失败")
      expect(compaction.attempts).toBe(2)
      expect(again.turns_used).toBe(0)
    }),
  )

  it.instance("a same-goal edit to the rolled-back claim revision is not paused", () =>
    Effect.gen(function* () {
      reset(prompts, compaction)
      afterAdmissionRollback = undefined
      window = [
        userMessage("user-1", Date.now() + 60_000),
        assistantMessage({ id: "assistant-1", created: Date.now() + 60_001, error: reasoningError() }),
      ]
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      yield* loop.init()
      const sessionID = SessionID.descending()
      const initial = yield* goal.set(sessionID, "ship the feature", 10)
      let editedRevision: number | undefined
      afterAdmissionRollback = Effect.gen(function* () {
        const edited = yield* goal.addSubgoal(sessionID, "user edit")
        editedRevision = edited?.revision
      })
      yield* Effect.yieldNow
      yield* idle(sessionID)
      yield* Effect.sleep("300 millis")

      // The rollback reverted the reset claim; the user's edit then advanced
      // the SAME goal to the same revision number the rolled-back claim had.
      // Identity must include the durable reset marker, so the delayed pause
      // must not fire.
      expect(editedRevision).toBe((initial.revision ?? 0) + 1)
      const current = yield* goal.load(sessionID)
      expect(current?.status).toBe("active")
      expect(current?.revision).toBe(editedRevision)
      expect(current?.recovery).toBeUndefined()
      expect(current?.subgoals).toContain("user edit")
      expect(compaction.attempts).toBe(1)
      expect(prompts.filter((call) => call.kind === "prompt" && call.text?.includes("自动压缩失败"))).toHaveLength(0)
    }),
  )
})
