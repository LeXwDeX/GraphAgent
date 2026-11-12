// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createTestRenderer } from "@opentui/core/testing"
import { stringifyKeyStroke, type KeySequencePart } from "@opentui/keymap"
import { createBindingLookup } from "@opentui/keymap/extras"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { TuiKeybind } from "../src/config/keybind"
import {
  Disposition,
  Layers,
  REMOVED,
  type DispositionEntry,
  type KeybindLayer,
} from "../src/config/keybind-disposition"
import { registerGraphagentKeymap } from "../src/keymap"

const definitions: Readonly<Record<string, { default: unknown }>> = TuiKeybind.Definitions
const definitionNames = Object.keys(definitions)
const commandMap: Readonly<Record<string, string>> = TuiKeybind.CommandMap
const table: Readonly<Record<string, DispositionEntry>> = Disposition
const layerNames = Object.keys(Layers).filter((name): name is KeybindLayer => name in Layers)

/** Definitions without a `CommandMap` entry; their config name doubles as the command name. */
const UNMAPPED = [
  "leader",
  "dialog.select.prev",
  "dialog.select.next",
  "dialog.select.page_up",
  "dialog.select.page_down",
  "dialog.select.home",
  "dialog.select.end",
  "dialog.select.submit",
  "dialog.prompt.submit",
  "dialog.mcp.toggle",
  "dialog.move_session.new",
  "dialog.move_session.delete",
  "dialog.move_session.refresh",
  "prompt.autocomplete.prev",
  "prompt.autocomplete.next",
  "prompt.autocomplete.hide",
  "prompt.autocomplete.select",
  "prompt.autocomplete.complete",
  "permission.prompt.fullscreen",
]

/** Name families that must not come back, even under a new suffix. */
const RETIRED_FAMILIES = [/^dag_/, /^which_key_/, /^plugin/, /^dialog\.plugins\./]

function readSchemaKeybinds() {
  const file = path.resolve(import.meta.dir, "../../../schema/tui.json")
  return Object.keys(JSON.parse(readFileSync(file, "utf8")).properties.keybinds.properties)
}

type Claim = { name: string; sequence: string }

function formatSequence(parts: readonly KeySequencePart[]) {
  return parts.map((part) => (part.tokenName ? `<${part.tokenName}>` : stringifyKeyStroke(part.stroke))).join(" ")
}

/**
 * Every key sequence each definition claims at its defaults, canonicalised by the real keymap (comma lists, key
 * aliases, leader token). The managed textarea layer appends the library's own textarea bindings after ours. Those
 * that no definition overrides are live in the `input` layer although no default lists them, so they are claimed on
 * behalf of the definition that owns the command.
 */
async function readClaims(): Promise<Claim[]> {
  const setup = await createTestRenderer({ width: 40, height: 10 })
  try {
    const keymap = createDefaultOpenTuiKeymap(setup.renderer)
    const keybinds = createBindingLookup(TuiKeybind.toBindingConfig(TuiKeybind.parse({})), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    })
    const dispose = registerGraphagentKeymap(keymap, setup.renderer, { keybinds, leader_timeout: 2000 })
    try {
      const own = new Map<string, Set<string>>()
      for (const name of definitionNames) {
        // A unique command name keeps other layers' bindings for the same command out of the result.
        const probe = `probe:${name}`
        const bindings = keybinds.get(commandMap[name] ?? name).map((binding) => ({ ...binding, cmd: probe }))
        const disposeProbe = keymap.registerLayer({ bindings })
        const found = keymap.getCommandBindings({ visibility: "registered", commands: [probe] }).get(probe) ?? []
        disposeProbe()
        own.set(name, new Set(found.map((binding) => formatSequence(binding.sequence))))
      }

      const managed = Object.entries(commandMap).filter(([, command]) => command.startsWith("input."))
      const registered = keymap.getCommandBindings({
        visibility: "registered",
        commands: managed.map(([, command]) => command),
      })
      const overridden = new Set(managed.flatMap(([name]) => [...own.get(name)!]))
      const claims: Claim[] = []
      for (const [name, sequences] of own) for (const sequence of sequences) claims.push({ name, sequence })
      for (const [name, command] of managed) {
        const sequences = new Set((registered.get(command) ?? []).map((binding) => formatSequence(binding.sequence)))
        for (const sequence of sequences) if (!overridden.has(sequence)) claims.push({ name, sequence })
      }
      return claims
    } finally {
      dispose()
    }
  } finally {
    setup.renderer.destroy()
  }
}

type Conflict = { sequence: string; names: string[] }

const identity = (conflict: Conflict) => `${conflict.sequence} <- ${[...conflict.names].sort().join(", ")}`

/** A conflict is one key sequence claimed by several definitions inside one layer context (a layer plus its coactive layers). */
function findConflicts(claims: readonly Claim[]): Conflict[] {
  const found = new Map<string, Conflict>()
  for (const layer of layerNames) {
    const scope = new Set<KeybindLayer>([layer, ...Layers[layer].coactive])
    const claimants = new Map<string, Set<string>>()
    for (const claim of claims) {
      const owner = table[claim.name]?.layer
      if (owner === undefined || !scope.has(owner)) continue
      claimants.set(claim.sequence, (claimants.get(claim.sequence) ?? new Set()).add(claim.name))
    }
    for (const [sequence, names] of claimants) {
      if (names.size < 2) continue
      const conflict = { sequence, names: [...names].sort() }
      found.set(identity(conflict), conflict)
    }
  }
  return [...found.values()].sort((a, b) => identity(a).localeCompare(identity(b)))
}

/**
 * Same-context key sharing that exists at the current defaults. "by design" entries follow the spec: the owners'
 * `enabled` predicates or a command that declines keep the two meanings apart. "defect" entries contradict the spec
 * and stay listed until their fix lands; the stale-entry test then forces the removal. No default was changed to hide
 * any of them.
 */
const KNOWN_CONFLICTS: ReadonlyArray<Conflict & { kind: "by design" | "defect"; reason: string; issue: string }> = [
  {
    sequence: "up",
    names: ["history_previous", "input_move_up"],
    kind: "by design",
    reason:
      "history_previous acts only on the first line and returns false otherwise, so input_move_up handles the key " +
      "(spec 4.4 keeps this).",
    issue: "#886",
  },
  {
    sequence: "down",
    names: ["history_next", "input_move_down"],
    kind: "by design",
    reason:
      "history_next acts only on the last line and returns false otherwise, so input_move_down handles the key " +
      "(spec 4.4 keeps this).",
    issue: "#886",
  },
  {
    sequence: "ctrl+c",
    names: ["app_exit", "input_clear"],
    kind: "by design",
    reason:
      "Stateful key: input_clear while the composer holds text, app_exit while it is empty or unfocused. The two " +
      "layers have complementary enabled predicates (spec 4.4 global table).",
    issue: "#886",
  },
  {
    sequence: "home",
    names: ["input_buffer_home", "messages_first"],
    kind: "defect",
    reason:
      "session.first is gathered into the always-on session layer as well as session.global.unfocused, so Home in a " +
      "focused composer scrolls the transcript instead of moving the cursor (verified against the real keymap). " +
      "Plain home belongs in the unfocused layer only; ctrl+g stays always-on (spec 4.4).",
    issue: "#886",
  },
  {
    sequence: "end",
    names: ["input_buffer_end", "messages_last"],
    kind: "defect",
    reason:
      "Same as home: session.last is also gathered into the always-on session layer, so End in a focused composer " +
      "scrolls the transcript. Plain end belongs in the unfocused layer only; ctrl+alt+g stays always-on.",
    issue: "#886",
  },
  {
    sequence: "ctrl+b",
    names: ["input_move_left", "session_drawer_toggle"],
    kind: "defect",
    reason:
      "The managed textarea layer appends the library's emacs defaults, so ctrl+b still moves the cursor left " +
      "although input_move_left no longer lists it. Inside a session the newer drawer layer wins; on the home route " +
      "there is no drawer layer and the cursor moves (spec 4.2 and 4.3).",
    issue: "#886",
  },
  {
    sequence: "ctrl+d",
    names: ["app_exit", "input_delete"],
    kind: "defect",
    reason:
      "The library default ctrl+d (delete forward) stays live in a non-empty composer; app_exit takes the key only " +
      "while the composer is empty. Spec 4.3 reserves ctrl+d for exit and leaves deletion to `delete`.",
    issue: "#886",
  },
  {
    sequence: "tab",
    names: ["agent_cycle", "diff_switch_focus"],
    kind: "by design",
    reason:
      "agent.cycle is live on the diff route too; diff.switch_focus wins only because the diff layer registers " +
      "later. Spec 4.4 checks diff keys inside the route only. Fragile: give the diff layer an explicit priority.",
    issue: "#886",
  },
  {
    sequence: "?",
    names: ["diff_help", "help_show"],
    kind: "by design",
    reason: "help.show is disabled on the diff route by its enabled predicate, so diff_help owns `?` there.",
    issue: "#886",
  },
]

/**
 * The keys named by the spec's uniqueness criterion, with every layer that claims them at the current defaults. The
 * `input` entries for ctrl+b and ctrl+d are library textarea defaults, listed again in KNOWN_CONFLICTS.
 */
const FOCUS_KEYS: Record<string, Partial<Record<KeybindLayer, string[]>>> = {
  "ctrl+b": { input: ["input_move_left"], session: ["session_drawer_toggle"] },
  "ctrl+d": {
    global: ["app_exit"],
    input: ["input_delete"],
    "modal:move-session": ["dialog.move_session.delete"],
    "modal:session-list": ["session_delete"],
    "modal:stash": ["stash_delete"],
  },
  left: { diff: ["diff_collapse"], input: ["input_move_left"] },
  right: { diff: ["diff_expand"], input: ["input_move_right"] },
  up: {
    autocomplete: ["prompt.autocomplete.prev"],
    input: ["history_previous", "input_move_up"],
    "modal:list": ["dialog.select.prev"],
  },
}

describe("keybind disposition", () => {
  test("retires the names removed from the default keybind surface", () => {
    const overrides = Object.fromEntries(REMOVED.map((name) => [name, "none"]))
    expect(TuiKeybind.unknownKeys(overrides)).toEqual([...REMOVED])
  })

  test("keeps the curated definition and command counts", () => {
    expect(definitionNames).toHaveLength(162)
    expect(Object.keys(commandMap)).toHaveLength(143)
  })

  test("pins the definitions that have no command mapping", () => {
    expect(definitionNames.filter((name) => !(name in commandMap))).toEqual(UNMAPPED)
  })

  test("maps each command once and only for known definitions", () => {
    const commands = Object.values(commandMap)
    expect(new Set(commands).size).toBe(commands.length)
    expect(Object.keys(commandMap).filter((name) => !definitionNames.includes(name))).toEqual([])
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

  test("the generated schema lists exactly the definitions", () => {
    expect(readSchemaKeybinds().sort()).toEqual([...definitionNames].sort())
  })
})

describe("disposition table", () => {
  test("has exactly one entry for every definition", () => {
    const entries = Object.keys(table)
    expect({
      missing: definitionNames.filter((name) => !entries.includes(name)),
      extra: entries.filter((name) => !definitionNames.includes(name)),
    }).toEqual({ missing: [], extra: [] })
  })

  test("marks only valid dispositions and known layers", () => {
    const invalid = Object.entries(table)
      .filter(
        ([, entry]) => !["keep", "change", "new"].includes(entry.disposition) || !layerNames.includes(entry.layer),
      )
      .map(([name]) => name)
    expect(invalid).toEqual([])
  })

  test("pins the changed and new definitions of the v2 plan", () => {
    const named = (disposition: string) => definitionNames.filter((name) => table[name].disposition === disposition)
    expect(named("new")).toEqual(["session_drawer_toggle", "view_expand_toggle", "session_dagmode_toggle"])
    expect(named("change")).toEqual([
      "help_show",
      "session_rename",
      "session_delete",
      "session_background",
      "session_pin_toggle",
      "stash_delete",
      "model_provider_list",
      "model_favorite_toggle",
      "input_move_left",
      "input_move_right",
      "input_delete",
      "dialog.select.prev",
      "dialog.select.next",
      "prompt.autocomplete.prev",
      "prompt.autocomplete.next",
    ])
    expect(named("keep")).toHaveLength(144)
  })

  test("declares only layers that are used and coactive layers that exist", () => {
    const used = new Set(Object.values(table).map((entry) => entry.layer))
    expect(layerNames.filter((layer) => !used.has(layer))).toEqual([])
    const malformed = layerNames.filter((layer) => {
      const { coactive, summary } = Layers[layer]
      return (
        summary.trim() === "" ||
        new Set(coactive).size !== coactive.length ||
        coactive.some((other) => other === layer || !layerNames.includes(other))
      )
    })
    expect(malformed).toEqual([])
  })

  test("keeps removed names out of every key surface", () => {
    const removed: readonly string[] = REMOVED
    const schemaKeys = readSchemaKeybinds()
    expect(new Set(removed).size).toBe(removed.length)
    expect(removed.filter((name) => definitionNames.includes(name))).toEqual([])
    expect(removed.filter((name) => name in commandMap)).toEqual([])
    expect(removed.filter((name) => schemaKeys.includes(name))).toEqual([])
    expect(removed.filter((name) => name in table)).toEqual([])
    expect(definitionNames.filter((name) => RETIRED_FAMILIES.some((family) => family.test(name)))).toEqual([])
  })
})

describe("layer uniqueness", () => {
  let claims: Claim[]
  let found: string[]

  beforeAll(async () => {
    claims = await readClaims()
    found = findConflicts(claims).map(identity)
  })

  const sequencesOf = (name: string) => claims.filter((claim) => claim.name === name).map((claim) => claim.sequence)

  test("reads a sequence for every definition whose default is not none", () => {
    const claimed = new Set(claims.map((claim) => claim.name))
    const unbound = definitionNames.filter((name) => definitions[name].default === "none")
    expect(definitionNames.filter((name) => !claimed.has(name))).toEqual(unbound)
  })

  test("canonicalises comma lists, key aliases and leader sequences", () => {
    expect(sequencesOf("app_exit").sort()).toEqual(["<leader> q", "ctrl+c", "ctrl+d"])
    expect(sequencesOf("diff_toggle").sort()).toEqual(["enter", "space"])
    expect(sequencesOf("session_interrupt").sort()).toEqual(["escape", "meta+escape"])
  })

  test("claims the library textarea defaults that no definition overrides", () => {
    expect(sequencesOf("input_move_left").sort()).toEqual(["ctrl+b", "left"])
    expect(sequencesOf("input_delete")).toContain("ctrl+d")
    // An explicit definition wins over the library default for the same key.
    expect(sequencesOf("input_newline")).not.toContain("enter")
    expect(sequencesOf("input_submit")).not.toContain("meta+enter")
  })

  test("no key is claimed twice in one layer context unless it is a known conflict", () => {
    // Fix the default or the owner's registration, or add a KNOWN_CONFLICTS entry with its reason.
    const known = new Set(KNOWN_CONFLICTS.map(identity))
    expect(found.filter((conflict) => !known.has(conflict))).toEqual([])
  })

  test("every known conflict is still real", () => {
    // A fixed conflict must leave KNOWN_CONFLICTS, so the list never hides a regression later.
    expect(KNOWN_CONFLICTS.map(identity).filter((conflict) => !found.includes(conflict))).toEqual([])
  })

  test("every known conflict explains itself", () => {
    const identities = KNOWN_CONFLICTS.map(identity)
    expect(new Set(identities).size).toBe(identities.length)
    for (const known of KNOWN_CONFLICTS) {
      expect(known.names.length).toBeGreaterThan(1)
      expect(known.reason.trim()).not.toBe("")
      expect(known.issue).toMatch(/^#\d+$/)
    }
  })

  test("ctrl+b, ctrl+d, left, right and up are claimed once per layer apart from the known conflicts", () => {
    const layersOf = (key: string) => {
      const result: Partial<Record<KeybindLayer, string[]>> = {}
      for (const claim of claims) {
        if (claim.sequence !== key) continue
        const layer = table[claim.name]?.layer
        if (layer === undefined) continue
        result[layer] = [...(result[layer] ?? []), claim.name].sort()
      }
      return result
    }
    const actual = Object.fromEntries(Object.keys(FOCUS_KEYS).map((key) => [key, layersOf(key)]))
    expect(actual).toEqual(FOCUS_KEYS)

    const doubled = Object.entries(actual).flatMap(([key, layers]) =>
      Object.entries(layers)
        .filter(([, names]) => names.length > 1)
        .map(([layer, names]) => `${key} in ${layer}: ${names.join(", ")}`),
    )
    expect(doubled).toEqual(["up in input: history_previous, input_move_up"])
  })
})
