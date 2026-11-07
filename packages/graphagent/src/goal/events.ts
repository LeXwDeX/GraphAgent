export * as GoalEvent from "./events"

// Re-export schema-level events — the single source of truth for event types.
// The TUI subscribes to these via the standard SSE event stream.
export { SessionGoal as GoalSchema } from "@opencode-ai/schema/session-goal"
import { SessionGoal } from "@opencode-ai/schema/session-goal"

export const Updated = SessionGoal.Event.Updated
export const Cleared = SessionGoal.Event.Cleared
