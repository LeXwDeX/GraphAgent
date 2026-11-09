// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { Event } from "@graphagent/sdk/v2"
import { createEventGate, eventScope, scopeOf } from "../../src/context/event-gate"

function event(type: string, properties: Record<string, unknown> = {}): Event {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: the gate reads only `type` and the opaque `properties` record.
  return { type, properties } as unknown as Event
}

function gate(full: Iterable<string>) {
  return createEventGate(() => new Set(full))
}

describe("eventScope", () => {
  test("classifies the session full event set", () => {
    for (const type of [
      "message.updated",
      "message.removed",
      "message.part.updated",
      "message.part.removed",
      "message.part.delta",
      "message.part.preview",
      "todo.updated",
      "session.diff",
      "session.hook.status",
      "session.hook.terminal",
      "session.hook.message",
      "dag.workflow.nodes.updated",
    ])
      expect(eventScope(type), type).toBe("session-full")
  })

  test("classifies the session summary event set", () => {
    for (const type of [
      "session.created",
      "session.updated",
      "session.deleted",
      "session.status",
      "session.idle",
      "session.error",
      "permission.asked",
      "permission.replied",
      "question.asked",
      "question.replied",
      "goal.updated",
      "goal.cleared",
      "dag.workflow.summary.updated",
    ])
      expect(eventScope(type), type).toBe("session-summary")
  })

  test("defaults unlisted event types to global", () => {
    expect(eventScope("vcs.branch.updated")).toBe("global")
    expect(eventScope("server.connected")).toBe("global")
    expect(eventScope("some.future.event")).toBe("global")
  })
})

describe("scopeOf", () => {
  test("reads the session id from properties.sessionID", () => {
    expect(scopeOf(event("message.updated", { sessionID: "ses_a" }))).toEqual({
      scope: "session-full",
      sessionID: "ses_a",
    })
  })

  test("reads the session id from nested info", () => {
    expect(scopeOf(event("session.updated", { info: { sessionID: "ses_info" } })).sessionID).toBe("ses_info")
    expect(scopeOf(event("session.updated", { info: { id: "ses_id" } })).sessionID).toBe("ses_id")
  })

  test("reads the session id from a part", () => {
    expect(scopeOf(event("message.part.updated", { part: { sessionID: "ses_part" } })).sessionID).toBe("ses_part")
  })

  test("leaves the session id undefined when absent", () => {
    expect(scopeOf(event("vcs.branch.updated", { branch: "main" })).sessionID).toBeUndefined()
  })
})

describe("createEventGate", () => {
  test("always delivers global and summary events", () => {
    const isFull = gate([])
    expect(isFull(event("vcs.branch.updated", { branch: "main" }))).toBe("deliver")
    expect(isFull(event("session.updated", { sessionID: "ses_a", info: { id: "ses_a" } }))).toBe("deliver")
    expect(isFull(event("session.deleted", { sessionID: "ses_a" }))).toBe("deliver")
    expect(isFull(event("permission.asked", { sessionID: "ses_a" }))).toBe("deliver")
  })

  test("delivers full events for sessions in the effective interest set", () => {
    const isFull = gate(["ses_a"])
    expect(isFull(event("message.updated", { sessionID: "ses_a", info: { id: "msg_1" } }))).toBe("deliver")
    expect(isFull(event("message.part.delta", { sessionID: "ses_a", messageID: "msg_1", partID: "prt_1" }))).toBe(
      "deliver",
    )
  })

  test("drops unknown full-event sessions", () => {
    const isFull = gate(["ses_a"])
    expect(isFull(event("message.updated", { sessionID: "ses_b", info: { id: "msg_1" } }))).toBe("drop")
    expect(isFull(event("todo.updated", { sessionID: "ses_b", todos: [] }))).toBe("drop")
  })

  test("drops full events without a session id", () => {
    expect(gate(["ses_a"])(event("message.updated", {}))).toBe("drop")
  })

  test("keeps tool parts as summary events for non-full sessions", () => {
    const isFull = gate([])
    expect(
      isFull(
        event("message.part.updated", {
          sessionID: "ses_child",
          part: { id: "prt_1", type: "tool", tool: "task" },
        }),
      ),
    ).toBe("summary")
  })

  test("drops non-tool parts for non-full sessions", () => {
    const isFull = gate([])
    expect(isFull(event("message.part.updated", { sessionID: "ses_child", part: { id: "prt_1", type: "text" } }))).toBe(
      "drop",
    )
  })

  test("reads the effective set on every event", () => {
    const sessions = new Set<string>()
    const isFull = createEventGate(() => sessions)
    const message = event("message.updated", { sessionID: "ses_a", info: { id: "msg_1" } })
    expect(isFull(message)).toBe("drop")
    sessions.add("ses_a")
    expect(isFull(message)).toBe("deliver")
    sessions.delete("ses_a")
    expect(isFull(message)).toBe("drop")
  })
})
