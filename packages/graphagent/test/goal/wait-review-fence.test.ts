// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mocked service slices use `as never` shims.
import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Option } from "effect"
import { BackgroundJob } from "@graphagent/core/background-job"
import { Database } from "@graphagent/core/database/database"
import { RuntimeJobTable } from "@graphagent/core/lifecycle/runtime-job.sql"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { Session as SessionSchema } from "@graphagent/schema/session"
import { runtimeJobProcessID } from "@/background/persist"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Goal } from "@/goal/goal"
import { GoalLoop, GoalLoopJudgeLLM } from "@/goal/loop"
import { GoalState } from "@/goal/state"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionCancellation } from "@/session/cancellation"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { requireInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

/**
 * #1069 / Codex review of the wait review turn. A wait that ended without its
 * wake (a deadline that passed, or a job a restart lost) returns the goal to
 * active with a review marker, and the loop then dispatches ONE review turn.
 * That dispatch is autonomous driving, so it is admitted under the same fence
 * as a continuation: the goal instance and revision that expired, the session's
 * cancellation epoch, an idle session, and the goal's claim of the exclusive
 * registry. Anything that changed between the expiry and the admission refuses
 * the review instead of running a stale turn.
 *
 * The goal wrapper below holds the dispatch at the point where it has committed
 * to the expiry and is about to admit, so each test can interfere exactly there.
 */

const delivered: { noReply?: boolean; text: string }[] = []
const reviews = () => delivered.filter((call) => !call.noReply)

type Gate = {
  readonly reached: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
  readonly ended: Deferred.Deferred<void>
}
let gate: Gate | undefined

const assistant = {
  info: { id: "asst-1", role: "assistant", time: { created: Date.now() } },
  parts: [{ type: "text", text: "Started the watch; waiting for CI." }],
} as never

const recordingPrompt = Layer.succeed(
  SessionPrompt.Service,
  (() => {
    const record = (input: SessionPrompt.PromptInput) =>
      Effect.sync(() => {
        delivered.push({
          noReply: input.noReply,
          text: input.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
        })
        return undefined as never
      })
    const base = withIdleAdmission({
      prompt: record,
      deliver: (input: SessionPrompt.PromptInput) => record(input).pipe(Effect.map(Option.some)),
    })
    return {
      ...base,
      // The real idle admission reserves the runner only while the session is
      // idle; a running turn refuses it instead of taking the prompt.
      prepareTurn: (input: SessionPrompt.PromptInput, persistAdmission?: Effect.Effect<void>) =>
        Effect.gen(function* () {
          const status = yield* Effect.serviceOption(SessionStatus.Service)
          if (Option.isSome(status) && (yield* status.value.get(input.sessionID)).type !== "idle") return Option.none()
          return yield* base.prepareTurn(input, persistAdmission)
        }),
    } as never
  })(),
)

const hookedGoal = Layer.effect(
  Goal.Service,
  Effect.gen(function* () {
    const real = yield* Goal.Service
    return Goal.Service.of({
      ...real,
      // The review dispatch calls this once it has committed to the expiry and
      // is about to admit its turn: hold it there while a test interferes.
      markTurnDriven: (sessionID) =>
        gate
          ? Deferred.succeed(gate.reached, undefined).pipe(
              Effect.andThen(Deferred.await(gate.release)),
              Effect.andThen(real.markTurnDriven(sessionID)),
            )
          : real.markTurnDriven(sessionID),
      // A refused admission ends with this call.
      clearTurnDriven: (sessionID) =>
        real
          .clearTurnDriven(sessionID)
          .pipe(Effect.tap(() => (gate ? Deferred.succeed(gate.ended, undefined) : Effect.void))),
    })
  }),
).pipe(Layer.provide(Goal.defaultLayer))

const layer = GoalLoop.layer.pipe(
  Layer.provide(Layer.mock(Session.Service, { messages: () => Effect.sync(() => [assistant]) })),
  Layer.provide(recordingPrompt),
  Layer.provide(Layer.mock(Provider.Service, {})),
  Layer.provide(Layer.mock(BackgroundJob.Service, { list: () => Effect.succeed([]) })),
  Layer.provide(
    Layer.succeed(GoalLoopJudgeLLM, {
      call: () => Effect.succeed(JSON.stringify({ verdict: "continue", reason: "x" })),
    }),
  ),
  Layer.provideMerge(hookedGoal),
  Layer.provideMerge(SessionStatus.defaultLayer),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
  Layer.provideMerge(Database.defaultLayer),
)

const it = testEffect(layer)

const expiredWait = (): GoalState.Intent => ({
  kind: "await",
  wait: {
    source: "watch_pr",
    wait_id: "job_1",
    deadline: Date.now() - 1,
    max_wakes: GoalState.nni(1),
    wakes: GoalState.nni(0),
  },
})

const newGate = Effect.gen(function* () {
  gate = {
    reached: yield* Deferred.make<void>(),
    release: yield* Deferred.make<void>(),
    ended: yield* Deferred.make<void>(),
  }
  return gate
})

const within = <A, E, R>(effect: Effect.Effect<A, E, R>, message: string) =>
  effect.pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error(message)) }))

/** A goal waiting on an expired deadline; the idle boundary that follows notices it. */
const expiredGoal = Effect.gen(function* () {
  const loop = yield* GoalLoop.Service
  const goal = yield* Goal.Service
  yield* loop.init()
  const sid = SessionID.descending()
  yield* goal.set(sid, "merge the PR", 10)
  yield* goal.setIntent(sid, expiredWait())
  yield* Effect.yieldNow
  return sid
})

const idleBoundary = (sid: SessionID) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
  })

/**
 * Runs one expiry whose review dispatch is held before its admission, lets
 * `interfere` change the world, releases it, and waits for the refused
 * admission to finish.
 */
const refusedReview = (sid: SessionID, interfere: Effect.Effect<void, never, Goal.Service | SessionStatus.Service>) =>
  Effect.gen(function* () {
    const held = yield* newGate
    yield* idleBoundary(sid)
    yield* within(Deferred.await(held.reached), "the expired wait never reached its review dispatch")
    yield* interfere
    yield* Deferred.succeed(held.release, undefined)
    yield* within(Deferred.await(held.ended), "the review admission was never refused")
    for (let i = 0; i < 10; i++) yield* Effect.yieldNow
  })

const reset = () => {
  delivered.length = 0
  gate = undefined
}

describe("wait review admission", () => {
  it.instance("a deadline expiry dispatches exactly one review turn when nothing interferes", () =>
    Effect.gen(function* () {
      reset()
      const goal = yield* Goal.Service
      const sid = yield* expiredGoal

      yield* idleBoundary(sid)
      yield* pollWithTimeout(
        Effect.sync(() => (reviews().length > 0 ? true : undefined)),
        "the expired wait never got its review turn",
      )
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow

      expect(reviews()).toHaveLength(1)
      expect(reviews()[0]?.text).toContain("[等待超时复核]")
      const state = yield* goal.load(sid)
      expect(state?.status).toBe("active")
      expect(state?.intent?.kind).toBe("blocked")
    }),
  )

  it.instance("no review turn runs when the user pauses the goal after the expiry", () =>
    Effect.gen(function* () {
      reset()
      const goal = yield* Goal.Service
      const sid = yield* expiredGoal

      yield* refusedReview(sid, goal.pause(sid, "paused by the user").pipe(Effect.asVoid))

      expect(reviews()).toHaveLength(0)
      const state = yield* goal.load(sid)
      expect(state?.status).toBe("paused")
      expect(state?.paused_reason).toBe("paused by the user")
    }),
  )

  it.instance("no review turn runs when the goal was replaced by a new one after the expiry", () =>
    Effect.gen(function* () {
      reset()
      const goal = yield* Goal.Service
      const sid = yield* expiredGoal
      const before = yield* goal.load(sid)

      yield* refusedReview(
        sid,
        Effect.gen(function* () {
          yield* goal.clear(sid)
          yield* goal.set(sid, "a different goal", 5)
        }),
      )

      expect(reviews()).toHaveLength(0)
      const replacement = yield* goal.load(sid)
      expect(replacement?.goal).toBe("a different goal")
      expect(replacement?.goal_id).not.toBe(before?.goal_id)
      expect(replacement?.status).toBe("active")
      expect(replacement?.intent).toBeUndefined()
    }),
  )

  it.instance("no review turn runs when the same goal changed revision after the expiry", () =>
    Effect.gen(function* () {
      reset()
      const goal = yield* Goal.Service
      const sid = yield* expiredGoal

      // Same goal, still active and still registered: only its revision moved,
      // so only the admission-time revision check can refuse the review.
      yield* refusedReview(sid, goal.addSubgoal(sid, "an extra subgoal").pipe(Effect.asVoid))

      expect(reviews()).toHaveLength(0)
      const state = yield* goal.load(sid)
      expect(state?.status).toBe("active")
      expect(state?.subgoals).toEqual(["an extra subgoal"])
    }),
  )

  it.instance("no review turn runs after an ESC advanced the cancellation epoch, and the goal pauses", () =>
    Effect.gen(function* () {
      reset()
      const goal = yield* Goal.Service
      const sid = yield* expiredGoal

      yield* refusedReview(
        sid,
        Effect.sync(() => {
          SessionCancellation.begin(sid).finish()
        }),
      )

      expect(reviews()).toHaveLength(0)
      const state = yield* goal.load(sid)
      expect(state?.status).toBe("paused")
      expect(state?.paused_reason).toContain("用户中断")
    }),
  )

  it.instance("the review is not appended to a turn the user started after the expiry", () =>
    Effect.gen(function* () {
      reset()
      const goal = yield* Goal.Service
      const status = yield* SessionStatus.Service
      const sid = yield* expiredGoal

      yield* refusedReview(sid, status.set(sid, { type: "busy" }))

      // The user's turn owns the session: nothing is delivered into it. The goal
      // keeps its review marker, so the next idle pauses it visibly.
      expect(reviews()).toHaveLength(0)
      const state = yield* goal.load(sid)
      expect(state?.status).toBe("active")
      expect(state?.intent?.kind).toBe("blocked")
    }),
  )

  // The restart path shares the dispatch; what is specific to it is that the
  // startup scan observes the cancellation epoch itself before it decides.
  it.instance("a lost job's review turn is fenced the same way after an ESC", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const { db } = yield* Database.Service
      const instance = yield* requireInstance
      const sid = SessionID.descending()
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(instance.directory), sandboxes: [] })
        .onConflictDoNothing()
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionSchema.ID.make(sid),
          project_id: Project.ID.global,
          slug: sid,
          directory: AbsolutePath.make(instance.directory),
          title: sid,
          version: "test",
        })
        .run()
      yield* db
        .insert(RuntimeJobTable)
        .values({
          id: "fence_job_lost",
          type: "watch_pr",
          process_id: "proc_dead",
          session_id: sid,
          status: "error",
          error: "process_restart",
          started_at: 1,
          updated_at: 1,
        })
        .run()
      yield* goal.set(sid, "merge the PR", 10)
      yield* goal.setIntent(sid, {
        kind: "await",
        wait: {
          source: "watch_pr",
          wait_id: "fence_job_lost",
          ref: { domain: "job", id: "fence_job_lost" },
          deadline: Date.now() + 60_000,
          max_wakes: GoalState.nni(1),
          wakes: GoalState.nni(0),
        },
      })
      expect(runtimeJobProcessID).not.toBe("proc_dead")

      const held = yield* newGate
      yield* loop.init()
      yield* within(Deferred.await(held.reached), "the lost job never reached its review dispatch")
      SessionCancellation.begin(sid).finish()
      yield* Deferred.succeed(held.release, undefined)
      yield* within(Deferred.await(held.ended), "the review admission was never refused")

      expect(reviews()).toHaveLength(0)
      const state = yield* goal.load(sid)
      expect(state?.status).toBe("paused")
      expect(state?.paused_reason).toContain("用户中断")
    }),
  )
})
