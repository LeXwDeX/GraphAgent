// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import type { Part, ReasoningPart, TextPart, ToolPart } from "@graphagent/sdk"
import { setLanguage } from "../../../src/i18n"
import {
  completedOutput,
  delegationFolds,
  errorDenied,
  errorLine,
  firstLine,
  foldFlag,
  foldHint,
  foldOutput,
  genericRowOutput,
  lastLine,
  openToolLines,
  outputCharCap,
  reasoningFolds,
  resultCardFolds,
  shellOutput,
  TOOL_FOLD_LINES,
  toolFailed,
  toolMetadata,
  type FoldEnv,
  type FoldSource,
} from "../../../src/routes/session/fold"
import { DELEGATION_PROMPT_LINES } from "../../../src/routes/session/rows"
import { collapseToolOutput } from "../../../src/util/collapse-tool-output"

/**
 * What can fold, as `view.expand.toggle` reads it from the parts of a transcript. The blocks draw from the same
 * functions, so the cases here are the ones the key and a click have to agree on.
 */

const env: FoldEnv = { width: 100, thinking: "hide", showGenericToolOutput: false }
const base = { sessionID: "ses", messageID: "msg" }
/** The overlay the stream buffer holds for a running call, keyed by part id. */
const previews = new Map<string, { tail: string; totalLength: number; seq: number }>()

const source: FoldSource = {
  text: (part) => (part.type === "reasoning" || part.type === "text" ? part.text : ""),
  metadata: (part) => toolMetadata(part, (item) => previews.get(item.id)),
}

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`).join("\n")

function reasoning(text: string): ReasoningPart {
  return { ...base, id: "prt_reasoning", type: "reasoning", text, time: { start: 1, end: 2 } }
}

type StateOf<S extends ToolPart["state"]["status"]> = Extract<ToolPart["state"], { status: S }>

function completed(output: string, metadata: Record<string, unknown> = {}): StateOf<"completed"> {
  return { status: "completed", input: {}, output, title: "t", metadata, time: { start: 1, end: 2 } }
}

function failed(error: string, metadata?: Record<string, unknown>): StateOf<"error"> {
  return { status: "error", input: {}, error, metadata, time: { start: 1, end: 2 } }
}

function tool(name: string, state: ToolPart["state"], id = "prt_tool"): ToolPart {
  return { ...base, id, type: "tool", callID: "call", tool: name, state }
}

const flag = (part: Part, overrides: Partial<FoldEnv> = {}) => foldFlag(part, { ...env, ...overrides }, source)

test("a reasoning with a body folds in the hide mode and not in the show mode", () => {
  expect(flag(reasoning("Thinking about the plan."))).toBe("expanded")
  expect(flag(reasoning("Thinking about the plan."), { thinking: "show" })).toBeUndefined()
})

test("a reasoning with only a title has nothing under its header to open", () => {
  expect(reasoningFolds("**Planning the change**", "hide")).toBe(false)
  expect(reasoningFolds("**Planning the change**\n\n", "hide")).toBe(false)
  expect(reasoningFolds("**Planning the change**\n\nThe body.", "hide")).toBe(true)
  expect(reasoningFolds("   ", "hide")).toBe(false)
})

test("the placeholder of an encrypted reasoning is no body", () => {
  expect(reasoningFolds("[REDACTED]", "hide")).toBe(false)
  expect(reasoningFolds("[REDACTED]\n\nWhat can be read.", "hide")).toBe(true)
})

test("parts that are not a reasoning or a tool never fold", () => {
  const text: TextPart = { ...base, id: "prt_text", type: "text", text: lines(50), time: { start: 1, end: 2 } }
  expect(flag(text)).toBeUndefined()
  expect(flag({ ...base, id: "prt_patch", type: "patch", hash: "h", files: ["a.ts"] })).toBeUndefined()
})

test("every tool output folds past six lines", () => {
  expect(TOOL_FOLD_LINES).toBe(6)
  expect(flag(tool("bash", completed("", { output: lines(6) })))).toBeUndefined()
  expect(flag(tool("bash", completed("", { output: lines(7) })))).toBe("expanded")
  expect(flag(tool("bash", completed("", { output: `\n${lines(6)}\n\n` })))).toBeUndefined()
})

test("a bash output folds past the characters the width allows, and a wider view allows more", () => {
  const cap = outputCharCap(TOOL_FOLD_LINES, 100)
  expect(cap).toBe(564)
  const oneLine = "x".repeat(1000)
  expect(flag(tool("bash", completed("", { output: oneLine })), { width: 100 })).toBe("expanded")
  expect(flag(tool("bash", completed("", { output: oneLine })), { width: 200 })).toBeUndefined()
  // The least width the cap is taken from: a narrow view still shows a line of twenty characters.
  expect(outputCharCap(TOOL_FOLD_LINES, 10)).toBe(120)
})

test("terminal escapes are not counted as output", () => {
  // Two hundred painted characters: well under the cap as text, well over it with their escapes.
  const painted = "\u001b[31mx\u001b[0m".repeat(200)
  expect(painted.length).toBeGreaterThan(outputCharCap(TOOL_FOLD_LINES, 100))
  expect(shellOutput({ output: painted })).toBe("x".repeat(200))
  expect(flag(tool("bash", completed("", { output: painted })))).toBeUndefined()
})

test("what the server writes for a command that printed nothing is no output", () => {
  expect(shellOutput({ output: "(no output)" })).toBe("")
  expect(shellOutput({ output: "  (no output)\n" })).toBe("")
  expect(shellOutput({ output: "" })).toBe("")
  expect(shellOutput({})).toBe("")
  // Only the whole placeholder is one: a line that says so among others is an output.
  expect(shellOutput({ output: "a\n(no output)" })).toBe("a\n(no output)")
})

test("the fold of an output leaves out every line but the one its row keeps", () => {
  const width = 100
  expect(foldOutput("", width)).toEqual({ folds: false, hidden: 0 })
  expect(foldOutput("one line", width)).toEqual({ folds: false, hidden: 0 })
  expect(foldOutput(lines(TOOL_FOLD_LINES), width)).toEqual({ folds: false, hidden: 0 })
  expect(foldOutput(lines(TOOL_FOLD_LINES + 1), width)).toEqual({ folds: true, hidden: TOOL_FOLD_LINES })
  expect(foldOutput(lines(40), width)).toEqual({ folds: true, hidden: 39 })
  // A line cut at the characters the lines may take leaves no line out of an output of one; two leave the other.
  expect(foldOutput("x".repeat(1000), width)).toEqual({ folds: true, hidden: 0 })
  expect(foldOutput(`${"x".repeat(1000)}\ny`, width)).toEqual({ folds: true, hidden: 1 })
})

test("the line a folded row keeps is the last of a bash output and the first of any other", () => {
  expect(lastLine("a\nb\nc")).toBe("c")
  expect(lastLine("only")).toBe("only")
  expect(firstLine("a\nb\nc")).toBe("a")
  expect(firstLine("only")).toBe("only")
  expect(firstLine("")).toBe("")
})

test("the line a failed row says is the first of the error that has text, as one displayable line", () => {
  expect(errorLine("boom\nat run (task.ts:42)")).toBe("boom")
  expect(errorLine("\n  \n  refused  \nmore")).toBe("refused")
  expect(errorLine("\u001b[31mred\u001b[0m boom\u0007")).toBe("red boom")
  expect(errorLine("")).toBeUndefined()
  expect(errorLine(" \n\t\n ")).toBeUndefined()
  expect(errorLine(undefined)).toBeUndefined()
})

test("a bash call without output is one line, and a successful one has nothing to fold", () => {
  expect(flag(tool("bash", completed("")))).toBeUndefined()
  expect(flag(tool("bash", { status: "pending", input: {}, raw: "" }))).toBeUndefined()
  expect(flag(tool("bash", { status: "running", input: {}, time: { start: 1 } }))).toBeUndefined()
})

test("a running bash call has nothing to fold: its row says it runs, with the latest line of the tail", () => {
  const part = tool("bash", { status: "running", input: {}, metadata: { output: "one line" }, time: { start: 1 } })
  expect(flag(part)).toBeUndefined()

  previews.set(part.id, { tail: lines(30), totalLength: 5000, seq: 1 })
  try {
    expect(flag(part)).toBeUndefined()
  } finally {
    previews.delete(part.id)
  }
})

test("a failed call drawn as one line folds its error under errorExpanded", () => {
  expect(flag(tool("bash", failed("boom")))).toBe("errorExpanded")
  expect(flag(tool("read", failed("boom")))).toBe("errorExpanded")
  expect(flag(tool("task", failed("boom")))).toBe("errorExpanded")
  expect(flag(tool("some_mcp_tool", failed("boom")))).toBe("errorExpanded")
})

test("a call the user or the permission rules turned down is not a failure", () => {
  for (const error of [
    "The user rejected permission to use this specific tool call.",
    "QuestionRejectedError: the user dismissed this question",
    "The user specified a rule that blocks this call",
    "user dismissed",
  ]) {
    expect(errorDenied(error)).toBe(true)
    expect(toolFailed(failed(error))).toBe(false)
    expect(flag(tool("read", failed(error)))).toBeUndefined()
  }
  expect(errorDenied("ENOENT: no such file")).toBe(false)
  expect(errorDenied(undefined)).toBe(false)
})

test("a failed bash call is one line whatever it printed: its error folds, with the output it printed", () => {
  expect(flag(tool("bash", failed("aborted", { output: lines(30), interrupted: true })))).toBe("errorExpanded")
  expect(flag(tool("bash", failed("aborted", { output: "short" })))).toBe("errorExpanded")
})

test("a failed call of a tool that draws a fixed block has no folded error", () => {
  expect(flag(tool("write", failed("boom")))).toBe("errorExpanded")
  expect(flag(tool("write", failed("boom", { diagnostics: {} })))).toBeUndefined()
  expect(flag(tool("edit", failed("boom")))).toBe("errorExpanded")
  expect(flag(tool("edit", failed("boom", { diff: "@@ -1 +1 @@" })))).toBeUndefined()
  expect(flag(tool("apply_patch", failed("boom")))).toBe("errorExpanded")
  const file = { type: "update", relativePath: "a.ts", filePath: "/a.ts", patch: "@@", deletions: 0 }
  expect(flag(tool("apply_patch", failed("boom", { files: [file] })))).toBeUndefined()
  expect(flag(tool("apply_patch", failed("boom", { files: [{ type: "update" }] })))).toBe("errorExpanded")
  expect(flag(tool("todowrite", failed("boom")))).toBe("errorExpanded")
  expect(flag(tool("todowrite", failed("boom", { todos: [{ status: "pending", content: "x" }] })))).toBeUndefined()
  expect(flag(tool("question", failed("boom")))).toBe("errorExpanded")
  expect(flag(tool("question", failed("boom", { answers: [["yes"]] })))).toBeUndefined()
})

test("a generic tool output is drawn only when the reader asked for it, and folds at the same six lines", () => {
  const long = completed(lines(20))
  expect(flag(tool("custom_tool", long))).toBeUndefined()
  expect(flag(tool("custom_tool", long), { showGenericToolOutput: true })).toBe("expanded")
  expect(flag(tool("custom_tool", completed(lines(6))), { showGenericToolOutput: true })).toBeUndefined()
  expect(flag(tool("custom_tool", completed(lines(7))), { showGenericToolOutput: true })).toBe("expanded")
})

test("a blocked call says why and has no output to fold, however long its output is", () => {
  const blocked = (output: string) => completed(output, { blocked: true, diagnosticSummary: "Denied by policy" })
  expect(flag(tool("custom_tool", blocked("short")))).toBeUndefined()
  expect(flag(tool("custom_tool", blocked(lines(40))))).toBeUndefined()
  expect(flag(tool("custom_tool", blocked(lines(40))), { showGenericToolOutput: true })).toBeUndefined()
})

test("a call that is still running or pending has no output to fold, whatever the reader shows", () => {
  const running = tool("custom_tool", { status: "running", input: {}, time: { start: 1 } })
  const pending = tool("custom_tool", { status: "pending", input: {}, raw: "" })
  expect(flag(running, { showGenericToolOutput: true })).toBeUndefined()
  expect(flag(pending, { showGenericToolOutput: true })).toBeUndefined()
})

test("a failed generic call is one line with a folded error", () => {
  expect(flag(tool("custom_tool", failed("boom")), { showGenericToolOutput: true })).toBe("errorExpanded")
})

test("the output a generic tool row draws is the one the reader asked for, and none when the call was blocked", () => {
  expect(genericRowOutput(undefined, "  output\n", true)).toBe("output")
  expect(genericRowOutput(undefined, "output", false)).toBe("")
  expect(genericRowOutput("blocked", "output", true)).toBe("")
  expect(genericRowOutput(undefined, undefined, true)).toBe("")
  expect(genericRowOutput(undefined, "", true)).toBe("")
})

test("the open row of a call draws as many lines under its result as the output has, or its error and output", () => {
  expect(openToolLines(tool("bash", completed("", { output: lines(30) })))).toBe(30)
  expect(openToolLines(tool("bash", completed("", {})))).toBe(0)
  expect(openToolLines(tool("bash", completed("", { output: "(no output)" })))).toBe(0)
  expect(openToolLines(tool("custom_tool", completed(lines(9))))).toBe(9)
  expect(openToolLines(tool("bash", { status: "pending", input: {}, raw: "" }))).toBe(0)
  // The error of a call that failed, and the blank line and the output a bash call printed before it did.
  expect(openToolLines(tool("read", failed("one\ntwo\nthree")))).toBe(3)
  expect(openToolLines(tool("bash", failed("aborted", { output: lines(4) })))).toBe(1 + 1 + 4)
})

test("the prompt of a task block folds past its lines, and past the characters those lines take", () => {
  expect(DELEGATION_PROMPT_LINES).toBe(8)
  expect(delegationFolds("scan the changelog", 100)).toBe(false)
  expect(delegationFolds("", 100)).toBe(false)
  expect(delegationFolds(lines(DELEGATION_PROMPT_LINES), 100)).toBe(false)
  expect(delegationFolds(lines(DELEGATION_PROMPT_LINES + 1), 100)).toBe(true)

  const cap = outputCharCap(DELEGATION_PROMPT_LINES, 100)
  expect(cap).toBe(752)
  expect(delegationFolds("x".repeat(cap), 100)).toBe(false)
  expect(delegationFolds("x".repeat(cap + 1), 100)).toBe(true)
})

test("the prompt of a task block folds by the width of the view: a wider one shows more of it", () => {
  const prompt = "x".repeat(outputCharCap(DELEGATION_PROMPT_LINES, 100) + 1)
  expect(delegationFolds(prompt, 100)).toBe(true)
  expect(delegationFolds(prompt, 200)).toBe(false)
  // The least width the cap is taken from: a narrow view still shows twenty characters to a line.
  expect(delegationFolds("x".repeat(160), 10)).toBe(false)
  expect(delegationFolds("x".repeat(161), 10)).toBe(true)
})

test("the prompt of a task block counts characters, not the units a character takes in a string", () => {
  const cap = outputCharCap(DELEGATION_PROMPT_LINES, 100)
  // Each takes two UTF-16 units: the string is longer than the cap, the text is not.
  const emoji = "\u{1F600}".repeat(cap - 1)
  expect(emoji.length).toBeGreaterThan(cap)
  expect(delegationFolds(emoji, 100)).toBe(false)
  expect(delegationFolds(`${emoji}\u{1F600}\u{1F600}`, 100)).toBe(true)
  expect(delegationFolds("请".repeat(cap), 100)).toBe(false)
  expect(delegationFolds("请".repeat(cap + 1), 100)).toBe(true)
})

test("the fold of a task block is the one its block draws: it folds exactly when the output is cut", () => {
  const prompts = [
    "",
    "short",
    lines(DELEGATION_PROMPT_LINES),
    lines(DELEGATION_PROMPT_LINES + 1),
    `${lines(DELEGATION_PROMPT_LINES)}\n`,
    "x".repeat(900),
    "请".repeat(700),
  ]
  for (const width of [10, 60, 100, 200]) {
    for (const prompt of prompts) {
      const cap = outputCharCap(DELEGATION_PROMPT_LINES, width)
      expect(delegationFolds(prompt, width)).toBe(collapseToolOutput(prompt, DELEGATION_PROMPT_LINES, cap).overflow)
    }
  }
})

test("the metadata of a call is the stored one, with the running preview laid over its output", () => {
  const stored = tool("bash", completed("", { output: "stored", exit: 0 }))
  expect(toolMetadata(stored, () => undefined)).toEqual({ output: "stored", exit: 0 })

  const running = tool("bash", { status: "running", input: {}, metadata: { exit: 1 }, time: { start: 1 } })
  expect(toolMetadata(running, () => ({ tail: "tail", totalLength: 9, seq: 1 }))).toEqual({
    exit: 1,
    output: "tail",
    previewTotalLength: 9,
  })
  expect(toolMetadata(tool("bash", { status: "pending", input: {}, raw: "" }), () => undefined)).toEqual({})
  expect(toolMetadata(tool("bash", { status: "running", input: {}, time: { start: 1 } }), () => undefined)).toEqual({})
})

test("only a finished call has an output", () => {
  expect(completedOutput(completed("done"))).toBe("done")
  expect(completedOutput(failed("boom"))).toBeUndefined()
  expect(completedOutput({ status: "running", input: {}, time: { start: 1 } })).toBeUndefined()
})

/** A card as `backgroundCard` makes one of a result: the body, and the first line of it that has text. */
const resultOf = (body: string) => ({
  body,
  firstLine:
    body
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "",
})

test("the card of a background result folds when it has a second line", () => {
  expect(resultCardFolds(resultOf("All clear."), 100, 1)).toBe(false)
  expect(resultCardFolds(resultOf(""), 100, 1)).toBe(false)
  expect(resultCardFolds(resultOf("found\nmore"), 100, 1)).toBe(true)
  // A blank line between is a line too: opening the card shows a paragraph the preview does not.
  expect(resultCardFolds(resultOf("found\n\nmore"), 100, 1)).toBe(true)
  expect(resultCardFolds(resultOf("found\nmore"), 100, 2)).toBe(true)
})

test("the card of a background result folds when its first line is wider than the room the preview has", () => {
  // The preview has the content width less the border, the padding and the indent: 100 - 4 - 2 cells, and a cell
  // fewer when the border is two cells wide.
  expect(resultCardFolds(resultOf("x".repeat(94)), 100, 1)).toBe(false)
  expect(resultCardFolds(resultOf("x".repeat(95)), 100, 1)).toBe(true)
  expect(resultCardFolds(resultOf("x".repeat(93)), 100, 2)).toBe(false)
  expect(resultCardFolds(resultOf("x".repeat(94)), 100, 2)).toBe(true)
  // Cells, not characters: a wide character takes two.
  expect(resultCardFolds(resultOf("请".repeat(47)), 100, 1)).toBe(false)
  expect(resultCardFolds(resultOf("请".repeat(48)), 100, 1)).toBe(true)
  // A glyph of ambiguous width takes two at that setting: the same line fits at one and is cut at two.
  expect(resultCardFolds(resultOf("·".repeat(90)), 100, 1)).toBe(false)
  expect(resultCardFolds(resultOf("·".repeat(90)), 100, 2)).toBe(true)
})

test("the card of a background result folds by the width of the view: a wider one has room for the line", () => {
  const line = resultOf("x".repeat(95))
  expect(resultCardFolds(line, 100, 1)).toBe(true)
  expect(resultCardFolds(line, 101, 1)).toBe(false)
  expect(resultCardFolds(line, 20, 1)).toBe(true)
})

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

// The line under a folded output, which `Shell` and `GenericTool` draw from the lines `collapseToolOutput` left out.
const HINTS = {
  en: {
    one: "… 1 more line · ctrl+o expand",
    other: "… 34 more lines · ctrl+o expand",
    oneClick: "… 1 more line · click to expand",
    otherClick: "… 34 more lines · click to expand",
    long: "… long output · ctrl+o expand",
    longClick: "… long output · click to expand",
    less: "ctrl+o collapse",
    lessClick: "click to collapse",
  },
  "zh-CN": {
    one: "… 还有 1 行 · ctrl+o 展开",
    other: "… 还有 34 行 · ctrl+o 展开",
    oneClick: "… 还有 1 行 · 点击展开",
    otherClick: "… 还有 34 行 · 点击展开",
    long: "… 内容较长 · ctrl+o 展开",
    longClick: "… 内容较长 · 点击展开",
    less: "ctrl+o 收起",
    lessClick: "点击收起",
  },
} as const

for (const language of ["en", "zh-CN"] as const) {
  test(`a folded output says how many lines it leaves out and which key opens it, in ${language}`, () => {
    setLanguage(language)
    const says = HINTS[language]
    expect(foldHint({ expanded: false, hidden: 1 }, "ctrl+o")).toBe(says.one)
    expect(foldHint({ expanded: false, hidden: 34 }, "ctrl+o")).toBe(says.other)
    // Only a cut at a long line, which leaves no line out.
    expect(foldHint({ expanded: false, hidden: 0 }, "ctrl+o")).toBe(says.long)
    expect(foldHint({ expanded: true, hidden: 34 }, "ctrl+o")).toBe(says.less)
  })

  test(`with the key unbound the hint says click and names no key, in ${language}`, () => {
    setLanguage(language)
    const says = HINTS[language]
    expect(foldHint({ expanded: false, hidden: 1 }, "")).toBe(says.oneClick)
    expect(foldHint({ expanded: false, hidden: 34 }, "")).toBe(says.otherClick)
    expect(foldHint({ expanded: false, hidden: 0 }, "")).toBe(says.longClick)
    expect(foldHint({ expanded: true, hidden: 34 }, "")).toBe(says.lessClick)
    // A fallback text has no `{key}` left in it, whatever it counts.
    for (const hidden of [0, 1, 2, 5]) {
      for (const expanded of [false, true]) expect(foldHint({ expanded, hidden }, "")).not.toContain("{")
    }
  })
}

test("the hint names the key the keymap gives, whatever it is", () => {
  setLanguage("en")
  expect(foldHint({ expanded: false, hidden: 5 }, "f9")).toBe("… 5 more lines · f9 expand")
  expect(foldHint({ expanded: true, hidden: 5 }, "<leader> o")).toBe("<leader> o collapse")
})

test("the hint counts what the fold left out: fifteen lines under a cap of ten leave five", () => {
  setLanguage("zh-CN")
  const folded = collapseToolOutput(lines(15), 10, outputCharCap(10, 100))
  expect(foldHint({ expanded: false, hidden: folded.hidden }, "ctrl+o")).toBe("… 还有 5 行 · ctrl+o 展开")
  // The text it folded to has no `…` line of its own: the hint opens with it.
  expect(folded.output.split("\n")).toHaveLength(10)
  expect(folded.output).not.toContain("…")
})
