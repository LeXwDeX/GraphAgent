// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { setLanguage } from "../../src/i18n"
import { AppFrame, type AppFrameProps } from "../../src/shell/app-frame"
import type { FooterHint } from "../../src/shell/footer"
import { cellWidth, type AmbiguousWidth } from "../../src/ui/width"
import { ShellContexts, renderFirstFrame, shellState } from "./contexts"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

const hints: readonly FooterHint[] = [
  { key: "/", label: "命令" },
  { key: "ctrl+b", label: "侧边栏" },
  { key: "?", label: "快捷键" },
]

function frameProps(): AppFrameProps {
  return {
    topBar: {
      path: "会话标题",
      right: { model: "Claude Sonnet 4.5", reasoning: "high", context: "上下文 24%" },
    },
    footer: { agent: "build", agentAction: "tab", hints },
    statusBand: <text>状态带</text>,
    bottomZone: <text>底区</text>,
    children: <text>主区内容</text>,
  }
}

async function renderFrame(
  createProps: () => AppFrameProps,
  options: { width: number; height: number; state: string },
) {
  const app = await testRender(
    () => {
      const props = createProps()
      return (
        <ShellContexts state={options.state}>
          <AppFrame {...props}>{props.children ?? <text>主区内容</text>}</AppFrame>
        </ShellContexts>
      )
    },
    { width: options.width, height: options.height },
  )
  await renderFirstFrame(app)
  return app
}

function contentLines(frame: string) {
  return frame
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

function expectWithin(frame: string, width: number, ambiguousWidth: AmbiguousWidth) {
  for (const line of frame.split("\n").map((item) => item.trimEnd())) {
    expect(cellWidth(line, ambiguousWidth)).toBeLessThanOrEqual(width)
  }
}

test("renders the 80x24 skeleton", async () => {
  await using tmp = await shellState()
  const app = await renderFrame(frameProps, { width: 80, height: 24, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("◇─◆ GraphAgent")
    expect(frame).toContain("› 会话标题")
    expect(frame).toContain("主区内容")
    expect(frame).toContain("状态带")
    expect(frame).toContain("底区")
    expect(frame).toContain("build")
    expectWithin(frame, 80, 1)
    expect(frame).toMatchSnapshot()
  } finally {
    app.renderer.destroy()
  }
})

test("renders the 100x30 skeleton", async () => {
  await using tmp = await shellState()
  const app = await renderFrame(frameProps, { width: 100, height: 30, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Claude Sonnet 4.5")
    expect(frame).toContain("上下文 24%")
    expect(frame).toMatchSnapshot()
  } finally {
    app.renderer.destroy()
  }
})

test("renders the 120x40 skeleton", async () => {
  await using tmp = await shellState()
  const app = await renderFrame(frameProps, { width: 120, height: 40, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Claude Sonnet 4.5")
    expect(frame).toContain("上下文 24%")
    expect(frame).toContain("主区内容")
    expectWithin(frame, 120, 1)
    expect(frame).toMatchSnapshot()
  } finally {
    app.renderer.destroy()
  }
})

test("renders the 140x40 skeleton", async () => {
  await using tmp = await shellState()
  const app = await renderFrame(frameProps, { width: 140, height: 40, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Claude Sonnet 4.5")
    expect(frame).toContain("状态带")
    expect(frame).toContain("底区")
    expect(frame).toMatchSnapshot()
  } finally {
    app.renderer.destroy()
  }
})

test("renders only the too-small notice below the minimum width", async () => {
  await using tmp = await shellState()
  const app = await renderFrame(frameProps, { width: 59, height: 24, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("终端太小")
    expect(frame).not.toContain("GraphAgent")
    expect(frame).not.toContain("主区内容")
    expect(contentLines(frame)).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("renders only the too-small notice below the minimum height", async () => {
  await using tmp = await shellState()
  const app = await renderFrame(frameProps, { width: 80, height: 11, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("终端太小")
    expect(frame).not.toContain("GraphAgent")
    expect(contentLines(frame)).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("renders the skeleton exactly at the minimum size", async () => {
  await using tmp = await shellState()
  const app = await renderFrame(frameProps, { width: 60, height: 12, state: tmp.path })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("◇─◆ GraphAgent")
    expect(frame).not.toContain("终端太小")
    expectWithin(frame, 60, 1)
  } finally {
    app.renderer.destroy()
  }
})

test("translates the too-small notice", async () => {
  await using tmp = await shellState()
  setLanguage("en")
  const app = await renderFrame(frameProps, { width: 59, height: 24, state: tmp.path })

  try {
    expect(app.captureCharFrame()).toContain("Terminal too small")
  } finally {
    app.renderer.destroy()
  }
})

for (const ambiguousWidth of [1, 2] as const) {
  test(`keeps the top bar and footer within 80 columns with ambiguous_width ${ambiguousWidth}`, async () => {
    await using tmp = await shellState({ ambiguous_width: ambiguousWidth })
    const app = await renderFrame(
      () => ({
        ...frameProps(),
        topBar: {
          path: "一个非常长的会话标题，用来验证骨架在窄终端里不会溢出",
          right: { model: "Claude Sonnet 4.5", reasoning: "high", context: "上下文 24%" },
        },
        footer: {
          agent: "build",
          agentAction: "tab",
          hints: [...hints, { key: "ctrl+o", label: "展开输出" }],
        },
      }),
      { width: 80, height: 24, state: tmp.path },
    )

    try {
      expectWithin(app.captureCharFrame(), 80, ambiguousWidth)
    } finally {
      app.renderer.destroy()
    }
  })
}

test("keeps the drawer in the rightmost 40 columns above the bottom zone", async () => {
  await using tmp = await shellState()
  const app = await renderFrame(() => ({ ...frameProps(), drawer: <text>DRAWER</text> }), {
    width: 80,
    height: 24,
    state: tmp.path,
  })

  try {
    const frame = app.captureCharFrame()
    const drawerLine = frame.split("\n").find((line) => line.includes("DRAWER"))
    expect(drawerLine).toBeDefined()
    const drawerIndex = drawerLine!.indexOf("DRAWER")
    expect(cellWidth(drawerLine!.slice(0, drawerIndex), 1)).toBeGreaterThanOrEqual(40)
    expect(frame).toContain("底区")
    expect(frame).toContain("build")
  } finally {
    app.renderer.destroy()
  }
})

// #886 F1-17: the drawer overlays the main and status area only. Its lower edge is the
// upper edge of the bottom zone, so it never covers the bottom zone or the footer.
const DRAWER_SIZES = [
  { width: 80, height: 24 },
  { width: 120, height: 40 },
] as const

for (const size of DRAWER_SIZES) {
  test(`ends the drawer exactly at the top of the bottom zone at ${size.width}x${size.height}`, async () => {
    await using tmp = await shellState()
    const app = await renderFrame(
      () => ({
        ...frameProps(),
        bottomZone: (
          <box id="zone" height={3} flexShrink={0}>
            <text>底区</text>
          </box>
        ),
        drawer: <text id="drawer-content">DRAWER</text>,
      }),
      { ...size, state: tmp.path },
    )

    try {
      const zone = app.renderer.root.findDescendantById("zone")
      const drawer = app.renderer.root.findDescendantById("drawer-content")?.parent
      expect(zone).toBeDefined()
      expect(drawer).toBeDefined()
      if (!zone || !drawer) return

      // The footer is the last row; the bottom zone sits right above it.
      const footerTop = size.height - 1
      expect(zone.screenY + zone.height).toBe(footerTop)

      const drawerBottom = drawer.screenY + drawer.height
      expect(drawerBottom).toBe(zone.screenY)
      expect(drawerBottom).toBeLessThanOrEqual(footerTop)

      // It starts below the top bar and its blank row, and hugs the right edge.
      expect(drawer.screenY).toBe(2)
      expect(drawer.width).toBe(40)
      expect(drawer.screenX + drawer.width).toBe(size.width)

      // Nothing of the bottom zone or the footer is painted over.
      const rows = app.captureCharFrame().split("\n")
      expect(rows[zone.screenY]).toContain("底区")
      expect(rows[footerTop]).toContain("build")
      expect(rows[footerTop]).toContain("命令")
      for (let row = zone.screenY; row < size.height; row++) expect(rows[row]).not.toContain("DRAWER")
      expect(rows[drawer.screenY]).toContain("DRAWER")
    } finally {
      app.renderer.destroy()
    }
  })
}
