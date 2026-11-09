import { render, TimeToFirstDraw, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { Deferred, Effect } from "effect"
import { Global } from "@graphagent/core/global"
import { APP_TITLE } from "@graphagent/core/brand"
import { Flag } from "@graphagent/core/flag/flag"
import { ClipboardProvider, useClipboard } from "./context/clipboard"
import { ExitProvider, useExit } from "./context/exit"
import { EpilogueProvider } from "./context/epilogue"
import * as Selection from "./util/selection"
import { createCliRenderer, MouseButton, type CliRenderer } from "@opentui/core"
import { RouteProvider, useRoute } from "./context/route"
import {
  Switch,
  Match,
  createEffect,
  createMemo,
  ErrorBoundary,
  createSignal,
  onMount,
  onCleanup,
  batch,
  Show,
  on,
  type JSX,
} from "solid-js"
import { TuiPathsProvider, TuiStartupProvider, TuiTerminalEnvironmentProvider } from "./context/runtime"
import { DialogProvider, useDialog } from "./ui/dialog"
import { DialogProvider as DialogProviderList } from "./component/dialog-provider"
import { ErrorComponent } from "./component/error-component"
import { ProjectProvider, useProject } from "./context/project"
import { EditorContextProvider } from "./context/editor"
import { useEvent } from "./context/event"
import { SDKProvider, useSDK } from "./context/sdk"
import { SyncProvider, useSync } from "./context/sync"
import { LocationProvider } from "./context/location"
import { LocalProvider, useLocal } from "./context/local"
import { DialogSessionList } from "./component/dialog-session-list"
import { ThemeProvider, useTheme } from "./context/theme"
import { Home } from "./routes/home"
import { HomeSessionDestinationProvider } from "./routes/home/session-destination"
import { useHomeFooterMeta } from "./routes/home/footer-meta"
import { Main } from "./routes/session"
import { Diff } from "./routes/diff"
import { useDiffNavigation } from "./routes/diff/route"
import { useDiffFooterHints } from "./routes/diff/footer-hints"
import { AppFrame } from "./shell/app-frame"
import { BottomZone, BottomZoneProvider, createBottomZoneState } from "./shell/bottom-zone"
import { AgentPanel } from "./panel/agent"
import { HelpPanel } from "./panel/help"
import { McpPanel } from "./panel/mcp"
import { ModelPanel } from "./panel/model"
import { StatusPanel } from "./panel/status"
import { ThemePanel } from "./panel/theme"
import { WorkspacesPanel } from "./panel/workspaces"
import { useDrawer } from "./shell/drawer"
import { useFooterKeyHints } from "./shell/footer"
import { useFooterStatus } from "./shell/footer-status"
import { SessionDrawer } from "./routes/session/drawer"
import type { TopBarRight } from "./shell/top-bar"
import { t } from "./i18n"
import { PromptHistoryProvider } from "./component/prompt/history"
import { FrecencyProvider } from "./component/prompt/frecency"
import { PromptStashProvider } from "./component/prompt/stash"
import { ToastProvider, useToast } from "./ui/toast"
import { isDefaultTitle } from "./util/session"
import { KVProvider, useKV } from "./context/kv"
import * as Model from "./util/model"
import { ArgsProvider, useArgs, type Args } from "./context/args"
import { PromptRefProvider, usePromptRef } from "./context/prompt"
import { TuiConfigProvider, useTuiConfig, type TuiConfig } from "./config"
import { CommandPaletteDialog } from "./component/command-palette"
import { CommandRegistryProvider, useCommands } from "./commands/context"
import {
  COMMAND_PALETTE_COMMAND,
  GRAPHAGENT_BASE_MODE,
  GraphagentKeymapProvider,
  hasManagedTextareaFocus,
  registerGraphagentKeymap,
  useBindings,
  useGraphagentKeymap,
} from "./keymap"

import type { EventSource } from "./context/sdk"
import { DialogVariant } from "./component/dialog-variant"
import { createTuiAttention } from "./attention"
import { createTuiNotifications } from "./attention/notify"
import * as TuiAudio from "./audio"
import { win32DisableProcessedInput, win32FlushInputBuffer } from "./terminal-win32"
import { destroyRenderer } from "./util/renderer"
import { cliErrorMessage, errorFormat } from "./util/error"
import { TuiLog } from "./util/log"

const appGlobalBindingCommands = [
  "session.list",
  "session.new",
  "session.quick_switch.1",
  "session.quick_switch.2",
  "session.quick_switch.3",
  "session.quick_switch.4",
  "session.quick_switch.5",
  "session.quick_switch.6",
  "session.quick_switch.7",
  "session.quick_switch.8",
  "session.quick_switch.9",
] as const

const appBindingCommands = [
  "command.palette.show",
  "model.list",
  "model.cycle_recent",
  "model.cycle_recent_reverse",
  "model.cycle_favorite",
  "model.cycle_favorite_reverse",
  "agent.list",
  "mcp.list",
  "agent.cycle",
  "agent.cycle.reverse",
  "variant.cycle",
  "variant.list",
  "provider.connect",
  "graphagent.status",
  "theme.switch",
  "theme.switch_mode",
  "theme.mode.lock",
  "diff.open",
  "workspace.list",
  "app.debug",
  "app.console",
  "app.heap_snapshot",
  "terminal.suspend",
  "terminal.title.toggle",
  "app.toggle.animations",
  "app.toggle.file_context",
  "app.toggle.diffwrap",
  "app.toggle.paste_summary",
  "app.toggle.session_directory_filter",
] as const

export type TuiInput = {
  url: string
  args: Args
  config: TuiConfig.Resolved
  onSnapshot?: () => Promise<string[]>
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
}

function errorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "message" in error.data &&
    typeof error.data.message === "string"
  ) {
    return error.data.message
  }
  return error instanceof Error ? error.message : String(error)
}

export const run = Effect.fn("Tui.run")(function* (input: TuiInput) {
  const global = yield* Global.Service
  const exit = { epilogue: undefined as string | undefined, reason: undefined as unknown }
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => TuiLog.installConsoleRedirect()),
        (restoreConsole) => Effect.sync(restoreConsole),
      )
      const renderer = yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          createCliRenderer({
            externalOutputMode: "passthrough",
            targetFps: 60,
            gatherStats: false,
            exitOnCtrlC: false,
            useKittyKeyboard: {},
            autoFocus: false,
            openConsoleOnError: false,
            useMouse: !Flag.GRAPHAGENT_DISABLE_MOUSE && input.config.mouse,
            consoleOptions: {
              keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
            },
          }),
        ),
        (renderer) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              destroyRenderer(renderer)
            })
            // `destroy()` only starts the native teardown; stdout and process
            // exit must wait for `closed` so the terminal is restored first.
            yield* Effect.promise(() =>
              renderer.closed.catch((error) => {
                TuiLog.write("error", "Failed to close the renderer", error)
              }),
            )
          }),
      )
      win32DisableProcessedInput()
      const keymap = createDefaultOpenTuiKeymap(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => registerGraphagentKeymap(keymap, renderer, input.config)),
        (unregister) => Effect.sync(unregister),
      )
      yield* Effect.addFinalizer(() => Effect.sync(TuiAudio.dispose))
      const shutdown = yield* Deferred.make<unknown>()
      const onSighup = () => destroyRenderer(renderer)
      // The renderer registers its own signal handlers and destroys itself
      // first on SIGHUP. Prepend so the title is cleared while the native
      // session is still usable; a destroyed renderer must not be touched.
      yield* Effect.acquireRelease(
        Effect.sync(() => process.prependListener("SIGHUP", onSighup)),
        () => Effect.sync(() => process.off("SIGHUP", onSighup)),
      )
      renderer.once("destroy", () => Deferred.doneUnsafe(shutdown, Effect.void))

      yield* Effect.tryPromise(async () => {
        // Prewarm palette before ThemeProvider mounts so `system` theme avoids a first-paint fallback flash.
        void renderer.getPalette({ size: 16 }).catch(() => undefined)
        const mode = (await renderer.waitForThemeMode(1000)) ?? "dark"
        if (renderer.isDestroyed) return

        await render(() => {
          return (
            <ExitProvider
              exit={(reason) => {
                if (renderer.isDestroyed) return
                exit.reason = reason
                destroyRenderer(renderer)
              }}
            >
              <EpilogueProvider set={(value) => (exit.epilogue = value)}>
                <ErrorBoundary fallback={(error, reset) => <ErrorComponent error={error} reset={reset} mode={mode} />}>
                  <TuiPathsProvider
                    value={{
                      cwd: process.cwd(),
                      home: global.home,
                      state: global.state,
                      worktree: global.data + "/worktree",
                    }}
                  >
                    <TuiTerminalEnvironmentProvider
                      value={{
                        platform: process.platform,
                        multiplexer: process.env.TMUX ? "tmux" : process.env.STY ? "screen" : undefined,
                        displayServer: process.env.WAYLAND_DISPLAY
                          ? "wayland"
                          : process.env.DISPLAY
                            ? "x11"
                            : undefined,
                      }}
                    >
                      <TuiStartupProvider
                        value={{
                          initialRoute: process.env.GRAPHAGENT_ROUTE
                            ? JSON.parse(process.env.GRAPHAGENT_ROUTE)
                            : undefined,
                          skipInitialLoading: Boolean(process.env.GRAPHAGENT_FAST_BOOT),
                        }}
                      >
                        <ClipboardProvider>
                          <GraphagentKeymapProvider keymap={keymap}>
                            <ArgsProvider {...input.args}>
                              <KVProvider>
                                <ToastProvider>
                                  <RouteProvider
                                    initialRoute={
                                      input.args.continue
                                        ? {
                                            type: "session",
                                            sessionID: "dummy",
                                          }
                                        : undefined
                                    }
                                  >
                                    <TuiConfigProvider config={input.config}>
                                      <SDKProvider
                                        url={input.url}
                                        directory={input.directory}
                                        fetch={input.fetch}
                                        headers={input.headers}
                                        events={input.events}
                                      >
                                        <ProjectProvider>
                                          <SyncProvider>
                                            <ThemeProvider mode={mode}>
                                              <LocalProvider>
                                                <PromptStashProvider>
                                                  <CommandRegistryProvider>
                                                    <DialogProvider>
                                                      <FrecencyProvider>
                                                        <PromptHistoryProvider>
                                                          <PromptRefProvider>
                                                            <EditorContextProvider>
                                                              <LocationProvider>
                                                                <HomeSessionDestinationProvider>
                                                                  <App onSnapshot={input.onSnapshot} />
                                                                </HomeSessionDestinationProvider>
                                                              </LocationProvider>
                                                            </EditorContextProvider>
                                                          </PromptRefProvider>
                                                        </PromptHistoryProvider>
                                                      </FrecencyProvider>
                                                    </DialogProvider>
                                                  </CommandRegistryProvider>
                                                </PromptStashProvider>
                                              </LocalProvider>
                                            </ThemeProvider>
                                          </SyncProvider>
                                        </ProjectProvider>
                                      </SDKProvider>
                                    </TuiConfigProvider>
                                  </RouteProvider>
                                </ToastProvider>
                              </KVProvider>
                            </ArgsProvider>
                          </GraphagentKeymapProvider>
                        </ClipboardProvider>
                      </TuiStartupProvider>
                    </TuiTerminalEnvironmentProvider>
                  </TuiPathsProvider>
                </ErrorBoundary>
              </EpilogueProvider>
            </ExitProvider>
          )
        }, renderer)
      })
      yield* Deferred.await(shutdown)
      return { epilogue: exit.epilogue, reason: exit.reason }
    }),
  )
  yield* Effect.sync(() => {
    win32FlushInputBuffer()
    if (result.reason !== undefined)
      process.stderr.write((cliErrorMessage(result.reason) ?? errorFormat(result.reason)) + "\n")
    if (result.epilogue) process.stdout.write(result.epilogue + "\n")
  })
})

function App(props: { onSnapshot?: () => Promise<string[]> }) {
  const tuiConfig = useTuiConfig()
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const dialog = useDialog()
  const local = useLocal()
  const kv = useKV()
  const keymap = useGraphagentKeymap()
  const event = useEvent()
  const sdk = useSDK()
  const toast = useToast()
  const themeState = useTheme()
  const { theme, mode, setMode, locked, lock, unlock } = themeState
  const sync = useSync()
  const project = useProject()
  const exit = useExit()
  const promptRef = usePromptRef()
  const commands = useCommands()
  const attention = createTuiAttention({ renderer, config: tuiConfig, kv })
  const disposeNotifications = createTuiNotifications({ event, sessions: sync.session, attention })
  const clipboard = useClipboard()
  const footerKeys = useFooterKeyHints()
  const footerStatus = useFooterStatus()
  const bottomZone = createBottomZoneState()
  const homeMeta = useHomeFooterMeta()
  const drawer = useDrawer()
  const diffFooterHints = useDiffFooterHints()
  const diffNavigation = useDiffNavigation()

  // Let selection copy/dismiss win ahead of normal bindings when explicit copy is required.
  const offSelectionKeys = keymap.intercept(
    "key",
    ({ event }) => {
      if (!Flag.GRAPHAGENT_DISABLE_COPY_ON_SELECT) return
      Selection.handleSelectionKey(renderer, toast, event, clipboard)
    },
    { priority: 1 },
  )
  onCleanup(() => {
    offSelectionKeys()
    disposeNotifications()
    attention.dispose()
  })

  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await clipboard
      .write?.(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch(toast.error)

    renderer.clearSelection()
  }
  const [terminalTitleEnabled, setTerminalTitleEnabled] = createSignal(kv.get("terminal_title_enabled", true))
  const [pasteSummaryEnabled, setPasteSummaryEnabled] = createSignal(
    kv.get("paste_summary_enabled", !sync.data.config.experimental?.disable_paste_summary),
  )

  // Update terminal window title based on current route and session
  createEffect(() => {
    if (!terminalTitleEnabled() || Flag.GRAPHAGENT_DISABLE_TERMINAL_TITLE) return

    if (route.data.type === "home") {
      renderer.setTerminalTitle(APP_TITLE)
      return
    }

    if (route.data.type === "session") {
      const session = sync.session.get(route.data.sessionID)
      if (!session || isDefaultTitle(session.title)) {
        renderer.setTerminalTitle(APP_TITLE)
        return
      }

      const title = session.title.length > 40 ? session.title.slice(0, 37) + "..." : session.title
      renderer.setTerminalTitle(`GA | ${title}`)
      return
    }

    if (route.data.type === "diff") {
      renderer.setTerminalTitle("GA | diff")
    }
  })

  const args = useArgs()
  onMount(() => {
    batch(() => {
      if (args.agent) local.agent.set(args.agent)
      if (args.model) {
        const { providerID, modelID } = Model.parse(args.model)
        if (!providerID || !modelID)
          return toast.show({
            variant: "warning",
            message: `Invalid model format: ${args.model}`,
            duration: 3000,
          })
        local.model.set({ providerID, modelID }, { recent: true })
      }
      if (args.sessionID && !args.fork) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
        })
      }
    })
  })

  let continued = false
  createEffect(() => {
    // When using -c, session list is loaded in blocking phase, so we can navigate at "partial"
    if (continued || sync.status === "loading" || !args.continue) return
    const match = sync.data.session
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .find((x) => x.parentID === undefined)?.id
    if (match) {
      continued = true
      if (args.fork) {
        void sdk.client.session.fork({ sessionID: match }).then((result) => {
          if (result.data?.id) {
            route.navigate({ type: "session", sessionID: result.data.id })
          } else {
            toast.show({ message: "Failed to fork session", variant: "error" })
          }
        })
      } else {
        route.navigate({ type: "session", sessionID: match })
      }
    }
  })

  // Handle --session with --fork: wait for sync to be fully complete before forking
  // (session list loads in non-blocking phase for --session, so we must wait for "complete"
  // to avoid a race where reconcile overwrites the newly forked session)
  let forked = false
  createEffect(() => {
    if (forked || sync.status !== "complete" || !args.sessionID || !args.fork) return
    forked = true
    void sdk.client.session.fork({ sessionID: args.sessionID }).then((result) => {
      if (result.data?.id) {
        route.navigate({ type: "session", sessionID: result.data.id })
      } else {
        toast.show({ message: "Failed to fork session", variant: "error" })
      }
    })
  })

  createEffect(
    on(
      () => sync.status === "complete" && sync.data.provider.length === 0,
      (isEmpty, wasEmpty) => {
        // only trigger when we transition into an empty-provider state
        if (!isEmpty || wasEmpty) return
        dialog.replace(() => <DialogProviderList />)
      },
    ),
  )

  const currentWorktreeWorkspace = createMemo(() => {
    const workspaceID = project.workspace.current()
    if (!workspaceID) return
    const workspace = project.workspace.get(workspaceID)
    if (workspace?.type !== "worktree" || !workspace.directory) return
    return workspace
  })

  const openSessionList = () => dialog.replace(() => <DialogSessionList />)
  const newSession = () => {
    route.navigate({ type: "home" })
    dialog.clear()
  }
  const openPanel = (id: string, render: () => JSX.Element) => {
    if (bottomZone.host.top()?.id === id) return
    bottomZone.host.push({ id, render })
  }
  const openWorkspaceList = () => openPanel("workspaces", () => <WorkspacesPanel />)
  const openModelList = () =>
    openPanel("model", () => (
      <ModelPanel
        onConnectProvider={() => dialog.replace(() => <DialogProviderList />)}
        onVariant={() => dialog.replace(() => <DialogVariant />)}
      />
    ))
  const openAgentList = () => openPanel("agent", () => <AgentPanel />)
  const openMcpList = () => openPanel("mcp", () => <McpPanel />)
  const connectProvider = () => dialog.replace(() => <DialogProviderList />)
  const openStatus = () => openPanel("status", () => <StatusPanel />)
  const openThemeList = () => openPanel("theme", () => <ThemePanel />)
  const openHelp = () => openPanel("help", () => <HelpPanel />)
  const openDiff = () => {
    const sessionID =
      route.data.type === "session"
        ? route.data.sessionID
        : route.data.type === "diff"
          ? route.data.params.sessionID
          : undefined
    diffNavigation.open({ mode: "git", sessionID })
    dialog.clear()
  }
  const toggleDebug = () => {
    renderer.toggleDebugOverlay()
    dialog.clear()
  }
  const toggleConsole = () => {
    renderer.console.toggle()
    dialog.clear()
  }
  const writeHeapSnapshot = async () => {
    const files = await props.onSnapshot?.()
    toast.show({
      variant: "info",
      message: `Heap snapshot written to ${files?.join(", ")}`,
      duration: 5000,
    })
    dialog.clear()
  }

  const commandHandlers: Record<string, () => void | Promise<void>> = {
    "session.new": newSession,
    "session.list": openSessionList,
    "workspace.list": openWorkspaceList,
    "model.list": openModelList,
    "agent.list": openAgentList,
    "mcp.list": openMcpList,
    "provider.connect": connectProvider,
    "graphagent.status": openStatus,
    "theme.switch": openThemeList,
    "diff.open": openDiff,
    "help.show": openHelp,
    "app.exit": () => exit(),
    "app.debug": toggleDebug,
    "app.console": toggleConsole,
    "app.heap_snapshot": writeHeapSnapshot,
  }
  for (const [id, handler] of Object.entries(commandHandlers)) {
    onCleanup(commands.setHandler(id, handler))
  }

  const appCommands = createMemo(() => [
    {
      name: COMMAND_PALETTE_COMMAND,
      title: "Show command palette",
      category: "System",
      hidden: true,
      run: () => {
        dialog.replace(() => <CommandPaletteDialog />)
      },
    },
    {
      name: "session.list",
      title: "Switch session",
      category: "Session",
      run: openSessionList,
    },
    {
      name: "session.new",
      title: "New session",
      category: "Session",
      run: newSession,
    },
    {
      name: "workspace.copy_path",
      title: "Copy worktree path",
      category: "Workspace",
      enabled: () => currentWorktreeWorkspace() !== undefined,
      run: async () => {
        const workspace = currentWorktreeWorkspace()
        if (!workspace?.directory) return
        await clipboard
          .write?.(workspace.directory)
          .then(() => toast.show({ message: "Copied worktree path", variant: "info" }))
          .catch(toast.error)
        dialog.clear()
      },
    },
    {
      name: "workspace.list",
      title: "Manage workspaces",
      category: "Workspace",
      hidden: !Flag.GRAPHAGENT_WORKSPACES,
      run: openWorkspaceList,
    },
    ...Array.from({ length: 9 }, (_, i) => ({
      name: `session.quick_switch.${i + 1}`,
      title: `Switch to session in quick slot ${i + 1}`,
      category: "Session",
      hidden: true,
      run: () => {
        local.session.quickSwitch(i + 1)
      },
    })),
    {
      name: "model.list",
      title: "Switch model",
      category: "Agent",
      run: openModelList,
    },
    {
      name: "model.cycle_recent",
      title: "Model cycle",
      category: "Agent",
      hidden: true,
      run: () => {
        local.model.cycle(1)
      },
    },
    {
      name: "model.cycle_recent_reverse",
      title: "Model cycle reverse",
      category: "Agent",
      hidden: true,
      run: () => {
        local.model.cycle(-1)
      },
    },
    {
      name: "model.cycle_favorite",
      title: "Favorite cycle",
      category: "Agent",
      hidden: true,
      run: () => {
        local.model.cycleFavorite(1)
      },
    },
    {
      name: "model.cycle_favorite_reverse",
      title: "Favorite cycle reverse",
      category: "Agent",
      hidden: true,
      run: () => {
        local.model.cycleFavorite(-1)
      },
    },
    {
      name: "agent.list",
      title: "Switch agent",
      category: "Agent",
      run: openAgentList,
    },
    {
      name: "mcp.list",
      title: "Toggle MCPs",
      category: "Agent",
      run: openMcpList,
    },
    {
      name: "agent.cycle",
      title: "Agent cycle",
      category: "Agent",
      hidden: true,
      run: () => {
        local.agent.move(1)
      },
    },
    {
      name: "variant.cycle",
      title: "Variant cycle",
      category: "Agent",
      run: () => {
        local.model.variant.cycle()
      },
    },
    {
      name: "variant.list",
      title: "Switch model variant",
      category: "Agent",
      hidden: local.model.variant.list().length === 0,
      run: () => {
        if (local.model.variant.list().length === 0) {
          return toast.show({
            title: "No variants available",
            message: "The current model does not support any variants.",
            variant: "info",
          })
        }
        dialog.replace(() => <DialogVariant />)
      },
    },
    {
      name: "agent.cycle.reverse",
      title: "Agent cycle reverse",
      category: "Agent",
      hidden: true,
      run: () => {
        local.agent.move(-1)
      },
    },
    {
      name: "provider.connect",
      title: "Connect provider",
      run: connectProvider,
      category: "Provider",
    },
    {
      name: "graphagent.status",
      title: "View status",
      run: openStatus,
      category: "System",
    },
    {
      name: "theme.switch",
      title: "Switch theme",
      run: openThemeList,
      category: "System",
    },
    {
      name: "theme.switch_mode",
      title: mode() === "dark" ? "Switch to light mode" : "Switch to dark mode",
      run: () => {
        setMode(mode() === "dark" ? "light" : "dark")
        dialog.clear()
      },
      category: "System",
    },
    {
      name: "theme.mode.lock",
      title: locked() ? "Unlock theme mode" : "Lock theme mode",
      run: () => {
        if (locked()) unlock()
        else lock()
        dialog.clear()
      },
      category: "System",
    },
    {
      name: "diff.open",
      title: t("diff.command.open"),
      category: "VCS",
      run: openDiff,
    },
    {
      name: "help.show",
      title: "Help",
      run: openHelp,
      category: "System",
    },
    {
      name: "app.exit",
      title: "Exit the app",
      run: () => exit(),
      category: "System",
    },
    {
      name: "app.debug",
      title: "Toggle debug panel",
      category: "System",
      run: toggleDebug,
    },
    {
      name: "app.console",
      title: "Toggle console",
      category: "System",
      run: toggleConsole,
    },
    {
      name: "app.heap_snapshot",
      title: "Write heap snapshot",
      category: "System",
      run: writeHeapSnapshot,
    },
    {
      name: "terminal.suspend",
      title: "Suspend terminal",
      category: "System",
      hidden: true,
      enabled: process.platform !== "win32",
      run: async () => {
        await renderer.suspend()
        process.once("SIGCONT", () => {
          void renderer.resume().catch(() => {})
        })
        process.kill(0, "SIGTSTP")
      },
    },
    {
      name: "terminal.title.toggle",
      title: terminalTitleEnabled() ? "Disable terminal title" : "Enable terminal title",
      category: "System",
      run: () => {
        setTerminalTitleEnabled((prev) => {
          const next = !prev
          kv.set("terminal_title_enabled", next)
          if (!next) renderer.setTerminalTitle("")
          return next
        })
        dialog.clear()
      },
    },
    {
      name: "app.toggle.animations",
      title: kv.get("animations_enabled", true) ? "Disable animations" : "Enable animations",
      category: "System",
      run: () => {
        kv.set("animations_enabled", !kv.get("animations_enabled", true))
        dialog.clear()
      },
    },
    {
      name: "app.toggle.file_context",
      title: kv.get("file_context_enabled", true) ? "Disable file context" : "Enable file context",
      category: "System",
      run: () => {
        kv.set("file_context_enabled", !kv.get("file_context_enabled", true))
        dialog.clear()
      },
    },
    {
      name: "app.toggle.diffwrap",
      title: kv.get("diff_wrap_mode", "word") === "word" ? "Disable diff wrapping" : "Enable diff wrapping",
      category: "System",
      run: () => {
        const current = kv.get("diff_wrap_mode", "word")
        kv.set("diff_wrap_mode", current === "word" ? "none" : "word")
        dialog.clear()
      },
    },
    {
      name: "app.toggle.paste_summary",
      title: pasteSummaryEnabled() ? "Disable paste summary" : "Enable paste summary",
      category: "System",
      run: () => {
        setPasteSummaryEnabled((prev) => {
          const next = !prev
          kv.set("paste_summary_enabled", next)
          return next
        })
        dialog.clear()
      },
    },
    {
      name: "app.toggle.session_directory_filter",
      title: kv.get("session_directory_filter_enabled", true)
        ? "Disable session directory filtering"
        : "Enable session directory filtering",
      category: "System",
      run: async () => {
        kv.set("session_directory_filter_enabled", !kv.get("session_directory_filter_enabled", true))
        await sync.session.refresh()
        dialog.clear()
      },
    },
  ])

  useBindings(() => ({
    commands: appCommands(),
  }))

  useBindings(() => ({
    mode: GRAPHAGENT_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("app", appBindingCommands),
  }))

  useBindings(() => ({
    bindings: tuiConfig.keybinds.gather("app.global", appGlobalBindingCommands),
  }))

  useBindings(() => ({
    mode: GRAPHAGENT_BASE_MODE,
    enabled: () => {
      const current = promptRef.current
      if (!current?.focused) return true
      return current.current.input === ""
    },
    bindings: tuiConfig.keybinds.gather("app_exit", ["app.exit"]),
  }))

  useBindings(() => ({
    mode: GRAPHAGENT_BASE_MODE,
    enabled: () => {
      if (route.data.type === "diff") return false
      const current = promptRef.current
      if (!current?.focused) return true
      if (hasManagedTextareaFocus(renderer)) return false
      return current.current.input === ""
    },
    bindings: tuiConfig.keybinds.gather("help", ["help.show"]),
  }))

  event.on("tui.toast.show", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    toast.show({
      title: evt.properties.title,
      message: evt.properties.message,
      variant: evt.properties.variant,
      duration: evt.properties.duration,
    })
  })

  event.on("session.deleted", (evt) => {
    if (route.data.type === "session" && route.data.sessionID === evt.properties.info.id) {
      route.navigate({ type: "home" })
      toast.show({
        variant: "info",
        message: "The current session was deleted",
      })
    }
  })

  event.on("session.error", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    const error = evt.properties.error
    if (error && typeof error === "object" && error.name === "MessageAbortedError") return
    const message = errorMessage(error)

    toast.show({
      variant: "error",
      message,
      duration: 5000,
    })
  })

  event.on("models-dev.fetch_failed", (evt) => {
    toast.show({
      variant: "warning",
      title: "Model catalog unavailable",
      message: `${evt.properties.source} is unreachable. Using cached or configured providers only. See ${TuiLog.logFilePath()} for details.`,
      duration: 8000,
    })
  })

  const topBar = createMemo(() => {
    const current = local.model.current()
    const info = current
      ? sync.data.provider.find((item) => item.id === current.providerID)?.models[current.modelID]
      : undefined
    const right: TopBarRight = {
      model: info?.name ?? current?.modelID,
      reasoning: local.model.variant.current(),
    }

    if (route.data.type === "session") {
      const messages = sync.data.message[route.data.sessionID] ?? []
      const last = messages.findLast((item) => item.role === "assistant" && item.tokens.output > 0)
      if (last?.role === "assistant") {
        const tokens =
          last.tokens.input +
          last.tokens.output +
          last.tokens.reasoning +
          last.tokens.cache.read +
          last.tokens.cache.write
        const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
        if (model?.limit.context) {
          right.context = t("shell.topBar.context", {
            percent: Math.round((tokens / model.limit.context) * 100),
          })
        }
      }
    }

    return {
      path: route.data.type === "session" ? sync.session.get(route.data.sessionID)?.title : undefined,
      right,
    }
  })

  const drawerContent = createMemo(() => {
    if (route.data.type !== "session") return
    if (!drawer.visible()) return
    if (sync.session.get(route.data.sessionID)?.parentID) return
    return <SessionDrawer sessionID={route.data.sessionID} />
  })

  return (
    <BottomZoneProvider state={bottomZone}>
      <box
        width={dimensions().width}
        height={dimensions().height}
        flexDirection="column"
        backgroundColor={theme.background}
        onMouseDown={(evt) => {
          if (!Flag.GRAPHAGENT_DISABLE_COPY_ON_SELECT) return
          if (evt.button !== MouseButton.RIGHT) return

          if (!Selection.copy(renderer, toast, clipboard)) return
          evt.preventDefault()
          evt.stopPropagation()
        }}
        onMouseUp={
          !Flag.GRAPHAGENT_DISABLE_COPY_ON_SELECT ? () => Selection.copy(renderer, toast, clipboard) : undefined
        }
      >
        <Show when={Flag.GRAPHAGENT_SHOW_TTFD}>
          <TimeToFirstDraw />
        </Show>
        <AppFrame
          topBar={topBar()}
          footer={{
            agent: local.agent.current()?.name,
            agentAction: footerKeys().agent,
            hints: route.data.type === "diff" ? diffFooterHints() : footerKeys().hints,
            meta: route.data.type === "home" ? homeMeta() : undefined,
            right: footerStatus(),
          }}
          bottomZone={<BottomZone state={bottomZone} composer={<></>} />}
          dimmed={bottomZone.dimmed}
          drawer={drawerContent()}
        >
          <Switch>
            <Match when={route.data.type === "home"}>
              <Home />
            </Match>
            <Match when={route.data.type === "session"}>
              <Main />
            </Match>
            <Match when={route.data.type === "diff"}>
              <Diff />
            </Match>
          </Switch>
        </AppFrame>
      </box>
    </BottomZoneProvider>
  )
}
