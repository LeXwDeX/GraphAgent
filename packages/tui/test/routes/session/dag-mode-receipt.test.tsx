// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import type { TextPart, UserMessage } from "@graphagent/sdk"
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
import { SyncProvider } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { HookStatusProvider } from "../../../src/context/hook-status"
import { TickerProvider } from "../../../src/context/ticker-context"
import { setLanguage } from "../../../src/i18n"
import type { DagModeReceiptKind } from "../../../src/i18n/receipt"
import { GraphagentKeymapProvider, registerGraphagentKeymap } from "../../../src/keymap"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { Main } from "../../../src/routes/session"
import { FooterToastProvider } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"

const sessionID = "ses_dag_mode_receipt"
const messageID = "msg_dag_mode_receipt"

const session = {
  id: sessionID,
  title: "Receipt render",
  slug: "receipt-render",
  projectID: "proj_test",
  time: { created: 1, updated: 2 },
  version: "test",
  directory,
}

const message: UserMessage = {
  id: messageID,
  sessionID,
  role: "user",
  agent: "build",
  model: { providerID: "opencode", modelID: "test-model" },
  time: { created: 1 },
}

const fixtures: Record<DagModeReceiptKind, Record<string, string | number | boolean>> = {
  on: { cap: 4, nodes: 32, budget: 200000 },
  off: { n: 2 },
  status: { state: "on", default: "off", running: 1, cap: 4, nodes: 32, used: 100, budget: 200 },
  budget: { N: 5000, k: 1 },
}

const anchors: Record<DagModeReceiptKind, Record<"zh-CN" | "en", string>> = {
  on: { "zh-CN": "DAG 模式已开启", en: "DAG mode is on" },
  off: { "zh-CN": "DAG 模式已关闭", en: "DAG mode is off" },
  status: { "zh-CN": "模式 on", en: "Mode on" },
  budget: { "zh-CN": "DAG 预算已设为", en: "DAG budget for this session" },
}

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

async function waitForFrame(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    if (frame.includes(text)) return frame
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${text}:\n${app.captureCharFrame()}`)
}

async function mountReceipt(kind: string, values: Record<string, unknown>, text: string, language: "zh-CN" | "en") {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  setLanguage(language)
  const events = createEventSource()
  const part: TextPart = {
    id: `prt_receipt_${kind}`,
    messageID,
    sessionID,
    type: "text",
    text,
    ignored: true,
    metadata: { receipt: { kind, values } },
    time: { start: 1, end: 1 },
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/config") return json({ language })
    if (url.pathname === "/session") return json([session])
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) return json([{ info: message, parts: [part] }])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    if (url.pathname === `/session/${sessionID}/goal`) return json(undefined)
    return undefined
  }, events)

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
                      <FooterToastProvider>
                        <TickerProvider>
                          <HookStatusProvider>
                            <RouteProvider initialRoute={{ type: "session", sessionID }}>
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
                                                      <Main />
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
                        </TickerProvider>
                      </FooterToastProvider>
                    </KVProvider>
                  </ArgsProvider>
                </GraphagentKeymapProvider>
              </ClipboardProvider>
            </EpilogueProvider>
          </ExitProvider>
        </TestTuiContexts>
      )
    },
    { width: 100, height: 30 },
  )
  return { app, tmp }
}

for (const kind of ["on", "off", "status", "budget"] as const) {
  for (const language of ["zh-CN", "en"] as const) {
    test(`renders the ${kind} receipt in ${language}`, async () => {
      const { app, tmp } = await mountReceipt(kind, fixtures[kind], `SERVER FALLBACK ${kind}`, language)
      try {
        const frame = await waitForFrame(app, anchors[kind][language])
        expect(frame).not.toContain(`SERVER FALLBACK ${kind}`)
        expect(frame).toMatchSnapshot()
      } finally {
        app.renderer.destroy()
        await tmp[Symbol.asyncDispose]()
      }
    })
  }
}

test("keeps the server text for an unknown receipt kind", async () => {
  const { app, tmp } = await mountReceipt("future", {}, "SERVER FALLBACK future", "en")
  try {
    const frame = await waitForFrame(app, "SERVER FALLBACK future")
    expect(frame).not.toContain("DAG mode is off")
  } finally {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
})
