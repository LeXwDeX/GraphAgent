// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Todo } from "../../src/session/todo"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { Parameters, TodoWriteTool } from "../../src/tool/todo"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

// #1450: the status and priority of a todo are enums, and the receipt says what the call did to the stored list.

const stored: Todo.Info[] = [
  { content: "one", status: "completed", priority: "high" },
  { content: "two", status: "in_progress", priority: "medium" },
  { content: "three", status: "pending", priority: "low" },
]

const calls: string[] = []
const updates: Todo.Info[][] = []

const todos = Layer.mock(Todo.Service)({
  get: () => Effect.sync(() => void calls.push("get")).pipe(Effect.as(stored)),
  update: (input) =>
    Effect.sync(() => {
      calls.push("update")
      updates.push([...input.todos])
    }),
})

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer, todos))

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const init = Effect.fn("TodoWriteToolTest.init")(function* () {
  const info = yield* TodoWriteTool
  return yield* info.init()
})

type RawExecute = (args: unknown, ctx: Tool.Context) => Effect.Effect<Tool.ExecuteResult>
// oxlint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- test shim: send raw arguments through the wrapped execute
const raw = (execute: Tool.Def["execute"]) => execute as unknown as RawExecute

describe("tool.todowrite", () => {
  it.instance("rejects a status outside the enum before anything is stored", () =>
    Effect.gen(function* () {
      calls.length = 0
      const tool = yield* init()
      const exit = yield* raw(tool.execute)(
        { todos: [{ content: "x", status: "done", priority: "medium" }] },
        ctx,
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(error).toBeInstanceOf(Tool.InvalidArgumentsError)
      expect(calls).toEqual([])
    }),
  )

  it.instance("rejects a priority outside the enum", () =>
    Effect.gen(function* () {
      calls.length = 0
      const tool = yield* init()
      const exit = yield* raw(tool.execute)(
        { todos: [{ content: "x", status: "pending", priority: "urgent" }] },
        ctx,
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toEqual([])
    }),
  )

  it.instance("the receipt's first line gives the count before and after, then the stored list", () =>
    Effect.gen(function* () {
      calls.length = 0
      updates.length = 0
      const tool = yield* init()
      const next: Schema.Schema.Type<typeof Parameters>["todos"] = [
        { content: "one", status: "completed", priority: "high" },
        { content: "two", status: "completed", priority: "medium" },
      ]
      const result = yield* tool.execute({ todos: next }, ctx)

      const [first, ...rest] = result.output.split("\n")
      expect(first).toBe("Todo list replaced: 3 before, 2 now.")
      expect(JSON.parse(rest.join("\n"))).toEqual(next)
      expect(result.title).toBe("0 todos")
      expect(result.metadata).toMatchObject({ todos: next })
      // The previous count is read before the list is replaced, and the whole new list is what is stored.
      expect(calls).toEqual(["get", "update"])
      expect(updates).toEqual([next])
    }),
  )

  test("the wire schema says the list replaces the stored one and lists the enums", () => {
    // Plain values only: the schema object is cached and shared with the parameters snapshot test.
    const schema = ToolJsonSchema.fromSchema(Parameters)
    expect(JSON.stringify(schema)).toContain("replaces the stored list: every omitted item is deleted")
    expect(schema).toMatchObject({
      properties: {
        todos: {
          items: {
            properties: {
              status: { enum: ["pending", "in_progress", "completed", "cancelled"] },
              priority: { enum: ["high", "medium", "low"] },
            },
          },
        },
      },
    })
  })
})
