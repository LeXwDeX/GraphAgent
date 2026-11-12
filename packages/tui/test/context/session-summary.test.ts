// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import {
  createSummary,
  mergeSession,
  mergeSnapshot,
  mergeStatus,
  mergeToolPart,
  summarizeMessages,
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
      metadata: { sessionID: "ses_child", background: true },
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
    expect(taskIndexEntry(toolPart({ state: { metadata: { sessionID: 42 } } }))).toBeUndefined()
  })
})

describe("summarizeMessages", () => {
  const text = (id: string) => ({ id, type: "text" })

  test("counts distinct tool parts across messages and skips every other part type", () => {
    const snapshot = summarizeMessages([
      { parts: [text("prt_text"), toolPart({ id: "prt_a", tool: "bash" })] },
      { parts: [toolPart({ id: "prt_b", tool: "read" }), toolPart({ id: "prt_b", tool: "read" })] },
      { parts: [{ id: "prt_reasoning", type: "reasoning" }] },
    ])
    expect(snapshot.toolCalls).toBe(2)
    expect([...snapshot.toolPartIDs].toSorted()).toEqual(["prt_a", "prt_b"])
  })

  test("current is the latest running or completed tool that has a title", () => {
    const snapshot = summarizeMessages([
      {
        parts: [
          toolPart({ id: "prt_a", tool: "bash", state: { status: "completed", title: "first" } }),
          toolPart({ id: "prt_b", tool: "grep", state: { status: "running", title: "second" } }),
          toolPart({ id: "prt_c", tool: "edit", state: { status: "pending", title: "third" } }),
          toolPart({ id: "prt_d", tool: "write", state: { status: "error", title: "fourth" } }),
          toolPart({ id: "prt_e", tool: "read", state: { status: "completed", title: undefined } }),
        ],
      },
    ])
    expect(snapshot.current).toEqual({ tool: "grep", title: "second" })
  })

  test("collects the child links of Task parts", () => {
    const snapshot = summarizeMessages([
      {
        parts: [
          toolPart({ id: "prt_task_1", state: { metadata: { sessionID: "ses_c1", background: false } } }),
          toolPart({ id: "prt_task_2", state: { metadata: { sessionId: "ses_c2", background: true } } }),
          toolPart({ id: "prt_task_3", state: { metadata: {} } }),
          toolPart({ id: "prt_bash", tool: "bash" }),
        ],
      },
    ])
    expect(snapshot.tasks.map((task) => [task.childSessionID, task.entry.partID, task.entry.background])).toEqual([
      ["ses_c1", "prt_task_1", false],
      ["ses_c2", "prt_task_2", true],
    ])
  })

  test("an empty session recounts to zero tools", () => {
    expect(summarizeMessages([])).toMatchObject({ toolCalls: 0, current: undefined, tasks: [] })
    expect(summarizeMessages([{ parts: [text("prt_text")] }]).toolCalls).toBe(0)
  })
})

describe("mergeSnapshot", () => {
  const snapshot = (count: number, current?: { tool: string; title?: string }) => ({
    toolCalls: count,
    current,
    toolPartIDs: new Set<string>(),
    tasks: [],
  })

  test("a complete snapshot replaces the accumulated count, even downwards", () => {
    const previous = { ...createSummary(session), status: "busy" as const, toolCalls: 7, current: { tool: "old" } }
    const next = mergeSnapshot(previous, "ses_a", snapshot(3, { tool: "bash", title: "ls" }), true)
    expect(next.toolCalls).toBe(3)
    expect(next.current).toEqual({ tool: "bash", title: "ls" })
    // Status and times belong to the event reducer.
    expect(next.status).toBe("busy")
    expect(next.startedAt).toBe(10)
    expect(next.lastActivityAt).toBe(20)
  })

  test("a complete snapshot without tools is an exact zero and clears current", () => {
    const previous = { ...createSummary(session), toolCalls: 2, current: { tool: "bash", title: "ls" } }
    const next = mergeSnapshot(previous, "ses_a", snapshot(0), true)
    expect(next.toolCalls).toBe(0)
    expect(next.current).toBeUndefined()
  })

  test("a complete snapshot turns an unknown count into an exact one", () => {
    const next = mergeSnapshot(createSummary(session), "ses_a", snapshot(4), true)
    expect(next.toolCalls).toBe(4)
  })

  test("a cut window only raises the count and keeps the previous current", () => {
    const previous = { ...createSummary(session), toolCalls: 30, current: { tool: "bash", title: "ls" } }
    expect(mergeSnapshot(previous, "ses_a", snapshot(12), false).toolCalls).toBe(30)
    expect(mergeSnapshot(previous, "ses_a", snapshot(45), false).toolCalls).toBe(45)
    expect(mergeSnapshot(previous, "ses_a", snapshot(12), false).current).toEqual({ tool: "bash", title: "ls" })
  })

  test("a cut window with no evidence leaves the count unknown", () => {
    expect(mergeSnapshot(createSummary(session), "ses_a", snapshot(0), false).toolCalls).toBeUndefined()
    expect(mergeSnapshot(createSummary(session), "ses_a", snapshot(6), false).toolCalls).toBe(6)
  })

  test("builds a skeleton for a session the summary does not know yet", () => {
    expect(mergeSnapshot(undefined, "ses_new", snapshot(2), true)).toEqual({
      id: "ses_new",
      status: "unknown",
      lastActivityAt: 0,
      toolCalls: 2,
      current: undefined,
    })
  })
})
