// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import type { AssistantMessage, GlobalEvent, ToolPart } from "@graphagent/sdk"
import { tmpdir } from "../../../fixture/fixture"
import { mountSessionMain, waitForFrame } from "../../../fixture/session-main"
import { directory, json, mount, wait } from "./sync-fixture"

// #886 5.4 / acceptance "Task laziness": the summary of a loaded session and
// the taskIndex links are rebuilt from the snapshot on hydration and on
// reconnect; sessions that were never loaded keep what the events gave them.

type Row = {
  id: string
  slug: string
  projectID: string
  directory: string
  version: string
  title: string
  parentID?: string
  time: { created: number; updated: number }
}

function row(id: string, parentID?: string): Row {
  return {
    id,
    slug: id,
    title: id,
    projectID: "proj_test",
    directory,
    version: "test",
    parentID,
    time: { created: 1_000, updated: 5_000 },
  }
}

function assistant(id: string, sessionID: string): AssistantMessage {
  return {
    id,
    sessionID,
    parentID: `${id}_user`,
    role: "assistant",
    agent: "build",
    mode: "build",
    modelID: "test-model",
    providerID: "test",
    path: { cwd: directory, root: directory },
    time: { created: 10, completed: 20 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function tool(id: string, sessionID: string, messageID: string, name: string, title: string): ToolPart {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    tool: name,
    callID: `call_${id}`,
    state: { status: "completed", input: {}, output: "", title, metadata: {}, time: { start: 12, end: 13 } },
  }
}

function taskPart(n: number): ToolPart {
  return {
    id: `prt_task_${n}`,
    sessionID: "ses_parent",
    messageID: "msg_parent",
    type: "tool",
    tool: "task",
    callID: `call_task_${n}`,
    state: {
      status: "completed",
      input: { description: `Inspect area ${n}`, subagent_type: "explore" },
      output: "done",
      title: `Inspect area ${n}`,
      metadata: { sessionID: `ses_c${n}`, background: n === 2 },
      time: { start: 10, end: 20 },
    },
  }
}

function toolEvent(id: string, part: ToolPart, time: number): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return {
    directory,
    project: "proj_test",
    payload: { id, type: "message.part.updated", properties: { sessionID: part.sessionID, time, part } },
  } as GlobalEvent
}

type Loaded = Record<string, Array<{ info: AssistantMessage; parts: ToolPart[] }>>

function routesFor(rows: Row[], messages: Loaded) {
  const byID = new Map(rows.map((item) => [item.id, item]))
  return (url: URL) => {
    if (url.pathname === "/session") return json(rows)
    if (url.pathname.startsWith("/dag/session/")) return json([])
    const match = url.pathname.match(/^\/session\/([^/]+)$/)
    if (match && byID.has(match[1])) return json(byID.get(match[1]))
    const loaded = url.pathname.match(/^\/session\/([^/]+)\/message$/)
    if (loaded) return json(messages[loaded[1]] ?? [])
    if (/^\/session\/[^/]+\/(todo|diff)$/.test(url.pathname)) return json([])
    if (/^\/session\/[^/]+\/goal$/.test(url.pathname)) return json(undefined)
    return undefined
  }
}

const parentRows = [
  row("ses_parent"),
  row("ses_c1", "ses_parent"),
  row("ses_c2", "ses_parent"),
  row("ses_c3", "ses_parent"),
]

function coldMessages(): Loaded {
  return {
    ses_parent: [{ info: assistant("msg_parent", "ses_parent"), parts: [taskPart(1), taskPart(2), taskPart(3)] }],
    ses_c1: [
      {
        info: assistant("msg_c1", "ses_c1"),
        parts: [
          tool("prt_c1_a", "ses_c1", "msg_c1", "bash", "run tests"),
          tool("prt_c1_b", "ses_c1", "msg_c1", "read", "src/index.ts"),
          tool("prt_c1_c", "ses_c1", "msg_c1", "grep", "TODO"),
          tool("prt_c1_d", "ses_c1", "msg_c1", "edit", "fix the typo"),
        ],
      },
    ],
  }
}

describe("cold start", () => {
  test("loading the parent relinks its Task children and leaves the child counts unknown", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, sync } = await mount(routesFor(parentRows, coldMessages()), tmp.path)

    try {
      // Right after a restart nothing has seen a Task event.
      expect(Object.keys(sync.data.taskIndex)).toEqual([])
      expect(sync.data.summary.ses_c1.toolCalls).toBeUndefined()

      await sync.session.sync("ses_parent")

      expect(Object.keys(sync.data.taskIndex).toSorted()).toEqual(["ses_c1", "ses_c2", "ses_c3"])
      expect(sync.data.taskIndex.ses_c1).toEqual({
        parentSessionID: "ses_parent",
        parentMessageID: "msg_parent",
        partID: "prt_task_1",
        kind: "explore",
        description: "Inspect area 1",
        background: false,
      })
      expect(sync.data.taskIndex.ses_c2.background).toBe(true)
      // The parent itself ran three Task tools, counted from its messages.
      expect(sync.data.summary.ses_parent.toolCalls).toBe(3)
      // The children were never loaded: their counts are unknown, not 0.
      for (const id of ["ses_c1", "ses_c2", "ses_c3"]) expect(sync.data.summary[id].toolCalls).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("entering one child makes its count exact and the others stay unknown", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(routesFor(parentRows, coldMessages()), tmp.path)

    try {
      await sync.session.sync("ses_parent")
      await sync.session.sync("ses_c1")

      expect(sync.data.summary.ses_c1.toolCalls).toBe(4)
      expect(sync.data.summary.ses_c1.current).toEqual({ tool: "edit", title: "fix the typo" })
      expect(sync.data.summary.ses_c2.toolCalls).toBeUndefined()
      expect(sync.data.summary.ses_c3.toolCalls).toBeUndefined()

      // A live update of a counted tool part is the same tool call...
      emit(toolEvent("evt_c1_again", tool("prt_c1_d", "ses_c1", "msg_c1", "edit", "fix the typo"), 30))
      // ...a part the snapshot did not hold is one more.
      emit(toolEvent("evt_c1_next", tool("prt_c1_e", "ses_c1", "msg_c1", "bash", "run lint"), 31))
      await wait(() => sync.data.summary.ses_c1.toolCalls === 5)
      expect(sync.data.summary.ses_c1.current).toEqual({ tool: "bash", title: "run lint" })
    } finally {
      app.renderer.destroy()
    }
  })

  test("the Task rows of three finished children show — until one of them is entered", async () => {
    const messages = coldMessages()
    const view = await mountSessionMain({
      sessionID: "ses_parent",
      width: 100,
      height: 40,
      fetch: routesFor(parentRows, messages),
    })

    try {
      const cold = await waitForFrame(view.app, "↳ —")
      const unknown = (frame: string) => frame.split("\n").filter((line) => line.includes("↳ —")).length
      // Every finished child shows the em dash, never 0 toolcalls.
      expect(cold).toContain("Explore Task — Inspect area 1")
      expect(cold).toContain("Explore Task (background) — Inspect area 2")
      expect(cold).toContain("Explore Task — Inspect area 3")
      expect(cold).not.toContain("0 toolcalls")
      expect(unknown(cold)).toBe(3)

      await view.sync.session.sync("ses_c1")
      const entered = await waitForFrame(view.app, "4 toolcalls")
      expect(unknown(entered)).toBe(2)
    } finally {
      await view.dispose()
    }
  })
})

describe("reconnect", () => {
  const rows = [row("ses_a"), row("ses_b")]
  const toolsFor = (sessionID: string, count: number) =>
    Array.from({ length: count }, (_, index) =>
      tool(`prt_${sessionID}_${index}`, sessionID, `msg_${sessionID}`, "bash", `step ${index}`),
    )

  test("loaded sessions are recounted from the snapshot, unloaded ones keep their value", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const messages: Loaded = {
      ses_a: [{ info: assistant("msg_ses_a", "ses_a"), parts: toolsFor("ses_a", 2) }],
    }
    const { app, emit, reconnect, sync } = await mount(routesFor(rows, messages), tmp.path)

    try {
      await sync.session.activate("ses_a")
      expect(sync.data.summary.ses_a.toolCalls).toBe(2)

      emit(toolEvent("evt_a_live", tool("prt_ses_a_live", "ses_a", "msg_ses_a", "bash", "live"), 20))
      await wait(() => sync.data.summary.ses_a.toolCalls === 3)
      // ses_b is not loaded; its tool events reach the reducer as summaries.
      emit(toolEvent("evt_b_1", tool("prt_b_1", "ses_b", "msg_b", "bash", "one"), 21))
      emit(toolEvent("evt_b_2", tool("prt_b_2", "ses_b", "msg_b", "read", "two"), 22))
      await wait(() => sync.data.summary.ses_b.toolCalls === 2)

      // While the stream was down ses_a ran more tools than the events show.
      messages.ses_a = [{ info: assistant("msg_ses_a", "ses_a"), parts: toolsFor("ses_a", 6) }]
      reconnect()
      await wait(() => sync.data.summary.ses_a.toolCalls === 6)

      expect(sync.data.summary.ses_a.current).toEqual({ tool: "bash", title: "step 5" })
      expect(sync.data.summary.ses_b.toolCalls).toBe(2)
      expect(sync.data.summary.ses_b.current).toEqual({ tool: "read", title: "two" })
    } finally {
      app.renderer.destroy()
    }
  })

  test("a snapshot of the whole history also corrects a count that is too high", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const messages: Loaded = {
      ses_a: [{ info: assistant("msg_ses_a", "ses_a"), parts: toolsFor("ses_a", 3) }],
    }
    const { app, reconnect, sync } = await mount(routesFor(rows, messages), tmp.path)

    try {
      await sync.session.activate("ses_a")
      expect(sync.data.summary.ses_a.toolCalls).toBe(3)

      // Two tool messages were reverted while the stream was down.
      messages.ses_a = [{ info: assistant("msg_ses_a", "ses_a"), parts: toolsFor("ses_a", 1) }]
      reconnect()
      await wait(() => sync.data.summary.ses_a.toolCalls === 1)
    } finally {
      app.renderer.destroy()
    }
  })
})

describe("a snapshot cut at the message limit", () => {
  const rows = [row("ses_long")]
  const window = (count: number): Loaded => ({
    ses_long: Array.from({ length: count }, (_, index) => ({
      info: { ...assistant(`msg_long_${String(index).padStart(3, "0")}`, "ses_long"), time: { created: 10 + index } },
      parts: [
        tool(`prt_long_${index}`, "ses_long", `msg_long_${String(index).padStart(3, "0")}`, "bash", `step ${index}`),
      ],
    })),
  })

  test("never lowers a count the events built up", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(routesFor(rows, window(100)), tmp.path)

    try {
      for (let index = 0; index < 150; index++) {
        emit(
          toolEvent(`evt_long_${index}`, tool(`prt_old_${index}`, "ses_long", "msg_old", "bash", "old"), 100 + index),
        )
      }
      await wait(() => sync.data.summary.ses_long.toolCalls === 150)

      await sync.session.sync("ses_long")
      expect(sync.data.message.ses_long).toHaveLength(100)
      expect(sync.data.summary.ses_long.toolCalls).toBe(150)

      // The tool parts the events counted lie outside the window, but they
      // stay known: an update of one is not a new tool call, a new part is.
      emit(toolEvent("evt_old_again", tool("prt_old_5", "ses_long", "msg_old", "bash", "old"), 400))
      emit(toolEvent("evt_fresh", tool("prt_fresh", "ses_long", "msg_fresh", "bash", "fresh"), 401))
      await wait(() => sync.data.summary.ses_long.toolCalls === 151)
    } finally {
      app.renderer.destroy()
    }
  })

  test("raises an unknown count to what the window shows", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, sync } = await mount(routesFor(rows, window(100)), tmp.path)

    try {
      expect(sync.data.summary.ses_long.toolCalls).toBeUndefined()
      await sync.session.sync("ses_long")
      expect(sync.data.summary.ses_long.toolCalls).toBe(100)
    } finally {
      app.renderer.destroy()
    }
  })
})
