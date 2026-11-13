// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { createMemo, createRoot, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { AssistantMessage, Message, Part, ReasoningPart, TextPart, ToolPart, UserMessage } from "@graphagent/sdk"
import { createStreamBuffer } from "../../../src/context/stream-buffer"
import { renderUserTextPart } from "../../../src/i18n/receipt"
import { createRowTable, type RowTable } from "../../../src/routes/session/row-table"
import {
  createSessionViewState,
  createTextFacts,
  rowRevision,
  type Row,
  type TextFactsCache,
} from "../../../src/routes/session/rows"
import { hideToolDetails } from "../../../src/routes/session/tool-attention"
import { errorMessage } from "../../../src/util/error"

const sessionID = "ses_table"

type Entry = { info: Message; parts: Part[] }

function userMessage(id: string, created: number): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "test", modelID: "table" },
  }
}

function assistantMessage(id: string, created: number, extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    parentID: "msg_user",
    agent: "build",
    mode: "build",
    modelID: "table",
    providerID: "test",
    path: { cwd: "/tmp", root: "/tmp" },
    time: { created, completed: created + 1 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
    ...extra,
  }
}

const text = (messageID: string, id: string, body: string, extra: Partial<TextPart> = {}): TextPart => ({
  id,
  sessionID,
  messageID,
  type: "text",
  text: body,
  time: { start: 1, end: 2 },
  ...extra,
})

/** A text part the server is still writing: no end time. */
const writing = (messageID: string, id: string, body = ""): TextPart => ({
  id,
  sessionID,
  messageID,
  type: "text",
  text: body,
  time: { start: 1 },
})

const reasoning = (messageID: string, id: string, body: string, end: number | undefined = 2): ReasoningPart => ({
  id,
  sessionID,
  messageID,
  type: "reasoning",
  text: body,
  time: end === undefined ? { start: 1 } : { start: 1, end },
})

function tool(messageID: string, id: string, name: string, state: ToolPart["state"]): ToolPart {
  return { id, sessionID, messageID, type: "tool", callID: `call_${id}`, tool: name, state }
}

const completed = (output: string, metadata: Record<string, unknown> = {}): ToolPart["state"] => ({
  status: "completed",
  input: {},
  output,
  title: "done",
  metadata,
  time: { start: 1, end: 2 },
})
const running = (metadata: Record<string, unknown> = {}): ToolPart["state"] => ({
  status: "running",
  input: {},
  metadata,
  time: { start: 1 },
})

/** A session of `count` finished turns: a question, then an answer of three parts and a tool. */
function conversation(count: number): Entry[] {
  const entries: Entry[] = []
  for (let turn = 0; turn < count; turn++) {
    const asked = `msg_u${turn}`
    const answered = `msg_a${turn}`
    entries.push({ info: userMessage(asked, turn * 2 + 1), parts: [text(asked, `prt_q${turn}`, `question ${turn}`)] })
    entries.push({
      info: assistantMessage(answered, turn * 2 + 2),
      parts: [
        reasoning(answered, `prt_r${turn}`, `thinking about ${turn}`),
        text(answered, `prt_t${turn}`, `answer ${turn}\nsecond line of the answer`),
        tool(answered, `prt_c${turn}`, "bash", completed(`output ${turn}`)),
      ],
    })
  }
  return entries
}

function counting(inner: TextFactsCache, derived: string[]): TextFactsCache {
  return {
    read: (id, raw, normalize) =>
      inner.read(id, raw, (value) => {
        derived.push(id)
        return normalize(value)
      }),
    retain: (live) => inner.retain(live),
    get size() {
      return inner.size
    },
  }
}

/** The table over a store, with the inputs a session route feeds it and a counter on every way it reads them. */
function build(entries: Entry[]) {
  const [store, setStore] = createStore({
    message: entries.map((entry) => entry.info),
    part: Object.fromEntries(entries.map((entry) => [entry.info.id, entry.parts])) as Record<string, Part[]>,
  })
  const stream = createStreamBuffer()
  const view = createSessionViewState()
  const [showDetails, setShowDetails] = createSignal(true)
  const [revertMessageID, setRevertMessageID] = createSignal<string | undefined>()
  const lastAssistant = createMemo(() => store.message.findLast((message) => message.role === "assistant")?.id)

  /** Calls of `readPartText` by part, runs of a message's memo by message, derivations of text facts by part. */
  const reads = new Map<string, number>()
  const runs = new Map<string, number>()
  const derived: string[] = []
  const bump = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)

  const reverted = (message: Message) => {
    const boundary = revertMessageID()
    if (boundary === undefined) return false
    return message.time.created >= (store.message.find((item) => item.id === boundary)?.time.created ?? Infinity)
  }
  const readPartText = (part: Part) => {
    bump(reads, part.id)
    // What `sync.readPartText` does: the stream version, then the snapshot and its buffer.
    stream.version()
    return stream.read(part)
  }
  const table = createRowTable({
    messages: () => store.message,
    parts: (messageID) => {
      bump(runs, messageID)
      return store.part[messageID] ?? []
    },
    readPartText,
    view,
    showDetails,
    lastAssistantID: lastAssistant,
    revertMessageID,
    revertRevision: () => rowRevision("revert", revertMessageID()),
    reverted,
    textFacts: () => counting(createTextFacts(), derived),
  })

  return {
    store,
    setStore,
    stream,
    view,
    table,
    showDetails,
    setShowDetails,
    revertMessageID,
    setRevertMessageID,
    reads,
    runs,
    derived,
    /** A delta of a streaming part, the way a frame flushes it. */
    delta(partID: string, delta: string) {
      stream.append(partID, "text", delta)
      stream.bump()
    },
    /** The snapshot that ends a part: its full text and an end time, which settles the buffer. */
    finish(messageID: string, partID: string, body: string) {
      stream.settle(partID)
      setStore("part", messageID, (parts) =>
        parts.map((part) =>
          part.id === partID && part.type === "text" ? { ...part, text: body, time: { start: 1, end: 2 } } : part,
        ),
      )
    },
    clear() {
      reads.clear()
      runs.clear()
      derived.length = 0
    },
    reference: () =>
      reference({
        messages: store.message,
        parts: (messageID) => store.part[messageID] ?? [],
        read: (part) => stream.read(part),
        view,
        showDetails: showDetails(),
        revertMessageID: revertMessageID(),
        reverted,
        lastAssistantID: lastAssistant(),
      }),
  }
}

type Rig = ReturnType<typeof build>

function withTable<T>(entries: Entry[], run: (rig: Rig) => T): T {
  return createRoot((dispose) => {
    try {
      return run(build(entries))
    } finally {
      dispose()
    }
  })
}

/** What a row table says apart from its revisions, which only have to move when the content does. */
type Shape = {
  rows: Array<[key: string, kind: Row["kind"], messageID: string, partID: string | undefined]>
  streaming: string[]
  chars: Array<[key: string, count: number]>
}

function shapeOf(table: RowTable): Shape {
  const streaming = [...table.streaming].toSorted()
  return {
    rows: table.rows.map((row) => [row.key, row.kind, row.messageID, row.partID]),
    streaming,
    // A row that is still being written keeps the estimate it was born with; the others are exact.
    chars: [...table.chars].filter(([key]) => !table.streaming.has(key)).toSorted(([a], [b]) => a.localeCompare(b)),
  }
}

/**
 * The row table as it was computed before it was kept per message: one pass over every message and part,
 * on every change. The incremental table has to say what this says.
 */
function reference(input: {
  messages: readonly Message[]
  parts: (messageID: string) => readonly Part[]
  read: (part: Part) => string
  view: ReturnType<typeof createSessionViewState>
  showDetails: boolean
  revertMessageID: string | undefined
  reverted: (message: Message) => boolean
  lastAssistantID: string | undefined
}): Shape {
  const rows: Shape["rows"] = []
  const chars = new Map<string, number>()
  const streaming = new Set<string>()
  const textLines = (value: string) => Math.max(1, ...value.split("\n").map((line) => line.length))

  for (const message of input.messages) {
    if (message.id === input.revertMessageID) rows.push([`revert:${message.id}`, "revert", message.id, undefined])
    if (input.reverted(message)) continue
    const parts = input.parts(message.id)

    if (message.role === "user") {
      const texts: string[] = []
      for (const part of parts)
        if (part.type === "text" && !part.synthetic) texts.push(renderUserTextPart(part, { key: "" }))
      const body = texts.join("\n\n")
      if (body || parts.some((part) => part.type === "compaction")) {
        rows.push([`user:${message.id}`, "user", message.id, undefined])
        chars.set(`user:${message.id}`, textLines(body))
      }
      continue
    }

    for (const part of parts) {
      if (part.type === "text" || part.type === "reasoning") {
        const raw = input.read(part)
        const body = (part.type === "text" ? raw : raw.replace("[REDACTED]", "")).trim()
        if (!body) continue
        rows.push([`part:${part.id}`, part.type, message.id, part.id])
        chars.set(`part:${part.id}`, textLines(body))
        if (part.time?.end === undefined) streaming.add(`part:${part.id}`)
      } else if (part.type === "tool") {
        if (hideToolDetails(part.tool, part.state, input.showDetails)) continue
        rows.push([`part:${part.id}`, "tool", message.id, part.id])
        if (part.state.status === "pending" || part.state.status === "running") streaming.add(`part:${part.id}`)
      }
    }
    if (parts.some((part) => part.type === "tool" && part.tool === "task")) {
      rows.push([`task:${message.id}`, "notice", message.id, undefined])
    }
    if (message.error && message.error.name !== "MessageAbortedError") {
      rows.push([`error:${message.id}`, "notice", message.id, undefined])
      void errorMessage(message.error)
    }
    const final = message.finish && !["tool-calls", "unknown"].includes(message.finish)
    if (input.lastAssistantID === message.id || final || message.error?.name === "MessageAbortedError") {
      rows.push([`summary:${message.id}`, "meta", message.id, undefined])
    }
  }
  return {
    rows,
    streaming: [...streaming].toSorted(),
    chars: [...chars].filter(([key]) => !streaming.has(key)).toSorted(([a], [b]) => a.localeCompare(b)),
  }
}

/** A session that exercises every branch of the table: each kind of row, and each reason a row is left out. */
function everything(): Entry[] {
  const first = "msg_u0"
  const second = "msg_a0"
  const third = "msg_u1"
  const fourth = "msg_a1"
  const fifth = "msg_a2"
  return [
    {
      info: userMessage(first, 1),
      parts: [
        text(first, "prt_u0", "first question"),
        text(first, "prt_u0s", "synthetic note", { synthetic: true }),
        { id: "prt_u0f", sessionID, messageID: first, type: "file", mime: "text/plain", url: "file:///tmp/a" },
      ],
    },
    {
      info: assistantMessage(second, 2),
      parts: [
        reasoning(second, "prt_r0", "plan [REDACTED]"),
        reasoning(second, "prt_r0e", "[REDACTED]"),
        reasoning(second, "prt_r0w", "still thinking", undefined),
        text(second, "prt_t0", "  an answer  \n\n"),
        text(second, "prt_t0e", "   \n  "),
        writing(second, "prt_t0w", "half a sentence"),
        tool(second, "prt_c0", "bash", completed("ok")),
        tool(second, "prt_c0r", "read", running()),
        tool(second, "prt_c0p", "glob", { status: "pending", input: {}, raw: "{" }),
        tool(second, "prt_c0x", "grep", {
          status: "error",
          input: {},
          error: "boom",
          time: { start: 1, end: 2 },
        }),
        tool(second, "prt_c0t", "task", running({ background: false })),
        tool(second, "prt_c0b", "task", running({ background: true })),
        tool(second, "prt_c0a", "bash", completed("blocked", { blocked: true, diagnosticSummary: "needs a look" })),
      ],
    },
    {
      info: userMessage(third, 3),
      parts: [{ id: "prt_u1c", sessionID, messageID: third, type: "compaction", auto: true }],
    },
    {
      info: assistantMessage(fourth, 4, {
        finish: "tool-calls",
        error: { name: "UnknownError", data: { message: "bad" } },
      }),
      parts: [text(fourth, "prt_t1", "after the error")],
    },
    {
      info: assistantMessage(fifth, 5, {
        finish: undefined,
        time: { created: 5 },
        error: { name: "MessageAbortedError", data: { message: "aborted" } },
      }),
      parts: [writing(fifth, "prt_t2", "cut short")],
    },
  ]
}

describe("the table says what a pass over every message says", () => {
  test("for a session with every kind of row", () =>
    withTable(everything(), (rig) => {
      const expected = rig.reference()
      expect(shapeOf(rig.table())).toEqual(expected)
      // The case is only worth running if it reaches every kind of row.
      const kinds = new Set(expected.rows.map((row) => row[1]))
      const needed: Row["kind"][] = ["user", "text", "reasoning", "tool", "meta", "notice"]
      for (const kind of needed) expect(kinds.has(kind)).toBe(true)
      expect(expected.streaming.length).toBeGreaterThan(2)
    }))

  test("while the details of finished tools are hidden and shown", () =>
    withTable(everything(), (rig) => {
      rig.setShowDetails(false)
      expect(shapeOf(rig.table())).toEqual(rig.reference())
      const hidden = rig.table().rows.filter((row) => row.kind === "tool").length
      rig.setShowDetails(true)
      expect(shapeOf(rig.table())).toEqual(rig.reference())
      expect(rig.table().rows.filter((row) => row.kind === "tool").length).toBeGreaterThan(hidden)
    }))

  test("across a revert boundary, and once it is lifted", () =>
    withTable(everything(), (rig) => {
      rig.setRevertMessageID("msg_u1")
      expect(shapeOf(rig.table())).toEqual(rig.reference())
      expect(rig.table().rows.some((row) => row.key === "revert:msg_u1")).toBe(true)
      expect(rig.table().rows.some((row) => row.messageID === "msg_a1")).toBe(false)
      rig.setRevertMessageID(undefined)
      expect(shapeOf(rig.table())).toEqual(rig.reference())
    }))

  test("through deltas, the end of a part, new messages and removed ones", () =>
    withTable(conversation(3), (rig) => {
      const check = () => expect(shapeOf(rig.table())).toEqual(rig.reference())
      check()

      // A reply opens as an empty snapshot and writes a first word, then more.
      const reply = assistantMessage("msg_a3", 20, { finish: undefined, time: { created: 20 } })
      rig.setStore("message", (messages) => [...messages, userMessage("msg_u3", 19), reply])
      rig.setStore("part", "msg_u3", [text("msg_u3", "prt_q3", "one more question")])
      rig.setStore("part", reply.id, [writing(reply.id, "prt_w")])
      check()
      rig.delta("prt_w", "  ")
      check()
      rig.delta("prt_w", "first")
      check()
      rig.delta("prt_w", " words\nand a second line")
      check()
      expect(rig.table().streaming.has("part:prt_w")).toBe(true)

      // A tool starts in the same message and the reply ends.
      rig.setStore("part", reply.id, (parts) => [...parts, tool(reply.id, "prt_x", "bash", running())])
      check()
      rig.finish(reply.id, "prt_w", "first words\nand a second line")
      check()
      rig.setStore(
        "part",
        reply.id,
        1,
        produce((part) => void (part.type === "tool" && (part.state = completed("done")))),
      )
      check()
      expect(rig.table().streaming.size).toBe(0)

      // The oldest turn goes away.
      rig.setStore("message", (messages) =>
        messages.filter((message) => message.id !== "msg_u0" && message.id !== "msg_a0"),
      )
      check()
    }))
})

describe("a row that is still being written", () => {
  test("keeps its identity and its revision while it grows, and takes a new revision when it ends", () =>
    withTable(conversation(3), (rig) => {
      const reply = assistantMessage("msg_a3", 20, { finish: undefined, time: { created: 20 } })
      rig.setStore("message", (messages) => [...messages, reply])
      rig.setStore("part", reply.id, [writing(reply.id, "prt_w")])
      rig.delta("prt_w", "begin")
      const born = rig.table().rows.find((row) => row.key === "part:prt_w")!

      for (let frame = 0; frame < 20; frame++) rig.delta("prt_w", ` word${frame}`)
      const grown = rig.table().rows.find((row) => row.key === "part:prt_w")!
      // The row the transcript mounted is the row it still holds: nothing remounts per frame.
      expect(grown).toBe(born)
      expect(grown.revision).toBe(born.revision)

      rig.finish(reply.id, "prt_w", "begin and the rest")
      const ended = rig.table().rows.find((row) => row.key === "part:prt_w")!
      expect(ended).not.toBe(born)
      expect(ended.revision).not.toBe(born.revision)
      // The finished text is hashed: the same text twice gives the same revision, another text another one.
      rig.finish(reply.id, "prt_w", "begin and the rest")
      expect(rig.table().rows.find((row) => row.key === "part:prt_w")!.revision).toBe(ended.revision)
      rig.finish(reply.id, "prt_w", "begin and something else")
      expect(rig.table().rows.find((row) => row.key === "part:prt_w")!.revision).not.toBe(ended.revision)
    }))

  test("is not a row until it has a word to show, and the whitespace before it does not make one", () =>
    withTable(conversation(2), (rig) => {
      const reply = assistantMessage("msg_a2", 20, { finish: undefined, time: { created: 20 } })
      rig.setStore("message", (messages) => [...messages, reply])
      rig.setStore("part", reply.id, [writing(reply.id, "prt_w")])
      const has = () => rig.table().rows.some((row) => row.key === "part:prt_w")
      expect(has()).toBe(false)
      rig.delta("prt_w", " \n ")
      expect(has()).toBe(false)
      rig.delta("prt_w", "go")
      expect(has()).toBe(true)
    }))
})

describe("a streamed frame costs what the part it writes to costs", () => {
  /** What one run of `frames` deltas into the last message of a session of `turns` turns reads and derives. */
  function streamed(turns: number, frames: number) {
    return withTable(conversation(turns), (rig) => {
      const reply = assistantMessage("msg_live", 1000, { finish: undefined, time: { created: 1000 } })
      rig.setStore("message", (messages) => [...messages, reply])
      rig.setStore("part", reply.id, [writing(reply.id, "prt_live")])
      // The first words give the part its row; that is the one frame that is allowed to read it.
      rig.delta("prt_live", "first words")
      const before = rig.table()
      const rowsBefore = before.rows.length

      rig.clear()
      for (let frame = 0; frame < frames; frame++) rig.delta("prt_live", ` more${frame}`)

      return {
        rows: rowsBefore,
        reads: Object.fromEntries(rig.reads),
        runs: Object.fromEntries(rig.runs),
        derived: [...rig.derived],
        // Nothing the transcript reads has been replaced by a new object.
        sameTable: rig.table() === before,
        sameRows: rig.table().rows === before.rows,
      }
    })
  }

  test("is no cost at all to the table once the part has a row, in a session of any length", () => {
    const short = streamed(10, 50)
    const long = streamed(100, 50)

    // Ten times the messages, ten times the rows.
    expect(long.rows).toBeGreaterThan(short.rows * 9)
    for (const run of [short, long]) {
      expect(run.reads).toEqual({})
      expect(run.runs).toEqual({})
      expect(run.derived).toEqual([])
      expect(run.sameTable).toBe(true)
      expect(run.sameRows).toBe(true)
    }
  })

  test("follows the stream only while the part has no word to show, and reads no other part", () =>
    withTable(conversation(200), (rig) => {
      const reply = assistantMessage("msg_live", 1000, { finish: undefined, time: { created: 1000 } })
      rig.setStore("message", (messages) => [...messages, reply])
      rig.setStore("part", reply.id, [text(reply.id, "prt_done", "an earlier part"), writing(reply.id, "prt_live")])
      rig.clear()

      for (let frame = 0; frame < 10; frame++) rig.delta("prt_live", " ")

      // Only the part that is being written is read, never its finished sibling or the other 400 messages,
      // and only the message that holds it runs again, once per frame.
      expect(Object.keys(Object.fromEntries(rig.reads))).toEqual(["prt_live"])
      expect(Object.fromEntries(rig.runs)).toEqual({ [reply.id]: 10 })
      expect(rig.derived).toEqual(Array(10).fill("prt_live"))

      // The first word gives it a row, and that is the last frame the table follows.
      rig.clear()
      rig.delta("prt_live", "word")
      expect(Object.fromEntries(rig.runs)).toEqual({ [reply.id]: 1 })
      rig.clear()
      for (let frame = 0; frame < 10; frame++) rig.delta("prt_live", " more")
      expect(Object.fromEntries(rig.runs)).toEqual({})
      expect(Object.fromEntries(rig.reads)).toEqual({})
    }))

  test("derives a finished part when its text arrives and never again while the session grows around it", () =>
    withTable(conversation(50), (rig) => {
      const derivedOf = (id: string) => rig.derived.filter((item) => item === id).length
      // Building the table derived every text part once.
      expect(derivedOf("prt_t7")).toBe(1)
      expect(derivedOf("prt_r7")).toBe(1)

      rig.clear()
      for (let turn = 50; turn < 60; turn++) {
        const asked = `msg_u${turn}`
        const answered = `msg_a${turn}`
        rig.setStore("message", (messages) => [
          ...messages,
          userMessage(asked, turn * 2 + 1),
          assistantMessage(answered, turn * 2 + 2),
        ])
        rig.setStore("part", asked, [text(asked, `prt_q${turn}`, `question ${turn}`)])
        rig.setStore("part", answered, [text(answered, `prt_t${turn}`, `answer ${turn}`)])
      }

      // Only the new parts were read or derived: ten answers, no part of the first fifty turns.
      expect(rig.derived.toSorted()).toEqual(Array.from({ length: 10 }, (_, index) => `prt_t${50 + index}`).toSorted())
      expect(rig.runs.has("msg_a7")).toBe(false)
      expect(rig.reads.size).toBe(0)
    }))

  test("re-runs the message a store write belongs to and no other", () =>
    withTable(conversation(30), (rig) => {
      rig.clear()

      // A tool part of one message finishes.
      rig.setStore(
        "part",
        "msg_a12",
        2,
        produce((part) => void (part.type === "tool" && (part.state = completed("changed")))),
      )
      expect(Object.fromEntries(rig.runs)).toEqual({ msg_a12: 1 })

      rig.clear()
      rig.view.set("prt_c3", "expanded", true)
      // The reader opened a tool: the messages that have a row to open follow it, as they do for a tool state.
      expect(rig.runs.get("msg_a3")).toBe(1)
      expect(shapeOf(rig.table())).toEqual(rig.reference())
    }))

  test("a finished message does not follow the stream", () =>
    withTable(conversation(20), (rig) => {
      const reply = assistantMessage("msg_live", 1000, { finish: undefined, time: { created: 1000 } })
      rig.setStore("message", (messages) => [...messages, reply])
      rig.setStore("part", reply.id, [writing(reply.id, "prt_live")])
      rig.clear()

      // Deltas for a part that has no word yet follow the stream; nothing else does.
      for (let frame = 0; frame < 5; frame++) rig.delta("prt_live", "\n")
      expect(Object.keys(Object.fromEntries(rig.runs))).toEqual([reply.id])
    }))
})

describe("the text a row is derived from", () => {
  test("is the snapshot for a part that has ended, so a late delta does not reach its row", () =>
    withTable(conversation(2), (rig) => {
      rig.clear()
      // A delta for a part the server has already closed: the buffer takes it, the row does not follow.
      rig.delta("prt_t0", " late")
      expect(rig.reads.size).toBe(0)
      expect(rig.runs.size).toBe(0)
    }))

  test("keeps its row when a snapshot rewrites its text mid-stream, and takes its estimate from the text that ends", () =>
    withTable(conversation(2), (rig) => {
      const reply = assistantMessage("msg_live", 1000, { finish: undefined, time: { created: 1000 } })
      rig.setStore("message", (messages) => [...messages, reply])
      rig.setStore("part", reply.id, [writing(reply.id, "prt_live", "short")])
      const before = rig.table()
      const born = before.chars.get("part:prt_live")!

      // A snapshot taken mid-stream (a reconnect) carries more text than the first one did. The row is the
      // same row: a transcript that mounted it keeps it, and measures it while it is on screen.
      rig.setStore(
        "part",
        reply.id,
        0,
        produce((part) => void (part.type === "text" && (part.text = `short\n${"x".repeat(60)}`))),
      )
      expect(rig.table()).toBe(before)
      expect(rig.table().chars.get("part:prt_live")).toBe(born)

      rig.finish(reply.id, "prt_live", `short\n${"x".repeat(60)}`)
      expect(rig.table().chars.get("part:prt_live")).toBe(60)
    }))
})

describe("the messages of the table", () => {
  test("go away with their rows when the session is replaced", () =>
    withTable(conversation(5), (rig) => {
      const before = rig.table().rows.length
      expect(before).toBeGreaterThan(10)

      rig.setStore(
        "message",
        produce((messages) => void messages.splice(0, messages.length)),
      )

      expect(rig.table().rows).toEqual([])
      expect(rig.table().streaming.size).toBe(0)
      expect(rig.table().chars.size).toBe(0)
    }))

  test("keep the row objects of the messages that did not change when another one does", () =>
    withTable(conversation(10), (rig) => {
      const before = rig.table().rows
      const reply = assistantMessage("msg_next", 100, { finish: undefined, time: { created: 100 } })

      rig.setStore("message", (messages) => [...messages, reply])
      rig.setStore("part", reply.id, [text(reply.id, "prt_next", "next")])

      const after = rig.table().rows
      expect(after.length).toBeGreaterThan(before.length)
      // The old last message loses its "last assistant" summary only if it was not final: these were final.
      for (const row of before) expect(after).toContain(row)
    }))
})

describe("the summary of the last assistant message", () => {
  test("moves to the new last message and leaves the one before it that did not finish", () =>
    withTable(
      [
        { info: userMessage("msg_u", 1), parts: [text("msg_u", "prt_u", "go")] },
        {
          info: assistantMessage("msg_first", 2, { finish: "tool-calls" }),
          parts: [text("msg_first", "prt_first", "one")],
        },
      ],
      (rig) => {
        const summaries = () =>
          rig
            .table()
            .rows.filter((row) => row.kind === "meta")
            .map((row) => row.messageID)
        expect(summaries()).toEqual(["msg_first"])

        rig.setStore("message", (messages) => [...messages, assistantMessage("msg_second", 3, { finish: undefined })])
        rig.setStore("part", "msg_second", [text("msg_second", "prt_second", "two")])

        expect(summaries()).toEqual(["msg_second"])
        expect(shapeOf(rig.table())).toEqual(rig.reference())
      },
    ))
})
