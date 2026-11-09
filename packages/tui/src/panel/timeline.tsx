// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { TextPart } from "@graphagent/sdk"
import { createMemo, onCleanup } from "solid-js"
import { useSync } from "../context/sync"
import { t } from "../i18n"
import { Locale } from "../util/locale"
import { usePanelHost } from "./host"
import { ListPanel, type ListItem } from "./list"

export interface TimelinePanelProps {
  sessionID: string
  /** Scrolls the transcript to the highlighted message (moving previews). */
  onPreview(messageID: string): void
  /** Returns the transcript to the position captured when the panel opened. */
  onRestore(): void
  /** Commits the highlighted message; the panel then closes. */
  onSelect(messageID: string): void
}

/** `/timeline`: moving previews messages in the transcript; closing restores the origin. */
export function TimelinePanel(props: TimelinePanelProps) {
  const sync = useSync()
  const host = usePanelHost()
  let confirmed = false

  onCleanup(() => {
    if (!confirmed) props.onRestore()
  })

  const items = createMemo<ListItem<string>[]>(() => {
    const messages = sync.data.message[props.sessionID] ?? []
    const result: ListItem<string>[] = []
    for (const message of messages) {
      if (message.role !== "user") continue
      const part = (sync.data.part[message.id] ?? []).find(
        (item): item is TextPart => item.type === "text" && !item.synthetic && !item.ignored,
      )
      if (!part) continue
      result.push({
        id: message.id,
        value: message.id,
        title: part.text.replace(/\n/g, " "),
        trail: Locale.time(message.time.created),
      })
    }
    return result.reverse()
  })

  return (
    <ListPanel
      title={t("panel.timeline.title")}
      command="/timeline"
      items={items()}
      onMove={(item) => props.onPreview(item.value)}
      onFilter={(value, filtered) => {
        if (value.length === 0) {
          props.onRestore()
          return
        }
        const first = filtered[0]
        if (first) props.onPreview(first.value)
        else props.onRestore()
      }}
      onSelect={(item) => {
        confirmed = true
        props.onSelect(item.value)
        host.close()
      }}
    />
  )
}
