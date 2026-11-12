// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Definitions } from "./keybind"

/**
 * Disposition relative to the pre-v2 baseline: `keep` is unchanged, `change` has a new default or a narrower scope,
 * `new` was added by v2. Names that were dropped are not in `Definitions` any more; their list lives in the keybind
 * disposition test, outside `src`, so the retired-feature guard stays clean.
 */
export type DispositionKind = "keep" | "change" | "new"

/** Keymap context that carries a definition's own bindings; see `Layers`. */
export type KeybindLayer =
  | "global"
  | "session"
  | "session-unfocused"
  | "input"
  | "interrupt"
  | "autocomplete"
  | "diff"
  | "ask"
  | "run"
  | "modal:session-list"
  | "modal:stash"
  | "modal:model"
  | "modal:mcp"
  | "modal:move-session"
  | "modal:list"
  | "modal:detail"

export interface DispositionEntry {
  disposition: DispositionKind
  layer: KeybindLayer
  note?: string
}

export interface LayerInfo {
  /** Where the layer is registered and when it is live. */
  summary: string
  /**
   * Layers that are live at the same time and at the same priority, so a key may not be claimed by both. Overlay
   * layers (interrupt, autocomplete, modal, ask) outrank the base layers by explicit mode or priority and are
   * checked on their own.
   */
  coactive: readonly KeybindLayer[]
}

/**
 * The contexts a key press can land in, read from where the owning component registers its bindings (mode,
 * `enabled`, target, priority). A key sequence may be claimed by one definition per context; reuse across contexts is
 * what layers are for, not command-internal branching. The names label registrations and are not keymap identifiers.
 *
 * Bindings that owners hard-code inline (panel navigation, ask choices, the sub-agent view, diff paging) are not
 * definitions and are not covered. The `run` footer registers a subset of these definitions on its own keymap; only
 * its run-only key is listed.
 */
export const Layers = {
  global: {
    summary:
      "App-level layers in app.tsx (`app`, `app.global`, `app_exit`, `help`) and the Prompt palette layer. Base mode, " +
      "live on every route; `app.global` is mode-less, `app_exit` and `help` carry `enabled` predicates.",
    coactive: [],
  },
  session: {
    summary:
      "Session route layers: `session` (base mode), `session.global`, `session.global.unfocused` and " +
      "`session.background` (priority 1). Live while a session is open, including with the composer focused.",
    coactive: ["global"],
  },
  "session-unfocused": {
    summary:
      "`session.global.unfocused`: session bindings that only fire while no editor is focused (plain Home/End jump to " +
      "the first/last message). Their modifier alternatives (ctrl+g, ctrl+alt+g) are re-registered in an always-on " +
      "base-mode layer, so only the plain keys are scoped here.",
    coactive: ["global", "session"],
  },
  input: {
    summary:
      "Composer textarea focused: the textarea layer in keymap.tsx (the definitions plus a few fixed aliases, without " +
      "the library's own textarea defaults) and the prompt layers targeted at the textarea (paste, clear, history).",
    coactive: ["global", "session"],
  },
  interrupt: {
    summary: "Escape chain level 7: interrupt a busy session. Targeted at the textarea, priority 100.",
    coactive: [],
  },
  autocomplete: {
    summary: "Escape chain level 1 and popup navigation. Pushes mode `autocomplete`, priority 700.",
    coactive: [],
  },
  diff: {
    summary: "Diff route layer: no mode, priority 0, registered when the route mounts.",
    coactive: ["global"],
  },
  ask: {
    summary: "Ask surfaces (permission, question, local confirm): base mode, priority 400 and above.",
    coactive: [],
  },
  run: {
    summary: "The `run` footer registers its own keymap, separate from the TUI one.",
    coactive: [],
  },
  "modal:session-list": {
    summary: "Session list panel actions (mode `modal`, priority 400).",
    coactive: [],
  },
  "modal:stash": {
    summary: "Stash panel actions (mode `modal`, priority 400).",
    coactive: [],
  },
  "modal:model": {
    summary: "Model panel actions (mode `modal`, priority 400).",
    coactive: [],
  },
  "modal:mcp": {
    summary: "MCP panel actions (mode `modal`, priority 400).",
    coactive: [],
  },
  "modal:move-session": {
    summary: "Move-session panel actions (mode `modal`, priority 400).",
    coactive: [],
  },
  "modal:list": {
    summary: "Generic list panel navigation; the keys are hard-coded in panel/list.tsx.",
    coactive: [],
  },
  "modal:detail": {
    summary: "Detail panel with an input row; the keys are hard-coded in panel/detail.tsx.",
    coactive: [],
  },
} as const satisfies Record<KeybindLayer, LayerInfo>

type KeybindName = keyof typeof Definitions

const CONFIG_TOGGLE = "Spec 4.4: the toggle moves into /config; the definition stays optional (default none)"
const CMD_ARROW = "Also bound to its Cmd+arrow (super) form by a fixed extra in keymap.tsx"

function entry(disposition: DispositionKind, layer: KeybindLayer, note?: string): DispositionEntry {
  return note === undefined ? { disposition, layer } : { disposition, layer, note }
}

const keep = (layer: KeybindLayer, note?: string) => entry("keep", layer, note)
const change = (layer: KeybindLayer, note: string) => entry("change", layer, note)
const added = (layer: KeybindLayer, note: string) => entry("new", layer, note)

/**
 * One entry per keybind definition. Adding a definition requires an entry here: the `satisfies` clause fails the
 * typecheck otherwise, and `test/keybind-disposition.test.ts` checks the table both ways at runtime.
 */
export const Disposition = {
  leader: keep("global", "Keymap-wide leader trigger (registerTimedLeader), not a command binding"),

  app_exit: keep(
    "global",
    "ctrl+d exits only while the composer is empty or unfocused; ask surfaces re-bind these keys to reject/cancel",
  ),
  app_debug: keep("global"),
  app_console: keep("global"),
  app_heap_snapshot: keep("global"),
  app_toggle_animations: keep("global", CONFIG_TOGGLE),
  app_toggle_file_context: keep("global", CONFIG_TOGGLE),
  app_toggle_diffwrap: keep("global", CONFIG_TOGGLE),
  app_toggle_paste_summary: keep("global", CONFIG_TOGGLE),
  app_toggle_session_directory_filter: keep("global", CONFIG_TOGGLE),
  command_list: keep("global"),
  help_show: change(
    "global",
    "Default is `?`; enabled only while the composer is unfocused and never on the diff route (diff_help owns `?`)",
  ),
  diff_open: keep("global", "Opens the diff route; the diff_* keys below live inside it"),
  diff_close: keep("diff"),
  diff_toggle: keep("diff"),
  diff_expand: keep("diff"),
  diff_expand_all: keep("diff"),
  diff_collapse: keep("diff"),
  diff_switch_focus: keep("diff"),
  diff_next_hunk: keep("diff"),
  diff_previous_hunk: keep("diff"),
  diff_next_file: keep("diff"),
  diff_previous_file: keep("diff"),
  diff_toggle_file_tree: keep("diff"),
  diff_single_patch: keep("diff"),
  diff_switch_source: keep("diff"),
  diff_toggle_view: keep("diff"),
  diff_help: keep("diff"),

  editor_open: keep("global", "Gathered by the Prompt palette layer"),
  theme_list: keep("global"),
  theme_switch_mode: keep("global"),
  theme_mode_lock: keep("global"),
  session_drawer_toggle: added(
    "session",
    "ctrl+b,<leader>b; registered by the session route only although spec 4.4 lists it as global; the shortcut " +
      "display prefers <leader>b inside tmux (keymap.tsx displaySequence)",
  ),
  scrollbar_toggle: keep("session", CONFIG_TOGGLE),
  status_view: keep("global"),
  view_expand_toggle: added(
    "session",
    "No command registered yet; the footer only reads its shortcut (spec 4.4 lists ctrl+o as global)",
  ),

  session_export: keep("session"),
  session_copy: keep("session"),
  session_move: keep("global", "Gathered by the Prompt palette layer"),
  session_new: keep("global"),
  session_list: keep("global"),
  session_timeline: keep("session"),
  session_fork: keep("session"),
  session_rename: change("modal:session-list", "Scoped to the session list panel; no longer a global key"),
  session_delete: change(
    "modal:session-list",
    "Scoped to the session list panel (the workspace panel reuses it); no longer a global key",
  ),
  session_interrupt: keep(
    "interrupt",
    "Escape chain level 7: acts while the composer is focused and the session is busy or has queued prompts",
  ),
  session_background: change("session", "ctrl+b moved to <leader>w; priority 1, enabled while foreground tasks run"),
  session_compact: keep("session"),
  session_dagmode_toggle: added(
    "session",
    "Main-session view only (spec 3.9); command registration ships with the DAG mode key work",
  ),
  session_toggle_timestamps: keep("session", CONFIG_TOGGLE),
  session_toggle_generic_tool_output: keep("session", CONFIG_TOGGLE),
  session_queued_prompts: keep("run", "Registered by the run footer only; the TUI registers no command for it"),
  session_child_first: keep("session"),
  session_pin_toggle: change("modal:session-list", "Scoped to the session list panel; no longer a global key"),
  session_quick_switch_1: keep("global"),
  session_quick_switch_2: keep("global"),
  session_quick_switch_3: keep("global"),
  session_quick_switch_4: keep("global"),
  session_quick_switch_5: keep("global"),
  session_quick_switch_6: keep("global"),
  session_quick_switch_7: keep("global"),
  session_quick_switch_8: keep("global"),
  session_quick_switch_9: keep("global"),

  stash_delete: change("modal:stash", "Scoped to the stash panel; no longer a global key"),
  model_provider_list: change("modal:model", "Scoped to the model panel; no longer a global key"),
  model_favorite_toggle: change("modal:model", "Scoped to the model panel; no longer a global key"),
  model_list: keep("global"),
  model_cycle_recent: keep("global"),
  model_cycle_recent_reverse: keep("global"),
  model_cycle_favorite: keep("global"),
  model_cycle_favorite_reverse: keep("global"),
  mcp_list: keep("global"),
  provider_connect: keep("global"),
  agent_list: keep("global"),
  agent_cycle: keep("global"),
  agent_cycle_reverse: keep("global"),
  variant_cycle: keep("global"),
  variant_list: keep("global"),

  messages_page_up: keep("session"),
  messages_page_down: keep("session"),
  messages_line_up: keep("session"),
  messages_line_down: keep("session"),
  messages_half_page_up: keep("session"),
  messages_half_page_down: keep("session"),
  messages_first: keep(
    "session-unfocused",
    "Plain home fires only with no editor focused; the ctrl+g alternative stays always-on through the modifier layer",
  ),
  messages_last: keep(
    "session-unfocused",
    "Plain end fires only with no editor focused; the ctrl+alt+g alternative stays always-on through the modifier layer",
  ),
  messages_next: keep("session"),
  messages_previous: keep("session"),
  messages_last_user: keep("session"),
  messages_copy: keep("session"),
  messages_undo: keep("session"),
  messages_redo: keep("session"),
  messages_toggle_conceal: keep("session"),
  tool_details: keep("session", CONFIG_TOGGLE),
  display_thinking: keep("session", CONFIG_TOGGLE),

  prompt_submit: keep("global", "Gathered by the Prompt palette layer"),
  prompt_editor_context_clear: keep("global", "Gathered by the Prompt palette layer"),
  prompt_skills: keep("global", "Dormant: the Prompt palette layer does not gather it, so an override binds nothing"),
  prompt_stash: keep("global", "Gathered by the Prompt palette layer"),
  prompt_stash_pop: keep("global", "Gathered by the Prompt palette layer"),
  prompt_stash_list: keep("global", "Gathered by the Prompt palette layer"),
  workspace_set: keep("global", "Gathered by the Prompt palette layer"),

  input_clear: keep("input", "Clears a non-empty composer; app_exit owns the same key when it is empty"),
  input_paste: keep("input"),
  input_submit: keep("input"),
  input_newline: keep(
    "input",
    "Also bound to keypad Enter and linefeed (what legacy terminals send for ctrl+j) by fixed extras in keymap.tsx",
  ),
  input_move_left: change("input", "ctrl+b removed from the default and from the layer (tmux prefix, drawer toggle)"),
  input_move_right: change(
    "input",
    "ctrl+f removed from the default and from the layer (list favorite, permission fullscreen)",
  ),
  input_move_up: keep("input", "Shares `up` with history_previous, which only acts on the first line"),
  input_move_down: keep("input", "Shares `down` with history_next, which only acts on the last line"),
  input_select_left: keep("input"),
  input_select_right: keep("input"),
  input_select_up: keep("input"),
  input_select_down: keep("input"),
  input_line_home: keep("input"),
  input_line_end: keep("input"),
  input_select_line_home: keep("input"),
  input_select_line_end: keep("input"),
  input_visual_line_home: keep("input", CMD_ARROW),
  input_visual_line_end: keep("input", CMD_ARROW),
  input_select_visual_line_home: keep("input", CMD_ARROW),
  input_select_visual_line_end: keep("input", CMD_ARROW),
  input_buffer_home: keep("input", CMD_ARROW),
  input_buffer_end: keep("input", CMD_ARROW),
  input_select_buffer_home: keep("input", CMD_ARROW),
  input_select_buffer_end: keep("input", CMD_ARROW),
  input_delete_line: keep("input"),
  input_delete_to_line_end: keep("input"),
  input_delete_to_line_start: keep("input"),
  input_backspace: keep("input"),
  input_delete: change(
    "input",
    "ctrl+d removed from the default and from the layer; ctrl+d is exit-only while the composer is empty",
  ),
  input_undo: keep("input"),
  input_redo: keep("input"),
  input_word_forward: keep("input"),
  input_word_backward: keep("input"),
  input_select_word_forward: keep("input"),
  input_select_word_backward: keep("input"),
  input_delete_word_forward: keep("input"),
  input_delete_word_backward: keep("input"),
  input_select_all: keep("input"),
  history_previous: keep(
    "input",
    "Acts only on the first line; otherwise returns false so input_move_up handles the key",
  ),
  history_next: keep("input", "Acts only on the last line; otherwise returns false so input_move_down handles the key"),

  "dialog.select.prev": change(
    "modal:list",
    "ctrl+p removed from the default (command palette); dormant: panel/list.tsx hard-codes its navigation keys",
  ),
  "dialog.select.next": change(
    "modal:list",
    "ctrl+n removed from the default; dormant: panel/list.tsx hard-codes its navigation keys",
  ),
  "dialog.select.page_up": keep("modal:list", "Dormant: panel/list.tsx hard-codes its navigation keys"),
  "dialog.select.page_down": keep("modal:list", "Dormant: panel/list.tsx hard-codes its navigation keys"),
  "dialog.select.home": keep("modal:list", "Dormant: panel/list.tsx hard-codes its navigation keys"),
  "dialog.select.end": keep("modal:list", "Dormant: panel/list.tsx hard-codes its navigation keys"),
  "dialog.select.submit": keep("modal:list", "Dormant: panel/list.tsx hard-codes its navigation keys"),
  "dialog.prompt.submit": keep("modal:detail", "Dormant: panel/detail.tsx hard-codes the input submit key"),
  "dialog.mcp.toggle": keep("modal:mcp"),
  "dialog.move_session.new": keep("modal:move-session"),
  "dialog.move_session.delete": keep("modal:move-session"),
  "dialog.move_session.refresh": keep("modal:move-session"),
  "prompt.autocomplete.prev": change("autocomplete", "ctrl+p removed from the default (command palette)"),
  "prompt.autocomplete.next": change("autocomplete", "ctrl+n removed from the default"),
  "prompt.autocomplete.hide": keep("autocomplete", "Escape chain level 1"),
  "prompt.autocomplete.select": keep("autocomplete"),
  "prompt.autocomplete.complete": keep("autocomplete"),
  "permission.prompt.fullscreen": keep("ask", "Dormant: the permission prompt hard-codes ctrl+f"),

  terminal_suspend: keep("global"),
  terminal_title_toggle: keep("global"),
} as const satisfies Record<KeybindName, DispositionEntry>
