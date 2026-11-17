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
  formatSubagentTitle,
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

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

// The row texts follow the interface language: the helpers below are read in English unless a test says otherwise.
beforeEach(() => {
  setLanguage("en")
})

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
  setLanguage(DEFAULT_LANGUAGE)
})

type ToolFixture = { icon: string; label: string; error?: string }

const tools: readonly ToolFixture[] = [
  {
    icon: "✱",
    label:
      'Grep "GRAPHAGENT.*DB|database|sqlite|drizzle|dev.*db|data.*dir|xdg|APPDATA" in packages/graphagent/src (151 matches)',
  },
  {
    icon: "✱",
    label: 'Glob "**/*db*" in packages/graphagent (6 matches)',
  },
  {
    icon: "→",
    label: "Read packages/graphagent/src/storage/db.ts [offset=1, limit=130]",
  },
  {
    icon: "→",
    label: "Read packages/graphagent/src/index.ts [offset=1, limit=100]",
    error: "No LSP server available for this file type.",
  },
  {
    icon: "✱",
    label:
      'Grep "export const GRAPHAGENT_DB|GRAPHAGENT_DB|GRAPHAGENT_DEV|Global\\.Path\\.data|data =" in packages/graphagent/src (115 matches)',
  },
] as const

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
    <box flexDirection="column" width={72}>
      <box flexDirection="column">
        {props.before === "shell" && <ShellOutput />}
        {props.before === "user" && <UserMessage />}
        <For each={tools}>
          {(item) => (
            <InlineToolRow
              icon={item.icon}
              complete={true}
              pending=""
              failed={Boolean(item.error)}
              error={item.error}
              errorExpanded={props.errorExpanded}
            >
              {item.label}
            </InlineToolRow>
          )}
        </For>
      </box>
    </box>
  )
}

function TaskRowsFixture() {
  return (
    <box flexDirection="column" width={72}>
      <InlineToolRow icon="✱" complete={true} pending="">
        Grep "Task" (2 matches)
      </InlineToolRow>
      <InlineToolRow icon="⠙" complete={true} pending="" separate={true}>
        Explore Task — Inspect active task spacing
      </InlineToolRow>
      <InlineToolRow icon="✓" complete={true} pending="" separate={true}>
        {"General Task — Confirm completed task spacing\n↳ 1 toolcall · 501ms"}
      </InlineToolRow>
      <InlineToolRow icon="→" complete={true} pending="">
        Read src/cli/cmd/tui/routes/session/index.tsx
      </InlineToolRow>
    </box>
  )
}

function LoadedReadBeforeTaskFixture() {
  return (
    <box flexDirection="column" width={72}>
      <InlineToolRow icon="→" complete={true} pending="">
        Read src/cli/cmd/tui/routes/session/index.tsx
      </InlineToolRow>
      <box paddingLeft={3}>
        <text paddingLeft={3}>↳ Loaded src/cli/cmd/tui/routes/session/tools.tsx</text>
      </box>
      <InlineToolRow icon="✓" complete={true} pending="" separate={true}>
        {"Explore Task — Inspect active task spacing\n↳ 1 toolcall · 501ms"}
      </InlineToolRow>
    </box>
  )
}

function AssistantSummaryBeforeInlineFixture() {
  return (
    <box flexDirection="column" width={72}>
      <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3}>
        <text>▣ Build · Little Frank · 53.1s</text>
      </box>
      <InlineToolRow icon="✓" complete={true} pending="">
        {"Build Task — Review changes\n↳ 48 toolcalls · 1m 40s"}
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
      <InlineToolRow icon="✓" complete={true} pending="">
        {"Build Task — Review changes\n↳ 48 toolcalls · 1m 40s"}
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
      <InlineToolRow icon="→" complete={true} pending="">
        Read src/cli/cmd/tui/routes/session/index.tsx
      </InlineToolRow>
    </scrollbox>
  )
}

function FailedPendingToolFixture() {
  return (
    <InlineToolRow icon="%" complete={false} pending="Preparing patch..." failed={true} failure="Patch failed">
      Patch
    </InlineToolRow>
  )
}

function FailedCompleteToolFixture() {
  return (
    <InlineToolRow icon="→" complete={true} pending="Reading file..." failed={true} failure="Read failed">
      Read src/index.ts
    </InlineToolRow>
  )
}

async function renderFrame(component: () => JSX.Element, options: { width: number; height: number }) {
  testSetup = await testRender(component, options)
  await testSetup.renderOnce()
  await testSetup.renderOnce()

  return testSetup
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
    expect(frame).toContain("Patch failed")
    expect(frame).not.toContain("Preparing patch")
  })

  test("preserves useful completed copy when a tool fails", async () => {
    const frame = await renderFrame(() => <FailedCompleteToolFixture />, { width: 72, height: 3 })
    expect(frame).toContain("Read src/index.ts")
    expect(frame).not.toContain("Read failed")
  })

  test("filters malformed nested tool wire data", () => {
    expect(
      parseApplyPatchFiles([
        null,
        { type: "add" },
        { type: "add", relativePath: "a.ts", filePath: "a.ts", patch: "diff", deletions: 0 },
      ]),
    ).toEqual([
      { type: "add", relativePath: "a.ts", filePath: "a.ts", patch: "diff", deletions: 0, movePath: undefined },
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

  test("keeps who asked and where it runs attached to the subagent identity", () => {
    const labels = { initiator: undefined, background: false, promoted: false }
    expect(formatSubagentTitle("Explore", "Inspect renderer", labels)).toBe(
      "Explore Task — Inspect renderer · main agent · foreground",
    )
    expect(formatSubagentTitle("Explore", "Inspect renderer", { ...labels, background: true })).toBe(
      "Explore Task — Inspect renderer · main agent · background",
    )
    expect(formatSubagentTitle("Explore", "Inspect renderer", { ...labels, initiator: "user" })).toBe(
      "Explore Task — Inspect renderer · you · foreground",
    )
    expect(
      formatSubagentTitle("Explore", "Inspect renderer", { initiator: "agent", background: true, promoted: true }),
    ).toBe("Explore Task — Inspect renderer · main agent · background (moved)")
  })

  test("keeps retry status ahead of wrapping messages", () => {
    expect(formatSubagentRetry(2, "Rate limited by provider")).toBe("Retrying (attempt 2) · Rate limited by provider")
  })

  test("says the same in Chinese", () => {
    setLanguage("zh-CN")
    expect(formatCompletedSubagentDetail(2, "501ms")).toBe("2 次工具调用 · 501ms")
    expect(formatSubagentToolcalls(1)).toBe("1 次工具调用")
    expect(formatSubagentToolcalls(undefined)).toBe("—")
    expect(
      formatSubagentTitle("Explore", "检查渲染器", { initiator: "user", background: false, promoted: false }),
    ).toBe("Explore Task — 检查渲染器 · 你发起 · 前台")
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
    expect(await renderFrame(() => <Fixture />, { width: 72, height: 12 })).toMatchSnapshot()
  })

  test("snapshots expanded tool errors under the tool text", async () => {
    expect(await renderFrame(() => <Fixture errorExpanded />, { width: 72, height: 12 })).toMatchSnapshot()
  })

  test("keeps separation after a shell output block", async () => {
    expect(await renderFrame(() => <Fixture before="shell" />, { width: 72, height: 16 })).toMatchSnapshot()
  })

  test("keeps separation after a padded user message", async () => {
    expect(await renderFrame(() => <Fixture before="user" />, { width: 72, height: 14 })).toMatchSnapshot()
  })

  test("separates after a multi-line task row", async () => {
    expect(await renderFrame(() => <TaskRowsFixture />, { width: 72, height: 10 })).toMatchSnapshot()
  })

  test("separates a task row from a preceding inline detail", async () => {
    expect(await renderFrame(() => <LoadedReadBeforeTaskFixture />, { width: 72, height: 8 })).toMatchSnapshot()
  })

  test("separates an inline row from the previous assistant summary", async () => {
    expect(await renderFrame(() => <AssistantSummaryBeforeInlineFixture />, { width: 72, height: 5 })).toMatchSnapshot()
  })

  test("separates an inline row from the previous assistant error", async () => {
    expect(await renderFrame(() => <AssistantErrorBeforeInlineFixture />, { width: 72, height: 7 })).toMatchSnapshot()
  })

  test("updates sticky-bottom geometry when a text separator mounts and unmounts", async () => {
    const [separated, setSeparated] = createSignal(false)
    let scroll: ScrollBoxRenderable | undefined
    testSetup = await testRender(
      () => <StickyScrollFixture separated={separated()} scroll={(value) => (scroll = value)} />,
      {
        width: 72,
        height: 3,
      },
    )

    await testSetup.renderOnce()
    expect(scroll?.scrollHeight).toBe(3)
    expect(scroll?.scrollTop).toBe(Math.max(0, scroll!.scrollHeight - scroll!.viewport.height))

    setSeparated(true)
    await testSetup.renderOnce()
    expect(scroll?.scrollHeight).toBe(5)
    expect(scroll?.scrollTop).toBe(Math.max(0, scroll!.scrollHeight - scroll!.viewport.height))

    setSeparated(false)
    await testSetup.renderOnce()
    expect(scroll?.scrollHeight).toBe(3)
    expect(scroll?.scrollTop).toBe(Math.max(0, scroll!.scrollHeight - scroll!.viewport.height))
  })
})
