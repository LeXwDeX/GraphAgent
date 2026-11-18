// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { TextRenderable, type Renderable } from "@opentui/core"
import type { GlobalEvent, Session, ToolPart } from "@graphagent/sdk"
import { DEFAULT_THEME } from "../../../src/context/theme"
import type { Ticker } from "../../../src/context/ticker"
import { setLanguage } from "../../../src/i18n"
import { WINDOW_MIN_ROWS } from "../../../src/routes/session/rows"
import { DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { cellWidth } from "../../../src/ui/width"
import { AppRoutes } from "../../fixture/route-frame"
import {
  assistantMessage,
  readPart,
  taskCall,
  textPart as text,
  userMessage,
  type MessageEntry as Entry,
  type TaskStatus,
} from "../../fixture/session-records"
import { directory, json, type FetchHandler } from "../../fixture/tui-sdk"
import { mountRoute, sessionFixture, waitFor } from "../dag-mode-harness"

/**
 * The record of a sub-agent (#1033 3.4): the task its parent delegated opens it, and a line that says the result went
 * back to the main session closes it once the agent is done. A main session has neither.
 */

afterEach(() => {
  setLanguage("zh-CN")
})

const palette = () => resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")

const rootID = "ses_rec_root"
const childID = "ses_rec_child"

const root = sessionFixture(rootID, { title: "升级工具链与全部依赖", time: { created: 1, updated: 2 } })
const child = sessionFixture(childID, {
  parentID: rootID,
  title: "扫描破坏性变更 (@explore subagent)",
  agent: "explore",
  time: { created: 1_000, updated: 66_000 },
})

/** The Task call of the root that started the child. */
function taskPart(status: TaskStatus = "completed", options: { background?: boolean; description?: string } = {}) {
  return taskCall({
    parentID: rootID,
    messageID: "msg_rec_root_assistant",
    id: "prt_rec_task",
    childID,
    status,
    ...options,
  })
}

const PROMPT = "请扫描 CHANGELOG 中的全部破坏性变更。\n只读，不要修改任何文件。\n最后按包名汇总。"
const FIRST_PROMPT_LINE = "请扫描 CHANGELOG 中的全部破坏性变更。"
const TITLE = "任务 · 来自主会话"
const DONE = "已完成，结果已交回主会话"
const FAILED = "已失败，错误已交回主会话"

const count = (frame: string, needle: string) => frame.split(needle).length - 1

function childEntries(prompt = PROMPT): Entry[] {
  return [
    {
      info: userMessage("msg_rec_child_user", childID, 1_000),
      parts: [text("msg_rec_child_user", childID, "prt_rec_child_prompt", prompt)],
    },
    {
      info: assistantMessage("msg_rec_child_assistant", childID, "msg_rec_child_user", 2_000),
      parts: [
        readPart("msg_rec_child_assistant", childID, "prt_rec_child_read_1"),
        readPart("msg_rec_child_assistant", childID, "prt_rec_child_read_2"),
        text("msg_rec_child_assistant", childID, "prt_rec_child_answer", "找到 2 处破坏性变更。"),
      ],
    },
  ]
}

/** A prompt the parent sent after the first one: the child was asked again. */
function followUp(): Entry {
  return {
    info: userMessage("msg_rec_child_user_2", childID, 3_000),
    parts: [text("msg_rec_child_user_2", childID, "prt_rec_child_prompt_2", "再查一遍依赖的版本。")],
  }
}

function rootEntries(task: ToolPart = taskPart()): Entry[] {
  return [
    {
      info: userMessage("msg_rec_root_user", rootID, 10),
      parts: [text("msg_rec_root_user", rootID, "prt_rec_root_prompt", "升级所有依赖")],
    },
    {
      info: assistantMessage("msg_rec_root_assistant", rootID, "msg_rec_root_user", 20),
      parts: [task],
    },
  ]
}

function transcripts(options: { child?: Entry[]; root?: Entry[] } = {}): FetchHandler {
  return (url) => {
    if (url.pathname === `/session/${childID}/message`) return json(options.child ?? childEntries())
    if (url.pathname === `/session/${rootID}/message`) return json(options.root ?? rootEntries())
    return undefined
  }
}

let sequence = 0
function event(type: string, properties: Record<string, unknown>): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return { directory, payload: { id: `evt_rec_${++sequence}`, type, properties } } as GlobalEvent
}

const status = (type: "busy" | "idle") => event("session.status", { sessionID: childID, status: { type } })
const retrying = () =>
  event("session.status", { sessionID: childID, status: { type: "retry", attempt: 1, message: "slow", next: 1 } })
const failure = () =>
  event("session.error", { sessionID: childID, error: { name: "UnknownError", data: { message: "boom" } } })

type MountOptions = {
  route?: string
  language?: "zh-CN" | "en"
  handler?: FetchHandler
  sessions?: readonly Session[]
  width?: number
  height?: number
  ambiguousWidth?: 1 | 2
  ticker?: Ticker
}

async function mount(options: MountOptions = {}) {
  const harness = await mountRoute({
    route: { type: "session", sessionID: options.route ?? childID },
    view: () => <AppRoutes />,
    frame: true,
    sessions: options.sessions ?? [root, child],
    handler: options.handler ?? transcripts(),
    language: options.language,
    kv: options.ambiguousWidth ? { ambiguous_width: options.ambiguousWidth } : undefined,
    ticker: options.ticker,
    width: options.width ?? 100,
    height: options.height ?? 30,
  })
  try {
    await waitFor(() => harness.sync().status === "complete", 10_000)
  } catch (error) {
    await harness.dispose()
    throw error
  }
  return harness
}

type Harness = Awaited<ReturnType<typeof mount>>

/** The color of the first span that holds `needle`. */
async function colorOf(harness: Harness, needle: string) {
  const frame = await harness.spans()
  for (const line of frame.lines) {
    const span = line.spans.find((item) => item.text.includes(needle))
    if (span) return span.fg
  }
  return undefined
}

const rowOf = (frame: string, needle: string) =>
  frame
    .split("\n")
    .find((line) => line.includes(needle))
    ?.trim()

/** The background of the first span that holds `needle`. */
async function backgroundOf(harness: Harness, needle: string) {
  const frame = await harness.spans()
  for (const line of frame.lines) {
    const span = line.spans.find((item) => item.text.includes(needle))
    if (span) return span.bg
  }
  return undefined
}

/** A prompt of `count` lines, each named by its number, so a frame says how much of it is drawn. */
const promptOf = (count: number) =>
  Array.from({ length: count }, (_, index) => `prompt-line-${String(index + 1).padStart(2, "0")}`).join("\n")

/** The words the task block of a prompt that folds says under it, by language. */
const HINTS = {
  "zh-CN": { expand: "点击展开", collapse: "点击折叠" },
  en: { expand: "Click to expand", collapse: "Click to collapse" },
} as const

/** The text of every text node that is mounted: a row the transcript unmounted is not in it. */
function mountedText(node: Renderable): string[] {
  return [...(node instanceof TextRenderable ? [node.plainText] : []), ...node.getChildren().flatMap(mountedText)]
}

function pressExpand(harness: Harness) {
  harness.app.mockInput.pressKey("o", { ctrl: true })
}

/**
 * Clicks `dx` cells into the first row that holds `needle`. A second click on the same cell is a double click, which
 * selects a word, and the block ignores a click while text is selected: a test that clicks twice uses two cells.
 */
async function clickOn(harness: Harness, needle: string, dx: number) {
  const rows = (await harness.frame()).split("\n")
  const row = rows.findIndex((line) => line.includes(needle))
  expect(row).toBeGreaterThanOrEqual(0)
  await harness.app.mockMouse.click(rows[row].indexOf(needle) + dx, row)
  harness.app.renderer.clearSelection()
  await harness.settle()
}

test("the first user message of a sub-agent opens its record as the task block, drawn once", async () => {
  const harness = await mount()
  try {
    const frame = await harness.waitForFrame((value) => value.includes("找到 2 处"), "the record")
    expect(count(frame, TITLE)).toBe(1)
    // The Task description above the prompt, then the prompt itself line by line.
    expect(frame).toContain("扫描变更日志")
    for (const line of PROMPT.split("\n")) expect(frame).toContain(line)
    // The prompt is the block's, not also a user message under it.
    expect(count(frame, FIRST_PROMPT_LINE)).toBe(1)
    // The block comes before everything the agent did.
    expect(frame.indexOf(TITLE)).toBeLessThan(frame.indexOf(FIRST_PROMPT_LINE))
    expect(frame.indexOf(FIRST_PROMPT_LINE)).toBeLessThan(frame.indexOf("找到 2 处"))
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("the task block says it in English too, and the description falls back to the title without its tail", async () => {
  // No description in the parent's Task call: the description is the session title less its `(@x subagent)` tail.
  const harness = await mount({
    language: "en",
    handler: transcripts({ root: rootEntries(taskPart("completed", { description: "" })) }),
  })
  try {
    const frame = await harness.waitForFrame((value) => value.includes("Task · from the main session"), "the block")
    expect(count(frame, "Task · from the main session")).toBe(1)
    expect(rowOf(frame, "扫描破坏性变更")).toBe("┃  扫描破坏性变更")
    expect(frame).toContain(FIRST_PROMPT_LINE)
    expect(frame).not.toContain(TITLE)
  } finally {
    await harness.dispose()
  }
})

test("a main session has no task block and shows its first user message as one", async () => {
  const harness = await mount({ route: rootID })
  try {
    const frame = await harness.waitForFrame((value) => value.includes("升级所有依赖"), "the main session")
    expect(frame).not.toContain(TITLE)
    expect(frame).not.toContain("Task · from the main session")
    expect(frame).not.toContain(DONE)
    expect(frame).not.toContain(FAILED)
  } finally {
    await harness.dispose()
  }
})

test("only the first message is the task: a later prompt of the parent stays an ordinary user message", async () => {
  const entries = [
    ...childEntries(),
    followUp(),
    {
      info: assistantMessage("msg_rec_child_assistant_2", childID, "msg_rec_child_user_2", 4_000),
      parts: [text("msg_rec_child_assistant_2", childID, "prt_rec_child_answer_2", "版本都没有变。")],
    },
  ]
  const harness = await mount({ handler: transcripts({ child: entries }) })
  try {
    const frame = await harness.waitForFrame((value) => value.includes("版本都没有变"), "the second answer")
    expect(count(frame, TITLE)).toBe(1)
    expect(count(frame, "再查一遍依赖的版本。")).toBe(1)
    expect(frame.indexOf(TITLE)).toBeLessThan(frame.indexOf("再查一遍依赖的版本。"))
  } finally {
    await harness.dispose()
  }
})

test("a window that no longer holds the first message has no task block, and what it holds shows as usual", async () => {
  const harness = await mount({ handler: transcripts({ child: [...childEntries().slice(1), followUp()] }) })
  try {
    const frame = await harness.waitForFrame((value) => value.includes("再查一遍依赖的版本。"), "the later prompt")
    expect(frame).not.toContain(TITLE)
    expect(frame).toContain("找到 2 处破坏性变更。")
  } finally {
    await harness.dispose()
  }
})

test("a long prompt shows its first lines and folds the rest into an ellipsis", async () => {
  const lines = Array.from({ length: 30 }, (_, index) => `prompt-line-${String(index + 1).padStart(2, "0")}`)
  const harness = await mount({ handler: transcripts({ child: childEntries(lines.join("\n")) }), height: 40 })
  try {
    const frame = await harness.waitForFrame((value) => value.includes("找到 2 处"), "the record")
    expect(frame).toContain("prompt-line-01")
    expect(frame).toContain("prompt-line-08")
    expect(frame).not.toContain("prompt-line-09")
    expect(frame).not.toContain("prompt-line-30")
    // The fold is the one tool output folds by: a line of its own.
    expect(frame.split("\n").some((line) => line.trim() === "┃  …")).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test("a prompt that fits has no hint, and the key has nothing to open in the block", async () => {
  const harness = await mount()
  try {
    const before = await harness.waitForFrame((value) => value.includes("找到 2 处"), "the record")
    expect(before).not.toContain(HINTS["zh-CN"].expand)
    expect(before).not.toContain(HINTS["zh-CN"].collapse)

    pressExpand(harness)
    await harness.settle()
    expect(await harness.frame()).toBe(before)
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("a long prompt says it can be opened, ctrl+o opens it whole, and the next press folds it again", async () => {
  const harness = await mount({ handler: transcripts({ child: childEntries(promptOf(20)) }), height: 40 })
  try {
    const folded = await harness.waitForFrame((value) => value.includes("找到 2 处"), "the record")
    expect(folded).toContain("prompt-line-08")
    expect(folded).not.toContain("prompt-line-09")
    expect(folded).not.toContain("prompt-line-20")
    // The cut is the `…` line, and under it, a line of its own, what a click or the key does.
    expect(folded.split("\n").some((line) => line.trim() === "┃  …")).toBe(true)
    expect(rowOf(folded, HINTS["zh-CN"].expand)).toBe(`┃  ${HINTS["zh-CN"].expand}`)
    expect(folded).not.toContain(HINTS["zh-CN"].collapse)

    pressExpand(harness)
    const opened = await harness.waitForFrame((value) => value.includes("prompt-line-20"), "the whole prompt")
    for (const line of promptOf(20).split("\n")) expect(count(opened, line)).toBe(1)
    expect(opened.split("\n").some((line) => line.trim() === "┃  …")).toBe(false)
    expect(rowOf(opened, HINTS["zh-CN"].collapse)).toBe(`┃  ${HINTS["zh-CN"].collapse}`)
    expect(opened).not.toContain(HINTS["zh-CN"].expand)
    // The agent's own record is still under it.
    expect(opened.indexOf("prompt-line-20")).toBeLessThan(opened.indexOf("找到 2 处"))

    // It is the only block that can fold and it is open, so the key closes it.
    pressExpand(harness)
    const closed = await harness.waitForFrame((value) => !value.includes("prompt-line-20"), "the fold")
    expect(closed).toContain("prompt-line-08")
    expect(closed).not.toContain("prompt-line-09")
    expect(closed).toContain(HINTS["zh-CN"].expand)
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("a click on a long prompt opens it and a click again folds it, and the words follow the language", async () => {
  const harness = await mount({
    language: "en",
    handler: transcripts({ child: childEntries(promptOf(20)) }),
    height: 40,
  })
  try {
    const folded = await harness.waitForFrame((value) => value.includes(HINTS.en.expand), "the hint")
    expect(folded).not.toContain(HINTS["zh-CN"].expand)
    expect(folded).not.toContain("prompt-line-09")

    await clickOn(harness, HINTS.en.expand, 2)
    const opened = await harness.waitForFrame((value) => value.includes(HINTS.en.collapse), "the open block")
    expect(opened).toContain("prompt-line-20")
    expect(opened).not.toContain(HINTS.en.expand)
    expect(opened).not.toContain(HINTS["zh-CN"].collapse)

    await clickOn(harness, HINTS.en.collapse, 10)
    const closed = await harness.waitForFrame((value) => value.includes(HINTS.en.expand), "the folded block")
    expect(closed).not.toContain("prompt-line-09")
    // A click is no request, and it opens no panel of actions either.
    expect(harness.writes()).toEqual([])
    expect(harness.bottomZone()?.host.depth()).toBe(0)
  } finally {
    await harness.dispose()
  }
})

test("a task block opened by a click closes by key, and the other way round", async () => {
  const harness = await mount({ handler: transcripts({ child: childEntries(promptOf(20)) }), height: 40 })
  try {
    await harness.waitForFrame((value) => value.includes(HINTS["zh-CN"].expand), "the hint")
    await clickOn(harness, HINTS["zh-CN"].expand, 2)
    await harness.waitForFrame((value) => value.includes("prompt-line-20"), "opened by the click")

    // Nothing is folded any more, so the key closes the block the click opened.
    pressExpand(harness)
    await harness.waitForFrame((value) => !value.includes("prompt-line-20"), "closed by the key")

    pressExpand(harness)
    await harness.waitForFrame((value) => value.includes("prompt-line-20"), "opened by the key")
    await clickOn(harness, HINTS["zh-CN"].collapse, 4)
    await harness.waitForFrame((value) => !value.includes("prompt-line-20"), "closed by the click")
  } finally {
    await harness.dispose()
  }
})

test("selecting text of a folded prompt does not open it", async () => {
  const harness = await mount({ handler: transcripts({ child: childEntries(promptOf(20)) }), height: 40 })
  try {
    const frame = await harness.waitForFrame((value) => value.includes(HINTS["zh-CN"].expand), "the hint")
    const rows = frame.split("\n")
    const row = rows.findIndex((line) => line.includes("prompt-line-03"))
    const column = rows[row].indexOf("prompt-line-03")
    await harness.app.mockMouse.drag(column, row, column + 10, row)
    await harness.settle()
    expect(harness.app.renderer.getSelection()?.getSelectedText()).toContain("prompt-line")
    expect(await harness.frame()).not.toContain("prompt-line-20")
    expect(await harness.frame()).toContain(HINTS["zh-CN"].expand)

    // Once nothing is selected a click on the same text opens it.
    harness.app.renderer.clearSelection()
    await clickOn(harness, "prompt-line-05", 12)
    await harness.waitForFrame((value) => value.includes("prompt-line-20"), "the open block")
  } finally {
    await harness.dispose()
  }
})

test("a prompt that folds is highlighted under the pointer, and one that fits is not", async () => {
  const hovered = async (prompt: string, needle: string) => {
    const harness = await mount({ handler: transcripts({ child: childEntries(prompt) }), height: 40 })
    try {
      const frame = await harness.waitForFrame((value) => value.includes(needle), "the prompt")
      const rows = frame.split("\n")
      const row = rows.findIndex((line) => line.includes(needle))
      const idle = await backgroundOf(harness, needle)
      await harness.app.mockMouse.moveTo(rows[row].indexOf(needle) + 1, row)
      await harness.settle()
      const over = await backgroundOf(harness, needle)
      await harness.app.mockMouse.moveTo(0, 0)
      await harness.settle()
      const away = await backgroundOf(harness, needle)
      return { idle, over, away }
    } finally {
      await harness.dispose()
    }
  }

  const folds = await hovered(promptOf(20), "prompt-line-03")
  expect(folds.idle?.equals(palette().backgroundPanel)).toBe(true)
  expect(folds.over?.equals(palette().backgroundMenu)).toBe(true)
  expect(folds.away?.equals(palette().backgroundPanel)).toBe(true)

  const fits = await hovered(PROMPT, FIRST_PROMPT_LINE)
  expect(fits.over?.equals(palette().backgroundPanel)).toBe(true)
})

test("the task block of a sub-agent view can be selected and copied like any text, and a click on a prompt that fits does nothing", async () => {
  const harness = await mount()
  try {
    const frame = await harness.waitForFrame((value) => value.includes("找到 2 处"), "the record")
    const rows = frame.split("\n")
    const row = rows.findIndex((line) => line.includes(FIRST_PROMPT_LINE))
    const column = rows[row].indexOf(FIRST_PROMPT_LINE)
    await harness.app.mockMouse.click(column + 2, row)
    await harness.settle()
    // No action list: the bottom zone holds no panel, and nothing was asked of the server.
    expect(harness.bottomZone()?.host.depth()).toBe(0)
    expect(harness.writes()).toEqual([])

    await harness.app.mockMouse.drag(column, row, column + 10, row)
    await harness.settle()
    expect(harness.app.renderer.getSelection()?.getSelectedText()).toContain("请扫描")
    expect(harness.bottomZone()?.host.depth()).toBe(0)
  } finally {
    await harness.dispose()
  }
})

test("a click on a user message opens its actions in a main session and does nothing in a sub-agent view", async () => {
  const main = await mount({ route: rootID })
  try {
    const frame = await main.waitForFrame((value) => value.includes("升级所有依赖"), "the main session")
    const rows = frame.split("\n")
    const row = rows.findIndex((line) => line.includes("升级所有依赖"))
    await main.app.mockMouse.click(rows[row].indexOf("升级所有依赖") + 1, row)
    await main.settle()
    expect(main.bottomZone()?.host.top()?.id).toBe("message")
  } finally {
    await main.dispose()
  }

  // A prompt the parent sent later is an ordinary user message, and as little clickable.
  const sub = await mount({ handler: transcripts({ child: [...childEntries(), followUp()] }) })
  try {
    const frame = await sub.waitForFrame((value) => value.includes("再查一遍依赖的版本。"), "the later prompt")
    const rows = frame.split("\n")
    const row = rows.findIndex((line) => line.includes("再查一遍依赖的版本。"))
    await sub.app.mockMouse.click(rows[row].indexOf("再查一遍依赖的版本。") + 1, row)
    await sub.settle()
    expect(sub.bottomZone()?.host.depth()).toBe(0)
    expect(sub.writes()).toEqual([])
  } finally {
    await sub.dispose()
  }
})

test("a finished sub-agent closes its record with a line that says the result went back, in gray", async () => {
  const harness = await mount()
  try {
    harness.events.emit(status("idle"))
    const frame = await harness.waitForFrame((value) => value.includes(DONE), "the closing line")
    expect(count(frame, DONE)).toBe(1)
    // Two tool calls in the loaded messages; 65 seconds from the start to the last activity.
    expect(rowOf(frame, DONE)).toBe(`✓ ${DONE} · 2 次工具调用 · 1m 5s`)
    // The last thing in the record: nothing of the agent comes after it.
    expect(frame.indexOf("找到 2 处")).toBeLessThan(frame.indexOf(DONE))
    expect((await colorOf(harness, "✓"))?.equals(palette().success)).toBe(true)
    expect((await colorOf(harness, DONE))?.equals(palette().textMuted)).toBe(true)
    expect((await colorOf(harness, "2 次工具调用"))?.equals(palette().textMuted)).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test("a failed sub-agent closes it with the error line, in the error color", async () => {
  const harness = await mount()
  try {
    harness.events.emit(failure())
    const frame = await harness.waitForFrame((value) => value.includes(FAILED), "the closing line")
    expect(frame).not.toContain(DONE)
    expect(rowOf(frame, FAILED)).toStartWith(`✗ ${FAILED} · 2 次工具调用 · `)
    expect((await colorOf(harness, "✗"))?.equals(palette().error)).toBe(true)
    expect((await colorOf(harness, FAILED))?.equals(palette().error)).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test("while the sub-agent runs there is no closing line, and it comes back when the agent is done", async () => {
  const harness = await mount({ handler: transcripts({ root: rootEntries(taskPart("running")) }) })
  try {
    harness.events.emit(status("busy"))
    const running = await harness.waitForFrame((value) => value.includes("找到 2 处"), "the record")
    await harness.settle()
    expect(running).toContain(TITLE)
    expect(await harness.frame()).not.toContain("结果已交回主会话")
    expect(await harness.frame()).not.toContain("错误已交回主会话")

    harness.events.emit(status("idle"))
    await harness.waitForFrame((value) => value.includes(DONE), "the closing line")

    // Asked again, it runs again, and the line goes while it does.
    harness.events.emit(status("busy"))
    await waitFor(() => harness.sync().data.summary[childID]?.status === "busy")
    await harness.settle()
    expect(await harness.frame()).not.toContain("结果已交回主会话")
  } finally {
    await harness.dispose()
  }
})

test("a retrying sub-agent has not finished either", async () => {
  const harness = await mount({ handler: transcripts({ root: rootEntries(taskPart("running")) }) })
  try {
    harness.events.emit(retrying())
    await waitFor(() => harness.sync().data.summary[childID]?.status === "retry")
    await harness.settle()
    expect(await harness.frame()).not.toContain("结果已交回主会话")
  } finally {
    await harness.dispose()
  }
})

test("the closing line counts tool calls, says one call in the singular, and shows a dash for what is unknown", async () => {
  const harness = await mount({ language: "en" })
  try {
    harness.events.emit(status("idle"))
    const done = await harness.waitForFrame(
      (value) => value.includes("Done, result handed back to the main session"),
      "the closing line",
    )
    expect(rowOf(done, "Done,")).toBe("✓ Done, result handed back to the main session · 2 tool calls · 1m 5s")

    harness.sync().set("summary", childID, "toolCalls", 1)
    const one = await harness.waitForFrame((value) => value.includes("1 tool call ·"), "one tool call")
    expect(rowOf(one, "Done,")).toBe("✓ Done, result handed back to the main session · 1 tool call · 1m 5s")

    // A cold start has no count: the dash, never a 0. Without a start time there is no time either.
    harness.sync().set("summary", childID, "toolCalls", undefined)
    harness.sync().set("summary", childID, "startedAt", undefined)
    const unknown = await harness.waitForFrame((value) => value.includes("main session · —"), "the dashes")
    expect(rowOf(unknown, "Done,")).toBe("✓ Done, result handed back to the main session · — · —")
  } finally {
    await harness.dispose()
  }
})

test("a failed one reads the same in English", async () => {
  const harness = await mount({ language: "en" })
  try {
    harness.events.emit(failure())
    await harness.waitForFrame((value) => value.includes("Failed, error handed back to the main session"), "the line")
    // The error stamps the summary with the wall clock; the fixture's session started in 1970.
    harness.sync().set("summary", childID, "lastActivityAt", 66_000)
    const frame = await harness.waitForFrame((value) => value.includes("1m 5s"), "the time")
    expect(rowOf(frame, "Failed,")).toBe("✗ Failed, error handed back to the main session · 2 tool calls · 1m 5s")
  } finally {
    await harness.dispose()
  }
})

test("a sub-agent whose own state is unknown ends as its parent's Task call did, a background one not at all", async () => {
  // No status event came: a cold start. The foreground Task call of the parent is what is left to go by.
  for (const [task, expected] of [
    [taskPart("completed"), DONE],
    [taskPart("error"), FAILED],
    [taskPart("running"), undefined],
    [taskPart("completed", { background: true }), undefined],
  ] as const) {
    const harness = await mount({ handler: transcripts({ root: rootEntries(task) }) })
    try {
      await harness.waitForFrame((value) => value.includes("找到 2 处"), "the record")
      await harness.settle()
      const frame = await harness.frame()
      expect(frame).toContain(TITLE)
      expect(frame.includes(DONE)).toBe(expected === DONE)
      expect(frame.includes(FAILED)).toBe(expected === FAILED)
    } finally {
      await harness.dispose()
    }
  }
})

test("the session's own state beats the parent's Task call: a running agent has no line even if the call ended", async () => {
  const harness = await mount({ handler: transcripts({ root: rootEntries(taskPart("completed")) }) })
  try {
    harness.events.emit(status("busy"))
    await waitFor(() => harness.sync().data.summary[childID]?.status === "busy")
    await harness.settle()
    expect(await harness.frame()).not.toContain("结果已交回主会话")
  } finally {
    await harness.dispose()
  }
})

for (const language of ["zh-CN", "en"] as const) {
  for (const ambiguousWidth of [1, 2] as const) {
    test(`the record fits 80 columns in ${language} at ambiguous_width ${ambiguousWidth}`, async () => {
      const long = Array.from(
        { length: 6 },
        (_, index) =>
          `${index + 1}. 逐个检查每一个依赖包的变更日志并把其中的破坏性变更按包名汇总 verify every changelog entry one by one`,
      ).join("\n")
      const description = "扫描全部变更日志中的破坏性变更并汇总每一项发现 scan every changelog"
      const harness = await mount({
        language,
        ambiguousWidth,
        width: 80,
        height: 40,
        handler: transcripts({
          child: childEntries(long),
          root: rootEntries(taskPart("completed", { description })),
        }),
      })
      try {
        harness.events.emit(status("idle"))
        const title = language === "en" ? "Task · from the main session" : TITLE
        const closing = language === "en" ? "Done, result handed back to the main session" : DONE
        const frame = await harness.waitForFrame((value) => value.includes(closing), "the closing line")
        expect(frame).toContain(title)
        for (const line of frame.split("\n")) expect(cellWidth(line.trimEnd(), ambiguousWidth)).toBeLessThanOrEqual(80)
        // The closing line is one row: it was not wrapped.
        expect(rowOf(frame, closing)).toMatch(/ · \d+ (次工具调用|tool calls) · 1m 5s$/)
      } finally {
        await harness.dispose()
      }
    })
  }
}

for (const language of ["zh-CN", "en"] as const) {
  for (const ambiguousWidth of [1, 2] as const) {
    test(`a task block that folds, open or not, fits 80 columns in ${language} at ambiguous_width ${ambiguousWidth}`, async () => {
      const prompt = Array.from(
        { length: 12 },
        (_, index) => `${index + 1}. 逐个检查每一个依赖包的变更日志并汇总 verify every changelog entry one by one`,
      ).join("\n")
      const description = "扫描全部变更日志中的破坏性变更并汇总每一项发现 scan every changelog"
      const harness = await mount({
        language,
        ambiguousWidth,
        width: 80,
        height: 60,
        handler: transcripts({
          child: childEntries(prompt),
          root: rootEntries(taskPart("completed", { description })),
        }),
      })
      try {
        const hint = HINTS[language]
        const folded = await harness.waitForFrame((value) => value.includes(hint.expand), "the hint")
        for (const line of folded.split("\n")) expect(cellWidth(line.trimEnd(), ambiguousWidth)).toBeLessThanOrEqual(80)
        // The hint is a row of its own, not wrapped into the prompt.
        expect(rowOf(folded, hint.expand)).toBe(`┃  ${hint.expand}`)

        pressExpand(harness)
        const opened = await harness.waitForFrame((value) => value.includes(hint.collapse), "the hint that closes it")
        for (const line of opened.split("\n")) expect(cellWidth(line.trimEnd(), ambiguousWidth)).toBeLessThanOrEqual(80)
        expect(rowOf(opened, hint.collapse)).toBe(`┃  ${hint.collapse}`)
        expect(opened).toContain("12. 逐个检查每一个依赖包的变更日志并汇总")
      } finally {
        await harness.dispose()
      }
    })
  }
}

for (const language of ["zh-CN", "en"] as const) {
  test(`the record at 80x24 in ${language}`, async () => {
    const harness = await mount({ language, width: 80, height: 24 })
    try {
      harness.events.emit(status("idle"))
      const closing = language === "en" ? "Done, result handed back" : DONE
      const frame = await harness.waitForFrame((value) => value.includes(closing), "the closing line")
      expect(frame).toMatchSnapshot()
    } finally {
      await harness.dispose()
    }
  })
}

/** A record of `childEntries` plus enough text parts to be windowed: the task block is the first of 2000 rows and more. */
function windowedEntries(prompt: string) {
  const entries = childEntries(prompt)
  const partsPerMessage = Math.ceil(WINDOW_MIN_ROWS / 90)
  for (let index = 0; index < 90; index++) {
    const id = `msg_rec_bulk_${index}`
    entries.push({
      info: assistantMessage(id, childID, "msg_rec_child_user", 3_000 + index),
      parts: Array.from({ length: partsPerMessage }, (_, part) =>
        text(id, childID, `prt_rec_bulk_${index}_${part}`, `bulk ${index}.${part}`),
      ),
    })
  }
  return entries
}

test("a transcript long enough to be windowed has the task block first and the closing line last", async () => {
  // The store keeps the last 100 messages of a session, so rows in the thousands come from many parts of few messages.
  const entries = windowedEntries(PROMPT)
  const harness = await mount({ handler: transcripts({ child: entries }), height: 40 })
  try {
    harness.events.emit(status("idle"))
    // At the end first: the transcript follows its tail, which holds the closing line.
    const tail = await harness.waitForFrame((value) => value.includes(DONE), "the closing line")
    expect(tail).not.toContain(TITLE)
    // Then to the top: the first row is the task block, and the prompt is not drawn a second time.
    harness.app.mockInput.pressKey("HOME")
    const head = await harness.waitForFrame((value) => value.includes(TITLE), "the task block")
    expect(count(head, FIRST_PROMPT_LINE)).toBe(1)
    expect(head).not.toContain(DONE)
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("in a windowed transcript the key opens the task block although it is not mounted, and it mounts open", async () => {
  const harness = await mount({ handler: transcripts({ child: windowedEntries(promptOf(20)) }), height: 40 })
  try {
    harness.events.emit(status("idle"))
    // At the end: the viewport follows the tail, and the task block, the first row, is far above it, unmounted.
    const tail = await harness.waitForFrame((value) => value.includes(DONE), "the closing line")
    expect(tail).not.toContain(TITLE)
    expect(mountedText(harness.app.renderer.root).join("\n")).not.toContain("prompt-line-01")

    pressExpand(harness)
    await harness.settle()
    // The flag pins the row: it is mounted, whole and open, wherever the viewport is, and the viewport stays put.
    const mounted = mountedText(harness.app.renderer.root).join("\n")
    expect(mounted).toContain("prompt-line-01")
    expect(mounted).toContain("prompt-line-20")
    expect(mounted).toContain(HINTS["zh-CN"].collapse)
    expect(await harness.frame()).toBe(tail)

    // At the top the reader finds it open.
    harness.app.mockInput.pressKey("HOME")
    const head = await harness.waitForFrame((value) => value.includes(TITLE), "the task block")
    expect(head).toContain("prompt-line-20")
    expect(head).toContain(HINTS["zh-CN"].collapse)
    expect(count(head, "prompt-line-01")).toBe(1)
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("in a windowed transcript a block that was closed is unmounted again, and what the key opened survives a scroll away", async () => {
  const harness = await mount({ handler: transcripts({ child: windowedEntries(promptOf(20)) }), height: 40 })
  try {
    harness.events.emit(status("idle"))
    await harness.waitForFrame((value) => value.includes(DONE), "the closing line")

    // Open it while it is unmounted, then leave it behind and come back: the state is the view's, not the row's.
    pressExpand(harness)
    await harness.settle()
    harness.app.mockInput.pressKey("HOME")
    await harness.waitForFrame((value) => value.includes("prompt-line-20"), "the open block")
    harness.app.mockInput.pressKey("END")
    await harness.waitForFrame((value) => value.includes(DONE), "the tail")
    expect(mountedText(harness.app.renderer.root).join("\n")).toContain("prompt-line-20")
    harness.app.mockInput.pressKey("HOME")
    await harness.waitForFrame((value) => value.includes(HINTS["zh-CN"].collapse), "the open block again")

    // Closed, and out of the window again: nothing keeps it mounted.
    pressExpand(harness)
    await harness.waitForFrame((value) => value.includes(HINTS["zh-CN"].expand), "the folded block")
    harness.app.mockInput.pressKey("END")
    await harness.waitForFrame((value) => value.includes(DONE), "the tail")
    expect(mountedText(harness.app.renderer.root).join("\n")).not.toContain("prompt-line-01")
  } finally {
    await harness.dispose()
  }
})

test("the task block and the closing line are static: they subscribe to neither the frame nor the second clock", async () => {
  const calls = { frame: 0, second: 0 }
  const ticker: Ticker = {
    frame: () => 0,
    second: () => 0,
    subscribe() {
      calls.frame++
      return () => {}
    },
    subscribeSecond() {
      calls.second++
      return () => {}
    },
    at: () => () => {},
    now: () => 0,
  }
  const harness = await mount({ ticker })
  try {
    harness.events.emit(status("idle"))
    const frame = await harness.waitForFrame((value) => value.includes(DONE), "the closing line")
    expect(frame).toContain(TITLE)
    await harness.settle()
    expect(calls).toEqual({ frame: 0, second: 0 })
  } finally {
    await harness.dispose()
  }
})
