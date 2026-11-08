import { describe, expect, test } from "bun:test"
import { TuiKeybind } from "../src/config/keybind"

// Names retired from the default keybind surface by the #886 PR3 migration.
// The commands they used to map to may still exist; only the config-facing
// names are gone, so overrides of these names must not be accepted silently
// by the keybind schema.
const RETIRED = [
  "docs_open",
  "dag_open",
  "dag_close",
  "dag_enter",
  "dag_down",
  "dag_up",
  "dag_next_workflow",
  "dag_previous_workflow",
  "sidebar_toggle",
  "session_parent",
  "session_child_cycle",
  "session_child_cycle_reverse",
  "tips_toggle",
  "which_key_toggle",
  "which_key_layout_toggle",
  "which_key_pending_toggle",
  "which_key_group_previous",
  "which_key_group_next",
  "which_key_scroll_up",
  "which_key_scroll_down",
  "which_key_page_up",
  "which_key_page_down",
  "which_key_home",
  "which_key_end",
] as const

describe("keybind disposition", () => {
  test("retires the names removed from the default keybind surface", () => {
    const overrides = Object.fromEntries(RETIRED.map((name) => [name, "none"]))
    expect(TuiKeybind.unknownKeys(overrides)).toEqual([...RETIRED])
  })

  test("keeps the curated definition and command counts", () => {
    expect(Object.keys(TuiKeybind.Definitions)).toHaveLength(162)
    expect(Object.keys(TuiKeybind.CommandMap)).toHaveLength(143)

    const unmapped = Object.keys(TuiKeybind.Definitions).filter((name) => !(name in TuiKeybind.CommandMap))
    expect(unmapped).toHaveLength(19)
    expect(unmapped).toContain("leader")
  })

  test("applies the audited defaults", () => {
    expect(TuiKeybind.defaultValue("help_show")).toBe("?")
    expect(TuiKeybind.defaultValue("session_background")).toBe("<leader>w")
    expect(TuiKeybind.defaultValue("input_move_left")).toBe("left")
    expect(TuiKeybind.defaultValue("input_move_right")).toBe("right")
    expect(TuiKeybind.defaultValue("input_delete")).toBe("delete,shift+delete")
    expect(TuiKeybind.defaultValue("dialog.select.prev")).toBe("up")
    expect(TuiKeybind.defaultValue("dialog.select.next")).toBe("down")
    expect(TuiKeybind.defaultValue("prompt.autocomplete.prev")).toBe("up")
    expect(TuiKeybind.defaultValue("prompt.autocomplete.next")).toBe("down")
  })

  test("registers the three new commands", () => {
    expect(TuiKeybind.defaultValue("session_drawer_toggle")).toBe("ctrl+b,<leader>b")
    expect(TuiKeybind.CommandMap.session_drawer_toggle).toBe("session.drawer.toggle")
    expect(TuiKeybind.defaultValue("session_dagmode_toggle")).toBe("<leader>d")
    expect(TuiKeybind.CommandMap.session_dagmode_toggle).toBe("session.dagmode.toggle")
    expect(TuiKeybind.defaultValue("view_expand_toggle")).toBe("ctrl+o")
    expect(TuiKeybind.CommandMap.view_expand_toggle).toBe("view.expand.toggle")
  })
})
