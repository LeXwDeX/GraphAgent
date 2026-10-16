import { describe, expect } from "bun:test"
import { asc } from "drizzle-orm"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable, TodoTable } from "@opencode-ai/core/session/sql"
import { SessionTodoHooks } from "@opencode-ai/core/session/todo-hooks"
import { SessionTodo } from "@opencode-ai/core/session/todo"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.mergeAll(Database.defaultLayer, EventV2.defaultLayer, SessionTodo.defaultLayer))
const sessionID = SessionV2.ID.make("ses_todo_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "todo",
      directory: "/project",
      title: "todo",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

describe("SessionTodo", () => {
  it.effect("replaces persisted todos in order and publishes updates", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const todos = yield* SessionTodo.Service
      const published = new Array<EventV2.Payload>()
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionTodo.Event.Updated.type) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* todos.update({
        sessionID,
        todos: [
          { content: "second", status: "pending", priority: "low" },
          { content: "first", status: "in_progress", priority: "high" },
        ],
      })
      expect(yield* todos.get(sessionID)).toEqual([
        { content: "second", status: "pending", priority: "low" },
        { content: "first", status: "in_progress", priority: "high" },
      ])
      expect(
        (yield* db.select().from(TodoTable).orderBy(asc(TodoTable.position)).all().pipe(Effect.orDie)).map((row) => ({
          content: row.content,
          position: row.position,
        })),
      ).toEqual([
        { content: "second", position: 0 },
        { content: "first", position: 1 },
      ])

      yield* todos.update({ sessionID, todos: [{ content: "replacement", status: "completed", priority: "medium" }] })
      expect(yield* todos.get(sessionID)).toEqual([{ content: "replacement", status: "completed", priority: "medium" }])

      yield* todos.update({ sessionID, todos: [] })
      expect(yield* todos.get(sessionID)).toEqual([])
      expect(published.map((event) => event.data)).toEqual([
        {
          sessionID,
          todos: [
            { content: "second", status: "pending", priority: "low" },
            { content: "first", status: "in_progress", priority: "high" },
          ],
        },
        { sessionID, todos: [{ content: "replacement", status: "completed", priority: "medium" }] },
        { sessionID, todos: [] },
      ])
    }),
  )
})

describe("Todo lifecycle preflight", () => {
  it.effect("stable bulk task identities survive reordering, priority and status changes", () =>
    Effect.sync(() => {
      const before = [
        { content: "alpha", status: "pending" },
        { content: "beta", status: "in_progress" },
        { content: "alpha", status: "pending" },
      ]
      const old = SessionTodoHooks.identified(sessionID, before)
      const next = SessionTodoHooks.identified(sessionID, [before[1], { ...before[0], status: "completed" }, before[2]])
      expect(next.map((item) => item.id)).toEqual([old[1].id, old[0].id, old[2].id])
      expect(SessionTodoHooks.changes(sessionID, before, next)).toEqual([
        { event: "TaskCompleted", sessionID, taskID: old[0].id, subject: "alpha" },
      ])
      expect(
        SessionTodoHooks.changes(sessionID, [], [{ content: "new", status: "completed" }]).map((item) => item.event),
      ).toEqual(["TaskCreated", "TaskCompleted"])
    }),
  )
  it.effect("a later veto preserves the entire previous real database list and publishes no update", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service
      const previous = [{ content: "kept", status: "pending", priority: "high" }]
      yield* todos.update({ sessionID, todos: previous })
      const calls: SessionTodoHooks.Change[] = []
      const result = yield* todos
        .update({ sessionID, todos: [{ content: "new", status: "completed", priority: "low" }] })
        .pipe(
          Effect.provideService(SessionTodoHooks.Service, {
            check: (change) =>
              Effect.sync(() => {
                calls.push(change)
                return change.event === "TaskCompleted" ? { blocked: { reason: "actual policy veto" } } : {}
              }),
          }),
          Effect.exit,
        )
      expect(result._tag).toBe("Failure")
      expect(calls.map((change) => change.event)).toEqual(["TaskCreated", "TaskCompleted"])
      expect(yield* todos.get(sessionID)).toEqual(previous)
    }),
  )
})

it.effect("Todo preflight serializes concurrent replacements and releases its lock on interruption", () =>
  Effect.gen(function* () {
    yield* setup
    const todos = yield* SessionTodo.Service
    const entered = yield* Deferred.make<void>()
    const blocked = yield* Deferred.make<void>()
    const hook = {
      check: (change: SessionTodoHooks.Change) =>
        change.subject === "first"
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(blocked)), Effect.as({}))
          : Effect.succeed({}),
    }
    const first = yield* todos
      .update({ sessionID, todos: [{ content: "first", status: "pending", priority: "low" }] })
      .pipe(Effect.provideService(SessionTodoHooks.Service, hook), Effect.forkScoped)
    yield* Deferred.await(entered)
    // A normal DB read remains available while the external hook is suspended.
    expect(yield* todos.get(sessionID)).toEqual([])
    const second = yield* todos
      .update({ sessionID, todos: [{ content: "second", status: "pending", priority: "high" }] })
      .pipe(Effect.provideService(SessionTodoHooks.Service, hook), Effect.forkScoped)
    yield* Fiber.interrupt(first)
    yield* Fiber.join(second)
    expect(yield* todos.get(sessionID)).toEqual([{ content: "second", status: "pending", priority: "high" }])
  }),
)
