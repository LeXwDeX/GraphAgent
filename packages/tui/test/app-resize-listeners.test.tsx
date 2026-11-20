// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import type { DagNode, DagWorkflowSummary } from "@graphagent/sdk"
import { setLanguage } from "../src/i18n"
import { RENDERER_LISTENER_LIMIT } from "../src/util/renderer"
import { nextTurn, renderUntilFrame } from "./fixture/frames"
import { runApp, promptShown, type Setup } from "./fixture/run-app"
import { json } from "./fixture/tui-sdk"
import { sessionFixture } from "./routes/dag-mode-harness"

// The real app against a fake server. Every mounted `useTerminalDimensions()` caller holds one `resize` listener on the
// renderer, so the count is ten with the app idle and thirteen with the `/dag` panel open, past the ten Node warns
// about (#1425). The count is bounded, not a leak: the app root raises the limit to a fixed value, the count stays
// under it with the panel open, it is back at the idle value once the panel closes, and Node never warns.

const mainID = "ses_app_resize"
const workflowID = "wf_app_resize"

afterEach(() => {
  setLanguage("zh-CN")
})

const summary: DagWorkflowSummary = {
  id: workflowID,
  title: "依赖升级验证",
  status: "running",
  graphRev: 1,
  nodeCount: 2,
  completedNodes: 1,
  runningNodes: 0,
  failedNodes: 1,
  skippedNodes: 0,
  abortedNodes: 0,
  queuedNodes: 0,
  escalatedNodes: 0,
}

const nodes: DagNode[] = [
  {
    id: "install",
    workflow_id: workflowID,
    name: "install",
    worker_type: "task",
    status: "completed",
    required: false,
    depends_on: [],
    replan_attempts: 0,
    started_at: 1_000,
    completed_at: 2_000,
  },
  {
    id: "e2e",
    workflow_id: workflowID,
    name: "e2e",
    worker_type: "task",
    status: "failed",
    required: false,
    depends_on: ["install"],
    replan_attempts: 0,
    started_at: 2_000,
    completed_at: 4_000,
    error_reason: "timeout",
  },
]

function collect(root: Renderable, result: Renderable[] = []) {
  result.push(root)
  for (const child of root.getChildren()) collect(child, result)
  return result
}

function textareas(setup: Setup) {
  return collect(setup.renderer.root).filter((item): item is TextareaRenderable => item instanceof TextareaRenderable)
}

function mountApp() {
  return runApp({
    sessions: [sessionFixture(mainID)],
    args: { continue: true },
    width: 120,
    height: 30,
    handler: (url) => {
      if (url.pathname === `/dag/session/${mainID}/summary`) return json([summary])
      if (url.pathname === `/dag/${workflowID}/nodes`) return json({ graphRev: 1, nodes })
      return undefined
    },
  })
}

test("the resize listeners stay under the renderer's limit with /dag open, and come back when it closes", async () => {
  const warnings: string[] = []
  const onWarning = (warning: Error) => {
    if (warning.name === "MaxListenersExceededWarning") warnings.push(warning.message)
  }
  process.on("warning", onWarning)
  const app = await mountApp()
  try {
    const { renderer } = app.setup
    await renderUntilFrame(app.setup, promptShown, "the prompt")
    // Bounded, not lifted: 0 would mean unlimited and mute a real leak.
    expect(renderer.getMaxListeners()).toBe(RENDERER_LISTENER_LIMIT)
    const idle = renderer.listenerCount("resize")
    expect(idle).toBeGreaterThan(0)

    // Twice: the listeners a panel adds go away with it, so opening it again starts from the same count.
    for (let round = 0; round < 2; round++) {
      await app.setup.mockInput.typeText("/dag")
      await renderUntilFrame(app.setup, (frame) => frame.includes("工作流"), "the command popup")
      app.setup.mockInput.pressEnter()
      await renderUntilFrame(
        app.setup,
        (frame) => frame.includes("[运行中]") && frame.includes("e2e"),
        "the workflow panel",
      )
      const open = renderer.listenerCount("resize")
      expect(open).toBeGreaterThan(idle)
      expect(open).toBeLessThanOrEqual(RENDERER_LISTENER_LIMIT)

      app.setup.mockInput.pressEscape()
      await renderUntilFrame(app.setup, promptShown, "the input again")
      expect(renderer.listenerCount("resize")).toBe(idle)
    }

    // Node reports an excess listener from a later tick of the loop.
    await nextTurn()
    expect(warnings).toEqual([])
  } finally {
    process.off("warning", onWarning)
    for (const input of textareas(app.setup)) if (!input.isDestroyed) input.setText("")
    await app.stop()
  }
})
