// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Clock, Deferred, Effect, Fiber, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Database } from "@graphagent/core/database/database"
import type { StopReason } from "@graphagent/schema/stop-reason"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { LoopAnalysis } from "@/loop/analysis"
import { LoopRuntime } from "@/loop/runtime"
import { LoopState } from "@/loop/state"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { intent, progress, result } from "./fixture"
import {
  analysis,
  analysisLayer,
  failed,
  host,
  hostLayer,
  ok,
  providerError,
  reasoningError,
  type FakeSession,
} from "./runtime.fixture"

const base = LoopState.layer.pipe(Layer.provideMerge(Database.defaultLayer), Layer.provideMerge(EventV2Bridge.defaultLayer))
const it = testEffect(
  LoopRuntime.layer.pipe(Layer.provideMerge(hostLayer), Layer.provideMerge(analysisLayer), Layer.provideMerge(base)),
)

/**
 * The same runtime over a state layer that runs `afterCommit` once an analysis has committed: the moment between the
 * commit and the next time the decision that made it reads the session. Nothing else sits there to put a test in.
 */
const afterCommit: { run: Effect.Effect<void> | undefined } = { run: undefined }
const hookedState = Layer.effect(
  LoopState.Service,
  Effect.gen(function* () {
    const inner = yield* LoopState.Service
    return LoopState.Service.of({
      ...inner,
      commitAnalysis: (sessionID, expected, commit) =>
        inner.commitAnalysis(sessionID, expected, commit).pipe(Effect.tap(() => afterCommit.run ?? Effect.void)),
    })
  }),
).pipe(Layer.provide(base))
const hooked = testEffect(
  LoopRuntime.layer.pipe(
    Layer.provideMerge(hostLayer),
    Layer.provideMerge(analysisLayer),
    Layer.provideMerge(hookedState),
  ),
)

const waitFor = (overrides: Partial<LoopState.Wait> = {}): LoopState.Wait => ({
  source: "background_job",
  wait_id: "job_1",
  ref: { domain: "job", id: "job_1" },
  deadline: 3_600_000,
  max_wakes: 1,
  wakes: 0,
  reviewed: false,
  ...overrides,
})

const stalled = result({ progress: progress({ advanced: false }) })

/**
 * One loop on its own session, with its round 1 running. `end` finishes the running turn and lets the
 * runtime decide the boundary it left; the first one is the user's own turn.
 */
const boot = (options: { maxRounds?: number } = {}) =>
  Effect.gen(function* () {
    const runtime = yield* LoopRuntime.Service
    const loops = yield* LoopState.Service
    const sessionID = SessionID.descending()
    const session = host.session(sessionID)
    const prompt = "Ship the loop analysis service."
    const created = yield* runtime.start(sessionID, {
      prompt,
      messageID: session.human(prompt),
      ...(options.maxRounds !== undefined ? { maxRounds: options.maxRounds } : {}),
    })
    session.begin()
    let first = true

    const load = () => loops.load(sessionID)
    const current = () =>
      load().pipe(
        Effect.map((state) => {
          if (state === undefined) throw new Error("the loop is gone")
          return state
        }),
      )
    const tick = runtime.claim(sessionID).pipe(Effect.andThen(runtime.settled(sessionID)))
    const script = (...steps: Parameters<typeof analysis.script> extends [unknown, ...infer Rest] ? Rest : never) =>
      analysis.script(sessionID, ...steps)
    const end = (steps?: Parameters<typeof script>, boundary: Parameters<FakeSession["finish"]>[0] = {}) =>
      Effect.gen(function* () {
        if (steps !== undefined) script(...steps)
        session.finish({ humanTurn: first, ...boundary })
        first = false
        yield* tick
      })
    return {
      runtime,
      loops,
      sessionID,
      session,
      created,
      prompt,
      load,
      current,
      tick,
      script,
      end,
      calls: () => analysis.calls(sessionID),
      rows: () => loops.analyses(created.state.loop_id),
      outcome: () => loops.lastOutcome(sessionID),
    }
  })

type Harness = Effect.Success<ReturnType<typeof boot>>

/** Ends the running turn with one scripted analysis, as most tests do. */
const round = (t: Harness, outcome: LoopAnalysis.Outcome = ok(result()), boundary: Parameters<typeof t.end>[1] = {}) =>
  t.end([outcome], boundary)

describe("LoopRuntime rounds", () => {
  it.effect("waits for round 1 to end, analyses it, and dispatches round 2 in three segments", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      // Round 1 is the user's own message: there is nothing to analyse while it runs.
      yield* t.tick
      expect(t.calls()).toHaveLength(0)
      expect(t.session.requests).toHaveLength(0)

      yield* round(t)

      const [call] = t.calls()
      expect(t.calls()).toHaveLength(1)
      expect(call.firstDescription).toBe(t.prompt)
      expect(call.prior).toBeUndefined()
      expect(call.outcome).toEqual({ type: "completed" })
      expect(call.humans).toEqual([])

      const state = yield* t.current()
      expect(state.round).toBe(2)
      expect(state.status).toBe("active")
      expect(state.origin.analysis).toEqual(intent())
      expect(state.intent_revision).toBe(1)
      expect(state.next_prompt).toBeUndefined()
      expect(state.analyzing).toBeUndefined()
      expect(state.last_analyzed_msg).toBe(t.session.boundary?.message)
      expect(yield* t.rows()).toHaveLength(1)

      expect(t.session.sent).toHaveLength(1)
      const [sent] = t.session.sent
      expect(sent.marker).toEqual({ loopID: state.loop_id, round: 2, kind: "next" })
      const text = sent.text
      expect(text.startsWith("[Loop round 2/20: continuing]")).toBe(true)
      const prompt = text.indexOf("## This round\nImplement the validator and run its tests.")
      const tail = text.indexOf("## Final goal")
      expect(prompt).toBeGreaterThan(0)
      expect(tail).toBeGreaterThan(prompt)
      expect(text.slice(tail)).toContain("Objective: Ship the loop analysis service")
      expect(text.slice(tail)).toContain("- Do not touch the shared runner")
      expect(text.slice(tail)).toContain("- No new configuration keys")
    }),
  )

  it.effect("sends a different prompt each round and shows the analysis its own history", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* round(t, ok(result({ next_prompt: "Write the schema." })))
      yield* round(t, ok(result({ next_prompt: "Write the validator.", reason: "Schema is in." })))
      yield* round(t, ok(result({ next_prompt: "Write the tests." })))

      expect(t.session.sent.map((sent) => sent.marker.round)).toEqual([2, 3, 4])
      expect(t.session.sent[0].text).toContain("## This round\nWrite the schema.")
      expect(t.session.sent[1].text).toContain("## This round\nWrite the validator.")
      expect(t.session.sent[2].text).toContain("## This round\nWrite the tests.")

      const [, second, third] = t.calls()
      expect(second.prior?.firstAnalysis).toEqual(intent())
      expect(second.prior?.prompt).toBe("Write the schema.")
      expect(third.prior?.recent.map((item) => item.reason)).toEqual([
        "Two acceptance items are still unmet.",
        "Schema is in.",
      ])
      expect((yield* t.current()).origin.analysis).toEqual(intent())
    }),
  )

  it.effect("marks the loop as analysing while the analysis runs, then clears the mark and appends the row", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      const events = yield* EventV2Bridge.Service
      const analysing: boolean[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          const data: any = event.data
          if (event.type === "loop.updated" && data.sessionID === t.sessionID) analysing.push(data.loop.analyzing)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      let during: LoopState.Info | undefined
      t.script(() =>
        t.load().pipe(
          Effect.tap((state) =>
            Effect.sync(() => {
              during = state
            }),
          ),
          Effect.as(ok(result())),
        ),
      )
      t.session.finish({ humanTurn: true })
      yield* t.tick

      expect(during?.analyzing).toEqual({ boundary: t.session.boundary?.message ?? "", started_at: 0 })
      // The interface is told when the analysis starts and when it ends: mark, commit, then the round's dispatch.
      expect(analysing).toEqual([true, false, false])
      const after = yield* t.current()
      expect(after.analyzing).toBeUndefined()
      expect(after.last_reason).toBe("Two acceptance items are still unmet.")
      expect(yield* t.rows()).toHaveLength(1)
    }),
  )

  it.effect("dispatches nothing when the analysis fails", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* round(t, failed({ kind: "invalid_output", detail: "no submission", violations: [] }))
      const state = yield* t.current()
      expect(state.status).toBe("stopped")
      expect(state.stop).toMatchObject({ reason: "analysis_failed", detail: { code: "invalid_output" } })
      expect(state.round).toBe(1)
      expect(state.analyzing).toBeUndefined()
      expect(t.session.requests).toHaveLength(0)
      expect(yield* t.rows()).toHaveLength(0)
    }),
  )

  it.effect("analyses a boundary once and dispatches its stored prompt when the first dispatch was refused", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      t.session.answer = "refused"
      yield* round(t, ok(result({ next_prompt: "Pick up the validator." })))
      // The analysis is committed, the prompt is kept, no round was counted.
      let state = yield* t.current()
      expect(state.round).toBe(1)
      expect(state.next_prompt).toBe("Pick up the validator.")
      expect(state.last_analyzed_msg).toBe(t.session.boundary?.message)
      expect(t.calls()).toHaveLength(1)

      t.session.answer = undefined
      yield* t.tick
      yield* t.tick

      expect(t.calls()).toHaveLength(1)
      state = yield* t.current()
      expect(state.round).toBe(2)
      expect(state.next_prompt).toBeUndefined()
      expect(t.session.sent).toHaveLength(1)
      expect(t.session.sent[0].text).toContain("## This round\nPick up the validator.")
    }),
  )

  it.effect("does not send a round twice when its turn ended without a new boundary", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* round(t)
      expect(t.session.sent).toHaveLength(1)
      // The dispatched turn died before it wrote anything: the session is idle at the old boundary.
      t.session.idle = true
      yield* t.tick
      yield* t.tick
      expect(t.calls()).toHaveLength(1)
      expect(t.session.sent).toHaveLength(1)
      expect((yield* t.current()).round).toBe(2)
    }),
  )

  it.effect("counts a round only with the message that starts it", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      // The host refuses while a turn runs: nothing is written, nothing is counted.
      yield* round(t)
      expect((yield* t.current()).round).toBe(2)
      t.session.begin()
      yield* t.tick
      yield* t.tick
      expect((yield* t.current()).round).toBe(2)
      expect(t.session.sent).toHaveLength(1)
    }),
  )
})

describe("LoopRuntime triggers", () => {
  it.effect("decides once more after a trigger that arrived mid-decision, without dispatching twice", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      t.script(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(ok(result()))),
      )
      t.session.finish({ humanTurn: true })
      yield* t.runtime.claim(t.sessionID)
      yield* Deferred.await(started)
      // Two more idle events while the analysis runs.
      expect(yield* t.runtime.claim(t.sessionID)).toBe(true)
      expect(yield* t.runtime.claim(t.sessionID)).toBe(true)
      expect(t.calls()).toHaveLength(1)

      yield* Deferred.succeed(release, undefined)
      yield* t.runtime.settled(t.sessionID)

      expect(t.calls()).toHaveLength(1)
      expect(t.session.sent).toHaveLength(1)
      expect((yield* t.current()).round).toBe(2)
    }),
  )

  it.effect("reads the agent's declaration into the analysis and clears it when the boundary is over", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* t.loops.update(t.sessionID, undefined, { declaration: { kind: "done", evidence: "tests pass: 12/12" } })
      yield* round(t, ok(result({ next_prompt: "Verify the claim." })), { humanTurn: true })

      expect(t.calls()[0]?.declaration).toEqual({ kind: "done", text: "tests pass: 12/12" })
      const state = yield* t.current()
      expect(state.declaration).toBeUndefined()
      expect(state.round).toBe(2)
    }),
  )

  it.effect("goes back to waiting when it is resumed while its object is still alive", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* t.loops.update(t.sessionID, undefined, { declaration: { kind: "await" }, wait: waitFor() })
      yield* t.end()
      yield* t.runtime.act(t.sessionID, "stop")
      expect((yield* t.current()).status).toBe("stopped")

      yield* t.runtime.resume(t.sessionID)
      yield* t.runtime.settled(t.sessionID)

      const state = yield* t.current()
      expect(state.status).toBe("waiting")
      expect(state.wait?.wait_id).toBe("job_1")
      expect(t.calls()).toHaveLength(0)
      expect(t.session.requests).toHaveLength(0)
    }),
  )
})

describe("LoopRuntime limits", () => {
  it.effect("stops with budget_exhausted at the round limit and keeps the prompt for a resume", () =>
    Effect.gen(function* () {
      const t = yield* boot({ maxRounds: 2 })
      yield* round(t)
      expect((yield* t.current()).round).toBe(2)
      yield* round(t, ok(result({ next_prompt: "The last prompt." })))

      const state = yield* t.current()
      expect(state.status).toBe("stopped")
      expect(state.stop?.reason).toBe("budget_exhausted")
      expect(state.round).toBe(2)
      expect(state.next_prompt).toBe("The last prompt.")
      expect(t.session.sent).toHaveLength(1)
    }),
  )

  it.effect("stops with no_progress after three analyses in a row without progress", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* round(t, ok(stalled))
      expect((yield* t.current()).no_progress_streak).toBe(1)
      yield* round(t, ok(stalled))
      expect((yield* t.current()).no_progress_streak).toBe(2)
      expect((yield* t.current()).status).toBe("active")
      yield* round(t, ok(stalled))

      const state = yield* t.current()
      expect(state.status).toBe("stopped")
      expect(state.stop?.reason).toBe("no_progress")
      expect(state.no_progress_streak).toBe(3)
      expect(t.session.sent).toHaveLength(2)
    }),
  )

  it.effect("resets the streak when a round makes progress", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* round(t, ok(stalled))
      yield* round(t, ok(stalled))
      yield* round(t, ok(result()))
      expect((yield* t.current()).no_progress_streak).toBe(0)
      yield* round(t, ok(stalled))
      const state = yield* t.current()
      expect(state.no_progress_streak).toBe(1)
      expect(state.status).toBe("active")
    }),
  )

  it.effect("does not move the streak for the analysis that follows a user turn", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* round(t)
      // Round 2 declares await and the loop waits.
      yield* t.loops.update(t.sessionID, undefined, { declaration: { kind: "await" }, wait: waitFor() })
      t.session.finish()
      yield* t.tick
      expect((yield* t.current()).status).toBe("waiting")

      t.session.human("how is it going?")
      t.session.begin()
      t.script(ok(stalled))
      t.session.finish({ humanTurn: true })
      yield* t.tick

      const state = yield* t.current()
      expect(state.no_progress_streak).toBe(0)
      expect(state.status).toBe("waiting")
      expect(t.calls()).toHaveLength(2)
    }),
  )
})

describe("LoopRuntime waiting", () => {
  it.effect("waits on an agent's await without analysing, however often the session goes idle", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* t.loops.update(t.sessionID, undefined, { declaration: { kind: "await" }, wait: waitFor() })
      yield* t.end()
      yield* t.tick
      yield* t.tick
      yield* t.tick

      const state = yield* t.current()
      expect(state.status).toBe("waiting")
      expect(state.declaration).toBeUndefined()
      expect(state.wait?.wait_id).toBe("job_1")
      expect(state.round).toBe(1)
      expect(t.calls()).toHaveLength(0)
      expect(t.session.requests).toHaveLength(0)
    }),
  )

  it.effect("analyses first when the user spoke in the round that declared await, then waits on continue", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* t.loops.update(t.sessionID, undefined, { declaration: { kind: "await" }, wait: waitFor() })
      const message = t.session.human("and mind the changelog")
      yield* t.end([ok(result({ next_prompt: "Mind the changelog." }))])

      expect(t.calls()).toHaveLength(1)
      expect(t.calls()[0].humans).toEqual([{ id: message, text: "and mind the changelog" }])
      expect(t.calls()[0].declaration).toMatchObject({ kind: "await" })
      const state = yield* t.current()
      expect(state.status).toBe("waiting")
      expect(state.declaration).toBeUndefined()
      expect(state.wait?.wait_id).toBe("job_1")
      expect(state.round).toBe(1)
      expect(t.session.requests).toHaveLength(0)
    }),
  )

  it.effect("leaves a live wait alone when another automation's turn ends", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* t.loops.update(t.sessionID, undefined, { declaration: { kind: "await" }, wait: waitFor() })
      yield* t.end()

      // A DAG result is delivered to the session and its turn ends: not the loop's turn, not a human's.
      t.session.begin()
      yield* t.end()

      const state = yield* t.current()
      expect(state.status).toBe("waiting")
      expect(state.round).toBe(1)
      expect(t.calls()).toHaveLength(0)
      expect(t.session.requests).toHaveLength(0)
    }),
  )

  it.effect("wakes with a turn of its own, counts the round and clears the wait", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* t.loops.update(t.sessionID, undefined, { declaration: { kind: "await" }, wait: waitFor() })
      yield* t.end()

      expect(yield* t.runtime.wake(t.sessionID, { source: "background_job", ids: ["other_job"] }, "no")).toBe(false)
      expect(yield* t.runtime.wake(t.sessionID, { source: "background_job", ids: ["job_1"] }, "job_1 finished: ok")).toBe(
        true,
      )

      const state = yield* t.current()
      expect(state.status).toBe("active")
      expect(state.round).toBe(2)
      expect(state.wait).toBeUndefined()
      expect(t.session.sent).toHaveLength(1)
      expect(t.session.sent[0].marker).toEqual({ loopID: state.loop_id, round: 2, kind: "wake" })
      expect(t.session.sent[0].text).toContain("## Why this round started\njob_1 finished: ok")
    }),
  )

  it.effect("with evaluate false only flips the state and leaves the turn to the caller", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* t.loops.update(t.sessionID, undefined, { declaration: { kind: "await" }, wait: waitFor() })
      yield* t.end()
      expect(yield* t.runtime.wake(t.sessionID, { source: "background_job", ids: ["job_1"] }, "done", { evaluate: false })).toBe(
        true,
      )
      const state = yield* t.current()
      expect([state.status, state.round, state.wait]).toEqual(["active", 2, undefined])
      expect(t.session.requests).toHaveLength(0)
    }),
  )

  it.effect(
    "changes nothing for a wake the session refuses, and ends the wait at the next boundary once its object is over",
    () =>
      Effect.gen(function* () {
        const t = yield* boot()
        yield* t.loops.update(t.sessionID, undefined, { declaration: { kind: "await" }, wait: waitFor() })
        yield* t.end()
        // A user turn is running when the job finishes.
        t.session.human("meanwhile, a question")
        t.session.begin()
        expect(yield* t.runtime.wake(t.sessionID, { source: "background_job", ids: ["job_1"] }, "job_1 finished")).toBe(
          true,
        )

        // The message was never admitted, so no round was counted and the wait was not cleared.
        let state = yield* t.current()
        expect([state.status, state.round, state.wait?.wait_id]).toEqual(["waiting", 1, "job_1"])
        expect(t.session.sent).toHaveLength(0)

        // The user's turn ends. The job is over and so is the wait: the analysis sends the next round.
        t.session.gone.set("job_1", "job_1 finished")
        yield* round(t, ok(result({ next_prompt: "Use the finished job." })), { humanTurn: true })
        state = yield* t.current()
        expect([state.status, state.round, state.wait]).toEqual(["active", 2, undefined])
        expect(t.session.sent).toHaveLength(1)
        expect(t.session.sent[0].marker.kind).toBe("next")
        expect(t.session.sent[0].text).toContain("Use the finished job.")
      }),
  )

  it.effect("leaves a waiting loop as it was when the process dies between a wake and its admission", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* t.loops.update(t.sessionID, undefined, { declaration: { kind: "await" }, wait: waitFor() })
      yield* t.end()
      // A user turn in the waiting loop: the analysis says continue, and its prompt waits for the job to end.
      t.session.human("also mind the changelog")
      t.session.begin()
      t.script(ok(result({ next_prompt: "Mind the changelog." })))
      t.session.finish({ humanTurn: true })
      yield* t.tick
      const before = yield* t.current()
      expect([before.status, before.round, before.next_prompt]).toEqual(["waiting", 1, "Mind the changelog."])

      // The job ends and wakes the loop; the process dies while the host has not yet admitted the message.
      const entered = yield* Deferred.make<void>()
      t.session.gate = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
      const waking = yield* t.runtime
        .wake(t.sessionID, { source: "background_job", ids: ["job_1"] }, "job_1 finished")
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(waking)

      const after = yield* t.current()
      expect(after).toEqual(before)
      expect(t.session.sent).toHaveLength(0)

      // After the restart the job is over: startup decides the boundary again and sends the kept prompt.
      t.session.gate = undefined
      t.session.gone.set("job_1", "job_1 finished while the process was down.")
      host.liveSessions.splice(0, host.liveSessions.length, { sessionID: t.sessionID, status: "waiting" })
      yield* t.runtime.init("/repo")
      yield* t.runtime.settled(t.sessionID)

      expect(t.session.sent).toHaveLength(1)
      expect(t.session.sent[0].text).toContain("Mind the changelog.")
      expect((yield* t.current()).round).toBe(2)
    }),
  )

  it.effect("does not take a wake for a loop that was written to between reading it and the admission", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* t.loops.update(t.sessionID, undefined, { declaration: { kind: "await" }, wait: waitFor() })
      yield* t.end()
      // A command changes the loop while the host is admitting the wake's message.
      t.session.gate = t.loops.update(t.sessionID, undefined, { max_rounds: 30 }).pipe(Effect.asVoid)
      expect(yield* t.runtime.wake(t.sessionID, { source: "background_job", ids: ["job_1"] }, "job_1 finished")).toBe(
        false,
      )

      const state = yield* t.current()
      expect([state.status, state.round, state.max_rounds, state.wait?.wait_id]).toEqual(["waiting", 1, 30, "job_1"])
      expect(t.session.sent).toHaveLength(0)
    }),
  )

  it.effect("ends at budget_exhausted when the agent keeps awaiting after every wake", () =>
    Effect.gen(function* () {
      const t = yield* boot({ maxRounds: 3 })
      const awaitAgain = () => t.loops.update(t.sessionID, undefined, { declaration: { kind: "await" }, wait: waitFor() })
      yield* awaitAgain()
      yield* t.end()
      const wake = () => t.runtime.wake(t.sessionID, { source: "background_job", ids: ["job_1"] }, "finished")

      for (const expected of [2, 3]) {
        expect(yield* wake()).toBe(true)
        expect((yield* t.current()).round).toBe(expected)
        yield* awaitAgain()
        yield* t.end()
        expect((yield* t.current()).status).toBe("waiting")
      }
      expect(yield* wake()).toBe(true)

      const state = yield* t.current()
      expect(state.status).toBe("stopped")
      expect(state.stop?.reason).toBe("budget_exhausted")
      expect(state.round).toBe(3)
      expect(t.calls()).toHaveLength(0)
    }),
  )

  it.effect("reviews an expired wait once, then stops with wait_expired if nothing moved", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* t.loops.update(t.sessionID, undefined, { declaration: { kind: "await" }, wait: waitFor({ deadline: 0 }) })
      yield* t.end()
      expect((yield* t.current()).status).toBe("waiting")
      expect(t.session.requests).toHaveLength(0)

      // The periodic scan finds the deadline passed.
      yield* t.tick
      let state = yield* t.current()
      expect(state.round).toBe(2)
      expect(state.status).toBe("active")
      expect(state.wait?.reviewed).toBe(true)
      const review = t.session.sent[0]
      expect(review.marker.kind).toBe("review")
      expect(review.text).toContain("Waiting for background_job:job_1 timed out.")
      expect(review.text).toContain("Do one bounded check")

      yield* round(t, ok(stalled))
      state = yield* t.current()
      expect(state.status).toBe("stopped")
      expect(state.stop?.reason).toBe("wait_expired")
      expect(t.session.sent).toHaveLength(1)
    }),
  )

  it.effect("goes on after a review that made progress, and drops the wait", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* t.loops.update(t.sessionID, undefined, { declaration: { kind: "await" }, wait: waitFor({ deadline: 0 }) })
      yield* t.end()
      yield* t.tick
      yield* round(t, ok(result({ next_prompt: "Finish the job's work." })))

      const state = yield* t.current()
      expect(state.status).toBe("active")
      expect(state.round).toBe(3)
      expect(state.wait).toBeUndefined()
      expect(t.session.sent.map((sent) => sent.marker.kind)).toEqual(["review", "next"])
    }),
  )

  it.effect("reviews a wait whose object is gone, and tells the agent why", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* t.loops.update(t.sessionID, undefined, { declaration: { kind: "await" }, wait: waitFor() })
      yield* t.end()
      t.session.gone.set("job_1", "The background job job_1 was lost in a restart.")
      yield* t.tick
      expect(t.session.sent).toHaveLength(1)
      expect(t.session.sent[0].marker.kind).toBe("review")
      expect(t.session.sent[0].text).toContain("The background job job_1 was lost in a restart.")
    }),
  )

  it.effect("turns a blocked analysis into a wait when something running can still unblock it", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      t.session.waitable = waitFor({ source: "watch_pr", wait_id: "watch_1", ref: { domain: "pr_watch", id: "watch_1" } })
      yield* round(t, ok(result({ verdict: "blocked", next_prompt: undefined })))
      const state = yield* t.current()
      expect(state.status).toBe("waiting")
      expect(state.wait?.wait_id).toBe("watch_1")
      expect(state.stop).toBeUndefined()
      expect(t.session.sent).toHaveLength(0)
    }),
  )

  it.effect("stops a blocked analysis with needs_user when nothing is running", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* round(t, ok(result({ verdict: "blocked", next_prompt: undefined })))
      const state = yield* t.current()
      expect(state.status).toBe("stopped")
      expect(state.stop).toMatchObject({ reason: "needs_user", detail: { code: "open_question" } })
    }),
  )

  it.effect("leaves the wait a blocked analysis created on its own deadline, and reviews it once it is over", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      // Like the real host, a wait is registered with a deadline counted from the moment it is asked for.
      t.session.waitable = (now) =>
        waitFor({
          source: "watch_pr",
          wait_id: "watch_1",
          ref: { domain: "pr_watch", id: "watch_1" },
          deadline: now + 60_000,
        })
      yield* round(t, ok(result({ verdict: "blocked", next_prompt: undefined })))
      let state = yield* t.current()
      expect(state.status).toBe("waiting")
      expect(state.wait?.deadline).toBe(60_000)
      expect(t.session.waitableCalls).toBe(1)

      // The periodic scan sees the same boundary and the same wait: there is nothing to decide again.
      yield* TestClock.adjust(30_000)
      yield* t.tick
      state = yield* t.current()
      expect(state.wait?.deadline).toBe(60_000)
      expect(t.session.waitableCalls).toBe(1)
      expect(t.session.requests).toHaveLength(0)

      // The deadline passes with the object still running: the wait ends in the review round, not in another wait.
      yield* TestClock.adjust(30_000)
      yield* t.tick
      state = yield* t.current()
      expect(t.session.sent).toHaveLength(1)
      expect(t.session.sent[0].marker).toEqual({ loopID: state.loop_id, round: 2, kind: "review" })
      expect(state.status).toBe("active")
      expect(state.wait?.reviewed).toBe(true)

      // A review that moves nothing ends the loop for the wait, as it does for any other wait.
      yield* round(t, ok(stalled))
      expect((yield* t.current()).stop?.reason).toBe("wait_expired")
    }),
  )

  it.effect(
    "reviews the wait a blocked analysis created once its object is gone, instead of stopping for the question again",
    () =>
      Effect.gen(function* () {
        const t = yield* boot()
        t.session.waitable = waitFor({
          source: "watch_pr",
          wait_id: "watch_1",
          ref: { domain: "pr_watch", id: "watch_1" },
        })
        yield* round(t, ok(result({ verdict: "blocked", next_prompt: undefined })))
        expect((yield* t.current()).status).toBe("waiting")

        // The watch is closed and nothing else is running.
        t.session.waitable = undefined
        t.session.gone.set("watch_1", "The PR watch watch_1 was closed.")
        yield* t.tick

        const state = yield* t.current()
        expect(state.stop).toBeUndefined()
        expect(state.status).toBe("active")
        expect(t.session.sent).toHaveLength(1)
        expect(t.session.sent[0].marker.kind).toBe("review")
        expect(t.session.sent[0].text).toContain("The PR watch watch_1 was closed.")
      }),
  )

  it.effect("analyses a user turn in a waiting loop and keeps waiting when it says continue", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* t.loops.update(t.sessionID, undefined, { declaration: { kind: "await" }, wait: waitFor() })
      yield* t.end()
      expect((yield* t.current()).status).toBe("waiting")

      const message = t.session.human("also keep the lockfile untouched")
      t.session.begin()
      t.script(
        ok(
          result({
            intent: intent({ constraints: ["Do not touch the shared runner", "Keep the lockfile untouched"] }),
            intent_change: { changed: true, basis_message_id: message, summary: "A constraint was added." },
          }),
        ),
      )
      t.session.finish({ humanTurn: true })
      yield* t.tick

      expect(t.calls()).toHaveLength(1)
      expect(t.calls()[0]?.humans).toEqual([{ id: message, text: "also keep the lockfile untouched" }])
      const state = yield* t.current()
      expect(state.status).toBe("waiting")
      expect(state.wait?.wait_id).toBe("job_1")
      // The first analysis of the loop, so the first revision of the intent whatever it reports as changed.
      expect(state.intent_revision).toBe(1)
      expect(state.intent?.constraints).toContain("Keep the lockfile untouched")
      expect(t.session.requests).toHaveLength(0)
    }),
  )

  /** A waiting loop that kept a prompt: a user turn in it was analysed as continue, and the prompt waits for the wait to end. */
  const keptPrompt = (deadline: number) =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* t.loops.update(t.sessionID, undefined, { declaration: { kind: "await" }, wait: waitFor({ deadline }) })
      yield* t.end()
      t.session.human("also mind the changelog")
      t.session.begin()
      t.script(ok(result({ next_prompt: "Mind the changelog." })))
      t.session.finish({ humanTurn: true })
      yield* t.tick
      const state = yield* t.current()
      expect([state.status, state.round, state.next_prompt]).toEqual(["waiting", 1, "Mind the changelog."])
      return t
    })

  it.effect("reviews the wait of a kept continue when its deadline passes, and carries the prompt in it", () =>
    Effect.gen(function* () {
      const t = yield* keptPrompt(60_000)

      // While the wait is alive and in time, a scan has nothing to decide.
      yield* TestClock.adjust(30_000)
      yield* t.tick
      expect(t.session.requests).toHaveLength(0)

      // The deadline passes with the job still running: the wait ends in the review round, not in an ordinary round.
      yield* TestClock.adjust(30_000)
      yield* t.tick
      let state = yield* t.current()
      expect(t.session.sent).toHaveLength(1)
      expect(t.session.sent[0].marker).toEqual({ loopID: state.loop_id, round: 2, kind: "review" })
      expect(t.session.sent[0].text).toContain("Waiting for background_job:job_1 timed out.")
      expect(t.session.sent[0].text).toContain("Mind the changelog.")
      expect([state.status, state.wait?.reviewed, state.next_prompt]).toEqual(["active", true, undefined])

      // A review that moves nothing ends the loop for the wait, as it does for any other wait.
      yield* round(t, ok(stalled))
      state = yield* t.current()
      expect(state.stop?.reason).toBe("wait_expired")
      expect(t.session.sent).toHaveLength(1)
    }),
  )

  it.effect("reviews the wait of a kept continue when its object is gone, not sending the prompt as a round", () =>
    Effect.gen(function* () {
      const t = yield* keptPrompt(3_600_000)
      t.session.gone.set("job_1", "The background job job_1 was lost in a restart.")
      yield* t.tick

      let state = yield* t.current()
      expect(t.session.sent).toHaveLength(1)
      expect(t.session.sent[0].marker).toEqual({ loopID: state.loop_id, round: 2, kind: "review" })
      expect(t.session.sent[0].text).toContain("The background job job_1 was lost in a restart.")
      expect(t.session.sent[0].text).toContain("Mind the changelog.")
      expect([state.status, state.wait?.reviewed, state.next_prompt]).toEqual(["active", true, undefined])

      yield* round(t, ok(stalled))
      state = yield* t.current()
      expect(state.stop?.reason).toBe("wait_expired")
      expect(t.session.sent).toHaveLength(1)
    }),
  )
})

describe("LoopRuntime user messages", () => {
  it.effect("analyses a human message merged into a running turn, and never stops for it", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* round(t)
      const message = t.session.human("also cover the empty case")
      yield* round(
        t,
        ok(
          result({
            intent: intent({ constraints: ["Do not touch the shared runner", "Cover the empty case"] }),
            intent_change: { changed: true, basis_message_id: message, summary: "Empty case added." },
            next_prompt: "Cover the empty case too.",
          }),
        ),
      )

      expect(t.calls()[1]?.humans).toEqual([{ id: message, text: "also cover the empty case" }])
      const state = yield* t.current()
      expect(state.status).toBe("active")
      expect(state.round).toBe(3)
      expect(state.intent_revision).toBe(2)
      expect(t.session.sent[1].text).toContain("Cover the empty case too.")
      expect(t.session.sent[1].text).toContain("- Cover the empty case")
    }),
  )

  it.effect("sends nothing until a waiting human message has its reply, then analyses it", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* round(t)
      t.session.finish()
      const message = t.session.human("wait, use the other approach")

      yield* t.tick
      yield* t.tick
      expect(t.calls()).toHaveLength(1)
      expect(t.session.sent).toHaveLength(1)
      expect((yield* t.current()).status).toBe("active")

      t.session.begin()
      yield* round(t, ok(result({ next_prompt: "Use the other approach." })), { humanTurn: true })
      expect(t.calls()[1]?.humans).toEqual([{ id: message, text: "wait, use the other approach" }])
      expect(t.session.sent).toHaveLength(2)
      expect(t.session.sent[1].text).toContain("Use the other approach.")
      expect((yield* t.current()).status).toBe("active")
    }),
  )

  it.effect("aborts the analysis when a new turn starts and commits nothing", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      const started = yield* Deferred.make<void>()
      t.script(
        (input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Effect.callback<void>((resume) => {
              input.abort.addEventListener("abort", () => resume(Effect.void), { once: true })
            })
            return failed({ kind: "cancelled" })
          }),
        ok(result({ next_prompt: "After the user's turn." })),
      )
      t.session.finish({ humanTurn: true })
      yield* t.runtime.claim(t.sessionID)
      yield* Deferred.await(started)
      expect((yield* t.current()).analyzing).toBeDefined()

      // The user types: the turn starts, the analysis is abandoned.
      t.session.human("one more thing")
      t.session.begin()
      yield* t.runtime.turnStarted(t.sessionID)
      yield* t.runtime.settled(t.sessionID)

      expect(yield* t.rows()).toHaveLength(0)
      expect((yield* t.current()).analyzing).toBeUndefined()
      expect(t.session.nudges).toBe(1)

      yield* round(t, undefined, { humanTurn: true })
      expect(t.calls()[1]?.humans).toHaveLength(1)
      expect((yield* t.current()).round).toBe(2)
    }),
  )

  it.effect("clears the previous boundary's declaration when a new turn starts", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* t.loops.update(t.sessionID, undefined, { declaration: { kind: "done", evidence: "all green" } })
      yield* t.runtime.turnStarted(t.sessionID)
      expect((yield* t.current()).declaration).toBeUndefined()
    }),
  )
})

describe("LoopRuntime fence", () => {
  it.effect("drops an analysis whose loop was written to meanwhile, and decides the boundary again", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      t.script(
        () =>
          t.loops.update(t.sessionID, undefined, { max_rounds: 30 }).pipe(Effect.as(ok(result({ next_prompt: "stale" })))),
        ok(result({ next_prompt: "fresh" })),
      )
      t.session.finish({ humanTurn: true })
      yield* t.tick

      expect(yield* t.rows()).toHaveLength(0)
      expect(t.session.nudges).toBe(1)
      expect(t.session.sent).toHaveLength(0)
      expect((yield* t.current()).round).toBe(1)

      // The nudge runs the boundary again: the stale mark is cleared and the boundary analysed afresh.
      yield* t.tick
      const state = yield* t.current()
      expect(t.calls()).toHaveLength(2)
      expect(yield* t.rows()).toHaveLength(1)
      expect(state.round).toBe(2)
      expect(state.max_rounds).toBe(30)
      expect(t.session.sent[0].text).toContain("fresh")
      expect(t.session.sent[0].text).not.toContain("stale")
    }),
  )

  it.effect("drops an analysis whose boundary moved on", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      t.script(() =>
        Effect.sync(() => {
          t.session.begin()
          t.session.finish()
        }).pipe(Effect.as(ok(result()))),
      )
      t.session.finish({ humanTurn: true })
      yield* t.tick
      expect(yield* t.rows()).toHaveLength(0)
      expect(t.session.nudges).toBe(1)
      expect((yield* t.current()).last_analyzed_msg).toBeUndefined()
    }),
  )

  it.effect("does not count a failed analysis against a turn that ended while it ran", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      const unavailable = failed({ kind: "provider", error: providerError(503) })
      t.script(
        // A human turn ends while the first analysis runs, and the provider fails that analysis.
        () =>
          Effect.sync(() => {
            t.session.human("Also add the changelog.")
            t.session.begin()
            t.session.finish({ humanTurn: true })
          }).pipe(Effect.as(unavailable)),
        unavailable,
        unavailable,
        ok(result({ next_prompt: "Add the changelog." })),
      )
      t.session.finish({ humanTurn: true })
      yield* t.tick

      // The failure belongs to the boundary that was left behind, not to the analysis of the new one: both retries the
      // ladder allows are still there for it, so the third analysis of that turn works and the loop goes on.
      expect(t.calls()).toHaveLength(4)
      const state = yield* t.current()
      expect([state.status, state.round, state.recovery]).toEqual(["active", 2, undefined])
      expect(t.session.sent.at(-1)?.text).toContain("Add the changelog.")
    }),
  )

  hooked.effect("does not apply an analysis to a turn that ended after it was analysed", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      t.script(
        ok(result({ verdict: "done", next_prompt: undefined })),
        ok(result({ next_prompt: "Add the changelog." })),
      )
      t.session.finish({ humanTurn: true })

      // A human turn ends just as that analysis commits, before the decision has looked at the session again.
      afterCommit.run = Effect.sync(() => {
        afterCommit.run = undefined
        t.session.human("Also add the changelog.")
        t.session.begin()
        t.session.finish({ humanTurn: true })
      })
      yield* t.tick

      // `done` was the verdict on the first turn. The new turn is a boundary of its own, and is analysed as one.
      expect(afterCommit.run).toBeUndefined()
      expect(t.calls()).toHaveLength(2)
      expect(t.calls()[1].humans).toEqual([{ id: expect.any(String), text: "Also add the changelog." }])
      const state = yield* t.current()
      expect([state.status, state.round]).toEqual(["active", 2])
      expect(t.session.sent.at(-1)?.text).toContain("Add the changelog.")
    }),
  )

  hooked.effect("does not apply an analysis to a loop that replaced the one it was made for", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      t.script(
        ok(result({ verdict: "done", next_prompt: undefined })),
        ok(result({ next_prompt: "Start on the new goal." })),
      )
      t.session.finish({ humanTurn: true })

      // A loop that has no first message, so holds no boundary back, replaces this one just as its analysis commits.
      afterCommit.run = Effect.suspend(() => {
        afterCommit.run = undefined
        return t.runtime.start(t.sessionID, { prompt: "A new goal." })
      })
      yield* t.tick

      // The old loop's `done` is not the new loop's: the new loop is not completed, and analyses the boundary itself.
      expect(afterCommit.run).toBeUndefined()
      expect(t.calls()).toHaveLength(2)
      const state = yield* t.current()
      expect([state.origin.prompt, state.status, state.round]).toEqual(["A new goal.", "active", 2])
      expect(t.session.sent.at(-1)?.text).toContain("Start on the new goal.")
    }),
  )

  it.effect("ignores the boundary of a loop it replaced until the new loop has run", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* round(t)
      t.session.finish()
      // The user starts a new loop. Its first message has an id, but is not in the session yet.
      yield* t.runtime.start(t.sessionID, { prompt: "A new goal.", messageID: "msg_9999" })
      yield* t.tick
      yield* t.tick
      expect(t.calls()).toHaveLength(1)
      expect(t.session.requests).toHaveLength(1)
    }),
  )
})

describe("LoopRuntime failures", () => {
  /** A loop at round 2, whose turn is running. */
  const atRound2 = Effect.gen(function* () {
    const t = yield* boot()
    yield* round(t)
    return t
  })

  it.effect("heals an interface error with two retries and three delayed probes before it stops", () =>
    Effect.gen(function* () {
      const t = yield* atRound2
      const failRound = () => {
        t.session.fail(providerError(503))
        return t.tick
      }

      // Level two: the failed round again, twice. A recovery is not a round.
      yield* failRound()
      yield* failRound()
      let state = yield* t.current()
      expect(t.session.sent.map((sent) => sent.marker.kind)).toEqual(["next", "recovery", "recovery"])
      expect(t.session.sent.every((sent) => sent.marker.round === 2)).toBe(true)
      expect(state.round).toBe(2)
      expect(state.recovery).toMatchObject({ attempts: 2, reset: 0, probes: 0 })

      // Level three: probes at 60 s, 300 s and 900 s. In between the loop is waiting for nothing but the clock.
      for (const [index, delay] of [60_000, 300_000, 900_000].entries()) {
        yield* failRound()
        state = yield* t.current()
        expect(state.status).toBe("waiting")
        expect(state.wait).toBeUndefined()
        expect(state.recovery?.probe_at).toBe((yield* Clock.currentTimeMillis) + delay)
        expect(state.recovery?.probes).toBe(index + 1)
        const sent = t.session.sent.length

        yield* t.tick
        expect(t.session.sent).toHaveLength(sent)
        yield* TestClock.adjust(delay - 1)
        yield* t.tick
        expect(t.session.sent).toHaveLength(sent)
        yield* TestClock.adjust(1)
        yield* t.tick
        expect(t.session.sent).toHaveLength(sent + 1)
        state = yield* t.current()
        expect(state.status).toBe("active")
        expect(state.recovery?.probe_at).toBeUndefined()
        expect(state.round).toBe(2)
      }

      // The last probe failed too: the ladder is spent.
      yield* failRound()
      state = yield* t.current()
      expect(state.status).toBe("stopped")
      expect(state.stop).toMatchObject({ reason: "provider_unavailable", detail: { status: 503 } })
      expect(state.round).toBe(2)
      expect(t.session.sent.map((sent) => sent.marker.kind)).toEqual([
        "next",
        "recovery",
        "recovery",
        "recovery",
        "recovery",
        "recovery",
      ])
    }),
  )

  it.effect("goes on when a retry works: the chain is over and the round count did not move", () =>
    Effect.gen(function* () {
      const t = yield* atRound2
      t.session.fail(providerError(503))
      yield* t.tick
      expect((yield* t.current()).recovery?.attempts).toBe(1)

      yield* round(t, ok(result({ next_prompt: "Next after the retry." })))
      const state = yield* t.current()
      expect(state.recovery).toBeUndefined()
      expect(state.round).toBe(3)
      expect(t.session.sent.map((sent) => sent.marker.kind)).toEqual(["next", "recovery", "next"])
    }),
  )

  it.effect("resets the reasoning state once, and gives up when the provider still refuses it", () =>
    Effect.gen(function* () {
      const t = yield* atRound2
      t.session.fail(reasoningError())
      yield* t.tick
      expect(t.session.sent).toHaveLength(2)
      expect(t.session.sent[1].marker.kind).toBe("recovery")
      expect(t.session.sent[1].reset).toBe(true)
      expect((yield* t.current()).recovery).toMatchObject({ reset: 1, attempts: 0 })

      t.session.fail(reasoningError())
      yield* t.tick
      const state = yield* t.current()
      expect(state.stop?.reason).toBe("provider_unavailable")
      expect(t.session.sent).toHaveLength(2)
    }),
  )

  it.effect("classifies a failed round that left no assistant message, and sends it again", () =>
    Effect.gen(function* () {
      const t = yield* atRound2
      // The turn died before it wrote a message: the boundary has none, but it is this loop's own.
      t.session.fail(providerError(503), { message: undefined })
      yield* t.tick

      let state = yield* t.current()
      expect(t.session.sent.map((sent) => sent.marker.kind)).toEqual(["next", "recovery"])
      expect(t.session.sent[1].boundary).toBeUndefined()
      expect(state.recovery).toMatchObject({ attempts: 1, boundary: "" })
      expect(state.round).toBe(2)

      // The retried turn works: its message ends the chain and the loop goes on.
      yield* round(t, ok(result({ next_prompt: "Next after the retry." })))
      state = yield* t.current()
      expect(state.recovery).toBeUndefined()
      expect(state.round).toBe(3)
    }),
  )

  it.effect("stops on a turn that left no message and no provider error, instead of staying active", () =>
    Effect.gen(function* () {
      const t = yield* atRound2
      t.session.finish({ message: undefined, turn: { type: "error", code: "UnknownError", retryable: false } })
      yield* t.tick
      const state = yield* t.current()
      expect(state.status).toBe("stopped")
      expect(state.stop).toMatchObject({ reason: "internal_error", detail: { code: "UnknownError" } })
    }),
  )

  it.effect("still ignores a boundary that left no message and ended before the loop began", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* round(t)
      // The old loop's last turn died without a message, before the user started a new loop.
      t.session.finish({
        message: undefined,
        turn: { type: "error", code: "UnknownError", retryable: false },
        endedAt: Date.now() - 60_000,
      })
      yield* t.runtime.start(t.sessionID, { prompt: "A new goal.", messageID: "msg_9999" })
      yield* t.tick
      yield* t.tick

      const state = yield* t.current()
      expect(state.status).toBe("active")
      expect(state.stop).toBeUndefined()
      expect(t.calls()).toHaveLength(1)
      expect(t.session.requests).toHaveLength(1)
    }),
  )

  it.effect("starts a new chain for an analysis that fails after the turn recovered", () =>
    Effect.gen(function* () {
      const t = yield* atRound2
      t.session.fail(providerError(503))
      yield* t.tick
      expect((yield* t.current()).recovery?.attempts).toBe(1)

      // The retried turn works; its analysis then fails three times. The turn's retry is not charged to it.
      const unavailable = failed({ kind: "provider", error: providerError(503) })
      const before = t.calls().length
      yield* t.end([unavailable, unavailable, unavailable])
      const state = yield* t.current()
      expect(t.calls().length - before).toBe(3)
      expect(state.status).toBe("waiting")
      expect(state.recovery).toMatchObject({ attempts: 2, probes: 1 })
    }),
  )

  it.effect("stops at once on an error that waiting cannot fix", () =>
    Effect.gen(function* () {
      const t = yield* atRound2
      t.session.fail(providerError(401))
      yield* t.tick
      const state = yield* t.current()
      expect(state.stop).toMatchObject({ reason: "provider_unavailable", detail: { status: 401 } })
      expect(t.session.sent).toHaveLength(1)
    }),
  )

  it.effect("does not redispatch a turn the user is present for", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      t.session.fail(providerError(503), { humanTurn: true })
      yield* t.tick
      const state = yield* t.current()
      expect(state.stop).toMatchObject({ reason: "provider_unavailable", detail: { status: 503 } })
      expect(t.session.requests).toHaveLength(0)
    }),
  )

  it.effect("ends the probe wait when another turn works, and decides its boundary as an ordinary one", () =>
    Effect.gen(function* () {
      const t = yield* atRound2
      for (let attempt = 0; attempt < 3; attempt++) {
        t.session.fail(providerError(503))
        yield* t.tick
      }
      expect((yield* t.current()).recovery?.probe_at).toBeDefined()

      t.session.human("are you there?")
      t.session.begin()
      t.script(ok(result({ next_prompt: "Back to work." })))
      t.session.finish({ humanTurn: true })
      yield* t.tick

      const state = yield* t.current()
      expect(state.recovery).toBeUndefined()
      expect(state.status).toBe("active")
      expect(state.round).toBe(3)
      expect(t.session.sent.at(-1)?.text).toContain("Back to work.")
    }),
  )

  it.effect("leaves the probe plan alone when another turn fails meanwhile", () =>
    Effect.gen(function* () {
      const t = yield* atRound2
      for (let attempt = 0; attempt < 3; attempt++) {
        t.session.fail(providerError(503))
        yield* t.tick
      }
      const before = yield* t.current()
      const sent = t.session.sent.length

      t.session.human("hello?")
      t.session.begin()
      t.session.fail(providerError(503), { humanTurn: true })
      yield* t.tick

      const after = yield* t.current()
      expect(after.recovery).toEqual(before.recovery)
      expect(after.status).toBe("waiting")
      expect(t.session.sent).toHaveLength(sent)
    }),
  )

  it.effect("probes when it comes due although another turn failed meanwhile", () =>
    Effect.gen(function* () {
      const t = yield* atRound2
      for (let attempt = 0; attempt < 3; attempt++) {
        t.session.fail(providerError(503))
        yield* t.tick
      }
      expect((yield* t.current()).recovery?.probe_at).toBe(60_000)

      // The user writes while the provider is down, and their turn fails too: the plan stays as it is.
      t.session.human("hello?")
      t.session.begin()
      t.session.fail(providerError(503), { humanTurn: true })
      yield* t.tick
      const sent = t.session.sent.length
      expect((yield* t.current()).recovery?.probe_at).toBe(60_000)

      // It is still due at probe_at, and it redoes the failed step.
      yield* TestClock.adjust(59_999)
      yield* t.tick
      expect(t.session.sent).toHaveLength(sent)
      yield* TestClock.adjust(1)
      yield* t.tick

      const state = yield* t.current()
      expect(t.session.sent).toHaveLength(sent + 1)
      expect(t.session.sent.at(-1)?.marker).toEqual({ loopID: state.loop_id, round: 2, kind: "recovery" })
      expect(state.status).toBe("active")
      expect(state.recovery).toMatchObject({ attempts: 2, probes: 1 })
      expect(state.recovery?.probe_at).toBeUndefined()
      expect(state.round).toBe(2)
    }),
  )

  it.effect("probes by sending the round again when the latest boundary left no message to analyse", () =>
    Effect.gen(function* () {
      const t = yield* atRound2
      for (let attempt = 0; attempt < 3; attempt++) {
        t.session.fail(providerError(503))
        yield* t.tick
      }
      const sent = t.session.sent.length
      // Another turn was cut off before it wrote anything: its boundary has no message, so there is nothing to analyse there.
      t.session.finish({ message: undefined, turn: { type: "cancelled", reason: undefined } })
      yield* TestClock.adjust(60_000)
      yield* t.tick

      expect(t.session.sent).toHaveLength(sent + 1)
      expect(t.session.sent.at(-1)?.marker.kind).toBe("recovery")
      expect((yield* t.current()).status).toBe("active")
    }),
  )

  /**
   * Fails the round until the loop waits for its `index`th delayed probe, each probe before it having been sent and
   * having failed too. Resolves to that probe's delay.
   */
  const waitingForProbe = (t: Harness, index: 1 | 2 | 3) =>
    Effect.gen(function* () {
      const delays = [60_000, 300_000, 900_000] as const
      for (let attempt = 0; attempt < 3; attempt++) {
        t.session.fail(providerError(503))
        yield* t.tick
      }
      for (let probe = 1; probe < index; probe++) {
        yield* TestClock.adjust(delays[probe - 1])
        yield* t.tick
        t.session.fail(providerError(503))
        yield* t.tick
      }
      expect((yield* t.current()).recovery?.probes).toBe(index)
      return delays[index - 1]
    })

  for (const { name, index } of [
    { name: "the first delayed probe", index: 1 },
    { name: "the last one", index: 3 },
  ] as const) {
    it.effect(`keeps ${name} owed until its message is admitted, so a process that dies before that still probes`, () =>
      Effect.gen(function* () {
        const t = yield* atRound2
        const delay = yield* waitingForProbe(t, index)
        const waiting = yield* t.current()
        const sent = t.session.sent.length
        yield* TestClock.adjust(delay)

        // The probe is due, and the process dies while the host has not yet admitted its message.
        const entered = yield* Deferred.make<void>()
        t.session.gate = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
        const dying = yield* Effect.scoped(t.runtime.claim(t.sessionID).pipe(Effect.andThen(Effect.never))).pipe(
          Effect.forkChild,
        )
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(dying)

        // Nothing was written: the probe is still owed, with the chain as it was.
        expect(yield* t.current()).toEqual(waiting)
        expect(t.session.sent).toHaveLength(sent)

        // After the restart it is still due, and it runs: the attempt that never started did not use it up.
        t.session.gate = undefined
        host.liveSessions.splice(0, host.liveSessions.length, { sessionID: t.sessionID, status: "waiting" })
        yield* t.runtime.init("/repo")
        yield* t.runtime.settled(t.sessionID)
        const state = yield* t.current()
        expect(t.session.sent).toHaveLength(sent + 1)
        expect(t.session.sent.at(-1)?.marker.kind).toBe("recovery")
        expect([state.status, state.round]).toEqual(["active", 2])
        expect(state.recovery).toMatchObject({ attempts: 2, probes: index })
        expect(state.recovery?.probe_at).toBeUndefined()
      }),
    )
  }

  it.effect("leaves a due probe owed when the session refuses its message, and sends it at the next decision", () =>
    Effect.gen(function* () {
      const t = yield* atRound2
      const delay = yield* waitingForProbe(t, 1)
      const waiting = yield* t.current()
      const sent = t.session.sent.length
      yield* TestClock.adjust(delay)

      // The session cannot take the message: nothing is written, and the probe stays owed rather than spent.
      t.session.answer = "refused"
      yield* t.tick
      expect(yield* t.current()).toEqual(waiting)
      expect(t.session.sent).toHaveLength(sent)

      t.session.answer = undefined
      yield* t.tick
      const state = yield* t.current()
      expect(t.session.sent).toHaveLength(sent + 1)
      expect(t.session.sent.at(-1)?.marker.kind).toBe("recovery")
      expect([state.status, state.recovery?.probes]).toEqual(["active", 1])
    }),
  )

  it.effect("retries a failed analysis, probes, and analyses again when the probe is due", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      const unavailable = failed({ kind: "provider", error: providerError(503) })
      t.script(unavailable, unavailable, unavailable, ok(result({ next_prompt: "Recovered." })))
      t.session.finish({ humanTurn: true })
      yield* t.tick

      let state = yield* t.current()
      expect(t.calls()).toHaveLength(3)
      expect(state.status).toBe("waiting")
      expect(state.recovery).toMatchObject({ attempts: 2, probes: 1 })
      expect(state.analyzing).toBeUndefined()
      expect(t.session.requests).toHaveLength(0)

      yield* TestClock.adjust(60_000)
      yield* t.tick
      state = yield* t.current()
      expect(t.calls()).toHaveLength(4)
      expect(state.status).toBe("active")
      expect(state.round).toBe(2)
      expect(state.recovery).toBeUndefined()
      expect(t.session.sent[0].text).toContain("Recovered.")
    }),
  )

  it.effect("analyses the boundary again when a restart interrupted the analysis of a probe", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      const unavailable = failed({ kind: "provider", error: providerError(503) })
      const entered = yield* Deferred.make<void>()
      t.script(
        unavailable,
        unavailable,
        unavailable,
        () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        ok(result({ next_prompt: "Recovered." })),
      )
      t.session.finish({ humanTurn: true })
      yield* t.tick
      expect((yield* t.current()).recovery).toMatchObject({ probes: 1, step: "analysis" })

      // The probe is due and its analysis is running when the process dies. An analysis has no message to admit, so the
      // loop is already active; what a restart finds is an ordinary boundary that has not been analysed.
      yield* TestClock.adjust(60_000)
      const dying = yield* Effect.scoped(t.runtime.claim(t.sessionID).pipe(Effect.andThen(Effect.never))).pipe(
        Effect.forkChild,
      )
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(dying)
      expect((yield* t.current()).status).toBe("active")

      host.liveSessions.splice(0, host.liveSessions.length, { sessionID: t.sessionID, status: "active" })
      yield* t.runtime.init("/repo")
      yield* t.runtime.settled(t.sessionID)
      const state = yield* t.current()
      expect(t.calls()).toHaveLength(5)
      expect([state.status, state.round, state.analyzing]).toEqual(["active", 2, undefined])
      expect(t.session.sent[0].text).toContain("Recovered.")
    }),
  )

  const stops: ReadonlyArray<{
    name: string
    boundary: Parameters<FakeSession["finish"]>[0]
    expected: object
  }> = [
    { name: "a refused permission prompt", boundary: { userRejected: true }, expected: { reason: "needs_user", detail: { code: "rejected" } } },
    { name: "a hook that stopped the turn", boundary: { hookStop: { message: "blocked by policy" } }, expected: { reason: "hook_stopped", detail: { message: "blocked by policy" } } },
    { name: "a context overflow", boundary: { turn: { type: "context_overflow" } }, expected: { reason: "context_exhausted" } },
    { name: "a content filter", boundary: { turn: { type: "content_filter" } }, expected: { reason: "content_refused" } },
    { name: "a turn that died on a defect", boundary: { turn: { type: "error", code: "UnknownError", retryable: false } }, expected: { reason: "internal_error", detail: { code: "UnknownError" } } },
  ]
  for (const { name, boundary, expected } of stops) {
    it.effect(`stops, and does not analyse, on ${name}`, () =>
      Effect.gen(function* () {
        const t = yield* atRound2
        t.session.finish(boundary)
        yield* t.tick
        const state = yield* t.current()
        expect(state.status).toBe("stopped")
        expect(state.stop).toMatchObject(expected)
        expect(t.calls()).toHaveLength(1)
      }),
    )
  }

  it.effect("stops with analysis_failed when the analysis overruns its limits", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* round(t, failed({ kind: "limit", limit: "steps" }))
      expect((yield* t.current()).stop).toMatchObject({ reason: "analysis_failed", detail: { code: "limit" } })
    }),
  )

  it.effect("stops the loop when starting the turn fails, instead of leaving it active", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      t.session.die = true
      yield* round(t)
      const state = yield* t.current()
      expect(state.status).toBe("stopped")
      expect(state.stop).toMatchObject({ reason: "internal_error", detail: { code: "dispatch_failed" } })
    }),
  )

  it.effect("maps the analysis's other verdicts to their stop reasons", () =>
    Effect.gen(function* () {
      const cases = [
        { verdict: "done", reason: "completed", status: "completed" },
        { verdict: "goal_changed", reason: "goal_changed", status: "cancelled" },
        { verdict: "user_stop", reason: "user_stopped", status: "stopped" },
      ] as const
      for (const item of cases) {
        const t = yield* boot()
        const message = t.session.human("a message that moves the goal")
        t.session.finish({ humanTurn: true })
        t.script(
          ok(
            result({
              verdict: item.verdict,
              next_prompt: undefined,
              intent_change: { changed: item.verdict === "goal_changed", basis_message_id: message },
            }),
          ),
        )
        yield* t.tick
        if (item.status === "stopped") {
          const state = yield* t.current()
          expect(state.stop).toMatchObject({ reason: item.reason })
        } else {
          const outcome = yield* t.outcome()
          expect(outcome?.status).toBe(item.status)
          expect(outcome?.stop?.reason).toBe(item.reason)
          expect(yield* t.load()).toBeUndefined()
        }
      }
    }),
  )
})

describe("LoopRuntime commands", () => {
  it.effect("stops, completes and clears as the commands say", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* round(t)

      expect((yield* t.runtime.act(t.sessionID, "stop")).tag).toBe("stopped")
      expect((yield* t.current()).stop).toMatchObject({ reason: "user_stopped" })
      // Stopping a stopped loop keeps what it stopped with.
      expect((yield* t.runtime.act(t.sessionID, "stop")).tag).toBe("unchanged")
      expect((yield* t.runtime.act(t.sessionID, "interrupt")).tag).toBe("unchanged")
      expect((yield* t.current()).stop?.reason).toBe("user_stopped")

      const done = yield* t.runtime.act(t.sessionID, "done")
      expect(done.tag).toBe("ended")
      expect(yield* t.load()).toBeUndefined()
      expect(yield* t.outcome()).toMatchObject({ status: "completed", stop: { reason: "completed" } })
      expect((yield* t.runtime.act(t.sessionID, "stop")).tag).toBe("none")
    }),
  )

  it.effect("clears a live loop as user_stopped and a stopped one with the reason it had", () =>
    Effect.gen(function* () {
      const live = yield* boot()
      yield* live.runtime.clear(live.sessionID)
      expect(yield* live.load()).toBeUndefined()
      expect(yield* live.outcome()).toMatchObject({ status: "cancelled", stop: { reason: "user_stopped" } })

      const stopped = yield* boot({ maxRounds: 1 })
      yield* round(stopped)
      expect((yield* stopped.current()).stop?.reason).toBe("budget_exhausted")
      yield* stopped.runtime.clear(stopped.sessionID)
      expect(yield* stopped.load()).toBeUndefined()
      expect(yield* stopped.outcome()).toMatchObject({ status: "cancelled", stop: { reason: "budget_exhausted" } })
    }),
  )

  it.effect("interrupts as user_interrupted, whatever is running", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* round(t)
      t.session.begin()
      expect((yield* t.runtime.act(t.sessionID, "interrupt")).tag).toBe("stopped")
      expect((yield* t.current()).stop?.reason).toBe("user_interrupted")
    }),
  )

  it.effect("aborts the analysis in flight when a command stops the loop, and commits nothing", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      const started = yield* Deferred.make<void>()
      t.script((input) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          yield* Effect.callback<void>((resume) => {
            input.abort.addEventListener("abort", () => resume(Effect.void), { once: true })
          })
          return failed({ kind: "cancelled" })
        }),
      )
      t.session.finish({ humanTurn: true })
      yield* t.runtime.claim(t.sessionID)
      yield* Deferred.await(started)

      yield* t.runtime.act(t.sessionID, "stop")
      yield* t.runtime.settled(t.sessionID)

      const state = yield* t.current()
      expect(state.status).toBe("stopped")
      expect(state.analyzing).toBeUndefined()
      expect(yield* t.rows()).toHaveLength(0)
      expect(t.session.sent).toHaveLength(0)
    }),
  )

  it.effect("ends a live loop as goal_changed when a new one starts", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      const replacement = yield* t.runtime.start(t.sessionID, { prompt: "A different goal." })
      expect(replacement.replaced?.stop).toMatchObject({ reason: "goal_changed", detail: { code: "explicit" } })
      expect(replacement.state.loop_id).not.toBe(t.created.state.loop_id)
      expect(yield* t.outcome()).toMatchObject({ status: "cancelled" })
    }),
  )

  it.effect("treats an ESC that lands before the dispatch as an interrupt", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      t.script(ok(result()))
      t.session.finish({ humanTurn: true })
      // The inbox observed the epoch, then the user pressed ESC.
      const observed = t.session.epoch
      t.session.epoch += 1
      yield* t.runtime.claim(t.sessionID, { claimEpoch: observed })
      yield* t.runtime.settled(t.sessionID)
      const state = yield* t.current()
      expect(state.status).toBe("stopped")
      expect(state.stop?.reason).toBe("user_interrupted")
      expect(state.round).toBe(1)
    }),
  )

  it.effect("does not let a late cancel stop a loop that was resumed after the ESC", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      t.script(ok(result({ next_prompt: "Go on." })))
      t.session.finish({ humanTurn: true })
      // The host holds the admission of round 2's message while the user presses ESC.
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      t.session.gate = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
      yield* t.runtime.claim(t.sessionID)
      yield* Deferred.await(entered)

      t.session.epoch += 1
      expect((yield* t.runtime.act(t.sessionID, "interrupt")).tag).toBe("stopped")
      // The user resumes before the old dispatch has answered; it answers `cancelled`, for an ESC the loop already took.
      expect((yield* t.runtime.resume(t.sessionID)).tag).toBe("resumed")
      yield* Deferred.succeed(release, undefined)
      yield* t.runtime.settled(t.sessionID)

      // The stale cancel wrote nothing; the resumed loop went on with the round it had analysed.
      const state = yield* t.current()
      expect([state.status, state.round, state.stop]).toEqual(["active", 2, undefined])
      expect(t.session.requests).toHaveLength(2)
      expect(t.session.sent).toHaveLength(1)
      expect(t.session.sent[0].text).toContain("Go on.")
    }),
  )

  it.effect("ends a loop whose session was archived", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* t.runtime.archive(t.sessionID)
      expect(yield* t.load()).toBeUndefined()
      expect(yield* t.outcome()).toMatchObject({ status: "cancelled", stop: { reason: "session_archived" } })
    }),
  )
})

describe("LoopRuntime resume", () => {
  const stoppedBy: ReadonlyArray<{ name: string; reason: StopReason; fail: (t: Harness) => void }> = [
    { name: "an interface error", reason: "provider_unavailable", fail: (t) => t.session.fail(providerError(401)) },
    { name: "a context overflow", reason: "context_exhausted", fail: (t) => t.session.finish({ turn: { type: "context_overflow" } }) },
    { name: "a hook", reason: "hook_stopped", fail: (t) => t.session.finish({ hookStop: { message: "no" } }) },
    { name: "a refused prompt", reason: "needs_user", fail: (t) => t.session.finish({ userRejected: true }) },
  ]
  for (const item of stoppedBy) {
    it.effect(`analyses first and does not stop again for ${item.name}`, () =>
      Effect.gen(function* () {
        const t = yield* boot()
        yield* round(t)
        item.fail(t)
        yield* t.tick
        expect((yield* t.current()).stop?.reason).toBe(item.reason)

        t.script(ok(result({ next_prompt: "Carry on after the stop." })))
        const resumed = yield* t.runtime.resume(t.sessionID)
        expect(resumed.tag).toBe("resumed")
        yield* t.runtime.settled(t.sessionID)

        const next = yield* t.current()
        expect(next.status).toBe("active")
        expect(next.stop).toBeUndefined()
        expect(next.recovery).toBeUndefined()
        expect(next.no_progress_streak).toBe(0)
        expect(next.round).toBe(3)
        expect(t.calls()).toHaveLength(2)
        // What the stopped turn did is still told to the analysis.
        expect(t.calls()[1].outcome).toEqual(t.session.boundary?.turn ?? { type: "completed" })
        expect(t.session.sent.at(-1)?.text).toContain("Carry on after the stop.")
      }),
    )
  }

  it.effect("dispatches the stored prompt without analysing when the boundary was already analysed", () =>
    Effect.gen(function* () {
      const t = yield* boot({ maxRounds: 2 })
      yield* round(t)
      yield* round(t, ok(result({ next_prompt: "One more round." })))
      expect((yield* t.current()).stop?.reason).toBe("budget_exhausted")
      const calls = t.calls().length

      const resumed = yield* t.runtime.resume(t.sessionID)
      yield* t.runtime.settled(t.sessionID)

      // No limit given and the budget was spent: exactly one more round.
      expect(resumed.tag === "resumed" && resumed.state.max_rounds).toBe(3)
      expect(t.calls()).toHaveLength(calls)
      const state = yield* t.current()
      expect(state.round).toBe(3)
      expect(t.session.sent.at(-1)?.text).toContain("One more round.")
    }),
  )

  it.effect("takes a new round limit only above the current round", () =>
    Effect.gen(function* () {
      const t = yield* boot({ maxRounds: 1 })
      yield* round(t)
      expect((yield* t.runtime.resume(t.sessionID, { maxRounds: 1 })).tag).toBe("invalid")
      expect((yield* t.current()).status).toBe("stopped")
      const resumed = yield* t.runtime.resume(t.sessionID, { maxRounds: 5 })
      yield* t.runtime.settled(t.sessionID)
      expect(resumed.tag === "resumed" && resumed.state.max_rounds).toBe(5)
      expect((yield* t.current()).round).toBe(2)
    }),
  )

  it.effect("resumes only a stopped loop", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      expect((yield* t.runtime.resume(t.sessionID)).tag).toBe("running")
      yield* t.runtime.clear(t.sessionID)
      expect((yield* t.runtime.resume(t.sessionID)).tag).toBe("none")
    }),
  )

  /** A loop at round 2 whose turn ended on a hook's stop, so the loop stopped there. */
  const stoppedByHook = Effect.gen(function* () {
    const t = yield* boot()
    yield* round(t)
    t.session.finish({ hookStop: { message: "blocked by policy" } })
    yield* t.tick
    expect((yield* t.current()).stop?.reason).toBe("hook_stopped")
    return t
  })

  it.effect("keeps the mask of the boundary it stopped at while the analysis is retried and probed", () =>
    Effect.gen(function* () {
      const t = yield* stoppedByHook
      const before = t.calls().length

      // The analysis of that boundary fails three times on the provider: the resumed loop plans a probe.
      const unavailable = failed({ kind: "provider", error: providerError(503) })
      t.script(unavailable, unavailable, unavailable, ok(result({ next_prompt: "Carry on after the hook." })))
      expect((yield* t.runtime.resume(t.sessionID)).tag).toBe("resumed")
      yield* t.runtime.settled(t.sessionID)
      let state = yield* t.current()
      expect([state.status, state.recovery?.probes]).toEqual(["waiting", 1])
      expect(t.calls().length - before).toBe(3)

      // The probe comes due and the analysis works: the hook's stop was handled before, and is not applied again.
      yield* TestClock.adjust(60_000)
      yield* t.tick
      state = yield* t.current()
      expect(t.calls().length - before).toBe(4)
      expect(state.stop).toBeUndefined()
      expect([state.status, state.round]).toEqual(["active", 3])
      expect(t.session.sent.at(-1)?.text).toContain("Carry on after the hook.")
    }),
  )

  it.effect("keeps the mask when the analysis after a resume loses its fence and the boundary is decided again", () =>
    Effect.gen(function* () {
      const t = yield* stoppedByHook

      // A command writes the loop while the analysis runs: its result is stale, and the same boundary is decided again.
      t.script(
        () =>
          t.loops
            .update(t.sessionID, undefined, { max_rounds: 30 })
            .pipe(Effect.as(ok(result({ next_prompt: "stale" })))),
        ok(result({ next_prompt: "Carry on after the hook." })),
      )
      yield* t.runtime.resume(t.sessionID)
      yield* t.runtime.settled(t.sessionID)
      expect(t.session.nudges).toBe(1)
      expect((yield* t.current()).status).toBe("active")

      yield* t.tick
      const state = yield* t.current()
      expect(state.stop).toBeUndefined()
      expect([state.status, state.round, state.max_rounds]).toEqual(["active", 3, 30])
      expect(t.session.sent.at(-1)?.text).toContain("Carry on after the hook.")
    }),
  )

  it.effect("probes by analysing again when the analysis of a resumed error boundary is the step that failed", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* round(t)
      // The round ends on an error that waiting cannot fix: the loop stops at that boundary.
      t.session.fail(providerError(401))
      yield* t.tick
      expect((yield* t.current()).stop?.reason).toBe("provider_unavailable")
      const calls = t.calls().length
      const sent = t.session.sent.length

      // Resumed, the boundary is analysed first. The provider is down for that: two retries, then a probe is planned.
      const unavailable = failed({ kind: "provider", error: providerError(503) })
      t.script(unavailable, unavailable, unavailable, ok(result({ next_prompt: "Carry on." })))
      expect((yield* t.runtime.resume(t.sessionID)).tag).toBe("resumed")
      yield* t.runtime.settled(t.sessionID)
      let state = yield* t.current()
      expect([state.status, state.recovery?.probes, state.recovery?.step]).toEqual(["waiting", 1, "analysis"])
      expect(t.calls().length - calls).toBe(3)

      // The probe comes due at the boundary whose turn ended on the error. What failed was the analysis, so that is what
      // runs again: sending the round would run into the old error and stop the loop with the analysis's retries unspent.
      yield* TestClock.adjust(60_000)
      yield* t.tick
      state = yield* t.current()
      expect(t.calls().length - calls).toBe(4)
      expect(t.session.sent.slice(sent).map((request) => request.marker.kind)).toEqual(["next"])
      expect([state.status, state.round]).toEqual(["active", 3])
      expect(state.stop).toBeUndefined()
      expect(t.session.sent.at(-1)?.text).toContain("Carry on.")
    }),
  )

  it.effect("probes by sending the round again when a failed round is what the chain recorded", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* round(t)
      for (let attempt = 0; attempt < 3; attempt++) {
        t.session.fail(providerError(503))
        yield* t.tick
      }
      expect((yield* t.current()).recovery?.step).toBe("round")
      const calls = t.calls().length
      const sent = t.session.sent.length

      yield* TestClock.adjust(60_000)
      yield* t.tick
      expect(t.calls().length).toBe(calls)
      expect(t.session.sent.slice(sent).map((request) => request.marker.kind)).toEqual(["recovery"])
    }),
  )

  it.effect("reads the step off the boundary for a probe planned before the chain recorded one", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* round(t)
      for (let attempt = 0; attempt < 3; attempt++) {
        t.session.fail(providerError(503))
        yield* t.tick
      }
      const { recovery } = yield* t.current()
      if (recovery === undefined) throw new Error("no probe was planned")
      // The same plan as an older build wrote it: no step.
      yield* t.loops.update(t.sessionID, undefined, { recovery: { ...recovery, step: undefined } })
      expect((yield* t.current()).recovery?.step).toBeUndefined()
      const sent = t.session.sent.length

      // A turn that ended on an error is a round to send again.
      yield* TestClock.adjust(60_000)
      yield* t.tick
      expect(t.session.sent.slice(sent).map((request) => request.marker.kind)).toEqual(["recovery"])
    }),
  )

  it.effect("ends the mask at the next boundary: a hook that stops a later turn stops the loop again", () =>
    Effect.gen(function* () {
      const t = yield* stoppedByHook
      const unavailable = failed({ kind: "provider", error: providerError(503) })
      t.script(unavailable, unavailable, unavailable)
      yield* t.runtime.resume(t.sessionID)
      yield* t.runtime.settled(t.sessionID)
      expect((yield* t.current()).status).toBe("waiting")

      // Another turn ends while the probe is pending, and a hook stops it: that is a boundary of its own.
      t.session.begin()
      t.session.finish({ hookStop: { message: "a second policy" } })
      yield* t.tick
      const state = yield* t.current()
      expect(state.status).toBe("stopped")
      expect(state.stop).toMatchObject({ reason: "hook_stopped", detail: { message: "a second policy" } })
    }),
  )
})

describe("LoopRuntime startup", () => {
  it.effect("clears a mark left by a dead process and analyses the boundary once", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      t.session.finish({ humanTurn: true })
      yield* t.loops.update(t.sessionID, undefined, {
        analyzing: { boundary: t.session.boundary?.message ?? "", started_at: 1 },
      })
      t.script(ok(result()))
      host.liveSessions.splice(0, host.liveSessions.length, { sessionID: t.sessionID, status: "active" })

      yield* t.runtime.init("/repo")
      yield* t.runtime.settled(t.sessionID)

      expect(t.calls()).toHaveLength(1)
      const state = yield* t.current()
      expect(state.analyzing).toBeUndefined()
      expect(state.round).toBe(2)
      expect(yield* t.rows()).toHaveLength(1)
    }),
  )

  it.effect("dispatches an analysed boundary's stored prompt without analysing again", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      t.session.answer = "refused"
      yield* round(t, ok(result({ next_prompt: "Left over from before the crash." })))
      t.session.answer = undefined
      host.liveSessions.splice(0, host.liveSessions.length, { sessionID: t.sessionID, status: "active" })

      yield* t.runtime.init("/repo")
      yield* t.runtime.settled(t.sessionID)

      expect(t.calls()).toHaveLength(1)
      expect(t.session.sent).toHaveLength(1)
      expect(t.session.sent[0].text).toContain("Left over from before the crash.")
    }),
  )

  it.effect("fires a probe that came due while the process was down", () =>
    Effect.gen(function* () {
      const t = yield* boot()
      yield* round(t)
      for (let attempt = 0; attempt < 3; attempt++) {
        t.session.fail(providerError(503))
        yield* t.tick
      }
      const sent = t.session.sent.length
      expect((yield* t.current()).recovery?.probe_at).toBeDefined()
      yield* TestClock.adjust(61_000)
      host.liveSessions.splice(0, host.liveSessions.length, { sessionID: t.sessionID, status: "waiting" })

      yield* t.runtime.init("/repo")
      yield* t.runtime.settled(t.sessionID)
      expect(t.session.sent).toHaveLength(sent + 1)
    }),
  )

  it.effect("lists only waiting loops for the periodic scan", () =>
    Effect.gen(function* () {
      const runtime = yield* LoopRuntime.Service
      const waiting = SessionID.descending()
      const active = SessionID.descending()
      host.liveSessions.splice(
        0,
        host.liveSessions.length,
        { sessionID: waiting, status: "waiting" },
        { sessionID: active, status: "active" },
      )
      expect(yield* runtime.scan("/repo")).toEqual([waiting])
    }),
  )

  it.effect("does not take a session that has no live loop", () =>
    Effect.gen(function* () {
      const runtime = yield* LoopRuntime.Service
      expect(yield* runtime.claim(SessionID.descending())).toBe(false)
    }),
  )
})
