// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Workspace } from "@graphagent/sdk"
import { createMemo, createSignal, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useProject } from "../context/project"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { useCommandShortcut } from "../keymap"
import { errorMessage } from "../util/error"
import { useToast } from "../ui/toast"
import { ListPanel, type ListItem } from "./list"

/** `/workspaces`: lists workspaces, expands details and deletes with a second ctrl+d. */
export function WorkspacesPanel() {
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const project = useProject()
  const { theme } = useTheme()
  const deleteHint = useCommandShortcut("session.delete")
  const [deleting, setDeleting] = createSignal<string>()
  const [removing, setRemoving] = createSignal<string>()
  const [expanded, setExpanded] = createStore<Record<string, boolean>>({})

  const current = createMemo(() => {
    const id =
      route.data.type === "session" ? sync.session.get(route.data.sessionID)?.workspaceID : project.workspace.current()
    if (!id) return undefined
    return project.workspace.list().find((workspace) => workspace.id === id)
  })

  const items = createMemo<ListItem<Workspace>[]>(() =>
    project.workspace
      .list()
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map((workspace) => {
        const status = project.workspace.status(workspace.id)
        return {
          id: workspace.id,
          value: workspace,
          title:
            removing() === workspace.id
              ? t("panel.workspace.deleting")
              : deleting() === workspace.id
                ? t("panel.workspace.delete.confirm", { name: workspace.name, key: deleteHint() })
                : workspace.name,
          description: expanded[workspace.id] && workspace.directory ? workspace.directory : undefined,
          lead: <text fg={status === "connected" ? theme.success : theme.error}>●</text>,
          trail: workspace.type,
        }
      }),
  )

  async function remove(workspace: Workspace) {
    if (removing()) return
    if (deleting() !== workspace.id) {
      setDeleting(workspace.id)
      return
    }

    setDeleting(undefined)
    setRemoving(workspace.id)
    const result = await sdk.client.experimental.workspace.remove({ id: workspace.id }).catch((error) => ({ error }))
    if (result?.error) {
      setRemoving(undefined)
      toast.show({
        variant: "error",
        title: t("panel.workspace.delete.failed"),
        message: errorMessage(result.error),
      })
      return
    }

    if (current()?.id === workspace.id) {
      project.workspace.set(undefined)
      route.navigate({ type: "home" })
    }
    await project.workspace.sync()
    await sync.bootstrap({ fatal: false }).catch(() => undefined)
    setRemoving(undefined)
  }

  onMount(() => {
    void sdk.client.experimental.workspace.syncList().catch(() => undefined)
    void project.workspace.sync()
  })

  return (
    <ListPanel
      title={t("panel.workspace.title")}
      command="/workspaces"
      items={items()}
      current={current()}
      onMove={() => setDeleting(undefined)}
      onSelect={(item) => setExpanded(item.value.id, (open) => !open)}
      actions={[
        {
          key: "session.delete",
          label: t("panel.workspace.delete"),
          run: (item) => void remove(item.value),
        },
      ]}
    />
  )
}
