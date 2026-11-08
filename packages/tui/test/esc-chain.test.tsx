/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { TuiKeybind } from "../src/config/keybind"
import { EscapePriority, GraphagentKeymapProvider, registerGraphagentKeymap } from "../src/keymap"

function createResolvedKeymapConfig() {
  const keybinds = TuiKeybind.parse({})
  return {
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(keybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: 2000,
  }
}

test("escape priorities follow the documented chain", () => {
  expect(EscapePriority.autocomplete).toBeGreaterThan(EscapePriority.drawer)
  expect(EscapePriority.drawer).toBeGreaterThan(EscapePriority.askSub)
  expect(EscapePriority.askSub).toBeGreaterThan(EscapePriority.ask)
  expect(EscapePriority.ask).toBeGreaterThan(EscapePriority.modalHelp)
  expect(EscapePriority.modalHelp).toBeGreaterThan(EscapePriority.modal)
  expect(EscapePriority.modal).toBeGreaterThan(EscapePriority.detail)
  expect(EscapePriority.detail).toBeGreaterThan(EscapePriority.subagent)
  expect(EscapePriority.subagent).toBeGreaterThan(EscapePriority.shell)
  expect(EscapePriority.shell).toBeGreaterThan(EscapePriority.interrupt)
  expect(EscapePriority.interrupt).toBeGreaterThan(EscapePriority.none)
})

test("the innermost enabled escape layer wins and disabled layers fall through", async () => {
  const calls: string[] = []
  const enabled = {
    askSub: true,
    ask: true,
    modalHelp: true,
    modal: true,
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const offKeymap = registerGraphagentKeymap(keymap, renderer, createResolvedKeymapConfig())
    const layers = [
      ["interrupt", EscapePriority.interrupt],
      ["modal", EscapePriority.modal],
      ["modalHelp", EscapePriority.modalHelp],
      ["ask", EscapePriority.ask],
      ["askSub", EscapePriority.askSub],
    ].map(([name, priority]) =>
      keymap.registerLayer({
        priority: priority as number,
        enabled: () => name === "interrupt" || enabled[name as keyof typeof enabled],
        commands: [
          {
            name: `test.escape.${name}`,
            run: () => {
              calls.push(name as string)
            },
          },
        ],
        bindings: [{ key: "escape", cmd: `test.escape.${name}` }],
      }),
    )
    onCleanup(() => {
      layers.forEach((dispose) => dispose())
      offKeymap()
    })

    return (
      <GraphagentKeymapProvider keymap={keymap}>
        <box />
      </GraphagentKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    await app.renderOnce()
    app.mockInput.pressEscape()
    await Bun.sleep(50)
    await app.renderOnce()
    expect(calls).toEqual(["askSub"])

    enabled.askSub = false
    app.mockInput.pressEscape()
    await Bun.sleep(50)
    await app.renderOnce()
    expect(calls).toEqual(["askSub", "ask"])

    enabled.ask = false
    app.mockInput.pressEscape()
    await Bun.sleep(50)
    await app.renderOnce()
    expect(calls).toEqual(["askSub", "ask", "modalHelp"])

    enabled.modalHelp = false
    app.mockInput.pressEscape()
    await Bun.sleep(50)
    await app.renderOnce()
    expect(calls).toEqual(["askSub", "ask", "modalHelp", "modal"])

    enabled.modal = false
    app.mockInput.pressEscape()
    await Bun.sleep(50)
    await app.renderOnce()
    expect(calls).toEqual(["askSub", "ask", "modalHelp", "modal", "interrupt"])
  } finally {
    app.renderer.destroy()
  }
})
