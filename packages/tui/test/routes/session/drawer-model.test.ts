// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Goal, Message, Session, SessionOverhead, SessionUsage } from "@graphagent/sdk"
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
  goalLine,
  OVERHEAD_ROWS_MAX,
  overheadSection,
  sameBackgroundSection,
  services,
  todoCount,
  todoMark,
  usageLines,
  type BackgroundRunRow,
} from "../../../src/routes/session/drawer-model"
import { backgroundItems, type BackgroundItem } from "../../../src/session/background"
import { DRAWER_WIDTH } from "../../../src/shell/drawer"
import { DRAWER_INSET, DRAWER_SCROLL_GAP, SCROLLBAR_CELLS } from "../../../src/ui/layout"
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

test("a model that declares no window is measured against the default one and marked as estimated", () => {
  const messages = [assistant(10, { input: 1000 })]
  const modelOf = (model: Parameters<typeof contextUsage>[1][number]["models"][string]) => [
    { id: "test", models: { big: model } },
  ]
  expect(contextUsage(messages, modelOf({ limit: { context: 0 }, profile: { sources: {} } }))).toEqual({
    used: 1010,
    limit: 128_000,
    percent: 1,
    estimated: true,
  })
  // A window the profile declares is not an estimate: the key is absent, not false.
  const declared = contextUsage(
    messages,
    modelOf({ limit: { context: 200_000 }, profile: { context: 200_000, sources: { context: "catalog" } } }),
  )
  expect(declared).toEqual({ used: 1010, limit: 200_000, percent: 1 })
  expect(declared).not.toHaveProperty("estimated")
  // The effective window the user set limits the window; it is the user's figure, not an estimate.
  expect(
    contextUsage(
      messages,
      modelOf({
        limit: { context: 200_000 },
        profile: { context: 200_000, effectiveContext: 100_000, sources: { context: "catalog" } },
      }),
    ),
  ).toEqual({ used: 1010, limit: 100_000, percent: 1 })
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

// ── The cost section (#1475) ─────────────────────────────────────────────────────

type Tokens = Required<Session>["tokens"]

function tokens(input = 0, output = 0, reasoning = 0, read = 0, write = 0): Tokens {
  return { input, output, reasoning, cache: { read, write } }
}

function usage(extra: Partial<SessionUsage> = {}): SessionUsage {
  return { rootID: "ses_root", sessions: 3, cost: 0, costUnknown: false, tokens: tokens(), ...extra }
}

describe("the cost section's lines", () => {
  test("are a dash and nothing else before the usage is read, on a sub-agent's screen too", () => {
    expect(usageLines(undefined, undefined, false)).toEqual(["—"])
    expect(usageLines(undefined, { cost: 0.25, tokens: tokens(10) }, true)).toEqual(["—"])
  })

  test("are the tree's cost, then its tokens by kind", () => {
    const lines = usageLines(
      usage({ cost: 1.5, tokens: tokens(12_345, 3_400, 800, 1_200_000, 30_000) }),
      undefined,
      false,
    )
    expect(lines).toEqual(["$1.50", "输入 12K · 输出 3.4K", "推理 800", "缓存 读 1.2M · 写 30K"])
  })

  test("say the same in English", () => {
    setLanguage("en")
    const lines = usageLines(
      usage({ cost: 1.5, tokens: tokens(12_345, 3_400, 800, 1_200_000, 30_000) }),
      undefined,
      false,
    )
    expect(lines).toEqual(["$1.50", "In 12K · Out 3.4K", "Reasoning 800", "Cache r 1.2M · w 30K"])
    expect(usageLines(usage(), { cost: 0.25, tokens: tokens(1) }, true).at(-1)).toBe("This session $0.25")
  })

  // The tree's cost line, by what the server summed (`costLabel`): a fraction of a cent keeps its digits (B1), a cost
  // never reads as zero when it is not, and a part that has no price is named, never counted as free.
  for (const [language, unknown] of [
    ["zh-CN", "未知"],
    ["en", "unknown"],
  ] as const) {
    test(`write the tree's cost by what is known of it, ${language}`, () => {
      setLanguage(language)
      const cost = (extra: Partial<SessionUsage>) => usageLines(usage(extra), undefined, false)[0]
      expect(cost({ cost: 0 })).toBe("$0.00")
      expect(cost({ cost: 1.234 })).toBe("$1.23")
      expect(cost({ cost: 0.0027 })).toBe("$0.0027")
      expect(cost({ cost: 0.00001 })).toBe("<$0.0001")
      expect(cost({ cost: 0.01 })).toBe("$0.01")
      expect(cost({ cost: 1234.5 })).toBe("$1,234.50")
      expect(cost({ cost: 0, costUnknown: true })).toBe(unknown)
      expect(cost({ cost: 1.5, costUnknown: true })).toBe(`$1.50 + ${unknown}`)
      expect(cost({ cost: 0.0027, costUnknown: true })).toBe(`$0.0027 + ${unknown}`)
    })
  }

  test("add the session's own cost last on a sub-agent's screen, and only there", () => {
    const tree = usage({ cost: 1.75, tokens: tokens(100, 50) })
    const own = { cost: 0.25, tokens: tokens(10, 5) }
    expect(usageLines(tree, own, true)).toEqual([
      "$1.75",
      "输入 100 · 输出 50",
      "推理 0",
      "缓存 读 0 · 写 0",
      "本会话 $0.25",
    ])
    expect(usageLines(tree, own, false)).toHaveLength(4)
    expect(usageLines(tree, own, false).some((line) => line.includes("本会话"))).toBe(false)
  })

  test("judge the session's own cost by its own tokens: tokens at no cost are unknown, nothing used is zero", () => {
    const tree = usage({ cost: 1.75 })
    const own = (value: Pick<Session, "cost" | "tokens"> | undefined) => usageLines(tree, value, true).at(-1)
    expect(own({ cost: 0, tokens: tokens(10) })).toBe("本会话 未知")
    expect(own({ cost: 0, tokens: tokens(0, 0, 0, 0, 1) })).toBe("本会话 未知")
    expect(own({ cost: 0, tokens: tokens() })).toBe("本会话 $0.00")
    expect(own({ cost: 0 })).toBe("本会话 $0.00")
    expect(own({ tokens: tokens(10) })).toBe("本会话 未知")
    expect(own({ cost: 0.0027, tokens: tokens(10) })).toBe("本会话 $0.0027")
    expect(own(undefined)).toBe("本会话 $0.00")
  })

  test("keep every line to the drawer's text width, whatever the numbers and the language", () => {
    const worst = usage({
      cost: 1_234_567.89,
      costUnknown: true,
      tokens: tokens(999_999_999_999, 999_999_999_999, 999_999_999_999, 999_999_999_999, 999_999_999_999),
    })
    const own = { cost: 1e15, tokens: tokens(1) }
    for (const language of ["zh-CN", "en"] as const) {
      for (const aw of [1, 2] as const) {
        setLanguage(language)
        for (const line of usageLines(worst, own, true, aw)) {
          expect(cellWidth(line, aw)).toBeLessThanOrEqual(DRAWER_TEXT_CELLS)
        }
        for (const line of usageLines(
          usage({ cost: 12.5, tokens: tokens(123, 456, 789, 1_234, 5_678) }),
          own,
          true,
          aw,
        )) {
          expect(cellWidth(line, aw)).toBeLessThanOrEqual(DRAWER_TEXT_CELLS)
        }
      }
    }
  })

  test("cut a line that does not fit with an ellipsis", () => {
    setLanguage("en")
    // A figure no session reaches, but the section does not trust the server's numbers to be small.
    const last = usageLines(usage(), { cost: 1e15, tokens: tokens(1) }, true).at(-1) ?? ""
    expect(last.startsWith("This session $1,000,000")).toBe(true)
    expect(last.endsWith("…")).toBe(true)
    expect(cellWidth(last, 1)).toBeLessThanOrEqual(DRAWER_TEXT_CELLS)
  })
})

// ── The fixed-overhead section (#1461) ──────────────────────────────────────────────

type OverheadSource = SessionOverhead["sources"][number]

function source(name: OverheadSource["source"], tokens: number, label?: string): OverheadSource {
  return {
    source: name,
    bytes: tokens * 3,
    tokens,
    hash: "0123456789abcdef",
    ...(label === undefined ? {} : { label }),
  }
}

function overhead(extra: Partial<SessionOverhead> = {}): SessionOverhead {
  return { bytes: 0, tokens: 0, sources: [], ...extra }
}

describe("the fixed-overhead section", () => {
  test("is hidden until the server reports an overhead: nothing held, or nothing sent yet", () => {
    expect(overheadSection(undefined)).toBeUndefined()
    expect(overheadSection(overhead())).toBeUndefined()
    // Zero tokens is zero: sources that add up to nothing are not shown either.
    expect(overheadSection(overhead({ sources: [source("base", 0)] }))).toBeUndefined()
  })

  test("is the total with its share of the window, and the largest sources, largest first", () => {
    const section = overheadSection(
      overhead({
        bytes: 40_000,
        tokens: 12_345,
        window: 100_000,
        windowSource: "config",
        ratio: 0.12345,
        sources: [
          source("environment", 150),
          source("tools", 8_000),
          source("base", 2_000),
          source("instructions", 1_200, "AGENTS.md"),
        ],
      }),
    )
    expect(section).toEqual({
      total: "≈12,345 tokens · 12%",
      rows: ["≈8,000 tools", "≈2,000 base", "≈1,200 instructions AGENTS.md", "≈150 environment"],
    })
  })

  test("says the same in English", () => {
    setLanguage("en")
    expect(overheadSection(overhead({ tokens: 12_345, ratio: 0.12345, sources: [source("tools", 12_345)] }))).toEqual({
      total: "≈12,345 tokens · 12%",
      rows: ["≈12,345 tools"],
    })
  })

  test("marks the share with a ~ when the window is the assumed one, and only then", () => {
    const sources = [source("tools", 40_000)]
    const total = (windowSource: string | undefined) =>
      overheadSection(overhead({ tokens: 40_000, window: 128_000, windowSource, ratio: 0.3125, sources }))?.total
    expect(total("default")).toBe("≈40,000 tokens · ~31%")
    expect(total("adapter")).toBe("≈40,000 tokens · 31%")
    expect(total("config")).toBe("≈40,000 tokens · 31%")
    expect(total(undefined)).toBe("≈40,000 tokens · 31%")
  })

  test("rounds the share to a whole percentage, and reads a missing one as 0%", () => {
    const total = (ratio: number | undefined) => overheadSection(overhead({ tokens: 500, ratio }))?.total
    expect(total(0.2549)).toBe("≈500 tokens · 25%")
    expect(total(0.2551)).toBe("≈500 tokens · 26%")
    expect(total(1.5)).toBe("≈500 tokens · 150%")
    expect(total(undefined)).toBe("≈500 tokens · 0%")
  })

  test("writes the figures with thousands separators in every language", () => {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguage(language)
      const section = overheadSection(
        overhead({ tokens: 1_234_567, ratio: 0.5, sources: [source("tools", 1_234_567)] }),
      )
      expect(section?.total).toBe("≈1,234,567 tokens · 50%")
      expect(section?.rows).toEqual(["≈1,234,567 tools"])
    }
  })

  test("lists at most five sources, the largest, and keeps the server's order among equals", () => {
    const names = ["environment", "language", "instructions", "skills", "hooks", "dag", "tools"] as const
    const section = overheadSection(
      overhead({ tokens: 100, ratio: 0.1, sources: names.map((name, index) => source(name, index === 6 ? 90 : 10)) }),
    )
    expect(OVERHEAD_ROWS_MAX).toBe(5)
    expect(section?.rows).toEqual(["≈90 tools", "≈10 environment", "≈10 language", "≈10 instructions", "≈10 skills"])
  })

  test("does not touch the list the store holds", () => {
    const sources = [source("environment", 1), source("tools", 9)]
    const info = overhead({ tokens: 10, ratio: 0.1, sources })
    overheadSection(info)
    expect(info.sources.map((item) => item.source)).toEqual(["environment", "tools"])
  })

  test("names a source without a label by its source alone, no trailing space", () => {
    const section = overheadSection(overhead({ tokens: 5, ratio: 0.1, sources: [source("runtime_context", 5)] }))
    expect(section?.rows).toEqual(["≈5 runtime_context"])
  })

  test("takes a label as one clean line: escapes and line breaks of a remote text do not reach the screen", () => {
    const label = "/r/\u001b[31mA\u001b[0m.md\nb\u0007"
    const section = overheadSection(overhead({ tokens: 5, ratio: 0.1, sources: [source("instructions", 5, label)] }))
    expect(section?.rows).toEqual(["≈5 instructions /r/A.md b"])
  })

  test("cuts a row that does not fit, with an ellipsis, in the width the user's terminal gives it", () => {
    const long = `https://example.invalid/${"rules/".repeat(30)}AGENTS.md`
    for (const aw of [1, 2] as const) {
      const section = overheadSection(
        overhead({ tokens: 5, ratio: 0.1, sources: [source("instructions", 5, long)] }),
        aw,
      )
      const [row] = section!.rows
      expect(row.startsWith("≈5 instructions https://ex")).toBe(true)
      expect(row.endsWith("…")).toBe(true)
      expect(cellWidth(row, aw)).toBeLessThanOrEqual(DRAWER_TEXT_CELLS)
    }
  })

  test("keeps every line to the drawer's text width, whatever the numbers and the language", () => {
    const worstSources: OverheadSource["source"][] = ["base", "tools", "instructions", "environment", "skills", "hooks"]
    const worst = overhead({
      tokens: 999_999_999_999,
      ratio: 99_999.9,
      window: 128_000,
      windowSource: "default",
      sources: worstSources.map((name) => source(name, 999_999_999_999, "/very/long/path/".repeat(8))),
    })
    for (const language of ["zh-CN", "en"] as const) {
      for (const aw of [1, 2] as const) {
        setLanguage(language)
        const section = overheadSection(worst, aw)!
        for (const line of [section.total, ...section.rows]) {
          expect(cellWidth(line, aw)).toBeLessThanOrEqual(DRAWER_TEXT_CELLS)
        }
      }
    }
  })
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
    // Worked out from the tokens the view pads with, so that the model and the drawer do not part.
    expect(DRAWER_TEXT_CELLS).toBe(DRAWER_WIDTH - 2 * DRAWER_INSET - DRAWER_SCROLL_GAP - SCROLLBAR_CELLS)
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
