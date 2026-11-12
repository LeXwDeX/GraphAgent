// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import type { Event, GlobalEvent } from "@graphagent/sdk"
import { HYDRATED_MAX } from "../../../../src/context/session-summary"
import { tmpdir } from "../../../fixture/fixture"
import { probeStoreWrites } from "../../../fixture/store-write-probe"
import { directory, json, mount, wait, worktree } from "./sync-fixture"

type Row = {
  id: string
  slug: string
  projectID: string
  directory: string
  version: string
  parentID?: string
  time: { created: number; updated: number }
}

function row(id: string, updated: number, parentID?: string): Row {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    directory,
    version: "test",
    parentID,
    time: { created: 0, updated },
  }
}

function message(id: string, sessionID: string) {
  return { id, sessionID, role: "user" as const, time: { created: 1 }, agent: "build" }
}

function textPart(id: string, sessionID: string, messageID: string, text: string) {
  return { id, sessionID, messageID, type: "text" as const, text }
}

function global(payload: GlobalEvent["payload"] | Record<string, unknown>): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return { directory, project: "proj_test", payload } as GlobalEvent
}

function sessionRoutes(rows: Row[], messages: Record<string, Array<{ info: unknown; parts: unknown[] }>>) {
  const byID = new Map(rows.map((item) => [item.id, item]))
  return (url: URL) => {
    if (url.pathname === "/session") return json(rows)
    if (url.pathname.startsWith("/dag/session/") && url.pathname.endsWith("/summary")) return json([])
    const match = url.pathname.match(/^\/session\/([^/]+)$/)
    if (match && byID.has(match[1])) return json(byID.get(match[1]))
    const messagesMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/)
    if (messagesMatch) return json(messages[messagesMatch[1]] ?? [])
    return undefined
  }
}

function reasoningPart(id: string, sessionID: string, messageID: string, text: string) {
  return { id, sessionID, messageID, type: "reasoning" as const, text, time: { start: 1 } }
}

/** Snapshot routes plus the todo and diff reads every hydration issues. */
function dataRoutes(rows: Row[], messages: Record<string, Array<{ info: unknown; parts: unknown[] }>>) {
  const base = sessionRoutes(rows, messages)
  return (url: URL) => {
    if (/^\/session\/[^/]+\/(todo|diff)$/.test(url.pathname)) return json([])
    return base(url)
  }
}

/** One message with one text part per session; the ids derive from the session id. */
function snapshots(rows: Row[]) {
  return Object.fromEntries(
    rows.map((item) => [
      item.id,
      [
        {
          info: message(`msg_${item.id}`, item.id),
          parts: [textPart(`prt_${item.id}`, item.id, `msg_${item.id}`, `text of ${item.id}`)],
        },
      ],
    ]),
  )
}

function sdkEvent(type: string, properties: Record<string, unknown>): Event {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: the gate reads only `type` and the opaque `properties` record.
  return { type, properties } as unknown as Event
}

let sequence = 0
function nextID() {
  return `evt_f1_${++sequence}`
}

describe("F1 data layer", () => {
  test("bootstrap fetches DAG summaries only for the newest root session tree", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const fetched: string[] = []
    const rows = [
      row("ses_root_new", 100),
      row("ses_new_child", 90, "ses_root_new"),
      row("ses_root_old", 50),
      row("ses_old_child", 40, "ses_root_old"),
    ]
    const routes = sessionRoutes(rows, {})
    const { app, sync } = await mount((url) => {
      const match = url.pathname.match(/^\/dag\/session\/([^/]+)\/summary$/)
      if (match) {
        fetched.push(match[1])
        return json([])
      }
      return routes(url)
    }, tmp.path)

    try {
      expect(sync.data.session.map((item) => item.id).toSorted()).toEqual([
        "ses_new_child",
        "ses_old_child",
        "ses_root_new",
        "ses_root_old",
      ])
      expect(fetched.toSorted()).toEqual(["ses_new_child", "ses_root_new"])
      expect(fetched).not.toContain("ses_root_old")
      expect(fetched).not.toContain("ses_old_child")
    } finally {
      app.renderer.destroy()
    }
  })

  test("activate registers interest before hydrating and fetches missing summaries lazily", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const fetched: string[] = []
    const rows = [
      row("ses_root_new", 100),
      row("ses_new_child", 90, "ses_root_new"),
      row("ses_root_old", 50),
      row("ses_old_child", 40, "ses_root_old"),
    ]
    const routes = sessionRoutes(rows, {
      ses_old_child: [{ info: message("msg_child", "ses_old_child"), parts: [] }],
    })
    let interestBeforeHydration = -1
    const { app, emit, interest, sync } = await mount((url) => {
      const match = url.pathname.match(/^\/dag\/session\/([^/]+)\/summary$/)
      if (match) {
        fetched.push(match[1])
        return json([])
      }
      if (url.pathname === "/session/ses_old_child/message")
        interestBeforeHydration = interest.filter((full) => full.includes("ses_old_child")).length
      return routes(url)
    }, tmp.path)

    try {
      fetched.length = 0
      await sync.session.activate("ses_old_child")

      expect(interestBeforeHydration).toBeGreaterThan(0)
      expect(interest.some((full) => full.includes("ses_old_child") && full.includes("ses_root_old"))).toBe(true)
      expect(sync.data.hydrated[0]).toBe("ses_old_child")
      expect(fetched.toSorted()).toEqual(["ses_old_child", "ses_root_old"])
      expect(fetched).not.toContain("ses_root_new")

      emit(
        global({
          id: "evt_old_child_message",
          type: "message.updated",
          properties: { sessionID: "ses_old_child", info: { ...message("msg_live", "ses_old_child"), id: "msg_live" } },
        }),
      )
      await wait(() => (sync.data.message.ses_old_child?.length ?? 0) === 2)
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps four hydrated sessions and evicts messages but not summaries", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const rows = Array.from({ length: 5 }, (_, index) => row(`ses_h${index + 1}`, 100 - index))
    const routes = sessionRoutes(
      rows,
      Object.fromEntries(rows.map((item) => [item.id, [{ info: message(`msg_${item.id}`, item.id), parts: [] }]])),
    )
    const { app, sync } = await mount(routes, tmp.path)

    try {
      for (const item of rows) await sync.session.sync(item.id)

      expect(sync.data.hydrated).toEqual(["ses_h5", "ses_h4", "ses_h3", "ses_h2"])
      expect(sync.data.message.ses_h1).toBeUndefined()
      expect(sync.data.message.ses_h2).toHaveLength(1)
      expect(sync.data.summary.ses_h1).toBeDefined()
      expect(sync.data.summary.ses_h5).toBeDefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("a deep parent chain is protected until the route is deactivated", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const rows = [
      row("ses_d1", 100),
      row("ses_d2", 99, "ses_d1"),
      row("ses_d3", 98, "ses_d2"),
      row("ses_d4", 97, "ses_d3"),
      row("ses_d5", 96, "ses_d4"),
      row("ses_d6", 95, "ses_d5"),
    ]
    const routes = sessionRoutes(
      rows,
      Object.fromEntries(rows.map((item) => [item.id, [{ info: message(`msg_${item.id}`, item.id), parts: [] }]])),
    )
    const { app, sync } = await mount(routes, tmp.path)

    try {
      await sync.session.activate("ses_d6")
      for (const id of ["ses_d5", "ses_d4", "ses_d3", "ses_d2", "ses_d1"]) await sync.session.sync(id)

      // The six-session chain plus the active session raises the LRU limit.
      expect(sync.data.hydrated).toHaveLength(6)
      expect(sync.data.hydrated).toContain("ses_d6")

      sync.session.deactivate()
      expect(sync.data.hydrated).toEqual(["ses_d1", "ses_d2", "ses_d3", "ses_d4"])
      expect(sync.data.message.ses_d5).toBeUndefined()
      expect(sync.data.message.ses_d6).toBeUndefined()
      expect(sync.data.summary.ses_d5).toBeDefined()
      expect(sync.data.summary.ses_d6).toBeDefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("summary events count tools and index Task children, deletion clears both", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const rows = [row("ses_parent", 100), row("ses_task_child", 90, "ses_parent")]
    const routes = sessionRoutes(rows, {})
    const { app, emit, sync } = await mount(routes, tmp.path)
    const toolPart = (id: string) => ({
      id,
      sessionID: "ses_parent",
      messageID: "msg_parent",
      type: "tool",
      tool: "task",
      callID: `call_${id}`,
      state: {
        status: "running",
        title: "Background child",
        input: { description: "do work", subagent_type: "general" },
        metadata: { sessionID: "ses_task_child", background: true },
      },
    })

    try {
      emit(
        global({
          id: "evt_task_1",
          type: "message.part.updated",
          properties: { sessionID: "ses_parent", time: 10, part: toolPart("prt_task_1") },
        }),
      )
      emit(
        global({
          id: "evt_task_1_again",
          type: "message.part.updated",
          properties: { sessionID: "ses_parent", time: 11, part: toolPart("prt_task_1") },
        }),
      )
      await wait(() => sync.data.summary.ses_parent?.toolCalls === 1)
      expect(sync.data.summary.ses_parent.current).toEqual({ tool: "task", title: "Background child" })
      expect(sync.data.taskIndex.ses_task_child).toMatchObject({
        parentSessionID: "ses_parent",
        partID: "prt_task_1",
        kind: "general",
        background: true,
      })

      emit(
        global({
          id: "evt_task_2",
          type: "message.part.updated",
          properties: { sessionID: "ses_parent", time: 12, part: toolPart("prt_task_2") },
        }),
      )
      await wait(() => sync.data.summary.ses_parent?.toolCalls === 2)

      emit(
        global({
          id: "evt_status",
          type: "session.status",
          properties: { sessionID: "ses_parent", status: { type: "idle" } },
        }),
      )
      await wait(() => sync.data.summary.ses_parent?.status === "idle")

      emit(
        global({
          id: "evt_deleted",
          type: "session.deleted",
          properties: { sessionID: "ses_task_child", info: rows[1] },
        }),
      )
      await wait(() => sync.data.summary.ses_task_child === undefined)
      expect(sync.data.taskIndex.ses_task_child).toBeUndefined()
      expect(sync.data.session.some((item) => item.id === "ses_task_child")).toBe(false)
    } finally {
      app.renderer.destroy()
    }
  })

  test("reconnect fans out to every resync handler exactly once", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, reconnect, sync } = await mount(sessionRoutes([row("ses_a", 100)], {}), tmp.path)

    try {
      let first = 0
      let second = 0
      const off = sync.onResync(() => {
        first++
      })
      sync.onResync(async () => {
        second++
      })

      reconnect()
      await wait(() => first === 1 && second === 1)

      off()
      reconnect()
      await wait(() => second === 2)
      expect(first).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("reconnect clears un-settled deltas and re-hydrates visible sessions", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let messageFetches = 0
    const rows = [row("ses_live", 100)]
    const routes = sessionRoutes(rows, {
      ses_live: [{ info: message("msg_live", "ses_live"), parts: [textPart("prt_live", "ses_live", "msg_live", "")] }],
    })
    const { app, emit, reconnect, sync } = await mount((url) => {
      if (url.pathname === "/session/ses_live/message") messageFetches++
      return routes(url)
    }, tmp.path)

    try {
      await sync.session.activate("ses_live")
      expect(messageFetches).toBe(1)

      emit(
        global({
          id: "evt_delta",
          type: "message.part.delta",
          properties: {
            sessionID: "ses_live",
            messageID: "msg_live",
            partID: "prt_live",
            field: "text",
            delta: "streamed",
          },
        }),
      )
      const part = sync.data.part.msg_live[0]
      await wait(() => sync.readPartText(part) === "streamed")

      reconnect()
      // The buffer drops synchronously; the snapshot re-fetch happens after.
      expect(sync.readPartText(part)).toBe("")
      await wait(() => messageFetches === 2)
      expect(sync.readPartText(sync.data.part.msg_live[0])).toBe("")
    } finally {
      app.renderer.destroy()
    }
  })

  test("running preview tails replace tool output until the durable part settles", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const rows = [row("ses_preview", 100)]
    const toolPart = (output: string) => ({
      id: "prt_preview",
      sessionID: "ses_preview",
      messageID: "msg_preview",
      type: "tool" as const,
      tool: "bash",
      callID: "call_preview",
      state: { status: "running" as const, title: "bash", input: {}, metadata: { output } },
    })
    const routes = sessionRoutes(rows, {
      ses_preview: [{ info: message("msg_preview", "ses_preview"), parts: [toolPart("")] }],
    })
    const { app, emit, sync } = await mount(routes, tmp.path)
    const tool = () => {
      const part = sync.data.part.msg_preview?.[0]
      return part?.type === "tool" ? part : undefined
    }
    const output = () => {
      const part = tool()
      if (!part || (part.state.status !== "running" && part.state.status !== "completed")) return ""
      return String(part.state.metadata?.output ?? "")
    }

    try {
      await sync.session.activate("ses_preview")
      emit(
        global({
          id: "evt_preview_1",
          type: "message.part.preview",
          properties: {
            sessionID: "ses_preview",
            messageID: "msg_preview",
            partID: "prt_preview",
            tail: "line 1\n",
            totalLength: 7,
            seq: 1,
          },
        }),
      )
      await wait(() => output() === "line 1\n")
      const running = tool()
      if (running?.state.status !== "running") throw new Error("expected a running tool part")
      expect(running.state.metadata?.previewTotalLength).toBe(7)

      emit(
        global({
          id: "evt_preview_done",
          type: "message.part.updated",
          properties: {
            sessionID: "ses_preview",
            time: 2,
            part: {
              ...toolPart("line 1\nline 2\n"),
              state: {
                status: "completed",
                title: "bash",
                input: {},
                output: "line 1\nline 2\n",
                metadata: { output: "line 1\nline 2\n" },
                time: { start: 0, end: 1 },
              },
            },
          },
        }),
      )
      await wait(() => tool()?.state.status === "completed")
      const settled = tool()
      if (settled?.state.status !== "completed") throw new Error("expected a completed tool part")
      expect(output()).toBe("line 1\nline 2\n")
      expect(settled.state.metadata?.previewTotalLength).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("bootstrap fills the @alias reference list from the sync store", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const reference = {
      name: "README.md",
      path: "README.md",
      description: "Project readme",
      source: { type: "local" as const, path: "README.md" },
    }
    const routes = sessionRoutes([row("ses_a", 100)], {})
    const { app, sync } = await mount((url) => {
      if (url.pathname === "/reference") return json([reference])
      return routes(url)
    }, tmp.path)

    try {
      await wait(() => sync.data.reference.length === 1)
      expect(sync.data.reference[0]).toMatchObject({ name: "README.md", path: "README.md" })
    } finally {
      app.renderer.destroy()
    }
  })
})

describe("F1 event gate in the sync store", () => {
  test("events for a session outside the full set write nothing and reach no subscriber", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const rows = [row("ses_full", 100), row("ses_other", 90)]
    const { app, emit, sdk, sync } = await mount(dataRoutes(rows, snapshots(rows)), tmp.path)
    const delivered: string[] = []
    const summarized: string[] = []
    const stopDelivered = sdk.event.on("event", (evt) => delivered.push(evt.payload.type))
    const stopSummarized = sdk.event.onSummary((evt) => summarized.push(evt.payload.type))
    const send = (type: string, properties: Record<string, unknown>) => emit(global({ id: nextID(), type, properties }))

    try {
      await sync.session.activate("ses_full")
      expect(sync.interest.full().has("ses_full")).toBe(true)
      expect(sync.interest.full().has("ses_other")).toBe(false)
      const probe = probeStoreWrites(sync.data, ["message", "part", "todo", "session_diff", "dag", "goal"])
      delivered.length = 0
      summarized.length = 0

      const other = "ses_other"
      send("message.updated", { sessionID: other, info: message("msg_other", other) })
      send("message.part.updated", {
        sessionID: other,
        time: 1,
        part: textPart("prt_other_text", other, "msg_other", "answer"),
      })
      send("message.part.updated", {
        sessionID: other,
        time: 2,
        part: reasoningPart("prt_other_reasoning", other, "msg_other", "thinking"),
      })
      send("message.part.delta", {
        sessionID: other,
        messageID: "msg_other",
        partID: "prt_other_text",
        field: "text",
        delta: "more",
      })
      send("message.part.preview", {
        sessionID: other,
        messageID: "msg_other",
        partID: "prt_other_tool",
        tail: "output",
        totalLength: 6,
        seq: 1,
      })
      send("message.part.removed", { sessionID: other, messageID: "msg_other", partID: "prt_other_text" })
      send("message.removed", { sessionID: other, messageID: "msg_other" })
      send("todo.updated", { sessionID: other, todos: [{ content: "write", status: "pending", priority: "high" }] })
      send("session.diff", { sessionID: other, diff: [{ file: "a.ts", additions: 1, deletions: 0 }] })
      send("session.hook.status", { sessionID: other, hookID: "hook_1", event: "PreToolUse", phase: "started" })
      send("session.hook.terminal", { sessionID: other, hookID: "hook_1", data: "x" })
      send("session.hook.message", { sessionID: other, hookID: "hook_1", message: "hello" })
      send("dag.workflow.nodes.updated", { sessionID: other, workflowID: "wf_1", nodes: [] })
      // A tool part is the one session-full shape that still reaches the summary reducer.
      send("message.part.updated", {
        sessionID: other,
        time: 3,
        part: {
          id: "prt_other_tool",
          sessionID: other,
          messageID: "msg_other",
          type: "tool",
          tool: "bash",
          callID: "call_other",
          state: { status: "running", title: "ls", input: { command: "ls" } },
        },
      })
      // The sentinel proves the queue ran to its end, so the zero counts below are not vacuous.
      send("vcs.branch.updated", { branch: "sentinel" })
      sdk.frameClock.flushNow()

      expect(delivered).toEqual(["vcs.branch.updated"])
      expect(summarized).toEqual(["message.part.updated"])
      expect(probe.total()).toBe(0)
      expect(sync.data.message[other]).toBeUndefined()
      expect(sync.data.part.msg_other).toBeUndefined()
      expect(sync.data.todo[other]).toBeUndefined()
      expect(sync.data.session_diff[other]).toBeUndefined()
      expect(sync.data.summary[other]?.toolCalls).toBe(1)
      expect(sync.data.hydrated).toEqual(["ses_full"])

      // Control: the same event kinds for a session in the full set do write, so the probe is live.
      delivered.length = 0
      summarized.length = 0
      send("todo.updated", { sessionID: "ses_full", todos: [{ content: "ship", status: "pending", priority: "low" }] })
      send("session.diff", { sessionID: "ses_full", diff: [{ file: "b.ts", additions: 2, deletions: 1 }] })
      send("message.part.updated", {
        sessionID: "ses_full",
        time: 4,
        part: textPart("prt_ses_full", "ses_full", "msg_ses_full", "rewritten"),
      })
      send("session.hook.status", { sessionID: "ses_full", hookID: "hook_2", event: "PreToolUse", phase: "started" })
      send("dag.workflow.nodes.updated", { sessionID: "ses_full", workflowID: "wf_2", nodes: [] })
      sdk.frameClock.flushNow()

      expect(delivered).toEqual([
        "todo.updated",
        "session.diff",
        "message.part.updated",
        "session.hook.status",
        "dag.workflow.nodes.updated",
      ])
      expect(summarized).toEqual([])
      expect(probe.writes("todo")).toBe(1)
      expect(probe.writes("session_diff")).toBe(1)
      expect(probe.writes("part")).toBe(1)
      expect(probe.writes("message")).toBe(0)
      expect(sync.data.todo.ses_full).toHaveLength(1)
      expect(sync.data.session_diff.ses_full).toHaveLength(1)
      expect(sync.data.part.msg_ses_full[0]).toMatchObject({ text: "rewritten" })
      probe.dispose()
    } finally {
      stopDelivered()
      stopSummarized()
      app.renderer.destroy()
    }
  })

  test("a frame of 100 part updates writes store.part in a single batch", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const rows = [row("ses_batch", 100)]
    const { app, emit, sdk, sync } = await mount(
      dataRoutes(rows, { ses_batch: [{ info: message("msg_batch", "ses_batch"), parts: [] }] }),
      tmp.path,
    )
    const insert = (from: number) => {
      for (let index = from; index < from + 100; index++) {
        const id = `prt_${String(index).padStart(3, "0")}`
        emit(
          global({
            id: nextID(),
            type: "message.part.updated",
            properties: { sessionID: "ses_batch", time: index, part: textPart(id, "ses_batch", "msg_batch", id) },
          }),
        )
      }
    }

    try {
      await sync.session.activate("ses_batch")
      const probe = probeStoreWrites(sync.data, ["part"])

      insert(0)
      expect(sync.data.part.msg_batch).toHaveLength(0)
      sdk.frameClock.flushNow()
      expect(sync.data.part.msg_batch).toHaveLength(100)
      // 100 events, one batch: the message's parts changed once, not 100 times.
      expect(probe.writes("part")).toBe(1)

      insert(100)
      sdk.frameClock.flushNow()
      expect(sync.data.part.msg_batch).toHaveLength(200)
      expect(probe.writes("part")).toBe(2)
      probe.dispose()
    } finally {
      app.renderer.destroy()
    }
  })

  test("a pending ask puts its session into the full set until it is answered, and hydrates it once", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const rows = [row("ses_root", 100), row("ses_asker", 90, "ses_root")]
    const base = dataRoutes(rows, snapshots(rows))
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let fetches = 0
    const { app, emit, sdk, sync } = await mount(async (url) => {
      if (url.pathname === "/session/ses_asker/message") {
        fetches++
        await held
      }
      return base(url)
    }, tmp.path)
    const delta = sdkEvent("message.part.delta", {
      sessionID: "ses_asker",
      messageID: "msg_ses_asker",
      partID: "prt_ses_asker",
      field: "text",
      delta: "x",
    })

    try {
      await sync.session.activate("ses_root")
      expect(sync.interest.full().has("ses_asker")).toBe(false)
      expect(sdk.decide(delta)).toBe("drop")

      emit(
        global({
          id: nextID(),
          type: "permission.asked",
          properties: { id: "per_1", sessionID: "ses_asker", permission: "bash", patterns: ["ls"], metadata: {} },
        }),
      )
      // Permission prompts bypass the frame, so the request and the gate already reflect it.
      expect(sync.data.permission.ses_asker).toHaveLength(1)
      expect(sync.interest.full().has("ses_asker")).toBe(true)
      // The worker owns the explicit set; the pending ask is what lets the events through.
      expect(sync.interest.explicit().has("ses_asker")).toBe(false)
      expect(sdk.decide(delta)).toBe("deliver")
      await wait(() => fetches === 1)
      expect(sync.data.hydrated).not.toContain("ses_asker")

      emit(
        global({
          id: nextID(),
          type: "permission.replied",
          properties: { sessionID: "ses_asker", requestID: "per_1", reply: "once" },
        }),
      )
      expect(sync.data.permission.ses_asker ?? []).toHaveLength(0)
      expect(sync.interest.full().has("ses_asker")).toBe(false)
      expect(sdk.decide(delta)).toBe("drop")

      // The snapshot requested for the ask still lands, and the hydrated session stays in the full set.
      release()
      await wait(() => sync.data.hydrated.includes("ses_asker"))
      expect(fetches).toBe(1)
      expect(sync.data.message.ses_asker).toHaveLength(1)
      expect(sync.data.part.msg_ses_asker[0]).toMatchObject({ text: "text of ses_asker" })
      expect(sync.interest.explicit().has("ses_asker")).toBe(true)
      expect(sdk.decide(delta)).toBe("deliver")
    } finally {
      release()
      app.renderer.destroy()
    }
  })

  test("asks hydrate a known session once and never fetch a session the store does not know", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const rows = [row("ses_root", 100), row("ses_asker", 90, "ses_root")]
    const base = dataRoutes(rows, snapshots(rows))
    const fetched: string[] = []
    const { app, emit, sdk, sync } = await mount((url) => {
      const match = url.pathname.match(/^\/session\/([^/]+)\/message$/)
      if (match) fetched.push(match[1])
      return base(url)
    }, tmp.path)

    try {
      await sync.session.activate("ses_root")
      fetched.length = 0

      emit(
        global({
          id: nextID(),
          type: "question.asked",
          properties: { id: "que_1", sessionID: "ses_asker", questions: [] },
        }),
      )
      await wait(() => sync.data.hydrated.includes("ses_asker"))
      expect(fetched).toEqual(["ses_asker"])
      expect(sync.data.question.ses_asker).toHaveLength(1)

      // A second ask for a session that already has its snapshot does not fetch again.
      emit(
        global({
          id: nextID(),
          type: "question.asked",
          properties: { id: "que_2", sessionID: "ses_asker", questions: [] },
        }),
      )
      sdk.frameClock.flushNow()
      expect(sync.data.question.ses_asker).toHaveLength(2)

      // An ask from a session missing from the session list is stored but never hydrated.
      emit(
        global({
          id: nextID(),
          type: "permission.asked",
          properties: { id: "per_9", sessionID: "ses_unknown", permission: "bash", patterns: [], metadata: {} },
        }),
      )
      sdk.frameClock.flushNow()
      await Bun.sleep(50)
      expect(sync.data.permission.ses_unknown).toHaveLength(1)
      expect(sync.interest.full().has("ses_unknown")).toBe(true)
      expect(fetched).toEqual(["ses_asker"])
    } finally {
      app.renderer.destroy()
    }
  })
})

describe("F1 streaming buffer in the sync store", () => {
  test("1000 deltas never write store.part; the terminal update writes once and readPartText joins them", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const rows = [row("ses_stream", 100)]
    const routes = dataRoutes(rows, {
      ses_stream: [
        {
          info: message("msg_stream", "ses_stream"),
          parts: [
            textPart("prt_a_text", "ses_stream", "msg_stream", ""),
            reasoningPart("prt_b_reasoning", "ses_stream", "msg_stream", ""),
          ],
        },
      ],
    })
    const { app, emit, sdk, sync } = await mount(routes, tmp.path)
    const delta = (partID: string, field: "text" | "reasoning", text: string) =>
      emit(
        global({
          id: nextID(),
          type: "message.part.delta",
          properties: { sessionID: "ses_stream", messageID: "msg_stream", partID, field, delta: text },
        }),
      )

    try {
      await sync.session.activate("ses_stream")
      const text = sync.data.part.msg_stream[0]
      const reasoning = sync.data.part.msg_stream[1]
      const probe = probeStoreWrites(sync.data, ["part", "message"])
      const version = sync.streamVersion

      const answer = Array.from({ length: 1000 }, (_, index) => `a${index} `).join("")
      const thought = Array.from({ length: 1000 }, (_, index) => `r${index} `).join("")
      for (let index = 0; index < 1000; index++) {
        delta("prt_a_text", "text", `a${index} `)
        delta("prt_b_reasoning", "reasoning", `r${index} `)
      }
      sdk.frameClock.flushNow()

      expect(probe.writes("part")).toBe(0)
      expect(probe.writes("message")).toBe(0)
      // The store still holds the snapshot; the views read snapshot plus buffer.
      expect(text).toMatchObject({ text: "" })
      expect(reasoning).toMatchObject({ text: "" })
      expect(sync.readPartText(text)).toBe(answer)
      expect(sync.readPartText(reasoning)).toBe(thought)
      // 2000 deltas, one frame: the version a view subscribes to moved once.
      expect(sync.streamVersion).toBe(version + 1)

      delta("prt_a_text", "text", "tail")
      sdk.frameClock.flushNow()
      expect(sync.streamVersion).toBe(version + 2)
      expect(sync.readPartText(text)).toBe(`${answer}tail`)
      expect(probe.writes("part")).toBe(0)

      // The terminal snapshot is the only store write, and it replaces the buffered deltas.
      const final = `${answer}tail.`
      emit(
        global({
          id: nextID(),
          type: "message.part.updated",
          properties: {
            sessionID: "ses_stream",
            time: 5,
            part: { ...textPart("prt_a_text", "ses_stream", "msg_stream", final), time: { start: 1, end: 2 } },
          },
        }),
      )
      sdk.frameClock.flushNow()
      expect(probe.writes("part")).toBe(1)
      expect(sync.data.part.msg_stream[0]).toMatchObject({ text: final })
      expect(sync.readPartText(text)).toBe(final)
      // The other part kept streaming on its own buffer.
      expect(sync.readPartText(reasoning)).toBe(thought)
      probe.dispose()
    } finally {
      app.renderer.destroy()
    }
  })

  test("a delta that arrives before its part snapshot is dropped, not replayed onto it", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const rows = [row("ses_order", 100)]
    const { app, emit, sdk, sync } = await mount(
      dataRoutes(rows, { ses_order: [{ info: message("msg_order", "ses_order"), parts: [] }] }),
      tmp.path,
    )

    try {
      await sync.session.activate("ses_order")
      const probe = probeStoreWrites(sync.data, ["part"])
      emit(
        global({
          id: nextID(),
          type: "message.part.delta",
          properties: {
            sessionID: "ses_order",
            messageID: "msg_order",
            partID: "prt_late",
            field: "text",
            delta: "orphan",
          },
        }),
      )
      sdk.frameClock.flushNow()
      expect(probe.writes("part")).toBe(0)

      emit(
        global({
          id: nextID(),
          type: "message.part.updated",
          properties: {
            sessionID: "ses_order",
            time: 1,
            part: textPart("prt_late", "ses_order", "msg_order", "snapshot"),
          },
        }),
      )
      sdk.frameClock.flushNow()
      expect(probe.writes("part")).toBe(1)
      expect(sync.readPartText(sync.data.part.msg_order[0])).toBe("snapshot")
      probe.dispose()
    } finally {
      app.renderer.destroy()
    }
  })
})

describe("F1 hydrated LRU through activate", () => {
  test("ten consecutive activations stay within the base limit and evict messages but not summaries", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const rows = Array.from({ length: 10 }, (_, index) =>
      row(`ses_n${String(index + 1).padStart(2, "0")}`, 100 - index),
    )
    const { app, interest, sync } = await mount(dataRoutes(rows, snapshots(rows)), tmp.path)

    try {
      const visited: string[] = []
      for (const item of rows) {
        await sync.session.activate(item.id)
        visited.push(item.id)
        // A root session has a parent chain of one, so the base limit applies.
        expect(sync.data.hydrated.length).toBeLessThanOrEqual(Math.max(HYDRATED_MAX, 1 + 1))
        expect(sync.data.hydrated[0]).toBe(item.id)
      }

      const kept = visited.slice(-HYDRATED_MAX).toReversed()
      expect(sync.data.hydrated).toEqual(kept)
      for (const id of visited.slice(0, -HYDRATED_MAX)) {
        expect(sync.data.message[id], id).toBeUndefined()
        expect(sync.data.part[`msg_${id}`], id).toBeUndefined()
        expect(sync.data.summary[id], id).toBeDefined()
      }
      for (const id of kept) {
        expect(sync.data.message[id], id).toHaveLength(1)
        expect(sync.data.part[`msg_${id}`], id).toHaveLength(1)
      }
      // The interest set mirrors the cache: an evicted session stops receiving full events.
      const expected = JSON.stringify(kept.toSorted())
      await wait(() => JSON.stringify(interest.at(-1)) === expected)
    } finally {
      app.renderer.destroy()
    }
  })

  const deepChain = ["ses_d1", "ses_d2", "ses_d3", "ses_d4", "ses_d5", "ses_d6"]
  const deepRows = () => [
    ...deepChain.map((id, index) => row(id, 100 - index, index === 0 ? undefined : deepChain[index - 1])),
    row("ses_e1", 90),
    row("ses_e2", 89),
    row("ses_e3", 88),
    row("ses_e4", 87),
  ]

  // Hydrates the whole chain, then four outsiders while the route stays on the leaf, the way
  // ask-driven hydration does when a sibling session raises a permission prompt.
  async function hydrateDeepChainWithOutsiders(sync: Awaited<ReturnType<typeof mount>>["sync"]) {
    await sync.session.activate("ses_d6")
    for (const id of ["ses_d5", "ses_d4", "ses_d3", "ses_d2", "ses_d1"]) await sync.session.sync(id)
    for (const id of ["ses_e1", "ses_e2", "ses_e3", "ses_e4"]) await sync.session.sync(id)
  }

  test("a depth-6 route chain is never evicted while other sessions hydrate", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const rows = deepRows()
    const { app, sync } = await mount(dataRoutes(rows, snapshots(rows)), tmp.path)

    try {
      await hydrateDeepChainWithOutsiders(sync)

      for (const id of deepChain) {
        expect(sync.data.hydrated, id).toContain(id)
        expect(sync.data.message[id], id).toHaveLength(1)
        expect(sync.data.part[`msg_${id}`], id).toHaveLength(1)
      }
    } finally {
      app.renderer.destroy()
    }
  })

  // Spec (#886 5.4): the limit is max(HYDRATED_MAX, chain length + 1) and the chain is never
  // evicted. Outsiders newer than the chain must not push the total past the limit: protected
  // sessions take their slots first, wherever they sit in the LRU order.
  test(
    "hydrated stays within max(HYDRATED_MAX, chain length + 1) while outsiders hydrate during a deep-chain route",
    async () => {
      await using tmp = await tmpdir()
      await Bun.write(`${tmp.path}/kv.json`, "{}")
      const rows = deepRows()
      const { app, sync } = await mount(dataRoutes(rows, snapshots(rows)), tmp.path)

      try {
        await hydrateDeepChainWithOutsiders(sync)

        expect(sync.data.hydrated.length).toBeLessThanOrEqual(Math.max(HYDRATED_MAX, deepChain.length + 1))
        for (const id of deepChain) expect(sync.data.hydrated, id).toContain(id)
      } finally {
        app.renderer.destroy()
      }
    },
  )
})

describe("F1 session deletion", () => {
  test("session.deleted clears messages, parts, summary, asks and the hydrated entry of a hydrated session", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const rows = [row("ses_keep", 100), row("ses_gone", 90)]
    const { app, emit, interest, sdk, sync } = await mount(dataRoutes(rows, snapshots(rows)), tmp.path)

    try {
      await sync.session.activate("ses_keep")
      await sync.session.sync("ses_gone")
      expect(sync.data.hydrated).toEqual(["ses_gone", "ses_keep"])

      // Leave a streaming buffer and a pending ask behind on the doomed session.
      const gonePart = sync.data.part.msg_ses_gone[0]
      emit(
        global({
          id: nextID(),
          type: "message.part.delta",
          properties: {
            sessionID: "ses_gone",
            messageID: "msg_ses_gone",
            partID: "prt_ses_gone",
            field: "text",
            delta: " streamed",
          },
        }),
      )
      emit(
        global({
          id: nextID(),
          type: "permission.asked",
          properties: { id: "per_gone", sessionID: "ses_gone", permission: "bash", patterns: [], metadata: {} },
        }),
      )
      sdk.frameClock.flushNow()
      expect(sync.readPartText(gonePart)).toBe("text of ses_gone streamed")
      expect(sync.data.permission.ses_gone).toHaveLength(1)
      expect(sync.data.summary.ses_gone).toBeDefined()

      emit(
        global({
          id: nextID(),
          type: "session.deleted",
          properties: { sessionID: "ses_gone", info: rows[1] },
        }),
      )
      sdk.frameClock.flushNow()

      expect(sync.data.message.ses_gone).toBeUndefined()
      expect(sync.data.part.msg_ses_gone).toBeUndefined()
      expect(sync.data.summary.ses_gone).toBeUndefined()
      expect(sync.data.permission.ses_gone).toBeUndefined()
      expect(sync.data.hydrated).toEqual(["ses_keep"])
      expect(sync.data.session.some((item) => item.id === "ses_gone")).toBe(false)
      // The buffered delta went with the session, and the survivor is untouched.
      expect(sync.readPartText(gonePart)).toBe("text of ses_gone")
      expect(sync.interest.full().has("ses_gone")).toBe(false)
      expect(sync.data.message.ses_keep).toHaveLength(1)
      expect(sync.data.summary.ses_keep).toBeDefined()
      await wait(() => JSON.stringify(interest.at(-1)) === JSON.stringify(["ses_keep"]))
    } finally {
      app.renderer.destroy()
    }
  })
})
