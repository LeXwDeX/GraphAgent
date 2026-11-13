// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { ChildOwnerKind, ChildRunState } from "@graphagent/core/session/child.sql"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Schema, type Effect, type Option } from "effect"
import type { PromptInput } from "../prompt-input"
import type { SessionID } from "../schema"

/**
 * Child-run vocabulary (Issue #1026, PR1). A child run is one episode of work a
 * parent session delegated to a child session: its owner (a task tool call, or a
 * DAG node from PR4), its durable `child_run` row, and its in-process registry
 * entry. The runtime shape lives in `run.ts`; this module only names the types.
 */

export type { ChildOwnerKind, ChildRunState }

/**
 * Declared and never defined: the key of the credential's brand. It is not
 * exported, so no other module can name it and an object literal can never
 * satisfy `ChildRunCredential`; only the registry's issuer casts one into being.
 */
declare const issuedByChildRuns: unique symbol

/**
 * The witness a driver of a child session carries into admission (Issue #1026,
 * PR3b): proof that the prompt comes from the run that owns the child session.
 * It is issued when a run is registered (`ChildRegistry.create`), by nothing
 * else, and revoked when the run ends. A value of this type is never built
 * outside `ChildRuns`: drivers receive it from the run and hand it on.
 *
 * Admission only records it for now; PR5 refuses a child session's prompt that
 * does not carry the credential of its active run.
 */
export interface ChildRunCredential {
  readonly [issuedByChildRuns]: true
  readonly runID: string
  /** The child session the run drives; a credential is valid for that session only. */
  readonly childSessionID: SessionID
  /** True once the run ended. A revoked credential still names the run it was issued for. */
  readonly revoked: boolean
}

/** Who asked for the run. PR1 registers task owners only; DAG nodes arrive with PR4. */
export type ChildOwner =
  | { readonly kind: "task"; readonly toolCallID?: string }
  | { readonly kind: "dag_node"; readonly workflowID: string; readonly nodeID: string; readonly attempt: number }

/** Who ended a run on purpose. `actor` keeps the engine-side attribution of a cancellation (DAG loop, deadline watcher, recovery). */
export type ChildCancelBy =
  | { readonly kind: "main_agent_tool"; readonly toolCallID: string }
  | { readonly kind: "engine"; readonly reason: string; readonly actor?: string }

/**
 * How a run ended. `interrupted` is what recovery and instance disposal record:
 * nobody asked for it and no result was produced.
 */
export type ChildRunOutcome =
  | { readonly type: "completed" }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "cancelled"; readonly by: ChildCancelBy }
  | { readonly type: "interrupted"; readonly reason?: string }

/**
 * What a detached run tells its parent when it ends, kept with the run's row
 * until the result ledger has delivered it (`child.result`). `title` names the
 * work and `text` is the result, or the failure, as the owner wants the parent
 * to read it. A foreground run has none: its result is the tool result.
 */
export interface ChildRunReport {
  readonly title: string
  readonly text: string
}

/**
 * How the permission asks of a child session are settled (Issue #1026, PR4;
 * the adjudicator itself arrives with #1031). `root-dag-mode` is the task
 * tool's policy: the root session's `dag_mode` is read at each ask, so a mode
 * switch applies to the next request. DAG nodes are always `auto`.
 */
export type ChildAskPolicy = "user" | "auto" | "root-dag-mode"

export interface ChildPermissionPolicy {
  readonly ask: ChildAskPolicy
  /**
   * Deny the tools whose declared effects are workspace writes (E3 supplies
   * this for read-only workflows). Absent means no extra restriction.
   */
  readonly workspaceWrites?: "deny"
}

export interface ChildRunSpec {
  readonly parentSessionID: SessionID
  readonly childSessionID: SessionID
  readonly owner: ChildOwner
  /**
   * A background run reports back to its parent through the result ledger
   * after it ends; a foreground run returns to its tool call. A foreground run
   * the user promotes to the background becomes detached with `detach`.
   * DAG node runs are not ledger runs: the DAG delivers their result itself,
   * so they register `detached: false` and their ending counts as reported.
   */
  readonly detached: boolean
  /**
   * How permission asks of this run are settled; see `ChildPermissionPolicy`.
   * Defaults to `user` (always ask) for callers that predate the policy,
   * notably SDK-created child sessions and fixtures.
   */
  readonly permission?: ChildPermissionPolicy
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
  readonly permission?: ChildPermissionPolicy
  readonly outcome?: ChildRunOutcome
  readonly reportedAt?: number
  readonly timeCreated: number
  readonly timeEnded?: number
  /** The child session's title and agent, on the reads that join the session (`listByParent`). */
  readonly title?: string
  readonly agent?: string
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
   *
   * `report` is what a detached run tells its parent; it is written with the
   * ending and delivered by the result ledger. A foreground run's ending
   * counts as reported at once and ignores it.
   */
  readonly settle: (outcome: ChildRunOutcome, report?: ChildRunReport) => Effect.Effect<boolean>
  /**
   * Makes the run detached: its result is delivered to the parent by the
   * result ledger instead of returning to a tool call. One-way and idempotent;
   * `ChildRuns.detach`. Call it before anything that can settle the run for
   * the background (the settlement watcher), so the ending cannot be marked
   * reported by the foreground rule.
   */
  readonly detach: Effect.Effect<boolean>
  /**
   * True once the child's own loop skipped its main-agent `Stop` for this run
   * because the run is a foreground task's and its tool call delivers
   * `SubagentStop` instead (`ChildRegistry.delegateStop`). It stays readable
   * after the run is detached or ended: a task promoted to the background
   * after that exit can still deliver the stop event.
   */
  readonly stopDelegated: Effect.Effect<boolean>
  /** Resolves with the outcome that won, whoever settled or cancelled the run. */
  readonly settled: Effect.Effect<ChildRunOutcome>
  /** Resolves when the run is cancelled; never resolves for any other ending. */
  readonly cancelled: Effect.Effect<ChildCancelBy>
}

/** The session is not a child session this parent started with the requested owner (kind and, for DAG nodes, owner ref). */
export class NotOwner extends Schema.TaggedError<NotOwner>()("ChildRunNotOwner", {
  childSessionID: Schema.String,
}) {
  override get message() {
    return `Session ${this.childSessionID} was not started by this conversation with the requested owner`
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

/** What a driver may set on a prompt it sends to a child session. That it is a delegation is not its to choose. */
export interface ChildPromptOptions {
  /** A follow-up inside the same input keeps the tool budget the input already has. */
  readonly continueToolBudget?: boolean
}

/** Child-run operations a tool sees for one parent session; the parent is fixed and cannot be named by the caller. */
export interface ChildRunsScoped {
  readonly parentSessionID: SessionID
  /**
   * Prompts a child session of this parent and resolves with the last message
   * of the turn it ran. The prompt is admitted as the delegation it is, under
   * the credential of the session's active run: the run the driver registered
   * with `start` / `adopt`, or the one it appended input to. A session without
   * an active run of this parent is prompted without a credential for now
   * (PR5 refuses it).
   */
  readonly prompt: (input: PromptInput, options?: ChildPromptOptions) => Effect.Effect<SessionV1.WithParts>
  /**
   * Cancels the turn a child session of this parent is running. The run is not
   * touched: it ends with its driver, or through `cancel`.
   */
  readonly interrupt: (childSessionID: SessionID) => Effect.Effect<void>
  /** The parts a task prompt template expands to (file references and the like). */
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
  /** Registers the first run of a child session the parent just created. */
  readonly start: (spec: Omit<ChildRunSpec, "parentSessionID">) => Effect.Effect<ChildRunHandle>
  /**
   * Registers a new run on an existing child session after verifying that this
   * parent started it with the same owner (task: owner kind; DAG node: owner
   * kind and `workflowID/nodeID`). Anything else fails with `NotOwner` and
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
  /**
   * The runs of one parent, newest first, with the title and agent of their
   * child sessions. `limit` bounds how many are read (the newest ones); without
   * it every run is.
   */
  readonly listByParent: (
    parentSessionID: SessionID,
    options?: { readonly limit?: number; readonly ownerKind?: ChildOwnerKind },
  ) => Effect.Effect<ReadonlyArray<ChildRunView>>
  /** `ChildRunsScoped.prompt` for a named parent. */
  readonly prompt: (
    parentSessionID: SessionID,
    input: PromptInput,
    options?: ChildPromptOptions,
  ) => Effect.Effect<SessionV1.WithParts>
  /** `ChildRunsScoped.interrupt` for a named parent. */
  readonly interrupt: (parentSessionID: SessionID, childSessionID: SessionID) => Effect.Effect<void>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
  /**
   * Signal-and-return cancellation: the run ends `cancelled` synchronously
   * (compare-and-swap, credential revoked, row written), then the child
   * session's turn is cancelled in the background under a five second bound.
   * The child session stays reserved (`adopt` waits) until the run's driver
   * settles, five seconds at the latest, so a new run cannot start while the
   * old job still carries the session.
   */
  readonly cancel: (runID: string, by: ChildCancelBy) => Effect.Effect<ChildRunCancelResult>
  /**
   * Cancels the active run of a child session, whichever parent started it.
   * Engine-side cancellation points (the DAG loop, its deadline watcher) know
   * the child session but not the run id. `not_active` when this process has
   * no active run for the session (a later process's row, a finished run); the
   * caller then cancels the session turn itself.
   */
  readonly cancelActive: (childSessionID: SessionID, by: ChildCancelBy) => Effect.Effect<ChildRunCancelResult>
  /**
   * Makes a run detached (`child_run.detached = 1`): from here its result goes
   * to the parent through the result ledger. One-way and idempotent: true only
   * for the call that changed the run, false for a run that is already
   * detached or unknown. A run that already ended keeps the report state its
   * ending wrote.
   */
  readonly detach: (runID: string) => Effect.Effect<boolean>
  /** Ends rows a dead or earlier-life process left active (`interrupted`). */
  readonly recover: () => Effect.Effect<void>
  /** Ends this process's runs of a deleted session, as child or as parent. In memory plus row writes only. */
  readonly forget: (sessionID: SessionID) => Effect.Effect<void>
  readonly forParent: (parentSessionID: SessionID) => ChildRunsScoped
}
