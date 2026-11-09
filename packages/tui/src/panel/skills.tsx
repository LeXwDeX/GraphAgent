// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { TextAttributes } from "@opentui/core"
import { createMemo, createResource, createSignal } from "solid-js"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { errorMessage } from "../util/error"
import { usePanelHost } from "./host"
import { ListPanel, type ListItem } from "./list"

export interface SkillsPanelProps {
  onSelect(skill: string): void
}

/** `/skills`: inserts the chosen skill name into the prompt. */
export function SkillsPanel(props: SkillsPanelProps) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const host = usePanelHost()
  const [loadError, setLoadError] = createSignal<unknown>()

  const [skills] = createResource(() =>
    sdk.client.app
      .skills({ throwOnError: true })
      .then((result) => result.data ?? [])
      .catch((error) => {
        setLoadError(error)
        return undefined
      }),
  )

  const items = createMemo<ListItem<string>[]>(() => {
    if (loadError()) return []
    const list = skills() ?? []
    const maxWidth = Math.max(0, ...list.map((skill) => skill.name.length))
    return list.map((skill) => ({
      id: skill.name,
      value: skill.name,
      title: skill.name.padEnd(maxWidth),
      description: skill.description?.replace(/\s+/g, " ").trim(),
    }))
  })

  const empty = createMemo(() => {
    const error = loadError()
    if (!error) return undefined
    return (
      <box paddingLeft={1} paddingRight={1} flexDirection="column">
        <text fg={theme.error} attributes={TextAttributes.BOLD}>
          {t("panel.skills.error")}
        </text>
        <text fg={theme.textMuted}>{errorMessage(error)}</text>
      </box>
    )
  })

  return (
    <ListPanel
      title={t("panel.skills.title")}
      command="/skills"
      items={items()}
      filter={{ placeholder: t("panel.skills.filter") }}
      loading={skills.loading && !loadError()}
      empty={empty()}
      onSelect={(item) => {
        props.onSelect(item.value)
        host.close()
      }}
    />
  )
}
