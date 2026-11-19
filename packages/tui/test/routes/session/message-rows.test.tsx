// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import type { CapturedFrame, RGBA } from "@opentui/core"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import type { AssistantMessage, Part } from "@graphagent/sdk"
import { DEFAULT_THEME } from "../../../src/context/theme"
import { setLanguage } from "../../../src/i18n"
import { DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { cellWidth, type AmbiguousWidth } from "../../../src/ui/width"
import { assistantMessage, textPart, userMessage, type MessageEntry } from "../../fixture/session-records"
import { promptTop } from "../../fixture/run-app"
import { json } from "../../fixture/tui-sdk"
import { deltaEvent } from "../../perf/fixtures"
import { sessionFixture } from "../dag-mode-harness"
import { mountSessionShell } from "../session-shell"

/**
 * The messages of the main area as the prototype draws them (#1615 PR B): a user message is one line, a `›` in the
 * brand color and its words on a ground of its own, with what wraps hanging under the first word; the text of the
 * assistant stands behind a `⏺`; and a thought is one `∴` line, folded or open, told in the reader's language.
 */

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

const ROOT = "ses_rows_root"
const CHILD = "ses_rows_child"
const root = sessionFixture(ROOT, { title: "root", time: { created: 1, updated: 2 } })
const child = sessionFixture(CHILD, {
  parentID: ROOT,
  agent: "explore",
  title: "child",
  time: { created: 3, updated: 4 },
})

const palette = () => resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")

type Language = "en" | "zh-CN"

interface Options {
  language?: Language
  width?: number
  height?: number
  kv?: Record<string, unknown>
  sessionID?: string
}

async function mount(entries: MessageEntry[], options: Options = {}) {
  const sessionID = options.sessionID ?? ROOT
  const shell = await mountSessionShell({
    sessionID,
    sessions: [root, child],
    language: options.language ?? "en",
    width: options.width ?? 80,
    height: options.height ?? 30,
    kv: options.kv,
    handler: (url) => (url.pathname === `/session/${sessionID}/message` ? json(entries) : undefined),
  })
  return shell
}

type Shell = Awaited<ReturnType<typeof mount>>

const user = (id: string, created: number, parts: Part[], sessionID = ROOT): MessageEntry => ({
  info: userMessage(id, sessionID, created),
  parts,
})

const says = (text: string) => (frame: string) => frame.includes(text)

const answer = (id: string, parentID: string, created: number, parts: Part[], sessionID = ROOT): MessageEntry => ({
  info: assistantMessage(id, sessionID, parentID, created),
  parts,
})

const thought = (messageID: string, id: string, text: string, time: { start: number; end?: number }): Part => ({
  id,
  sessionID: ROOT,
  messageID,
  type: "reasoning",
  text,
  time,
})

/** One painted run of a row: where it starts, what it says, and in which colors. */
interface Run {
  row: number
  column: number
  text: string
  fg: RGBA
  bg: RGBA
}

function runsOf(frame: CapturedFrame): Run[] {
  const runs: Run[] = []
  frame.lines.forEach((line, row) => {
    let column = 0
    for (const span of line.spans) {
      runs.push({ row, column, text: span.text, fg: span.fg, bg: span.bg })
      column += cellWidth(span.text)
    }
  })
  return runs
}

const runsIn = async (shell: Shell) => runsOf(await shell.spans())

/** The first run that holds `text`. */
const find = (runs: Run[], text: string) => runs.find((run) => run.text.includes(text))

/**
 * The rows from `from` to `to` that have a run with the ground of a user message. The input box under the transcript has
 * the same ground, so a test names the rows of the transcript it looks at, a row of margin on each side included: a
 * row of padding that a message still owned would show there.
 */
const groundRows = (runs: Run[], from: number, to: number) => [
  ...new Set(
    runs
      .filter((run) => run.row >= from && run.row <= to && run.bg.equals(palette().backgroundUser))
      .map((run) => run.row),
  ),
]

/** The rows of a frame, without the blank ones at the end. */
const rowsOf = (frame: string) => frame.split("\n")

/** The column of the first character of `text` in the row of the frame that holds it. */
function columnOf(frame: string, text: string) {
  const row = rowsOf(frame).findIndex((line) => line.includes(text))
  if (row < 0) throw new Error(`"${text}" is not on screen:\n${frame}`)
  return { row, column: cellWidth(rowsOf(frame)[row].slice(0, rowsOf(frame)[row].indexOf(text))) }
}

const PROMPT = "Upgrade every dependency to the latest stable release."
const PROMPT_ZH = "把工具链和全部依赖升级到最新稳定版，修完破坏性变更、跑完 CI 再开 PR。"
const LONG_PROMPT =
  "Upgrade the toolchain first, then every dependency of the workspace one package at a time, fix whatever the " +
  "breaking changes break, run the whole of CI, and only then open the pull request for review by the team."

/** The `›` marks of the transcript: the input box below it opens with its own `›` (#1616), which is not a message. */
function marksAbovePrompt(frame: string) {
  const rows = frame.split("\n")
  const top = promptTop(rows)
  return (top < 0 ? rows : rows.slice(0, top)).join("\n").match(/›/g)?.length ?? 0
}

describe("a user message", () => {
  for (const language of ["en", "zh-CN"] as const) {
    const prompt = language === "en" ? PROMPT : PROMPT_ZH

    test(`is one line: a brand colored mark, its words, and a ground of its own across the transcript, in ${language}`, async () => {
      const shell = await mount([user("msg_one", 10, [textPart("msg_one", ROOT, "prt_one", prompt)])], { language })
      try {
        const frame = await shell.waitForFrame(says(prompt), "the message")
        const rows = rowsOf(frame)
        const row = rows.findIndex((line) => line.includes(prompt))
        // The mark, a space, the words: on one row, with nothing above or below that the message owns.
        expect(rows[row]).toContain(`› ${prompt}`)
        expect(rows[row]).not.toContain("┃")
        const runs = await runsIn(shell)
        expect(groundRows(runs, row - 2, row + 2)).toEqual([row])

        const mark = runs.find((run) => run.row === row && run.text === "›")!
        expect(mark.fg.equals(palette().primary)).toBe(true)
        expect(mark.bg.equals(palette().backgroundUser)).toBe(true)
        const words = find(runs, prompt)!
        expect(words.fg.equals(palette().text)).toBe(true)
        expect(words.bg.equals(palette().backgroundUser)).toBe(true)

        // The ground runs the width of the transcript, which is the terminal less the 2 cells of padding on each side.
        const ground = runs
          .filter((run) => run.row === row && run.bg.equals(palette().backgroundUser))
          .reduce((cells, run) => cells + cellWidth(run.text), 0)
        expect(ground).toBe(80 - 4)
        // The words are in the text color: no other run of the row is in the brand color.
        const brand = runs.filter(
          (run) => run.row === row && run.fg.equals(palette().primary) && run.text.trim() !== "",
        )
        expect(brand.map((run) => run.text)).toEqual(["›"])
        expect(shell.writes()).toEqual([])
      } finally {
        await shell.dispose()
      }
    })
  }

  test("is no taller than its words: the gap above it is one blank row, and nothing is added under it", async () => {
    const shell = await mount([
      user("msg_first", 10, [textPart("msg_first", ROOT, "prt_first", "first question")]),
      answer("msg_reply", "msg_first", 11, [textPart("msg_reply", ROOT, "prt_reply", "the answer")]),
      user("msg_second", 20, [textPart("msg_second", ROOT, "prt_second", "second question")]),
    ])
    try {
      const frame = await shell.waitForFrame(says("second question"), "the second message")
      const rows = rowsOf(frame)
      const first = rows.findIndex((line) => line.includes("first question"))
      const reply = rows.findIndex((line) => line.includes("the answer"))
      const second = rows.findIndex((line) => line.includes("second question"))
      // A blank row between blocks, and none inside them.
      expect(reply - first).toBe(2)
      expect(rows[first + 1].trim()).toBe("")
      expect(second).toBeGreaterThan(reply)
      expect(rows[second - 1].trim()).toBe("")
      // Each message owns exactly one row of the user ground.
      const runs = await runsIn(shell)
      expect(groundRows(runs, first - 2, second + 2)).toEqual([first, second])
    } finally {
      await shell.dispose()
    }
  })

  test("wraps with the words hanging under the first word, and the mark stands on the first row only", async () => {
    const shell = await mount([user("msg_long", 10, [textPart("msg_long", ROOT, "prt_long", LONG_PROMPT)])])
    try {
      const frame = await shell.waitForFrame(says("review by the team"), "the whole message")
      const rows = rowsOf(frame)
      const first = rows.findIndex((line) => line.includes("› Upgrade"))
      expect(first).toBeGreaterThanOrEqual(0)
      const start = columnOf(frame, "Upgrade").column
      // Three rows at 80 columns, each starting under the first word.
      const second = rows[first + 1]
      const third = rows[first + 2]
      expect(second.slice(0, start).trim()).toBe("")
      expect(second[start]).not.toBe(" ")
      expect(third.slice(0, start).trim()).toBe("")
      expect(third[start]).not.toBe(" ")
      expect(marksAbovePrompt(frame)).toBe(1)
      // The ground follows the words to the last row, and stops there.
      const runs = await runsIn(shell)
      expect(groundRows(runs, first - 2, first + 5)).toEqual([first, first + 1, first + 2])
      // What a row is cut to is the room the words have: the padding of 1 and the mark of 2 take 4 of the 4 + 76.
      for (const line of rows.slice(first, first + 3)) expect(cellWidth(line.trimEnd())).toBeLessThanOrEqual(80 - 2 - 1)
    } finally {
      await shell.dispose()
    }
  })

  test("keeps the lines the user wrote, each hanging under the first word", async () => {
    const shell = await mount([
      user("msg_lines", 10, [
        textPart("msg_lines", ROOT, "prt_lines", "first line\nsecond line\n\nafter a blank line"),
      ]),
    ])
    try {
      const frame = await shell.waitForFrame(says("after a blank line"), "the message")
      const start = columnOf(frame, "first line").column
      for (const line of ["second line", "after a blank line"]) expect(columnOf(frame, line).column).toBe(start)
      expect(marksAbovePrompt(frame)).toBe(1)
      const runs = await runsIn(shell)
      const first = columnOf(frame, "first line").row
      expect(groundRows(runs, first - 2, first + 6)).toEqual([first, first + 1, first + 2, first + 3])
    } finally {
      await shell.dispose()
    }
  })

  for (const language of ["en", "zh-CN"] as const) {
    const waiting = language === "en" ? "QUEUED" : "排队中"

    test(`that waits for the reply says so at the end of its line, and the time follows when timestamps are shown, in ${language}`, async () => {
      // The reply has no completion time, so it is the pending turn; the second prompt came after it and is not consumed.
      const pending: AssistantMessage = {
        ...assistantMessage("msg_pending", ROOT, "msg_waits_first", 20),
        time: { created: 20 },
        finish: undefined,
      }
      const shell = await mount(
        [
          user("msg_waits_first", 10, [textPart("msg_waits_first", ROOT, "prt_waits_first", "first prompt")]),
          { info: pending, parts: [] },
          user("msg_waits_second", 30, [textPart("msg_waits_second", ROOT, "prt_waits_second", "second prompt")]),
        ],
        { language, kv: { timestamps: "show" }, width: 100 },
      )
      try {
        const frame = await shell.waitForFrame(says(waiting), "the badge")
        const rows = rowsOf(frame)
        const second = rows.findIndex((line) => line.includes("second prompt"))
        // The words, the badge and the time are one line: the badge is after the words and the time after the badge.
        expect(rows[second].indexOf(waiting)).toBeGreaterThan(rows[second].indexOf("second prompt"))
        expect(rows[second]).toMatch(/\d{1,2}:\d{2}/)
        expect(rows[second].search(/\d{1,2}:\d{2}/)).toBeGreaterThan(rows[second].indexOf(waiting))
        expect(rows.filter((line) => line.includes(waiting))).toHaveLength(1)

        const runs = await runsIn(shell)
        const badge = runs.find((run) => run.row === second && run.text.includes(waiting))!
        expect(badge.fg.equals(palette().warning)).toBe(true)
        expect(badge.bg.equals(palette().backgroundUser)).toBe(true)
        // The time is dim: the first prompt, which does not wait, has only that after its words.
        const time = runs.find((run) => run.row === second && /\d{1,2}:\d{2}/.test(run.text))!
        expect(time.fg.equals(palette().textDim)).toBe(true)
        const firstRow = rows.findIndex((line) => line.includes("first prompt"))
        expect(rows[firstRow]).toMatch(/\d{1,2}:\d{2}/)
        expect(rows[firstRow]).not.toContain(waiting)
        const firstTime = runs.find((run) => run.row === firstRow && /\d{1,2}:\d{2}/.test(run.text))!
        expect(firstTime.fg.equals(palette().textDim)).toBe(true)
        // Still one row of ground each, and nothing else on the row is in the brand color but the mark.
        expect(groundRows(runs, firstRow - 2, second + 2)).toEqual([firstRow, second])
        expect(shell.writes()).toEqual([])
      } finally {
        await shell.dispose()
      }
    })
  }

  test("shows no time while timestamps are hidden, and no badge on a message that does not wait", async () => {
    const shell = await mount([user("msg_plain", 10, [textPart("msg_plain", ROOT, "prt_plain", "plain prompt")])])
    try {
      const frame = await shell.waitForFrame(says("plain prompt"), "the message")
      const row = rowsOf(frame).find((line) => line.includes("plain prompt"))!
      expect(row).not.toMatch(/\d{1,2}:\d{2}/)
      expect(row).not.toContain("QUEUED")
    } finally {
      await shell.dispose()
    }
  })

  for (const language of ["en", "zh-CN"] as const) {
    const labels = language === "en" ? { file: "File", directory: "Directory" } : { file: "文件", directory: "目录" }

    test(`labels what it attached on the line under its words, inside the same block, in ${language}`, async () => {
      const shell = await mount(
        [
          user("msg_files", 10, [
            textPart("msg_files", ROOT, "prt_files_words", "look at these"),
            {
              id: "prt_files_a",
              sessionID: ROOT,
              messageID: "msg_files",
              type: "file",
              mime: "text/plain",
              filename: "a.ts",
              url: "file:///repo/a.ts",
            },
            {
              id: "prt_files_dir",
              sessionID: ROOT,
              messageID: "msg_files",
              type: "file",
              mime: "application/x-directory",
              filename: "src",
              url: "file:///repo/src",
            },
          ]),
        ],
        { language },
      )
      try {
        const frame = await shell.waitForFrame(says(labels.file), "the labels")
        const words = columnOf(frame, "look at these")
        const tag = columnOf(frame, labels.file)
        // The next row, under the first word.
        expect(tag.row).toBe(words.row + 1)
        expect(tag.column).toBeGreaterThanOrEqual(words.column)
        expect(rowsOf(frame)[tag.row]).toContain("a.ts")
        expect(rowsOf(frame)[tag.row]).toContain(labels.directory)
        expect(rowsOf(frame)[tag.row]).toContain("src")

        const runs = await runsIn(shell)
        // One block of ground over both rows, and no other row of it.
        expect(groundRows(runs, words.row - 2, tag.row + 2)).toEqual([words.row, tag.row])
        const name = find(
          runs.filter((run) => run.row === tag.row),
          "a.ts",
        )!
        expect(name.fg.equals(palette().textMuted)).toBe(true)
        expect(name.bg.equals(palette().backgroundUser)).toBe(true)
      } finally {
        await shell.dispose()
      }
    })
  }

  test("paints its own ground when the mouse is over it, and puts it back when the mouse leaves", async () => {
    const shell = await mount([
      user("msg_hover", 10, [textPart("msg_hover", ROOT, "prt_hover", "hover prompt")]),
      answer("msg_hover_reply", "msg_hover", 11, [textPart("msg_hover_reply", ROOT, "prt_hover_reply", "an answer")]),
    ])
    try {
      const frame = await shell.waitForFrame(says("an answer"), "the transcript")
      const at = columnOf(frame, "hover prompt")
      await shell.app.mockMouse.moveTo(at.column + 2, at.row)
      await shell.settle()
      let runs = await runsIn(shell)
      const row = runs.filter((run) => run.row === at.row && run.text.trim() !== "")
      // The block is painted in the hover ground, which is not the ground of an idle message nor the transcript's own.
      expect(row.every((run) => run.bg.equals(palette().border))).toBe(true)
      expect(palette().border.equals(palette().backgroundUser)).toBe(false)
      // Nothing else answered the mouse.
      expect(runs.filter((run) => run.row !== at.row && run.bg.equals(palette().border))).toEqual([])
      expect(shell.writes()).toEqual([])

      await shell.app.mockMouse.moveTo(0, 0)
      await shell.settle()
      runs = await runsIn(shell)
      expect(find(runs, "hover prompt")!.bg.equals(palette().backgroundUser)).toBe(true)
    } finally {
      await shell.dispose()
    }
  })

  test("in a sub-agent view is not clickable and does not answer the mouse", async () => {
    const shell = await mount(
      [
        user("msg_task", 10, [textPart("msg_task", CHILD, "prt_task", "the task the parent delegated")], CHILD),
        answer(
          "msg_child_reply",
          "msg_task",
          11,
          [textPart("msg_child_reply", CHILD, "prt_child_reply", "done")],
          CHILD,
        ),
        user("msg_follow", 20, [textPart("msg_follow", CHILD, "prt_follow", "a follow-up of the parent")], CHILD),
      ],
      { sessionID: CHILD },
    )
    try {
      const frame = await shell.waitForFrame(says("a follow-up of the parent"), "the follow-up")
      const at = columnOf(frame, "a follow-up of the parent")
      await shell.app.mockMouse.moveTo(at.column + 2, at.row)
      await shell.settle()
      let runs = await runsIn(shell)
      // The block keeps its ground under the mouse, and a click on it opens nothing and writes nothing.
      expect(find(runs, "a follow-up of the parent")!.bg.equals(palette().backgroundUser)).toBe(true)
      expect(runs.some((run) => run.bg.equals(palette().border))).toBe(false)
      await shell.app.mockMouse.click(at.column + 2, at.row)
      await shell.settle()
      runs = await runsIn(shell)
      expect(find(runs, "a follow-up of the parent")!.bg.equals(palette().backgroundUser)).toBe(true)
      expect(shell.bottomZone().host.depth()).toBe(0)
      expect(shell.writes()).toEqual([])
      // It is still the user's message, `›` and all.
      expect(rowsOf(await shell.frame())[at.row]).toContain("› a follow-up of the parent")
    } finally {
      await shell.dispose()
    }
  })

  test("in the main session opens its actions when clicked", async () => {
    const shell = await mount([user("msg_click", 10, [textPart("msg_click", ROOT, "prt_click", "click prompt")])])
    try {
      const frame = await shell.waitForFrame(says("click prompt"), "the message")
      const at = columnOf(frame, "click prompt")
      await shell.app.mockMouse.click(at.column + 2, at.row)
      await shell.settle()
      expect(shell.bottomZone().host.depth()).toBe(1)
    } finally {
      await shell.dispose()
    }
  })
})

describe("the text of the assistant", () => {
  for (const language of ["en", "zh-CN"] as const) {
    const body =
      language === "en" ? "I listed the outdated dependencies first." : "先列出过期依赖，再按 workspace 分批升级。"

    test(`stands behind a ⏺ in the success color, in ${language}`, async () => {
      const shell = await mount(
        [
          user("msg_q", 10, [textPart("msg_q", ROOT, "prt_q", "question")]),
          answer("msg_a", "msg_q", 11, [textPart("msg_a", ROOT, "prt_a", body)]),
        ],
        { language },
      )
      try {
        const frame = await shell.waitForFrame(says(body), "the answer")
        const rows = rowsOf(frame)
        const row = rows.findIndex((line) => line.includes(body))
        expect(rows[row]).toContain(`⏺ ${body}`)
        const runs = await runsIn(shell)
        const mark = runs.find((run) => run.row === row && run.text === "⏺")!
        expect(mark.fg.equals(palette().success)).toBe(true)
        expect(find(runs, body)!.fg.equals(palette().markdownText)).toBe(true)
        // It is not the brand color, and the gap above it is a blank row.
        expect(runs.some((run) => run.row === row && run.fg.equals(palette().primary) && run.text.trim() !== "")).toBe(
          false,
        )
        expect(rows[row - 1].trim()).toBe("")
        // The `⏺` of the answer stands at the column of the dots of the tool rows, behind the indent of 3 and the route's 2.
        expect(rows[row].indexOf("⏺")).toBe(5)
      } finally {
        await shell.dispose()
      }
    })
  }

  test("wraps with the words hanging under the first word, and has one ⏺ for each part", async () => {
    const shell = await mount([
      user("msg_q", 10, [textPart("msg_q", ROOT, "prt_q", "question")]),
      answer("msg_a", "msg_q", 11, [
        textPart("msg_a", ROOT, "prt_a1", LONG_PROMPT),
        textPart("msg_a", ROOT, "prt_a2", "A second part of the same message."),
      ]),
    ])
    try {
      const frame = await shell.waitForFrame(says("A second part"), "the answer")
      const rows = rowsOf(frame)
      const first = rows.findIndex((line) => line.includes("⏺ Upgrade"))
      const last = rows.findIndex((line) => line.includes("team."))
      const start = columnOf(frame, "Upgrade").column
      expect(first).toBeGreaterThanOrEqual(0)
      // The text wraps over several rows, each of the rows after the first under the first word and with no mark.
      expect(last - first).toBeGreaterThanOrEqual(2)
      for (let row = first + 1; row <= last; row++) {
        expect(rows[row].slice(0, start).trim()).toBe("")
        expect(rows[row][start]).not.toBe(" ")
        expect(rows[row]).not.toContain("⏺")
      }
      // One mark for each part: the first, and the second after a blank row.
      expect(frame.match(/⏺/g)).toHaveLength(2)
      expect(columnOf(frame, "A second part").row).toBe(last + 2)
      expect(rows[last + 1].trim()).toBe("")
      expect(rows[last + 2]).toContain("⏺ A second part")
      for (const line of rows.slice(first, last + 1)) expect(cellWidth(line.trimEnd())).toBeLessThanOrEqual(80 - 2)
    } finally {
      await shell.dispose()
    }
  })

  test("has its ⏺ as soon as the first words come, while the text is still being written", async () => {
    const writing: Part = {
      id: "prt_stream",
      sessionID: ROOT,
      messageID: "msg_stream",
      type: "text",
      text: "",
      time: { start: 1 },
    }
    const message: AssistantMessage = {
      ...assistantMessage("msg_stream", ROOT, "msg_q", 11),
      finish: undefined,
      time: { created: 11 },
    }
    const shell = await mount([
      user("msg_q", 10, [textPart("msg_q", ROOT, "prt_q", "question")]),
      { info: message, parts: [writing] },
    ])
    try {
      await shell.waitForFrame(says("question"), "the question")
      // Nothing to show yet: no row, so no mark.
      expect(await shell.frame()).not.toContain("⏺")

      shell.deliver(deltaEvent(writing, "Hel", "evt_stream_1"))
      const first = await shell.waitForFrame(says("⏺ Hel"), "the first words")
      expect(first.match(/⏺/g)).toHaveLength(1)

      shell.deliver(deltaEvent(writing, "lo, and more", "evt_stream_2"))
      const second = await shell.waitForFrame(says("⏺ Hello, and more"), "the words that followed")
      // The same part, still being written: one mark, and the text did not end.
      expect(second.match(/⏺/g)).toHaveLength(1)
      const runs = await runsIn(shell)
      expect(runs.find((run) => run.text === "⏺")!.fg.equals(palette().success)).toBe(true)
    } finally {
      await shell.dispose()
    }
  })
})

describe("a thought", () => {
  const TITLED = "**Planning the change**\n\nFirst I look at the files, then I do the work."
  const PLAIN = "Second thought, without a title."

  const THOUGHTS = {
    en: {
      folded: "Thought for 12s · collapsed",
      titled: "Planning the change · Thought for 12s · collapsed",
      long: "Thought for 1m 12s · collapsed",
      open: "Thought for 12s",
      openTitled: "Planning the change · Thought for 12s",
      thinking: "Thinking…",
      thinkingTitled: "Thinking: Planning the change",
    },
    "zh-CN": {
      folded: "思考了 12 秒 · 已折叠",
      titled: "Planning the change · 思考了 12 秒 · 已折叠",
      long: "思考了 1 分 12 秒 · 已折叠",
      open: "思考了 12 秒",
      openTitled: "Planning the change · 思考了 12 秒",
      thinking: "思考中…",
      thinkingTitled: "思考中：Planning the change",
    },
  } as const

  const withThoughts = (parts: Part[]) => [
    user("msg_q", 10, [textPart("msg_q", ROOT, "prt_q", "question")]),
    answer("msg_a", "msg_q", 11, parts),
  ]

  for (const language of ["en", "zh-CN"] as const) {
    const words = THOUGHTS[language]

    test(`is one dim line that says how long it took and that it is folded, in ${language}`, async () => {
      const shell = await mount(
        withThoughts([
          thought("msg_a", "prt_plain", PLAIN, { start: 1_000, end: 13_000 }),
          thought("msg_a", "prt_long", PLAIN + " more", { start: 1_000, end: 73_000 }),
        ]),
        { language },
      )
      try {
        const frame = await shell.waitForFrame(says(words.long), "the thoughts")
        const rows = rowsOf(frame)
        expect(rows.some((line) => line.includes(`∴ ${words.folded}`))).toBe(true)
        expect(rows.some((line) => line.includes(`∴ ${words.long}`))).toBe(true)
        // The text of the thought is not shown while it is folded.
        expect(frame).not.toContain(PLAIN)
        // The mark and the words are in the dim color, the line is one row, and it is the transcript's indent.
        const runs = await runsIn(shell)
        for (const text of ["∴", words.folded, words.long]) {
          const run = find(runs, text)!
          expect(run.fg.equals(palette().textDim)).toBe(true)
        }
        expect(rows.find((line) => line.includes("∴"))!.indexOf("∴")).toBe(5)
        expect(shell.writes()).toEqual([])
      } finally {
        await shell.dispose()
      }
    })

    test(`with a title says the title first, in ${language}`, async () => {
      const shell = await mount(withThoughts([thought("msg_a", "prt_titled", TITLED, { start: 1_000, end: 13_000 })]), {
        language,
      })
      try {
        const frame = await shell.waitForFrame(says(words.titled), "the titled thought")
        expect(frame).toContain(`∴ ${words.titled}`)
        // The title is the header; the body under it stays folded.
        expect(frame).not.toContain("First I look at the files")
        expect(find(await runsIn(shell), words.titled)!.fg.equals(palette().textDim)).toBe(true)
      } finally {
        await shell.dispose()
      }
    })

    test(`opens on a click to its header and the words of the thought, and closes on the next, in ${language}`, async () => {
      const shell = await mount(withThoughts([thought("msg_a", "prt_titled", TITLED, { start: 1_000, end: 13_000 })]), {
        language,
      })
      try {
        const folded = await shell.waitForFrame(says(words.titled), "the folded thought")
        const header = columnOf(folded, "∴")
        const counts = shell.writes().length
        await shell.app.mockMouse.click(header.column + 6, header.row)
        const open = await shell.waitForFrame(says("First I look at the files"), "the opened thought")
        const rows = rowsOf(open)
        const head = rows.findIndex((line) => line.includes(`∴ ${words.openTitled}`))
        expect(head).toBe(header.row)
        expect(open).not.toContain("已折叠")
        expect(open).not.toContain("collapsed")
        // The body stands under the words of the header, behind the mark, after a blank row.
        const body = columnOf(open, "First I look at the files")
        expect(body.row).toBe(head + 2)
        expect(body.column).toBe(columnOf(open, words.openTitled).column)

        // The header keeps the warning color it had, at the opacity of a thought; the body is muted.
        const runs = await runsIn(shell)
        const mark = runs.find((run) => run.row === head && run.text === "∴")!
        const warning = palette().warning
        const background = palette().background
        const [r, g, b] = mark.fg.toInts()
        const blend = (above: number, below: number) =>
          Math.round(above * palette().thinkingOpacity + below * (1 - palette().thinkingOpacity))
        // The renderer paints the translucent color over the ground it stands on: within one step per channel of that blend.
        expect(Math.abs(r - blend(warning.toInts()[0], background.toInts()[0]))).toBeLessThanOrEqual(1)
        expect(Math.abs(g - blend(warning.toInts()[1], background.toInts()[1]))).toBeLessThanOrEqual(1)
        expect(Math.abs(b - blend(warning.toInts()[2], background.toInts()[2]))).toBeLessThanOrEqual(1)
        expect(find(runs, words.openTitled)!.fg.equals(mark.fg)).toBe(true)
        expect(find(runs, "First I look at the files")!.fg.equals(palette().textMuted)).toBe(false)
        expect(shell.writes().length).toBe(counts)

        await shell.app.mockMouse.click(header.column + 6, header.row)
        const closed = await shell.waitForFrame(says(words.titled), "the folded thought again")
        expect(closed).not.toContain("First I look at the files")
        expect(shell.writes().length).toBe(counts)
      } finally {
        await shell.dispose()
      }
    })

    test(`is open from the start, with the header and no word about folding, while thinking is shown, in ${language}`, async () => {
      const shell = await mount(withThoughts([thought("msg_a", "prt_shown", PLAIN, { start: 1_000, end: 13_000 })]), {
        language,
        kv: { thinking_mode: "show" },
      })
      try {
        const frame = await shell.waitForFrame(says(PLAIN), "the shown thought")
        const rows = rowsOf(frame)
        const head = rows.findIndex((line) => line.includes(`∴ ${words.open}`))
        expect(head).toBeGreaterThanOrEqual(0)
        expect(rows[head]).not.toContain("已折叠")
        expect(rows[head]).not.toContain("collapsed")
        expect(columnOf(frame, PLAIN).column).toBe(columnOf(frame, words.open).column)
      } finally {
        await shell.dispose()
      }
    })

    test(`that is still being written says it is thinking, with its title when it has one, in ${language}`, async () => {
      const shell = await mount(
        withThoughts([
          thought("msg_a", "prt_doing", "**Planning the change**\n\nStill going", { start: 1_000 }),
          thought("msg_a", "prt_doing_plain", "Going on without a title", { start: 1_000 }),
        ]),
        { language },
      )
      try {
        const frame = await shell.waitForFrame(says(words.thinkingTitled), "the thought in progress")
        expect(frame).toContain(words.thinking)
        // A spinner stands for the mark, and nothing says how long it took, or that it is folded.
        expect(frame).not.toContain("∴")
        expect(frame).not.toContain("已折叠")
        expect(frame).not.toContain("collapsed")
        const row = rowsOf(frame).find((line) => line.includes(words.thinkingTitled))!
        expect(row).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⋯] /)
      } finally {
        await shell.dispose()
      }
    })
  }

  for (const width of [80, 120] as const) {
    for (const aw of [1, 2] as const satisfies readonly AmbiguousWidth[]) {
      for (const language of ["en", "zh-CN"] as const) {
        test(`is cut to the room the row has, at ${width} columns and ambiguous width ${aw}, in ${language}`, async () => {
          const title =
            "Checking every dependency of the workspace against the release notes of its latest version 一直写下去"
          const text = `**${title}**\n\nand the body of it`
          const shell = await mount(withThoughts([thought("msg_a", "prt_wide", text, { start: 1_000, end: 13_000 })]), {
            language,
            width,
            kv: { ambiguous_width: aw },
          })
          try {
            const tail = THOUGHTS[language].folded
            const frame = await shell.waitForFrame(says(tail), "the cut line")
            const row = rowsOf(frame).find((line) => line.includes("∴"))!
            // After the mark and the cell next to it: the words of the line.
            const words = row.slice(row.indexOf("∴") + 2).trimEnd()
            // The row has the transcript (the terminal less 4), the indent of 3 and the mark of 2.
            const room = width - 4 - 3 - 2
            expect(cellWidth(words, aw)).toBeLessThanOrEqual(room)
            // The title gave way, and what says how long it took and that it is folded did not.
            expect(words).toContain("…")
            expect(words.endsWith(tail)).toBe(true)
            expect(words).not.toContain("the body of it")
          } finally {
            await shell.dispose()
          }
        })
      }
    }
  }
})

describe("the messages of the main area", () => {
  for (const width of [80, 120] as const) {
    for (const aw of [1, 2] as const satisfies readonly AmbiguousWidth[]) {
      for (const language of ["en", "zh-CN"] as const) {
        test(`keep every row inside the transcript at ${width} columns and ambiguous width ${aw}, in ${language}`, async () => {
          const shell = await mount(
            [
              user("msg_q", 10, [
                textPart("msg_q", ROOT, "prt_q", LONG_PROMPT + " " + PROMPT_ZH.repeat(3)),
                {
                  id: "prt_f",
                  sessionID: ROOT,
                  messageID: "msg_q",
                  type: "file",
                  mime: "text/plain",
                  filename: "a-rather-long-file-name.ts",
                  url: "file:///repo/a-rather-long-file-name.ts",
                },
              ]),
              answer("msg_a", "msg_q", 11, [
                thought("msg_a", "prt_t", "**A title**\n\nbody", { start: 1_000, end: 13_000 }),
                textPart("msg_a", ROOT, "prt_a", LONG_PROMPT + " " + PROMPT_ZH.repeat(3)),
              ]),
            ],
            { width, height: 40, language, kv: { ambiguous_width: aw } },
          )
          try {
            const frame = await shell.waitForFrame(says("⏺ Upgrade"), "the messages")
            const rows = rowsOf(frame)
            const last = rows.findLastIndex((line) => line.includes("再开 PR"))
            expect(last).toBeGreaterThan(0)
            // Every row of the messages, from the first to the last of the answer, ends inside the transcript, which
            // keeps 2 cells of the terminal at each side.
            for (const line of rows.slice(1, last + 1)) expect(cellWidth(line.trimEnd())).toBeLessThanOrEqual(width - 2)
            expect(frame).toContain("› Upgrade")
            // The thought is one row and it is the whole of it: cut to the room it has, and not wrapped.
            const thoughts = rows.filter((line) => line.includes("∴"))
            expect(thoughts).toHaveLength(1)
            const words = thoughts[0].slice(thoughts[0].indexOf("∴") + 2).trimEnd()
            expect(cellWidth(words, aw)).toBeLessThanOrEqual(width - 4 - 3 - 2)
          } finally {
            await shell.dispose()
          }
        })
      }
    }
  }
})
