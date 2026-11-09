// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import type { AssistantMessage, GlobalEvent, ToolPart } from "@graphagent/sdk/v2"
import { onCleanup } from "solid-js"
import { TuiConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { EditorContextProvider } from "../../../src/context/editor"
import { EpilogueProvider } from "../../../src/context/epilogue"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { LocalProvider } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { ProjectProvider } from "../../../src/context/project"
import { PromptRefProvider } from "../../../src/context/prompt"
import { RouteProvider } from "../../../src/context/route"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
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

const sessionID = "ses_task_parent"
const childID = "ses_task_child"
const messageID = "msg_task_parent"

const session = {
  id: sessionID,
  title: "Task lazy loading",
  slug: "task-lazy",
  projectID: "proj_test",
  time: { created: 1, updated: 20 },
  version: "test",
  directory,
}

const child = {
  id: childID,
  title: "Child work",
  slug: "task-lazy-child",
  projectID: "proj_test",
  parentID: sessionID,
  time: { created: 1, updated: 5 },
  version: "test",
  directory,
}

const assistant: AssistantMessage = {
  id: messageID,
  sessionID,
  parentID: "msg_task_user",
  role: "assistant",
  agent: "build",
  mode: "build",
  modelID: "test-model",
  providerID: "test",
  path: { cwd: directory, root: directory },
  time: { created: 10 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

const taskPart: ToolPart = {
  id: "prt_task_parent",
  sessionID,
  messageID,
  type: "tool" as const,
  tool: "task",
  callID: "call_task_parent",
  state: {
    status: "running",
    input: { description: "Inspect renderer", subagent_type: "explore" },
    title: "Inspect renderer",
    time: { start: 10 },
    metadata: { sessionId: childID },
  },
}

function childToolEvent(id: string, tool: string, title: string): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id,
      type: "message.part.updated",
      properties: {
        sessionID: childID,
        time: 12,
        part: {
          id: `prt_${id}`,
          sessionID: childID,
          messageID: "msg_child",
          type: "tool",
          tool,
          callID: `call_${id}`,
          state: { status: "running", title, input: {}, time: { start: 12 }, metadata: {} },
        },
      },
    },
  }
}

async function waitForFrame(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    if (frame.includes(text)) return frame
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${text}:\n${app.captureCharFrame()}`)
}

test("the Task row renders the child summary without hydrating the child session", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  let childMessageFetches = 0
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([session, child])
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) return json([{ info: assistant, parts: [taskPart] }])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`)
      return json([])
    if (url.pathname === `/session/${sessionID}/goal`) return json(undefined)
    if (url.pathname.startsWith(`/session/${childID}/`)) {
      if (url.pathname === `/session/${childID}/message`) childMessageFetches++
      return json([])
    }
    if (url.pathname === `/session/${childID}`) return json(child)
    return undefined
  }, events)
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
                      <ToastProvider>
                        <RouteProvider initialRoute={{ type: "session", sessionID }}>
                          <TuiConfigProvider config={config}>
                            <PluginRuntimeProvider value={createPluginRuntime()}>
                              <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
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
    },
    { width: 90, height: 28 },
  )

  try {
    await waitForFrame(app, "Inspect renderer")
    // Cold start: no tool-call count is known, so the row shows an em dash.
    const cold = await waitForFrame(app, "↳ —")
    expect(cold).toContain("Explore Task — Inspect renderer")

    // A child tool event is delivered as a summary even though the child is not
    // hydrated; the visible row follows it without a child session fetch.
    events.emit(childToolEvent("evt_child_tool", "bash", "run tests"))
    const frame = await waitForFrame(app, "↳ Bash run tests")
    expect(frame).toContain("Explore Task — Inspect renderer")
    expect(sync.data.summary[childID]).toMatchObject({ toolCalls: 1, current: { tool: "bash", title: "run tests" } })
    expect(sync.data.message[childID]).toBeUndefined()
    expect(childMessageFetches).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})
