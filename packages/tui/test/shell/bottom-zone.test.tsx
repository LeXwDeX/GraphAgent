// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { BoxRenderable, InputRenderable, RGBA, Renderable } from "@opentui/core"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { setLanguage } from "../../src/i18n"
import { AppFrame } from "../../src/shell/app-frame"
import { BottomZone, createBottomZoneState, type BottomZoneStateApi } from "../../src/shell/bottom-zone"
import { renderPanel } from "../panel/contexts"
import { shellState } from "../shell/contexts"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

function Composer(props: { onRef?: (input: InputRenderable) => void }) {
  return (
    <box height={1} flexShrink={0}>
      <input
        ref={(value: InputRenderable) => {
          props.onRef?.(value)
        }}
        placeholder="composer"
      />
    </box>
  )
}

function collect(root: Renderable, result: Renderable[] = []) {
  result.push(root)
  for (const child of root.getChildren()) collect(child, result)
  return result
}

async function typeInto(app: Awaited<ReturnType<typeof renderPanel>>, input: InputRenderable, text: string) {
  input.focus()
  for (const key of text) app.mockInput.pressKey(key)
  await Bun.sleep(20)
  await app.renderOnce()
}

test("ask wins over the panel and restores the suspended stack when answered", async () => {
  await using tmp = await shellState()
  let state!: BottomZoneStateApi
  let input: InputRenderable | undefined

  function Harness() {
    state = createBottomZoneState()
    return <BottomZone state={state} composer={<Composer onRef={(value) => (input = value)} />} />
  }

  const app = await renderPanel(() => <Harness />, { width: 100, height: 30, state: tmp.path })
  try {
    expect(input).toBeDefined()
    expect(state.state().kind).toBe("composer")
    expect(state.dimmed()).toBe(false)

    state.host.push({ id: "panel", render: () => <text>面板内容</text> })
    await Bun.sleep(20)
    await app.renderOnce()
    expect(state.state().kind).toBe("panel")
    expect(state.dimmed()).toBe(true)
    expect(state.composerVisible()).toBe(false)
    expect(app.captureCharFrame()).toContain("面板内容")

    state.ask({ id: "ask-1", render: () => <text>询问内容</text> })
    await Bun.sleep(20)
    await app.renderOnce()
    expect(state.state()).toMatchObject({ kind: "ask", suspended: [{ id: "panel" }] })
    expect(app.captureCharFrame()).toContain("询问内容")
    expect(app.captureCharFrame()).not.toContain("面板内容")
    expect(state.host.depth()).toBe(1)

    state.resolveAsk()
    await Bun.sleep(20)
    await app.renderOnce()
    expect(state.state().kind).toBe("panel")
    expect(state.host.depth()).toBe(1)
    expect(app.captureCharFrame()).toContain("面板内容")
    expect(app.captureCharFrame()).not.toContain("询问内容")
  } finally {
    app.renderer.destroy()
  }
})

test("panels keep the composer draft and restore input focus after escape", async () => {
  await using tmp = await shellState()
  let state!: BottomZoneStateApi
  let input: InputRenderable | undefined

  function Harness() {
    state = createBottomZoneState()
    return <BottomZone state={state} composer={<Composer onRef={(value) => (input = value)} />} />
  }

  const app = await renderPanel(() => <Harness />, { width: 100, height: 30, state: tmp.path })
  try {
    await typeInto(app, input!, "draft")
    expect(input!.value).toBe("draft")
    expect(app.captureCharFrame()).toContain("draft")
    expect(app.renderer.currentFocusedRenderable).toBe(input!)

    state.host.push({ id: "panel", render: () => <text>面板内容</text> })
    await Bun.sleep(20)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("面板内容")
    expect(app.captureCharFrame()).not.toContain("draft")
    expect(input!.value).toBe("draft")
    expect(app.renderer.currentFocusedRenderable).not.toBe(input)

    app.mockInput.pressEscape()
    await Bun.sleep(20)
    await app.renderOnce()
    expect(state.state().kind).toBe("composer")
    expect(app.captureCharFrame()).not.toContain("面板内容")
    expect(app.captureCharFrame()).toContain("draft")
    expect(input!.value).toBe("draft")
    expect(app.renderer.currentFocusedRenderable).toBe(input!)
  } finally {
    app.renderer.destroy()
  }
})

test("the aside sits above the composer without taking focus or dimming", async () => {
  await using tmp = await shellState()
  let state!: BottomZoneStateApi
  let input: InputRenderable | undefined
  const closed: string[] = []

  function Harness() {
    state = createBottomZoneState()
    return <BottomZone state={state} composer={<Composer onRef={(value) => (input = value)} />} />
  }

  const app = await renderPanel(() => <Harness />, { width: 100, height: 30, state: tmp.path })
  try {
    await typeInto(app, input!, "note")

    state.openAside({ id: "aside", render: () => <text>旁注内容</text>, onClose: () => closed.push("aside") })
    await Bun.sleep(20)
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const lines = frame.split("\n")
    expect(frame).toContain("旁注内容")
    expect(frame).toContain("note")
    expect(lines.findIndex((line) => line.includes("旁注内容"))).toBeLessThan(
      lines.findIndex((line) => line.includes("note")),
    )
    expect(state.dimmed()).toBe(false)
    expect(state.composerVisible()).toBe(true)
    expect(app.renderer.currentFocusedRenderable).toBe(input!)

    app.mockInput.pressEscape()
    await Bun.sleep(20)
    await app.renderOnce()
    expect(closed).toEqual(["aside"])
    expect(app.captureCharFrame()).not.toContain("旁注内容")
    expect(state.state().kind).toBe("composer")
    expect(state.host.depth()).toBe(0)
    expect(app.renderer.currentFocusedRenderable).toBe(input!)
  } finally {
    app.renderer.destroy()
  }
})

test("an ask suspends the aside and the aside returns after the answer", async () => {
  await using tmp = await shellState()
  let state!: BottomZoneStateApi
  let input: InputRenderable | undefined

  function Harness() {
    state = createBottomZoneState({ aside: { render: () => <text>旁注内容</text> } })
    return <BottomZone state={state} composer={<Composer onRef={(value) => (input = value)} />} />
  }

  const app = await renderPanel(() => <Harness />, { width: 100, height: 30, state: tmp.path })
  try {
    await app.renderOnce()
    expect(input).toBeDefined()
    expect(app.captureCharFrame()).toContain("旁注内容")
    expect(state.dimmed()).toBe(false)

    state.ask({ id: "ask-1", render: () => <text>询问内容</text> })
    await Bun.sleep(20)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("询问内容")
    expect(app.captureCharFrame()).not.toContain("旁注内容")
    expect(state.dimmed()).toBe(true)

    state.resolveAsk()
    await Bun.sleep(20)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("旁注内容")
    expect(app.captureCharFrame()).not.toContain("询问内容")
    expect(state.dimmed()).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("the frame dims the main area only while a panel or ask surface is open", async () => {
  await using tmp = await shellState()
  let state!: BottomZoneStateApi
  let input: InputRenderable | undefined
  const overlay = RGBA.fromInts(0, 0, 0, 120)

  function Harness() {
    state = createBottomZoneState()
    return (
      <AppFrame
        dimmed={state.dimmed}
        bottomZone={<BottomZone state={state} composer={<Composer onRef={(value) => (input = value)} />} />}
      >
        <text>主区内容</text>
      </AppFrame>
    )
  }

  const app = await renderPanel(() => <Harness />, { width: 100, height: 30, state: tmp.path })
  try {
    await app.renderOnce()
    expect(input).toBeDefined()
    const overlays = () =>
      collect(app.renderer.root).filter(
        (item): item is BoxRenderable => item instanceof BoxRenderable && item.backgroundColor.equals(overlay),
      )
    expect(app.captureCharFrame()).toContain("主区内容")
    expect(overlays()).toHaveLength(0)

    state.host.push({ id: "panel", render: () => <text>面板内容</text> })
    await Bun.sleep(20)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("面板内容")
    expect(overlays().length).toBe(1)

    state.host.pop()
    await Bun.sleep(20)
    await app.renderOnce()
    expect(overlays()).toHaveLength(0)
  } finally {
    app.renderer.destroy()
  }
})
