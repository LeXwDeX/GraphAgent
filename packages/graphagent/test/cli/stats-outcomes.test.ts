// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Only the project id of `Project.Info` is read by the stats filter.

import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@graphagent/core/database/database"
import { ProjectTable } from "@graphagent/core/project/sql"
import { ToolOutcomeTable } from "@graphagent/core/session/outcome.sql"
import { MessageTable, PartTable, SessionTable } from "@graphagent/core/session/sql"
import { Project as CoreProject } from "@graphagent/core/project"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionV1 } from "@graphagent/core/v1/session"
import type { ToolOutcomeKind } from "@graphagent/core/session/outcome"
import { SessionID } from "@graphagent/schema/session-id"
import { setLanguage } from "@graphagent/tui/i18n"
import type { Project } from "@/project/project"
import { outcomeLimit, queryOutcomes, renderOutcomes, type OutcomeRow } from "../../src/cli/cmd/stats-outcomes"
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

describe("queryOutcomes", () => {
  const DAY = 24 * 60 * 60 * 1000
  const projectA = CoreProject.ID.make("project_a")
  const projectB = CoreProject.ID.make("project_b")

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
      const partID = SessionV1.PartID.make(input.part)
      yield* db
        .insert(PartTable)
        .values({ id: partID, message_id: messageID, session_id: sessionID, data: { type: "step-start" } })
        .run()
        .pipe(Effect.orDie)
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
