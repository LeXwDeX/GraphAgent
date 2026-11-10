// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo } from "solid-js"
import {
  paletteCommandId,
  paletteRows,
  selectPaletteCommand,
  suggestedCommandIds,
  type PaletteOption,
} from "../commands/palette"
import { useCommandScope, useCommands } from "../commands/context"
import { commandCategoryTitle, commandDescription, commandTitle, type CommandSpec } from "../commands/registry"
import { useConnected } from "../component/use-connected"
import { useTuiConfig } from "../config"
import { usePromptRef } from "../context/prompt"
import { useRoute } from "../context/route"
import { useSync } from "../context/sync"
import { t } from "../i18n"
import { formatKeyBindings, useGraphagentKeymap } from "../keymap"
import { usePanelHost } from "./host"
import { ListPanel, type ListItem } from "./list"

/** `ctrl+p`: one registry-driven list with a suggestion group and keybinding hints. */
export function CommandPalettePanel() {
  const config = useTuiConfig()
  const keymap = useGraphagentKeymap()
  const registry = useCommands()
  const scope = useCommandScope()
  const prompt = usePromptRef()
  const route = useRoute()
  const sync = useSync()
  const connected = useConnected()
  const host = usePanelHost()

  const entries = createMemo(() => registry.list(scope()))
  const bindings = createMemo(() => {
    const ids = entries().map((spec) => spec.id)
    return keymap.getCommandBindings({ visibility: "registered", commands: ids })
  })
  const suggested = createMemo(() =>
    suggestedCommandIds({
      scope: scope(),
      hasSessions: sync.data.session.length > 0,
      connected: connected(),
    }),
  )
  const renameTitle = createMemo(() => {
    if (route.data.type !== "session") return undefined
    return sync.session.get(route.data.sessionID)?.title
  })
  const specs = createMemo(() => new Map(entries().map((spec) => [spec.id, spec])))

  const items = createMemo<ListItem<CommandSpec>[]>(() => {
    const rows = entries().map((spec): PaletteOption => ({
      id: spec.id,
      title: commandTitle(spec),
      description: commandDescription(spec),
      category: commandCategoryTitle(spec.category),
      footer: formatKeyBindings(bindings().get(spec.id) ?? [], config),
      suggested: suggested().has(spec.id),
    }))
    return paletteRows(rows).flatMap((row) => {
      const spec = specs().get(paletteCommandId(row.id))
      if (!spec) return []
      return [
        {
          id: row.id,
          value: spec,
          title: row.title,
          description: row.description,
          group: row.category,
          trail: row.footer,
        },
      ]
    })
  })

  return (
    <ListPanel
      title={t("command.palette.title")}
      items={items()}
      onSelect={(item) =>
        selectPaletteCommand({
          registry,
          spec: item.value,
          close: () => host.close(),
          prompt,
          renameTitle: renameTitle(),
        })
      }
    />
  )
}
