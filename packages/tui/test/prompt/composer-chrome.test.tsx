// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { TextareaRenderable, type CapturedFrame, type Renderable } from "@opentui/core"
import { Prompt } from "../../src/component/prompt"
import { DEFAULT_THEME } from "../../src/context/theme"
import { setLanguage } from "../../src/i18n"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import { cellWidth } from "../../src/ui/width"
import { AppRoutes } from "../fixture/route-frame"
import { promptTop } from "../fixture/run-app"
import { mountRoute, sessionFixture, waitFor, type MountOptions } from "../routes/dag-mode-harness"

/**
 * #1616: the input box is one rounded frame with the prompt mark `›` in its own column and the textarea beside it.
 * These tests mount the real home and session routes in the app frame, the way `app.tsx` does, and read what is
 * drawn: the frame's rows and the colors of its cells. The last group holds the risk the mark brings: it is not part
 * of the textarea, so the text, the draft and the cursor sit where the layout says (border 1, padding 1, mark and
 * space 2), whatever is typed.
 */

const sessionID = "ses_chrome"

// 60 columns is the narrowest the frame draws a screen at: the longest placeholder (English) has to stay on one row.
const SIZES = [
  { width: 60, height: 14 },
  { width: 80, height: 24 },
  { width: 120, height: 40 },
] as const
const LANGUAGES = ["zh-CN", "en"] as const
type Language = (typeof LANGUAGES)[number]

// The original texts, not `t()`: a changed placeholder has to change this file too.
const PLACEHOLDER: Record<Language, string> = {
  "zh-CN": "输入消息；/ 打开命令，@ 引用文件",
  en: "Message · / for commands · @ to reference files",
}
const SHELL_PLACEHOLDER: Record<Language, string> = {
  "zh-CN": "输入要运行的命令",
  en: "Command to run",
}

const theme = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")

/** Columns from the frame's left border to the first cell of the text: border 1, padding 1, the mark and a space 2. */
const TEXT_OFFSET = 4

afterEach(() => {
  setLanguage("zh-CN")
})

type Harness = Awaited<ReturnType<typeof mountApp>>

function mountApp(route: MountOptions["route"], extra: Partial<MountOptions> = {}) {
  return mountRoute({
    route,
    view: () => <AppRoutes />,
    frame: true,
    sessions: [sessionFixture(sessionID)],
    withAgentAndModel: true,
    ...extra,
  })
}

function collect(root: Renderable, result: Renderable[] = []) {
  result.push(root)
  for (const child of root.getChildren()) collect(child, result)
  return result
}

function textareaOf(harness: Harness) {
  const found = collect(harness.app.renderer.root).filter(
    (item): item is TextareaRenderable => item instanceof TextareaRenderable,
  )
  expect(found).toHaveLength(1)
  return found[0]
}

function rowsOf(frame: string) {
  return frame.split("\n").map((line) => line.trimEnd())
}

/** The input box in a frame: the rows of its edges and the column of its left border. */
function boxOf(frame: string) {
  const rows = rowsOf(frame)
  const top = promptTop(rows)
  if (top < 0) throw new Error(`no input box in the frame:\n${frame}`)
  return {
    rows,
    top,
    bottom: rows.findLastIndex((row) => row.trimStart().startsWith("╰")),
    left: rows[top].indexOf("╭"),
  }
}

/** The painted spans of one row, in order. */
function spansOf(frame: CapturedFrame, row: number) {
  return frame.lines[row].spans
}

/** The first span of `row` that contains `text`. */
function spanWith(frame: CapturedFrame, row: number, text: string) {
  const found = spansOf(frame, row).find((span) => span.text.includes(text))
  if (!found) throw new Error(`"${text}" is not painted on row ${row}`)
  return found
}

/** The visible text after the mark on the input row, with the colors of every non-blank span of it. */
function inputText(frame: CapturedFrame, row: number) {
  const spans = spansOf(frame, row)
  const mark = spans.findIndex((span) => /^[›$]$/.test(span.text.trim()))
  const rest = spans.slice(mark + 1).filter((span) => span.text.trim() !== "" && span.text.trim() !== "│")
  const text = rest.map((span) => span.text).join("")
  return { text: text.trim(), spans: rest }
}

/** How many prompt marks the rows hold. */
function marksIn(rows: readonly string[]) {
  return rows.join("\n").split("›").length - 1
}

for (const size of SIZES) {
  for (const language of LANGUAGES) {
    for (const route of ["home", "session"] as const) {
      test(`draws a one-row rounded frame with the prompt mark and the placeholder (${route}, ${language}, ${size.width}x${size.height})`, async () => {
        const harness = await mountApp(route === "home" ? { type: "home" } : { type: "session", sessionID }, {
          ...size,
          language,
        })
        try {
          await harness.settle()
          const text = await harness.frame()
          const { rows, top, bottom, left } = boxOf(text)

          // The edges are the rounded corners, the input row is `│ ›`, and an idle box is three rows tall.
          expect(rows[top].trimStart().startsWith("╭")).toBe(true)
          expect(rows[top].includes("╮")).toBe(true)
          expect(rows[top + 1].trimStart().startsWith("│ ›")).toBe(true)
          expect(rows[top + 2].trimStart().startsWith("╰")).toBe(true)
          expect(rows[top + 2].includes("╯")).toBe(true)
          expect(bottom).toBe(top + 2)
          expect(textareaOf(harness).height).toBe(1)
          expect(rows.filter((row) => row.trimStart().startsWith("╭"))).toHaveLength(1)

          // None of the old block is left, and the line of agent and model that sat in it is not drawn.
          expect(text).not.toContain("┃")
          expect(text).not.toContain("╹▀")
          expect(text).not.toContain("Build · ")
          expect(rows.slice(top, top + 3).join("\n")).not.toContain("Test model")

          // An empty input shows the placeholder as written.
          expect(rows[top + 1]).toContain(PLACEHOLDER[language])
          expect(harness.promptDraft()).toBe("")

          // The three edges span the same columns: the home box is capped at `prompt.max_width` (75) and centered, the
          // session box takes the width the route gives it.
          const width = rows[top].trimEnd().length - left
          expect(rows[top + 2].trimEnd().length - rows[top + 2].indexOf("╰")).toBe(width)
          if (route === "home") {
            // The cap is 75; a screen too narrow for it gives the box what the route's padding leaves.
            expect(width).toBe(Math.min(75, size.width - 4))
            expect(Math.abs(left - (size.width - width) / 2)).toBeLessThanOrEqual(1)
          } else {
            expect(left).toBe(2)
            expect(width).toBe(size.width - 4)
          }
          expect(harness.writes()).toEqual([])
        } finally {
          await harness.dispose()
        }
      })
    }
  }
}

test("paints the mark in the brand color, the placeholder in the dim text color and the border by focus", async () => {
  const harness = await mountApp({ type: "session", sessionID })
  try {
    await harness.settle()
    const area = textareaOf(harness)
    expect(area.focused).toBe(true)

    const read = async () => {
      const frame = await harness.spans()
      const { top } = boxOf(await harness.frame())
      return { frame, top }
    }

    // Focused: the border is lit.
    let { frame, top } = await read()
    expect(spanWith(frame, top, "╭").fg.equals(theme.textDim)).toBe(true)
    expect(spanWith(frame, top + 1, "│").fg.equals(theme.textDim)).toBe(true)
    expect(spanWith(frame, top + 2, "╰").fg.equals(theme.textDim)).toBe(true)
    expect(spanWith(frame, top + 1, "›").fg.equals(theme.primary)).toBe(true)
    const placeholder = inputText(frame, top + 1)
    expect(placeholder.text).toBe(PLACEHOLDER["zh-CN"])
    for (const span of placeholder.spans) expect(span.fg.equals(theme.textDim)).toBe(true)

    // Blurred: the border goes back to the plain border color; the mark and the placeholder do not move.
    area.blur()
    await harness.settle()
    ;({ frame, top } = await read())
    expect(spanWith(frame, top, "╭").fg.equals(theme.border)).toBe(true)
    expect(spanWith(frame, top + 1, "│").fg.equals(theme.border)).toBe(true)
    expect(spanWith(frame, top + 2, "╰").fg.equals(theme.border)).toBe(true)
    expect(spanWith(frame, top + 1, "›").fg.equals(theme.primary)).toBe(true)
    for (const span of inputText(frame, top + 1).spans) expect(span.fg.equals(theme.textDim)).toBe(true)

    // And lit again when the textarea takes the focus back.
    area.focus()
    await harness.settle()
    ;({ frame, top } = await read())
    expect(spanWith(frame, top, "╭").fg.equals(theme.textDim)).toBe(true)
    expect(spanWith(frame, top + 2, "╰").fg.equals(theme.textDim)).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test("follows the interface language when it changes while the box is on screen", async () => {
  const harness = await mountApp({ type: "home" }, { language: "zh-CN" })
  try {
    await harness.settle()
    expect(await harness.frame()).toContain(PLACEHOLDER["zh-CN"])
    setLanguage("en")
    await harness.settle()
    const frame = await harness.frame()
    expect(frame).toContain(PLACEHOLDER.en)
    expect(frame).not.toContain(PLACEHOLDER["zh-CN"])
  } finally {
    await harness.dispose()
  }
})

test("draws no placeholder when the caller turns it off, and keeps the mark", async () => {
  const harness = await mountRoute({
    route: { type: "home" },
    view: () => <Prompt showPlaceholder={false} />,
    language: "en",
    withAgentAndModel: true,
  })
  try {
    await harness.settle()
    const frame = await harness.frame()
    expect(frame).not.toContain(PLACEHOLDER.en)
    expect(frame).toContain("│ ›")
  } finally {
    await harness.dispose()
  }
})

test("paints what is typed in the text color, not the placeholder color", async () => {
  const harness = await mountApp({ type: "home" })
  try {
    await harness.settle()
    await harness.app.mockInput.typeText("hello")
    await harness.settle()
    const { top } = boxOf(await harness.frame())
    const typed = inputText(await harness.spans(), top + 1)
    expect(typed.text).toBe("hello")
    for (const span of typed.spans) expect(span.fg.equals(theme.text)).toBe(true)
  } finally {
    await harness.dispose()
  }
})

for (const language of LANGUAGES) {
  test(`shell mode swaps the mark for $ and the placeholder for the command one, and esc brings both back (${language})`, async () => {
    const harness = await mountApp({ type: "session", sessionID }, { language })
    try {
      await harness.settle()
      const area = textareaOf(harness)
      const read = async () => {
        const text = await harness.frame()
        const { rows, top } = boxOf(text)
        return { row: rows[top + 1], frame: await harness.spans(), top }
      }

      let state = await read()
      expect(state.row).toContain(`│ › ${PLACEHOLDER[language]}`)

      // `!` at the start of an empty input enters shell mode and is not typed into the draft.
      harness.app.mockInput.pressKey("!")
      await harness.settle()
      state = await read()
      expect(state.row).toContain(`│ $ ${SHELL_PLACEHOLDER[language]}`)
      expect(state.row).not.toContain("›")
      expect(spanWith(state.frame, state.top + 1, "$").fg.equals(theme.primary)).toBe(true)
      for (const span of inputText(state.frame, state.top + 1).spans) expect(span.fg.equals(theme.textDim)).toBe(true)
      expect(harness.promptDraft()).toBe("")
      expect(area.focused).toBe(true)

      // What is typed in shell mode starts where it does in the normal mode.
      await harness.app.mockInput.typeText("ls")
      await harness.settle()
      state = await read()
      expect(state.row).toContain("│ $ ls")
      expect(harness.promptDraft()).toBe("ls")
      expect(area.visualCursor.offset).toBe(2)

      // Esc leaves the mode and keeps the text; an empty input is back to the normal placeholder.
      harness.app.mockInput.pressEscape()
      await harness.settle()
      state = await read()
      expect(state.row).toContain("│ › ls")
      expect(harness.promptDraft()).toBe("ls")
      area.setText("")
      await harness.settle()
      state = await read()
      expect(state.row).toContain(`│ › ${PLACEHOLDER[language]}`)
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })
}

test("the editing line is drawn inside the frame, above the first input row", async () => {
  const harness = await mountApp({ type: "session", sessionID }, { language: "en" })
  try {
    await harness.settle()
    for (const key of "/rename") harness.app.mockInput.pressKey(key)
    await harness.app.renderOnce()
    harness.app.mockInput.pressEnter()
    const text = await harness.waitForFrame((frame) => frame.includes("Editing: Rename"), "the editing line")
    const rows = rowsOf(text)
    const editing = rows.findIndex((row) => row.includes("Editing: Rename"))
    // The edge, the editing line, then the input row with the mark: one frame around both.
    expect(rows[editing - 1].trimStart().startsWith("╭")).toBe(true)
    expect(rows[editing].trimStart().startsWith("│ Editing: Rename")).toBe(true)
    expect(rows[editing + 1].trimStart().startsWith("│ ›")).toBe(true)
    expect(rows[editing + 2].trimStart().startsWith("╰")).toBe(true)
    expect(marksIn(rows.slice(editing - 1, editing + 3))).toBe(1)
  } finally {
    await harness.dispose()
  }
})

// The cursor and the text stay where the layout puts them: the mark is a column of its own, not a character of the
// input, so nothing typed or pasted can move them.

/** Cell columns between the frame's left border and the cursor the renderer draws (its coordinates start at 1). */
function cursorColumn(harness: Harness, left: number) {
  return harness.app.renderer.getCursorState().x - 1 - left
}

for (const route of ["home", "session"] as const) {
  test(`keeps the text at the fifth column of the frame and the cursor at its end whatever is typed (${route})`, async () => {
    const harness = await mountApp(route === "home" ? { type: "home" } : { type: "session", sessionID })
    try {
      await harness.settle()
      const area = textareaOf(harness)
      const left = boxOf(await harness.frame()).left

      // The textarea starts four columns right of the left border, empty or not, and the cursor is on its first cell.
      expect(area.x - left).toBe(TEXT_OFFSET)
      expect(area.visualCursor.offset).toBe(0)
      expect(cursorColumn(harness, left)).toBe(TEXT_OFFSET)

      const expectCursorAtEnd = async () => {
        await harness.settle()
        const draft = harness.promptDraft()!
        // The mark is not in the draft; the draft is what was typed.
        expect(draft).not.toContain("›")
        // One cell per ASCII letter, two per CJK character or emoji: the offset is the width of the text before the
        // cursor, and the cursor is drawn that far right of where the text starts.
        expect(area.visualCursor.offset).toBe(cellWidth(draft))
        expect(area.x - left).toBe(TEXT_OFFSET)
        expect(cursorColumn(harness, left)).toBe(TEXT_OFFSET + cellWidth(draft))
      }
      for (const typed of ["abc", "中文", "ab"]) {
        await harness.app.mockInput.typeText(typed)
        await expectCursorAtEnd()
      }
      // The mock types a key per UTF-16 unit, so an emoji goes in the way a paste brings it.
      await harness.app.mockInput.pasteBracketedText("😀")
      await expectCursorAtEnd()

      // The first typed letters start at the fifth column of the frame's input row.
      const { rows, top } = boxOf(await harness.frame())
      expect(rows[top + 1].slice(left + TEXT_OFFSET).startsWith("abc中文ab😀")).toBe(true)
      expect(harness.promptDraft()).toBe("abc中文ab😀")
    } finally {
      await harness.dispose()
    }
  })
}

test("keeps the cursor on the last row of a pasted text, four columns right of the border", async () => {
  // Unsummarized, so that the paste lands in the input as the three rows it is.
  const harness = await mountApp({ type: "session", sessionID }, { kv: { paste_summary_enabled: false } })
  try {
    await harness.settle()
    const area = textareaOf(harness)
    await harness.app.mockInput.typeText("abc")
    await harness.app.mockInput.pasteBracketedText("\none\ntwo\nthree")
    await harness.settle()
    expect(harness.promptDraft()).toBe("abc\none\ntwo\nthree")

    const { rows, top, bottom, left } = boxOf(await harness.frame())
    // Three rows pasted below the first: the frame grows with them, and the mark stays on the first row alone.
    expect(area.height).toBe(4)
    expect(bottom - top).toBe(5)
    expect(rows[top + 1].trimStart().startsWith("│ › abc")).toBe(true)
    for (const [index, line] of ["one", "two", "three"].entries()) {
      expect(rows[top + 2 + index].slice(left)).toStartWith(`│   ${line}`)
    }
    expect(marksIn(rows.slice(top, bottom + 1))).toBe(1)

    // Every row of the text is aligned with the first one, and the cursor is at the end of the last.
    expect(area.x - left).toBe(TEXT_OFFSET)
    expect(area.visualCursor.visualRow).toBe(3)
    expect(area.visualCursor.visualCol).toBe(cellWidth("three"))
    expect(cursorColumn(harness, left)).toBe(TEXT_OFFSET + cellWidth("three"))
    expect(harness.app.renderer.getCursorState().y - 1).toBe(top + 1 + 3)
  } finally {
    await harness.dispose()
  }
})

test("keeps the cursor after a summarized paste, which is one virtual piece of the first row", async () => {
  const harness = await mountApp({ type: "home" })
  try {
    await harness.settle()
    const area = textareaOf(harness)
    const left = boxOf(await harness.frame()).left
    await harness.app.mockInput.typeText("中")
    await harness.app.mockInput.pasteBracketedText("one\ntwo\nthree")
    await harness.settle()

    // The three rows are shown as one label, and the box stays three rows tall.
    const draft = harness.promptDraft()!
    expect(draft).toContain("[Pasted ~3 lines]")
    const { rows, top, bottom } = boxOf(await harness.frame())
    expect(bottom).toBe(top + 2)
    expect(rows[top + 1].slice(left + TEXT_OFFSET)).toStartWith("中[Pasted ~3 lines]")
    expect(area.visualCursor.offset).toBe(cellWidth(draft))
    expect(cursorColumn(harness, left)).toBe(TEXT_OFFSET + cellWidth(draft))
  } finally {
    await harness.dispose()
  }
})

test("never lets the mark into the text a command run or a history step reads", async () => {
  const harness = await mountApp({ type: "session", sessionID })
  try {
    await harness.settle()
    const area = textareaOf(harness)
    await harness.app.mockInput.typeText("draft")
    await waitFor(() => harness.promptDraft() === "draft")
    // What the textarea holds, what the prompt reports and what is on screen as input are the same text.
    expect(area.plainText).toBe("draft")
    expect(harness.promptDraft()).toBe("draft")
    expect(harness.promptParts()).toEqual([])
    expect(area.plainText).not.toContain("›")
  } finally {
    await harness.dispose()
  }
})
