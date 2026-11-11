// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Domain, Phase } from "@graphagent/schema/lifecycle-status"

/**
 * Read-only lifecycle vocabulary (#1069 P1).
 *
 * Maps each domain's existing status literals onto the shared phase/terminal/
 * settled model. This is a projection, not a second state machine: the values
 * are the persisted or in-memory literals each owner already uses (DAG values
 * come from `@graphagent/schema/dag-status`), and transition rules stay with
 * their owner (`packages/core/src/dag/core/types.ts` for DAG).
 *
 * `settled` means "terminal and successfully quiet, the owner needs no further
 * wake-up" — not merely "terminal". A failed or cancelled value is terminal
 * but not settled.
 *
 * Pure data: no Effect, drizzle, node builtins, or `@/` imports.
 */

export type Authority = "live" | "durable" | "mixed"

export interface OutcomeVocabulary {
  readonly phase: Phase
  readonly settled: boolean
}

export interface DomainVocabulary {
  readonly values: readonly string[]
  readonly phases: Readonly<Record<string, Phase>>
  readonly terminal: readonly string[]
  readonly settled: readonly string[]
  readonly authority: Authority
  /** Turn only: the turn row's `ended` value has no single phase; its outcome decides. */
  readonly outcomes?: Readonly<Record<string, OutcomeVocabulary>>
}

const TABLE = {
  session: {
    values: ["idle", "retry", "busy"],
    phases: { idle: "waiting", retry: "running", busy: "running" },
    terminal: [],
    settled: [],
    authority: "live",
  },
  job: {
    values: ["running", "completed", "error", "cancelled"],
    phases: { running: "running", completed: "succeeded", error: "failed", cancelled: "cancelled" },
    terminal: ["completed", "error", "cancelled"],
    settled: ["completed"],
    authority: "live",
  },
  goal: {
    values: ["active", "waiting", "paused", "done"],
    phases: { active: "running", waiting: "waiting", paused: "paused", done: "succeeded" },
    terminal: ["done"],
    settled: ["done"],
    authority: "durable",
  },
  workflow: {
    values: ["pending", "running", "paused", "stepping", "completed", "failed", "cancelled"],
    phases: {
      pending: "pending",
      running: "running",
      stepping: "running",
      paused: "paused",
      completed: "succeeded",
      failed: "failed",
      cancelled: "cancelled",
    },
    terminal: ["completed", "failed", "cancelled"],
    settled: ["completed"],
    authority: "durable",
  },
  node: {
    values: ["pending", "queued", "running", "completed", "failed", "aborted", "skipped"],
    phases: {
      pending: "pending",
      queued: "pending",
      running: "running",
      completed: "succeeded",
      failed: "failed",
      aborted: "cancelled",
      skipped: "skipped",
    },
    terminal: ["completed", "failed", "aborted", "skipped"],
    settled: ["completed", "skipped"],
    authority: "durable",
  },
  mailbox: {
    values: ["queued", "delivered", "undeliverable"],
    phases: { queued: "pending", delivered: "succeeded", undeliverable: "failed" },
    terminal: ["delivered", "undeliverable"],
    settled: ["delivered"],
    authority: "durable",
  },
  inbox: {
    values: ["pending", "started", "joined", "written", "skipped_busy", "duplicate"],
    phases: {
      pending: "pending",
      started: "running",
      joined: "running",
      written: "succeeded",
      skipped_busy: "skipped",
      duplicate: "skipped",
    },
    terminal: ["written", "skipped_busy", "duplicate"],
    settled: ["written", "skipped_busy", "duplicate"],
    authority: "live",
  },
  hook: {
    values: ["pending", "started", "finished", "cancelled", "timeout"],
    phases: {
      pending: "pending",
      started: "running",
      finished: "succeeded",
      cancelled: "cancelled",
      timeout: "failed",
    },
    terminal: ["finished", "cancelled", "timeout"],
    settled: ["finished"],
    authority: "mixed",
  },
  tool: {
    values: ["pending", "running", "completed", "error"],
    phases: { pending: "pending", running: "running", completed: "succeeded", error: "failed" },
    terminal: ["completed", "error"],
    settled: ["completed"],
    authority: "durable",
  },
  turn: {
    values: ["running", "ended"],
    phases: { running: "running" },
    terminal: ["ended"],
    settled: [],
    authority: "durable",
    outcomes: {
      completed: { phase: "succeeded", settled: true },
      length: { phase: "failed", settled: false },
      tool_budget_exhausted: { phase: "failed", settled: false },
      structured_missing: { phase: "failed", settled: false },
      content_filter: { phase: "failed", settled: false },
      error: { phase: "failed", settled: false },
      cancelled: { phase: "cancelled", settled: false },
      context_overflow: { phase: "failed", settled: false },
      blocked: { phase: "skipped", settled: false },
      interrupted: { phase: "cancelled", settled: false },
    },
  },
  cancellation: {
    values: ["requested", "completed"],
    phases: { requested: "settling", completed: "cancelled" },
    terminal: ["completed"],
    settled: ["completed"],
    authority: "live",
  },
} as const satisfies { readonly [D in Domain]: DomainVocabulary }

/** Literal-preserving view (the `satisfies` above keeps value unions narrow). */
export const VOCABULARY = TABLE

const WIDE: { readonly [D in Domain]: DomainVocabulary } = TABLE

export function phaseOf(domain: Domain, value: string): Phase | undefined {
  return WIDE[domain].phases[value]
}

export function valuesOf(domain: Domain): readonly string[] {
  return WIDE[domain].values
}

export function isTerminalValue(domain: Domain, value: string): boolean {
  return WIDE[domain].terminal.includes(value)
}

export function isSettledValue(domain: Domain, value: string): boolean {
  return WIDE[domain].settled.includes(value)
}

export function authorityOf(domain: Domain): Authority {
  return WIDE[domain].authority
}

export function turnOutcomePhase(outcome: string): Phase | undefined {
  return WIDE.turn.outcomes?.[outcome]?.phase
}

export function isSettledOutcome(outcome: string): boolean {
  return WIDE.turn.outcomes?.[outcome]?.settled === true
}
