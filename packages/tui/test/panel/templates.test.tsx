// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { BoxRenderable, Renderable, TextAttributes, type RGBA } from "@opentui/core"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { setLanguage } from "../../src/i18n"
import { DetailPanel, type DetailRow } from "../../src/panel/detail"
import { ListPanel, type ListItem } from "../../src/panel/list"
import { PanelShell } from "../../src/panel/shell"
import { SettingsPanel, type SettingRow, type SettingsTab } from "../../src/panel/settings"
import { DEFAULT_THEME } from "../../src/context/theme"
import { useBindings } from "../../src/keymap"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import { cellWidth } from "../../src/ui/width"
import { readFrame, readSpans } from "../fixture/frames"
import { waitFor } from "../routes/dag-mode-harness"
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
    expect(lines[bottom - 1]).toContain("↑↓ 选择")
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

/** Renders until the frame satisfies `ready`, no sleeping in between, and returns it. */
async function untilFrame(app: Awaited<ReturnType<typeof renderPanel>>, ready: (frame: string) => boolean) {
  let frame = ""
  for (let pass = 0; pass < 200; pass++) {
    await app.renderOnce()
    frame = app.captureCharFrame()
    if (ready(frame)) return frame
  }
  throw new Error(`the expected frame never came:\n${frame}`)
}

test("a description of several lines shows one row each under the selected item, empty lines left out", async () => {
  await using tmp = await shellState()
  const items: ListItem<string>[] = [
    { id: "one", value: "one", title: "条目一", description: "只有一行" },
    { id: "two", value: "two", title: "条目二", description: ["", "第一行", "", "第二行"] },
    { id: "three", value: "three", title: "条目三", description: [] },
    { id: "four", value: "four", title: "条目四", description: "" },
  ]
  const app = await renderPanel(
    () => <PanelSurface spec={{ render: () => <ListPanel title="多行" items={items} onSelect={() => {}} /> }} />,
    { width: 80, height: 24, state: tmp.path },
  )

  try {
    const first = await untilFrame(app, (frame) => frame.includes("只有一行"))
    expect(first).not.toContain("第一行")

    app.mockInput.pressArrow("down")
    const second = frameLines(await untilFrame(app, (frame) => frame.includes("第二行")))
    // Each line is one row, straight under the item, and the empty ones take no row.
    const row = second.findIndex((line) => line.includes("条目二"))
    expect(second[row + 1]).toContain("第一行")
    expect(second[row + 2]).toContain("第二行")
    expect(second[row + 3]).toContain("条目三")
    expect(second.join("\n")).not.toContain("只有一行")

    // An empty list of lines, and an empty string, are no description at all: the next item follows at once.
    app.mockInput.pressArrow("down")
    const third = frameLines(await untilFrame(app, (frame) => !frame.includes("第二行")))
    expect(third[third.findIndex((line) => line.includes("条目三")) + 1]).toContain("条目四")
  } finally {
    app.renderer.destroy()
  }
})

test("the lines of a description scroll into view with their item, at the bottom of a long list", async () => {
  await using tmp = await shellState()
  const items: ListItem<string>[] = Array.from({ length: 20 }, (_, index) => ({
    id: `item-${index}`,
    value: `item-${index}`,
    title: `条目 ${index + 1}`,
    description: index === 19 ? ["最后的第一行", "最后的第二行", "最后的第三行"] : undefined,
  }))
  const app = await renderPanel(
    () => <PanelSurface spec={{ render: () => <ListPanel title="长列表" items={items} onSelect={() => {}} /> }} />,
    { width: 80, height: 24, state: tmp.path },
  )

  try {
    await untilFrame(app, (frame) => frame.includes("条目 1"))
    app.mockInput.pressKey("END")
    // The last item is selected and all three lines under it are inside the capped area, not cut off below it.
    const frame = await untilFrame(app, (value) => value.includes("最后的第三行"))
    expect(frame).toContain("最后的第一行")
    expect(frame).toContain("最后的第二行")
    const lines = frameLines(frame)
    expect(lines.findIndex((line) => line.includes("最后的第三行"))).toBeGreaterThan(
      lines.findIndex((line) => line.includes("条目 20")),
    )
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

test("list panel reports the remaining items while filtering", async () => {
  await using tmp = await shellState()
  const seen: string[][] = []
  const items: ListItem<string>[] = [
    { id: "alpha", value: "alpha", title: "alpha" },
    { id: "beta", value: "beta", title: "beta" },
  ]
  const app = await renderPanel(
    () => (
      <PanelSurface
        spec={{
          render: () => (
            <ListPanel
              title="过滤"
              items={items}
              onSelect={() => {}}
              onFilter={(_value, filtered) => seen.push(filtered.map((item) => item.value))}
            />
          ),
        }}
      />
    ),
    { width: 120, height: 40, state: tmp.path },
  )

  try {
    app.mockInput.pressKey("a")
    app.mockInput.pressKey("l")
    await Bun.sleep(50)
    await app.renderOnce()
    expect(seen.at(-1)).toEqual(["alpha"])
  } finally {
    app.renderer.destroy()
  }
})

/** The row of the frame that holds `text`. */
const rowWith = (frame: string, text: string) => frameLines(frame).find((line) => line.includes(text))

test("the selection stays on its item when a group that follows data moves the items around", async () => {
  await using tmp = await shellState()
  const [together, setTogether] = createSignal(false)
  const selected: string[] = []
  // Nothing about the items changes: only the group of the second one, which is read where the list is laid out.
  const items: ListItem<string>[] = [
    { id: "a", value: "a", title: "条目甲", group: "一组" },
    {
      id: "b",
      value: "b",
      title: "条目乙",
      get group() {
        return together() ? "一组" : "二组"
      },
    },
    { id: "c", value: "c", title: "条目丙", group: "一组" },
  ]
  const app = await renderPanel(
    () => (
      <PanelSurface
        spec={{ render: () => <ListPanel title="分组" items={items} onSelect={(item) => selected.push(item.id)} /> }}
      />
    ),
    { width: 80, height: 24, state: tmp.path },
  )

  try {
    // The list reads a, c under the first group and b under the second: c is the second row.
    const apart = await untilFrame(app, (frame) => frame.includes("二组"))
    const order = ["条目甲", "条目丙", "条目乙"].map((text) => apart.indexOf(text))
    expect(order).toEqual([...order].sort((left, right) => left - right))
    app.mockInput.pressArrow("down")
    await untilFrame(app, (frame) => rowWith(frame, "条目丙")?.includes("›") === true)

    // b joins the first group: the rows are a, b, c now, and c is the third. The index the selection had is b's.
    setTogether(true)
    const frame = await untilFrame(app, (value) => !value.includes("二组"))
    expect(rowWith(frame, "条目丙")).toContain("›")
    expect(rowWith(frame, "条目乙")).not.toContain("›")
    app.mockInput.pressEnter()
    await waitFor(() => selected.length > 0)
    expect(selected).toEqual(["c"])
  } finally {
    app.renderer.destroy()
  }
})

test("an owner that gives a selection key keeps the selection on its item through changes of the items", async () => {
  await using tmp = await shellState()
  const selected: string[] = []
  const item = (id: string): ListItem<string> => ({ id, value: id, title: `条目${id}` })
  const [items, setItems] = createSignal([item("a"), item("b"), item("c")])
  const [key, setKey] = createSignal("")
  const app = await renderPanel(
    () => (
      <PanelSurface
        spec={{
          render: () => (
            <ListPanel
              title="保持选中"
              items={items()}
              selectionKey={key()}
              onSelect={(chosen) => selected.push(chosen.id)}
            />
          ),
        }}
      />
    ),
    { width: 80, height: 24, state: tmp.path },
  )
  // The row the pointer is on, in the frame, or none.
  const pointed = (frame: string) => ["a", "b", "c", "d"].filter((id) => rowWith(frame, `条目${id}`)?.includes("›"))
  const before = (frame: string, first: string, second: string) =>
    frame.indexOf(`条目${first}`) < frame.indexOf(`条目${second}`)

  try {
    await untilFrame(app, (frame) => pointed(frame).join() === "a")
    app.mockInput.pressArrow("down")
    await untilFrame(app, (frame) => pointed(frame).join() === "b")

    // The owner reorders to c, a, b. By place the pointer would be on a, and a start over would put it on c.
    setItems([item("c"), item("a"), item("b")])
    const reordered = await untilFrame(app, (frame) => before(frame, "c", "a") && before(frame, "a", "b"))
    expect(pointed(reordered)).toEqual(["b"])

    // The selected item is gone: the selection stays at the place it had, cut to the list, which is a's now.
    setItems([item("c"), item("a")])
    const gone = await untilFrame(app, (frame) => !frame.includes("条目b"))
    expect(pointed(gone)).toEqual(["a"])

    // The item that took the place is the selected one from here on: it moves to the end, and the pointer with it.
    setItems([item("c"), item("d"), item("a")])
    const moved = await untilFrame(app, (frame) => before(frame, "d", "a"))
    expect(pointed(moved)).toEqual(["a"])

    // A new key is a new question: the selection starts over at the first row, not on the row it was moved to.
    app.mockInput.pressArrow("up")
    await untilFrame(app, (frame) => pointed(frame).join() === "d")
    setKey("z")
    await untilFrame(app, (frame) => pointed(frame).join() === "c")
    app.mockInput.pressEnter()
    await waitFor(() => selected.length > 0)
    expect(selected).toEqual(["c"])
  } finally {
    app.renderer.destroy()
  }
})

test("without a selection key, a change of the items starts the selection over at the first row", async () => {
  await using tmp = await shellState()
  const item = (id: string): ListItem<string> => ({ id, value: id, title: `条目${id}` })
  const [items, setItems] = createSignal([item("a"), item("b"), item("c")])
  const app = await renderPanel(
    () => <PanelSurface spec={{ render: () => <ListPanel title="重置" items={items()} onSelect={() => {}} /> }} />,
    { width: 80, height: 24, state: tmp.path },
  )

  try {
    await untilFrame(app, (frame) => rowWith(frame, "条目a")?.includes("›") === true)
    app.mockInput.pressArrow("down")
    await untilFrame(app, (frame) => rowWith(frame, "条目b")?.includes("›") === true)

    // b is still the second row, but the items are not the ones the selection was made in: c is the first.
    setItems([item("c"), item("b"), item("a")])
    const frame = await untilFrame(app, (value) => value.indexOf("条目c") < value.indexOf("条目b"))
    expect(rowWith(frame, "条目c")).toContain("›")
    expect(rowWith(frame, "条目b")).not.toContain("›")
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

// ---- settings panel: how a value is presented -------------------------------------------------------------------

const modeOptions = [
  { value: "hidden", label: "默认隐藏" },
  { value: "auto", label: "宽屏时自动显示" },
  { value: "always", label: "始终显示" },
]
const askOptions = [
  { value: "ask", label: "询问" },
  { value: "allow", label: "允许" },
]

/** One row of each way a row can look: what follows the name, and whether the key changes it. */
function valueRows(log: string[] = []): readonly SettingRow[] {
  const changed = (id: string) => (value: unknown) => log.push(`${id}:${String(value)}`)
  return [
    {
      id: "drawer",
      label: "抽屉",
      kind: "choice",
      value: "auto",
      options: modeOptions,
      description: "隐藏时按快捷键打开，打开后覆盖在对话上方",
      onChange: changed("drawer"),
    },
    {
      id: "thinking",
      label: "推理过程",
      kind: "toggle",
      value: true,
      suffix: () => "本会话：开",
      description: "折叠时只显示思考用时",
      onChange: changed("thinking"),
    },
    { id: "stamps", label: "时间戳", kind: "toggle", value: false, onChange: changed("stamps") },
    {
      id: "single",
      label: "仅一个选项",
      kind: "choice",
      value: "only",
      options: [{ value: "only", label: "唯一" }],
      onChange: changed("single"),
    },
    {
      id: "custom",
      label: "权限",
      kind: "choice",
      value: "custom",
      valueLabel: "自定义规则",
      options: askOptions,
      onChange: changed("custom"),
    },
    { id: "file", label: "文件名", kind: "text", value: "transcript.md", onChange: changed("file") },
    { id: "clear", label: "清除缓存", kind: "action", valueLabel: "0 项", run: () => log.push("clear") },
    {
      id: "keys",
      label: "切换工作流模式",
      kind: "action",
      valueLabel: "ctrl+x d",
      readonly: true,
      description: "由快捷键表生成，只读",
      run: () => log.push("keys"),
    },
    {
      id: "locked",
      label: "全局写入",
      kind: "choice",
      value: "ask",
      disabled: true,
      options: askOptions,
      onChange: changed("locked"),
    },
    { id: "long", label: "一个相当长的设置名称超出了名称列", kind: "toggle", value: true, onChange: changed("long") },
  ]
}

function valuePanel(rows: readonly SettingRow[] = valueRows()) {
  return <SettingsPanel title="设置" command="/config" tabs={[{ id: "values", label: "取值", rows }]} />
}

type PanelApp = Awaited<ReturnType<typeof renderPanel>>

/** The line the selection mark is on. */
const selectedLine = (frame: string) => frameLines(frame).find((line) => line.includes("›"))

/** Moves the selection, one row per key and one frame per row, until the mark is on the row with `label`. */
async function selectRow(app: PanelApp, label: string, key: "down" | "up" = "down") {
  for (let step = 0; step < 40; step++) {
    const frame = await untilFrame(app, (value) => selectedLine(value) !== undefined)
    const current = selectedLine(frame)
    if (current?.includes(label)) return frame
    app.mockInput.pressArrow(key)
    await untilFrame(app, (value) => selectedLine(value) !== current)
  }
  throw new Error(`the selection never reached ${label}`)
}

/** The cell the text starts at on its line of the frame. */
function columnOf(line: string, needle: string, ambiguousWidth: 1 | 2 = 1) {
  return cellWidth(line.slice(0, line.indexOf(needle)), ambiguousWidth)
}

/** The border and the padding on its left, the selection mark, and the name column. */
const VALUE_COLUMN = 2 + 2 + 22

/** The first span holding `needle`, as the renderer painted it. */
async function spanOf(app: PanelApp, needle: string) {
  for (const line of (await readSpans(app)).lines) {
    for (const span of line.spans) if (span.text.includes(needle)) return span
  }
  throw new Error(`no span holds ${needle}:\n${await readFrame(app)}`)
}

/** Whether the first span holding `needle` is painted with the foreground `color`. */
async function paintedWith(app: PanelApp, needle: string, color: RGBA) {
  return (await spanOf(app, needle)).fg.equals(color)
}

/** Whether the first span holding `needle` is bold. */
async function isBold(app: PanelApp, needle: string) {
  return ((await spanOf(app, needle)).attributes & TextAttributes.BOLD) !== 0
}

test("settings panel draws the value right after the name column, at the same cell on every row", async () => {
  await using tmp = await shellState()
  const app = await renderPanel(() => <PanelSurface spec={{ render: () => valuePanel() }} />, {
    width: 120,
    height: 40,
    state: tmp.path,
  })

  try {
    const lines = frameLines(await untilFrame(app, (frame) => frame.includes("清除缓存")))
    const line = (label: string) => lines.find((candidate) => candidate.includes(label)) ?? ""
    // The selection mark is two cells, the name starts right after it, and a value starts where the name column ends.
    expect(columnOf(line("抽屉"), "抽屉")).toBe(4)
    for (const [label, value] of [
      ["抽屉", "宽屏时自动显示"],
      ["推理过程", "开"],
      ["时间戳", "关"],
      ["仅一个选项", "唯一"],
      ["权限", "自定义规则"],
      ["文件名", "transcript.md"],
      ["清除缓存", "0 项"],
      ["切换工作流模式", "ctrl+x d"],
      ["全局写入", "询问"],
    ] as const) {
      expect({ label, column: columnOf(line(label), value) }).toEqual({ label, column: VALUE_COLUMN })
    }

    // A name that is too long is cut inside its column, and still leaves a cell before the value.
    const long = line("一个相当长的设置名称")
    expect(long).toContain("…")
    expect(long).not.toContain("超出了名称列")
    expect(columnOf(long, "开")).toBe(VALUE_COLUMN)
    expect(long.slice(long.indexOf("…") + 1).startsWith(" ")).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("settings panel colors the value muted, the selected value with the brand color, and notes dim", async () => {
  await using tmp = await shellState()
  const theme = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")
  const app = await renderPanel(() => <PanelSurface spec={{ render: () => valuePanel() }} />, {
    width: 120,
    height: 40,
    state: tmp.path,
  })

  try {
    await selectRow(app, "抽屉")
    // The selected row: its mark and its value are the brand color, its name bold in the text color.
    expect(await paintedWith(app, "›", theme.primary)).toBe(true)
    expect(await paintedWith(app, "宽屏时自动显示", theme.primary)).toBe(true)
    expect(await paintedWith(app, "抽屉", theme.text)).toBe(true)
    expect(await isBold(app, "抽屉")).toBe(true)
    // The hint to change the value is dim, like a suffix, and the note under the rows is muted.
    expect(await paintedWith(app, "换一个", theme.textDim)).toBe(true)
    expect(await paintedWith(app, "隐藏时按快捷键打开", theme.textMuted)).toBe(true)
    // The rows that are not selected: the value is muted, the name is not bold, and a suffix is dim.
    expect(await paintedWith(app, "关", theme.textMuted)).toBe(true)
    expect(await paintedWith(app, "时间戳", theme.text)).toBe(true)
    expect(await isBold(app, "时间戳")).toBe(false)
    expect(await paintedWith(app, "本会话：开", theme.textDim)).toBe(true)

    // A row that cannot be written is dimmed, selected or not; a read-only row is not.
    expect(await paintedWith(app, "全局写入", theme.textMuted)).toBe(true)
    expect(await paintedWith(app, "询问", theme.textDim)).toBe(true)
    expect(await paintedWith(app, "ctrl+x d", theme.textMuted)).toBe(true)
    await selectRow(app, "切换工作流模式")
    expect(await paintedWith(app, "ctrl+x d", theme.primary)).toBe(true)
    await selectRow(app, "全局写入")
    expect(await paintedWith(app, "询问", theme.textDim)).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

for (const language of ["zh-CN", "en"] as const) {
  test(`the hint to change a value says where it stands among the values, ${language}`, async () => {
    setLanguage(language)
    const verb = language === "en" ? "Change" : "修改"
    const cycle = (key: string, index: number, total: number) =>
      language === "en" ? `${key} change (${index}/${total})` : `${key} 换一个（${index}/${total}）`
    await using tmp = await shellState()
    const app = await renderPanel(() => <PanelSurface spec={{ render: () => valuePanel() }} />, {
      width: 120,
      height: 40,
      state: tmp.path,
    })

    try {
      // The key is the one the hint row shows for the same action.
      const key = /(\S+) (?:Change|修改)/.exec(await untilFrame(app, (frame) => frame.includes(verb)))?.[1]
      expect(key).toBeTruthy()

      // A choice shows the place of its value among the options: the second of three.
      expect(rowWith(await selectRow(app, "抽屉"), "抽屉")).toContain(cycle(key!, 2, 3))
      // A toggle has two values, on then off.
      expect(rowWith(await selectRow(app, "推理过程"), "推理过程")).toContain(cycle(key!, 1, 2))
      const off = await selectRow(app, "时间戳")
      expect(rowWith(off, "时间戳")).toContain(cycle(key!, 2, 2))
      // Only the selected row has one: the rows above it say nothing, whatever their kind.
      expect(rowWith(off, "抽屉")).not.toContain(`${key!} `)
      expect(rowWith(off, "推理过程")).not.toContain(`${key!} `)

      // No hint where there is nothing to cycle: one option, a value that is none of the options, a text row, an
      // action, a read-only row, and a row that cannot be written.
      for (const label of ["仅一个选项", "权限", "文件名", "清除缓存", "切换工作流模式", "全局写入"]) {
        const frame = await selectRow(app, label)
        expect({ label, line: rowWith(frame, label)?.match(/\(\d\/\d\)|（\d\/\d）/) }).toEqual({ label, line: null })
      }

      // The last row is a toggle again.
      expect(rowWith(await selectRow(app, "一个相当长的设置名称"), "一个相当长的设置名称")).toContain(cycle(key!, 1, 2))
    } finally {
      app.renderer.destroy()
    }
  })
}

test("the hint to change a value is cut before the suffix, and the suffix before the value", async () => {
  await using tmp = await shellState()
  setLanguage("en")
  const rows = (value: string): readonly SettingRow[] => [
    {
      id: "mode",
      label: "Mode",
      kind: "choice",
      value: "a",
      valueLabel: value,
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
        { value: "c", label: "C" },
      ],
      suffix: () => "this session: on",
      onChange: () => {},
    },
  ]
  const look = async (width: number, value: string) => {
    const app = await renderPanel(() => <PanelSurface spec={{ render: () => valuePanel(rows(value)) }} />, {
      width,
      height: 24,
      state: tmp.path,
    })
    try {
      return rowWith(await untilFrame(app, (frame) => frame.includes("Mode")), "Mode")!
    } finally {
      app.renderer.destroy()
    }
  }

  // Room for all three, with the value, the suffix and the hint in that order.
  const wide = await look(100, "graphagent-light")
  expect(wide).toMatch(/graphagent-light {3}this session: on {3}\S+ change \(1\/3\)/)
  // 80 columns leave 48 for the three (the panel's frame is the 76 between the gutters), which need 52 with the 14 cells
  // of `⏎ change (1/3)`; the hint does not fit, and goes whole: no part of it is left. (At 84 columns it fits: the key is
  // the one cell of `⏎`, not the five of `enter`.)
  const mid = await look(80, "graphagent-light")
  expect(mid).toContain("graphagent-light   this session: on")
  expect(mid).not.toContain("change")
  // 64 columns leave 32: the suffix is cut with an ellipsis, the value is whole.
  const narrow = await look(64, "graphagent-light")
  expect(narrow).toMatch(/graphagent-light {3}this session…/)
  expect(narrow).not.toContain("this session:")
  expect(narrow).not.toContain("change")
  // A value too long for the line is cut last, and takes the whole width: nothing of the suffix is left.
  const longest = await look(64, "a value that is a good deal longer than the line can hold")
  expect(longest).toContain("a value that is a good deal")
  expect(longest).toContain("…")
  expect(longest).not.toContain("hold")
  expect(longest).not.toContain("session")
})

test("settings panel shows the note of the selected row on the line above the hints, outside the scroll area", async () => {
  await using tmp = await shellState()
  const rows = Array.from({ length: 20 }, (_, index): SettingRow => ({
    id: `row-${index}`,
    label: `设置 ${index + 1}`,
    kind: "toggle",
    value: false,
    // Only some rows explain themselves.
    description: index % 3 === 2 ? `第 ${index + 1} 行的说明` : undefined,
    onChange: () => {},
  }))
  const app = await renderPanel(() => <PanelSurface spec={{ render: () => valuePanel(rows) }} />, {
    width: 80,
    height: 24,
    state: tmp.path,
  })
  /** The line before the hint row, which is the one before the bottom border. */
  const noteOf = (frame: string) => {
    const lines = frameLines(frame)
    return { lines, note: lines[borderIndex(lines, "╰") - 2], hint: lines[borderIndex(lines, "╰") - 1] }
  }

  try {
    // The third row has a description; it is on the line above the hints, not under the row.
    const third = noteOf(await selectRow(app, "设置 3"))
    expect(third.note).toContain("第 3 行的说明")
    expect(third.hint).toContain("关闭")
    const row = third.lines.findIndex((line) => line.includes("设置 3"))
    expect(third.lines[row + 1]).toContain("设置 4")
    expect(third.lines.filter((line) => line.includes("第 3 行的说明"))).toHaveLength(1)

    // A row with no description leaves that line blank: the panel does not change height with the selection.
    const second = noteOf(await selectRow(app, "设置 2", "up"))
    expect(second.note?.replace(/[│ ]/g, "")).toBe("")
    expect(second.lines.length).toBe(third.lines.length)
    expect(borderIndex(second.lines, "╰")).toBe(borderIndex(third.lines, "╰"))

    // The scroll area is capped, and the note stays in view however far it has scrolled: the 18th row has one.
    app.mockInput.pressKey("END")
    const last = noteOf(await selectRow(app, "设置 20"))
    expect(last.lines.some((line) => line.includes("设置 1 "))).toBe(false)
    const eighteenth = noteOf(await selectRow(app, "设置 18", "up"))
    expect(eighteenth.note).toContain("第 18 行的说明")
    expect(eighteenth.hint).toContain("关闭")
  } finally {
    app.renderer.destroy()
  }
})

test("settings panel with no description on any row takes no line for a note", async () => {
  await using tmp = await shellState()
  const rows = Array.from({ length: 3 }, (_, index): SettingRow => ({
    id: `row-${index}`,
    label: `设置 ${index + 1}`,
    kind: "toggle",
    value: false,
    onChange: () => {},
  }))
  const app = await renderPanel(() => <PanelSurface spec={{ render: () => valuePanel(rows) }} />, {
    width: 80,
    height: 24,
    state: tmp.path,
  })

  try {
    const lines = frameLines(await untilFrame(app, (frame) => frame.includes("设置 3")))
    const top = borderIndex(lines, "╭")
    // The border, the header, three rows, the hints, the border: nothing between the rows and the hints.
    expect(borderIndex(lines, "╰") - top).toBe(6)
    expect(lines[borderIndex(lines, "╰") - 1]).toContain("关闭")
    expect(lines[borderIndex(lines, "╰") - 2]).toContain("设置 3")
  } finally {
    app.renderer.destroy()
  }
})

test("the note of the shell is one muted line cut to the width, and an empty note keeps the line", async () => {
  await using tmp = await shellState()
  const theme = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")
  const shell = (note: string | undefined) => (
    <PanelSurface
      spec={{
        render: () => (
          <PanelShell title="说明" hints={[]} note={note}>
            <text>内容一行</text>
          </PanelShell>
        ),
      }}
    />
  )
  const heightWith = async (note: string | undefined) => {
    const app = await renderPanel(() => shell(note), { width: 80, height: 24, state: tmp.path })
    try {
      const lines = frameLines(await untilFrame(app, (frame) => frame.includes("内容一行")))
      return borderIndex(lines, "╰") - borderIndex(lines, "╭")
    } finally {
      app.renderer.destroy()
    }
  }

  // No note takes no line; an empty one takes a blank line.
  expect(await heightWith("")).toBe((await heightWith(undefined)) + 1)

  const app = await renderPanel(() => shell("一段很长的说明".repeat(12)), { width: 80, height: 24, state: tmp.path })
  try {
    const lines = frameLines(await untilFrame(app, (frame) => frame.includes("一段很长的说明")))
    const note = lines[borderIndex(lines, "╰") - 2]
    // Indented two cells past the padding, cut to the width with an ellipsis, on the line above the hint row.
    expect(note.startsWith("│   一段很长的说明")).toBe(true)
    expect(note.slice(0, -1).trimEnd().endsWith("…")).toBe(true)
    expect(cellWidth(note.slice(1, -1).trimEnd())).toBeLessThanOrEqual(80 - 3)
    expect(lines[borderIndex(lines, "╰") - 1]).toContain("关闭")
    expect(await paintedWith(app, "一段很长的说明", theme.textMuted)).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

for (const language of ["zh-CN", "en"] as const) {
  for (const ambiguousWidth of [1, 2] as const) {
    test(`settings panel lays nothing out wider than 80 columns, ${language}, ambiguous_width ${ambiguousWidth}`, async () => {
      setLanguage(language)
      const tmp = await shellState({ ambiguous_width: ambiguousWidth })
      const long = "一个很长很长的值用来检查窄终端下的一行不会溢出到边框外面去，也不会换行 Long value that goes on"
      const rows: readonly SettingRow[] = [
        ...valueRows(),
        {
          id: "wide",
          label: "Setting with a name that is far too long for the column",
          kind: "choice",
          value: "x",
          valueLabel: long,
          options: [
            { value: "x", label: long },
            { value: "y", label: "y" },
          ],
          suffix: () => `${long} ◆ ◇ ● ○`,
          description: `${long}${long}`,
          onChange: () => {},
        },
      ]
      const app = await renderPanel(() => <PanelSurface spec={{ render: () => valuePanel(rows) }} />, {
        width: 80,
        height: 24,
        state: tmp.path,
      })

      try {
        let height: number | undefined
        for (const label of ["抽屉", "推理过程", "文件名", "切换工作流模式", "Setting with"]) {
          const lines = frameLines(await selectRow(app, label))
          const bordered = lines.filter((line) => line.startsWith("│") && line.endsWith("│"))
          expect(bordered.length).toBeGreaterThan(6)
          for (const line of bordered) {
            // Inside the border: the padding and what the panel itself laid out.
            expect({ line, fits: cellWidth(line.slice(1, -1).trimEnd(), ambiguousWidth) <= 80 - 3 }).toEqual({
              line,
              fits: true,
            })
          }
          // Nothing wrapped onto a second line: the panel keeps its height from row to row.
          height ??= borderIndex(lines, "╰") - borderIndex(lines, "╭")
          expect(borderIndex(lines, "╰") - borderIndex(lines, "╭")).toBe(height)
        }
      } finally {
        app.renderer.destroy()
        await tmp[Symbol.asyncDispose]()
      }
    })
  }
}

test("a read-only row can be selected to read its note, and key and click do nothing on it", async () => {
  await using tmp = await shellState()
  const log: string[] = []
  const frozen = (id: string) => () => log.push(id)
  const rows: SettingRow[] = [
    {
      id: "choice",
      label: "只读选择",
      kind: "choice",
      value: "ask",
      options: askOptions,
      readonly: true,
      description: "选择行的说明",
      onChange: frozen("choice"),
    },
    { id: "toggle", label: "只读开关", kind: "toggle", value: true, readonly: true, onChange: frozen("toggle") },
    { id: "text", label: "只读文字", kind: "text", value: "abc", readonly: true, onChange: frozen("text") },
    { id: "action", label: "只读动作", kind: "action", valueLabel: "值", readonly: true, run: frozen("action") },
    { id: "plain", label: "普通开关", kind: "toggle", value: false, onChange: frozen("plain") },
  ]
  const app = await renderPanel(() => <PanelSurface spec={{ render: () => valuePanel(rows) }} />, {
    width: 120,
    height: 40,
    state: tmp.path,
  })

  try {
    for (const label of ["只读选择", "只读开关", "只读文字", "只读动作"]) {
      const frame = await selectRow(app, label)
      // The hints offer no change, confirmation, edit or submit for it, and the row has no hint to cycle.
      const hints = frameLines(frame)[borderIndex(frameLines(frame), "╰") - 1]
      expect(hints).toContain("关闭")
      for (const verb of ["修改", "确认", "编辑", "提交"]) expect(hints).not.toContain(verb)
      expect(rowWith(frame, label)).not.toContain("换一个")

      app.mockInput.pressEnter()
      await Bun.sleep(20)
      // Return opened no input either.
      expect(await untilFrame(app, (value) => value.includes(label))).not.toContain("提交")
      expect(log).toEqual([])

      const lines = frameLines(await untilFrame(app, (value) => value.includes(label)))
      const row = lines.findIndex((line) => line.includes(label))
      await app.mockMouse.click(columnOf(lines[row], label) + 1, row)
      expect(await untilFrame(app, (value) => value.includes(label))).not.toContain("提交")
      expect(log).toEqual([])
    }

    // The note of a read-only row is there to read, and it keeps the colors of a normal row.
    const theme = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")
    expect(await selectRow(app, "只读选择")).toContain("选择行的说明")
    expect(await paintedWith(app, "询问", theme.primary)).toBe(true)

    // The row below it is an ordinary one: the same key and click do act on it.
    const frame = await selectRow(app, "普通开关")
    expect(frameLines(frame)[borderIndex(frameLines(frame), "╰") - 1]).toContain("修改")
    app.mockInput.pressEnter()
    await Bun.sleep(20)
    expect(log).toEqual(["plain"])
  } finally {
    app.renderer.destroy()
  }
})

test("a row that cannot be written is dimmed, offers no change, and key and click do nothing on it", async () => {
  await using tmp = await shellState()
  const log: string[] = []
  const rows: SettingRow[] = [
    {
      id: "locked",
      label: "全局写入",
      kind: "choice",
      value: "ask",
      disabled: true,
      options: askOptions,
      onChange: (value) => log.push(value),
    },
  ]
  const app = await renderPanel(() => <PanelSurface spec={{ render: () => valuePanel(rows) }} />, {
    width: 120,
    height: 40,
    state: tmp.path,
  })

  try {
    const frame = await untilFrame(app, (value) => value.includes("全局写入"))
    expect(rowWith(frame, "全局写入")).not.toContain("换一个")
    expect(frameLines(frame)[borderIndex(frameLines(frame), "╰") - 1]).not.toContain("修改")
    app.mockInput.pressEnter()
    await Bun.sleep(20)
    const lines = frameLines(await untilFrame(app, (value) => value.includes("全局写入")))
    const row = lines.findIndex((line) => line.includes("全局写入"))
    await app.mockMouse.click(columnOf(lines[row], "全局写入") + 1, row)
    await untilFrame(app, (value) => value.includes("全局写入"))
    expect(log).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

for (const language of ["zh-CN", "en"] as const) {
  test(`settings panel values at 80x24 and 120x40, ${language}`, async () => {
    setLanguage(language)
    await using tmp = await shellState()
    for (const [width, height] of [
      [80, 24],
      [120, 40],
    ] as const) {
      const app = await renderPanel(() => <PanelSurface spec={{ render: () => valuePanel() }} />, {
        width,
        height,
        state: tmp.path,
      })
      try {
        // The first row is selected: the hint to change it and its note show.
        const frame = await untilFrame(app, (value) => value.includes("清除缓存"))
        expect(frame).toMatchSnapshot()
      } finally {
        app.renderer.destroy()
      }
    }
  })
}

test("detail panel answers space on a row with a toggle label, and says so while that row is selected", async () => {
  await using tmp = await shellState()
  const toggles: string[] = []
  const rows: DetailRow<string>[] = [
    { id: "slot", cells: ["分组"], value: "slot", toggleLabel: "展开子节点" },
    { id: "plain", cells: ["普通"], value: "plain" },
  ]
  const app = await renderPanel(
    () => (
      <PanelSurface
        spec={{
          render: () => <DetailPanel title="折叠" rows={rows} onToggle={(row) => toggles.push(row.id)} hints={[]} />,
        }}
      />
    ),
    { width: 120, height: 40, state: tmp.path },
  )

  try {
    expect(app.captureCharFrame()).toContain("空格 展开子节点")
    app.mockInput.pressKey(" ")
    await Bun.sleep(50)
    expect(toggles).toEqual(["slot"])

    app.mockInput.pressArrow("down")
    await Bun.sleep(50)
    await app.renderOnce()
    // A row with neither a check lead nor a label leaves the key alone, and has no hint for it.
    expect(app.captureCharFrame()).not.toMatch(/空格|space/)
    app.mockInput.pressKey(" ")
    await Bun.sleep(50)
    expect(toggles).toEqual(["slot"])
  } finally {
    app.renderer.destroy()
  }
})

test("detail panel leaves space alone without onToggle, label or not", async () => {
  await using tmp = await shellState()
  const rows: DetailRow<string>[] = [{ id: "slot", cells: ["分组"], value: "slot", toggleLabel: "展开子节点" }]
  const app = await renderPanel(
    () => <PanelSurface spec={{ render: () => <DetailPanel title="折叠" rows={rows} hints={[]} /> }} />,
    { width: 120, height: 40, state: tmp.path },
  )

  try {
    // No handler to call: nothing to offer either.
    expect(app.captureCharFrame()).not.toMatch(/空格|space/)
    app.mockInput.pressKey(" ")
    await Bun.sleep(30)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("分组")
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

function tabbedDetailPanel() {
  return (
    <DetailPanel
      title="会话详情"
      command="/status"
      tabs={[
        { id: "overview", label: "概览" },
        { id: "history", label: "历史" },
      ]}
      activeTab="overview"
      onTab={() => {}}
      summary={<text>进度 2/5</text>}
      rows={detailRows}
      onActivate={() => {}}
      hints={[]}
    />
  )
}

/** The hint row of the panel: the text on the line above the bottom border, between the border and the padding. */
function hintRowOf(frame: string) {
  const lines = frameLines(frame)
  return lines[borderIndex(lines, "╰") - 1].slice(1, -1).trim()
}

/**
 * What the hint row of each template says: the two arrow keys of the rows are one entry whatever the language, the two
 * of the tabs are one entry on the settings and detail panels, and the list has the one key of its tab hint. The first
 * row of each is selected, so the settings panel offers to change it.
 */
const HINT_ROWS = {
  "zh-CN": {
    settings: "↑↓ 选择 · ←→ 切换标签 · ⏎ 修改 · esc 关闭",
    detail: "↑↓ 选择 · ←→ 切换标签 · ⏎ 确认 · esc 关闭",
    list: "↑↓ 选择 · ⇥ 切换标签 · ⏎ 确认 · esc 关闭",
  },
  en: {
    settings: "↑↓ Select · ←→ Switch tab · ⏎ Change · esc Close",
    detail: "↑↓ Select · ←→ Switch tab · ⏎ Confirm · esc Close",
    list: "↑↓ Select · ⇥ Switch tab · ⏎ Confirm · esc Close",
  },
} as const

const HINT_TEMPLATES = {
  settings: () => settingsPanel(),
  detail: () => tabbedDetailPanel(),
  list: () => listPanel(),
} as const

for (const language of ["zh-CN", "en"] as const) {
  for (const template of ["settings", "detail", "list"] as const) {
    test(`the hint row of the ${template} panel pairs the arrow keys, ${language}`, async () => {
      setLanguage(language)
      await using tmp = await shellState()
      const app = await renderPanel(() => <PanelSurface spec={{ render: HINT_TEMPLATES[template] }} />, {
        width: 80,
        height: 24,
        state: tmp.path,
      })

      try {
        const frame = await untilFrame(app, (value) => value.includes("╰"))
        expect(hintRowOf(frame)).toBe(HINT_ROWS[language][template])
        expect(frame).toMatchSnapshot()
      } finally {
        app.renderer.destroy()
      }
    })

    for (const ambiguousWidth of [1, 2] as const) {
      test(`the hint row of the ${template} panel fits 80 columns whole, ${language}, ambiguous_width ${ambiguousWidth}`, async () => {
        setLanguage(language)
        await using tmp = await shellState({ ambiguous_width: ambiguousWidth })
        const app = await renderPanel(() => <PanelSurface spec={{ render: HINT_TEMPLATES[template] }} />, {
          width: 80,
          height: 24,
          state: tmp.path,
        })

        try {
          const row = hintRowOf(await untilFrame(app, (value) => value.includes("╰")))
          // Whole: nothing cut off with an ellipsis, so the way out is still there at its end.
          expect(row).not.toContain("…")
          expect(row).toEndWith(language === "en" ? "Close" : "关闭")
          expect(cellWidth(row, ambiguousWidth)).toBeLessThanOrEqual(80 - 4)
        } finally {
          app.renderer.destroy()
        }
      })
    }
  }
}

/** A second key for the command of the next row, as a user's binding would be. */
function ExtraNextKey() {
  useBindings(() => ({ commands: [], bindings: [{ key: "ctrl+n", cmd: "panel.next" }] }))
  return null
}

test("a next-row command with a key besides down leaves the arrow keys as two entries on the settings panel", async () => {
  await using tmp = await shellState()
  const app = await renderPanel(
    () => (
      <PanelSurface
        spec={{
          render: () => (
            <>
              <ExtraNextKey />
              {settingsPanel()}
            </>
          ),
        }}
      />
    ),
    { width: 120, height: 40, state: tmp.path },
  )

  try {
    const row = hintRowOf(await untilFrame(app, (value) => value.includes("╰")))
    expect(row).toBe("↑ 选择 · ⌃N, ↓ 选择 · ←→ 切换标签 · ⏎ 修改 · esc 关闭")
  } finally {
    app.renderer.destroy()
  }
})
