// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import path from "path"
import { createMemo, createResource, createSignal } from "solid-js"
import { askChoice } from "../ask/local-ask"
import { Spinner } from "../component/spinner"
import { useLocal } from "../context/local"
import { useProject } from "../context/project"
import { usePromptRef } from "../context/prompt"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { getLanguage, t } from "../i18n"
import { useCommandShortcut } from "../keymap"
import { useBottomZoneOptional } from "../shell/bottom-zone"
import { errorMessage } from "../util/error"
import { Locale } from "../util/locale"
import { createDebouncedSignal } from "../util/signal"
import { useTicker } from "../context/ticker-context"
import { useToast } from "../ui/toast"
import { usePanelHost } from "./host"
import { ListPanel, type ListItem } from "./list"
import { openWorkspacePanel, warpWorkspaceSession, type WorkspaceSelection } from "./workspace-select"

type SyncApi = ReturnType<typeof useSync>
type SessionInfo = NonNullable<ReturnType<SyncApi["session"]["get"]>>

/** `/sessions`: browse, search, pin, rename and delete sessions. */
export function SessionListPanel() {
  const route = useRoute()
  const sync = useSync()
  const project = useProject()
  const sdk = useSDK()
  const local = useLocal()
  const toast = useToast()
  const host = usePanelHost()
  const bottomZone = useBottomZoneOptional()
  const prompt = usePromptRef()
  const { theme } = useTheme()
  const ticker = useTicker()
  const [toDelete, setToDelete] = createSignal<string>()
  const [search, setSearch] = createDebouncedSignal("", 150, (callback, ms) => ticker.at(ticker.now() + ms, callback))
  const deleteHint = useCommandShortcut("session.delete")

  const [searchResults, { refetch }] = createResource(
    () => ({ query: search(), filter: sync.session.query() }),
    async (input) => {
      if (!input.query) return undefined
      const result = await sdk.client.session.list({ search: input.query, limit: 30, ...input.filter })
      return result.data ?? []
    },
  )

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  // sync.data.session is id-ordered (binary-search invariant); the browse
  // fallback re-sorts by recency for display, matching the search results.
  const sessions = createMemo<SessionInfo[]>(() => {
    const results = searchResults()
    if (results) return results
    return [...sync.data.session].toSorted((left, right) => right.time.updated - left.time.updated)
  })

  // The browse order is captured when the panel opens so rows do not jump
  // while the user moves the selection.
  const [browseOrder] = createSignal<string[]>(
    sync.data.session
      .filter((session) => session.parentID === undefined)
      .toSorted((left, right) => right.time.updated - left.time.updated)
      .map((session) => session.id),
  )

  const sessionMap = createMemo(
    () =>
      new Map(
        sessions()
          .filter((s) => s.parentID === undefined)
          .map((s) => [s.id, s]),
      ),
  )

  const items = createMemo<ListItem<string>[]>(() => {
    const map = sessionMap()
    const results = searchResults()
    const ordered = results
      ? results
          .filter((session) => session.parentID === undefined)
          .toSorted((left, right) => right.time.updated - left.time.updated)
          .map((session) => session.id)
      : browseOrder()

    const pinned = local.session.pinned().filter((id) => map.has(id))
    const pinnedSet = new Set(pinned)
    const slotByID = new Map<string, number>(local.session.slots().map((id, index) => [id, index + 1]))
    const today = new Date().toDateString()
    const locale = getLanguage() === "zh-CN" ? "zh-CN" : "en"

    const row = (id: string, group: string): ListItem<string> | undefined => {
      const session = map.get(id)
      if (!session) return undefined
      const directory = session.path
        ? session.directory.endsWith(session.path)
          ? session.directory.slice(0, -session.path.length).replace(/\/$/, "")
          : undefined
        : session.directory
      const trail =
        directory && directory !== project.data.project.mainDir
          ? Locale.truncate(path.basename(directory), 20)
          : undefined
      const status = sync.data.session_status?.[id]
      const isWorking = status?.type === "busy" || status?.type === "retry"
      const slot = slotByID.get(id)
      return {
        id,
        value: id,
        title: toDelete() === id ? t("panel.sessions.delete.confirm", { key: deleteHint() }) : session.title,
        group,
        lead: isWorking ? <Spinner /> : slot !== undefined ? <text fg={theme.accent}>{slot}</text> : undefined,
        trail,
      }
    }

    const remaining = ordered
      .filter((id) => !pinnedSet.has(id))
      .map((id) => {
        const session = map.get(id)
        if (!session) return undefined
        const label = new Date(session.time.updated).toDateString()
        const group =
          label === today ? t("panel.sessions.group.today") : new Date(session.time.updated).toLocaleDateString(locale)
        return row(id, group)
      })
      .filter((item) => item !== undefined)

    return [
      ...pinned.map((id) => row(id, t("panel.sessions.group.pinned"))).filter((item) => item !== undefined),
      ...remaining,
    ]
  })

  function rename(item: ListItem<string>) {
    const current = prompt.current
    if (!current) return
    host.close()
    current.edit({
      label: t("prompt.edit.rename"),
      value: sessionMap().get(item.value)?.title ?? "",
      commit: async (next) => {
        await sdk.client.session.update({ sessionID: item.value, title: next })
      },
    })
  }

  async function remove(item: ListItem<string>) {
    if (toDelete() !== item.value) {
      setToDelete(item.value)
      return
    }
    const session = sessionMap().get(item.value)
    if (!session) return
    const status = session.workspaceID ? project.workspace.status(session.workspaceID) : undefined
    setToDelete(undefined)

    let failure: unknown
    try {
      const result = await sdk.client.session.delete({ sessionID: item.value })
      if (result.error) failure = result.error
    } catch (error) {
      failure = error
    }

    if (failure !== undefined) {
      if (session.workspaceID) {
        await recover(session)
      } else {
        toast.show({
          text: `${t("panel.sessions.delete.failed")}: ${errorMessage(failure)}`,
          level: "error",
        })
      }
      return
    }

    if (status && status !== "connected") await sync.session.refresh()
    if (search()) await refetch()
  }

  async function recover(session: SessionInfo) {
    if (!bottomZone) return
    const choice = await askChoice(bottomZone, {
      title: t("panel.sessions.recover.title"),
      body: t("panel.sessions.recover.body", {
        session: session.title,
        workspace: project.workspace.get(session.workspaceID!)?.name ?? session.workspaceID!,
      }),
      options: [
        { id: "delete", label: t("panel.sessions.recover.delete") },
        { id: "restore", label: t("panel.sessions.recover.restore") },
      ],
    })
    if (choice === "delete") {
      await deleteWorkspace(session)
      return
    }
    if (choice === "restore") restore(session)
  }

  async function deleteWorkspace(session: SessionInfo) {
    const workspaceID = session.workspaceID!
    const result = await sdk.client.experimental.workspace.remove({ id: workspaceID })
    if (result.error) {
      toast.show({
        text: `${t("panel.sessions.workspace.deleteFailed")}: ${errorMessage(result.error)}`,
        level: "error",
      })
      return
    }
    const current = currentSessionID()
    const info = current ? sync.data.session.find((item) => item.id === current) : undefined
    await project.workspace.sync()
    await sync.session.refresh()
    if (search()) await refetch()
    if (info?.workspaceID === workspaceID) route.navigate({ type: "home" })
  }

  function restore(session: SessionInfo) {
    host.close()
    void openWorkspacePanel({
      host,
      sdk,
      sync,
      project,
      toast,
      onSelect: async (selection) => {
        const workspaceID = await resolveWorkspace(selection)
        if (workspaceID === undefined) return
        const warped = await warpWorkspaceSession({
          sdk,
          sync,
          project,
          toast,
          workspaceID,
          sessionID: session.id,
          copyChanges: false,
        })
        if (warped) host.push({ id: "sessions", render: () => <SessionListPanel /> })
      },
    })
  }

  async function resolveWorkspace(selection: WorkspaceSelection): Promise<string | null | undefined> {
    if (selection.type === "none") return null
    if (selection.type === "existing") return selection.workspaceID
    let result
    try {
      result = await sdk.client.experimental.workspace.create({ type: selection.workspaceType, branch: null })
    } catch (error) {
      toast.show({
        text: `${t("panel.sessions.workspace.createFailed")}: ${errorMessage(error)}`,
        level: "error",
      })
      return undefined
    }
    if (!result?.data) {
      toast.show({
        text: `${t("panel.sessions.workspace.createFailed")}: ${errorMessage(result?.error ?? "no response")}`,
        level: "error",
      })
      return undefined
    }
    await project.workspace.sync()
    return result.data.id
  }

  return (
    <ListPanel
      title={t("panel.sessions.title")}
      command="/sessions"
      items={items()}
      current={currentSessionID()}
      filter={{ placeholder: t("panel.sessions.filter"), client: false }}
      loading={Boolean(search()) && searchResults.loading}
      onFilter={(value) => setSearch(value)}
      onMove={() => setToDelete(undefined)}
      onSelect={(item) => {
        route.navigate({ type: "session", sessionID: item.value })
        host.close()
      }}
      actions={[
        {
          key: "session.pin.toggle",
          label: t("panel.sessions.action.pin"),
          run: (item) => local.session.togglePin(item.value),
        },
        {
          key: "session.delete",
          label: t("panel.sessions.action.delete"),
          run: (item) => void remove(item),
        },
        {
          key: "session.rename",
          label: t("panel.sessions.action.rename"),
          when: () => prompt.current !== undefined,
          run: (item) => rename(item),
        },
      ]}
    />
  )
}
