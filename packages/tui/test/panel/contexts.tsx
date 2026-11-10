// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { createBindingLookup } from "@opentui/keymap/extras"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { createEffect, onCleanup, type JSX, type ParentProps } from "solid-js"
import { setLanguage } from "../../src/i18n"
import { TuiKeybind } from "../../src/config/keybind"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { ExitProvider } from "../../src/context/exit"
import { LocalProvider, useLocal } from "../../src/context/local"
import { LocationProvider } from "../../src/context/location"
import { ProjectProvider, useProject } from "../../src/context/project"
import { RouteProvider, useRoute } from "../../src/context/route"
import { SDKProvider, useSDK } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider, useTheme } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider, useKV } from "../../src/context/kv"
import { TickerProvider } from "../../src/context/ticker-context"
import type { Ticker } from "../../src/context/ticker"
import { GraphagentKeymapProvider, registerGraphagentKeymap } from "../../src/keymap"
import { PanelHost, PanelHostProvider, createPanelHost, type PanelHostApi, type PanelSpec } from "../../src/panel/host"
import { PromptStashProvider, usePromptStash } from "../../src/component/prompt/stash"
import { DialogProvider } from "../../src/ui/dialog"
import { BottomZoneProvider, useBottomZone, type BottomZoneStateApi } from "../../src/shell/bottom-zone"
import { FooterToastProvider, useToast } from "../../src/ui/toast"
import { HookStatusProvider, useHookStatus } from "../../src/context/hook-status"
import { createEventSource, createFetch, directory, json, type FetchHandler } from "../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import { ShellContexts } from "../shell/contexts"

function createResolvedKeymapConfig() {
  const keybinds = TuiKeybind.parse({})
  return {
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(keybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: 2000,
  }
}

export function PanelContexts(
  props: ParentProps<{
    state: string
    onReady?: () => void
  }>,
) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const offKeymap = registerGraphagentKeymap(keymap, renderer, createResolvedKeymapConfig())
  onCleanup(offKeymap)

  return (
    <GraphagentKeymapProvider keymap={keymap}>
      <ShellContexts state={props.state} onReady={props.onReady}>
        {props.children}
      </ShellContexts>
    </GraphagentKeymapProvider>
  )
}

/** Mounts one panel spec through a real PanelHost so host hints and bindings apply. */
export function PanelSurface(props: { spec: PanelSpec; onHost?: (host: PanelHostApi) => void }) {
  const host = createPanelHost()
  host.push(props.spec)
  props.onHost?.(host)
  return (
    <PanelHostProvider host={host}>
      <PanelHost host={host} />
    </PanelHostProvider>
  )
}

export async function renderPanel(
  element: () => JSX.Element,
  options: { width: number; height: number; state: string },
) {
  let ready!: () => void
  const settled = new Promise<void>((resolve) => (ready = resolve))
  const app = await testRender(
    () => (
      <PanelContexts state={options.state} onReady={ready}>
        {element()}
      </PanelContexts>
    ),
    { width: options.width, height: options.height },
  )
  await settled
  // KVReady resolves before the reactive switch from its blank fallback has
  // painted; render until the first non-empty frame instead of assuming a
  // fixed number of frames.
  for (let attempt = 0; attempt < 50; attempt++) {
    await app.renderOnce()
    if (app.captureCharFrame().trim().length > 0) break
  }
  // Content measurement settles one render after the first paint.
  for (let attempt = 0; attempt < 3; attempt++) await app.renderOnce()
  return app
}

export interface AppPanelTestContext {
  sync: ReturnType<typeof useSync>
  project: ReturnType<typeof useProject>
  route: ReturnType<typeof useRoute>
  local: ReturnType<typeof useLocal>
  theme: ReturnType<typeof useTheme>
  stash: ReturnType<typeof usePromptStash>
  toast: ReturnType<typeof useToast>
  hooks: ReturnType<typeof useHookStatus>
  sdk: ReturnType<typeof useSDK>
  kv: ReturnType<typeof useKV>
  /** Shared ask state so confirm/choice promises can be driven from tests. */
  bottomZone: BottomZoneStateApi
}

export interface AppPanelContextsProps extends ParentProps<{
  state: string
  /** Language applied after the bootstrap settles (it defaults from the host locale). */
  language?: "zh-CN" | "en"
  /** Runs once the sync bootstrap has settled, before the panel assertions start. */
  setup?: (context: AppPanelTestContext) => void | Promise<void>
  onReady?: () => void
  /** Extra endpoint responses layered over the shared fixture defaults. */
  handler?: FetchHandler
  /** Injected ticker so countdown tests control the one-second signal. */
  ticker?: Ticker
}> {}

/**
 * Full application context tree for panels that read sync, local, project and
 * toast data. The bootstrap is allowed to settle before `setup` seeds stores so
 * reactive reconciliation cannot overwrite the fixtures.
 */
export function AppPanelContexts(props: AppPanelContextsProps) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const offKeymap = registerGraphagentKeymap(keymap, renderer, createResolvedKeymapConfig())
  onCleanup(offKeymap)

  const events = createEventSource()
  const calls = createFetch((url) => {
    const custom = props.handler?.(url)
    if (custom) return custom
    if (/^\/project\/[^/]+\/directories$/.test(url.pathname)) return json([])
    if (/^\/mcp\/[^/]+\/(connect|disconnect)$/.test(url.pathname)) return json({})
    if (url.pathname === "/skill") return json([])
    if (url.pathname === "/experimental/workspace/sync-list") return json([])
    return undefined
  }, events)

  return (
    <GraphagentKeymapProvider keymap={keymap}>
      <TestTuiContexts paths={{ state: props.state }}>
        <ExitProvider exit={() => {}}>
          <ArgsProvider>
            <KVProvider>
              <FooterToastProvider>
                <HookStatusProvider>
                  <ClipboardProvider>
                    <RouteProvider>
                      <TuiConfigProvider config={createTuiResolvedConfig()}>
                        <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
                          <ProjectProvider>
                            <SyncProvider>
                              <ThemeProvider mode="dark">
                                <LocalProvider>
                                  <LocationProvider>
                                    <PromptStashProvider>
                                      <DialogProvider>
                                        <BottomZoneProvider>
                                          <AppPanelSetup
                                            language={props.language}
                                            setup={props.setup}
                                            onReady={props.onReady}
                                          >
                                            <TickerProvider ticker={props.ticker}>{props.children}</TickerProvider>
                                          </AppPanelSetup>
                                        </BottomZoneProvider>
                                      </DialogProvider>
                                    </PromptStashProvider>
                                  </LocationProvider>
                                </LocalProvider>
                              </ThemeProvider>
                            </SyncProvider>
                          </ProjectProvider>
                        </SDKProvider>
                      </TuiConfigProvider>
                    </RouteProvider>
                  </ClipboardProvider>
                </HookStatusProvider>
              </FooterToastProvider>
            </KVProvider>
          </ArgsProvider>
        </ExitProvider>
      </TestTuiContexts>
    </GraphagentKeymapProvider>
  )
}

function AppPanelSetup(
  props: ParentProps<{
    language?: "zh-CN" | "en"
    setup?: (context: AppPanelTestContext) => void | Promise<void>
    onReady?: () => void
  }>,
) {
  const sync = useSync()
  const project = useProject()
  const route = useRoute()
  const local = useLocal()
  const theme = useTheme()
  const stash = usePromptStash()
  const toast = useToast()
  const hooks = useHookStatus()
  const sdk = useSDK()
  const kv = useKV()
  const bottomZone = useBottomZone()
  let seeded = false

  createEffect(() => {
    if (seeded || sync.status !== "complete") return
    seeded = true
    // The bootstrap applies the language from the resolved config, which the
    // fixture leaves unset; pin it after the bootstrap so panel assertions do
    // not depend on the host locale.
    setLanguage(props.language ?? "zh-CN")
    void Promise.resolve(
      props.setup?.({ sync, project, route, local, theme, stash, toast, hooks, sdk, kv, bottomZone }),
    ).then(() => {
      props.onReady?.()
    })
  })

  return <>{props.children}</>
}

export async function renderAppPanel(
  element: () => JSX.Element,
  options: {
    width: number
    height: number
    state: string
    setup?: (context: AppPanelTestContext) => void | Promise<void>
    handler?: FetchHandler
    ticker?: Ticker
  },
) {
  let ready!: () => void
  const settled = new Promise<void>((resolve) => (ready = resolve))
  const app = await testRender(
    () => (
      <AppPanelContexts
        state={options.state}
        setup={options.setup}
        handler={options.handler}
        ticker={options.ticker}
        onReady={ready}
      >
        {element()}
      </AppPanelContexts>
    ),
    { width: options.width, height: options.height },
  )
  await settled
  for (let attempt = 0; attempt < 50; attempt++) {
    await app.renderOnce()
    if (app.captureCharFrame().trim().length > 0) break
  }
  for (let attempt = 0; attempt < 3; attempt++) await app.renderOnce()
  return app
}
