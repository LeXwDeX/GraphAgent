// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- a database that fails on demand stands in for the real one below

import { describe, expect, test } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionProjector } from "@graphagent/core/session/projector"
import { SessionTurnTable } from "@graphagent/core/session/turn.sql"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Cause, Effect, Exit } from "effect"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import type { TurnOutcome } from "@/session/turns"
import { TaskFacts } from "@/tool/task-facts"
import { testEffect } from "../lib/effect"

/**
 * #1453 PR1: the facts block a task result carries. `render` and `endOf` are pure; `collect` reads the child
 * session's turns and messages from a real in-memory database.
 */

const it = testEffect(LayerNode.buildLayer(LayerNode.group([Session.node, MessageV2.node, SessionProjector.node])))

const NO_SNAPSHOT = "unknown (no snapshot: not a git repository, or snapshots are disabled)"

const measured = (over: Partial<TaskFacts.Measured> = {}): TaskFacts.Measured => ({
  end: "completed",
  steps: 4,
  tokens: { input: 120, output: 30, reasoning: 5, cacheRead: 8, cacheWrite: 2 },
  toolErrors: 1,
  changed: { kind: "files", files: ["/w/a.ts", "/w/b.ts"] },
  ...over,
})

describe("TaskFacts.render", () => {
  test("writes one item per line, in a fixed order", () => {
    expect(TaskFacts.render(measured())).toBe(
      [
        "<task_facts>",
        "end: completed",
        "steps: 4",
        "tokens: input=120 output=30 reasoning=5 cache_read=8 cache_write=2",
        "tool_errors: 1",
        "changed_files (2): /w/a.ts, /w/b.ts",
        "</task_facts>",
      ].join("\n"),
    )
  })

  test("writes an item it could not read as unknown", () => {
    expect(
      TaskFacts.render({
        end: "unknown",
        steps: undefined,
        tokens: undefined,
        toolErrors: undefined,
        changed: { kind: "unknown" },
      }),
    ).toBe(
      [
        "<task_facts>",
        "end: unknown",
        "steps: unknown",
        "tokens: unknown",
        "tool_errors: unknown",
        "changed_files: unknown",
        "</task_facts>",
      ].join("\n"),
    )
  })

  test("tells no change, and no snapshot to tell it by, apart", () => {
    expect(TaskFacts.render(measured({ changed: { kind: "none" } }))).toContain("\nchanged_files: none\n")
    expect(TaskFacts.render(measured({ changed: { kind: "no_snapshot" } }))).toContain(
      `\nchanged_files: ${NO_SNAPSHOT}\n`,
    )
  })

  test("lists at most 20 changed files and counts the rest", () => {
    const files = Array.from({ length: 25 }, (_, index) => `/w/f${index + 1}.ts`)
    const line = TaskFacts.render(measured({ changed: { kind: "files", files } }))
      .split("\n")
      .find((item) => item.startsWith("changed_files"))

    expect(line).toBe(`changed_files (25): ${files.slice(0, 20).join(", ")}, ... 5 more`)
    const exact = TaskFacts.render(measured({ changed: { kind: "files", files: files.slice(0, 20) } }))
    expect(exact).toContain("changed_files (20): /w/f1.ts")
    expect(exact).not.toContain("more")
  })

  test("keeps every path on its own line", () => {
    const text = TaskFacts.render(
      measured({ changed: { kind: "files", files: ["/w/a\nend: completed.ts", "/w/b\r.ts"] } }),
    )

    expect(text.split("\n")).toHaveLength(7)
    expect(text).toContain("changed_files (2): /w/a\\nend: completed.ts, /w/b\\r.ts")
  })
})

describe("TaskFacts.endOf", () => {
  const turn = (outcome: TurnOutcome | undefined, steps: number) => ({ outcome, steps })

  test("reads unknown when there is no turn to read, or the last one has no readable outcome", () => {
    expect(TaskFacts.endOf([], 3)).toBe("unknown")
    expect(TaskFacts.endOf([turn({ type: "completed" }, 1), turn(undefined, 1)], 3)).toBe("unknown")
  })

  test("takes the outcome of the last turn", () => {
    expect(TaskFacts.endOf([turn({ type: "completed" }, 1)], undefined)).toBe("completed")
    expect(TaskFacts.endOf([turn({ type: "error", code: "boom", retryable: false }, 1)], 3)).toBe("error")
    expect(TaskFacts.endOf([turn({ type: "cancelled", reason: undefined }, 1)], 3)).toBe("cancelled")
    expect(TaskFacts.endOf([turn({ type: "length" }, 1)], 3)).toBe("length")
    // Only the last turn counts: the continuation after an earlier cut ended on its own.
    expect(TaskFacts.endOf([turn({ type: "tool_budget_exhausted" }, 2), turn({ type: "completed" }, 1)], 3)).toBe(
      "completed",
    )
  })

  test("calls a completed turn that reached its agent's step limit a step limit", () => {
    expect(TaskFacts.endOf([turn({ type: "completed" }, 3)], 3)).toBe("step_limit")
    expect(TaskFacts.endOf([turn({ type: "completed" }, 5)], 3)).toBe("step_limit")
    expect(TaskFacts.endOf([turn({ type: "completed" }, 2)], 3)).toBe("completed")
    // No limit, no step limit; and a turn that ended another way keeps its own outcome.
    expect(TaskFacts.endOf([turn({ type: "completed" }, 99)], undefined)).toBe("completed")
    expect(TaskFacts.endOf([turn({ type: "tool_budget_exhausted" }, 3)], 3)).toBe("tool_budget_exhausted")
    expect(TaskFacts.endOf([turn({ type: "error", code: "boom", retryable: false }, 3)], 3)).toBe("error")
  })
})

// A child session as the engine leaves it: user messages, assistant messages with their parts, and turn rows.
const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }

type Distributive<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type PartInput = Distributive<SessionV1.Part, "id" | "messageID" | "sessionID">

const stepStart = (snapshot?: string): PartInput => ({ type: "step-start", ...(snapshot ? { snapshot } : {}) })
const patched = (...files: string[]): PartInput => ({ type: "patch", hash: "h", files })
const called = (status: "completed" | "error"): PartInput => ({
  type: "tool",
  callID: `call_${Bun.randomUUIDv7()}`,
  tool: "read",
  state:
    status === "error"
      ? { status: "error", input: {}, error: "boom", time: { start: 1, end: 2 } }
      : { status: "completed", input: {}, output: "ok", title: "read", metadata: {}, time: { start: 1, end: 2 } },
})

const child = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const { db } = yield* Database.Service
  const created = yield* sessions.create({})
  const user = Effect.fnUntraced(function* (at: number) {
    const id = MessageID.ascending()
    yield* sessions.updateMessage({
      id,
      role: "user",
      sessionID: created.id,
      agent: "explore",
      model: ref,
      time: { created: at },
    })
    return id
  })
  const assistant = Effect.fnUntraced(function* (
    at: number,
    parentID: MessageID,
    input: { tokens?: Partial<typeof ZERO_TOKENS>; parts?: PartInput[] } = {},
  ) {
    const id = MessageID.ascending()
    yield* sessions.updateMessage({
      id,
      role: "assistant",
      parentID,
      sessionID: created.id,
      mode: "explore",
      agent: "explore",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { ...ZERO_TOKENS, ...input.tokens },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: at },
    })
    for (const part of input.parts ?? [])
      yield* sessions.updatePart({ ...part, id: PartID.ascending(), messageID: id, sessionID: created.id })
    return id
  })
  const turn = Effect.fnUntraced(function* (
    userMessageID: MessageID | null,
    outcome: Record<string, unknown>,
    steps: number,
    at: number,
  ) {
    yield* db
      .insert(SessionTurnTable)
      .values({
        id: `turn_${Bun.randomUUIDv7()}`,
        session_id: created.id,
        origin: JSON.stringify({ kind: "user", via: "prompt" }),
        state: "ended",
        outcome,
        user_message_id: userMessageID,
        steps,
        runner_id: "1",
        time_started: at,
        time_ended: at + 1,
      })
      .run()
      .pipe(Effect.orDie)
  })
  return { sessionID: created.id, user, assistant, turn }
})

const blockOf = (facts: { block: string }) => facts.block.split("\n").slice(1, -1)

describe("TaskFacts.collect", () => {
  it.instance("sums the run's turns, tokens and tool errors, and lists the files it changed once", () =>
    Effect.gen(function* () {
      const { sessionID, user, assistant, turn } = yield* child
      // An earlier run of the same child session: none of it is this run's.
      const first = yield* user(100)
      yield* assistant(101, first, {
        tokens: { input: 1000, output: 1000, reasoning: 1000, cache: { read: 1000, write: 1000 } },
        parts: [stepStart("old"), called("error"), patched("/w/old.ts")],
      })
      yield* turn(first, { type: "completed" }, 9, 102)
      // This run.
      const start = yield* user(200)
      yield* assistant(201, start, {
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 } },
        parts: [stepStart("s1"), called("completed"), called("error"), patched("/w/a.ts", "/w/b.ts")],
      })
      const next = yield* user(202)
      yield* assistant(203, next, {
        tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 1, write: 2 } },
        parts: [stepStart("s2"), called("error"), patched("/w/b.ts", "/w/c.ts")],
      })
      yield* turn(start, { type: "completed" }, 2, 204)

      const facts = yield* TaskFacts.collect({ sessionID, sinceMessageID: start, agentSteps: 5 })

      expect(blockOf(facts)).toEqual([
        "end: completed",
        "steps: 2",
        "tokens: input=150 output=30 reasoning=5 cache_read=8 cache_write=5",
        "tool_errors: 2",
        "changed_files (3): /w/a.ts, /w/b.ts, /w/c.ts",
      ])
      expect(facts.block.startsWith("<task_facts>\n")).toBe(true)
      expect(facts.block.endsWith("\n</task_facts>")).toBe(true)
      expect(facts.incomplete).toBeUndefined()
    }),
  )

  it.instance("sums the steps of every turn the run took and takes its end from the last one", () =>
    Effect.gen(function* () {
      const { sessionID, user, assistant, turn } = yield* child
      const start = yield* user(200)
      yield* assistant(201, start, { parts: [stepStart("s1")] })
      const next = yield* user(202)
      yield* assistant(203, next, { parts: [stepStart("s2")] })
      yield* turn(start, { type: "completed" }, 3, 204)
      yield* turn(next, { type: "completed" }, 1, 205)

      // The first turn reached the limit, the continuation after it did not: the run ended on its own.
      const facts = yield* TaskFacts.collect({ sessionID, sinceMessageID: start, agentSteps: 3 })

      expect(blockOf(facts)).toContain("end: completed")
      expect(blockOf(facts)).toContain("steps: 4")
      expect(facts.incomplete).toBeUndefined()
    }),
  )

  it.instance("marks a run whose last turn reached its agent's step limit", () =>
    Effect.gen(function* () {
      const { sessionID, user, assistant, turn } = yield* child
      const start = yield* user(200)
      yield* assistant(201, start, { parts: [stepStart("s1")] })
      yield* turn(start, { type: "completed" }, 3, 204)

      const facts = yield* TaskFacts.collect({ sessionID, sinceMessageID: start, agentSteps: 3 })

      expect(blockOf(facts)).toContain("end: step_limit")
      expect(facts.incomplete).toBe("step_limit")
      expect((yield* TaskFacts.collect({ sessionID, sinceMessageID: start, agentSteps: undefined })).incomplete).toBe(
        undefined,
      )
    }),
  )

  it.instance("marks a run whose last turn ran out of tool budget", () =>
    Effect.gen(function* () {
      const { sessionID, user, assistant, turn } = yield* child
      const start = yield* user(200)
      yield* assistant(201, start, { parts: [stepStart("s1")] })
      yield* turn(start, { type: "tool_budget_exhausted" }, 2, 204)

      const facts = yield* TaskFacts.collect({ sessionID, sinceMessageID: start, agentSteps: undefined })

      expect(blockOf(facts)).toContain("end: tool_budget_exhausted")
      expect(facts.incomplete).toBe("tool_budget_exhausted")
    }),
  )

  it.instance(
    "says no snapshot when no step of the run started with one, and none when one did and nothing changed",
    () =>
      Effect.gen(function* () {
        const bare = yield* child
        const bareStart = yield* bare.user(200)
        yield* bare.assistant(201, bareStart, { parts: [stepStart(), called("completed")] })
        const tracked = yield* child
        const trackedStart = yield* tracked.user(200)
        yield* tracked.assistant(201, trackedStart, { parts: [stepStart("s1"), called("completed")] })

        const none = yield* TaskFacts.collect({
          sessionID: bare.sessionID,
          sinceMessageID: bareStart,
          agentSteps: undefined,
        })
        const clean = yield* TaskFacts.collect({
          sessionID: tracked.sessionID,
          sinceMessageID: trackedStart,
          agentSteps: undefined,
        })

        expect(blockOf(none)).toContain(`changed_files: ${NO_SNAPSHOT}`)
        expect(blockOf(clean)).toContain("changed_files: none")
      }),
  )

  it.instance("reads the items of a source it can read when the other fails", () =>
    Effect.gen(function* () {
      // Turns, but the message the run started from is not in the session: the tokens, errors and files cannot be read.
      const lost = yield* child
      const missing = MessageID.ascending()
      yield* lost.turn(missing, { type: "completed" }, 2, 204)
      const unread = yield* TaskFacts.collect({
        sessionID: lost.sessionID,
        sinceMessageID: missing,
        agentSteps: undefined,
      })
      expect(blockOf(unread)).toEqual([
        "end: completed",
        "steps: 2",
        "tokens: unknown",
        "tool_errors: unknown",
        "changed_files: unknown",
      ])

      // Messages, but no turn row: the end and the steps cannot be read.
      const bare = yield* child
      const start = yield* bare.user(200)
      yield* bare.assistant(201, start, { tokens: { input: 10 }, parts: [stepStart("s1"), called("error")] })
      const facts = yield* TaskFacts.collect({ sessionID: bare.sessionID, sinceMessageID: start, agentSteps: 3 })
      expect(blockOf(facts)).toEqual([
        "end: unknown",
        "steps: unknown",
        "tokens: input=10 output=0 reasoning=0 cache_read=0 cache_write=0",
        "tool_errors: 1",
        "changed_files: none",
      ])
      expect(facts.incomplete).toBeUndefined()
    }),
  )

  it.instance("reads every item as unknown when the database cannot be read, and never fails", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const real = yield* Database.Service
      const created = yield* sessions.create({})
      const failing: Database.Interface = {
        ...real,
        db: {
          select: () => {
            const chain: Record<string, unknown> = {}
            for (const name of ["from", "where", "orderBy", "limit"]) chain[name] = () => chain
            for (const name of ["all", "get"]) chain[name] = () => Effect.die(new Error("the database is gone"))
            return chain
          },
        } as unknown as Database.Interface["db"],
      }

      const facts = yield* TaskFacts.collect({
        sessionID: created.id,
        sinceMessageID: MessageID.ascending(),
        agentSteps: 3,
      }).pipe(Effect.provideService(Database.Service, failing))

      expect(blockOf(facts)).toEqual([
        "end: unknown",
        "steps: unknown",
        "tokens: unknown",
        "tool_errors: unknown",
        "changed_files: unknown",
      ])
      expect(facts.incomplete).toBeUndefined()
    }),
  )

  it.instance("passes an interruption on instead of reading unknown", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const real = yield* Database.Service
      const created = yield* sessions.create({})
      const interrupted: Database.Interface = {
        ...real,
        db: {
          select: () => {
            const chain: Record<string, unknown> = {}
            for (const name of ["from", "where", "orderBy", "limit"]) chain[name] = () => chain
            for (const name of ["all", "get"]) chain[name] = () => Effect.interrupt
            return chain
          },
        } as unknown as Database.Interface["db"],
      }

      const exit = yield* TaskFacts.collect({
        sessionID: created.id,
        sinceMessageID: MessageID.ascending(),
        agentSteps: 3,
      }).pipe(Effect.provideService(Database.Service, interrupted), Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    }),
  )
})
