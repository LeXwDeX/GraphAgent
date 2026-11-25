// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import type { DagNode, DagWorkflowSummary } from "@graphagent/sdk"
import { setLanguage } from "../src/i18n"
import { runApp, waitForFrame, promptShown, type Setup } from "./fixture/run-app"
import { json } from "./fixture/tui-sdk"
import { sessionFixture } from "./routes/dag-mode-harness"

// The real app against a fake server: `/dag` opens the workflow panel in the bottom zone, over the input, and what
// the panel hands back to the input is the main session's draft (#1032 4).

const mainID = "ses_app_dag_panel"
const workflowID = "wf_app_panel"

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
      if (url.pathname === `/dag/${workflowID}/nodes`) return json(nodes)
      return undefined
    },
  })
}

test("/dag opens the workflow panel over the input, and escape gives the input back", async () => {
  const app = await mountApp()
  try {
    await waitForFrame(app.setup, promptShown, "the prompt")
    await app.setup.mockInput.typeText("/dag")
    await waitForFrame(app.setup, (frame) => frame.includes("工作流"), "the command popup")
    app.setup.mockInput.pressEnter()

    const frame = await waitForFrame(
      app.setup,
      (value) => value.includes("[运行中]") && value.includes("e2e"),
      "the workflow panel",
    )
    expect(frame).toContain("依赖升级验证")
    expect(frame).toContain("请主 agent 处理")
    expect(promptShown(frame)).toBe(false)

    app.setup.mockInput.pressEscape()
    await waitForFrame(app.setup, promptShown, "the input again")
    expect(app.writes()).toEqual([])
  } finally {
    for (const input of textareas(app.setup)) if (!input.isDestroyed) input.setText("")
    await app.stop()
  }
})

test("a request chosen in the panel is the draft of the main session, and nothing is sent", async () => {
  const app = await mountApp()
  try {
    await waitForFrame(app.setup, promptShown, "the prompt")
    await app.setup.mockInput.typeText("/dag")
    await waitForFrame(app.setup, (frame) => frame.includes("工作流"), "the command popup")
    app.setup.mockInput.pressEnter()
    await waitForFrame(app.setup, (value) => value.includes("[运行中]") && value.includes("e2e"), "the workflow panel")

    // The failed node starts selected: `i` prefills the request for it in one press and closes the panel.
    await app.setup.mockInput.typeText("i")

    const frame = await waitForFrame(app.setup, promptShown, "the input again")
    expect(frame).toContain("请主 agent 处理工作流「依赖升级验证」(wf_app_panel) 的节点「e2e」：timeout")
    const [input] = textareas(app.setup)
    expect(input.plainText).toBe("请主 agent 处理工作流「依赖升级验证」(wf_app_panel) 的节点「e2e」：timeout")
    expect(app.setup.renderer.currentFocusedRenderable).toBe(input)
    expect(app.writes()).toEqual([])
  } finally {
    for (const input of textareas(app.setup)) if (!input.isDestroyed) input.setText("")
    await app.stop()
  }
})
