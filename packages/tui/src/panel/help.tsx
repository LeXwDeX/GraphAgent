// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, createSignal, type Accessor } from "solid-js"
import { commandTitle, slashCommandEntries } from "../commands/registry"
import { useCommands, useCommandScope } from "../commands/context"
import { useTuiConfig } from "../config"
import { t } from "../i18n"
import { formatKeyBindings, useKeymapSelector } from "../keymap"
import { DetailPanel, type DetailRow } from "./detail"

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export interface ShortcutEntry {
  /** The keymap command name. */
  id: string
  /** The command's bindings as the keymap shows them now, overrides included. */
  keys: string
  title: string
  /** The command's own description, when it has one. */
  note?: string
  /** The command's category; empty when it has none. */
  group: string
}

/**
 * The shortcuts a user can press, read from the keymap as it is now: no command that is hidden, has no title, belongs
 * to the panels (`Panel`) or has no binding. Ordered by category, then by title. `/help` and the shortcuts tab of
 * `/config` both list these, so a rebound key changes both.
 */
export function useShortcutEntries(): Accessor<ShortcutEntry[]> {
  const config = useTuiConfig()
  const entries = useKeymapSelector((keymap) => keymap.getCommandEntries({ visibility: "registered" }))

  return createMemo(() => {
    const result: ShortcutEntry[] = []
    const seen = new Set<string>()
    for (const entry of entries()) {
      const name = entry.command.name
      if (seen.has(name) || entry.command.hidden === true) continue
      const title = stringField(entry.command.title)
      if (!title) continue
      const category = stringField(entry.command.category)
      if (category === "Panel") continue
      const keys = formatKeyBindings(entry.bindings, config)
      if (!keys) continue
      seen.add(name)
      result.push({ id: name, keys, title, note: stringField(entry.command.desc), group: category ?? "" })
    }
    return result.sort((left, right) => left.group.localeCompare(right.group) || left.title.localeCompare(right.title))
  })
}

/** `/help`: shortcuts and slash commands generated from the keymap and registry. */
export function HelpPanel() {
  const registry = useCommands()
  const scope = useCommandScope()
  const [tab, setTab] = createSignal("shortcuts")

  const shortcuts = useShortcutEntries()

  const shortcutRows = createMemo<DetailRow[]>(() => {
    const result: DetailRow[] = []
    let group: string | undefined
    for (const entry of shortcuts()) {
      if (entry.group !== group) {
        group = entry.group
        if (group) result.push({ id: `group:${group}`, cells: [group], selectable: false })
      }
      result.push({ id: `shortcut:${entry.id}`, cells: [entry.keys, entry.title], note: entry.note })
    }
    return result
  })

  const commandRows = createMemo<DetailRow[]>(() =>
    slashCommandEntries(registry, scope()).map((entry) => ({
      id: `command:${entry.spec.id}`,
      cells: [entry.display, commandTitle(entry.spec)],
      value: entry.spec,
      note: entry.description,
    })),
  )

  return (
    <DetailPanel
      title={t("panel.help.title")}
      command="/help"
      tabs={[
        { id: "shortcuts", label: t("panel.help.tab.shortcuts") },
        { id: "commands", label: t("panel.help.tab.commands") },
      ]}
      activeTab={tab()}
      onTab={setTab}
      rows={tab() === "shortcuts" ? shortcutRows() : commandRows()}
      hints={[]}
    />
  )
}
