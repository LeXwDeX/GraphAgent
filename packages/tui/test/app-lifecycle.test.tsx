import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@graphagent/tui/plugin-api"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { Global } from "@graphagent/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

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
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposes = 0

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
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(Global.defaultLayer)),
    )
    await ready
    await setup.renderOnce()
    await Bun.sleep(20)
    expect(titles).toContain("GraphAgent")
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(titlesAtDestroy).toBe(titles.length)
    expect(disposes).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("app.exit prints the session epilogue after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  // The test renderer has no terminal session, so the native title control
  // rejects with InvalidPhase; record the call without forwarding it.
  const titles: string[] = []
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
  }
  const events = createEventSource()
  const session = {
    id: "dummy",
    title: "Demo session",
    slug: "dummy",
    projectID: "project",
    directory,
    version: "0.0.0-test",
    time: { created: 0, updated: 0 },
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([session])
    if (url.pathname === "/session/dummy") return json(session)
    if (url.pathname === "/session/dummy/message") return json([])
    if (url.pathname === "/session/dummy/todo") return json([])
    if (url.pathname === "/session/dummy/diff") return json([])
  })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

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
        config: createTuiResolvedConfig(),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(Global.defaultLayer)),
    )

    await ready
    await setup.renderOnce()
    await Bun.sleep(20)
    expect(titles).toContain("GA | Demo session")
    api?.keymap.dispatchCommand("app.exit")
    await task

    expect(stdout).toContain("Demo session")
    expect(stdout).toContain("opencode -s dummy")
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
