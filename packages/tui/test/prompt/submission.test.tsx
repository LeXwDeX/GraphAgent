/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionAttentionInput } from "../../../schema/src/session-attention"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createSignal, onCleanup, Show } from "solid-js"
import { Prompt, type PromptRef } from "../../src/component/prompt"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { DataProvider } from "../../src/context/data"
import { EditorContextProvider, useEditorContext, type EditorIntegration } from "../../src/context/editor"
import { EpilogueProvider } from "../../src/context/epilogue"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { LocalProvider, useLocal } from "../../src/context/local"
import { LocationProvider } from "../../src/context/location"
import { ProjectProvider } from "../../src/context/project"
import { PromptRefProvider } from "../../src/context/prompt"
import { RouteProvider, useRoute } from "../../src/context/route"
import { SDKProvider, useSDK } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { createPluginRuntime, PluginRuntimeProvider } from "../../src/plugin/runtime"
import { FrecencyProvider } from "../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../src/prompt/history"
import { PromptStashProvider } from "../../src/prompt/stash"
import { Session } from "../../src/routes/session"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider, Toast } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

let prompt: PromptRef | undefined
let createStarted = false
let releaseCreate!: () => void
const createGate = new Promise<void>((r) => (releaseCreate = r))
const sent: Array<{ parts: unknown[] }> = []
const routeSessionID = "ses_real_route"

const routeSession = {
  id: routeSessionID,
  title: "event cleanup",
  slug: "test-session",
  projectID: "proj_test",
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

function PromptRoute(props: { sessionID?: string }) {
  const route = useRoute()
  return (
    <Show
      when={!props.sessionID && route.data.type === "session"}
      fallback={
        <Prompt
          sessionID={props.sessionID}
          ref={(value) => {
            prompt = value
          }}
        />
      }
    >
      <Prompt
        sessionID={route.data.type === "session" ? route.data.sessionID : undefined}
        ref={(value) => {
          prompt = value
        }}
      />
    </Show>
  )
}

function LocalProbe(props: { ready: (value: ReturnType<typeof useLocal>) => void }) {
  props.ready(useLocal())
  return <box />
}

function RouteProbe(props: { ready: (value: ReturnType<typeof useRoute>) => void }) {
  props.ready(useRoute())
  return <box />
}

function EditorProbe(props: { ready: (value: ReturnType<typeof useEditorContext>) => void }) {
  props.ready(useEditorContext())
  return <box />
}

// Mirrors the production provider stack from src/app.tsx (same order, test
// fixtures for config/keymap/paths/fetch). The route component is gated
// behind a signal so the baseline can be captured before it mounts.
async function mountRoute(
  view: "session" | "prompt",
  messages: unknown[] = [],
  hideDetails = false,
  override?: (url: URL, request: Request) => Response | Promise<Response | undefined> | undefined,
  sessionID?: string,
  editorIntegration?: EditorIntegration,
) {
  prompt = undefined
  const tmp = await tmpdir()
  await Bun.write(
    `${tmp.path}/kv.json`,
    JSON.stringify({ tool_details_visibility: !hideDetails, generic_tool_output_visibility: false }),
  )
  const events = createEventSource()
  const base = createFetch((url) =>
    url.pathname === `/session/${routeSessionID}/message` ? json(messages) : routeFetch(url),
  )
  const calls = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init)
      const url = new URL(req.url)
      const overridden = await override?.(url, req)
      if (overridden) return overridden
      if (url.pathname === "/session" && req.method === "POST") {
        createStarted = true
        await createGate
        return json(routeSession)
      }
      if (url.pathname === `/session/${routeSessionID}/message` && req.method === "POST") {
        sent.push(await req.json())
        return json({})
      }
      return base.fetch(req)
    },
  }
  const [mounted, setMounted] = createSignal(false)
  let local!: ReturnType<typeof useLocal>
  let navigation!: ReturnType<typeof useRoute>
  let editor!: ReturnType<typeof useEditorContext>
  let sync!: ReturnType<typeof useSync>
  let keymap!: ReturnType<typeof createDefaultOpenTuiKeymap>
  let counter!: () => number
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  function Harness() {
    const renderer = useRenderer()
    keymap = createDefaultOpenTuiKeymap(renderer)
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
                      <RouteProvider initialRoute={{ type: "home" }}>
                        <RouteProbe ready={(value) => (navigation = value)} />
                        <TuiConfigProvider config={config}>
                          <PluginRuntimeProvider value={createPluginRuntime()}>
                            <SDKProvider
                              url="http://test"
                              directory={directory}
                              events={events.source}
                              fetch={Object.assign(calls.fetch, { preconnect: globalThis.fetch.preconnect })}
                            >
                              <ProjectProvider>
                                <SyncProvider>
                                  <DataProvider>
                                    <ThemeProvider mode="dark">
                                      <Toast />
                                      <LocalProvider>
                                        <LocalProbe
                                          ready={(value) => {
                                            local = value
                                          }}
                                        />
                                        <PromptStashProvider>
                                          <DialogProvider>
                                            <FrecencyProvider>
                                              <PromptHistoryProvider>
                                                <PromptRefProvider>
                                                  <EditorContextProvider integration={editorIntegration ?? {}}>
                                                    <EditorProbe
                                                      ready={(value) => {
                                                        editor = value
                                                      }}
                                                    />
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
                                                          <PromptRoute sessionID={sessionID} />
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
                                  </DataProvider>
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
  await wait(() => sync.ready)
  return {
    app,
    baseline: counter(),
    sync,
    events,
    keymap,
    editor,
    local,
    navigation,
    counter,
    mount: () => setMounted(true),
    unmount: () => setMounted(false),
    async dispose() {
      prompt?.reset()
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

function configureModel(route: Awaited<ReturnType<typeof mountRoute>>) {
  route.sync.set("agent", [{ name: "build", mode: "primary", hidden: false, options: {}, permission: [] }])
  route.sync.set("provider", [
    {
      id: "test",
      name: "test",
      source: "config",
      env: [],
      options: {},
      models: {
        m: {
          id: "m",
          name: "m",
          providerID: "test",
          api: { id: "m", url: "http://test", npm: "test" },
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-01-01",
          capabilities: {
            temperature: false,
            reasoning: false,
            attachment: true,
            toolcall: true,
            input: { text: true, audio: false, image: true, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          limit: { context: 10000, output: 1000 },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          variants: {},
        },
      },
    },
  ])
}

test("submission snapshots the draft before delayed session creation and preserves later edits", async () => {
  const route = await mountRoute("prompt")
  try {
    configureModel(route)
    route.mount()
    await wait(() => Boolean(prompt))
    await route.app.renderOnce()
    const attachment = {
      type: "file" as const,
      mime: "image/png",
      url: "data:image/png;base64,AA==",
      filename: "original.png",
      source: { type: "file" as const, path: "original.png", text: { start: 6, end: 15, value: "[Image 1]" } },
    }
    prompt!.set({ input: "FIRST [Image 1]", parts: [attachment] })
    prompt!.focus()
    prompt!.submit()
    prompt!.submit()
    await wait(() => createStarted)
    await route.app.renderOnce()
    const immediateFeedback = route.app.captureCharFrame().includes("Sending prompt")
    prompt!.set({ input: "SECOND", parts: [] })
    releaseCreate()
    await wait(() => sent.length > 0)
    await route.app.renderOnce()
    expect(sent).toHaveLength(1)
    expect(sent[0].parts).toContainEqual({ type: "text", text: "FIRST [Image 1]" })
    expect(sent[0].parts).toContainEqual(attachment)
    expect(prompt!.current.input).toBe("SECOND")
    expect(immediateFeedback).toBe(true)
  } finally {
    releaseCreate()
    await route.dispose()
  }
})

test("console state does not block core bootstrap readiness", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const mounting = mountRoute("prompt", [], false, async (url) => {
    if (url.pathname !== "/experimental/console") return undefined
    await gate
    return json({ consoleManagedProviders: [], switchableOrgCount: 0 })
  })
  let route: Awaited<ReturnType<typeof mountRoute>> | undefined
  try {
    // mountRoute waits for full sync readiness, exercising the actual provider.
    route = await mounting
    expect(route.sync.ready).toBe(true)
  } finally {
    release()
    route ??= await mounting
    await route.dispose()
  }
})

test("session core hydrates while ancillary requests wait and live events win", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const route = await mountRoute("prompt", [], false, async (url) => {
    if (!["todo", "diff", "goal"].some((kind) => url.pathname === `/session/${routeSessionID}/${kind}`))
      return undefined
    await gate
    return json([])
  })
  try {
    await route.sync.session.sync(routeSessionID)
    expect(route.sync.session.get(routeSessionID)?.id).toBe(routeSessionID)
    const todos = [{ content: "live update", status: "pending", priority: "high" }]
    route.events.emit({
      directory,
      payload: { id: "evt_test", type: "todo.updated", properties: { sessionID: routeSessionID, todos } },
    })
    await wait(() => route.sync.data.todo[routeSessionID]?.length === 1)
    release()
    await Bun.sleep(30)
    expect(route.sync.data.todo[routeSessionID]).toEqual(todos)
  } finally {
    release()
    await route.dispose()
  }
})

test("cancellation is immediately stopping, survives HTTP success, and ends on server idle", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let aborts = 0
  const route = await mountRoute(
    "prompt",
    [],
    false,
    async (url) => {
      if (url.pathname !== `/session/${routeSessionID}/abort`) return undefined
      aborts++
      await gate
      return json(true)
    },
    routeSessionID,
  )
  try {
    await wait(() => route.sync.status === "complete")
    route.sync.set("session_status", routeSessionID, { type: "busy" })
    route.mount()
    await wait(() => Boolean(prompt))
    prompt!.focus()
    await route.app.renderOnce()
    route.app.mockInput.pressKey("ESCAPE")
    route.app.mockInput.pressKey("ESCAPE")
    await wait(() => aborts === 1)
    await route.app.renderOnce()
    expect(route.app.captureCharFrame()).toContain("Stopping")
    release()
    await Bun.sleep(20)
    await route.app.renderOnce()
    expect(route.app.captureCharFrame()).toContain("Stopping")
    route.sync.set("session_status", routeSessionID, { type: "idle" })
    await route.app.renderOnce()
    expect(route.app.captureCharFrame()).not.toContain("Stopping")
  } finally {
    release()
    await route.dispose()
  }
})

for (const newerDraft of [false, true]) {
  test(`failed submission ${newerDraft ? "preserves newer draft and can restore failed input" : "restores its owned empty draft"}`, async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let requested = false
    const route = await mountRoute(
      "prompt",
      [],
      false,
      async (url) => {
        if (url.pathname !== `/session/${routeSessionID}/message`) return undefined
        requested = true
        await gate
        return json({ error: "failed" }, { status: 500 })
      },
      routeSessionID,
    )
    try {
      route.sync.set("agent", [{ name: "build", mode: "primary", hidden: false, options: {}, permission: [] }])
      route.sync.set("provider", [
        {
          id: "test",
          name: "test",
          source: "config",
          env: [],
          options: {},
          models: {
            m: {
              id: "m",
              name: "m",
              providerID: "test",
              api: { id: "m", url: "http://test", npm: "test" },
              status: "active",
              options: {},
              headers: {},
              release_date: "2026-01-01",
              capabilities: {
                temperature: false,
                reasoning: false,
                attachment: true,
                toolcall: true,
                input: { text: true, audio: false, image: true, video: false, pdf: false },
                output: { text: true, audio: false, image: false, video: false, pdf: false },
                interleaved: false,
              },
              limit: { context: 10000, output: 1000 },
              cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
              variants: {},
            },
          },
        },
      ])
      route.mount()
      await wait(() => Boolean(prompt))
      const attachment = {
        type: "file" as const,
        mime: "image/png",
        url: "data:image/png;base64,AA==",
        filename: "original.png",
        source: { type: "file" as const, path: "original.png", text: { start: 11, end: 20, value: "[Image 1]" } },
      }
      prompt!.set({ input: "recover me [Image 1]", parts: [attachment] })
      prompt!.submit()
      await wait(() => requested)
      if (newerDraft) prompt!.set({ input: "keep writing", parts: [] })
      release()
      if (newerDraft) {
        await wait(() =>
          route.keymap
            .getCommands()
            .some((command) => command.name === "prompt.restore_failed" && command.enabled !== false),
        )
        expect(prompt!.current.input).toBe("keep writing")
        expect(route.keymap.runCommand("prompt.restore_failed").ok).toBe(true)
      }
      await wait(() => prompt!.current.input === "recover me [Image 1]")
      expect(prompt!.current.parts).toEqual([attachment])
    } finally {
      release()
      await route.dispose()
    }
  })
}

test("cancel failure is visible, retryable, and a stale failure cannot clear a newer stop", async () => {
  const releases: Array<() => void> = []
  let aborts = 0
  const route = await mountRoute(
    "prompt",
    [],
    false,
    async (url) => {
      if (url.pathname !== `/session/${routeSessionID}/abort`) return undefined
      aborts++
      await new Promise<void>((resolve) => releases.push(resolve))
      return json({ error: "stop unavailable" }, { status: 500 })
    },
    routeSessionID,
  )
  try {
    await wait(() => route.sync.status === "complete")
    route.sync.set("session_status", routeSessionID, { type: "busy" })
    route.mount()
    await wait(() => Boolean(prompt))
    prompt!.focus()
    const cancel = async () => {
      route.app.mockInput.pressKey("ESCAPE")
      route.app.mockInput.pressKey("ESCAPE")
      await route.app.renderOnce()
    }
    await cancel()
    await wait(() => aborts === 1)
    releases[0]()
    await Bun.sleep(20)
    await route.app.renderOnce()
    expect(route.app.captureCharFrame()).toContain("Failed to stop session")
    await cancel()
    await wait(() => aborts === 2)
    route.sync.set("session_status", routeSessionID, { type: "idle" })
    await route.app.renderOnce()
    route.sync.set("session_status", routeSessionID, { type: "busy" })
    await cancel()
    await wait(() => aborts === 3)
    releases[1]()
    await Bun.sleep(20)
    await route.app.renderOnce()
    expect(route.app.captureCharFrame()).toContain("Stopping")
    releases[2]()
    await Bun.sleep(20)
    await route.app.renderOnce()
    expect(route.app.captureCharFrame()).not.toContain("Stopping")
    route.unmount()
    expect(route.counter()).toBe(route.baseline)
  } finally {
    for (const release of releases) release()
    await route.dispose()
  }
})

test("secondary endpoint failure stays local and a live update clears its error", async () => {
  const route = await mountRoute("prompt", [], false, (url) => {
    if (url.pathname === "/experimental/console" || url.pathname === `/session/${routeSessionID}/todo`)
      return json({ error: "unavailable" }, { status: 500 })
    return undefined
  })
  try {
    expect(route.sync.ready).toBe(true)
    await route.sync.session.sync(routeSessionID)
    await wait(() => route.sync.data.session_load_errors[routeSessionID]?.includes("todo") ?? false)
    expect(route.sync.session.get(routeSessionID)?.id).toBe(routeSessionID)
    route.events.emit({
      directory,
      payload: { id: "evt_test", type: "todo.updated", properties: { sessionID: routeSessionID, todos: [] } },
    })
    await wait(() => route.sync.data.session_load_errors[routeSessionID]?.length === 0)
  } finally {
    await route.dispose()
  }
})

test("failed editor-context submission keeps the selection pending and retries the same context", async () => {
  const previous = process.env.ZED_TERM
  process.env.ZED_TERM = "true"
  const requests: Array<{ parts: Array<{ type: string; synthetic?: boolean; metadata?: { kind?: string } }> }> = []
  let route: Awaited<ReturnType<typeof mountRoute>> | undefined
  try {
    route = await mountRoute(
      "prompt",
      [],
      false,
      async (url, request) => {
        if (url.pathname !== `/session/${routeSessionID}/message` || request.method !== "POST") return undefined
        requests.push(await request.json())
        return requests.length === 1 ? json({ error: "failed" }, { status: 500 }) : json({})
      },
      routeSessionID,
      {
        selection: async () => ({
          type: "selection",
          selection: {
            filePath: "/tmp/original.ts",
            ranges: [
              {
                text: "const original = 1",
                selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 18 } },
              },
            ],
          },
        }),
      },
    )
    configureModel(route)
    route.mount()
    await wait(() => Boolean(prompt) && route!.editor.labelState() === "pending")
    prompt!.set({ input: "with editor", parts: [] })
    prompt!.submit()
    await wait(() => requests.length === 1 && prompt!.current.input === "with editor")
    expect(route.editor.labelState()).toBe("pending")
    const original = requests[0].parts.filter((part) => part.synthetic && part.metadata?.kind === "editor_context")
    expect(original).toHaveLength(1)
    prompt!.submit()
    await wait(() => requests.length === 2)
    expect(requests[1].parts.filter((part) => part.synthetic && part.metadata?.kind === "editor_context")).toEqual(
      original,
    )
  } finally {
    await route?.dispose()
    if (previous === undefined) delete process.env.ZED_TERM
    else process.env.ZED_TERM = previous
  }
})

test("new-session navigation retains pending feedback and failed input without overwriting its next draft", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let requested = false
  const route = await mountRoute("prompt", [], false, async (url, request) => {
    if (url.pathname !== `/session/${routeSessionID}/message` || request.method !== "POST") return undefined
    requested = true
    await gate
    return json({ error: "failed" }, { status: 500 })
  })
  try {
    configureModel(route)
    route.mount()
    await wait(() => Boolean(prompt))
    const original = prompt
    prompt!.set({ input: "new session input", parts: [] })
    prompt!.submit()
    await wait(() => requested)
    await wait(() => Boolean(prompt) && prompt !== original)
    await route.app.renderOnce()
    expect(route.app.captureCharFrame()).toContain("Sending prompt")
    prompt!.set({ input: "newer draft", parts: [] })
    release()
    await wait(() => Boolean(route.sync.data.failed_submission[routeSessionID]))
    expect(prompt!.current.input).toBe("newer draft")
    expect(route.keymap.runCommand("prompt.restore_failed").ok).toBe(true)
    expect(prompt!.current.input).toBe("new session input")
  } finally {
    release()
    await route.dispose()
  }
})

test("session creation completing after Prompt unmount never mutates its destroyed editor", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let creating = false
  let sentAfterUnmount = false
  const route = await mountRoute("prompt", [], false, async (url, request) => {
    if (url.pathname === "/session" && request.method === "POST") {
      creating = true
      await gate
      return json(routeSession)
    }
    if (url.pathname === `/session/${routeSessionID}/message` && request.method === "POST") {
      sentAfterUnmount = true
      return json({})
    }
    return undefined
  })
  try {
    configureModel(route)
    route.mount()
    await wait(() => Boolean(prompt))
    prompt!.set({ input: "submitted before leaving", parts: [] })
    prompt!.submit()
    await wait(() => creating)
    route.unmount()
    release()
    await wait(() => sentAfterUnmount)
    expect(route.counter()).toBe(route.baseline)
  } finally {
    release()
    await route.dispose()
  }
})

for (const deleted of [false, true]) {
  test(`late session hydration preserves ${deleted ? "deletion" : "live metadata"}`, async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let requested = false
    const route = await mountRoute("prompt", [], false, async (url) => {
      if (url.pathname !== `/session/${routeSessionID}`) return undefined
      requested = true
      await gate
      return json(routeSession)
    })
    try {
      const task = route.sync.session.sync(routeSessionID)
      await wait(() => requested)
      route.events.emit({
        directory,
        payload: {
          id: "evt_metadata",
          type: deleted ? "session.deleted" : "session.updated",
          properties: { sessionID: routeSessionID, info: { ...routeSession, title: "live title" } },
        },
      })
      await Bun.sleep(10)
      release()
      await task
      expect(route.sync.session.get(routeSessionID)?.title).toBe(deleted ? undefined : "live title")
    } finally {
      release()
      await route.dispose()
    }
  })
}

test("authoritative user message reconciles pending once and a later response failure cannot restore duplicates", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let messageID = ""
  const route = await mountRoute(
    "prompt",
    [],
    false,
    async (url, request) => {
      if (url.pathname !== `/session/${routeSessionID}/message` || request.method !== "POST") return undefined
      messageID = (await request.json()).messageID
      await gate
      return json({ error: "response failed after acceptance" }, { status: 500 })
    },
    routeSessionID,
  )
  try {
    configureModel(route)
    route.mount()
    await wait(() => Boolean(prompt))
    prompt!.set({ input: "accepted once", parts: [] })
    prompt!.submit()
    await wait(() => Boolean(messageID))
    const info = {
      id: messageID,
      sessionID: routeSessionID,
      role: "user" as const,
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test", modelID: "m" },
    }
    for (let index = 0; index < 2; index++)
      route.events.emit({
        directory,
        payload: {
          id: `evt_accepted_${index}`,
          type: "message.updated",
          properties: { sessionID: routeSessionID, info },
        },
      })
    await wait(() => route.sync.data.pending_submission[routeSessionID] === undefined)
    expect(route.sync.data.message[routeSessionID].filter((message) => message.id === messageID)).toHaveLength(1)
    release()
    await Bun.sleep(20)
    expect(prompt!.current.input).toBe("")
    expect(route.sync.data.failed_submission[routeSessionID]).toBeUndefined()
  } finally {
    release()
    await route.dispose()
  }
})

test("explicitly selected provider model snapshots a Solid store proxy without a clone defect", async () => {
  const route = await mountRoute("prompt", [], false, undefined, routeSessionID)
  try {
    configureModel(route)
    await route.local.model.set({ providerID: "test", modelID: "m" })
    // Explicit selections come from LocalProvider's Solid model store; the
    // fallback path exercised by other tests returns a plain object instead.
    expect(() => structuredClone(route.local.model.current())).toThrow()
    route.mount()
    await wait(() => Boolean(prompt))
    const before = sent.length
    prompt!.set({ input: "explicit model", parts: [] })
    prompt!.submit()
    await wait(() => sent.length > before)
    expect(sent[before].parts).toContainEqual({ type: "text", text: "explicit model" })
    await route.app.renderOnce()
    expect(route.app.captureCharFrame()).not.toContain("The object can not be cloned")
  } finally {
    await route.dispose()
  }
})

test("model picker keeps the server-accepted model when a queued replacement is refused", async () => {
  let acceptFirst!: () => void
  const firstAccepted = new Promise<void>((resolve) => {
    acceptFirst = resolve
  })
  const requests: string[] = []
  const route = await mountRoute(
    "prompt",
    [],
    false,
    async (url, request) => {
      if (url.pathname !== `/session/${routeSessionID}/model`) return undefined
      const body: unknown = await request.json()
      if (
        !body ||
        typeof body !== "object" ||
        !("model" in body) ||
        !body.model ||
        typeof body.model !== "object" ||
        !("modelID" in body.model) ||
        typeof body.model.modelID !== "string"
      )
        throw new Error("Invalid model selection request")
      requests.push(body.model.modelID)
      if (body.model.modelID === "accepted") {
        await firstAccepted
        return json(true)
      }
      return json({ _tag: "InvalidRequestError", message: "SECOND_MODEL_REFUSED" }, { status: 400 })
    },
    routeSessionID,
  )
  try {
    configureModel(route)
    const original = route.sync.data.provider[0].models.m
    route.sync.set("provider", 0, "models", {
      accepted: { ...original, id: "accepted", name: "Accepted model" },
      refused: { ...original, id: "refused", name: "Refused model" },
    })
    await route.local.model.set({ providerID: "test", modelID: "m" })
    route.navigation.navigate({ type: "session", sessionID: routeSessionID })
    route.mount()
    await wait(() => Boolean(prompt))
    const first = route.local.model.set({ providerID: "test", modelID: "accepted" })
    await wait(() => requests.length === 1)
    const second = route.local.model.set({ providerID: "test", modelID: "refused" })
    acceptFirst()
    expect(await first).toBe(false)
    expect(await second).toBe(false)
    expect(requests).toEqual(["accepted", "refused"])
    expect(route.local.model.current()).toEqual({ providerID: "test", modelID: "accepted" })
    await route.app.renderOnce()
    expect(route.app.captureCharFrame()).toContain("Accepted model")
  } finally {
    acceptFirst()
    await route.dispose()
  }
})

test("session attention follows real typing, background child navigation, and unmount", async () => {
  const childID = "ses_attention_child"
  const child = { ...routeSession, id: childID, parentID: routeSessionID, title: "Background child" }
  const updates: Array<{ sessionID: string; value: SessionAttentionInput }> = []
  const parentMessage = {
    info: {
      id: "msg_attention_task",
      sessionID: routeSessionID,
      parentID: "msg_attention_user",
      role: "assistant",
      agent: "build",
      mode: "build",
      modelID: "m",
      providerID: "test",
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, completed: 2 },
      finish: "stop",
    },
    parts: [
      {
        id: "prt_attention_task",
        sessionID: routeSessionID,
        messageID: "msg_attention_task",
        type: "tool",
        tool: "task",
        callID: "call_attention_task",
        state: {
          status: "completed",
          input: { description: "Background child", subagent_type: "general" },
          title: "Background child",
          output: "Running",
          time: { start: 1, end: 2 },
          metadata: { background: true, sessionId: childID },
        },
      },
    ],
  }
  const route = await mountRoute("session", [parentMessage], false, async (url, request) => {
    const match = url.pathname.match(/^\/session\/([^/]+)\/attention$/)
    if (match) {
      updates.push({
        sessionID: match[1],
        value: Schema.decodeUnknownSync(SessionAttentionInput)(await request.json()),
      })
      return json(true)
    }
    if (url.pathname === `/session/${childID}`) return json(child)
    if (url.pathname.startsWith(`/session/${childID}/`)) return json([])
    return undefined
  })
  try {
    configureModel(route)
    route.sync.set("session", [routeSession, child])
    route.navigation.navigate({ type: "session", sessionID: routeSessionID })
    route.mount()
    await wait(() => updates.some((item) => item.sessionID === routeSessionID))
    route.app.mockInput.pressKey("a")
    await wait(() => updates.some((item) => item.sessionID === routeSessionID && item.value.activity === 1))
    expect(updates.every((item) => item.value.clientType === "terminal")).toBe(true)
    expect(updates.some((item) => item.value.backgroundView)).toBe(false)
    route.navigation.navigate({ type: "session", sessionID: childID })
    await wait(() => updates.some((item) => item.sessionID === routeSessionID && item.value.backgroundView))
    const lease = updates.find((item) => item.sessionID === routeSessionID && item.value.backgroundView)
    if (!lease) throw new Error("Background view lease missing")
    route.app.mockInput.pressKey("b")
    await wait(() => updates.some((item) => item.sessionID === childID && item.value.activity === 1))
    route.navigation.navigate({ type: "session", sessionID: routeSessionID })
    await wait(() => updates.some((item) => item.value.clientID === lease.value.clientID && item.value.closed))
    route.unmount()
    await wait(() => updates.filter((item) => item.value.closed).length === 4)
    const count = updates.length
    route.app.mockInput.pressKey("c")
    await Bun.sleep(150)
    expect(updates).toHaveLength(count)
    expect(updates.filter((item) => item.value.closed).every((item) => item.value.backgroundView === false)).toBe(true)
  } finally {
    await route.dispose()
  }
})
