// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import type { Agent, McpStatus, Provider, Workspace } from "@graphagent/sdk"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { setLanguage } from "../../src/i18n"
import { AgentPanel } from "../../src/panel/agent"
import type { PanelHostApi } from "../../src/panel/host"
import { McpPanel } from "../../src/panel/mcp"
import { ModelPanel, type ModelRef } from "../../src/panel/model"
import { SkillsPanel } from "../../src/panel/skills"
import { StashPanel } from "../../src/panel/stash"
import { ThemePanel } from "../../src/panel/theme"
import { WorkspacesPanel } from "../../src/panel/workspaces"
import { shellState } from "../shell/contexts"
import { json } from "../fixture/tui-sdk"
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

const agents: Agent[] = [
  { name: "build", mode: "primary", hidden: false, options: {}, permission: [] },
  { name: "plan", mode: "primary", hidden: false, options: {}, permission: [] },
]

function providerFixture(): Provider {
  const model = {
    id: "m1",
    name: "Model One",
    providerID: "test",
    api: { id: "m1", url: "http://test", npm: "test" },
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
    cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
    variants: {},
  }
  return {
    id: "test",
    name: "Test Provider",
    source: "config",
    env: [],
    options: {},
    models: {
      m1: model,
      m2: { ...model, id: "m2", name: "Model Two", release_date: "2026-02-01" },
    },
  }
}

test("agent panel selects an agent and closes", async () => {
  await using tmp = await shellState()
  let panelHost: PanelHostApi | undefined
  let ctx!: AppPanelTestContext
  const app = await renderAppPanel(
    () => <PanelSurface spec={{ id: "agent", render: () => <AgentPanel /> }} onHost={(host) => (panelHost = host)} />,
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => {
        ctx = context
        context.sync.set("agent", agents)
      },
    },
  )

  try {
    expect(app.captureCharFrame()).toContain("选择主 agent")
    expect(app.captureCharFrame()).toContain("build")
    expect(panelHost?.depth()).toBe(1)

    app.mockInput.pressArrow("down")
    await settle(app)
    app.mockInput.pressEnter()
    await settle(app)

    expect(ctx.local.agent.current()?.name).toBe("plan")
    expect(panelHost?.depth()).toBe(0)
    expect(app.captureCharFrame()).not.toContain("选择主 agent")
  } finally {
    app.renderer.destroy()
  }
})

test("mcp panel toggles the selected server with space and keeps the panel open on select", async () => {
  await using tmp = await shellState()
  let panelHost: PanelHostApi | undefined
  let mcp = { alpha: { status: "connected" } as McpStatus, beta: { status: "disabled" } as McpStatus }
  const app = await renderAppPanel(
    () => <PanelSurface spec={{ id: "mcp", render: () => <McpPanel /> }} onHost={(host) => (panelHost = host)} />,
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => context.sync.set("mcp", mcp),
      handler: (url) => {
        if (url.pathname === "/mcp") return json(mcp)
        if (/^\/mcp\/[^/]+\/(connect|disconnect)$/.test(url.pathname)) {
          mcp = { ...mcp, alpha: { status: "disabled" } }
          return json({})
        }
        return undefined
      },
    },
  )

  try {
    expect(app.captureCharFrame()).toContain("MCP 服务器")
    expect(app.captureCharFrame()).toContain("alpha")

    app.mockInput.pressEnter()
    await settle(app)
    expect(panelHost?.depth()).toBe(1)

    app.mockInput.pressKey(" ")
    await settle(app)
    expect(app.captureCharFrame()).toContain("已禁用")

    app.mockInput.pressEscape()
    await settle(app)
    expect(panelHost?.depth()).toBe(0)
    expect(app.captureCharFrame()).not.toContain("MCP 服务器")
  } finally {
    app.renderer.destroy()
  }
})

test("model panel favorites the selected model with ctrl+f", async () => {
  await using tmp = await shellState()
  let ctx!: AppPanelTestContext
  const app = await renderAppPanel(
    () => (
      <PanelSurface
        spec={{ id: "model", render: () => <ModelPanel onConnectProvider={() => {}} onVariant={() => {}} /> }}
      />
    ),
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => {
        ctx = context
        context.sync.set("agent", agents)
        context.sync.set("provider", [providerFixture()])
      },
    },
  )

  try {
    expect(app.captureCharFrame()).toContain("选择模型")
    expect(app.captureCharFrame()).toContain("Model One")

    app.mockInput.pressKey("f", { ctrl: true })
    await settle(app)

    expect(ctx.local.model.favorite()).toEqual([{ providerID: "test", modelID: "m2" }])
    expect(app.captureCharFrame()).toContain("收藏")
  } finally {
    app.renderer.destroy()
  }
})

test("model panel selects a model and closes", async () => {
  await using tmp = await shellState()
  let panelHost: PanelHostApi | undefined
  let ctx!: AppPanelTestContext
  const app = await renderAppPanel(
    () => (
      <PanelSurface
        spec={{ id: "model", render: () => <ModelPanel onConnectProvider={() => {}} onVariant={() => {}} /> }}
        onHost={(host) => (panelHost = host)}
      />
    ),
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => {
        ctx = context
        context.sync.set("agent", agents)
        context.sync.set("provider", [providerFixture()])
      },
    },
  )

  try {
    // The panel starts on the newest model; Enter commits it over the current one.
    expect(ctx.local.model.current()).toEqual({ providerID: "test", modelID: "m1" } satisfies ModelRef)
    app.mockInput.pressEnter()
    await settle(app)

    expect(ctx.local.model.current()).toEqual({ providerID: "test", modelID: "m2" } satisfies ModelRef)
    expect(panelHost?.depth()).toBe(0)
    expect(app.captureCharFrame()).not.toContain("选择模型")
  } finally {
    app.renderer.destroy()
  }
})

test("model panel opens the provider list with ctrl+a", async () => {
  await using tmp = await shellState()
  let panelHost: PanelHostApi | undefined
  let providers = 0
  const app = await renderAppPanel(
    () => (
      <PanelSurface
        spec={{
          id: "model",
          render: () => (
            <ModelPanel
              onConnectProvider={() => {
                providers += 1
              }}
              onVariant={() => {}}
            />
          ),
        }}
        onHost={(host) => (panelHost = host)}
      />
    ),
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => {
        context.sync.set("agent", agents)
        context.sync.set("provider", [providerFixture()])
      },
    },
  )

  try {
    app.mockInput.pressKey("a", { ctrl: true })
    await settle(app)

    expect(providers).toBe(1)
    expect(panelHost?.depth()).toBe(0)
    expect(app.captureCharFrame()).not.toContain("选择模型")
  } finally {
    app.renderer.destroy()
  }
})

test("theme panel previews on move and restores on escape", async () => {
  await using tmp = await shellState()
  let panelHost: PanelHostApi | undefined
  let ctx!: AppPanelTestContext
  const app = await renderAppPanel(
    () => <PanelSurface spec={{ id: "theme", render: () => <ThemePanel /> }} onHost={(host) => (panelHost = host)} />,
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => {
        ctx = context
      },
    },
  )

  try {
    const initial = ctx.theme.selected
    expect(app.captureCharFrame()).toContain("主题")

    app.mockInput.pressArrow("down")
    await settle(app)
    expect(ctx.theme.selected).not.toBe(initial)

    app.mockInput.pressEscape()
    await settle(app)
    expect(ctx.theme.selected).toBe(initial)
    expect(panelHost?.depth()).toBe(0)
    expect(app.captureCharFrame()).not.toContain("主题")
  } finally {
    app.renderer.destroy()
  }
})

test("theme panel confirms the previewed theme on return", async () => {
  await using tmp = await shellState()
  let panelHost: PanelHostApi | undefined
  let ctx!: AppPanelTestContext
  const app = await renderAppPanel(
    () => <PanelSurface spec={{ id: "theme", render: () => <ThemePanel /> }} onHost={(host) => (panelHost = host)} />,
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => {
        ctx = context
      },
    },
  )

  try {
    app.mockInput.pressArrow("down")
    await settle(app)
    const previewed = ctx.theme.selected
    app.mockInput.pressEnter()
    await settle(app)

    expect(ctx.theme.selected).toBe(previewed)
    expect(panelHost?.depth()).toBe(0)
    expect(app.captureCharFrame()).not.toContain("主题")
  } finally {
    app.renderer.destroy()
  }
})

test("skills panel inserts the selected skill and closes", async () => {
  await using tmp = await shellState()
  let panelHost: PanelHostApi | undefined
  const skills: string[] = []
  const app = await renderAppPanel(
    () => (
      <PanelSurface
        spec={{ id: "skills", render: () => <SkillsPanel onSelect={(skill) => skills.push(skill)} /> }}
        onHost={(host) => (panelHost = host)}
      />
    ),
    {
      width: 120,
      height: 40,
      state: tmp.path,
      handler: (url) => {
        if (url.pathname === "/skill") return json([{ name: "alpha", description: "First" }])
        return undefined
      },
    },
  )

  try {
    await settle(app)
    expect(app.captureCharFrame()).toContain("技能")
    expect(app.captureCharFrame()).toContain("alpha")

    app.mockInput.pressEnter()
    await settle(app)

    expect(skills).toEqual(["alpha"])
    expect(panelHost?.depth()).toBe(0)
    expect(app.captureCharFrame()).not.toContain("技能")
  } finally {
    app.renderer.destroy()
  }
})

test("stash panel deletes with ctrl+d twice and restores the selected entry", async () => {
  await using tmp = await shellState()
  await Bun.write(
    `${tmp.path}/prompt-stash.jsonl`,
    [
      JSON.stringify({ input: "oldest", parts: [], timestamp: 1000 }),
      JSON.stringify({ input: "second\nline", parts: [], timestamp: 2000 }),
    ].join("\n") + "\n",
  )
  let panelHost: PanelHostApi | undefined
  const selected: string[] = []
  const app = await renderAppPanel(
    () => (
      <PanelSurface
        spec={{ id: "stash", render: () => <StashPanel onSelect={(entry) => selected.push(entry.input)} /> }}
        onHost={(host) => (panelHost = host)}
      />
    ),
    {
      width: 120,
      height: 40,
      state: tmp.path,
    },
  )

  try {
    await settle(app)
    expect(app.captureCharFrame()).toContain("暂存输入")

    app.mockInput.pressKey("d", { ctrl: true })
    await settle(app)
    expect(app.captureCharFrame()).toContain("再按一次")
    app.mockInput.pressKey("d", { ctrl: true })
    await settle(app)
    expect(app.captureCharFrame()).not.toContain("second")

    app.mockInput.pressEnter()
    await settle(app)
    expect(selected).toEqual(["oldest"])
    expect(panelHost?.depth()).toBe(0)
    expect(app.captureCharFrame()).not.toContain("暂存输入")
  } finally {
    app.renderer.destroy()
  }
})

test("workspaces panel expands details, deletes with ctrl+d and closes", async () => {
  await using tmp = await shellState()
  let panelHost: PanelHostApi | undefined
  let workspaces: Workspace[] = [
    { id: "w1", type: "worktree", name: "Alpha", directory: "/tmp/alpha", projectID: "proj_test", timeUsed: 0 },
    { id: "w2", type: "worktree", name: "Beta", directory: "/tmp/beta", projectID: "proj_test", timeUsed: 0 },
  ]
  const app = await renderAppPanel(
    () => (
      <PanelSurface
        spec={{ id: "workspaces", render: () => <WorkspacesPanel /> }}
        onHost={(host) => (panelHost = host)}
      />
    ),
    {
      width: 120,
      height: 40,
      state: tmp.path,
      handler: (url) => {
        if (url.pathname === "/experimental/workspace") return json(workspaces)
        if (url.pathname === "/experimental/workspace/status") {
          return json(workspaces.map((workspace) => ({ workspaceID: workspace.id, status: "connected" })))
        }
        if (/^\/experimental\/workspace\/[^/]+$/.test(url.pathname)) {
          const id = url.pathname.split("/").at(-1)
          workspaces = workspaces.filter((workspace) => workspace.id !== id)
          return json(true)
        }
        return undefined
      },
      setup: async (context) => {
        await context.project.workspace.sync()
      },
    },
  )

  try {
    expect(app.captureCharFrame()).toContain("工作区")
    expect(app.captureCharFrame()).toContain("Alpha")

    app.mockInput.pressEnter()
    await settle(app)
    expect(app.captureCharFrame()).toContain("/tmp/alpha")

    app.mockInput.pressKey("d", { ctrl: true })
    await settle(app)
    expect(app.captureCharFrame()).toContain("再按一次")
    app.mockInput.pressKey("d", { ctrl: true })
    await settle(app)
    await settle(app)
    expect(app.captureCharFrame()).toContain("Beta")
    expect(app.captureCharFrame()).not.toContain("Alpha")

    app.mockInput.pressEscape()
    await settle(app)
    expect(panelHost?.depth()).toBe(0)
    expect(app.captureCharFrame()).not.toContain("工作区")
  } finally {
    app.renderer.destroy()
  }
})
