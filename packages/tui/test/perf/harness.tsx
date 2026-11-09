// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { ScrollBoxRenderable, TextareaRenderable, type Renderable } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { onCleanup, onMount } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { EditorContextProvider } from "../../src/context/editor"
import { EpilogueProvider } from "../../src/context/epilogue"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { LocalProvider } from "../../src/context/local"
import { LocationProvider } from "../../src/context/location"
import { ProjectProvider } from "../../src/context/project"
import { PromptRefProvider, usePromptRef } from "../../src/context/prompt"
import { RouteProvider } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { registerGraphagentKeymap, GraphagentKeymapProvider } from "../../src/keymap"
import { Prompt, type PromptRef } from "../../src/component/prompt"
import { FrecencyProvider } from "../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../src/prompt/history"
import { PromptStashProvider } from "../../src/prompt/stash"
import { Main } from "../../src/routes/session"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory } from "../fixture/tui-sdk"
import { tmpdir } from "../fixture/fixture"
import { backgroundEvent, makeFetchFixture, type PerfFixture, updatePartEvent } from "./fixtures"
import { createCounters, type CounterSnapshot, type PerfCounters } from "./counters"

export type PerfHarness = {
  app: Awaited<ReturnType<typeof testRender>>
  fixture: PerfFixture
  clock: ManualClock
  counters: PerfCounters
  sync: ReturnType<typeof useSync>
  prompt: PromptRef
  emit(event: Parameters<ReturnType<typeof createEventSource>["emit"]>[0]): void
  updateStream(text: string, time: number): void
  tickBackground(tick: number): void
  hideAutocomplete(): void
  reset(): Promise<void>
  scroll(): ScrollBoxRenderable | undefined
  snapshot(): CounterSnapshot
  dispose(): Promise<void>
}

function findNodes(root: Renderable): Renderable[] {
  return [root, ...root.getChildren().flatMap(findNodes)]
}

function findScroll(root: Renderable): ScrollBoxRenderable | undefined {
  return findNodes(root).find((node): node is ScrollBoxRenderable => node instanceof ScrollBoxRenderable)
}

function findPrompt(root: Renderable): PromptRef | undefined {
  const input = findNodes(root).find((node): node is TextareaRenderable => node instanceof TextareaRenderable)
  if (!input) return undefined
  return {
    get focused() {
      return input.focused
    },
    get current() {
      return { input: input.plainText, parts: [] }
    },
    set(prompt) {
      input.setText(prompt.input)
    },
    reset() {
      input.clear()
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    submit() {},
  }
}

export async function mountHarness(fixture: PerfFixture): Promise<PerfHarness> {
  const stateDir = await tmpdir()
  await Bun.write(`${stateDir.path}/kv.json`, "{}")
  const calls = createFetch((url) => makeFetchFixture(fixture, url))
  const events = createEventSource()
  const clock = new ManualClock()
  clock.setTime(Date.now())
  const config = createTuiResolvedConfig()
  const state = {} as {
    sync?: ReturnType<typeof useSync>
    promptRef?: ReturnType<typeof usePromptRef>
    prompt?: NonNullable<ReturnType<typeof usePromptRef>["current"]>
    directPrompt?: PromptRef
  }
  let counters!: PerfCounters
  let keymap!: ReturnType<typeof createDefaultOpenTuiKeymap>

  function Probe() {
    const sync = useSync()
    const promptRef = usePromptRef()
    state.sync = sync
    state.promptRef = promptRef
    onMount(() => {
      state.sync = sync
      state.promptRef = promptRef
    })
    return (
      <>
        <Main />
        <Prompt sessionID={fixture.session.id} visible={true} ref={(value) => (state.directPrompt = value)} />
      </>
    )
  }

  function Harness() {
    const renderer = useRenderer()
    keymap = createDefaultOpenTuiKeymap(renderer)
    counters = createCounters(renderer, keymap)
    onCleanup(registerGraphagentKeymap(keymap, renderer, config))
    onCleanup(() => counters.dispose())
    return (
      <TestTuiContexts cwd={directory} paths={{ home: stateDir.path, state: stateDir.path, worktree: "/tmp/opencode" }}>
        <ExitProvider exit={() => {}}>
          <EpilogueProvider set={() => {}}>
            <ClipboardProvider>
              <GraphagentKeymapProvider keymap={keymap}>
                <ArgsProvider>
                  <KVProvider>
                    <ToastProvider>
                      <RouteProvider initialRoute={{ type: "session", sessionID: fixture.session.id }}>
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
                                      <DialogProvider>
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
                                      </DialogProvider>
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
          </EpilogueProvider>
        </ExitProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 30, clock, gatherStats: true })
  app.renderer.requestRender()
  await app.renderOnce()
  for (let attempt = 0; attempt < 50 && state.sync?.status !== "complete"; attempt++) {
    await app.renderOnce()
    await Bun.sleep(1)
  }
  if (state.sync?.status !== "complete") {
    const frame = app.captureCharFrame()
    app.renderer.destroy()
    throw new Error(`Sync bootstrap did not complete: ${state.sync?.status ?? "missing"}\n${frame}`)
  }
  await app.renderOnce()
  for (let attempt = 0; attempt < 20 && !state.prompt; attempt++) {
    state.prompt = state.promptRef?.current
    if (!state.prompt) await app.renderOnce()
  }
  const prompt = state.directPrompt ?? findPrompt(app.renderer.root)
  if (!prompt) {
    const names = findNodes(app.renderer.root).map((node) => node.constructor.name)
    const frame = app.captureCharFrame()
    app.renderer.destroy()
    await stateDir[Symbol.asyncDispose]()
    throw new Error(
      `Session Prompt did not mount (${names.filter((name) => name.toLowerCase().includes("text")).join(", ")}):\n${frame}`,
    )
  }

  const emit = (event: Parameters<typeof events.emit>[0]) => {
    const type = event.payload.type
    if (type === "message.updated" || type === "message.removed") counters.countStoreWrite("message")
    if (type === "message.part.updated" || type === "message.part.removed") counters.countStoreWrite("part")
    events.emit(event)
  }

  return {
    app,
    fixture,
    clock,
    counters,
    sync: state.sync,
    prompt,
    emit,
    updateStream(text, time) {
      const part =
        fixture.streamPart.type === "text"
          ? { ...fixture.streamPart, type: "text" as const, text }
          : {
              id: fixture.streamPart.id,
              sessionID: fixture.streamPart.sessionID,
              messageID: fixture.streamPart.messageID,
              type: "text" as const,
              text,
              time: { start: time },
            }
      emit(updatePartEvent(part, time, `evt_stream_${time}`))
    },
    tickBackground(tick) {
      fixture.backgroundParts.forEach((part) => emit(backgroundEvent(part, tick)))
    },
    hideAutocomplete() {
      keymap.dispatchCommand("prompt.autocomplete.hide")
    },
    async reset() {
      prompt.reset()
      keymap.dispatchCommand("prompt.autocomplete.hide")
      prompt.focus()
      findScroll(app.renderer.root)?.scrollTo(0)
      await app.renderOnce()
    },
    scroll() {
      return findScroll(app.renderer.root)
    },
    snapshot() {
      return counters.snapshot()
    },
    async dispose() {
      if (!app.renderer.isDestroyed) app.renderer.destroy()
      await stateDir[Symbol.asyncDispose]()
    },
  }
}
