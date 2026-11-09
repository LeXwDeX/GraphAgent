// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { Session } from "@graphagent/sdk/v2"
import type { TuiPluginApi } from "@graphagent/tui/plugin-api"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { EditorContextProvider } from "../../../src/context/editor"
import { EpilogueProvider } from "../../../src/context/epilogue"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { LocalProvider } from "../../../src/context/local"
import { ProjectProvider } from "../../../src/context/project"
import { PromptRefProvider } from "../../../src/context/prompt"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { SDKProvider, useSDK } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { registerGraphagentKeymap, GraphagentKeymapProvider } from "../../../src/keymap"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { Main } from "../../../src/routes/session"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"

const sessionA = "ses_main_a"
const sessionB = "ses_main_b"
const SLOW_SESSION_MS = 120

const sessions: Record<string, Session> = {
  [sessionA]: {
    id: sessionA,
    slug: "main-a",
    projectID: "proj_test",
    directory,
    title: "Session A",
    version: "test",
    time: { created: 1, updated: 2 },
  },
  [sessionB]: {
    id: sessionB,
    slug: "main-b",
    projectID: "proj_test",
    directory,
    title: "Session B",
    version: "test",
    time: { created: 1, updated: 2 },
  },
}

async function waitFor(predicate: () => boolean, timeout = 3000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

// Counts live `sdk.event.on("event")` registrations so mount/unmount cycles can
// be compared against the provider baseline.
function BusCounter(props: { onReady: (counter: () => number) => void }) {
  const sdk = useSDK()
  let count = 0
  // oxlint-disable-next-line typescript-eslint/unbound-method -- the reference IS the restoration point for onCleanup.
  const original = sdk.event.on
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the overloaded emitter is widened to one call shape for counting.
  const register = original.bind(sdk.event) as (type: string, handler: unknown) => () => void
  const counting = ((type: string, handler: unknown) => {
    const off = register(type, handler)
    if (type !== "event") return off
    count += 1
    let released = false
    return () => {
      if (released) return
      released = true
      count -= 1
      off()
    }
  }) as typeof original
  sdk.event.on = counting
  onCleanup(() => {
    sdk.event.on = original
  })
  props.onReady(() => count)
  return <box />
}

async function mountMain(initialPrompt?: string) {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  const requested: string[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([sessions[sessionA], sessions[sessionB]])
    if (url.pathname === `/session/${sessionA}`) {
      return Bun.sleep(SLOW_SESSION_MS).then(() => json(sessions[sessionA]))
    }
    if (url.pathname === `/session/${sessionB}`) return json(sessions[sessionB])
    if (url.pathname === `/session/${sessionA}/message` || url.pathname === `/session/${sessionB}/message`) return json([])
    if (/^\/session\/[^/]+\/(todo|diff)$/.test(url.pathname)) return json([])
    if (/^\/session\/[^/]+\/goal$/.test(url.pathname)) return json(undefined)
    return undefined
  }, events)
  const fetch = (async (request: RequestInfo | URL) => {
    const url = new URL(request instanceof Request ? request.url : String(request))
    requested.push(url.pathname)
    return calls.fetch(request)
  }) as typeof globalThis.fetch

  const [mounted, setMounted] = createSignal(false)
  let route!: ReturnType<typeof useRoute>
  let sync!: ReturnType<typeof useSync>
  let listeners!: () => number
  let deactivations = 0
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  function Probe() {
    route = useRoute()
    sync = useSync()
    const original = sync.session.deactivate
    sync.session.deactivate = () => {
      deactivations += 1
      original()
    }
    resolveReady()
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const runtime = createPluginRuntime()
    onCleanup(registerGraphagentKeymap(keymap, renderer, config))
    // Production wires the slot registry from the plugin host; with no plugins
    // the registry renders each Slot's fallback children, which is what the
    // real session prompt relies on.
    onMount(() => runtime.setupSlots({ renderer, theme: {} } as unknown as TuiPluginApi))
    return (
      <TestTuiContexts cwd={directory} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <ExitProvider exit={() => {}}>
          <EpilogueProvider set={() => {}}>
            <ClipboardProvider>
              <GraphagentKeymapProvider keymap={keymap}>
                <ArgsProvider>
                  <KVProvider>
                    <ToastProvider>
                      <RouteProvider
                        initialRoute={{
                          type: "session",
                          sessionID: sessionA,
                          prompt: initialPrompt ? { input: initialPrompt, parts: [] } : undefined,
                        }}
                      >
                        <TuiConfigProvider config={config}>
                          <PluginRuntimeProvider value={runtime}>
                            <SDKProvider
                              url="http://test"
                              directory={directory}
                              events={events.source}
                              fetch={fetch}
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
                                                  <BusCounter onReady={(value) => (listeners = value)} />
                                                  <Probe />
                                                  <Show when={mounted()}>
                                                    <Main />
                                                  </Show>
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
                          </PluginRuntimeProvider>
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

  const app = await testRender(() => <Harness />, { width: 80, height: 28 })
  await ready
  await app.renderOnce()
  return {
    app,
    tmp,
    requested,
    listeners: () => listeners(),
    deactivations: () => deactivations,
    sync: () => sync,
    route: () => route,
    async mount() {
      setMounted(true)
      await app.renderOnce()
    },
    async unmount() {
      setMounted(false)
      await app.renderOnce()
    },
    async navigate(sessionID: string) {
      route.navigate({ type: "session", sessionID })
      await app.renderOnce()
    },
  }
}

async function waitForFrame(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await app.renderOnce()
    if (app.captureCharFrame().includes(text)) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${text}:\n${app.captureCharFrame()}`)
}

test("switching sessions activates the new route without hydrating the stale one", async () => {
  const harness = await mountMain()
  try {
    await harness.mount()
    await harness.navigate(sessionB)
    await waitFor(() => harness.requested.includes(`/session/${sessionB}/message`))
    await Bun.sleep(SLOW_SESSION_MS + 120)
    expect(harness.requested).not.toContain(`/session/${sessionA}/message`)
    expect(harness.sync().interest.explicit().has(sessionA)).toBe(false)
    expect(harness.sync().interest.explicit().has(sessionB)).toBe(true)
  } finally {
    harness.app.renderer.destroy()
    await harness.tmp[Symbol.asyncDispose]()
  }
})

test("switching sessions clears the prompt draft", async () => {
  const harness = await mountMain("draft from session A")
  try {
    await harness.mount()
    await waitForFrame(harness.app, "draft from session A")
    await harness.navigate(sessionB)
    await waitFor(() => !harness.app.captureCharFrame().includes("draft from session A"))
  } finally {
    harness.app.renderer.destroy()
    await harness.tmp[Symbol.asyncDispose]()
  }
})

test("unmounting deactivates the session and restores the event listener baseline", async () => {
  const harness = await mountMain()
  try {
    const baseline = harness.listeners()
    await harness.mount()
    await waitFor(() => harness.listeners() > baseline)
    await harness.unmount()
    await waitFor(() => harness.deactivations() > 0)
    await waitFor(() => harness.listeners() === baseline)
  } finally {
    harness.app.renderer.destroy()
    await harness.tmp[Symbol.asyncDispose]()
  }
})
