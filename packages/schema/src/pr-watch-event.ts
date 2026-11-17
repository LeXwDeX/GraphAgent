// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as PrWatchEvent from "./pr-watch-event"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { NonNegativeInt } from "./schema"
import { SessionID } from "./session-id"

/**
 * Live PR/MR watch progress (#1036). Transient: the durable truth is the
 * `pr_watch` row (#1071) and its `lifecycle.transitioned` edges; this event
 * only adds what a status line needs between edges (check counts, the
 * sanitized review state, the delivery record). Consumers must tolerate
 * missed events and re-read `GET /session/:sessionID/pr-watch` on reconnect.
 */

/** The `pr_watch` lifecycle values (`packages/core/src/lifecycle/vocabulary.ts`). */
export const Phase = Schema.Literals([
  "watching",
  "delivering",
  "succeeded",
  "failed",
  "expired",
  "cancelled",
]).annotate({ identifier: "PrWatchPhase" })
export type Phase = typeof Phase.Type

/** The forge classification a watch observed; `deadline` is the watch's own deadline. */
export const Outcome = Schema.Literals(["success", "failure", "merged", "closed", "review", "deadline"]).annotate({
  identifier: "PrWatchOutcome",
})
export type Outcome = typeof Outcome.Type

export const Checks = Schema.Struct({
  total: NonNegativeInt,
  pending: NonNegativeInt,
  failed: NonNegativeInt,
  passed: NonNegativeInt,
}).annotate({ identifier: "PrWatchChecks" })
export type Checks = typeof Checks.Type

/**
 * The notice's delivery. `pending`: the outcome is recorded and owed to the
 * session (it waits for an idle boundary and is retried until it commits).
 * `delivered`: the admission committed the notice message; `deliveredAt` and
 * `noticeMessageID` name that message, and `noReply` marks an admission that
 * committed the message without starting a turn.
 */
export const Delivery = Schema.Struct({
  state: Schema.Literals(["pending", "delivered"]),
  deliveredAt: Schema.optional(Schema.Finite),
  noticeMessageID: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "PrWatchDelivery" })
export type Delivery = typeof Delivery.Type

export const fields = {
  /** The session that registered the watch (`watch_pr` is root-only). */
  sessionID: SessionID,
  watchID: Schema.String,
  url: Schema.String,
  provider: Schema.Literals(["github", "gitlab"]),
  number: NonNegativeInt,
  phase: Phase,
  outcome: Schema.optional(Outcome),
  /** Absent until this process read the forge for the watch (or after a restart). */
  checks: Schema.optional(Checks),
  head: Schema.optional(Schema.String),
  /** Sanitized to `[A-Za-z0-9_.-]`, at most 40 characters. */
  review: Schema.optional(Schema.String),
  startedAt: Schema.Finite,
  updatedAt: Schema.Finite,
  deadlineAt: Schema.Finite,
  delivery: Schema.optional(Delivery),
}

/** One watch as the event carries it and the read endpoint lists it. */
export const Entry = Schema.Struct(fields).annotate({ identifier: "PrWatchEntry" })
export type Entry = typeof Entry.Type

export const Updated = define({
  type: "pr.watch.updated",
  schema: fields,
})

export const Definitions = inventory(Updated)
