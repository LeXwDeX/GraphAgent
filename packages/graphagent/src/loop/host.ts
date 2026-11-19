// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The session side of the loop (#1329): what `LoopRuntime` needs to know about a session and to do to one,
 * and cannot decide itself.
 *
 * The runtime owns the decisions (`StopCondition`), the state (`LoopState`) and the analysis
 * (`LoopAnalysis`). This port owns the facts of the session and the one effect that touches it: starting a
 * turn. It is the seam the goal system had inline, in `GoalLoop` (read the messages, check the lease, admit
 * under a fence, wake on a job). The real adapter arrives with the switch-over; here it is only the contract.
 *
 * Every method is read-only except `dispatch` and `nudge`.
 */
import { Context, type Effect } from "effect"
import type { SessionID } from "@/session/schema"
import type { SessionRetry } from "@/session/retry"
import type { TurnOutcome } from "@/session/turn/decide"
import type { LoopInput } from "./input"
import type { LoopState } from "./state"

/**
 * Why the loop started a turn. `recovery` re-runs a round that failed (or whose analysis failed) and is the
 * only kind that does not count as a round.
 */
export type Kind = "next" | "wake" | "review" | "recovery"

/** What a loop-dispatched message carries so the interface and Memory can tell it from a human one. */
export interface Marker {
  readonly loopID: string
  readonly round: number
  readonly kind: Kind
}

/** How the turn that closed the latest boundary ended, as the session recorded it. */
export interface Boundary {
  /** The closing assistant message; a compaction summary is never one. Absent when the turn left none. */
  readonly message?: string
  readonly turn: TurnOutcome
  /** The error the closing assistant message carries, for `StopCondition.failureOf`. Absent for a defect. */
  readonly error?: { readonly error: SessionRetry.Err; readonly provider: string }
  /** A human message started the turn. A human message merged into a running automatic turn does not make it one. */
  readonly humanTurn: boolean
  /** The turn ended because the user refused a permission prompt or a question. */
  readonly userRejected: boolean
  /** A hook stopped the turn: Stop or admission `continue: false`, or a tool-phase hook ended it. */
  readonly hookStop?: { readonly message: string }
}

export interface Query {
  /** Human messages are those after this message (the assistant message of the last analysis, or the one that started the loop). */
  readonly after?: string
  /** Without `after`: human messages created after this time. */
  readonly since: number
}

/**
 * Message ids sort by creation: the runtime compares them as strings to tell which of two messages is newer.
 */
export interface Observation {
  /** No turn is running. A boundary is decided only while the session is idle. */
  readonly idle: boolean
  /** The latest boundary. Absent while the session has not produced a turn. */
  readonly boundary?: Boundary
  /** Human messages after `Query.after`, oldest first, merged ones included. */
  readonly humans: ReadonlyArray<LoopInput.Human>
  /** A human message newer than the boundary is still waiting for its reply. */
  readonly preempted: boolean
}

/** Whether the object a wait names can still wake the loop. */
export type Health = { readonly alive: true } | { readonly alive: false; readonly reason: string }

export interface Request {
  readonly marker: Marker
  /** The three-segment message, sent as synthetic user text that starts with `LoopMessage.PREFIX`. */
  readonly text: string
  /** The boundary this answers. The admission is refused when the session's latest closing assistant message is another one. */
  readonly boundary?: string
  /** The provider rejected the saved reasoning state: compact the session first and send the message after the summary. */
  readonly reset?: boolean
  /** The cancellation epoch observed before the decision was made. An ESC since then makes the admission `cancelled`. */
  readonly epoch: number
  /**
   * Runs inside the admission, once, right before the message is committed, and settles it: `false` refuses
   * the admission and nothing is written. The state write that counts the round goes here, so a round and its
   * message commit together or not at all.
   */
  readonly commit: Effect.Effect<boolean>
}

/**
 * `started`: the message is committed and its turn runs (this does not wait for the turn). `refused`: nothing
 * was written, because a turn is running, a human message is waiting for its reply, the boundary moved on, or
 * `commit` said no. `cancelled`: the user pressed ESC since `epoch` was observed.
 */
export type Dispatched = "started" | "refused" | "cancelled"

export interface Live {
  readonly sessionID: SessionID
  readonly status: "active" | "waiting"
}

export interface Interface {
  /** The facts of the session at its latest boundary. */
  readonly observe: (sessionID: SessionID, query: Query) => Effect.Effect<Observation>
  /** Admits one loop message and starts its turn. Defects propagate: the runtime stops the loop on them. */
  readonly dispatch: (sessionID: SessionID, request: Request) => Effect.Effect<Dispatched>
  /** Whether the object `wait` names is still alive. A wait without a reference is. */
  readonly health: (sessionID: SessionID, wait: LoopState.Wait) => Effect.Effect<Health>
  /**
   * A running PR watch (first) or background task (the latest registered) that may still unblock the work,
   * as the wait to record with its deadline, or `undefined` when there is none.
   */
  readonly waitable: (sessionID: SessionID, now: number) => Effect.Effect<LoopState.Wait | undefined>
  /** The session's cancellation epoch, which advances on every ESC. */
  readonly epoch: (sessionID: SessionID) => Effect.Effect<number>
  /** Runs the boundary decision again as soon as the session is idle, without waiting for the next idle event. */
  readonly nudge: (sessionID: SessionID) => Effect.Effect<void>
  /** Sessions of this directory that have an `active` or `waiting` loop. */
  readonly live: (directory: string) => Effect.Effect<ReadonlyArray<Live>>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/LoopHost") {}

export * as LoopHost from "./host"
