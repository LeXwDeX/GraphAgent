export * as SessionGoal from "./session-goal"

import { Effect, Schema } from "effect"
import { define, inventory } from "./event"
import { SessionID } from "./session-id"

export const GoalStatus = Schema.Literals(["active", "waiting", "paused", "done"])

export const Info = Schema.Struct({
  goal: Schema.String.annotate({ description: "The autonomous goal text" }),
  status: GoalStatus.annotate({ description: "Current status: active, waiting, paused, done" }),
  turnsUsed: Schema.Number.annotate({ description: "Turns used so far" }),
  maxTurns: Schema.Number.annotate({ description: "Maximum turns allowed" }),
  subgoals: Schema.Array(Schema.String)
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed([] as ReadonlyArray<string>)))
    .annotate({ description: "Sub-goals attached to this goal (empty array when none)" }),
  pausedReason: Schema.optional(Schema.String).annotate({
    description: "Reason the goal was paused (only set when status === 'paused')",
  }),
}).annotate({ identifier: "Goal" })
export type Info = typeof Info.Type
export const SessionGoalInfo = Info

const Updated = define({
  type: "goal.updated",
  schema: {
    sessionID: SessionID,
    goal: Info,
  },
})

const Cleared = define({
  type: "goal.cleared",
  schema: {
    sessionID: SessionID,
  },
})

export const Event = { Updated, Cleared, Definitions: inventory(Updated, Cleared) }
