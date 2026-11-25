// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { setLanguage } from "../../src/i18n"
import { DetailPanel, type DetailRow } from "../../src/panel/detail"
import { SettingsPanel, type SettingRow } from "../../src/panel/settings"
import { renderUntilFrame } from "../fixture/frames"
import { shellState } from "../shell/contexts"
import { PanelSurface, renderPanel } from "./contexts"

// #1672: the keys that move a page stop at the first and the last row, where the arrow keys wrap round; and the
// terminal cursor is drawn at the input that has the focus, so an input inside the scrolling content that has scrolled
// out of view would leave the cursor on the screen where it was, in the message area above the panel. The same check as
// for the filter row of a list (`list-scroll.test.tsx`), for the two other inputs a panel has: the value being edited
// in a settings row, and the input of a detail panel.

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

type App = Awaited<ReturnType<typeof renderPanel>>

/** Rows of other content above the panel, as the message area is above it: a cursor drawn outside the panel shows. */
const ABOVE = 12

/** A panel under a block of other content, the way the bottom zone sits under the message area. */
function mountUnder(path: string, panel: () => import("solid-js").JSX.Element, height = 40) {
  return renderPanel(
    () => (
      <box flexDirection="column">
        <box height={ABOVE} flexShrink={0}>
          <text>消息区</text>
        </box>
        <PanelSurface spec={{ render: panel }} />
      </box>
    ),
    { width: 80, height, state: path },
  )
}

const linesOf = (frame: string) => frame.split("\n").map((line) => line.trimEnd())

/** The rows the panel draws between its borders and the cursor the terminal shows (the renderer counts it from 1). */
function placeOf(app: App, frame: string) {
  const lines = linesOf(frame)
  const top = lines.findIndex((line) => line.includes("╭"))
  const bottom = lines.findIndex((line) => line.includes("╰"))
  const state = app.renderer.getCursorState()
  return {
    lines,
    top,
    bottom,
    left: lines[top]?.indexOf("╭") ?? -1,
    right: lines[top]?.lastIndexOf("╮") ?? -1,
    cursor: { row: state.y - 1, col: state.x - 1, visible: state.visible },
  }
}

/** Whether the terminal cursor, when it shows at all, is inside the borders of the panel. */
function cursorInside(place: ReturnType<typeof placeOf>) {
  const { cursor } = place
  if (!cursor.visible) return true
  return cursor.row > place.top && cursor.row < place.bottom && cursor.col > place.left && cursor.col < place.right
}

/** The row the panel marks as selected, as the settings and the detail panel both write it. */
function selectedRow(frame: string) {
  return linesOf(frame).find((line) => line.includes("›"))
}

function press(app: App, key: "pageup" | "pagedown" | "home" | "end" | "up" | "down") {
  if (key === "up" || key === "down") return app.mockInput.pressArrow(key)
  app.mockInput.pressKey({ pageup: "\u001B[5~", pagedown: "\u001B[6~", home: "HOME", end: "END" }[key])
}

/** The wheel, as a user over the panel's content, and the frames it takes to show. */
async function wheel(app: App, top: number, direction: "up" | "down") {
  for (let tick = 0; tick < 30; tick++) await app.mockMouse.scroll(10, top + 4, direction)
  await app.renderOnce()
  await app.renderOnce()
}

/** The frame as it is now, for a check that must not wait for a change. */
async function now(app: App) {
  await app.renderOnce()
  return renderUntilFrame(app, () => true, "the frame")
}

function longRows(): SettingRow[] {
  const toggles = Array.from({ length: 24 }, (_, index): SettingRow => {
    return {
      id: `toggle-${index}`,
      label: `选项 ${index + 1}`,
      kind: "toggle",
      value: false,
      onChange: () => {},
    }
  })
  return [...toggles, { id: "name", label: "文件名", kind: "text", value: "a.md", onChange: () => {} }]
}

const longSettings = () => <SettingsPanel title="设置" tabs={[{ id: "all", label: "全部", rows: longRows() }]} />

function numbered(count: number): DetailRow<string>[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `row-${index + 1}`
    return { id, cells: [`条目 ${index + 1}`], value: id }
  })
}

test("a page key stops at the first and the last row of a settings panel", async () => {
  await using tmp = await shellState()
  const app = await mountUnder(tmp.path, longSettings)
  try {
    await renderUntilFrame(app, (frame) => selectedRow(frame)?.includes("选项 1") === true, "the settings")
    press(app, "pagedown")
    await renderUntilFrame(app, (frame) => selectedRow(frame)?.includes("选项 11") === true, "a page down")
    // The last row has nowhere further to go, and the page key does not wrap round to the first one.
    press(app, "end")
    await renderUntilFrame(app, (frame) => selectedRow(frame)?.includes("文件名") === true, "the last row")
    press(app, "pagedown")
    expect(selectedRow(await now(app))).toContain("文件名")
    press(app, "home")
    await renderUntilFrame(app, (frame) => selectedRow(frame)?.includes("选项 1") === true, "the first row")
    press(app, "pageup")
    expect(selectedRow(await now(app))).toContain("选项 1")
    // The arrow keys still wrap round both ends.
    press(app, "up")
    await renderUntilFrame(app, (frame) => selectedRow(frame)?.includes("文件名") === true, "the last row by wrapping")
    press(app, "down")
    await renderUntilFrame(app, (frame) => selectedRow(frame)?.includes("选项 1") === true, "the first row by wrapping")
  } finally {
    app.renderer.destroy()
  }
})

test("a page key stops at the first and the last row of a detail panel", async () => {
  await using tmp = await shellState()
  const app = await mountUnder(tmp.path, () => <DetailPanel title="详情" rows={numbered(24)} hints={[]} />)
  try {
    await renderUntilFrame(app, (frame) => selectedRow(frame)?.includes("条目 1") === true, "the rows")
    press(app, "pagedown")
    await renderUntilFrame(app, (frame) => selectedRow(frame)?.includes("条目 11") === true, "a page down")
    press(app, "end")
    await renderUntilFrame(app, (frame) => selectedRow(frame)?.includes("条目 24") === true, "the last row")
    press(app, "pagedown")
    expect(selectedRow(await now(app))).toContain("条目 24")
    press(app, "home")
    await renderUntilFrame(app, (frame) => selectedRow(frame)?.includes("条目 1") === true, "the first row")
    press(app, "pageup")
    expect(selectedRow(await now(app))).toContain("条目 1")
    press(app, "up")
    await renderUntilFrame(app, (frame) => selectedRow(frame)?.includes("条目 24") === true, "the last row by wrapping")
    press(app, "down")
    await renderUntilFrame(app, (frame) => selectedRow(frame)?.includes("条目 1") === true, "the first row by wrapping")
  } finally {
    app.renderer.destroy()
  }
})

test("the cursor of the value being edited in a settings row stays inside the panel", async () => {
  await using tmp = await shellState()
  const app = await mountUnder(tmp.path, longSettings)
  try {
    await renderUntilFrame(app, (frame) => frame.includes("› 选项 1"), "the settings")
    press(app, "end")
    await renderUntilFrame(app, (frame) => frame.includes("› 文件名"), "the last row")
    app.mockInput.pressEnter()
    const editing = await renderUntilFrame(app, () => app.renderer.getCursorState().visible, "the cursor")
    const start = placeOf(app, editing)
    expect(start.lines.some((line) => line.includes("文件名"))).toBe(true)
    expect(cursorInside(start)).toBe(true)
    // The wheel takes the view away from the row being edited; the row comes back with the cursor in it.
    await wheel(app, start.top, "up")
    const place = placeOf(app, await now(app))
    expect(place.lines.some((line) => line.includes("文件名"))).toBe(true)
    expect(cursorInside(place)).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("the cursor of the input of a detail panel under a body taller than the panel stays inside it", async () => {
  await using tmp = await shellState()
  const body = Array.from({ length: 30 }, (_, index) => `说明 ${index + 1}`).join("\n")
  const app = await mountUnder(tmp.path, () => (
    <DetailPanel title="输入" body={body} input={{ placeholder: "输入…", onSubmit: () => {} }} hints={[]} />
  ))
  try {
    const frame = await renderUntilFrame(app, (shown) => shown.includes("说明 1"), "the panel")
    const place = placeOf(app, frame)
    // The input is the last row of the content: the panel opens with it in view, not with the body alone.
    expect(place.lines.some((line) => line.includes("输入…"))).toBe(true)
    expect(cursorInside(place)).toBe(true)
    await wheel(app, place.top, "up")
    const after = placeOf(app, await now(app))
    expect(after.lines.some((line) => line.includes("输入…"))).toBe(true)
    expect(cursorInside(after)).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})
