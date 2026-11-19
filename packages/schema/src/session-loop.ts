// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as SessionLoop from "./session-loop"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { LoopVerdict } from "./loop"
import { NonNegativeInt } from "./schema"
import { SessionID } from "./session-id"
import type { StopRecord as StopRecordType } from "./stop-reason"

/**
 * Loop state on the wire (#1329), and the two events that carry it.
 *
 * The first three states are alive and live in `loop_state`; `completed` and
 * `cancelled` are terminal: a terminal snapshot goes to `loop_outcome` and the
 * live row is deleted. The terminal state still travels once as `loop.updated`,
 * followed by `loop.cleared`, which repeats the terminal state and the stop
 * record so a client can show the last reason after the row is gone.
 */
export const Status = Schema.Literals(["active", "waiting", "stopped", "completed", "cancelled"]).annotate({
  identifier: "LoopStatus",
})
export type Status = typeof Status.Type

export const TerminalStatus = Schema.Literals(["completed", "cancelled"]).annotate({
  identifier: "LoopTerminalStatus",
})
export type TerminalStatus = typeof TerminalStatus.Type

/** What a waiting loop waits on. */
export const WaitSource = Schema.Literals(["background_job", "watch_pr", "hook", "timer", "dag"]).annotate({
  identifier: "LoopWaitSource",
})
export type WaitSource = typeof WaitSource.Type

const at = Schema.Finite.annotate({ description: "Epoch milliseconds when the loop stopped" })

const UserStoppedDetail = Schema.Union([
  Schema.Struct({ basis_message_id: Schema.String }),
  Schema.Struct({ code: Schema.Literal("migrated"), message: Schema.String }),
])

const GoalChangedDetail = Schema.Union([
  Schema.Struct({ code: Schema.Literal("explicit") }),
  Schema.Struct({ code: Schema.Literal("inferred"), basis_message_id: Schema.String }),
])

const NeedsUserDetail = Schema.Struct({ code: Schema.Literals(["open_question", "rejected"]) })

const ProviderUnavailableDetail = Schema.Struct({
  code: Schema.String,
  status: Schema.optional(Schema.Finite),
  message: Schema.String,
})

const HookStoppedDetail = Schema.Struct({ message: Schema.String })

const AnalysisFailedDetail = Schema.Struct({ code: Schema.Literals(["invalid_output", "limit"]) })

const InternalErrorDetail = Schema.Struct({ code: Schema.String, message: Schema.String })

/**
 * Why automatic advancement stopped, as persisted and published: the schema of
 * `StopRecord` (`stop-reason.ts`, #1327), one member per reason. The assertion
 * below keeps the two in step: a reason or detail added to one and not the other
 * fails the typecheck.
 */
export const StopRecord = Schema.Union([
  Schema.Struct({ reason: Schema.Literal("completed"), at }),
  Schema.Struct({ reason: Schema.Literal("user_stopped"), detail: Schema.optional(UserStoppedDetail), at }),
  Schema.Struct({ reason: Schema.Literal("user_interrupted"), at }),
  Schema.Struct({ reason: Schema.Literal("goal_changed"), detail: GoalChangedDetail, at }),
  Schema.Struct({ reason: Schema.Literal("needs_user"), detail: NeedsUserDetail, at }),
  Schema.Struct({ reason: Schema.Literal("provider_unavailable"), detail: ProviderUnavailableDetail, at }),
  Schema.Struct({ reason: Schema.Literal("context_exhausted"), at }),
  Schema.Struct({ reason: Schema.Literal("content_refused"), at }),
  Schema.Struct({ reason: Schema.Literal("hook_stopped"), detail: HookStoppedDetail, at }),
  Schema.Struct({ reason: Schema.Literal("session_archived"), at }),
  Schema.Struct({ reason: Schema.Literal("budget_exhausted"), at }),
  Schema.Struct({ reason: Schema.Literal("no_progress"), at }),
  Schema.Struct({ reason: Schema.Literal("wait_expired"), at }),
  Schema.Struct({ reason: Schema.Literal("analysis_failed"), detail: AnalysisFailedDetail, at }),
  Schema.Struct({ reason: Schema.Literal("internal_error"), detail: InternalErrorDetail, at }),
]).annotate({ identifier: "LoopStopRecord" })
export type StopRecord = typeof StopRecord.Type

type Mutually<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
export type StopRecordSchemaMatchesVocabulary = Assert<Mutually<StopRecord, StopRecordType>>

export const Info = Schema.Struct({
  loopID: Schema.String.annotate({ description: "Identity of this loop; a replacement loop gets a new one" }),
  status: Status.annotate({ description: "Current status: active, waiting, stopped, completed, cancelled" }),
  round: NonNegativeInt.annotate({ description: "Current round, counted from 1" }),
  maxRounds: NonNegativeInt.annotate({ description: "Round limit" }),
  prompt: Schema.String.annotate({ description: "The user's first description, verbatim; never changes" }),
  objective: Schema.optional(
    Schema.String.annotate({
      description: "The final goal as the background analysis understands it; absent before the first analysis",
    }),
  ),
  analyzing: Schema.Boolean.annotate({
    description: 'True while a background analysis is running; clients show "updating loop goal"',
  }),
  probeAt: Schema.optional(
    Schema.Finite.annotate({
      description:
        "Epoch milliseconds of the next self-healing probe. Set on a waiting loop that waits for a provider to recover, not for an external object",
    }),
  ),
  wait: Schema.optional(
    Schema.Struct({
      source: WaitSource,
      deadline: Schema.Finite.annotate({ description: "Epoch milliseconds when the wait expires" }),
    }).annotate({ description: "The external object a waiting loop waits for" }),
  ),
  intentRevision: NonNegativeInt.annotate({
    description: "0 before the first analysis, 1 once it is committed, plus one for every later intent change",
  }),
  lastVerdict: Schema.optional(LoopVerdict),
  lastReason: Schema.optional(Schema.String.annotate({ description: "Reason of the last committed analysis" })),
  stop: Schema.optional(
    StopRecord.annotate({ description: "Why the loop stopped; set on a stopped loop and on a terminal one" }),
  ),
}).annotate({ identifier: "Loop" })
export type Info = typeof Info.Type

const Updated = define({
  type: "loop.updated",
  schema: {
    sessionID: SessionID,
    loop: Info,
  },
})

const Cleared = define({
  type: "loop.cleared",
  schema: {
    sessionID: SessionID,
    status: Schema.optional(
      TerminalStatus.annotate({
        description: "The terminal state the loop ended in; absent when the session itself was removed",
      }),
    ),
    stop: Schema.optional(
      StopRecord.annotate({ description: "Why the loop ended; absent when the session itself was removed" }),
    ),
  },
})

export const Event = { Updated, Cleared, Definitions: inventory(Updated, Cleared) }
