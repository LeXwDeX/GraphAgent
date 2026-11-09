// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { AppLayer } from "@/effect/app-runtime"
import { HookTranscript, __transcriptStats, resetTranscriptStats } from "@/hook/transcript"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

// D1 PR3: incremental transcript materialization. Every incremental snapshot is
// compared byte-for-byte against a full rewrite produced after clearing the
// in-memory cursor, so the stable-prefix algorithm cannot drift observably.
const it = testEffect(AppLayer)

const transcriptRoot = (directory: string) => path.join(directory, "transcripts")

const materialize = (sessionID: SessionID, directory: string) =>
  HookTranscript.materialize({ sessionID, directory, root: transcriptRoot(directory) })

const readText = (file: string) => Effect.promise(() => Bun.file(file).text())

type TranscriptRow = {
  uuid: string
  parentUuid?: string
  message: { role: string; content: unknown[] }
}

const isTranscriptRow = (value: unknown): value is TranscriptRow =>
  typeof value === "object" && value !== null && "uuid" in value && "message" in value

const rows = (text: string) =>
  text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line): TranscriptRow => {
      const value: unknown = JSON.parse(line)
      if (!isTranscriptRow(value)) throw new Error(`not a transcript row: ${line}`)
      return value
    })

const addUser = (sessionID: SessionID, created: number, text: string, id = MessageID.ascending()) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    yield* sessions.updateMessage({
      id,
      sessionID,
      role: "user",
      time: { created },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("fixture") },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text,
    })
    return id
  })

const assistant = (
  sessionID: SessionID,
  created: number,
  opts: { parentID: MessageID; id?: MessageID; completed?: boolean },
) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const id = opts.id ?? MessageID.ascending()
    const message: SessionV1.Assistant = {
      id,
      sessionID,
      role: "assistant",
      parentID: opts.parentID,
      time: { created, ...(opts.completed === false ? {} : { completed: created + 1 }) },
      modelID: ModelV2.ID.make("fixture"),
      providerID: ProviderV2.ID.make("fixture"),
      mode: "test",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    yield* sessions.updateMessage(message)
    return id
  })

const addTextPart = (sessionID: SessionID, messageID: MessageID, text: string, id = PartID.ascending()) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    yield* sessions.updatePart({
      id,
      sessionID,
      messageID,
      type: "text",
      text,
    })
    return id
  })

const addToolPart = (
  sessionID: SessionID,
  messageID: MessageID,
  input: {
    callID: string
    tool: string
    state: { status: "completed"; output: string } | { status: "error"; error: string } | { status: "running" }
  },
) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const state: SessionV1.ToolState =
      input.state.status === "completed"
        ? {
            status: "completed",
            input: { command: "ls" },
            output: input.state.output,
            title: "fixture",
            metadata: {},
            time: { start: 1, end: 2 },
          }
        : input.state.status === "error"
          ? {
              status: "error",
              input: { command: "ls" },
              error: input.state.error,
              metadata: {},
              time: { start: 1, end: 2 },
            }
          : { status: "running", input: { command: "ls" }, time: { start: 1 } }
    const part: SessionV1.ToolPart = {
      id: PartID.ascending(),
      sessionID,
      messageID,
      type: "tool",
      callID: input.callID,
      tool: input.tool,
      state,
    }
    yield* sessions.updatePart(part)
  })

const newSession = Effect.gen(function* () {
  const sessions = yield* Session.Service
  return yield* sessions.create({})
})

describe("HookTranscript incremental materialization", () => {
  it.instance("an incremental snapshot is byte-identical to a full rewrite", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const session = yield* newSession
      const u1 = yield* addUser(session.id, 1000, "first prompt")
      const a1 = yield* assistant(session.id, 1001, { parentID: u1 })
      yield* addTextPart(session.id, a1, "running a command")
      yield* addToolPart(session.id, a1, {
        callID: "call_1",
        tool: "bash",
        state: { status: "completed", output: "ok" },
      })
      const u2 = yield* addUser(session.id, 1002, "second prompt")

      const first = yield* materialize(session.id, directory)
      expect(rows(yield* readText(first)).map((row) => row.uuid)).toEqual([u1, a1, `${a1}:tool-results`, u2])

      const a2 = yield* assistant(session.id, 1003, { parentID: u2 })
      yield* addToolPart(session.id, a2, { callID: "call_2", tool: "bash", state: { status: "error", error: "boom" } })
      const incremental = yield* readText(yield* materialize(session.id, directory))
      const incrementalRows = rows(incremental)
      // parentUuid continues through the persisted tool-results row.
      expect(incrementalRows.map((row) => row.uuid)).toEqual([
        u1,
        a1,
        `${a1}:tool-results`,
        u2,
        a2,
        `${a2}:tool-results`,
      ])
      expect(incrementalRows[2].parentUuid).toBe(a1)
      expect(incrementalRows[3].parentUuid).toBe(`${a1}:tool-results`)
      expect(incrementalRows[4].parentUuid).toBe(u2)
      expect(incrementalRows[5].message.content).toEqual([
        { type: "tool_result", tool_use_id: "call_2", content: "boom", is_error: true },
      ])

      HookTranscript.clearCursor(session.id)
      const full = yield* readText(yield* materialize(session.id, directory))
      expect(incremental).toBe(full)
    }),
  )

  it.instance("an unstable assistant tail is rewritten until it settles", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const session = yield* newSession
      const u1 = yield* addUser(session.id, 2000, "prompt")
      const a1 = yield* assistant(session.id, 2001, { parentID: u1, completed: true })
      yield* materialize(session.id, directory)

      const inflight = yield* assistant(session.id, 2002, { parentID: a1, completed: false })
      const partID = yield* addTextPart(session.id, inflight, "partial output")
      yield* addToolPart(session.id, inflight, { callID: "call_live", tool: "bash", state: { status: "running" } })
      const first = rows(yield* readText(yield* materialize(session.id, directory)))
      expect(first.at(-1)?.message.content).toEqual([
        { type: "text", text: "partial output" },
        { type: "tool_use", id: "call_live", name: "bash", input: { command: "ls" } },
      ])

      const sessions = yield* Session.Service
      yield* sessions.updatePart({
        id: partID,
        sessionID: session.id,
        messageID: inflight,
        type: "text",
        text: "final output",
      })
      const completed: SessionV1.Assistant = {
        id: inflight,
        sessionID: session.id,
        role: "assistant",
        parentID: a1,
        time: { created: 2002, completed: 2003 },
        modelID: ModelV2.ID.make("fixture"),
        providerID: ProviderV2.ID.make("fixture"),
        mode: "test",
        agent: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      yield* sessions.updateMessage(completed)
      const settled = yield* readText(yield* materialize(session.id, directory))
      expect(rows(settled)[0].uuid).toBe(u1)
      expect(rows(settled).at(-1)?.message.content[0]).toEqual({ type: "text", text: "final output" })
      HookTranscript.clearCursor(session.id)
      expect(yield* readText(yield* materialize(session.id, directory))).toBe(settled)
    }),
  )

  it.instance("a deletion before the settled point rewrites once, then resumes incrementally", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const session = yield* newSession
      const sessions = yield* Session.Service
      const u1 = yield* addUser(session.id, 3000, "one")
      const u2 = yield* addUser(session.id, 3001, "two")
      yield* addUser(session.id, 3002, "three")
      yield* materialize(session.id, directory)
      yield* addUser(session.id, 3003, "four")
      yield* materialize(session.id, directory)

      yield* sessions.removeMessage({ sessionID: session.id, messageID: u2 })
      resetTranscriptStats()
      yield* materialize(session.id, directory)
      expect(__transcriptStats.fullRewrites).toBe(1)
      expect(__transcriptStats.lastRewriteReason).toBe("count_mismatch")
      expect(rows(yield* readText(yield* materialize(session.id, directory))).map((row) => row.uuid)).not.toContain(u2)

      yield* addUser(session.id, 3004, "five")
      resetTranscriptStats()
      const file = yield* materialize(session.id, directory)
      expect(__transcriptStats.fullRewrites).toBe(0)
      expect(__transcriptStats.writtenBytes).toBeGreaterThan(0)
      HookTranscript.clearCursor(session.id)
      expect(yield* readText(yield* materialize(session.id, directory))).toBe(yield* readText(file))
      expect(rows(yield* readText(file))[0].uuid).toBe(u1)
    }),
  )

  it.instance("a missing or truncated file rebuilds once", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const session = yield* newSession
      yield* addUser(session.id, 4000, "persisted")
      const file = yield* materialize(session.id, directory)
      const expected = yield* readText(file)

      yield* Effect.promise(() => fs.rm(file))
      resetTranscriptStats()
      yield* materialize(session.id, directory)
      expect(__transcriptStats.fullRewrites).toBe(1)
      expect(__transcriptStats.lastRewriteReason).toBe("file_missing")
      expect(yield* readText(file)).toBe(expected)

      yield* Effect.promise(() => fs.writeFile(file, ""))
      resetTranscriptStats()
      yield* materialize(session.id, directory)
      expect(__transcriptStats.fullRewrites).toBe(1)
      expect(__transcriptStats.lastRewriteReason).toBe("file_truncated")
      expect(yield* readText(file)).toBe(expected)

      resetTranscriptStats()
      yield* materialize(session.id, directory)
      expect(__transcriptStats.fullRewrites).toBe(0)
      expect(__transcriptStats.writes).toBe(0)
    }),
  )

  it.instance("orders by (time_created, id) even when ids disagree", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const session = yield* newSession
      // Insertion order is the reverse of time order; two messages share a time.
      const late = yield* addUser(session.id, 5002, "late", MessageID.make("msg_zzz_late"))
      const tieB = yield* addUser(session.id, 5001, "tie-b", MessageID.make("msg_bbb_tie"))
      const tieA = yield* addUser(session.id, 5001, "tie-a", MessageID.make("msg_aaa_tie"))
      const early = yield* addUser(session.id, 5000, "early", MessageID.make("msg_yyy_early"))
      const file = yield* materialize(session.id, directory)
      expect(rows(yield* readText(file)).map((row) => row.uuid)).toEqual([early, tieA, tieB, late])
    }),
  )
})
