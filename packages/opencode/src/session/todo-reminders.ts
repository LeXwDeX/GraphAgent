// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pre-tool-call todo reminder (issue #429, narrowed by #930).
 *
 * Before a non-todowrite tool call executes, the current uncompleted list is
 * returned once per assistant turn so long multi-tool turns re-see it
 * mid-flight. Turn-scoped dedup keeps parallel tool calls from repeating the
 * same reminder N times.
 *
 * #930 removed the per-step synthetic part that used to re-inject the whole
 * list on every model step: it duplicated the tool's own description, churned
 * the prompt prefix each step, and cost tokens on turns that never touched the
 * list. The pre-tool seam remains because it lands at the tail of the request
 * only when the model is about to act.
 */
import { Cause, Effect } from "effect"
import type { SessionID } from "./schema"
import { Todo } from "./todo"

const TODO_WRITE_TOOL = "todowrite"

// sessionID -> assistant messageID that already received the pre-tool-call
// reminder this turn. One entry per live session, overwritten each turn.
const remindedTurns = new Map<string, string>()

function uncompletedOf(todos: Todo.Info[]): Todo.Info[] {
  return todos.filter((item) => item.status !== "completed" && item.status !== "cancelled")
}

function renderReminder(uncompleted: Todo.Info[]): string {
  const lines = uncompleted.map((todo) => `- ${todo.status}: ${todo.content}`)
  return [
    `[todo reminder] ${uncompleted.length} uncompleted todo item${uncompleted.length === 1 ? "" : "s"}:`,
    ...lines,
    "Keep the list current: mark items completed when done, adjust stale entries, and set in_progress only for the item you are actively working on. Update via todowrite.",
  ].join("\n")
}

/**
 * Reminder string for the pre-tool-call seam, or undefined when the call must
 * stay clean: todowrite itself, a turn already surfaced this turn, or nothing
 * uncompleted. Marks the turn only when a string is actually returned.
 */
export const preToolCall = Effect.fn("TodoReminders.preToolCall")(function* (input: {
  sessionID: SessionID
  messageID: string
  tool: string
}) {
  if (input.tool === TODO_WRITE_TOOL) return undefined
  if (remindedTurns.get(input.sessionID) === input.messageID) return undefined
  // The reminder is decoration on top of tool execution: a missing or failing
  // Todo service must degrade to "no reminder", never kill the tool call.
  const uncompleted = yield* Effect.gen(function* () {
    const todo = yield* Todo.Service
    const todos = yield* todo.get(input.sessionID)
    return uncompletedOf(todos)
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed([] as Todo.Info[]),
    ),
  )
  if (uncompleted.length === 0) return undefined
  remindedTurns.set(input.sessionID, input.messageID)
  return renderReminder(uncompleted)
})

export * as TodoReminders from "./todo-reminders"
