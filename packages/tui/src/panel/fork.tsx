// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Part, TextPart } from "@graphagent/sdk"
import { createMemo } from "solid-js"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { t } from "../i18n"
import type { PromptInfo } from "../prompt/history"
import { stripPromptPartIDs as strip } from "../prompt/part"
import { Locale } from "../util/locale"
import { usePanelHost } from "./host"
import { ListPanel, type ListItem } from "./list"

export interface ForkPanelProps {
  sessionID: string
  /** Scrolls the transcript to the highlighted message; undefined previews nothing. */
  onPreview(messageID?: string): void
}

/** `/fork`: the first row forks the whole session, the rest fork from a user message. */
export function ForkPanel(props: ForkPanelProps) {
  const sync = useSync()
  const sdk = useSDK()
  const route = useRoute()
  const host = usePanelHost()

  const items = createMemo<ListItem<string | undefined>[]>(() => {
    const messages = sync.data.message[props.sessionID] ?? []
    const result: ListItem<string | undefined>[] = []
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
    return [{ id: "full-session", value: undefined, title: t("panel.fork.full") }, ...result.reverse()]
  })

  function promptFrom(parts: readonly Part[]): PromptInfo {
    return parts.reduce<PromptInfo>(
      (agg, part) => {
        if (part.type === "text") {
          if (!part.synthetic) agg.input += part.text
        }
        if (part.type === "file") agg.parts.push(strip(part))
        return agg
      },
      { input: "", parts: [] },
    )
  }

  async function fork(item: ListItem<string | undefined>) {
    if (item.value === undefined) {
      const forked = await sdk.client.session.fork({ sessionID: props.sessionID })
      route.navigate({ sessionID: forked.data!.id, type: "session" })
      host.close()
      return
    }
    const forked = await sdk.client.session.fork({ sessionID: props.sessionID, messageID: item.value })
    const prompt = promptFrom(sync.data.part[item.value] ?? [])
    route.navigate({ sessionID: forked.data!.id, type: "session", prompt })
    host.close()
  }

  return (
    <ListPanel
      title={t("panel.fork.title")}
      command="/fork"
      items={items()}
      onMove={(item) => props.onPreview(item.value)}
      onFilter={(_, filtered) => {
        const first = filtered[0]
        if (first) props.onPreview(first.value)
      }}
      onSelect={(item) => void fork(item)}
    />
  )
}
