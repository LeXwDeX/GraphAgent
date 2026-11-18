// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { HINT_LIMIT, HINT_TEXT, Hints } from "@/session/turn/hints"

const sessionID = SessionID.make("ses_hints")
const messageID = MessageID.make("msg_hints")
let counter = 0
const base = () => ({ id: PartID.make(`prt_hints_${counter++}`), messageID, sessionID })

const text = (value: string, flags: { synthetic?: boolean; ignored?: boolean } = {}): SessionV1.TextPart => ({
  ...base(),
  type: "text",
  text: value,
  ...flags,
})

const reasoning = (value: string): SessionV1.ReasoningPart => ({
  ...base(),
  type: "reasoning",
  text: value,
  time: { start: 1 },
})

const tool = (): SessionV1.ToolPart => ({
  ...base(),
  type: "tool",
  callID: "call-1",
  tool: "read",
  state: { status: "completed", input: {}, output: "ok", title: "read", metadata: {}, time: { start: 1, end: 2 } },
})

// The DSML sample of packages/core/test/session/reasoning-control-markup.test.ts.
const dsml = [
  "<｜DSML｜tool_calls>",
  '<｜DSML｜invoke name="bash">',
  '<｜DSML｜parameter name="command" string="true">git status --short</｜DSML｜parameter>',
  "</｜DSML｜invoke>",
  "</｜DSML｜tool_calls>",
].join("\n")

const jsonCall = 'Let me read it.\n<tool_call>{"name":"read","arguments":{"filePath":"a.ts"}}</tool_call>'

const functionCalls = [
  "<function_calls>",
  '<invoke name="read">',
  '<parameter name="filePath">a.ts</parameter>',
  "</invoke>",
  "</function_calls>",
].join("\n")

describe("Hints.detectPseudoToolCall", () => {
  for (const [name, sample] of [
    ["a DSML tool call envelope", dsml],
    ["a <tool_call> JSON object", jsonCall],
    ["a <function_calls> invoke", functionCalls],
    ["a <function_calls> invoke in other case with single quotes", "<FUNCTION_CALLS><Invoke name='read'>"],
  ] as const) {
    test(`detects ${name}`, () => {
      expect(Hints.detectPseudoToolCall([text(sample)])).toBe(true)
    })
  }

  test("detects a marker outside a fence even when a fenced block precedes it", () => {
    expect(
      Hints.detectPseudoToolCall([text(`Example:\n\`\`\`\n${jsonCall}\n\`\`\`\nNow for real:\n${jsonCall}`)]),
    ).toBe(true)
  })

  test("detects a marker outside a tilde fence even when a tilde fenced block precedes it", () => {
    expect(Hints.detectPseudoToolCall([text(`Example:\n~~~\n${jsonCall}\n~~~\nNow for real:\n${jsonCall}`)])).toBe(true)
  })

  test("detects a marker in any text part of the step", () => {
    expect(Hints.detectPseudoToolCall([text("first"), reasoning("thinking"), text(jsonCall)])).toBe(true)
  })

  for (const [name, parts] of [
    ["a fenced code block", [text(`Calls look like this:\n\`\`\`xml\n${jsonCall}\n\`\`\``)]],
    ["a fenced DSML envelope", [text(`\`\`\`\n${dsml}\n\`\`\``)]],
    ["a tilde fenced code block", [text(`Calls look like this:\n~~~xml\n${jsonCall}\n~~~`)]],
    ["a tilde fenced DSML envelope", [text(`~~~\n${dsml}\n~~~`)]],
    ["a tilde line inside a backtick fence", [text(`\`\`\`\n~~~\n${jsonCall}\n\`\`\``)]],
    ["a backtick line inside a tilde fence", [text(`~~~\n\`\`\`\n${jsonCall}\n~~~`)]],
    [
      "a mention of a marker",
      [text("Use the <tool_call> tag, or <function_calls> and <invoke> elements, only via tools.")],
    ],
    ["plain text", [text("I read the file and found nothing wrong.")]],
    ["a step with a real tool call", [text(jsonCall), tool()]],
    ["synthetic text", [text(jsonCall, { synthetic: true })]],
    ["ignored text", [text(jsonCall, { ignored: true })]],
    ["markers inside reasoning only", [reasoning(jsonCall)]],
    ["no parts", []],
  ] as const) {
    test(`does not flag ${name}`, () => {
      expect(Hints.detectPseudoToolCall(parts)).toBe(false)
    })
  }
})

describe("hint table", () => {
  test("every hint kind has a limit and a text", () => {
    expect(Object.keys(HINT_TEXT).sort()).toEqual(Object.keys(HINT_LIMIT).sort())
    expect(HINT_LIMIT.pseudo_tool_call).toBe(1)
  })

  test("renderHint is the single way a hint becomes message text", () => {
    expect(Hints.renderHint("pseudo_tool_call")).toBe(HINT_TEXT.pseudo_tool_call)
    expect(HINT_TEXT.pseudo_tool_call).toBe(
      "[runtime] Tool calls must use the function-calling interface. The text above looks like a tool call and was not executed. Call the tool through that interface.",
    )
  })
})
