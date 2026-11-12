// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { ManualClock } from "@opentui/core/testing"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { EditorContextProvider } from "../../src/context/editor"
import { EpilogueProvider } from "../../src/context/epilogue"
import { ExitProvider } from "../../src/context/exit"
import { HookStatusProvider } from "../../src/context/hook-status"
import { KVProvider } from "../../src/context/kv"
import { LocalProvider } from "../../src/context/local"
import { LocationProvider } from "../../src/context/location"
import { ProjectProvider } from "../../src/context/project"
import { PromptRefProvider } from "../../src/context/prompt"
import { RouteProvider } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { TickerProvider } from "../../src/context/ticker-context"
import { registerGraphagentKeymap, GraphagentKeymapProvider } from "../../src/keymap"
import { FrecencyProvider } from "../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../src/prompt/history"
import { PromptStashProvider } from "../../src/prompt/stash"
import { Main } from "../../src/routes/session"
import { FooterToastProvider } from "../../src/ui/toast"
import { tmpdir } from "./fixture"
import { nextTurn } from "./frames"
import { TestTuiContexts } from "./tui-environment"
import { createTuiResolvedConfig } from "./tui-runtime"
import { createEventSource, createFetch, directory, type FetchHandler } from "./tui-sdk"

/**
 * Mounts the production `Main` session view under the provider order of the
 * app, backed by the fake SDK. `fetch` answers the session routes a test cares
 * about; everything else falls through to the shared defaults. The renderer
 * runs on a manual clock: time only passes when `waitForFrame` advances it.
 */
export async function mountSessionMain(input: {
  sessionID: string
  fetch: FetchHandler
  width?: number
  height?: number
}) {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  const calls = createFetch(input.fetch, events)
  const clock = new ManualClock()
  clock.setTime(Date.now())
  let sync!: ReturnType<typeof useSync>

  function Probe() {
    sync = useSync()
    return <Main />
  }

  const app = await testRender(
    () => {
      const renderer = useRenderer()
      const keymap = createDefaultOpenTuiKeymap(renderer)
      const config = createTuiResolvedConfig()
      onCleanup(registerGraphagentKeymap(keymap, renderer, config))
      return (
        <TestTuiContexts cwd={directory} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
          <ExitProvider exit={() => {}}>
            <EpilogueProvider set={() => {}}>
              <ClipboardProvider>
                <GraphagentKeymapProvider keymap={keymap}>
                  <ArgsProvider>
                    <KVProvider>
                      <TickerProvider>
                        <FooterToastProvider>
                          <HookStatusProvider>
                            <RouteProvider initialRoute={{ type: "session", sessionID: input.sessionID }}>
                              <TuiConfigProvider config={config}>
                                <SDKProvider
                                  url="http://test"
                                  directory={directory}
                                  events={events.source}
                                  fetch={calls.fetch}
                                >
                                  <ProjectProvider>
                                    <SyncProvider>
                                      <ThemeProvider mode="dark">
                                        <LocalProvider>
                                          <PromptStashProvider>
                                            <FrecencyProvider>
                                              <PromptHistoryProvider>
                                                <PromptRefProvider>
                                                  <EditorContextProvider integration={{}}>
                                                    <LocationProvider>
                                                      <Probe />
                                                    </LocationProvider>
                                                  </EditorContextProvider>
                                                </PromptRefProvider>
                                              </PromptHistoryProvider>
                                            </FrecencyProvider>
                                          </PromptStashProvider>
                                        </LocalProvider>
                                      </ThemeProvider>
                                    </SyncProvider>
                                  </ProjectProvider>
                                </SDKProvider>
                              </TuiConfigProvider>
                            </RouteProvider>
                          </HookStatusProvider>
                        </FooterToastProvider>
                      </TickerProvider>
                    </KVProvider>
                  </ArgsProvider>
                </GraphagentKeymapProvider>
              </ClipboardProvider>
            </EpilogueProvider>
          </ExitProvider>
        </TestTuiContexts>
      )
    },
    { width: input.width ?? 100, height: input.height ?? 30, clock },
  )

  return {
    app,
    clock,
    events,
    calls,
    get sync() {
      return sync
    },
    async dispose() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

/** One frame of the renderer's manual clock. */
const FRAME_MS = 16

/**
 * Renders frame after frame until `text` shows up on screen and returns that
 * frame. Each round advances the manual clock by one frame, renders (which also
 * flushes the events queued for it), and yields one event-loop turn so requests
 * in flight can finish. The bound is a number of frames, not a duration.
 */
export async function waitForFrame(
  view: { app: Awaited<ReturnType<typeof testRender>>; clock: ManualClock },
  text: string,
  rounds = 500,
) {
  for (let round = 0; round < rounds; round++) {
    view.clock.advance(FRAME_MS)
    await view.app.renderOnce()
    const frame = view.app.captureCharFrame()
    if (frame.includes(text)) return frame
    await nextTurn()
  }
  throw new Error(`"${text}" did not show up after ${rounds} frames:\n${view.app.captureCharFrame()}`)
}
