/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { TuiKeybind } from "../src/config/keybind"
import {
  displaySequence,
  formatKeySequence,
  getGraphagentModeStack,
  GRAPHAGENT_BASE_MODE,
  GraphagentKeymapProvider,
  modifiedBindings,
  registerGraphagentKeymap,
} from "../src/keymap"

function createResolvedKeymapConfig(input: TuiKeybind.KeybindOverrides = {}) {
  const keybinds = TuiKeybind.parse(input)
  return {
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(keybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: 2000,
  }
}

test("legacy page key aliases compile as page keys", async () => {
  const sequences: Record<string, string[][]> = {}

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createResolvedKeymapConfig({
      messages_page_up: "pgup",
      messages_page_down: "pgdown",
    })
    const offKeymap = registerGraphagentKeymap(keymap, renderer, config)
    const offLayer = keymap.registerLayer({
      bindings: config.keybinds.gather("session", ["session.page.up", "session.page.down"]),
    })
    const bindings = keymap.getCommandBindings({
      visibility: "registered",
      commands: ["session.page.up", "session.page.down"],
    })
    sequences.up =
      bindings.get("session.page.up")?.map((binding) => binding.sequence.map((part) => part.stroke.name)) ?? []
    sequences.down =
      bindings.get("session.page.down")?.map((binding) => binding.sequence.map((part) => part.stroke.name)) ?? []
    onCleanup(() => {
      offLayer()
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
    expect(sequences).toEqual({
      up: [["pageup"]],
      down: [["pagedown"]],
    })
  } finally {
    app.renderer.destroy()
  }
})

test("session interrupt binds a meta-modified escape fallback for merged double-ESC presses", async () => {
  const captured: { strokes: Array<Array<{ name: string; meta?: boolean }>> } = { strokes: [] }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createResolvedKeymapConfig()
    const offKeymap = registerGraphagentKeymap(keymap, renderer, config)
    const offLayer = keymap.registerLayer({
      commands: [{ name: "session.interrupt", run() {} }],
      bindings: config.keybinds.gather("prompt.palette", ["session.interrupt"]),
    })
    captured.strokes =
      keymap
        .getCommandBindings({
          visibility: "registered",
          commands: ["session.interrupt"],
        })
        .get("session.interrupt")
        ?.map((binding) =>
          binding.sequence.map((part) => ({
            name: part.stroke.name,
            ...(part.stroke.meta ? { meta: true } : {}),
          })),
        ) ?? []
    onCleanup(() => {
      offLayer()
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
    expect(captured.strokes).toEqual([[{ name: "escape" }], [{ name: "escape", meta: true }]])
  } finally {
    app.renderer.destroy()
  }
})

test("mode-less bindings stay active when opencode mode changes", async () => {
  const counts: Record<string, Record<string, number>> = {}

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createResolvedKeymapConfig()
    const offKeymap = registerGraphagentKeymap(keymap, renderer, config)
    const offGlobal = keymap.registerLayer({
      commands: [
        { name: "session.list", run() {} },
        { name: "session.new", run() {} },
        { name: "session.page.up", run() {} },
        { name: "session.first", run() {} },
      ],
      bindings: config.keybinds.gather("test.global", [
        "session.list",
        "session.new",
        "session.page.up",
        "session.first",
      ]),
    })
    const offBase = keymap.registerLayer({
      mode: GRAPHAGENT_BASE_MODE,
      commands: [{ name: "model.list", run() {} }],
      bindings: config.keybinds.gather("test.base", ["model.list"]),
    })
    const activeCounts = () =>
      Object.fromEntries(
        Array.from(
          keymap.getCommandBindings({
            visibility: "active",
            commands: ["session.list", "session.new", "session.page.up", "session.first", "model.list"],
          }),
          ([command, bindings]) => [command, bindings.length],
        ),
      )

    counts.base = activeCounts()
    const popQuestion = getGraphagentModeStack(keymap).push("question")
    counts.question = activeCounts()
    popQuestion()
    const popAutocomplete = getGraphagentModeStack(keymap).push("autocomplete")
    counts.autocomplete = activeCounts()
    popAutocomplete()

    onCleanup(() => {
      offBase()
      offGlobal()
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
    expect(counts).toEqual({
      base: { "session.list": 1, "session.new": 1, "session.page.up": 2, "session.first": 2, "model.list": 1 },
      question: { "session.list": 1, "session.new": 1, "session.page.up": 2, "session.first": 2, "model.list": 0 },
      autocomplete: {
        "session.list": 1,
        "session.new": 1,
        "session.page.up": 2,
        "session.first": 2,
        "model.list": 0,
      },
    })
  } finally {
    app.renderer.destroy()
  }
})

async function withKeymap<T>(run: (keymap: ReturnType<typeof createDefaultOpenTuiKeymap>) => T) {
  let result!: T
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    onCleanup(registerGraphagentKeymap(keymap, renderer, createResolvedKeymapConfig()))
    result = run(keymap)
    return <box />
  }
  const app = await testRender(() => <Harness />)
  app.renderer.destroy()
  return result
}

test("modifiedBindings keeps the modified keys of the default jump bindings", async () => {
  const config = createResolvedKeymapConfig()
  const kept = await withKeymap((keymap) => ({
    first: modifiedBindings(keymap, config.keybinds.get("session.first")),
    last: modifiedBindings(keymap, config.keybinds.get("session.last")),
  }))
  expect(kept.first).toEqual([{ desc: "Navigate to first message", key: "ctrl+g", cmd: "session.first" }])
  expect(kept.last).toEqual([{ desc: "Navigate to last message", key: "ctrl+alt+g", cmd: "session.last" }])
})

test("modifiedBindings drops plain and shift-only keys and keeps ctrl, alt, super, hyper and leader keys", async () => {
  const kept = await withKeymap((keymap) =>
    modifiedBindings(keymap, [
      { key: "home,end,shift+home,f6,a", cmd: "plain" },
      { key: "ctrl+home,alt+h,super+h,hyper+h,<leader>h", cmd: "modified" },
      { key: "  ctrl+f6 , f7  ", cmd: "spaced" },
      { key: { name: "g", ctrl: true }, cmd: "stroke" },
      { key: { name: "g" }, cmd: "plain-stroke" },
    ]),
  )
  expect(kept.map((binding) => [binding.cmd, binding.key])).toEqual([
    ["modified", "ctrl+home"],
    ["modified", "alt+h"],
    ["modified", "super+h"],
    ["modified", "hyper+h"],
    ["modified", "<leader>h"],
    ["spaced", "ctrl+f6"],
    ["stroke", { name: "g", ctrl: true }],
  ])
})

test("modifiedBindings keeps the other binding fields and tolerates keys the parser rejects", async () => {
  const kept = await withKeymap((keymap) =>
    modifiedBindings(keymap, [
      { key: "ctrl+g", cmd: "x", desc: "Jump", event: "release", preventDefault: false, fallthrough: true },
      { key: "ctrl+", cmd: "broken" },
      { key: "", cmd: "empty" },
    ]),
  )
  expect(kept).toEqual([
    { key: "ctrl+g", cmd: "x", desc: "Jump", event: "release", preventDefault: false, fallthrough: true },
  ])
})

const TMUX_SESSION = "/tmp/tmux-1000/default,4242,0"

/**
 * The shortcut text `useCommandShortcut` shows for `command`, with `TMUX` set to
 * `options.tmux` (or removed) while the bindings are read.
 */
async function shortcutText(
  command: string,
  options: { tmux: string | undefined; overrides?: TuiKeybind.KeybindOverrides },
) {
  const previous = process.env.TMUX
  if (options.tmux === undefined) delete process.env.TMUX
  else process.env.TMUX = options.tmux
  try {
    let text = ""

    function Harness() {
      const renderer = useRenderer()
      const keymap = createDefaultOpenTuiKeymap(renderer)
      const config = createResolvedKeymapConfig(options.overrides)
      const offKeymap = registerGraphagentKeymap(keymap, renderer, config)
      const offLayer = keymap.registerLayer({
        commands: [{ name: command, run() {} }],
        bindings: config.keybinds.gather("test.display", [command]),
      })
      const bindings = keymap.getCommandBindings({ visibility: "registered", commands: [command] }).get(command)
      text = formatKeySequence(displaySequence(command, bindings), config)
      onCleanup(() => {
        offLayer()
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
      return text
    } finally {
      app.renderer.destroy()
    }
  } finally {
    if (previous === undefined) delete process.env.TMUX
    else process.env.TMUX = previous
  }
}

test("shows ctrl+b for the drawer toggle outside tmux", async () => {
  expect(await shortcutText("session.drawer.toggle", { tmux: undefined })).toBe("ctrl+b")
  // An empty TMUX is the same as no tmux.
  expect(await shortcutText("session.drawer.toggle", { tmux: "" })).toBe("ctrl+b")
})

test("shows the leader alternative for the drawer toggle inside tmux", async () => {
  expect(await shortcutText("session.drawer.toggle", { tmux: TMUX_SESSION })).toBe("ctrl+x b")
})

test("keeps the only drawer toggle binding inside tmux when it has no leader alternative", async () => {
  expect(
    await shortcutText("session.drawer.toggle", {
      tmux: TMUX_SESSION,
      overrides: { session_drawer_toggle: "f9" },
    }),
  ).toBe("f9")
})

test("inside tmux only the drawer toggle prefers its leader alternative", async () => {
  const overrides = { help_show: "?,<leader>h" }
  expect(await shortcutText("help.show", { tmux: undefined, overrides })).toBe("?")
  expect(await shortcutText("help.show", { tmux: TMUX_SESSION, overrides })).toBe("?")
})
