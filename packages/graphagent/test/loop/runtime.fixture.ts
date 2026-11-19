// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect, Layer } from "effect"
import { SessionV1 } from "@graphagent/core/v1/session"
import type { LoopAnalysisResult } from "@graphagent/schema/loop"
import { REASONING_STATE_MESSAGE } from "@/provider/error"
import { LoopAnalysis } from "@/loop/analysis"
import { LoopHost } from "@/loop/host"
import type { LoopState } from "@/loop/state"
import type { SessionRetry } from "@/session/retry"
import type { SessionID } from "@/session/schema"
import type { TurnOutcome } from "@/session/turn/decide"

/**
 * The fakes behind the loop runtime tests: the session (`LoopHost`), and the background analysis. Both are
 * scripted per session id, so tests that share a layer never see each other's calls.
 */

const id = (n: number) => `msg_${String(n).padStart(4, "0")}`

/** One session as the host sees it. Messages share one ascending counter, like real message ids. */
export class FakeSession {
  idle = true
  epoch = 0
  boundary: LoopHost.Boundary | undefined
  /** Every human message, oldest first. */
  readonly humans: Array<{ id: string; text: string }> = []
  /** Every message the loop dispatched, accepted or not, in order. */
  readonly requests: LoopHost.Request[] = []
  /** The accepted ones. */
  readonly sent: LoopHost.Request[] = []
  nudges = 0
  /** What a running watch or task would register as, or a function of the clock like the real host's deadline rule. */
  waitable: LoopState.Wait | ((now: number) => LoopState.Wait | undefined) | undefined
  /** How often the runtime asked for it. */
  waitableCalls = 0
  /** Waits whose object is gone, by `wait_id`, with the reason. */
  readonly gone = new Map<string, string>()
  /** The answer to the next dispatch, without running `commit`. */
  answer: LoopHost.Dispatched | undefined
  /** Makes the next dispatch die. */
  die = false
  /** Held inside the dispatch before anything is decided, so a test can end the run while the admission is pending. */
  gate: Effect.Effect<void> | undefined
  private counter = 0

  next() {
    this.counter += 1
    return id(this.counter)
  }

  /** A human message arrives. */
  human(text = "a human message") {
    const message = this.next()
    this.humans.push({ id: message, text })
    return message
  }

  /** A turn starts. */
  begin() {
    this.idle = false
  }

  /** The running turn ends with an assistant message, which becomes the boundary. */
  finish(boundary: Partial<LoopHost.Boundary> = {}) {
    const message = this.next()
    this.idle = true
    this.boundary = {
      message,
      turn: { type: "completed" },
      humanTurn: false,
      userRejected: false,
      endedAt: Date.now(),
      ...boundary,
    }
    return message
  }

  /** The turn ends on a provider error. */
  fail(error: SessionRetry.Err, boundary: Partial<LoopHost.Boundary> = {}) {
    return this.finish({
      turn: { type: "error", code: error.name, retryable: true },
      error: { error, provider: "test" },
      ...boundary,
    })
  }

  get preempted() {
    const message = this.boundary?.message
    return message !== undefined && this.humans.some((human) => human.id > message)
  }
}

export class FakeHost {
  private readonly sessions = new Map<SessionID, FakeSession>()
  readonly liveSessions: LoopHost.Live[] = []

  session(sessionID: SessionID) {
    const known = this.sessions.get(sessionID)
    if (known !== undefined) return known
    const created = new FakeSession()
    this.sessions.set(sessionID, created)
    return created
  }

  readonly service: LoopHost.Interface = {
    observe: (sessionID, query) =>
      Effect.sync(() => {
        const session = this.session(sessionID)
        return {
          idle: session.idle,
          ...(session.boundary !== undefined ? { boundary: session.boundary } : {}),
          humans: session.humans.filter((human) => query.after === undefined || human.id > query.after),
          preempted: session.preempted,
        }
      }),
    dispatch: (sessionID, request) => {
      const session = this.session(sessionID)
      return Effect.gen(function* () {
        session.requests.push(request)
        if (session.gate !== undefined) yield* session.gate
        if (session.die) return yield* Effect.die(new Error("the session write failed"))
        if (session.answer !== undefined) return session.answer
        if (!session.idle || session.preempted) return "refused" as const
        if (request.epoch !== session.epoch) return "cancelled" as const
        if (request.boundary !== undefined && request.boundary !== session.boundary?.message) return "refused" as const
        if (!(yield* request.commit)) return "refused" as const
        session.sent.push(request)
        session.begin()
        return "started" as const
      })
    },
    health: (sessionID, wait) =>
      Effect.sync(() => {
        const reason = this.session(sessionID).gone.get(wait.wait_id)
        return reason === undefined ? { alive: true as const } : { alive: false as const, reason }
      }),
    waitable: (sessionID, now) =>
      Effect.sync(() => {
        const session = this.session(sessionID)
        session.waitableCalls += 1
        return typeof session.waitable === "function" ? session.waitable(now) : session.waitable
      }),
    epoch: (sessionID) => Effect.sync(() => this.session(sessionID).epoch),
    nudge: (sessionID) =>
      Effect.sync(() => {
        this.session(sessionID).nudges += 1
      }),
    live: () => Effect.sync(() => [...this.liveSessions]),
  }
}

type Script = LoopAnalysis.Outcome | ((input: LoopAnalysis.RunInput) => Effect.Effect<LoopAnalysis.Outcome>)

const report = { usage: { input: 10, output: 5, reasoning: 2 }, elapsedMs: 7, steps: 1, attempts: 1 }

export const ok = (result: LoopAnalysisResult): LoopAnalysis.Outcome => ({ type: "ok", result, ...report })

export const failed = (failure: LoopAnalysis.Failure): LoopAnalysis.Outcome => ({ type: "failed", failure, ...report })

/** The analysis, answering from a script per session and remembering what it was asked. */
export class FakeAnalysis {
  private readonly scripts = new Map<SessionID, Script[]>()
  private readonly asked = new Map<SessionID, LoopAnalysis.RunInput[]>()

  script(sessionID: SessionID, ...steps: Script[]) {
    this.scripts.set(sessionID, [...(this.scripts.get(sessionID) ?? []), ...steps])
  }

  calls(sessionID: SessionID): ReadonlyArray<LoopAnalysis.RunInput> {
    return this.asked.get(sessionID) ?? []
  }

  readonly service: LoopAnalysis.Interface = {
    run: (input) =>
      Effect.suspend(() => {
        this.asked.set(input.sessionID, [...(this.asked.get(input.sessionID) ?? []), input])
        const step = this.scripts.get(input.sessionID)?.shift()
        if (step === undefined) return Effect.die(new Error("the analysis was not scripted for this call"))
        return typeof step === "function" ? step(input) : Effect.succeed(step)
      }),
  }
}

export const host = new FakeHost()
export const analysis = new FakeAnalysis()

export const hostLayer = Layer.succeed(LoopHost.Service, LoopHost.Service.of(host.service))
export const analysisLayer = Layer.succeed(LoopAnalysis.Service, LoopAnalysis.Service.of(analysis.service))

/** A provider error the retry policy classifies by status: 5xx and 429 heal with time, 401 and 400 never. */
export const providerError = (statusCode: number): SessionRetry.Err =>
  new SessionV1.APIError({ message: `status ${statusCode}`, isRetryable: false, statusCode }).toObject()

export const completed: TurnOutcome = { type: "completed" }

/** The provider rejected the saved reasoning state: only a reset heals it, and only once. */
export const reasoningError = (): SessionRetry.Err =>
  new SessionV1.APIError({ message: REASONING_STATE_MESSAGE, isRetryable: false, statusCode: 400 }).toObject()
