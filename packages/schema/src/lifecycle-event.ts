// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as LifecycleEvent from "./lifecycle-event"

import { Schema } from "effect"
import { Event } from "./event"
import { DOMAINS, PHASES } from "./lifecycle-status"
import { DateTimeUtcFromMillis, NonNegativeInt } from "./schema"
import { SessionID } from "./session-id"

/**
 * Cross-domain lifecycle events (#1069 P2). Both are transient: the durable
 * truth for a domain stays with its owning `*.event` inventory (DAG lifecycle
 * in `dag.*`, sessions in `session.next.*`), and these only feed live clients.
 */

/** Mirrors `TurnOutcome` from the session loop decision layer. */
export const TurnOutcome = Schema.Union([
  Schema.Struct({ type: Schema.Literal("completed") }),
  Schema.Struct({ type: Schema.Literal("length") }),
  Schema.Struct({ type: Schema.Literal("tool_budget_exhausted") }),
  Schema.Struct({ type: Schema.Literal("structured_missing") }),
  Schema.Struct({ type: Schema.Literal("content_filter") }),
  Schema.Struct({ type: Schema.Literal("error"), code: Schema.String, retryable: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("cancelled"), reason: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("context_overflow") }),
  Schema.Struct({ type: Schema.Literal("blocked"), by: Schema.String, code: Schema.String }),
  Schema.Struct({ type: Schema.Literal("interrupted") }),
])
export type TurnOutcome = Schema.Schema.Type<typeof TurnOutcome>

export const Transitioned = Event.define({
  type: "lifecycle.transitioned",
  schema: {
    domain: Schema.Literals(DOMAINS),
    stateID: Schema.String,
    sessionID: Schema.optional(SessionID),
    from: Schema.optional(Schema.String),
    to: Schema.String,
    phase: Schema.Literals(PHASES),
    reason: Schema.optional(Schema.String),
    timestamp: DateTimeUtcFromMillis,
  },
})

export const TurnSettled = Event.define({
  type: "session.turn.settled",
  schema: {
    sessionID: SessionID,
    turnID: Schema.String,
    outcome: TurnOutcome,
    steps: NonNegativeInt,
    timeEnded: DateTimeUtcFromMillis,
  },
})

export const Definitions = Event.inventory(Transitioned, TurnSettled)
