// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import type { AssistantMessage, GlobalEvent, ToolPart } from "@graphagent/sdk"
import { tmpdir } from "../../../fixture/fixture"
import { mountSessionMain, waitForFrame } from "../../../fixture/session-main"
import { probeStoreWrites } from "../../../fixture/store-write-probe"
import { directory, json, mount } from "./sync-fixture"

// #886 5.3 / acceptance "preview events": the running output window of a tool
// part replaces itself inside the stream buffer. `store.part` is not written
// while it runs; the durable snapshot that ends the run settles the buffer.
//
// Events reach the store when a test flushes the frame clock, so every
// assertion below sees exactly the events emitted before it.

const sessionID = "ses_preview"
const messageID = "msg_preview"
const partID = "prt_preview"

function row(id: string) {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    directory,
    version: "test",
    time: { created: 1, updated: 2 },
  }
}

function toolPart(status: "running" | "completed", output: string, extra: Record<string, unknown> = {}) {
  return {
    id: partID,
    sessionID,
    messageID,
    type: "tool" as const,
    tool: "bash",
    callID: "call_preview",
    state:
      status === "running"
        ? { status, title: "bash", input: { command: "seq 1 100" }, metadata: { output, ...extra }, time: { start: 1 } }
        : {
            status,
            title: "bash",
            input: { command: "seq 1 100" },
            output,
            metadata: { output, ...extra },
            time: { start: 1, end: 2 },
          },
  }
}

function global(payload: Record<string, unknown>): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return { directory, project: "proj_test", payload } as GlobalEvent
}

function preview(seq: number, tail: string, totalLength = tail.length, id = partID) {
  return global({
    id: `evt_preview_${id}_${seq}`,
    type: "message.part.preview",
    properties: { sessionID, messageID, partID: id, tail, totalLength, seq },
  })
}

function partUpdated(part: ReturnType<typeof toolPart>, id: string) {
  return global({ id, type: "message.part.updated", properties: { sessionID, time: 3, part } })
}

async function mountPreview(tmpPath: string) {
  const routes = (url: URL) => {
    if (url.pathname === "/session") return json([row(sessionID)])
    if (url.pathname === `/session/${sessionID}`) return json(row(sessionID))
    if (url.pathname === `/session/${sessionID}/message`)
      return json([
        {
          info: { id: messageID, sessionID, role: "user", time: { created: 1 }, agent: "build" },
          parts: [toolPart("running", "")],
        },
      ])
    if (url.pathname.startsWith("/dag/session/")) return json([])
    return undefined
  }
  const mounted = await mount(routes, tmpPath)
  await mounted.sync.session.activate(sessionID)
  const part = () => mounted.sync.data.part[messageID]?.[0]
  const status = () => {
    const current = part()
    return current?.type === "tool" ? current.state.status : undefined
  }
  /** Delivers everything emitted so far to the store. */
  const deliver = () => mounted.sdk.frameClock.flushNow()
  return { ...mounted, part, status, deliver }
}

describe("preview events use the stream buffer", () => {
  test("100 previews in one frame keep only the latest window and write no store.part", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, deliver, emit, part, sync } = await mountPreview(tmp.path)
    const probe = probeStoreWrites(sync.data, ["part"])

    try {
      const running = part()
      if (!running) throw new Error("expected the hydrated tool part")
      for (let seq = 1; seq <= 100; seq++) emit(preview(seq, `tail ${seq}`, seq * 10))
      deliver()

      expect(sync.readPartPreview(running)).toEqual({ tail: "tail 100", totalLength: 1000, seq: 100 })
      expect(probe.writes("part")).toBe(0)
      // The snapshot in the store is what it was before the first preview.
      expect(part()).toEqual(toolPart("running", ""))
    } finally {
      probe.dispose()
      app.renderer.destroy()
    }
  })

  test("a window with a lower or equal seq does not replace a newer one", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, deliver, emit, part, sync } = await mountPreview(tmp.path)

    try {
      const running = part()
      if (!running) throw new Error("expected the hydrated tool part")
      emit(preview(5, "newest"))
      deliver()
      expect(sync.readPartPreview(running)?.seq).toBe(5)

      emit(preview(3, "older"))
      emit(preview(5, "repeat"))
      deliver()
      expect(sync.readPartPreview(running)).toEqual({ tail: "newest", totalLength: 6, seq: 5 })

      emit(preview(6, "sentinel"))
      deliver()
      expect(sync.readPartPreview(running)).toEqual({ tail: "sentinel", totalLength: 8, seq: 6 })

      // Reordered delivery after the sentinel: ignored, the window stays put.
      emit(preview(2, "late"))
      deliver()
      expect(sync.readPartPreview(running)).toEqual({ tail: "sentinel", totalLength: 8, seq: 6 })
    } finally {
      app.renderer.destroy()
    }
  })

  test("the durable snapshot that ends the run settles the buffer with one store.part write", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, deliver, emit, part, status, sync } = await mountPreview(tmp.path)

    try {
      const running = part()
      if (!running) throw new Error("expected the hydrated tool part")
      emit(preview(1, "partial\n", 8))
      deliver()
      expect(sync.readPartPreview(running)?.seq).toBe(1)

      const probe = probeStoreWrites(sync.data, ["part"])
      emit(partUpdated(toolPart("completed", "partial\ndone\n"), "evt_preview_done"))
      deliver()
      expect(status()).toBe("completed")
      const settled = part()
      if (!settled) throw new Error("expected the settled tool part")

      expect(sync.readPartPreview(settled)).toBeUndefined()
      expect(settled.type === "tool" && settled.state.status === "completed" && settled.state.output).toBe(
        "partial\ndone\n",
      )
      expect(probe.writes("part")).toBe(1)
      probe.dispose()
    } finally {
      app.renderer.destroy()
    }
  })

  test("a durable snapshot of a part that is still running also settles the window", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, deliver, emit, part, sync } = await mountPreview(tmp.path)

    try {
      const running = part()
      if (!running) throw new Error("expected the hydrated tool part")
      emit(preview(1, "window", 6))
      deliver()
      expect(sync.readPartPreview(running)?.seq).toBe(1)

      emit(partUpdated(toolPart("running", "snapshot output", { phase: "second" }), "evt_preview_running"))
      deliver()
      const next = part()
      if (!next) throw new Error("expected the running tool part")
      expect(sync.readPartPreview(next)).toBeUndefined()
      expect(next.type === "tool" && next.state.status === "running" && next.state.metadata?.output).toBe(
        "snapshot output",
      )
    } finally {
      app.renderer.destroy()
    }
  })

  test("previews for a settled part or for a part the store does not know create no window", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, deliver, emit, part, status, sync } = await mountPreview(tmp.path)

    try {
      emit(partUpdated(toolPart("completed", "all done"), "evt_preview_finished"))
      deliver()
      expect(status()).toBe("completed")
      const settled = part()
      if (!settled) throw new Error("expected the settled tool part")

      emit(preview(1, "too late"))
      // A window for an unknown part id: no identity to read it back against.
      emit(preview(1, "orphan", 6, "prt_unknown"))
      deliver()

      expect(sync.readPartPreview(settled)).toBeUndefined()
      expect(sync.readPartPreview({ ...toolPart("running", ""), id: "prt_unknown" })).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("a reconnect drops the windows together with the un-settled deltas", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, deliver, emit, part, reconnect, sync } = await mountPreview(tmp.path)

    try {
      const running = part()
      if (!running) throw new Error("expected the hydrated tool part")
      emit(preview(1, "before the drop"))
      deliver()
      expect(sync.readPartPreview(running)?.seq).toBe(1)

      reconnect()
      expect(sync.readPartPreview(running)).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })
})

describe("bash block renders the buffered preview", () => {
  const id = "ses_bash_view"
  const bashMessageID = "msg_bash_view"
  const bashPartID = "prt_bash_view"
  const session = {
    id,
    title: "Bash preview",
    slug: "bash-preview",
    projectID: "proj_test",
    time: { created: 1, updated: 20 },
    version: "test",
    directory,
  }
  const assistant: AssistantMessage = {
    id: bashMessageID,
    sessionID: id,
    parentID: "msg_bash_user",
    role: "assistant",
    agent: "build",
    mode: "build",
    modelID: "test-model",
    providerID: "test",
    path: { cwd: directory, root: directory },
    time: { created: 10 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const bash = (state: ToolPart["state"]): ToolPart => ({
    id: bashPartID,
    sessionID: id,
    messageID: bashMessageID,
    type: "tool",
    tool: "bash",
    callID: "call_bash_view",
    state,
  })
  const running = bash({
    status: "running",
    input: { command: "tail -f build.log" },
    title: "tail -f build.log",
    time: { start: 10 },
    metadata: { output: "" },
  })

  test("the latest window replaces the earlier one, the durable output replaces the window", async () => {
    const view = await mountSessionMain({
      sessionID: id,
      fetch: (url) => {
        if (url.pathname === "/session") return json([session])
        if (url.pathname === `/session/${id}`) return json(session)
        if (url.pathname === `/session/${id}/message`) return json([{ info: assistant, parts: [running] }])
        if (url.pathname === `/session/${id}/todo` || url.pathname === `/session/${id}/diff`) return json([])
        if (url.pathname === `/session/${id}/goal`) return json(undefined)
        return undefined
      },
    })

    try {
      await waitForFrame(view, "tail -f build.log")
      const hydrated = view.sync.data.part[bashMessageID]?.[0]
      const beforeWrite = JSON.stringify(hydrated)

      const previewEvent = (seq: number, tail: string) =>
        global({
          id: `evt_bash_preview_${seq}`,
          type: "message.part.preview",
          properties: {
            sessionID: id,
            messageID: bashMessageID,
            partID: bashPartID,
            tail,
            totalLength: tail.length,
            seq,
          },
        })
      view.events.emit(previewEvent(1, "compiling alpha"))
      const first = await waitForFrame(view, "compiling alpha")
      expect(first).toContain("tail -f build.log")

      view.events.emit(previewEvent(2, "compiling beta"))
      const second = await waitForFrame(view, "compiling beta")
      expect(second).not.toContain("compiling alpha")
      // Nothing was written to the store while the output streamed in.
      expect(JSON.stringify(view.sync.data.part[bashMessageID]?.[0])).toBe(beforeWrite)

      view.events.emit(
        global({
          id: "evt_bash_done",
          type: "message.part.updated",
          properties: {
            sessionID: id,
            time: 30,
            part: bash({
              status: "completed",
              input: { command: "tail -f build.log" },
              output: "build finished",
              title: "tail -f build.log",
              metadata: { output: "build finished" },
              time: { start: 10, end: 30 },
            }),
          },
        }),
      )
      const done = await waitForFrame(view, "build finished")
      expect(done).not.toContain("compiling beta")
    } finally {
      await view.dispose()
    }
  })
})
