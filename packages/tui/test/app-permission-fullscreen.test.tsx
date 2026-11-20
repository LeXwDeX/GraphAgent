// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import type { GlobalEvent } from "@graphagent/sdk"
import { setLanguage } from "../src/i18n"
import { cellWidth, type AmbiguousWidth } from "../src/ui/width"
import { promptShown, runApp, waitFor } from "./fixture/run-app"
import { renderUntilFrame } from "./fixture/frames"
import { directory, json, type FetchHandler } from "./fixture/tui-sdk"
import { sessionFixture } from "./routes/dag-mode-harness"

// The fullscreen permission ask (`ctrl+f`) in the real app against a fake server (#1662). The ask used to leave the
// bottom zone for a `Portal`, whose container is a box in the flow of the root: laid out after the app, which is as
// tall as the terminal, it sat below the last row, and the whole frame came out empty. `renderAppPanel` and
// `mountSessionShell` showed the same in their own ways; the permission-shell tests cover the panel itself.

afterEach(() => setLanguage("zh-CN"))

type Language = "zh-CN" | "en"
const LANGUAGES: readonly Language[] = ["zh-CN", "en"]

const sessionID = "ses_ask_fullscreen"
const requestID = "per_000000000001"
/** A second request, for the run that answers one ask and meets the next. */
const nextRequestID = "per_000000000002"

/** A diff of 40 rows, more than any of the terminals below can show: 6 lines of context, 14 removed, 14 added, 6 of context. */
const LONG_DIFF = [
  "Index: src/app.ts",
  "===================================================================",
  "--- src/app.ts",
  "+++ src/app.ts",
  "@@ -1,26 +1,26 @@",
  ...Array.from({ length: 6 }, (_, index) => ` const keep${index + 1} = ${index + 1}`),
  ...Array.from({ length: 14 }, (_, index) => `-  old${index + 1}()`),
  ...Array.from({ length: 14 }, (_, index) => `+  new${index + 1}()`),
  ...Array.from({ length: 6 }, (_, index) => ` const tail${index + 1} = ${index + 1}`),
  "",
].join("\n")

/** What the ask says, by language: the title, the three options of a request from the root, and what its hint row starts with. */
const TEXT: Record<Language, { title: string; options: string[]; hint: string }> = {
  "zh-CN": {
    title: "Edit 需要权限",
    options: ["1. 允许这一次", "2. 本会话内都允许 src/*", "3. 拒绝，并告诉 agent 怎么做"],
    hint: "或数字键选择",
  },
  en: {
    title: "Edit needs permission",
    options: ["1. Allow once", "2. Allow src/* for this session", "3. Reject, and tell the agent what to do instead"],
    hint: "or number keys to pick",
  },
}

/** The terminals the ask is laid out for, and the rows of the diff the fullscreen ask has in each: the terminal less 12. */
const SIZES = [
  { width: 80, height: 24, diffRows: 12 },
  { width: 120, height: 40, diffRows: 28 },
] as const

/** The edit request, as the server sends it: a path and the diff of the change. */
function editAsk(id = requestID): GlobalEvent {
  return {
    directory,
    payload: {
      id: `evt_ask_${id}`,
      type: "permission.asked",
      properties: {
        id,
        sessionID,
        permission: "edit",
        patterns: ["src/app.ts"],
        metadata: { filepath: "src/app.ts", diff: LONG_DIFF },
        always: ["src/*"],
      },
    },
  }
}

/** The thumb of a scroll bar is drawn with block characters, ambiguous in width; the panel lays the bar out as one cell. */
const SCROLL_THUMB = /[█▀▄]/g

/** The numbered lines of a diff, and the lines of the options, inside the borders of a panel. */
const DIFF_ROW = /^│ +\d+ [-+ ]/
const OPTION_ROW = /^│ [› ] \d\. /

/** The text between the borders of one line. */
const inside = (line: string) => line.slice(1, -1)

/** The rows of a frame: `captureCharFrame` ends the last one with a line break. */
const rowsOf = (frame: string, height: number) => frame.split("\n").slice(0, height)

interface Setup {
  language: Language
  width: number
  height: number
  ambiguousWidth?: AmbiguousWidth
}

type App = Awaited<ReturnType<typeof runApp>>

/**
 * Runs the real app on a session, lets the server ask for an edit and hands the run to `body` once the ask is on screen
 * and no longer changes. A reply to the ask is answered with an empty body, which is all the app needs of it.
 */
async function withAsk<T>(options: Setup, body: (app: App, ordinary: string) => Promise<T>) {
  const reads: string[] = []
  const handler: FetchHandler = (url) => {
    reads.push(url.pathname)
    if (options.language === "en" && url.pathname === "/config") return json({ language: "en" })
    if (/^\/permission\/[^/]+\/reply$/.test(url.pathname)) return json({})
    return undefined
  }
  const app = await runApp({
    sessions: [sessionFixture(sessionID)],
    args: { sessionID },
    width: options.width,
    height: options.height,
    ambiguousWidth: options.ambiguousWidth,
    handler,
  })
  try {
    await renderUntilFrame(app.setup, promptShown, "the prompt")
    await waitFor(() => reads.includes(`/session/${sessionID}/message`))
    app.events.emit(editAsk())
    await renderUntilFrame(app.setup, (frame) => frame.includes(TEXT[options.language].title), "the ask")
    return await body(app, await settled(app))
  } finally {
    await leave(app)
  }
}

/** The server's word that the ask is answered, which takes it off the queue. */
function repliedAsk(id = requestID): GlobalEvent {
  return {
    directory,
    payload: {
      id: `evt_replied_${id}`,
      type: "permission.replied",
      properties: { sessionID, requestID: id, reply: "once" },
    },
  }
}

/**
 * The quit key of the app rejects a pending ask instead of quitting, so the server answers the ask first; without that
 * `stop` waits out its timeout for an exit that never comes.
 */
async function leave(app: App) {
  for (const id of [requestID, nextRequestID]) app.events.emit(repliedAsk(id))
  await renderUntilFrame(app.setup, promptShown, "the prompt once the ask is answered").catch(() => {
    // `stop` closes the app all the same, and a failing test is to report its own error, not this wait's.
  })
  await app.stop()
}

/** The first frame that no later render changes. */
async function settled(app: App) {
  let last = ""
  return renderUntilFrame(
    app.setup,
    (frame) => {
      const unchanged = frame === last && frame.trim().length > 0
      last = frame
      return unchanged
    },
    "a frame that stops changing",
  )
}

/** Presses `ctrl+f` and waits for the frame in which the fullscreen ask is up, or, with `back`, the ordinary one. */
async function toggleFullscreen(app: App, height: number, back = false) {
  app.setup.mockInput.pressKey("f", { ctrl: true })
  // The fullscreen ask keeps one blank row above its panel; the ordinary one sits at the bottom, above the footer.
  const up = (frame: string) => (rowsOf(frame, height)[1] ?? "").startsWith("╭")
  await renderUntilFrame(app.setup, (frame) => up(frame) !== back, back ? "the ordinary ask" : "the fullscreen ask")
  return settled(app)
}

for (const language of LANGUAGES) {
  for (const { width, height, diffRows } of SIZES) {
    for (const ambiguousWidth of [1, 2] as const) {
      test(`ctrl+f puts the ask over the whole terminal inside its border, and ctrl+f again puts it back, ${language}, ${width}x${height}, ambiguous_width ${ambiguousWidth}`, async () => {
        await withAsk({ language, width, height, ambiguousWidth }, async (app, ordinary) => {
          const text = TEXT[language]
          // The ask starts in the bottom zone, under the main area and above the footer.
          expect(rowsOf(ordinary, height)[1]?.startsWith("╭")).toBe(false)

          const full = await toggleFullscreen(app, height)
          const rows = rowsOf(full, height)
          expect(rows.length).toBe(height)
          // A blank row above and below the panel, and the panel between them with its border whole.
          expect(rows[0].trim()).toBe("")
          expect(rows[height - 1].trim()).toBe("")
          expect(rows[1].startsWith("╭") && rows[1].endsWith("╮")).toBe(true)
          expect(rows[height - 2].startsWith("╰") && rows[height - 2].endsWith("╯")).toBe(true)
          const panel = rows.slice(1, height - 1)
          for (const row of panel.slice(1, -1)) {
            expect({ row, whole: row.startsWith("│") && row.endsWith("│") }).toEqual({ row, whole: true })
            // Nothing is laid out wider than the border: the frame has no room for a cell more.
            const fits = cellWidth(inside(row).replace(SCROLL_THUMB, "#").trimEnd(), ambiguousWidth) <= width - 2
            expect({ row, fits }).toEqual({ row, fits: true })
          }
          // The title, the diff from its first row, the three options and the hint row, in view together.
          expect(panel[1]).toContain(text.title)
          expect(panel.filter((row) => DIFF_ROW.test(row)).length).toBe(diffRows)
          expect(panel.find((row) => DIFF_ROW.test(row))).toContain("const keep1")
          expect(panel.filter((row) => OPTION_ROW.test(row)).length).toBe(3)
          for (const option of text.options)
            expect({ option, found: full.includes(option) }).toEqual({ option, found: true })
          // The hint row is cut to the width of the panel, as the ordinary ask's is; the key that brings the ordinary ask
          // back is always named, in the key symbols the hints use (#1619).
          expect(panel.at(-2)).toContain(text.hint)
          expect(panel.at(-2)).toContain("⌃F")
          // The app behind it is covered: the top bar and the footer are not on screen.
          expect(full).not.toContain("GraphAgent")
          if (ambiguousWidth === 1) expect(full).toMatchSnapshot()

          // The same key brings the ordinary ask back, as it was.
          expect(await toggleFullscreen(app, height, true)).toBe(ordinary)
          // Neither way sends the server anything.
          expect(app.writes()).toEqual([])
        })
      })
    }
  }
}

test("the diff of the fullscreen ask scrolls inside its area to its last row, and the options and the hint row stay", async () => {
  await withAsk({ language: "zh-CN", width: 80, height: 24 }, async (app) => {
    const before = await toggleFullscreen(app, 24)
    const row = rowsOf(before, 24).findIndex((line) => line.includes("const keep1"))
    expect(row).toBeGreaterThan(0)
    expect(before).not.toContain("const tail6")
    for (let tick = 0; tick < 30; tick++) await app.setup.mockMouse.scroll(10, row, "down")
    const after = await renderUntilFrame(
      app.setup,
      (frame) => frame.includes("const tail6"),
      "the last row of the diff",
    )
    expect(after).not.toContain("const keep1")
    // The diff moved and nothing around it did: the same panel, the options on the rows they had, the hint row in view.
    const rows = (frame: string) => rowsOf(frame, 24)
    expect(rows(after).filter((line) => OPTION_ROW.test(line))).toEqual(
      rows(before).filter((line) => OPTION_ROW.test(line)),
    )
    expect(rows(after).filter((line) => DIFF_ROW.test(line)).length).toBe(12)
    expect(rows(after)[1]).toBe(rows(before)[1])
    expect(rows(after).at(-3)).toBe(rows(before).at(-3))
    expect(app.writes()).toEqual([])
  })
})

const replyTo = (id: string, reply: string) => ({ method: "POST", path: `/permission/${id}/reply`, body: { reply } })

test("the options of the fullscreen ask answer as those of the ordinary one do, and an answered ask leaves no layer behind", async () => {
  await withAsk({ language: "zh-CN", width: 80, height: 24 }, async (app) => {
    // By key.
    await toggleFullscreen(app, 24)
    app.setup.mockInput.pressKey("1")
    await waitFor(() => app.writes().length === 1)
    expect(app.writes()).toEqual([replyTo(requestID, "once")])
    // The server's word that it is answered takes the ask off the queue, and the layer with it: the app is back, with
    // its top bar and its prompt, and nothing of the fullscreen ask is left over it.
    app.events.emit(repliedAsk())
    const after = await renderUntilFrame(app.setup, promptShown, "the app once the ask is answered")
    expect(after).toContain("GraphAgent")
    expect(after).not.toContain(TEXT["zh-CN"].title)

    // By click, on the next ask: the layer that carries it takes the mouse as the panel did.
    app.events.emit(editAsk(nextRequestID))
    await renderUntilFrame(app.setup, (frame) => frame.includes(TEXT["zh-CN"].title), "the next ask")
    const full = await toggleFullscreen(app, 24)
    const row = rowsOf(full, 24).findIndex((line) => line.includes("2. 本会话内都允许"))
    expect(row).toBeGreaterThan(0)
    await app.setup.mockMouse.click(8, row)
    await waitFor(() => app.writes().length === 2)
    expect(app.writes()[1]).toEqual(replyTo(nextRequestID, "always"))
  })
})
