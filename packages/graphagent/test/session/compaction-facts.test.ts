// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import path from "path"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { HOOK_REWAKE_SENTINEL } from "@/hook"
import { CompactionFacts } from "@/session/compaction-facts"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Token } from "@/util/token"

const sessionID = SessionID.make("ses_compaction_facts")
const directory = path.resolve("/work/project")
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

// A part without the ids the message gives it.
type Body<T = SessionV1.Part> = T extends unknown ? Omit<T, "id" | "sessionID" | "messageID"> : never

// A stored message: the facts read only the role and the parts, so the rest of `info` is filler.
function message(role: "user" | "assistant", bodies: readonly Body[]): SessionV1.WithParts {
  const id = MessageID.ascending()
  const time = { created: 0 }
  const info: SessionV1.Info =
    role === "user"
      ? { id, sessionID, role, time, agent: "build", model }
      : {
          id,
          sessionID,
          role,
          time,
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

const user = (...parts: Body[]) => message("user", parts)
const assistant = (...parts: Body[]) => message("assistant", parts)
const text = (value: string, extra: { synthetic?: boolean; ignored?: boolean } = {}): Body => ({
  type: "text",
  text: value,
  ...extra,
})
const file = (mime: string, filename?: string, url = "https://example.com/data"): Body => ({
  type: "file",
  mime,
  url,
  ...(filename === undefined ? {} : { filename }),
})
const patch = (...files: string[]): Body => ({ type: "patch", hash: "h", files })
const compaction = (): Body => ({ type: "compaction", auto: true })
const subtask = (): Body => ({ type: "subtask", prompt: "p", description: "d", agent: "build" })
const agentMention = (): Body => ({ type: "agent", name: "explore" })
const tool = (
  name: string,
  input: Record<string, unknown>,
  options: { status?: "completed" | "error" | "running"; metadata?: Record<string, unknown> } = {},
): Body => {
  const status = options.status ?? "completed"
  return {
    type: "tool",
    callID: `call_${name}`,
    tool: name,
    state:
      status === "completed"
        ? { status, input, output: "ok", title: name, metadata: options.metadata ?? {}, time: { start: 0, end: 1 } }
        : status === "error"
          ? { status, input, error: "boom", time: { start: 0, end: 1 } }
          : { status, input, time: { start: 0 } },
  }
}

describe("CompactionFacts.requestsOf", () => {
  test("returns nothing without a human request", () => {
    expect(CompactionFacts.requestsOf({ messages: [], child: false })).toEqual({})
    expect(CompactionFacts.requestsOf({ messages: [assistant(text("answer"))], child: true })).toEqual({})
  })

  test("takes the newest human request, joined from trimmed text parts, with no length cap", () => {
    const long = `${"x".repeat(5_000)} do not deploy`
    const messages = [
      user(text("old request")),
      assistant(text("answer")),
      user(text("  first part \n"), text("   "), text(long)),
    ]
    expect(CompactionFacts.requestsOf({ messages, child: false })).toEqual({
      latest: { messageID: messages[2].info.id, text: `first part\n${long}`, attachments: [] },
    })
  })

  test("leaves compaction markers, subtask turns, synthetic and ignored text out", () => {
    const messages = [
      user(text("real request")),
      user(compaction()),
      user(subtask(), text("subtask text")),
      user(text("continue from the summary", { synthetic: true })),
      user(text("hidden", { ignored: true })),
    ]
    expect(CompactionFacts.requestsOf({ messages, child: false }).latest).toEqual({
      messageID: messages[0].info.id,
      text: "real request",
      attachments: [],
    })
  })

  test("does not count a hook rewake prompt as a request", () => {
    const messages = [
      user(text("old request")),
      user(text(`${HOOK_REWAKE_SENTINEL} (command: test, event: Stop):\nrun`)),
    ]
    expect(CompactionFacts.requestsOf({ messages, child: false }).latest?.text).toBe("old request")
  })

  test("keeps a sentinel that is not at the start of the joined text, and ignores attachment data", () => {
    const messages = [
      user(text("old request")),
      user(text("please review"), text(`${HOOK_REWAKE_SENTINEL} pasted text`)),
    ]
    expect(CompactionFacts.requestsOf({ messages, child: false }).latest?.text).toBe(
      `please review\n${HOOK_REWAKE_SENTINEL} pasted text`,
    )
    const attached = user(
      text("review the attachment"),
      file("text/plain", "pasted.txt", `data:text/plain,${encodeURIComponent(`${HOOK_REWAKE_SENTINEL} attached`)}`),
    )
    expect(
      CompactionFacts.requestsOf({ messages: [user(text("old request")), attached], child: false }).latest,
    ).toEqual({
      messageID: attached.info.id,
      text: "review the attachment",
      attachments: ["[Attached text/plain: pasted.txt]"],
    })
  })

  test("writes one line per file part and counts an attachment-only turn as a request", () => {
    const messages = [user(text("old request")), user(text(" "), file("image/png", "cat.png"), file("application/pdf"))]
    expect(CompactionFacts.requestsOf({ messages, child: false }).latest).toEqual({
      messageID: messages[1].info.id,
      text: "",
      attachments: ["[Attached image/png: cat.png]", "[Attached application/pdf: file]"],
    })
  })

  test("a turn with neither text nor attachments is not a request", () => {
    const messages = [user(text("real request")), user(text("   "), agentMention())]
    expect(CompactionFacts.requestsOf({ messages, child: false }).latest?.text).toBe("real request")
  })

  test("a root session has a latest request only", () => {
    const messages = [user(text("first")), assistant(text("answer")), user(text("second"))]
    const found = CompactionFacts.requestsOf({ messages, child: false })
    expect(found.latest?.text).toBe("second")
    expect(found.first).toBeUndefined()
  })

  test("a child session also has its first request, the task prompt", () => {
    const messages = [
      user(text("task prompt")),
      assistant(text("working")),
      user(text("follow-up one")),
      user(text("follow-up two")),
    ]
    const found = CompactionFacts.requestsOf({ messages, child: true })
    expect(found.first).toEqual({ messageID: messages[0].info.id, text: "task prompt", attachments: [] })
    expect(found.latest).toEqual({ messageID: messages[3].info.id, text: "follow-up two", attachments: [] })
  })

  test("a child session leaves the first request out when it is the latest one", () => {
    const found = CompactionFacts.requestsOf({ messages: [user(text("task prompt"))], child: true })
    expect(found.latest?.text).toBe("task prompt")
    expect(found.first).toBeUndefined()
  })

  test("the first request of a child skips turns that are not requests", () => {
    const messages = [
      user(text("continue", { synthetic: true })),
      user(compaction()),
      user(text("task prompt"), file("text/plain", "spec.md")),
      user(text("latest")),
    ]
    expect(CompactionFacts.requestsOf({ messages, child: true }).first).toEqual({
      messageID: messages[2].info.id,
      text: "task prompt",
      attachments: ["[Attached text/plain: spec.md]"],
    })
  })
})

describe("CompactionFacts.quotedRequests", () => {
  // The head is what the summary replaces; the messages after it are the retained tail.
  const turns = [user(text("older request")), user(text("latest request"))]
  const [older, latest] = turns
  const requests = CompactionFacts.requestsOf({ messages: turns, child: true })

  test("quotes the latest request when the summary replaces its message", () => {
    expect(requests.latest?.messageID).toBe(latest.info.id)
    expect(CompactionFacts.quotedRequests(requests, turns)).toBe(requests)
  })

  test("leaves the latest request out while its message is in the retained tail", () => {
    expect(CompactionFacts.quotedRequests(requests, [older])).toEqual({ first: requests.first })
    expect(CompactionFacts.quotedRequests(requests, [])).toEqual({ first: requests.first })
    // A root session has no first request: nothing is quoted.
    const root = CompactionFacts.requestsOf({ messages: turns, child: false })
    expect(CompactionFacts.quotedRequests(root, [older])).toEqual({})
  })

  test("keeps the first request of a child whether or not the tail holds it", () => {
    expect(CompactionFacts.quotedRequests(requests, [older]).first).toEqual(requests.first)
    expect(CompactionFacts.quotedRequests(requests, []).first).toEqual(requests.first)
  })

  test("finds the message by its id, not by its place", () => {
    const copy = { ...latest, parts: [] }
    expect(CompactionFacts.quotedRequests(requests, [older, copy])).toBe(requests)
  })

  test("has nothing to leave out without a latest request", () => {
    expect(CompactionFacts.quotedRequests({}, [older])).toEqual({})
  })
})

describe("CompactionFacts.fitRequests", () => {
  const messageID = MessageID.ascending()
  const request = (value: string, attachments: string[] = []) => ({ messageID, text: value, attachments })
  const marker = /\[\.\.\. (\d+) characters omitted \.\.\.\]/

  test("leaves a request that fits its budget as it is, up to the budget itself", () => {
    const requests = { latest: request("short request", ["[Attached image/png: cat.png]"]) }
    expect(CompactionFacts.fitRequests(requests, 1_000)).toEqual(requests)
    // 13 characters are ceil(13 / 3) = 5 tokens.
    expect(CompactionFacts.fitRequests(requests, 5)).toEqual(requests)
    expect(CompactionFacts.fitRequests({}, 5)).toEqual({})
  })

  test("keeps the beginning and the end of a request over the budget and counts what it leaves out", () => {
    const text = `START ${"middle ".repeat(2_000)}END`
    const fit = CompactionFacts.fitRequests({ latest: request(text, ["[Attached text/plain: log.txt]"]) }, 100)
    const result = fit.latest!
    const [head, tail] = result.text.split(marker).filter((part) => !/^\d+$/.test(part))
    expect(head.startsWith("START middle")).toBe(true)
    expect(tail.trimEnd().endsWith("middle END")).toBe(true)
    const omitted = Number(marker.exec(result.text)![1])
    expect(head.trimEnd().length + omitted + tail.trimStart().length).toBe(text.length)
    expect(Token.estimateReserve(result.text)).toBeLessThanOrEqual(120)
    expect(result.attachments).toEqual(["[Attached text/plain: log.txt]"])
  })

  test("the first and the latest request of a child share the budget", () => {
    const text = "a".repeat(120)
    const both = CompactionFacts.fitRequests({ first: request(text), latest: request(text) }, 60)
    expect(both.first?.text).toMatch(marker)
    expect(both.latest?.text).toMatch(marker)
    expect(CompactionFacts.fitRequests({ first: request(text), latest: request(text) }, 100)).toEqual({
      first: request(text),
      latest: request(text),
    })
    // Alone, the same request has the whole budget: the latest one, and the first one when the latest is not quoted.
    expect(CompactionFacts.fitRequests({ latest: request(text) }, 60)).toEqual({ latest: request(text) })
    expect(CompactionFacts.fitRequests({ first: request(text) }, 60)).toEqual({ first: request(text) })
    expect(CompactionFacts.fitRequests({ first: request(text) }, 30).first?.text).toMatch(marker)
  })

  test("counts CJK text by its own density, one character per token", () => {
    const text = "汉".repeat(1_000)
    const fit = CompactionFacts.fitRequests({ latest: request(text) }, 100).latest!.text
    const kept = fit.replace(marker, "").replaceAll("\n", "").length
    expect(kept).toBeLessThanOrEqual(100)
    expect(kept).toBeGreaterThan(80)
  })

  test("with no budget left only the count of omitted characters remains", () => {
    expect(CompactionFacts.fitRequests({ latest: request("abcdef") }, 0)).toEqual({
      latest: request("[... 6 characters omitted ...]"),
    })
  })

  test("never cuts a surrogate pair", () => {
    const text = "😀".repeat(500)
    for (let budget = 1; budget <= 40; budget++) {
      const fit = CompactionFacts.fitRequests({ latest: request(text) }, budget).latest!.text
      expect(fit).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
    }
  })
})

describe("CompactionFacts.sessionFiles", () => {
  const files = (...messages: SessionV1.WithParts[]) => CompactionFacts.sessionFiles({ messages, directory })

  test("is empty for a history without file work", () => {
    expect(files(user(text("hello")), assistant(text("answer")))).toEqual({
      changed: [],
      read: [],
      omittedChanged: 0,
      omittedRead: 0,
    })
  })

  test("collects changed paths from patch parts and completed edit, write and apply_patch parts", () => {
    const result = files(
      assistant(
        patch("/repo/a.ts", "/repo/b.ts"),
        tool("edit", { filePath: "/repo/c.ts" }),
        tool("write", { filePath: "/repo/d.ts" }),
        tool(
          "apply_patch",
          {},
          { metadata: { files: [{ filePath: "/repo/e.ts" }, { filePath: "/repo/f.ts", movePath: "/repo/g.ts" }] } },
        ),
      ),
    )
    expect(result.changed).toEqual(["/repo/a.ts", "/repo/b.ts", "/repo/c.ts", "/repo/d.ts", "/repo/e.ts", "/repo/g.ts"])
    expect(result.read).toEqual([])
  })

  test("skips tool calls that did not complete and tools that are not file tools", () => {
    const result = files(
      assistant(
        tool("edit", { filePath: "/repo/error.ts" }, { status: "error" }),
        tool("write", { filePath: "/repo/running.ts" }, { status: "running" }),
        tool("read", { filePath: "/repo/read-error.ts" }, { status: "error" }),
        tool("grep", { filePath: "/repo/grep.ts" }),
        tool("apply_patch", {}, { status: "error" }),
      ),
    )
    expect(result.changed).toEqual([])
    expect(result.read).toEqual([])
  })

  test("ignores malformed inputs and apply_patch metadata", () => {
    const result = files(
      assistant(
        tool("edit", {}),
        tool("write", { filePath: 7 }),
        tool("read", { filePath: "" }),
        tool("apply_patch", {}, { metadata: { files: "none" } }),
        tool("apply_patch", {}, { metadata: { files: [null, 3, { relativePath: "x" }, { filePath: "/repo/ok.ts" }] } }),
        tool("apply_patch", {}),
      ),
    )
    expect(result.changed).toEqual(["/repo/ok.ts"])
    expect(result.read).toEqual([])
  })

  test("collects read paths and leaves out files the session changed", () => {
    const result = files(
      assistant(
        tool("read", { filePath: "/repo/only-read.ts" }),
        tool("read", { filePath: "/repo/read-then-edited.ts" }),
        tool("edit", { filePath: "/repo/read-then-edited.ts" }),
        tool("edit", { filePath: "/repo/edited-then-read.ts" }),
        tool("read", { filePath: "/repo/edited-then-read.ts" }),
        tool("read", { filePath: "/repo/in-patch.ts" }),
        patch("/repo/in-patch.ts"),
      ),
    )
    expect(result.read).toEqual(["/repo/only-read.ts"])
    expect(result.changed).toEqual(["/repo/read-then-edited.ts", "/repo/edited-then-read.ts", "/repo/in-patch.ts"])
  })

  test("resolves relative paths against the directory and writes every path as an absolute one", () => {
    const result = files(
      assistant(
        tool("edit", { filePath: "src/a.ts" }),
        tool("read", { filePath: "./docs/../docs/b.md" }),
        tool("write", { filePath: path.join(directory, "src", "a.ts") }),
      ),
    )
    expect(result.changed).toEqual([path.join(directory, "src", "a.ts")])
    expect(result.read).toEqual([path.join(directory, "docs", "b.md")])
    for (const item of [...result.changed, ...result.read]) expect(path.isAbsolute(item)).toBe(true)
  })

  test("keeps a repeated path at its most recent position, across messages", () => {
    const result = files(
      assistant(tool("edit", { filePath: "/repo/a.ts" }), tool("edit", { filePath: "/repo/b.ts" })),
      user(text("again")),
      assistant(tool("write", { filePath: "/repo/a.ts" })),
    )
    expect(result.changed).toEqual(["/repo/b.ts", "/repo/a.ts"])
  })

  test("keeps the most recent paths up to the limit and counts the rest", () => {
    const many = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => `/repo/${prefix}${index}.ts`)
    const result = CompactionFacts.sessionFiles({
      messages: [
        assistant(
          ...many("c", 5).map((filePath) => tool("edit", { filePath })),
          ...many("r", 4).map((filePath) => tool("read", { filePath })),
        ),
      ],
      directory,
      limit: 3,
    })
    expect(result.changed).toEqual(["/repo/c2.ts", "/repo/c3.ts", "/repo/c4.ts"])
    expect(result.omittedChanged).toBe(2)
    expect(result.read).toEqual(["/repo/r1.ts", "/repo/r2.ts", "/repo/r3.ts"])
    expect(result.omittedRead).toBe(1)
  })

  test("limits each list to 100 paths by default", () => {
    const edits = Array.from({ length: 103 }, (_, index) => tool("edit", { filePath: `/repo/f${index}.ts` }))
    const result = files(assistant(...edits))
    expect(result.changed).toHaveLength(100)
    expect(result.changed[0]).toBe("/repo/f3.ts")
    expect(result.changed.at(-1)).toBe("/repo/f102.ts")
    expect(result.omittedChanged).toBe(3)
    expect(result.omittedRead).toBe(0)
  })

  test("a limit of zero keeps nothing and counts everything", () => {
    const result = CompactionFacts.sessionFiles({
      messages: [assistant(tool("edit", { filePath: "/repo/a.ts" }), tool("read", { filePath: "/repo/b.ts" }))],
      directory,
      limit: 0,
    })
    expect(result).toEqual({ changed: [], read: [], omittedChanged: 1, omittedRead: 1 })
  })
})

describe("CompactionFacts.summaryItems", () => {
  const summary = [
    "## Goal",
    "- Ship the fix",
    "",
    "## Progress",
    "### In Progress",
    "- Waiting on CI",
    "- (none)",
    "not a bullet",
    "- Reviewing",
    "### Blocked",
    "- Hidden by the next heading",
    "",
    "## Next Steps",
    "- (none)",
  ].join("\n")

  test("returns the bullets under an exact heading up to the next heading", () => {
    expect(CompactionFacts.summaryItems(summary, "## Goal")).toEqual(["Ship the fix"])
    expect(CompactionFacts.summaryItems(summary, "### In Progress")).toEqual(["Waiting on CI", "Reviewing"])
  })

  test("treats a (none) placeholder, a missing heading and a missing summary as no items", () => {
    expect(CompactionFacts.summaryItems(summary, "## Next Steps")).toEqual([])
    expect(CompactionFacts.summaryItems(summary, "## Critical Context")).toEqual([])
    expect(CompactionFacts.summaryItems(undefined, "## Goal")).toEqual([])
  })
})

describe("CompactionFacts.validateSummary", () => {
  const valid = [
    "## Goal",
    "- Ship the fix",
    "",
    "## Progress",
    "### In Progress",
    "- (none)",
    "",
    "## Next Steps",
    "- (none)",
  ].join("\n")

  test("accepts a summary with the three sections the continuation reads and one goal item", () => {
    expect(CompactionFacts.validateSummary(valid)).toBe(true)
  })

  test("tolerates indented headings, extra sections and text around them", () => {
    expect(
      CompactionFacts.validateSummary(`preamble\n  ## Goal  \n- Ship\n\n   ### In Progress\n## Next Steps\n- go\nmore`),
    ).toBe(true)
  })

  test("needs each of the three headings on a line of its own", () => {
    for (const heading of ["## Goal", "### In Progress", "## Next Steps"])
      expect(CompactionFacts.validateSummary(valid.replace(heading, "heading removed"))).toBe(false)
    // A heading inside a sentence or with more text on its line is not a heading line.
    expect(CompactionFacts.validateSummary(valid.replace("### In Progress", "see ### In Progress below"))).toBe(false)
    expect(CompactionFacts.validateSummary(valid.replace("## Next Steps", "## Next Steps and more"))).toBe(false)
  })

  test("needs at least one goal item, and a (none) goal is none", () => {
    expect(CompactionFacts.validateSummary(valid.replace("- Ship the fix", "- (none)"))).toBe(false)
    expect(CompactionFacts.validateSummary(valid.replace("- Ship the fix", "Ship the fix without a bullet"))).toBe(
      false,
    )
    expect(CompactionFacts.validateSummary(valid.replace("- Ship the fix\n", ""))).toBe(false)
  })

  test("rejects text without headings, an empty text and a missing text", () => {
    expect(CompactionFacts.validateSummary("summary")).toBe(false)
    expect(CompactionFacts.validateSummary("")).toBe(false)
    expect(CompactionFacts.validateSummary("  \n ")).toBe(false)
    expect(CompactionFacts.validateSummary(undefined)).toBe(false)
  })
})
