// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The message the loop sends at the start of every round it dispatches (#1329, L7).
 *
 * Three segments, so the constraints never depend on the analysis remembering them:
 *
 * 1. a header the runtime writes: which round of how many, the rules of an automatic turn, and how to
 *    declare `await`, `done` or `blocked` with the `loop` tool;
 * 2. the analysis's `next_prompt`, the part that changes every round;
 * 3. a tail the runtime appends: the final objective, the constraints and the non-goals, verbatim from the
 *    latest intent. Before the first analysis exists (a wake or recovery of round 1) the user's own words
 *    stand in for the objective.
 *
 * A note, when the round has a reason beyond "continue" (a wake notice, why a wait ended, the failure being
 * recovered), sits between the header and the prompt. Pure: no state, no I/O.
 */
import type { LoopIntent } from "@graphagent/schema/loop"
import type { LoopHost } from "./host"

/**
 * The first characters of every loop-dispatched message. The marker metadata is the durable provenance; this
 * prefix lets the text-based automation check recognise the message without it, the way it recognises a
 * goal continuation.
 */
export const PREFIX = "[Loop round "

const LABELS: Record<LoopHost.Kind, string> = {
  next: "continuing",
  wake: "woken by an event",
  review: "wait review",
  recovery: "resuming after a failure",
}

export interface Input {
  readonly kind: LoopHost.Kind
  readonly round: number
  readonly maxRounds: number
  /** The analysis's `next_prompt`. Absent when the round is a wake, a review or a recovery without one. */
  readonly prompt?: string
  /** Why this round runs, when `kind` needs saying. */
  readonly note?: string
  /** The user's own words, the objective until an intent exists. */
  readonly origin: string
  readonly intent?: LoopIntent
}

function header(input: Input) {
  return [
    `${PREFIX}${input.round}/${input.maxRounds}: ${LABELS[input.kind]}]`,
    "The loop that works toward the user's goal started this turn automatically. No new message from the user is waiting.",
    "Rules for an automatic turn:",
    "- Interactive questions are disabled and will not be answered. Do not ask the user for clarification or confirmation; decide with your best judgment.",
    "- Do what this round asks, then stop. Say what you did and what you verified.",
    "Declare how the round ended with the `loop` tool when one of these applies; otherwise just finish and the loop prepares the next round:",
    "- `await`: you wait for a background task or a PR watch you already started. Name it.",
    "- `done`: the final goal is met. Give the evidence.",
    "- `blocked`: only the user can unblock the work. Say what is missing.",
  ].join("\n")
}

function list(title: string, items: ReadonlyArray<string>) {
  return items.length === 0 ? [] : [`${title}:`, ...items.map((item) => `- ${item}`)]
}

function tail(input: Input) {
  const { intent } = input
  return [
    "## Final goal (fixed; every round answers to it)",
    `Objective: ${intent?.objective ?? input.origin}`,
    ...list("Constraints", intent?.constraints ?? []),
    ...list("Out of scope", intent?.non_goals ?? []),
  ].join("\n")
}

/** The message of one round, segments in order and empty ones left out. */
export function render(input: Input): string {
  return [
    header(input),
    ...(input.note !== undefined && input.note !== "" ? [`## Why this round started\n${input.note}`] : []),
    ...(input.prompt !== undefined && input.prompt !== "" ? [`## This round\n${input.prompt}`] : []),
    tail(input),
  ].join("\n\n")
}

export const REVIEW_NOTE =
  "The wait ended without the event you waited for. Do one bounded check of the external state (for example the " +
  "status of the PR or MR, or of the background task) instead of waiting again, then continue the work or declare " +
  "`await`, `done` or `blocked`. If nothing has progressed, the loop stops."

export const RECOVERY_NOTE =
  "The previous attempt of this round ended on an interface failure. Pick up where it stopped; do not start over."

export * as LoopMessage from "./message"
