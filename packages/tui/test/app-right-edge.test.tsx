// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import type { Part, ToolPart } from "@graphagent/sdk"
import type { CapturedFrame } from "@opentui/core"
import { DEFAULT_THEME } from "../src/context/theme"
import { setLanguage } from "../src/i18n"
import { DEFAULT_THEMES, resolveTheme } from "../src/theme"
import { readFrame, readSpans, renderUntilFrame } from "./fixture/frames"
import { promptShown, runApp, type Setup } from "./fixture/run-app"
import { assistantMessage, textPart, userMessage } from "./fixture/session-records"
import { json } from "./fixture/tui-sdk"
import { sessionFixture } from "./routes/dag-mode-harness"

/**
 * The right edge of the session screen (#1673). A user saw a ragged column of pure black cells and a few characters of
 * an earlier frame in the last columns of the window, with the screen itself drawn two columns narrower than the
 * terminal. Pure black is the terminal's own default background: the TUI does not paint it once the theme is mounted
 * (the default theme has no black, and `ThemeProvider` makes the theme background the renderer's clear color), so
 * those cells were cells the TUI did not write. The cause could not be reproduced in the TUI, so these tests pin what
 * the TUI owns.
 *
 * Every cell of the screen it draws carries the theme background, the last two columns (the main area's right
 * padding) included, at the sizes the shell is tested at and with the tool output open; a resize leaves nothing of the
 * frame before it; and the screen follows the size of the renderer, not a copy of it that a `resize` listener has to
 * keep up to date.
 */

afterEach(() => {
  setLanguage("zh-CN")
})

const sessionID = "ses_right_edge"

/** Lines that reach the width of the content box, with and without wide characters, so that they are cut with `…`. */
const longLine = `src/very/long/path/to/some/module/file-with-a-long-name.ts:123: ${"x".repeat(200)}`
const cjkLine = "错误：这是一个很长的中文输出行，用来检查宽字符在行尾被截断时的背景处理是否正确。".repeat(4)
const output = [
  ...Array.from({ length: 6 }, (_, index) => `line ${index} ${longLine}`),
  ...Array.from({ length: 4 }, (_, index) => `中文 ${index} ${cjkLine}`),
  "end 0.",
].join("\n")
const command =
  "grep -n -E 'fake|文档|总结|未做|后续' notes.md | sort | uniq -c | head -20; echo '—— 完成 ——'; cat notes.md"

function bash(messageID: string, id: string, input: string, result: string): ToolPart {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: `call_${id}`,
    tool: "bash",
    state: {
      status: "completed",
      input: { command: input, description: "list" },
      output: result,
      title: "list",
      metadata: { output: result },
      time: { start: 1, end: 2 },
    },
  }
}

/** One user message and one assistant message: wrapped CJK text, a table, a code block, a cut command, long output. */
function transcript() {
  const user = userMessage("msg_edge_user", sessionID, 10)
  const reply = assistantMessage("msg_edge_reply", sessionID, user.id, 11)
  const parts: Part[] = [
    textPart(
      reply.id,
      sessionID,
      "prt_edge_text",
      [
        "好的，下面逐项说明，第二项的描述足够长，会在内容区的右端换行：",
        "",
        "- 第一项 `code` 与 **加粗**",
        "- second item with a rather long description that should wrap around the content width of the terminal",
        "",
        "```ts",
        "const x = 1",
        "```",
        "",
        "| 条目 | 编号 | 当前状态 / 剩余动作 |",
        "| --- | --- | --- |",
        "| 多视图与会话锁定模型冲突 | #1 | 检查全部通过；待合并后在测试环境复现，再确认是否需要补充用例 |",
      ].join("\n"),
    ),
    bash(reply.id, "prt_edge_bash", command, output),
    textPart(reply.id, sessionID, "prt_edge_done", "完成。0."),
  ]
  return [
    {
      info: user,
      parts: [textPart(user.id, sessionID, "prt_edge_ask", "请列出文件并检查输出。Check the output ek 0. t please.")],
    },
    { info: reply, parts },
  ]
}

function mount(size: { width: number; height: number }, ambiguousWidth?: 1 | 2) {
  return runApp({
    sessions: [sessionFixture(sessionID)],
    args: { continue: true },
    ambiguousWidth,
    handler: (url) => (url.pathname === `/session/${sessionID}/message` ? json(transcript()) : undefined),
    ...size,
  })
}

/** What every cell holds, as plain text so that two frames can be compared. */
function signature(frame: CapturedFrame) {
  const color = (value: { toInts(): number[] }) => value.toInts().join(",")
  return frame.lines.map((line) =>
    line.spans.map((span) => `${span.text}|${span.width}|${color(span.fg)}|${color(span.bg)}|${span.attributes}`),
  )
}

/** The background of every cell of every row: a span is as wide as the cells it covers. */
function backgrounds(frame: CapturedFrame) {
  return frame.lines.map((line) => line.spans.flatMap((span) => Array.from({ length: span.width }, () => span.bg)))
}

/**
 * Everything that is wrong with the edge of `frame`: a row that does not cover the whole width, a cell of the last two
 * columns that is not the theme background, and any cell at all that is not an opaque color (a cell nothing painted is
 * transparent, and the terminal shows its own background there).
 */
function edgeProblems(frame: CapturedFrame) {
  const background = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark").background.toInts().join(",")
  const problems: string[] = []
  backgrounds(frame).forEach((row, y) => {
    if (row.length !== frame.cols) problems.push(`row ${y} covers ${row.length} of ${frame.cols} columns`)
    for (const x of [row.length - 2, row.length - 1]) {
      const color = row[x]?.toInts().join(",")
      if (color !== background)
        problems.push(`row ${y}, column ${x}: ${color} is not the theme background ${background}`)
    }
    row.forEach((color, x) => {
      if (color.a === 0) problems.push(`row ${y}, column ${x}: nothing painted this cell`)
    })
  })
  return problems
}

/** Renders until two frames in a row are the same, which is when a layout that needs a few frames has settled. */
async function settled(setup: Setup) {
  let previous = ""
  for (let round = 0; round < 40; round++) {
    await setup.renderOnce()
    await Bun.sleep(5)
    const frame = await readFrame(setup)
    if (frame === previous) return readSpans(setup)
    previous = frame
  }
  throw new Error(`the screen did not settle:\n${previous}`)
}

async function transcriptShown(setup: Setup) {
  await renderUntilFrame(setup, (frame) => promptShown(frame) && frame.includes("end 0."), "the transcript")
}

for (const ambiguousWidth of [1, 2] as const) {
  for (const size of [
    { width: 80, height: 24 },
    { width: 120, height: 40 },
  ] as const) {
    test(`every cell of the session screen is painted, the last two columns included, at ${size.width}x${size.height} (ambiguous width ${ambiguousWidth})`, async () => {
      const app = await mount(size, ambiguousWidth)
      try {
        await transcriptShown(app.setup)
        expect(edgeProblems(await settled(app.setup))).toEqual([])
        // The same with the tool output open: its long lines now reach the right end of the content box.
        app.setup.mockInput.pressKey("o", { ctrl: true })
        await renderUntilFrame(app.setup, (frame) => frame.includes("⌃O 收起"), "the open output")
        expect(edgeProblems(await settled(app.setup))).toEqual([])
      } finally {
        await app.stop()
      }
    })
  }
}

test("a resize repaints every cell and leaves nothing of the frame before it", async () => {
  const widths = [120, 100, 120] as const
  const height = 40
  const resized: CapturedFrame[] = []
  const app = await mount({ width: widths[0], height })
  try {
    await transcriptShown(app.setup)
    resized.push(await settled(app.setup))
    for (const width of widths.slice(1)) {
      app.setup.resize(width, height)
      resized.push(await settled(app.setup))
    }
  } finally {
    await app.stop()
  }
  // A screen that was drawn at that size from the start is what a resize has to arrive at.
  const fresh: Record<number, CapturedFrame> = {}
  for (const width of new Set(widths)) {
    const other = await mount({ width, height })
    try {
      await transcriptShown(other.setup)
      fresh[width] = await settled(other.setup)
    } finally {
      await other.stop()
    }
  }
  widths.forEach((width, index) => {
    expect(resized[index].cols).toBe(width)
    expect(edgeProblems(resized[index])).toEqual([])
    expect(signature(resized[index])).toEqual(signature(fresh[width]))
  })
})

test("the screen follows the renderer when a resize listener ahead of the app's own fails", async () => {
  const height = 40
  const app = await mount({ width: 120, height })
  let failures = 0
  let widened: CapturedFrame
  try {
    await transcriptShown(app.setup)
    // The renderer calls its `resize` listeners in order and stops at the first that throws (a resize from the terminal
    // is caught and logged by the renderer, the test renderer's `resize` lets the error through). The app's size
    // signals are kept by such listeners, so with this one in front none of them hears of the new size.
    const failure = "a listener that fails"
    app.setup.renderer.prependListener("resize", () => {
      failures++
      throw new Error(failure)
    })
    try {
      app.setup.resize(140, height)
    } catch (error) {
      if (!(error instanceof Error) || error.message !== failure) throw error
    }
    widened = await settled(app.setup)
    expect(failures).toBe(1)
  } finally {
    await app.stop()
  }
  const other = await mount({ width: 140, height })
  let fresh: CapturedFrame
  try {
    await transcriptShown(other.setup)
    fresh = await settled(other.setup)
  } finally {
    await other.stop()
  }
  expect(widened.cols).toBe(140)
  expect(edgeProblems(widened)).toEqual([])
  // Where the right end of the screen is: the input box is as wide as the screen less its margins.
  const rows = (value: CapturedFrame) => value.lines.map((line) => line.spans.map((span) => span.text).join(""))
  const boxRight = (value: CapturedFrame) =>
    rows(value)
      .find((row) => row.trimStart().startsWith("╭"))
      ?.trimEnd().length
  expect(boxRight(widened)).toBe(boxRight(fresh))
})
