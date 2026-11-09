// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { ProjectDirectories } from "@graphagent/sdk"
import path from "path"
import { createMemo, createResource, createSignal } from "solid-js"
import { useProject } from "../context/project"
import { useRoute } from "../context/route"
import { useTuiPaths } from "../context/runtime"
import { locationHeaders, useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { abbreviateHome } from "../runtime"
import { errorMessage } from "../util/error"
import { askConfirm } from "../ask/local-ask"
import { useBottomZoneOptional } from "../shell/bottom-zone"
import { useToast } from "../ui/toast"
import { usePanelHost } from "./host"
import { ListPanel, type ListItem } from "./list"
import { showWorkspaceFileChanges } from "./workspace-file-changes"

export type MoveSessionSelection = { type: "directory"; directory: string; subdirectory: boolean } | { type: "new" }
type ProjectDirectory = ProjectDirectories[number]

export interface MoveSessionPanelProps {
  projectID: string
  current?: MoveSessionSelection
  onSelect(selection: MoveSessionSelection): void
  onCurrentChange?(selection: MoveSessionSelection): void
}

/** `/move`: lists project copies and creates, refreshes or deletes them. */
export function MoveSessionPanel(props: MoveSessionPanelProps) {
  const bottomZone = useBottomZoneOptional()
  const host = usePanelHost()
  const sdk = useSDK()
  const sync = useSync()
  const project = useProject()
  const route = useRoute()
  const toast = useToast()
  const paths = useTuiPaths()
  const { theme } = useTheme()
  const [removing, setRemoving] = createSignal<string>()
  const [replacementCurrent, setReplacementCurrent] = createSignal<string>()
  const [loadError, setLoadError] = createSignal<unknown>()

  // A failed current-checkout lookup only affects which row is highlighted, so
  // swallow it and let the directory list render without a current marker.
  const [loadedProject] = createResource(
    () => (project.project() === props.projectID ? undefined : props.projectID),
    (projectID) =>
      sdk.client.project
        .current({ throwOnError: true })
        .then((result) => (result.data?.id === projectID ? result.data.worktree : undefined))
        .catch(() => undefined),
  )

  const [directories, { refetch }] = createResource(
    () => props.projectID,
    async (projectID, info): Promise<ProjectDirectories | undefined> => {
      try {
        await sdk.client.experimental.projectCopy.refresh(
          { projectID },
          { throwOnError: true, headers: locationHeaders({ directory: sdk.directory }) },
        )
        const result = await sdk.client.project.directories({ projectID }, { throwOnError: true })
        setLoadError(undefined)
        return result.data ?? []
      } catch (error) {
        setLoadError(error)
        // A failed refresh intentionally stays quiet and keeps the already-shown
        // list interactive; an initial load with no data shows the error view.
        return info.value
      }
    },
  )

  const directoryData = createMemo(() => directories() ?? [])
  const showError = createMemo(() => Boolean(loadError()) && directories() === undefined)

  const currentCheckout = createMemo(() => {
    if (project.project() === props.projectID) return project.instance.path().worktree
    return loadedProject()
  })

  const currentDirectory = createMemo(
    () => replacementCurrent() ?? (props.current?.type === "directory" ? props.current.directory : currentCheckout()),
  )

  const currentRoot = createMemo<ProjectDirectory | undefined>(() => {
    if (showError()) return
    const directory = currentDirectory()
    if (!directory) return
    return (
      directoryData()
        .filter((root) => contains(root.directory, directory))
        .toSorted((left, right) => right.directory.length - left.directory.length)[0] ?? { directory }
    )
  })

  const items = createMemo<ListItem<MoveSessionSelection>[]>(() => {
    if (showError()) return []
    const current = currentRoot()?.directory
    const roots = [...directoryData()]
    if (current && !roots.some((item) => item.directory === current)) roots.unshift({ directory: current })
    roots.sort((left, right) => {
      if (left.directory === current) return -1
      if (right.directory === current) return 1
      if (Boolean(left.strategy) !== Boolean(right.strategy)) return left.strategy ? 1 : -1
      if (!left.strategy && !right.strategy) return left.directory.length - right.directory.length
      return 0
    })
    if (roots.length === 0) return []

    const subdirectories = sync.data.session
      .filter((session) => session.projectID === props.projectID && session.path && ![".", "/"].includes(session.path))
      .map((session) => session.directory)
      .filter((directory) => !roots.some((root) => root.directory === directory))
      .filter((directory, index, all) => all.indexOf(directory) === index)
      .map((location) => ({
        location,
        root: roots
          .filter((root) => {
            const relative = path.relative(root.directory, location)
            return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
          })
          .toSorted((left, right) => right.directory.length - left.directory.length)[0],
      }))
      .filter((item): item is { location: string; root: ProjectDirectory } => item.root !== undefined)

    const list = [...roots.map((root) => ({ location: root.directory, root })), ...subdirectories].toSorted(
      (left, right) => {
        const root = roots.indexOf(left.root) - roots.indexOf(right.root)
        if (root !== 0) return root
        if (left.location === left.root.directory) return -1
        if (right.location === right.root.directory) return 1
        return left.location.localeCompare(right.location)
      },
    )

    return list.map((item) => ({
      id: item.location,
      value: {
        type: "directory" as const,
        directory: item.location,
        subdirectory: item.location !== item.root.directory,
      },
      title: removing() === item.location ? t("panel.move.deleting") : abbreviateHome(item.location, paths.home),
      description: item.location,
      group: item.root.directory === current ? t("panel.move.group.current") : t("panel.move.group.other"),
    }))
  })

  const current = createMemo<MoveSessionSelection | undefined>(() => {
    const directory = currentRoot()?.directory
    if (!directory) return undefined
    return { type: "directory", directory, subdirectory: false }
  })

  function contains(root: string, target: string) {
    const relative = path.relative(root, target)
    return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
  }

  function canDelete(item: ListItem<MoveSessionSelection> | undefined) {
    const value = item?.value
    if (!value || value.type !== "directory" || value.subdirectory || removing()) return false
    return Boolean(directoryData().find((entry) => entry.directory === value.directory)?.strategy)
  }

  async function remove(item: ListItem<MoveSessionSelection>) {
    const value = item.value
    if (!canDelete(item) || value.type !== "directory") return
    const deletingCurrent = value.directory === currentRoot()?.directory
    if (!bottomZone) return
    const confirmed = await askConfirm(bottomZone, {
      title: t("panel.move.delete.title"),
      body: t("panel.move.delete.message", { directory: abbreviateHome(value.directory, paths.home) }),
      confirmLabel: t("ask.confirm.confirm"),
      cancelLabel: t("ask.confirm.cancel"),
      danger: true,
    })
    if (!confirmed) return
    await performRemove(value.directory, deletingCurrent, false)
  }

  async function performRemove(directory: string, deletingCurrent: boolean, force: boolean) {
    setRemoving(directory)
    const result = await sdk.client.experimental.projectCopy
      .remove({
        projectID: props.projectID,
        directory,
        force,
      })
      .catch((error) => ({ error }))
    if (result.error) {
      if (!force && "data" in result.error && result.error.data.forceRequired) {
        const status = await sdk.client.vcs.status({ headers: locationHeaders({ directory }) }).catch(() => undefined)
        const choice = await showWorkspaceFileChanges({
          host,
          zone: bottomZone,
          files: status?.data ?? [],
          title: t("panel.move.delete.title"),
          message: t("panel.move.delete.force"),
        })
        if (choice !== "yes") {
          setRemoving(undefined)
          return
        }
        await performRemove(directory, deletingCurrent, true)
        return
      }
      setRemoving(undefined)
      toast.show({
        text: `${t("panel.move.delete.failed")}: ${errorMessage(result.error)}`,
        level: "error",
      })
      return
    }

    await refetch()
    setRemoving(undefined)
    await removedCurrent(deletingCurrent)
  }

  async function removedCurrent(deletingCurrent: boolean) {
    if (!deletingCurrent) return false
    const fallback = project.data.project.mainDir
    if (fallback) setReplacementCurrent(fallback)
    if (route.data.type === "session") {
      route.navigate({ type: "home" })
      host.close()
      return true
    }
    if (fallback) {
      props.onCurrentChange?.({ type: "directory", directory: fallback, subdirectory: false })
      return true
    }
    host.close()
    return true
  }

  return (
    <ListPanel
      title={t("panel.move.title")}
      command="/move"
      items={items()}
      current={current()}
      loading={directories.loading && directoryData().length === 0}
      empty={
        showError() ? (
          <box flexDirection="column">
            <text fg={theme.error}>{t("panel.move.load.failed")}</text>
            <text fg={theme.textMuted}>{errorMessage(loadError())}</text>
          </box>
        ) : (
          <text fg={theme.textMuted}>{t("panel.move.empty")}</text>
        )
      }
      onSelect={(item) => {
        // Deletion re-renders the list; do not move the session mid-flight.
        if (removing()) return
        props.onSelect(item.value)
      }}
      actions={[
        {
          key: "dialog.move_session.new",
          label: t("panel.move.new"),
          when: () => !removing(),
          run: () => props.onSelect({ type: "new" }),
        },
        {
          key: "dialog.move_session.delete",
          label: t("panel.move.delete"),
          when: canDelete,
          run: (item) => void remove(item),
        },
        {
          key: "dialog.move_session.refresh",
          label: t("panel.move.refresh"),
          run: () => void refetch(),
        },
      ]}
    />
  )
}
