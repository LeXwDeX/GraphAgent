// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { ExperimentalWorkspaceAdapterListResponse, Workspace } from "@graphagent/sdk"
import { createMemo, createSignal } from "solid-js"
import { useProject } from "../context/project"
import { useRoute } from "../context/route"
import { locationHeaders, useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { t } from "../i18n"
import { errorMessage } from "../util/error"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { usePanelHost, type PanelHostApi } from "./host"
import { ListPanel, type ListItem } from "./list"
import { showWorkspaceFileChanges } from "./workspace-file-changes"

type Adapter = ExperimentalWorkspaceAdapterListResponse[number]

export type WorkspaceSelection =
  | { type: "none" }
  | { type: "new"; workspaceType: string; workspaceName: string }
  | { type: "existing"; workspaceID: string; workspaceType: string; workspaceName: string }

type WorkspaceSelectValue = WorkspaceSelection | { type: "existing-list" }

export function recentConnectedWorkspaces<WorkspaceInfo extends { id: string; timeUsed: number | string }>(input: {
  workspaces: readonly WorkspaceInfo[]
  status: (workspaceID: string) => string | undefined
  limit?: number
  omitWorkspaceID?: string
}) {
  const connected = input.workspaces.filter(
    (workspace) => input.status(workspace.id) === "connected" && workspace.id !== input.omitWorkspaceID,
  )
  const sorted = connected.toSorted((left, right) => Number(right.timeUsed) - Number(left.timeUsed))
  const recent = sorted.slice(0, input.limit ?? 3)
  return { recent, hasMore: recent.length < sorted.length }
}

export function warpReminderText(directory: string) {
  return `<system-reminder>The user has changed the current working directory to "${directory}". This is still the same project at a possibly new location; take this into account when working with any files from now on.</system-reminder>`
}

async function loadWorkspaceAdapters(input: {
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  toast: ReturnType<typeof useToast>
}) {
  const directory = input.sync.path.directory || input.sdk.directory
  try {
    const response = await input.sdk.client.experimental.workspace.adapter.list({
      headers: locationHeaders({ directory }),
    })
    if (response.error) throw response.error
    return response.data
  } catch (error) {
    input.toast.show({
      title: t("panel.workspace.adapter.failed"),
      message: errorMessage(error),
      variant: "error",
    })
    return undefined
  }
}

/** Loads adapters and opens the workspace picker in the bottom-zone host. */
export async function openWorkspacePanel(input: {
  host: PanelHostApi
  dialog: DialogContext
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  project: ReturnType<typeof useProject>
  toast: ReturnType<typeof useToast>
  onSelect: (selection: WorkspaceSelection) => Promise<void> | void
}) {
  input.dialog.clear()
  await input.sdk.client.experimental.workspace.syncList().catch(() => undefined)
  await input.project.workspace.sync().catch(() => undefined)
  const adapters = await loadWorkspaceAdapters(input)
  if (!adapters) return

  const rootDepth = input.host.depth()
  const closeFlow = () => {
    while (input.host.depth() > 0 && input.host.depth() >= rootDepth) input.host.close()
  }
  input.host.push({
    id: "workspace-select",
    render: () => (
      <WorkspaceSelectPanel
        adapters={adapters}
        onSelect={(selection) => {
          closeFlow()
          void input.onSelect(selection)
        }}
      />
    ),
  })
}

/** Adapter list plus local and recent workspace targets. */
export function WorkspaceSelectPanel(props: {
  adapters: readonly Adapter[]
  onSelect(selection: WorkspaceSelection): void
}) {
  const host = usePanelHost()
  const dialog = useDialog()
  const project = useProject()
  const route = useRoute()
  const [confirming, setConfirming] = createSignal(false)

  const omittedWorkspaceID = createMemo(() => (route.data.type === "session" ? project.workspace.current() : undefined))

  const items = createMemo<ListItem<WorkspaceSelectValue>[]>(() => {
    const { recent, hasMore } = recentConnectedWorkspaces({
      workspaces: project.workspace.list(),
      status: project.workspace.status,
      omitWorkspaceID: omittedWorkspaceID(),
    })
    const chooseGroup = t("panel.workspace.select.group.choose")
    return [
      ...props.adapters.map((adapter) => ({
        id: `adapter:${adapter.type}:${adapter.name}`,
        value: { type: "new" as const, workspaceType: adapter.type, workspaceName: adapter.name },
        title: adapter.name,
        description: adapter.description,
        group: t("panel.workspace.select.group.new"),
      })),
      {
        id: "none",
        value: { type: "none" as const },
        title: t("panel.workspace.select.none"),
        description: t("panel.workspace.select.none.description"),
        group: chooseGroup,
      },
      ...recent.map((workspace) => ({
        id: `workspace:${workspace.id}`,
        value: {
          type: "existing" as const,
          workspaceID: workspace.id,
          workspaceType: workspace.type,
          workspaceName: workspace.name,
        },
        title: workspace.name,
        description: t("panel.workspace.select.type", { type: workspace.type }),
        group: chooseGroup,
      })),
      ...(hasMore
        ? [
            {
              id: "existing-list",
              value: { type: "existing-list" as const },
              title: t("panel.workspace.select.viewAll"),
              description: t("panel.workspace.select.viewAll.description"),
              group: chooseGroup,
            },
          ]
        : []),
    ]
  })

  async function select(item: ListItem<WorkspaceSelectValue>) {
    const value = item.value
    if (value.type === "existing-list") {
      host.push({
        id: "workspace-existing",
        render: () => <ExistingWorkspacePanel omitWorkspaceID={omittedWorkspaceID()} onSelect={props.onSelect} />,
      })
      return
    }
    if (value.type !== "new") {
      props.onSelect(value)
      return
    }
    if (confirming()) return
    setConfirming(true)
    try {
      const confirmed = await DialogConfirm.show(
        dialog,
        t("panel.workspace.select.confirm.title"),
        t("panel.workspace.select.confirm.message", { name: value.workspaceName }),
      )
      if (confirmed) props.onSelect(value)
    } finally {
      setConfirming(false)
    }
  }

  return (
    <ListPanel
      title={t("panel.workspace.select.title")}
      command="/warp"
      items={items()}
      onSelect={(item) => void select(item)}
    />
  )
}

function ExistingWorkspacePanel(props: { omitWorkspaceID?: string; onSelect(selection: WorkspaceSelection): void }) {
  const project = useProject()
  const items = createMemo<ListItem<Workspace>[]>(() =>
    project.workspace
      .list()
      .filter((workspace) => project.workspace.status(workspace.id) === "connected")
      .filter((workspace) => workspace.id !== props.omitWorkspaceID)
      .map((workspace) => ({
        id: workspace.id,
        value: workspace,
        title: workspace.name,
        description: t("panel.workspace.select.type", { type: workspace.type }),
      })),
  )

  return (
    <ListPanel
      title={t("panel.workspace.select.existing.title")}
      command="/warp"
      items={items()}
      onSelect={(item) =>
        props.onSelect({
          type: "existing",
          workspaceID: item.value.id,
          workspaceType: item.value.type,
          workspaceName: item.value.name,
        })
      }
    />
  )
}

export async function warpWorkspaceSession(input: {
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  project: ReturnType<typeof useProject>
  toast: ReturnType<typeof useToast>
  workspaceID: string | null
  sessionID: string
  copyChanges: boolean
  done?: () => void
}): Promise<boolean> {
  let result
  try {
    result = await input.sdk.client.experimental.workspace.warp({
      id: input.workspaceID,
      sessionID: input.sessionID,
      copyChanges: input.copyChanges,
    })
  } catch (error) {
    input.toast.show({
      title: t("panel.workspace.warp.failed"),
      message: errorMessage(error),
      variant: "error",
    })
    return false
  }
  if (!result?.data) {
    if (result?.error && "name" in result.error && result.error.name === "VcsApplyError") {
      input.toast.show({
        title: t("panel.workspace.warp.failed"),
        message: t("panel.workspace.warp.conflict"),
        variant: "error",
      })
      return false
    }
    input.toast.show({
      title: t("panel.workspace.warp.failed"),
      message: errorMessage(result?.error ?? "no response"),
      variant: "error",
    })
    return false
  }

  input.project.workspace.set(input.workspaceID)
  await input.sync.bootstrap({ fatal: false }).catch(() => undefined)

  const directory = input.project.instance.directory() || input.sync.path.directory
  if (directory) {
    await input.sdk.client.session
      .promptAsync(
        {
          sessionID: input.sessionID,
          noReply: true,
          parts: [
            {
              type: "text",
              text: warpReminderText(directory),
              synthetic: true,
            },
          ],
        },
        { headers: locationHeaders({ workspace: input.workspaceID }) },
      )
      .catch(() => undefined)
  }

  await Promise.all([input.project.workspace.sync(), input.sync.session.refresh()])
  input.done?.()
  return true
}

export async function confirmWorkspaceFileChanges(input: {
  dialog: DialogContext
  host: PanelHostApi
  sdk: ReturnType<typeof useSDK>
  sourceWorkspaceID?: string
}) {
  const status = await input.sdk.client.vcs
    .status({ headers: locationHeaders({ workspace: input.sourceWorkspaceID }) })
    .catch(() => undefined)
  const choice = status?.data?.length
    ? await showWorkspaceFileChanges({ host: input.host, dialog: input.dialog, files: status.data })
    : "no"
  if (!choice) return
  return choice === "yes"
}
