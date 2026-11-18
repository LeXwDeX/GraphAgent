// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createBindingLookup } from "@opentui/keymap/extras"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { TuiKeybind } from "../src/config/keybind"
import { registerGraphagentKeymap } from "../src/keymap"

/**
 * The key that follows the leader key belongs to the chord. A chord whose command is not available (the command is
 * disabled, or the layer holding it is) used to end without being consumed, so the keymap handed its key to the
 * focused prompt and it was typed as text. Every chord is consumed now; typing outside a chord is untouched.
 */

const open: Array<{ destroy(): void }> = []

afterEach(() => {
  for (const renderer of open.splice(0)) renderer.destroy()
})

/**
 * A focused, empty composer-like textarea under the real keymap, with four leader chords of the kind the routes
 * register: `<leader>e` runs, `<leader>d` belongs to a command that is disabled until `state.commandOn` is set,
 * `<leader>l` to a layer that is disabled until `state.layerOn` is set, and `<leader>x` to a command that is off
 * for good.
 */
async function composer(kittyKeyboard: boolean) {
  const setup = await createTestRenderer({ width: 60, height: 12, kittyKeyboard })
  open.push(setup.renderer)
  const keymap = createDefaultOpenTuiKeymap(setup.renderer)
  const keybinds = createBindingLookup(TuiKeybind.toBindingConfig(TuiKeybind.parse({})), {
    commandMap: TuiKeybind.CommandMap,
    bindingDefaults: TuiKeybind.bindingDefaults(),
  })
  registerGraphagentKeymap(keymap, setup.renderer, { keybinds, leader_timeout: 2000 })

  const state = { commandOn: false, layerOn: false }
  const ran: string[] = []
  keymap.registerLayer({
    commands: [
      {
        name: "test.leader.ready",
        run: () => {
          ran.push("ready")
        },
      },
      {
        name: "test.leader.command",
        enabled: () => state.commandOn,
        run: () => {
          ran.push("command")
        },
      },
      {
        name: "test.leader.off",
        enabled: false,
        run: () => {
          ran.push("off")
        },
      },
    ],
    bindings: [
      { key: "<leader>e", cmd: "test.leader.ready" },
      { key: "<leader>d", cmd: "test.leader.command" },
      { key: "<leader>x", cmd: "test.leader.off" },
    ],
  })
  keymap.registerLayer({
    enabled: () => state.layerOn,
    commands: [
      {
        name: "test.leader.layer",
        run: () => {
          ran.push("layer")
        },
      },
    ],
    bindings: [{ key: "<leader>l", cmd: "test.leader.layer" }],
  })

  const area = new TextareaRenderable(setup.renderer, { width: 40, height: 6, initialValue: "" })
  setup.renderer.root.add(area)
  area.focus()
  await setup.renderOnce()

  return {
    area,
    keymap,
    ran,
    state,
    /** Presses the leader key and then `key`, one frame after each. */
    async chord(key: string) {
      setup.mockInput.pressKey("x", { ctrl: true })
      await setup.renderOnce()
      setup.mockInput.pressKey(key)
      await setup.renderOnce()
    },
    async type(text: string) {
      for (const key of text) setup.mockInput.pressKey(key)
      await setup.renderOnce()
    },
  }
}

for (const kittyKeyboard of [true, false]) {
  describe(`leader chords (kitty keyboard ${kittyKeyboard ? "on" : "off"})`, () => {
    test("a chord whose command is available runs it and types nothing", async () => {
      const c = await composer(kittyKeyboard)
      await c.chord("e")
      expect(c.ran).toEqual(["ready"])
      expect(c.area.plainText).toBe("")
      expect(c.keymap.hasPendingSequence()).toBe(false)
    })

    test("a chord whose command is disabled is consumed: it neither runs nor types", async () => {
      const c = await composer(kittyKeyboard)
      await c.chord("d")
      expect(c.ran).toEqual([])
      expect(c.area.plainText).toBe("")
      expect(c.keymap.hasPendingSequence()).toBe(false)
    })

    test("a chord whose command is switched off for good is consumed", async () => {
      const c = await composer(kittyKeyboard)
      await c.chord("x")
      expect(c.ran).toEqual([])
      expect(c.area.plainText).toBe("")
    })

    test("a chord in a disabled layer is consumed", async () => {
      const c = await composer(kittyKeyboard)
      await c.chord("l")
      expect(c.ran).toEqual([])
      expect(c.area.plainText).toBe("")
      expect(c.keymap.hasPendingSequence()).toBe(false)
    })

    test("a chord runs again once its command is enabled", async () => {
      const c = await composer(kittyKeyboard)
      await c.chord("d")
      expect(c.ran).toEqual([])
      c.state.commandOn = true
      await c.chord("d")
      expect(c.ran).toEqual(["command"])
      c.state.layerOn = true
      await c.chord("l")
      expect(c.ran).toEqual(["command", "layer"])
      expect(c.area.plainText).toBe("")
    })

    test("a key that no chord uses is consumed too", async () => {
      const c = await composer(kittyKeyboard)
      await c.chord("z")
      expect(c.ran).toEqual([])
      expect(c.area.plainText).toBe("")
      expect(c.keymap.hasPendingSequence()).toBe(false)
    })

    test("the chord ends with its key: typing right after it is normal", async () => {
      const c = await composer(kittyKeyboard)
      await c.chord("d")
      await c.type("d")
      expect(c.area.plainText).toBe("d")
      await c.chord("e")
      await c.type("r")
      expect(c.area.plainText).toBe("dr")
      expect(c.ran).toEqual(["ready"])
    })

    test("the keys of a chord type as text when no leader key comes first", async () => {
      const c = await composer(kittyKeyboard)
      await c.type("delxz")
      expect(c.area.plainText).toBe("delxz")
      expect(c.ran).toEqual([])
    })
  })
}
