import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"

// Todo.Info is still a zod schema (session/todo.ts). Inline the field shape
// here rather than referencing its `.shape` — the LLM-visible JSON Schema is
// identical, and it removes the last zod dependency from this tool.
const TodoItem = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]).annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.Literals(["high", "medium", "low"]).annotate({
    description: "Priority level of the task: high, medium, low",
  }),
})

export const Parameters = Schema.Struct({
  todos: Schema.mutable(Schema.Array(TodoItem)).annotate({
    description: "The complete todo list after this call. It replaces the stored list: every omitted item is deleted.",
  }),
})

// The receipt's first line states what the call did to the stored list, so a model that sent only the changed items
// sees the deleted rest at once instead of discovering it later.
function replaceReceipt(previous: number, now: number) {
  return `Todo list replaced: ${previous} before, ${now} now.`
}

type Metadata = {
  todos: Todo.Info[]
}

export const TodoWriteTool = Tool.define<typeof Parameters, Metadata, Todo.Service>(
  "todowrite",
  Effect.gen(function* () {
    const todo = yield* Todo.Service

    return {
      description: DESCRIPTION_WRITE,
      effects: "read",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "todowrite",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          const previous = (yield* todo.get(ctx.sessionID)).length
          yield* todo
            .update({
              sessionID: ctx.sessionID,
              todos: params.todos,
            })
            .pipe(Effect.orDie)

          return {
            title: `${params.todos.filter((x) => x.status !== "completed").length} todos`,
            output: `${replaceReceipt(previous, params.todos.length)}\n${JSON.stringify(params.todos, null, 2)}`,
            metadata: {
              todos: params.todos,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
