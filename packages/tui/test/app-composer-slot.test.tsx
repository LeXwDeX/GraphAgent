// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { BoxRenderable, TextareaRenderable, type Renderable } from "@opentui/core"
import { setLanguage } from "../src/i18n"
import { DRAWER_WIDTH } from "../src/shell/drawer"
import { captureFrame, footerRow, runApp, waitForFrame, type Setup } from "./fixture/run-app"
import { directory } from "./fixture/tui-sdk"
import { sessionFixture } from "./routes/dag-mode-harness"

// The real app against a fake server: the input lives in the bottom zone's composer slot, between the main area
// and the footer, and neither the open drawer nor a panel takes it from there (#1032 D1).

const mainID = "ses_composer_main"

afterEach(() => {
  setLanguage("zh-CN")
})

function collect(root: Renderable, result: Renderable[] = []) {
  result.push(root)
  for (const child of root.getChildren()) collect(child, result)
  return result
}

/** Every prompt text area in the tree. The frame builds each slot once, so there is one. */
function textareas(setup: Setup) {
  return collect(setup.renderer.root).filter((item): item is TextareaRenderable => item instanceof TextareaRenderable)
}

function rowsOf(frame: string) {
  return frame.split("\n").map((line) => line.trimEnd())
}

/** Where the prompt is in a frame: its first row (the left border) and its command hint row. */
function composerSpan(frame: string) {
  const rows = rowsOf(frame)
  const first = rows.findIndex((row, index) => index > 2 && row.trimStart().startsWith("┃"))
  const hint = rows.findLastIndex((row) => row.includes("ctrl+p commands"))
  if (first < 0 || hint < first) throw new Error(`no composer in the frame:\n${frame}`)
  return { rows, first, hint }
}

function composerRows(frame: string) {
  const { rows, first, hint } = composerSpan(frame)
  return rows.slice(first, hint + 1)
}

/**
 * An unmounting prompt keeps a non-empty draft in module state for the next prompt in the process. Empty the
 * text areas before the app exits so a test does not hand its typing to whichever test mounts a prompt next.
 */
function clearDrafts(setup: Setup) {
  for (const input of textareas(setup)) if (!input.isDestroyed) input.setText("")
}

async function settled(setup: Setup) {
  await Bun.sleep(60)
  await setup.renderOnce()
  return captureFrame(setup)
}

test("the session prompt sits above the footer with one blank row between them", async () => {
  const app = await runApp({ sessions: [sessionFixture(mainID)], args: { continue: true }, width: 120, height: 30 })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("ctrl+p commands"), "the prompt hint")
    const frame = await settled(app.setup)
    const rows = rowsOf(frame)
    const footer = rows.findLastIndex((row) => row.length > 0)
    const hint = rows.findLastIndex((row) => row.includes("ctrl+p commands"))

    expect(footerRow(frame)).toContain("ctrl+p 命令")
    expect(footer - hint).toBe(2)
    expect(rows[hint + 1]).toBe("")
    // One prompt, drawn above the footer and below the top bar.
    const inputs = textareas(app.setup)
    expect(inputs).toHaveLength(1)
    expect(inputs[0].y).toBeLessThan(footer)
    expect(inputs[0].y).toBeGreaterThan(2)
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("an open drawer covers the main area and leaves every composer row as it was", async () => {
  const app = await runApp({ sessions: [sessionFixture(mainID)], args: { continue: true }, width: 140, height: 30 })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("ctrl+p commands"), "the prompt hint")
    const closed = await settled(app.setup)
    const before = composerRows(closed)
    // The hint row is right-aligned, so it sits under the drawer's columns: it is the row an overlay would hit.
    expect(before.at(-1)!.length).toBeGreaterThan(140 - DRAWER_WIDTH)

    app.setup.mockInput.pressKey("b", { ctrl: true })
    await waitForFrame(app.setup, (frame) => frame.includes("上下文"), "the drawer")
    const after = composerRows(await settled(app.setup))
    expect(after).toEqual(before)

    // The overlay ends where the main area ends: above the input, never beside or over it.
    const drawer = collect(app.setup.renderer.root).find(
      (item): item is BoxRenderable => item instanceof BoxRenderable && item.width === DRAWER_WIDTH && item.x > 0,
    )
    expect(drawer).toBeDefined()
    expect(drawer!.x + drawer!.width).toBe(140)
    expect(drawer!.y + drawer!.height).toBeLessThanOrEqual(textareas(app.setup)[0].y)

    app.setup.mockInput.pressKey("b", { ctrl: true })
    await waitForFrame(app.setup, (frame) => !frame.includes("上下文"), "the drawer closed")
    expect(composerRows(await settled(app.setup))).toEqual(before)
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("the home prompt sits above the footer, below the logo, at its capped width", async () => {
  const app = await runApp({ sessions: [sessionFixture(mainID)], args: {}, width: 120, height: 30 })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("ctrl+p commands"), "the prompt hint")
    const frame = await settled(app.setup)
    const { rows, first, hint } = composerSpan(frame)
    const footer = rows.findLastIndex((row) => row.length > 0)
    const logo = rows.findLastIndex((row) => row.includes("██"))

    expect(footer - hint).toBe(2)
    expect(logo).toBeGreaterThan(0)
    expect(logo).toBeLessThan(first)
    // The prompt keeps the width cap home gave it (75 columns by default) and stays centered.
    const edge = rows.find((row) => row.includes("╹▀"))!
    expect(edge.trimEnd().length - edge.indexOf("╹")).toBe(75)
    expect(Math.abs(edge.indexOf("╹") - (120 - 75) / 2)).toBeLessThanOrEqual(1)
    const inputs = textareas(app.setup)
    expect(inputs).toHaveLength(1)
    expect(inputs[0].y).toBeLessThan(footer)
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("the slash popup at home is drawn over the logo, not under it", async () => {
  const app = await runApp({ sessions: [sessionFixture(mainID)], args: {}, width: 100, height: 30 })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("ctrl+p commands"), "the prompt hint")
    await app.setup.mockInput.typeText("/")
    const frame = await waitForFrame(app.setup, (frame) => frame.includes("/agent"), "the command popup")
    const rows = rowsOf(frame)
    // At 100x30 the popup reaches up into the logo. A row where both are on screen shows the popup's text
    // whole, with logo glyphs on both sides of it.
    const overlap = rows.find((row) => row.includes("/config") && row.includes("█"))
    expect(overlap).toBeDefined()
    expect(overlap!.indexOf("█")).toBeLessThan(overlap!.indexOf("/config"))
    expect(overlap!.lastIndexOf("█")).toBeGreaterThan(overlap!.indexOf("/config"))
    expect(rows.find((row) => row.includes("/agent"))).toContain("┃ /agent")
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("a panel takes the composer's place, and the prompt returns with its draft and focus", async () => {
  const app = await runApp({ sessions: [sessionFixture(mainID)], args: { continue: true }, width: 120, height: 30 })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("ctrl+p commands"), "the prompt hint")
    const [input] = textareas(app.setup)
    await app.setup.mockInput.typeText("keep this draft")
    await waitForFrame(app.setup, (frame) => frame.includes("keep this draft"), "the typed draft")

    app.setup.mockInput.pressKey("p", { ctrl: true })
    const panel = await waitForFrame(app.setup, (frame) => !frame.includes("keep this draft"), "the command panel")
    expect(panel).not.toContain("ctrl+p commands")
    // The composer is hidden, not rebuilt: the same prompt is still mounted under the panel, holding the draft.
    expect(collect(app.setup.renderer.root)).toContain(input)
    expect(input.plainText).toBe("keep this draft")

    app.setup.mockInput.pressEscape()
    const back = await waitForFrame(app.setup, (frame) => frame.includes("keep this draft"), "the draft again")
    expect(back).toContain("ctrl+p commands")
    expect(textareas(app.setup)).toEqual([input])
    expect(app.setup.renderer.currentFocusedRenderable).toBe(input)

    await app.setup.mockInput.typeText("!")
    await waitForFrame(app.setup, (frame) => frame.includes("keep this draft!"), "typing after the panel")
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("a draft typed in a session follows the user home when the session goes away", async () => {
  const app = await runApp({ sessions: [sessionFixture(mainID)], args: { continue: true }, width: 120, height: 30 })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("ctrl+p commands"), "the prompt hint")
    await app.setup.mockInput.typeText("unsent words")
    await waitForFrame(app.setup, (frame) => frame.includes("unsent words"), "the typed draft")

    app.events.emit({
      directory,
      payload: {
        id: "evt_composer_deleted",
        type: "session.deleted",
        properties: { sessionID: mainID, info: sessionFixture(mainID) },
      },
    })
    const home = await waitForFrame(app.setup, (frame) => frame.includes("██"), "the home logo")
    expect(textareas(app.setup)).toHaveLength(1)
    await waitForFrame(app.setup, (frame) => frame.includes("unsent words"), "the draft on home")
    expect(home).toContain("ctrl+p commands")
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})
