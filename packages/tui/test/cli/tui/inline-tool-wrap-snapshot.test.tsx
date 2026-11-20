import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createSignal, For, Show } from "solid-js"
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import { testRender, type JSX } from "@opentui/solid"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { setLanguage } from "../../../src/i18n"
import {
  backgroundReason,
  formatBackgroundStatus,
  formatCompletedSubagentDetail,
  formatSubagentRetry,
  formatSubagentTags,
  formatSubagentToolcalls,
  InlineToolRow,
  parseApplyPatchFiles,
  parseDiagnostics,
  parseQuestionAnswers,
  parseQuestions,
  parseTodos,
  alwaysSeparate,
  toolDisplay,
} from "../../../src/routes/session"
import { ToolRow } from "../../../src/routes/session/tool-row"
import { ShellContexts, renderFirstFrame, shellState } from "../../shell/contexts"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined
let state: Awaited<ReturnType<typeof shellState>> | undefined

// The row texts follow the interface language: the helpers below are read in English unless a test says otherwise.
beforeEach(() => {
  setLanguage("en")
})

afterEach(async () => {
  testSetup?.renderer.destroy()
  testSetup = undefined
  await state?.[Symbol.asyncDispose]()
  state = undefined
  setLanguage(DEFAULT_LANGUAGE)
})

/** The width the rows of the fixtures below are laid out at, which is what `ToolRow` is given as the content width. */
const WIDTH = 72

type ToolFixture = { name: string; arg: string; result: string; error?: string }

// The calls of one turn, as the rows of the tools draw them: the call, and what came of it under it (#1614).
const tools: readonly ToolFixture[] = [
  {
    name: "Grep",
    arg: '"GRAPHAGENT.*DB|database|sqlite|drizzle|dev.*db|data.*dir|xdg|APPDATA" in packages/graphagent/src',
    result: "151 matches",
  },
  { name: "Glob", arg: '"**/*db*" in packages/graphagent', result: "6 files" },
  { name: "Read", arg: "packages/graphagent/src/storage/db.ts [offset=1, limit=130]", result: "Read 130 lines" },
  {
    name: "Read",
    arg: "packages/graphagent/src/index.ts [offset=1, limit=100]",
    result: "Failed · No LSP server available for this file type.",
    error: "No LSP server available for this file type.",
  },
  {
    name: "Grep",
    arg: '"export const GRAPHAGENT_DB|GRAPHAGENT_DB|GRAPHAGENT_DEV|Global\\.Path\\.data|data =" in packages/graphagent/src',
    result: "115 matches",
  },
] as const

/** One call as the row of a tool draws it; a call that failed opens its error when `errorExpanded` is set. */
function Call(props: { item: ToolFixture; errorExpanded?: boolean }) {
  return (
    <ToolRow
      state={props.item.error ? "failed" : "done"}
      name={props.item.name}
      arg={props.item.arg}
      result={props.item.result}
      expanded={props.item.error ? props.errorExpanded : undefined}
      width={WIDTH}
    >
      <text>{props.item.error}</text>
    </ToolRow>
  )
}

function ShellOutput() {
  return (
    <box
      ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
      marginTop={1}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      gap={1}
    >
      <box gap={1}>
        <text>$ ls</text>
        <text>file.ts</text>
      </box>
    </box>
  )
}

function UserMessage() {
  return (
    <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)}>
      <box paddingTop={1} paddingBottom={1} paddingLeft={2}>
        <text>Check whether the next tool remains separated.</text>
      </box>
    </box>
  )
}

function Fixture(props: { errorExpanded?: boolean; before?: "shell" | "user" }) {
  return (
    <box flexDirection="column" width={WIDTH}>
      <box flexDirection="column">
        {props.before === "shell" && <ShellOutput />}
        {props.before === "user" && <UserMessage />}
        <For each={tools}>{(item) => <Call item={item} errorExpanded={props.errorExpanded} />}</For>
      </box>
    </box>
  )
}

// The Task rows are rows of `ToolRow` like the calls around them (#1614): two lines, with who asked and where it runs at
// the end of the first.
function TaskRowsFixture() {
  return (
    <box flexDirection="column" width={WIDTH}>
      <ToolRow state="done" name="Grep" arg='"Task"' result="2 matches" width={WIDTH} />
      <ToolRow
        state="pending"
        name="Task"
        arg="explore · Inspect active task spacing"
        tag="main agent · background"
        result="queued · waiting for a slot"
        width={WIDTH}
      />
      <ToolRow
        state="done"
        name="Task"
        arg="general · Confirm completed task spacing"
        tag="main agent · foreground"
        result="done · 1 tool call · 501ms"
        action="open"
        width={WIDTH}
      />
      <ToolRow
        state="done"
        name="Read"
        arg="src/cli/cmd/tui/routes/session/index.tsx"
        result="Read 40 lines"
        width={WIDTH}
      />
    </box>
  )
}

function LoadedReadBeforeTaskFixture() {
  return (
    <box flexDirection="column" width={WIDTH}>
      <ToolRow
        state="done"
        name="Read"
        arg="src/cli/cmd/tui/routes/session/index.tsx"
        result={
          <box>
            <text>Read 40 lines</text>
            <text>↳ Loaded src/cli/cmd/tui/routes/session/tools.tsx</text>
          </box>
        }
        width={WIDTH}
      />
      <ToolRow
        state="done"
        name="Task"
        arg="explore · Inspect active task spacing"
        tag="main agent · foreground"
        result="done · 1 tool call · 501ms"
        width={WIDTH}
      />
    </box>
  )
}

// The one-line rows that are still `InlineToolRow`s are the ones of a question and a todo update.
function AssistantTextBeforeInlineFixture() {
  return (
    <box flexDirection="column" width={72}>
      <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3} flexDirection="row">
        <box width={2} flexShrink={0}>
          <text>⏺</text>
        </box>
        <text>Checking the open questions first.</text>
      </box>
      <InlineToolRow icon="→" complete={true} pending="">
        Asked 2 questions
      </InlineToolRow>
    </box>
  )
}

function AssistantErrorBeforeInlineFixture() {
  return (
    <box flexDirection="column" width={72}>
      <box
        ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
        border={["left"]}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
      >
        <text>Managed inference requires an active Member plan</text>
      </box>
      <InlineToolRow icon="→" complete={true} pending="">
        Asked 2 questions
      </InlineToolRow>
    </box>
  )
}

function StickyScrollFixture(props: { separated: boolean; scroll: (scroll: ScrollBoxRenderable) => void }) {
  return (
    <scrollbox ref={props.scroll} stickyScroll={true} stickyStart="bottom" height={3} width={72}>
      <box height={1}>
        <text>First row</text>
      </box>
      <box height={1}>
        <text>Second row</text>
      </box>
      <Show when={props.separated}>
        <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)}>
          <text>Assistant text</text>
        </box>
      </Show>
      <ToolRow
        state="done"
        name="Read"
        arg="src/cli/cmd/tui/routes/session/index.tsx"
        result="Read 40 lines"
        width={72}
      />
    </scrollbox>
  )
}

// The call site of a todo update, which is still a one-line row of its own: a patch is a row of `ToolRow` since #1614.
function FailedPendingToolFixture() {
  return (
    <InlineToolRow icon="⚙" complete={false} pending="Updating todos..." failed={true} failure="Todo update failed">
      Updating todos...
    </InlineToolRow>
  )
}

function FailedCompleteToolFixture() {
  return (
    <InlineToolRow icon="→" complete={true} pending="Asking questions..." failed={true} failure="Question failed">
      Asked 2 questions
    </InlineToolRow>
  )
}

/** The fixture in the provider stack of the shell, which the theme and the settings of a row come from. */
async function mountInStack(component: () => JSX.Element, options: { width: number; height: number }) {
  state = await shellState()
  testSetup = await testRender(() => <ShellContexts state={state!.path}>{component()}</ShellContexts>, options)
  await renderFirstFrame(testSetup)
  return testSetup
}

async function renderFrame(component: () => JSX.Element, options: { width: number; height: number }) {
  const app = await mountInStack(component, options)
  await app.renderOnce()
  await app.renderOnce()

  return app
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
}

describe("TUI inline tool wrapping", () => {
  test("falls back for unknown tool names", () => {
    expect(toolDisplay("bash")).toBe("bash")
    expect(toolDisplay("plugin_tool")).toBe("generic")
  })

  test("replaces pending copy when a tool fails before completion", async () => {
    const frame = await renderFrame(() => <FailedPendingToolFixture />, { width: 72, height: 3 })
    expect(frame).toContain("Todo update failed")
    expect(frame).not.toContain("Updating todos")
  })

  test("preserves useful completed copy when a tool fails", async () => {
    const frame = await renderFrame(() => <FailedCompleteToolFixture />, { width: 72, height: 3 })
    expect(frame).toContain("Asked 2 questions")
    expect(frame).not.toContain("Question failed")
  })

  test("filters malformed nested tool wire data", () => {
    expect(
      parseApplyPatchFiles([
        null,
        { type: "add" },
        { type: "add", relativePath: "a.ts", filePath: "a.ts", patch: "diff", deletions: 0 },
      ]),
    ).toEqual([
      {
        type: "add",
        relativePath: "a.ts",
        filePath: "a.ts",
        patch: "diff",
        additions: undefined,
        deletions: 0,
        movePath: undefined,
      },
    ])
    expect(parseTodos([null, { status: "pending" }, { status: "pending", content: "Safe" }])).toEqual([
      { status: "pending", content: "Safe" },
    ])
    expect(parseQuestions([{}, { question: 1 }, { question: "Continue?" }])).toEqual([{ question: "Continue?" }])
    expect(parseQuestionAnswers([null, ["yes", 1], "no"])).toEqual([[], ["yes"], []])
    expect(parseQuestionAnswers({})).toBeUndefined()
  })

  test("ignores diagnostics with malformed nested ranges", () => {
    expect(
      parseDiagnostics(
        {
          "a.ts": [
            { severity: 1, message: "missing range" },
            { severity: 1, message: "bad line", range: { start: { line: "0", character: 1 } } },
            { severity: 1, message: "valid", range: { start: { line: 2, character: 3 } } },
          ],
        },
        "a.ts",
      ),
    ).toEqual([{ message: "valid", range: { start: { line: 2, character: 3 } } }])
  })

  test("formats completed subagent toolcall details", () => {
    expect(formatCompletedSubagentDetail(0, "501ms")).toBe("501ms")
    expect(formatCompletedSubagentDetail(1, "501ms")).toBe("1 tool call · 501ms")
    expect(formatCompletedSubagentDetail(2, "501ms")).toBe("2 tool calls · 501ms")
    expect(formatSubagentToolcalls(0)).toBe("0 tool calls")
  })

  test("distinguishes an unknown cold-start tool count from zero", () => {
    expect(formatSubagentToolcalls(undefined)).toBe("—")
    expect(formatCompletedSubagentDetail(undefined, "501ms")).toBe("— · 501ms")
  })

  test("keeps who asked and where it runs together, for the end of the first line of a Task row", () => {
    const labels = { initiator: undefined, background: false, promoted: false }
    expect(formatSubagentTags(labels)).toBe("main agent · foreground")
    expect(formatSubagentTags({ ...labels, background: true })).toBe("main agent · background")
    expect(formatSubagentTags({ ...labels, initiator: "user" })).toBe("you · foreground")
    expect(formatSubagentTags({ initiator: "agent", background: true, promoted: true })).toBe(
      "main agent · background (moved)",
    )
  })

  test("keeps retry status ahead of wrapping messages", () => {
    expect(formatSubagentRetry(2, "Rate limited by provider")).toBe("Retrying (attempt 2) · Rate limited by provider")
  })

  test("says the same in Chinese", () => {
    setLanguage("zh-CN")
    expect(formatCompletedSubagentDetail(2, "501ms")).toBe("2 次工具调用 · 501ms")
    expect(formatSubagentToolcalls(1)).toBe("1 次工具调用")
    expect(formatSubagentToolcalls(undefined)).toBe("—")
    expect(formatSubagentTags({ initiator: "user", background: false, promoted: false })).toBe("你发起 · 前台")
    expect(formatSubagentRetry(2, "限流")).toBe("重试中（第 2 次）· 限流")
  })

  test("puts a background run's status in one line, with a dash where a number is unknown", () => {
    const base = { reported: false, calls: "—", elapsed: "—" } as const
    expect(formatBackgroundStatus({ ...base, status: "queued" })).toBe("queued · waiting for a slot")
    expect(formatBackgroundStatus({ ...base, status: "running" })).toBe("running · — · —")
    expect(formatBackgroundStatus({ ...base, status: "running", calls: "3 tool calls", elapsed: "1m 5s" })).toBe(
      "running · 3 tool calls · 1m 5s",
    )
    expect(formatBackgroundStatus({ ...base, status: "completed", elapsed: "1.5s" })).toBe("done · 1.5s")
    expect(formatBackgroundStatus({ ...base, status: "completed", reported: true, elapsed: "1.5s" })).toBe(
      "done · 1.5s · result below",
    )
    expect(formatBackgroundStatus({ ...base, status: "error", reason: "boom" })).toBe("failed · boom")
    expect(formatBackgroundStatus({ ...base, status: "error" })).toBe("failed")
    expect(formatBackgroundStatus({ ...base, status: "interrupted" })).toBe("interrupted · can be run again")
    expect(formatBackgroundStatus({ ...base, status: "cancelled" })).toBe("cancelled")
  })

  test("reads the reason a run failed from the first line that has text", () => {
    expect(backgroundReason(undefined, 80, 1)).toBeUndefined()
    expect(backgroundReason("", 80, 1)).toBeUndefined()
    expect(backgroundReason(" \t\n\r\n  \n", 80, 1)).toBeUndefined()
    expect(backgroundReason("\n\n  boom: refused  \nat run (task.ts:42)", 80, 1)).toBe("boom: refused")
    expect(backgroundReason("line one\r\nline two", 80, 1)).toBe("line one")
    // Escapes and control characters are not the reader's to see.
    expect(backgroundReason("\u001b[31mred\u001b[0m boom\u0007", 80, 1)).toBe("red boom")
  })

  test("cuts the reason by the cells it takes, not by its characters", () => {
    expect(backgroundReason("abcdefghij", 6, 1)).toBe("abcde…")
    // Wide characters take two cells each: three of them and the ellipsis are seven cells.
    expect(backgroundReason("网络错误连接被拒绝", 7, 1)).toBe("网络错…")
    // The ellipsis itself is an ambiguous glyph: two cells when the setting says so.
    expect(backgroundReason("abcdefghij", 6, 2)).toBe("abcd…")
    // No room for even the ellipsis: no reason, which the line then leaves out.
    expect(backgroundReason("abcdefghij", 0, 1)).toBeUndefined()
  })

  test("snapshots consecutive grep, glob, and read rows at a narrow width", async () => {
    const frame = await renderFrame(() => <Fixture />, { width: 72, height: 18 })
    expect(frame).toMatchSnapshot()
    // A call is one row for its line and one for its result, cut at the width and not wrapped, and a blank row between.
    expect(frame.split("\n").every((row) => row.length <= 72)).toBe(true)
    expect(frame.split("\n").filter((row) => row.includes("⏺"))).toHaveLength(tools.length)
  })

  test("snapshots expanded tool errors under the tool text", async () => {
    expect(await renderFrame(() => <Fixture errorExpanded />, { width: 72, height: 20 })).toMatchSnapshot()
  })

  test("keeps separation after a shell output block", async () => {
    expect(await renderFrame(() => <Fixture before="shell" />, { width: 72, height: 22 })).toMatchSnapshot()
  })

  test("keeps separation after a padded user message", async () => {
    expect(await renderFrame(() => <Fixture before="user" />, { width: 72, height: 20 })).toMatchSnapshot()
  })

  test("separates after a task row", async () => {
    expect(await renderFrame(() => <TaskRowsFixture />, { width: 72, height: 12 })).toMatchSnapshot()
  })

  test("separates a task row from a preceding tool row with a loaded file", async () => {
    expect(await renderFrame(() => <LoadedReadBeforeTaskFixture />, { width: 72, height: 8 })).toMatchSnapshot()
  })

  test("separates a one-line row from the previous assistant text", async () => {
    expect(await renderFrame(() => <AssistantTextBeforeInlineFixture />, { width: 72, height: 5 })).toMatchSnapshot()
  })

  test("separates a one-line row from the previous assistant error", async () => {
    expect(await renderFrame(() => <AssistantErrorBeforeInlineFixture />, { width: 72, height: 7 })).toMatchSnapshot()
  })

  test("updates sticky-bottom geometry when a text separator mounts and unmounts", async () => {
    const [separated, setSeparated] = createSignal(false)
    let scroll: ScrollBoxRenderable | undefined
    await mountInStack(() => <StickyScrollFixture separated={separated()} scroll={(value) => (scroll = value)} />, {
      width: 72,
      height: 3,
    })

    // Two rows of one line, and a call of two: four lines.
    await testSetup!.renderOnce()
    expect(scroll?.scrollHeight).toBe(4)
    expect(scroll?.scrollTop).toBe(Math.max(0, scroll!.scrollHeight - scroll!.viewport.height))

    // The text that mounts before the call gets a blank line between: six.
    setSeparated(true)
    await testSetup!.renderOnce()
    expect(scroll?.scrollHeight).toBe(6)
    expect(scroll?.scrollTop).toBe(Math.max(0, scroll!.scrollHeight - scroll!.viewport.height))

    setSeparated(false)
    await testSetup!.renderOnce()
    expect(scroll?.scrollHeight).toBe(4)
    expect(scroll?.scrollTop).toBe(Math.max(0, scroll!.scrollHeight - scroll!.viewport.height))
  })
})
