/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import type { Event, GlobalEvent } from "@opencode-ai/sdk/v2"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { Prompt } from "../../../src/component/prompt"
import { TuiConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { EditorContextProvider } from "../../../src/context/editor"
import { EpilogueProvider } from "../../../src/context/epilogue"
import { useEvent } from "../../../src/context/event"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { LocalProvider } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { ProjectProvider } from "../../../src/context/project"
import { PromptRefProvider } from "../../../src/context/prompt"
import { RouteProvider } from "../../../src/context/route"
import { SDKProvider, useSDK } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { Session } from "../../../src/routes/session"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"

// Route components (routes/session/index.tsx, component/prompt/index.tsx)
// subscribe to app-level events via `onCleanup(event.on(...))` so the
// handler dies with the owning scope. These tests pin that contract at the
// seam it depends on: while the SDKProvider (app lifetime) stays alive,
// unmounting the owning component must remove its handler from the
// app-level emitter, and mount/unmount cycles must not accumulate handlers.

const sessionID = "ses_route"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function event(payload: Event): GlobalEvent {
  return { directory, payload }
}

function partUpdated(text: string): Event {
  return {
    id: `evt_${text}`,
    type: "message.part.updated",
    properties: {
      sessionID,
      time: 1,
      part: { id: `part_${text}`, sessionID, messageID: "msg_1", type: "text", text },
    },
  }
}

// Mirrors the production subscription shape: the unsubscribe returned by
// event.on is registered with onCleanup in the component body.
function RouteProbe(props: { received: string[] }) {
  const event = useEvent()
  onCleanup(
    event.on("message.part.updated", (evt) => {
      if (evt.properties.part.type !== "text") return
      props.received.push(evt.properties.part.text)
    }),
  )
  return <box />
}

// Root-level subscription that never unmounts. When it has observed an
// event, the emitter batch has flushed, so any still-registered route
// handler would have observed it in the same pass.
function ControlProbe(props: { received: string[]; onReady: () => void }) {
  const event = useEvent()
  onCleanup(event.subscribe((evt) => props.received.push(evt.id)))
  onMount(() => props.onReady())
  return <box />
}

async function mount() {
  const events = createEventSource()
  const calls = createFetch()
  const route: string[] = []
  const control: string[] = []
  const [mounted, setMounted] = createSignal(true)
  let ready!: () => void
  const done = new Promise<void>((resolve) => {
    ready = resolve
  })

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ControlProbe received={control} onReady={ready} />
        <Show when={mounted()}>
          <RouteProbe received={route} />
        </Show>
      </SDKProvider>
    </TestTuiContexts>
  ))

  await done
  return {
    app,
    emit: (e: GlobalEvent) => events.emit(e),
    route,
    control,
    unmount: () => setMounted(false),
    remount: () => setMounted(true),
  }
}

describe("event.on cleanup", () => {
  test("unmounted component stops receiving events while the SDK provider lives", async () => {
    const { app, emit, route, control, unmount } = await mount()

    try {
      emit(event(partUpdated("before")))
      await wait(() => control.includes("evt_before"))
      expect(route).toEqual(["before"])

      unmount()
      emit(event(partUpdated("after")))
      await wait(() => control.includes("evt_after"))
      expect(route).toEqual(["before"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("mount/unmount cycles do not accumulate handlers", async () => {
    const { app, emit, route, control, unmount, remount } = await mount()

    try {
      unmount()
      remount()
      unmount()
      remount()

      emit(event(partUpdated("single")))
      await wait(() => control.includes("evt_single"))
      expect(route).toEqual(["single"])
    } finally {
      app.renderer.destroy()
    }
  })
})

// The seam tests above pin the event-context contract with a probe that
// mirrors the production subscription shape. The tests below mount the REAL
// route components (routes/session, component/prompt) that #502 wrapped in
// `onCleanup(event.on(...))` and count listeners on the real SDK event
// emitter: mounting must add listeners, unmounting must return the bus to
// the pre-mount baseline, and mount/unmount cycles must not accumulate.
// Removing any of the production `onCleanup` wrappers leaves a listener
// behind and turns these red.

const routeSessionID = "ses_real_route"

const routeSession = {
  id: routeSessionID,
  title: "event cleanup",
  time: { created: 0, updated: 0 },
  version: "1.17.11",
  directory,
}

function routeFetch(url: URL) {
  if (url.pathname === `/session/${routeSessionID}`) return json(routeSession)
  if (url.pathname.startsWith(`/session/${routeSessionID}/`)) return json([])
  return undefined
}

// Counting bridge installed on the real bus seam: every `useEvent()`
// registration (Session, Prompt, and anything they mount) flows through
// `sdk.event.on("event", ...)`, so wrapping that method yields the net
// listener count without touching component internals. Subscriptions the
// providers install before the bridge are app-lifetime constants and stay
// outside the count; the baseline is captured after the full provider stack
// reports ready.
function BusCounter(props: { onReady: (counter: () => number) => void }) {
  const sdk = useSDK()
  let count = 0
  // oxlint-disable-next-line typescript-eslint/unbound-method -- the reference IS the restoration point for onCleanup; every invocation goes through bind with an explicit receiver.
  const original = sdk.event.on
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- sdk.event.on is overloaded; the counting bridge needs one widened call signature and bind preserves the receiver.
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

function SyncProbe(props: { onSync: (sync: ReturnType<typeof useSync>) => void }) {
  props.onSync(useSync())
  return <box />
}

// Mirrors the production provider stack from src/app.tsx (same order, test
// fixtures for config/keymap/paths/fetch). The route component is gated
// behind a signal so the baseline can be captured before it mounts.
async function mountRoute(view: "session" | "prompt", messages: unknown[] = [], hideDetails = false) {
  const tmp = await tmpdir()
  await Bun.write(
    `${tmp.path}/kv.json`,
    JSON.stringify({ tool_details_visibility: !hideDetails, generic_tool_output_visibility: false }),
  )
  const events = createEventSource()
  const calls = createFetch((url) =>
    url.pathname === `/session/${routeSessionID}/message` ? json(messages) : routeFetch(url),
  )
  const [mounted, setMounted] = createSignal(false)
  let sync!: ReturnType<typeof useSync>
  let counter!: () => number
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))

    return (
      <TestTuiContexts cwd={directory} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <ExitProvider exit={() => {}}>
          <EpilogueProvider set={() => {}}>
            <ClipboardProvider>
              <OpencodeKeymapProvider keymap={keymap}>
                <ArgsProvider>
                  <KVProvider>
                    <ToastProvider>
                      <RouteProvider initialRoute={{ type: "session", sessionID: routeSessionID }}>
                        <TuiConfigProvider config={config}>
                          <PluginRuntimeProvider value={createPluginRuntime()}>
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
                                                      <BusCounter
                                                        onReady={(count) => {
                                                          counter = count
                                                          resolveReady()
                                                        }}
                                                      />
                                                      <SyncProbe onSync={(value) => (sync = value)} />
                                                      <Show when={mounted()}>
                                                        {view === "session" ? (
                                                          <Session />
                                                        ) : (
                                                          <Prompt sessionID={routeSessionID} />
                                                        )}
                                                      </Show>
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
                          </PluginRuntimeProvider>
                        </TuiConfigProvider>
                      </RouteProvider>
                    </ToastProvider>
                  </KVProvider>
                </ArgsProvider>
              </OpencodeKeymapProvider>
            </ClipboardProvider>
          </EpilogueProvider>
        </ExitProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 80, height: 24 })
  await ready
  await wait(() => sync.status === "complete")
  return {
    app,
    baseline: counter(),
    counter,
    mount: () => setMounted(true),
    unmount: () => setMounted(false),
    async dispose() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

describe("real route component event cleanup", () => {
  test("Session route returns the event bus to its baseline listener count after unmount", async () => {
    const route = await mountRoute("session")

    try {
      route.mount()
      await wait(() => route.counter() > route.baseline)
      route.unmount()
      expect(route.counter()).toBe(route.baseline)

      route.mount()
      await wait(() => route.counter() > route.baseline)
      route.unmount()
      expect(route.counter()).toBe(route.baseline)
    } finally {
      await route.dispose()
    }
  })
})

describe("workflow failure rendering in the real session route", () => {
  for (const legacy of [true, false]) {
    test(`shows ${legacy ? "historical validation" : "blocked start"} with both output toggles disabled`, async () => {
      const messages = [
        {
          info: {
            id: "msg_failure",
            sessionID: routeSessionID,
            role: "assistant",
            parentID: "msg_user",
            time: { created: 1, completed: 2 },
            agent: "build",
            mode: "build",
            providerID: "test",
            modelID: "test",
            path: { cwd: directory, root: directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          },
          parts: [
            {
              id: "part_failure",
              sessionID: routeSessionID,
              messageID: "msg_failure",
              type: "tool",
              callID: "call_failure",
              tool: "workflow",
              state: {
                status: "completed",
                input: { params: { action: legacy ? "validate" : "start" } },
                title: "Workflow validation failed",
                time: { start: 1, end: 2 },
                metadata: legacy
                  ? {}
                  : { blocked: true, diagnosticSummary: "[model.unavailable] unavailable worker model" },
                output: JSON.stringify({
                  valid: false,
                  errors: [{ code: "model.unavailable", message: "unavailable worker model" }],
                }),
              },
            },
          ],
        },
      ]
      const route = await mountRoute("session", messages, true)
      try {
        route.mount()
        let frame = ""
        for (let i = 0; i < 100; i++) {
          await route.app.renderOnce()
          frame = route.app.captureCharFrame()
          if (frame.includes("model.unavailable")) break
          await Bun.sleep(10)
        }
        expect(frame).toContain("workflow: blocked")
        expect(frame).toContain("model.unavailable")
        expect(frame).toContain("unavailable worker model")
      } finally {
        await route.dispose()
      }
    })
  }
})
