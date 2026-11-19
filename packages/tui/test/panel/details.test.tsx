// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import type { FormatterStatus, LspStatus, McpStatus, VcsFileStatus } from "@graphagent/sdk"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { onMount } from "solid-js"
import { useTuiConfig } from "../../src/config"
import { useBindings } from "../../src/keymap"
import { setLanguage } from "../../src/i18n"
import { HelpPanel } from "../../src/panel/help"
import { createPanelHost, PanelHost, PanelHostProvider, type PanelHostApi } from "../../src/panel/host"
import { showExportOptions, type ExportOptions } from "../../src/panel/export"
import { StatusPanel } from "../../src/panel/status"
import { WorkspaceFileChangesPanel } from "../../src/panel/workspace-file-changes"
import { cellWidth } from "../../src/ui/width"
import { shellState } from "../shell/contexts"
import { PanelSurface, renderAppPanel, renderPanel } from "./contexts"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

async function settle(app: Awaited<ReturnType<typeof renderPanel>>) {
  await Bun.sleep(30)
  await app.renderOnce()
}

/** Registers a keymap command so the help panel can list a real shortcut row. */
function RegisteredShortcut() {
  useBindings(() => ({
    commands: [{ name: "test.shortcut", title: "测试快捷键", category: "测试", run: () => {} }],
    bindings: [{ key: "ctrl+t", cmd: "test.shortcut", desc: "测试快捷键", group: "测试" }],
  }))
  return null
}

/** Registers an existing command from the resolved config so overrides reach /help. */
function ReboundShortcut() {
  const config = useTuiConfig()
  useBindings(() => ({
    commands: [{ name: "session.dagmode.toggle", title: "切换工作流模式", category: "测试", run: () => {} }],
    bindings: config.keybinds.gather("test.help", ["session.dagmode.toggle"]),
  }))
  return null
}

/** Shortcuts in two categories and one in none, and three the list must leave out: hidden, a panel's own, unbound. */
function GroupedShortcuts() {
  useBindings(() => ({
    commands: [
      { name: "test.beta", title: "Beta", category: "Group B", run: () => {} },
      { name: "test.alpha", title: "Alpha", category: "Group B", run: () => {} },
      { name: "test.first", title: "First", category: "Group A", run: () => {} },
      { name: "test.bare", title: "Bare", run: () => {} },
      { name: "test.hidden", title: "Hidden one", category: "Group A", hidden: true, run: () => {} },
      { name: "test.panel", title: "Panel one", category: "Panel", run: () => {} },
      { name: "test.unbound", title: "Unbound one", category: "Group A", run: () => {} },
    ],
    bindings: [
      { key: "f1", cmd: "test.beta" },
      { key: "f2", cmd: "test.alpha" },
      { key: "f3", cmd: "test.first" },
      { key: "f4", cmd: "test.bare" },
      { key: "f5", cmd: "test.hidden" },
      { key: "f6", cmd: "test.panel" },
    ],
  }))
  return null
}

function ExportHarness(props: { onReady(host: PanelHostApi, options: Promise<ExportOptions | null>): void }) {
  const host = createPanelHost()
  onMount(() =>
    props.onReady(
      host,
      showExportOptions({
        host,
        defaultFilename: "transcript.md",
        defaultThinking: false,
        defaultToolDetails: true,
        defaultAssistantMetadata: false,
        defaultOpenWithoutSaving: false,
      }),
    ),
  )
  return (
    <PanelHostProvider host={host}>
      <PanelHost host={host} />
    </PanelHostProvider>
  )
}

test("help panel lists keymap shortcuts and registry commands and closes with escape", async () => {
  await using tmp = await shellState()
  let host: PanelHostApi | undefined
  const app = await renderAppPanel(
    () => (
      <>
        <RegisteredShortcut />
        <PanelSurface spec={{ id: "help", render: () => <HelpPanel /> }} onHost={(value) => (host = value)} />
      </>
    ),
    { width: 120, height: 40, state: tmp.path },
  )

  try {
    expect(app.captureCharFrame()).toContain("帮助")
    expect(app.captureCharFrame()).toContain("测试快捷键")

    app.mockInput.pressArrow("right")
    await settle(app)
    expect(app.captureCharFrame()).toContain("/new")
    expect(app.captureCharFrame()).toContain("新建会话")

    app.mockInput.pressEscape()
    await settle(app)
    expect(host?.depth()).toBe(0)
    expect(app.captureCharFrame()).not.toContain("帮助")
  } finally {
    app.renderer.destroy()
  }
})

test("help panel shows the rebound key for an existing command", async () => {
  await using tmp = await shellState()
  const app = await renderAppPanel(
    () => (
      <>
        <ReboundShortcut />
        <PanelSurface spec={{ id: "help", render: () => <HelpPanel /> }} />
      </>
    ),
    {
      width: 120,
      height: 40,
      state: tmp.path,
      keybinds: { session_dagmode_toggle: "f8" },
    },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("帮助")
    expect(frame).toContain("切换工作流模式")
    expect(frame).toContain("f8")
    expect(frame).not.toContain("ctrl+x d")
  } finally {
    app.renderer.destroy()
  }
})

test("help panel groups the shortcuts by category, sorts them by title, and leaves out what cannot be pressed", async () => {
  await using tmp = await shellState()
  const app = await renderAppPanel(
    () => (
      <>
        <GroupedShortcuts />
        <PanelSurface spec={{ id: "help", render: () => <HelpPanel /> }} />
      </>
    ),
    { width: 120, height: 40, state: tmp.path },
  )

  try {
    const frame = app.captureCharFrame()
    // A command with no category comes first and has no heading; the others follow under theirs, each in order of title.
    const order = ["Bare", "Group A", "First", "Group B", "Alpha", "Beta"].map((text) => frame.indexOf(text))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(frame.match(/Group A/g)).toHaveLength(1)
    expect(frame.match(/Group B/g)).toHaveLength(1)
    for (const left of ["Hidden one", "Panel one", "Unbound one"]) expect(frame).not.toContain(left)
  } finally {
    app.renderer.destroy()
  }
})

test("status panel reveals the full recent error when its row is selected", async () => {
  await using tmp = await shellState()
  const segments = Array.from({ length: 40 }, (_, index) => `segment-${index}`)
  const long = `export failed: ${segments.join(" ")}`
  const app = await renderAppPanel(() => <PanelSurface spec={{ id: "status", render: () => <StatusPanel /> }} />, {
    width: 120,
    height: 40,
    state: tmp.path,
    setup: (context) => {
      context.sync.set("mcp", { alpha: { status: "connected" } as McpStatus })
      context.toast.error(new Error(long))
    },
  })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("最近的错误")
    expect(frame).toContain("export failed:")
    expect(frame).not.toContain("segment-39")

    app.mockInput.pressArrow("down")
    await settle(app)
    const expanded = app.captureCharFrame()
    expect(expanded).toContain("export failed:")
    expect(expanded).toContain("segment-39")
  } finally {
    app.renderer.destroy()
  }
})

test("status panel renders mcp, lsp, formatter, version and recent error records", async () => {
  await using tmp = await shellState()
  let host: PanelHostApi | undefined
  const mcp = {
    alpha: { status: "connected" } as McpStatus,
    beta: { status: "failed", error: "beta failed" } as McpStatus,
  }
  const lsp: LspStatus[] = [{ id: "typescript", name: "TypeScript", root: "/tmp/project", status: "error" }]
  const formatter: FormatterStatus[] = [
    { name: "prettier", extensions: [".ts"], enabled: true },
    { name: "disabled-formatter", extensions: [".ts"], enabled: false },
  ]
  const app = await renderAppPanel(
    () => <PanelSurface spec={{ id: "status", render: () => <StatusPanel /> }} onHost={(value) => (host = value)} />,
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => {
        context.sync.set("mcp", mcp)
        context.sync.set("lsp", lsp)
        context.sync.set("formatter", formatter)
        context.toast.error(new Error("export failed"))
      },
    },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("状态")
    expect(frame).toContain("MCP 服务器")
    expect(frame).toContain("alpha")
    expect(frame).toContain("已连接")
    expect(frame).toContain("beta failed")
    expect(frame).toContain("LSP 服务器")
    expect(frame).toContain("typescript")
    expect(frame).toContain("格式化器")
    expect(frame).toContain("prettier")
    expect(frame).not.toContain("disabled-formatter")
    expect(frame).toContain("版本")
    expect(frame).toContain("local")
    expect(frame).toContain("最近的错误")
    expect(frame).toContain("export failed")

    app.mockInput.pressEscape()
    await settle(app)
    expect(host?.depth()).toBe(0)
    expect(app.captureCharFrame()).not.toContain("状态")
  } finally {
    app.renderer.destroy()
  }
})

test("export panel toggles options and submits the export action", async () => {
  await using tmp = await shellState()
  let host: PanelHostApi | undefined
  let pending!: Promise<ExportOptions | null>
  const app = await renderPanel(
    () => (
      <ExportHarness
        onReady={(value, options) => {
          host = value
          pending = options
        }}
      />
    ),
    { width: 120, height: 40, state: tmp.path },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("导出选项")
    expect(frame).toContain("transcript.md")
    expect(frame).toContain("文件名")

    app.mockInput.pressArrow("down")
    await settle(app)
    app.mockInput.pressEnter()
    await settle(app)

    app.mockInput.pressArrow("down")
    await settle(app)
    app.mockInput.pressEnter()
    await settle(app)

    app.mockInput.pressArrow("down")
    await settle(app)
    app.mockInput.pressArrow("down")
    await settle(app)
    app.mockInput.pressArrow("down")
    await settle(app)
    app.mockInput.pressEnter()
    await settle(app)

    const options = await Promise.race([pending, Bun.sleep(1000).then(() => "timeout" as const)])
    expect(options).not.toBe("timeout")
    expect(options).toEqual({
      filename: "transcript.md",
      thinking: true,
      toolDetails: false,
      assistantMetadata: false,
      openWithoutSaving: false,
    })
    expect(host?.depth()).toBe(0)
    expect(app.captureCharFrame()).not.toContain("导出选项")
  } finally {
    app.renderer.destroy()
  }
})

test("export panel shares the settings layout: values after the names, where a toggle stands, no note line", async () => {
  await using tmp = await shellState()
  const app = await renderPanel(() => <ExportHarness onReady={() => {}} />, {
    width: 120,
    height: 40,
    state: tmp.path,
  })
  const lines = () =>
    app
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())
  const row = (label: string) => lines().find((line) => line.includes(label)) ?? ""
  /** The cell the text starts at: the border and padding, the selection mark, and the 22 cells of the name column. */
  const column = (line: string, text: string) => cellWidth(line.slice(0, line.indexOf(text)))

  try {
    // The filename is the first row and is selected: a text row has no hint to cycle.
    expect(column(row("文件名"), "transcript.md")).toBe(26)
    expect(row("文件名")).not.toContain("换一个")
    // The toggles: thinking is off, the second of its two values; tool details are on, the first.
    expect(column(row("包含思考过程"), "关")).toBe(26)
    expect(column(row("包含工具详情"), "开")).toBe(26)
    app.mockInput.pressArrow("down")
    await settle(app)
    expect(row("包含思考过程")).toContain("换一个（2/2）")
    app.mockInput.pressArrow("down")
    await settle(app)
    expect(row("包含工具详情")).toContain("换一个（1/2）")
    expect(row("包含思考过程")).not.toContain("换一个")

    // No row explains itself, so the panel has no line for a note: the hints follow the last row at once.
    const all = lines()
    const bottom = all.findIndex((line) => line.includes("╰"))
    expect(all[bottom - 2]).toContain("导出")
    expect(all[bottom - 1]).toContain("关闭")
  } finally {
    app.renderer.destroy()
  }
})

test("workspace file changes panel lists rows, confirms on return and closes with escape", async () => {
  await using tmp = await shellState()
  let host: PanelHostApi | undefined
  let confirms = 0
  const files: VcsFileStatus[] = [
    { file: "src/a.ts", additions: 3, deletions: 1, status: "modified" },
    { file: "src/b.ts", additions: 2, deletions: 0, status: "added" },
  ]
  const app = await renderPanel(
    () => (
      <PanelSurface
        spec={{
          id: "workspace-file-changes",
          render: () => (
            <WorkspaceFileChangesPanel
              files={files}
              onConfirm={() => {
                confirms += 1
              }}
            />
          ),
        }}
        onHost={(value) => (host = value)}
      />
    ),
    { width: 120, height: 40, state: tmp.path },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("发现文件变更")
    expect(frame).toContain("要把这些文件变更随会话一起移动吗？")
    expect(frame).toContain("src/a.ts")
    expect(frame).toContain("+3 -1")
    expect(frame).toContain("src/b.ts")

    app.mockInput.pressArrow("down")
    await settle(app)
    app.mockInput.pressEnter()
    await settle(app)
    expect(confirms).toBe(1)

    app.mockInput.pressEscape()
    await settle(app)
    expect(host?.depth()).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})
