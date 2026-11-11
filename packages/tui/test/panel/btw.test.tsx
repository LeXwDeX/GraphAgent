// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { setLanguage } from "../../src/i18n"
import type { PanelHostApi } from "../../src/panel/host"
import { BtwPanel } from "../../src/panel/btw"
import { json, type FetchHandler } from "../fixture/tui-sdk"
import { shellState } from "../shell/contexts"
import { PanelSurface, renderAppPanel, type AppPanelTestContext } from "./contexts"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

async function waitFor(
  app: Awaited<ReturnType<typeof renderAppPanel>>,
  condition: () => boolean,
  message: string,
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await Bun.sleep(20)
    await app.renderOnce()
    if (condition()) return
  }
  throw new Error(`timed out waiting for ${message}`)
}

function answer(
  id: string,
  text: string,
  context: { truncated: boolean; inFlightDropped: boolean } = { truncated: false, inFlightDropped: false },
) {
  return json({
    id,
    answer: text,
    model: { providerID: "test", modelID: "m" },
    usage: { inputTokens: 12, outputTokens: 34 },
    context: { messages: 3, estimatedTokens: 120, ...context },
  })
}

async function renderBtw(options: {
  state: string
  handler: FetchHandler
  setup: (context: AppPanelTestContext) => void | Promise<void>
}) {
  let host: PanelHostApi | undefined
  const app = await renderAppPanel(
    () => (
      <PanelSurface
        spec={{ id: "btw", render: () => <BtwPanel sessionID="ses_btw" /> }}
        onHost={(value) => (host = value)}
      />
    ),
    {
      width: 120,
      height: 40,
      state: options.state,
      handler: options.handler,
      setup: options.setup,
    },
  )
  return { app, host: () => host }
}

test("shows the completed answer with model, usage and context notes", async () => {
  await using tmp = await shellState()
  const handler: FetchHandler = async (url) => {
    if (url.pathname !== "/session/ses_btw/btw") return undefined
    return answer("btw_test", "because scattering", { truncated: true, inFlightDropped: true })
  }
  const { app } = await renderBtw({
    state: tmp.path,
    handler,
    setup: async ({ btw }) => {
      await btw.ask("ses_btw", "why is the sky blue?")
    },
  })

  try {
    await waitFor(app, () => app.captureCharFrame().includes("because scattering"), "answer body")
    const frame = app.captureCharFrame()
    expect(frame).toContain("旁问")
    expect(frame).toContain("why is the sky blue?")
    expect(frame).toContain("test/m")
    expect(frame).toContain("12/34 tokens")
    expect(frame).toContain("上下文已截断")
    expect(frame).toContain("不含进行中的步骤")
  } finally {
    app.renderer.destroy()
  }
})

test("x cancels a pending side question", async () => {
  await using tmp = await shellState()
  const requests: string[] = []
  const handler: FetchHandler = async (url, request) => {
    requests.push(`${request?.method ?? "GET"} ${url.pathname}`)
    if (url.pathname === "/session/ses_btw/btw" && request?.method === "POST") {
      return new Promise<Response>(() => {})
    }
    if (url.pathname.startsWith("/session/ses_btw/btw/") && request?.method === "DELETE") {
      return json({})
    }
    return undefined
  }
  const { app } = await renderBtw({
    state: tmp.path,
    handler,
    setup: ({ btw }) => {
      void btw.ask("ses_btw", "pending question")
    },
  })

  try {
    await waitFor(app, () => app.captureCharFrame().includes("进行中"), "pending status")
    app.mockInput.pressKey("x")
    await waitFor(app, () => requests.some((entry) => entry.startsWith("DELETE ")), "cancel request")
    await waitFor(app, () => app.captureCharFrame().includes("已取消"), "cancelled body")
  } finally {
    app.renderer.destroy()
  }
})

test("escape closes the panel without cancelling the pending request", async () => {
  await using tmp = await shellState()
  const requests: string[] = []
  const handler: FetchHandler = async (url, request) => {
    requests.push(`${request?.method ?? "GET"} ${url.pathname}`)
    if (url.pathname === "/session/ses_btw/btw" && request?.method === "POST") {
      return new Promise<Response>(() => {})
    }
    return undefined
  }
  const { app, host } = await renderBtw({
    state: tmp.path,
    handler,
    setup: ({ btw }) => {
      void btw.ask("ses_btw", "still pending")
    },
  })

  try {
    await waitFor(app, () => app.captureCharFrame().includes("进行中"), "pending status")
    app.mockInput.pressEscape()
    await waitFor(app, () => host()?.depth() === 0, "panel close")
    expect(requests.some((entry) => entry.startsWith("DELETE "))).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("history switches between earlier answers", async () => {
  await using tmp = await shellState()
  let completed = 0
  const handler: FetchHandler = async (url) => {
    if (url.pathname !== "/session/ses_btw/btw") return undefined
    return answer("btw_test", completed++ === 0 ? "answer one" : "answer two")
  }
  const { app } = await renderBtw({
    state: tmp.path,
    handler,
    setup: async ({ btw }) => {
      await btw.ask("ses_btw", "first?")
      await btw.ask("ses_btw", "second?")
    },
  })

  try {
    await waitFor(app, () => app.captureCharFrame().includes("answer two"), "newest answer")
    expect(app.captureCharFrame()).toContain("2/2")
    app.mockInput.pressKey("[")
    await waitFor(app, () => app.captureCharFrame().includes("answer one"), "older answer")
    expect(app.captureCharFrame()).toContain("1/2")
    app.mockInput.pressKey("]")
    await waitFor(app, () => app.captureCharFrame().includes("answer two"), "newest answer again")
  } finally {
    app.renderer.destroy()
  }
})
