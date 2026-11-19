// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { setLanguage } from "../src/i18n"
import { promptShown, runApp, waitForFrame, type Setup } from "./fixture/run-app"
import { directory, json } from "./fixture/tui-sdk"
import { sessionFixture } from "./routes/dag-mode-harness"

// The real app against a fake server: a session deleted while it is on screen takes the user to its parent session
// when it was a sub-agent, and home otherwise.

const rootID = "ses_gone_root"
const childID = "ses_gone_child"

afterEach(() => {
  setLanguage("zh-CN")
})

function collect(root: Renderable, result: Renderable[] = []) {
  result.push(root)
  for (const child of root.getChildren()) collect(child, result)
  return result
}

/** An unmounting prompt keeps a non-empty draft for the next prompt in the process; leave none behind. */
function clearDrafts(setup: Setup) {
  for (const item of collect(setup.renderer.root)) {
    if (item instanceof TextareaRenderable && !item.isDestroyed) item.setText("")
  }
}

function deleted(id: string, parentID?: string) {
  return {
    directory,
    payload: {
      id: `evt_${id}_deleted`,
      type: "session.deleted" as const,
      properties: { sessionID: id, info: sessionFixture(id, parentID ? { parentID } : {}) },
    },
  }
}

test("a sub-agent session deleted on screen returns the user to its parent session, not home", async () => {
  const app = await runApp({
    sessions: [sessionFixture(rootID), sessionFixture(childID, { parentID: rootID })],
    args: { sessionID: childID },
  })
  try {
    // The sub-agent view has no prompt; its footer says it is read-only.
    const child = await waitForFrame(app.setup, (frame) => frame.includes("只读"), "the sub-agent view")
    expect(promptShown(child)).toBe(false)

    app.events.emit(deleted(childID, rootID))
    const parent = await waitForFrame(
      app.setup,
      (frame) => frame.includes("这个子 agent 会话已被删除，已回到父会话"),
      "the notice",
    )
    // The parent session is on screen with its prompt: home would have drawn the logo instead.
    expect(promptShown(parent)).toBe(true)
    expect(parent).not.toContain("██")
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("a sub-agent session deleted on screen says so in English too", async () => {
  const app = await runApp({
    sessions: [sessionFixture(rootID), sessionFixture(childID, { parentID: rootID })],
    args: { sessionID: childID },
    handler: (url) => (url.pathname === "/config" ? json({ language: "en" }) : undefined),
  })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("read-only"), "the sub-agent view")
    app.events.emit(deleted(childID, rootID))
    const parent = await waitForFrame(
      app.setup,
      (frame) => frame.includes("The subagent session was deleted; back in the parent session"),
      "the notice",
    )
    expect(promptShown(parent)).toBe(true)
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("a main session deleted on screen still goes home with its old notice", async () => {
  const app = await runApp({ sessions: [sessionFixture(rootID)], args: { continue: true } })
  try {
    await waitForFrame(app.setup, promptShown, "the session prompt")
    app.events.emit(deleted(rootID))
    const home = await waitForFrame(
      app.setup,
      (frame) => frame.includes("The current session was deleted"),
      "the old notice",
    )
    expect(home).toContain("██")
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})
