// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import type { GlobalEvent, Goal } from "@graphagent/sdk"
import { setLanguage } from "../../../src/i18n"
import { captureFrame, promptShown, promptTop, runApp, waitForFrame, type Setup } from "../../fixture/run-app"
import { assistantMessage, textPart, userMessage, type MessageEntry } from "../../fixture/session-records"
import { directory, json, type FetchHandler } from "../../fixture/tui-sdk"
import { sessionFixture } from "../dag-mode-harness"

/**
 * A transcript that does not fill the screen stands on the bottom of the main area, against the status band or the
 * input, the way the prototype draws it (#1615 PR C). The scroll box gives its content box the height of its viewport
 * at least and puts the content at the end of it (`contentOptions`), so a short session has nothing to scroll, and a
 * session that fills the screen is laid out exactly as it was: the content box is as tall as its content, and the
 * scroll box follows the end the way it did.
 */

afterEach(() => {
  setLanguage("zh-CN")
})

const ID = "ses_short_main"

/** The server's side: the messages of the session, and nothing else. */
function served(entries: readonly MessageEntry[]): FetchHandler {
  return (url) => (url.pathname === `/session/${ID}/message` ? json(entries) : undefined)
}

/** A question and its answer, one line each. */
function turn(index: number): MessageEntry[] {
  const asked = userMessage(`msg_u${index}`, ID, index * 10 + 1)
  const answered = assistantMessage(`msg_a${index}`, ID, asked.id, index * 10 + 2)
  return [
    { info: asked, parts: [textPart(asked.id, ID, `prt_q${index}`, `question ${index}`)] },
    { info: answered, parts: [textPart(answered.id, ID, `prt_t${index}`, `answer ${index}`)] },
  ]
}

const rowsOf = (frame: string) => frame.split("\n").map((line) => line.trimEnd())

/** A frame that has been given the time its text needs: the markdown of a reply is drawn after the row is. */
async function settled(setup: Setup) {
  await Bun.sleep(60)
  await setup.renderOnce()
  return captureFrame(setup)
}

function collect(root: Renderable, result: Renderable[] = []) {
  result.push(root)
  for (const child of root.getChildren()) collect(child, result)
  return result
}

function transcriptOf(setup: Setup) {
  const scroll = collect(setup.renderer.root).find(
    (item): item is ScrollBoxRenderable => item instanceof ScrollBoxRenderable,
  )
  if (!scroll) throw new Error("no scroll box in the tree")
  return scroll
}

/** The row of the last line of text above the input or the band: where the transcript ends. */
function lastLineAbove(rows: readonly string[], edge: number) {
  return rows.findLastIndex((row, index) => index < edge && row.trim().length > 0)
}

const GOAL: Goal = { goal: "全部依赖升到最新稳定版并通过 CI", status: "active", turnsUsed: 6, maxTurns: 30 }

function event(id: string, type: string, properties: Record<string, unknown>): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  return { directory, payload: { id, type, properties } } as GlobalEvent
}

test("three short messages stand on the input, with the blank row of the main area between them and it", async () => {
  const entries = [...turn(0), turn(1)[0]]
  const app = await runApp({
    sessions: [sessionFixture(ID)],
    args: { sessionID: ID },
    width: 100,
    height: 34,
    handler: served(entries),
  })
  try {
    await waitForFrame(
      app.setup,
      (frame) => frame.includes("question 1") && frame.includes("answer 0") && promptShown(frame),
      "the transcript and the input",
    )
    const rows = rowsOf(await settled(app.setup))
    const input = promptTop(rows)
    const first = rows.findIndex((row) => row.includes("question 0"))
    const last = rows.findIndex((row) => row.includes("question 1"))

    // The next row under the last message is the input's top edge, or the one blank row the main area keeps under it.
    expect(input - last).toBeGreaterThan(0)
    expect(input - last).toBeLessThanOrEqual(2)
    expect(rows[input - 1]).toBe("")
    // The three messages stand together, a blank row between each, and nothing is under the last of them but that row.
    expect(rows.slice(first, last + 1).map((row) => row.trim())).toEqual([
      "› question 0",
      "",
      "⏺ answer 0",
      "",
      "› question 1",
    ])
    // Above them the main area is empty down to the top bar: nothing of the session is up there.
    expect(rows.slice(1, first).every((row) => row === "")).toBe(true)
    // And no row closes the turn: the answer is the end of it.
    expect(rows.join("\n")).not.toContain("▣")
  } finally {
    await app.stop()
  }
})

test("a goal in the status band is what the last message stands on, and the messages go up by its row", async () => {
  const entries = [...turn(0), turn(1)[0]]
  const app = await runApp({
    sessions: [sessionFixture(ID)],
    args: { sessionID: ID },
    width: 100,
    height: 34,
    handler: served(entries),
  })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("question 1") && promptShown(frame), "the transcript")
    const before = rowsOf(await settled(app.setup))
    const lastBefore = before.findIndex((row) => row.includes("question 1"))

    app.events.emit(event("evt_short_goal", "goal.updated", { sessionID: ID, goal: GOAL }))
    await waitForFrame(app.setup, (frame) => frame.includes("◎ 目标"), "the goal row")
    const rows = rowsOf(await settled(app.setup))
    const band = rows.findIndex((row) => row.includes("◎ 目标"))
    const last = rows.findIndex((row) => row.includes("question 1"))

    expect(band - last).toBeGreaterThan(0)
    expect(band - last).toBeLessThanOrEqual(2)
    // The band took a row of the main area, and the messages stayed on the bottom of what is left of it.
    expect(promptTop(rows) - band).toBe(1)
    expect(last).toBe(lastBefore - 1)
  } finally {
    await app.stop()
  }
})

test("a session that fills the screen is laid out as a scroll box follows its end: the content is as tall as it is", async () => {
  const turns = 12
  const entries = Array.from({ length: turns }, (_, index) => turn(index)).flat()
  const app = await runApp({
    sessions: [sessionFixture(ID)],
    args: { sessionID: ID },
    width: 100,
    height: 34,
    handler: served(entries),
  })
  try {
    await waitForFrame(
      app.setup,
      (frame) => frame.includes(`answer ${turns - 1}`) && promptShown(frame),
      "the end of the transcript",
    )
    const rows = rowsOf(await settled(app.setup))
    const scroll = transcriptOf(app.setup)
    const view = scroll.viewport

    // The rows of the content, from the top: a row of gap, the first question, then a blank row and a line for each of
    // the other messages. A min-height that added a row to it would show here.
    const content = [""]
    for (let index = 0; index < turns; index++) {
      if (index > 0) content.push("")
      content.push(`› question ${index}`, "", `⏺ answer ${index}`)
    }
    expect(scroll.scrollHeight).toBe(content.length)
    expect(scroll.scrollHeight).toBeGreaterThan(view.height)
    // At the end, with the last line of the content on the last row of the viewport.
    expect(scroll.scrollTop).toBe(scroll.scrollHeight - view.height)
    expect(rows.slice(view.y, view.y + view.height).map((row) => row.trim())).toEqual(content.slice(-view.height))
    // The input is where it is under a short session.
    expect(promptTop(rows) - lastLineAbove(rows, promptTop(rows))).toBe(2)
  } finally {
    await app.stop()
  }
})

test("a session that grows past the screen stays on the same row all the way, and follows its end after that", async () => {
  const app = await runApp({
    sessions: [sessionFixture(ID)],
    args: { sessionID: ID },
    width: 100,
    height: 34,
    handler: served([...turn(0)]),
  })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("answer 0") && promptShown(frame), "the first turn")
    const scroll = transcriptOf(app.setup)
    const first = rowsOf(await settled(app.setup))
    const resting = promptTop(first) - lastLineAbove(first, promptTop(first))
    expect(resting).toBe(2)

    let sequence = 0
    const places: number[] = []
    const heights: number[] = []
    for (let index = 1; index <= 9; index++) {
      for (const entry of turn(index)) {
        app.events.emit(event(`evt_short_${++sequence}`, "message.updated", { sessionID: ID, info: entry.info }))
        for (const part of entry.parts) {
          app.events.emit(
            event(`evt_short_${++sequence}`, "message.part.updated", { sessionID: ID, time: sequence, part }),
          )
        }
      }
      const rows = rowsOf(
        await waitForFrame(app.setup, (frame) => frame.includes(`answer ${index}`), `turn ${index}`).then(() =>
          settled(app.setup),
        ),
      )
      places.push(promptTop(rows) - lastLineAbove(rows, promptTop(rows)))
      heights.push(scroll.scrollHeight - scroll.viewport.height)
    }

    // The last line of the transcript never left its row: not while the session had room, not as it ran out of it, and
    // not once the scroll box had to follow the end.
    expect(new Set(places)).toEqual(new Set([resting]))
    // The session did run out of room: the scroll box ends up with an offset to follow.
    expect(heights[0]).toBeLessThanOrEqual(0)
    expect(heights.at(-1)).toBeGreaterThan(0)
    expect(scroll.scrollTop).toBe(scroll.scrollHeight - scroll.viewport.height)
  } finally {
    await app.stop()
  }
}, 60_000)
