// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { t } from "../i18n"
import { usePanelHost } from "./host"
import { ListPanel, type ListItem } from "./list"

/**
 * Model variant picker. `/variants` is gone; this panel is reached from
 * `/config`'s equivalent flow (the model picker) and the `variant.list` keymap
 * command, while `variant.cycle` keeps its shortcut.
 */
export function VariantPanel() {
  const local = useLocal()
  const host = usePanelHost()

  const items = createMemo<ListItem<string>[]>(() => [
    { id: "default", value: "default", title: t("panel.variant.default") },
    ...local.model.variant.list().map((variant) => ({ id: variant, value: variant, title: variant })),
  ])

  return (
    <ListPanel
      title={t("panel.variant.title")}
      items={items()}
      current={local.model.variant.current() ?? "default"}
      onSelect={(item) => {
        host.close()
        local.model.variant.set(item.value === "default" ? undefined : item.value)
      }}
    />
  )
}
