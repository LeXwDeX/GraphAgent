// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Goal, Message } from "@graphagent/sdk"
import { afterEach, expect, test } from "bun:test"
import { setLanguage } from "../../../src/i18n"
import {
  contextBarCells,
  contextTone,
  contextUsage,
  costText,
  goalLine,
  services,
  todoCount,
  todoMark,
} from "../../../src/routes/session/drawer-model"

afterEach(() => {
  setLanguage("zh-CN")
})

function assistant(output: number, extra: { input?: number; providerID?: string; modelID?: string } = {}): Message {
  return {
    id: `msg_${output}`,
    sessionID: "ses_model",
    role: "assistant",
    parentID: "msg_user",
    agent: "build",
    mode: "build",
    modelID: extra.modelID ?? "big",
    providerID: extra.providerID ?? "test",
    path: { cwd: "/", root: "/" },
    time: { created: 1, completed: 2 },
    cost: 0,
    tokens: { input: extra.input ?? 0, output, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  } as Message
}

const providers = [{ id: "test", models: { big: { limit: { context: 1000 } } } }]

test("the context is the latest assistant message with output, against the model's window", () => {
  expect(contextUsage([], providers)).toBeUndefined()
  expect(contextUsage([assistant(0, { input: 500 })], providers)).toBeUndefined()
  expect(contextUsage([assistant(10, { input: 840 }), assistant(0, { input: 990 })], providers)).toEqual({
    used: 850,
    limit: 1000,
    percent: 85,
  })
  // An unknown model has no window: the tokens alone.
  expect(contextUsage([assistant(10, { modelID: "other" })], providers)).toEqual({ used: 10 })
})

test("the context tone turns to warning at 85% and to error at 95%", () => {
  expect(contextTone(84)).toBe("text")
  expect(contextTone(85)).toBe("warning")
  expect(contextTone(94)).toBe("warning")
  expect(contextTone(95)).toBe("error")
  expect(contextTone(130)).toBe("error")
})

test("the bar has 8 cells, never all of them below 100% and never none above 0%", () => {
  expect(contextBarCells(0)).toBe(0)
  expect(contextBarCells(1)).toBe(1)
  expect(contextBarCells(50)).toBe(4)
  expect(contextBarCells(99)).toBe(7)
  expect(contextBarCells(100)).toBe(8)
  expect(contextBarCells(140)).toBe(8)
})

test("the cost is dollars with cents, $0.00 without one", () => {
  expect(costText(undefined)).toBe("$0.00")
  expect(costText(Number.NaN)).toBe("$0.00")
  expect(costText(1.234)).toBe("$1.23")
})

test("the goal line is the turns and the status, or the reason a waiting or paused goal gives", () => {
  const goal: Goal = { goal: "升级依赖", status: "active", turnsUsed: 3, maxTurns: 10 }
  expect(goalLine(goal)).toEqual({ turns: "第 3/10 轮", state: "进行中", warning: false })
  expect(goalLine({ ...goal, maxTurns: "Infinity" })).toEqual({ turns: "第 3 轮", state: "进行中", warning: false })
  expect(goalLine({ ...goal, status: "paused", pausedReason: "等待评审" })).toEqual({
    turns: "第 3/10 轮",
    state: "等待评审",
    warning: true,
  })
  // A reason only counts for a goal that is waiting or paused.
  expect(goalLine({ ...goal, pausedReason: "旧原因" }).warning).toBe(false)
  setLanguage("en")
  expect(goalLine(goal)).toEqual({ turns: "turn 3/10", state: "Active", warning: false })
})

test("todo marks and the done count", () => {
  expect(todoMark("completed")).toEqual({ symbol: "✓", tone: "textMuted" })
  expect(todoMark("in_progress")).toEqual({ symbol: "●", tone: "primary" })
  expect(todoMark("pending")).toEqual({ symbol: "○", tone: "textDim" })
  expect(todoCount([{ status: "completed" }, { status: "in_progress" }, { status: "pending" }])).toBe("1/3")
})

test("services list each LSP, count connected MCP servers and name the ones that are down", () => {
  expect(services([], {})).toBeUndefined()
  expect(services([], { off: { status: "disabled" } })).toBeUndefined()
  expect(
    services([{ id: "typescript", status: "connected" }], {
      b: { status: "connected" },
      a: { status: "failed" },
      c: { status: "needs_auth" },
      d: { status: "disabled" },
    }),
  ).toEqual({ lsp: [{ id: "typescript", ok: true }], mcpConnected: 1, mcpFailed: ["a", "c"] })
  expect(services([{ id: "pyright", status: "error" }], {})).toEqual({
    lsp: [{ id: "pyright", ok: false }],
    mcpConnected: undefined,
    mcpFailed: [],
  })
})
