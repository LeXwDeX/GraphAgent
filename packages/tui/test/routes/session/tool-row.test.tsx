// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { TextAttributes, type CapturedFrame, type RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import type { ToolPart } from "@graphagent/sdk"
import { SPINNER_FRAMES } from "../../../src/component/spinner"
import { DEFAULT_THEME } from "../../../src/context/theme"
import type { Ticker } from "../../../src/context/ticker"
import { TickerProvider } from "../../../src/context/ticker-context"
import { setLanguage } from "../../../src/i18n"
import { ToolRow, toolRowState, type ToolRowProps, type ToolRowState } from "../../../src/routes/session/tool-row"
import { DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { cellWidth, type AmbiguousWidth } from "../../../src/ui/width"
import { ShellContexts, renderFirstFrame, shellState } from "../../shell/contexts"

/**
 * The row of one tool call (#1614): the dot in the color of its state, the name in bold and what the call acts on
 * muted after it, the result behind a `⎿`, and the line that counts what a fold leaves out. The row draws what it is
 * given, so these cases give it the strings and read the cells.
 */

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

const palette = () => resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")

type Rendered = Awaited<ReturnType<typeof renderRow>>

type Options = { width?: number; height?: number; ambiguousWidth?: AmbiguousWidth; ticker?: Ticker }

/** What the row is given; a function when it holds elements, which can only be made once the renderer is there. */
type Given = Omit<ToolRowProps, "width">
type Props = Given | (() => Given)

/** The row at `width` columns, in the provider stack of the shell, inside a column as wide as the transcript content. */
async function renderRow(props: Props, options: Options = {}) {
  const width = options.width ?? 80
  const tmp = await shellState(options.ambiguousWidth ? { ambiguous_width: options.ambiguousWidth } : {})
  const app = await testRender(
    () => (
      <ShellContexts state={tmp.path}>
        <TickerProvider ticker={options.ticker}>
          <box width={width} flexDirection="column">
            <ToolRow {...(typeof props === "function" ? props() : props)} width={width} />
          </box>
        </TickerProvider>
      </ShellContexts>
    ),
    { width, height: options.height ?? 8 },
  )
  await renderFirstFrame(app)
  return {
    app,
    width,
    /** The rows of the frame with nothing after their last cell. */
    rows() {
      return app
        .captureCharFrame()
        .split("\n")
        .map((line) => line.trimEnd())
    },
    spans: () => app.captureSpans(),
    async dispose() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

function span(frame: CapturedFrame, needle: string) {
  for (const line of frame.lines) {
    const found = line.spans.find((item) => item.text.includes(needle))
    if (found) return found
  }
  return undefined
}

const colorOf = (frame: CapturedFrame, needle: string) => span(frame, needle)?.fg

/** The frame as it is when `read` is done with it, whatever it throws. */
async function using<T>(props: Props, options: Options, read: (view: Rendered) => Promise<T> | T) {
  const view = await renderRow(props, options)
  try {
    return await read(view)
  } finally {
    await view.dispose()
  }
}

const CALL = "bun outdated --recursive"

type Case = {
  state: ToolRowState
  result: string
  dot: () => RGBA
  fg: () => RGBA
}

// What each state says: the dot in front of the name, and the color of the line under it.
const CASES: readonly Case[] = [
  { state: "pending", result: "准备中…", dot: () => palette().textMuted, fg: () => palette().textMuted },
  { state: "running", result: "运行中", dot: () => palette().primary, fg: () => palette().primary },
  { state: "done", result: "完成", dot: () => palette().success, fg: () => palette().text },
  { state: "failed", result: "失败 · boom", dot: () => palette().error, fg: () => palette().error },
  { state: "denied", result: "已拒绝", dot: () => palette().error, fg: () => palette().error },
  { state: "waiting", result: "等待授权", dot: () => palette().warning, fg: () => palette().warning },
]

for (const item of CASES) {
  test(`a call that is ${item.state} has the dot and the result line of its state`, async () => {
    await using({ state: item.state, name: "Bash", arg: CALL, result: item.result }, {}, (view) => {
      const rows = view.rows()
      const spans = view.spans()
      if (item.state === "running") {
        // No static dot for a call that runs: the braille spinner is in its place, and in the color of what runs.
        const glyph = SPINNER_FRAMES.find((frame) => rows[0].includes(frame))
        expect(glyph).toBeDefined()
        expect(rows[0]).toBe(`   ${glyph} Bash ${CALL}`)
        expect(colorOf(spans, glyph!)?.equals(palette().primary)).toBe(true)
        expect(rows[0]).not.toContain("⏺")
      } else {
        expect(rows[0]).toBe(`   ⏺ Bash ${CALL}`)
        expect(colorOf(spans, "⏺")?.equals(item.dot())).toBe(true)
      }
      expect(rows[1]).toBe(`     ⎿ ${item.result}`)
      // The name is bold in the text color; what the call acts on is muted; the mark of the line under it is the dimmest.
      const name = span(spans, "Bash")!
      expect(name.fg.equals(palette().text)).toBe(true)
      expect(name.attributes & TextAttributes.BOLD).toBeTruthy()
      expect(colorOf(spans, CALL)?.equals(palette().textMuted)).toBe(true)
      expect(colorOf(spans, "⎿")?.equals(palette().textDim)).toBe(true)
      expect(colorOf(spans, item.result)?.equals(item.fg())).toBe(true)
      // The result is not bold: only the name is.
      expect(span(spans, item.result)!.attributes & TextAttributes.BOLD).toBeFalsy()
    })
  })
}

test("a result color the caller gives replaces the one of the state", async () => {
  await using(
    { state: "done", name: "Bash", arg: CALL, result: "退出码 1", resultColor: palette().error },
    {},
    (view) => {
      const spans = view.spans()
      expect(colorOf(spans, "退出码 1")?.equals(palette().error)).toBe(true)
      // The dot is the state's own: the call completed.
      expect(colorOf(spans, "⏺")?.equals(palette().success)).toBe(true)
    },
  )
})

test("what a call that runs has printed last is a muted tail on the result line", async () => {
  await using(
    { state: "running", name: "Bash", arg: CALL, result: "运行中", detail: "compiling 12/40" },
    {},
    (view) => {
      expect(view.rows()[1]).toBe("     ⎿ 运行中 · compiling 12/40")
      const spans = view.spans()
      expect(colorOf(spans, "运行中")?.equals(palette().primary)).toBe(true)
      expect(colorOf(spans, "compiling")?.equals(palette().textMuted)).toBe(true)
    },
  )
})

test("a dot color the caller gives replaces the one of the state, and the spinner takes it too", async () => {
  await using({ state: "pending", name: "Task", arg: "explore · a", dotColor: palette().statusQueued }, {}, (view) => {
    expect(colorOf(view.spans(), "⏺")?.equals(palette().statusQueued)).toBe(true)
  })
  await using({ state: "running", name: "Task", arg: "explore · a", dotColor: palette().error }, {}, (view) => {
    const glyph = SPINNER_FRAMES.find((frame) => view.rows()[0].includes(frame))
    expect(glyph).toBeDefined()
    expect(colorOf(view.spans(), glyph!)?.equals(palette().error)).toBe(true)
  })
})

test("a tag stands at the right end of the first line, dim, and leaves the title whole", async () => {
  await using({ state: "done", name: "Task", arg: "explore · scan", tag: "main agent · foreground" }, {}, (view) => {
    const first = view.rows()[0]
    expect(first).toStartWith("   ⏺ Task explore · scan")
    expect(first).toEndWith("main agent · foreground")
    // It is flush with the right end of the content, which is the width of the row.
    expect(cellWidth(first, 1)).toBe(view.width)
    expect(colorOf(view.spans(), "main agent")?.equals(palette().textDim)).toBe(true)
    expect(colorOf(view.spans(), "explore · scan")?.equals(palette().textMuted)).toBe(true)
  })
})

test("a tag is left out where the whole of it does not fit beside the whole title, and the title is not cut for it", async () => {
  const tag = "main agent · foreground"
  // A row at 80 columns has 77 cells. The title is the dot, `Task`, a space and the arg: 7 cells and the arg; the tag is
  // 23 cells and keeps two off the title, so it fits beside an arg of up to 45.
  const fits = "x".repeat(45)
  const near = "x".repeat(46)
  await using({ state: "done", name: "Task", arg: fits, tag }, {}, (view) => {
    expect(view.rows()[0]).toBe(`   ⏺ Task ${fits}${" ".repeat(2)}${tag}`)
  })
  await using({ state: "done", name: "Task", arg: near, tag }, {}, (view) => {
    expect(view.rows()[0]).toBe(`   ⏺ Task ${near}`)
  })
  // A title that does not fit even without it is cut as it is, with no tag.
  await using({ state: "done", name: "Task", arg: "x".repeat(200), tag }, {}, (view) => {
    expect(view.rows()[0]).toEndWith("…")
    expect(view.rows()[0]).not.toContain("main agent")
    expect(cellWidth(view.rows()[0], 1)).toBeLessThanOrEqual(view.width)
  })
})

for (const ambiguousWidth of [1, 2] as const) {
  test(`a tag is never wider than the row, at ambiguous_width ${ambiguousWidth}`, async () => {
    // `·` and `…` are ambiguous glyphs: two cells each at 2, so the tag that fit at 1 may not at 2.
    for (const arg of ["x".repeat(30), "x".repeat(40), "x".repeat(60)]) {
      await using(
        { state: "done", name: "Task", arg, tag: "主 agent · 后台（已转）" },
        { ambiguousWidth, width: 60 },
        (view) => {
          expect(cellWidth(view.rows()[0], ambiguousWidth)).toBeLessThanOrEqual(60)
        },
      )
    }
  })
}

test("a note and an action end the result line: the note dim after a separator, the action in the muted color two cells on", async () => {
  await using(
    { state: "running", name: "Task", arg: "a", result: "运行中", note: "转后台 ctrl+x w", action: "进入" },
    {},
    (view) => {
      expect(view.rows()[1]).toBe("     ⎿ 运行中 · 转后台 ctrl+x w  进入")
      const spans = view.spans()
      expect(colorOf(spans, "运行中")?.equals(palette().primary)).toBe(true)
      expect(colorOf(spans, "转后台")?.equals(palette().textDim)).toBe(true)
      expect(colorOf(spans, "进入")?.equals(palette().textMuted)).toBe(true)
    },
  )
})

test("the action is in the text color under the pointer, on a row that has a click only", async () => {
  await using(
    { state: "done", name: "Task", arg: "a", result: "完成", action: "进入", onClick: () => {} },
    {},
    async (view) => {
      const at = await cellOf(view, "进入")
      await view.app.mockMouse.moveTo(at.column + 1, at.row)
      await view.app.renderOnce()
      expect(colorOf(view.spans(), "进入")?.equals(palette().text)).toBe(true)
      await view.app.mockMouse.moveTo(view.width - 1, 6)
      await view.app.renderOnce()
      expect(colorOf(view.spans(), "进入")?.equals(palette().textMuted)).toBe(true)
    },
  )
  await using({ state: "done", name: "Task", arg: "a", result: "完成", action: "进入" }, {}, async (view) => {
    const at = await cellOf(view, "进入")
    await view.app.mockMouse.moveTo(at.column + 1, at.row)
    await view.app.renderOnce()
    expect(colorOf(view.spans(), "进入")?.equals(palette().textMuted)).toBe(true)
  })
})

test("where the result line is tight, the note goes first, then the action, and the result is cut only to what is left", async () => {
  const given = { state: "done", name: "Task", arg: "a", note: "转后台 ctrl+x w", action: "进入" } as const
  // At 80 columns the result line has 73 cells; the note takes 18 and the action 6, so all three fit with a result of up
  // to 49.
  const fits = "x".repeat(49)
  await using({ ...given, result: fits }, {}, (view) => {
    expect(view.rows()[1]).toBe(`     ⎿ ${fits} · 转后台 ctrl+x w  进入`)
  })
  // One cell more and the note is left out whole, not cut, and the result is not cut for it.
  await using({ ...given, result: "x".repeat(50) }, {}, (view) => {
    expect(view.rows()[1]).toBe(`     ⎿ ${"x".repeat(50)}  进入`)
  })
  // A result wider than the line is cut for the action, which stays.
  await using({ ...given, result: "x".repeat(200) }, {}, (view) => {
    expect(view.rows()[1]).toBe(`     ⎿ ${"x".repeat(66)}…  进入`)
  })
  await using({ ...given, result: "x".repeat(200) }, { width: 20 }, (view) => {
    expect(view.rows()[1]).not.toContain("进入")
    expect(view.rows()[1]).toEndWith("…")
    expect(cellWidth(view.rows()[1], 1)).toBeLessThanOrEqual(20)
  })
})

test("elements given as the result are drawn under the mark, a line to a row, wrapped at the room they have", async () => {
  const result = () => (
    <box>
      <text>first line</text>
      <text>second line</text>
    </box>
  )
  await using(
    () => ({ state: "done", name: "Read", arg: "a.ts", result: result() }),
    {},
    (view) => {
      expect(view.rows().slice(0, 3)).toEqual(["   ⏺ Read a.ts", "     ⎿ first line", "       second line"])
    },
  )
})

test("a call without a result has no line under it", async () => {
  await using({ state: "pending", name: "Bash" }, {}, (view) => {
    expect(view.rows()[0]).toBe("   ⏺ Bash")
    expect(view.rows().slice(1).join("")).toBe("")
  })
})

test("the state of a call comes from its part, and a permission it waits for outranks the part", () => {
  const input = {}
  const time = { start: 1, end: 2 }
  const pending: ToolPart["state"] = { status: "pending", input, raw: "" }
  const running: ToolPart["state"] = { status: "running", input, time: { start: 1 } }
  const completed: ToolPart["state"] = { status: "completed", input, output: "", title: "t", metadata: {}, time }
  const failed: ToolPart["state"] = { status: "error", input, error: "boom", time }
  const denied: ToolPart["state"] = {
    status: "error",
    input,
    error: "The user rejected permission to use this tool.",
    time,
  }
  expect(toolRowState(pending, false)).toBe("pending")
  expect(toolRowState(running, false)).toBe("running")
  expect(toolRowState(completed, false)).toBe("done")
  expect(toolRowState(failed, false)).toBe("failed")
  expect(toolRowState(denied, false)).toBe("denied")
  expect(toolRowState(pending, true)).toBe("waiting")
  expect(toolRowState(running, true)).toBe("waiting")
  // A call that ended is not waiting for anything.
  expect(toolRowState(completed, true)).toBe("done")
  expect(toolRowState(failed, true)).toBe("failed")
})

const WIDTHS = [80, 120]
const AMBIGUOUS: readonly AmbiguousWidth[] = [1, 2]

for (const width of WIDTHS) {
  for (const ambiguousWidth of AMBIGUOUS) {
    test(`no line of the row is wider than ${width} columns at ambiguous_width ${ambiguousWidth}`, async () => {
      // `…` and `·` are Ambiguous glyphs and take two cells at 2: what is cut has to be cut by cells, not by characters.
      const arg = `${"很长的参数 — a long argument · ".repeat(12)}…`
      const result = "一行很长的结果 · a long result… ".repeat(12)
      await using(
        {
          state: "running",
          name: "Bash",
          arg,
          result,
          detail: "最新一行 · the latest line… ".repeat(6),
          hidden: 34,
          expandKey: "ctrl+o",
        },
        { width, ambiguousWidth, height: 6 },
        (view) => {
          const rows = view.rows()
          // One row each: the call, its result, and the hint under them. Nothing wraps onto a row of its own.
          expect(rows.slice(0, 3).every(Boolean)).toBe(true)
          expect(rows.slice(3).join("")).toBe("")
          for (const row of rows) expect(cellWidth(row, ambiguousWidth)).toBeLessThanOrEqual(width)
          // The row that is cut ends in the ellipsis, in the muted color it is drawn in.
          expect(rows[0].endsWith("…")).toBe(true)
          expect(rows[1].endsWith("…")).toBe(true)
        },
      )
    })
  }
}

test("a name wider than the room leaves the arg nothing, and the row still holds in its width", async () => {
  await using({ state: "done", name: "WebSearch", arg: "x".repeat(200), result: "完成" }, { width: 20 }, (view) => {
    for (const row of view.rows()) expect(cellWidth(row, 1)).toBeLessThanOrEqual(20)
    expect(view.rows()[0]).toStartWith("   ⏺ WebSearch")
  })
})

test("an arg is one line: line breaks and escapes in it are not drawn", async () => {
  await using({ state: "done", name: "Bash", arg: "echo a\nb\u001b[31m red\u0007", result: "完成" }, {}, (view) => {
    const rows = view.rows()
    expect(rows[0]).toBe("   ⏺ Bash echo a b red")
    expect(rows[1]).toBe("     ⎿ 完成")
  })
})

const HINTS = {
  "zh-CN": {
    more: "… 还有 34 行 · ctrl+o 展开",
    moreClick: "… 还有 34 行 · 点击展开",
    long: "… 内容较长 · ctrl+o 展开",
    less: "ctrl+o 收起",
  },
  en: {
    more: "… 34 more lines · ctrl+o expand",
    moreClick: "… 34 more lines · click to expand",
    long: "… long output · ctrl+o expand",
    less: "ctrl+o collapse",
  },
} as const

for (const language of ["zh-CN", "en"] as const) {
  test(`a folded call has a third line that counts what the fold leaves out, in ${language}`, async () => {
    setLanguage(language)
    const says = HINTS[language]
    await using(
      { state: "done", name: "Bash", arg: CALL, result: "out 40", hidden: 34, expandKey: "ctrl+o" },
      {},
      (view) => {
        expect(view.rows().slice(0, 3)).toEqual(["   ⏺ Bash " + CALL, "     ⎿ out 40", `       ${says.more}`])
        expect(colorOf(view.spans(), says.more)?.equals(palette().textDim)).toBe(true)
      },
    )
    // With no key bound it says click and names none; an output that is only a long line leaves no line out.
    await using({ state: "done", name: "Bash", arg: CALL, result: "out 40", hidden: 34, expandKey: "" }, {}, (view) => {
      expect(view.rows()[2]).toBe(`       ${says.moreClick}`)
      expect(view.rows()[2]).not.toMatch(/ctrl|\{/)
    })
    await using(
      { state: "done", name: "Bash", arg: CALL, result: "x…", hidden: 0, expandKey: "ctrl+o" },
      {},
      (view) => {
        expect(view.rows()[2]).toBe(`       ${says.long}`)
      },
    )
  })

  test(`an open row draws its body under the result and the hint that closes it, in ${language}`, async () => {
    setLanguage(language)
    const says = HINTS[language]
    const body = () => (
      <box>
        <text>out 1</text>
        <text>out 2</text>
        <text>out 3</text>
      </box>
    )
    await using(
      () => ({
        state: "done",
        name: "Bash",
        arg: CALL,
        result: "out 3",
        hidden: 2,
        expanded: true,
        expandKey: "ctrl+o",
        children: body(),
      }),
      { height: 8 },
      (view) => {
        expect(view.rows().slice(0, 6)).toEqual([
          "   ⏺ Bash " + CALL,
          "     ⎿ out 3",
          "       out 1",
          "       out 2",
          "       out 3",
          `       ${says.less}`,
        ])
        expect(colorOf(view.spans(), says.less)?.equals(palette().textDim)).toBe(true)
      },
    )
  })
}

test("a row that folds nothing has no third line, and one that is not open does not draw its body", async () => {
  const body = () => <text>the body</text>
  await using(
    () => ({ state: "done", name: "Read", arg: "a.ts", result: "读取 3 行", children: body() }),
    {},
    (view) => {
      expect(view.rows().slice(0, 3)).toEqual(["   ⏺ Read a.ts", "     ⎿ 读取 3 行", ""])
      expect(view.rows().join("\n")).not.toContain("the body")
    },
  )
})

test("the open row of a call that failed draws its error under the result, with no hint", async () => {
  const error = () => <text>ENOENT: no such file</text>
  await using(
    () => ({ state: "failed", name: "Read", arg: "a.ts", result: "失败 · ENOENT", expanded: true, children: error() }),
    {},
    (view) => {
      expect(view.rows().slice(0, 3)).toEqual(["   ⏺ Read a.ts", "     ⎿ 失败 · ENOENT", "       ENOENT: no such file"])
    },
  )
})

test("two rows in a column have a blank line between them, and the first has none above it", async () => {
  const tmp = await shellState()
  const app = await testRender(
    () => (
      <ShellContexts state={tmp.path}>
        <box width={80} flexDirection="column">
          <ToolRow state="done" name="Read" arg="a.ts" result="读取 1 行" width={80} />
          <ToolRow state="done" name="Grep" arg='"x"' result="无匹配" width={80} />
        </box>
      </ShellContexts>
    ),
    { width: 80, height: 8 },
  )
  try {
    await renderFirstFrame(app)
    await app.renderOnce()
    const rows = app
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())
    expect(rows.slice(0, 5)).toEqual(["   ⏺ Read a.ts", "     ⎿ 读取 1 行", "", '   ⏺ Grep "x"', "     ⎿ 无匹配"])
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

/** Clicks the first cell of `text` in the frame the test has rendered. */
async function cellOf(view: Rendered, text: string) {
  await view.app.renderOnce()
  const rows = view.rows()
  const row = rows.findIndex((line) => line.includes(text))
  expect(row).toBeGreaterThanOrEqual(0)
  return { row, column: rows[row].indexOf(text) }
}

test("a click on a row that has one runs it, and a selection that ends on the row is not a click", async () => {
  setLanguage("zh-CN")
  let clicks = 0
  await using(
    { state: "done", name: "Bash", arg: CALL, result: "out 40", hidden: 34, onClick: () => clicks++ },
    {},
    async (view) => {
      const hint = await cellOf(view, "还有")
      await view.app.mockMouse.click(hint.column + 1, hint.row)
      expect(clicks).toBe(1)

      // A drag over the text selects it; the button goes up on the row, and the row leaves it alone.
      view.app.renderer.clearSelection()
      const arg = await cellOf(view, CALL)
      await view.app.mockMouse.drag(arg.column, arg.row, arg.column + 6, arg.row)
      await view.app.renderOnce()
      expect(view.app.renderer.getSelection()?.getSelectedText()).toBeTruthy()
      expect(clicks).toBe(1)

      view.app.renderer.clearSelection()
      await view.app.mockMouse.click(arg.column + 12, arg.row)
      expect(clicks).toBe(2)
    },
  )
})

test("the mouse over a row that has a click paints its arg in the text color, and off it the muted one", async () => {
  await using({ state: "done", name: "Bash", arg: CALL, result: "out 40", onClick: () => {} }, {}, async (view) => {
    expect(colorOf(view.spans(), CALL)?.equals(palette().textMuted)).toBe(true)
    const arg = await cellOf(view, CALL)
    await view.app.mockMouse.moveTo(arg.column + 2, arg.row)
    await view.app.renderOnce()
    expect(colorOf(view.spans(), CALL)?.equals(palette().text)).toBe(true)

    await view.app.mockMouse.moveTo(view.width - 1, 6)
    await view.app.renderOnce()
    expect(colorOf(view.spans(), CALL)?.equals(palette().textMuted)).toBe(true)
  })
})

test("a row without a click does not answer the mouse", async () => {
  await using({ state: "done", name: "Read", arg: "a.ts", result: "读取 1 行" }, {}, async (view) => {
    const arg = await cellOf(view, "a.ts")
    await view.app.mockMouse.moveTo(arg.column, arg.row)
    await view.app.renderOnce()
    expect(colorOf(view.spans(), "a.ts")?.equals(palette().textMuted)).toBe(true)
  })
})

/** A ticker that counts who listens to its frames; the one-second clock and `at` are not what a row uses. */
function frameTicker() {
  const [frame] = createSignal(0)
  const calls = { subscribed: 0, released: 0 }
  const ticker: Ticker = {
    frame,
    second: () => 0,
    subscribe() {
      calls.subscribed++
      return () => {
        calls.released++
      }
    },
    subscribeSecond: () => () => {},
    at: () => () => {},
    now: () => 0,
  }
  return { ticker, listeners: () => calls.subscribed - calls.released, calls }
}

test("the spinner of a call that runs listens to the ticker only while the row is on screen", async () => {
  const clock = frameTicker()
  const [state, setState] = createSignal<ToolRowState>("running")
  const [visible, setVisible] = createSignal(false)
  const tmp = await shellState()
  const app = await testRender(
    () => (
      <ShellContexts state={tmp.path}>
        <TickerProvider ticker={clock.ticker}>
          <box width={80}>
            <ToolRow state={state()} name="Bash" arg={CALL} result="运行中" width={80} visible={visible} />
          </box>
        </TickerProvider>
      </ShellContexts>
    ),
    { width: 80, height: 4 },
  )
  try {
    await renderFirstFrame(app)
    // Running and scrolled away: a static frame and no subscription.
    expect(clock.listeners()).toBe(0)

    setVisible(true)
    await app.renderOnce()
    expect(clock.listeners()).toBe(1)

    setVisible(false)
    await app.renderOnce()
    expect(clock.listeners()).toBe(0)

    // A call that is not running has no spinner at all, however visible its row is.
    setVisible(true)
    await app.renderOnce()
    expect(clock.listeners()).toBe(1)
    setState("done")
    await app.renderOnce()
    expect(clock.listeners()).toBe(0)
    expect(app.captureCharFrame().split("\n")[0]).toContain("⏺")
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})

test("a call that is not running subscribes to nothing", async () => {
  const clock = frameTicker()
  for (const state of ["pending", "done", "failed", "denied", "waiting"] as const) {
    await using(
      { state, name: "Bash", arg: CALL, result: "x", visible: () => true },
      { ticker: clock.ticker },
      () => {},
    )
  }
  expect(clock.calls.subscribed).toBe(0)
})
