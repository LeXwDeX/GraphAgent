// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import type { Part } from "@graphagent/sdk"
import { setLanguage } from "../../src/i18n"
import {
  handbackLine,
  handbackText,
  promptText,
  sameHandback,
  subagentOutcome,
  UNKNOWN,
} from "../../src/session/subagent-record"

afterEach(() => {
  setLanguage("zh-CN")
})

describe("subagentOutcome", () => {
  test("a running or retrying sub-agent has no outcome, whatever its error or its parent's Task call say", () => {
    expect(subagentOutcome({ status: "busy" })).toBeUndefined()
    expect(subagentOutcome({ status: "retry" })).toBeUndefined()
    // An error on record from an earlier run is beaten by running again, the way the top bar marker has it.
    expect(subagentOutcome({ status: "busy", error: "boom" })).toBeUndefined()
    expect(subagentOutcome({ status: "busy" }, { status: "completed" })).toBeUndefined()
    expect(subagentOutcome({ status: "retry" }, { status: "error" })).toBeUndefined()
  })

  test("an idle one is done, or failed when an error is on record", () => {
    expect(subagentOutcome({ status: "idle" })).toBe("done")
    expect(subagentOutcome({ status: "idle", error: "boom" })).toBe("failed")
    // Its own state is the one that counts: the Task call is read only when the session says nothing.
    expect(subagentOutcome({ status: "idle" }, { status: "error" })).toBe("done")
    expect(subagentOutcome({ status: "idle", error: "boom" }, { status: "completed" })).toBe("failed")
  })

  test("an unknown state goes by the foreground Task call of the parent that ended", () => {
    expect(subagentOutcome({ status: "unknown" }, { status: "completed" })).toBe("done")
    expect(subagentOutcome(undefined, { status: "completed" })).toBe("done")
    expect(subagentOutcome({ status: "unknown" }, { status: "error" })).toBe("failed")
    expect(subagentOutcome({ status: "unknown" }, { status: "running" })).toBeUndefined()
    expect(subagentOutcome({ status: "unknown" }, { status: "pending" })).toBeUndefined()
    expect(subagentOutcome({ status: "unknown" }, {})).toBeUndefined()
  })

  test("a background Task call says nothing of how its agent ended", () => {
    expect(subagentOutcome({ status: "unknown" }, { background: true, status: "completed" })).toBeUndefined()
    expect(subagentOutcome({ status: "unknown" }, { background: true, status: "error" })).toBeUndefined()
  })

  test("with neither the session's state nor a Task call there is nothing to say", () => {
    expect(subagentOutcome(undefined)).toBeUndefined()
    expect(subagentOutcome({ status: "unknown" })).toBeUndefined()
  })
})

describe("handbackLine", () => {
  test("counts the tool calls the summary holds, and the time from its start to its last activity", () => {
    expect(handbackLine("done", { toolCalls: 12, startedAt: 1_000, lastActivityAt: 66_000 })).toEqual({
      outcome: "done",
      toolCalls: 12,
      duration: 65_000,
    })
  })

  test("keeps what is unknown unknown: no count is 0, and no start or no time passed is no time", () => {
    expect(handbackLine("failed", { startedAt: 1_000, lastActivityAt: 66_000 }).toolCalls).toBeUndefined()
    expect(handbackLine("done", { toolCalls: 3, lastActivityAt: 66_000 }).duration).toBeUndefined()
    expect(handbackLine("done", { toolCalls: 3, startedAt: 66_000, lastActivityAt: 66_000 }).duration).toBeUndefined()
    expect(handbackLine("done", { toolCalls: 3, startedAt: 70_000, lastActivityAt: 66_000 }).duration).toBeUndefined()
    expect(handbackLine("done", undefined)).toEqual({ outcome: "done", toolCalls: undefined, duration: undefined })
    // A real zero stays a zero.
    expect(handbackLine("done", { toolCalls: 0, startedAt: 1, lastActivityAt: 2 }).toolCalls).toBe(0)
  })

  test("sameHandback compares what the line says", () => {
    const line = { outcome: "done", toolCalls: 2, duration: 65_000 } as const
    expect(sameHandback(line, { ...line })).toBe(true)
    expect(sameHandback(undefined, undefined)).toBe(true)
    expect(sameHandback(line, undefined)).toBe(false)
    expect(sameHandback(line, { ...line, outcome: "failed" })).toBe(false)
    expect(sameHandback(line, { ...line, toolCalls: 3 })).toBe(false)
    expect(sameHandback(line, { ...line, duration: 66_000 })).toBe(false)
  })
})

describe("handbackText", () => {
  test("says in Chinese that the result, or the error, went back to the main session", () => {
    setLanguage("zh-CN")
    const done = handbackText({ outcome: "done", toolCalls: 12, duration: 65_000 })
    expect(done.glyph + done.lead + done.meta).toBe("✓ 已完成，结果已交回主会话 · 12 次工具调用 · 1m 5s")
    const failed = handbackText({ outcome: "failed", toolCalls: 3, duration: 1_200 })
    expect(failed.glyph + failed.lead + failed.meta).toBe("✗ 已失败，错误已交回主会话 · 3 次工具调用 · 1.2s")
  })

  test("and in English, with one call in the singular", () => {
    setLanguage("en")
    const done = handbackText({ outcome: "done", toolCalls: 12, duration: 65_000 })
    expect(done.glyph + done.lead + done.meta).toBe(
      "✓ Done, result handed back to the main session · 12 tool calls · 1m 5s",
    )
    const one = handbackText({ outcome: "failed", toolCalls: 1, duration: 400 })
    expect(one.glyph + one.lead + one.meta).toBe(
      "✗ Failed, error handed back to the main session · 1 tool call · 400ms",
    )
  })

  test("shows a dash for a count or a time it does not know, in either language", () => {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguage(language)
      const unknown = handbackText({ outcome: "done", toolCalls: undefined, duration: undefined })
      expect(unknown.meta).toBe(` · ${UNKNOWN} · ${UNKNOWN}`)
      expect(UNKNOWN).toBe("—")
      // A zero is a count: it reads as one.
      expect(handbackText({ outcome: "done", toolCalls: 0, duration: 5_000 }).meta).toContain("0 ")
    }
  })

  test("the glyph is the one of the top bar marker", () => {
    expect(handbackText({ outcome: "done", toolCalls: 1, duration: 1 }).glyph).toBe("✓")
    expect(handbackText({ outcome: "failed", toolCalls: 1, duration: 1 }).glyph).toBe("✗")
  })
})

describe("promptText", () => {
  const part = (extra: Partial<Part> & { type: Part["type"] }) =>
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- fixture: only the fields the reader looks at.
    ({ id: "prt", sessionID: "ses", messageID: "msg", ...extra }) as Part

  test("joins the visible text parts of a message with a blank line", () => {
    expect(promptText([part({ type: "text", text: "第一段" }), part({ type: "text", text: "第二段" })])).toBe(
      "第一段\n\n第二段",
    )
  })

  test("leaves out what the transcript does not show: synthetic text, files and tool calls", () => {
    expect(
      promptText([
        part({ type: "text", text: "可见" }),
        part({ type: "text", text: "系统补充", synthetic: true }),
        part({ type: "file" }),
        part({ type: "tool" }),
      ]),
    ).toBe("可见")
    expect(promptText([])).toBe("")
  })
})
