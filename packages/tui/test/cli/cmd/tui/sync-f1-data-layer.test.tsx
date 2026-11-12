// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import type { GlobalEvent } from "@graphagent/sdk"
import { tmpdir } from "../../../fixture/fixture"
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
