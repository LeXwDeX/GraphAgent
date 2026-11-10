// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import type { ProjectDirectories, Provider, ProviderAuthMethod } from "@graphagent/sdk"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { onMount } from "solid-js"
import { useProject } from "../../src/context/project"
import { useSDK } from "../../src/context/sdk"
import { useSync } from "../../src/context/sync"
import { setLanguage } from "../../src/i18n"
import { type PanelHostApi, type PanelSpec } from "../../src/panel/host"
import { MoveSessionPanel } from "../../src/panel/move-session"
import { ProviderPanel } from "../../src/panel/provider"
import { BottomZone, useBottomZone } from "../../src/shell/bottom-zone"
import {
  openWorkspacePanel,
  recentConnectedWorkspaces,
  type WorkspaceSelection,
} from "../../src/panel/workspace-select"
import { useToast } from "../../src/ui/toast"
import { shellState } from "../shell/contexts"
import { json } from "../fixture/tui-sdk"
import { PanelSurface, renderAppPanel } from "./contexts"

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

/**
 * Mounts a panel through the shared bottom zone so an ask surface suspends the
 * panel exactly as it does in the app. Rendering the panel outside the zone
 * would keep its filter input focused while a confirm prompt is up.
 */
function ZonedPanel(props: { spec: PanelSpec; onHost?: (host: PanelHostApi) => void }) {
  const zone = useBottomZone()
  onMount(() => {
    zone.host.push(props.spec)
    props.onHost?.(zone.host)
  })
  return <BottomZone state={zone} composer={<></>} />
}

async function waitFor(app: Awaited<ReturnType<typeof renderAppPanel>>, condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    await Bun.sleep(20)
    await app.renderOnce()
    if (condition()) return
  }
  throw new Error(`timed out waiting for ${message}`)
}

function providerFixture(id: string, name: string): Provider {
  return { id, name, source: "config", env: [], options: {}, models: {} } as Provider
}

test("provider panel walks provider, auth method and API key without upstream-only copy", async () => {
  await using tmp = await shellState()
  let host: PanelHostApi | undefined
  const connected: string[] = []
  let authSets = 0
  const alpha = providerFixture("test", "Alpha Test")
  const zen = providerFixture("opencode", "Zeta Zen")
  const go = providerFixture("opencode-go", "Zeta Go")
  const methods: ProviderAuthMethod[] = [
    { type: "api", label: "API key" },
    { type: "api", label: "Secondary key" },
  ]

  const app = await renderAppPanel(
    () => (
      <PanelSurface
        spec={{ id: "provider", render: () => <ProviderPanel onConnected={(id) => connected.push(id)} /> }}
        onHost={(value) => (host = value)}
      />
    ),
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => {
        context.sync.set("provider_next", { all: [alpha, zen, go], default: {}, connected: [] })
        context.sync.set("provider_auth", { test: methods })
      },
      handler: (url) => {
        if (url.pathname === "/provider") return json({ all: [alpha, zen, go], default: {}, connected: ["test"] })
        if (url.pathname === "/auth/test") {
          authSets += 1
          return json(true)
        }
        if (url.pathname === "/instance/dispose") return json(true)
        return undefined
      },
    },
  )

  try {
    expect(app.captureCharFrame()).toContain("连接提供商")
    expect(app.captureCharFrame()).toContain("Alpha Test")
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("Recommended")
    expect(frame).not.toContain("Low cost subscription")
    expect(frame).not.toContain("opencode.ai")
    expect(host?.depth()).toBe(1)

    app.mockInput.pressEnter()
    await settle(app)
    expect(host?.depth()).toBe(2)
    expect(app.captureCharFrame()).toContain("选择认证方式")
    expect(app.captureCharFrame()).toContain("Secondary key")

    app.mockInput.pressEscape()
    await settle(app)
    expect(host?.depth()).toBe(1)
    expect(app.captureCharFrame()).toContain("Alpha Test")
    expect(app.captureCharFrame()).not.toContain("选择认证方式")

    app.mockInput.pressEnter()
    await settle(app)
    app.mockInput.pressEnter()
    await settle(app)
    expect(host?.depth()).toBe(2)
    expect(app.captureCharFrame()).toContain("API key")

    for (const key of "sktest") app.mockInput.pressKey(key)
    await settle(app)
    app.mockInput.pressEnter()

    await waitFor(app, () => connected.length === 1 && host?.depth() === 0, "provider connection")
    expect(authSets).toBe(1)
    expect(connected).toEqual(["test"])
    expect(app.captureCharFrame()).not.toContain("连接提供商")
  } finally {
    app.renderer.destroy()
  }
})

test("move panel refreshes, deletes the selected copy after confirmation and closes", async () => {
  await using tmp = await shellState()
  let host: PanelHostApi | undefined
  let directories: ProjectDirectories = [{ directory: "/tmp/copy-a", strategy: "git_worktree" }]
  let refreshes = 0
  let deletes = 0

  const app = await renderAppPanel(
    () => (
      <ZonedPanel
        spec={{ id: "move-session", render: () => <MoveSessionPanel projectID="proj_test" onSelect={() => {}} /> }}
        onHost={(value) => (host = value)}
      />
    ),
    {
      width: 120,
      height: 40,
      state: tmp.path,
      handler: (url) => {
        if (url.pathname === "/path") {
          return json({ home: "", state: "", config: "", worktree: "/tmp/base", directory: "/tmp/base/packages/tui" })
        }
        if (/^\/project\/[^/]+\/directories$/.test(url.pathname)) return json(directories)
        if (/^\/experimental\/project\/[^/]+\/copy\/refresh$/.test(url.pathname)) {
          refreshes += 1
          return json(true)
        }
        if (/^\/experimental\/project\/[^/]+\/copy$/.test(url.pathname)) {
          deletes += 1
          directories = []
          return json(true)
        }
        return undefined
      },
    },
  )

  try {
    await waitFor(app, () => app.captureCharFrame().includes("/tmp/copy-a"), "directory list")
    expect(app.captureCharFrame()).toContain("移动会话")
    expect(app.captureCharFrame()).toContain("当前")
    expect(app.captureCharFrame()).toContain("/tmp/base")
    expect(host?.depth()).toBe(1)
    const initialRefreshes = refreshes

    app.mockInput.pressKey("r", { ctrl: true })
    await waitFor(app, () => refreshes > initialRefreshes, "directory refresh")

    // The current checkout row sorts first; the only copy follows it.
    app.mockInput.pressArrow("down")
    await settle(app)
    app.mockInput.pressKey("d", { ctrl: true })
    await settle(app)
    expect(app.captureCharFrame()).toContain("删除工作副本？")

    // The ask surface suspends the panel, so its enter binding is the only one live.
    app.mockInput.pressEnter()
    await waitFor(app, () => deletes === 1, "copy deletion")
    await waitFor(app, () => !app.captureCharFrame().includes("/tmp/copy-a"), "deleted row removal")

    app.mockInput.pressEscape()
    await settle(app)
    expect(host?.depth()).toBe(0)
    expect(app.captureCharFrame()).not.toContain("移动会话")
  } finally {
    app.renderer.destroy()
  }
})

test("recent connected workspaces excludes the current one and keeps the newest three", () => {
  const workspaces = [
    { id: "w1", timeUsed: 500 },
    { id: "w2", timeUsed: 400 },
    { id: "w3", timeUsed: 300 },
    { id: "w4", timeUsed: 200 },
    { id: "w5", timeUsed: 100 },
  ]
  const status = (workspaceID: string) => (workspaceID === "w5" ? "disconnected" : "connected")

  const { recent, hasMore } = recentConnectedWorkspaces({
    workspaces,
    status,
    omitWorkspaceID: "w1",
  })

  expect(recent.map((workspace) => workspace.id)).toEqual(["w2", "w3", "w4"])
  expect(hasMore).toBe(false)
})

function WorkspaceHarness(props: { onReady(host: PanelHostApi, selected: WorkspaceSelection[]): void }) {
  const zone = useBottomZone()
  const sdk = useSDK()
  const sync = useSync()
  const project = useProject()
  const toast = useToast()
  const selected: WorkspaceSelection[] = []

  onMount(() => {
    props.onReady(zone.host, selected)
    void openWorkspacePanel({
      host: zone.host,
      sdk,
      sync,
      project,
      toast,
      onSelect: (selection) => {
        selected.push(selection)
      },
    })
  })

  return <BottomZone state={zone} composer={<></>} />
}

test("workspace panel selects an adapter, confirms creation and closes the flow", async () => {
  await using tmp = await shellState()
  let host: PanelHostApi | undefined
  let selected: WorkspaceSelection[] = []

  const app = await renderAppPanel(
    () => (
      <WorkspaceHarness
        onReady={(value, choices) => {
          host = value
          selected = choices
        }}
      />
    ),
    {
      width: 120,
      height: 40,
      state: tmp.path,
      handler: (url) => {
        if (url.pathname === "/experimental/workspace/adapter") {
          return json([{ type: "worktree", name: "Alpha", description: "Alpha adapter" }])
        }
        return undefined
      },
    },
  )

  try {
    await waitFor(app, () => host?.depth() === 1, "workspace picker")
    expect(app.captureCharFrame()).toContain("切换工作区")
    expect(app.captureCharFrame()).toContain("Alpha")

    app.mockInput.pressEnter()
    await waitFor(app, () => app.captureCharFrame().includes("新建工作区？"), "adapter confirmation")
    expect(app.captureCharFrame()).toContain("将创建并切换到 Alpha。继续吗？")
    expect(host?.depth()).toBe(1)

    // See the move-panel test: the panel is suspended while the confirm is up.
    app.mockInput.pressEnter()
    await waitFor(app, () => selected.length === 1 && host?.depth() === 0, "workspace selection")
    expect(selected).toEqual([{ type: "new", workspaceType: "worktree", workspaceName: "Alpha" }])
    expect(app.captureCharFrame()).not.toContain("切换工作区")
  } finally {
    app.renderer.destroy()
  }
})
