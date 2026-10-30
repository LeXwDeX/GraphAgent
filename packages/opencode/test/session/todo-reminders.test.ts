// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * #429 — pre-tool-call todo reminder; #930 removed the per-step injection, so
 * only the pre-tool seam remains.
 *
 * Before a non-todowrite tool call executes, the current uncompleted list is
 * surfaced once per assistant turn. Completed and cancelled items count as
 * settled and never appear.
 */
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionID } from "@/session/schema"
import { Todo } from "@/session/todo"
import { TodoReminders } from "@/session/todo-reminders"
import { testEffect } from "../lib/effect"

const runtime = testEffect(Layer.empty)

function makeTodoLayer(todos: Todo.Info[]) {
  return Layer.mock(Todo.Service, {
    get: () => Effect.succeed(todos),
  })
}

describe("TodoReminders.preToolCall (#429)", () => {
  const sessionID = SessionID.make("ses_1")
  const todos: Todo.Info[] = [
    { content: "ship feature", status: "in_progress", priority: "high" },
    { content: "done already", status: "completed", priority: "low" },
  ]

  runtime.effect("returns the reminder before a non-todowrite tool call", () =>
    Effect.gen(function* () {
      const reminder = yield* TodoReminders.preToolCall({
        sessionID,
        messageID: "msg_pre_1",
        tool: "bash",
      }).pipe(Effect.provide(makeTodoLayer(todos)))
      expect(reminder).toContain("[todo reminder]")
      expect(reminder).toContain("ship feature")
      expect(reminder).toContain("todowrite")
    }),
  )

  runtime.effect("injects at most once per assistant turn", () =>
    Effect.gen(function* () {
      const layer = makeTodoLayer(todos)
      const first = yield* TodoReminders.preToolCall({ sessionID, messageID: "msg_pre_2", tool: "bash" }).pipe(
        Effect.provide(layer),
      )
      const second = yield* TodoReminders.preToolCall({ sessionID, messageID: "msg_pre_2", tool: "read" }).pipe(
        Effect.provide(layer),
      )
      expect(first).toBeDefined()
      expect(second).toBeUndefined()
    }),
  )

  runtime.effect("re-arms on a new assistant turn", () =>
    Effect.gen(function* () {
      const layer = makeTodoLayer(todos)
      yield* TodoReminders.preToolCall({ sessionID, messageID: "msg_pre_3", tool: "bash" }).pipe(
        Effect.provide(layer),
      )
      const next = yield* TodoReminders.preToolCall({ sessionID, messageID: "msg_pre_4", tool: "read" }).pipe(
        Effect.provide(layer),
      )
      expect(next).toBeDefined()
    }),
  )

  runtime.effect("never surfaces for todowrite and leaves the turn unmarked", () =>
    Effect.gen(function* () {
      const layer = makeTodoLayer(todos)
      const write = yield* TodoReminders.preToolCall({ sessionID, messageID: "msg_pre_5", tool: "todowrite" }).pipe(
        Effect.provide(layer),
      )
      expect(write).toBeUndefined()
      // todowrite must not consume the turn's single shot either.
      const other = yield* TodoReminders.preToolCall({ sessionID, messageID: "msg_pre_5", tool: "grep" }).pipe(
        Effect.provide(layer),
      )
      expect(other).toBeDefined()
    }),
  )

  runtime.effect("returns undefined when nothing is uncompleted", () =>
    Effect.gen(function* () {
      const settled: Todo.Info[] = [{ content: "a", status: "completed", priority: "low" }]
      const none = yield* TodoReminders.preToolCall({
        sessionID,
        messageID: "msg_pre_6",
        tool: "bash",
      }).pipe(Effect.provide(makeTodoLayer(settled)))
      expect(none).toBeUndefined()
    }),
  )
})
