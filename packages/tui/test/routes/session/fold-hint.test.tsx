// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import type { ToolPart } from "@graphagent/sdk"
import { DEFAULT_THEME } from "../../../src/context/theme"
import { setLanguage } from "../../../src/i18n"
import { DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { cellWidth } from "../../../src/ui/width"
import { AppRoutes } from "../../fixture/route-frame"
import { assistantMessage, textPart, userMessage, type MessageEntry } from "../../fixture/session-records"
import { json } from "../../fixture/tui-sdk"
import { mountRoute, sessionFixture, waitFor, type MountOptions } from "../dag-mode-harness"

/**
 * The line under a tool output that folds (#1615 PR A): it counts the lines the fold leaves out and names the key
 * that opens them, or says "click" when the key is unbound. The block shows the first lines as they are, with no `…`
 * line of its own, since the hint opens with one.
 */

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

const palette = () => resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")

const ROOT = "ses_fold_root"
const root = sessionFixture(ROOT, { title: "root", time: { created: 1, updated: 2 } })

type Language = "en" | "zh-CN"

/** `count` lines, each a line of its own whatever its number: `out 1` is not the start of `out 10` once whole. */
const output = (count: number) => Array.from({ length: count }, (_, index) => `out ${index + 1}`).join("\n")

/** A finished call; `bash` draws its block from `metadata.output`, any other tool from the output of the call. */
function call(tool: string, text: string, id = "prt_fold_call"): ToolPart {
  return {
    id,
    sessionID: ROOT,
    messageID: "msg_fold_assistant",
    type: "tool",
    callID: `call_${id}`,
    tool,
    state: {
      status: "completed",
      input: tool === "bash" ? { command: "printf out" } : {},
      output: text,
      title: tool,
      metadata: tool === "bash" ? { output: text } : {},
      time: { start: 1, end: 2 },
    },
  }
}

type Options = {
  calls: ToolPart[]
  language?: Language
  ambiguousWidth?: 1 | 2
  width?: number
  height?: number
  keybinds?: MountOptions["keybinds"]
  kv?: Record<string, unknown>
}

async function mount(options: Options) {
  const entries: MessageEntry[] = [
    {
      info: userMessage("msg_fold_user", ROOT, 10),
      parts: [textPart("msg_fold_user", ROOT, "prt_fold_prompt", "run it")],
    },
    {
      info: assistantMessage("msg_fold_assistant", ROOT, "msg_fold_user", 20),
      parts: options.calls,
    },
  ]
  const harness = await mountRoute({
    route: { type: "session", sessionID: ROOT },
    view: () => <AppRoutes />,
    frame: true,
    sessions: [root],
    handler: (url) => (url.pathname === `/session/${ROOT}/message` ? json(entries) : undefined),
    language: options.language ?? "en",
    keybinds: options.keybinds,
    kv: { ...options.kv, ...(options.ambiguousWidth ? { ambiguous_width: options.ambiguousWidth } : {}) },
    width: options.width ?? 100,
    height: options.height ?? 40,
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

/** A row of the frame without the gutter the block draws in front of its text. */
const inside = (line: string) => line.replace(/^[\s┃│]+/, "").trimEnd()
const rowsOf = (frame: string) => frame.split("\n").map(inside)
/** The first row with anything on it under the row of `last`, the last line of the output: the hint. */
function hintUnder(frame: string, last: string) {
  const rows = rowsOf(frame)
  return rows.slice(rows.lastIndexOf(last) + 1).find(Boolean)
}
const has = (text: string) => (frame: string) => frame.includes(text)

function pressExpand(harness: Harness) {
  harness.app.mockInput.pressKey("o", { ctrl: true })
}

/** Clicks the first cell of `text`, which is on the hint line: a click anywhere in the block flips it. */
async function clickOn(harness: Harness, frame: string, text: string) {
  const lines = frame.split("\n")
  const row = lines.findIndex((line) => line.includes(text))
  expect(row).toBeGreaterThanOrEqual(0)
  await harness.app.mockMouse.click(lines[row].indexOf(text), row)
  harness.app.renderer.clearSelection()
}

const SAYS = {
  en: {
    five: "… 5 more lines · ctrl+o expand",
    one: "… 1 more line · ctrl+o expand",
    fiveClick: "… 5 more lines · click to expand",
    long: "… long output · ctrl+o expand",
    open: "ctrl+o collapse",
    openClick: "click to collapse",
    f9: "… 5 more lines · f9 expand",
    f9Open: "f9 collapse",
  },
  "zh-CN": {
    five: "… 还有 5 行 · ctrl+o 展开",
    one: "… 还有 1 行 · ctrl+o 展开",
    fiveClick: "… 还有 5 行 · 点击展开",
    long: "… 内容较长 · ctrl+o 展开",
    open: "ctrl+o 收起",
    openClick: "点击收起",
    f9: "… 还有 5 行 · f9 展开",
    f9Open: "f9 收起",
  },
} as const

for (const language of ["en", "zh-CN"] as const) {
  test(`a bash output of fifteen lines shows ten and a hint that counts the other five, in ${language}`, async () => {
    const harness = await mount({ calls: [call("bash", output(15))], language })
    try {
      const frame = await harness.waitForFrame(has(SAYS[language].five), "the hint")
      const rows = rowsOf(frame)
      // The first ten lines, as printed: nothing of the eleventh, and no `…` line closing them.
      expect(rows).toContain("out 1")
      expect(rows).toContain("out 10")
      expect(rows).not.toContain("out 11")
      expect(rows).not.toContain("…")
      // The hint is the one row that opens with `…`, and it stands under the last line shown.
      expect(rows.filter((row) => row.startsWith("…"))).toEqual([SAYS[language].five])
      expect(hintUnder(frame, "out 10")).toBe(SAYS[language].five)
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test(`the key opens the output and the hint then says which key closes it, in ${language}`, async () => {
    const harness = await mount({ calls: [call("bash", output(15))], language })
    try {
      await harness.waitForFrame(has(SAYS[language].five), "the hint")
      pressExpand(harness)
      const open = await harness.waitForFrame(has(SAYS[language].open), "the whole output")
      const rows = rowsOf(open)
      expect(rows).toContain("out 15")
      expect(hintUnder(open, "out 15")).toBe(SAYS[language].open)
      // Open, the output ends at its last line and nothing opens a hint with `…`.
      expect(rows.filter((row) => row.startsWith("…"))).toEqual([])

      pressExpand(harness)
      const closed = await harness.waitForFrame(has(SAYS[language].five), "the hint again")
      expect(rowsOf(closed)).not.toContain("out 15")
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test(`with the key unbound the hint says click, and a click opens and closes the output, in ${language}`, async () => {
    const harness = await mount({
      calls: [call("bash", output(15))],
      language,
      keybinds: { keybinds: { view_expand_toggle: "none" } },
    })
    try {
      const frame = await harness.waitForFrame(has(SAYS[language].fiveClick), "the hint")
      expect(hintUnder(frame, "out 10")).toBe(SAYS[language].fiveClick)
      // A fallback text names no key and holds no placeholder.
      expect(hintUnder(frame, "out 10")).not.toMatch(/ctrl|\{/)

      await clickOn(harness, frame, language === "en" ? "5 more" : "还有")
      const open = await harness.waitForFrame(has(SAYS[language].openClick), "the whole output")
      expect(rowsOf(open)).toContain("out 15")
      expect(hintUnder(open, "out 15")).toBe(SAYS[language].openClick)

      await clickOn(harness, open, SAYS[language].openClick)
      const closed = await harness.waitForFrame(has(SAYS[language].fiveClick), "the hint again")
      expect(rowsOf(closed)).not.toContain("out 15")
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  test(`a long line that leaves no line out gets the long hint, in ${language}`, async () => {
    // One line of 3000 characters: a single line is under the cap of ten, the characters are over it.
    const harness = await mount({ calls: [call("bash", "x".repeat(3000))], language, height: 70 })
    try {
      const frame = await harness.waitForFrame(has(SAYS[language].long), "the hint")
      // The cut is inside the line, where the `…` stays: it is the last thing of the text above the hint.
      const rows = rowsOf(frame)
      const above = rows.slice(0, rows.indexOf(SAYS[language].long)).filter(Boolean)
      expect(above.at(-1)).toEndWith("…")
      expect(rows.filter((row) => row.startsWith("…"))).toEqual([SAYS[language].long])

      pressExpand(harness)
      const open = await harness.waitForFrame(has(SAYS[language].open), "the whole line")
      expect(rowsOf(open).filter((row) => row.includes(SAYS[language].open))).toEqual([SAYS[language].open])
    } finally {
      await harness.dispose()
    }
  })
}

test("one line left out is one line, not one lines", async () => {
  for (const language of ["en", "zh-CN"] as const) {
    const harness = await mount({ calls: [call("bash", output(11))], language })
    try {
      const frame = await harness.waitForFrame(has(SAYS[language].one), "the hint")
      expect(hintUnder(frame, "out 10")).toBe(SAYS[language].one)
      expect(rowsOf(frame)).toContain("out 10")
      expect(rowsOf(frame)).not.toContain("out 11")
    } finally {
      await harness.dispose()
    }
  }
})

test("the hint names the key the keymap has, and that key opens and closes the output", async () => {
  for (const language of ["en", "zh-CN"] as const) {
    const harness = await mount({
      calls: [call("bash", output(15))],
      language,
      keybinds: { keybinds: { view_expand_toggle: "f9" } },
    })
    try {
      const frame = await harness.waitForFrame(has(SAYS[language].f9), "the hint")
      expect(hintUnder(frame, "out 10")).toBe(SAYS[language].f9)
      expect(frame).not.toContain("ctrl+o")

      harness.app.mockInput.pressKey("F9")
      const open = await harness.waitForFrame(has(SAYS[language].f9Open), "the whole output")
      expect(rowsOf(open)).toContain("out 15")
    } finally {
      await harness.dispose()
    }
  }
})

test("the output of a tool without a display of its own folds at three lines, and says so the same way", async () => {
  for (const language of ["en", "zh-CN"] as const) {
    const harness = await mount({
      calls: [call("custom_tool", output(8))],
      language,
      kv: { generic_tool_output_visibility: true },
    })
    try {
      const frame = await harness.waitForFrame(has(SAYS[language].five), "the hint")
      const rows = rowsOf(frame)
      expect(rows).toContain("out 3")
      expect(rows).not.toContain("out 4")
      expect(rows).not.toContain("…")
      expect(hintUnder(frame, "out 3")).toBe(SAYS[language].five)

      pressExpand(harness)
      const open = await harness.waitForFrame(has(SAYS[language].open), "the whole output")
      expect(rowsOf(open)).toContain("out 8")
    } finally {
      await harness.dispose()
    }
  }
})

test("the hint is drawn in the dimmest text color, and the lines above it in the text color", async () => {
  const harness = await mount({ calls: [call("bash", output(15))] })
  try {
    await harness.waitForFrame(has(SAYS.en.five), "the hint")
    const frame = await harness.spans()
    const colorOf = (needle: string) => {
      for (const line of frame.lines) {
        const span = line.spans.find((item) => item.text.includes(needle))
        if (span) return span.fg
      }
      return undefined
    }
    expect(colorOf("5 more lines")?.equals(palette().textDim)).toBe(true)
    expect(colorOf("out 10")?.equals(palette().text)).toBe(true)
  } finally {
    await harness.dispose()
  }
})

for (const language of ["en", "zh-CN"] as const) {
  for (const width of [60, 80, 120]) {
    for (const ambiguousWidth of [1, 2] as const) {
      test(`the hint row is within ${width} columns at ambiguous_width ${ambiguousWidth}, in ${language}`, async () => {
        // `…` and `·` are Ambiguous glyphs: they take two cells at 2, and the hint has both.
        const harness = await mount({ calls: [call("bash", output(15))], language, width, ambiguousWidth })
        try {
          for (const [text, folded] of [
            [SAYS[language].five, true],
            [SAYS[language].open, false],
          ] as const) {
            if (!folded) pressExpand(harness)
            const frame = await harness.waitForFrame(has(text), "the hint")
            const row = frame.split("\n").find((line) => line.includes(text))!
            expect(cellWidth(row.trimEnd(), ambiguousWidth)).toBeLessThanOrEqual(width)
            // The hint is one row: the same words do not wrap onto the next.
            expect(frame.split("\n").filter((line) => line.includes(text))).toHaveLength(1)
          }
        } finally {
          await harness.dispose()
        }
      })
    }
  }
}

test("a language switch changes the words of a hint that is on screen", async () => {
  const harness = await mount({ calls: [call("bash", output(15))], language: "en" })
  try {
    await harness.waitForFrame(has(SAYS.en.five), "the hint")
    setLanguage("zh-CN")
    const frame = await harness.waitForFrame(has(SAYS["zh-CN"].five), "the words")
    expect(hintUnder(frame, "out 10")).toBe(SAYS["zh-CN"].five)
  } finally {
    await harness.dispose()
  }
})
