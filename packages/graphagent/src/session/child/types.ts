// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { ChildOwnerKind, ChildRunState } from "@graphagent/core/session/child.sql"
import { Schema, type Effect, type Option } from "effect"
import type { SessionID } from "../schema"

/**
 * Child-run vocabulary (Issue #1026, PR1). A child run is one episode of work a
 * parent session delegated to a child session: its owner (a task tool call, or a
 * DAG node from PR4), its durable `child_run` row, and its in-process registry
 * entry. The runtime shape lives in `run.ts`; this module only names the types.
 */

export type { ChildOwnerKind, ChildRunState }

/** Who asked for the run. PR1 registers task owners only; DAG nodes arrive with PR4. */
export type ChildOwner =
  | { readonly kind: "task"; readonly toolCallID?: string }
  | { readonly kind: "dag_node"; readonly workflowID: string; readonly nodeID: string; readonly attempt: number }

/** Who ended a run on purpose. */
export type ChildCancelBy =
  | { readonly kind: "main_agent_tool"; readonly toolCallID: string }
  | { readonly kind: "engine"; readonly reason: string }

/**
 * How a run ended. `interrupted` is what recovery and instance disposal record:
 * nobody asked for it and no result was produced.
 */
export type ChildRunOutcome =
  | { readonly type: "completed" }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "cancelled"; readonly by: ChildCancelBy }
  | { readonly type: "interrupted"; readonly reason?: string }

export interface ChildRunSpec {
  readonly parentSessionID: SessionID
  readonly childSessionID: SessionID
  readonly owner: ChildOwner
  /** A background run reports back through its parent after it ends; a foreground run returns to its tool call. */
  readonly detached: boolean
}

/** Read model of one `child_run` row. */
export interface ChildRunView {
  readonly id: string
  readonly childSessionID: SessionID
  readonly parentSessionID: SessionID
  readonly ownerKind: ChildOwnerKind
  readonly state: ChildRunState
  readonly attempt: number
  readonly detached: boolean
  readonly outcome?: ChildRunOutcome
  readonly reportedAt?: number
  readonly timeCreated: number
  readonly timeEnded?: number
}

/**
 * The driver's handle on one registered run. Persisted states are only
 * queued, running and ended; each transition is one write.
 */
export interface ChildRunHandle {
  readonly id: string
  readonly childSessionID: SessionID
  /** 1 for the first run of a child session, +1 for every later run. */
  readonly attempt: number
  /** queued -> running. False when the run already ended (cancelled while it waited). */
  readonly markRunning: Effect.Effect<boolean>
  /**
   * Ends the run with `outcome`. The first of several racing settlements wins
   * (compare-and-swap); every later caller gets `false` and changes nothing.
   * Call it when the run's driver stops (the job is terminal, the tool call
   * exits): winner or not, it tells the registry the driver is gone, which
   * frees the child session of a run a cancellation ended earlier.
   */
  readonly settle: (outcome: ChildRunOutcome) => Effect.Effect<boolean>
  /** Resolves with the outcome that won, whoever settled or cancelled the run. */
  readonly settled: Effect.Effect<ChildRunOutcome>
  /** Resolves when the run is cancelled; never resolves for any other ending. */
  readonly cancelled: Effect.Effect<ChildCancelBy>
}

/** The session is not a child session this parent started with the requested owner kind. */
export class NotOwner extends Schema.TaggedError<NotOwner>()("ChildRunNotOwner", {
  childSessionID: Schema.String,
}) {
  override get message() {
    return `Session ${this.childSessionID} is not a task session started by this conversation`
  }
}

/** The child session already has an active run (only one at a time). */
export class ActiveRunExists extends Schema.TaggedError<ActiveRunExists>()("ChildRunActive", {
  childSessionID: Schema.String,
  runID: Schema.String,
}) {
  override get message() {
    return `Session ${this.childSessionID} already has an active run (${this.runID})`
  }
}

export type ChildRunError = NotOwner | ActiveRunExists

/** What happened to a cancellation request. */
export type ChildRunCancelResult = "cancelled" | "not_active"

/** Child-run operations a tool sees for one parent session; the parent is fixed and cannot be named by the caller. */
export interface ChildRunsScoped {
  readonly parentSessionID: SessionID
  /** Registers the first run of a child session the parent just created. */
  readonly start: (spec: Omit<ChildRunSpec, "parentSessionID">) => Effect.Effect<ChildRunHandle>
  /**
   * Registers a new run on an existing child session after verifying that this
   * parent started it as a task: anything else fails with `NotOwner` and
   * writes nothing. A child that is still running fails with `ActiveRunExists`.
   * A run that has just ended, or that a cancellation ended while its driver is
   * still stopping, is waited for (at most the cancellation bound) instead.
   */
  readonly adopt: (spec: Omit<ChildRunSpec, "parentSessionID">) => Effect.Effect<ChildRunHandle, ChildRunError>
  /** The latest run of one of this parent's child sessions. */
  readonly latest: (childSessionID: SessionID) => Effect.Effect<Option.Option<ChildRunView>>
  readonly list: () => Effect.Effect<ReadonlyArray<ChildRunView>>
  /** Cancels an active run of this parent; any other run id is `not_active`. */
  readonly cancel: (runID: string, by: ChildCancelBy) => Effect.Effect<ChildRunCancelResult>
}

export interface ChildRunsInterface {
  /** Registers the first run of a child session. Writes the child's binding and the run. */
  readonly start: (spec: ChildRunSpec) => Effect.Effect<ChildRunHandle>
  /** Registers another run on an existing child session; see `ChildRunsScoped.adopt`. */
  readonly adopt: (spec: ChildRunSpec) => Effect.Effect<ChildRunHandle, ChildRunError>
  readonly inspect: (runID: string) => Effect.Effect<Option.Option<ChildRunView>>
  readonly latest: (childSessionID: SessionID) => Effect.Effect<Option.Option<ChildRunView>>
  readonly listByParent: (parentSessionID: SessionID) => Effect.Effect<ReadonlyArray<ChildRunView>>
  /**
   * Signal-and-return cancellation: the run ends `cancelled` synchronously
   * (compare-and-swap, credential revoked, row written), then the child
   * session's turn is cancelled in the background under a five second bound.
   * The child session stays reserved (`adopt` waits) until the run's driver
   * settles, five seconds at the latest, so a new run cannot start while the
   * old job still carries the session.
   */
  readonly cancel: (runID: string, by: ChildCancelBy) => Effect.Effect<ChildRunCancelResult>
  /** Ends rows a dead or earlier-life process left active (`interrupted`). */
  readonly recover: () => Effect.Effect<void>
  /** Ends this process's runs of a deleted session, as child or as parent. In memory plus row writes only. */
  readonly forget: (sessionID: SessionID) => Effect.Effect<void>
  readonly forParent: (parentSessionID: SessionID) => ChildRunsScoped
}
