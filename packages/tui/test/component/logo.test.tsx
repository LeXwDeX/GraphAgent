// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { TextAttributes, TextRenderable, type BaseRenderable, type RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { Logo } from "../../src/component/logo"
import { LOGO_AGENT, LOGO_GAP, LOGO_GRAPH, LOGO_MINI, LOGO_MIN_COLUMNS, LOGO_MIN_ROWS } from "../../src/logo"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import { ShellContexts, shellState } from "../shell/contexts"
import { readSpans, renderUntilFrame } from "../fixture/frames"

const GRAPH_WIDTH = 41
const GLYPHS = /[█╗╔╝╚║═]/
const theme = resolveTheme(DEFAULT_THEMES.graphagent, "dark")

async function renderLogo(size: { width: number; height: number }, state: string) {
  let ready!: () => void
  const settled = new Promise<void>((resolve) => (ready = resolve))
  const app = await testRender(
    () => (
      <ShellContexts state={state} onReady={ready}>
        <Logo />
      </ShellContexts>
    ),
    size,
  )
  try {
    await settled
    // Every case draws something (the wordmark or the one-line mark), but only once the providers above the logo
    // have loaded, which takes real time that a loaded runner stretches (#1397, #1406). Render until it is there,
    // bounded by a deadline that reports the last frame, instead of reading after a fixed number of renders.
    await renderUntilFrame(app, (frame) => frame.trim() !== "", "the first frame of the logo")
    return app
  } catch (error) {
    app.renderer.destroy()
    throw error
  }
}

type App = Awaited<ReturnType<typeof renderLogo>>

function filledRows(frame: string) {
  return frame
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
}

/** Renders until the logo's rows satisfy `ready` and returns them. */
async function rowsWhen(app: App, ready: (rows: string[]) => boolean, what: string) {
  const frame = await renderUntilFrame(app, (candidate) => ready(filledRows(candidate)), what)
  return { frame, rows: filledRows(frame) }
}

const isWordmark = (rows: string[]) => rows.length === 6
const isMark = (rows: string[]) => rows.length === 1 && rows[0].trim() === LOGO_MINI

function fullRow(row: number) {
  return LOGO_GRAPH[row] + " ".repeat(LOGO_GAP) + LOGO_AGENT[row]
}

function ints(color: RGBA) {
  return color.toInts().join(",")
}

/** Index of the first frame line that carries wordmark glyphs, and the column the wordmark starts at. */
function locate(frame: string) {
  const lines = frame.split("\n")
  const top = lines.findIndex((line) => GLYPHS.test(line))
  // Row 1 of GRAPH starts with a glyph, so its indentation is the wordmark's left edge.
  const left = lines[top + 1].length - lines[top + 1].trimStart().length
  return { top, left }
}

function descendants(node: BaseRenderable): BaseRenderable[] {
  return node.getChildren().flatMap((child) => [child, ...descendants(child)])
}

test("a wide, tall terminal draws the 87 by 6 wordmark", async () => {
  await using tmp = await shellState()
  const app = await renderLogo({ width: 100, height: 30 }, tmp.path)

  try {
    const { frame, rows } = await rowsWhen(app, isWordmark, "the six-row wordmark")
    expect(rows).toHaveLength(6)
    const { left } = locate(frame)
    expect(rows.map((row) => row.slice(left))).toEqual(Array.from({ length: 6 }, (_, row) => fullRow(row).trimEnd()))
    expect(Math.max(...rows.map((row) => row.slice(left).length))).toBe(87)
    expect(frame).not.toContain("GraphAgent")
  } finally {
    app.renderer.destroy()
  }
})

test("GRAPH uses logoFace, AGENT uses logoAccent and every outline uses logoShadow", async () => {
  await using tmp = await shellState()
  const app = await renderLogo({ width: 100, height: 30 }, tmp.path)

  try {
    const { frame } = await rowsWhen(app, isWordmark, "the six-row wordmark")
    const { top, left } = locate(frame)
    const spans = await readSpans(app)
    const face = ints(theme.logoFace)
    const accent = ints(theme.logoAccent)
    const shadow = ints(theme.logoShadow)
    expect(new Set([face, accent, shadow]).size).toBe(3)

    for (let row = 0; row < 6; row++) {
      const colors: Array<string | undefined> = []
      for (const span of spans.lines[top + row].spans) {
        for (const _char of span.text) colors.push(ints(span.fg))
      }
      const text = fullRow(row)
      for (let column = 0; column < 87; column++) {
        const char = text[column]
        if (char === " ") continue
        const expected = char !== "█" ? shadow : column < GRAPH_WIDTH ? face : accent
        expect({ row, column, color: colors[left + column] }).toEqual({ row, column, color: expected })
      }
    }
  } finally {
    app.renderer.destroy()
  }
})

test("each wordmark row is one text node with no per-glyph children", async () => {
  await using tmp = await shellState()
  const app = await renderLogo({ width: 100, height: 30 }, tmp.path)

  try {
    await rowsWhen(app, isWordmark, "the six-row wordmark")
    const nodes = descendants(app.renderer.root)
    const rows = nodes.filter(
      (node): node is TextRenderable => node instanceof TextRenderable && GLYPHS.test(node.plainText),
    )
    expect(rows).toHaveLength(6)
    for (const row of rows) {
      // The row itself plus its text children: far below one node per character.
      expect(1 + row.getTextChildren().length).toBeLessThanOrEqual(8)
      expect(row.chunks.length).toBeGreaterThan(1)
      expect(row.chunks.every((chunk) => chunk.attributes === TextAttributes.BOLD)).toBe(true)
    }
    // Container plus six rows is the whole wordmark.
    const container = rows[0].parent!
    expect(container.getChildren()).toHaveLength(6)
    expect(descendants(container)).toHaveLength(6)
  } finally {
    app.renderer.destroy()
  }
})

test("narrow or short terminals fall back to the one-line mark", async () => {
  await using tmp = await shellState()
  for (const size of [
    { width: LOGO_MIN_COLUMNS - 1, height: 30 },
    { width: 120, height: LOGO_MIN_ROWS - 1 },
    { width: 80, height: 24 },
  ]) {
    const app = await renderLogo(size, tmp.path)
    try {
      const { frame, rows } = await rowsWhen(app, isMark, `the one-line mark at ${size.width}x${size.height}`)
      expect(rows).toHaveLength(1)
      expect(rows[0].trim()).toBe(LOGO_MINI)
      expect(frame).not.toContain("█")
    } finally {
      app.renderer.destroy()
    }
  }
})

test("the smallest terminal that fits still draws the wordmark", async () => {
  await using tmp = await shellState()
  const app = await renderLogo({ width: LOGO_MIN_COLUMNS, height: LOGO_MIN_ROWS }, tmp.path)

  try {
    const { frame, rows } = await rowsWhen(app, isWordmark, "the six-row wordmark")
    expect(rows).toHaveLength(6)
    expect(frame).not.toContain("GraphAgent")
  } finally {
    app.renderer.destroy()
  }
})

test("the mark colours the diamond, the accent and bolds the name", async () => {
  await using tmp = await shellState()
  const app = await renderLogo({ width: 80, height: 24 }, tmp.path)

  try {
    await rowsWhen(app, isMark, "the one-line mark")
    const spans = await readSpans(app)
    const line = spans.lines.find((candidate) => candidate.spans.some((span) => span.text.includes("◆")))!
    const find = (text: string) => line.spans.find((span) => span.text.includes(text))!
    expect(ints(find("◇─").fg)).toBe(ints(theme.textMuted))
    expect(ints(find("◆").fg)).toBe(ints(theme.primary))
    expect(find("GraphAgent").attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
  } finally {
    app.renderer.destroy()
  }
})

test("ambiguous_width 2 keeps the wordmark off a terminal it would overflow", async () => {
  await using tmp = await shellState({ ambiguous_width: 2 })
  const narrow = await renderLogo({ width: 120, height: 40 }, tmp.path)
  try {
    const { rows } = await rowsWhen(narrow, isMark, "the one-line mark on a 120 column terminal")
    expect(rows.map((row) => row.trim())).toEqual([LOGO_MINI])
  } finally {
    narrow.renderer.destroy()
  }

  const wide = await renderLogo({ width: 170, height: 40 }, tmp.path)
  try {
    const { rows } = await rowsWhen(wide, isWordmark, "the six-row wordmark on a 170 column terminal")
    expect(rows).toHaveLength(6)
  } finally {
    wide.renderer.destroy()
  }
})

test("resizing the terminal swaps between the wordmark and the mark", async () => {
  await using tmp = await shellState()
  const app = await renderLogo({ width: 100, height: 30 }, tmp.path)

  try {
    expect((await rowsWhen(app, isWordmark, "the six-row wordmark")).rows).toHaveLength(6)

    // The renderer applies a resize when it can, which on a loaded runner is later than the next two renders:
    // render until the frame has the shape of the new size.
    app.resize(80, 24)
    const small = await rowsWhen(app, isMark, "the one-line mark after resizing to 80x24")
    expect(small.rows.map((row) => row.trim())).toEqual([LOGO_MINI])

    app.resize(120, 40)
    const large = await rowsWhen(app, isWordmark, "the six-row wordmark after resizing to 120x40")
    expect(large.rows).toHaveLength(6)
  } finally {
    app.renderer.destroy()
  }
})
