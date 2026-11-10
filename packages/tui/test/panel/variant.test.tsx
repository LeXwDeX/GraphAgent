// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import type { Agent, Provider } from "@graphagent/sdk"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { setLanguage, t } from "../../src/i18n"
import type { PanelHostApi } from "../../src/panel/host"
import { VariantPanel } from "../../src/panel/variant"
import { json } from "../fixture/tui-sdk"
import { shellState } from "../shell/contexts"
import { PanelSurface, renderAppPanel, type AppPanelTestContext } from "./contexts"

beforeEach(() => {
  setLanguage("zh-CN")
})

afterEach(() => {
  setLanguage("zh-CN")
})

async function settle(app: Awaited<ReturnType<typeof renderAppPanel>>) {
  await Bun.sleep(30)
  await app.renderOnce()
}

async function waitFor(app: Awaited<ReturnType<typeof renderAppPanel>>, condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await Bun.sleep(20)
    await app.renderOnce()
    if (condition()) return
  }
  throw new Error(`timed out waiting for ${message}`)
}

const agents: Agent[] = [{ name: "build", mode: "primary", hidden: false, options: {}, permission: [] }]

const model = {
  id: "m",
  name: "Model",
  providerID: "test",
  api: { id: "m", url: "http://test", npm: "test" },
  status: "active" as const,
  options: {},
  headers: {},
  release_date: "2026-01-01",
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  limit: { context: 10000, output: 1000 },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  variants: { high: {}, xhigh: {} },
}

const provider: Provider = {
  id: "test",
  name: "Test Provider",
  source: "config",
  env: [],
  options: {},
  models: { m: model },
}

test("variant panel moves from default to a reasoning variant and closes", async () => {
  await using tmp = await shellState()
  let ctx!: AppPanelTestContext
  let host: PanelHostApi | undefined
  const writes: string[] = []
  const app = await renderAppPanel(
    () => <PanelSurface spec={{ id: "variant", render: () => <VariantPanel /> }} onHost={(value) => (host = value)} />,
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => {
        ctx = context
        context.sync.set("agent", agents)
        context.sync.set("provider", [provider])
        context.sync.set("session", [
          {
            id: "s1",
            slug: "s1",
            projectID: "proj_test",
            directory: "/repo",
            title: "Session",
            version: "test",
            time: { created: 1, updated: 1 },
            model: { id: "m", providerID: "test", variant: "default" },
          },
        ])
      },
      handler: (url) => {
        if (url.pathname === "/session/s1/model") {
          writes.push(url.pathname)
          return json(true)
        }
        return undefined
      },
    },
  )

  try {
    await waitFor(app, () => ctx.local.model.ready, "model store")
    ctx.route.navigate({ type: "session", sessionID: "s1" })
    await waitFor(app, () => ctx.local.model.current()?.modelID === "m", "current model")
    const frame = app.captureCharFrame()
    expect(frame).toContain(t("panel.variant.title"))
    expect(frame).toContain(t("panel.variant.default"))
    expect(frame).toContain("high")
    expect(frame).toContain("xhigh")

    app.mockInput.pressArrow("down")
    await settle(app)
    app.mockInput.pressEnter()
    await waitFor(app, () => writes.length === 1 && host?.depth() === 0, "variant write")
    expect(ctx.local.model.variant.current()).toBe("high")
    expect(app.captureCharFrame()).not.toContain(t("panel.variant.title"))
  } finally {
    app.renderer.destroy()
  }
})
