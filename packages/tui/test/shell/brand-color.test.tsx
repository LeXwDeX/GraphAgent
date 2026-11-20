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
import { promptTop } from "../fixture/run-app"
import { AppRoutes } from "../fixture/route-frame"
import { renderPanel } from "../panel/contexts"
import { assistantMessage, textPart, userMessage, type MessageEntry } from "../fixture/session-records"
import { json } from "../fixture/tui-sdk"
import { mountRoute, sessionFixture } from "../routes/dag-mode-harness"
import { mountSessionShell } from "../routes/session-shell"
import { ShellContexts, renderFirstFrame, shellState } from "./contexts"

/**
 * #886 1.3: the brand color `primary` may only paint a closed list of places; every other
 * place is gray. `test/theme.test.ts` checks that the theme file keeps `primary` out of every
 * other token. This file checks the rendered skeleton: it paints the frame, collects every run
 * of cells colored with the brand value and compares the runs with the whitelist.
 *
 * Whitelist item -> where it is checked:
 * 1. logo AGENT face and top bar `◆`  top bar here; the wordmark is in test/component/logo.test.tsx
 * 2. selected row and panel title     the list panel scenario here
 * 3. running spinner, DAG run segment spinners take their color from the caller; the DAG bar is in
 *                                     test/shell/status-band.test.tsx
 * 4. footer agent name                here
 * 5. footer `◆ DAG` (on)              here
 * 6. status band leading `◆`          test/shell/status-band.test.tsx
 * 7. input prompt `›` (`$` in shell mode, #1616)
 *                                     the real input box of the home and session routes, here: the skeleton scenes
 *                                     fill the bottom zone with stand-in text, which has no prompt
 * 8. user message line mark `›` (#1615) a real transcript here: the `›` of each user message and nothing else of the
 *                                     transcript, whose `⏺` of the assistant and `∴` of a thought stay gray
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
 * text; a background in the brand color always counts. Dimmed regions fade toward the app
 * background and can no longer be matched by value, so the scenes below keep their dimmed
 * main area free of colored text.
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
  try {
    await renderFirstFrame(app)
  } catch (error) {
    app.renderer.destroy()
    throw error
  }
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
      { ...size, state: tmp.path, zone: false },
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

test("paints the › that opens a user message in the brand color, and nothing else of the transcript (#1615)", async () => {
  const sessionID = "ses_brand_transcript"
  const entries: MessageEntry[] = [
    {
      info: userMessage("msg_brand_q1", sessionID, 10),
      parts: [textPart("msg_brand_q1", sessionID, "prt_brand_q1", "第一个问题")],
    },
    {
      info: assistantMessage("msg_brand_a1", sessionID, "msg_brand_q1", 11),
      parts: [
        {
          id: "prt_brand_thought",
          sessionID,
          messageID: "msg_brand_a1",
          type: "reasoning",
          text: "**A title**\n\nthe body of a thought",
          time: { start: 1_000, end: 13_000 },
        },
        textPart("msg_brand_a1", sessionID, "prt_brand_a1", "第一个回答"),
      ],
    },
    {
      info: userMessage("msg_brand_q2", sessionID, 20),
      parts: [textPart("msg_brand_q2", sessionID, "prt_brand_q2", "第二个问题\n第二行")],
    },
    {
      info: assistantMessage("msg_brand_a2", sessionID, "msg_brand_q2", 21),
      parts: [textPart("msg_brand_a2", sessionID, "prt_brand_a2", "最后的回答")],
    },
  ]
  const shell = await mountSessionShell({
    sessionID,
    sessions: [sessionFixture(sessionID)],
    width: 80,
    height: 30,
    handler: (url) => (url.pathname === `/session/${sessionID}/message` ? json(entries) : undefined),
  })

  try {
    const frame = await shell.waitForFrame((value) => value.includes("最后的回答"), "the transcript")
    // Sanity: every kind of row of the transcript is on screen, so an empty result cannot pass for a blank one.
    for (const text of ["› 第一个问题", "› 第二个问题", "∴ ", "⏺ 第一个回答", "⏺ 最后的回答"])
      expect(frame).toContain(text)

    const first = rowOf(frame, "第一个问题")
    const last = rowOf(frame, "最后的回答")
    const runs = brandRuns(await shell.spans(), brandOf("dark")).filter((run) => run.row >= first && run.row <= last)
    // One `›` on the row of each user message; the second line of the second message, the thought, and the answers
    // carry none.
    expect(labels(runs)).toEqual([`row ${first}:›`, `row ${rowOf(frame, "第二个问题")}:›`].sort())
  } finally {
    await shell.dispose()
  }
})

/**
 * The real input box, mounted in the app frame the way `app.tsx` does, not the skeleton's stand-in text: the runs of
 * brand color on the rows of the box (its edges and the input row). The harness paints the dark theme.
 */
async function inputBoxRuns(harness: Awaited<ReturnType<typeof mountRoute>>) {
  const rows = (await harness.frame()).split("\n").map((line) => line.trimEnd())
  const top = promptTop(rows)
  if (top < 0) throw new Error(`no input box in the frame:\n${rows.join("\n")}`)
  const runs = brandRuns(await harness.spans(), brandOf("dark")).filter((run) => run.row >= top && run.row <= top + 2)
  return { runs, row: top + 1 }
}

for (const route of ["home", "session"] as const) {
  for (const size of SIZES) {
    test(`paints the input box's prompt mark in the brand color and nothing else of the box (${route} ${size.width}x${size.height})`, async () => {
      const harness = await mountRoute({
        route: route === "home" ? { type: "home" } : { type: "session", sessionID: "ses_brand" },
        view: () => <AppRoutes />,
        frame: true,
        sessions: [sessionFixture("ses_brand")],
        withAgentAndModel: true,
        ...size,
      })
      try {
        await harness.settle()
        // The normal mode marks the input with `›`: the border, the placeholder and the status row are gray.
        let { runs, row } = await inputBoxRuns(harness)
        expect(labels(runs)).toEqual([`row ${row}:›`])

        // Shell mode swaps the mark for `$`, in the same color and the same place.
        harness.app.mockInput.pressKey("!")
        await harness.settle()
        ;({ runs, row } = await inputBoxRuns(harness))
        expect(labels(runs)).toEqual([`row ${row}:$`])

        // A typed draft is plain text: the box still holds only the mark.
        await harness.app.mockInput.typeText("ls")
        await harness.settle()
        ;({ runs, row } = await inputBoxRuns(harness))
        expect(labels(runs)).toEqual([`row ${row}:$`])
      } finally {
        await harness.dispose()
      }
    })
  }
}
