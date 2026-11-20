// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { setLanguage } from "../src/i18n"
import { footerRow, promptShown, runApp, waitForFrame, type Setup } from "./fixture/run-app"
import { json, type FetchHandler } from "./fixture/tui-sdk"
import { sessionFixture } from "./routes/dag-mode-harness"

// The real app against a fake server: the primary agent is switched with Tab and Shift+Tab alone. `/agent` is gone
// from the command list, and `/agents`, the sub-agent list, stays (#1677).

const mainID = "ses_agent_switch_main"

afterEach(() => {
  setLanguage("zh-CN")
})

const agents = ["build", "plan"].map((name) => ({ name, mode: "primary", permission: [], options: {}, native: true }))
const handler: FetchHandler = (url) => (url.pathname === "/agent" ? json(agents) : undefined)

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

test("Tab and Shift+Tab switch the primary agent, and the footer keeps its hint", async () => {
  const app = await runApp({ sessions: [sessionFixture(mainID)], args: {}, width: 120, height: 30, handler })
  try {
    await waitForFrame(app.setup, (frame) => footerRow(frame).includes("build ⇥ 切换 agent"), "the first agent")

    app.setup.mockInput.pressTab()
    await waitForFrame(app.setup, (frame) => footerRow(frame).includes("plan ⇥ 切换 agent"), "the second agent")

    app.setup.mockInput.pressTab({ shift: true })
    await waitForFrame(app.setup, (frame) => footerRow(frame).includes("build ⇥ 切换 agent"), "the first agent again")
  } finally {
    await app.stop()
  }
})

test("the command popup of a session has no /agent and still lists /agents", async () => {
  const app = await runApp({
    sessions: [sessionFixture(mainID)],
    args: { continue: true },
    width: 120,
    height: 30,
    handler,
  })
  try {
    await waitForFrame(app.setup, promptShown, "the prompt")
    await app.setup.mockInput.typeText("/agent")
    // A popup row reads `┃ /name  description ┃`, so `/agent` as a command is followed by a space and `/agents` is not.
    const frame = await waitForFrame(app.setup, (frame) => /┃ \/agents\s/.test(frame), "the command popup")
    expect(frame.split("\n").filter((row) => /┃ \/agent\s/.test(row))).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})
