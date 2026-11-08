/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { setLanguage } from "../../src/i18n"
import { AppFrame, type AppFrameProps } from "../../src/shell/app-frame"
import type { FooterHint } from "../../src/shell/footer"
import { cellWidth, type AmbiguousWidth } from "../../src/ui/width"
import { ShellContexts, shellState } from "./contexts"

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
  let ready!: () => void
  const settled = new Promise<void>((resolve) => (ready = resolve))
  const app = await testRender(
    () => {
      const props = createProps()
      return (
        <ShellContexts state={options.state} onReady={ready}>
          <AppFrame {...props}>{props.children ?? <text>主区内容</text>}</AppFrame>
        </ShellContexts>
      )
    },
    { width: options.width, height: options.height },
  )
  await settled
  // KVReady resolves before the reactive switch from its blank fallback to the
  // frame children has painted; render until the first non-empty frame instead
  // of assuming a fixed number of frames.
  for (let attempt = 0; attempt < 50; attempt++) {
    await app.renderOnce()
    if (app.captureCharFrame().trim().length > 0) break
  }
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
