// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { getLanguage, setLanguage } from "@graphagent/tui/i18n"
import {
  aggregateSessionStats,
  displayStats,
  latestRoots,
  rootLimitOf,
  type RootUsageRow,
  type SessionStats,
} from "@/cli/cmd/stats"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const originalLanguage = getLanguage()
beforeEach(() => setLanguage("en"))
afterAll(() => setLanguage(originalLanguage))

/** What `displayStats` prints, one entry per line. */
function render(stats: SessionStats, toolLimit?: number, modelLimit?: number) {
  const lines: string[] = []
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "))
  })
  // The model block moves the cursor up one line; the terminal control code has no place in the capture.
  const write = spyOn(process.stdout, "write").mockImplementation(() => true)
  try {
    displayStats(stats, toolLimit, modelLimit)
  } finally {
    log.mockRestore()
    write.mockRestore()
  }
  return lines
}

function emptyStats(): SessionStats {
  return {
    totalSessions: 0,
    totalMessages: 0,
    totalCost: 0,
    costUnknown: false,
    totalTokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    toolUsage: {},
    modelUsage: {},
    dateRange: { earliest: 0, latest: 0 },
    days: 1,
    costPerDay: 0,
    tokensPerSession: 0,
    medianTokensPerSession: 0,
  }
}

/** The value printed on the row that starts with `label` (`│Label      value │`). */
function valueOf(lines: readonly string[], label: string) {
  const line = lines.find((item) => item.startsWith(`│${label}`))
  if (!line) throw new Error(`no row starts with "${label}"`)
  return line.slice(1 + label.length, -1).trim()
}

const BOX_LINE = 58 // 56 columns inside two borders

function expectBoxed(lines: readonly string[]) {
  for (const line of lines.filter((item) => item !== ""))
    expect([line, Bun.stringWidth(line)]).toEqual([line, BOX_LINE])
}

describe("stats --roots option", () => {
  test("alone it shows the default count, with a number that many", () => {
    expect(rootLimitOf(true)).toBe(10)
    expect(rootLimitOf(3)).toBe(3)
    expect(rootLimitOf(2.9)).toBe(2)
  })

  test("absent, or not a positive count, it shows none", () => {
    expect(rootLimitOf(undefined)).toBeUndefined()
    expect(rootLimitOf(false)).toBeUndefined()
    expect(rootLimitOf(0)).toBeUndefined()
    expect(rootLimitOf(-2)).toBeUndefined()
    expect(rootLimitOf(Number.NaN)).toBeUndefined()
    expect(rootLimitOf("many")).toBeUndefined()
  })

  test("the latest roots are the most recently updated sessions without a parent", () => {
    const sessions = [
      { id: "a", time: { updated: 10 } },
      { id: "child", parentID: "a", time: { updated: 99 } },
      { id: "b", time: { updated: 30 } },
      { id: "c", time: { updated: 20 } },
    ]
    expect(latestRoots(sessions, 2).map((item) => item.id)).toEqual(["b", "c"])
    expect(latestRoots(sessions, 10).map((item) => item.id)).toEqual(["b", "c", "a"])
    // The input is left as it was.
    expect(sessions.map((item) => item.id)).toEqual(["a", "child", "b", "c"])
  })
})

describe("stats rows", () => {
  test("reasoning has its own row in the overview and in each model block, and output does not carry it", () => {
    const stats = emptyStats()
    stats.totalTokens = { input: 1000, output: 2000, reasoning: 3000, cache: { read: 4000, write: 5000 } }
    stats.modelUsage = {
      "p/m": {
        messages: 2,
        tokens: { input: 100, output: 200, reasoning: 300, cache: { read: 400, write: 500 } },
        cost: 1,
      },
    }
    const lines = render(stats, undefined, 5)

    expect(valueOf(lines, "Output")).toBe("2.0K")
    expect(valueOf(lines, "Reasoning")).toBe("3.0K")
    expect(valueOf(lines, "  Output Tokens")).toBe("200")
    expect(valueOf(lines, "  Reasoning")).toBe("300")
    expectBoxed(lines)
  })

  test("the labels follow the language", () => {
    setLanguage("zh-CN")
    const stats = emptyStats()
    stats.totalTokens.reasoning = 3000
    const lines = render(stats)
    expect(valueOf(lines, "推理")).toBe("3.0K")
  })

  test("a total under a cent keeps its digits (B1)", () => {
    const stats = emptyStats()
    stats.totalCost = 0.0027
    stats.costPerDay = 0.00001
    const lines = render(stats)
    expect(valueOf(lines, "Total Cost")).toBe("$0.0027")
    expect(valueOf(lines, "Avg Cost/Day")).toBe("<$0.0001")
  })

  test("an unpriced session is called unknown, next to the priced part when there is one", () => {
    const stats = emptyStats()
    stats.costUnknown = true
    expect(valueOf(render(stats), "Total Cost")).toBe("unknown")

    stats.totalCost = 1.5
    expect(valueOf(render(stats), "Total Cost")).toBe("$1.50 + unknown")

    setLanguage("zh-CN")
    expect(valueOf(render(stats), "总费用")).toBe("$1.50 + 未知")
  })

  test("a model that recorded tokens at zero cost reads unknown, one with a price its cost, an idle one $0.00", () => {
    const stats = emptyStats()
    stats.modelUsage = {
      "p/free": { messages: 1, tokens: { input: 5, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
      "p/paid": {
        messages: 1,
        tokens: { input: 5, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0.0027,
      },
      "p/idle": { messages: 1, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
    }
    const lines = render(stats, undefined, 5)
    const costs = lines.filter((line) => line.startsWith("│  Cost")).map((line) => line.slice(7, -1).trim())
    expect(costs).toEqual(["unknown", "$0.0027", "$0.00"])
  })
})

describe("stats --roots block", () => {
  const row = (patch: Partial<RootUsageRow> = {}): RootUsageRow => ({
    title: "Fix login bug",
    sessions: 3,
    tokens: 123_400,
    cost: 1.5,
    costUnknown: false,
    ...patch,
  })

  test("is left out unless roots were asked for, and when there are none", () => {
    expect(render(emptyStats()).join("\n")).not.toContain("ROOT SESSIONS")
    const stats = emptyStats()
    stats.roots = []
    expect(render(stats).join("\n")).not.toContain("ROOT SESSIONS")
  })

  test("a row is the title, the session count, the tokens and the cost in fixed columns", () => {
    const stats = emptyStats()
    stats.roots = [row()]
    const lines = render(stats)
    const title = lines.findIndex((line) => line.includes("ROOT SESSIONS (sessions · tokens · cost)"))
    expect(title).toBeGreaterThan(0)
    expect(lines[title - 1]).toBe("┌────────────────────────────────────────────────────────┐")
    expect(lines[title + 1]).toBe("├────────────────────────────────────────────────────────┤")
    // Title 24, sessions 4, tokens 7, cost 11, a space between the columns and against each border.
    const columns = ["Fix login bug".padEnd(24), "3".padStart(4), "123.4K".padStart(7), "$1.50".padStart(11)]
    expect(lines[title + 2]).toBe(`│ ${columns.join(" ").padEnd(54)} │`)
    expect(lines[title + 3]).toBe("└────────────────────────────────────────────────────────┘")
  })

  test("an unknown part follows the cost, or stands alone", () => {
    const stats = emptyStats()
    stats.roots = [row({ costUnknown: true }), row({ cost: 0, costUnknown: true, title: "Free" })]
    const rows = render(stats).filter((line) => line.includes("123.4K"))
    expect(rows[0]).toContain("$1.50 + unknown")
    expect(rows[1]).toContain("unknown")
    expect(rows[1]).not.toContain("$")
  })

  test("never outgrows the box, in either language, whatever the title and the numbers", () => {
    const awkward: RootUsageRow[] = [
      row(),
      row({ title: "A very long title that cannot possibly fit into its column of twenty-four" }),
      row({ title: "修复登录页面在移动端无法提交表单的问题并补充回归测试" }),
      row({ title: "混合 mixed 标题 with emoji 🚀🚀🚀 and more words after" }),
      row({ title: "line one\nline two\ttabbed" }),
      row({ title: "" }),
      row({ sessions: 12_345, tokens: 987_654_321, cost: 1_234_567.891, costUnknown: true }),
      row({ cost: 0.00001 }),
    ]
    for (const language of ["en", "zh-CN"] as const) {
      setLanguage(language)
      const stats = emptyStats()
      stats.roots = awkward
      const lines = render(stats)
      const start = lines.findIndex((line) => line.startsWith("┌")) // the overview
      expect(start).toBe(0)
      expectBoxed(lines)
    }
  })

  test("a title is cut by display width, not by characters", () => {
    const stats = emptyStats()
    stats.roots = [row({ title: "修复登录页面在移动端无法提交表单的问题" })]
    const body = render(stats).find((line) => line.includes("123.4K")) ?? ""
    const titleColumn = body.slice(2, body.indexOf("  "))
    expect(Bun.stringWidth(titleColumn)).toBeLessThanOrEqual(24)
    expect(titleColumn.endsWith("…")).toBe(true)
  })

  test("is titled in Chinese when the language is", () => {
    setLanguage("zh-CN")
    const stats = emptyStats()
    stats.roots = [row()]
    expect(render(stats).join("\n")).toContain("根会话用量（会话数 · token · 费用）")
  })
})

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const providerID = ProviderV2.ID.make("test")
const modelID = ModelV2.ID.make("test-model")

interface Step {
  cost: number
  input: number
  output: number
  reasoning: number
}

/** A user message, the assistant's reply and its step-finish part: the path that writes a session's usage. */
const seedStep = (sessionID: SessionID, step: Step) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const tokens = { input: step.input, output: step.output, reasoning: step.reasoning, cache: { read: 0, write: 0 } }
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      agent: "build",
      model: { providerID, modelID },
      time: { created: 1 },
    })
    const assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      role: "assistant",
      parentID: user.id,
      time: { created: 2 },
      agent: "build",
      modelID,
      providerID,
      mode: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: step.cost,
      tokens,
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: assistant.id,
      type: "step-finish",
      reason: "stop",
      cost: step.cost,
      tokens,
    })
  })

describe("stats aggregation", () => {
  it.instance("keeps reasoning out of each model's output and out of the cost unknown flag when priced", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "priced" })
      yield* seedStep(root.id, { cost: 0.5, input: 100, output: 40, reasoning: 25 })

      const stats = yield* aggregateSessionStats()
      expect(stats.modelUsage["test/test-model"]?.tokens).toEqual({
        input: 100,
        output: 40,
        reasoning: 25,
        cache: { read: 0, write: 0 },
      })
      expect(stats.totalTokens.reasoning).toBe(25)
      expect(stats.costUnknown).toBe(false)
      expect(stats.roots).toBeUndefined()
    }),
  )

  it.instance("flags a session that recorded tokens at zero cost", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "unpriced" })
      yield* seedStep(root.id, { cost: 0, input: 10, output: 4, reasoning: 0 })

      const stats = yield* aggregateSessionStats()
      expect(stats.costUnknown).toBe(true)
      expect(stats.modelUsage["test/test-model"]?.cost).toBe(0)
    }),
  )

  it.instance("--roots sums each root's whole tree, children and grandchildren included", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root task" })
      const child = yield* sessions.create({ title: "Task child", parentID: root.id })
      const grandchild = yield* sessions.create({ title: "Grandchild", parentID: child.id })
      const stranger = yield* sessions.create({ title: "Unrelated" })
      yield* seedStep(root.id, { cost: 0.5, input: 100, output: 40, reasoning: 25 })
      yield* seedStep(child.id, { cost: 0.25, input: 10, output: 4, reasoning: 6 })
      yield* seedStep(grandchild.id, { cost: 0, input: 3, output: 0, reasoning: 0 })
      yield* seedStep(stranger.id, { cost: 2, input: 1, output: 1, reasoning: 0 })

      const stats = yield* aggregateSessionStats(undefined, undefined, undefined, 10)
      const roots = stats.roots ?? []
      expect(roots.map((item) => item.title).sort()).toEqual(["Root task", "Unrelated"])
      expect(roots.find((item) => item.title === "Root task")).toEqual({
        title: "Root task",
        sessions: 3,
        tokens: 100 + 40 + 25 + 10 + 4 + 6 + 3,
        cost: 0.75,
        costUnknown: true,
      })
      expect(roots.find((item) => item.title === "Unrelated")).toEqual({
        title: "Unrelated",
        sessions: 1,
        tokens: 2,
        cost: 2,
        costUnknown: false,
      })
      // The overview still counts every session row; only the roots block folds the trees.
      expect(stats.totalSessions).toBe(4)
    }),
  )

  it.instance("--roots N keeps the N most recently updated roots", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      yield* sessions.create({ title: "first" })
      yield* sessions.create({ title: "second" })
      yield* sessions.create({ title: "third" })

      expect(((yield* aggregateSessionStats(undefined, undefined, undefined, 2)).roots ?? []).length).toBe(2)
      expect(((yield* aggregateSessionStats(undefined, undefined, undefined, 1)).roots ?? []).length).toBe(1)
    }),
  )
})
