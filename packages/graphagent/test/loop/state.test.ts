// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Exit, Layer, Schema } from "effect"
import { Database } from "@graphagent/core/database/database"
import { LoopAnalysisTable, LoopOutcomeTable, LoopStateTable } from "@graphagent/core/loop/sql"
import type { LoopIntent } from "@graphagent/schema/loop"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LoopState } from "@/loop/state"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { intent, progress, result } from "./fixture"

// EventV2Bridge is shared between LoopState (which publishes through it) and the
// test (which listens): `provideMerge` exposes the built instance in the output
// context while feeding it to LoopState, a plain `provide` would consume it.
// Every test uses its own session id: loop_state.session_id is the primary key.
const testLayer = LoopState.layer.pipe(
  Layer.provideMerge(Database.defaultLayer),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
)

const it = testEffect(testLayer)

type Seen = { readonly type: string; readonly data: any }

const capture = (events: EventV2Bridge.Service["Service"], sessionID: SessionID) =>
  Effect.gen(function* () {
    const seen: Seen[] = []
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => {
        const data: unknown = event.data
        if (typeof data === "object" && data !== null && "sessionID" in data && data.sessionID === sessionID)
          seen.push({ type: event.type, data })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    return seen
  })

/** Rows of the three tables, read around the service. */
const rows = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return {
      state: yield* db
        .select()
        .from(LoopStateTable)
        .where(eq(LoopStateTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie),
      outcome: yield* db
        .select()
        .from(LoopOutcomeTable)
        .where(eq(LoopOutcomeTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie),
      analysis: yield* db
        .select()
        .from(LoopAnalysisTable)
        .where(eq(LoopAnalysisTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie),
    }
  })

const session = () => SessionID.descending()

describe("LoopState.create", () => {
  it.live("starts an active loop at round 1 and revision 0 with the prompt verbatim", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const events = yield* EventV2Bridge.Service
      const sessionID = session()
      const seen = yield* capture(events, sessionID)
      const prompt = "  Make the build green.\n\n  Do not touch the lockfile.  "

      const { state, replaced } = yield* loops.create(sessionID, { prompt, messageID: "msg_human" })

      expect(replaced).toBeUndefined()
      expect(state.status).toBe("active")
      expect(state.round).toBe(1)
      expect(state.max_rounds).toBe(LoopState.DEFAULT_MAX_ROUNDS)
      expect(LoopState.DEFAULT_MAX_ROUNDS).toBe(20)
      expect(state.revision).toBe(0)
      expect(state.intent_revision).toBe(0)
      expect(state.no_progress_streak).toBe(0)
      expect(state.origin.prompt).toBe(prompt)
      expect(state.origin.message_id).toBe("msg_human")
      expect(state.origin.analysis).toBeUndefined()
      expect(yield* loops.load(sessionID)).toEqual(state)

      expect(seen.map((event) => event.type)).toEqual(["loop.updated"])
      expect(seen[0].data.loop).toMatchObject({
        loopID: state.loop_id,
        status: "active",
        round: 1,
        maxRounds: 20,
        prompt,
        analyzing: false,
        intentRevision: 0,
      })
    }),
  )

  it.live("takes the round limit it is given", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const { state } = yield* loops.create(session(), { prompt: "go", maxRounds: 3 })
      expect(state.max_rounds).toBe(3)
    }),
  )

  it.live("ends the live loop it replaces as cancelled, goal_changed explicit, in the same transaction", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const events = yield* EventV2Bridge.Service
      const sessionID = session()
      const first = (yield* loops.create(sessionID, { prompt: "first" })).state
      const seen = yield* capture(events, sessionID)

      const created = yield* loops.create(sessionID, { prompt: "second" })

      expect(created.state.loop_id).not.toBe(first.loop_id)
      expect(created.state.revision).toBe(0)
      expect(created.replaced).toMatchObject({
        loop_id: first.loop_id,
        status: "cancelled",
        revision: first.revision + 1,
        stop: { reason: "goal_changed", detail: { code: "explicit" } },
      })
      expect(yield* loops.load(sessionID)).toEqual(created.state)
      expect(yield* loops.lastOutcome(sessionID)).toEqual(created.replaced)
      // The old loop's terminal state travels before the new loop appears.
      expect(seen.map((event) => event.type)).toEqual(["loop.updated", "loop.cleared", "loop.updated"])
      expect(seen[0].data.loop).toMatchObject({ loopID: first.loop_id, status: "cancelled" })
      expect(seen[1].data).toMatchObject({ status: "cancelled", stop: { reason: "goal_changed" } })
      expect(seen[2].data.loop).toMatchObject({ loopID: created.state.loop_id, status: "active" })
      const stored = yield* rows(sessionID)
      expect(stored.state).toHaveLength(1)
      expect(stored.outcome.map((row) => row.loop_id)).toEqual([first.loop_id])
    }),
  )

  it.live("also replaces a stopped loop and drops its earlier stop record for goal_changed", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const sessionID = session()
      const first = (yield* loops.create(sessionID, { prompt: "first" })).state
      yield* loops.update(sessionID, LoopState.expected(first), {
        status: "stopped",
        stop: LoopState.stopRecord({ reason: "no_progress" }),
      })

      const created = yield* loops.create(sessionID, { prompt: "second" })

      expect(created.replaced?.status).toBe("cancelled")
      expect(created.replaced?.stop).toMatchObject({ reason: "goal_changed", detail: { code: "explicit" } })
    }),
  )
})

describe("LoopState.update fence", () => {
  it.live("advances revision by exactly one per write and publishes loop.updated each time", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const events = yield* EventV2Bridge.Service
      const sessionID = session()
      const state = (yield* loops.create(sessionID, { prompt: "go" })).state
      const seen = yield* capture(events, sessionID)

      const a = yield* loops.update(sessionID, LoopState.expected(state), { round: 2 })
      const b = yield* loops.update(sessionID, LoopState.expected(a!), {
        analyzing: { boundary: "msg_1", started_at: 10 },
      })
      const c = yield* loops.update(sessionID, LoopState.expected(b!), { analyzing: undefined, status: "waiting" })

      expect([a?.revision, b?.revision, c?.revision]).toEqual([1, 2, 3])
      expect(yield* loops.load(sessionID)).toEqual(c)
      expect(seen.map((event) => event.type)).toEqual(["loop.updated", "loop.updated", "loop.updated"])
      expect(seen.map((event) => event.data.loop.analyzing)).toEqual([false, true, false])
      expect(seen.map((event) => event.data.loop.status)).toEqual(["active", "active", "waiting"])
    }),
  )

  it.live("discards a write that holds a stale revision: nothing changes and nothing is published", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const events = yield* EventV2Bridge.Service
      const sessionID = session()
      const state = (yield* loops.create(sessionID, { prompt: "go" })).state
      const advanced = yield* loops.update(sessionID, LoopState.expected(state), { round: 2 })
      const seen = yield* capture(events, sessionID)

      const stale = yield* loops.update(sessionID, LoopState.expected(state), { round: 9, status: "stopped" })

      expect(stale).toBeUndefined()
      expect(yield* loops.load(sessionID)).toEqual(advanced)
      expect(seen).toEqual([])
    }),
  )

  it.live("discards a write for another loop's identity at the same revision", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const sessionID = session()
      const state = (yield* loops.create(sessionID, { prompt: "go" })).state

      const other = yield* loops.update(
        sessionID,
        { loopID: "some-other-loop", revision: state.revision },
        { round: 2 },
      )

      expect(other).toBeUndefined()
      expect((yield* loops.load(sessionID))?.revision).toBe(state.revision)
    }),
  )

  it.live("applies an update without an identity to the current loop and does nothing without a loop", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const sessionID = session()
      expect(yield* loops.update(sessionID, undefined, { round: 2 })).toBeUndefined()
      expect(yield* loops.load(sessionID)).toBeUndefined()

      const state = (yield* loops.create(sessionID, { prompt: "go" })).state
      const next = yield* loops.update(sessionID, undefined, { round: 2 })

      expect(next).toMatchObject({ loop_id: state.loop_id, revision: 1, round: 2 })
    }),
  )

  it.live("lets exactly one of two concurrent writers holding the same revision win", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const sessionID = session()
      const state = (yield* loops.create(sessionID, { prompt: "go" })).state
      const fence = LoopState.expected(state)

      const outcomes = yield* Effect.all(
        [loops.update(sessionID, fence, { round: 2 }), loops.update(sessionID, fence, { round: 3 })],
        { concurrency: "unbounded" },
      )

      expect(outcomes.filter((outcome) => outcome !== undefined)).toHaveLength(1)
      const stored = yield* loops.load(sessionID)
      expect(stored?.revision).toBe(1)
      expect(stored?.round).toBe(outcomes.find((outcome) => outcome !== undefined)?.round)
      expect([2, 3]).toContain(stored?.round ?? 0)
    }),
  )

  it.live("refuses a change of origin and leaves the row as it was", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const events = yield* EventV2Bridge.Service
      const sessionID = session()
      const state = (yield* loops.create(sessionID, { prompt: "the user's words" })).state
      const seen = yield* capture(events, sessionID)

      // `origin` is outside the type of an update; the writer still refuses it.
      const exit = yield* Effect.exit(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- bypasses the patch type on purpose.
        loops.update(sessionID, undefined, { origin: { ...state.origin, prompt: "rewritten" } } as never),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* loops.load(sessionID)).toEqual(state)
      expect(seen).toEqual([])
    }),
  )

  it.live("owns the revision: a patch cannot set it", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const sessionID = session()
      const state = (yield* loops.create(sessionID, { prompt: "go" })).state

      // `revision` and `loop_id` are outside the type of an update; the patch cannot carry them in anyway.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- bypasses the patch type on purpose.
      const next = yield* loops.update(sessionID, undefined, { revision: 99, loop_id: "other" } as never)

      expect(next).toMatchObject({ loop_id: state.loop_id, revision: state.revision + 1 })
    }),
  )
})

describe("LoopState.end", () => {
  it.live("writes the terminal snapshot, deletes the row, and publishes updated then cleared", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const events = yield* EventV2Bridge.Service
      const sessionID = session()
      const state = (yield* loops.create(sessionID, { prompt: "go" })).state
      const marked = yield* loops.update(sessionID, LoopState.expected(state), {
        analyzing: { boundary: "msg_1", started_at: 1 },
      })
      const seen = yield* capture(events, sessionID)
      const stop = LoopState.stopRecord({ reason: "completed" })

      const terminal = yield* loops.end(sessionID, LoopState.expected(marked!), { status: "completed", stop })

      expect(terminal).toMatchObject({ loop_id: state.loop_id, status: "completed", revision: 2, stop })
      expect(terminal?.analyzing).toBeUndefined()
      expect(yield* loops.load(sessionID)).toBeUndefined()
      expect(yield* loops.lastOutcome(sessionID)).toEqual(terminal)
      const stored = yield* rows(sessionID)
      expect(stored.state).toEqual([])
      expect(stored.outcome.map((row) => row.loop_id)).toEqual([state.loop_id])
      expect(seen.map((event) => event.type)).toEqual(["loop.updated", "loop.cleared"])
      expect(seen[0].data.loop).toMatchObject({ status: "completed", analyzing: false, stop })
      expect(seen[1].data).toEqual({ sessionID, status: "completed", stop })
    }),
  )

  it.live("keeps the stop record of a stopped loop when none is given", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const events = yield* EventV2Bridge.Service
      const sessionID = session()
      const state = (yield* loops.create(sessionID, { prompt: "go" })).state
      const stop = LoopState.stopRecord({
        reason: "provider_unavailable",
        detail: { code: "APIError", message: "down" },
      })
      const stopped = yield* loops.update(sessionID, LoopState.expected(state), { status: "stopped", stop })
      const seen = yield* capture(events, sessionID)

      const terminal = yield* loops.end(sessionID, LoopState.expected(stopped!), { status: "cancelled" })

      expect(terminal).toMatchObject({ status: "cancelled", stop })
      expect(seen[1].data).toEqual({ sessionID, status: "cancelled", stop })
    }),
  )

  it.live("changes nothing for a stale identity or a session without a loop", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const events = yield* EventV2Bridge.Service
      const sessionID = session()
      const stop = LoopState.stopRecord({ reason: "completed" })
      expect(yield* loops.end(sessionID, undefined, { status: "completed", stop })).toBeUndefined()

      const state = (yield* loops.create(sessionID, { prompt: "go" })).state
      const advanced = yield* loops.update(sessionID, LoopState.expected(state), { round: 2 })
      const seen = yield* capture(events, sessionID)

      expect(yield* loops.end(sessionID, LoopState.expected(state), { status: "completed", stop })).toBeUndefined()

      expect(yield* loops.load(sessionID)).toEqual(advanced)
      expect(yield* loops.lastOutcome(sessionID)).toBeUndefined()
      expect(seen).toEqual([])
    }),
  )

  it.live("refuses to end a loop that has no stop record to keep", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const sessionID = session()
      const state = (yield* loops.create(sessionID, { prompt: "go" })).state

      const exit = yield* Effect.exit(loops.end(sessionID, undefined, { status: "cancelled" }))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* loops.load(sessionID)).toEqual(state)
      expect(yield* loops.lastOutcome(sessionID)).toBeUndefined()
    }),
  )
})

describe("LoopState.commitAnalysis", () => {
  const usage = { input: 1200, output: 300, reasoning: 800 }

  it.live("freezes the first analysis, sets the intent, and appends the first row", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const events = yield* EventV2Bridge.Service
      const sessionID = session()
      const state = (yield* loops.create(sessionID, { prompt: "go" })).state
      const marked = yield* loops.update(sessionID, LoopState.expected(state), {
        analyzing: { boundary: "msg_a", started_at: 5 },
      })
      const seen = yield* capture(events, sessionID)
      const analysis = result({ reason: "Two items are still unmet." })

      const next = yield* loops.commitAnalysis(sessionID, LoopState.expected(marked!), {
        boundary: "msg_a",
        result: analysis,
        usage,
        elapsedMs: 4200,
        noProgressStreak: 1,
      })

      expect(next?.revision).toBe(marked!.revision + 1)
      expect(next?.origin.analysis).toEqual(analysis.intent)
      expect(next?.origin.analysis_at).toBeGreaterThan(0)
      expect(next?.origin.prompt).toBe("go")
      expect(next).toMatchObject({
        intent: analysis.intent,
        intent_revision: 1,
        progress: analysis.progress,
        next_prompt: analysis.next_prompt,
        last_verdict: "continue",
        last_reason: "Two items are still unmet.",
        last_analyzed_msg: "msg_a",
        no_progress_streak: 1,
      })
      expect(next?.analyzing).toBeUndefined()
      expect(yield* loops.load(sessionID)).toEqual(next)

      const log = yield* loops.analyses(state.loop_id)
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({
        loop_id: state.loop_id,
        seq: 1,
        session_id: sessionID,
        round: 1,
        boundary: "msg_a",
        verdict: "continue",
        reason: "Two items are still unmet.",
        intent_revision: 1,
        change_summary: null,
        change_basis_message_id: null,
        prompt: analysis.next_prompt,
        input_tokens: 1200,
        output_tokens: 300,
        reasoning_tokens: 800,
        elapsed_ms: 4200,
      })
      expect(log[0].created_at).toBeGreaterThan(0)
      // One state write, one event: the marker is gone and the objective is known.
      expect(seen.map((event) => event.type)).toEqual(["loop.updated"])
      expect(seen[0].data.loop).toMatchObject({
        analyzing: false,
        objective: analysis.intent.objective,
        intentRevision: 1,
        lastVerdict: "continue",
        lastReason: "Two items are still unmet.",
      })
    }),
  )

  it.live(
    "leaves the origin alone afterwards, bumps the intent revision only on a change, and numbers rows densely",
    () =>
      Effect.gen(function* () {
        const loops = yield* LoopState.Service
        const sessionID = session()
        const state = (yield* loops.create(sessionID, { prompt: "the first words" })).state
        const first = result()
        const afterFirst = yield* loops.commitAnalysis(sessionID, LoopState.expected(state), {
          boundary: "msg_1",
          result: first,
          usage,
          elapsedMs: 1,
        })
        const dispatched = yield* loops.update(sessionID, LoopState.expected(afterFirst!), { round: 2 })

        const unchanged = yield* loops.commitAnalysis(sessionID, LoopState.expected(dispatched!), {
          boundary: "msg_2",
          result: result({ next_prompt: "Second round prompt.", progress: progress({ summary: "Validator landed" }) }),
          usage,
          elapsedMs: 2,
        })
        const changedResult = result({
          intent: intent({
            objective: "A wider goal",
            constraints: ["Do not touch the shared runner", "No new files"],
          }),
          intent_change: { changed: true, basis_message_id: "msg_human_2", summary: "The user added a constraint" },
          next_prompt: "Third round prompt.",
        })
        const changed = yield* loops.commitAnalysis(sessionID, LoopState.expected(unchanged!), {
          boundary: "msg_3",
          result: changedResult,
          usage,
          elapsedMs: 3,
        })

        expect(unchanged?.origin).toEqual(afterFirst?.origin)
        expect(changed?.origin).toEqual(afterFirst?.origin)
        expect(changed?.origin.analysis).toEqual(first.intent)
        expect(changed?.origin.prompt).toBe("the first words")
        expect([afterFirst?.intent_revision, unchanged?.intent_revision, changed?.intent_revision]).toEqual([1, 1, 2])
        expect(changed?.intent?.objective).toBe("A wider goal")
        expect(changed?.next_prompt).toBe("Third round prompt.")
        expect(changed?.last_analyzed_msg).toBe("msg_3")

        const log = yield* loops.analyses(state.loop_id)
        expect(log.map((row) => [row.seq, row.round, row.boundary, row.intent_revision])).toEqual([
          [1, 1, "msg_1", 1],
          [2, 2, "msg_2", 1],
          [3, 2, "msg_3", 2],
        ])
        expect(log[2]).toMatchObject({
          change_summary: "The user added a constraint",
          change_basis_message_id: "msg_human_2",
          prompt: "Third round prompt.",
        })
      }),
  )

  it.live("clears the next prompt when the verdict is not continue and keeps the streak when none is given", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const sessionID = session()
      const state = (yield* loops.create(sessionID, { prompt: "go" })).state
      const streak = yield* loops.update(sessionID, LoopState.expected(state), { no_progress_streak: 2 })
      const withPrompt = yield* loops.commitAnalysis(sessionID, LoopState.expected(streak!), {
        boundary: "msg_1",
        result: result(),
        usage,
        elapsedMs: 1,
      })
      expect(withPrompt).toMatchObject({ no_progress_streak: 2 })
      expect(withPrompt?.next_prompt).toBeDefined()

      const done = yield* loops.commitAnalysis(sessionID, LoopState.expected(withPrompt!), {
        boundary: "msg_2",
        result: result({
          verdict: "done",
          intent: intent({
            acceptance: [
              { id: "A1", text: "The schema is exported", status: "met", evidence: "schema.ts" },
              { id: "A2", text: "The validator rejects drift", status: "met", evidence: "validate.test.ts" },
            ],
          }),
          next_prompt: undefined,
          reason: "Every item is met.",
        }),
        usage,
        elapsedMs: 1,
      })

      expect(done?.next_prompt).toBeUndefined()
      expect(done).toMatchObject({ last_verdict: "done", no_progress_streak: 2 })
      const log = yield* loops.analyses(state.loop_id)
      expect(log[1]).toMatchObject({ verdict: "done", prompt: null })
    }),
  )

  it.live("discards a result whose loop changed during the analysis: no state, no row, no event", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const events = yield* EventV2Bridge.Service
      const sessionID = session()
      const state = (yield* loops.create(sessionID, { prompt: "go" })).state
      const marked = yield* loops.update(sessionID, LoopState.expected(state), {
        analyzing: { boundary: "msg_a", started_at: 1 },
      })
      // Something else writes while the analysis runs.
      const interrupted = yield* loops.update(sessionID, LoopState.expected(marked!), { analyzing: undefined })
      const seen = yield* capture(events, sessionID)

      const discarded = yield* loops.commitAnalysis(sessionID, LoopState.expected(marked!), {
        boundary: "msg_a",
        result: result(),
        usage,
        elapsedMs: 1,
      })

      expect(discarded).toBeUndefined()
      expect(yield* loops.load(sessionID)).toEqual(interrupted)
      expect(yield* loops.analyses(state.loop_id)).toEqual([])
      expect(seen).toEqual([])
    }),
  )

  it.live("is not committed for a loop that already ended", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const sessionID = session()
      const state = (yield* loops.create(sessionID, { prompt: "go" })).state
      yield* loops.end(sessionID, undefined, {
        status: "cancelled",
        stop: LoopState.stopRecord({ reason: "user_stopped" }),
      })

      const late = yield* loops.commitAnalysis(sessionID, LoopState.expected(state), {
        boundary: "msg_a",
        result: result(),
        usage,
        elapsedMs: 1,
      })

      expect(late).toBeUndefined()
      expect(yield* loops.analyses(state.loop_id)).toEqual([])
    }),
  )
})

describe("LoopState.purgeSession", () => {
  it.live("drops the row, every outcome and every analysis, and publishes a bare loop.cleared", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const events = yield* EventV2Bridge.Service
      const sessionID = session()
      const other = session()
      const old = (yield* loops.create(sessionID, { prompt: "old" })).state
      yield* loops.commitAnalysis(sessionID, LoopState.expected(old), {
        boundary: "msg_1",
        result: result(),
        usage: { input: 1, output: 1, reasoning: 1 },
        elapsedMs: 1,
      })
      yield* loops.end(sessionID, undefined, {
        status: "completed",
        stop: LoopState.stopRecord({ reason: "completed" }),
      })
      const live = (yield* loops.create(sessionID, { prompt: "live" })).state
      const bystander = (yield* loops.create(other, { prompt: "bystander" })).state
      yield* loops.commitAnalysis(other, LoopState.expected(bystander), {
        boundary: "msg_9",
        result: result(),
        usage: { input: 1, output: 1, reasoning: 1 },
        elapsedMs: 1,
      })
      const seen = yield* capture(events, sessionID)

      yield* loops.purgeSession(sessionID)

      expect(yield* loops.load(sessionID)).toBeUndefined()
      expect(yield* loops.lastOutcome(sessionID)).toBeUndefined()
      expect(yield* loops.analyses(old.loop_id)).toEqual([])
      expect(yield* loops.analyses(live.loop_id)).toEqual([])
      expect(seen.map((event) => event.type)).toEqual(["loop.cleared"])
      expect(seen[0].data).toEqual({ sessionID })
      // Another session is untouched.
      expect((yield* loops.load(other))?.loop_id).toBe(bystander.loop_id)
      expect(yield* loops.analyses(bystander.loop_id)).toHaveLength(1)
    }),
  )

  it.live("publishes nothing for a session that has no loop", () =>
    Effect.gen(function* () {
      const loops = yield* LoopState.Service
      const events = yield* EventV2Bridge.Service
      const sessionID = session()
      const seen = yield* capture(events, sessionID)

      yield* loops.purgeSession(sessionID)

      expect(seen).toEqual([])
    }),
  )
})

describe("LoopState.admit", () => {
  const base = LoopState.initial({ prompt: "the first words", messageID: "msg_1" })
  const analyzed = LoopState.advance(base, {
    origin: { ...base.origin, analysis: intent(), analysis_at: 5 },
    intent: intent(),
    intent_revision: 1,
  })
  const ended = (of: LoopState.Info) =>
    LoopState.advance(of, {
      status: "cancelled",
      stop: LoopState.stopRecord({ reason: "goal_changed", detail: { code: "explicit" } }),
    })
  const rewrite = (previous: LoopState.Info, origin: Partial<LoopState.Origin>) =>
    LoopState.advance(previous, { origin: { ...previous.origin, ...origin } })

  test("admits a first write, the next revision, and the commit that freezes the first analysis", () => {
    expect(() => LoopState.admit(undefined, base)).not.toThrow()
    expect(() => LoopState.admit(base, LoopState.advance(base, { round: 2, status: "waiting" }))).not.toThrow()
    expect(() => LoopState.admit(base, analyzed)).not.toThrow()
    expect(() =>
      LoopState.admit(analyzed, LoopState.advance(analyzed, { intent: intent({ objective: "A wider goal" }) })),
    ).not.toThrow()
  })

  test("admits a replacement that carries the terminal snapshot of the old loop", () => {
    expect(() => LoopState.admit(base, LoopState.initial({ prompt: "second" }), ended(base))).not.toThrow()
  })

  test("rejects a terminal state in a live row", () => {
    expect(() => LoopState.admit(base, LoopState.advance(base, { status: "completed" }))).toThrow("live loops only")
  })

  test("rejects a revision that is not the next one", () => {
    const previous = LoopState.advance(LoopState.advance(base, { round: 2 }), { round: 3 })
    expect(previous.revision).toBe(2)
    const next = Schema.encodeSync(LoopState.Info)(LoopState.advance(previous, { round: 4 }))
    expect(next.revision).toBe(3)
    for (const revision of [2, 4, 1, 0])
      expect(() => LoopState.admit(previous, new LoopState.Info({ ...next, revision })), String(revision)).toThrow(
        "revision must advance by one",
      )
    expect(() => LoopState.admit(previous, new LoopState.Info(next))).not.toThrow()
  })

  test("rejects any change of the origin, and of the first analysis once it is committed", () => {
    for (const change of [
      { prompt: "rewritten" },
      { message_id: "msg_other" },
      { message_id: undefined },
      { created_at: 1 },
    ])
      expect(() => LoopState.admit(base, rewrite(base, change)), JSON.stringify(change)).toThrow("origin is frozen")
    for (const change of [
      { analysis: intent({ objective: "drifted" }) },
      { analysis: undefined },
      { analysis_at: 99 },
      { analysis_at: undefined },
    ])
      expect(() => LoopState.admit(analyzed, rewrite(analyzed, change)), JSON.stringify(change)).toThrow(
        "origin is frozen",
      )
  })

  test("compares the frozen analysis by value, not by key order or identity", () => {
    const frozen = analyzed.origin.analysis!
    const { open_questions, assumptions, non_goals, constraints, acceptance, objective } = frozen
    const reordered: LoopIntent = { open_questions, assumptions, non_goals, constraints, acceptance, objective }
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(frozen))
    expect(() => LoopState.admit(analyzed, rewrite(analyzed, { analysis: reordered }))).not.toThrow()
    expect(() => LoopState.admit(analyzed, rewrite(analyzed, { analysis: structuredClone(frozen) }))).not.toThrow()
  })

  test("rejects a new loop that does not start at revision 0 or replaces a live loop without its snapshot", () => {
    const fresh = LoopState.initial({ prompt: "second" })
    const advancedFresh = LoopState.advance(fresh, { round: 2 })
    expect(() => LoopState.admit(undefined, advancedFresh)).toThrow("starts at revision 0")
    expect(() => LoopState.admit(base, advancedFresh, ended(base))).toThrow("starts at revision 0")
    // no snapshot, someone else's snapshot, a snapshot that is not terminal, one without a stop record
    expect(() => LoopState.admit(base, fresh)).toThrow("terminal snapshot")
    expect(() => LoopState.admit(base, fresh, ended(fresh))).toThrow("terminal snapshot")
    expect(() => LoopState.admit(base, fresh, LoopState.advance(base, { round: 2 }))).toThrow("terminal snapshot")
    expect(() => LoopState.admit(base, fresh, LoopState.advance(base, { status: "cancelled" }))).toThrow(
      "terminal snapshot",
    )
    // a snapshot with nothing to replace, and one next to a loop that simply continues
    expect(() => LoopState.admit(undefined, fresh, ended(base))).toThrow("no live loop")
    expect(() => LoopState.admit(base, LoopState.advance(base, { round: 2 }), ended(base))).toThrow(
      "not ended in the same write",
    )
  })
})

describe("LoopState.Info", () => {
  const full = new LoopState.Info({
    loop_id: "loop_full",
    revision: 7,
    status: "waiting",
    origin: {
      prompt: "  keep\n the whitespace  ",
      message_id: "msg_1",
      created_at: 1,
      analysis: intent(),
      analysis_at: 2,
    },
    intent: intent({ objective: "A later objective" }),
    intent_revision: 3,
    progress: progress(),
    next_prompt: "Do the next thing.",
    round: 4,
    max_rounds: 20,
    no_progress_streak: 2,
    declaration: { kind: "done", evidence: "the tests pass" },
    wait: {
      source: "watch_pr",
      wait_id: "watch_1",
      ref: { domain: "pr_watch", id: "watch_1" },
      deadline: 99,
      max_wakes: 5,
      wakes: 1,
      payload: "check run finished",
      reviewed: true,
    },
    analyzing: { boundary: "msg_9", started_at: 5 },
    last_analyzed_msg: "msg_8",
    last_verdict: "continue",
    last_reason: "One item left.",
    recovery: { attempts: 1, reset: 1, probes: 2, probe_at: 1000, boundary: "msg_7", step: "analysis" },
    stop: { reason: "needs_user", detail: { code: "rejected" }, at: 3 },
  })

  test("round-trips through its JSON payload with every field", () => {
    const payload = JSON.stringify(Schema.encodeSync(LoopState.Info)(full))
    expect(Schema.decodeUnknownSync(LoopState.Info)(JSON.parse(payload))).toEqual(full)
  })

  test("reads a failure chain written before it recorded its step, and writes it back without one", () => {
    const older = { attempts: 1, reset: 1, probes: 2, probe_at: 1000, boundary: "msg_7" }
    const encoded = Schema.encodeSync(LoopState.Info)(full)
    const decoded = Schema.decodeUnknownSync(LoopState.Info)({ ...encoded, recovery: older })
    expect(decoded.recovery).toEqual(older)
    expect(Schema.encodeSync(LoopState.Info)(decoded).recovery).toEqual(older)
    const unknown = { ...encoded, recovery: { ...older, step: "probe" } }
    expect(() => Schema.decodeUnknownSync(LoopState.Info)(unknown)).toThrow()
  })

  test("round-trips a fresh loop whose optional fields are all absent", () => {
    const fresh = LoopState.initial({ prompt: "go" })
    const payload = JSON.stringify(Schema.encodeSync(LoopState.Info)(fresh))
    expect(Schema.decodeUnknownSync(LoopState.Info)(JSON.parse(payload))).toEqual(fresh)
    expect(Object.keys(JSON.parse(payload)).toSorted()).toEqual(
      [
        "intent_revision",
        "loop_id",
        "max_rounds",
        "no_progress_streak",
        "origin",
        "revision",
        "round",
        "status",
      ].toSorted(),
    )
  })

  test("rejects a payload that is not a loop", () => {
    expect(() => Schema.decodeUnknownSync(LoopState.Info)({ loop_id: "x" })).toThrow()
    const bad = { ...Schema.encodeSync(LoopState.Info)(full), status: "paused" }
    expect(() => Schema.decodeUnknownSync(LoopState.Info)(bad)).toThrow()
    const noRounds = { ...Schema.encodeSync(LoopState.Info)(full), max_rounds: 0 }
    expect(() => Schema.decodeUnknownSync(LoopState.Info)(noRounds)).toThrow()
  })

  test("advance raises the revision by one and keeps identity", () => {
    const next = LoopState.advance(full, { round: 5, analyzing: undefined })
    expect(next.revision).toBe(8)
    expect(next.loop_id).toBe(full.loop_id)
    expect(next.round).toBe(5)
    expect(next.analyzing).toBeUndefined()
    expect(next.origin).toEqual(full.origin)
    expect(full.revision).toBe(7)
  })

  test("the public shape carries what a client shows and nothing internal", () => {
    expect(LoopState.toPublic(full)).toEqual({
      loopID: "loop_full",
      status: "waiting",
      round: 4,
      maxRounds: 20,
      prompt: "  keep\n the whitespace  ",
      objective: "A later objective",
      analyzing: true,
      probeAt: 1000,
      wait: { source: "watch_pr", deadline: 99 },
      intentRevision: 3,
      lastVerdict: "continue",
      lastReason: "One item left.",
      stop: { reason: "needs_user", detail: { code: "rejected" }, at: 3 },
    })
    expect(LoopState.toPublic(LoopState.initial({ prompt: "go" }))).toMatchObject({
      status: "active",
      round: 1,
      analyzing: false,
      intentRevision: 0,
    })
    expect(Object.keys(LoopState.toPublic(LoopState.initial({ prompt: "go" }))).toSorted()).toEqual(
      ["analyzing", "intentRevision", "loopID", "maxRounds", "prompt", "round", "status"].toSorted(),
    )
  })
})
