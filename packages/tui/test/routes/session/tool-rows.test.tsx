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
    expect(blockOf(frame, "⏺ WebSearch Exa")).toEqual(['⏺ WebSearch Exa Web Search "bun 1.4 release"', "  ⎿ 8 条结果"])
    // No result count in the metadata: the row says the call is done, and makes up no number.
    expect(blockOf(frame, "⏺ WebSearch Parallel")).toEqual(['⏺ WebSearch Parallel Web Search "no count"', "  ⎿ 完成"])
  } finally {
    await harness.dispose()
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
