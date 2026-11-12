// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Domain, Phase } from "@graphagent/schema/lifecycle-status"
import type { StateRef } from "./state"
import { phaseOf, valuesOf } from "./vocabulary"

/**
 * Cross-domain transition contract (#1069 P1).
 *
 * A table names the values a call MAY move to from the asserted current value.
 * `checkTransition` only validates the shape and ordering of one request; it
 * reads no state and performs no compare-and-swap. Owners keep their own
 * authoritative transition rules: the DAG state machine in
 * `packages/core/src/dag/core/types.ts` stays untouched and is reusable as a
 * table through a thin adapter.
 */

export interface TransitionTable {
  readonly domain: Domain
  /** `null` means creation; an empty array means the value is terminal. */
  readonly next: (from: string | null) => readonly string[]
}

export interface TransitionRequest {
  readonly ref: StateRef
  /** The caller's asserted current value; `null` means creation. Not a read and not a CAS. */
  readonly expect: string | null
  readonly to: string
  readonly phase?: Phase
  readonly reason?: string
  readonly sessionID?: string
}

export type TransitionCheck =
  | { readonly kind: "allowed"; readonly phase: Phase }
  | { readonly kind: "duplicate" }
  | { readonly kind: "unknown-from"; readonly value: string }
  | { readonly kind: "unknown-to"; readonly value: string }
  | { readonly kind: "invalid"; readonly allowed: readonly string[] }

/**
 * Decision order is fixed: unknown current value, duplicate, disallowed target,
 * unresolvable phase, then allowed. `unknown-to` covers a target whose phase
 * the vocabulary cannot derive and the caller did not state (for example
 * `turn` + `ended`, whose phase comes from the turn outcome).
 */
export function checkTransition(
  table: TransitionTable,
  request: Pick<TransitionRequest, "expect" | "to" | "phase">,
): TransitionCheck {
  if (request.expect !== null && !valuesOf(table.domain).includes(request.expect)) {
    return { kind: "unknown-from", value: request.expect }
  }
  if (request.expect === request.to) return { kind: "duplicate" }
  const allowed = table.next(request.expect)
  if (!allowed.includes(request.to)) return { kind: "invalid", allowed }
  const phase = request.phase ?? phaseOf(table.domain, request.to)
  if (phase === undefined) return { kind: "unknown-to", value: request.to }
  return { kind: "allowed", phase }
}

export const TURN_TRANSITION_TABLE: TransitionTable = {
  domain: "turn",
  next: (from) => (from === null ? ["running"] : from === "running" ? ["ended"] : []),
}

/**
 * Goals are durable and may be overwritten by a new `/goal set`, so every live
 * value (including `paused`) can move back to `active` (#1069). `done` is not
 * a live row value: completion deletes the row and keeps the terminal snapshot
 * in `goal_outcome`, reporting removal through `goal.cleared`. The table still
 * renders `done` as terminal if a transition is ever published for it.
 */
export const GOAL_TRANSITION_TABLE: TransitionTable = {
  domain: "goal",
  next: (from) =>
    from === null
      ? ["active"]
      : from === "active"
        ? ["waiting", "paused"]
        : from === "waiting"
          ? ["active", "paused"]
          : from === "paused"
            ? ["active"]
            : [],
}

/**
 * Background jobs keep their owner-specific rule: a job may finish without
 * settling (short work with no delivered side effect), and `settling` only
 * admits terminal states (#1069 P4).
 */
export const JOB_TRANSITION_TABLE: TransitionTable = {
  domain: "job",
  next: (from) =>
    from === null
      ? ["running"]
      : from === "running"
        ? ["settling", "completed", "error", "cancelled"]
        : from === "settling"
          ? ["completed", "error", "cancelled"]
          : [],
}
