import { describe, expect, test } from "bun:test"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { EventManifest as SchemaEventManifest } from "@opencode-ai/schema/event-manifest"
import { Todo } from "@/session/todo"
import { SessionGoal } from "@opencode-ai/schema/session-goal"
import { EventManifest } from "@/event-manifest"

describe("public event manifest", () => {
  test("contains every latest public wire type once", () => {
    expect(EventManifest.Definitions).toBe(SchemaEventManifest.Definitions)
    expect(EventManifest.Latest).toBe(SchemaEventManifest.Latest)
    expect(EventManifest.Durable).toBe(SchemaEventManifest.Durable)
    expect(EventManifest.Latest.size).toBe(62)
    expect(EventManifest.Latest.get("session.next.moved")).toBe(SessionEvent.Moved)
    expect(EventManifest.Latest.get("todo.updated")).toBe(Todo.Event.Updated)
    expect(EventManifest.Latest.get("goal.updated")).toBe(SessionGoal.Event.Updated)
    expect(EventManifest.Latest.get("goal.cleared")).toBe(SessionGoal.Event.Cleared)
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(EventManifest.Latest.has("server.connected")).toBe(true)
    expect(EventManifest.Latest.has("global.disposed")).toBe(true)
  })

  test("contains only the current session-next durable versions", () => {
    expect(EventManifest.Durable.has("session.next.step.ended.2")).toBe(false)
    expect(EventManifest.Durable.get("session.next.moved.1")).toBe(SessionEvent.Moved)
  })
})
