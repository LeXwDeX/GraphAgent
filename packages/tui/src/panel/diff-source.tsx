// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { DiffMode } from "../context/route"
import { t } from "../i18n"
import { usePanelHost } from "./host"
import { ListPanel, type ListItem } from "./list"

export interface DiffSourceItem {
  mode: DiffMode
  title: string
  description?: string
}

export interface DiffSourcePanelProps {
  current: DiffMode
  options: readonly DiffSourceItem[]
  onSelect(mode: DiffMode): void
}

/** Diff viewer source picker: marks the active source and switches on select. */
export function DiffSourcePanel(props: DiffSourcePanelProps) {
  const host = usePanelHost()

  const items = (): ListItem<DiffMode>[] =>
    props.options.map((option) => ({
      id: option.mode,
      value: option.mode,
      title: option.title,
      description: option.description,
    }))

  return (
    <ListPanel
      title={t("diff.switch.title")}
      items={items()}
      current={props.current}
      filter={false}
      onSelect={(item) => {
        props.onSelect(item.value)
        host.close()
      }}
    />
  )
}
