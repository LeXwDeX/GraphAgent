// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mocked service slices use `as never` shims.
import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { GoalLoop, GoalLoopJudgeLLM } from "@/goal/loop"
import { Goal } from "@/goal/goal"
import { GoalState } from "@/goal/state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { SessionID } from "@/session/schema"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

// Loop-level regressions for #989 waits: an expired wait must pause visibly,
// and a wake only for the registered source/identity flips the goal back to
// work without racing the caller's own notice prompt.

const promptCalls: { noReply?: boolean; text: string }[] = []
let judgeCalls = 0

const assistant = {
  info: { id: "asst-1", role: "assistant", time: { created: Date.now() } },
  parts: [{ type: "text", text: "Started the watch; waiting for CI." }],
} as never

const recordingPrompt = Layer.succeed(
  SessionPrompt.Service,
  (() => {
    const record = (input: SessionPrompt.PromptInput) =>
      Effect.sync(() => {
        promptCalls.push({
          noReply: input.noReply,
          text: input.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
        })
        return undefined as never
      })
    return withIdleAdmission({
      prompt: record,
      promptIfIdle: (input: SessionPrompt.PromptInput) => record(input).pipe(Effect.map(Option.some)),
    }) as never
  })(),
)

const layer = GoalLoop.layer.pipe(
  Layer.provide(Layer.mock(Session.Service, { messages: () => Effect.sync(() => [assistant]) })),
  Layer.provide(recordingPrompt),
  Layer.provide(Layer.mock(Provider.Service, {})),
  Layer.provide(
    Layer.succeed(GoalLoopJudgeLLM, {
      call: () =>
        Effect.sync(() => {
          judgeCalls += 1
          return JSON.stringify({ verdict: "continue", reason: "not yet" })
        }),
    }),
  ),
  Layer.provideMerge(Goal.defaultLayer),
  Layer.provideMerge(SessionStatus.defaultLayer),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
)

const it = testEffect(layer)

const reset = () => {
  promptCalls.length = 0
  judgeCalls = 0
}

const awaitWatch = (deadline: number): GoalState.Intent => ({
  kind: "await",
  wait: {
    source: "watch_pr",
    wait_id: "job_1",
    deadline,
    max_wakes: GoalState.nni(1),
    wakes: GoalState.nni(0),
  },
})

describe("GoalLoop — waits", () => {
  it.instance("an expired wait pauses the goal visibly at idle", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "merge the PR", 10)
      yield* goal.setIntent(sid, awaitWatch(Date.now() - 1))
      yield* Effect.yieldNow

      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          return (yield* goal.load(sid))?.status === "paused" && promptCalls.length > 0 ? true : undefined
        }),
        "the expired wait never paused the goal visibly",
        "5 seconds",
      )

      expect(String((yield* goal.load(sid))?.paused_reason)).toContain("watch_pr:job_1")
      expect(promptCalls).toEqual([{ noReply: true, text: expect.stringContaining("⏸ 目标已暂停") }])
      expect(judgeCalls).toBe(0)
    }),
  )

  it.instance("idle boundaries while waiting never dispatch or spend turns", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "merge the PR", 10)
      yield* goal.setIntent(sid, {
        kind: "await",
        wait: {
          source: "background_job",
          wait_id: "ses_child",
          deadline: Date.now() + 60_000,
          max_wakes: GoalState.nni(1),
          wakes: GoalState.nni(0),
        },
      })
      yield* Effect.yieldNow

      for (let i = 0; i < 5; i++) {
        yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
        for (let j = 0; j < 10; j++) yield* Effect.yieldNow
      }
      yield* Effect.sleep("50 millis")

      const state = yield* goal.load(sid)
      expect(state?.status).toBe("waiting")
      expect(Number(state?.turns_used)).toBe(0)
      expect(promptCalls).toHaveLength(0)
      expect(judgeCalls).toBe(0)
    }),
  )

  it.instance("a waiting goal that survives a restart is not dispatched by the startup scan", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const sid = SessionID.descending()
      // Durable row written before this process's GoalLoop boots.
      yield* goal.set(sid, "merge the PR", 10)
      yield* goal.setIntent(sid, awaitWatch(Date.now() + 60_000))

      yield* loop.init()
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow
      yield* Effect.sleep("50 millis")

      const state = yield* goal.load(sid)
      expect(state?.status).toBe("waiting")
      expect(Number(state?.turns_used)).toBe(0)
      expect(promptCalls).toHaveLength(0)
      expect(judgeCalls).toBe(0)
    }),
  )

  it.instance("only the registered watch wakes the goal, and a state-only wake defers to the next idle", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "merge the PR", 10)
      yield* goal.setIntent(sid, awaitWatch(Date.now() + 60_000))
      yield* Effect.yieldNow

      expect(yield* Effect.scoped(loop.wake(sid, { source: "watch_pr", ids: ["job_9", "https://x/pr/2"] }))).toBe(false)
      expect(yield* Effect.scoped(loop.wake(sid, { source: "background_job", ids: ["job_1"] }))).toBe(false)
      expect((yield* goal.load(sid))?.status).toBe("waiting")

      const woke = yield* Effect.scoped(
        loop.wake(sid, { source: "watch_pr", ids: ["job_1"] }, "checks passed", { evaluate: false }),
      )
      expect(woke).toBe(true)
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow
      expect(promptCalls).toHaveLength(0)
      expect((yield* goal.load(sid))?.intent?.kind).toBe("progress")

      // The notice turn ends: its idle event continues the goal without a judge call.
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.sync(() => (promptCalls.some((call) => !call.noReply) ? true : undefined)),
        "the woken goal never continued",
        "5 seconds",
      )
      expect(judgeCalls).toBe(0)
      const state = yield* goal.load(sid)
      expect(state?.status).toBe("active")
      expect(state?.intent).toBeUndefined()
    }),
  )

  it.instance("a progress intent spends one turn per continuation and respects the budget", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship it", 1)
      yield* goal.setIntent(sid, { kind: "progress" })
      yield* Effect.yieldNow

      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const state = yield* goal.load(sid)
          return state && state.status !== "active" ? state : promptCalls.length > 0 ? state : undefined
        }),
        "the progress intent never reached a budget decision",
        "5 seconds",
      )
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow

      // Budget 1: the first progress boundary spends the only turn and the
      // goal pauses visibly instead of dispatching unbounded work.
      const state = yield* goal.load(sid)
      expect(judgeCalls).toBe(0)
      expect(Number(state?.turns_used)).toBe(1)
      expect(state?.status).toBe("paused")
      expect(promptCalls.every((call) => call.noReply)).toBe(true)
    }),
  )

  it.instance("a wake that evaluates immediately survives the caller's scope", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "merge the PR", 10)
      yield* goal.setIntent(sid, awaitWatch(Date.now() + 60_000))
      yield* Effect.yieldNow

      // Callers wrap the wake in Effect.scoped; no notice prompt follows.
      expect(
        yield* Effect.scoped(loop.wake(sid, { source: "watch_pr", ids: ["job_1"] }, "watch exited without a notice")),
      ).toBe(true)
      yield* pollWithTimeout(
        Effect.sync(() => (promptCalls.some((call) => !call.noReply) ? true : undefined)),
        "the woken goal was never evaluated",
        "5 seconds",
      )
      expect(Number((yield* goal.load(sid))?.turns_used)).toBe(1)
    }),
  )
})
