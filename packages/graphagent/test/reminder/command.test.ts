// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1072: `/remind` dispatch, the exchange it records and the receipts it writes.
//
// The command body is exercised with stubbed session dependencies (like
// `session/command.test.ts` does for `/dag-mode`) over a real database and a
// real clock service, so the reminder rows behind every receipt are real.
import { describe, expect } from "bun:test"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Duration, Effect, Option } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Command } from "@/command"
import { ReminderClock } from "@/reminder/clock"
import { MessageV2 } from "@/session/message-v2"
import { makeCommand, type CommandDeps } from "@/session/command"
import type { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { base, readReminder, seedSession, unique, withClock } from "./reminder.fixture"

const it = testEffect(base)

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const model = { providerID: "test", modelID: "test-model" }
const buildAgent = { name: "build", mode: "primary" as const }

// The command body reads a small slice of each dependency; a full layer graph
// would test the session stack instead of the receipt contract.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- partial test double
const asDeps = (value: Record<string, unknown>) => value as unknown as CommandDeps

function harness(input: {
  readonly sessionID: SessionID
  readonly parentID?: string
  /** Registry entry under the `remind` name; a different object means a user override. */
  readonly command?: Record<string, unknown>
}) {
  const info = { id: input.sessionID, parentID: input.parentID, agent: "build", model, permission: [] }
  const parts: SessionV1.Part[] = []
  const messages: SessionV1.Info[] = []
  const prompts: Array<{ parts: ReadonlyArray<Record<string, unknown>> }> = []
  const deps = asDeps({
    sessions: {
      get: () => Effect.succeed(info),
      findMessage: () => Effect.succeed(Option.none()),
      updateMessage: (message: SessionV1.Info) => {
        messages.push(message)
        return Effect.succeed(message)
      },
      updatePart: (part: SessionV1.Part) => {
        parts.push(part)
        return Effect.succeed(part)
      },
      touch: () => Effect.void,
    },
    agents: {
      defaultAgent: () => Effect.succeed("build"),
      get: () => Effect.succeed(buildAgent),
      defaultInfo: () => Effect.succeed(buildAgent),
      list: () => Effect.succeed([]),
    },
    config: { get: () => Effect.succeed({}) },
    events: { publish: () => Effect.void },
    commands: {
      // Undefined means "the built-in registry entry"; a template path is only
      // entered when a user command replaced the name.
      get: () => Effect.succeed(input.command),
      list: () => Effect.succeed([]),
    },
    prepareFns: {
      currentModel: () => Effect.succeed(model),
      modelSelection: () => Effect.succeed({}),
      getModel: () => Effect.succeed({}),
      resolvePromptParts: (template: string) => Effect.succeed([{ type: "text" as const, text: template }]),
    },
    admit: {
      promptImpl: (value: { parts: ReadonlyArray<Record<string, unknown>> }) => {
        prompts.push(value)
        return Effect.succeed({ info: { id: "msg_prompt" }, parts: [] })
      },
    },
    state: { startIfIdle: () => Effect.succeed(Option.none()) },
    withRunRequest: (_sessionID: SessionID, use: (request: unknown, witness: unknown) => Effect.Effect<unknown>) =>
      use({ valid: () => true }, {}),
    withPromptLock: (_witness: unknown, _sessionID: SessionID, use: (witness: unknown) => Effect.Effect<unknown>) =>
      use({}),
    lastAssistant: () => Effect.succeed({ info: {}, parts: [] }),
    budgetState: () => Effect.succeed({ pending: new Map() }),
    modelWriteBegin: () => ({ epoch: 0, release: () => {} }),
  })
  const command = makeCommand(deps).command
  return {
    parts,
    messages,
    prompts,
    run: (args: string) =>
      command(
        { sessionID: input.sessionID, command: "remind", arguments: args, agent: "build" },
        { skipHookStart: true },
      ),
  }
}

const textParts = (result: SessionV1.WithParts): SessionV1.TextPart[] =>
  result.parts.filter((part): part is SessionV1.TextPart => part.type === "text")

/** Runs one `/remind` line against a clock and returns the receipt part. */
const remind = (clock: ReminderClock.Interface, sessionID: SessionID, args: string) =>
  harness({ sessionID })
    .run(args)
    .pipe(
      Effect.provideService(ReminderClock.Service, clock),
      Effect.map((result) => textParts(result)[1]),
    )

describe("/remind exchange", () => {
  it.effect("creates the reminder and records an ignored exchange the session treats as a local command", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(unique("ses_remcmd_create"))
        const test = harness({ sessionID })
        const result = yield* test.run("30m check the logs").pipe(Effect.provideService(ReminderClock.Service, clock))
        const [command, receipt] = textParts(result)

        expect(command).toMatchObject({
          ignored: true,
          text: "/remind 30m check the logs",
          metadata: { command: "remind" },
        })
        expect(receipt?.ignored).toBe(true)
        expect(receipt?.synthetic).toBeUndefined()
        expect(receipt?.time?.end).toBeDefined()
        expect(receipt?.text).toMatch(
          /^已设置提醒 rmd_[0-9a-f]{8}：\d{4}-\d{2}-\d{2} \d{2}:\d{2}（30 分钟后）\ncheck the logs$/,
        )
        // The whole exchange is presentation state: it never becomes the turn a model answers.
        expect(MessageV2.isLocalCommand({ info: result.info, parts: result.parts })).toBe(true)

        const [created] = yield* clock.list(sessionID)
        expect(created).toMatchObject({
          text: "check the logs",
          fireAt: 30 * MINUTE,
          everyMs: null,
          status: "scheduled",
        })
        expect(receipt?.text).toContain(created?.id)
        expect(yield* readReminder(created.id)).toMatchObject({ creator: "user", session_id: sessionID })
      }),
    ),
  )

  it.effect("creates a repeating reminder one interval from now", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(unique("ses_remcmd_every"))
        yield* TestClock.adjust(Duration.minutes(10))
        const receipt = yield* remind(clock, sessionID, "every 1h look at the logs")
        expect(receipt?.text).toContain("（1 小时后）")
        expect(receipt?.text).toContain("每 1 小时重复")
        expect(yield* clock.list(sessionID)).toMatchObject([
          { text: "look at the logs", fireAt: 10 * MINUTE + HOUR, everyMs: HOUR },
        ])
      }),
    ),
  )

  it.effect("lists the session's reminders, soonest first, with their ids", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(unique("ses_remcmd_list"))
        const other = yield* seedSession(unique("ses_remcmd_list_other"))
        expect((yield* remind(clock, sessionID, "list"))?.text).toBe("本会话没有待触发的提醒。")

        yield* remind(clock, sessionID, "2h later one")
        yield* remind(clock, sessionID, "every 1h  repeating\none")
        yield* remind(clock, other, "5m somebody else's")
        const [first, second] = yield* clock.list(sessionID)

        const receipt = yield* remind(clock, sessionID, "list")
        const lines = receipt?.text.split("\n") ?? []
        expect(lines[0]).toBe("本会话的提醒（2）：")
        // Soonest first: the hourly one, then the one in two hours. Text collapses to one line.
        expect(lines[1]).toContain(`${first?.id}  `)
        expect(lines[1]).toContain("每 1 小时重复")
        expect(lines[1].endsWith("  repeating one")).toBe(true)
        expect(lines[2]).toContain(`${second?.id}  `)
        expect(lines[2].endsWith("  later one")).toBe(true)
        expect(receipt?.text).not.toContain("somebody else's")
      }),
    ),
  )

  it.effect("cancels by id, and says so when there is nothing to cancel", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(unique("ses_remcmd_cancel"))
        const other = yield* seedSession(unique("ses_remcmd_cancel_other"))
        yield* remind(clock, sessionID, "30m check the logs")
        const [created] = yield* clock.list(sessionID)

        // Not this session's reminder, and not a reminder at all.
        expect((yield* remind(clock, other, `cancel ${created.id}`))?.text).toContain("没有找到可取消的提醒")
        expect((yield* remind(clock, sessionID, "cancel rmd_unknown"))?.text).toBe(
          "没有找到可取消的提醒 rmd_unknown（可能已触发、已取消，或不属于本会话）。",
        )
        expect((yield* remind(clock, sessionID, `cancel ${created.id}`))?.text).toBe(`已取消提醒 ${created.id}。`)
        expect(yield* readReminder(created.id)).toMatchObject({ status: "cancelled" })
        expect(yield* clock.list(sessionID)).toEqual([])
        // Already cancelled: the second attempt finds nothing live.
        expect((yield* remind(clock, sessionID, `cancel ${created.id}`))?.text).toContain("没有找到可取消的提醒")
      }),
    ),
  )

  it.effect("explains what it did not understand and creates nothing", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(unique("ses_remcmd_errors"))
        const usage = (yield* remind(clock, sessionID, ""))?.text ?? ""
        expect(usage).toContain("用法：")
        expect(usage).toContain("/remind list")
        expect(usage).toContain("/remind cancel <id>")

        expect((yield* remind(clock, sessionID, "soon check"))?.text).toContain("无法识别时间")
        expect((yield* remind(clock, sessionID, "30m"))?.text).toContain("缺少提醒文本")
        expect((yield* remind(clock, sessionID, "every 4m check"))?.text).toBe("重复间隔最短 5 分钟。")
        expect((yield* remind(clock, sessionID, "cancel"))?.text).toContain("缺少提醒 id")
        expect((yield* remind(clock, sessionID, "list please"))?.text).toContain("多余的参数")
        expect(yield* clock.list(sessionID)).toEqual([])
      }),
    ),
  )

  it.effect("refuses a child session without writing anything", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(unique("ses_remcmd_child"))
        const result = yield* harness({ sessionID, parentID: "ses_parent" })
          .run("30m check")
          .pipe(Effect.provideService(ReminderClock.Service, clock))
        const [command, receipt] = textParts(result)
        expect(command?.ignored).toBe(true)
        expect(receipt?.ignored).toBe(true)
        expect(receipt?.text).toBe("提醒只适用于主会话。")
        expect(yield* clock.list(sessionID)).toEqual([])
      }),
    ),
  )

  it.effect("reports an unavailable reminder service instead of failing", () =>
    Effect.gen(function* () {
      const sessionID = yield* seedSession(unique("ses_remcmd_nosvc"))
      const result = yield* harness({ sessionID }).run("30m check")
      expect(textParts(result)[1]?.text).toBe("提醒服务当前不可用。")
    }),
  )

  it.effect("a user-defined remind command runs its template instead of the local operation", () =>
    withClock((clock) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(unique("ses_remcmd_override"))
        const test = harness({
          sessionID,
          command: {
            name: Command.Default.REMIND,
            description: "Custom remind",
            source: "command",
            template: "Custom reminder prompt $ARGUMENTS",
            hints: ["$ARGUMENTS"],
          },
        })
        yield* test.run("30m check").pipe(Effect.provideService(ReminderClock.Service, clock))

        expect(yield* clock.list(sessionID)).toEqual([])
        expect(test.prompts).toHaveLength(1)
        expect(test.prompts[0]?.parts).toContainEqual({
          type: "text",
          text: "Custom reminder prompt 30m check",
          synthetic: true,
        })
      }),
    ),
  )
})
