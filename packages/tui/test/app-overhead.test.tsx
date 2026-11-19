// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import type { GlobalEvent, SessionOverhead } from "@graphagent/sdk"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { setLanguage } from "../src/i18n"
import { captureFrame, footerRow, runApp, waitForFrame, type Setup } from "./fixture/run-app"
import { directory, json, type FetchHandler } from "./fixture/tui-sdk"
import { overheadFixture, sessionFixture } from "./routes/dag-mode-harness"

// The fixed request overhead in the real app (#1461): the server's large-overhead warning reaches the footer as the
// warning toast it is, and the drawer shows what every request carries, only while it is open.

const mainID = "ses_overhead_main"

afterEach(() => {
  setLanguage("zh-CN")
})

function collect(root: Renderable, result: Renderable[] = []) {
  result.push(root)
  for (const child of root.getChildren()) collect(child, result)
  return result
}

/** An unmounting prompt keeps its draft in module state; leave nothing for the next test in the process. */
function clearDrafts(setup: Setup) {
  for (const item of collect(setup.renderer.root)) {
    if (item instanceof TextareaRenderable && !item.isDestroyed) item.setText("")
  }
}

let sequence = 0
function event(type: string, properties: Record<string, unknown>): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the app reads are populated.
  return { directory, payload: { id: `evt_app_overhead_${++sequence}`, type, properties } } as GlobalEvent
}

const OVERHEAD: SessionOverhead = overheadFixture({
  bytes: 52_200,
  tokens: 17_400,
  model: "test/test-model",
  window: 100_000,
  windowSource: "config",
  ratio: 0.174,
  sources: [
    { source: "base", bytes: 6_000, tokens: 2_000, hash: "0123456789abcdef" },
    { source: "tools", bytes: 36_000, tokens: 12_000, hash: "0123456789abcdef" },
    { source: "instructions", label: "AGENTS.md", bytes: 3_600, tokens: 1_200, hash: "0123456789abcdef" },
  ],
})

const sessions = [sessionFixture(mainID)]

/** The overhead endpoint of the fake server, with the reads it has heard of. */
function overheadServer(answer: () => SessionOverhead = () => OVERHEAD) {
  const reads: string[] = []
  const handler: FetchHandler = (url) => {
    const match = url.pathname.match(/^\/session\/([^/]+)\/overhead$/)
    if (!match) return undefined
    reads.push(match[1])
    return json(answer())
  }
  return { reads, handler }
}

test("the server's large-overhead warning reaches the footer as a warning toast, title in front", async () => {
  const app = await runApp({ sessions, args: { continue: true }, width: 160, height: 30 })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("ctrl+p"), "the footer hints")
    app.events.emit(
      event("tui.toast.show", {
        title: "Fixed request overhead is large",
        message: "≈17,400 tokens (17% of the 100,000-token window) are sent with every request.",
        variant: "warning",
        duration: 8000,
      }),
    )
    const frame = await waitForFrame(app.setup, (value) => value.includes("are sent with every request"), "the toast")
    expect(footerRow(frame)).toContain(
      "Fixed request overhead is large: ≈17,400 tokens (17% of the 100,000-token window) are sent with every request.",
    )
    // The server's toast is the only notice: the app raises none of its own.
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("the drawer shows the overhead while it is open, and a closed drawer neither shows it nor reads it", async () => {
  const server = overheadServer()
  const app = await runApp({ sessions, args: { continue: true }, width: 120, height: 36, handler: server.handler })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("ctrl+p"), "the footer hints")
    // Closed: nothing in the frame, and nothing asked of the server.
    expect(await captureFrame(app.setup)).not.toContain("固定开销")
    expect(server.reads).toEqual([])

    app.setup.mockInput.pressKey("b", { ctrl: true })
    const open = await waitForFrame(app.setup, (frame) => frame.includes("≈17,400 tokens · 17%"), "the open drawer")
    expect(open).toContain("固定开销")
    expect(open).toContain("≈12,000 tools")
    expect(open).toContain("≈1,200 instructions AGENTS.md")
    expect(server.reads).toEqual([mainID])

    app.setup.mockInput.pressKey("b", { ctrl: true })
    await waitForFrame(app.setup, (frame) => !frame.includes("固定开销"), "the closed drawer")
    // A turn that settles now asks for nothing: the section is gone with the drawer. The toast that follows the event
    // on the same stream shows once the event before it has been handled, so what is asserted next is not a guess.
    app.events.emit(
      event("session.turn.settled", {
        sessionID: mainID,
        turnID: "turn_app_overhead",
        outcome: { type: "completed" },
        steps: 1,
        timeEnded: 10,
      }),
    )
    app.events.emit(event("tui.toast.show", { message: "after the settled turn", variant: "info" }))
    await waitForFrame(app.setup, (frame) => frame.includes("after the settled turn"), "the toast behind the event")
    expect(server.reads).toEqual([mainID])
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})
