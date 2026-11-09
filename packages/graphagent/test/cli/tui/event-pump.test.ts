// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { EventPump, eventScope, FRAME_MS, type PumpEvent } from "../../../src/cli/tui/event-pump"

function harness() {
  let current = 0
  const batches: PumpEvent[][] = []
  const timers = new Set<{ at: number; fn: () => void }>()
  const pump = new EventPump({
    emit: (events) => batches.push(events),
    now: () => current,
    schedule: (fn, ms) => {
      const timer = { at: current + ms, fn }
      timers.add(timer)
      return timer
    },
    cancel: (handle) => {
      timers.delete(handle as { at: number; fn: () => void })
    },
  })
  const advance = (ms: number) => {
    current += ms
    for (const timer of [...timers]) {
      if (timer.at > current) continue
      timers.delete(timer)
      timer.fn()
    }
  }
  return {
    pump,
    batches,
    advance,
    setNow: (value: number) => {
      current = value
    },
  }
}

let sequence = 0
function event(type: string, properties: Record<string, any> = {}, directory = "/tmp/project"): PumpEvent {
  return { directory, payload: { id: `evt_${++sequence}`, type, properties } }
}

function delta(sessionID: string, partID: string, text = "", field = "text", messageID = "msg_1") {
  return event("message.part.delta", { sessionID, messageID, partID, field, delta: text })
}

function delivered(batches: PumpEvent[][]) {
  return batches.flat()
}

function types(events: PumpEvent[]) {
  return events.map((entry) => entry.payload.type)
}

describe("event scope", () => {
  test("classifies the shared worker/client table", () => {
    expect(eventScope("message.part.delta")).toBe("session-full")
    expect(eventScope("message.part.updated")).toBe("session-full")
    expect(eventScope("todo.updated")).toBe("session-full")
    expect(eventScope("session.diff")).toBe("session-full")
    expect(eventScope("session.hook.status")).toBe("session-full")
    expect(eventScope("dag.workflow.nodes.updated")).toBe("session-full")
    expect(eventScope("session.created")).toBe("session-summary")
    expect(eventScope("session.status")).toBe("session-summary")
    expect(eventScope("permission.asked")).toBe("session-summary")
    expect(eventScope("question.v2.asked")).toBe("session-summary")
    expect(eventScope("goal.updated")).toBe("session-summary")
    expect(eventScope("dag.workflow.summary.updated")).toBe("session-summary")
    expect(eventScope("mcp.tools.changed")).toBe("global")
    expect(eventScope("project.updated")).toBe("global")
    expect(eventScope("lsp.updated")).toBe("global")
    expect(eventScope("server.connected")).toBe("global")
  })
})

describe("event pump", () => {
  test("drops sync frames and forwards global and summary events", () => {
    const h = harness()
    h.pump.push(event("sync", {}))
    h.pump.push(event("lsp.updated", {}))
    h.pump.push(event("session.status", { sessionID: "ses_a", status: { type: "idle" } }))
    h.advance(FRAME_MS)

    expect(types(delivered(h.batches))).toEqual(["lsp.updated", "session.status"])
  })

  test("forwards session-full events only for the interested sessions", async () => {
    const h = harness()
    h.pump.flush()
    await h.pump.setInterest({ full: ["ses_0"] })

    for (let index = 0; index < 1000; index++) {
      for (let session = 0; session < 8; session++) {
        h.pump.push(delta(`ses_${session}`, `part_${index}`))
      }
    }
    h.advance(FRAME_MS)

    const events = delivered(h.batches)
    expect(events).toHaveLength(1000)
    expect(new Set(events.map((entry) => entry.payload.properties!.sessionID))).toEqual(new Set(["ses_0"]))
  })

  test("merges adjacent deltas within a frame and bounds the post count", async () => {
    const h = harness()
    h.pump.flush()
    await h.pump.setInterest({ full: ["ses_a"] })

    let expected = ""
    for (let tick = 0; tick <= 160; tick++) {
      const text = String(tick % 10)
      expected += text
      h.setNow(tick)
      h.pump.push(delta("ses_a", "part_x", text))
      h.advance(0)
    }
    h.advance(FRAME_MS)

    const merged = delivered(h.batches).map((entry) => entry.payload.properties!.delta as string)
    expect(merged.join("")).toBe(expected)
    expect(h.batches.length).toBeLessThanOrEqual(Math.ceil(160 / FRAME_MS) + 1)
  })

  test("keeps global and summary events when the session is not interested", () => {
    const h = harness()
    h.pump.flush()
    h.pump.push(event("message.updated", { sessionID: "ses_x", info: {} }))
    h.pump.push(event("todo.updated", { sessionID: "ses_x", todos: [] }))
    h.pump.push(event("session.diff", { sessionID: "ses_x", diff: [] }))
    h.pump.push(event("session.updated", { sessionID: "ses_x", info: {} }))
    h.pump.push(event("mcp.tools.changed", {}))
    h.advance(FRAME_MS)

    expect(types(delivered(h.batches))).toEqual(["session.updated", "mcp.tools.changed"])
  })

  test("starts with an empty interest set and replaces it wholesale", async () => {
    const h = harness()
    h.pump.flush()
    h.pump.push(event("message.updated", { sessionID: "ses_x", info: {} }))
    h.advance(FRAME_MS)
    expect(delivered(h.batches)).toHaveLength(0)

    await h.pump.setInterest({ full: ["ses_x"] })
    h.pump.push(event("message.updated", { sessionID: "ses_x", info: {} }))
    h.advance(FRAME_MS)
    expect(types(delivered(h.batches))).toEqual(["message.updated"])

    await h.pump.setInterest({ full: [] })
    h.pump.push(event("message.updated", { sessionID: "ses_x", info: {} }))
    h.advance(FRAME_MS)
    expect(types(delivered(h.batches))).toEqual(["message.updated"])
  })

  test("forwards a slim tool part for sessions without full interest", () => {
    const h = harness()
    const part = {
      id: "prt_1",
      sessionID: "ses_x",
      messageID: "msg_1",
      type: "tool",
      tool: "bash",
      callID: "call_1",
      state: {
        status: "completed",
        input: { command: "ls" },
        output: "secret output",
        title: "list files",
        metadata: { output: "secret" },
        attachments: [{ type: "file" }],
        time: { start: 1, end: 2 },
      },
    }
    h.pump.push(event("message.part.updated", { sessionID: "ses_x", part, time: 2 }))
    h.advance(FRAME_MS)

    const [forwarded] = delivered(h.batches)
    expect(forwarded?.payload.properties?.part).toEqual({
      id: "prt_1",
      sessionID: "ses_x",
      messageID: "msg_1",
      type: "tool",
      tool: "bash",
      callID: "call_1",
      state: { status: "completed", title: "list files", time: { start: 1, end: 2 } },
    })
  })

  test("keeps pending/running tool input and drops other part types", () => {
    const h = harness()
    const part = {
      id: "prt_2",
      sessionID: "ses_x",
      messageID: "msg_1",
      type: "tool",
      tool: "bash",
      callID: "call_2",
      state: { status: "running", input: { command: "ls" }, title: "list", time: { start: 1 } },
    }
    h.pump.push(event("message.part.updated", { sessionID: "ses_x", part, time: 1 }))
    h.pump.push(
      event("message.part.updated", {
        sessionID: "ses_x",
        part: { id: "prt_3", sessionID: "ses_x", messageID: "msg_1", type: "text", text: "hello" },
        time: 1,
      }),
    )
    h.pump.push(delta("ses_x", "prt_3", "hello"))
    h.advance(FRAME_MS)

    const events = delivered(h.batches)
    expect(events).toHaveLength(1)
    expect(events[0]!.payload.properties?.part.state).toEqual({
      status: "running",
      input: { command: "ls" },
      title: "list",
      time: { start: 1 },
    })
  })

  test("adds a session with a pending ask until the request is settled", () => {
    const h = harness()
    h.pump.flush()

    h.pump.push(event("permission.asked", { sessionID: "ses_child", id: "per_1" }))
    h.pump.push(delta("ses_child", "part_1", "a"))
    h.advance(FRAME_MS)
    expect(types(delivered(h.batches))).toEqual(["permission.asked", "message.part.delta"])

    h.pump.push(event("permission.replied", { sessionID: "ses_child", requestID: "per_1", reply: "once" }))
    h.pump.push(delta("ses_child", "part_2", "b"))
    h.advance(FRAME_MS)
    expect(types(delivered(h.batches))).toEqual(["permission.asked", "message.part.delta", "permission.replied"])
  })

  test("keeps the ask session until every pending request settles", () => {
    const h = harness()
    h.pump.flush()

    h.pump.push(event("question.asked", { sessionID: "ses_child", id: "que_1" }))
    h.pump.push(event("question.asked", { sessionID: "ses_child", id: "que_2" }))
    h.pump.push(event("question.replied", { sessionID: "ses_child", requestID: "que_1", answers: [] }))
    h.pump.push(delta("ses_child", "part_1", "a"))
    h.advance(FRAME_MS)
    expect(types(delivered(h.batches))).toContain("message.part.delta")

    h.pump.push(event("question.timed_out", { sessionID: "ses_child", requestID: "que_2" }))
    h.pump.push(delta("ses_child", "part_2", "b"))
    h.advance(FRAME_MS)
    expect(delivered(h.batches).filter((entry) => entry.payload.type === "message.part.delta")).toHaveLength(1)
  })

  test("clears the pending ask on session deletion", () => {
    const h = harness()
    h.pump.flush()

    h.pump.push(event("permission.asked", { sessionID: "ses_child", id: "per_1" }))
    h.pump.push(event("session.deleted", { sessionID: "ses_child", info: {} }))
    h.pump.push(delta("ses_child", "part_1", "a"))
    h.advance(FRAME_MS)

    expect(types(delivered(h.batches))).toEqual(["permission.asked", "session.deleted"])
  })

  test("keeps only the latest preview per part within a frame", async () => {
    const h = harness()
    h.pump.flush()
    await h.pump.setInterest({ full: ["ses_a"] })

    h.pump.push(event("message.part.preview", { sessionID: "ses_a", partID: "part_1", seq: 1, tail: "a" }))
    h.pump.push(event("message.part.preview", { sessionID: "ses_a", partID: "part_1", seq: 2, tail: "ab" }))
    h.advance(FRAME_MS)

    const events = delivered(h.batches)
    expect(events).toHaveLength(1)
    expect(events[0]!.payload.properties).toMatchObject({ seq: 2, tail: "ab" })
  })
})
