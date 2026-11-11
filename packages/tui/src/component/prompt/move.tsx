import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import path from "path"
import { useTuiPaths } from "../../context/runtime"
import { errorMessage } from "../../util/error"
import { useSDK, locationHeaders } from "../../context/sdk"
import { useSync } from "../../context/sync"
import { useToast } from "../../ui/toast"
import { MoveSessionPanel, type MoveSessionSelection } from "../../panel/move-session"
import { t } from "../../i18n"
import { showWorkspaceFileChanges } from "../../panel/workspace-file-changes"
import { useBottomZoneOptional } from "../../shell/bottom-zone"
import { useHomeSessionDestination } from "../../routes/home/session-destination"
import { useProject } from "../../context/project"
import { useTicker } from "../../context/ticker-context"

function moveReminderText(directory: string) {
  return `<system-reminder>The user has changed the current working directory to "${directory}". This is still the same project but at a possibly new location; take this into account when working with any files from now on.</system-reminder>`
}

export function usePromptMove(input: { projectID: () => string | undefined; sessionID: () => string | undefined }) {
  const bottomZone = useBottomZoneOptional()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const homeDestination = useHomeSessionDestination()
  const project = useProject()
  const paths = useTuiPaths()
  const ticker = useTicker()
  const [creating, setCreating] = createSignal(false)
  const [creatingDots, setCreatingDots] = createSignal(3)
  const [progress, setProgress] = createSignal<string>()

  async function create(context?: string) {
    const projectID = input.projectID()
    if (!projectID) return
    setCreating(true)
    setProgress(t("panel.move.progress.copy"))
    try {
      const generated = await sdk.client.experimental.projectCopy.generateName(
        { projectID, context },
        { throwOnError: true },
      )
      const result = await sdk.client.experimental.projectCopy.create(
        {
          projectID,
          strategy: "git_worktree",
          directory: path.join(paths.worktree, projectID.slice(0, 6)),
          name: generated.data.name,
        },
        { throwOnError: true },
      )
      const directory = result.data?.directory
      if (!directory) throw new Error("No project copy directory returned")

      // Call a location-based route to make sure it's bootstrapped
      // before moving on
      await sdk.client.path.get({ throwOnError: true, headers: locationHeaders({ directory }) })

      setProgress(t("panel.move.progress.session"))
      return directory
    } catch (err) {
      homeDestination?.clear()
      setProgress(undefined)
      setCreating(false)
      toast.show({
        text: `${t("panel.move.create.failed")}: ${errorMessage(err)}`,
        level: "error",
      })
      return
    }
  }

  function open() {
    const projectID = input.projectID()
    const host = bottomZone?.host
    if (!projectID || !host) return
    if (host.top()?.id === "move-session") return
    const sessionID = input.sessionID()
    const session = sessionID ? sync.session.get(sessionID) : undefined
    host.push({
      id: "move-session",
      render: () => (
        <MoveSessionPanel
          projectID={projectID}
          current={
            homeDestination?.destination() ??
            (session
              ? {
                  type: "directory",
                  directory: session.directory,
                  subdirectory: !!session.path,
                }
              : {
                  type: "directory",
                  directory: project.instance.directory(),
                  subdirectory: project.instance.directory() !== project.instance.path().worktree,
                })
          }
          onCurrentChange={(selection) => homeDestination?.setDestination(selection)}
          onSelect={(selection) => {
            const sessionID = input.sessionID()
            host.close()
            if (!sessionID) {
              homeDestination?.setDestination(selection)
              return
            }
            void moveExistingSession(sessionID, selection)
          }}
        />
      ),
    })
  }

  function sessionContext(sessionID: string) {
    const session = sync.session.get(sessionID)
    const messages = (sync.data.message[sessionID] ?? [])
      .slice(-6)
      .map((message) =>
        [
          message.role + ":",
          ...(sync.data.part[message.id] ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])),
        ].join(" "),
      )
    return [session?.title, ...messages].filter(Boolean).join("\n") || undefined
  }

  async function moveExistingSession(sessionID: string, selection: MoveSessionSelection) {
    const session = sync.session.get(sessionID)
    const status = await sdk.client.vcs
      .status({ headers: locationHeaders({ directory: session?.directory }) })
      .catch(() => undefined)
    const choice =
      status?.data?.length && bottomZone
        ? await showWorkspaceFileChanges({ host: bottomZone.host, zone: bottomZone, files: status.data })
        : "no"
    if (!choice) return
    const directory = selection.type === "new" ? await create(sessionContext(sessionID)) : selection.directory
    if (!directory) {
      setProgress(undefined)
      return
    }
    setProgress(t("panel.move.progress.moving"))
    try {
      await sdk.client.experimental.controlPlane.moveSession(
        {
          sessionID,
          destination: { directory },
          moveChanges: choice === "yes",
        },
        { throwOnError: true },
      )
      await sdk.client.session
        .promptAsync(
          {
            sessionID,
            noReply: true,
            parts: [
              {
                type: "text",
                text: moveReminderText(directory),
                synthetic: true,
              },
            ],
          },
          { headers: locationHeaders({ directory }) },
        )
        .catch(() => undefined)
    } catch (error) {
      toast.error(error)
    } finally {
      setProgress(undefined)
      setCreating(false)
    }
  }

  const pending = createMemo(() => Boolean(homeDestination?.destination()))
  const pendingNew = createMemo(() => homeDestination?.destination()?.type === "new")

  async function getDirectory(context?: string) {
    const value = homeDestination?.destination()
    if (!value) return
    if (value.type === "directory") {
      return value.directory
    }
    return await create(context)
  }

  function startSubmit() {
    if (progress()) setProgress(t("panel.move.progress.submit"))
  }

  function finishSubmit() {
    homeDestination?.clear()
    setProgress(undefined)
    setCreating(false)
  }

  createEffect(() => {
    if (!creating()) {
      setCreatingDots(3)
      return
    }
    onCleanup(ticker.subscribeSecond())
  })

  createEffect(
    on(
      ticker.second,
      () => {
        if (creating()) setCreatingDots((dots) => (dots % 3) + 1)
      },
      { defer: true },
    ),
  )

  return {
    creating,
    creatingDots,
    finishSubmit,
    getDirectory,
    open,
    pending,
    pendingNew,
    progress,
    startSubmit,
  }
}
