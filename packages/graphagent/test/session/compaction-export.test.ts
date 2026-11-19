// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Cause, Effect, Exit, FileSystem } from "effect"
import path from "node:path"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { CompactionExport } from "@/session/compaction-export"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("ses_export_unit")
const compactionID = MessageID.make("msg_export_marker")
const directory = path.resolve("/work/project")
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const created = Date.UTC(2026, 10, 19, 8, 30, 15)
const header =
  "# Messages compacted from session ses_export_unit (compaction msg_export_marker). Reasoning parts are not included."

// A part without the ids the message gives it.
type Body<T = SessionV1.Part> = T extends unknown ? Omit<T, "id" | "sessionID" | "messageID"> : never

// A stored message: the export reads the role, the id, the creation time and the parts.
function message(role: "user" | "assistant", bodies: readonly Body[], id = MessageID.ascending(), time = created) {
  const info: SessionV1.Info =
    role === "user"
      ? { id, sessionID, role, time: { created: time }, agent: "build", model }
      : {
          id,
          sessionID,
          role,
          time: { created: time },
          parentID: MessageID.ascending(),
          mode: "build",
          agent: "build",
          path: { cwd: directory, root: directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.modelID,
          providerID: model.providerID,
        }
  return { info, parts: bodies.map((body) => ({ ...body, id: PartID.ascending(), sessionID, messageID: id })) }
}

const text = (value: string): Body => ({ type: "text", text: value })
const reasoning = (value: string): Body => ({ type: "reasoning", text: value, time: { start: 1, end: 2 } })
const file = (mime: string, filename?: string): Body => ({
  type: "file",
  mime,
  url: "https://example.com/data",
  ...(filename === undefined ? {} : { filename }),
})
const patch = (...files: string[]): Body => ({ type: "patch", hash: "h", files })
const tool = (name: string, state: SessionV1.ToolState): Body => ({
  type: "tool",
  callID: `call_${name}`,
  tool: name,
  state,
})
const done = (input: Record<string, unknown>, output: string): SessionV1.ToolState => ({
  status: "completed",
  input,
  output,
  title: "t",
  metadata: {},
  time: { start: 1, end: 2 },
})
const failed = (input: Record<string, unknown>, error: string): SessionV1.ToolState => ({
  status: "error",
  input,
  error,
  time: { start: 1, end: 2 },
})
const running = (input: Record<string, unknown>): SessionV1.ToolState => ({
  status: "running",
  input,
  time: { start: 1 },
})
const pending = (input: Record<string, unknown>): SessionV1.ToolState => ({ status: "pending", input, raw: "{" })

const render = (...messages: SessionV1.WithParts[]) => CompactionExport.render({ sessionID, compactionID, messages })

describe("CompactionExport.render", () => {
  test("starts with a header that names the session and the compaction", () => {
    expect(render().split("\n")[0]).toBe(header)
  })

  test("puts each message under a role, id and time line, in the order given", () => {
    const first = message("user", [text("fix the parser bug")], MessageID.make("msg_export_first"))
    const second = message("assistant", [text("on it")], MessageID.make("msg_export_second"), created + 5_000)

    expect(render(first, second)).toBe(
      [
        header,
        "",
        "=== user msg_export_first 2026-11-19T08:30:15.000Z",
        "fix the parser bug",
        "",
        "=== assistant msg_export_second 2026-11-19T08:30:20.000Z",
        "on it",
        "",
      ].join("\n"),
    )
  })

  test("writes text as it was written: nothing trimmed, cut or escaped", () => {
    const body = `  indented\n\n\ttabbed ${"long ".repeat(2_000)}\n=== user msg_fake 1970-01-01T00:00:00.000Z\n<b>中文 ✓</b>\n`

    expect(render(message("user", [text(body)]))).toContain(`\n${body}\n`)
  })

  test("writes text parts in their order and leaves reasoning out", () => {
    const out = render(
      message("assistant", [text("first"), reasoning("SECRET-THOUGHT"), text("second"), reasoning("MORE-THOUGHT")]),
    )

    expect(out).toContain("\nfirst\nsecond\n")
    expect(out).not.toContain("SECRET-THOUGHT")
    expect(out).not.toContain("MORE-THOUGHT")
  })

  test("writes a tool call as one line of name, state and input, then its complete output", () => {
    const output = Array.from({ length: 400 }, (_, index) => `line ${index} ${"x".repeat(20)}`).join("\n")
    const out = render(
      message("assistant", [tool("write", done({ filePath: "/p/a.ts", content: "one\ntwo" }, output))]),
    )

    expect(output.length).toBeGreaterThan(2_000)
    // The input is one line: the newline inside the content is JSON's escape, not a line break.
    expect(out.split("\n")).toContain('[tool write completed] {"filePath":"/p/a.ts","content":"one\\ntwo"}')
    expect(out).toContain(`\n${output}\n`)
  })

  test("writes the error of a failed call, and only the line for a call that never finished", () => {
    const out = render(
      message("assistant", [
        tool("edit", failed({ filePath: "/p/a.ts" }, "oldString not found\nin /p/a.ts")),
        tool("shell", running({ command: "sleep 99" })),
        tool("read", pending({ filePath: "/p/b.ts" })),
        tool("glob", done({ pattern: "*" }, "")),
      ]),
    )

    expect(out).toContain('[tool edit error] {"filePath":"/p/a.ts"}\noldString not found\nin /p/a.ts\n')
    expect(out).toContain('[tool shell running] {"command":"sleep 99"}\n[tool read pending] {"filePath":"/p/b.ts"}\n')
    expect(out).toContain('[tool glob completed] {"pattern":"*"}\n')
  })

  test("sums up patch and file parts in one line each", () => {
    const out = render(
      message("user", [text("look"), file("image/png", "cat.png"), file("text/plain")]),
      message("assistant", [patch("/p/a.ts", "/p/b.ts"), patch()]),
    )

    expect(out).toContain("look\n[Attached image/png: cat.png]\n[Attached text/plain: file]\n")
    expect(out).toContain("[patch] /p/a.ts, /p/b.ts\n")
    expect(out.match(/\[patch\]/g)).toHaveLength(1)
  })

  test("skips the parts that carry no content of their own, and keeps the line of a message left empty", () => {
    const id = MessageID.make("msg_export_bare")
    const out = render(
      message(
        "assistant",
        [
          reasoning("hidden"),
          { type: "step-start" },
          { type: "snapshot", snapshot: "tree-hash" },
          { type: "agent", name: "explore" },
          { type: "compaction", auto: true },
          { type: "subtask", prompt: "DO-NOT-LIST", description: "d", agent: "build" },
          text(""),
        ],
        id,
      ),
    )

    expect(out).toBe([header, "", "=== assistant msg_export_bare 2026-11-19T08:30:15.000Z", ""].join("\n"))
  })
})

describe("CompactionExport.retrievalNote", () => {
  test("names the file, how to search and read it, and where the exports of the session are", () => {
    const saved = "/data/tool-output/compacted_ses_x_msg_y.txt"

    expect(CompactionExport.retrievalNote({ path: saved, sessionID: SessionID.make("ses_x") })).toBe(
      `Earlier messages were saved verbatim in ${saved}; each starts with a "=== role id time" line. Search it with grep (pattern, path="${saved}") or read a range with read (filePath="${saved}", offset, limit). All exports of this session: ${TRUNCATION_DIR}/compacted_ses_x_*.txt.`,
    )
  })
})

const it = testEffect(NodeFileSystem.layer)

const inDir = (name: string) => path.join(TRUNCATION_DIR, name)

// An entry of the tool output directory that goes away with the test: a file, or a directory with `directory`.
const planted = Effect.fn("test.planted")(function* (name: string, directory = false) {
  const fs = yield* FileSystem.FileSystem
  const target = inDir(name)
  yield* fs.makeDirectory(directory ? target : TRUNCATION_DIR, { recursive: true })
  if (!directory) yield* fs.writeFileString(target, "kept")
  yield* Effect.addFinalizer(() => fs.remove(target, { recursive: true, force: true }).pipe(Effect.orDie))
  return target
})

describe("CompactionExport.write", () => {
  it.live("writes the render to a file named after the session and the compaction", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const messages = [message("user", [text("fix the parser bug")]), message("assistant", [text("on it")])]
      const input = { sessionID: SessionID.make("ses_export_write"), compactionID, messages }
      yield* Effect.addFinalizer(() => fs.remove(CompactionExport.pathOf(input), { force: true }).pipe(Effect.orDie))

      const saved = yield* CompactionExport.write(input)

      expect(saved).toBe(inDir("compacted_ses_export_write_msg_export_marker.txt"))
      expect(saved).toBe(CompactionExport.pathOf(input))
      expect(yield* fs.readFileString(saved)).toBe(CompactionExport.render(input))
    }),
  )

  it.live("leaves the file to its owner alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const input = { sessionID: SessionID.make("ses_export_mode"), compactionID, messages: [] }
      yield* Effect.addFinalizer(() => fs.remove(CompactionExport.pathOf(input), { force: true }).pipe(Effect.orDie))

      const saved = yield* CompactionExport.write(input)

      // Windows has no owner bits to read.
      if (process.platform !== "win32") expect((yield* fs.stat(saved)).mode & 0o777).toBe(0o600)
    }),
  )

  it.live("gives each compaction a file of its own and replaces the file of the same compaction", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const base = { sessionID: SessionID.make("ses_export_twice") }
      const first = {
        ...base,
        compactionID: MessageID.make("msg_export_one"),
        messages: [message("user", [text("a")])],
      }
      const second = {
        ...base,
        compactionID: MessageID.make("msg_export_two"),
        messages: [message("user", [text("b")])],
      }
      for (const input of [first, second])
        yield* Effect.addFinalizer(() => fs.remove(CompactionExport.pathOf(input), { force: true }).pipe(Effect.orDie))

      const one = yield* CompactionExport.write(first)
      const two = yield* CompactionExport.write(second)
      yield* CompactionExport.write({ ...first, messages: [message("user", [text("a again")])] })

      expect(one).not.toBe(two)
      expect(yield* fs.readFileString(one)).toContain("\na again\n")
      expect(yield* fs.readFileString(one)).not.toContain("\na\n")
      expect(yield* fs.readFileString(two)).toContain("\nb\n")
    }),
  )

  it.live("fails, without a defect, when the file cannot be written", () =>
    Effect.gen(function* () {
      const input = { sessionID: SessionID.make("ses_export_blocked"), compactionID, messages: [] }
      // A directory where the file belongs.
      yield* planted(path.basename(CompactionExport.pathOf(input)), true)

      const exit = yield* CompactionExport.write(input).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && !Cause.hasDies(exit.cause) && !Cause.hasInterrupts(exit.cause)).toBe(true)
    }),
  )
})

describe("CompactionExport.clear", () => {
  it.live("deletes the exports of the session and no other file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const exports = [
        yield* planted("compacted_ses_export_clear_msg_one.txt"),
        yield* planted("compacted_ses_export_clear_msg_two.txt"),
      ]
      // Another session whose id starts with this one's, a third one, and a file of the tool outputs.
      const kept = [
        yield* planted("compacted_ses_export_clear2_msg_one.txt"),
        yield* planted("compacted_ses_export_other_msg_one.txt"),
        yield* planted("tool_export_clear_neighbor"),
      ]

      yield* CompactionExport.clear(SessionID.make("ses_export_clear"))

      for (const target of exports) expect(yield* fs.exists(target)).toBe(false)
      for (const target of kept) expect(yield* fs.exists(target)).toBe(true)
    }),
  )

  it.live("goes on past an entry it cannot remove, and has nothing to say when there is nothing to remove", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      // A directory that is not empty cannot be removed without `recursive`.
      const stuck = yield* planted("compacted_ses_export_stuck_msg_dir", true)
      yield* fs.writeFileString(path.join(stuck, "inner"), "not empty")
      const removable = yield* planted("compacted_ses_export_stuck_msg_file.txt")

      yield* CompactionExport.clear(SessionID.make("ses_export_stuck"))
      yield* CompactionExport.clear(SessionID.make("ses_export_nothing_to_clear"))

      expect(yield* fs.exists(removable)).toBe(false)
      expect(yield* fs.exists(stuck)).toBe(true)
    }),
  )
})
