// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { LoopInput } from "@/loop/input"
import { PartID } from "@/session/schema"
import { Token } from "@/util/token"
import { assistant, compaction, intent, progress, reply, text, toolPart, user } from "./fixture"

const FIRST_DESCRIPTION = "Make the importer idempotent.\nKeep the CLI flags: `--dry-run` stays."
const FIRST_ANALYSIS = intent({ objective: "Idempotent importer", constraints: ["Keep --dry-run"] })
const CURRENT = intent({ objective: "Idempotent importer", constraints: ["Keep --dry-run", "No new dependency"] })

const humans = [
  { id: "msg_h1", text: "Also: no new dependency.\nThanks!" },
  { id: "msg_h2", text: "Please stop touching the CLI." },
]

const base = (overrides: Partial<LoopInput.Anchor> = {}): LoopInput.Anchor => ({
  firstDescription: FIRST_DESCRIPTION,
  outcome: { type: "completed" },
  humans,
  ...overrides,
})

const later = (overrides: Partial<LoopInput.Prior> = {}): LoopInput.Prior => ({
  firstAnalysis: FIRST_ANALYSIS,
  intent: CURRENT,
  progress: progress(),
  prompt: "Run the importer twice and compare the databases.",
  recent: [
    { verdict: "continue", reason: "Importer still duplicates rows." },
    { verdict: "continue", reason: "Second run now skips existing rows." },
  ],
  ...overrides,
})

describe("anchor (sections 1-5)", () => {
  test("puts the first description and the first analysis in verbatim", () => {
    const anchor = LoopInput.anchor(base({ prior: later() }))

    expect(anchor).toContain(FIRST_DESCRIPTION)
    expect(anchor).toContain(JSON.stringify(FIRST_ANALYSIS, null, 2))
    expect(anchor).toContain(JSON.stringify(CURRENT, null, 2))
    expect(anchor).toContain("Run the importer twice and compare the databases.")
    expect(anchor).toContain("- continue: Second run now skips existing rows.")
  })

  test("keeps the sections in the fixed order", () => {
    const anchor = LoopInput.anchor(base({ prior: later(), declaration: { kind: "done", text: "all tests pass" } }))
    const positions = [
      "## 1. First description",
      "## 2. First analysis",
      "## 3. Current state",
      "## 4. This round",
      "## 5. Human messages in the basis window",
    ].map((heading) => anchor.indexOf(heading))

    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual(positions.toSorted((a, b) => a - b))
    // The history is section 6 and only the frame adds it.
    expect(anchor).not.toContain("## 6.")
    expect(LoopInput.frame(anchor, "history text").indexOf("## 6. Conversation history")).toBeGreaterThan(
      anchor.lastIndexOf("## 5."),
    )
  })

  test("human messages appear verbatim with their IDs and are marked as the top evidence", () => {
    const anchor = LoopInput.anchor(base({ prior: later() }))

    expect(anchor).toContain(`<human_message id="msg_h1">\nAlso: no new dependency.\nThanks!\n</human_message>`)
    expect(anchor).toContain(`<human_message id="msg_h2">\nPlease stop touching the CLI.\n</human_message>`)
    expect(anchor).toContain("highest-priority evidence")
    expect(anchor).toContain("Only these IDs can be cited")
    expect(anchor.indexOf("msg_h1")).toBeLessThan(anchor.indexOf("msg_h2"))
  })

  test("an empty window says so, so no change can be justified", () => {
    const anchor = LoopInput.anchor(base({ prior: later(), humans: [] }))

    expect(anchor).not.toContain("<human_message")
    expect(anchor).toContain("No human message arrived since the last analysis")
  })

  test("the first analysis says that earlier agent output is progress evidence only", () => {
    const anchor = LoopInput.anchor(base())

    expect(anchor).toContain("FIRST analysis")
    expect(anchor).toContain("progress evidence only")
    expect(anchor).toContain("must not define or reshape the goal")
    // The human messages typed after the loop started and before the analysis are still in the input.
    expect(anchor).toContain("msg_h1")
    expect(anchor).toContain("msg_h2")
    // There is no frozen analysis to show.
    expect(anchor).not.toContain("<first_analysis>")
    expect(anchor).not.toContain("<current_intent>")
  })

  test("a later analysis does not carry the first-analysis note", () => {
    const anchor = LoopInput.anchor(base({ prior: later() }))

    expect(anchor).not.toContain("FIRST analysis")
    expect(anchor).toContain("<first_analysis>")
  })

  test("shows only the last five recent analyses, oldest first", () => {
    const recent = Array.from({ length: 8 }, (_, index) => ({
      verdict: "continue" as const,
      reason: `reason ${index + 1}`,
    }))
    const anchor = LoopInput.anchor(base({ prior: later({ recent }) }))

    expect(anchor).not.toContain("reason 3")
    for (const index of [4, 5, 6, 7, 8]) expect(anchor).toContain(`- continue: reason ${index}`)
    expect(anchor.indexOf("reason 4")).toBeLessThan(anchor.indexOf("reason 8"))
  })

  test("states the agent's declaration and how the round ended", () => {
    const done = LoopInput.anchor(base({ prior: later(), declaration: { kind: "done", text: "bun test passes" } }))
    expect(done).toContain("Agent declaration: done.")
    expect(done).toContain("bun test passes")
    expect(done).toContain("verify it, do not take it on trust")

    const blocked = LoopInput.anchor(
      base({ prior: later(), declaration: { kind: "blocked", text: "need the API key" } }),
    )
    expect(blocked).toContain("blocked. The agent says it cannot continue without the user")
    expect(blocked).toContain("need the API key")

    const waiting = LoopInput.anchor(base({ prior: later(), declaration: { kind: "await", text: "CI run 42" } }))
    expect(waiting).toContain("await. The agent waits for")

    expect(LoopInput.anchor(base())).toContain("Agent declaration: none")
    expect(LoopInput.anchor(base({ outcome: { type: "error", code: "APIError", retryable: true } }))).toContain(
      "How the round ended: error (code APIError, retryable)",
    )
    expect(LoopInput.anchor(base({ outcome: { type: "cancelled", reason: "user interrupt" } }))).toContain(
      "cancelled (user interrupt)",
    )
  })
})

describe("history transcript", () => {
  test("renders text, tool calls and attachments; reasoning, media and bookkeeping are left out", () => {
    const first = user("Please fix the importer")
    const answer = assistant(first, (id) => [
      { ...text(id, "I will inspect it first."), type: "text" },
      toolPart(id, {
        status: "completed",
        input: { command: "ls" },
        output: "importer.ts",
        title: "ls",
        metadata: {},
        time: { start: 0, end: 1 },
      }),
      toolPart(
        id,
        { status: "error", input: { command: "false" }, error: "exit 1", time: { start: 0, end: 1 } },
        "bash",
        "call_2",
      ),
      {
        id: PartID.ascending(),
        sessionID: first.info.sessionID,
        messageID: id,
        type: "reasoning",
        text: "secret thoughts",
        time: { start: 0 },
      },
    ])

    const rendered = LoopInput.entries([first, answer]).map((entry) => entry.text)

    expect(rendered[0]).toBe("[user]\nPlease fix the importer")
    expect(rendered[1]).toContain("[assistant]\nI will inspect it first.")
    expect(rendered[1]).toContain('[tool bash] {"command":"ls"}\n=> importer.ts')
    expect(rendered[1]).toContain('[tool bash] {"command":"false"}\n=> error: exit 1')
    expect(rendered.join("\n")).not.toContain("secret thoughts")
  })

  test("shortens long tool input and output", () => {
    const first = user("run it")
    const answer = assistant(first, (id) => [
      toolPart(id, {
        status: "completed",
        input: { command: "x".repeat(LoopInput.TOOL_INPUT_CHARS + 50) },
        output: "y".repeat(LoopInput.TOOL_OUTPUT_CHARS + 70),
        title: "t",
        metadata: {},
        time: { start: 0, end: 1 },
      }),
    ])

    const text = LoopInput.entries([first, answer])[1]?.text ?? ""

    expect(text).toContain("...[truncated")
    expect(text).not.toContain("y".repeat(LoopInput.TOOL_OUTPUT_CHARS + 1))
    expect(text.length).toBeLessThan(LoopInput.TOOL_INPUT_CHARS + LoopInput.TOOL_OUTPUT_CHARS + 300)
  })

  test("a compaction marker has no entry and its summary is the protected one", () => {
    const marker = compaction()
    const summary = reply(marker, "Summary: importer duplicated rows, fixed in a.ts", { summary: true })
    const next = user("now the tests")

    const found = LoopInput.entries([marker, summary, next])

    expect(found.map((entry) => entry.summary)).toEqual([true, false])
    expect(found[0]?.text).toContain("[summary of the earlier conversation]")
    expect(found[1]?.text).toBe("[user]\nnow the tests")
  })

  test("labels automation, leaves out ignored command receipts and presentation-only messages", () => {
    const automatic = user("[Continuing toward your standing goal]\nGoal: x", { synthetic: true })
    const receipt = user("Loop status: round 2", { ignored: true, metadata: { command: "goal" } })

    const found = LoopInput.entries([automatic, receipt, user("typed by hand")])

    expect(found.map((entry) => entry.text.split("\n")[0])).toEqual(["[automatic message]", "[user]"])
  })
})

describe("fit (history trimming)", () => {
  const entry = (label: string, size = 400, summary = false): LoopInput.Entry => ({
    text: `${label} ${"w".repeat(size)}`,
    summary,
  })
  const labels = (text: string) => [...text.matchAll(/\b(old|mid|new|sum)\d?\b/g)].map((match) => match[0])

  test("keeps everything that fits", () => {
    const all = [entry("old"), entry("mid"), entry("new")]
    const fitted = LoopInput.fit(all, 1_000_000)

    expect(fitted.omitted).toBe(0)
    expect(fitted.kept).toBe(3)
    expect(labels(fitted.text)).toEqual(["old", "mid", "new"])
    expect(fitted.text).not.toContain("omitted")
  })

  test("drops the oldest non-summary entries first and says how many", () => {
    const all = [entry("sum", 400, true), entry("old"), entry("mid"), entry("new")]
    const sizes = all.map((item) => Token.estimateReserve(item.text))
    const budget = sizes[0] + sizes[3] + 1

    const fitted = LoopInput.fit(all, budget)

    expect(labels(fitted.text)).toEqual(["sum", "new"])
    expect(fitted.omitted).toBe(2)
    expect(fitted.text.startsWith("(2 older message(s) omitted")).toBe(true)
    expect(fitted.tokens).toBeLessThanOrEqual(budget)
  })

  test("never drops the compaction summary, even when nothing else is left", () => {
    const all = [entry("old"), entry("sum", 400, true), entry("new")]

    const fitted = LoopInput.fit(all, 0)

    expect(labels(fitted.text)).toEqual(["sum"])
    expect(fitted.kept).toBe(1)
    expect(fitted.omitted).toBe(2)
  })

  test("trimming never touches the anchor: sections 1-5 are identical at every budget", () => {
    const anchor = LoopInput.anchor(base({ prior: later() }))
    const all = [entry("sum", 400, true), entry("old"), entry("mid"), entry("new")]

    for (const budget of [1_000_000, 300, 0]) {
      const frame = LoopInput.frame(anchor, LoopInput.fit(all, budget).text)
      expect(frame.startsWith(anchor)).toBe(true)
      expect(frame).toContain(FIRST_DESCRIPTION)
      expect(frame).toContain(JSON.stringify(FIRST_ANALYSIS, null, 2))
      expect(frame).toContain("msg_h1")
    }
  })

  test("an empty history renders as such", () => {
    expect(LoopInput.frame("anchor", "")).toContain("(empty)")
  })
})

describe("isHuman", () => {
  test("a message the user typed is human", () => {
    expect(LoopInput.isHuman(user("please also handle the empty file"))).toBe(true)
  })

  test("loop continuations, wake-ups and other injections are not", () => {
    expect(LoopInput.isHuman(user("[Continuing toward your standing goal]", { synthetic: true }))).toBe(false)
    expect(LoopInput.isHuman(user("[DAG Workflow wf_1] finished", { synthetic: true }))).toBe(false)
    expect(LoopInput.isHuman(user("hook says hi", { synthetic: true, metadata: { reminder: true } }))).toBe(false)
  })

  test("a typed message merged into an automatic turn is human", () => {
    const merged = user("hand typed")
    merged.parts.push(text(merged.info.id, "[Continuing toward your standing goal]", { synthetic: true }))

    expect(LoopInput.isHuman(merged)).toBe(true)
  })

  test("command exchanges, presentation-only messages, compaction markers and assistants are not", () => {
    expect(LoopInput.isHuman(user("/loop status"))).toBe(false)
    expect(LoopInput.isHuman(user("anything", { metadata: { command: "goal" } }))).toBe(false)
    expect(LoopInput.isHuman(user("notice", { ignored: true }))).toBe(false)
    expect(LoopInput.isHuman(compaction())).toBe(false)
    expect(LoopInput.isHuman(reply(user("q"), "a"))).toBe(false)
    expect(LoopInput.isHuman(user("   "))).toBe(false)
  })

  test("an absolute path is not a command", () => {
    expect(LoopInput.isHuman(user("/var/log/app/output.log has the answer"))).toBe(true)
    expect(LoopInput.isHuman(user("look in /var/log/app/output.log"))).toBe(true)
  })
})
