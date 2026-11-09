// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { BoxRenderable, Renderable } from "@opentui/core"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { setLanguage } from "../../src/i18n"
import { DetailPanel, type DetailRow } from "../../src/panel/detail"
import { ListPanel, type ListItem } from "../../src/panel/list"
import { SettingsPanel, type SettingsTab } from "../../src/panel/settings"
import { DEFAULT_THEME } from "../../src/context/theme"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import { PanelSurface, renderPanel } from "./contexts"
import { shellState } from "../shell/contexts"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

const listItems: ListItem<string>[] = [
  { id: "light", value: "light", title: "浅色主题", group: "内置", trail: "默认", description: "浅色背景与深色文字" },
  { id: "dark", value: "dark", title: "深色主题", group: "内置", trail: "已选" },
  { id: "custom", value: "custom", title: "自定义主题", group: "用户", description: "从配置目录读取" },
]

const listTabs = [
  { id: "builtin", label: "内置", badge: "NEW" },
  { id: "user", label: "用户", badge: "OLD" },
]

function listPanel(onSelect: (item: ListItem<string>) => void = () => {}) {
  return (
    <ListPanel
      title="选择主题"
      command="/theme"
      items={listItems}
      current="dark"
      tabs={listTabs}
      activeTab="builtin"
      onSelect={onSelect}
    />
  )
}

function settingsTabs(changes: string[] = []): readonly SettingsTab[] {
  return [
    {
      id: "general",
      label: "通用",
      rows: [
        {
          id: "theme",
          label: "主题",
          kind: "choice",
          value: "graphagent-dark",
          options: [
            { value: "graphagent-dark", label: "graphagent-dark" },
            { value: "graphagent-light", label: "graphagent-light" },
          ],
          description: "界面配色",
          onChange: (value) => changes.push(`theme:${value}`),
        },
        {
          id: "reasoning",
          label: "推理过程",
          kind: "toggle",
          value: true,
          description: "折叠时只显示思考用时",
          onChange: (value) => changes.push(`reasoning:${value}`),
        },
        {
          id: "apiKey",
          label: "接口密钥",
          kind: "text",
          value: "",
          secret: true,
          description: "保存在全局配置",
          suffix: () => "全局",
          onChange: (value) => changes.push(`apiKey:${value}`),
        },
        {
          id: "clear",
          label: "清除缓存",
          kind: "action",
          valueLabel: "0 项",
          run: () => changes.push("clear"),
        },
      ],
    },
    { id: "model", label: "模型", rows: [] },
  ]
}

function settingsPanel(changes: string[] = []) {
  return <SettingsPanel title="设置" command="/config" tabs={settingsTabs(changes)} activeTab="general" />
}

const detailRows: DetailRow<string>[] = [
  { id: "title", cells: ["标题", "重构底部面板"], value: "title", note: "按 ⏎ 复制标题" },
  { id: "state", cells: ["状态", "运行中"], value: "state" },
  { id: "owner", cells: ["归属", "根会话"], value: "owner" },
]

function detailPanel(onActivate: (row: DetailRow<string>) => void = () => {}) {
  return (
    <DetailPanel
      title="会话详情"
      command="/status"
      summary={<text>进度 2/5</text>}
      rows={detailRows}
      onActivate={onActivate}
      hints={[]}
    />
  )
}

function collect(root: Renderable, result: Renderable[] = []) {
  result.push(root)
  for (const child of root.getChildren()) collect(child, result)
  return result
}

function frameLines(frame: string) {
  return frame.split("\n").map((line) => line.trimEnd())
}

function borderIndex(lines: string[], glyph: string) {
  return lines.findIndex((line) => line.includes(glyph))
}

test("list panel renders the three-segment surface at 80x24", async () => {
  await using tmp = await shellState()
  const app = await renderPanel(() => <PanelSurface spec={{ render: () => listPanel() }} />, {
    width: 80,
    height: 24,
    state: tmp.path,
  })

  try {
    const frame = app.captureCharFrame()
    const lines = frameLines(frame)
    const top = borderIndex(lines, "╭")
    const bottom = borderIndex(lines, "╰")
    expect(top).toBeGreaterThanOrEqual(0)
    expect(bottom).toBeGreaterThan(top)
    expect(lines[top + 1]).toContain("选择主题")
    expect(lines[bottom - 1]).toContain("上移")
    expect(lines[bottom - 1]).toContain("关闭")
    const content = lines.slice(top + 2, bottom - 1).join("\n")
    expect(content).toContain("浅色主题")
    expect(frame).toMatchSnapshot()
  } finally {
    app.renderer.destroy()
  }
})

test("list panel renders the three-segment surface at 120x40", async () => {
  await using tmp = await shellState()
  const app = await renderPanel(() => <PanelSurface spec={{ render: () => listPanel() }} />, {
    width: 120,
    height: 40,
    state: tmp.path,
  })

  try {
    const frame = app.captureCharFrame()
    const lines = frameLines(frame)
    const top = borderIndex(lines, "╭")
    const bottom = borderIndex(lines, "╰")
    expect(top).toBeGreaterThanOrEqual(0)
    expect(bottom).toBeGreaterThan(top)
    expect(lines[top + 1]).toContain("选择主题")
    expect(lines[top + 1]).toContain("/theme")
    expect(lines[top + 1]).toContain("NEW")
    expect(frame).toMatchSnapshot()
  } finally {
    app.renderer.destroy()
  }
})

test("settings panel renders at 80x24 and 120x40", async () => {
  await using tmp = await shellState()
  const narrow = await renderPanel(() => <PanelSurface spec={{ render: () => settingsPanel() }} />, {
    width: 80,
    height: 24,
    state: tmp.path,
  })

  try {
    const frame = narrow.captureCharFrame()
    expect(frame).toContain("设置")
    expect(frame).toContain("推理过程")
    expect(frame).not.toContain("/config")
    expect(frame).toMatchSnapshot()
  } finally {
    narrow.renderer.destroy()
  }

  const wide = await renderPanel(() => <PanelSurface spec={{ render: () => settingsPanel() }} />, {
    width: 120,
    height: 40,
    state: tmp.path,
  })

  try {
    const frame = wide.captureCharFrame()
    expect(frame).toContain("/config")
    expect(frame).toContain("graphagent-dark")
    expect(frame).toMatchSnapshot()
  } finally {
    wide.renderer.destroy()
  }
})

test("detail panel renders at 80x24 and 120x40", async () => {
  await using tmp = await shellState()
  const narrow = await renderPanel(() => <PanelSurface spec={{ render: () => detailPanel() }} />, {
    width: 80,
    height: 24,
    state: tmp.path,
  })

  try {
    const frame = narrow.captureCharFrame()
    expect(frame).toContain("会话详情")
    expect(frame).toContain("进度 2/5")
    expect(frame).toContain("重构底部面板")
    expect(frame).not.toContain("/status")
    expect(frame).toMatchSnapshot()
  } finally {
    narrow.renderer.destroy()
  }

  const wide = await renderPanel(() => <PanelSurface spec={{ render: () => detailPanel() }} />, {
    width: 120,
    height: 40,
    state: tmp.path,
  })

  try {
    const frame = wide.captureCharFrame()
    expect(frame).toContain("/status")
    expect(frame).toContain("按 ⏎ 复制标题")
    expect(frame).toMatchSnapshot()
  } finally {
    wide.renderer.destroy()
  }
})

test("warning tone uses the borderWarning token", async () => {
  await using tmp = await shellState()
  const theme = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME]!, "dark")
  const app = await renderPanel(() => <PanelSurface spec={{ render: () => detailPanel() }} />, {
    width: 100,
    height: 30,
    state: tmp.path,
  })

  try {
    const boxes = collect(app.renderer.root).filter(
      (item): item is BoxRenderable => item instanceof BoxRenderable && item.border !== false,
    )
    expect(boxes.length).toBeGreaterThan(0)
    expect(boxes.some((box) => box.borderColor.equals(theme.borderWarning))).toBe(false)
  } finally {
    app.renderer.destroy()
  }

  const warning = await renderPanel(
    () => (
      <PanelSurface
        spec={{
          render: () => (
            <DetailPanel title="权限请求" tone="warning" rows={detailRows} hints={[]} onActivate={() => {}} />
          ),
        }}
      />
    ),
    { width: 100, height: 30, state: tmp.path },
  )

  try {
    const boxes = collect(warning.renderer.root).filter(
      (item): item is BoxRenderable => item instanceof BoxRenderable && item.border !== false,
    )
    expect(boxes.some((box) => box.borderColor.equals(theme.borderWarning))).toBe(true)
  } finally {
    warning.renderer.destroy()
  }
})

test("narrow terminals hide the command name and tab badges", async () => {
  await using tmp = await shellState()
  const narrow = await renderPanel(() => <PanelSurface spec={{ render: () => listPanel() }} />, {
    width: 80,
    height: 24,
    state: tmp.path,
  })

  try {
    const frame = narrow.captureCharFrame()
    expect(frame).not.toContain("/theme")
    expect(frame).not.toContain("NEW")
    expect(frame).toContain("内置")
  } finally {
    narrow.renderer.destroy()
  }

  const wide = await renderPanel(() => <PanelSurface spec={{ render: () => listPanel() }} />, {
    width: 120,
    height: 40,
    state: tmp.path,
  })

  try {
    const frame = wide.captureCharFrame()
    expect(frame).toContain("/theme")
    expect(frame).toContain("NEW")
  } finally {
    wide.renderer.destroy()
  }
})

test("long lists scroll inside the capped content area", async () => {
  await using tmp = await shellState()
  const items: ListItem<string>[] = Array.from({ length: 20 }, (_, index) => ({
    id: `item-${index}`,
    value: `item-${index}`,
    title: `条目 ${index + 1}`,
  }))
  const app = await renderPanel(
    () => <PanelSurface spec={{ render: () => <ListPanel title="长列表" items={items} onSelect={() => {}} /> }} />,
    { width: 80, height: 24, state: tmp.path },
  )

  try {
    const frame = app.captureCharFrame()
    const lines = frameLines(frame)
    const top = borderIndex(lines, "╭")
    const bottom = borderIndex(lines, "╰")
    // One top border, one header row, at most ten content rows, one hint row.
    expect(bottom - top).toBeLessThanOrEqual(13)
    expect(frame).toContain("条目 1")
    expect(frame).not.toContain("条目 20")

    app.mockInput.pressKey("END")
    await Bun.sleep(50)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("条目 20")
  } finally {
    app.renderer.destroy()
  }
})

test("list panel moves with arrows, selects with return, and runs ctrl bindings", async () => {
  await using tmp = await shellState()
  const selected: string[] = []
  const actions: string[] = []
  const app = await renderPanel(
    () => (
      <PanelSurface
        spec={{
          render: () => (
            <ListPanel
              title="选择主题"
              items={listItems}
              current="dark"
              onSelect={(item) => selected.push(item.id)}
              actions={[
                {
                  key: "session.pin.toggle",
                  label: "置顶",
                  run: (item) => {
                    actions.push(item.id)
                  },
                },
              ]}
            />
          ),
        }}
      />
    ),
    { width: 120, height: 40, state: tmp.path },
  )

  try {
    app.mockInput.pressArrow("down")
    await Bun.sleep(50)
    app.mockInput.pressEnter()
    await Bun.sleep(20)
    expect(selected).toEqual(["custom"])

    app.mockInput.pressKey("f", { ctrl: true })
    await Bun.sleep(50)
    expect(actions).toEqual(["custom"])
  } finally {
    app.renderer.destroy()
  }
})

test("settings panel cycles choice and toggle rows", async () => {
  await using tmp = await shellState()
  const changes: string[] = []
  const app = await renderPanel(() => <PanelSurface spec={{ render: () => settingsPanel(changes) }} />, {
    width: 120,
    height: 40,
    state: tmp.path,
  })

  try {
    app.mockInput.pressEnter()
    await Bun.sleep(50)
    expect(changes).toEqual(["theme:graphagent-light"])

    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await Bun.sleep(50)
    expect(changes).toEqual(["theme:graphagent-light", "reasoning:false"])
  } finally {
    app.renderer.destroy()
  }
})

test("detail panel selects rows and activates them", async () => {
  await using tmp = await shellState()
  const selects: string[] = []
  const activates: string[] = []
  const app = await renderPanel(
    () => (
      <PanelSurface
        spec={{
          render: () => (
            <DetailPanel
              title="会话详情"
              rows={detailRows}
              onSelect={(row) => selects.push(row.id)}
              onActivate={(row) => activates.push(row.id)}
              hints={[]}
            />
          ),
        }}
      />
    ),
    { width: 120, height: 40, state: tmp.path },
  )

  try {
    app.mockInput.pressArrow("down")
    await Bun.sleep(50)
    app.mockInput.pressEnter()
    await Bun.sleep(20)
    expect(selects).toEqual(["state"])
    expect(activates).toEqual(["state"])
  } finally {
    app.renderer.destroy()
  }
})
