// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, onCleanup } from "solid-js"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { usePanelHost } from "./host"
import { ListPanel, type ListItem } from "./list"

/** `/theme`: moving previews a theme and closing without confirming restores the original. */
export function ThemePanel() {
  const theme = useTheme()
  const host = usePanelHost()
  const initial = theme.selected
  let confirmed = false

  onCleanup(() => {
    if (!confirmed) theme.set(initial)
  })

  const items = createMemo<ListItem<string>[]>(() =>
    Object.keys(theme.all())
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }))
      .map((name) => ({ id: name, value: name, title: name })),
  )

  return (
    <ListPanel
      title={t("panel.theme.title")}
      command="/theme"
      items={items()}
      current={initial}
      onMove={(item) => theme.set(item.value)}
      onSelect={(item) => {
        theme.set(item.value)
        confirmed = true
        host.close()
      }}
      onFilter={(value, items) => {
        if (value.length === 0) {
          theme.set(initial)
          return
        }
        const first = items[0]
        if (first) theme.set(first.value)
      }}
    />
  )
}
