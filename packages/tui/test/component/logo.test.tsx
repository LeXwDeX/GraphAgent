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
  await settled
  await app.renderOnce()
  await app.renderOnce()
  return app
}

type App = Awaited<ReturnType<typeof renderLogo>>

function filledRows(app: App) {
  return app
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
}

function fullRow(row: number) {
  return LOGO_GRAPH[row] + " ".repeat(LOGO_GAP) + LOGO_AGENT[row]
}

function ints(color: RGBA) {
  return color.toInts().join(",")
}

/** Index of the first frame line that carries wordmark glyphs, and the column the wordmark starts at. */
function locate(app: App) {
  const lines = app.captureCharFrame().split("\n")
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
    const rows = filledRows(app)
    expect(rows).toHaveLength(6)
    const { left } = locate(app)
    expect(rows.map((row) => row.slice(left))).toEqual(Array.from({ length: 6 }, (_, row) => fullRow(row).trimEnd()))
    expect(Math.max(...rows.map((row) => row.slice(left).length))).toBe(87)
    expect(app.captureCharFrame()).not.toContain("GraphAgent")
  } finally {
    app.renderer.destroy()
  }
})

test("GRAPH uses logoFace, AGENT uses logoAccent and every outline uses logoShadow", async () => {
  await using tmp = await shellState()
  const app = await renderLogo({ width: 100, height: 30 }, tmp.path)

  try {
    const { top, left } = locate(app)
    const frame = app.captureSpans()
    const face = ints(theme.logoFace)
    const accent = ints(theme.logoAccent)
    const shadow = ints(theme.logoShadow)
    expect(new Set([face, accent, shadow]).size).toBe(3)

    for (let row = 0; row < 6; row++) {
      const colors: Array<string | undefined> = []
      for (const span of frame.lines[top + row].spans) {
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
      const rows = filledRows(app)
      expect(rows).toHaveLength(1)
      expect(rows[0].trim()).toBe(LOGO_MINI)
      expect(app.captureCharFrame()).not.toContain("█")
    } finally {
      app.renderer.destroy()
    }
  }
})

test("the smallest terminal that fits still draws the wordmark", async () => {
  await using tmp = await shellState()
  const app = await renderLogo({ width: LOGO_MIN_COLUMNS, height: LOGO_MIN_ROWS }, tmp.path)

  try {
    expect(filledRows(app)).toHaveLength(6)
    expect(app.captureCharFrame()).not.toContain("GraphAgent")
  } finally {
    app.renderer.destroy()
  }
})

test("the mark colours the diamond, the accent and bolds the name", async () => {
  await using tmp = await shellState()
  const app = await renderLogo({ width: 80, height: 24 }, tmp.path)

  try {
    const line = app.captureSpans().lines.find((candidate) => candidate.spans.some((span) => span.text.includes("◆")))!
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
    expect(filledRows(narrow).map((row) => row.trim())).toEqual([LOGO_MINI])
  } finally {
    narrow.renderer.destroy()
  }

  const wide = await renderLogo({ width: 170, height: 40 }, tmp.path)
  try {
    expect(filledRows(wide)).toHaveLength(6)
  } finally {
    wide.renderer.destroy()
  }
})

test("resizing the terminal swaps between the wordmark and the mark", async () => {
  await using tmp = await shellState()
  const app = await renderLogo({ width: 100, height: 30 }, tmp.path)

  try {
    expect(filledRows(app)).toHaveLength(6)

    app.resize(80, 24)
    await app.renderOnce()
    await app.renderOnce()
    expect(filledRows(app).map((row) => row.trim())).toEqual([LOGO_MINI])

    app.resize(120, 40)
    await app.renderOnce()
    await app.renderOnce()
    expect(filledRows(app)).toHaveLength(6)
  } finally {
    app.renderer.destroy()
  }
})
