// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * #953 — the todo reminder belongs to the model request, not persisted tool
 * output. This service returns request-only text for the current turn; provider
 * adapters append it after the persisted content, so earlier turns keep an
 * unchanged cached prefix and each request carries at most one reminder.
 */
import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Effect, Layer } from "effect"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { RuntimeContext } from "@/session/runtime-context"
import { Todo } from "@/session/todo"
import { TodoReminders } from "@/session/todo-reminders"
import { testEffect } from "../lib/effect"

const runtime = testEffect(TodoReminders.layer.pipe(Layer.provide(EventV2Bridge.defaultLayer)))

function makeTodoLayer(get: () => Effect.Effect<Todo.Info[]>) {
  return Layer.mock(Todo.Service, { get })
}

function user(id: string, text: string) {
  return {
    info: {
      id: MessageID.make(id),
      sessionID: SessionID.make("ses_todo_request"),
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    } satisfies SessionV1.User,
    parts: [
      {
        id: PartID.make(`prt_${id}`),
        messageID: MessageID.make(id),
        sessionID: SessionID.make("ses_todo_request"),
        type: "text" as const,
        text,
      },
    ],
  }
}

function assistant(id: string) {
  return {
    info: {
      id: MessageID.make(id),
      sessionID: SessionID.make("ses_todo_request"),
      role: "assistant",
      parentID: MessageID.make("msg_user_1"),
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: 2 },
    } satisfies SessionV1.Assistant,
    parts: [],
  }
}

const todos: Todo.Info[] = [
  { content: "ship feature", status: "in_progress", priority: "high" },
  { content: "done already", status: "completed", priority: "low" },
]

describe("TodoReminders.forRequest (#953)", () => {
  runtime.instance("returns request-only text for the newest user content", () =>
    Effect.gen(function* () {
      const reminders = yield* TodoReminders.Service
      const sessionID = SessionID.make("ses_1")
      const messages = [user("msg_user_1", "do the work"), assistant("msg_asst_1")]
      const before = structuredClone(messages)

      const result = yield* reminders
        .forRequest({ sessionID, messages, enabled: true })
        .pipe(Effect.provide(makeTodoLayer(() => Effect.succeed(todos))))

      expect(result).toContain("[todo reminder]")
      expect(result).toContain("ship feature")
      expect(result).not.toContain("done already")
      expect(messages).toEqual(before)
      expect(JSON.stringify(messages)).not.toContain("[todo reminder]")
    }),
  )

  runtime.instance("freezes a turn, keeps it while disabled, and updates only the next turn", () =>
    Effect.gen(function* () {
      const reminders = yield* TodoReminders.Service
      const sessionID = SessionID.make("ses_2")
      let current: Todo.Info[] = todos
      const layer = makeTodoLayer(() => Effect.succeed(current))
      const first = yield* reminders
        .forRequest({ sessionID, messages: [user("msg_user_2a", "first turn")], enabled: true })
        .pipe(Effect.provide(layer))
      expect(first).toContain("ship feature")

      // todowrite lands later in the same turn. The request keeps the frozen
      // text, including across a transition to enabled=false (last step with
      // tools disabled).
      current = [
        { content: "ship feature", status: "completed", priority: "high" },
        { content: "updated item", status: "pending", priority: "high" },
      ]
      const sameTurn = [user("msg_user_2a", "first turn"), assistant("msg_asst_2")]
      for (const enabled of [false, true, false]) {
        const next = yield* reminders.forRequest({ sessionID, messages: sameTurn, enabled }).pipe(Effect.provide(layer))
        expect(next).toBe(first)
      }

      // A new turn replaces the old entry: exactly one reminder, updated text.
      const latest = yield* reminders
        .forRequest({ sessionID, messages: [...sameTurn, user("msg_user_2b", "next turn")], enabled: true })
        .pipe(Effect.provide(layer))
      expect(latest).toContain("updated item")
      expect(latest).not.toContain("ship feature")
    }),
  )

  runtime.instance("returns the current turn reminder once across a multi-step history", () =>
    Effect.gen(function* () {
      const reminders = yield* TodoReminders.Service
      const sessionID = SessionID.make("ses_3")
      const result = yield* reminders
        .forRequest({
          sessionID,
          messages: [
            user("msg_user_3a", "old turn"),
            assistant("msg_asst_3a"),
            user("msg_user_3b", "current turn"),
            assistant("msg_asst_3b"),
            assistant("msg_asst_3c"),
          ],
          enabled: true,
        })
        .pipe(Effect.provide(makeTodoLayer(() => Effect.succeed(todos))))
      expect(result?.match(/\[todo reminder\]/g)).toHaveLength(1)
      expect(result).toContain("ship feature")
    }),
  )

  runtime.instance("does not create a reminder for a session without todowrite", () =>
    Effect.gen(function* () {
      const reminders = yield* TodoReminders.Service
      const sessionID = SessionID.make("ses_4")
      const messages = [user("msg_user_4", "dag node")]
      const result = yield* reminders
        .forRequest({ sessionID, messages, enabled: false })
        .pipe(Effect.provide(makeTodoLayer(() => Effect.succeed(todos))))
      expect(result).toBeUndefined()

      // A disabled first call must not leave a later enabled same-turn call with
      // stale text; it computes from the current list when enabled.
      const enabled = yield* reminders
        .forRequest({ sessionID, messages, enabled: true })
        .pipe(Effect.provide(makeTodoLayer(() => Effect.succeed(todos))))
      expect(enabled).toContain("ship feature")
    }),
  )

  runtime.instance("returns undefined when no todo is uncompleted", () =>
    Effect.gen(function* () {
      const reminders = yield* TodoReminders.Service
      const sessionID = SessionID.make("ses_5")
      const result = yield* reminders
        .forRequest({ sessionID, messages: [user("msg_user_5", "all done")], enabled: true })
        .pipe(
          Effect.provide(
            makeTodoLayer(() => Effect.succeed([{ content: "a", status: "completed", priority: "low" } as Todo.Info])),
          ),
        )
      expect(result).toBeUndefined()
    }),
  )

  runtime.instance("degrades to no reminder when the todo service fails", () =>
    Effect.gen(function* () {
      const reminders = yield* TodoReminders.Service
      const sessionID = SessionID.make("ses_6")
      const result = yield* reminders
        .forRequest({ sessionID, messages: [user("msg_user_6", "keep going")], enabled: true })
        .pipe(Effect.provide(makeTodoLayer(() => Effect.die("todo unavailable"))))
      expect(result).toBeUndefined()
    }),
  )

  runtime.effect("renders a singular uncompleted label", () =>
    Effect.gen(function* () {
      expect(TodoReminders.renderReminder([{ content: "one", status: "pending", priority: "high" }])).toContain(
        "[todo reminder] 1 uncompleted todo item:",
      )
    }),
  )

  runtime.effect("append adds a marked part to the current user message and never adds a user turn", () =>
    Effect.sync(() => {
      const messages = [
        { role: "user" as const, content: [{ type: "text" as const, text: "stable" }] },
        { role: "assistant" as const, content: "reply" },
      ]
      expect(TodoReminders.append(messages, undefined)).toBe(messages)
      const result = TodoReminders.append(messages, "[todo reminder] ephemeral")
      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({
        role: "user",
        content: [
          { type: "text", text: "stable" },
          {
            type: "text",
            text: "[todo reminder] ephemeral",
            providerOptions: { graphagent: { cache: "none" } },
          },
        ],
      })
      expect(result[1]).toEqual({ role: "assistant", content: "reply" })
      // A repeated projection in the same turn must not duplicate the part.
      expect(TodoReminders.append(result, "[todo reminder] ephemeral")).toEqual(result)
    }),
  )

  runtime.effect("append targets the persisted user, not a runtime-context user block", () =>
    Effect.sync(() => {
      const placed = RuntimeContext.place({
        ledger: [],
        messages: [
          { role: "user", content: "old turn" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: "current turn" },
        ],
        state: [{ key: "goal", parts: ["runtime context state"], cleared: "cleared" }],
        events: [],
      })
      const context = placed.messages.at(-1)
      if (!context) throw new Error("missing runtime context")
      expect(RuntimeContext.isMessage(context)).toBe(true)
      expect(context.role).toBe("user")
      expect(JSON.stringify(context.content)).toContain("<runtime_context>")

      const result = TodoReminders.append(placed.messages, "[todo reminder] ephemeral")
      expect(result).toHaveLength(placed.messages.length)
      expect(result[2]).toEqual({
        role: "user",
        content: [
          { type: "text", text: "current turn" },
          {
            type: "text",
            text: "[todo reminder] ephemeral",
            providerOptions: { graphagent: { cache: "none" } },
          },
        ],
      })
      expect(result[3]).toMatchObject({
        role: "user",
        content: context.content,
        providerOptions: { graphagent: { cache: "none" } },
      })
      expect(JSON.stringify(result[3].content)).toContain("<runtime_context>")
    }),
  )

  runtime.effect("append skips a synthetic tool-result attachment user message", () =>
    Effect.sync(() => {
      const synthetic = {
        role: "user" as const,
        content: [
          Object.assign(
            { type: "text" as const, text: "Attached media from tool result:" },
            { providerOptions: { graphagent: { synthetic: "attachment" } } },
          ),
          { type: "file" as const, mediaType: "image/png", data: "AA==" },
        ],
      }
      const messages = [
        { role: "user" as const, content: "current turn" },
        { role: "assistant" as const, content: "tool call" },
        synthetic,
      ]
      const result = TodoReminders.append(messages, "[todo reminder] ephemeral")
      expect(result[0]).toEqual({
        role: "user",
        content: [
          { type: "text", text: "current turn" },
          { type: "text", text: "[todo reminder] ephemeral", providerOptions: { graphagent: { cache: "none" } } },
        ],
      })
      expect(result[2]).toBe(synthetic)
      expect(JSON.stringify(result[2])).not.toContain("[todo reminder]")
    }),
  )

  runtime.effect("append stays idempotent across cloned runtime-context messages", () =>
    Effect.sync(() => {
      const placed = RuntimeContext.place({
        ledger: [],
        messages: [{ role: "user", content: "persisted turn" }],
        state: [{ key: "goal", parts: ["cloned context"], cleared: "cleared" }],
        events: [],
      })
      const cloned = structuredClone(placed.messages)
      const first = TodoReminders.append(cloned, "[todo reminder] ephemeral")
      const second = TodoReminders.append(first, "[todo reminder] ephemeral")
      expect(second).toEqual(first)
      const context = second.at(-1)
      if (!context) throw new Error("missing cloned runtime context")
      expect(RuntimeContext.isMessage(context)).toBe(true)
      expect(JSON.stringify(context)).not.toContain("[todo reminder]")
      expect(JSON.stringify(second[0])).toContain("[todo reminder]")
    }),
  )

  runtime.effect("append leaves the message sequence unchanged without a user message", () =>
    Effect.sync(() => {
      const messages = [{ role: "assistant" as const, content: "reply" }]
      expect(TodoReminders.append(messages, "[todo reminder] ephemeral")).toBe(messages)
    }),
  )
})
