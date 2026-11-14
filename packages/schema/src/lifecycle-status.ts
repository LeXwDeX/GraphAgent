// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-domain lifecycle wire vocabulary (#1069 P1).
 *
 * Pure: zero imports. `domain` and `phase` are the only enums that travel on
 * the wire; each domain's concrete status literals stay internal to
 * `@graphagent/core/lifecycle/vocabulary` and events carry them as strings.
 */

export const DOMAINS = [
  "session",
  "job",
  "goal",
  "workflow",
  "node",
  "mailbox",
  "inbox",
  "hook",
  "tool",
  "turn",
  "cancellation",
  "pr_watch",
] as const

export type Domain = (typeof DOMAINS)[number]

export const PHASES = [
  "pending",
  "running",
  "waiting",
  "settling",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
  "paused",
] as const

export type Phase = (typeof PHASES)[number]
