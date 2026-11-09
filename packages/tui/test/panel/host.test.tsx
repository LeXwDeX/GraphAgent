// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { setLanguage } from "../../src/i18n"
import {
  MAX_PANEL_DEPTH,
  PanelHost,
  PanelHostProvider,
  createPanelHost,
  type PanelHostApi,
  type PanelSpec,
} from "../../src/panel/host"
import { renderPanel } from "./contexts"
import { shellState } from "../shell/contexts"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

test("the panel host caps the stack at three entries", () => {
  const host = createPanelHost()
  expect(host.push({ render: () => <text>one</text> })).toBe(true)
  expect(host.push({ render: () => <text>two</text> })).toBe(true)
  expect(host.push({ render: () => <text>three</text> })).toBe(true)
  expect(host.push({ render: () => <text>four</text> })).toBe(false)
  expect(host.depth()).toBe(MAX_PANEL_DEPTH)
  expect(host.top()?.render).toBeDefined()

  const popped = host.pop()
  expect(popped).toBeDefined()
  expect(host.depth()).toBe(2)
  host.clear()
  expect(host.depth()).toBe(0)
  expect(host.pop()).toBeUndefined()
})

test("escape closes one panel and restores the previous one", async () => {
  await using tmp = await shellState()
  const closed: string[] = []
  let host!: PanelHostApi
  const specs: PanelSpec[] = [
    { id: "root", render: () => <text>根面板</text>, onClose: () => closed.push("root") },
    { id: "child", render: () => <text>子面板</text>, onClose: () => closed.push("child") },
  ]

  function Harness() {
    host = createPanelHost()
    specs.forEach((spec) => host.push(spec))
    return (
      <PanelHostProvider host={host}>
        <PanelHost host={host} />
      </PanelHostProvider>
    )
  }

  const app = await renderPanel(() => <Harness />, { width: 100, height: 30, state: tmp.path })
  try {
    expect(app.captureCharFrame()).toContain("子面板")
    expect(app.captureCharFrame()).not.toContain("根面板")

    app.mockInput.pressEscape()
    await Bun.sleep(20)
    await app.renderOnce()

    expect(closed).toEqual(["child"])
    expect(host.depth()).toBe(1)
    expect(app.captureCharFrame()).toContain("根面板")
  } finally {
    app.renderer.destroy()
  }
})

test("ctrl+c closes every panel in last-in-first-out order", async () => {
  await using tmp = await shellState()
  const closed: string[] = []
  let host!: PanelHostApi

  function Harness() {
    host = createPanelHost()
    for (const id of ["a", "b", "c"]) {
      host.push({ id, render: () => <text>{id} 面板</text>, onClose: () => closed.push(id) })
    }
    return (
      <PanelHostProvider host={host}>
        <PanelHost host={host} />
      </PanelHostProvider>
    )
  }

  const app = await renderPanel(() => <Harness />, { width: 100, height: 30, state: tmp.path })
  try {
    app.mockInput.pressKey("c", { ctrl: true })
    await Bun.sleep(20)
    await app.renderOnce()

    expect(closed).toEqual(["c", "b", "a"])
    expect(host.depth()).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})
