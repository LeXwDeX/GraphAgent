// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test"
import { setLanguage } from "../src/i18n"
import { cellWidth } from "../src/ui/width"
import { captureFrame, footerRow, runApp, waitFor, waitForFrame } from "./fixture/run-app"
import { directory } from "./fixture/tui-sdk"
import { dagModeStatus, sessionFixture } from "./routes/dag-mode-harness"

const mainID = "ses_app_dag_main"
const childID = "ses_app_dag_child"

afterEach(() => {
  setLanguage("zh-CN")
})

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
    // The footer of a sub-agent view carries its read-only notice where the agent name is on the other routes.
    const frame = await waitForFrame(child.setup, (value) => footerRow(value).includes("只读"), "the sub-agent footer")
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

// The shared right slot belongs to a leader hint, a toast or a running hook. With none of them the footer lists
// the key hints: the hook progress used to sit in the slot even while idle and kept them off every session route.
test("the session footer lists the key hints, the expand shortcut among them, while nothing holds the shared slot", async () => {
  const app = await runApp({
    sessions: [sessionFixture(mainID)],
    args: { continue: true },
    width: 140,
    height: 30,
  })
  try {
    const frame = await waitForFrame(
      app.setup,
      (value) => footerRow(value).includes("ctrl+o 展开输出"),
      "the expand shortcut in the footer",
    )
    expect(footerRow(frame)).toContain("ctrl+p 命令")
    expect(footerRow(frame)).toContain("展开输出")
    expect(footerRow(frame)).toContain("? 快捷键")
    expect(cellWidth(footerRow(frame), 1)).toBeLessThanOrEqual(140)
  } finally {
    await app.stop()
  }
})

test("a running hook takes the shared slot from the key hints and gives it back when it ends", async () => {
  const app = await runApp({ sessions: [sessionFixture(mainID)], args: { continue: true }, width: 140, height: 30 })
  const hook = (phase: "started" | "finished") => ({
    directory,
    payload: {
      id: `evt_app_hook_${phase}`,
      type: "session.hook.status" as const,
      properties: {
        sessionID: mainID,
        hookID: "policy",
        event: "PreToolUse",
        descriptor: "policy check",
        phase,
        timeoutMs: 30_000,
        cancellable: true,
        startedAt: Date.now(),
      },
    },
  })
  try {
    await waitForFrame(app.setup, (value) => footerRow(value).includes("ctrl+o 展开输出"), "the key hints")

    app.events.emit(hook("started"))
    const running = await waitForFrame(
      app.setup,
      (value) => footerRow(value).includes("hook policy check"),
      "the hook progress",
    )
    expect(footerRow(running)).not.toContain("ctrl+o 展开输出")

    app.events.emit(hook("finished"))
    await waitForFrame(app.setup, (value) => footerRow(value).includes("ctrl+o 展开输出"), "the key hints again")
  } finally {
    await app.stop()
  }
})
