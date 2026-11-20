// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { onCleanup, type ParentProps } from "solid-js"
import { useCommands } from "../../src/commands/context"
import { usePromptRef } from "../../src/context/prompt"
import { setLanguage, t } from "../../src/i18n"
import { useGraphagentKeymap } from "../../src/keymap"
import type { PanelHostApi } from "../../src/panel/host"
import { CommandPalettePanel } from "../../src/panel/palette"
import { shellState } from "../shell/contexts"
import { PanelSurface, renderAppPanel } from "./contexts"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

async function settle(app: Awaited<ReturnType<typeof renderAppPanel>>) {
  await Bun.sleep(30)
  await app.renderOnce()
}

function PaletteHarness(props: ParentProps<{ onRun(origin: string): void }>) {
  const commands = useCommands()
  const prompt = usePromptRef()
  commands.setHandler("model.list", (context) => props.onRun(context.origin))
  prompt.set(undefined)
  onCleanup(() => prompt.set(undefined))
  return <>{props.children}</>
}

test("palette panel shows the suggestion group and runs the selected command through the registry", async () => {
  await using tmp = await shellState()
  let host: PanelHostApi | undefined
  const runs: string[] = []
  const app = await renderAppPanel(
    () => (
      <PaletteHarness onRun={(origin) => runs.push(origin)}>
        <PanelSurface
          spec={{ id: "palette", render: () => <CommandPalettePanel /> }}
          onHost={(value) => (host = value)}
        />
      </PaletteHarness>
    ),
    { width: 120, height: 40, state: tmp.path },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain(t("command.palette.title"))
    expect(frame).toContain(t("command.category.suggested"))
    expect(frame).toContain(t("command.model.list.title"))
    expect(host?.depth()).toBe(1)

    app.mockInput.pressEnter()
    await settle(app)
    expect(runs).toEqual(["palette"])
    expect(host?.depth()).toBe(0)
    expect(app.captureCharFrame()).not.toContain(t("command.palette.title"))
  } finally {
    app.renderer.destroy()
  }
})

test("palette panel closes with escape", async () => {
  await using tmp = await shellState()
  let host: PanelHostApi | undefined
  const app = await renderAppPanel(
    () => (
      <PaletteHarness onRun={() => {}}>
        <PanelSurface
          spec={{ id: "palette", render: () => <CommandPalettePanel /> }}
          onHost={(value) => (host = value)}
        />
      </PaletteHarness>
    ),
    { width: 120, height: 40, state: tmp.path },
  )

  try {
    app.mockInput.pressEscape()
    await settle(app)
    expect(host?.depth()).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

/** Binds `model.list` to two keys before the palette mounts, as a user's keybinds would: the palette reads them once. */
function ModelKeys(props: ParentProps) {
  const keymap = useGraphagentKeymap()
  const off = keymap.registerLayer({
    commands: [{ name: "model.list", run() {} }],
    bindings: [
      { key: "<leader>m", cmd: "model.list" },
      { key: "ctrl+shift+m", cmd: "model.list" },
    ],
  })
  onCleanup(off)
  return <>{props.children}</>
}

// The keys at the end of a row come from the keymap, as the footer's do: `<leader>m` is `⌃X M`, not `ctrl+x m`.
for (const language of ["zh-CN", "en"] as const) {
  test(`palette rows end in the keys of their commands written as symbols, in ${language}`, async () => {
    setLanguage(language)
    await using tmp = await shellState()
    const app = await renderAppPanel(
      () => (
        <PaletteHarness onRun={() => {}}>
          <ModelKeys>
            <PanelSurface spec={{ id: "palette", render: () => <CommandPalettePanel /> }} />
          </ModelKeys>
        </PaletteHarness>
      ),
      { width: 120, height: 40, state: tmp.path },
    )

    try {
      const rows = app.captureCharFrame().split("\n")
      const row = rows.find((line) => line.includes(t("command.model.list.title")))
      expect(row).toBeDefined()
      expect(row!.replace(/ *│$/, "")).toEndWith("⌃X M, ⌃⇧M")
      expect(rows.join("\n")).not.toContain("ctrl+")
    } finally {
      app.renderer.destroy()
    }
  })
}
