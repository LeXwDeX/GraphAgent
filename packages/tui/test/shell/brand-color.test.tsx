// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { CapturedFrame, RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { DEFAULT_THEME } from "../../src/context/theme"
import { setLanguage } from "../../src/i18n"
import { ListPanel, type ListItem } from "../../src/panel/list"
import { AppFrame, type AppFrameProps } from "../../src/shell/app-frame"
import { BottomZone, createBottomZoneState } from "../../src/shell/bottom-zone"
import type { DagIndicatorState } from "../../src/shell/dag-indicator"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import { renderPanel } from "../panel/contexts"
import { ShellContexts, renderFirstFrame, shellState } from "./contexts"

/**
 * #886 1.3: the brand color `primary` may only paint a closed list of places; every other
 * place is gray. `test/theme.test.ts` checks that the theme file keeps `primary` out of every
 * other token. This file checks the rendered skeleton: it paints the frame, collects every run
 * of cells colored with the brand value and compares the runs with the whitelist.
 *
 * Whitelist item -> where it is checked:
 * 1. logo AGENT face and top bar `◆`  top bar here; the wordmark is in test/component/logo.test.tsx
 * 2. input prompt `›`                 the prompt draws no `›` today, nothing to paint
 * 3. selected row and panel title     the list panel scenario here
 * 4. running spinner, DAG run segment spinners take their color from the caller; the DAG bar is F4 (#1032)
 * 5. footer agent name                here
 * 6. footer `◆ DAG` (on)              here
 * 7. status band leading `◆`          F4 (#1032) has not filled the status band slot yet
 */

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

const MODES = ["dark", "light"] as const
type Mode = (typeof MODES)[number]

const SIZES = [
  { width: 80, height: 24 },
  { width: 120, height: 40 },
] as const

function brandOf(mode: Mode) {
  return resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], mode).primary
}

interface BrandRun {
  row: number
  /** `topbar` is the first row, `footer` the last, anything else `row <n>`. */
  place: string
  text: string
}

const label = (run: BrandRun) => `${run.place}:${run.text}`

/**
 * Every run of cells painted with `brand`. Foregrounds count only when they paint visible
 * text; a background in the brand color always counts. Dimmed regions blend toward black and
 * can no longer be matched by value (and wide characters under the overlay are not drawn at
 * all), so the scenes below keep their dimmed main area free of colored text.
 */
function brandRuns(frame: CapturedFrame, brand: RGBA) {
  const runs: BrandRun[] = []
  frame.lines.forEach((line, row) => {
    const place = row === 0 ? "topbar" : row === frame.lines.length - 1 ? "footer" : `row ${row}`
    for (const span of line.spans) {
      if (span.fg.equals(brand) && span.text.trim() !== "") runs.push({ row, place, text: span.text.trim() })
      if (span.bg.equals(brand)) runs.push({ row, place, text: "background" })
    }
  })
  return runs
}

/** Sorted labels of the runs, for comparing against an exact whitelist. */
const labels = (runs: readonly BrandRun[]) => runs.map(label).sort()

function rowOf(frame: string, text: string) {
  const row = frame.split("\n").findIndex((line) => line.includes(text))
  if (row < 0) throw new Error(`"${text}" is not on screen:\n${frame}`)
  return row
}

const hints = [
  { key: "/", label: "命令" },
  { key: "ctrl+b", label: "侧边栏" },
  { key: "?", label: "快捷键" },
]

/** Elements need a live renderer, so scenes are built by thunks that run inside the render. */
function skeleton(dag?: DagIndicatorState, extra: () => Partial<AppFrameProps> = () => ({})): AppFrameProps {
  return {
    topBar: { path: "会话标题", right: { model: "Claude Sonnet 4.5", reasoning: "high", context: "上下文 24%" } },
    footer: { agent: "build", agentAction: "tab", hints, dag },
    statusBand: <text>状态带</text>,
    bottomZone: <text>底区</text>,
    children: <text>主区内容</text>,
    ...extra(),
  }
}

async function renderSkeleton(
  createProps: () => AppFrameProps,
  options: { width: number; height: number; state: string; mode: Mode },
) {
  const app = await testRender(
    () => {
      const props = createProps()
      return (
        <ShellContexts state={options.state} mode={options.mode}>
          <AppFrame {...props}>{props.children}</AppFrame>
        </ShellContexts>
      )
    },
    { width: options.width, height: options.height },
  )
  await renderFirstFrame(app)
  return app
}

for (const mode of MODES) {
  for (const size of SIZES) {
    test(`paints only the top bar mark, the agent name and the DAG mark in the brand color (${mode} ${size.width}x${size.height})`, async () => {
      await using tmp = await shellState()
      const app = await renderSkeleton(() => skeleton("on"), { ...size, state: tmp.path, mode })

      try {
        const frame = app.captureCharFrame()
        // Sanity: the frame is the full skeleton, so an empty result cannot pass for a blank screen.
        for (const text of ["GraphAgent", "会话标题", "主区内容", "状态带", "底区", "build", "◆ DAG"]) {
          expect(frame).toContain(text)
        }
        expect(labels(brandRuns(app.captureSpans(), brandOf(mode)))).toEqual([
          "footer:build",
          "footer:◆ DAG",
          "topbar:◆",
        ])
      } finally {
        app.renderer.destroy()
      }
    })

    for (const dag of ["off", "unavailable"] as const) {
      test(`paints the ${dag} DAG mark in a muted color (${mode} ${size.width}x${size.height})`, async () => {
        await using tmp = await shellState()
        const app = await renderSkeleton(() => skeleton(dag), { ...size, state: tmp.path, mode })

        try {
          expect(app.captureCharFrame()).toContain("DAG")
          expect(labels(brandRuns(app.captureSpans(), brandOf(mode)))).toEqual(["footer:build", "topbar:◆"])
        } finally {
          app.renderer.destroy()
        }
      })
    }
  }

  test(`keeps the brand color on the compact DAG mark and nowhere else (${mode})`, async () => {
    await using tmp = await shellState()
    // Below 80 columns the footer keeps only the marker glyph of the indicator.
    const app = await renderSkeleton(() => skeleton("on"), { width: 70, height: 24, state: tmp.path, mode })

    try {
      const frame = app.captureCharFrame()
      expect(frame).not.toContain("DAG")
      expect(labels(brandRuns(app.captureSpans(), brandOf(mode)))).toEqual(["footer:build", "footer:◆", "topbar:◆"])
    } finally {
      app.renderer.destroy()
    }
  })

  test(`leaves the drawer, the status band and the footer hints gray (${mode})`, async () => {
    await using tmp = await shellState()
    const app = await renderSkeleton(() => skeleton("on", () => ({ drawer: <text>抽屉内容</text> })), {
      width: 120,
      height: 40,
      state: tmp.path,
      mode,
    })

    try {
      const frame = app.captureCharFrame()
      for (const text of ["抽屉内容", "状态带", "命令", "侧边栏"]) expect(frame).toContain(text)
      expect(labels(brandRuns(app.captureSpans(), brandOf(mode)))).toEqual(["footer:build", "footer:◆ DAG", "topbar:◆"])
    } finally {
      app.renderer.destroy()
    }
  })
}

const themes: ListItem<string>[] = [
  { id: "light", value: "light", title: "浅色主题" },
  { id: "dark", value: "dark", title: "深色主题" },
  { id: "custom", value: "custom", title: "自定义主题" },
]

for (const size of SIZES) {
  test(`adds only the panel title and the selected row mark when a list panel is open (${size.width}x${size.height})`, async () => {
    await using tmp = await shellState()
    const bottomZone = createBottomZoneState()
    bottomZone.host.push({
      id: "themes",
      render: () => <ListPanel title="选择主题" items={themes} onSelect={() => {}} />,
    })

    const app = await renderPanel(
      () => (
        <AppFrame
          {...skeleton("on", () => ({
            bottomZone: <BottomZone state={bottomZone} composer={<text>输入框</text>} />,
            dimmed: bottomZone.dimmed,
          }))}
        >
          <text>主区内容</text>
        </AppFrame>
      ),
      { ...size, state: tmp.path },
    )

    try {
      const frame = app.captureCharFrame()
      expect(bottomZone.dimmed()).toBe(true)
      for (const text of ["选择主题", "浅色主题", "深色主题"]) expect(frame).toContain(text)
      expect(frame).not.toContain("输入框")

      // The first row is selected: the panel title and that row (its `›`, and its text if the
      // panel colors it) are the only additions to the skeleton's own three places.
      const runs = brandRuns(app.captureSpans(), brandOf("dark"))
      const title = rowOf(frame, "选择主题")
      const selected = rowOf(frame, "浅色主题")
      const selectedRow = runs.filter((run) => run.row === selected).map((run) => run.text)
      expect(selectedRow).toContain("›")
      for (const text of selectedRow) expect(["›", "浅色主题"]).toContain(text)
      expect(labels(runs.filter((run) => run.row !== selected))).toEqual(
        [`row ${title}:选择主题`, "footer:build", "footer:◆ DAG", "topbar:◆"].sort(),
      )
    } finally {
      app.renderer.destroy()
    }
  })
}

test("a brand colored run outside the whitelist shows up in the comparison", async () => {
  await using tmp = await shellState()
  const brand = brandOf("dark")
  const app = await renderSkeleton(
    () =>
      skeleton("on", () => ({
        children: (
          <text>
            <span style={{ fg: brand }}>泄漏</span>
          </text>
        ),
      })),
    { width: 80, height: 24, state: tmp.path, mode: "dark" },
  )

  try {
    // Guards the guard: the collector must see a stray brand colored word in the main area.
    const runs = labels(brandRuns(app.captureSpans(), brand))
    expect(runs).toContain(`row ${rowOf(app.captureCharFrame(), "泄漏")}:泄漏`)
    expect(runs).not.toEqual(["footer:build", "footer:◆ DAG", "topbar:◆"])
  } finally {
    app.renderer.destroy()
  }
})
