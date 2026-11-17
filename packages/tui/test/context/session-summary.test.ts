// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import {
  backgroundResultOf,
  createSummary,
  mergeSession,
  mergeSnapshot,
  mergeStatus,
  mergeToolPart,
  summarizeMessages,
  summaryStatus,
  taskIndexEntry,
  type TextPartLike,
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

/** The `backgroundResult` metadata the server writes, with every field a valid one needs. */
function resultMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    childSessionID: "ses_child",
    initiator: "user",
    command: "/review src",
    title: "Review src",
    status: "completed",
    startedAt: 1_000,
    endedAt: 4_000,
    ...overrides,
  }
}

function resultPart(overrides: Partial<TextPartLike> = {}, backgroundResult: unknown = resultMetadata()): TextPartLike {
  return {
    id: "prt_result",
    sessionID: "ses_root",
    messageID: "msg_result",
    type: "text",
    synthetic: true,
    metadata: { backgroundResult },
    ...overrides,
  }
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

  test("a new run drops the error of the previous one; a run already under way keeps it", () => {
    const failed = { ...mergeStatus(createSummary(session), "ses_a", { type: "busy" }), error: "boom" }
    const stopped = mergeStatus(failed, "ses_a", { type: "idle" })
    expect(stopped).toMatchObject({ status: "idle", error: "boom" })

    const rerun = mergeStatus(stopped, "ses_a", { type: "busy" })
    expect(rerun.status).toBe("busy")
    expect(rerun.error).toBeUndefined()
    expect(mergeStatus(rerun, "ses_a", { type: "idle" }).error).toBeUndefined()

    // A retry inside the same run, or a repeated busy, does not start a new run.
    const retrying = mergeStatus(failed, "ses_a", { type: "retry", attempt: 1, message: "again", next: 0 })
    expect(retrying.error).toBe("boom")
    expect(mergeStatus(failed, "ses_a", { type: "busy" }).error).toBe("boom")
  })
})

describe("mergeStatus: when a run ends", () => {
  test("a run that stops ends when the stop is seen, not at its last tool call", () => {
    const running = { ...mergeStatus(createSummary(session), "ses_a", { type: "busy" }, 1_000), lastActivityAt: 1_000 }
    expect(running.lastActivityAt).toBe(1_000)
    expect(mergeStatus(running, "ses_a", { type: "idle" }, 61_000).lastActivityAt).toBe(61_000)
    // A retry is still the same run, and a stop seen twice does not move the end.
    expect(
      mergeStatus(running, "ses_a", { type: "retry", attempt: 1, message: "x", next: 0 }, 61_000).lastActivityAt,
    ).toBe(1_000)
    const ended = mergeStatus(running, "ses_a", { type: "idle" }, 61_000)
    expect(mergeStatus(ended, "ses_a", { type: "idle" }, 90_000).lastActivityAt).toBe(61_000)
    // Without the time it was seen, the end stays where the summary had it.
    expect(mergeStatus(running, "ses_a", { type: "idle" }).lastActivityAt).toBe(1_000)
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

  test("a call that cancels a task makes no link, so it cannot overwrite the one that started it", () => {
    const cancel = toolPart({
      id: "prt_cancel",
      state: { input: { action: "cancel", task_id: "ses_child" }, metadata: { sessionID: "ses_child" } },
    })
    expect(taskIndexEntry(cancel)).toBeUndefined()
    // Only the cancel action is left out; any other call that names its child still links.
    const other = toolPart({ state: { input: { action: "start", description: "do work" } } })
    expect(taskIndexEntry(other)?.childSessionID).toBe("ses_child")
  })

  test("reads who started the run, its command, whether it was promoted, and when the tool started", () => {
    const part = toolPart({
      state: {
        metadata: {
          sessionID: "ses_child",
          background: true,
          initiator: "user",
          command: "/review src",
          promoted: true,
        },
        time: { start: 1_234, end: 1_300 },
      },
    })
    expect(taskIndexEntry(part)?.entry).toEqual({
      parentSessionID: "ses_child",
      parentMessageID: "msg_1",
      partID: "prt_1",
      kind: "general",
      description: "do work",
      background: true,
      initiator: "user",
      command: "/review src",
      promoted: true,
      startedAt: 1_234,
    })
    const agent = taskIndexEntry(toolPart({ state: { metadata: { sessionID: "ses_child", initiator: "agent" } } }))
    expect(agent?.entry).toMatchObject({ initiator: "agent", background: false })
    expect(agent?.entry.command).toBeUndefined()
    expect(agent?.entry.promoted).toBeUndefined()
    expect(agent?.entry.startedAt).toBeUndefined()
  })

  test("leaves out malformed values and keeps the link", () => {
    const malformed = [
      {
        metadata: { sessionID: "ses_child", initiator: "robot", command: 42, promoted: "yes" },
        time: { start: "soon" },
      },
      { metadata: { sessionID: "ses_child", initiator: 1, command: "", promoted: false }, time: { start: Number.NaN } },
      { metadata: { sessionID: "ses_child", promoted: 1 }, time: { start: Number.POSITIVE_INFINITY } },
      { metadata: { sessionID: "ses_child" }, time: null },
    ]
    for (const state of malformed) {
      const entry = taskIndexEntry(toolPart({ state }))?.entry
      expect(entry).toBeDefined()
      expect(entry?.initiator).toBeUndefined()
      expect(entry?.command).toBeUndefined()
      expect(entry?.promoted).toBeUndefined()
      expect(entry?.startedAt).toBeUndefined()
      expect(entry?.partID).toBe("prt_1")
    }
  })

  test("a link never carries a result: the part does not know it", () => {
    expect(taskIndexEntry(toolPart())?.entry).not.toHaveProperty("result")
  })
})

describe("backgroundResultOf", () => {
  test("reads the result a finished background run left for its parent", () => {
    expect(backgroundResultOf(resultPart())).toEqual({
      childSessionID: "ses_child",
      result: {
        status: "completed",
        title: "Review src",
        initiator: "user",
        command: "/review src",
        startedAt: 1_000,
        endedAt: 4_000,
        messageID: "msg_result",
        partID: "prt_result",
      },
    })
  })

  test("accepts the three statuses the server reports", () => {
    for (const status of ["completed", "error", "interrupted"] as const) {
      expect(backgroundResultOf(resultPart({}, resultMetadata({ status })))?.result.status).toBe(status)
    }
  })

  test("an agent's run has an initiator and no command", () => {
    const found = backgroundResultOf(resultPart({}, resultMetadata({ initiator: "agent", command: undefined })))
    expect(found?.result.initiator).toBe("agent")
    expect(found?.result.command).toBeUndefined()
  })

  test("a malformed initiator or command is left out and the result stays", () => {
    const found = backgroundResultOf(resultPart({}, resultMetadata({ initiator: "robot", command: 7 })))
    expect(found?.childSessionID).toBe("ses_child")
    expect(found?.result.initiator).toBeUndefined()
    expect(found?.result.command).toBeUndefined()
    expect(
      backgroundResultOf(resultPart({}, resultMetadata({ initiator: undefined, command: "" })))?.result,
    ).toMatchObject({ status: "completed" })
  })

  test("is not a result without the synthetic mark or the metadata", () => {
    expect(backgroundResultOf(resultPart({ synthetic: false }))).toBeUndefined()
    expect(backgroundResultOf(resultPart({ synthetic: undefined }))).toBeUndefined()
    expect(backgroundResultOf(resultPart({ metadata: undefined }))).toBeUndefined()
    expect(backgroundResultOf(resultPart({ metadata: { prWatch: {} } }))).toBeUndefined()
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a part of another type, as the store's union holds.
    expect(backgroundResultOf({ ...resultPart(), type: "reasoning" } as unknown as TextPartLike)).toBeUndefined()
  })

  test("is not a result when the metadata is not an object", () => {
    for (const raw of [undefined, null, "done", 42, true]) {
      expect(backgroundResultOf(resultPart({ metadata: { backgroundResult: raw } }))).toBeUndefined()
    }
  })

  test("is not a result when the child, the status, the title or a time is malformed", () => {
    const bad: Array<Record<string, unknown>> = [
      { childSessionID: undefined },
      { childSessionID: "" },
      { childSessionID: 7 },
      { status: undefined },
      { status: "running" },
      { status: "cancelled" },
      { status: "COMPLETED" },
      { status: 1 },
      { title: undefined },
      { title: "" },
      { title: {} },
      { startedAt: undefined },
      { startedAt: "1000" },
      { startedAt: Number.NaN },
      { startedAt: Number.POSITIVE_INFINITY },
      { endedAt: undefined },
      { endedAt: "4000" },
      { endedAt: Number.NEGATIVE_INFINITY },
    ]
    for (const overrides of bad) {
      expect(backgroundResultOf(resultPart({}, resultMetadata(overrides)))).toBeUndefined()
    }
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

  test("collects the results of finished background runs, oldest first, and no other text", () => {
    const snapshot = summarizeMessages([
      {
        parts: [
          text("prt_plain"),
          resultPart({ id: "prt_r1", messageID: "msg_r1" }, resultMetadata({ childSessionID: "ses_c1" })),
          resultPart({ id: "prt_forged", synthetic: false }, resultMetadata({ childSessionID: "ses_forged" })),
        ],
      },
      {
        parts: [
          resultPart({ id: "prt_bad", messageID: "msg_r2" }, resultMetadata({ status: "running" })),
          resultPart(
            { id: "prt_r2", messageID: "msg_r2" },
            resultMetadata({ childSessionID: "ses_c2", status: "error" }),
          ),
          toolPart({ id: "prt_task", state: { metadata: { sessionID: "ses_c1", background: true } } }),
        ],
      },
    ])
    expect(
      snapshot.results.map((item) => [
        item.childSessionID,
        item.result.status,
        item.result.messageID,
        item.result.partID,
      ]),
    ).toEqual([
      ["ses_c1", "completed", "msg_r1", "prt_r1"],
      ["ses_c2", "error", "msg_r2", "prt_r2"],
    ])
    // The results sit beside the links; neither is counted as a tool call.
    expect(snapshot.tasks.map((task) => task.childSessionID)).toEqual(["ses_c1"])
    expect(snapshot.toolCalls).toBe(1)
  })

  test("a cancel call is not a link in a snapshot either", () => {
    const snapshot = summarizeMessages([
      {
        parts: [
          toolPart({ id: "prt_task", state: { metadata: { sessionID: "ses_c1", background: true } } }),
          toolPart({ id: "prt_cancel", state: { input: { action: "cancel" }, metadata: { sessionID: "ses_c1" } } }),
        ],
      },
    ])
    expect(snapshot.tasks.map((task) => task.entry.partID)).toEqual(["prt_task"])
    expect(snapshot.toolCalls).toBe(2)
  })

  test("an empty session recounts to zero tools", () => {
    expect(summarizeMessages([])).toMatchObject({ toolCalls: 0, current: undefined, tasks: [], results: [] })
    expect(summarizeMessages([{ parts: [text("prt_text")] }]).toolCalls).toBe(0)
  })
})

describe("mergeSnapshot", () => {
  const snapshot = (count: number, current?: { tool: string; title?: string }) => ({
    toolCalls: count,
    current,
    toolPartIDs: new Set<string>(),
    tasks: [],
    results: [],
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
