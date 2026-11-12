// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { TopBar, type TopBarProps } from "../../src/shell/top-bar"
import { setLanguage } from "../../src/i18n"
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
