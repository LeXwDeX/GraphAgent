// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Goal, Message } from "@graphagent/sdk"
import { afterEach, describe, expect, test } from "bun:test"
import type { TaskIndexEntry } from "../../../src/context/session-summary"
import { setLanguage } from "../../../src/i18n"
import {
  BACKGROUND_ROWS_MAX,
  DRAWER_TEXT_CELLS,
  backgroundRunLine,
  backgroundSection,
  contextBarCells,
  contextTone,
  contextUsage,
  costText,
  goalLine,
  sameBackgroundSection,
  services,
  todoCount,
  todoMark,
  type BackgroundRunRow,
} from "../../../src/routes/session/drawer-model"
import { backgroundItems, type BackgroundItem } from "../../../src/session/background"
import { DRAWER_WIDTH } from "../../../src/shell/drawer"
import { cellWidth, type AmbiguousWidth } from "../../../src/ui/width"

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

describe("the background section", () => {
  const ROOT = "ses_root"
  const entry = (extra: Partial<TaskIndexEntry> = {}): TaskIndexEntry => ({
    parentSessionID: ROOT,
    parentMessageID: "msg",
    partID: "prt",
    kind: "explore",
    description: "Scan",
    background: true,
    startedAt: 1_000,
    ...extra,
  })

  /** `count` runs under the root: the first `running` of them are busy, the rest wait for a slot. */
  function runs(count: number, running = count) {
    const taskIndex: Record<string, TaskIndexEntry> = {}
    const jobs: Record<string, { value: string }> = {}
    const summaries: Record<string, { status: "busy"; toolCalls: number }> = {}
    for (let index = 0; index < count; index++) {
      const id = `ses_run_${index}`
      taskIndex[id] = entry({ description: `Run ${index}`, startedAt: 10_000 + index })
      jobs[id] = { value: "running" }
      if (index < running) summaries[id] = { status: "busy", toolCalls: 2 }
    }
    return backgroundItems({ taskIndex, rootID: ROOT, job: (id) => jobs[id], summary: (id) => summaries[id] })
  }
  const none = () => undefined

  test("is hidden while no run is going", () => {
    expect(backgroundSection(runs(0), none)).toBeUndefined()
  })

  test(`lists ${BACKGROUND_ROWS_MAX} runs at most, running first and newest first, and counts the rest`, () => {
    const section = backgroundSection(runs(5, 3), none)
    expect(section?.total).toBe(5)
    expect(section?.more).toBe(2)
    expect(section?.rows.map((row) => [row.description, row.marker])).toEqual([
      ["Run 2", "running"],
      ["Run 1", "running"],
      ["Run 0", "running"],
    ])
    const mixed = backgroundSection(runs(5, 1), none)
    expect(mixed?.rows.map((row) => [row.description, row.marker])).toEqual([
      ["Run 0", "running"],
      ["Run 4", "queued"],
      ["Run 3", "queued"],
    ])
    expect(mixed?.more).toBe(2)
  })

  test("lists every run, and counts none beyond, when there are three or fewer", () => {
    const section = backgroundSection(runs(3, 1), none)
    expect(section?.rows).toHaveLength(3)
    expect(section?.more).toBe(0)
    expect(backgroundSection(runs(1), none)?.rows).toHaveLength(1)
  })

  test("needs the clock only while a listed run is running", () => {
    expect(backgroundSection(runs(2, 2), none)?.running).toBe(true)
    expect(backgroundSection(runs(3, 1), none)?.running).toBe(true)
    expect(backgroundSection(runs(2, 0), none)?.running).toBe(false)
  })

  test("names a run as /agents does: the child session's agent, the Task's description", () => {
    const section = backgroundSection(runs(1), () => ({ title: "t", agent: "review" }))
    expect(section?.rows[0]).toMatchObject({ kind: "review", description: "Run 0" })
  })

  test("equals itself while a run only reports progress, and differs when a row, a name or a count moves", () => {
    const base = backgroundSection(runs(4, 2), none)
    expect(sameBackgroundSection(base, backgroundSection(runs(4, 2), none))).toBe(true)
    expect(sameBackgroundSection(base, backgroundSection(runs(4, 3), none))).toBe(false)
    expect(sameBackgroundSection(base, backgroundSection(runs(5, 2), none))).toBe(false)
    expect(
      sameBackgroundSection(
        base,
        backgroundSection(runs(4, 2), () => ({ title: "t", agent: "x" })),
      ),
    ).toBe(false)
    expect(sameBackgroundSection(base, undefined)).toBe(false)
    expect(sameBackgroundSection(undefined, undefined)).toBe(true)
  })

  test("has the text a line of the drawer has: its width less the paddings and the scrollbar's column", () => {
    expect(DRAWER_TEXT_CELLS).toBe(DRAWER_WIDTH - 6)
  })
})

describe("a line of the background section", () => {
  const NOW = 200_000
  const item = (extra: Partial<TaskIndexEntry> = {}, status: "running" | "queued" = "running"): BackgroundItem => ({
    sessionID: "ses_run",
    status,
    entry: {
      parentSessionID: "ses_root",
      parentMessageID: "msg",
      partID: "prt",
      startedAt: NOW - 134_000,
      ...extra,
    },
  })
  const row = (
    kind: string,
    description: string,
    marker: "running" | "queued" = "running",
    extra = {},
  ): BackgroundRunRow => ({
    item: item(extra, marker),
    marker,
    kind,
    description,
  })

  test("marks a running run `●` and a queued one `○`, in the running and the queued tokens, and writes the name", () => {
    const running = backgroundRunLine(row("review", "未提交改动"), NOW, 34)
    expect(running.marker).toBe("● ")
    expect(running.token).toBe("statusRunning")
    expect(running.text).toBe("review · 未提交改动")
    const queued = backgroundRunLine(row("explore", "扫描依赖", "queued"), NOW, 34)
    expect(queued.marker).toBe("○ ")
    expect(queued.token).toBe("statusQueued")
    expect(queued.text).toBe("explore · 扫描依赖")
  })

  test("shows how long a running run has run, at the right edge, in seconds and minutes", () => {
    const line = backgroundRunLine(row("review", "未提交改动"), NOW, 34)
    expect(line.time).toBe("2m 14s")
    expect(cellWidth(line.marker + line.text + line.pad + line.time)).toBe(34)
    expect(backgroundRunLine(row("review", "x", "running", { startedAt: NOW - 58_000 }), NOW, 34).time).toBe("58s")
    expect(backgroundRunLine(row("review", "x", "running", { startedAt: NOW }), NOW, 34).time).toBe("0s")
    // A clock behind the start reads as nothing yet, not a negative time.
    expect(backgroundRunLine(row("review", "x", "running", { startedAt: NOW + 5_000 }), NOW, 34).time).toBe("0s")
  })

  test("shows no time for a queued run, nor for a run whose start is not known", () => {
    const queued = backgroundRunLine(row("explore", "扫描依赖", "queued"), NOW, 34)
    expect(queued.time).toBe("")
    expect(queued.pad).toBe("")
    const unknown = backgroundRunLine(row("review", "x", "running", { startedAt: undefined }), NOW, 34)
    expect(unknown.time).toBe("")
  })

  test("moves with the clock it is given and no other", () => {
    expect(backgroundRunLine(row("review", "x"), NOW + 60_000, 34).time).toBe("3m 14s")
    expect(backgroundRunLine(row("review", "x"), NOW, 34).time).toBe("2m 14s")
  })

  test("cuts the description, not the type, and keeps the time", () => {
    const line = backgroundRunLine(row("review", "把 changelog 里的破坏性变更逐条列出来并给出迁移建议"), NOW, 34)
    expect(line.text.startsWith("review · 把 changelog")).toBe(true)
    expect(line.text.endsWith("…")).toBe(true)
    expect(line.time).toBe("2m 14s")
    expect(cellWidth(line.marker + line.text + line.pad + line.time)).toBeLessThanOrEqual(34)
  })

  test("writes a run without a description as its type", () => {
    expect(backgroundRunLine(row("review", ""), NOW, 34).text).toBe("review")
  })

  for (const aw of [1, 2] as const satisfies readonly AmbiguousWidth[]) {
    test(`never claims more cells than the width, at every width, at ambiguous width ${aw}`, () => {
      const rows = [
        row("review", "未提交改动"),
        row("explore", "Review the uncommitted changes carefully and report", "queued"),
        row("a-very-long-agent-type-from-the-config-file", "短"),
        row("review", "x".repeat(200), "running", { startedAt: NOW - 3_700_000 }),
        row("review", ""),
      ]
      for (const line of rows) {
        for (let width = 0; width <= 80; width++) {
          const drawn = backgroundRunLine(line, NOW, width, aw)
          const cells = cellWidth(drawn.marker + drawn.text + drawn.pad + drawn.time, aw)
          // The marker and its space come first whatever the width: below that nothing is drawn well anyway.
          expect(cells, `${line.kind} at ${width}`).toBeLessThanOrEqual(Math.max(width, cellWidth(drawn.marker, aw)))
        }
      }
    })
  }
})
