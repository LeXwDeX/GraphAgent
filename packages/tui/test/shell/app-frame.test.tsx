// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { DEFAULT_THEME } from "../../src/context/theme"
import { setLanguage } from "../../src/i18n"
import { AppFrame, DIMMED_OPACITY, type AppFrameProps } from "../../src/shell/app-frame"
import type { FooterHint } from "../../src/shell/footer"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
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

/*
 * #886 3.1: while a bottom-zone panel or ask surface is open, the main area is dimmed. A
 * translucent box over it is not an option: OpenTUI's alpha fill blanks every cell that holds a
 * wide character, so a Chinese transcript would disappear while a panel is open. The frame
 * dims the area with `opacity` instead, and these tests pin what that keeps and what it leaves.
 */

const background = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark").background

type DimScene = Awaited<ReturnType<typeof renderDimScene>>

async function renderDimScene(options: {
  dim: boolean
  drawer: boolean
  main?: string
  state: string
  width?: number
  height?: number
}) {
  let setDim!: (on: boolean) => void
  let setDrawer!: (on: boolean) => void
  const app = await renderFrame(
    () => {
      const [dim, updateDim] = createSignal(options.dim)
      const [drawer, updateDrawer] = createSignal(options.drawer)
      setDim = updateDim
      setDrawer = updateDrawer
      const drawerContent = createMemo(() => (drawer() ? <text>DRAWER</text> : undefined))
      return {
        ...frameProps(),
        children: <text>{options.main ?? "主区内容 MAINTEXT"}</text>,
        dimmed: dim,
        get drawer() {
          return drawerContent()
        },
      }
    },
    { width: options.width ?? 80, height: options.height ?? 24, state: options.state },
  )
  return {
    app,
    setDim,
    setDrawer,
    /** Renders the frames that follow a state change. */
    async settle() {
      for (let index = 0; index < 3; index++) {
        await app.renderOnce()
        await Bun.sleep(0)
      }
    },
  }
}

/** The first painted span that holds `text`. */
function paintOf(scene: DimScene, text: string) {
  for (const line of scene.app.captureSpans().lines) {
    for (const span of line.spans) if (span.text.includes(text)) return span
  }
  throw new Error(`no span contains ${text}:\n${scene.app.captureCharFrame()}`)
}

/** The channels of a color after the frame's dimming: blended toward the app background. */
function dimmedChannels(color: readonly number[]) {
  const [r, g, b] = color
  const [bgR, bgG, bgB] = background.toInts()
  const mix = (value: number | undefined, under: number | undefined) =>
    Math.round((value ?? 0) * DIMMED_OPACITY + (under ?? 0) * (1 - DIMMED_OPACITY))
  return [mix(r, bgR), mix(g, bgG), mix(b, bgB)]
}

function expectDimmed(after: RGBA, before: readonly number[]) {
  const expected = dimmedChannels(before)
  after
    .toInts()
    .slice(0, 3)
    .forEach((value, index) => expect(Math.abs(value - (expected[index] ?? 0))).toBeLessThanOrEqual(1))
  // Dimming must be visible: the text moved toward the dark background.
  expect(after.toInts()[0]).toBeLessThan(before[0] ?? 0)
}

test("dims the main area and the status band without erasing wide characters", async () => {
  await using tmp = await shellState()
  const plain = await renderDimScene({ dim: false, drawer: false, state: tmp.path })
  const dimmed = await renderDimScene({ dim: true, drawer: false, state: tmp.path })

  try {
    for (const scene of [plain, dimmed]) {
      const frame = scene.app.captureCharFrame()
      expect(frame).toContain("主区内容 MAINTEXT")
      expect(frame).toContain("状态带")
    }

    expectDimmed(paintOf(dimmed, "主区内容").fg, paintOf(plain, "主区内容").fg.toInts())
    expectDimmed(paintOf(dimmed, "状态带").fg, paintOf(plain, "状态带").fg.toInts())

    // The bars and the bottom zone are not part of the dimmed area.
    for (const text of ["GraphAgent", "底区", "build"]) {
      expect(paintOf(dimmed, text).fg.toInts()).toEqual(paintOf(plain, text).fg.toInts())
    }
  } finally {
    plain.app.renderer.destroy()
    dimmed.app.renderer.destroy()
  }
})

test("dims when a panel opens and restores the colors when it closes", async () => {
  await using tmp = await shellState()
  const scene = await renderDimScene({ dim: false, drawer: false, state: tmp.path })

  try {
    const before = paintOf(scene, "主区内容").fg.toInts()

    scene.setDim(true)
    await scene.settle()
    expect(scene.app.captureCharFrame()).toContain("主区内容 MAINTEXT")
    expectDimmed(paintOf(scene, "主区内容").fg, before)

    scene.setDim(false)
    await scene.settle()
    expect(scene.app.captureCharFrame()).toContain("主区内容 MAINTEXT")
    expect(paintOf(scene, "主区内容").fg.toInts()).toEqual(before)
  } finally {
    scene.app.renderer.destroy()
  }
})

// The drawer hides what is under it, so it is drawn above the dimmed area at full strength. That
// must hold whichever of the two appears first; an overlay that was inserted later used to land
// on top of the drawer and dim it, an earlier one let the drawer through.
const DRAWER_ORDERS = [
  { name: "the drawer and the dimming at once", dim: true, drawer: true, later: undefined },
  { name: "the drawer first, the dimming later", dim: false, drawer: true, later: "dim" },
  { name: "the dimming first, the drawer later", dim: true, drawer: false, later: "drawer" },
] as const

for (const order of DRAWER_ORDERS) {
  test(`keeps the drawer at full strength above the dimmed area: ${order.name}`, async () => {
    await using tmp = await shellState()
    // Wide enough to run under the drawer, which covers the right 40 of 80 columns.
    const main = "MAIN".repeat(20)
    const reference = await renderDimScene({ dim: false, drawer: true, main, state: tmp.path })
    const scene = await renderDimScene({ dim: order.dim, drawer: order.drawer, main, state: tmp.path })

    try {
      if (order.later === "dim") scene.setDim(true)
      if (order.later === "drawer") scene.setDrawer(true)
      await scene.settle()

      const row = scene.app
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("DRAWER"))
      expect(row).toBeGreaterThanOrEqual(0)
      const line = scene.app.captureCharFrame().split("\n")[row] ?? ""
      // Nothing of the main text shows through the drawer, and the main text left of it is intact.
      expect(line.slice(40).trimEnd()).toBe("DRAWER")
      expect(line.slice(0, 40)).toBe("MAIN".repeat(10))

      expect(paintOf(scene, "DRAWER").fg.toInts()).toEqual(paintOf(reference, "DRAWER").fg.toInts())
      const referenceMain = reference.app.captureSpans().lines[row]?.spans[0]
      const sceneMain = scene.app.captureSpans().lines[row]?.spans[0]
      expect(referenceMain?.text.startsWith("MAIN")).toBe(true)
      expect(sceneMain).toBeDefined()
      if (referenceMain && sceneMain) expectDimmed(sceneMain.fg, referenceMain.fg.toInts())
    } finally {
      reference.app.renderer.destroy()
      scene.app.renderer.destroy()
    }
  })
}
