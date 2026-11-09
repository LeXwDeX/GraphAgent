// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, createSignal } from "solid-js"
import { usePromptStash, type StashEntry } from "../component/prompt/stash"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { useCommandShortcut } from "../keymap"
import { Locale } from "../util/locale"
import { usePanelHost } from "./host"
import { ListPanel, type ListItem } from "./list"

export interface StashPanelProps {
  onSelect(entry: StashEntry): void
}

function getRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return t("panel.stash.time.justNow")
  if (minutes < 60) return t("panel.stash.time.minutes", { count: minutes })
  if (hours < 24) return t("panel.stash.time.hours", { count: hours })
  if (days < 7) return t("panel.stash.time.days", { count: days })
  return Locale.datetime(timestamp)
}

function getStashPreview(input: string, maxLength: number = 50): string {
  const firstLine = input.split("\n")[0].trim()
  return Locale.truncate(firstLine, maxLength)
}

/** Stash list reachable from the command palette; ctrl+d deletes with a second press. */
export function StashPanel(props: StashPanelProps) {
  const stash = usePromptStash()
  const host = usePanelHost()
  const { theme } = useTheme()
  const [toDelete, setToDelete] = createSignal<number>()
  const deleteHint = useCommandShortcut("stash.delete")

  const items = createMemo<ListItem<number>[]>(() =>
    stash
      .list()
      .map((entry, index) => {
        const deleting = toDelete() === index
        const lineCount = (entry.input.match(/\n/g)?.length ?? 0) + 1
        return {
          id: `${entry.timestamp}-${index}`,
          value: index,
          title: deleting ? t("panel.stash.confirm", { key: deleteHint() }) : getStashPreview(entry.input),
          description: getRelativeTime(entry.timestamp),
          trail: lineCount > 1 ? t("panel.stash.lines", { count: lineCount }) : undefined,
          lead: deleting ? <text fg={theme.error}>●</text> : undefined,
        }
      })
      .toReversed(),
  )

  return (
    <ListPanel
      title={t("panel.stash.title")}
      items={items()}
      onMove={() => setToDelete(undefined)}
      onSelect={(item) => {
        const entry = stash.list()[item.value]
        if (entry) {
          stash.remove(item.value)
          props.onSelect(entry)
        }
        host.close()
      }}
      actions={[
        {
          key: "stash.delete",
          label: t("panel.stash.delete"),
          run: (item) => {
            if (toDelete() === item.value) {
              stash.remove(item.value)
              setToDelete(undefined)
              return
            }
            setToDelete(item.value)
          },
        },
      ]}
    />
  )
}
