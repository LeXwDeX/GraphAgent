// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer, type MockInput } from "@opentui/core/testing"
import { createBindingLookup } from "@opentui/keymap/extras"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { TuiKeybind } from "../src/config/keybind"
import { registerGraphagentKeymap } from "../src/keymap"

const TEXT = "alpha beta\ngamma delta"
const CURSOR = 3

type Key = Parameters<MockInput["pressKey"]>[0]
type Modifiers = Parameters<MockInput["pressKey"]>[1]

const open: Array<{ destroy(): void }> = []

afterEach(() => {
  for (const renderer of open.splice(0)) renderer.destroy()
})

/** A focused composer-like textarea under the real keymap, with the cursor after "alp". */
async function composer(overrides: TuiKeybind.KeybindOverrides = {}, kittyKeyboard = true) {
  const setup = await createTestRenderer({ width: 60, height: 12, kittyKeyboard })
  open.push(setup.renderer)
  const keymap = createDefaultOpenTuiKeymap(setup.renderer)
  const keybinds = createBindingLookup(TuiKeybind.toBindingConfig(TuiKeybind.parse(overrides)), {
    commandMap: TuiKeybind.CommandMap,
    bindingDefaults: TuiKeybind.bindingDefaults(),
  })
  registerGraphagentKeymap(keymap, setup.renderer, { keybinds, leader_timeout: 2000 })

  let submits = 0
  const area = new TextareaRenderable(setup.renderer, { width: 40, height: 6, initialValue: TEXT })
  area.onSubmit = () => {
    submits++
  }
  setup.renderer.root.add(area)
  area.focus()
  await setup.renderOnce()

  // Keys are dispatched synchronously; one frame lets the cursor and selection catch up.
  const settle = () => setup.renderOnce()
  const reset = () => {
    area.setText(TEXT)
    area.cursorOffset = CURSOR
  }
  reset()
  return {
    area,
    reset,
    submits: () => submits,
    async press(key: Key, modifiers?: Modifiers) {
      setup.mockInput.pressKey(key, modifiers)
      await settle()
    },
    async raw(sequence: string) {
      setup.renderer.stdin.emit("data", Buffer.from(sequence))
      await settle()
    },
  }
}

describe("input layer", () => {
  test("acts on the keys the definitions list", async () => {
    const c = await composer()
    const cases: Array<{ key: Key; modifiers?: Modifiers; cursor: number; text?: string }> = [
      { key: "ARROW_LEFT", cursor: 2 },
      { key: "ARROW_RIGHT", cursor: 4 },
      { key: "a", modifiers: { ctrl: true }, cursor: 0 },
      { key: "e", modifiers: { ctrl: true }, cursor: 10 },
      { key: "HOME", cursor: 0 },
      { key: "END", cursor: TEXT.length },
      { key: "DELETE", cursor: 3, text: "alpa beta\ngamma delta" },
      { key: "BACKSPACE", cursor: 2, text: "alha beta\ngamma delta" },
      { key: "k", modifiers: { ctrl: true }, cursor: 3, text: "alp\ngamma delta" },
      { key: "u", modifiers: { ctrl: true }, cursor: 0, text: "ha beta\ngamma delta" },
      { key: "w", modifiers: { ctrl: true }, cursor: 0, text: "ha beta\ngamma delta" },
      { key: "d", modifiers: { meta: true }, cursor: 3, text: "alpbeta\ngamma delta" },
    ]
    for (const { key, modifiers, cursor, text = TEXT } of cases) {
      c.reset()
      await c.press(key, modifiers)
      const label = `${key} ${JSON.stringify(modifiers ?? {})}`
      expect({ label, text: c.area.plainText, cursor: c.area.cursorOffset }).toEqual({ label, text, cursor })
    }
  })

  test("submits on Enter and inserts a newline on shift+Enter and alt+Enter", async () => {
    const c = await composer()
    await c.press("RETURN")
    expect(c.submits()).toBe(1)
    expect(c.area.plainText).toBe(TEXT)
    await c.press("RETURN", { shift: true })
    expect(c.area.plainText).toBe("alp\nha beta\ngamma delta")
    await c.press("RETURN", { meta: true })
    expect(c.area.plainText).toBe("alp\n\nha beta\ngamma delta")
    expect(c.submits()).toBe(1)
  })

  test("ignores the emacs keys the key plan removed", async () => {
    const c = await composer()
    for (const key of ["b", "f", "d"]) {
      await c.press(key, { ctrl: true })
      expect({ key, text: c.area.plainText, cursor: c.area.cursorOffset }).toEqual({
        key,
        text: TEXT,
        cursor: CURSOR,
      })
    }
  })

  test("applies user overrides in place of the defaults", async () => {
    const c = await composer({ input_move_left: "ctrl+b", input_delete: "ctrl+d", input_move_right: "none" })
    await c.press("b", { ctrl: true })
    expect(c.area.cursorOffset).toBe(2)
    // The default `left` is replaced by the override, not kept next to it.
    await c.press("ARROW_LEFT")
    expect(c.area.cursorOffset).toBe(2)
    await c.press("ARROW_RIGHT")
    expect(c.area.cursorOffset).toBe(2)
    await c.press("d", { ctrl: true })
    expect(c.area.plainText).toBe("alha beta\ngamma delta")
    // `delete` was not part of the override and no longer deletes.
    await c.press("DELETE")
    expect(c.area.plainText).toBe("alha beta\ngamma delta")
  })

  test("keeps the Cmd+arrow keys that no definition lists", async () => {
    const c = await composer()
    await c.press("ARROW_LEFT", { super: true })
    expect(c.area.cursorOffset).toBe(0)
    await c.press("ARROW_DOWN", { super: true })
    expect(c.area.cursorOffset).toBe(TEXT.length)
    await c.press("ARROW_UP", { super: true })
    expect(c.area.cursorOffset).toBe(0)
    await c.press("ARROW_RIGHT", { super: true })
    expect(c.area.cursorOffset).toBe(10)

    c.area.cursorOffset = CURSOR
    await c.press("ARROW_RIGHT", { super: true, shift: true })
    expect(c.area.getSelectedText()).toBe("ha beta")
  })

  test("keeps keypad Enter as a newline", async () => {
    const c = await composer()
    await c.raw("\u001b[57414u")
    expect(c.area.plainText).toBe("alp\nha beta\ngamma delta")
    expect(c.submits()).toBe(0)
  })

  test("keeps linefeed, which legacy terminals send for ctrl+j, as a newline", async () => {
    const c = await composer({}, false)
    await c.press("j", { ctrl: true })
    expect(c.area.plainText).toBe("alp\nha beta\ngamma delta")
    await c.press("LINEFEED")
    expect(c.area.plainText).toBe("alp\n\nha beta\ngamma delta")
  })
})
