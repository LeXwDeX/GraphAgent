// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Only the project id of `Project.Info` is read by the stats filter.

import { afterEach, describe, expect, spyOn } from "bun:test"
import { Effect } from "effect"
import { Database } from "@graphagent/core/database/database"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionStepTable, ToolOutcomeTable } from "@graphagent/core/session/outcome.sql"
import { MessageTable, PartTable, SessionTable } from "@graphagent/core/session/sql"
import { Project as CoreProject } from "@graphagent/core/project"
import { AbsolutePath } from "@graphagent/core/schema"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionV1 } from "@graphagent/core/v1/session"
import type { ToolOutcomeKind } from "@graphagent/core/session/outcome"
import { SessionID } from "@graphagent/schema/session-id"
import { setLanguage } from "@graphagent/tui/i18n"
import type { Project } from "@/project/project"
import { displayStats } from "../../src/cli/cmd/stats"
import {
  modelStepRows,
  outcomeLimit,
  queryModelSteps,
  queryOutcomes,
  renderOutcomes,
  type ModelSteps,
  type OutcomeRow,
} from "../../src/cli/cmd/stats-outcomes"
import { testEffect } from "../lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))

afterEach(() => setLanguage("en"))

const row = (tool: string, outcome: string, count: number, extra: Partial<OutcomeRow> = {}): OutcomeRow => ({
  providerID: "anthropic",
  modelID: "claude-sonnet-5-5",
  tool,
  outcome,
  truncated: false,
  corrections: [],
  count,
  ...extra,
})

/** The text between the box borders of one printed line. */
const inner = (line: string) => line.slice(1, -1)

describe("renderOutcomes", () => {
  const rows = [
    row("edit", "ok", 90),
    row("edit", "ok", 4, { corrections: ["fuzzy_match"] }),
    row("edit", "ok", 2, { corrections: ["args_repaired", "fuzzy_match"] }),
    row("edit", "validation_error", 5),
    row("edit", "execution_error", 1),
    row("bash", "ok", 997),
    row("bash", "ok", 3, { truncated: true }),
    row("a_very_long_tool_name_indeed", "denied", 2),
    row("read", "aborted", 1),
    row("write", "arguments_truncated", 1),
  ]

  it.effect("prints one block per model: model line, tool table, corrections table", () =>
    Effect.sync(() => {
      const lines = renderOutcomes(rows, Infinity)
      expect(lines[0]).toBe(`┌${"─".repeat(56)}┐`)
      expect(inner(lines[1]).trim()).toBe("TOOL OUTCOMES")
      expect(lines[2]).toBe(`├${"─".repeat(56)}┤`)
      expect(inner(lines[3])).toBe(` ${"anthropic/claude-sonnet-5-5".padEnd(54)} `)
      expect(inner(lines[4])).toBe(" Tool         Calls  Val Exec Deny Abrt ArgT Corr OutT  ")
      expect(lines.at(-1)).toBe(`└${"─".repeat(56)}┘`)
    }),
  )

  it.effect("shares are of the tool's calls: - for none, <1% under one percent, a rounded percent otherwise", () =>
    Effect.sync(() => {
      const lines = renderOutcomes(rows, Infinity).map(inner)
      // bash: 1000 calls, 3 with truncated output (0.3%).
      expect(lines).toContain(" bash          1000    -    -    -    -    -    -  <1%  ")
      // edit: 102 calls; 5 validation (4.9%), 1 execution (0.98%), 6 corrected (5.9%).
      expect(lines).toContain(" edit           102   5%  <1%    -    -    -   6%    -  ")
      // A long tool name is cut to 12 cells; every call of this tool was denied.
      expect(lines).toContain(" a_very_lon..     2    -    - 100%    -    -    -    -  ")
      expect(lines).toContain(" read             1    -    -    - 100%    -    -    -  ")
      expect(lines).toContain(" write            1    -    -    -    - 100%    -    -  ")
    }),
  )

  it.effect("lists tools by calls then name, and corrections by count then name", () =>
    Effect.sync(() => {
      const text = renderOutcomes(rows, Infinity).map(inner)
      const tools = text
        .filter((line) => /^ (bash|edit|a_very_lon\.\.|read|write) /.test(line))
        .map((line) => line.trim().split(/\s+/)[0])
      expect(tools).toEqual(["bash", "edit", "a_very_lon..", "read", "write"])
      const heading = text.findIndex((line) => line.trim() === "Corrections")
      expect(text[heading + 1]).toBe("   fuzzy_match                                  6   <1% ")
      expect(text[heading + 2]).toBe("   args_repaired                                2   <1% ")
    }),
  )

  it.effect("draws no corrections table for a model without corrections", () =>
    Effect.sync(() => {
      const lines = renderOutcomes([row("read", "ok", 3)], Infinity).map(inner)
      expect(lines.some((line) => line.includes("Corrections"))).toBe(false)
    }),
  )

  it.effect("shows the busiest models first and at most `limit` of them", () =>
    Effect.sync(() => {
      const many = [
        row("edit", "ok", 1, { modelID: "small" }),
        row("edit", "ok", 9, { modelID: "big" }),
        row("edit", "ok", 5, { modelID: "mid" }),
      ]
      const names = (limit: number) =>
        renderOutcomes(many, limit)
          .map(inner)
          .filter((line) => line.startsWith(" anthropic/"))
          .map((line) => line.trim())
      expect(names(Infinity)).toEqual(["anthropic/big", "anthropic/mid", "anthropic/small"])
      expect(names(2)).toEqual(["anthropic/big", "anthropic/mid"])
      expect(renderOutcomes(many, 0)).toEqual([])
    }),
  )

  it.effect("cuts a model name longer than 54 cells to 54 with ..", () =>
    Effect.sync(() => {
      const lines = renderOutcomes([row("edit", "ok", 1, { modelID: "m".repeat(80) })], Infinity).map(inner)
      expect(lines[3]).toBe(` anthropic/${"m".repeat(42)}.. `)
      expect(Bun.stringWidth(lines[3])).toBe(56)
    }),
  )

  for (const language of ["en", "zh-CN"] as const) {
    it.effect(`no printed line is wider than the 56-cell box in ${language}`, () =>
      Effect.sync(() => {
        setLanguage(language)
        const wide = [
          ...rows,
          row("a_tool_with_a_name_much_longer_than_the_column", "ok", 123456),
          row("edit", "ok", 1, {
            corrections: ["a_correction_kind_with_a_really_long_name_that_cannot_fit_in_the_row"],
          }),
          row("read", "ok", 1, { providerID: "p".repeat(40), modelID: "m".repeat(40) }),
        ]
        const lines = renderOutcomes(wide, Infinity)
        expect(lines.length).toBeGreaterThan(10)
        for (const line of lines) expect(Bun.stringWidth(line)).toBe(58)
        for (const line of lines.slice(1).filter((entry) => entry.startsWith("│"))) {
          expect(Bun.stringWidth(inner(line))).toBe(56)
        }
      }),
    )
  }

  it.effect("the Chinese table keeps its columns aligned", () =>
    Effect.sync(() => {
      setLanguage("zh-CN")
      const lines = renderOutcomes([row("edit", "validation_error", 4)], Infinity).map(inner)
      expect(lines[1].trim()).toBe("工具调用结果")
      expect(lines[4]).toBe(" 工具          调用 校验 执行 拒绝 中断 截参 改写 截输  ")
      expect(lines[5]).toBe(" edit             4 100%    -    -    -    -    -    -  ")
    }),
  )

  it.effect("no rows, no output", () => Effect.sync(() => expect(renderOutcomes([], Infinity)).toEqual([])))
})

describe("outcomeLimit", () => {
  it.effect("maps the flag: bare shows every model, a number shows that many, absent shows nothing", () =>
    Effect.sync(() => {
      expect(outcomeLimit(true)).toBe(Infinity)
      expect(outcomeLimit(3)).toBe(3)
      expect(outcomeLimit(undefined)).toBeUndefined()
      expect(outcomeLimit(false)).toBeUndefined()
    }),
  )
})

const DAY = 24 * 60 * 60 * 1000
const projectA = CoreProject.ID.make("project_a")
const projectB = CoreProject.ID.make("project_b")

/** A session of `project` last touched at `updated`, with a user message to hang parts on. */
const seedSession = (
  db: Database.Interface["db"],
  input: { session: string; project: typeof projectA; updated: number },
) =>
  Effect.gen(function* () {
    const sessionID = SessionID.make(input.session)
    const messageID = SessionV1.MessageID.make(`msg_${input.session}`)
    yield* db
      .insert(ProjectTable)
      .values({ id: input.project, worktree: AbsolutePath.make(`/${input.project}`), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: input.project,
        slug: input.session,
        directory: "/project",
        title: "t",
        version: "v",
        time_updated: input.updated,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(MessageTable)
      .values({
        id: messageID,
        session_id: sessionID,
        data: { role: "user", agent: "build", time: { created: 1 } },
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    return { sessionID, messageID }
  })

/** A part row under the session's user message; the statistics tables key on it. */
const seedPart = (
  db: Database.Interface["db"],
  at: { sessionID: SessionID; messageID: SessionV1.MessageID },
  part: string,
) =>
  Effect.gen(function* () {
    const partID = SessionV1.PartID.make(part)
    yield* db
      .insert(PartTable)
      .values({ id: partID, message_id: at.messageID, session_id: at.sessionID, data: { type: "step-start" } })
      .run()
      .pipe(Effect.orDie)
    return partID
  })

describe("queryOutcomes", () => {
  const book = (
    db: Database.Interface["db"],
    input: {
      session: string
      project: typeof projectA
      updated: number
      part: string
      model?: string
      tool: string
      outcome: ToolOutcomeKind
      corrections?: string[]
      truncated?: boolean
    },
  ) =>
    Effect.gen(function* () {
      const at = yield* seedSession(db, input)
      const partID = yield* seedPart(db, at, input.part)
      const sessionID = at.sessionID
      yield* db
        .insert(ToolOutcomeTable)
        .values({
          part_id: partID,
          session_id: sessionID,
          provider_id: "anthropic",
          model_id: input.model ?? "claude",
          tool: input.tool,
          outcome: input.outcome,
          corrections: input.corrections ?? [],
          truncated: input.truncated ?? false,
        })
        .run()
        .pipe(Effect.orDie)
    })

  it.effect("an empty database yields no rows and no output", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const rows = yield* queryOutcomes(db, {})
      expect(rows).toEqual([])
      expect(renderOutcomes(rows, Infinity)).toEqual([])
    }),
  )

  it.effect("counts rows by model, tool, outcome, truncation and corrections", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const now = Date.now()
      yield* book(db, { session: "ses_a", project: projectA, updated: now, part: "prt_1", tool: "edit", outcome: "ok" })
      yield* book(db, { session: "ses_a", project: projectA, updated: now, part: "prt_2", tool: "edit", outcome: "ok" })
      yield* book(db, {
        session: "ses_a",
        project: projectA,
        updated: now,
        part: "prt_3",
        tool: "edit",
        outcome: "ok",
        corrections: ["fuzzy_match"],
      })
      yield* book(db, {
        session: "ses_a",
        project: projectA,
        updated: now,
        part: "prt_4",
        tool: "bash",
        outcome: "denied",
        truncated: true,
        model: "other",
      })

      const rows = (yield* queryOutcomes(db, {})).sort((a, b) => a.tool.localeCompare(b.tool) || b.count - a.count)
      expect(rows).toEqual([
        {
          providerID: "anthropic",
          modelID: "other",
          tool: "bash",
          outcome: "denied",
          truncated: true,
          corrections: [],
          count: 1,
        },
        {
          providerID: "anthropic",
          modelID: "claude",
          tool: "edit",
          outcome: "ok",
          truncated: false,
          corrections: [],
          count: 2,
        },
        {
          providerID: "anthropic",
          modelID: "claude",
          tool: "edit",
          outcome: "ok",
          truncated: false,
          corrections: ["fuzzy_match"],
          count: 1,
        },
      ])
    }),
  )

  it.effect("filters sessions by --days and --project like the session statistics do", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const now = Date.now()
      yield* book(db, {
        session: "ses_new_a",
        project: projectA,
        updated: now,
        part: "prt_n1",
        tool: "edit",
        outcome: "ok",
      })
      yield* book(db, {
        session: "ses_old_a",
        project: projectA,
        updated: now - 10 * DAY,
        part: "prt_o1",
        tool: "edit",
        outcome: "ok",
      })
      yield* book(db, {
        session: "ses_new_b",
        project: projectB,
        updated: now,
        part: "prt_n2",
        tool: "bash",
        outcome: "ok",
      })

      const total = (rows: readonly OutcomeRow[]) => rows.reduce((sum, entry) => sum + entry.count, 0)
      expect(total(yield* queryOutcomes(db, {}))).toBe(3)
      expect(total(yield* queryOutcomes(db, { days: 7 }))).toBe(2)
      expect(total(yield* queryOutcomes(db, { days: 30 }))).toBe(3)
      expect(total(yield* queryOutcomes(db, { project: "project_b" }))).toBe(1)
      expect(total(yield* queryOutcomes(db, { project: "project_a", days: 7 }))).toBe(1)
      // An empty project filter means the current project.
      const current = { id: projectA } as Project.Info
      expect(total(yield* queryOutcomes(db, { project: "", currentProject: current }))).toBe(2)
      const missing = yield* Effect.exit(queryOutcomes(db, { project: "" }))
      expect(missing._tag).toBe("Failure")
    }),
  )
})

describe("queryModelSteps", () => {
  const apiError = { name: "APIError", data: { message: "boom", isRetryable: false } } as const
  const aborted = { name: "MessageAbortedError", data: { message: "stopped" } } as const
  const overflow = { name: "ContextOverflowError", data: { message: "too long" } } as const

  const bookStep = (
    db: Database.Interface["db"],
    input: {
      session: string
      project?: typeof projectA
      updated?: number
      part: string
      model?: string
      requestMs: number
      retries?: number
      toolErrors?: number
    },
  ) =>
    Effect.gen(function* () {
      const at = yield* seedSession(db, { project: projectA, updated: Date.now(), ...input })
      const partID = yield* seedPart(db, at, input.part)
      yield* db
        .insert(SessionStepTable)
        .values({
          part_id: partID,
          session_id: at.sessionID,
          provider_id: "anthropic",
          model_id: input.model ?? "claude",
          prepare_ms: 1,
          request_ms: input.requestMs,
          ttft_ms: 1,
          tool_calls: (input.toolErrors ?? 0) + 1,
          tool_errors: input.toolErrors ?? 0,
          retries: input.retries ?? 0,
        })
        .run()
        .pipe(Effect.orDie)
    })

  /** An assistant message of `model`, with or without a recorded error. */
  const bookRequest = (
    db: Database.Interface["db"],
    input: {
      session: string
      project?: typeof projectA
      updated?: number
      message: string
      model?: string
      error?: SessionV1.Assistant["error"]
      role?: "assistant" | "user"
    },
  ) =>
    Effect.gen(function* () {
      const at = yield* seedSession(db, { project: projectA, updated: Date.now(), ...input })
      const data =
        input.role === "user"
          ? { role: "user" as const, agent: "build", time: { created: 1 }, error: input.error }
          : {
              role: "assistant" as const,
              time: { created: 1 },
              parentID: at.messageID,
              modelID: ModelV2.ID.make(input.model ?? "claude"),
              providerID: ProviderV2.ID.make("anthropic"),
              mode: "build",
              agent: "build",
              path: { cwd: "/project", root: "/project" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              ...(input.error ? { error: input.error } : {}),
            }
      yield* db
        .insert(MessageTable)
        // A user message never carries an error in real data; the cast lets a test plant one to prove it is ignored.
        .values({ id: SessionV1.MessageID.make(input.message), session_id: at.sessionID, data: data as never })
        .run()
        .pipe(Effect.orDie)
    })

  it.effect("an empty database yields an empty table", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      expect(yield* queryModelSteps(db, {})).toEqual({})
    }),
  )

  it.effect("sums retries and tool failures per model and averages the request time to whole milliseconds", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* bookStep(db, { session: "ses_a", part: "prt_1", requestMs: 100, retries: 0, toolErrors: 1 })
      yield* bookStep(db, { session: "ses_a", part: "prt_2", requestMs: 200, retries: 1, toolErrors: 0 })
      yield* bookStep(db, { session: "ses_b", part: "prt_3", requestMs: 301, retries: 2, toolErrors: 2 })
      yield* bookStep(db, { session: "ses_a", part: "prt_4", requestMs: 55, model: "other" })

      expect(yield* queryModelSteps(db, {})).toEqual({
        // 601 ms over 3 steps is 200.33
        "anthropic/claude": { steps: 3, avgRequestMs: 200, retries: 3, toolErrors: 3, requestFailures: 0 },
        "anthropic/other": { steps: 1, avgRequestMs: 55, retries: 0, toolErrors: 0, requestFailures: 0 },
      })
    }),
  )

  it.effect("counts the assistant messages that ended in an error, an abort not being one", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* bookStep(db, { session: "ses_a", part: "prt_1", requestMs: 40 })
      yield* bookRequest(db, { session: "ses_a", message: "msg_ok" })
      yield* bookRequest(db, { session: "ses_a", message: "msg_api", error: apiError })
      yield* bookRequest(db, { session: "ses_a", message: "msg_overflow", error: overflow })
      yield* bookRequest(db, { session: "ses_a", message: "msg_abort", error: aborted })
      // Only an assistant message can fail a request.
      yield* bookRequest(db, { session: "ses_a", message: "msg_user", role: "user", error: apiError })

      expect(yield* queryModelSteps(db, {})).toEqual({
        "anthropic/claude": { steps: 1, avgRequestMs: 40, retries: 0, toolErrors: 0, requestFailures: 2 },
      })
    }),
  )

  it.effect("keeps a model whose every request failed, with no steps, and leaves out one with nothing to report", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* bookRequest(db, { session: "ses_a", message: "msg_1", model: "broken", error: apiError })
      yield* bookRequest(db, { session: "ses_a", message: "msg_2", model: "broken", error: apiError })
      yield* bookRequest(db, { session: "ses_a", message: "msg_3", model: "quiet" })
      yield* bookRequest(db, { session: "ses_a", message: "msg_4", model: "stopped", error: aborted })

      expect(yield* queryModelSteps(db, {})).toEqual({
        "anthropic/broken": { steps: 0, avgRequestMs: 0, retries: 0, toolErrors: 0, requestFailures: 2 },
      })
    }),
  )

  it.effect("filters sessions by --days and --project like the session statistics do", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const now = Date.now()
      yield* bookStep(db, { session: "ses_new_a", project: projectA, updated: now, part: "prt_n1", requestMs: 10 })
      yield* bookStep(db, {
        session: "ses_old_a",
        project: projectA,
        updated: now - 10 * DAY,
        part: "prt_o1",
        requestMs: 10,
      })
      yield* bookStep(db, { session: "ses_new_b", project: projectB, updated: now, part: "prt_n2", requestMs: 10 })
      yield* bookRequest(db, {
        session: "ses_old_a",
        project: projectA,
        updated: now - 10 * DAY,
        message: "msg_old_fail",
        error: apiError,
      })
      yield* bookRequest(db, {
        session: "ses_new_b",
        project: projectB,
        updated: now,
        message: "msg_b_fail",
        error: apiError,
      })

      const counts = (table: Record<string, ModelSteps>) => {
        const model = table["anthropic/claude"]
        return model ? [model.steps, model.requestFailures] : undefined
      }
      expect(counts(yield* queryModelSteps(db, {}))).toEqual([3, 2])
      expect(counts(yield* queryModelSteps(db, { days: 7 }))).toEqual([2, 1])
      expect(counts(yield* queryModelSteps(db, { project: "project_b" }))).toEqual([1, 1])
      expect(counts(yield* queryModelSteps(db, { project: "project_a", days: 7 }))).toEqual([1, 0])
      const current = { id: projectA } as Project.Info
      expect(counts(yield* queryModelSteps(db, { project: "", currentProject: current }))).toEqual([2, 1])
    }),
  )
})

describe("the step rows of stats --models", () => {
  const steps: ModelSteps = { steps: 7, avgRequestMs: 340, retries: 2, toolErrors: 1, requestFailures: 3 }

  const stats = (): Parameters<typeof displayStats>[0] => ({
    totalSessions: 1,
    totalMessages: 4,
    totalCost: 1.5,
    totalTokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    toolUsage: {},
    modelUsage: {
      "anthropic/claude": {
        messages: 4,
        tokens: { input: 10, output: 20, cache: { read: 1, write: 2 } },
        cost: 0.1234,
      },
      "openai/gpt": { messages: 2, tokens: { input: 5, output: 6, cache: { read: 0, write: 0 } }, cost: 0.5 },
    },
    dateRange: { earliest: 0, latest: 1 },
    days: 1,
    costPerDay: 1.5,
    tokensPerSession: 3,
    medianTokensPerSession: 3,
  })

  /** What `displayStats` prints, line by line; the cursor-up escape it writes to stdout is swallowed. */
  const printed = (...args: [steps?: Record<string, ModelSteps>]) => {
    const lines: string[] = []
    const log = spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      lines.push(parts.join(" "))
    })
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      displayStats(stats(), undefined, Infinity, ...args)
    } finally {
      log.mockRestore()
      write.mockRestore()
    }
    return lines
  }

  /** A box row the way `displayStats` pads it: label left, value right, a space before the border. */
  const boxRow = (label: string, value: string) =>
    `│${label}${" ".repeat(55 - Bun.stringWidth(label) - Bun.stringWidth(value))}${value} │`

  it.effect("prints five rows after the cost row and before the separator, in English", () =>
    Effect.sync(() => {
      setLanguage("en")
      const lines = printed({ "anthropic/claude": steps })
      const cost = lines.indexOf(boxRow("  Cost", "$0.1234"))
      expect(cost).toBeGreaterThan(0)
      expect(lines.slice(cost + 1, cost + 7)).toEqual([
        boxRow("  Steps", "7"),
        boxRow("  Avg Request Time", "340 ms"),
        boxRow("  Retries", "2"),
        boxRow("  Tool Failures", "1"),
        boxRow("  Request Failures", "3"),
        "├────────────────────────────────────────────────────────┤",
      ])
    }),
  )

  for (const language of ["en", "zh-CN"] as const) {
    it.effect(`every printed line is the width of the 56-cell box in ${language}`, () =>
      Effect.sync(() => {
        setLanguage(language)
        const huge: ModelSteps = {
          steps: 123456789,
          avgRequestMs: 987654,
          retries: 4242,
          toolErrors: 99999,
          requestFailures: 31337,
        }
        const lines = printed({ "anthropic/claude": steps, "openai/gpt": huge })
        const rows = modelStepRows(huge).map(([label]) => `  ${label}`)
        expect(rows).toHaveLength(5)
        for (const line of lines.filter((entry) => entry.startsWith("│"))) {
          expect(Bun.stringWidth(line)).toBe(58)
        }
        for (const label of rows) expect(lines.some((line) => line.startsWith(`│${label}`))).toBe(true)
      }),
    )
  }

  it.effect("labels the rows in Chinese", () =>
    Effect.sync(() => {
      setLanguage("zh-CN")
      expect(modelStepRows(steps)).toEqual([
        ["步数", "7"],
        ["平均请求耗时", "340 ms"],
        ["重试", "2"],
        ["工具失败", "1"],
        ["请求失败", "3"],
      ])
    }),
  )

  it.effect("a model without an entry gets no rows, and without the table the output is unchanged", () =>
    Effect.sync(() => {
      const without = printed()
      expect(printed({})).toEqual(without)
      const lines = printed({ "anthropic/claude": steps })
      expect(lines.length).toBe(without.length + 5)
      // Only the model with an entry grew: the other model's block is as before.
      const header = `│ ${"openai/gpt".padEnd(54)} │`
      expect(lines.slice(lines.indexOf(header))).toEqual(without.slice(without.indexOf(header)))
    }),
  )
})
