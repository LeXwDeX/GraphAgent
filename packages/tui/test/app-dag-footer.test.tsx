// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { Global } from "@graphagent/core/global"
import type { Session } from "@graphagent/sdk"
import { setLanguage } from "../src/i18n"
import { cellWidth } from "../src/ui/width"
import { tmpdir } from "./fixture/fixture"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"
import { dagModeStatus, sessionFixture } from "./routes/dag-mode-harness"

const mainID = "ses_app_dag_main"
const childID = "ses_app_dag_child"

const provider = {
  id: "test",
  name: "Test",
  source: "config",
  env: [],
  options: {},
  models: { "test-model": { id: "test-model", name: "Test model", capabilities: { reasoning: false } } },
}
const agent = { name: "build", mode: "primary", permission: [], options: {}, native: true }

afterEach(() => {
  setLanguage("zh-CN")
})

async function waitFor(predicate: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

type Setup = Awaited<ReturnType<typeof createTestRenderer>>

// The renderer can still hold its output buffer right after a key press or an
// event. The native lease is transient, so retry instead of failing.
async function captureFrame(setup: Setup): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return setup.captureCharFrame()
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("OutputBusy"))) throw error
      await Bun.sleep(5)
      await setup.renderOnce()
    }
  }
  throw new Error("renderer stayed busy while capturing a frame")
}

async function waitForFrame(setup: Setup, predicate: (frame: string) => boolean, label: string, timeout = 5000) {
  const start = Date.now()
  for (;;) {
    await setup.renderOnce()
    const frame = await captureFrame(setup)
    if (predicate(frame)) return frame
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}:\n${frame}`)
    await Bun.sleep(10)
  }
}

/** The footer is the last non-empty row of the frame. */
function footerRow(frame: string) {
  return (
    frame
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .at(-1) ?? ""
  )
}

/**
 * Runs the real app against a fake server. Returns once `ready` holds; `stop`
 * exits through the remapped quit key and waits for the scoped cleanup.
 */
async function runApp(options: {
  sessions: readonly Session[]
  args: Record<string, unknown>
  width?: number
  height?: number
  ambiguousWidth?: 1 | 2
  dagMode?: () => ReturnType<typeof dagModeStatus>
}) {
  const tmp = await tmpdir()
  await Bun.write(
    `${tmp.path}/kv.json`,
    JSON.stringify(options.ambiguousWidth ? { ambiguous_width: options.ambiguousWidth } : {}),
  )
  const setup = await createTestRenderer({ width: options.width ?? 120, height: options.height ?? 30 })
  const core = await import("@opentui/core")
  await mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  // The test renderer has no terminal session, so the native title control
  // rejects; the title is not under test here.
  setup.renderer.setTerminalTitle = () => {}

  const events = createEventSource()
  const sent: { method: string; path: string; body: unknown }[] = []
  const calls = createFetch(async (url, request) => {
    if (request && request.method !== "GET") {
      const text = await request.clone().text()
      sent.push({ method: request.method, path: url.pathname, body: text ? JSON.parse(text) : undefined })
    }
    if (url.pathname === "/config") return json({ language: "zh-CN" })
    if (url.pathname === "/agent") return json([agent])
    if (url.pathname === "/session") return json(options.sessions)
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: {} })
    if (url.pathname === "/provider") return json({ all: [provider], default: {}, connected: ["test"] })
    for (const item of options.sessions) {
      if (url.pathname === `/session/${item.id}`) return json(item)
      if (url.pathname === `/session/${item.id}/message`) return json([])
      if (url.pathname === `/session/${item.id}/todo` || url.pathname === `/session/${item.id}/diff`) return json([])
      if (url.pathname === `/session/${item.id}/goal`) return json(undefined)
      if (url.pathname === `/session/${item.id}/attention`) return json({})
      if (url.pathname === `/session/${item.id}/dag-mode`) return json(options.dagMode?.() ?? dagModeStatus())
      if (url.pathname === `/session/${item.id}/command`) return json({ info: {}, parts: [] })
    }
    return undefined
  }, events)

  const originalWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (() => true) as typeof process.stdout.write

  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      url: "http://test",
      directory,
      config: createTuiResolvedConfig({ keybinds: { app_exit: "ctrl+y" } }),
      fetch: calls.fetch,
      events: events.source,
      args: options.args,
    }).pipe(Effect.provide(Global.layerWith({ state: tmp.path, home: tmp.path, data: tmp.path }))),
  )

  return {
    setup,
    events,
    commands: () => sent.filter((item) => item.path.endsWith("/command")),
    writes: () => sent.filter((item) => !item.path.endsWith("/attention")),
    async stop() {
      try {
        if (!setup.renderer.isDestroyed) {
          setup.mockInput.pressKey("y", { ctrl: true })
          // A failing test must report its own error, not hang on the app exit.
          await Promise.race([task, Bun.sleep(5000)])
        }
      } finally {
        process.stdout.write = originalWrite
        if (!setup.renderer.isDestroyed) setup.renderer.destroy()
        mock.restore()
        await tmp[Symbol.asyncDispose]()
      }
    },
  }
}

for (const [dagMode, expected] of [
  ["on", "build ◆ DAG tab 切换 agent"],
  ["off", "build ◇ DAG tab 切换 agent"],
] as const) {
  test(`the session footer shows the ${dagMode} indicator after the agent name`, async () => {
    const app = await runApp({ sessions: [sessionFixture(mainID, { dagMode })], args: { continue: true } })
    try {
      const frame = await waitForFrame(app.setup, (value) => footerRow(value).includes(expected), expected)
      expect(footerRow(frame)).toContain(expected)
    } finally {
      await app.stop()
    }
  })
}

test("the session footer shows the warning state when workflows cannot start", async () => {
  const app = await runApp({
    sessions: [sessionFixture(mainID, { dagMode: "on" })],
    args: { continue: true },
    dagMode: () => dagModeStatus({ availability: "unavailable", unavailableReason: "workflow_tool_disabled" }),
  })
  try {
    const frame = await waitForFrame(app.setup, (value) => footerRow(value).includes("◆ DAG !"), "◆ DAG !")
    expect(footerRow(frame)).toContain("build ◆ DAG ! tab 切换 agent")
  } finally {
    await app.stop()
  }
})

test("the footer keeps only the marker below 80 columns", async () => {
  const app = await runApp({
    sessions: [sessionFixture(mainID, { dagMode: "on" })],
    args: { continue: true },
    width: 70,
    height: 24,
  })
  try {
    const frame = await waitForFrame(app.setup, (value) => footerRow(value).includes("build ◆"), "build ◆")
    expect(footerRow(frame)).not.toContain("DAG")
    expect(footerRow(frame)).toContain("build ◆ tab 切换 agent")
  } finally {
    await app.stop()
  }
})

for (const ambiguousWidth of [1, 2] as const) {
  test(`the session footer fits 80 columns at ambiguous_width ${ambiguousWidth}`, async () => {
    const app = await runApp({
      sessions: [sessionFixture(mainID, { dagMode: "on" })],
      args: { continue: true },
      width: 80,
      height: 24,
      ambiguousWidth,
      dagMode: () => dagModeStatus({ availability: "unavailable", unavailableReason: "start_denied" }),
    })
    try {
      const frame = await waitForFrame(app.setup, (value) => footerRow(value).includes("◆ DAG !"), "◆ DAG !")
      // Only the footer row is measured: the prompt border above it is a run of
      // ambiguous block glyphs that this change does not own.
      expect(cellWidth(footerRow(frame), ambiguousWidth)).toBeLessThanOrEqual(80)
    } finally {
      await app.stop()
    }
  })
}

test("a sub-agent view and the home route show no indicator", async () => {
  const child = await runApp({
    sessions: [sessionFixture(mainID, { dagMode: "on" }), sessionFixture(childID, { parentID: mainID, dagMode: "on" })],
    args: { sessionID: childID },
  })
  try {
    const frame = await waitForFrame(child.setup, (value) => footerRow(value).includes("build"), "the footer agent")
    await Bun.sleep(100)
    await child.setup.renderOnce()
    expect(footerRow(await captureFrame(child.setup))).not.toContain("DAG")
    expect(frame).not.toContain("◆ DAG")
  } finally {
    await child.stop()
  }

  const home = await runApp({ sessions: [sessionFixture(mainID, { dagMode: "on" })], args: {} })
  try {
    await waitForFrame(home.setup, (value) => footerRow(value).includes("build"), "the footer agent")
    await Bun.sleep(100)
    await home.setup.renderOnce()
    expect(footerRow(await captureFrame(home.setup))).not.toContain("DAG")
  } finally {
    await home.stop()
  }
})

test("<leader>d asks the server once and the footer follows the session update", async () => {
  const app = await runApp({ sessions: [sessionFixture(mainID, { dagMode: "off" })], args: { continue: true } })
  try {
    await waitForFrame(app.setup, (value) => footerRow(value).includes("◇ DAG"), "◇ DAG")

    app.setup.mockInput.pressKey("x", { ctrl: true })
    await app.setup.renderOnce()
    app.setup.mockInput.pressKey("d")
    await waitFor(() => app.commands().length > 0)
    expect(app.writes()).toEqual([
      {
        method: "POST",
        path: `/session/${mainID}/command`,
        body: {
          hookMode: "interactive",
          command: "dag-mode",
          arguments: "on",
          agent: "build",
          model: "test/test-model",
        },
      },
    ])
    // The footer only changes once the server reports the new mode.
    await Bun.sleep(100)
    await app.setup.renderOnce()
    expect(footerRow(await captureFrame(app.setup))).toContain("◇ DAG")

    app.events.emit({
      directory,
      payload: {
        id: "evt_app_dag_updated",
        type: "session.updated",
        properties: { sessionID: mainID, info: sessionFixture(mainID, { dagMode: "on" }) },
      },
    })
    await waitForFrame(app.setup, (value) => footerRow(value).includes("build ◆ DAG"), "build ◆ DAG")
  } finally {
    await app.stop()
  }
})
