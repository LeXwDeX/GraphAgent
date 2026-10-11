/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import type { AssistantMessage, TextPart, UserMessage } from "@opencode-ai/sdk/v2"
import { onCleanup } from "solid-js"
import { TuiConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { DataProvider } from "../../../src/context/data"
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
import { registerOpencodeKeymap, OpencodeKeymapProvider } from "../../../src/keymap"
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

const sessionID = "ses_dag_delivery_render"
const requestID = "msg_dag_delivery_request"
const deliveryID = "msg_dag_delivery_generated"
const followupID = "msg_dag_delivery_followup"

const session = {
  id: sessionID,
  title: "DAG delivery render",
  slug: "dag-delivery-render",
  projectID: "proj_test",
  time: { created: 1, updated: 20 },
  version: "test",
  directory,
}

const request: UserMessage = {
  id: requestID,
  sessionID,
  role: "user",
  agent: "build",
  model: { providerID: "opencode", modelID: "test-model" },
  time: { created: 1 },
}

const source: TextPart = {
  id: "prt_dag_delivery_source",
  messageID: deliveryID,
  sessionID,
  type: "text",
  text: "DAG · Release workflow · final-report",
  time: { start: 10, end: 10 },
  metadata: { dag_delivery: { kind: "source", workflow_id: "wf_release", node_id: "final-report" } },
}

const answer: TextPart = {
  id: "prt_dag_delivery_answer",
  messageID: deliveryID,
  sessionID,
  type: "text",
  text: "DELIVERY BODY: the release report is ready.",
  time: { start: 10, end: 10 },
  metadata: { dag_delivery: { kind: "answer", workflow_id: "wf_release", node_id: "final-report" } },
}

const delivery: AssistantMessage = {
  id: deliveryID,
  sessionID,
  parentID: requestID,
  role: "assistant",
  agent: "build",
  mode: "build",
  modelID: "test-model",
  providerID: "opencode",
  path: { cwd: directory, root: directory },
  time: { created: 10, completed: 10 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  finish: "stop",
}

const followup: UserMessage = {
  id: followupID,
  sessionID,
  role: "user",
  agent: "build",
  model: { providerID: "opencode", modelID: "test-model" },
  time: { created: 20 },
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

test("renders both DAG delivery text parts once and keeps a following user turn visible", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  const messages = [
    {
      info: request,
      parts: [{ id: "prt_request", sessionID, messageID: requestID, type: "text", text: "run workflow" }],
    },
    { info: delivery, parts: [source, answer] },
    {
      info: followup,
      parts: [{ id: "prt_followup", sessionID, messageID: followupID, type: "text", text: "FOLLOWUP USER TURN" }],
    },
  ]
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([session])
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) return json(messages)
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    if (url.pathname === `/session/${sessionID}/goal`) return json(undefined)
    return undefined
  }, events)
  let sync!: ReturnType<typeof useSync>

  function Probe() {
    sync = useSync()
    return <Session />
  }

  const app = await testRender(
    () => {
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
                        <RouteProvider initialRoute={{ type: "session", sessionID }}>
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
                                    <DataProvider>
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
    },
    { width: 90, height: 28 },
  )

  try {
    await waitForFrame(app, "DELIVERY BODY")
    const frame = await waitForFrame(app, "FOLLOWUP USER TURN")
    expect(frame.match(/DAG · Release workflow · final-report/g)).toHaveLength(1)
    expect(frame.match(/DELIVERY BODY/g)).toHaveLength(1)
    expect(sync.data.message[sessionID]?.map((item) => item.id)).toEqual([requestID, deliveryID, followupID])
    expect(sync.data.part[deliveryID]?.map((part) => part.id)).toEqual([source.id, answer.id])
  } finally {
    app.renderer.destroy()
  }
})
