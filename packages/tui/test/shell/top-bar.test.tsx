// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { TextAttributes, type CapturedFrame } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { DEFAULT_THEME } from "../../src/context/theme"
import { TopBar, type TopBarProps, type TopBarSubagent } from "../../src/shell/top-bar"
import { setLanguage } from "../../src/i18n"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import { cellWidth, type AmbiguousWidth } from "../../src/ui/width"
import { ShellContexts, renderFirstFrame, shellState } from "./contexts"

afterEach(() => {
  setLanguage("zh-CN")
})

async function renderTopBar(props: TopBarProps, options: { width: number; height?: number; state: string }) {
  const app = await testRender(
    () => (
      <ShellContexts state={options.state}>
        <TopBar {...props} />
      </ShellContexts>
    ),
    { width: options.width, height: options.height ?? 1 },
  )
  await renderFirstFrame(app)
  return app
}

function frameLines(frame: string) {
  return frame.split("\n").map((line) => line.trimEnd())
}

function expectWithin(frame: string, width: number, ambiguousWidth: AmbiguousWidth) {
  for (const line of frameLines(frame)) {
    expect(cellWidth(line, ambiguousWidth)).toBeLessThanOrEqual(width)
  }
}

const right = {
  model: "Claude Sonnet 4.5",
  reasoning: "high",
  context: "上下文 24%",
}

test("renders the small mark and session title at 80 columns", async () => {
  await using tmp = await shellState()
  const app = await renderTopBar({ path: "排查 TUI 渲染", right }, { width: 80, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("◇─◆ GraphAgent")
    expect(frame).toContain("›")
    expect(frame).toContain("排查 TUI 渲染")
    expect(frame).not.toContain("Claude Sonnet 4.5")
    expect(frame).not.toContain("上下文")
    expect(frame).toContain("high")
    expectWithin(frame, 80, 1)
  } finally {
    app.renderer.destroy()
  }
})

test("shows model, reasoning strength and context usage at 120 columns", async () => {
  await using tmp = await shellState()
  const app = await renderTopBar({ path: "会话标题", right }, { width: 120, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Claude Sonnet 4.5")
    expect(frame).toContain("high")
    expect(frame).toContain("上下文 24%")
    expectWithin(frame, 120, 1)
  } finally {
    app.renderer.destroy()
  }
})

test("translates the context label", async () => {
  await using tmp = await shellState()
  setLanguage("en")
  const app = await renderTopBar(
    { path: "Investigate render", right: { model: "Claude Sonnet 4.5", reasoning: "high", context: "context 24%" } },
    { width: 120, state: tmp.path },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("context 24%")
    expect(frame).toContain("Investigate render")
  } finally {
    app.renderer.destroy()
  }
})

for (const ambiguousWidth of [1, 2] as const) {
  test(`does not overflow 80 columns with ambiguous_width ${ambiguousWidth}`, async () => {
    await using tmp = await shellState({ ambiguous_width: ambiguousWidth })
    const app = await renderTopBar(
      {
        path: "一个非常长的会话标题，用来验证顶栏在窄终端里按单元格宽度截断而不是按字符数截断",
        right,
      },
      { width: 80, state: tmp.path },
    )

    try {
      const frame = app.captureCharFrame()
      expect(frame).toContain("GraphAgent")
      expect(frame).toContain("…")
      expectWithin(frame, 80, ambiguousWidth)
    } finally {
      app.renderer.destroy()
    }
  })
}

test("drops the title before the brand mark when there is no room", async () => {
  await using tmp = await shellState()
  const app = await renderTopBar({ path: "会话", right: { reasoning: "x".repeat(80) } }, { width: 60, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("◇─◆ GraphAgent")
    expect(frame).not.toContain("会话")
    expectWithin(frame, 60, 1)
  } finally {
    app.renderer.destroy()
  }
})

// ── Sub-agent view (#1033 2): the path, its markers, the position and the clicks ─────────────────────────────────────

const palette = () => resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")

function subagent(extra: Partial<TopBarSubagent> = {}): TopBarSubagent {
  return {
    ancestors: [{ id: "ses_root", title: "升级工具链与全部依赖" }],
    kind: "explore",
    description: "扫描破坏性变更",
    marker: "running",
    ...extra,
  }
}

const subagentEn = (extra: Partial<TopBarSubagent> = {}) =>
  subagent({
    ancestors: [{ id: "ses_root", title: "Upgrade the toolchain and every dependency" }],
    description: "scan for breaking changes",
    ...extra,
  })

/** The color of the first span that holds `needle`. */
function colorOf(frame: CapturedFrame, needle: string) {
  for (const line of frame.lines) {
    for (const span of line.spans) if (span.text.includes(needle)) return span.fg
  }
  return undefined
}

/** The first row without the trailing blanks, which is where the clipped text of an overflow would be missing. */
const firstRow = (frame: string) => frame.split("\n")[0].trimEnd()

test("draws the path of a sub-agent: the root title, then the kind and its description", async () => {
  await using tmp = await shellState()
  const app = await renderTopBar({ subagent: subagent(), right }, { width: 120, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    expect(firstRow(frame)).toStartWith(" ◇─◆ GraphAgent › 升级工具链与全部依赖 › ● explore · 扫描破坏性变更")
    expect(frame).toContain("Claude Sonnet 4.5 · high · 上下文 24%")
    expectWithin(frame, 120, 1)
    expect(frame).toMatchSnapshot()
  } finally {
    app.renderer.destroy()
  }
})

test("draws three segments for a sub-agent under a sub-agent", async () => {
  await using tmp = await shellState()
  const view = subagent({
    ancestors: [
      { id: "ses_root", title: "升级工具链" },
      { id: "ses_middle", title: "检查破坏性变更" },
    ],
  })
  const app = await renderTopBar({ subagent: view }, { width: 100, state: tmp.path })

  try {
    expect(firstRow(app.captureCharFrame())).toBe(
      " ◇─◆ GraphAgent › 升级工具链 › 检查破坏性变更 › ● explore · 扫描破坏性变更",
    )
  } finally {
    app.renderer.destroy()
  }
})

test("shows the position and the keys that move it on the right, in both languages", async () => {
  await using tmp = await shellState()
  const zh = await renderTopBar(
    { subagent: subagent(), position: { index: 2, total: 3 } },
    { width: 120, state: tmp.path },
  )
  try {
    const frame = zh.captureCharFrame()
    expect(firstRow(frame)).toEndWith("子 agent 2/3  ←→")
    expect(frame).toMatchSnapshot()
    const spans = zh.captureSpans()
    expect(colorOf(spans, "子 agent 2/3")?.equals(palette().textMuted)).toBe(true)
    expect(colorOf(spans, "←→")?.equals(palette().textDim)).toBe(true)
  } finally {
    zh.renderer.destroy()
  }

  setLanguage("en")
  const en = await renderTopBar(
    { subagent: subagentEn(), position: { index: 1, total: 3 } },
    { width: 120, state: tmp.path },
  )
  try {
    const frame = en.captureCharFrame()
    expect(firstRow(frame)).toEndWith("subagent 1/3  ←→")
    expect(frame).toContain("› ● explore · scan for breaking changes")
    expect(frame).toMatchSnapshot()
  } finally {
    en.renderer.destroy()
  }
})

test("a lone sub-agent shows its position without the keys", async () => {
  await using tmp = await shellState()
  const app = await renderTopBar(
    { subagent: subagent(), position: { index: 1, total: 1 } },
    { width: 120, state: tmp.path },
  )

  try {
    const frame = app.captureCharFrame()
    expect(firstRow(frame)).toEndWith("子 agent 1/1")
    expect(frame).not.toContain("←→")
  } finally {
    app.renderer.destroy()
  }
})

test("the model details get what is left beside the whole path and the position, and give way before either", async () => {
  await using tmp = await shellState()
  const at = async (width: number) => {
    const app = await renderTopBar(
      { subagent: subagent(), position: { index: 1, total: 2 }, right },
      { width, state: tmp.path },
    )
    try {
      return app.captureCharFrame()
    } finally {
      app.renderer.destroy()
    }
  }

  // The path takes 52 cells and the position 18; of the model details the name goes first, then the context.
  const wide = await at(120)
  expect(firstRow(wide)).toContain("› ● explore · 扫描破坏性变更")
  expect(firstRow(wide)).toEndWith("high · 上下文 24%  子 agent 1/2  ←→")
  expect(wide).not.toContain("Claude Sonnet 4.5")

  const narrower = await at(100)
  expect(firstRow(narrower)).toContain("› ● explore · 扫描破坏性变更")
  expect(firstRow(narrower)).toEndWith("high  子 agent 1/2  ←→")

  // Where the path does not fit whole, none of them is shown and the path takes everything but the position.
  const narrow = await at(80)
  expect(firstRow(narrow)).toContain("● explore")
  expect(firstRow(narrow)).toEndWith("子 agent 1/2  ←→")
  expect(narrow).not.toContain("high")
  expectWithin(narrow, 80, 1)
})

test("a top bar without a sub-agent or a position is the one it was", async () => {
  await using tmp = await shellState()
  const app = await renderTopBar({ path: "排查 TUI 渲染", right }, { width: 80, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    expect(firstRow(frame)).toStartWith(" ◇─◆ GraphAgent › 排查 TUI 渲染 ")
    expect(firstRow(frame)).toEndWith(" high")
    expect(frame).not.toContain("子 agent")
    expect(frame).not.toContain("←→")
  } finally {
    app.renderer.destroy()
  }
})

test("the marker is a static glyph whose color tells the state: running is the brand color, failed an error, done gray", async () => {
  await using tmp = await shellState()
  const cases = [
    { marker: "running", glyph: "●", color: () => palette().primary },
    { marker: "failed", glyph: "✗", color: () => palette().error },
    { marker: "done", glyph: "✓", color: () => palette().success },
  ] as const

  for (const item of cases) {
    const app = await renderTopBar({ subagent: subagent({ marker: item.marker }) }, { width: 100, state: tmp.path })
    try {
      expect(firstRow(app.captureCharFrame())).toContain(`› ${item.glyph} explore · 扫描破坏性变更`)
      expect(colorOf(app.captureSpans(), item.glyph)?.equals(item.color())).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  }

  // Without a state there is no glyph at all.
  const bare = await renderTopBar({ subagent: subagent({ marker: undefined }) }, { width: 100, state: tmp.path })
  try {
    expect(firstRow(bare.captureCharFrame())).toContain("› explore · 扫描破坏性变更")
    expect(bare.captureCharFrame()).not.toMatch(/[●✗✓]/)
  } finally {
    bare.renderer.destroy()
  }
})

test("colors the segments: ancestors in the text color, the kind bold, the description and the separators muted", async () => {
  await using tmp = await shellState()
  const view = subagent({
    ancestors: [
      { id: "ses_root", title: "升级工具链" },
      { id: "ses_middle", title: "检查破坏性变更" },
    ],
  })
  const app = await renderTopBar({ subagent: view }, { width: 100, state: tmp.path })

  try {
    const spans = app.captureSpans()
    expect(colorOf(spans, "升级工具链")?.equals(palette().text)).toBe(true)
    expect(colorOf(spans, "检查破坏性变更")?.equals(palette().text)).toBe(true)
    expect(colorOf(spans, "explore")?.equals(palette().text)).toBe(true)
    expect(colorOf(spans, "扫描破坏性变更")?.equals(palette().textMuted)).toBe(true)
    expect(colorOf(spans, "›")?.equals(palette().textMuted)).toBe(true)
    const kind = spans.lines[0].spans.find((span) => span.text.includes("explore"))!
    expect(kind.attributes & TextAttributes.BOLD).toBeTruthy()
  } finally {
    app.renderer.destroy()
  }
})

test("the folded middle segments are the dim ellipsis between the root and the current segment", async () => {
  await using tmp = await shellState()
  const view = subagent({
    ancestors: [
      { id: "ses_root", title: "升级工具链与全部依赖" },
      { id: "ses_middle", title: "检查破坏性变更并给出详细的结论" },
    ],
    description: "扫描破坏性变更并汇总所有结果",
  })
  const app = await renderTopBar({ subagent: view }, { width: 70, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    // The middle segment folds, the root stays whole, and the description takes what the fold freed.
    expect(firstRow(frame)).toBe(" ◇─◆ GraphAgent › 升级工具链与全部依赖 › … › ● explore · 扫描破坏性…")
    expect(frame).not.toContain("检查破坏性变更并给出详细的结论")
    expect(colorOf(app.captureSpans(), "…")?.equals(palette().textDim)).toBe(true)
    expectWithin(frame, 70, 1)
  } finally {
    app.renderer.destroy()
  }
})

for (const language of ["zh-CN", "en"] as const) {
  for (const ambiguousWidth of [1, 2] as const) {
    test(`keeps the path and the position inside 80 columns in ${language} at ambiguous_width ${ambiguousWidth}`, async () => {
      await using tmp = await shellState({ ambiguous_width: ambiguousWidth })
      setLanguage(language)
      const long =
        language === "en"
          ? subagentEn({
              ancestors: [
                { id: "ses_root", title: "Upgrade the toolchain and every dependency of the whole monorepo" },
                { id: "ses_middle", title: "Check the breaking changes of each upgraded package" },
              ],
              description: "scan the changelogs for breaking changes and summarize every finding",
            })
          : subagent({
              ancestors: [
                { id: "ses_root", title: "升级工具链与整个单体仓库的全部依赖并验证构建结果" },
                { id: "ses_middle", title: "检查每个已升级软件包的破坏性变更" },
              ],
              description: "扫描全部变更日志中的破坏性变更并汇总每一项发现",
            })
      const app = await renderTopBar(
        { subagent: long, position: { index: 3, total: 12 }, right },
        { width: 80, state: tmp.path },
      )

      try {
        const frame = app.captureCharFrame()
        const row = firstRow(frame)
        expectWithin(frame, 80, ambiguousWidth)
        // Nothing is clipped: the current segment and the position at the right edge are both whole.
        expect(row).toContain("● explore")
        expect(row).toEndWith(language === "en" ? "subagent 3/12  ←→" : "子 agent 3/12  ←→")
        expect(row).toContain("◇─◆ GraphAgent › ")
        expect(frame).toMatchSnapshot()
      } finally {
        app.renderer.destroy()
      }
    })
  }
}

test("clicking an ancestor opens its session; the current segment and the folded segments do nothing", async () => {
  await using tmp = await shellState()
  const opened: string[] = []
  const view = subagent({
    ancestors: [
      { id: "ses_root", title: "升级工具链" },
      { id: "ses_middle", title: "检查破坏性变更" },
    ],
    onOpen: (sessionID) => opened.push(sessionID),
  })
  const app = await renderTopBar({ subagent: view }, { width: 100, state: tmp.path })

  try {
    const row = firstRow(app.captureCharFrame())
    // Everything left of the first wide character is one cell per character, so a string index is a column.
    const columnOf = (needle: string) => cellWidth(row.slice(0, row.indexOf(needle)))

    await app.mockMouse.click(columnOf("升级工具链") + 2, 0)
    expect(opened).toEqual(["ses_root"])
    await app.mockMouse.click(columnOf("检查破坏性变更") + 2, 0)
    expect(opened).toEqual(["ses_root", "ses_middle"])

    await app.mockMouse.click(columnOf("explore") + 2, 0)
    await app.mockMouse.click(columnOf("扫描破坏性变更") + 2, 0)
    await app.mockMouse.click(columnOf("GraphAgent") + 2, 0)
    await app.mockMouse.click(columnOf("›") + 1, 0)
    expect(opened).toEqual(["ses_root", "ses_middle"])
  } finally {
    app.renderer.destroy()
  }
})

test("a click on the folded middle segments does nothing", async () => {
  await using tmp = await shellState()
  const opened: string[] = []
  const view = subagent({
    ancestors: [
      { id: "ses_root", title: "升级工具链与全部依赖" },
      { id: "ses_middle", title: "检查破坏性变更并给出详细的结论" },
    ],
    description: "扫描破坏性变更并汇总所有结果",
    onOpen: (sessionID) => opened.push(sessionID),
  })
  const app = await renderTopBar({ subagent: view }, { width: 70, state: tmp.path })

  try {
    const row = firstRow(app.captureCharFrame())
    const fold = cellWidth(row.slice(0, row.indexOf("…")))
    await app.mockMouse.click(fold, 0)
    expect(opened).toEqual([])
    const root = cellWidth(row.slice(0, row.indexOf("升级工具链与全部依赖")))
    await app.mockMouse.click(root + 1, 0)
    expect(opened).toEqual(["ses_root"])
  } finally {
    app.renderer.destroy()
  }
})

test("drops the path before the brand mark when there is no room for even the current segment", async () => {
  await using tmp = await shellState()
  const app = await renderTopBar(
    { subagent: subagent(), position: { index: 1, total: 2 } },
    { width: 60, state: tmp.path },
  )

  try {
    const frame = app.captureCharFrame()
    expect(firstRow(frame)).toStartWith(" ◇─◆ GraphAgent")
    expectWithin(frame, 60, 1)
  } finally {
    app.renderer.destroy()
  }
})
