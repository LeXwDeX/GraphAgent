// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import {
  createSummary,
  mergeSession,
  mergeStatus,
  mergeToolPart,
  summaryStatus,
  taskIndexEntry,
  type ToolPartLike,
} from "../../src/context/session-summary"

const session = {
  id: "ses_a",
  parentID: "ses_root",
  time: { created: 10, updated: 20 },
}

type ToolOverrides = { id?: string; tool?: string; state?: Record<string, any> }

function toolPart(overrides: ToolOverrides = {}): ToolPartLike {
  return {
    id: overrides.id ?? "prt_1",
    sessionID: "ses_child",
    messageID: "msg_1",
    type: "tool",
    tool: overrides.tool ?? "task",
    state: {
      status: "running",
      title: "Background child",
      input: { description: "do work", subagent_type: "general" },
      metadata: { sessionId: "ses_child", background: true },
      ...overrides.state,
    },
  } as ToolPartLike
}

describe("summaryStatus", () => {
  test("maps SDK statuses to the compact summary status", () => {
    expect(summaryStatus(undefined)).toBe("unknown")
    expect(summaryStatus({ type: "idle" })).toBe("idle")
    expect(summaryStatus({ type: "retry", attempt: 1, message: "rate limited", next: 0 })).toBe("retry")
    expect(summaryStatus({ type: "busy" })).toBe("busy")
  })
})

describe("createSummary", () => {
  test("derives activity from a session without counting tools", () => {
    expect(createSummary(session)).toEqual({
      id: "ses_a",
      parentID: "ses_root",
      status: "unknown",
      toolCalls: undefined,
      current: undefined,
      startedAt: 10,
      lastActivityAt: 20,
      error: undefined,
    })
  })

  test("keeps accumulated counters and status when the session refreshes", () => {
    const previous = { ...createSummary(session), status: "busy" as const, toolCalls: 3, current: { tool: "task" } }
    const next = createSummary({ ...session, time: { created: 10, updated: 30 } }, undefined, previous)
    expect(next.status).toBe("busy")
    expect(next.toolCalls).toBe(3)
    expect(next.current).toEqual({ tool: "task" })
    expect(next.lastActivityAt).toBe(30)
  })

  test("an explicit status wins over the stored one", () => {
    const previous = { ...createSummary(session), status: "busy" as const }
    expect(createSummary(session, { type: "idle" }, previous).status).toBe("idle")
  })
})

describe("mergeSession", () => {
  test("keeps the first seen start time and the newest activity", () => {
    const previous = { ...createSummary(session), startedAt: 5, lastActivityAt: 50 }
    const next = mergeSession(previous, { ...session, time: { created: 10, updated: 40 } })
    expect(next.startedAt).toBe(5)
    expect(next.lastActivityAt).toBe(50)
    expect(next.parentID).toBe("ses_root")
  })

  test("creates a summary for an unknown session", () => {
    expect(mergeSession(undefined, session)).toMatchObject({ id: "ses_a", startedAt: 10, lastActivityAt: 20 })
  })
})

describe("mergeStatus", () => {
  test("creates a skeleton when the session is unknown", () => {
    expect(mergeStatus(undefined, "ses_x", { type: "busy" })).toMatchObject({
      id: "ses_x",
      status: "busy",
      lastActivityAt: 0,
    })
  })

  test("preserves counters from an existing summary", () => {
    const previous = { ...createSummary(session), toolCalls: 2, current: { tool: "task", title: "t" } }
    const next = mergeStatus(previous, "ses_a", { type: "idle" })
    expect(next.toolCalls).toBe(2)
    expect(next.current).toEqual({ tool: "task", title: "t" })
    expect(next.status).toBe("idle")
  })
})

describe("mergeToolPart", () => {
  test("counts unique tool parts and records the current tool", () => {
    const seen = new Set<string>()
    const first = mergeToolPart(undefined, toolPart(), seen, 30)
    expect(first.toolCalls).toBe(1)
    expect(first.current).toEqual({ tool: "task", title: "Background child" })
    expect(first.lastActivityAt).toBe(30)

    const duplicate = mergeToolPart(first, toolPart(), seen, 25)
    expect(duplicate.toolCalls).toBe(1)
    expect(duplicate.lastActivityAt).toBe(30)
  })

  test("counts a different part id once", () => {
    const seen = new Set<string>()
    let summary = mergeToolPart(undefined, toolPart(), seen)
    summary = mergeToolPart(summary, toolPart({ id: "prt_2" }), seen)
    expect(summary.toolCalls).toBe(2)
  })

  test("ignores titles for incomplete or failed tools", () => {
    const summary = mergeToolPart(undefined, toolPart({ state: { status: "pending", title: "soon" } }), new Set())
    expect(summary.toolCalls).toBe(1)
    expect(summary.current).toBeUndefined()
  })

  test("leaves activity untouched without a timestamp", () => {
    const summary = mergeToolPart(undefined, toolPart(), new Set())
    expect(summary.lastActivityAt).toBe(0)
  })
})

describe("taskIndexEntry", () => {
  test("links a task part to its child session", () => {
    expect(taskIndexEntry(toolPart())).toEqual({
      childSessionID: "ses_child",
      entry: {
        parentSessionID: "ses_child",
        parentMessageID: "msg_1",
        partID: "prt_1",
        kind: "general",
        description: "do work",
        background: true,
      },
    })
  })

  test("ignores non-task tools", () => {
    expect(taskIndexEntry(toolPart({ tool: "bash" }))).toBeUndefined()
  })

  test("ignores a missing or non-string child session id", () => {
    expect(taskIndexEntry(toolPart({ state: { metadata: {} } }))).toBeUndefined()
    expect(taskIndexEntry(toolPart({ state: { metadata: { sessionId: 42 } } }))).toBeUndefined()
  })
})
