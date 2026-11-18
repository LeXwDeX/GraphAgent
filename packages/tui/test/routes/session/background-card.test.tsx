// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import type { Session, TextPart } from "@graphagent/sdk"
import { DEFAULT_THEME } from "../../../src/context/theme"
import { setLanguage } from "../../../src/i18n"
import { estimateRowHeight, WINDOW_MIN_ROWS } from "../../../src/routes/session/rows"
import { DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { cellWidth } from "../../../src/ui/width"
import { AppRoutes } from "../../fixture/route-frame"
import {
  assistantMessage,
  taskCall,
  textPart,
  userMessage,
  type MessageEntry as Entry,
} from "../../fixture/session-records"
import { json, type FetchHandler } from "../../fixture/tui-sdk"
import { mountRoute, sessionFixture, waitFor, type MountOptions } from "../dag-mode-harness"

/**
 * The card of a finished background run (#1058): the result message the server adds to the session when a run ends is
 * drawn where it sits, two lines closed and the whole result as markdown open, and a click on it opens the sub-agent.
 */

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

const palette = () => resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")

const ROOT = "ses_card_root"
const START = 1_000_000
const root = sessionFixture(ROOT, { title: "root", time: { created: 1, updated: 2 } })
const childID = (key: string) => `ses_card_${key}`
const child = (key: string) =>
  sessionFixture(childID(key), {
    parentID: ROOT,
    title: key,
    agent: "explore",
    time: { created: 1_000, updated: 2_000 },
  })

type Status = "completed" | "error" | "interrupted"
type Run = {
  key: string
  status: Status
  body: string
  /** No Task call started this run in the transcript, so no link says what kind of agent it was. */
  orphan?: boolean
}

/** A result with a body of several lines: it folds. */
const LONG = "Found 3 issues in src/a.ts\n\n- first finding\n- second finding\n\n**final word**"
/** A result that is one short line: it has nothing to open. */
const SHORT = "All clear."
const INTERRUPTED =
  'The background task was interrupted before it finished, so it left no result. If its work is still needed, continue it with task_id="ses_card_cut".'

const RUNS: Run[] = [
  { key: "done", status: "completed", body: LONG },
  { key: "short", status: "completed", body: SHORT },
  { key: "failed", status: "error", body: "boom: connection refused\nat run (task.ts:42)" },
  { key: "cut", status: "interrupted", body: INTERRUPTED },
]

/** What the server writes into the text of the result message (`renderTask` of the task notice). */
function notice(run: Run) {
  const verb = { completed: "completed", error: "failed", interrupted: "interrupted" }[run.status]
  const tag = run.status === "completed" ? "task_result" : "task_error"
  return [
    `<task id="${childID(run.key)}" state="${run.status === "completed" ? "completed" : "error"}">`,
    `<summary>Background task ${verb}: Scan ${run.key}</summary>`,
    `<${tag}>`,
    run.body,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

/** The text part of the message the server adds to the parent session when the run ends. */
function resultPart(run: Run, metadata = true): TextPart {
  return {
    id: `prt_card_result_${run.key}`,
    sessionID: ROOT,
    messageID: `msg_card_result_${run.key}`,
    type: "text",
    synthetic: true,
    text: notice(run),
    ...(metadata
      ? {
          metadata: {
            backgroundResult: {
              childSessionID: childID(run.key),
              initiator: "agent",
              title: `Scan ${run.key}`,
              status: run.status,
              startedAt: START,
              endedAt: START + 65_000,
            },
          },
        }
      : {}),
  }
}

/** The Task call that started the run; its description is `Scan <key>`. */
const task = (run: Run) =>
  taskCall({
    parentID: ROOT,
    messageID: "msg_card_assistant",
    id: `prt_card_${run.key}`,
    childID: childID(run.key),
    description: `Scan ${run.key}`,
    background: true,
    initiator: "agent",
    start: START,
  })

/** The text the server leaves for the model after a command, which has no metadata and is not shown. */
const SUMMARIZE = "Summarize the task tool output above and continue with your task."

function syntheticMessage(id: string, text: string, created: number): Entry {
  return {
    info: userMessage(id, ROOT, created),
    parts: [{ id: `prt_${id}`, sessionID: ROOT, messageID: id, type: "text", synthetic: true, text }],
  }
}

/** Assistant messages enough for the transcript to be taller than a short terminal, or to be windowed. */
function bulk(messages: number, perMessage: number, label = "bulk"): Entry[] {
  return Array.from({ length: messages }, (_, index) => {
    const id = `msg_card_${label}_${index}`
    return {
      info: assistantMessage(id, ROOT, "msg_card_user", 15 + index / 100),
      parts: Array.from({ length: perMessage }, (_, part) =>
        textPart(id, ROOT, `prt_card_${label}_${index}_${part}`, `${label} ${index}.${part}`),
      ),
    }
  })
}

/** Answers the job-state read the data layer makes for the Task calls it finds; none of them has a state. */
const lifecycle: FetchHandler = async (url, request) => {
  if (url.pathname !== "/lifecycle/states") return undefined
  const body: unknown = await request?.json()
  const refs = typeof body === "object" && body !== null && "refs" in body && Array.isArray(body.refs) ? body.refs : []
  return json(refs.map((ref: { domain: string; id: string }) => ({ domain: ref.domain, id: ref.id, state: null })))
}

type Options = {
  runs?: Run[]
  language?: "zh-CN" | "en"
  ambiguousWidth?: 1 | 2
  width?: number
  height?: number
  keybinds?: MountOptions["keybinds"]
  /** Messages after the prompt and before the Task calls: where a transcript long enough to scroll or window goes. */
  before?: Entry[]
  /** Messages after the results. */
  after?: Entry[]
  /** Results that have the text of one and not the metadata. */
  unmarked?: Run[]
  handler?: FetchHandler
}

async function mount(options: Options = {}) {
  const runs = options.runs ?? RUNS
  const entries: Entry[] = [
    {
      info: userMessage("msg_card_user", ROOT, 10),
      parts: [textPart("msg_card_user", ROOT, "prt_card_prompt", "scan everything")],
    },
    ...(options.before ?? []),
    {
      info: assistantMessage("msg_card_assistant", ROOT, "msg_card_user", 20),
      parts: runs.filter((run) => !run.orphan).map(task),
    },
    ...runs.map((run, index) => ({
      info: userMessage(`msg_card_result_${run.key}`, ROOT, 30 + index),
      parts: [resultPart(run)],
    })),
    ...(options.unmarked ?? []).map((run, index) => ({
      info: userMessage(`msg_card_result_${run.key}`, ROOT, 50 + index),
      parts: [resultPart(run, false)],
    })),
    ...(options.after ?? []),
  ]
  const harness = await mountRoute({
    route: { type: "session", sessionID: ROOT },
    view: () => <AppRoutes />,
    frame: true,
    sessions: [root, ...runs.map((run) => child(run.key))] satisfies Session[],
    handler: (url, request) =>
      url.pathname === `/session/${ROOT}/message`
        ? json(entries)
        : (options.handler?.(url, request) ?? lifecycle(url, request)),
    language: options.language ?? "en",
    keybinds: options.keybinds,
    kv: options.ambiguousWidth ? { ambiguous_width: options.ambiguousWidth } : undefined,
    width: options.width ?? 80,
    height: options.height ?? 60,
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

/** The title line of the card of run `key` and what is around it, without the margins and the border. */
function card(frame: string, key: string) {
  const lines = frame.split("\n")
  const index = lines.findIndex((line) => line.includes("◇") && line.includes(`Scan ${key} ·`))
  if (index < 0) return undefined
  const inside = (line: string | undefined) => (line ?? "").replace(/^\s*┃\s*/, "").trimEnd()
  return {
    index,
    lines,
    title: inside(lines[index]),
    preview: inside(lines[index + 1]),
    /** The rows of the card: its padding above, the two lines, its padding below. */
    rows: lines.slice(index - 1, index + 3),
  }
}

/** Every card of `keys` is on the screen. */
const shown = (frame: string, keys: readonly string[]) => keys.every((key) => card(frame, key) !== undefined)

/** The color of the first span that holds `needle` on a row that holds `row`. */
async function colorOn(harness: Harness, row: string, needle: string) {
  const frame = await harness.spans()
  for (const line of frame.lines) {
    if (!line.spans.some((span) => span.text.includes(row))) continue
    const span = line.spans.find((item) => item.text.includes(needle))
    if (span) return span.fg
  }
  return undefined
}

const WIDE = `${"网络错误：".repeat(12)}${"connection refused ".repeat(6)}`
const ALL: Run[] = [...RUNS, { key: "wide", status: "error", body: WIDE }]
const KEYS = ALL.map((run) => run.key)

/** What each card says in each language: its title line and the start of its preview. */
const SAYS: Record<"en" | "zh-CN", Record<string, { title: string; line: string }>> = {
  en: {
    done: { title: "background result · explore · Scan done · done · 1m 5s", line: "Found 3 issues in src/a.ts" },
    short: { title: "background result · explore · Scan short · done · 1m 5s", line: "All clear." },
    failed: { title: "background result · explore · Scan failed · failed · 1m 5s", line: "boom: connection refused" },
    cut: { title: "background result · explore · Scan cut · interrupted · 1m 5s", line: "The background task was" },
    wide: { title: "background result · explore · Scan wide · failed · 1m 5s", line: "网络错误：网络错误：" },
  },
  "zh-CN": {
    done: { title: "后台结果 · explore · Scan done · 完成 · 1m 5s", line: "Found 3 issues in src/a.ts" },
    short: { title: "后台结果 · explore · Scan short · 完成 · 1m 5s", line: "All clear." },
    failed: { title: "后台结果 · explore · Scan failed · 失败 · 1m 5s", line: "boom: connection refused" },
    cut: { title: "后台结果 · explore · Scan cut · 已中断 · 1m 5s", line: "The background task was" },
    wide: { title: "后台结果 · explore · Scan wide · 失败 · 1m 5s", line: "网络错误：网络错误：" },
  },
}

const HINTS = {
  en: { fold: "ctrl+o expand · click to open", open: "click to open" },
  "zh-CN": { fold: "ctrl+o 展开 · 点击进入", open: "点击进入" },
} as const

for (const language of ["zh-CN", "en"] as const) {
  for (const ambiguousWidth of [1, 2] as const) {
    test(`a result is two lines, its title and the first line of what it left with a hint, within 80 columns, in ${language} at ambiguous_width ${ambiguousWidth}`, async () => {
      const harness = await mount({ runs: ALL, language, ambiguousWidth, height: 70 })
      try {
        const frame = await harness.waitForFrame((value) => shown(value, KEYS), "every card")
        for (const run of ALL) {
          const at = card(frame, run.key)!
          const says = SAYS[language][run.key]
          expect(at.title).toBe(`◇ ${says.title}`)
          expect(at.preview).toStartWith(says.line)
          // Only a result that is one line that fits has nothing to open, and says so by naming no key.
          expect(at.preview).toEndWith(run.key === "short" ? HINTS[language].open : HINTS[language].fold)
          // A line that was cut says so, and the hint stays whole after it.
          if (run.key === "cut" || run.key === "wide") expect(at.preview).toMatch(/…\s+\S/)
          // The padding below the card is a row of its own, and the card is two lines between the paddings.
          expect(at.rows[3].replace(/^\s*┃\s*/, "").trim()).toBe("")
          // Nothing of it is wider than the screen, at either width of `◇` and `┃`.
          for (const line of at.rows) expect(cellWidth(line.trimEnd(), ambiguousWidth)).toBeLessThanOrEqual(80)
        }
        // The cards stand as far apart as the row table estimates a closed one to be tall: the windowed transcript
        // places the rows it has not measured by it.
        const estimated = estimateRowHeight({ key: "part:x", messageID: "msg_x", kind: "result", revision: 0 }, 76, 0)
        expect(card(frame, "short")!.index - card(frame, "done")!.index).toBe(estimated)
        expect(estimated).toBe(5)
        expect(harness.writes()).toEqual([])
      } finally {
        await harness.dispose()
      }
    })
  }
}

test("a language switch changes the words of a card that is on screen", async () => {
  const harness = await mount({ runs: [RUNS[0]], language: "en" })
  try {
    await harness.waitForFrame((value) => card(value, "done")?.title === `◇ ${SAYS.en.done.title}`, "the card")
    setLanguage("zh-CN")
    const frame = await harness.waitForFrame(
      (value) => card(value, "done")?.title === `◇ ${SAYS["zh-CN"].done.title}`,
      "words",
    )
    expect(card(frame, "done")?.preview).toEndWith(HINTS["zh-CN"].fold)
  } finally {
    await harness.dispose()
  }
})

test("the mark says how the run ended, and the line of a failed run is drawn in the color of an error", async () => {
  const harness = await mount({ runs: RUNS })
  try {
    await harness.waitForFrame((value) => shown(value, ["done", "failed", "cut"]), "the cards")
    const mark = (key: string) => colorOn(harness, `Scan ${key} ·`, "◇")
    expect((await mark("done"))?.equals(palette().success)).toBe(true)
    expect((await mark("short"))?.equals(palette().success)).toBe(true)
    expect((await mark("failed"))?.equals(palette().error)).toBe(true)
    expect((await mark("cut"))?.equals(palette().warning)).toBe(true)

    // The text of a result is gray, the failure's is red, and the hint is the dimmest of the three.
    expect((await colorOn(harness, "Found 3 issues", "Found 3 issues"))?.equals(palette().textMuted)).toBe(true)
    expect((await colorOn(harness, "boom: connection", "boom: connection"))?.equals(palette().error)).toBe(true)
    expect((await colorOn(harness, "Found 3 issues", "ctrl+o"))?.equals(palette().textDim)).toBe(true)
    expect((await colorOn(harness, "Scan done ·", "background result"))?.equals(palette().text)).toBe(true)
  } finally {
    await harness.dispose()
  }
})

/** The session the route shows, if it shows one. */
function sessionOf(harness: Harness) {
  const data = harness.route().data
  return data.type === "session" ? data.sessionID : undefined
}

function pressExpand(harness: Harness) {
  harness.app.mockInput.pressKey("o", { ctrl: true })
}

test("view.expand.toggle opens the whole result as markdown under the title, and closes it again", async () => {
  const harness = await mount({ runs: [RUNS[0], RUNS[1]], language: "en" })
  try {
    const closed = await harness.waitForFrame((value) => shown(value, ["done", "short"]), "the cards")
    expect(closed).not.toContain("second finding")
    const height = card(closed, "short")!.index - card(closed, "done")!.index

    // The key goes to the last card that has something to open: the one-line result has none.
    pressExpand(harness)
    const open = await harness.waitForFrame((value) => value.includes("second finding"), "the result")
    const at = card(open, "done")!
    // The body is drawn by the markdown view assistant text uses: the list has bullets, and bold has no asterisks.
    const text = open.replace(/┃/g, " ")
    expect(text).toContain("Found 3 issues in src/a.ts")
    expect(text).toContain("first finding")
    expect(text).toContain("final word")
    expect(text).not.toContain("**")
    // The preview line is gone: the body stands in its place, and the hint at its foot says what the key does now.
    expect(at.preview).not.toContain("ctrl+o expand")
    expect(open).toContain("ctrl+o collapse · click to open")
    // The card under it moved down by what the body took, and the one that had nothing to open did not change.
    expect(card(open, "short")!.index - at.index).toBeGreaterThan(height)
    expect(card(open, "short")!.preview).toEndWith(HINTS.en.open)
    expect(harness.writes()).toEqual([])

    // Every card that can open is open: the key closes the most recent one.
    pressExpand(harness)
    const again = await harness.waitForFrame((value) => !value.includes("second finding"), "the card closed")
    expect(card(again, "done")!.preview).toEndWith(HINTS.en.fold)
    expect(card(again, "short")!.index - card(again, "done")!.index).toBe(height)
  } finally {
    await harness.dispose()
  }
})

test("the key opens one card at a time, the last one first, and the hint names the key the keymap has", async () => {
  const harness = await mount({
    runs: [RUNS[0], RUNS[2]],
    language: "zh-CN",
    keybinds: { keybinds: { view_expand_toggle: "f9" } },
  })
  try {
    const closed = await harness.waitForFrame((value) => shown(value, ["done", "failed"]), "the cards")
    expect(card(closed, "done")!.preview).toEndWith("f9 展开 · 点击进入")
    expect(card(closed, "failed")!.preview).toEndWith("f9 展开 · 点击进入")

    harness.app.mockInput.pressKey("F9")
    const first = await harness.waitForFrame((value) => value.includes("at run (task.ts:42)"), "the later card")
    expect(first).not.toContain("second finding")
    expect(first).toContain("f9 折叠 · 点击进入")

    harness.app.mockInput.pressKey("F9")
    const second = await harness.waitForFrame((value) => value.includes("second finding"), "the earlier card")
    expect(second).toContain("at run (task.ts:42)")
  } finally {
    await harness.dispose()
  }
})

test("a card says only that it can be opened when the expand key is not bound", async () => {
  const harness = await mount({
    runs: [RUNS[0]],
    language: "en",
    keybinds: { keybinds: { view_expand_toggle: "none" } },
  })
  try {
    const frame = await harness.waitForFrame((value) => shown(value, ["done"]), "the card")
    expect(card(frame, "done")!.preview).toEndWith(HINTS.en.open)
    expect(card(frame, "done")!.preview).not.toContain("expand")
  } finally {
    await harness.dispose()
  }
})

test("a click on a card opens the sub-agent that ran it and asks the server for nothing", async () => {
  const harness = await mount({ runs: [RUNS[0], RUNS[1]], language: "en" })
  try {
    const frame = await harness.waitForFrame((value) => shown(value, ["done", "short"]), "the cards")
    const at = card(frame, "short")!
    // On the title; the line under it, and the padding around, are the card as much.
    await harness.app.mockMouse.click(at.lines[at.index].indexOf("Scan short"), at.index)
    await waitFor(() => sessionOf(harness) === childID("short"))
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("a click on the preview opens it too, and a drag that selects the text does not", async () => {
  const harness = await mount({ runs: [RUNS[0]], language: "en" })
  try {
    const frame = await harness.waitForFrame((value) => shown(value, ["done"]), "the card")
    const at = card(frame, "done")!
    const column = at.lines[at.index + 1].indexOf("Found 3")
    await harness.app.mockMouse.drag(column, at.index + 1, column + 10, at.index + 1)
    await harness.settle()
    expect(harness.app.renderer.getSelection()?.getSelectedText()).toContain("Found 3")
    expect(sessionOf(harness)).toBe(ROOT)
    harness.app.renderer.clearSelection()

    await harness.app.mockMouse.click(column + 2, at.index + 1)
    await waitFor(() => sessionOf(harness) === childID("done"))
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("only the metadata makes a card: the text a command leaves for the model, and a notice without it, stay hidden", async () => {
  const lookalike: Run = { key: "lookalike", status: "completed", body: "this is not a result", orphan: true }
  const harness = await mount({
    runs: [RUNS[0]],
    unmarked: [lookalike],
    after: [syntheticMessage("msg_card_summarize", SUMMARIZE, 60)],
    language: "en",
  })
  try {
    const frame = await harness.waitForFrame((value) => shown(value, ["done"]), "the card")
    expect(frame).not.toContain("Summarize the task tool output")
    expect(frame).not.toContain("this is not a result")
    expect(frame).not.toContain("Background task completed: Scan lookalike")
    expect(frame.split("\n").filter((line) => line.includes("background result"))).toHaveLength(1)
  } finally {
    await harness.dispose()
  }
})

test("a run no Task call in the transcript started has a card too, of an agent of no known kind", async () => {
  const harness = await mount({ runs: [{ ...RUNS[0], orphan: true }], language: "en" })
  try {
    const frame = await harness.waitForFrame(
      (value) => value.split("\n").some((line) => line.includes("◇ background result")),
      "the card",
    )
    const title = frame.split("\n").find((line) => line.includes("◇ background result"))
    expect(title).toContain("background result · agent · Scan done · done · 1m 5s")
  } finally {
    await harness.dispose()
  }
})

for (const ambiguousWidth of [1, 2] as const) {
  for (const width of [80, 60]) {
    test(`a title that is too long loses its own end and keeps the status and the time, at ${width} columns, ambiguous_width ${ambiguousWidth}`, async () => {
      const long: Run = { key: `${"长标题".repeat(15)}-${"x".repeat(40)}`, status: "completed", body: "ok" }
      const harness = await mount({ runs: [long], language: "en", ambiguousWidth, width, height: 40 })
      try {
        const frame = await harness.waitForFrame(
          (value) => value.split("\n").some((line) => line.includes("◇ background result")),
          "the card",
        )
        const lines = frame.split("\n")
        const index = lines.findIndex((line) => line.includes("◇ background result"))
        const title = lines[index].replace(/^\s*┃\s*/, "").trimEnd()
        // At 60 columns with `·` two cells wide the words around the title take the whole line, and the end goes.
        if (width === 80 || ambiguousWidth === 1) expect(title).toEndWith("… · done · 1m 5s")
        expect(title).toStartWith("◇ background result · explore · ")
        expect(title).toContain("…")
        for (const line of lines.slice(index - 1, index + 3)) {
          expect(cellWidth(line.trimEnd(), ambiguousWidth)).toBeLessThanOrEqual(width)
        }
      } finally {
        await harness.dispose()
      }
    })
  }
}

test("the first line of a result is one clean line, whatever the run wrote", async () => {
  const dirty: Run = { key: "dirty", status: "completed", body: "\n\n  \u001b[31mred\u001b[0m\u0007 alarm\nsecond" }
  const harness = await mount({ runs: [dirty], language: "en" })
  try {
    const frame = await harness.waitForFrame((value) => shown(value, ["dirty"]), "the card")
    expect(card(frame, "dirty")!.preview).toStartWith("red alarm")
    expect(frame).not.toContain("\u001b")
    expect(frame).not.toContain("\u0007")
    // Opened, the whole result is cleaned too, and keeps its lines.
    pressExpand(harness)
    const open = await harness.waitForFrame((value) => value.includes("second"), "the opened result")
    expect(open).toContain("red alarm")
    expect(open).not.toContain("\u001b")
    expect(open).not.toContain("\u0007")
    expect(open).not.toContain("[31m")
  } finally {
    await harness.dispose()
  }
})

test("a transcript long enough to be windowed shows the card at its place, and opens it", async () => {
  const harness = await mount({
    runs: [RUNS[0]],
    language: "en",
    height: 30,
    before: bulk(90, Math.ceil(WINDOW_MIN_ROWS / 90)),
  })
  try {
    const frame = await harness.waitForFrame((value) => shown(value, ["done"]), "the card")
    expect(card(frame, "done")!.preview).toEndWith(HINTS.en.fold)
    pressExpand(harness)
    const open = await harness.waitForFrame((value) => value.includes("second finding"), "the result")
    expect(open).toContain("ctrl+o collapse · click to open")
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("a card far from the viewport of a windowed transcript opens by key and is there when the reader scrolls to it", async () => {
  const harness = await mount({
    runs: [RUNS[0]],
    language: "en",
    height: 30,
    after: bulk(90, Math.ceil(WINDOW_MIN_ROWS / 90), "tail"),
  })
  try {
    // At the end the card is thousands of rows away and not mounted.
    await harness.waitForFrame((value) => value.includes("tail 89."), "the end")
    pressExpand(harness)
    await harness.settle()
    // At the top it stands where it was, open.
    harness.app.mockInput.pressKey("g", { ctrl: true })
    // The card is open: the first of the findings is on the screen, and the rest is below the viewport.
    const frame = await harness.waitForFrame((value) => value.includes("first finding"), "the open card")
    expect(frame).toContain("Found 3 issues in src/a.ts")
    expect(card(frame, "done")!.preview).not.toContain("ctrl+o expand")
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

/** A transcript taller than a short terminal, with the prompt at its top and the cards at its end. */
const tall = () => ({ runs: [RUNS[0]], language: "en" as const, height: 24, before: bulk(30, 2) })

test("the jump to the last user message goes to what the user wrote and not to a result", async () => {
  const harness = await mount(tall())
  try {
    // The transcript follows its end: the prompt, the first message, is far above.
    const end = await harness.waitForFrame((value) => shown(value, ["done"]), "the end")
    expect(end).not.toContain("scan everything")
    harness.keymap().dispatchCommand("session.messages_last_user")
    await harness.waitForFrame((value) => value.includes("scan everything"), "the prompt")
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("undo goes back to what the user wrote and does not copy the text of a result into the prompt", async () => {
  const harness = await mount({
    ...tall(),
    handler: (url) =>
      /\/(abort|revert)$/.test(url.pathname) ? json(url.pathname.endsWith("/abort") ? true : {}) : undefined,
  })
  try {
    await harness.waitForFrame((value) => shown(value, ["done"]), "the card")
    harness.app.mockInput.pressKey("x", { ctrl: true })
    await harness.app.renderOnce()
    harness.app.mockInput.pressKey("u")
    await waitFor(() => harness.sent.some((request) => request.path.endsWith("/revert")))
    await harness.settle()
    // The result message is not what is undone (#1408): the prompt gets what the user wrote, and nothing of the result.
    expect(harness.sent.find((request) => request.path.endsWith("/revert"))?.body).toMatchObject({
      messageID: "msg_card_user",
    })
    expect(harness.promptDraft()).toBe("scan everything")
    expect(harness.promptParts()).toEqual([])
  } finally {
    await harness.dispose()
  }
})
