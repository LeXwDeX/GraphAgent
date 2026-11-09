// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { t } from "../i18n"
import { ListPanel, type ListItem } from "./list"
import { usePanelHost } from "./host"

/** `/agent`: picks the primary agent for the current scope. */
export function AgentPanel() {
  const local = useLocal()
  const host = usePanelHost()

  const items = createMemo<ListItem<string>[]>(() =>
    local.agent.list().map((agent) => ({
      id: agent.name,
      value: agent.name,
      title: agent.name,
      description: agent.native ? t("panel.agent.native") : agent.description,
    })),
  )

  return (
    <ListPanel
      title={t("panel.agent.title")}
      command="/agent"
      items={items()}
      current={local.agent.current()?.name}
      onSelect={(item) => {
        local.agent.set(item.value)
        host.close()
      }}
    />
  )
}
