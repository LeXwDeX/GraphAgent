// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, createSignal } from "solid-js"
import { commandTitle, slashCommandEntries } from "../commands/registry"
import { useCommands, useCommandScope } from "../commands/context"
import { useTuiConfig } from "../config"
import { t } from "../i18n"
import { formatKeyBindings, useKeymapSelector } from "../keymap"
import { DetailPanel, type DetailRow } from "./detail"

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** `/help`: shortcuts and slash commands generated from the keymap and registry. */
export function HelpPanel() {
  const registry = useCommands()
  const scope = useCommandScope()
  const config = useTuiConfig()
  const [tab, setTab] = createSignal("shortcuts")

  const entries = useKeymapSelector((keymap) => keymap.getCommandEntries({ visibility: "registered" }))

  const shortcutRows = createMemo<DetailRow[]>(() => {
    const groups = new Map<string, { id: string; keys: string; title: string; note?: string }[]>()
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
      const group = category ?? ""
      const rows = groups.get(group) ?? []
      rows.push({ id: `shortcut:${name}`, keys, title, note: stringField(entry.command.desc) })
      groups.set(group, rows)
    }

    const result: DetailRow[] = []
    for (const [group, rows] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
      if (group) result.push({ id: `group:${group}`, cells: [group], selectable: false })
      for (const row of rows.sort((left, right) => left.title.localeCompare(right.title))) {
        result.push({ id: row.id, cells: [row.keys, row.title], note: row.note })
      }
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
