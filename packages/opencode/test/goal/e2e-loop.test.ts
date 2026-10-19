// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mocked service slices and seeded rows use `as never` shims.
import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer, Option } from "effect"
import { GoalLoop, GoalLoopJudgeLLM } from "@/goal/loop"
import { Goal } from "@/goal/goal"
import { Memory } from "@/memory/memory"
import { MessageV2 } from "@/session/message-v2"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderTest } from "../fake/provider"
import { NotFoundError } from "@/storage/storage"
import { GoalEvent } from "@/goal/events"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { Provider } from "@/provider/provider"
import { SessionID } from "@/session/schema"
import { SessionAutomationLease } from "@/session/automation-lease"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { GoalStateTable } from "@opencode-ai/core/goal/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectSchema } from "@opencode-ai/core/project/schema"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { TestInstance } from "../fixture/fixture"
import { logLines } from "effect/testing/TestConsole"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

// P2b: full-cycle Goal regression (D5). Drives set → idle → judge(continue) →
// continuation → idle → judge(done) → terminal event sequence, with the judge
// LLM scripted via the injected GoalLoopJudgeLLM (no network / Provider creds).
// Session / SessionPrompt / Provider are mocked; Goal / SessionStatus /
// EventV2Bridge are real so goal state, the fibers map, and the event bus are
// exercised end-to-end.

type CapturedEvent = { type: string; status?: string }

const captureEvents = (events: EventV2Bridge.Service["Service"]) =>
  Effect.gen(function* () {
    const seen: CapturedEvent[] = []
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => {
        const goal = (event.data as { goal?: { status?: string } }).goal
        seen.push({ type: event.type, status: goal?.status })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    return seen
  })

// Scripted assistant response — afterIdle extracts its text as the judge input.
const assistantText = "I have made progress on the feature."
// GoalLoop.init forks the idle-event subscription (loop.ts Effect.forkScoped).
// Each scenario yields one scheduler turn before its first idle publish so that
// fiber can acquire the PubSub subscription. No business event exists yet, so
// outcome completion remains separately observed through public state/events.
const mkAssistant = (id?: string) =>
  ({
    info: { id, role: "assistant", time: { created: Date.now() } },
    parts: [{ type: "text", text: assistantText }],
  }) as never

// A user-only message window — no assistant turn exists. Drives afterIdle into
// the "no lastAssistant" branch (loop.ts branch 1 → visible pause).
const mkUser = () =>
  ({
    info: { role: "user", time: { created: Date.now() } },
    parts: [{ type: "text", text: "继续推进" }],
  }) as never

// An assistant turn that produced only tool calls (no text part). afterIdle's
// responseText filter (`p.type === "text"`) yields "" → the synthetic
// continue verdict skips the judge entirely (loop.ts branch 2 → no stall).
const mkAssistantTools = () =>
  ({
    info: { role: "assistant", time: { created: Date.now() } },
    parts: [{ type: "tool-call", toolCallId: "1", toolName: "run", input: {} }],
  }) as never

// Prompt mock that records every call (noReply flag + joined text) for branch
// assertions. Resolves void — these tests never drive a real agent turn from
// the mock; the goal state and event captures are the observable contract.
const recordingPrompt = (sink: { noReply?: boolean; text: string }[]) =>
  Layer.succeed(SessionPrompt.Service, (() => {
    const record = (input: SessionPrompt.PromptInput) =>
      Effect.sync(() => {
        sink.push({
          noReply: input.noReply,
          text: input.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
        })
        return undefined as never
      })
    return withIdleAdmission({
      prompt: record,
      promptIfIdle: (input: SessionPrompt.PromptInput) =>
        record(input).pipe(Effect.map(Option.some)),
    }) as never
  })())

describe("GoalLoop — model controls during an executing turn", () => {
  let judgeCalls = 0
  let continuationCalls = 0
  let pauseReturned = false
  let boundary = "created-in-model-turn"
  const promptMock = Layer.unwrap(
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      return Layer.mock(SessionPrompt.Service, withIdleAdmission({
        prompt: () => Effect.succeed(mkAssistant()),
        promptIfIdle: (input: SessionPrompt.PromptInput) => Effect.gen(function* () {
          continuationCalls += 1
          const paused = yield* goal.controlDuringTurn(input.sessionID, {
            action: "pause",
            reason: "external dependency unavailable",
          })
          pauseReturned = paused.changed
          return Option.some(mkAssistant("paused-in-model-turn"))
        }),
      }))
    }),
  )
  const layer = GoalLoop.layer.pipe(
    Layer.provide(Layer.mock(Session.Service, { messages: () => Effect.sync(() => [mkAssistant(boundary)]) })),
    Layer.provide(promptMock),
    Layer.provide(Layer.mock(Provider.Service, {})),
    Layer.provide(Layer.succeed(GoalLoopJudgeLLM, {
      call: () => Effect.sync(() => {
        judgeCalls += 1
        return JSON.stringify({ verdict: judgeCalls === 1 ? "continue" : "done", reason: "verified" })
      }),
    })),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provideMerge(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )
  const it = testEffect(layer)

  it.instance("create waits for idle, pause returns inside continuation, resume completes at the next boundary", () =>
    Effect.gen(function* () {
      judgeCalls = 0
      continuationCalls = 0
      pauseReturned = false
      boundary = "created-in-model-turn"
      const goal = yield* Goal.Service
      const status = yield* SessionStatus.Service
      const loop = yield* GoalLoop.Service
      yield* loop.init()
      yield* Effect.yieldNow
      const sid = SessionID.descending()
      yield* status.set(sid, { type: "busy" })
      yield* goal.controlDuringTurn(sid, { action: "create", text: "deliver feature", maxTurns: 5 })
      expect(continuationCalls).toBe(0)
      expect(judgeCalls).toBe(0)
      yield* status.set(sid, { type: "idle" })
      yield* pollWithTimeout(Effect.sync(() => pauseReturned || undefined), "pause tool did not return")
      expect(continuationCalls).toBe(1)
      const paused = yield* goal.load(sid)
      expect(paused?.status).toBe("paused")
      expect(paused?.turns_used).toBe(1)
      yield* status.set(sid, { type: "busy" })
      boundary = "resumed-and-completed-in-model-turn"
      yield* goal.controlDuringTurn(sid, { action: "resume" })
      expect(continuationCalls).toBe(1)
      yield* status.set(sid, { type: "idle" })
      yield* pollWithTimeout(goal.lastOutcome(sid), "resumed goal did not complete")
      expect(yield* goal.load(sid)).toBeUndefined()
      expect((yield* goal.lastOutcome(sid))?.goal_id).toBe(paused?.goal_id)
      expect(judgeCalls).toBe(2)
      expect(continuationCalls).toBe(1)
    }),
  )
})

describe("GoalLoop end-to-end — continue → done lifecycle (P2b)", () => {
  // Per-test mutable mock state (each it.instance runs in its own scope, but
  // these closures are shared across the single test below — fine since the
  // test serializes the two judge calls).
  let judgeCalls = 0
  const promptCalls: { noReply?: boolean; text: string }[] = []
  const promptInputs: SessionPrompt.PromptInput[] = []

  const reset = () => {
    judgeCalls = 0
    promptCalls.length = 0
    promptInputs.length = 0
  }

  const sessionMock = Layer.succeed(Session.Service, {
    messages: () => Effect.succeed([mkAssistant()]),
  } as never)
  const promptMock = Layer.succeed(SessionPrompt.Service, (() => {
    const record = (input: SessionPrompt.PromptInput) =>
      Effect.sync(() => {
        promptInputs.push(input)
        promptCalls.push({
          noReply: input.noReply,
          text: input.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
        })
        return undefined as never
      })
    return withIdleAdmission({
      prompt: record,
      promptIfIdle: (input: SessionPrompt.PromptInput) =>
        record(input).pipe(Effect.map(Option.some)),
    }) as never
  })())
  const providerMock = Layer.succeed(Provider.Service, {} as never)
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.sync(() => {
          judgeCalls += 1
          // First judge call → continue; second → done.
          return judgeCalls === 1
            ? JSON.stringify({ done: false, reason: "more steps needed" })
            : JSON.stringify({ done: true, reason: "feature shipped" })
        }),
    }),
  )

  const e2eLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(promptMock),
    Layer.provide(providerMock),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )
  const it = testEffect(e2eLayer)

  it.instance("continuation reaches the model without becoming human memory evidence", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship the feature", 10)
      yield* Effect.yieldNow
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      const continuation = yield* pollWithTimeout(
        Effect.sync(() => promptInputs.find((input) => !input.noReply)),
        "continuation was not admitted",
        "5 seconds",
      )
      const message = {
        info: { id: "goal-continuation", role: "user" },
        parts: continuation.parts,
      } as SessionV1.WithParts
      const completed = {
        info: { role: "assistant", parentID: message.info.id, finish: "end_turn" },
        parts: [],
      } as unknown as SessionV1.WithParts
      expect(Memory.cleanEvidence([message])).toBe("")
      expect(Memory.completedTurns([message, completed])).toBe(0)
      const human = {
        info: { ...message.info, id: "human-input" },
        parts: [{ type: "text", text: "长期偏好是简洁中文" }],
      } as SessionV1.WithParts
      const humanReply = {
        ...completed,
        info: { ...completed.info, parentID: human.info.id },
      } as SessionV1.WithParts
      expect(Memory.cleanEvidence([human, message])).toBe("user: 长期偏好是简洁中文")
      expect(Memory.completedTurns([human, humanReply, message, completed])).toBe(1)
      const modelMessages = yield* Effect.promise(() => MessageV2.toModelMessages([message], ProviderTest.model()))
      expect(modelMessages).toEqual([
        {
          role: "user",
          content: [{ type: "text", text: promptCalls[0].text }],
        },
      ])
      yield* goal.clear(sid)
    }),
  )

  it.instance("set → continue → continuation → done → cleared, scripted judge", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)

      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship the feature", 10)
      // Give the forkScoped idle subscriber one scheduler turn to acquire its
      // PubSub subscription. Business completion is observed below.
      yield* Effect.yieldNow

      // ── Turn 1: idle → judge(continue) → continuation prompt ──
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.sync(() => (judgeCalls >= 1 ? true : undefined)),
        "judge call 1 (continue) never fired",
        "5 seconds",
      )

      const after1 = yield* goal.load(sid)
      expect(after1?.status).toBe("active")
      expect(Number(after1?.turns_used)).toBe(1)
      // A continuation prompt was injected (not a noReply), carrying the goal.
      expect(promptCalls.some((p) => !p.noReply)).toBe(true)

      // ── Turn 2: idle → judge(done) → terminal event sequence ──
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.sync(() => (judgeCalls >= 2 ? true : undefined)),
        "judge call 2 (done) never fired",
        "5 seconds",
      )

      const types = seen.map((e) => e.type)
      // Terminal contract: goal.updated(done) then goal.cleared, exactly once.
      const doneUpdates = seen.filter((e) => e.type === GoalEvent.Updated.type && e.status === "done")
      expect(doneUpdates.length).toBe(1)
      expect(types).toContain(GoalEvent.Cleared.type)
      // Row deleted after the terminal sequence.
      const loaded = yield* goal.load(sid)
      expect(loaded).toBeUndefined()
    }),
  )
})

describe("GoalLoop — shared Session automation lease", () => {
  let leaseAttempts = 0
  let directPromptAttempts = 0
  const sessionMock = Layer.succeed(Session.Service, {
    messages: () => Effect.succeed([mkAssistant()]),
  } as never)
  const promptMock = Layer.succeed(SessionPrompt.Service, withIdleAdmission({
    prompt: () =>
      Effect.sync(() => {
        directPromptAttempts += 1
        return undefined as never
      }),
    promptIfIdle: () =>
      Effect.sync(() => {
        leaseAttempts += 1
        return Option.none()
      }),
  }) as never)
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () => Effect.succeed(JSON.stringify({ verdict: "continue", reason: "more work" })),
    }),
  )
  const leaseLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(promptMock),
    Layer.provide(Layer.succeed(Provider.Service, {} as never)),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )
  const it = testEffect(leaseLayer)

  it.instance("a busy Session lease rejects Goal continuation without direct prompt admission", () =>
    Effect.gen(function* () {
      leaseAttempts = 0
      directPromptAttempts = 0
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      yield* loop.init()
      const sessionID = SessionID.descending()
      yield* goal.set(sessionID, "ship the feature", 10)
      yield* Effect.yieldNow

      yield* events.publish(SessionStatus.Event.Status, {
        sessionID,
        status: { type: "idle" },
      })
      yield* pollWithTimeout(
        Effect.sync(() => (leaseAttempts > 0 ? true : undefined)),
        "GoalLoop never attempted the shared Session automation lease",
        "5 seconds",
      )

      expect(directPromptAttempts).toBe(0)
      expect((yield* goal.load(sessionID))?.status).toBe("active")
    }),
  )
})

describe("GoalLoop + DAG owner arbitration", () => {
  let judgeCalls = 0
  let continuationCalls = 0
  const sessionMock = Layer.succeed(Session.Service, {
    messages: () => Effect.succeed([mkAssistant()]),
  } as never)
  const promptMock = Layer.succeed(SessionPrompt.Service, withIdleAdmission({
    prompt: () => Effect.succeed(undefined as never),
    promptIfIdle: () =>
      Effect.sync(() => {
        continuationCalls += 1
        return Option.some(undefined as never)
      }),
  }) as never)
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.sync(() => {
          judgeCalls += 1
          return JSON.stringify({ verdict: "continue", reason: "more work" })
        }),
    }),
  )
  const arbitrationLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(promptMock),
    Layer.provide(Layer.succeed(Provider.Service, {} as never)),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    // provideMerge (not provide): the lease's GOAL-FP-01-02 re-trigger runs
    // in the test body's context when unregister is called from the body, so
    // SessionStatus must be part of the output context (branch 3 documents
    // the same pattern).
    Layer.provideMerge(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
    Layer.provideMerge(SessionAutomationLease.defaultLayer),
  )
  const it = testEffect(arbitrationLayer)

  it.instance("a live DAG owns the Session; Goal resumes when the DAG releases it", () =>
    Effect.gen(function* () {
      judgeCalls = 0
      continuationCalls = 0
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const automation = yield* SessionAutomationLease.Service
      yield* loop.init()
      const sessionID = SessionID.descending()
      yield* goal.set(sessionID, "ship the feature", 10)
      yield* automation.register(sessionID, { kind: "dag", id: "dag-executor" })
      yield* Effect.yieldNow

      yield* events.publish(SessionStatus.Event.Status, {
        sessionID,
        status: { type: "idle" },
      })
      yield* Effect.sleep("50 millis")
      expect(judgeCalls).toBe(0)
      expect(continuationCalls).toBe(0)

      // GOAL-FP-01-02: the dag release itself re-triggers the goal evaluation
      // through the idle status event mechanism — no follow-up idle event is
      // needed. This is exactly the stall that previously required the manual
      // second idle publish below.
      yield* automation.unregister(sessionID, { kind: "dag", id: "dag-executor" })
      yield* pollWithTimeout(
        Effect.sync(() => (continuationCalls === 1 ? true : undefined)),
        "Goal did not resume after the DAG released the Session lease",
        "5 seconds",
      )
      expect(judgeCalls).toBe(1)
    }),
  )
})

// GOAL-FP-01-02 follow-up (R1): the dag-release re-trigger must NOT publish a
// duplicate idle when no goal evaluation was ever blocked by the dag. The
// unfixed re-trigger forks a full evaluation (D) whose commit consumes the
// turn boundary; the real turn-idle fiber (B) then commits AGAIN for the same
// boundary — turns inflation (and, with a live runner, the busy→pause path).
//
// Deterministic construction through the public seam: the dag releases while
// the session is idle, THEN the turn-boundary idle event is published. The
// re-trigger's evaluation (if any) completes before the boundary evaluation
// forks, so the boundary fiber always double-commits under the unfixed
// re-trigger. The second continuation dispatch is parked on a gate so the
// test observes the settled double-commit state instead of a transient.
//
// The judge is scripted out of the picture entirely: the assistant message
// carries no text, so afterIdle takes the synthetic "continue" verdict path
// (loop.ts branch 2) and the judge mock must never be reached.
describe("GoalLoop — dag release must not double-evaluate a boundary (GOAL-FP-01-02 follow-up)", () => {
  let continuationCalls = 0
  let gateHit = false
  let gateRelease = Deferred.makeUnsafe<void>()
  const reset = () => {
    continuationCalls = 0
    gateHit = false
    gateRelease = Deferred.makeUnsafe<void>()
  }

  const sessionMock = Layer.mock(Session.Service, {
    messages: () => Effect.succeed([mkAssistantTools()]),
  })
  // Second continuation dispatch parks on a gate: under the unfixed
  // re-trigger the boundary fiber commits (turns 1 → 2) and reaches the gate;
  // the test then observes the settled double-commit state.
  const promptMock = Layer.mock(SessionPrompt.Service, withIdleAdmission({
    prompt: () => Effect.die("the direct prompt path is not exercised in this scenario"),
    promptIfIdle: () =>
      Effect.sync(() => {
        continuationCalls += 1
      }).pipe(
        Effect.flatMap(() => {
          if (continuationCalls === 2) {
            gateHit = true
            return Deferred.await(gateRelease)
          }
          return Effect.void
        }),
        Effect.map(() => Option.none()),
      ),
  }))
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () => Effect.die("the synthetic no-text verdict path must never reach the judge"),
    }),
  )
  const raceLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(promptMock),
    Layer.provide(Layer.mock(Provider.Service, {})),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    // provideMerge (not provide): unregister runs in the test body context and
    // the lease's re-trigger resolves SessionStatus from it (see the
    // arbitration describe above).
    Layer.provideMerge(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
    Layer.provideMerge(SessionAutomationLease.defaultLayer),
  )
  const it = testEffect(raceLayer)

  it.instance("an unblocked goal is evaluated exactly once when the dag releases before the boundary idle", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const automation = yield* SessionAutomationLease.Service
      yield* loop.init()
      const sessionID = SessionID.descending()
      yield* goal.set(sessionID, "ship the feature", 10)
      yield* automation.register(sessionID, { kind: "dag", id: "dag-executor" })
      yield* Effect.yieldNow

      // The dag releases while the session is idle and NO evaluation was ever
      // blocked by it. The re-trigger must stay silent here.
      yield* automation.unregister(sessionID, { kind: "dag", id: "dag-executor" })

      // Under the unfixed re-trigger an evaluation (D) was already forked by
      // the unregister's idle publish. Wait for it to settle so the boundary
      // fiber below cannot interrupt it mid-flight.
      const spuriousEvaluation = yield* pollWithTimeout(
        Effect.sync(() => (continuationCalls >= 1 ? true : undefined)),
        "unfixed re-trigger evaluation never dispatched",
        "500 millis",
      )
        .pipe(Effect.exit)
        .pipe(Effect.map(Exit.isSuccess))

      // The real turn-boundary idle event (the runner's idle emit).
      yield* events.publish(SessionStatus.Event.Status, {
        sessionID,
        status: { type: "idle" },
      })

      // Under the unfixed re-trigger the boundary fiber commits a SECOND time
      // (turns inflation) and parks at the second-dispatch gate.
      const doubleCommit = yield* pollWithTimeout(
        Effect.sync(() => (gateHit ? true : undefined)),
        "boundary fiber never reached the second dispatch (no double evaluation)",
        "500 millis",
      )
        .pipe(Effect.exit)
        .pipe(Effect.map(Exit.isSuccess))

      // Let the parked boundary fiber finish (no-op when it was never parked).
      yield* Deferred.succeed(gateRelease, undefined)
      yield* pollWithTimeout(
        Effect.sync(() => (continuationCalls >= (spuriousEvaluation ? 2 : 1) ? true : undefined)),
        "boundary evaluation never dispatched its continuation",
        "5 seconds",
      )

      const g = yield* goal.load(sessionID)
      expect(g?.status).toBe("active")
      // The R1 harm: the boundary's single real evaluation must account for
      // exactly one turn — not two.
      expect(Number(g?.turns_used)).toBe(1)
      expect(doubleCommit).toBe(false)
    }),
  )
})

// D1 (hooks-goal-completeness): a continuation dispatch failure must surface as a
// recoverable paused state, not a silent stall. Reuses the e2e harness with a
// prompt mock that always fails — the only prompt in this flow is the
// continuation after judge(continue), so it fails and exercises the catchCause
// → pauseAndPublish branch added in loop.ts.
describe("GoalLoop — continuation dispatch failure → recoverable pause (D1)", () => {
  let judgeCalls = 0
  const reset = () => {
    judgeCalls = 0
  }

  const sessionMock = Layer.succeed(Session.Service, {
    messages: () => Effect.succeed([mkAssistant()]),
  } as never)
  // Always-failing prompt — simulates provider fault / session write error.
  const promptFailMock = Layer.succeed(SessionPrompt.Service, withIdleAdmission({
    prompt: () => Effect.fail(new Error("continuation provider down")),
    promptIfIdle: () => Effect.fail(new Error("continuation provider down")),
  }) as never)
  const providerMock = Layer.succeed(Provider.Service, {} as never)
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.sync(() => {
          judgeCalls += 1
          return JSON.stringify({ done: false, reason: "more steps needed" })
        }),
    }),
  )
  const failLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(promptFailMock),
    Layer.provide(providerMock),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )
  const it = testEffect(failLayer)

  // 1.2 — continuation prompt fails → goal transitions to paused with a reason
  // and a goal.updated(paused) event; afterIdle does not propagate the error.
  it.instance("continuation prompt 失败 → goal paused + reason + 事件发布", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship the feature", 10)
      yield* Effect.yieldNow

      // idle → judge(continue) → continuation prompt fails → catchCause → pause
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const g = yield* goal.load(sid)
          return g?.status === "paused" ? true : undefined
        }),
        "goal never transitioned to paused after continuation failure",
        "5 seconds",
      )

      const paused = yield* goal.load(sid)
      expect(paused?.status).toBe("paused")
      expect(String(paused?.paused_reason)).toContain("continuation dispatch failed")
      // goal.updated(paused) published (SSE/TUI visible)
      expect(seen.some((e) => e.type === GoalEvent.Updated.type && e.status === "paused")).toBe(true)
      // The continuation was actually attempted: judge ran, turns_used advanced.
      expect(judgeCalls).toBeGreaterThanOrEqual(1)
      expect(Number(paused?.turns_used)).toBe(1)
    }),
  )

  // 1.3 — after the failure-induced pause, /goal resume restores active and
  // preserves the turns_used budget (resume must not silently grant a fresh budget).
  it.instance("paused 后 resume 恢复 active，turns_used 保留", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship the feature", 10)
      yield* Effect.yieldNow
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const g = yield* goal.load(sid)
          return g?.status === "paused" ? true : undefined
        }),
        "goal never transitioned to paused before resume",
        "5 seconds",
      )
      const before = yield* goal.load(sid)
      const turnsBefore = Number(before?.turns_used)

      const resumed = yield* goal.resume(sid)
      expect(resumed?.status).toBe("active")
      expect(Number(resumed?.turns_used)).toBe(turnsBefore) // budget preserved, not reset
      expect(resumed?.paused_reason).toBeUndefined()
    }),
  )
})

// ── GOAL-FP-01-12: dispatch-failure unregister must not depend on the
// trailing load ─────────────────────────────────────────────────────────
//
// The failure path pauses the goal and the loop releases the lease
// registration afterwards. That release must be SYMMETRIC with the pause
// (pauseAndPublish + unregister in the same handler) — it must not depend on
// the afterDispatch load that follows the dispatch attempt. To make the
// dependency observable, the failure path's visible-pause prompt parks on a
// gate; the test body then drops the goal_state table and releases the gate,
// so the trailing load dies with a defect: only an inline unregister can
// release the lease.
describe("GoalLoop — dispatch failure releases the lease without the trailing load (GOAL-FP-01-12)", () => {
  let judgeCalls = 0
  let promptGate = Deferred.makeUnsafe<void>()
  const reset = () => {
    judgeCalls = 0
    promptGate = Deferred.makeUnsafe<void>()
  }

  const sessionMock = Layer.mock(Session.Service, {
    messages: () => Effect.succeed([mkAssistant()]),
  })
  // Continuation dispatch fails (promptIfIdle). The failure handler's
  // visible-pause prompt parks on a gate — the sync point where the test body
  // drops the goal_state table — so afterDispatch's goal.load defects: the
  // lease release must NOT depend on that trailing load. The die after the
  // gate is swallowed by the handler's Effect.ignore.
  const promptFailAndParkMock = Layer.mock(SessionPrompt.Service, withIdleAdmission({
    prompt: () =>
      Effect.gen(function* () {
        yield* Deferred.await(promptGate)
        return yield* Effect.die("failure-path prompt is the last stop before the trailing load")
      }),
    promptIfIdle: () => Effect.die(new Error("continuation provider down")),
  }))
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.sync(() => {
          judgeCalls += 1
          return JSON.stringify({ done: false, reason: "more steps needed" })
        }),
    }),
  )
  const failLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(promptFailAndParkMock),
    Layer.provide(Layer.mock(Provider.Service, {})),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provideMerge(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
    Layer.provideMerge(SessionAutomationLease.defaultLayer),
    Layer.provideMerge(Database.defaultLayer),
  )
  const it = testEffect(failLayer)

  it.instance("the lease registration is gone after the failure pause even when the post-dispatch load dies", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const automation = yield* SessionAutomationLease.Service
      const { db } = yield* Database.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      yield* loop.init()
      const sid = SessionID.descending()
      const goalState = yield* goal.set(sid, "ship the feature", 10)
      const goalOwner = { kind: "goal" as const, id: goalState.goal_id ?? "legacy" }
      yield* Effect.yieldNow

      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      // The pause committed and published BEFORE the handler reaches the
      // parked prompt — the parked handler is the deterministic sync point.
      yield* pollWithTimeout(
        Effect.sync(() =>
          seen.some((e) => e.type === GoalEvent.Updated.type && e.status === "paused") ? true : undefined,
        ),
        "failure path never paused the goal",
        "5 seconds",
      )
      expect(Option.isNone(yield* automation.claim(sid, goalOwner))).toBe(true)
      // Kill the trailing load: the handler is parked on the prompt gate, so
      // dropping the table here guarantees afterDispatch's goal.load defects.
      yield* db.run("DROP TABLE goal_state")
      yield* Deferred.succeed(promptGate, undefined)
      // Give the (defecting) trailing load a scheduler turn to run.
      yield* Effect.sleep("100 millis")
      expect(judgeCalls).toBeGreaterThanOrEqual(1)

      // The paused goal was unclaimable before the durable store disappeared.
      // Once the authority itself is unreadable, admission must fail closed
      // instead of treating a failed durable read as an absent goal.
      expect(Exit.isFailure(yield* automation.claim(sid, goalOwner).pipe(Effect.exit))).toBe(true)
    }),
  )
})

// ── GOAL-FP-01-13: real admission seam for the goal continuation ───────
//
// Every other GoalLoop harness mocks SessionPrompt with a flat
// `promptIfIdle: () => Option.some(...)` — the real admission gate
// (SessionRunState.startIfIdle: Runner state machine, busy flip, onIdle →
// real SessionStatus.set → real idle event) is never exercised, so the
// lease-claim + promptIfIdle atomicity has no regression coverage.
//
// The REAL SessionPrompt layer pulls in the whole app (Permission, MCP, LSP,
// ToolRegistry, Config, Plugin, …) — disproportionate for this suite. The
// tightest feasible real seam: the REAL SessionRunState.defaultLayer, with a
// SessionPrompt mock that delegates promptIfIdle admission to the real gate
// exactly like the real implementation's core. Remains mocked (reported):
// SessionPrompt.admitPrompt (transcript write) + runLoop (provider turn),
// Session.messages, Provider, judge LLM.
describe("GoalLoop — real SessionRunState admission seam (GOAL-FP-01-13)", () => {
  let judgeCalls = 0
  let admissions = 0
  let rejectedAdmissions = 0
  let firstAdmissionParked = false
  let admissionRelease = Deferred.makeUnsafe<void>()
  const reset = () => {
    judgeCalls = 0
    admissions = 0
    rejectedAdmissions = 0
    firstAdmissionParked = false
    admissionRelease = Deferred.makeUnsafe<void>()
  }

  const sessionMock = Layer.mock(Session.Service, {
    messages: () => Effect.succeed([mkAssistant()]),
  })
  // Effect.fn-wrapped like the wake-integration harness's `deliver` mock. The
  // real SessionRunState is resolved via serviceOption (R-free, same pattern
  // the harness uses for the bridge) so the implementation stays assignable to
  // the SessionPrompt Interface while still hitting the REAL admission gate.
  //
  // The scripted "run" completes with an interrupt (typed never, no cast):
  // the Runner's finishRun still emits the real onIdle (status.set(idle) →
  // real event) before completing the handle, so the loop re-drive chain is
  // real. The mock returns Option.none() even on admission — afterIdle
  // discards the promptIfIdle result (only its failure matters), and
  // admission is observable through the real status flip and the counters.
  const prepareIfIdle = Effect.fn("test.goalSeam.SessionPrompt.prepareIfIdle")(function* (
    input: SessionPrompt.PromptInput,
  ) {
    const runState = yield* Effect.serviceOption(SessionRunState.Service)
    if (Option.isNone(runState)) return yield* Effect.die("SessionRunState not provided to the seam mock")
    const activation = yield* Deferred.make<void>()
    const admitted = yield* runState.value.startIfIdle(
      input.sessionID,
      Effect.die("onInterrupt is not exercised in this scenario"),
      Effect.gen(function* () {
        yield* Deferred.await(activation)
        admissions += 1
        if (admissions === 1) {
          firstAdmissionParked = true
          yield* Deferred.await(admissionRelease)
        }
        return yield* Effect.interrupt
      }),
    )
    if (Option.isNone(admitted)) {
      rejectedAdmissions += 1
      return Option.none()
    }
    return Option.some({
      activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
      result: admitted.value.pipe(Effect.exit, Effect.as(mkAssistant())),
      abort: runState.value.cancel(input.sessionID),
    })
  })
  const promptIfIdle = Effect.fn("test.goalSeam.SessionPrompt.promptIfIdle")(function* (
    input: SessionPrompt.PromptInput,
  ) {
    const prepared = yield* prepareIfIdle(input)
    if (Option.isNone(prepared)) return Option.none()
    yield* prepared.value.activate
    return Option.some(yield* prepared.value.result)
  })
  const promptMock = Layer.mock(SessionPrompt.Service, {
    prompt: () => Effect.die("the direct prompt path is not exercised in this scenario"),
    ...withIdleAdmission({ promptIfIdle }),
    prepareIfIdle,
  })
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.sync(() => {
          judgeCalls += 1
          // Calls 1-2 continue (drive admissions 1-2); call 3 ends the goal.
          return judgeCalls <= 2
            ? JSON.stringify({ done: false, reason: "more steps needed" })
            : JSON.stringify({ done: true, reason: "feature shipped" })
        }),
    }),
  )
  const seamLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(promptMock),
    Layer.provide(Layer.mock(Provider.Service, {})),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provideMerge(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
    Layer.provideMerge(SessionAutomationLease.defaultLayer),
    Layer.provideMerge(SessionRunState.defaultLayer),
  )
  const it = testEffect(seamLayer)

  it.instance("a continuation admitted by the real gate flips the session busy, blocks concurrent admission, and the real idle re-drives the loop to done", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const status = yield* SessionStatus.Service
      const runState = yield* SessionRunState.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship the feature", 10)
      yield* Effect.yieldNow

      // Turn 1: idle → judge(continue) → continuation admitted through the
      // REAL admission gate; the scripted run parks and the session is BUSY.
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.sync(() => (firstAdmissionParked ? true : undefined)),
        "the continuation was never admitted through the real gate",
        "5 seconds",
      )
      // Real seam proof: admission itself flipped the session status to busy.
      expect((yield* status.get(sid)).type).toBe("busy")
      // The real gate rejects concurrent admission while the goal run holds it
      // (the probe work is Effect.never — a rejection never forks it).
      const probe = yield* runState.startIfIdle(
        sid,
        Effect.die("probe onInterrupt is not exercised"),
        Effect.never,
      )
      expect(Option.isNone(probe)).toBe(true)
      expect(admissions).toBe(1)

      // Release the run: the REAL Runner onIdle publishes the REAL idle
      // status event, which re-drives GoalLoop with NO manual idle publish —
      // the next continuation and the judge(done) terminal transition both
      // ride the real chain.
      yield* Deferred.succeed(admissionRelease, undefined)
      yield* pollWithTimeout(
        Effect.sync(() => (admissions >= 2 ? true : undefined)),
        "the real onIdle event never re-drove the goal loop",
        "5 seconds",
      )
      expect(rejectedAdmissions).toBe(0)
      yield* pollWithTimeout(
        Effect.sync(() => (judgeCalls >= 3 ? true : undefined)),
        "the loop never reached the terminal judge call",
        "5 seconds",
      )

      // Terminal contract through the real chain: exactly one done update,
      // the cleared event, and the row is gone.
      const doneUpdates = seen.filter((e) => e.type === GoalEvent.Updated.type && e.status === "done")
      expect(doneUpdates.length).toBe(1)
      expect(seen.some((e) => e.type === GoalEvent.Cleared.type)).toBe(true)
      expect(yield* goal.load(sid)).toBeUndefined()
      expect(admissions).toBe(2)
      expect(judgeCalls).toBe(3)
    }),
  )
})

// ── Stall-prevention branch coverage ───────────────────────────────────
//
// afterIdle has four historically-silent stall paths that now surface as
// visible pauses or documented continuations. Each test drives exactly one
// branch via the GoalLoopJudgeLLM injection point + mocked Session /
// SessionPrompt, with Goal / SessionStatus / EventV2Bridge real so goal
// state, the fibers map, and the event bus are exercised end-to-end.

// Branch 1 (loop.ts): no assistant message in the last-20 window → the loop
// used to bare-return and leave the goal permanently "active" with no
// progress. It now publishes a visible pause + a noReply prompt.
describe("GoalLoop — no assistant in window → visible pause (branch 1)", () => {
  const promptCalls: { noReply?: boolean; text: string }[] = []
  const sessionMock = Layer.succeed(Session.Service, {
    messages: () => Effect.succeed([mkUser()]),
  } as never)
  const providerMock = Layer.succeed(Provider.Service, {} as never)
  // The judge is unreachable on this path — branch 1 returns before it.
  // Die loudly so a regression that reaches the judge fails the test.
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({ call: () => Effect.die("branch 1 must not reach the judge") }),
  )

  const branchLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(recordingPrompt(promptCalls)),
    Layer.provide(providerMock),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )
  const it = testEffect(branchLayer)

  it.instance("无 assistant 回复 → goal paused + 可见暂停提示 + noReply prompt", () =>
    Effect.gen(function* () {
      promptCalls.length = 0
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship the feature", 10)
      yield* Effect.yieldNow

      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const g = yield* goal.load(sid)
          return g?.status === "paused" ? true : undefined
        }),
        "branch 1 never paused the goal",
        "5 seconds",
      )

      const paused = yield* goal.load(sid)
      expect(paused?.status).toBe("paused")
      expect(String(paused?.paused_reason)).toContain("无 assistant 回复")
      // Visible pause: a noReply prompt was injected (not a bare return).
      expect(promptCalls.some((p) => p.noReply)).toBe(true)
    }),
  )
})

// A non-ignored user message newer than the last reply (HTTP noReply prompt,
// a /memory command turn, ESC before any reply) used to make every
// idle evaluation spend a judge call and then discard the verdict, leaving the
// goal active with no continuation and no visible pause. The loop now skips
// the judge and pauses visibly under the idle fence; a real prompt that is
// still running (Session busy) is left alone and judged once it is answered.
describe("GoalLoop — unanswered user message after the last reply", () => {
  let judgeCalls = 0
  const promptCalls: { noReply?: boolean; text: string }[] = []
  let window: unknown[] = []
  const reset = () => {
    judgeCalls = 0
    promptCalls.length = 0
  }
  const message = (id: string, role: "user" | "assistant", created: number, text: string) =>
    ({ info: { id, role, time: { created } }, parts: [{ type: "text", text }] }) as never

  const branchLayer = GoalLoop.layer.pipe(
    Layer.provide(Layer.succeed(Session.Service, { messages: () => Effect.succeed(window) } as never)),
    Layer.provide(recordingPrompt(promptCalls)),
    Layer.provide(Layer.succeed(Provider.Service, {} as never)),
    Layer.provide(
      Layer.succeed(
        GoalLoopJudgeLLM,
        GoalLoopJudgeLLM.of({
          call: () =>
            Effect.sync(() => {
              judgeCalls += 1
              return JSON.stringify({ verdict: "continue", reason: "more work" })
            }),
        }),
      ),
    ),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provideMerge(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )
  const it = testEffect(branchLayer)

  it.instance("an idle Session with an unanswered user message pauses the goal visibly without judging", () =>
    Effect.gen(function* () {
      reset()
      const now = Date.now()
      window = [
        message("asst-1", "assistant", now - 2_000, "I made progress; next I will add tests."),
        message("user-noreply", "user", now - 1_000, "/memory status"),
      ]
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship the feature", 10)
      yield* Effect.yieldNow

      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          return (yield* goal.load(sid))?.status === "paused" && promptCalls.length > 0 ? true : undefined
        }),
        "the unanswered user message never paused the goal",
        "5 seconds",
      )

      const paused = yield* goal.load(sid)
      expect(String(paused?.paused_reason)).toContain("尚未得到回复")
      expect(Number(paused?.turns_used)).toBe(0)
      expect(judgeCalls).toBe(0)
      expect(promptCalls).toEqual([{ noReply: true, text: expect.stringContaining("⏸ 目标已暂停") }])
    }),
  )

  it.instance("a running user turn is not paused; its answered reply is judged and continued", () =>
    Effect.gen(function* () {
      reset()
      const now = Date.now()
      window = [
        message("asst-1", "assistant", now - 2_000, "I made progress; next I will add tests."),
        message("user-real", "user", now - 1_000, "also update the docs"),
      ]
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const status = yield* SessionStatus.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship the feature", 10)
      yield* Effect.yieldNow

      // The user's prompt is admitted and running: an idle event observed for
      // the previous boundary must not pause the goal or spend a judge call.
      yield* status.set(sid, { type: "busy" })
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* Effect.sleep("200 millis")
      expect((yield* goal.load(sid))?.status).toBe("active")
      expect(judgeCalls).toBe(0)
      expect(promptCalls).toEqual([])

      // The turn answers the user; its real idle event drives the goal on.
      window = [...window, message("asst-2", "assistant", now, "Docs updated as requested.")]
      yield* status.set(sid, { type: "idle" })
      yield* pollWithTimeout(
        Effect.sync(() => (promptCalls.some((p) => !p.noReply) ? true : undefined)),
        "the answered user turn never drove a continuation",
        "5 seconds",
      )
      expect(judgeCalls).toBe(1)
      const state = yield* goal.load(sid)
      expect(state?.status).toBe("active")
      expect(Number(state?.turns_used)).toBe(1)
    }),
  )
})

// Branch 2 (loop.ts): the last assistant turn produced no text (pure tool
// calls / reasoning-only). The loop now synthesizes a "continue" verdict and
// skips the judge, instead of stalling. Proves the synthetic-continue path
// advances the turn budget without invoking the judge LLM.
describe("GoalLoop — empty assistant text → synthetic continue, no stall (branch 2)", () => {
  let judgeCalls = 0
  const promptCalls: { noReply?: boolean; text: string }[] = []
  const reset = () => {
    judgeCalls = 0
    promptCalls.length = 0
  }

  const sessionMock = Layer.succeed(Session.Service, {
    messages: () => Effect.succeed([mkAssistantTools()]),
  } as never)
  const providerMock = Layer.succeed(Provider.Service, {} as never)
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.sync(() => {
          judgeCalls += 1
          return JSON.stringify({ done: false, reason: "more steps" })
        }),
    }),
  )

  const branchLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(recordingPrompt(promptCalls)),
    Layer.provide(providerMock),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )
  const it = testEffect(branchLayer)

  it.instance("纯工具调用 → 跳过 judge，合成 continue，turns_used 推进不 stall", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship the feature", 10)
      yield* Effect.yieldNow

      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      // The synthetic continue dispatches a continuation prompt (non-noReply).
      // Poll on the dispatched prompt since turns_used is set just before it.
      yield* pollWithTimeout(
        Effect.sync(() => (promptCalls.some((p) => !p.noReply) ? true : undefined)),
        "branch 2 never dispatched a continuation",
        "5 seconds",
      )

      // Judge was never invoked — the empty-text short-circuit took over.
      expect(judgeCalls).toBe(0)
      const g = yield* goal.load(sid)
      expect(g?.status).toBe("active")
      expect(Number(g?.turns_used)).toBe(1)
    }),
  )
})

// Branch 4 (loop.ts): the continuation dispatch fails with an INTERRUPT cause
// (user pressed ESC mid-dispatch). The loop logs and returns WITHOUT pausing,
// relying on the session always re-emitting idle (SessionStatus.set publishes
// idle unconditionally) to fork a fresh afterIdle — whose shouldPreempt guard
// handles the user's newer message. Pausing here would race that replacement
// fiber. Asserts: no pause published, goal stays active, and a second idle
// event re-drives the loop (proving it is not stalled by the dropped interrupt).
describe("GoalLoop — continuation interrupted → no pause, goal stays active (branch 4)", () => {
  let judgeCalls = 0
  const reset = () => {
    judgeCalls = 0
  }

  const sessionMock = Layer.succeed(Session.Service, {
    messages: () => Effect.succeed([mkAssistant()]),
  } as never)
  // Continuation dispatch fails with an INTERRUPT cause — simulates user ESC
  // mid-dispatch. catchCause sees hasInterrupts → branch 4 (log + return). The
  // cause is held in `interruptCause` so each instance below covers a different
  // fiber-id shape: a DEFINED id (Cause.interrupt(0)) and Cause.interrupt()'s
  // undefined id — the F1 miss case that Cause.interruptors silently drops and
  // the old interruptors().size check misclassified as a dispatch failure.
  let interruptCause: Cause.Cause<never> = Cause.interrupt(0)
  const promptInterruptMock = Layer.succeed(SessionPrompt.Service, withIdleAdmission({
    prompt: () => Effect.failCause(interruptCause),
    promptIfIdle: () => Effect.failCause(interruptCause),
  }) as never)
  const providerMock = Layer.succeed(Provider.Service, {} as never)
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.sync(() => {
          judgeCalls += 1
          return JSON.stringify({ done: false, reason: "more steps" })
        }),
    }),
  )

  const branchLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(promptInterruptMock),
    Layer.provide(providerMock),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )
  const it = testEffect(branchLayer)

  it.instance("continuation 被中断（defined fiber id）→ 不暂停，goal 保持 active，后续 idle 重新驱动", () =>
    Effect.gen(function* () {
      reset()
      interruptCause = Cause.interrupt(0)
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship the feature", 10)
      yield* Effect.yieldNow

      // Turn 1: idle → judge(continue) → continuation fails with interrupt →
      // branch 4: log + return, NO pause.
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      // turns_used advancing proves updateAfterJudge ran (just before the
      // failed continuation), so the cycle reached the dispatch step.
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const g = yield* goal.load(sid)
          return Number(g?.turns_used) >= 1 ? true : undefined
        }),
        "branch 4: turns_used never advanced",
        "5 seconds",
      )

      const afterInterrupt = yield* goal.load(sid)
      expect(afterInterrupt?.status).toBe("active") // NOT paused
      expect(afterInterrupt?.paused_reason).toBeUndefined()
      // No goal.updated(paused) event was published by branch 4.
      expect(seen.some((e) => e.type === GoalEvent.Updated.type && e.status === "paused")).toBe(false)

      // Turn 2: a fresh idle event re-drives afterIdle — the contract branch 4
      // relies on (SessionStatus always re-emits idle). The loop must NOT be
      // stalled by the dropped interrupt; judge fires a second time.
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.sync(() => (judgeCalls >= 2 ? true : undefined)),
        "branch 4: loop did not re-drive on second idle",
        "5 seconds",
      )
    }),
  )

  // F1: the same interrupt contract must hold when the cause carries NO
  // defined fiber id (Cause.interrupt() → fiberId undefined). The old
  // interruptors().size check dropped such reasons (causeFilterInterruptors
  // skips undefined ids), misclassifying the interrupt as a dispatch failure
  // and spuriously pausing. hasInterrupts is structural and catches it.
  it.instance("continuation 被中断（undefined fiber id, F1 miss case）→ 同样不暂停，goal 保持 active", () =>
    Effect.gen(function* () {
      reset()
      interruptCause = Cause.interrupt()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* captureEvents(events)
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship the feature", 10)
      yield* Effect.yieldNow

      // idle → judge(continue) → continuation fails with an anonymous interrupt
      // → branch 4: log + return, NO pause (the F1 fix; old code paused here).
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const g = yield* goal.load(sid)
          return Number(g?.turns_used) >= 1 ? true : undefined
        }),
        "branch 4 (undefined id): turns_used never advanced",
        "5 seconds",
      )

      const afterInterrupt = yield* goal.load(sid)
      expect(afterInterrupt?.status).toBe("active") // NOT paused
      expect(afterInterrupt?.paused_reason).toBeUndefined()
      expect(seen.some((e) => e.type === GoalEvent.Updated.type && e.status === "paused")).toBe(false)
    }),
  )
})

// GOAL-FP-01-04: GoalLoop is purely event-driven — the idle subscription is
// the only driver, and nothing re-emits idle for sessions that already
// existed at startup. An active goal that survived a crash therefore sleeps
// until the next user interaction (and the D6 zombie guard cannot fire
// without an idle event). The startup scan in GoalLoop.init must resume it:
// seed the goal in the durable store BEFORE boot, publish ZERO idle/status
// events, and the goal must still get evaluated (judge + continuation).
//
// The shared scanLayer mirrors the e2e harness: Goal / SessionStatus /
// EventV2Bridge / the lease are real; Session / SessionPrompt / Provider and
// the judge LLM are mocked. provideMerge exposes SessionStatus and the lease
// to the test body so pre-boot setup (busy / dag owner) shares the SAME
// instances the scan reads.
describe("GoalLoop — startup scan resumes pre-boot active goals (GOAL-FP-01-04)", () => {
  let judgeCalls = 0
  let continuationCalls = 0
  const reset = () => {
    judgeCalls = 0
    continuationCalls = 0
  }

  // Layer.mock (not Layer.succeed(… as never)) — the R1 describe above shows
  // the warning-free pattern; `as never` would add lint-ratchet warnings.
  const sessionMock = Layer.mock(Session.Service, {
    messages: () => Effect.succeed([mkAssistant()]),
  })
  const promptMock = Layer.mock(SessionPrompt.Service, withIdleAdmission({
    prompt: () => Effect.die("the direct prompt path is not exercised in this scenario"),
    promptIfIdle: () =>
      Effect.sync(() => {
        continuationCalls += 1
        return Option.none()
      }),
  }))
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.sync(() => {
          judgeCalls += 1
          return JSON.stringify({ done: false, reason: "more steps needed" })
        }),
    }),
  )
  const scanLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(promptMock),
    Layer.provide(Layer.mock(Provider.Service, {})),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    // provideMerge (not provide): the test body seeds pre-boot busy / dag
    // owner through SessionStatus, the lease, and the DB, and the scan must
    // read the SAME instances (see the arbitration describe above).
    Layer.provideMerge(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
    Layer.provideMerge(SessionAutomationLease.defaultLayer),
    Layer.provideMerge(Database.defaultLayer),
  )
  const it = testEffect(scanLayer)

  // Seeds a durable session row (+ its project row, FK-required) so the
  // D-1 directory join can attribute the goal_state row to an instance.
  const seedSessionRow = (sessionID: SessionID, directory: string) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = ProjectSchema.ID.make(Bun.randomUUIDv7())
      yield* db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make(directory),
        sandboxes: [AbsolutePath.make(directory)],
      })
      yield* db.insert(SessionTable).values({
        id: sessionID,
        project_id: projectID,
        slug: "test-session",
        directory,
        title: "test session",
        version: "1",
        time_created: Date.now(),
        time_updated: Date.now(),
      })
    })

  it.instance("a goal active before boot is evaluated with ZERO idle events", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const directory = (yield* TestInstance).directory
      // Seed the durable store BEFORE GoalLoop boots — models a goal_state
      // row surviving a crash-restart. No idle/status event is published.
      const sid = SessionID.descending()
      yield* seedSessionRow(sid, directory)
      yield* goal.set(sid, "ship the feature", 10)
      yield* loop.init()

      // The only driver available is the startup scan: assert the full
      // claim+judge+continuation flow ran within the poll window.
      yield* pollWithTimeout(
        Effect.sync(() => (continuationCalls >= 1 ? true : undefined)),
        "startup scan never evaluated the pre-boot active goal",
        "5 seconds",
      )
      expect(judgeCalls).toBe(1)
      const g = yield* goal.load(sid)
      expect(g?.status).toBe("active")
      expect(Number(g?.turns_used)).toBe(1)
    }),
  )

  it.instance("a dag-owned session yields to the startup scan and resumes when the dag releases", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const automation = yield* SessionAutomationLease.Service
      const directory = (yield* TestInstance).directory

      // Session B is a plain active goal — its evaluation is the positive
      // signal that the scan RAN (judgeCalls 0→1). Session A is dag-owned:
      // the scan's claim must be rejected exactly like a real idle, so A
      // contributes no judge call and stays untouched.
      const sidA = SessionID.descending()
      const sidB = SessionID.descending()
      yield* seedSessionRow(sidA, directory)
      yield* seedSessionRow(sidB, directory)
      yield* goal.set(sidA, "goal owned by dag", 10)
      yield* goal.set(sidB, "goal evaluated by scan", 10)
      yield* automation.register(sidA, { kind: "dag", id: "dag-executor" })
      yield* loop.init()

      yield* pollWithTimeout(
        Effect.sync(() => (judgeCalls >= 1 ? true : undefined)),
        "startup scan never evaluated the unblocked goal",
        "5 seconds",
      )
      const a = yield* goal.load(sidA)
      expect(a?.status).toBe("active")
      expect(Number(a?.turns_used)).toBe(0) // claim rejected — trigger harmless
      expect(judgeCalls).toBe(1) // only B was evaluated

      // GOAL-FP-01-02: releasing the dag re-triggers the blocked goal
      // evaluation through the idle mechanism — no manual idle event needed.
      yield* automation.unregister(sidA, { kind: "dag", id: "dag-executor" })
      yield* pollWithTimeout(
        Effect.sync(() => (judgeCalls >= 2 ? true : undefined)),
        "goal did not resume after the dag released the session",
        "5 seconds",
      )
      const a2 = yield* goal.load(sidA)
      expect(Number(a2?.turns_used)).toBe(1)
    }),
  )

  it.instance("a busy session is not force-evaluated by the scan; its own idle event (or the bounded scan retry) drives it", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const status = yield* SessionStatus.Service
      const directory = (yield* TestInstance).directory

      const sidA = SessionID.descending()
      const sidB = SessionID.descending()
      yield* seedSessionRow(sidA, directory)
      yield* seedSessionRow(sidB, directory)
      yield* goal.set(sidA, "goal on busy session", 10)
      yield* goal.set(sidB, "goal on idle session", 10)
      yield* status.set(sidA, { type: "busy" })
      yield* loop.init()

      // B's evaluation proves the scan ran; A must have been skipped by the
      // SessionStatus gate — no force-evaluation mid-turn.
      yield* pollWithTimeout(
        Effect.sync(() => (judgeCalls >= 1 ? true : undefined)),
        "startup scan never evaluated the idle-session goal",
        "5 seconds",
      )
      expect(judgeCalls).toBe(1)
      const a = yield* goal.load(sidA)
      expect(a?.status).toBe("active")
      expect(Number(a?.turns_used)).toBe(0)

      // GOAL-04: the busy skip must be VISIBLE — the scan logs the deferral
      // with the session id (previously a bare `continue`: no log, no retry
      // obligation, a silently dormant goal).
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const logs = JSON.stringify(yield* logLines)
          return logs.includes("goal startup scan deferred busy sessions") ? (true as const) : undefined
        }),
        "busy session skip was never logged (GOAL-04)",
        "5 seconds",
      )
      expect(JSON.stringify(yield* logLines)).toContain(String(sidA))

      // When the busy session finishes, its own idle event drives the goal.
      // (The GOAL-04 bounded scan retry may also re-trigger it if the flip to
      // idle happens within the retry window — the revision fence keeps the
      // commit exactly-once either way.)
      yield* status.set(sidA, { type: "idle" })
      yield* pollWithTimeout(
        Effect.sync(() => (judgeCalls >= 2 ? true : undefined)),
        "busy session's goal was not driven by its own idle event",
        "5 seconds",
      )
      const a2 = yield* goal.load(sidA)
      expect(Number(a2?.turns_used)).toBe(1)
    }),
  )
})

// GOAL-FP-01-04 follow-up (D-1..D-4): scoping and hardening of the startup
// scan. D-1: the scan must be scoped to the instance's own directory (join
// goal_state → session.directory). D-2: a defective scan query must degrade
// to no-scan + a log, never kill init or the idle path. D-3: undecodable
// rows must be skipped with a visible log, not silently. D-4: a scan
// evaluation racing an idle evaluation must commit exactly once.
describe("GoalLoop — startup scan scoping and hardening (GOAL-FP-01-04 follow-up)", () => {
  let judgeCalls = 0
  let foreignJudgeCalls = 0
  let parkFirstJudge = false
  let judgeRelease = Deferred.makeUnsafe<void>()
  const reset = () => {
    judgeCalls = 0
    foreignJudgeCalls = 0
    parkFirstJudge = false
    judgeRelease = Deferred.makeUnsafe<void>()
  }

  // The judge LLM prompt carries the goal text verbatim, so the mock can
  // attribute calls to the foreign-directory goal via a marker string.
  const FOREIGN_GOAL = "FOREIGN-MARKER ship the feature"

  const sessionMock = Layer.mock(Session.Service, {
    messages: () => Effect.succeed([mkAssistant()]),
  })
  const promptMock = Layer.mock(SessionPrompt.Service, withIdleAdmission({
    prompt: () => Effect.die("the direct prompt path is not exercised in this scenario"),
    promptIfIdle: () => Effect.sync(() => Option.none()),
  }))
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: (opts: { user: string }) =>
        Effect.gen(function* () {
          judgeCalls += 1
          if (opts.user.includes("FOREIGN-MARKER")) foreignJudgeCalls += 1
          // D-4 hook: park the first judge call so the scan and idle
          // evaluations race deterministically.
          if (parkFirstJudge && judgeCalls === 1) yield* Deferred.await(judgeRelease)
          return JSON.stringify({ done: false, reason: "more steps needed" })
        }),
    }),
  )
  const hardenLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(promptMock),
    Layer.provide(Layer.mock(Provider.Service, {})),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provideMerge(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
    Layer.provideMerge(SessionAutomationLease.defaultLayer),
    Layer.provideMerge(Database.defaultLayer),
  )
  const it = testEffect(hardenLayer)

  const seedSessionRow = (sessionID: SessionID, directory: string) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = ProjectSchema.ID.make(Bun.randomUUIDv7())
      yield* db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make(directory),
        sandboxes: [AbsolutePath.make(directory)],
      })
      yield* db.insert(SessionTable).values({
        id: sessionID,
        project_id: projectID,
        slug: "test-session",
        directory,
        title: "test session",
        version: "1",
        time_created: Date.now(),
        time_updated: Date.now(),
      })
    })

  it.instance("D-1: a foreign-directory active goal is not evaluated; the same-directory goal is", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const directory = (yield* TestInstance).directory

      const sidForeign = SessionID.descending()
      const sidSame = SessionID.descending()
      yield* seedSessionRow(sidForeign, directory + "-foreign")
      yield* seedSessionRow(sidSame, directory)
      yield* goal.set(sidForeign, FOREIGN_GOAL, 10)
      yield* goal.set(sidSame, "ship the feature", 10)
      yield* loop.init()

      // Positive control: the same-directory goal IS evaluated by the scan.
      yield* pollWithTimeout(
        Effect.sync(() => (judgeCalls >= 1 ? true : undefined)),
        "startup scan never evaluated the same-directory goal",
        "5 seconds",
      )
      // Let any (buggy) foreign evaluation settle before asserting.
      yield* Effect.sleep("300 millis")
      const same = yield* goal.load(sidSame)
      const foreign = yield* goal.load(sidForeign)
      expect(Number(same?.turns_used)).toBe(1)
      expect(foreignJudgeCalls).toBe(0)
      expect(foreign?.status).toBe("active")
      expect(Number(foreign?.turns_used)).toBe(0)
    }),
  )

  it.instance("D-2: a defective scan query never kills init; the idle path still works", () =>
    Effect.gen(function* () {
      reset()
      const { db } = yield* Database.Service
      // Corrupt DB state: the scan query hits a missing table.
      yield* db.run("DROP TABLE goal_state")
      const loop = yield* GoalLoop.Service
      yield* loop.init() // must not die
      yield* db.run(
        "CREATE TABLE goal_state (session_id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)",
      )
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const directory = (yield* TestInstance).directory
      const sid = SessionID.descending()
      yield* seedSessionRow(sid, directory)
      yield* goal.set(sid, "ship the feature", 10)
      yield* Effect.yieldNow

      // The idle subscription (armed before the scan) must still drive the
      // goal — the defective scan degraded, it did not kill the loop.
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.sync(() => (judgeCalls >= 1 ? true : undefined)),
        "idle path dead after a defective scan",
        "5 seconds",
      )
      expect(Number((yield* goal.load(sid))?.turns_used)).toBe(1)
    }),
  )

  it.instance("D-3: an undecodable goal_state row is skipped with a visible warning log", () =>
    Effect.gen(function* () {
      reset()
      const { db } = yield* Database.Service
      const directory = (yield* TestInstance).directory
      const sid = SessionID.descending()
      yield* seedSessionRow(sid, directory)
      yield* db
        .insert(GoalStateTable)
        .values({ session_id: sid, payload: "{corrupt", updated_at: Date.now() })
      const loop = yield* GoalLoop.Service
      yield* loop.init()
      const logs = JSON.stringify(yield* logLines)
      expect(logs).toContain("goal startup scan skipped undecodable goal_state row")
      expect(logs).toContain(String(sid))
    }),
  )

  it.instance("D-4: a scan evaluation racing an idle evaluation commits exactly once", () =>
    Effect.gen(function* () {
      reset()
      parkFirstJudge = true
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const directory = (yield* TestInstance).directory
      const sid = SessionID.descending()
      yield* seedSessionRow(sid, directory)
      yield* goal.set(sid, "ship the feature", 10)
      yield* loop.init()

      // Wait for the scan's evaluation to reach the judge, where it parks.
      yield* pollWithTimeout(
        Effect.sync(() => (judgeCalls >= 1 ? true : undefined)),
        "the scan's evaluation never reached the judge",
        "5 seconds",
      )
      // A second idle for the same boundary must share the pending judge.
      // Releasing that judge must commit the boundary exactly once.
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* Deferred.succeed(judgeRelease, undefined)

      yield* pollWithTimeout(
        Effect.gen(function* () {
          const g = yield* goal.load(sid)
          return Number(g?.turns_used) >= 1 ? true : undefined
        }),
        "no racing evaluation committed",
        "5 seconds",
      )
      expect(judgeCalls).toBe(1)
      const g = yield* goal.load(sid)
      expect(g?.status).toBe("active")
      // The single-writer commit point (matchesExpected + record gate) must
      // yield exactly ONE commit for the boundary — not two.
      expect(Number(g?.turns_used)).toBe(1)
    }),
  )
})

// GOAL-FP-01-17 regression suite: every messages-window read in afterIdle
// that fails with storage NotFoundError (session row gone mid-goal, or a
// synthetic session) must degrade to an empty window — never a typed failure
// escaping the fork. Before the fix the pre-judge window escaped into the
// fork's catch and left the goal permanently "active" with zero logs.
describe("GoalLoop — NotFoundError messages window pauses instead of stalling (GOAL-FP-01-17)", () => {
  let judgeCalls = 0
  const sessionMock = Layer.mock(Session.Service, {
    messages: () => Effect.fail(new NotFoundError({ message: "Session not found" })),
  })
  const promptMock = Layer.mock(SessionPrompt.Service, {
    // The pause branch only delivers a noReply transcript line; die() proves
    // the pause happened without needing a cast for a full WithParts value.
    prompt: () => Effect.die(new Error("unreachable outside the pause branch")),
  })
  const providerMock = Layer.mock(Provider.Service, {})
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.sync(() => {
          judgeCalls += 1
          return JSON.stringify({ verdict: "done", reason: "must never run" })
        }),
    }),
  )

  const nfLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(promptMock),
    Layer.provide(providerMock),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )
  const it = testEffect(nfLayer)

  it.instance("idle with a NotFoundError messages window pauses the goal visibly", () =>
    Effect.gen(function* () {
      judgeCalls = 0
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service

      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "vanished-session tolerance", 5)
      yield* Effect.yieldNow

      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })

      const paused = yield* pollWithTimeout(
        Effect.gen(function* () {
          const g = yield* goal.load(sid)
          return g && g.status === "paused" ? g : undefined
        }),
        "goal never paused after a NotFoundError messages window — typed failure escaped the fork",
        "5 seconds",
      )
      expect(paused.paused_reason).toContain("无 assistant 回复")
      // The window must short-circuit before the judge ever runs.
      expect(judgeCalls).toBe(0)
    }),
  )
})

// GOAL-FP-01-18: the post-judge reload window (freshMsgs) needs the same
// tolerance — a session row deleted during the 5-30s judge latency must not
// stall a goal whose turn already committed. The evaluation proceeds to the
// continuation branch (shouldPreempt is defensively false on an empty window).
describe("GoalLoop — NotFoundError on the post-judge reload must not stall (GOAL-FP-01-18)", () => {
  let messageCall = 0
  let vanished = false
  const sessionMock = Layer.mock(Session.Service, {
    messages: () =>
      Effect.suspend(() => {
        messageCall += 1
        return !vanished
          ? Effect.succeed([mkAssistant()])
          : Effect.fail(new NotFoundError({ message: "Session not found" }))
      }),
  })
  const promptMock = Layer.mock(SessionPrompt.Service, {
    prompt: () => Effect.die(new Error("unreachable - paused branch not expected")),
    ...withIdleAdmission({ promptIfIdle: () => Effect.succeed(Option.none()) }),
  })
  const providerMock = Layer.mock(Provider.Service, {})
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.sync(() => {
          vanished = true
          return JSON.stringify({ verdict: "continue", reason: "more work" })
        }),
    }),
  )

  const reloadLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(promptMock),
    Layer.provide(providerMock),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )
  const it = testEffect(reloadLayer)

  it.instance("a vanished session during judge pauses without charging the turn", () =>
    Effect.gen(function* () {
      messageCall = 0
      vanished = false
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service

      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "post-judge reload tolerance", 5)
      yield* Effect.yieldNow

      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })

      const committed = yield* pollWithTimeout(
        Effect.gen(function* () {
          const g = yield* goal.load(sid)
          return g && g.status === "paused" ? g : undefined
        }),
        "missing boundary did not pause",
        "5 seconds",
      )
      expect(committed.turns_used).toBe(0)
      expect(committed.status).toBe("paused")
      expect(messageCall).toBeGreaterThanOrEqual(2)
    }),
  )
})

// GOAL-FP-01-18b: the judge chain must survive DEFECTS, not just typed
// failures. The production callLLM path (provider.defaultModel → small-model
// resolution → getLanguage → generateText) can defect (config orDie, payload
// decode throws); a defect escaping into the fork was the invisible 0-turn
// stall class. catchCause folds it into the parseFailed budget so the loop
// commits the parse failure and auto-pauses after
// MAX_CONSECUTIVE_PARSE_FAILURES (GOAL-03: budget-neutrally — a failed judge
// consumed no turn, so turns_used and the boundary stamp are untouched).
describe("GoalLoop — judge-chain defect degrades into the parse budget (GOAL-FP-01-18b)", () => {
  let judgeCalls = 0
  const sessionMock = Layer.mock(Session.Service, {
    messages: () => Effect.succeed([mkAssistant()]),
  })
  const promptMock = Layer.mock(SessionPrompt.Service, {
    prompt: () => Effect.die(new Error("unreachable - paused branch not expected")),
    ...withIdleAdmission({ promptIfIdle: () => Effect.succeed(Option.none()) }),
  })
  const providerMock = Layer.mock(Provider.Service, {})
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.sync(() => {
          judgeCalls += 1
        }).pipe(Effect.flatMap(() => Effect.die(new Error("simulated provider-chain defect")))),
    }),
  )

  const defectLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(promptMock),
    Layer.provide(providerMock),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )
  const it = testEffect(defectLayer)

  // GOAL-03: the commit still lands (the parse-failure counter advances so
  // the auto-pause safety valve keeps working), but the failed judge is
  // budget-neutral — it evaluated no turn, so turns_used stays 0 and the
  // boundary is not stamped as judged.
  it.instance("a defecting judge commits a parse failure without consuming budget", () =>
    Effect.gen(function* () {
      judgeCalls = 0
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service

      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "judge defect tolerance", 5)
      yield* Effect.yieldNow

      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })

      const committed = yield* pollWithTimeout(
        Effect.gen(function* () {
          const g = yield* goal.load(sid)
          return g && g.consecutive_parse_failures >= 1 ? g : undefined
        }),
        "parse failure never committed — the judge defect escaped the fork",
        "5 seconds",
      )
      expect(judgeCalls).toBe(2)
      expect(committed.turns_used).toBe(0)
      expect(committed.consecutive_parse_failures).toBe(1)
      expect(committed.last_judged_msg).toBeUndefined()
      // First defect is a blip: verdict stays continue, goal keeps running.
      expect(committed.status).toBe("active")
    }),
  )
})

// issue #285 / GOAL-FP-01-21 / GOAL-01: the boot scan must not re-judge a
// boundary the crashed process already judged and committed, but it MUST
// still restore the drive. The process-local evaluatedRevisions map dies
// with the process, so the DURABLE gate is the goal row's last_judged_msg:
// updateAfterJudge records the judged assistant message ID on every continue
// commit, and while the session window still ends on that same message the
// scan path suppresses RE-JUDGMENT only — a plain skip stranded goals whose
// committed continuation was lost to the crash (nothing left to drive them,
// GOAL-01). On a gate hit the judge and its commit are skipped, but the
// continuation dispatch still runs. Live idle events are never gated (each
// dispatched continuation produces a fresh assistant message, so the live
// path always sees a new boundary).
describe("GoalLoop — boot scan must not re-evaluate an already-judged boundary (issue #285)", () => {
  let judgeCalls = 0
  let continuationCalls = 0
  let boundaryID = "msg_boundary_a"
  const reset = () => {
    judgeCalls = 0
    continuationCalls = 0
    boundaryID = "msg_boundary_a"
  }

  const sessionMock = Layer.mock(Session.Service, {
    messages: () => Effect.succeed([mkAssistant(boundaryID)]),
  })
  const promptMock = Layer.mock(SessionPrompt.Service, withIdleAdmission({
    prompt: () => Effect.die("the direct prompt path is not exercised in this scenario"),
    promptIfIdle: () =>
      Effect.sync(() => {
        continuationCalls += 1
        return Option.none()
      }),
  }))
  const judgeMock = Layer.succeed(
    GoalLoopJudgeLLM,
    GoalLoopJudgeLLM.of({
      call: () =>
        Effect.sync(() => {
          judgeCalls += 1
          return JSON.stringify({ verdict: "continue", reason: "more work" })
        }),
    }),
  )

  const boundaryLayer = GoalLoop.layer.pipe(
    Layer.provide(sessionMock),
    Layer.provide(promptMock),
    Layer.provide(Layer.mock(Provider.Service, {})),
    Layer.provide(judgeMock),
    Layer.provideMerge(Goal.defaultLayer),
    Layer.provideMerge(SessionStatus.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
    Layer.provideMerge(SessionAutomationLease.defaultLayer),
    Layer.provideMerge(Database.defaultLayer),
  )
  const it = testEffect(boundaryLayer)

  const seedSessionRow = (sessionID: SessionID, directory: string) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = ProjectSchema.ID.make(Bun.randomUUIDv7())
      yield* db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make(directory),
        sandboxes: [AbsolutePath.make(directory)],
      })
      yield* db.insert(SessionTable).values({
        id: sessionID,
        project_id: projectID,
        slug: "test-session",
        directory,
        title: "test session",
        version: "1",
        time_created: Date.now(),
        time_updated: Date.now(),
      })
    })

  // Commits one continue evaluation ahead of the (re)boot — models a process
  // that crashed right after the commit, before the continuation produced an
  // assistant message.
  const commitPriorBoundary = (sid: SessionID) =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const before = yield* goal.load(sid)
      const result = yield* goal.updateAfterJudge(
        sid,
        "continue",
        "pre-crash commit",
        false,
        { goalID: before!.goal_id ?? "legacy", revision: before!.revision ?? 0 },
        boundaryID,
      )
      expect(result?.state.turns_used).toBe(1)
      return result?.state
    })

  // GOAL-01: the gate suppresses RE-JUDGMENT, never the drive. The crashed
  // continuation must be re-dispatched (the goal would otherwise sit
  // permanently active with nothing driving it), while the judge call and
  // the turns_used increment stay suppressed (no inflation).
  it.instance("scan with an unchanged boundary skips re-judgment but still dispatches the continuation", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const directory = (yield* TestInstance).directory
      const sid = SessionID.descending()
      yield* seedSessionRow(sid, directory)
      yield* goal.set(sid, "boundary guard", 5)
      yield* commitPriorBoundary(sid)

      yield* loop.init()
      // The gate-hit path dispatches the continuation synchronously enough to
      // poll on its admission signal instead of a bounded sleep.
      yield* pollWithTimeout(
        Effect.sync(() => (continuationCalls >= 1 ? true : undefined)),
        "gate-hit scan never dispatched the crashed continuation",
        "5 seconds",
      )
      expect(judgeCalls).toBe(0)
      expect(continuationCalls).toBe(1)
      const g = yield* goal.load(sid)
      expect(g?.turns_used).toBe(1)
    }),
  )

  it.instance("scan proceeds once the window advanced past the boundary", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const directory = (yield* TestInstance).directory
      const sid = SessionID.descending()
      yield* seedSessionRow(sid, directory)
      yield* goal.set(sid, "boundary guard", 5)
      yield* commitPriorBoundary(sid)
      // The continuation finished and produced a NEW assistant message.
      boundaryID = "msg_boundary_b"

      yield* loop.init()
      yield* pollWithTimeout(
        Effect.sync(() => (judgeCalls >= 1 ? true : undefined)),
        "scan never re-evaluated the advanced boundary",
        "5 seconds",
      )
      const g = yield* goal.load(sid)
      expect(g?.turns_used).toBe(2)
      expect(continuationCalls).toBe(1)
    }),
  )
})
