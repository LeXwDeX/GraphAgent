// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@graphagent/core/v1/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { freeze } from "@/session/history/freeze"
import {
  applyCommitted,
  makeHistoryState,
  storeEntry,
  versionOf,
  type HistoryEntry,
  type TranscriptEvent,
} from "@/session/history/state"

// The write-through cache applies these events synchronously on the commit
// path. The tests pin the incremental rules: when an event can be applied in
// place, when the entry must be marked dirty for a full reload, and how the
// per-session version and per-entry sequence fences behave.

const sessionID = SessionID.make("ses_history_state")

const user = (n: number, extra?: Record<string, unknown>) =>
  ({
    id: MessageID.make(`msg_${String(n).padStart(6, "0")}`),
    sessionID,
    role: "user",
    time: { created: n },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    ...extra,
  }) as unknown as SessionV1.User

const assistant = (n: number, parentID: string, extra?: Record<string, unknown>) =>
  ({
    id: MessageID.make(`msg_${String(n).padStart(6, "0")}`),
    sessionID,
    role: "assistant",
    time: { created: n },
    parentID,
    ...extra,
  }) as unknown as SessionV1.Info

const part = (messageID: string, n: number, extra?: Record<string, unknown>) =>
  ({
    id: PartID.make(`prt_${String(n).padStart(6, "0")}`),
    sessionID,
    messageID,
    type: "text",
    text: `part ${n}`,
    ...extra,
  }) as unknown as SessionV1.Part

const entry = (rows: SessionV1.WithParts[], input?: { seq?: number; version?: number; dirty?: boolean }) => {
  const value: HistoryEntry = {
    rows,
    version: input?.version ?? 0,
    viewVersion: 0,
    dirty: input?.dirty ?? false,
    lastSeq: input?.seq,
    bytes: 0,
  }
  return value
}

const seed = (rows: SessionV1.WithParts[], input?: { seq?: number }) => {
  const state = makeHistoryState()
  storeEntry(state, sessionID, entry(rows, { seq: input?.seq }))
  return state
}

const transcript = (type: string, data: unknown, seq?: number): TranscriptEvent => ({
  type,
  data: { sessionID, ...(data as object) },
  ...(seq === undefined ? {} : { durable: { aggregateID: sessionID, seq } }),
})

const updated = (info: SessionV1.Info, seq?: number) => transcript(SessionV1.Event.MessageUpdated.type, { info }, seq)

describe("HistoryState.applyCommitted", () => {
  test("unshifts a message newer than the cached head", () => {
    const state = makeHistoryState()
    storeEntry(state, sessionID, entry([]))

    applyCommitted(state, updated(user(10), 0))

    const cached = state.entries.get(sessionID)!
    expect(cached.rows.map((row) => row.info.id)).toEqual([MessageID.make("msg_000010")])
    expect(cached.lastSeq).toBe(0)
    expect(versionOf(state, sessionID)).toBe(1)
    expect(cached.view).toBeUndefined()
  })

  test("marks a message older than the cached tail dirty", () => {
    const state = seed([{ info: user(10), parts: [] }])

    applyCommitted(state, updated(user(5), 0))

    const cached = state.entries.get(sessionID)!
    expect(cached.dirty).toBe(true)
    expect(cached.rows).toHaveLength(1)
  })

  test("keeps the greatest consumed timestamp on both sides", () => {
    const state = seed([{ info: user(1, { time: { created: 1, consumed: 5 } }), parts: [] }])
    const cached = state.entries.get(sessionID)!

    applyCommitted(state, updated(user(1, { time: { created: 1, consumed: 3 } }), 0))
    if (cached.rows[0]!.info.role !== "user") throw new Error("expected a user message")
    expect(cached.rows[0]!.info.time.consumed).toBe(5)

    applyCommitted(state, updated(user(1, { time: { created: 1, consumed: 8 } }), 1))
    if (cached.rows[0]!.info.role !== "user") throw new Error("expected a user message")
    expect(cached.rows[0]!.info.time.consumed).toBe(8)
  })

  test("leaves both missing consumed timestamps absent", () => {
    const state = seed([{ info: user(1), parts: [] }])
    const cached = state.entries.get(sessionID)!

    applyCommitted(state, updated(user(1), 0))

    if (cached.rows[0]!.info.role !== "user") throw new Error("expected a user message")
    expect(cached.rows[0]!.info.time.consumed).toBeUndefined()
  })

  test("marks assistant boundary changes dirty", () => {
    const state = seed([{ info: assistant(2, "msg_000001"), parts: [] }])

    applyCommitted(state, updated(assistant(2, "msg_000001", { finish: "stop" }), 0))

    expect(state.entries.get(sessionID)!.dirty).toBe(true)
  })

  test("applies assistant updates that keep the boundary", () => {
    const state = seed([{ info: assistant(2, "msg_000001", { finish: "stop" }), parts: [] }])

    applyCommitted(state, updated(assistant(2, "msg_000001", { finish: "stop", cost: 2 }), 0))

    const cached = state.entries.get(sessionID)!
    expect(cached.dirty).toBe(false)
    expect((cached.rows[0]!.info as SessionV1.Assistant).cost).toBe(2)
  })

  test("replaces parts copy-on-write so held frozen views are unchanged", () => {
    const first = part("msg_000001", 1)
    const rows: SessionV1.WithParts[] = [{ info: user(1), parts: [first] }]
    const state = seed(rows)
    const held = freeze(MessageV2.filterCompacted(state.entries.get(sessionID)!.rows))
    const heldPart = held[0]!.parts[0]!

    applyCommitted(
      state,
      transcript(SessionV1.Event.PartUpdated.type, { part: part("msg_000001", 1, { text: "new" }) }, 0),
    )

    const cached = state.entries.get(sessionID)!
    expect(cached.rows[0]!.parts[0]!.id).toBe(first.id)
    expect(cached.rows[0]!.parts[0]).not.toBe(heldPart)
    expect(heldPart.type === "text" && heldPart.text).toBe("part 1")
    expect(Object.isFrozen(held[0]!.parts)).toBe(true)
  })

  test("inserts parts in id order", () => {
    const state = seed([{ info: user(1), parts: [part("msg_000001", 1), part("msg_000001", 3)] }])

    applyCommitted(state, transcript(SessionV1.Event.PartUpdated.type, { part: part("msg_000001", 2) }, 0))

    expect(state.entries.get(sessionID)!.rows[0]!.parts.map((candidate) => candidate.id)).toEqual([
      PartID.make("prt_000001"),
      PartID.make("prt_000002"),
      PartID.make("prt_000003"),
    ])
  })

  test("marks compaction part updates dirty", () => {
    const state = seed([{ info: user(1), parts: [part("msg_000001", 1)] }])

    applyCommitted(
      state,
      transcript(
        SessionV1.Event.PartUpdated.type,
        { part: part("msg_000001", 1, { type: "compaction", auto: true }) },
        0,
      ),
    )

    expect(state.entries.get(sessionID)!.dirty).toBe(true)
  })

  test("records the sequence when a part update hits a missing message", () => {
    const state = seed([{ info: user(1), parts: [] }])

    applyCommitted(state, transcript(SessionV1.Event.PartUpdated.type, { part: part("msg_999999", 1) }, 0))

    const cached = state.entries.get(sessionID)!
    expect(cached.dirty).toBe(false)
    expect(cached.lastSeq).toBe(0)
    expect(cached.rows).toHaveLength(1)
  })

  test("always marks message removals dirty", () => {
    const state = seed([{ info: user(1), parts: [] }])

    applyCommitted(state, transcript(SessionV1.Event.MessageRemoved.type, { messageID: "msg_000001" }, 0))

    expect(state.entries.get(sessionID)!.dirty).toBe(true)
  })

  test("removes parts and dirties on a missing or compaction part", () => {
    const state = seed([{ info: user(1), parts: [part("msg_000001", 1), part("msg_000001", 2)] }])

    applyCommitted(
      state,
      transcript(SessionV1.Event.PartRemoved.type, { messageID: "msg_000001", partID: "prt_000002" }, 0),
    )
    expect(state.entries.get(sessionID)!.rows[0]!.parts).toHaveLength(1)

    applyCommitted(
      state,
      transcript(SessionV1.Event.PartRemoved.type, { messageID: "msg_000001", partID: "prt_000009" }, 1),
    )
    expect(state.entries.get(sessionID)!.dirty).toBe(true)
  })

  test("forgets the entry when the session is deleted", () => {
    const state = seed([{ info: user(1), parts: [] }])

    applyCommitted(state, transcript(SessionV1.Event.Deleted.type, { info: user(1) }, 0))

    expect(state.entries.has(sessionID)).toBe(false)
    expect(versionOf(state, sessionID)).toBe(1)
  })

  test("advances the version but ignores a duplicate sequence", () => {
    const state = seed([{ info: user(1), parts: [] }], { seq: 5 })
    const cached = state.entries.get(sessionID)!

    applyCommitted(state, updated(user(1, { time: { created: 1, consumed: 9 } }), 5))

    expect(versionOf(state, sessionID)).toBe(1)
    expect(cached.lastSeq).toBe(5)
    if (cached.rows[0]!.info.role !== "user") throw new Error("expected a user message")
    expect(cached.rows[0]!.info.time.consumed).toBeUndefined()
  })

  test("marks a sequence gap dirty, including out-of-order delivery", () => {
    const state = seed([{ info: user(1), parts: [] }], { seq: 5 })

    applyCommitted(state, updated(user(2), 7))

    const cached = state.entries.get(sessionID)!
    expect(cached.dirty).toBe(true)
    expect(cached.lastSeq).toBe(5)
    expect(cached.rows).toHaveLength(1)
  })

  test("applies consecutive sequences and advances lastSeq", () => {
    const state = seed([{ info: user(1), parts: [] }], { seq: 5 })

    applyCommitted(state, updated(user(2), 6))

    const cached = state.entries.get(sessionID)!
    expect(cached.dirty).toBe(false)
    expect(cached.lastSeq).toBe(6)
    expect(cached.rows[0]!.info.id).toBe(MessageID.make("msg_000002"))
  })

  test("a dirty entry only tracks the version until the next full read", () => {
    const state = seed([{ info: user(1), parts: [] }], { seq: 5 })
    const cached = state.entries.get(sessionID)!
    cached.dirty = true

    applyCommitted(state, updated(user(2), 6))

    expect(cached.dirty).toBe(true)
    expect(cached.lastSeq).toBe(5)
    expect(cached.version).toBe(1)
    expect(cached.rows).toHaveLength(1)
  })

  test("ignores unknown event types without touching the version", () => {
    const state = seed([{ info: user(1), parts: [] }])

    applyCommitted(state, transcript("workflow.paused", {}, 0))
    applyCommitted(state, { type: "message.updated", data: {} })

    expect(versionOf(state, sessionID)).toBe(0)
    expect(state.entries.get(sessionID)!.lastSeq).toBeUndefined()
  })

  test("advances the version for a transcript event without a durable sequence", () => {
    const state = seed([{ info: user(1), parts: [] }])

    applyCommitted(state, { type: SessionV1.Event.MessageUpdated.type, data: { sessionID, info: user(2) } })

    expect(versionOf(state, sessionID)).toBe(1)
    expect(state.entries.get(sessionID)!.lastSeq).toBeUndefined()
    expect(state.entries.get(sessionID)!.rows).toHaveLength(1)
  })
})
