// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo } from "solid-js"
import { useConnected } from "../component/use-connected"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { t } from "../i18n"
import { sortModelOptions } from "../util/model-options"
import { usePanelHost } from "./host"
import { ListPanel, type ListItem } from "./list"

export interface ModelRef {
  providerID: string
  modelID: string
}

export interface ModelPanelProps {
  /** Set after connecting a provider: list only that provider's models, newest first. */
  providerID?: string
  /** Opens the provider panel. */
  onConnectProvider(): void
  /** Variant selection still lives in the dialog flow for now. */
  onVariant(): void
}

type Candidate = {
  id: string
  value: ModelRef
  title: string
  description?: string
  group?: string
  footer?: string
  releaseDate: string | number
}

/** `/model`: favorites, recents and every configured model in one list. */
export function ModelPanel(props: ModelPanelProps) {
  const local = useLocal()
  const sync = useSync()
  const host = usePanelHost()
  const connected = useConnected()

  const favorites = createMemo(() => (connected() ? local.model.favorite() : []))

  const candidates = createMemo<Candidate[]>(() => {
    const favoriteList = favorites()
    const recentList = local.model.recent()
    // After connecting, hide favorites/recents so the new provider's models lead.
    const showExtra = connected() && !props.providerID
    const isFavorite = (ref: ModelRef) =>
      favoriteList.some((item) => item.providerID === ref.providerID && item.modelID === ref.modelID)
    const isRecent = (ref: ModelRef) =>
      recentList.some((item) => item.providerID === ref.providerID && item.modelID === ref.modelID)

    const favoriteOptions: Candidate[] = showExtra
      ? favoriteList.flatMap((item) => {
          const provider = sync.data.provider.find((entry) => entry.id === item.providerID)
          const model = provider?.models[item.modelID]
          if (!provider || !model) return []
          return [
            {
              id: `${provider.id}/${model.id}`,
              value: { providerID: provider.id, modelID: model.id },
              title: model.name ?? item.modelID,
              description: provider.name,
              group: t("panel.model.group.favorites"),
              releaseDate: model.release_date,
              footer: model.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            },
          ]
        })
      : []

    const recentOptions: Candidate[] = showExtra
      ? recentList
          .filter((item) => !isFavorite(item))
          .flatMap((item) => {
            const provider = sync.data.provider.find((entry) => entry.id === item.providerID)
            const model = provider?.models[item.modelID]
            if (!provider || !model) return []
            return [
              {
                id: `${provider.id}/${model.id}`,
                value: { providerID: provider.id, modelID: model.id },
                title: model.name ?? item.modelID,
                description: provider.name,
                group: t("panel.model.group.recent"),
                releaseDate: model.release_date,
                footer: model.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
              },
            ]
          })
      : []

    const modelOptions = sync.data.provider
      .filter((provider) => !props.providerID || provider.id === props.providerID)
      .toSorted((left, right) => {
        const opencode = Number(left.id !== "opencode") - Number(right.id !== "opencode")
        return opencode || left.name.localeCompare(right.name)
      })
      .flatMap((provider) =>
        sortModelOptions(
          Object.entries(provider.models)
            .filter(([, info]) => info.status !== "deprecated")
            .map(([modelID, info]) => {
              const ref = { providerID: provider.id, modelID }
              return {
                id: `${provider.id}/${modelID}`,
                value: ref,
                title: info.name ?? modelID,
                description: isFavorite(ref) ? t("panel.model.favorite.mark") : connected() ? undefined : provider.name,
                group: connected() ? provider.name : undefined,
                releaseDate: info.release_date,
                footer: info.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
              } satisfies Candidate
            })
            .filter(
              (option) => !connected() || props.providerID || (!isFavorite(option.value) && !isRecent(option.value)),
            ),
          props.providerID !== undefined,
        ),
      )

    return [...favoriteOptions, ...recentOptions, ...modelOptions]
  })

  const items = createMemo<ListItem<ModelRef>[]>(() =>
    candidates().map((candidate) => ({
      id: candidate.id,
      value: candidate.value,
      title: candidate.title,
      description: candidate.description,
      group: candidate.group,
      trail: candidate.footer === "Free" ? t("panel.model.free") : undefined,
      disabled: candidate.value.providerID === "opencode" && candidate.value.modelID.includes("-nano"),
    })),
  )

  async function select(item: ListItem<ModelRef>) {
    if (!(await local.model.set(item.value, { recent: true, source: "picker" }))) return
    const list = local.model.variant.list()
    const current = local.model.variant.selected()
    host.close()
    if (current === "default" || (current && list.includes(current))) return
    if (list.length > 0) props.onVariant()
  }

  // A provider-scoped list is titled with the provider, matching the connect flow.
  const title = createMemo(() => {
    if (!props.providerID) return t("panel.model.title")
    return sync.data.provider.find((entry) => entry.id === props.providerID)?.name ?? t("panel.model.title")
  })

  return (
    <ListPanel
      title={title()}
      command="/model"
      items={items()}
      current={local.model.current()}
      onSelect={(item) => void select(item)}
      actions={[
        {
          key: "model.dialog.provider",
          label: connected() ? t("panel.model.provider.connect") : t("panel.model.provider.all"),
          run: () => {
            host.close()
            props.onConnectProvider()
          },
        },
        {
          key: "model.dialog.favorite",
          label: t("panel.model.favorite"),
          when: () => connected(),
          run: (item) => local.model.toggleFavorite(item.value),
        },
      ]}
    />
  )
}
