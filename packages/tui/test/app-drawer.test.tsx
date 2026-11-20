// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import type { Goal, GlobalEvent } from "@graphagent/sdk"
import { TextRenderable, type Renderable } from "@opentui/core"
import { setLanguage } from "../src/i18n"
import { DRAWER_WIDTH } from "../src/shell/drawer"
import { captureFrame, runApp, waitForFrame, type Setup } from "./fixture/run-app"
import { directory } from "./fixture/tui-sdk"
import { sessionFixture } from "./routes/dag-mode-harness"

/**
 * The drawer in the real app (#1032 5.1): hidden by default and never opened by the old `sidebar` value; the toggle
 * key, `/sidebar`, `esc` and a click beside it close it; `drawer_mode` decides whether it opens on its own, `auto` by
 * the live width; the user's own toggle lives in memory only. It overlays the main area, so nothing left of it moves.
 */

afterEach(() => {
  setLanguage("zh-CN")
})

const mainID = "ses_drawer_main"
const childID = "ses_drawer_sub"
const sessions = [sessionFixture(mainID, { title: "主会话" }), sessionFixture(childID, { parentID: mainID })]

/** A heading only the drawer draws. */
const DRAWER_MARK = "上下文"

const isOpen = (frame: string) => frame.includes(DRAWER_MARK)

function rowsOf(frame: string) {
  return frame.split("\n")
}

/**
 * Key presses, clicks and resizes reach the drawer's signals synchronously, so a few renders show their effect; no
 * wall-clock wait is needed to see that something did not change.
 */
async function settled(setup: Setup) {
  for (let pass = 0; pass < 3; pass++) await setup.renderOnce()
  return captureFrame(setup)
}

async function ready(setup: Setup) {
  await waitForFrame(setup, (frame) => frame.includes("⌃B 侧边栏"), "the footer")
  return settled(setup)
}

function collect(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap((child) => collect(child))]
}

/** Text nodes of the drawer's sections that are mounted; zero while the drawer is closed. */
function drawerSections(setup: Setup) {
  return collect(setup.renderer.root).filter(
    (item) => item instanceof TextRenderable && !item.isDestroyed && item.plainText.includes(DRAWER_MARK),
  ).length
}

let sequence = 0
function event(type: string, properties: Record<string, unknown>): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return { directory, payload: { id: `evt_app_drawer_${++sequence}`, type, properties } } as GlobalEvent
}

test("hidden by default on a wide terminal, whatever the old sidebar value says", async () => {
  const app = await runApp({ sessions, args: { continue: true }, width: 200, height: 30, kv: { sidebar: "auto" } })
  try {
    const frame = await ready(app.setup)
    expect(isOpen(frame)).toBe(false)
    expect(drawerSections(app.setup)).toBe(0)
  } finally {
    await app.stop()
  }
})

test("the toggle key opens it over the right 40 columns without moving anything left of it", async () => {
  const app = await runApp({ sessions, args: { continue: true }, width: 140, height: 30 })
  try {
    const closed = await ready(app.setup)
    app.setup.mockInput.pressKey("b", { ctrl: true })
    const open = await waitForFrame(app.setup, isOpen, "the drawer")
    const left = (frame: string) => rowsOf(frame).map((row) => row.slice(0, 140 - DRAWER_WIDTH))
    expect(left(await settled(app.setup))).toEqual(left(closed))
    // The drawer's own column starts right where the main area's free columns end.
    const row = rowsOf(open).find((line) => line.includes(DRAWER_MARK))!
    expect(row.indexOf(DRAWER_MARK)).toBeGreaterThanOrEqual(140 - DRAWER_WIDTH)
    // The toggle wrote no policy: `drawer_mode` is the user's setting, not the drawer's state.
    expect(app.kv().drawer_mode).toBeUndefined()

    app.setup.mockInput.pressKey("b", { ctrl: true })
    await waitForFrame(app.setup, (frame) => !isOpen(frame), "the drawer closed")
    expect(app.kv().drawer_mode).toBeUndefined()
    expect(app.writes()).toEqual([])
  } finally {
    await app.stop()
  }
})

test("esc, /sidebar and a click beside it close it; a click that selected text does not", async () => {
  const app = await runApp({ sessions, args: { continue: true }, width: 140, height: 30 })
  try {
    await ready(app.setup)
    const open = async () => {
      app.setup.mockInput.pressKey("b", { ctrl: true })
      await waitForFrame(app.setup, isOpen, "the drawer")
    }
    const closed = () => waitForFrame(app.setup, (frame) => !isOpen(frame), "the drawer closed")

    await open()
    app.setup.mockInput.pressEscape()
    await closed()

    await open()
    await app.setup.mockInput.typeText("/sidebar")
    await waitForFrame(app.setup, (frame) => frame.includes("/sidebar"), "the command")
    app.setup.mockInput.pressEnter()
    await closed()

    await open()
    // A press that ends with text selected is a selection, not a click on the backdrop.
    const renderer = app.setup.renderer
    const original = renderer.getSelection.bind(renderer)
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test double: the frame reads only getSelectedText.
    renderer.getSelection = (() => ({ getSelectedText: () => "选中的字" })) as typeof renderer.getSelection
    await app.setup.mockMouse.click(10, 5)
    await settled(app.setup)
    expect(isOpen(await captureFrame(app.setup))).toBe(true)
    renderer.getSelection = original

    await app.setup.mockMouse.click(10, 5)
    await closed()
    // A click inside the drawer is not a click beside it.
    await open()
    await app.setup.mockMouse.click(140 - DRAWER_WIDTH + 5, 5)
    await settled(app.setup)
    expect(isOpen(await captureFrame(app.setup))).toBe(true)
    expect(app.writes()).toEqual([])
  } finally {
    await app.stop()
  }
})

test("auto opens it while the terminal is wider than 120, following resizes", async () => {
  const app = await runApp({ sessions, args: { continue: true }, width: 200, height: 30, kv: { drawer_mode: "auto" } })
  try {
    await waitForFrame(app.setup, isOpen, "the drawer at 200 columns")
    app.setup.resize(100, 30)
    await waitForFrame(app.setup, (frame) => !isOpen(frame), "no drawer at 100 columns")
    app.setup.resize(121, 30)
    await waitForFrame(app.setup, isOpen, "the drawer at 121 columns")
    app.setup.resize(120, 30)
    await waitForFrame(app.setup, (frame) => !isOpen(frame), "no drawer at 120 columns")
  } finally {
    await app.stop()
  }
})

test("a manual close holds for the run against auto, until the policy is chosen again", async () => {
  const app = await runApp({ sessions, args: { continue: true }, width: 200, height: 30, kv: { drawer_mode: "auto" } })
  try {
    await waitForFrame(app.setup, isOpen, "the drawer")
    app.setup.mockInput.pressKey("b", { ctrl: true })
    await waitForFrame(app.setup, (frame) => !isOpen(frame), "closed by hand")
    app.setup.resize(100, 30)
    await settled(app.setup)
    app.setup.resize(200, 30)
    await settled(app.setup)
    expect(isOpen(await captureFrame(app.setup))).toBe(false)
    expect(app.kv().drawer_mode).toBe("auto")
  } finally {
    await app.stop()
  }
})

test("always opens it on a narrow terminal, hidden keeps it shut on a wide one", async () => {
  const always = await runApp({
    sessions,
    args: { continue: true },
    width: 100,
    height: 30,
    kv: { drawer_mode: "always" },
  })
  try {
    await waitForFrame(always.setup, isOpen, "the drawer at 100 columns")
  } finally {
    await always.stop()
  }
  const hidden = await runApp({
    sessions,
    args: { continue: true },
    width: 200,
    height: 30,
    kv: { drawer_mode: "hidden" },
  })
  try {
    expect(isOpen(await ready(hidden.setup))).toBe(false)
  } finally {
    await hidden.stop()
  }
})

test("a sub-agent session has the drawer: its own sections, the root session's goal, no mode line", async () => {
  const goal: Goal = { goal: "根会话的目标", status: "active", turnsUsed: 2, maxTurns: 10 }
  const app = await runApp({ sessions, args: { sessionID: childID }, width: 140, height: 40 })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("⌃B"), "the footer")
    app.events.emit(event("goal.updated", { sessionID: mainID, goal }))
    app.events.emit(
      event("todo.updated", {
        sessionID: childID,
        todos: [{ content: "子会话的待办", status: "pending", priority: "high" }],
      }),
    )
    app.events.emit(
      event("todo.updated", {
        sessionID: mainID,
        todos: [{ content: "主会话的待办", status: "pending", priority: "high" }],
      }),
    )
    app.setup.mockInput.pressKey("b", { ctrl: true })
    const frame = await waitForFrame(
      app.setup,
      (value) => value.includes("根会话的目标") && value.includes("子会话的待办"),
      "the goal and the todo",
    )
    expect(frame).not.toContain("主会话的待办")
    expect(frame).not.toContain("DAG 模式")
    // esc closes the drawer before it leaves the sub-agent session.
    app.setup.mockInput.pressEscape()
    const after = await waitForFrame(app.setup, (value) => !isOpen(value), "the drawer closed")
    expect(after).not.toContain("主会话的待办")
  } finally {
    await app.stop()
  }
})
