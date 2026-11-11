import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { Global } from "@graphagent/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

async function waitFor(predicate: () => boolean, timeout = 3000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function waitForFrame(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string, timeout = 3000) {
  const start = Date.now()
  for (;;) {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    if (frame.includes(text)) return frame
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for "${text}":\n${frame}`)
    await Bun.sleep(10)
  }
}

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  // The test renderer has no terminal session, so the native title control
  // rejects with InvalidPhase; record the call without forwarding it.
  const titles: string[] = []
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
  }
  let titlesAtDestroy: number | undefined
  const destroy = setup.renderer.destroy.bind(setup.renderer)
  setup.renderer.destroy = () => {
    titlesAtDestroy ??= titles.length
    destroy()
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventSource()
  const calls = createFetch()
  const audio = await import("../src/audio")
  let disposes = 0
  mock.module("../src/audio", () => ({
    ...audio,
    dispose: () => {
      disposes += 1
    },
  }))

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig(),
        fetch: calls.fetch,
        events: events.source,
        args: {},
      }).pipe(Effect.provide(Global.defaultLayer)),
    )
    await waitFor(() => titles.includes("GraphAgent"))
    await setup.renderOnce()
    expect(titles).toContain("GraphAgent")
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(titlesAtDestroy).toBe(titles.length)
    // The scoped finalizer must run exactly one audio teardown.
    expect(disposes).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("home auto-opens the trust panel and escape closes it without a decision", async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  // The test renderer has no terminal session, so the native title control
  // rejects with InvalidPhase; record the call without forwarding it.
  const titles: string[] = []
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
  }
  // Sync opens the provider dialog when no provider is configured; a provider
  // keeps the bottom zone free for the trust prompt.
  const provider = {
    id: "test",
    name: "Test",
    source: "config",
    env: [],
    options: {},
    models: { "test-model": { id: "test-model", name: "Test model", capabilities: { reasoning: false } } },
  }
  const entries = [
    {
      id: "hook:project:.agents/hooks.json:0",
      category: "hook",
      command: "bun run setup",
      fp: "fp-setup",
      state: "pending",
      source: { file: "hooks.json", line: 3 },
      when: "PreToolUse",
      risks: [],
    },
  ]
  let posts = 0
  const events = createEventSource()
  const calls = createFetch((url, request) => {
    if (url.pathname === "/config") return json({ language: "zh-CN" })
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: {} })
    if (url.pathname === "/provider") return json({ all: [provider], default: {}, connected: ["test"] })
    if (url.pathname === "/project/trust") {
      if (request?.method === "POST") posts += 1
      return json({ entries })
    }
  })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ keybinds: { app_exit: "ctrl+y" } }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
      }).pipe(Effect.provide(Global.defaultLayer)),
    )
    const opened = await waitForFrame(setup, "先看一下这个项目会做什么", 5000)
    expect(opened).toContain("bun run setup")

    setup.mockInput.pressEscape()
    const closeDeadline = Date.now() + 3000
    for (;;) {
      await setup.renderOnce()
      if (!setup.captureCharFrame().includes("先看一下这个项目会做什么")) break
      if (Date.now() > closeDeadline) {
        throw new Error(`trust panel did not close:\n${setup.captureCharFrame()}`)
      }
      await Bun.sleep(20)
    }
    expect(posts).toBe(0)

    setup.mockInput.pressKey("y", { ctrl: true })
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("app.exit prints the session epilogue after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const core = await import("@opentui/core")
  await mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  // The test renderer has no terminal session, so the native title control
  // rejects with InvalidPhase; record the call without forwarding it.
  const titles: string[] = []
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
  }
  const events = createEventSource()
  // Sync opens the provider dialog when no provider is configured, which
  // pushes the keymap's `modal` mode and disables the base-layer exit binding.
  const provider = {
    id: "test",
    name: "Test",
    source: "config",
    env: [],
    options: {},
    models: { "test-model": { id: "test-model", name: "Test model", capabilities: { reasoning: false } } },
  }
  const session = {
    id: "dummy",
    title: "Demo session",
    slug: "dummy",
    projectID: "project",
    directory,
    version: "0.0.0-test",
    time: { created: 0, updated: 0 },
  }
  let trustEntries = [
    {
      id: "hook:project:.agents/hooks.json:0",
      category: "hook",
      command: "bun run setup",
      fp: "fp-setup",
      state: "pending",
      source: { file: "hooks.json", line: 3 },
      when: "PreToolUse",
      risks: [],
    },
  ]
  const calls = createFetch((url) => {
    // Pin the catalog so the footer assertion does not depend on the host locale.
    if (url.pathname === "/config") return json({ language: "zh-CN" })
    if (url.pathname === "/session") return json([session])
    if (url.pathname === "/session/dummy") return json(session)
    if (url.pathname === "/session/dummy/message") return json([])
    if (url.pathname === "/session/dummy/todo") return json([])
    if (url.pathname === "/session/dummy/diff") return json([])
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: {} })
    if (url.pathname === "/provider") return json({ all: [provider], default: {}, connected: ["test"] })
    if (url.pathname === "/project/trust") return json({ entries: trustEntries })
    return undefined
  })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ keybinds: { app_exit: "ctrl+y" } }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
      }).pipe(Effect.provide(Global.defaultLayer)),
    )

    await waitFor(() => titles.includes("GA | Demo session"))
    // Session routes keep the trust reminder next to the right slot.
    const frame = await waitForFrame(setup, "条项目命令未信任")
    expect(frame).toContain("⚠ 1 条项目命令未信任 · /trust")

    trustEntries = []
    events.emit({
      directory,
      payload: {
        id: "evt_trust_cleared",
        type: "project.trust.updated",
        properties: { projectID: "proj_test", entries: [], removed: [] },
      },
    })
    const clearedDeadline = Date.now() + 3000
    for (;;) {
      await setup.renderOnce()
      if (!setup.captureCharFrame().includes("未信任")) break
      if (Date.now() > clearedDeadline) throw new Error(`trust reminder did not clear:\n${setup.captureCharFrame()}`)
      await Bun.sleep(10)
    }

    setup.mockInput.pressKey("y", { ctrl: true })
    await task

    expect(stdout).toContain("Demo session")
    expect(stdout).toContain("opencode -s dummy")
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
