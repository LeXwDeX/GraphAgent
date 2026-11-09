// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { createBindingLookup } from "@opentui/keymap/extras"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, type JSX, type ParentProps } from "solid-js"
import { TuiKeybind } from "../../src/config/keybind"
import { GraphagentKeymapProvider, registerGraphagentKeymap } from "../../src/keymap"
import { PanelHost, PanelHostProvider, createPanelHost, type PanelSpec } from "../../src/panel/host"
import { ShellContexts } from "../shell/contexts"

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

export function PanelContexts(
  props: ParentProps<{
    state: string
    onReady?: () => void
  }>,
) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const offKeymap = registerGraphagentKeymap(keymap, renderer, createResolvedKeymapConfig())
  onCleanup(offKeymap)

  return (
    <GraphagentKeymapProvider keymap={keymap}>
      <ShellContexts state={props.state} onReady={props.onReady}>
        {props.children}
      </ShellContexts>
    </GraphagentKeymapProvider>
  )
}

/** Mounts one panel spec through a real PanelHost so host hints and bindings apply. */
export function PanelSurface(props: { spec: PanelSpec }) {
  const host = createPanelHost()
  host.push(props.spec)
  return (
    <PanelHostProvider host={host}>
      <PanelHost host={host} />
    </PanelHostProvider>
  )
}

export async function renderPanel(
  element: () => JSX.Element,
  options: { width: number; height: number; state: string },
) {
  let ready!: () => void
  const settled = new Promise<void>((resolve) => (ready = resolve))
  const app = await testRender(
    () => (
      <PanelContexts state={options.state} onReady={ready}>
        {element()}
      </PanelContexts>
    ),
    { width: options.width, height: options.height },
  )
  await settled
  // KVReady resolves before the reactive switch from its blank fallback has
  // painted; render until the first non-empty frame instead of assuming a
  // fixed number of frames.
  for (let attempt = 0; attempt < 50; attempt++) {
    await app.renderOnce()
    if (app.captureCharFrame().trim().length > 0) break
  }
  // Content measurement settles one render after the first paint.
  for (let attempt = 0; attempt < 3; attempt++) await app.renderOnce()
  return app
}
