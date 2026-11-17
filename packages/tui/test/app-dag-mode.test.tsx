// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import type { DagNode, DagWorkflowSummary, GlobalEvent } from "@graphagent/sdk"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { setLanguage } from "../src/i18n"
import { captureFrame, footerRow, runApp, waitForFrame, type Setup } from "./fixture/run-app"
import { directory, json, type FetchHandler } from "./fixture/tui-sdk"
import { dagModeStatus, sessionFixture } from "./routes/dag-mode-harness"

// DAG mode in the real app: the drawer's line shows only while the drawer is open, and the budget the server
// announces reaches the footer once and in its own words (#1032 5.1, 7.1).

const mainID = "ses_mode_main"
const childID = "ses_mode_sub"

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

async function settled(setup: Setup) {
  await Bun.sleep(60)
  await setup.renderOnce()
  return captureFrame(setup)
}

function toastEvent(properties: { title?: string; message: string; variant: string; duration?: number }): GlobalEvent {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the app reads are populated.
  return {
    directory,
    payload: { id: `evt_mode_toast_${properties.message.length}`, type: "tui.toast.show", properties },
  } as GlobalEvent
}

const sessions = [
  sessionFixture(mainID, { dagMode: "on" }),
  sessionFixture(childID, { parentID: mainID, dagMode: "on" }),
]

test("the drawer has the DAG mode line while it is open, and none of it while it is closed", async () => {
  const app = await runApp({ sessions, args: { continue: true }, width: 120, height: 30 })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("ctrl+p"), "the footer hints")
    expect(await settled(app.setup)).not.toContain("DAG 模式 开")

    app.setup.mockInput.pressKey("b", { ctrl: true })
    const open = await waitForFrame(app.setup, (frame) => frame.includes("DAG 模式 开"), "the open drawer")
    expect(open).toContain("DAG 模式 开 ctrl+x d")

    app.setup.mockInput.pressKey("b", { ctrl: true })
    await waitForFrame(app.setup, (frame) => !frame.includes("DAG 模式 开"), "the closed drawer")
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("a sub-agent view has no drawer line, even with the mode on", async () => {
  const app = await runApp({ sessions, args: { sessionID: childID }, width: 120, height: 30 })
  try {
    // The sub-agent footer is its own: the read-only notice and the keys of that view, not the command hints.
    await waitForFrame(app.setup, (frame) => frame.includes("只读"), "the sub-agent footer")
    app.setup.mockInput.pressKey("b", { ctrl: true })
    expect(await settled(app.setup)).not.toContain("DAG 模式")
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("the server's budget toast says its text once: the title is not put in front of a message that begins with it", async () => {
  const app = await runApp({ sessions, args: { continue: true }, width: 140, height: 30 })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("ctrl+p"), "the footer hints")
    app.events.emit(
      toastEvent({
        title: "DAG token budget",
        message: "DAG token budget: over 85% used",
        variant: "warning",
        duration: 8000,
      }),
    )
    const frame = await waitForFrame(app.setup, (value) => value.includes("over 85% used"), "the toast")
    expect(footerRow(frame)).toContain("DAG token budget: over 85% used")
    expect(frame).not.toContain("DAG token budget: DAG token budget")
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("the exhausted budget's toast is not stuttered either", async () => {
  const app = await runApp({ sessions, args: { continue: true }, width: 140, height: 30 })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("ctrl+p"), "the footer hints")
    app.events.emit(
      toastEvent({
        title: "DAG token budget",
        message: "DAG token budget exhausted: workflows paused",
        variant: "error",
        duration: 8000,
      }),
    )
    const frame = await waitForFrame(app.setup, (value) => value.includes("workflows paused"), "the toast")
    expect(footerRow(frame)).toContain("DAG token budget exhausted: workflows paused")
    expect(frame).not.toContain("DAG token budget: DAG token budget")
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

test("a toast whose message does not repeat its title keeps the title in front", async () => {
  const app = await runApp({ sessions, args: { continue: true }, width: 140, height: 30 })
  try {
    await waitForFrame(app.setup, (frame) => frame.includes("ctrl+p"), "the footer hints")
    app.events.emit(toastEvent({ title: "Build", message: "finished in 4s", variant: "info" }))
    const frame = await waitForFrame(app.setup, (value) => value.includes("finished in 4s"), "the toast")
    expect(footerRow(frame)).toContain("Build: finished in 4s")
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})

const WORKFLOW: DagWorkflowSummary = {
  id: "dag_alpha",
  title: "依赖升级验证",
  status: "running",
  graphRev: 1,
  nodeCount: 4,
  completedNodes: 2,
  runningNodes: 1,
  failedNodes: 0,
  skippedNodes: 0,
  abortedNodes: 0,
  queuedNodes: 1,
  escalatedNodes: 0,
  tokens: 1000,
  concurrencyRunning: 3,
}

function server(summary: DagWorkflowSummary): FetchHandler {
  return (url) => {
    if (url.pathname === `/dag/session/${mainID}/summary`) return json([summary])
    if (url.pathname === "/dag/dag_alpha/nodes") {
      const node = (id: string, status: string, depends: string[] = []): DagNode => ({
        id,
        workflow_id: "dag_alpha",
        name: id,
        worker_type: "task",
        status,
        required: false,
        depends_on: depends,
        replan_attempts: 0,
      })
      return json([
        node("a", "completed"),
        node("b", "completed"),
        node("c", "running", ["a", "b"]),
        node("d", "queued", ["c"]),
      ])
    }
    return undefined
  }
}

test("the band, the panel and the footer take a budget in its own tier and the app raises no toast of its own", async () => {
  const app = await runApp({
    sessions,
    args: { continue: true },
    width: 140,
    height: 30,
    dagMode: () =>
      dagModeStatus({
        budget: { tokens: 1000, used: 1000, usedCacheRead: 0, warnRatio: 0.8 },
        limits: { concurrency: 12, maxTotalNodes: 100, running: 3 },
      }),
    handler: server(WORKFLOW),
  })
  try {
    const band = await waitForFrame(app.setup, (frame) => frame.includes("预算 100%"), "the exhausted band")
    expect(band).toContain("模式开")
    expect(band).toContain("全进程并发 3/12")
    // Loading it exhausted is a snapshot, not a crossing: the footer's right side keeps its hints.
    const after = await settled(app.setup)
    expect(footerRow(after)).not.toContain("预算")
    expect(footerRow(after)).not.toContain("DAG token budget")
    expect(app.writes()).toEqual([])
  } finally {
    clearDrafts(app.setup)
    await app.stop()
  }
})
