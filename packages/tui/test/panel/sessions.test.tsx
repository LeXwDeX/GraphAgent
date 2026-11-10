// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import type { Session } from "@graphagent/sdk"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createSignal, onCleanup, onMount, Show, type ParentProps } from "solid-js"
import type { PromptRef } from "../../src/component/prompt"
import { usePromptRef } from "../../src/context/prompt"
import { setLanguage, t } from "../../src/i18n"
import type { PanelHostApi, PanelSpec } from "../../src/panel/host"
import { SessionListPanel } from "../../src/panel/sessions"
import { BottomZone, useBottomZone } from "../../src/shell/bottom-zone"
import { json } from "../fixture/tui-sdk"
import { shellState } from "../shell/contexts"
import { PanelSurface, renderAppPanel, type AppPanelTestContext } from "./contexts"
import { fakePromptRef } from "./prompt-ref"

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

function session(id: string, title: string, updated: number, workspaceID?: string): Session {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    directory: "/repo",
    title,
    version: "test",
    time: { created: 1, updated },
    ...(workspaceID ? { workspaceID } : {}),
  }
}

/** Mounts the session list through the shared bottom zone so recovery asks render. */
function ZonedPanel(props: { spec: PanelSpec; onHost?: (host: PanelHostApi) => void }) {
  const zone = useBottomZone()
  onMount(() => {
    zone.host.push(props.spec)
    props.onHost?.(zone.host)
  })
  return <BottomZone state={zone} composer={<></>} />
}

function PromptRefHarness(props: ParentProps<{ value: PromptRef }>) {
  const prompt = usePromptRef()
  prompt.set(props.value)
  onCleanup(() => prompt.set(undefined))
  return <>{props.children}</>
}

function DeferredPanel(props: { ready: () => boolean; spec: PanelSpec; onHost?: (host: PanelHostApi) => void }) {
  return (
    <Show when={props.ready()}>
      <PanelSurface spec={props.spec} onHost={props.onHost} />
    </Show>
  )
}

test("session panel lists sessions newest first and selects one", async () => {
  await using tmp = await shellState()
  let host: PanelHostApi | undefined
  let ctx!: AppPanelTestContext
  const ready = createSignal(false)
  const app = await renderAppPanel(
    () => (
      <DeferredPanel
        ready={ready[0]}
        spec={{ id: "sessions", render: () => <SessionListPanel /> }}
        onHost={(value) => (host = value)}
      />
    ),
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => {
        ctx = context
        context.sync.set("session", [session("alpha", "Alpha session", 1000), session("beta", "Beta session", 2000)])
        ready[1](true)
      },
    },
  )

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain(t("panel.sessions.title"))
    expect(frame).toContain("Beta session")
    expect(frame).toContain("Alpha session")
    expect(host?.depth()).toBe(1)

    app.mockInput.pressEnter()
    await settle(app)
    expect(JSON.parse(JSON.stringify(ctx.route.data))).toEqual({ type: "session", sessionID: "beta" })
    expect(host?.depth()).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("session panel pins the selected session with ctrl+f", async () => {
  await using tmp = await shellState()
  let ctx!: AppPanelTestContext
  const ready = createSignal(false)
  const app = await renderAppPanel(
    () => <DeferredPanel ready={ready[0]} spec={{ id: "sessions", render: () => <SessionListPanel /> }} />,
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => {
        ctx = context
        context.sync.set("session", [session("alpha", "Alpha session", 1000), session("beta", "Beta session", 2000)])
        ready[1](true)
      },
    },
  )

  try {
    app.mockInput.pressKey("f", { ctrl: true })
    await settle(app)
    expect(ctx.local.session.pinned()).toContain("beta")
    expect(app.captureCharFrame()).toContain(t("panel.sessions.group.pinned"))

    app.mockInput.pressKey("f", { ctrl: true })
    await settle(app)
    expect(ctx.local.session.pinned()).not.toContain("beta")
  } finally {
    app.renderer.destroy()
  }
})

test("session panel deletes only after a second ctrl+d confirmation", async () => {
  await using tmp = await shellState()
  let deletes = 0
  const ready = createSignal(false)
  const app = await renderAppPanel(
    () => <DeferredPanel ready={ready[0]} spec={{ id: "sessions", render: () => <SessionListPanel /> }} />,
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => {
        context.sync.set("session", [session("alpha", "Alpha session", 1000), session("beta", "Beta session", 2000)])
        ready[1](true)
      },
      handler: (url) => {
        if (url.pathname === "/session/beta") {
          deletes += 1
          return json(true)
        }
        return undefined
      },
    },
  )

  try {
    app.mockInput.pressKey("d", { ctrl: true })
    await settle(app)
    expect(deletes).toBe(0)
    expect(app.captureCharFrame()).toContain("再按一次")
    expect(app.captureCharFrame()).toContain("确认删除")

    app.mockInput.pressKey("d", { ctrl: true })
    await waitFor(app, () => deletes === 1, "session deletion")
  } finally {
    app.renderer.destroy()
  }
})

test("session panel renames the selected session through the composer edit", async () => {
  await using tmp = await shellState()
  let host: PanelHostApi | undefined
  let updates = 0
  const prompt = fakePromptRef()
  const ready = createSignal(false)
  const app = await renderAppPanel(
    () => (
      <PromptRefHarness value={prompt.ref}>
        <DeferredPanel
          ready={ready[0]}
          spec={{ id: "sessions", render: () => <SessionListPanel /> }}
          onHost={(value) => (host = value)}
        />
      </PromptRefHarness>
    ),
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => {
        context.sync.set("session", [session("alpha", "Alpha session", 1000), session("beta", "Beta session", 2000)])
        ready[1](true)
      },
      handler: (url) => {
        if (url.pathname === "/session/beta") {
          updates += 1
          return json(session("beta", "Renamed session", 2000))
        }
        return undefined
      },
    },
  )

  try {
    app.mockInput.pressKey("r", { ctrl: true })
    await settle(app)
    expect(host?.depth()).toBe(0)
    expect(prompt.edits).toHaveLength(1)
    expect(prompt.edits[0]!.label).toBe(t("prompt.edit.rename"))
    expect(prompt.edits[0]!.value).toBe("Beta session")

    await prompt.edits[0]!.commit?.("Renamed session")
    expect(updates).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("session panel searches on the server and shows the returned rows", async () => {
  await using tmp = await shellState()
  const searches: string[] = []
  const ready = createSignal(false)
  const app = await renderAppPanel(
    () => <DeferredPanel ready={ready[0]} spec={{ id: "sessions", render: () => <SessionListPanel /> }} />,
    {
      width: 120,
      height: 40,
      state: tmp.path,
      setup: (context) => {
        context.sync.set("session", [session("alpha", "Alpha session", 1000), session("beta", "Beta session", 2000)])
        ready[1](true)
      },
      handler: (url) => {
        if (url.pathname !== "/session") return undefined
        const search = url.searchParams.get("search")
        if (!search) return undefined
        searches.push(search)
        return json([session("alpha", "Alpha session", 1000)])
      },
    },
  )

  try {
    for (const key of "alp") app.mockInput.pressKey(key)
    await waitFor(app, () => searches.includes("alp"), "server search")
    await waitFor(app, () => !app.captureCharFrame().includes("Beta session"), "search rows")
    expect(app.captureCharFrame()).toContain("Alpha session")
  } finally {
    app.renderer.destroy()
  }
})

test("a failed delete offers to delete the unavailable workspace", async () => {
  await using tmp = await shellState()
  let deletes = 0
  let removals = 0
  const app = await renderAppPanel(() => <ZonedPanel spec={{ id: "sessions", render: () => <SessionListPanel /> }} />, {
    width: 120,
    height: 40,
    state: tmp.path,
    setup: (context) => {
      context.sync.set("session", [session("beta", "Beta session", 2000, "wrk_unavailable")])
    },
    handler: (url) => {
      if (url.pathname === "/session/beta") {
        deletes += 1
        return json({ message: "workspace unavailable" }, { status: 500 })
      }
      if (url.pathname === "/experimental/workspace/wrk_unavailable") {
        removals += 1
        return json(true)
      }
      return undefined
    },
  })

  try {
    app.mockInput.pressKey("d", { ctrl: true })
    await settle(app)
    app.mockInput.pressKey("d", { ctrl: true })
    await waitFor(app, () => app.captureCharFrame().includes(t("panel.sessions.recover.title")), "recovery ask")
    expect(app.captureCharFrame()).toContain(t("panel.sessions.recover.delete"))
    expect(app.captureCharFrame()).toContain(t("panel.sessions.recover.restore"))

    app.mockInput.pressKey("1")
    await waitFor(app, () => removals === 1, "workspace removal")
    expect(deletes).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("a failed delete can restore the session into a new workspace", async () => {
  await using tmp = await shellState()
  let adapters = 0
  const app = await renderAppPanel(() => <ZonedPanel spec={{ id: "sessions", render: () => <SessionListPanel /> }} />, {
    width: 120,
    height: 40,
    state: tmp.path,
    setup: (context) => {
      context.sync.set("session", [session("beta", "Beta session", 2000, "wrk_unavailable")])
    },
    handler: (url) => {
      if (url.pathname === "/session/beta") return json({ message: "workspace unavailable" }, { status: 500 })
      if (url.pathname === "/experimental/workspace/adapter") {
        adapters += 1
        return json([{ type: "worktree", name: "Alpha", description: "Alpha adapter" }])
      }
      return undefined
    },
  })

  try {
    app.mockInput.pressKey("d", { ctrl: true })
    await settle(app)
    app.mockInput.pressKey("d", { ctrl: true })
    await waitFor(app, () => app.captureCharFrame().includes(t("panel.sessions.recover.title")), "recovery ask")

    app.mockInput.pressKey("2")
    await waitFor(app, () => adapters === 1, "workspace picker")
    await waitFor(app, () => app.captureCharFrame().includes(t("panel.workspace.select.title")), "workspace panel")
    expect(app.captureCharFrame()).toContain("Alpha")
  } finally {
    app.renderer.destroy()
  }
})
