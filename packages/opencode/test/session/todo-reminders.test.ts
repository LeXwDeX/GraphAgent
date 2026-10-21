// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- fixtures
// mirror dag-wake-integration.test.ts: message/part fixtures use `as never`
// shims implementing only the slice the scenario exercises. Type-only.
// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Issue #389 — per-step todo stale-state reminder.
 *
 * While a session holds uncompleted todos, every model step (including
 * tool-free steps) re-surfaces the current list as ONE synthetic part on the
 * last user message — model-visible, never persisted. Skip conditions:
 *   - no todos for the session
 *   - nothing uncompleted (completed and cancelled both count as settled)
 *   - freshness guard: the current turn's last assistant message already
 *     contains a successful todowrite call (the model just updated the list)
 */
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionID, PartID, MessageID } from "@/session/schema"
import { Todo } from "@/session/todo"
import { TodoReminders } from "@/session/todo-reminders"
import { testEffect } from "../lib/effect"

const runtime = testEffect(Layer.empty)

function makeTodoLayer(todos: Todo.Info[]) {
  return Layer.mock(Todo.Service, {
    get: () => Effect.succeed(todos),
  })
}

let clock = 0

function userMessage(text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "user",
      sessionID: SessionID.make("ses_1"),
      time: { created: clock++ },
      agent: "build",
      model: { providerID: "test" as never, modelID: "m" as never },
    },
    parts: [{
      id: PartID.ascending(),
      messageID: id,
      sessionID: SessionID.make("ses_1"),
      type: "text",
      text,
    }] as never,
  }
}

function assistantMessage(
  tools: { name: string; status: string }[] = [],
  text?: string,
): SessionV1.WithParts {
  const id = MessageID.ascending()
  const parts: Record<string, unknown>[] = tools.map((t) => ({
    id: PartID.ascending(),
    messageID: id,
    sessionID: SessionID.make("ses_1"),
    type: "tool",
    callID: `call-${clock++}`,
    tool: t.name,
    state: {
      status: t.status,
      input: {},
      ...(t.status === "completed" ? { output: "", title: "" } : t.status === "error" ? { error: "boom" } : {}),
    },
  }))
  if (text) {
    parts.push({
      id: PartID.ascending(),
      messageID: id,
      sessionID: SessionID.make("ses_1"),
      type: "text",
      text,
    })
  }
  return {
    info: {
      id,
      role: "assistant",
      sessionID: SessionID.make("ses_1"),
      parentID: MessageID.ascending(),
      time: { created: clock++ },
      mode: "build",
      agent: "build",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "m" as never,
      providerID: "test" as never,
      path: { cwd: "/tmp", root: "/tmp" },
      finish: "stop",
    },
    parts: parts as never,
  }
}

function lastUser(messages: SessionV1.WithParts[]) {
  return messages.findLast((m) => m.info.role === "user")
}

function reminderText(messages: SessionV1.WithParts[]) {
  const part = lastUser(messages)?.parts.at(-1)
  return part?.type === "text" ? part.text : undefined
}

describe("TodoReminders.apply (issue #389)", () => {
  runtime.effect("injects nothing when the session has no todos", () =>
    Effect.gen(function* () {
      const messages = [userMessage("work")]
      const result = yield* TodoReminders.apply({
        messages,
        sessionID: SessionID.make("ses_1"),
      }).pipe(Effect.provide(makeTodoLayer([])))
      expect(result).toBe(messages)
      expect(lastUser(result)?.parts).toHaveLength(1)
    }),
  )

  runtime.effect("injects nothing when every todo is settled (completed or cancelled)", () =>
    Effect.gen(function* () {
      const messages = [userMessage("work")]
      const result = yield* TodoReminders.apply({
        messages,
        sessionID: SessionID.make("ses_1"),
      }).pipe(
        Effect.provide(makeTodoLayer([
          { content: "a", status: "completed", priority: "high" },
          { content: "b", status: "cancelled", priority: "low" },
        ])),
      )
      expect(lastUser(result)?.parts).toHaveLength(1)
    }),
  )

  runtime.effect("injects exactly one synthetic reminder with uncompleted statuses", () =>
    Effect.gen(function* () {
      const messages = [userMessage("work")]
      const result = yield* TodoReminders.apply({
        messages,
        sessionID: SessionID.make("ses_1"),
      }).pipe(
        Effect.provide(makeTodoLayer([
          { content: "implement reminder module", status: "in_progress", priority: "high" },
          { content: "add tests", status: "pending", priority: "high" },
          { content: "shipped", status: "completed", priority: "low" },
        ])),
      )
      const last = lastUser(result)
      expect(last?.parts).toHaveLength(2)
      const reminder = last?.parts.at(-1) as never as { type: string; text: string; synthetic?: boolean }
      expect(reminder.type).toBe("text")
      expect(reminder.synthetic).toBe(true)
      expect(reminder.text).toContain("implement reminder module")
      expect(reminder.text).toContain("in_progress")
      expect(reminder.text).toContain("add tests")
      expect(reminder.text).toContain("pending")
      expect(reminder.text).not.toContain("shipped")
      expect(reminder.text).toContain("todowrite")
    }),
  )

  runtime.effect("freshness guard: skips when the turn's last assistant message contains a successful todowrite", () =>
    Effect.gen(function* () {
      const messages = [
        userMessage("work"),
        assistantMessage([{ name: "todowrite", status: "completed" }], "updated"),
      ]
      const result = yield* TodoReminders.apply({
        messages,
        sessionID: SessionID.make("ses_1"),
      }).pipe(
        Effect.provide(makeTodoLayer([
          { content: "a", status: "pending", priority: "high" },
        ])),
      )
      expect(lastUser(result)?.parts).toHaveLength(1)
    }),
  )

  runtime.effect("an older todowrite does not suppress the reminder once further steps followed", () =>
    Effect.gen(function* () {
      const messages = [
        userMessage("work"),
        assistantMessage([{ name: "todowrite", status: "completed" }]),
        assistantMessage([{ name: "read", status: "completed" }], "read the file"),
      ]
      const result = yield* TodoReminders.apply({
        messages,
        sessionID: SessionID.make("ses_1"),
      }).pipe(
        Effect.provide(makeTodoLayer([
          { content: "a", status: "pending", priority: "high" },
        ])),
      )
      expect(lastUser(result)?.parts).toHaveLength(2)
    }),
  )

  runtime.effect("a failed todowrite does not satisfy the freshness guard", () =>
    Effect.gen(function* () {
      const messages = [
        userMessage("work"),
        assistantMessage([{ name: "todowrite", status: "error" }]),
      ]
      const result = yield* TodoReminders.apply({
        messages,
        sessionID: SessionID.make("ses_1"),
      }).pipe(
        Effect.provide(makeTodoLayer([
          { content: "a", status: "pending", priority: "high" },
        ])),
      )
      expect(lastUser(result)?.parts).toHaveLength(2)
    }),
  )
})

// The run-loop structural guarantees called out by the PR #391 review (O3):
// apply runs once per model step BEFORE tool resolution — never once per
// tool — and its mutation lives only in that step's in-memory request.
describe("TodoReminders run-loop guarantees (issue #389 review)", () => {
  runtime.effect("parallel tools in one step still see exactly one reminder", () =>
    Effect.gen(function* () {
      // The rejected PreToolUse design would have injected once per tool
      // call; the run-loop seam injects once per step, so a fan-out of N
      // completed tools (none a fresh todowrite) yields ONE reminder.
      const messages = [
        userMessage("work"),
        assistantMessage([
          { name: "read", status: "completed" },
          { name: "grep", status: "completed" },
          { name: "bash", status: "completed" },
        ], "ran three tools"),
      ]
      const result = yield* TodoReminders.apply({
        messages,
        sessionID: SessionID.make("ses_1"),
      }).pipe(
        Effect.provide(makeTodoLayer([
          { content: "a", status: "pending", priority: "high" },
        ])),
      )
      const last = lastUser(result)
      expect(last?.parts).toHaveLength(2)
      expect(last?.parts.filter((part) => (part as never as { text?: string }).text?.startsWith("[todo reminder]"))).toHaveLength(1)
    }),
  )

  runtime.effect("consecutive steps with fresh per-step reads never accumulate reminders", () =>
    Effect.gen(function* () {
      // The run loop re-derives msgs from the database each step, so the
      // synthetic part never persists and never stacks across steps.
      const todoLayer = makeTodoLayer([{ content: "a", status: "pending", priority: "high" }])
      const durableBase = [userMessage("work")]

      const step1 = structuredClone(durableBase)
      const result1 = yield* TodoReminders.apply({ messages: step1, sessionID: SessionID.make("ses_1") }).pipe(
        Effect.provide(todoLayer),
      )
      expect(lastUser(result1)?.parts).toHaveLength(2)

      const step2 = structuredClone(durableBase)
      const result2 = yield* TodoReminders.apply({ messages: step2, sessionID: SessionID.make("ses_1") }).pipe(
        Effect.provide(todoLayer),
      )
      expect(lastUser(result2)?.parts).toHaveLength(2)

      // The durable base stays pristine — the injection is per-request only.
      expect(lastUser(durableBase)?.parts).toHaveLength(1)
    }),
  )

  runtime.effect("later steps of a turn reuse the turn's reminder so the cached prefix stays stable", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_pinned")
      const durableBase = [userMessage("work")]
      const first = yield* TodoReminders.apply({ messages: structuredClone(durableBase), sessionID }).pipe(
        Effect.provide(makeTodoLayer([{ content: "a", status: "pending", priority: "high" }])),
      )
      const firstText = reminderText(first)

      // The model then updates the list mid-turn. Neither the todowrite
      // freshness guard nor the new list may rewrite the turn's reminder.
      const later = [
        ...structuredClone(durableBase),
        assistantMessage([{ name: "todowrite", status: "completed" }]),
      ]
      const second = yield* TodoReminders.apply({ messages: later, sessionID }).pipe(
        Effect.provide(makeTodoLayer([{ content: "b", status: "in_progress", priority: "high" }])),
      )
      expect(lastUser(second)?.parts).toHaveLength(2)
      expect(reminderText(second)).toBe(firstText)

      // A new user message starts a new turn with a freshly decided reminder.
      const nextTurn = [...later, userMessage("continue")]
      const third = yield* TodoReminders.apply({ messages: nextTurn, sessionID }).pipe(
        Effect.provide(makeTodoLayer([{ content: "b", status: "in_progress", priority: "high" }])),
      )
      const thirdText = reminderText(third)
      expect(thirdText).toContain("b")
      expect(thirdText).not.toBe(firstText)
    }),
  )

  runtime.effect("a compacted transcript still receives the reminder", () =>
    Effect.gen(function* () {
      // Compaction runs before apply on the per-step fresh read: the
      // filtered transcript still ends in a user message, and with no
      // assistant carrying a fresh todowrite the reminder must survive.
      const messages = [userMessage("compacted summary: prior turns elided, work continues")]
      const result = yield* TodoReminders.apply({
        messages,
        sessionID: SessionID.make("ses_1"),
      }).pipe(
        Effect.provide(makeTodoLayer([
          { content: "a", status: "pending", priority: "high" },
        ])),
      )
      expect(lastUser(result)?.parts).toHaveLength(2)
      const reminder = lastUser(result)?.parts.at(-1) as never as { text: string; synthetic?: boolean }
      expect(reminder.synthetic).toBe(true)
      expect(reminder.text).toContain("[todo reminder]")
    }),
  )
})

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
