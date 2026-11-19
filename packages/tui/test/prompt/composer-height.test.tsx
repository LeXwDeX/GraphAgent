// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { cellWidth } from "../../src/ui/width"
import { AppRoutes } from "../fixture/route-frame"
import { promptTop } from "../fixture/run-app"
import { mountRoute, sessionFixture, type MountOptions } from "../routes/dag-mode-harness"

/**
 * #1616: how tall the input box is, read off the real home and session routes in the app frame.
 *
 * The textarea is as tall as the rows its text takes after wrapping: one at least, and `maxHeight()` at most, which is
 * `prompt.max_height` or else a third of the terminal's height rounded down, six rows at least. The frame is two rows
 * taller than the textarea (its top and bottom edge), so an empty input is three rows. Past the cap the frame stops
 * growing and the text scrolls inside the textarea. The mark stays on the first row of the frame, and the other rows
 * of the text are aligned with the first one. The editing line, when there is one, is a row of its own inside the
 * frame, above the textarea, and is not part of the cap. The numbers are written out here and not taken from the
 * source: a change of the rule has to change this file too.
 */

const sessionID = "ses_height"

// 80x24 unless a test says otherwise: the cap is a third of 24 rows, eight.
const SIZE = { width: 80, height: 24 } as const
const CAP = 8

/** Columns from the frame's left border to the first cell of the text: border 1, padding 1, the mark and a space 2. */
const TEXT_OFFSET = 4

/** The start of the editing line (`prompt.edit.status`, zh-CN), which sits between the top edge and the mark's row. */
const EDITING = "正在编辑："

type Harness = Awaited<ReturnType<typeof mountApp>>

// Unsummarized, so that a paste lands in the input as the rows it has, which is what the frame has to count.
function mountApp(route: MountOptions["route"], extra: Partial<MountOptions> = {}) {
  return mountRoute({
    route,
    view: () => <AppRoutes />,
    frame: true,
    sessions: [sessionFixture(sessionID)],
    withAgentAndModel: true,
    kv: { paste_summary_enabled: false },
    ...SIZE,
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

type Box = ReturnType<typeof boxOf>

/**
 * The input box in a frame: its rows, the rows of its edges, its height and the column of its left border. The
 * fixture finds it by the mark right under the top edge; with the editing line in between, give the line's start.
 */
function boxOf(frame: string, editingLine?: string) {
  const rows = frame.split("\n").map((row) => row.trimEnd())
  const top = editingLine === undefined ? promptTop(rows) : rows.findIndex((row) => row.includes(editingLine)) - 1
  if (top < 0) throw new Error(`no input box in the frame:\n${frame}`)
  const bottom = rows.findIndex((row, index) => index > top && row.trimStart().startsWith("╰"))
  if (bottom < 0) throw new Error(`the input box has no bottom edge:\n${frame}`)
  return { rows, top, bottom, left: rows[top].indexOf("╭"), height: bottom - top + 1 }
}

/** The box after the frames that follow an input have been drawn. */
async function boxNow(harness: Harness, editingLine?: string) {
  await harness.settle()
  return boxOf(await harness.frame(), editingLine)
}

/** How many prompt marks the rows hold. */
function marksIn(rows: readonly string[]) {
  return rows.join("\n").split("›").length - 1
}

/**
 * The input rows of `box` show `lines`: the first row starts at row `first` of the frame and has the mark, the others
 * have a blank column of the mark's width in its place so that their text is aligned with the first, and the bottom
 * edge comes right after the last. The mark appears once in the whole frame.
 */
function expectInputRows(box: Box, first: number, lines: readonly string[]) {
  for (const [index, line] of lines.entries()) {
    expect(box.rows[first + index].slice(box.left)).toStartWith(`│ ${index === 0 ? "›" : " "} ${line}`)
  }
  expect(box.bottom).toBe(first + lines.length)
  expect(box.rows[box.bottom].slice(box.left)).toStartWith("╰")
  expect(marksIn(box.rows.slice(box.top, box.bottom + 1))).toBe(1)
}

/** Where the renderer draws the cursor: its row on the screen, and the cells between the frame's left border and it. */
function cursorOf(harness: Harness, box: Box) {
  const { x, y } = harness.app.renderer.getCursorState()
  // Its coordinates start at 1.
  return { row: y - 1, column: x - 1 - box.left }
}

/** `count` different rows of text without a `›` in them: "line 01", "line 02" and so on. */
function textRows(count: number) {
  return Array.from({ length: count }, (_, index) => `line ${String(index + 1).padStart(2, "0")}`)
}

for (const route of ["home", "session"] as const) {
  test(`a pasted text of three rows makes a five-row frame, and the frame shrinks with the text (${route})`, async () => {
    const harness = await mountApp(route === "home" ? { type: "home" } : { type: "session", sessionID })
    try {
      await harness.settle()
      const area = textareaOf(harness)
      // Idle: one row of input in a frame of three.
      expect(area.height).toBe(1)
      expect((await boxNow(harness)).height).toBe(3)

      await harness.app.mockInput.pasteBracketedText("one\ntwo\nthree")
      let box = await boxNow(harness)
      expect(harness.promptDraft()).toBe("one\ntwo\nthree")
      expect(area.height).toBe(3)
      expect(box.height).toBe(5)
      expectInputRows(box, box.top + 1, ["one", "two", "three"])
      // The text of every row starts where it does on the first row, right of the mark's column.
      expect(area.x - box.left).toBe(TEXT_OFFSET)

      // Deleting from the end takes the frame back down: "three" and the newline before it are six keys.
      for (let key = 0; key < 6; key++) harness.app.mockInput.pressBackspace()
      box = await boxNow(harness)
      expect(harness.promptDraft()).toBe("one\ntwo")
      expect(area.height).toBe(2)
      expect(box.height).toBe(4)
      expectInputRows(box, box.top + 1, ["one", "two"])

      // "one\ntwo" is seven keys more, and an empty input is one row in a frame of three again.
      for (let key = 0; key < 7; key++) harness.app.mockInput.pressBackspace()
      box = await boxNow(harness)
      expect(harness.promptDraft()).toBe("")
      expect(area.height).toBe(1)
      expect(box.height).toBe(3)
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })
}

test("a newline typed adds a row to the frame and the cursor follows to the last one", async () => {
  const harness = await mountApp({ type: "session", sessionID })
  try {
    await harness.settle()
    const area = textareaOf(harness)
    const typed = ["a", "b", "c", "d"]
    for (const [index, text] of typed.entries()) {
      // Ctrl+J is the newline a terminal without the kitty keyboard protocol can send; enter alone submits.
      if (index > 0) harness.app.mockInput.pressKey("j", { ctrl: true })
      await harness.app.mockInput.typeText(text)
      const box = await boxNow(harness)
      expect(area.height).toBe(index + 1)
      expect(box.height).toBe(index + 3)
      expectInputRows(box, box.top + 1, typed.slice(0, index + 1))
      const cursor = cursorOf(harness, box)
      expect(cursor.row).toBe(box.bottom - 1)
      expect(cursor.column).toBe(TEXT_OFFSET + 1)
    }
    expect(harness.promptDraft()).toBe("a\nb\nc\nd")
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("counts the rows a long line takes after wrapping, by display width", async () => {
  const harness = await mountApp({ type: "session", sessionID })
  try {
    await harness.settle()
    const area = textareaOf(harness)
    const width = area.width
    const size = async () => {
      const box = await boxNow(harness)
      return { text: area.height, frame: box.height, box }
    }

    // A line a few cells short of the textarea's width is one row.
    await harness.app.mockInput.typeText("a".repeat(width - 5))
    expect(await size()).toMatchObject({ text: 1, frame: 3 })

    // Ten cells more wrap it onto a second row, and a whole row more onto a third. It is still one line of the draft.
    await harness.app.mockInput.typeText("a".repeat(10))
    expect(await size()).toMatchObject({ text: 2, frame: 4 })
    await harness.app.mockInput.typeText("a".repeat(width))
    const { text, frame, box } = await size()
    expect({ text, frame }).toEqual({ text: 3, frame: 5 })
    expectInputRows(box, box.top + 1, ["a".repeat(width), "a".repeat(width), "a".repeat(5)])
    expect(area.lineCount).toBe(1)

    // Cells, not characters: CJK characters are two cells each, so fewer than `width` of them can still wrap.
    area.setText("")
    const wide = "中".repeat(Math.floor(width / 2) + 1)
    expect(wide.length).toBeLessThan(width)
    expect(cellWidth(wide)).toBeGreaterThan(width)
    await harness.app.mockInput.typeText(wide)
    expect(await size()).toMatchObject({ text: 2, frame: 4 })

    // Two characters fewer fit on one row.
    area.setText("")
    await harness.app.mockInput.typeText("中".repeat(Math.floor(width / 2) - 1))
    expect(await size()).toMatchObject({ text: 1, frame: 3 })
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

for (const route of ["home", "session"] as const) {
  test(`stops growing at the cap and scrolls the text inside the textarea, the mark staying on the first row (${route})`, async () => {
    const harness = await mountApp(route === "home" ? { type: "home" } : { type: "session", sessionID })
    try {
      await harness.settle()
      const area = textareaOf(harness)
      const all = textRows(30)

      await harness.app.mockInput.pasteBracketedText(all.join("\n"))
      let box = await boxNow(harness)
      // Thirty rows do not fit: the textarea is as tall as the cap, the frame two rows more, and the cursor, at the
      // end of the text, has the textarea scrolled to the last rows.
      expect(harness.promptDraft()).toBe(all.join("\n"))
      expect(area.lineCount).toBe(30)
      expect(area.height).toBe(CAP)
      expect(area.scrollY).toBe(30 - CAP)
      expect(box.height).toBe(CAP + 2)
      expectInputRows(box, box.top + 1, all.slice(-CAP))
      expect(cursorOf(harness, box)).toEqual({ row: box.bottom - 1, column: TEXT_OFFSET + cellWidth("line 30") })

      // The wheel over the textarea scrolls the text in place: the frame keeps its height, and the mark its row over
      // whichever row of the text is first now.
      await harness.app.mockMouse.scroll(area.x + 5, area.y + 3, "up")
      box = await boxNow(harness)
      expect(area.scrollY).toBeLessThan(30 - CAP)
      expect(area.height).toBe(CAP)
      expect(box.height).toBe(CAP + 2)
      expectInputRows(box, box.top + 1, all.slice(area.scrollY, area.scrollY + CAP))

      // Home takes the cursor to the start of the text and the textarea scrolls back to the first rows. The frame is
      // as tall as it was, and the mark is still on its first row, over whatever row of the text is there.
      harness.app.mockInput.pressKey("HOME")
      box = await boxNow(harness)
      expect(area.scrollY).toBe(0)
      expect(area.height).toBe(CAP)
      expect(box.height).toBe(CAP + 2)
      expectInputRows(box, box.top + 1, all.slice(0, CAP))
      expect(cursorOf(harness, box)).toEqual({ row: box.top + 1, column: TEXT_OFFSET })

      // End and another row typed: the frame does not grow, the text scrolls by one row.
      harness.app.mockInput.pressKey("END")
      harness.app.mockInput.pressKey("j", { ctrl: true })
      await harness.app.mockInput.typeText("more")
      box = await boxNow(harness)
      expect(harness.promptDraft()).toBe(`${all.join("\n")}\nmore`)
      expect(area.lineCount).toBe(31)
      expect(area.height).toBe(CAP)
      expect(area.scrollY).toBe(31 - CAP)
      expect(box.height).toBe(CAP + 2)
      expectInputRows(box, box.top + 1, [...all, "more"].slice(-CAP))
      expect(cursorOf(harness, box)).toEqual({ row: box.bottom - 1, column: TEXT_OFFSET + cellWidth("more") })
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })
}

// A size for each part of the rule. At 14 rows a third is four, so the floor of six applies. 24 and 30 are exact thirds.
// 20 and 44 are not (6.67 and 14.67), and the cap is rounded down, not to the nearest row. The first is the size the
// harness starts at, the others are resizes.
const CAPS = [
  { height: 24, cap: 8 },
  { height: 14, cap: 6 },
  { height: 20, cap: 6 },
  { height: 44, cap: 14 },
  { height: 30, cap: 10 },
  { height: 24, cap: 8 },
] as const

test("the cap is a third of the terminal's height, six rows at least, and follows a resize", async () => {
  const harness = await mountApp({ type: "session", sessionID })
  try {
    await harness.settle()
    const area = textareaOf(harness)
    const all = textRows(30)
    await harness.app.mockInput.pasteBracketedText(all.join("\n"))

    for (const { height, cap } of CAPS) {
      harness.app.resize(SIZE.width, height)
      const box = await boxNow(harness)
      expect(area.height).toBe(cap)
      expect(box.height).toBe(cap + 2)
      expectInputRows(box, box.top + 1, all.slice(-cap))
    }
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

for (const max of [1, 4, 15]) {
  test(`prompt.max_height of ${max} replaces the cap of a third of the terminal's height`, async () => {
    // The harness hands its option to the TUI config as a whole, whatever its name says.
    const harness = await mountApp({ type: "session", sessionID }, { keybinds: { prompt: { max_height: max } } })
    try {
      await harness.settle()
      const area = textareaOf(harness)
      const all = textRows(30)

      // Below the cap the textarea is as tall as its rows, so the cap is no minimum: 15 does not make three rows fifteen.
      await harness.app.mockInput.pasteBracketedText(all.slice(0, 3).join("\n"))
      let box = await boxNow(harness)
      const rows = Math.min(3, max)
      expect(area.height).toBe(rows)
      expect(box.height).toBe(rows + 2)
      expectInputRows(box, box.top + 1, all.slice(0, 3).slice(-rows))

      // Past it the textarea stops at the setting, above or below what a third of 24 rows would give (eight).
      await harness.app.mockInput.pasteBracketedText(`\n${all.slice(3).join("\n")}`)
      box = await boxNow(harness)
      expect(harness.promptDraft()).toBe(all.join("\n"))
      expect(area.height).toBe(max)
      expect(box.height).toBe(max + 2)
      expectInputRows(box, box.top + 1, all.slice(-max))
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })
}

test("the editing line is one more row of the frame, above the textarea and outside the cap", async () => {
  const harness = await mountApp({ type: "session", sessionID })
  try {
    await harness.settle()
    const area = textareaOf(harness)
    expect((await boxNow(harness)).height).toBe(3)

    // `/rename` starts an edit: the line appears, and the frame, which was three rows, is four.
    for (const key of "/rename") harness.app.mockInput.pressKey(key)
    await harness.app.renderOnce()
    harness.app.mockInput.pressEnter()
    await harness.waitForFrame((frame) => frame.includes(EDITING), "the editing line")
    let box = await boxNow(harness, EDITING)
    expect(area.height).toBe(1)
    expect(box.height).toBe(4)
    expect(box.rows[box.top].trimStart()).toStartWith("╭")
    expect(box.rows[box.top + 1].trimStart()).toStartWith(`│ ${EDITING}`)
    expect(box.rows[box.top + 2].trimStart()).toStartWith("│ ›")
    expect(marksIn(box.rows.slice(box.top, box.bottom + 1))).toBe(1)

    // The textarea starts with the session's title; empty it, so that the rows below are the ones pasted.
    area.setText("")
    await harness.app.mockInput.pasteBracketedText("one\ntwo\nthree")
    box = await boxNow(harness, EDITING)
    expect(area.height).toBe(3)
    expect(box.height).toBe(6)
    expect(box.rows[box.top + 1].trimStart()).toStartWith(`│ ${EDITING}`)
    expectInputRows(box, box.top + 2, ["one", "two", "three"])

    // At the cap the textarea has `CAP` rows, and the line is a row more than the two edges: the cap does not take it.
    const all = textRows(30)
    area.setText("")
    await harness.app.mockInput.pasteBracketedText(all.join("\n"))
    box = await boxNow(harness, EDITING)
    expect(area.height).toBe(CAP)
    expect(box.height).toBe(CAP + 3)
    expect(box.rows[box.top + 1].trimStart()).toStartWith(`│ ${EDITING}`)
    expectInputRows(box, box.top + 2, all.slice(-CAP))

    // Esc drops the edit and its line: the frame is the three rows of an empty input.
    harness.app.mockInput.pressEscape()
    box = await boxNow(harness)
    expect(harness.promptDraft()).toBe("")
    expect(area.height).toBe(1)
    expect(box.height).toBe(3)
    expect(box.rows.join("\n")).not.toContain(EDITING)
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})
