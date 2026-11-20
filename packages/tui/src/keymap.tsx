import { InputRenderable, TextareaRenderable, type CliRenderer, type KeyEvent, type Renderable } from "@opentui/core"
import {
  registerBackspacePopsPendingSequence,
  registerBaseLayoutFallback,
  registerCommaBindings,
  registerEditBufferCommands,
  registerEscapeClearsPendingSequence,
  registerTextareaMappingSuspension,
  registerTimedLeader,
} from "@opentui/keymap/addons/opentui"
import { type ActiveBinding, type Binding, type KeyLike, type KeySequencePart } from "@opentui/keymap"
import {
  formatCommandBindings as formatCommandBindingsExtra,
  formatKeySequence as formatKeySequenceExtra,
  type KeySequenceFormatPart,
} from "@opentui/keymap/extras"
import { KeymapProvider, useKeymap, useKeymapSelector, useBindings } from "@opentui/keymap/solid"
import { type Accessor } from "solid-js"
import { useTuiConfig } from "./config"
import { t } from "./i18n"

export const LEADER_TOKEN = "leader"
export const GRAPHAGENT_BASE_MODE = "base"
export const COMMAND_PALETTE_COMMAND = "command.palette.show"

const GRAPHAGENT_MODE_KEY = "graphagent.mode"

/**
 * Shared escape-layer ordering. Higher values are consulted first; sibling
 * layers keep their own sub-ordering where the child must win (askSub, modalHelp).
 */
export const EscapePriority = {
  autocomplete: 700,
  drawer: 600,
  ask: 500,
  askSub: 501,
  modal: 400,
  modalHelp: 401,
  detail: 300,
  subagent: 200,
  shell: 110,
  /** Composer prefill edit: Esc rolls back instead of interrupting the run. */
  edit: 105,
  interrupt: 100,
  none: -1,
} as const

export const GraphagentKeymapProvider = KeymapProvider
export const useGraphagentKeymap = useKeymap

export { useBindings, useKeymapSelector }

export type OpenTuiKeymap = ReturnType<typeof useKeymap>
type GraphagentModeStack = ReturnType<typeof createGraphagentModeStack>
type BindingLookup = {
  get(command: string): readonly Binding<Renderable, KeyEvent>[]
  gather(name: string, commands: readonly string[]): readonly Binding<Renderable, KeyEvent>[]
}
type FormatConfig = { keybinds: BindingLookup }
type ResolvedKeymapConfig = FormatConfig & { leader_timeout: number }

const modeStacks = new WeakMap<OpenTuiKeymap, GraphagentModeStack>()

export function createGraphagentModeStack(keymap: OpenTuiKeymap) {
  keymap.setData(GRAPHAGENT_MODE_KEY, GRAPHAGENT_BASE_MODE)

  const offFields = keymap.registerLayerFields({
    mode(value, ctx) {
      ctx.require(GRAPHAGENT_MODE_KEY, value)
    },
  })

  const stack: { id: symbol; mode: string }[] = []
  let disposed = false

  const update = () => {
    keymap.setData(GRAPHAGENT_MODE_KEY, stack.at(-1)?.mode ?? GRAPHAGENT_BASE_MODE)
  }

  const stackApi = {
    current() {
      return stack.at(-1)?.mode ?? GRAPHAGENT_BASE_MODE
    },
    push(mode: string) {
      if (disposed) return () => {}
      const id = Symbol(mode)
      let active = true
      stack.push({ id, mode })
      update()

      return () => {
        if (!active) return
        active = false
        const index = stack.findIndex((item) => item.id === id)
        if (index !== -1) stack.splice(index, 1)
        update()
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      stack.length = 0
      offFields()
      keymap.setData(GRAPHAGENT_MODE_KEY, undefined)
      modeStacks.delete(keymap)
    },
  }

  modeStacks.set(keymap, stackApi)
  return stackApi
}

export function useGraphagentModeStack() {
  return getGraphagentModeStack(useGraphagentKeymap())
}

export function getGraphagentModeStack(keymap: OpenTuiKeymap) {
  const value = modeStacks.get(keymap)
  if (!value) throw new Error("Graphagent mode stack is not registered for this keymap")
  return value
}

const KEY_ALIASES = {
  enter: "return",
  esc: "escape",
  pgdown: "pagedown",
  pgup: "pageup",
} as const

function expandKeyAliases(input: string) {
  const result = Object.entries(KEY_ALIASES).reduce(
    (acc, [alias, key]) => acc.replace(new RegExp(`(^|[+,\\s>])${alias}(?=$|[+,\\s<])`, "gi"), `$1${key}`),
    input,
  )
  if (result === input) return
  return result
}

function registerKeyAliases(keymap: OpenTuiKeymap) {
  return keymap.appendBindingExpander((ctx) => {
    const key = expandKeyAliases(ctx.input)
    if (!key) return
    return [{ key, displays: ctx.displays }]
  })
}

const inputCommands = [
  "input.move.left",
  "input.move.right",
  "input.move.up",
  "input.move.down",
  "input.select.left",
  "input.select.right",
  "input.select.up",
  "input.select.down",
  "input.line.home",
  "input.line.end",
  "input.select.line.home",
  "input.select.line.end",
  "input.visual.line.home",
  "input.visual.line.end",
  "input.select.visual.line.home",
  "input.select.visual.line.end",
  "input.buffer.home",
  "input.buffer.end",
  "input.select.buffer.home",
  "input.select.buffer.end",
  "input.delete.line",
  "input.delete.to.line.end",
  "input.delete.to.line.start",
  "input.backspace",
  "input.delete",
  "input.newline",
  "input.undo",
  "input.redo",
  "input.word.forward",
  "input.word.backward",
  "input.select.word.forward",
  "input.select.word.backward",
  "input.delete.word.forward",
  "input.delete.word.backward",
  "input.select.all",
  "input.submit",
] as const

/**
 * Keeps the keys of `bindings` that start with a modified key (ctrl, alt, super,
 * hyper) or the leader. Such keys never produce text, so they can stay active
 * while a text input has focus; plain keys such as `home` and `end` belong to
 * the input then. Comma lists are split the way the keymap expands them.
 */
export function modifiedBindings(
  keymap: OpenTuiKeymap,
  bindings: readonly Binding<Renderable, KeyEvent>[],
): Binding<Renderable, KeyEvent>[] {
  return bindings.flatMap((binding) => {
    const keys = typeof binding.key === "string" ? binding.key.split(",").map((part) => part.trim()) : [binding.key]
    return keys.filter((key) => startsModified(keymap, key)).map((key) => ({ ...binding, key }))
  })
}

function startsModified(keymap: OpenTuiKeymap, key: KeyLike) {
  try {
    const first = keymap.parseKeySequence(key)[0]
    if (!first) return false
    const { ctrl, meta, super: command, hyper } = first.stroke
    return first.tokenName !== undefined || ctrl || meta || command || hyper === true
  } catch {
    // A key the parser rejects is not a modified key. The keymap reports the
    // same key itself when the plain-key layer registers it.
    return false
  }
}

export function hasManagedTextareaFocus(renderer: CliRenderer) {
  const editor = renderer.currentFocusedEditor
  return editor instanceof TextareaRenderable && !(editor instanceof InputRenderable)
}

/**
 * Textarea bindings that no definition lists but that the library's own defaults used to provide: Cmd+arrow
 * navigation on terminals that report `super`, and keypad Enter / linefeed as newline aliases (linefeed is what
 * legacy terminals send for ctrl+j). They are fixed and not configurable.
 *
 * The library's emacs defaults ctrl+b, ctrl+f and ctrl+d are deliberately absent: the key plan hands them to the
 * drawer, the lists and exit (#886 4.2 and 4.3). So are its alt+enter and alt+keypad-enter submit defaults, which
 * contradict `input_newline`, and its plain Enter newline default, which `input.submit` always shadowed.
 */
const inputExtraBindings: readonly Binding<Renderable, KeyEvent>[] = [
  { key: "super+left", cmd: "input.visual.line.home" },
  { key: "super+right", cmd: "input.visual.line.end" },
  { key: "super+up", cmd: "input.buffer.home" },
  { key: "super+down", cmd: "input.buffer.end" },
  { key: "shift+super+left", cmd: "input.select.visual.line.home" },
  { key: "shift+super+right", cmd: "input.select.visual.line.end" },
  { key: "shift+super+up", cmd: "input.select.buffer.home" },
  { key: "shift+super+down", cmd: "input.select.buffer.end" },
  { key: "kpenter", cmd: "input.newline" },
  { key: "linefeed", cmd: "input.newline" },
]

/**
 * The managed textarea layer: the edit-buffer commands, suspension of the textarea's own key handling, and a layer
 * bound while a managed textarea has focus. Built from the definitions only so that a key removed from or rebound in
 * `Definitions` really stops acting; `registerManagedTextareaLayer` would append the library's 64 defaults to it.
 */
function registerInputLayer(keymap: OpenTuiKeymap, renderer: CliRenderer, config: FormatConfig) {
  const offCommands = registerEditBufferCommands(keymap, renderer)
  const offSuspension = registerTextareaMappingSuspension(keymap, renderer)
  try {
    const offLayer = keymap.registerLayer({
      enabled: () => hasManagedTextareaFocus(renderer),
      bindings: [...config.keybinds.gather("input", inputCommands), ...inputExtraBindings],
    })
    return () => {
      offLayer()
      offSuspension()
      offCommands()
    }
  } catch (error) {
    offSuspension()
    offCommands()
    throw error
  }
}

/**
 * Ends a leader chord that has nothing to run without typing its key. The key after the leader is matched against the
 * reachable bindings only. When its command is disabled, the layer holding it is, or nothing is bound to it, the
 * keymap reports a `sequence-miss`: it clears the sequence but lets the key event go on to the focused input, which
 * would type it (`<leader>r` with nothing to redo put an "r" in the prompt). A chord is never text, so the key is
 * consumed here and the sequence ends as a no-op. Keys that do not follow the leader are left alone.
 */
function registerLeaderMissConsumption(keymap: OpenTuiKeymap) {
  return keymap.intercept("key:after", ({ reason, sequence, consume }) => {
    if (reason !== "sequence-miss" || sequence[0]?.tokenName !== LEADER_TOKEN) return
    consume()
  })
}

function leaderKey(config: FormatConfig) {
  return config.keybinds.get(LEADER_TOKEN)?.[0]?.key
}

/** How a modifier is written: the key symbols of the Mac keyboard, each one cell wide at either `ambiguous_width`. */
const MODIFIER_ALIASES = {
  ctrl: "⌃",
  shift: "⇧",
  meta: "⌥",
  super: "⌘",
} as const

/** Key names that are written as a symbol or a shorter word. The formatter looks `return` up here as `enter`. */
const KEY_NAME_ALIASES = {
  tab: "⇥",
  enter: "⏎",
  escape: "esc",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  pageup: "pgup",
  pagedown: "pgdn",
  delete: "del",
} as const

/**
 * Options for the upstream formatter. It writes a token such as the leader as the fixed text it was registered with,
 * and applies the aliases only to plain strokes. Every token part carries the stroke of the key it stands for, so the
 * token is written as that stroke: the leader gets the same aliases as any other key, whichever key it is bound to.
 */
function formatOptions() {
  const aliases = {
    keyNameAliases: { ...KEY_NAME_ALIASES, space: t("keymap.key.space") },
    modifierAliases: MODIFIER_ALIASES,
  }
  return {
    ...aliases,
    tokenDisplay: (_token: string, part: KeySequenceFormatPart) =>
      formatKeySequenceExtra([{ stroke: part.stroke, display: part.display }], aliases),
  }
}

/**
 * The writing the upstream formatter cannot produce: it joins a modifier and the key with `+` ("⌃+b") and leaves letter
 * keys and function keys in lower case. Applying it twice changes nothing.
 */
function finishKeyText(text: string) {
  return text
    .replace(/([⌃⇧⌥⌘])\+/g, "$1")
    .replace(/(^|[\s,⌃⇧⌥⌘])([a-z]|f\d{1,2})(?=$|[\s,])/g, (_match, before: string, key: string) => {
      return before + key.toUpperCase()
    })
}

/**
 * The text of a key sequence as the footer, the panels and `/help` show it: `⌃B`, `⌃⇧P`, `⇧⇥`, `⏎`, `esc`, `↑`, `F9`,
 * and `⌃X B` for the leader and the key after it. The keys themselves are written in `keybinds` as before (`ctrl+b`);
 * only what is displayed changes. `config` is kept for the callers that pass the one they hold: the leader's key
 * comes with the sequence, so nothing here reads it.
 */
export function formatKeySequence(parts: Parameters<typeof formatKeySequenceExtra>[0], _config: FormatConfig) {
  return finishKeyText(formatKeySequenceExtra(parts, formatOptions()))
}

/** The sequences of every binding of a command, written like `formatKeySequence`, apart by `, ` and each one once. */
export function formatKeyBindings(bindings: Parameters<typeof formatCommandBindingsExtra>[0], _config: FormatConfig) {
  const text = formatCommandBindingsExtra(bindings, formatOptions())
  return text === undefined ? undefined : finishKeyText(text)
}

export function registerGraphagentKeymap(keymap: OpenTuiKeymap, renderer: CliRenderer, config: ResolvedKeymapConfig) {
  const modeStack = createGraphagentModeStack(keymap)
  const offCommaBindings = registerCommaBindings(keymap)
  const offAliasExpander = registerKeyAliases(keymap)
  const offBaseLayout = registerBaseLayoutFallback(keymap)
  const leader = leaderKey(config)
  const offLeader = leader
    ? registerTimedLeader(keymap, {
        trigger: leader,
        name: LEADER_TOKEN,
        timeoutMs: config.leader_timeout,
      })
    : () => {}
  const offLeaderMiss = leader ? registerLeaderMissConsumption(keymap) : () => {}
  const offEscape = registerEscapeClearsPendingSequence(keymap)
  const offBackspace = registerBackspacePopsPendingSequence(keymap)
  const offInputBindings = registerInputLayer(keymap, renderer, config)

  return () => {
    offInputBindings()
    offBackspace()
    offEscape()
    offLeaderMiss()
    offLeader()
    offAliasExpander()
    offBaseLayout()
    offCommaBindings()
    modeStack.dispose()
  }
}

export function useLeaderActive(): Accessor<boolean> {
  return useKeymapSelector((keymap: OpenTuiKeymap) => keymap.getPendingSequence()[0]?.tokenName === LEADER_TOKEN)
}

export function useCommandShortcut(command: string): Accessor<string> {
  const config = useTuiConfig()
  return useKeymapSelector((keymap: OpenTuiKeymap) => {
    const bindings = keymap.getCommandBindings({ visibility: "registered", commands: [command] }).get(command)
    return formatKeySequence(displaySequence(command, bindings), config)
  })
}

/**
 * Inside tmux, ctrl+b is the terminal multiplexer prefix, so the drawer prefers
 * its leader alternative when both are registered.
 */
export function displaySequence(
  command: string,
  bindings: readonly Pick<ActiveBinding<Renderable, KeyEvent>, "sequence">[] | undefined,
): KeySequencePart[] | undefined {
  const first = bindings?.[0]
  if (command !== "session.drawer.toggle" || !process.env.TMUX) return first?.sequence
  return (
    bindings?.find((binding) => binding.sequence.some((part) => part.tokenName === LEADER_TOKEN))?.sequence ??
    first?.sequence
  )
}
