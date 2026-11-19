// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import type { GlobalEvent, ToolPart } from "@graphagent/sdk"
import { SPINNER_FRAMES } from "../../../src/component/spinner"
import { DEFAULT_THEME } from "../../../src/context/theme"
import { setLanguage } from "../../../src/i18n"
import { DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { cellWidth } from "../../../src/ui/width"
import { AppRoutes } from "../../fixture/route-frame"
import { assistantMessage, textPart, userMessage, type MessageEntry } from "../../fixture/session-records"
import { directory, json } from "../../fixture/tui-sdk"
import { mountRoute, sessionFixture, waitFor, type MountOptions } from "../dag-mode-harness"

/**
 * The rows of the tools that draw one call as a block of lines (#1614): `⏺` and the call, `⎿` and what came of it, and
 * under them what its output folds. What each tool says of its result, and in which state, is read from the parts the
 * session holds.
 */

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

const palette = () => resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")

const ROOT = "ses_rows_root"
const root = sessionFixture(ROOT, { title: "root", time: { created: 1, updated: 2 } })

type StateOf<S extends ToolPart["state"]["status"]> = Extract<ToolPart["state"], { status: S }>

const completed = (input: Record<string, unknown>, output: string, metadata: Record<string, unknown> = {}) =>
  ({
    status: "completed",
    input,
    output,
    title: "t",
    metadata,
    time: { start: 1, end: 2 },
  }) satisfies StateOf<"completed">
const running = (input: Record<string, unknown>, metadata: Record<string, unknown> = {}) =>
  ({ status: "running", input, metadata, time: { start: 1 } }) satisfies StateOf<"running">
const pending = () => ({ status: "pending", input: {}, raw: "" }) satisfies StateOf<"pending">
const failed = (input: Record<string, unknown>, error: string, metadata?: Record<string, unknown>) =>
  ({ status: "error", input, error, metadata, time: { start: 1, end: 2 } }) satisfies StateOf<"error">

const ids = { next: 0 }
function call(tool: string, state: ToolPart["state"], id = `prt_rows_${++ids.next}`): ToolPart {
  return { id, sessionID: ROOT, messageID: "msg_rows_assistant", type: "tool", callID: `call_${id}`, tool, state }
}

/** `count` lines, each one of its own whatever its number. */
const lines = (count: number, prefix = "out") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n")

type Options = Pick<MountOptions, "keybinds" | "kv"> & {
  language?: "en" | "zh-CN"
  ambiguousWidth?: 1 | 2
  width?: number
  height?: number
}

async function mount(calls: ToolPart[], options: Options = {}) {
  const entries: MessageEntry[] = [
    { info: userMessage("msg_rows_user", ROOT, 10), parts: [textPart("msg_rows_user", ROOT, "prt_rows_prompt", "go")] },
    { info: assistantMessage("msg_rows_assistant", ROOT, "msg_rows_user", 20), parts: calls },
  ]
  const harness = await mountRoute({
    route: { type: "session", sessionID: ROOT },
    view: () => <AppRoutes />,
    frame: true,
    sessions: [root],
    handler: (url) => (url.pathname === `/session/${ROOT}/message` ? json(entries) : undefined),
    language: options.language ?? "zh-CN",
    keybinds: options.keybinds,
    kv: { ...options.kv, ...(options.ambiguousWidth ? { ambiguous_width: options.ambiguousWidth } : {}) },
    width: options.width ?? 100,
    height: options.height ?? 40,
  })
  try {
    await waitFor(() => harness.sync().status === "complete", 10_000)
  } catch (error) {
    await harness.dispose()
    throw error
  }
  return harness
}

type Harness = Awaited<ReturnType<typeof mount>>

const rowsOf = (frame: string) => frame.split("\n").map((line) => line.trimEnd())

/**
 * The block of the call that starts at the row that begins with `lead`, down to the blank row that ends it, with the
 * indent of the block taken off.
 */
function blockOf(frame: string, lead: string, options: { indent?: boolean } = {}) {
  const rows = rowsOf(frame)
  const start = rows.findIndex((row) => row.trimStart().startsWith(lead))
  if (start === -1) throw new Error(`no row starts with ${lead}:\n${frame}`)
  const indent = rows[start].length - rows[start].trimStart().length
  const end = rows.findIndex((row, index) => index > start && row.trim() === "")
  return rows.slice(start, end === -1 ? undefined : end).map((row) => (options.indent ? row : row.slice(indent)))
}

/** Renders until a row starts with `lead`, and returns the frame. */
const frameWith = (harness: Harness, lead: string) =>
  harness.waitForFrame((frame) => rowsOf(frame).some((row) => row.trimStart().startsWith(lead)), `the row of ${lead}`)

function colorOf(spans: Awaited<ReturnType<Harness["spans"]>>, needle: string) {
  for (const line of spans.lines) {
    const found = line.spans.find((item) => item.text.includes(needle))
    if (found) return found.fg
  }
  return undefined
}

const channels = (color: { toInts(): number[] }) => color.toInts().slice(0, 3)

/** A color at the opacity the frame gives the main area while an ask is open. */
function dim(color: { toInts(): number[] }) {
  const background = channels(palette().background)
  return channels(color).map((value, index) => (value + background[index]) / 2)
}

const near = (color: { toInts(): number[] } | undefined, expected: number[]) =>
  color !== undefined && channels(color).every((value, index) => Math.abs(value - expected[index]) <= 1)

function press(harness: Harness) {
  harness.app.mockInput.pressKey("o", { ctrl: true })
}

async function clickOn(harness: Harness, text: string) {
  await harness.app.renderOnce()
  const rows = rowsOf(await harness.frame())
  const row = rows.findIndex((line) => line.includes(text))
  expect(row).toBeGreaterThanOrEqual(0)
  await harness.app.mockMouse.click(rows[row].indexOf(text), row)
  harness.app.renderer.clearSelection()
}

test("a bash call that printed nothing says so, in both languages", async () => {
  for (const [language, says] of [
    ["zh-CN", "（无输出）"],
    ["en", "(no output)"],
  ] as const) {
    // The server writes `(no output)` as the output of such a command; a command that wrote an empty one has none.
    for (const output of ["(no output)", ""]) {
      const harness = await mount([call("bash", completed({ command: "true" }, output, { output, exit: 0 }))], {
        language,
      })
      try {
        const frame = await frameWith(harness, "⏺ Bash")
        expect(blockOf(frame, "⏺ Bash")).toEqual(["⏺ Bash true", `  ⎿ ${says}`])
      } finally {
        await harness.dispose()
      }
    }
  }
})

test("a bash call with one line of output puts it after the mark", async () => {
  const harness = await mount([
    call("bash", completed({ command: "git rev-parse HEAD" }, "9f2c1ab", { output: "9f2c1ab\n", exit: 0 })),
  ])
  try {
    const frame = await frameWith(harness, "⏺ Bash")
    expect(blockOf(frame, "⏺ Bash")).toEqual(["⏺ Bash git rev-parse HEAD", "  ⎿ 9f2c1ab"])
    // The result is drawn in the text color, and the dot of a call that completed in the one for success.
    const spans = await harness.spans()
    expect(colorOf(spans, "9f2c1ab")?.equals(palette().text)).toBe(true)
    expect(colorOf(spans, "⏺")?.equals(palette().success)).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test("an output of six lines is drawn whole after the mark, with no hint", async () => {
  const output = lines(6)
  const harness = await mount([call("bash", completed({ command: "seq 6" }, output, { output, exit: 0 }))])
  try {
    const frame = await frameWith(harness, "⏺ Bash")
    expect(blockOf(frame, "⏺ Bash")).toEqual([
      "⏺ Bash seq 6",
      "  ⎿ out 1",
      "    out 2",
      "    out 3",
      "    out 4",
      "    out 5",
      "    out 6",
    ])
    // Nothing folds, so there is nothing for the key to open.
    press(harness)
    await harness.settle()
    expect(await harness.frame()).toBe(frame)
  } finally {
    await harness.dispose()
  }
})

test("an output of seven lines folds into its last line and a hint that counts the other six", async () => {
  for (const [language, hint, open] of [
    ["zh-CN", "… 还有 6 行 · ctrl+o 展开", "ctrl+o 收起"],
    ["en", "… 6 more lines · ctrl+o expand", "ctrl+o collapse"],
  ] as const) {
    const output = lines(7)
    const harness = await mount([call("bash", completed({ command: "seq 7" }, output, { output, exit: 0 }))], {
      language,
    })
    try {
      const frame = await frameWith(harness, "⏺ Bash")
      expect(blockOf(frame, "⏺ Bash")).toEqual(["⏺ Bash seq 7", "  ⎿ out 7", `    ${hint}`])
      expect(colorOf(await harness.spans(), hint)?.equals(palette().textDim)).toBe(true)

      // The key opens the whole output under the result line, and the hint under it closes it.
      press(harness)
      const opened = await harness.waitForFrame((text) => text.includes(open), "the open output")
      expect(blockOf(opened, "⏺ Bash")).toEqual([
        "⏺ Bash seq 7",
        "  ⎿ out 7",
        ...lines(7)
          .split("\n")
          .map((row) => `    ${row}`),
        `    ${open}`,
      ])

      press(harness)
      expect(blockOf(await harness.waitForFrame((text) => text.includes(hint), "the hint again"), "⏺ Bash")).toEqual([
        "⏺ Bash seq 7",
        "  ⎿ out 7",
        `    ${hint}`,
      ])
      // Opening and closing is view state: no request.
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  }
})

test("a click on the hint opens the output and a click on its hint closes it", async () => {
  const output = lines(9)
  const harness = await mount([call("bash", completed({ command: "seq 9" }, output, { output, exit: 0 }))])
  try {
    await frameWith(harness, "⏺ Bash")
    await clickOn(harness, "还有 8 行")
    const opened = await harness.waitForFrame((text) => text.includes("ctrl+o 收起"), "the open output")
    expect(blockOf(opened, "⏺ Bash")).toContain("    out 5")
    await clickOn(harness, "ctrl+o 收起")
    await harness.waitForFrame((text) => text.includes("还有 8 行"), "the folded output")
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("the result line of a folded output is the last line, because the output is the tail the server kept", async () => {
  // The server writes a `...` line ahead of what it cut off; the first line says nothing of the command.
  const output = `...\n${lines(7)}\nBuild finished in 4.2s`
  const harness = await mount([call("bash", completed({ command: "bun run build" }, output, { output, exit: 0 }))])
  try {
    const frame = await frameWith(harness, "⏺ Bash")
    expect(blockOf(frame, "⏺ Bash")).toEqual([
      "⏺ Bash bun run build",
      "  ⎿ Build finished in 4.2s",
      "    … 还有 8 行 · ctrl+o 展开",
    ])
  } finally {
    await harness.dispose()
  }
})

test("one long line folds, leaves no line out, and opens to the whole of it", async () => {
  const output = `${"word ".repeat(300)}end`
  const harness = await mount([call("bash", completed({ command: "cat blob" }, output, { output, exit: 0 }))], {
    height: 50,
  })
  try {
    const frame = await frameWith(harness, "⏺ Bash")
    const block = blockOf(frame, "⏺ Bash")
    expect(block).toHaveLength(3)
    expect(block[1]).toStartWith("  ⎿ word word")
    expect(block[1]).toEndWith("…")
    expect(block[2]).toBe("    … 内容较长 · ctrl+o 展开")

    press(harness)
    const opened = await harness.waitForFrame((text) => text.includes("ctrl+o 收起"), "the whole line")
    expect(opened.replaceAll("\n", " ")).toContain("end")
  } finally {
    await harness.dispose()
  }
})

test("a command that failed says its exit code, in the color of an error, ahead of the last line", async () => {
  for (const [language, code] of [
    ["zh-CN", "退出码 2"],
    ["en", "Exit code 2"],
  ] as const) {
    const output = lines(8, "FAIL")
    const harness = await mount([call("bash", completed({ command: "bun test" }, output, { output, exit: 2 }))], {
      language,
    })
    try {
      const frame = await frameWith(harness, "⏺ Bash")
      const block = blockOf(frame, "⏺ Bash")
      expect(block[1]).toBe(`  ⎿ ${code} · FAIL 8`)
      expect(colorOf(await harness.spans(), `${code} · FAIL 8`)?.equals(palette().error)).toBe(true)
      // The call itself completed: its dot is not the one of a failure.
      expect(colorOf(await harness.spans(), "⏺")?.equals(palette().success)).toBe(true)
    } finally {
      await harness.dispose()
    }
  }
})

test("a command that failed with a short output has the exit code ahead of the output, and one without has the code alone", async () => {
  const harness = await mount([
    call("bash", completed({ command: "grep x f" }, "no match", { output: "no match", exit: 1 })),
    call("bash", completed({ command: "false" }, "(no output)", { output: "(no output)", exit: 1 })),
  ])
  try {
    const frame = await harness.waitForFrame((text) => text.includes("⏺ Bash false"), "both rows")
    expect(blockOf(frame, "⏺ Bash grep")).toEqual(["⏺ Bash grep x f", "  ⎿ 退出码 1 · no match"])
    expect(blockOf(frame, "⏺ Bash false")).toEqual(["⏺ Bash false", "  ⎿ 退出码 1"])
  } finally {
    await harness.dispose()
  }
})

test("a call that is running says so, with the latest line of what it printed, and has a spinner for a dot", async () => {
  const harness = await mount([
    call("bash", running({ command: "bun run dev" }, { output: "compiling 3/9\ncompiling 4/9" })),
  ])
  try {
    // The glyph of the spinner is the frame the ticker is at: whichever it is, it is in the place of the dot.
    const frame = await harness.waitForFrame((text) => text.includes("⎿ 运行中"), "the running row")
    const glyph = SPINNER_FRAMES.find((item) => frame.includes(item))
    expect(glyph).toBeDefined()
    expect(blockOf(frame, glyph!)).toEqual([`${glyph} Bash bun run dev`, "  ⎿ 运行中 · compiling 4/9"])
    expect(frame).not.toContain("⏺")
    const spans = await harness.spans()
    expect(colorOf(spans, "运行中")?.equals(palette().primary)).toBe(true)
    expect(colorOf(spans, "compiling 4/9")?.equals(palette().textMuted)).toBe(true)
    const spinner = SPINNER_FRAMES.map((item) => colorOf(spans, item)).find(Boolean)
    expect(spinner?.equals(palette().primary)).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test("a call whose arguments are still arriving says it is getting ready, with no arg to show", async () => {
  const harness = await mount([call("bash", pending())])
  try {
    const frame = await frameWith(harness, "⏺ Bash")
    expect(blockOf(frame, "⏺ Bash")).toEqual(["⏺ Bash", "  ⎿ 准备中…"])
    expect(colorOf(await harness.spans(), "⏺")?.equals(palette().textMuted)).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test("a call that failed says why in its first line, and opens its whole error by key or click", async () => {
  const error = "boom: the fetch failed\nsecond line of the error\nthird"
  const harness = await mount([call("webfetch", failed({ url: "https://example.com/a" }, error))])
  try {
    const frame = await frameWith(harness, "⏺ WebFetch")
    expect(blockOf(frame, "⏺ WebFetch")).toEqual([
      "⏺ WebFetch https://example.com/a",
      "  ⎿ 失败 · boom: the fetch failed",
    ])
    const spans = await harness.spans()
    expect(colorOf(spans, "失败 · boom")?.equals(palette().error)).toBe(true)
    expect(colorOf(spans, "⏺")?.equals(palette().error)).toBe(true)

    press(harness)
    const opened = await harness.waitForFrame((text) => text.includes("third"), "the whole error")
    expect(blockOf(opened, "⏺ WebFetch")).toEqual([
      "⏺ WebFetch https://example.com/a",
      "  ⎿ 失败 · boom: the fetch failed",
      "    boom: the fetch failed",
      "    second line of the error",
      "    third",
    ])

    await clickOn(harness, "second line")
    expect((await harness.waitForFrame((text) => !text.includes("third"), "the error closed")).includes("third")).toBe(
      false,
    )
    await clickOn(harness, "boom: the fetch failed")
    await harness.waitForFrame((text) => text.includes("third"), "the error opened by a click")
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("a bash call that failed after it printed keeps the output under its error", async () => {
  const harness = await mount([
    call(
      "bash",
      failed({ command: "sleep 100" }, "Tool execution aborted", { output: "partial 1\npartial 2", interrupted: true }),
    ),
  ])
  try {
    const frame = await frameWith(harness, "⏺ Bash")
    expect(blockOf(frame, "⏺ Bash")).toEqual(["⏺ Bash sleep 100", "  ⎿ 失败 · Tool execution aborted"])
    press(harness)
    const opened = await harness.waitForFrame((text) => text.includes("partial 2"), "the open error")
    // The error, a blank line, and what the command printed before it was stopped. The blank line ends the block the
    // helper reads, so the rows are read as they are.
    const rows = rowsOf(opened).map((row) => row.trim())
    const start = rows.findIndex((row) => row === "⏺ Bash sleep 100")
    expect(rows.slice(start, start + 6)).toEqual([
      "⏺ Bash sleep 100",
      "⎿ 失败 · Tool execution aborted",
      "Tool execution aborted",
      "",
      "partial 1",
      "partial 2",
    ])
    expect(colorOf(await harness.spans(), "partial 1")?.equals(palette().textMuted)).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test("a call the user or the rules turned down says it was denied, and its text is not struck through", async () => {
  for (const [language, says] of [
    ["zh-CN", "已拒绝"],
    ["en", "Denied"],
  ] as const) {
    const harness = await mount(
      [call("skill", failed({ name: "deploy" }, "The user rejected permission to use this specific tool call."))],
      { language },
    )
    try {
      const frame = await frameWith(harness, "⏺ Skill")
      expect(blockOf(frame, "⏺ Skill")).toEqual(['⏺ Skill "deploy"', `  ⎿ ${says}`])
      const spans = await harness.spans()
      expect(colorOf(spans, says)?.equals(palette().error)).toBe(true)
      for (const line of spans.lines) {
        for (const item of line.spans) expect(item.attributes & TextAttributes.STRIKETHROUGH).toBeFalsy()
      }
      // A call that was turned down has no error to open: the key finds nothing to do.
      press(harness)
      await harness.settle()
      expect(await harness.frame()).toBe(frame)
    } finally {
      await harness.dispose()
    }
  }
})

function permissionEvent(callID: string): GlobalEvent {
  return {
    directory,
    payload: {
      id: `evt_rows_permission_${callID}`,
      type: "permission.asked",
      properties: {
        id: "per_000000000099",
        sessionID: ROOT,
        permission: "bash",
        patterns: ["bun test"],
        metadata: {},
        always: [],
        tool: { messageID: "msg_rows_assistant", callID },
      },
    },
  }
}

test("a call that waits for a permission says so in the color of a warning", async () => {
  for (const [language, says] of [
    ["zh-CN", "等待授权"],
    ["en", "Waiting for permission"],
  ] as const) {
    const part = call("bash", running({ command: "bun test" }))
    const harness = await mount([part], { language })
    try {
      await harness.waitForFrame((text) => text.includes("⎿ 运行中") || text.includes("⎿ Running"), "the running row")
      harness.deliver(permissionEvent(part.callID))
      const frame = await harness.waitForFrame((text) => text.includes(`⎿ ${says}`), "the wait")
      expect(blockOf(frame, "⏺ Bash")).toEqual(["⏺ Bash bun test", `  ⎿ ${says}`])
      // The main area is dimmed while the ask is open: the warning color half way to the background, as the frame paints it.
      const spans = await harness.spans()
      const dimmed = dim(palette().warning)
      expect(near(colorOf(spans, says), dimmed)).toBe(true)
      expect(near(colorOf(spans, "⏺"), dimmed)).toBe(true)
    } finally {
      await harness.dispose()
    }
  }
})

test("a read of a file says how many lines it got, a read of a directory how many entries", async () => {
  const harness = await mount([
    call(
      "read",
      completed({ filePath: `${directory}/src/a.ts`, offset: 10, limit: 120 }, "…", {
        display: { type: "file", lineStart: 10, lineEnd: 129 },
      }),
    ),
    call(
      "read",
      completed({ filePath: `${directory}/src` }, "…", {
        display: { type: "directory", totalEntries: 12, entries: [] },
      }),
    ),
    call(
      "read",
      completed({ filePath: `${directory}/one.ts` }, "…", { display: { type: "file", lineStart: 1, lineEnd: 1 } }),
    ),
    call("read", completed({ filePath: `${directory}/logo.png` }, "Image read successfully", {})),
  ])
  try {
    const frame = await harness.waitForFrame((text) => text.includes("logo.png"), "the rows")
    expect(blockOf(frame, "⏺ Read src/a.ts")).toEqual(["⏺ Read src/a.ts [offset=10, limit=120]", "  ⎿ 读取 120 行"])
    expect(blockOf(frame, "⏺ Read src")).toEqual(["⏺ Read src/a.ts [offset=10, limit=120]", "  ⎿ 读取 120 行"])
    expect(rowsOf(frame).map((row) => row.trim())).toContain("⎿ 12 个条目")
    expect(rowsOf(frame).map((row) => row.trim())).toContain("⎿ 读取 1 行")
    // A read that gave no line range (an image) has nothing to count.
    expect(blockOf(frame, "⏺ Read logo.png")).toEqual(["⏺ Read logo.png", "  ⎿ 完成"])
  } finally {
    await harness.dispose()
  }
})

test("a read keeps the line for each file it loaded with it", async () => {
  const state = completed({ filePath: `${directory}/src/a.ts` }, "…", {
    display: { type: "file", lineStart: 1, lineEnd: 30 },
    loaded: [`${directory}/src/AGENTS.md`, `${directory}/AGENTS.md`],
  })
  for (const [language, loaded] of [
    ["zh-CN", "已加载"],
    ["en", "Loaded"],
  ] as const) {
    const harness = await mount([call("read", state)], { language })
    try {
      const frame = await frameWith(harness, "⏺ Read")
      const block = blockOf(frame, "⏺ Read")
      expect(block).toHaveLength(4)
      expect(block[2]).toBe(`    ↳ ${loaded} src/AGENTS.md`)
      expect(block[3]).toBe(`    ↳ ${loaded} AGENTS.md`)
      expect(colorOf(await harness.spans(), `${loaded} src/AGENTS.md`)?.equals(palette().textMuted)).toBe(true)
    } finally {
      await harness.dispose()
    }
  }
})

test("a search says how many matches it found, or that it found none", async () => {
  for (const [language, found, none, one] of [
    ["zh-CN", "41 处匹配", "无匹配", "1 处匹配"],
    ["en", "41 matches", "No matches", "1 match"],
  ] as const) {
    const harness = await mount(
      [
        call("grep", completed({ pattern: "TODO", path: `${directory}/src` }, "…", { matches: 41 })),
        call("grep", completed({ pattern: "nothing" }, "No matches", { matches: 0 })),
        call("grep", completed({ pattern: "once" }, "…", { matches: 1 })),
      ],
      { language },
    )
    try {
      const frame = await harness.waitForFrame((text) => text.includes('"once"'), "the rows")
      expect(blockOf(frame, '⏺ Grep "TODO"')).toEqual(['⏺ Grep "TODO" in src', `  ⎿ ${found}`])
      expect(blockOf(frame, '⏺ Grep "nothing"')).toEqual(['⏺ Grep "nothing"', `  ⎿ ${none}`])
      expect(blockOf(frame, '⏺ Grep "once"')).toEqual(['⏺ Grep "once"', `  ⎿ ${one}`])
    } finally {
      await harness.dispose()
    }
  }
})

test("a glob says how many files it found", async () => {
  for (const [language, many, one] of [
    ["zh-CN", "6 个文件", "1 个文件"],
    ["en", "6 files", "1 file"],
  ] as const) {
    const harness = await mount(
      [
        call("glob", completed({ pattern: "**/*db*", path: `${directory}/packages` }, "…", { count: 6 })),
        call("glob", completed({ pattern: "*.md" }, "…", { count: 1 })),
        call("glob", completed({ pattern: "*.zzz" }, "…", {})),
      ],
      { language },
    )
    try {
      const frame = await harness.waitForFrame((text) => text.includes('"*.zzz"'), "the rows")
      expect(blockOf(frame, '⏺ Glob "**/*db*"')).toEqual(['⏺ Glob "**/*db*" in packages', `  ⎿ ${many}`])
      expect(blockOf(frame, '⏺ Glob "*.md"')).toEqual(['⏺ Glob "*.md"', `  ⎿ ${one}`])
      // A result without a count is not made one up.
      expect(blockOf(frame, '⏺ Glob "*.zzz"')[1]).toBe(`  ⎿ ${language === "en" ? "Done" : "完成"}`)
    } finally {
      await harness.dispose()
    }
  }
})

test("a web search names its provider and the query, and says how many results it was asked for when it knows", async () => {
  const harness = await mount([
    call("websearch", completed({ query: "bun 1.4 release" }, "…", { provider: "exa", numResults: 8 })),
    call("websearch", completed({ query: "no count" }, "…", { provider: "parallel" })),
  ])
  try {
    const frame = await harness.waitForFrame((text) => text.includes("no count"), "the rows")
    expect(blockOf(frame, "⏺ WebSearch Exa")).toEqual(['⏺ WebSearch Exa "bun 1.4 release"', "  ⎿ 8 条结果"])
    // No result count in the metadata: the row says the call is done, and makes up no number.
    expect(blockOf(frame, "⏺ WebSearch Parallel")).toEqual(['⏺ WebSearch Parallel "no count"', "  ⎿ 完成"])
  } finally {
    await harness.dispose()
  }
})

test("the name of the tool is on the row of a web search once, whichever provider it went through", async () => {
  for (const [language, results] of [
    ["zh-CN", "3 条结果"],
    ["en", "3 results"],
  ] as const) {
    const harness = await mount(
      [
        call("websearch", completed({ query: "a" }, "…", { provider: "exa", numResults: 3 })),
        call("websearch", completed({ query: "b" }, "…", { provider: "parallel", numResults: 3 })),
        // A provider this build does not know is not named, and the query stands right after the tool.
        call("websearch", completed({ query: "c" }, "…", { provider: "other", numResults: 3 })),
        call("websearch", completed({ query: "d" }, "…", { numResults: 3 })),
      ],
      { language },
    )
    try {
      const frame = await harness.waitForFrame((text) => text.includes('"d"'), "the rows")
      expect(blockOf(frame, '⏺ WebSearch Exa "a"')).toEqual(['⏺ WebSearch Exa "a"', `  ⎿ ${results}`])
      expect(blockOf(frame, '⏺ WebSearch Parallel "b"')).toEqual(['⏺ WebSearch Parallel "b"', `  ⎿ ${results}`])
      expect(blockOf(frame, '⏺ WebSearch "c"')).toEqual(['⏺ WebSearch "c"', `  ⎿ ${results}`])
      expect(blockOf(frame, '⏺ WebSearch "d"')).toEqual(['⏺ WebSearch "d"', `  ⎿ ${results}`])
      // However the tool is called, its name is not said a second time on the row: no "Web Search" after "WebSearch".
      for (const row of rowsOf(frame).filter((line) => line.includes("⏺ WebSearch"))) {
        expect(row.match(/web ?search/gi)).toHaveLength(1)
      }
    } finally {
      await harness.dispose()
    }
  }
})

test("a fetch and a skill have no result data of their own: they say they are done", async () => {
  for (const [language, done] of [
    ["zh-CN", "完成"],
    ["en", "Done"],
  ] as const) {
    const harness = await mount(
      [
        call("webfetch", completed({ url: "https://example.com/docs" }, "page", {})),
        call("skill", completed({ name: "review" }, "skill text", {})),
      ],
      { language },
    )
    try {
      const frame = await harness.waitForFrame((text) => text.includes("⏺ Skill"), "the rows")
      expect(blockOf(frame, "⏺ WebFetch")).toEqual(["⏺ WebFetch https://example.com/docs", `  ⎿ ${done}`])
      expect(blockOf(frame, "⏺ Skill")).toEqual(['⏺ Skill "review"', `  ⎿ ${done}`])
    } finally {
      await harness.dispose()
    }
  }
})

test("a tool without a display of its own says it is done, and its output only when the reader asked for it", async () => {
  const state = completed({ query: "x", limit: 3 }, "first line\nsecond line", {})
  const closed = await mount([call("mcp_search", state)])
  try {
    const frame = await frameWith(closed, "⏺ mcp_search")
    expect(blockOf(frame, "⏺ mcp_search")).toEqual(["⏺ mcp_search [query=x, limit=3]", "  ⎿ 完成"])
    // With the output hidden there is nothing to open.
    press(closed)
    await closed.settle()
    expect(await closed.frame()).toBe(frame)
  } finally {
    await closed.dispose()
  }

  const shown = await mount([call("mcp_search", state)], { kv: { generic_tool_output_visibility: true } })
  try {
    const frame = await frameWith(shown, "⏺ mcp_search")
    expect(blockOf(frame, "⏺ mcp_search")).toEqual([
      "⏺ mcp_search [query=x, limit=3]",
      "  ⎿ first line",
      "    second line",
    ])
  } finally {
    await shown.dispose()
  }
})

test("the output of a tool without a display of its own folds at the same six lines, to its first line", async () => {
  const output = lines(9, "row")
  const harness = await mount([call("mcp_search", completed({}, output, {}))], {
    kv: { generic_tool_output_visibility: true },
  })
  try {
    const frame = await frameWith(harness, "⏺ mcp_search")
    expect(blockOf(frame, "⏺ mcp_search")).toEqual(["⏺ mcp_search", "  ⎿ row 1", "    … 还有 8 行 · ctrl+o 展开"])
    press(harness)
    const opened = await harness.waitForFrame((text) => text.includes("ctrl+o 收起"), "the open output")
    expect(blockOf(opened, "⏺ mcp_search")).toContain("    row 9")
  } finally {
    await harness.dispose()
  }
})

test("a call that was blocked says why, in the color of an error, and has the dot of a failure", async () => {
  const state = completed({}, "Blocked by the policy", {
    blocked: true,
    diagnosticSummary: "Denied by policy: no network",
  })
  const harness = await mount([call("mcp_fetch", state)])
  try {
    const frame = await frameWith(harness, "⏺ mcp_fetch")
    expect(blockOf(frame, "⏺ mcp_fetch")).toEqual(["⏺ mcp_fetch", "  ⎿ Denied by policy: no network"])
    const spans = await harness.spans()
    expect(colorOf(spans, "Denied by policy")?.equals(palette().error)).toBe(true)
    expect(colorOf(spans, "⏺")?.equals(palette().error)).toBe(true)
  } finally {
    await harness.dispose()
  }
})

/** The diff of an edit that changed one line of a function: four rows, the context above and below the change. */
const DIFF = [
  "Index: src/answer.ts",
  "===================================================================",
  "--- src/answer.ts",
  "+++ src/answer.ts",
  "@@ -1,3 +1,3 @@",
  " export function value() {",
  "-  const answer = 41",
  "+  const answer = 42",
  " }",
  "",
].join("\n")

/** The diff of a file a patch created. */
const ADDED = [
  "Index: src/b.ts",
  "===",
  "--- src/b.ts",
  "+++ src/b.ts",
  "@@ -0,0 +1,2 @@",
  "+export const a = 1",
  "+export const b = 2",
  "",
].join("\n")

const ANSWER = `${directory}/src/answer.ts`

/** What the server records of an edit that completed: the diff, and the lines it added and removed. */
const edited = (
  additions: number,
  deletions: number,
  metadata: Record<string, unknown> = {},
  input: Record<string, unknown> = {},
) =>
  completed({ filePath: ANSWER, oldString: "41", newString: "42", ...input }, "Edit applied successfully.", {
    diff: DIFF,
    filediff: { file: ANSWER, patch: DIFF, additions, deletions },
    diagnostics: {},
    ...metadata,
  })

/** An error of the language server in `file`, at the first column of `line`. */
const lspError = (message: string, line = 0, severity = 1) => ({
  severity,
  message,
  range: { start: { line, character: 3 }, end: { line, character: 5 } },
})

/** The spans of the first row that holds `row`, whatever it is split into. */
function spansOf(spans: Awaited<ReturnType<Harness["spans"]>>, row: string) {
  return (
    spans.lines.find((line) =>
      line.spans
        .map((item) => item.text)
        .join("")
        .includes(row),
    )?.spans ?? []
  )
}

/** The color behind `token` on the row that holds `row`: how the diff paints a line it added or removed. */
const backgroundOf = (spans: Awaited<ReturnType<Harness["spans"]>>, row: string, token: string) =>
  spansOf(spans, row).find((item) => item.text.includes(token))?.bg

test("an edit says what it added and what it removed, in the colors of success and of error, in two rows and with no diff", async () => {
  for (const language of ["zh-CN", "en"] as const) {
    const harness = await mount([call("edit", edited(6, 4))], { language })
    try {
      const frame = await frameWith(harness, "⏺ Edit")
      // The minus sign is U+2212, not a hyphen. The row is the call and its summary: nothing is said under them.
      expect(blockOf(frame, "⏺ Edit")).toEqual(["⏺ Edit src/answer.ts", "  ⎿ +6 −4"])
      // The diff is not drawn: none of its rows is on screen, and no hint offers it.
      expect(frame).not.toContain("const answer")
      expect(frame).not.toContain("export function value")
      expect(frame).not.toContain("ctrl+o")
      expect(frame).not.toMatch(/还有|more lines?/)

      const spans = await harness.spans()
      expect(colorOf(spans, "+6")?.equals(palette().success)).toBe(true)
      expect(colorOf(spans, "−4")?.equals(palette().error)).toBe(true)
      expect(colorOf(spans, "⎿")?.equals(palette().textDim)).toBe(true)
      expect(colorOf(spans, "⏺")?.equals(palette().success)).toBe(true)
      expect(colorOf(spans, "Edit")?.equals(palette().text)).toBe(true)
      expect(colorOf(spans, "src/answer.ts")?.equals(palette().textMuted)).toBe(true)
    } finally {
      await harness.dispose()
    }
  }
})

test("an edit that added nothing says +0, and one the server gave no counts for says it is done and still opens by the key", async () => {
  const harness = await mount([
    call("edit", edited(0, 3, {}, { replaceAll: true })),
    call("edit", completed({ filePath: `${directory}/src/other.ts` }, "ok", { diff: DIFF, diagnostics: {} })),
  ])
  try {
    const frame = await harness.waitForFrame((text) => text.includes("other.ts"), "the rows")
    // The flag the call was made with stays on the row, as it did before.
    expect(blockOf(frame, "⏺ Edit src/answer.ts")[0]).toBe("⏺ Edit src/answer.ts [replaceAll=true]")
    expect(blockOf(frame, "⏺ Edit src/answer.ts")[1]).toBe("  ⎿ +0 −3")
    // No counts, and none made up from the diff: the row says it is done, and has no more rows than the other.
    expect(blockOf(frame, "⏺ Edit src/other.ts")).toEqual(["⏺ Edit src/other.ts", "  ⎿ 完成"])
    expect(frame).not.toContain("const answer")

    // The key opens the latest of the two, the one without counts, and its diff is under its summary.
    press(harness)
    const opened = await harness.waitForFrame((text) => text.includes("const answer = 42"), "the open diff")
    expect(blockOf(opened, "⏺ Edit src/other.ts").slice(0, 2)).toEqual(["⏺ Edit src/other.ts", "  ⎿ 完成"])
    expect(blockOf(opened, "⏺ Edit src/other.ts").some((row) => row.includes("const answer = 42"))).toBe(true)
    expect(blockOf(opened, "⏺ Edit src/answer.ts")).toHaveLength(2)
  } finally {
    await harness.dispose()
  }
})

test("the key opens the diff of an edit under its summary, with the backgrounds of the diff, and the key closes it", async () => {
  const harness = await mount([call("edit", edited(1, 1))])
  try {
    await frameWith(harness, "⏺ Edit")
    press(harness)
    const opened = await harness.waitForFrame((text) => text.includes("const answer = 42"), "the open diff")
    const block = blockOf(opened, "⏺ Edit")
    expect(block[0]).toBe("⏺ Edit src/answer.ts")
    expect(block[1]).toBe("  ⎿ +1 −1")
    // The rows of the diff are indented under the summary, and the last of them is the last row of the block: no
    // hint closes it.
    expect(block.slice(2).map((row) => row.replace(/\s+/g, " ").trim())).toEqual([
      "1 export function value() {",
      "2 - const answer = 41",
      "2 + const answer = 42",
      "3 }",
    ])
    expect(block[2].startsWith("     ")).toBe(true)

    // The colors are the ones the diff has always had: the removed line on the removed background, the added on the added.
    const spans = await harness.spans()
    expect(backgroundOf(spans, "const answer = 41", "41")?.equals(palette().diffRemovedBg)).toBe(true)
    expect(backgroundOf(spans, "const answer = 42", "42")?.equals(palette().diffAddedBg)).toBe(true)
    // A line the edit did not touch is on the background of the context, whichever it is, and not on one of the two.
    expect(backgroundOf(spans, "export function value", "export")?.equals(palette().diffContextBg)).toBe(true)

    press(harness)
    const closed = await harness.waitForFrame((text) => !text.includes("const answer = 42"), "the closed diff")
    expect(blockOf(closed, "⏺ Edit")).toEqual(["⏺ Edit src/answer.ts", "  ⎿ +1 −1"])
    // Opening and closing is view state: no request.
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("a click on the summary of an edit opens its diff, and a click on its call closes the diff", async () => {
  const harness = await mount([call("edit", edited(1, 1))], { language: "en" })
  try {
    await frameWith(harness, "⏺ Edit")
    await clickOn(harness, "+1")
    const opened = await harness.waitForFrame(
      (text) => text.includes("const answer = 42"),
      "the diff opened by a click",
    )
    const spans = await harness.spans()
    expect(backgroundOf(spans, "const answer = 42", "42")?.equals(palette().diffAddedBg)).toBe(true)
    // Nothing under the diff says how to close it: the row is the target of the click, wherever on it that is.
    expect(blockOf(opened, "⏺ Edit").at(-1)?.replace(/\s+/g, " ").trim()).toBe("3 }")
    expect(opened).not.toContain("ctrl+o")

    await clickOn(harness, "src/answer.ts")
    const closed = await harness.waitForFrame(
      (text) => !text.includes("const answer = 42"),
      "the diff closed by a click",
    )
    expect(blockOf(closed, "⏺ Edit")).toEqual(["⏺ Edit src/answer.ts", "  ⎿ +1 −1"])
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("an edit counts the errors the language server found in its file, and lists the first three when it is open", async () => {
  const errors = [lspError("first"), lspError("second", 1), lspError("third", 2), lspError("fourth", 3)]
  const diagnostics = {
    [ANSWER]: [...errors, lspError("a warning", 4, 2)],
    [`${directory}/src/elsewhere.ts`]: [lspError("not this file")],
  }
  for (const [language, says] of [
    ["zh-CN", "+1 −1 · 4 个诊断错误"],
    ["en", "+1 −1 · 4 diagnostic errors"],
  ] as const) {
    const harness = await mount([call("edit", edited(1, 1, { diagnostics }))], { language })
    try {
      const frame = await frameWith(harness, "⏺ Edit")
      expect(blockOf(frame, "⏺ Edit")[1]).toBe(`  ⎿ ${says}`)
      const spans = await harness.spans()
      // The counts keep their own colors, and what follows them is one color, the one of an error.
      expect(colorOf(spans, "+1")?.equals(palette().success)).toBe(true)
      expect(colorOf(spans, language === "en" ? "4 diagnostic errors" : "4 个诊断错误")?.equals(palette().error)).toBe(
        true,
      )
      expect(frame).not.toContain("Error [")

      press(harness)
      const opened = await harness.waitForFrame((text) => text.includes("Error ["), "the diagnostics")
      const listed = rowsOf(opened).filter((row) => row.includes("Error ["))
      expect(listed.map((row) => row.trim())).toEqual(["Error [1:4] first", "Error [2:4] second", "Error [3:4] third"])
      expect(opened).not.toContain("fourth")
      expect(opened).not.toContain("a warning")
      expect(opened).not.toContain("not this file")
    } finally {
      await harness.dispose()
    }
  }
})

test("one error is said in the singular", async () => {
  const harness = await mount([call("edit", edited(1, 1, { diagnostics: { [ANSWER]: [lspError("only")] } }))], {
    language: "en",
  })
  try {
    const frame = await frameWith(harness, "⏺ Edit")
    expect(blockOf(frame, "⏺ Edit")[1]).toBe("  ⎿ +1 −1 · 1 diagnostic error")
  } finally {
    await harness.dispose()
  }
})

test("an edit is one row until it completes: getting ready, running, and then its summary", async () => {
  const harness = await mount([
    call("edit", pending()),
    call("edit", running({ filePath: `${directory}/src/running.ts` }, { diff: DIFF })),
  ])
  try {
    const frame = await harness.waitForFrame((text) => text.includes("running.ts"), "the rows")
    expect(blockOf(frame, "⏺ Edit")).toEqual(["⏺ Edit", "  ⎿ 准备中…"])
    // A running edit has the diff in its metadata already; its row says it runs and offers nothing to open. The glyph
    // of its dot is the frame the spinner is at, whichever it is.
    const glyph = [
      ...rowsOf(frame)
        .find((row) => row.includes("Edit src/running.ts"))!
        .trim(),
    ][0]
    expect(SPINNER_FRAMES).toContain(glyph)
    expect(blockOf(frame, glyph)).toEqual([`${glyph} Edit src/running.ts`, "  ⎿ 运行中"])
    expect(frame).not.toContain("const answer")
    // Nothing of the two folds: the key opens nothing. The spinner moves on, so the frame is read for what it holds.
    press(harness)
    await harness.settle()
    const after = await harness.frame()
    expect(after).not.toContain("const answer")
    expect(after).not.toContain("ctrl+o")
  } finally {
    await harness.dispose()
  }
})

test("an edit that failed says why, and opens its error and not a diff; one that was turned down says so", async () => {
  const error = "The text to replace was not found\nsecond line of the error"
  const harness = await mount([
    call("edit", failed({ filePath: ANSWER }, error, { diff: DIFF })),
    call(
      "edit",
      failed(
        { filePath: `${directory}/src/denied.ts` },
        "The user rejected permission to use this specific tool call.",
      ),
    ),
  ])
  try {
    const frame = await harness.waitForFrame((text) => text.includes("denied.ts"), "the rows")
    expect(blockOf(frame, "⏺ Edit src/answer.ts")).toEqual([
      "⏺ Edit src/answer.ts",
      "  ⎿ 失败 · The text to replace was not found",
    ])
    expect(blockOf(frame, "⏺ Edit src/denied.ts")).toEqual(["⏺ Edit src/denied.ts", "  ⎿ 已拒绝"])
    const spans = await harness.spans()
    expect(colorOf(spans, "失败 · The text")?.equals(palette().error)).toBe(true)
    expect(colorOf(spans, "已拒绝")?.equals(palette().error)).toBe(true)

    // The key opens the error of the one that failed: a call that was turned down has none to open.
    press(harness)
    const opened = await harness.waitForFrame((text) => text.includes("second line of the error"), "the error")
    expect(opened).not.toContain("const answer")
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("a write says how many lines it wrote and folds the file under that, which the key opens", async () => {
  const path = `${directory}/src/new.ts`
  const diagnostics = { [path]: [lspError("boom")] }
  for (const [language, says] of [
    ["zh-CN", "写入 2 行 · 1 个诊断错误"],
    ["en", "Wrote 2 lines · 1 diagnostic error"],
  ] as const) {
    const harness = await mount(
      [
        call(
          "write",
          completed({ filePath: path, content: "export const a = 1\nexport const b = 2\n" }, "ok", { diagnostics }),
        ),
      ],
      { language },
    )
    try {
      const frame = await frameWith(harness, "⏺ Write")
      expect(blockOf(frame, "⏺ Write")).toEqual(["⏺ Write src/new.ts", `  ⎿ ${says}`])
      expect(frame).not.toContain("export const a")
      expect(frame).not.toContain("ctrl+o")
      const spans = await harness.spans()
      expect(colorOf(spans, language === "en" ? "1 diagnostic error" : "1 个诊断错误")?.equals(palette().error)).toBe(
        true,
      )
      expect(
        colorOf(spans, "Wrote 2 lines")?.equals(palette().text) ?? colorOf(spans, "写入 2 行")?.equals(palette().text),
      ).toBe(true)

      press(harness)
      const opened = await harness.waitForFrame((text) => text.includes("export const b"), "the written file")
      // The code block is the file, numbered, and the line break that ends it does not start a third line. The
      // errors of the language server are under it, and no hint.
      expect(
        blockOf(opened, "⏺ Write")
          .slice(2)
          .map((row) => row.replace(/\s+/g, " ").trim()),
      ).toEqual(["1 export const a = 1", "2 export const b = 2", "Error [1:4] boom"])
      press(harness)
      const closed = await harness.waitForFrame((text) => !text.includes("export const b"), "the closed file")
      expect(blockOf(closed, "⏺ Write")).toEqual(["⏺ Write src/new.ts", `  ⎿ ${says}`])
      expect(harness.writes()).toEqual([])
    } finally {
      await harness.dispose()
    }
  }
})

test("a write of one line is said in the singular and opens, and one of no lines has nothing to open", async () => {
  const one = `${directory}/one.txt`
  const none = `${directory}/none.txt`
  const harness = await mount(
    [
      call("write", completed({ filePath: one, content: "x" }, "ok", { diagnostics: {} })),
      call("write", completed({ filePath: none, content: "" }, "ok", { diagnostics: {} })),
    ],
    { language: "en" },
  )
  try {
    const frame = await harness.waitForFrame((text) => text.includes("none.txt"), "the rows")
    expect(blockOf(frame, "⏺ Write one.txt")).toEqual(["⏺ Write one.txt", "  ⎿ Wrote 1 line"])
    expect(blockOf(frame, "⏺ Write none.txt")).toEqual(["⏺ Write none.txt", "  ⎿ Wrote 0 lines"])
    // The click on the one that wrote nothing does nothing: it has nothing under it to open.
    await clickOn(harness, "Wrote 0 lines")
    await harness.settle()
    expect(await harness.frame()).toBe(frame)
    // The one that wrote a line opens by a click, to the line, and closes by the key.
    await clickOn(harness, "Wrote 1 line")
    const opened = await harness.waitForFrame((text) => text.includes("1 x"), "the written line")
    expect(blockOf(opened, "⏺ Write one.txt").map((row) => row.replace(/\s+/g, " ").trim())).toEqual([
      "⏺ Write one.txt",
      "⎿ Wrote 1 line",
      "1 x",
    ])
    press(harness)
    await harness.waitForFrame((text) => !text.includes("1 x"), "the closed file")
  } finally {
    await harness.dispose()
  }
})

/** A patch of four files: one changed, one created, one deleted and one moved. */
const patchFiles = [
  {
    filePath: `${directory}/src/a.ts`,
    relativePath: "src/a.ts",
    type: "update",
    patch: DIFF,
    additions: 3,
    deletions: 1,
  },
  {
    filePath: `${directory}/src/b.ts`,
    relativePath: "src/b.ts",
    type: "add",
    patch: ADDED,
    additions: 25,
    deletions: 0,
  },
  {
    filePath: `${directory}/src/gone.ts`,
    relativePath: "src/gone.ts",
    type: "delete",
    patch: "",
    additions: 0,
    deletions: 14,
  },
  {
    filePath: `${directory}/src/old.ts`,
    relativePath: "src/new.ts",
    type: "move",
    patch: DIFF,
    additions: 2,
    deletions: 2,
    movePath: `${directory}/src/new.ts`,
  },
]

const patched = (files: Record<string, unknown>[], metadata: Record<string, unknown> = {}) =>
  completed({ patchText: "*** Begin Patch" }, "Success. Updated the following files", {
    diff: DIFF,
    files,
    diagnostics: {},
    ...metadata,
  })

test("a patch has a row of two lines for each file: what the patch did to it, and what it added and removed", async () => {
  for (const [language, created, deleted, moved] of [
    ["zh-CN", "新增", "删除", "移动"],
    ["en", "Created", "Deleted", "Moved"],
  ] as const) {
    const harness = await mount([call("apply_patch", patched(patchFiles))], { language, height: 50 })
    try {
      const frame = await frameWith(harness, "⏺ Patch")
      expect(blockOf(frame, "⏺ Patch src/a.ts")).toEqual(["⏺ Patch src/a.ts", "  ⎿ +3 −1"])
      expect(blockOf(frame, `⏺ Patch ${created}`)).toEqual([`⏺ Patch ${created} src/b.ts`, "  ⎿ +25 −0"])
      // A file the patch deleted has no diff to open, and so is no different from the others to look at.
      expect(blockOf(frame, `⏺ Patch ${deleted}`)).toEqual([`⏺ Patch ${deleted} src/gone.ts`, "  ⎿ +0 −14"])
      expect(blockOf(frame, `⏺ Patch ${moved}`)).toEqual([`⏺ Patch ${moved} src/old.ts → src/new.ts`, "  ⎿ +2 −2"])
      expect(frame).not.toContain("const answer")
      expect(frame).not.toContain("ctrl+o")
      const spans = await harness.spans()
      expect(colorOf(spans, "+25")?.equals(palette().success)).toBe(true)
      expect(colorOf(spans, "−14")?.equals(palette().error)).toBe(true)
    } finally {
      await harness.dispose()
    }
  }
})

test("the key opens the diff of every file of a patch at once, and a file it deleted stays as it was", async () => {
  const harness = await mount([call("apply_patch", patched(patchFiles))], { height: 60 })
  try {
    await frameWith(harness, "⏺ Patch")
    press(harness)
    const opened = await harness.waitForFrame((text) => text.includes("export const b = 2"), "the open diffs")
    expect(
      blockOf(opened, "⏺ Patch src/a.ts")
        .slice(2)
        .map((row) => row.replace(/\s+/g, " ").trim()),
    ).toEqual(["1 export function value() {", "2 - const answer = 41", "2 + const answer = 42", "3 }"])
    expect(
      blockOf(opened, "⏺ Patch 新增")
        .slice(2)
        .map((row) => row.replace(/\s+/g, " ").trim()),
    ).toEqual(["1 + export const a = 1", "2 + export const b = 2"])
    expect(opened).not.toContain("ctrl+o")
    expect(blockOf(opened, "⏺ Patch 删除")).toEqual(["⏺ Patch 删除 src/gone.ts", "  ⎿ +0 −14"])
    expect(blockOf(opened, "⏺ Patch 移动").some((row) => row.includes("const answer = 42"))).toBe(true)

    const spans = await harness.spans()
    expect(backgroundOf(spans, "export const a = 1", "export")?.equals(palette().diffAddedBg)).toBe(true)
    expect(backgroundOf(spans, "const answer = 41", "41")?.equals(palette().diffRemovedBg)).toBe(true)
    expect(backgroundOf(spans, "const answer = 42", "42")?.equals(palette().diffAddedBg)).toBe(true)

    // A click on any file of the call closes all of them: the call is what folds.
    await clickOn(harness, "新增 src/b.ts")
    const closed = await harness.waitForFrame((text) => !text.includes("export const b = 2"), "the closed diffs")
    expect(closed).not.toContain("const answer")
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("a patch that deleted files and nothing else has nothing to open, and the key leaves it alone", async () => {
  const harness = await mount([call("apply_patch", patched([patchFiles[2]]))])
  try {
    const frame = await frameWith(harness, "⏺ Patch")
    expect(blockOf(frame, "⏺ Patch")).toEqual(["⏺ Patch 删除 src/gone.ts", "  ⎿ +0 −14"])
    press(harness)
    await harness.settle()
    expect(await harness.frame()).toBe(frame)
  } finally {
    await harness.dispose()
  }
})

test("a patch the server did not count the added lines of says only what it removed", async () => {
  const { additions: _, ...uncounted } = patchFiles[0]
  const harness = await mount([call("apply_patch", patched([uncounted]))])
  try {
    const frame = await frameWith(harness, "⏺ Patch")
    expect(blockOf(frame, "⏺ Patch")[1]).toBe("  ⎿ −1")
    expect(colorOf(await harness.spans(), "−1")?.equals(palette().error)).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test("a patch counts the errors of each file by the file, and the destination of a move is the file it counts for", async () => {
  const diagnostics = {
    [`${directory}/src/a.ts`]: [lspError("in a"), lspError("in a again", 1)],
    // The errors of a moved file are those of the place it moved to, not the one it left.
    [`${directory}/src/new.ts`]: [lspError("in the new place")],
    [`${directory}/src/old.ts`]: [lspError("in the old place"), lspError("and again", 1), lspError("and once more", 2)],
  }
  const harness = await mount([call("apply_patch", patched([patchFiles[0], patchFiles[3]], { diagnostics }))], {
    language: "en",
  })
  try {
    const frame = await frameWith(harness, "⏺ Patch")
    expect(blockOf(frame, "⏺ Patch src/a.ts")[1]).toBe("  ⎿ +3 −1 · 2 diagnostic errors")
    expect(blockOf(frame, "⏺ Patch Moved")[1]).toBe("  ⎿ +2 −2 · 1 diagnostic error")
  } finally {
    await harness.dispose()
  }
})

test("a patch is one row until it completes, and one row again when it failed", async () => {
  const harness = await mount([
    call("apply_patch", pending()),
    call("apply_patch", failed({ patchText: "x" }, "apply_patch verification failed: no such file\nsecond line")),
  ])
  try {
    const frame = await harness.waitForFrame((text) => text.includes("verification failed"), "the rows")
    expect(blockOf(frame, "⏺ Patch")).toEqual(["⏺ Patch", "  ⎿ 准备中…"])
    expect(frame).toContain("⎿ 失败 · apply_patch verification failed: no such file")
    expect(frame).not.toContain("second line")
    press(harness)
    await harness.waitForFrame((text) => text.includes("second line"), "the error")
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

for (const width of [80, 120]) {
  for (const ambiguousWidth of [1, 2] as const) {
    test(`no row of a call is wider than ${width} columns at ambiguous_width ${ambiguousWidth}`, async () => {
      const long = "很长的命令 · a long command… ".repeat(14)
      const output = `${lines(9, "输出 · output…")}\n${"最后一行 · the last line… ".repeat(12)}`
      const harness = await mount(
        [
          call(
            "bash",
            completed({ command: long, workdir: `${directory}/${"nested/".repeat(8)}` }, output, { output, exit: 3 }),
          ),
          call("grep", completed({ pattern: long, path: `${directory}/${"dir/".repeat(30)}` }, "…", { matches: 1234 })),
          call(
            "webfetch",
            failed({ url: `https://example.com/${"path/".repeat(60)}` }, `${"错误 · error… ".repeat(30)}\nsecond`),
          ),
        ],
        { width, ambiguousWidth, height: 40 },
      )
      try {
        const frame = await harness.waitForFrame((text) => text.includes("WebFetch"), "the rows")
        // The first call is its line, its result and the hint under them; the others are two lines each. A row that
        // wrapped would add one.
        expect(blockOf(frame, "⏺ Bash")).toHaveLength(3)
        expect(blockOf(frame, "⏺ Grep")).toHaveLength(2)
        expect(blockOf(frame, "⏺ WebFetch")).toHaveLength(2)
        // The rows of the calls, with their indent: the rest of the screen has its own rules for the cells it uses.
        for (const lead of ["⏺ Bash", "⏺ Grep", "⏺ WebFetch"]) {
          for (const row of blockOf(frame, lead, { indent: true })) {
            expect(cellWidth(row, ambiguousWidth)).toBeLessThanOrEqual(width)
          }
        }
      } finally {
        await harness.dispose()
      }
    })
  }
}

for (const width of [80, 120]) {
  for (const ambiguousWidth of [1, 2] as const) {
    test(`no row of an edit, a write or a patch is wider than ${width} columns at ambiguous_width ${ambiguousWidth}, in both languages`, async () => {
      const long = `${directory}/${"很长的目录 · a long directory… ".repeat(5)}answer.ts`
      const moved = `${directory}/${"另一个目录 · another place… ".repeat(5)}moved.ts`
      const diagnostics = {
        // The message is the language server's own text, which the open row wraps as it comes.
        [long]: Array.from({ length: 12 }, (_, line) => lspError(`${"a long error message ".repeat(8)}${line}`, line)),
        [moved]: [lspError("x")],
      }
      const calls = () => [
        call(
          "edit",
          completed({ filePath: long }, "ok", {
            diff: DIFF,
            filediff: { additions: 123456, deletions: 654321 },
            diagnostics,
          }),
        ),
        call(
          "write",
          completed({ filePath: long, content: lines(9, "很长的一行 · a long line…") }, "ok", { diagnostics }),
        ),
        call(
          "apply_patch",
          patched(
            [
              {
                filePath: long,
                relativePath: moved.slice(directory.length + 1),
                type: "move",
                patch: DIFF,
                additions: 123456,
                deletions: 654321,
                movePath: moved,
              },
            ],
            { diagnostics },
          ),
        ),
      ]
      for (const language of ["zh-CN", "en"] as const) {
        const harness = await mount(calls(), { width, ambiguousWidth, height: 80, language })
        try {
          const folded = await harness.waitForFrame((text) => text.includes("⏺ Patch"), "the rows")
          // Each is its call and its summary: a row that wrapped would add one.
          for (const lead of ["⏺ Edit", "⏺ Write", "⏺ Patch"]) {
            const block = blockOf(folded, lead, { indent: true })
            expect(block).toHaveLength(2)
            expect(block.filter((row) => cellWidth(row, ambiguousWidth) > width)).toEqual([])
          }

          // Open, the call and its summary are still one row each, and nothing the diff or the file adds is too wide.
          press(harness)
          press(harness)
          press(harness)
          // The diff of the edit and the diff of the patch are the same, so the line that was added is there twice.
          const opened = await harness.waitForFrame(
            (text) => text.split("const answer = 42").length === 3 && text.includes("a long line…"),
            "the open rows",
          )
          for (const lead of ["⏺ Edit", "⏺ Write", "⏺ Patch"]) {
            const block = blockOf(opened, lead, { indent: true })
            expect(block[0].trimStart().startsWith(lead)).toBe(true)
            expect(block[1].trimStart().startsWith("⎿")).toBe(true)
            expect(block.filter((row) => cellWidth(row, ambiguousWidth) > width)).toEqual([])
          }
        } finally {
          await harness.dispose()
        }
      }
    })
  }
}

test("the rows read and write nothing: a click, the key and a hover send no request and write no store part", async () => {
  const output = lines(9)
  const harness = await mount([
    call("bash", completed({ command: "seq 9" }, output, { output, exit: 0 })),
    call("webfetch", failed({ url: "https://example.com" }, "boom")),
  ])
  try {
    await frameWith(harness, "⏺ Bash")
    await clickOn(harness, "还有 8 行")
    await clickOn(harness, "失败 · boom")
    press(harness)
    press(harness)
    await harness.settle()
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})
