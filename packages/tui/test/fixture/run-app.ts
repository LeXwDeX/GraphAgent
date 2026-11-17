// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs"
import { mock } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { Global } from "@graphagent/core/global"
import type { Session } from "@graphagent/sdk"
import { dagModeStatus } from "../routes/dag-mode-harness"
import { tmpdir } from "./fixture"
import { createTuiResolvedConfig } from "./tui-runtime"
import { createEventSource, createFetch, directory, json, type FetchHandler } from "./tui-sdk"

const provider = {
  id: "test",
  name: "Test",
  source: "config",
  env: [],
  options: {},
  models: { "test-model": { id: "test-model", name: "Test model", capabilities: { reasoning: false } } },
}
const agent = { name: "build", mode: "primary", permission: [], options: {}, native: true }

export async function waitFor(predicate: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

export type Setup = Awaited<ReturnType<typeof createTestRenderer>>

// The renderer can still hold its output buffer right after a key press or an
// event. The native lease is transient, so retry instead of failing.
export async function captureFrame(setup: Setup): Promise<string> {
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

/**
 * Text that only the prompt draws: its agent and model line. The key hints that used to mark it are the footer's
 * alone since #1032 PR6, and the footer writes the agent name in lower case.
 */
export const PROMPT_MARK = "Build · "

export async function waitForFrame(setup: Setup, predicate: (frame: string) => boolean, label: string, timeout = 5000) {
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
export function footerRow(frame: string) {
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
export async function runApp(options: {
  sessions: readonly Session[]
  args: Record<string, unknown>
  width?: number
  height?: number
  ambiguousWidth?: 1 | 2
  dagMode?: () => ReturnType<typeof dagModeStatus>
  /** Extra entries of the persisted kv file, such as a display policy. */
  kv?: Record<string, unknown>
  /** Extra endpoint replies, consulted before the built-in ones; return nothing to fall through. */
  handler?: FetchHandler
}) {
  const tmp = await tmpdir()
  await Bun.write(
    `${tmp.path}/kv.json`,
    JSON.stringify({ ...(options.ambiguousWidth ? { ambiguous_width: options.ambiguousWidth } : {}), ...options.kv }),
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
    const custom = await options.handler?.(url, request)
    if (custom) return custom
    if (url.pathname === "/config") return json({ language: "zh-CN" })
    if (url.pathname === "/agent") return json([agent])
    if (url.pathname === "/session") return json(options.sessions)
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: {} })
    if (url.pathname === "/provider") return json({ all: [provider], default: {}, connected: ["test"] })
    for (const item of options.sessions) {
      if (url.pathname === `/session/${item.id}`) return json(item)
      if (url.pathname === `/session/${item.id}/message`) return json([])
      if (url.pathname === `/session/${item.id}/todo` || url.pathname === `/session/${item.id}/diff`) return json([])
      // No goal: an empty body would read as an empty goal object, and the drawer's goal block cannot draw one.
      if (url.pathname === `/session/${item.id}/goal`) return json(null)
      if (url.pathname === `/session/${item.id}/attention`) return json({})
      if (url.pathname === `/session/${item.id}/dag-mode`) return json(options.dagMode?.() ?? dagModeStatus())
      if (url.pathname === `/session/${item.id}/command`) return json({ info: {}, parts: [] })
    }
    return undefined
  }, events)

  const originalWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (() => true) as typeof process.stdout.write

  const { run } = await import("../../src/app")
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
    /** The kv file as it is on disk now. */
    kv: (): Record<string, unknown> => JSON.parse(readFileSync(`${tmp.path}/kv.json`, "utf8")),
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
