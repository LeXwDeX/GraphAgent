// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { ChildRunTable } from "@graphagent/core/session/child.sql"
import { eq } from "drizzle-orm"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { ChildOwner, ChildRunOutcome } from "@/session/child/types"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { TaskRead } from "@/tool/task-read"
import { Parameters as TaskParameters, TaskTool } from "@/tool/task"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { initTaskTool } from "../lib/child-runs"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

/**
 * `task action="read"` (#1453): the log of a task this conversation started, a page at a time. `TaskRead` builds the
 * log and cuts it into pages; the tool checks whose task it is and writes the page with its header.
 */

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

type PartSpec =
  { readonly text: string } | { readonly tool: string; readonly state: SessionV1.ToolState; readonly callID?: string }

const completed = (
  input: Record<string, unknown>,
  output: string,
  metadata: Record<string, unknown> = {},
): SessionV1.ToolState => ({
  status: "completed",
  input,
  output,
  title: "done",
  metadata,
  time: { start: 1, end: 2 },
})

const failed = (
  input: Record<string, unknown>,
  error: string,
  metadata?: Record<string, unknown>,
): SessionV1.ToolState => ({
  status: "error",
  input,
  error,
  ...(metadata ? { metadata } : {}),
  time: { start: 1, end: 2 },
})

const running = (input: Record<string, unknown>): SessionV1.ToolState => ({
  status: "running",
  input,
  time: { start: 1 },
})

const pending = (input: Record<string, unknown>): SessionV1.ToolState => ({ status: "pending", input, raw: "" })

function partOf(sessionID: SessionID, messageID: MessageID, spec: PartSpec, index: number): SessionV1.Part {
  const base = { id: PartID.ascending(), sessionID, messageID }
  if ("text" in spec) return { ...base, type: "text", text: spec.text }
  return { ...base, type: "tool", callID: spec.callID ?? `call_${index}`, tool: spec.tool, state: spec.state }
}

const assistantInfo = (sessionID: SessionID): SessionV1.Assistant => ({
  id: MessageID.ascending(),
  role: "assistant",
  parentID: MessageID.ascending(),
  sessionID,
  mode: "explore",
  agent: "explore",
  cost: 0,
  path: { cwd: "/tmp", root: "/tmp" },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  modelID: ref.modelID,
  providerID: ref.providerID,
  time: { created: Date.now() },
})

const UNIT_SESSION = SessionID.make("ses_taskread_unit")

/** An assistant message of the child session, with the parts in order. */
function assistant(...specs: PartSpec[]): SessionV1.WithParts {
  const info = assistantInfo(UNIT_SESSION)
  return { info, parts: specs.map((spec, index) => partOf(UNIT_SESSION, info.id, spec, index)) }
}

/** The message that started the child; the log never reads it. */
function user(text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: { id, role: "user", sessionID: UNIT_SESSION, agent: "build", model: ref, time: { created: 1 } },
    parts: [partOf(UNIT_SESSION, id, { text }, 0)],
  }
}

/** The text of one index line: what a model reads for that call. */
const indexLine = (doc: string, number: number) => doc.split("\n").find((line) => line.startsWith(`${number}. `))

describe("TaskRead.document", () => {
  test("the latest assistant text leads, then an index of the tool calls in the order they were made", () => {
    const doc = TaskRead.document([
      user("find the cache key"),
      assistant(
        { text: "Looking around." },
        { tool: "read", state: completed({ filePath: "/a.ts" }, "x".repeat(2048)) },
      ),
      assistant({ tool: "grep", state: failed({ pattern: "p" }, "no such file") }),
      assistant({ text: "The key is built in a.ts." }),
    ])

    expect(doc).toBe(
      [
        "Final message:",
        "The key is built in a.ts.",
        "",
        "Tool calls (2):",
        '1. read {"filePath":"/a.ts"} | completed | 2.0 KB',
        '2. grep {"pattern":"p"} | error | 12 B',
      ].join("\n"),
    )
  })

  test("a message with no text is passed over for the latest one that has some", () => {
    const doc = TaskRead.document([
      assistant({ text: "first thoughts" }),
      assistant({ text: "  \n" }, { tool: "read", state: completed({}, "") }),
      assistant({ tool: "read", state: completed({}, "") }),
    ])

    expect(doc.split("\n").slice(0, 2)).toEqual(["Final message:", "first thoughts"])
  })

  test("all the text of the message is the final message, its parts one to a line", () => {
    const doc = TaskRead.document([
      assistant({ text: "one" }, { tool: "glob", state: completed({}, "") }, { text: "two" }),
    ])

    expect(doc.split("\n").slice(0, 3)).toEqual(["Final message:", "one", "two"])
  })

  test("no text anywhere reads (none), and no calls read as an empty index", () => {
    expect(TaskRead.document([])).toBe(["Final message:", "(none)", "", "Tool calls (0):"].join("\n"))
    expect(TaskRead.document([user("hi"), assistant({ tool: "glob", state: completed({}, "") })])).toContain(
      "Final message:\n(none)\n",
    )
  })

  test("an input longer than 80 characters is cut there and marked, one of exactly 80 is not", () => {
    const long = JSON.stringify({ query: "q".repeat(200) })
    const exact = JSON.stringify({ k: "x".repeat(72) })
    const over = JSON.stringify({ k: "x".repeat(73) })
    expect(exact).toHaveLength(80)
    expect(over).toHaveLength(81)

    const doc = TaskRead.document([
      assistant(
        { tool: "grep", state: running({ query: "q".repeat(200) }) },
        { tool: "grep", state: running({ k: "x".repeat(72) }) },
        { tool: "grep", state: running({ k: "x".repeat(73) }) },
      ),
    ])

    expect(indexLine(doc, 1)).toBe(`1. grep ${long.slice(0, 80)}... | running | -`)
    expect(indexLine(doc, 2)).toBe(`2. grep ${exact} | running | -`)
    expect(indexLine(doc, 3)).toBe(`3. grep ${over.slice(0, 80)}... | running | -`)
  })

  test("the cut never splits a surrogate pair", () => {
    // The high half is the 80th character: a cut at 80 would leave it alone.
    const input = { a: "x".repeat(73) + "😀tail" }
    const doc = TaskRead.document([assistant({ tool: "grep", state: running(input) })])
    const line = indexLine(doc, 1) ?? ""

    expect(line).not.toContain("😀")
    expect(line).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
    expect(line.endsWith("... | running | -")).toBe(true)
  })

  test("pending and running calls have no result size, a finished one has the bytes of what it stored", () => {
    const doc = TaskRead.document([
      assistant(
        { tool: "glob", state: pending({}) },
        { tool: "glob", state: running({}) },
        { tool: "read", state: completed({}, "é".repeat(1024)) },
        { tool: "read", state: completed({}, "") },
        { tool: "read", state: failed({}, "é".repeat(1024)) },
      ),
    ])

    expect(doc.split("\n").slice(-5)).toEqual([
      "1. glob {} | pending | -",
      "2. glob {} | running | -",
      "3. read {} | completed | 2.0 KB",
      "4. read {} | completed | 0 B",
      "5. read {} | error | 2.0 KB",
    ])
  })

  test("a result saved to a file names it at the end of its line", () => {
    const doc = TaskRead.document([
      assistant(
        {
          tool: "read",
          state: completed({}, "x".repeat(1536), { truncated: true, outputPath: "/data/tool-output/tool_1" }),
        },
        { tool: "bash", state: failed({}, "boom", { truncated: true, outputPath: "/data/tool-output/tool_2" }) },
        { tool: "read", state: completed({}, "", { outputPath: "" }) },
        { tool: "read", state: completed({}, "", { outputPath: 5 }) },
        { tool: "read", state: completed({}, "", { truncated: false }) },
      ),
    ])

    expect(doc.split("\n").slice(-5)).toEqual([
      "1. read {} | completed | 1.5 KB | saved: /data/tool-output/tool_1",
      "2. bash {} | error | 4 B | saved: /data/tool-output/tool_2",
      "3. read {} | completed | 0 B",
      "4. read {} | completed | 0 B",
      "5. read {} | completed | 0 B",
    ])
  })

  test("a line break in a tool name, an input or a saved path does not start a line of its own", () => {
    // JSON leaves U+2028 as it is, so an input can carry one.
    const separator = String.fromCharCode(0x2028)
    const doc = TaskRead.document([
      assistant({
        tool: "mcp\nread",
        state: completed({ note: `a${separator}b` }, "", { outputPath: "/data/a\n9. forged" }),
      }),
    ])

    expect(doc.split("\n")).toHaveLength(5)
    expect(doc.split("\n").at(-1)).toBe('1. mcp read {"note":"a b"} | completed | 0 B | saved: /data/a 9. forged')
  })
})

describe("TaskRead.slice", () => {
  const doc = "a".repeat(8000) + "b".repeat(8000) + "c".repeat(4000)

  test("a log that fits is one page", () => {
    expect(TaskRead.slice("short log", 1)).toEqual({ ok: true, text: "short log", page: 1, pages: 1 })
    expect(TaskRead.slice("short log", -1)).toEqual({ ok: true, text: "short log", page: 1, pages: 1 })
  })

  test("pages are 8000 characters each and together they are the whole log", () => {
    const first = TaskRead.slice(doc, 1)
    const second = TaskRead.slice(doc, 2)
    const third = TaskRead.slice(doc, 3)

    expect(first).toEqual({ ok: true, text: "a".repeat(8000), page: 1, pages: 3 })
    expect(second).toEqual({ ok: true, text: "b".repeat(8000), page: 2, pages: 3 })
    expect(third).toEqual({ ok: true, text: "c".repeat(4000), page: 3, pages: 3 })
    expect([first, second, third].map((page) => (page.ok ? page.text : "")).join("")).toBe(doc)
  })

  test("-1 is the last page, answered with its own number", () => {
    expect(TaskRead.slice(doc, -1)).toEqual({ ok: true, text: "c".repeat(4000), page: 3, pages: 3 })
    expect(TaskRead.slice("x".repeat(8000), -1)).toMatchObject({ ok: true, page: 1, pages: 1 })
    expect(TaskRead.slice("x".repeat(8001), -1)).toMatchObject({ ok: true, page: 2, pages: 2 })
  })

  test("0 is refused with how to ask for the first and the last page", () => {
    expect(TaskRead.slice(doc, 0)).toEqual({
      ok: false,
      error: "page must not be 0; use 1 for the first page or -1 for the last.",
    })
  })

  test("a page past either end is refused with the range the log has", () => {
    const range = "this log has 3 page(s). Use 1 to 3, or -1 for the last page."
    expect(TaskRead.slice(doc, 4)).toEqual({ ok: false, error: `page 4 is out of range: ${range}` })
    expect(TaskRead.slice(doc, -2)).toEqual({ ok: false, error: `page -2 is out of range: ${range}` })
    expect(TaskRead.slice(doc, -4)).toEqual({ ok: false, error: `page -4 is out of range: ${range}` })
    expect(TaskRead.slice("short log", 2)).toEqual({
      ok: false,
      error: "page 2 is out of range: this log has 1 page(s). Use 1 to 1, or -1 for the last page.",
    })
  })

  test("a page never ends between the two halves of a surrogate pair", () => {
    const text = "a".repeat(7999) + "😀tail"
    const first = TaskRead.slice(text, 1)
    const second = TaskRead.slice(text, 2)

    expect(first).toMatchObject({ ok: true, text: "a".repeat(7999), pages: 2 })
    expect(second).toMatchObject({ ok: true, text: "😀tail" })
  })
})

const baseLayer = Layer.mergeAll(
  Agent.defaultLayer,
  BackgroundJob.defaultLayer,
  EventV2Bridge.defaultLayer,
  Config.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Session.defaultLayer,
  SessionRunState.defaultLayer,
  SessionStatus.defaultLayer,
  Truncate.defaultLayer,
  ToolRegistry.defaultLayer,
  Database.defaultLayer,
  RuntimeFlags.layer({}),
).pipe(Layer.provide(Ripgrep.defaultLayer))

const it = testEffect(baseLayer)

const seed = Effect.fn("TaskReadTest.seed")(function* (title = "Reading") {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant = yield* sessions.updateMessage({ ...assistantInfo(chat.id), parentID: user.id, agent: "build" })
  return { chat, assistant }
})

/** Writes the messages a child session recorded: one assistant message to a list of parts. */
const record = Effect.fn("TaskReadTest.record")(function* (
  sessionID: SessionID,
  messages: ReadonlyArray<ReadonlyArray<PartSpec>>,
) {
  const sessions = yield* Session.Service
  for (const specs of messages) {
    const info = yield* sessions.updateMessage(assistantInfo(sessionID))
    for (const [index, spec] of specs.entries()) yield* sessions.updatePart(partOf(sessionID, info.id, spec, index))
  }
})

const runsOf = (childSessionID: SessionID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(ChildRunTable)
      .where(eq(ChildRunTable.child_session_id, childSessionID))
      .all()
      .pipe(Effect.orDie)
  })

/** The text of a failed call, whatever it failed with. */
const failureOf = (exit: Exit.Exit<unknown, unknown>): string => {
  if (!Exit.isFailure(exit)) return "(the call succeeded)"
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error.message : String(error)
}

/** A parent conversation, a task tool bound to it, and the means to leave a task of its own (or not its own) to read. */
const harness = Effect.fn("TaskReadTest.harness")(function* () {
  const sessions = yield* Session.Service
  const { chat, assistant } = yield* seed()
  const def = yield* initTaskTool(yield* TaskTool)
  const asks: string[] = []
  const ctx = (sessionID: SessionID = chat.id): Tool.Context => ({
    sessionID,
    messageID: assistant.id,
    agent: "build",
    abort: new AbortController().signal,
    extra: {},
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.sync(() => {
        asks.push(request.permission)
      }),
  })
  /** A child session of `parent` that holds `log`, and the run that started it, ended as `outcome` when one is given. */
  const child = Effect.fn("TaskReadTest.child")(function* (
    log: ReadonlyArray<ReadonlyArray<PartSpec>>,
    options: { parent?: SessionID; owner?: ChildOwner; outcome?: ChildRunOutcome; agent?: string } = {},
  ) {
    const parent = options.parent ?? chat.id
    const created = yield* sessions.create({
      parentID: parent,
      role: options.owner?.kind === "dag_node" ? "dag_node" : "task_child",
      title: "inspect bug (@explore subagent)",
      agent: options.agent ?? "explore",
    })
    const run = yield* def.children
      .forParent(parent)
      .start({ childSessionID: created.id, owner: options.owner ?? { kind: "task" }, detached: false })
    yield* record(created.id, log)
    if (options.outcome) yield* run.settle(options.outcome)
    return created.id
  })
  return { sessions, chat, assistant, def, asks, ctx, child }
})

// The log of the task the pages tests read: a final message long enough for a second page, and two tool calls.
const FINAL = "F".repeat(9000)
const LOG: ReadonlyArray<ReadonlyArray<PartSpec>> = [
  [
    { text: "Looking around." },
    {
      tool: "read",
      state: completed({ filePath: "/a.ts" }, "x".repeat(3072), { outputPath: "/data/tool-output/tool_9" }),
    },
  ],
  [{ tool: "grep", state: failed({ pattern: "p" }, "no such file") }],
  [{ text: FINAL }],
]

describe("tool.task read", () => {
  it.instance(
    "answers page 1 with a header, the first 8000 characters of the log and how to ask for the next page",
    () =>
      Effect.gen(function* () {
        const { def, ctx, child } = yield* harness()
        const task = yield* child(LOG, { outcome: { type: "completed" } })

        const result = yield* def.execute({ action: "read", task_id: task }, ctx())

        const lines = result.output.split("\n")
        expect(lines.slice(0, 5)).toEqual([`task_id: ${task}`, "agent: explore", "state: completed", "page 1/2", ""])
        expect(lines[5]).toBe("Final message:")
        expect(lines[6]).toBe("F".repeat(7985))
        expect(lines).toHaveLength(8)
        expect(lines[7]).toBe(`Next page: task action="read" task_id="${task}" page=2`)
        expect(result.title).toBe("Task log")
        // The tool wrapper adds `truncated`; the call's own metadata is the task and where in its log the page is.
        expect(result.metadata).toMatchObject({ taskID: task, page: 1, pages: 2 })
      }),
  )

  it.instance("page is optional and 1 is the first page", () =>
    Effect.gen(function* () {
      const { def, ctx, child } = yield* harness()
      const task = yield* child(LOG, { outcome: { type: "completed" } })

      const omitted = yield* def.execute({ action: "read", task_id: task }, ctx())
      const first = yield* def.execute({ action: "read", task_id: task, page: 1 }, ctx())

      expect(first.output).toBe(omitted.output)
      expect(first.metadata).toEqual(omitted.metadata)
    }),
  )

  it.instance("the last page carries the rest of the log, the index of tool calls, and no next page", () =>
    Effect.gen(function* () {
      const { def, ctx, child } = yield* harness()
      const task = yield* child(LOG, { outcome: { type: "completed" } })

      const second = yield* def.execute({ action: "read", task_id: task, page: 2 }, ctx())
      const last = yield* def.execute({ action: "read", task_id: task, page: -1 }, ctx())

      expect(last.output).toBe(second.output)
      expect(last.metadata).toMatchObject({ taskID: task, page: 2, pages: 2 })
      expect(last.output.split("\n").slice(0, 5)).toEqual([
        `task_id: ${task}`,
        "agent: explore",
        "state: completed",
        "page 2/2",
        "",
      ])
      expect(last.output.split("\n").slice(-5)).toEqual([
        "F".repeat(1015),
        "",
        "Tool calls (2):",
        '1. read {"filePath":"/a.ts"} | completed | 3.0 KB | saved: /data/tool-output/tool_9',
        '2. grep {"pattern":"p"} | error | 12 B',
      ])
      expect(last.output).not.toContain("Next page")
    }),
  )

  it.instance("the state is how the run stands: queued while it waits, how it ended once it has", () =>
    Effect.gen(function* () {
      const { def, ctx, child } = yield* harness()
      const stateOf = (task: SessionID) =>
        def.execute({ action: "read", task_id: task }, ctx()).pipe(Effect.map((result) => result.output.split("\n")[2]))

      expect(yield* stateOf(yield* child(LOG))).toBe("state: queued")
      expect(yield* stateOf(yield* child(LOG, { outcome: { type: "error", message: "boom" } }))).toBe("state: error")
      expect(yield* stateOf(yield* child(LOG, { outcome: { type: "interrupted" } }))).toBe("state: interrupted")
    }),
  )

  it.instance("a session with no recorded agent reads agent: unknown", () =>
    Effect.gen(function* () {
      const { sessions, chat, def, ctx } = yield* harness()
      const created = yield* sessions.create({ parentID: chat.id, role: "task_child", title: "no agent" })
      yield* def.children
        .forParent(chat.id)
        .start({ childSessionID: created.id, owner: { kind: "task" }, detached: false })
        .pipe(Effect.flatMap((run) => run.settle({ type: "completed" })))

      const result = yield* def.execute({ action: "read", task_id: created.id }, ctx())

      expect(result.output.split("\n").slice(0, 4)).toEqual([
        `task_id: ${created.id}`,
        "agent: unknown",
        "state: completed",
        "page 1/1",
      ])
    }),
  )

  it.instance("0 and pages outside the log are refused with what to ask for", () =>
    Effect.gen(function* () {
      const { def, ctx, child } = yield* harness()
      const task = yield* child(LOG, { outcome: { type: "completed" } })
      const read = (page: number) => def.execute({ action: "read", task_id: task, page }, ctx()).pipe(Effect.exit)

      expect(failureOf(yield* read(0))).toBe("page must not be 0; use 1 for the first page or -1 for the last.")
      const range = "this log has 2 page(s). Use 1 to 2, or -1 for the last page."
      expect(failureOf(yield* read(3))).toBe(`page 3 is out of range: ${range}`)
      expect(failureOf(yield* read(-2))).toBe(`page -2 is out of range: ${range}`)
      expect(failureOf(yield* read(-3))).toBe(`page -3 is out of range: ${range}`)
    }),
  )

  it.instance("reading asks nothing, writes nothing and names no session in its metadata", () =>
    Effect.gen(function* () {
      const { sessions, chat, def, asks, ctx, child } = yield* harness()
      const task = yield* child(LOG, { outcome: { type: "completed" } })
      const messagesBefore = (yield* sessions.messages({ sessionID: task })).length
      const runsBefore = yield* runsOf(task)
      const childrenBefore = (yield* sessions.children(chat.id)).length

      const result = yield* def.execute({ action: "read", task_id: task, page: 1 }, ctx())

      expect(asks).toEqual([])
      expect((yield* sessions.messages({ sessionID: task })).length).toBe(messagesBefore)
      expect(yield* runsOf(task)).toEqual(runsBefore)
      expect((yield* sessions.children(chat.id)).length).toBe(childrenBefore)
      // A tool call whose metadata names a session is read as the call that started it (the TUI row, the run view).
      expect(result.metadata).not.toHaveProperty("sessionID")
      expect(result.metadata).not.toHaveProperty("sessionId")
    }),
  )

  it.instance("reads the log of a run that has not ended: what the child has recorded so far", () =>
    Effect.gen(function* () {
      const { def, ctx, child } = yield* harness()
      const task = yield* child([[{ text: "half way" }, { tool: "grep", state: running({ pattern: "p" }) }]])

      const result = yield* def.execute({ action: "read", task_id: task }, ctx())

      expect(result.output.split("\n").slice(-5)).toEqual([
        "Final message:",
        "half way",
        "",
        "Tool calls (1):",
        '1. grep {"pattern":"p"} | running | -',
      ])
    }),
  )

  it.instance("refuses a task_id that is not a task of this conversation, and reads nothing for it", () =>
    Effect.gen(function* () {
      const { sessions, chat, def, asks, ctx, child } = yield* harness()
      const other = yield* seed("Other conversation")
      // Another conversation's task, a DAG node of this conversation, and a child of this conversation nobody registered.
      const theirs = yield* child(LOG, { parent: other.chat.id, outcome: { type: "completed" } })
      const node = yield* child(LOG, {
        owner: { kind: "dag_node", workflowID: "wf_1", nodeID: "node_1", attempt: 1 },
        outcome: { type: "completed" },
      })
      const unregistered = yield* sessions.create({ parentID: chat.id, role: "task_child", title: "unregistered" })
      yield* record(unregistered.id, LOG)

      const targets: Array<[string, string]> = [
        ["another conversation's task", theirs],
        ["a DAG node's session", node],
        ["an unregistered child session", unregistered.id],
        ["a top-level session", other.chat.id],
        ["the calling session itself", chat.id],
        ["an id no session has", "ses_does_not_exist"],
        ["a string that is not an id", "not even a session id"],
      ]
      for (const [label, target] of targets) {
        const exit = yield* def.execute({ action: "read", task_id: target }, ctx()).pipe(Effect.exit)
        expect(failureOf(exit), label).toBe(
          `task_id "${target}" is not a task started by this conversation. Pass the task_id of a task this conversation started.`,
        )
      }
      expect(asks).toEqual([])
    }),
  )

  it.instance("a task_id that is not an id is named in the refusal only as far as the name limit", () =>
    Effect.gen(function* () {
      const { def, ctx } = yield* harness()

      const exit = yield* def.execute({ action: "read", task_id: "z".repeat(500) }, ctx()).pipe(Effect.exit)

      expect(failureOf(exit)).toBe(
        `task_id "${"z".repeat(64)}" is not a task started by this conversation. Pass the task_id of a task this conversation started.`,
      )
    }),
  )

  it.instance("a child session cannot read: the refusal comes before anything is looked up", () =>
    Effect.gen(function* () {
      const { chat, def, asks, ctx, child } = yield* harness()
      const task = yield* child(LOG, { outcome: { type: "completed" } })
      // A child of this conversation calling the tool with the id of a task this conversation could read.
      const caller = yield* child([], { outcome: { type: "completed" } })

      const exit = yield* def.execute({ action: "read", task_id: task }, ctx(caller)).pipe(Effect.exit)

      expect(failureOf(exit)).toBe("Task delegation is available only to the main conversation, not child agents")
      expect(asks).toEqual([])
      // The same call from the conversation itself reads it.
      expect((yield* def.execute({ action: "read", task_id: task }, ctx(chat.id))).output).toContain("Final message:")
    }),
  )

  const shapeFault = Effect.fn("TaskReadTest.shapeFault")(function* (args: Schema.Schema.Type<typeof TaskParameters>) {
    const { def, asks, ctx } = yield* harness()
    const exit = yield* def.execute(args, ctx()).pipe(Effect.exit)
    if (!Exit.isFailure(exit)) throw new Error("expected the call to be rejected")
    const error = Cause.squash(exit.cause)
    if (!(error instanceof Tool.InvalidArgumentsError))
      throw new Error(`expected InvalidArgumentsError, got ${String(error)}`)
    return { detail: error.detail, asks }
  })

  it.instance("a read that carries run arguments is rejected before anything is asked, naming them", () =>
    Effect.gen(function* () {
      expect(
        yield* shapeFault({
          action: "read",
          task_id: "ses_child",
          description: "d",
          prompt: "p",
          subagent_type: "general",
          background: false,
        }),
      ).toEqual({
        detail: 'action "read" takes only task_id and page; remove description, prompt, subagent_type, background.',
        asks: [],
      })
      expect(yield* shapeFault({ action: "read", task_id: "ses_child", page: 2, background: true })).toEqual({
        detail: 'action "read" takes only task_id and page; remove background.',
        asks: [],
      })
    }),
  )

  it.instance("a read without a task_id, and a page without a read, are rejected", () =>
    Effect.gen(function* () {
      expect(yield* shapeFault({ action: "read" })).toEqual({
        detail: 'task_id is required when action is "read".',
        asks: [],
      })
      expect(yield* shapeFault({ task_id: "ses_child", action: "cancel", page: 1 })).toEqual({
        detail: 'page is only used with action "read".',
        asks: [],
      })
      expect(yield* shapeFault({ action: "resume", task_id: "ses_child", page: 1 })).toEqual({
        detail: 'page is only used with action "read".',
        asks: [],
      })
      expect(yield* shapeFault({ description: "d", prompt: "p", subagent_type: "general", page: 1 })).toEqual({
        detail: 'page is only used with action "read".',
        asks: [],
      })
    }),
  )
})
