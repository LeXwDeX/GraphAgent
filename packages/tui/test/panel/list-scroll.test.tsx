// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { BoxRenderable, Renderable, TextRenderable } from "@opentui/core"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { setLanguage } from "../../src/i18n"
import { ListPanel, type ListItem } from "../../src/panel/list"
import { renderUntilFrame } from "../fixture/frames"
import { shellState } from "../shell/contexts"
import { PanelSurface, renderPanel } from "./contexts"

// #1676: how a list panel behaves when it has more rows than it shows. The filter row stays where it is, the terminal
// cursor with it; the selected row is always in view; the page keys stop at the ends; rows are not mounted again while
// the data under them refreshes.

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

type App = Awaited<ReturnType<typeof renderPanel>>

/** Rows of other content above the panel, as the message area is above it: a cursor drawn outside the panel shows. */
const ABOVE = 12

function numbered(count: number, group?: (index: number) => string | undefined): ListItem<string>[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    value: `item-${index}`,
    title: `条目 ${index + 1}`,
    group: group?.(index),
  }))
}

interface MountOptions {
  width?: number
  height?: number
  selectionKey?: string
  current?: string
}

/** A list panel under a block of other content, the way the bottom zone sits under the message area. */
function mountList(path: string, items: () => readonly ListItem<string>[], options: MountOptions = {}) {
  return renderPanel(
    () => (
      <box flexDirection="column">
        <box height={ABOVE} flexShrink={0}>
          <text>消息区</text>
        </box>
        <PanelSurface
          spec={{
            render: () => (
              <ListPanel
                title="长列表"
                items={items()}
                selectionKey={options.selectionKey}
                current={options.current}
                onSelect={() => {}}
              />
            ),
          }}
        />
      </box>
    ),
    { width: options.width ?? 80, height: options.height ?? 40, state: path },
  )
}

const linesOf = (frame: string) => frame.split("\n").map((line) => line.trimEnd())

/** The title of the selected row: the pointer of the filter row is not followed by a title. */
const selectedTitle = (frame: string) => frame.match(/› (条目 \d+)/)?.[1]

/**
 * Whether the selection has left the row with this title and the view shows the row it is on now. The selection moves
 * first and the view follows it; a frame in between has no pointer on any row, and is not yet the place the selection
 * has moved to.
 */
const movedFrom = (title: string) => (frame: string) => {
  const now = selectedTitle(frame)
  return now !== undefined && now !== title
}

/** The rows the panel draws: its borders, its filter row when it is in view, and the cursor the terminal shows. */
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
    filterRow: lines.findIndex((line) => line.includes("筛选…")),
    // The renderer counts the cursor from 1.
    cursor: { row: state.y - 1, col: state.x - 1, visible: state.visible },
  }
}

function press(app: App, key: "pageup" | "pagedown" | "home" | "end" | "up" | "down") {
  if (key === "up" || key === "down") return app.mockInput.pressArrow(key)
  app.mockInput.pressKey({ pageup: "\u001B[5~", pagedown: "\u001B[6~", home: "HOME", end: "END" }[key])
}

function collect(root: Renderable, result: Renderable[] = []) {
  result.push(root)
  for (const child of root.getChildren()) collect(child, result)
  return result
}

/** The row of the list that shows this title: the box that holds the text of the title. */
function rowNode(app: App, title: string) {
  const text = collect(app.renderer.root).find((node) => node instanceof TextRenderable && node.plainText === title)
  const row = text?.parent
  return row instanceof BoxRenderable ? row : undefined
}

/** Whether a row shows this title. The rows are padded, so a longer title that starts the same does not count. */
const shows = (frame: string, title: string) => frame.includes(`${title} `)

test("the terminal cursor stays on the filter row, inside the panel, however far the list scrolls", async () => {
  await using tmp = await shellState()
  const app = await mountList(tmp.path, () => numbered(26))
  try {
    const start = placeOf(app, await renderUntilFrame(app, (frame) => selectedTitle(frame) === "条目 1", "the list"))
    // The filter is the row under the title and the cursor is in it, after the pointer.
    expect(start.filterRow).toBe(start.top + 2)
    expect(start.cursor).toEqual({ row: start.filterRow, col: start.left + 4, visible: true })

    press(app, "end")
    const end = placeOf(
      app,
      await renderUntilFrame(app, (frame) => selectedTitle(frame) === "条目 26", "the end of the list"),
    )
    // Nothing of the cursor is outside the panel: not above it, in the other content, and not on its border.
    expect(end.cursor.visible).toBe(true)
    expect(end.cursor.row).toBeGreaterThan(end.top)
    expect(end.cursor.row).toBeLessThan(end.bottom)
    expect(end.cursor.col).toBeGreaterThan(end.left)
    expect(end.cursor.col).toBeLessThan(end.right)
    // The filter is where it was and still shows, and the cursor is still in it.
    expect(end.filterRow).toBe(start.filterRow)
    expect(end.cursor).toEqual(start.cursor)
  } finally {
    app.renderer.destroy()
  }
})

test("a list that opens on a current value far down shows it, and its filter row", async () => {
  await using tmp = await shellState()
  const app = await mountList(tmp.path, () => numbered(26), { current: "item-21" })
  try {
    const frame = await renderUntilFrame(app, (shown) => shown.includes("● 条目 22"), "the current value in view")
    // It is the selected row, and the filter is still the row under the title.
    expect(frame.match(/● (条目 \d+)/)?.[1]).toBe("条目 22")
    const place = placeOf(app, frame)
    expect(place.filterRow).toBe(place.top + 2)
  } finally {
    app.renderer.destroy()
  }
})

test("the filter row does not scroll: it is the row under the title, whichever rows the list shows", async () => {
  await using tmp = await shellState()
  const app = await mountList(tmp.path, () => numbered(26))
  try {
    await renderUntilFrame(app, (frame) => selectedTitle(frame) === "条目 1", "the list")
    // Each key with the row the selection is on once it has been handled: the end, a page up from the end, the top.
    // The pointer is drawn on a row in view only, so a frame that shows it is one in which the view has followed.
    for (const [key, title] of [
      ["end", "条目 26"],
      ["pageup", "条目 16"],
      ["home", "条目 1"],
    ] as const) {
      press(app, key)
      const frame = await renderUntilFrame(
        app,
        (shown) => selectedTitle(shown) === title,
        `the selection on ${title} after ${key}`,
      )
      const place = placeOf(app, frame)
      expect(place.filterRow).toBe(place.top + 2)
      expect(place.lines[place.top + 1]).toContain("长列表")
    }
  } finally {
    app.renderer.destroy()
  }
})

test("PageDown and PageUp stop at the last and the first item, they do not wrap round", async () => {
  await using tmp = await shellState()
  const app = await mountList(tmp.path, () => numbered(20))
  try {
    await renderUntilFrame(app, (frame) => selectedTitle(frame) === "条目 1", "the first item")
    for (let step = 0; step < 14; step++) press(app, "down")
    await renderUntilFrame(app, (frame) => selectedTitle(frame) === "条目 15", "the fifteenth item")

    // Ten items down would be past the end: the selection is on the last item, not on the fifth.
    press(app, "pagedown")
    const last = await renderUntilFrame(app, movedFrom("条目 15"), "the selection after a page down")
    expect(selectedTitle(last)).toBe("条目 20")
    // At the last item there is nowhere further to go. A key that changes nothing leaves nothing to wait for, so the key
    // after it is what is waited for. Keys are handled in the order they are pressed: a step up ends on the item before
    // the last one only if the page down before it left the selection where it was.
    press(app, "pagedown")
    press(app, "up")
    const stayed = await renderUntilFrame(app, movedFrom("条目 20"), "the selection after a step up")
    expect(selectedTitle(stayed)).toBe("条目 19")

    press(app, "home")
    await renderUntilFrame(app, (frame) => selectedTitle(frame) === "条目 1", "the first item again")
    press(app, "down")
    press(app, "down")
    await renderUntilFrame(app, (frame) => selectedTitle(frame) === "条目 3", "the third item")
    press(app, "pageup")
    const first = await renderUntilFrame(app, movedFrom("条目 3"), "the selection after a page up")
    expect(selectedTitle(first)).toBe("条目 1")
    // The same at the first item, with one step down.
    press(app, "pageup")
    press(app, "down")
    const stayedFirst = await renderUntilFrame(app, movedFrom("条目 1"), "the selection after a step down")
    expect(selectedTitle(stayedFirst)).toBe("条目 2")

    // A page is still ten items where there are ten to go.
    press(app, "pagedown")
    await renderUntilFrame(app, (frame) => selectedTitle(frame) === "条目 12", "a page down")
    // Up and Down still wrap round the ends.
    press(app, "home")
    await renderUntilFrame(app, (frame) => selectedTitle(frame) === "条目 1", "the first item once more")
    press(app, "up")
    await renderUntilFrame(app, (frame) => selectedTitle(frame) === "条目 20", "the last item by wrapping")
    press(app, "down")
    await renderUntilFrame(app, (frame) => selectedTitle(frame) === "条目 1", "the first item by wrapping")
  } finally {
    app.renderer.destroy()
  }
})

test("a page key brings the selected row back into view even when it does not move it", async () => {
  await using tmp = await shellState()
  const app = await mountList(tmp.path, () => numbered(20), { height: 24 })
  try {
    await renderUntilFrame(app, (frame) => selectedTitle(frame) === "条目 1", "the first item")
    press(app, "end")
    const end = await renderUntilFrame(app, (frame) => selectedTitle(frame) === "条目 20", "the last item")
    // The wheel takes the view away from the selection; the selection stays on the last item.
    const place = placeOf(app, end)
    for (let tick = 0; tick < 30; tick++) await app.mockMouse.scroll(10, place.top + 4, "up")
    const away = await renderUntilFrame(app, (frame) => shows(frame, "条目 1"), "the top of the list")
    expect(shows(away, "条目 20")).toBe(false)
    // PageDown cannot move it any further, and it is shown again all the same.
    press(app, "pagedown")
    const frame = await renderUntilFrame(app, (shown) => selectedTitle(shown) === "条目 20", "the selected row in view")
    expect(selectedTitle(frame)).toBe("条目 20")
  } finally {
    app.renderer.destroy()
  }
})

test("after the wheel has scrolled the view away, Down moves the selection one step from where it is, and shows it", async () => {
  await using tmp = await shellState()
  const app = await mountList(tmp.path, () => numbered(30), { height: 24 })
  try {
    const first = await renderUntilFrame(app, (frame) => selectedTitle(frame) === "条目 1", "the first item")
    const place = placeOf(app, first)
    for (let tick = 0; tick < 30; tick++) await app.mockMouse.scroll(10, place.top + 4, "down")
    // The view is at the other end; the selection did not move with it and is not in view.
    const scrolled = await renderUntilFrame(app, (frame) => shows(frame, "条目 30"), "the end of the list")
    expect(selectedTitle(scrolled)).toBeUndefined()

    // One step from the selected item, not from the place in the view: it is the second item, and it is in view.
    press(app, "down")
    const frame = await renderUntilFrame(app, (shown) => selectedTitle(shown) !== undefined, "the selected row in view")
    expect(selectedTitle(frame)).toBe("条目 2")
  } finally {
    app.renderer.destroy()
  }
})

test("an item that data moves out of view takes the view with it, and a group's heading comes along", async () => {
  await using tmp = await shellState()
  const [items, setItems] = createSignal(numbered(20))
  const app = await mountList(tmp.path, items, { height: 24, selectionKey: "keep" })
  try {
    await renderUntilFrame(app, (frame) => selectedTitle(frame) === "条目 1", "the first item")
    // The owner sends the first item to the end of the list. The selection follows it, and so does the view.
    setItems((current) => [...current.slice(1), current[0]])
    // The first item is selected before the update as well, so the wait is for the view that has gone to the end of the
    // list with it, not for the pointer alone.
    const frame = await renderUntilFrame(
      app,
      (shown) => selectedTitle(shown) === "条目 1" && shows(shown, "条目 20"),
      "the selected item in view at the end of the list",
    )
    expect(shows(frame, "条目 2")).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("moving to the first item of a group shows the heading of the group with it", async () => {
  await using tmp = await shellState()
  const groups = numbered(24, (index) => (index < 12 ? "甲组" : "乙组"))
  const app = await mountList(tmp.path, () => groups, { height: 24 })
  try {
    // The first item of the first group has its heading above it, and nothing above that but the title and the filter.
    const home = placeOf(
      app,
      await renderUntilFrame(app, (frame) => selectedTitle(frame) === "条目 1", "the first item"),
    )
    expect(home.lines[home.filterRow + 1]).toContain("甲组")

    press(app, "end")
    await renderUntilFrame(app, (frame) => selectedTitle(frame) === "条目 24", "the last item")
    // Up from the end, one step at a time, to the first item of the second group: the view only has to follow the row.
    for (let step = 0; step < 11; step++) press(app, "up")
    const frame = await renderUntilFrame(
      app,
      (shown) => selectedTitle(shown) === "条目 13" && shown.includes("乙组"),
      "the first item of 乙组, and its heading",
    )
    const lines = linesOf(frame)
    const row = lines.findIndex((line) => line.includes("› 条目 13"))
    expect(lines[row - 1]).toContain("乙组")

    // And back to the top: the heading of the first group is in view again.
    press(app, "home")
    const top = await renderUntilFrame(
      app,
      (shown) => selectedTitle(shown) === "条目 1" && shown.includes("甲组"),
      "the top",
    )
    expect(placeOf(app, top).lines[placeOf(app, top).filterRow + 1]).toContain("甲组")
  } finally {
    app.renderer.destroy()
  }
})

test("rows that data refreshes under are not mounted again: the same ids keep the same rows", async () => {
  await using tmp = await shellState()
  // Every refresh builds all the items anew, with the same ids; one more item may come, at the top of the first group.
  const [round, setRound] = createSignal(0)
  const [extra, setExtra] = createSignal(false)
  const items = () => [
    ...(extra() ? [{ id: "item-new", value: "item-new", title: "新条目", group: "甲组" }] : []),
    ...Array.from({ length: 6 }, (_, index): ListItem<string> => ({
      id: `item-${index}`,
      value: `item-${index}`,
      title: `条目 ${index + 1}`,
      trail: `第 ${round()} 次`,
      group: index < 3 ? "甲组" : "乙组",
    })),
  ]
  const app = await mountList(tmp.path, items, { height: 24 })
  const titles = ["条目 1", "条目 3", "条目 6"]
  try {
    await renderUntilFrame(app, (frame) => frame.includes("条目 6"), "the list")
    const before = titles.map((title) => rowNode(app, title))
    expect(before.every((row) => row !== undefined)).toBe(true)

    setRound(1)
    const frame = await renderUntilFrame(app, (shown) => shown.includes("第 1 次"), "the refreshed list")
    // Each row is the node it was, still alive, and its text is the refreshed one.
    for (const [index, row] of before.entries()) {
      expect(row?.isDestroyed).toBe(false)
      expect(titles.map((title) => rowNode(app, title))[index]).toBe(row)
    }
    expect(selectedTitle(frame)).toBe("条目 1")

    // An item that comes is the only row that is made: the others are the nodes they were.
    setExtra(true)
    await renderUntilFrame(app, (shown) => shown.includes("新条目"), "the new item")
    for (const [index, row] of before.entries()) {
      expect(row?.isDestroyed).toBe(false)
      expect(titles.map((title) => rowNode(app, title))[index]).toBe(row)
    }
  } finally {
    app.renderer.destroy()
  }
})
