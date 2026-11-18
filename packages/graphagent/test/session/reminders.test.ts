// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@graphagent/core/v1/session"
import { FSUtil } from "@graphagent/core/fs-util"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { Injection } from "@graphagent/core/system-context/injection"
import { SessionReminders } from "@/session/reminders"
import { PartID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// The three texts the plan reminders write, each in one block with source "reminder" and kind "plan" (#1456).
const { PLAN_REMINDER, BUILD_SWITCH_REMINDER } = SessionReminders

const sessionID = SessionID.make("ses_reminders")
const session = { slug: "reminders", time: { created: 1 } } as Session.Info

const persisted: SessionV1.Part[] = []

const sessions = Layer.mock(Session.Service, {
  updatePart: <T extends SessionV1.Part>(part: T) => Effect.sync(() => (persisted.push(part), part)),
})
const standard = Layer.mergeAll(RuntimeFlags.layer({ experimentalPlanMode: false }), FSUtil.defaultLayer, sessions)
const it = testEffect(standard)

const experimental = Layer.mergeAll(RuntimeFlags.layer({ experimentalPlanMode: true }), FSUtil.defaultLayer, sessions)
const itPlan = testEffect(experimental)

beforeEach(() => {
  persisted.length = 0
})

const user = (id: string, parts: SessionV1.Part[] = []): SessionV1.WithParts =>
  ({
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    },
    parts,
  }) as unknown as SessionV1.WithParts

const assistant = (id: string, agent: string): SessionV1.WithParts =>
  ({
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: 1 },
      parentID: "msg_parent",
      modelID: "test",
      providerID: "test",
      mode: agent,
      agent,
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [],
  }) as unknown as SessionV1.WithParts

const textPart = (id: string, text: string, messageID = "msg_2"): SessionV1.Part =>
  ({
    id: PartID.make(id),
    sessionID,
    messageID,
    type: "text",
    text,
    synthetic: true,
  }) as SessionV1.Part

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const plan: Agent.Info = { ...build, name: "plan" }

const derive = (messages: SessionV1.WithParts[], agent: Agent.Info = build, tools: readonly string[] = []) =>
  SessionReminders.derive({ messages, agent, session, tools })

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

const stripIDs = (messages: SessionV1.WithParts[]) =>
  messages.map((message) => ({
    ...message,
    info: { ...message.info },
    parts: message.parts.map((part) => ({ ...part, id: "<part>", messageID: "<message>", sessionID: "<session>" })),
  }))

/** The pre-derivation implementation of the experimental plan mode, kept as the byte-equality oracle. */
function legacy(input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  tools: readonly string[]
  persist: (part: SessionV1.Part) => SessionV1.Part
}): Effect.Effect<SessionV1.WithParts[], never, FSUtil.Service> {
  return Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const messages = structuredClone(input.messages)
    const userMessage = messages.findLast((msg) => msg.info.role === "user")
    if (!userMessage) return messages
    const assistantMessage = messages.findLast((msg) => msg.info.role === "assistant")
    const ctx = yield* InstanceState.context
    const target = Session.plan(session, ctx)
    if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
      const exists = yield* fsys.existsSafe(target)
      const part = input.persist(
        textPart(
          String(PartID.ascending()),
          exists
            ? Injection.wrap(
                "reminder",
                `${BUILD_SWITCH_REMINDER.split("\n").slice(1, -1).join("\n")}\n\nA plan file exists at ${target}. You should execute on the plan defined within it`,
                { kind: "plan" },
              )
            : BUILD_SWITCH_REMINDER,
        ),
      )
      userMessage.parts.push(part)
      return messages
    }
    if (input.agent.name !== "plan") return messages
    const exists = yield* fsys.existsSafe(target)
    const text = SessionReminders.planModePrompt({ plan: target, exists, tools: input.tools })
    const reminders = messages.flatMap((message) =>
      message.parts.filter(
        (part): part is SessionV1.TextPart =>
          part.type === "text" &&
          part.synthetic === true &&
          Injection.has(part.text) &&
          part.text.includes("\n# Plan mode\n") &&
          part.text.includes("\n# Plan file\n"),
      ),
    )
    if (reminders.length) {
      for (const reminder of reminders) reminder.text = text
      return messages
    }
    const part = input.persist(textPart(String(PartID.ascending()), text))
    userMessage.parts.push(part)
    return messages
  })
}

describe("session.reminders texts", () => {
  const blockOf = (text: string) => {
    const lines = text.split("\n")
    return { open: lines[0], close: lines.at(-1), body: lines.slice(1, -1).join("\n") }
  }

  it.effect("the plan prompt and the build switch are one reminder block each, of kind plan", () =>
    Effect.gen(function* () {
      for (const text of [PLAN_REMINDER, BUILD_SWITCH_REMINDER]) {
        const block = blockOf(text)
        expect(block.open).toBe('<system-reminder source="reminder" kind="plan">')
        expect(block.close).toBe("</system-reminder>")
        expect(text.match(/<system-reminder/g)).toHaveLength(1)
        expect(text.match(/<\/system-reminder>/g)).toHaveLength(1)
        expect(Injection.has(text)).toBe(true)
        // The tag lines are the block's own; the text under them starts and ends with words.
        expect(block.body).toBe(block.body.trim())
      }
      expect(blockOf(PLAN_REMINDER).body).toStartWith("# Plan mode\n\nPlan mode is active.")
      expect(blockOf(BUILD_SWITCH_REMINDER).body).toStartWith("Your mode has changed from plan to build.")
    }),
  )

  it.effect("the plan-mode prompt is one reminder block with the plan file and the exit step filled in", () =>
    Effect.gen(function* () {
      const text = SessionReminders.planModePrompt({ plan: "/plans/x.md", exists: true, tools: ["plan_exit"] })
      const block = blockOf(text)
      expect(block.open).toBe('<system-reminder source="reminder" kind="plan">')
      expect(block.close).toBe("</system-reminder>")
      expect(text.match(/<system-reminder/g)).toHaveLength(1)
      expect(block.body).toStartWith("# Plan mode\n\nPlan mode is active.")
      expect(text).toContain("\n# Plan file\nA plan file already exists at /plans/x.md.")
      expect(text).toContain("Call plan_exit when the plan is ready for user approval.")
      expect(text).not.toContain("${")
    }),
  )

  itPlan.instance(
    "the plan file note of the build switch sits inside the same block",
    () =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        const planPath = Session.plan(session, ctx)
        yield* Effect.promise(() => Bun.write(planPath, "# the plan\n"))
        const next = yield* derive(deepFreeze([user("msg_1"), assistant("msg_plan", "plan"), user("msg_2")]), build)
        const text = next
          .find((message) => message.info.id === "msg_2")!
          .parts.map((part) => (part.type === "text" ? part.text : ""))[0]
        expect(text).toStartWith(
          '<system-reminder source="reminder" kind="plan">\nYour mode has changed from plan to build.',
        )
        expect(text).toEndWith(
          `A plan file exists at ${planPath}. You should execute on the plan defined within it\n</system-reminder>`,
        )
        expect(text.match(/<\/system-reminder>/g)).toHaveLength(1)
      }),
    { git: true },
  )
})

describe("session.reminders plan transition", () => {
  // The plan reminder is a state reminder (#1456): `settle` writes the plan prompt on the plan agent's turn and the
  // build switch on the turn that leaves it. The note the history holds is the memory; no assistant message is read.
  const settle = (messages: SessionV1.WithParts[], agent: Agent.Info) => {
    const lastUser = messages.findLast((message) => message.info.role === "user")?.info
    if (lastUser?.role !== "user") throw new Error("the history has no user message")
    return SessionReminders.settle({ messages, lastUser, agent, tools: [], dagEligible: false })
  }
  const planTurn = Effect.gen(function* () {
    return yield* settle([user("msg_1")], plan)
  })

  it.effect("writes the build switch once on the turn that leaves plan mode", () =>
    Effect.gen(function* () {
      const history = yield* planTurn
      persisted.length = 0
      const current = user("msg_2")
      const messages = deepFreeze([...history, assistant("msg_plan", "plan"), current])

      const once = yield* settle(messages, build)
      expect(persisted).toHaveLength(1)
      expect(persisted[0]).toMatchObject({ type: "text", text: BUILD_SWITCH_REMINDER, synthetic: true })
      const appended = once.find((message) => message.info.id === "msg_2")!.parts
      expect(appended).toHaveLength(1)
      expect(appended[0]).toBe(persisted[0])
      // The plan turn's own note stays where it was written.
      expect(once.find((message) => message.info.id === "msg_1")!.parts).toHaveLength(1)
      expect(current.parts).toHaveLength(0)

      // The turn's next request finds the note in the history it reads back, and adds nothing.
      persisted.length = 0
      yield* settle(once, build)
      expect(persisted).toHaveLength(0)
    }),
  )

  it.effect("does not write the switch again on later build turns", () =>
    Effect.gen(function* () {
      const history = yield* planTurn
      const switched = yield* settle([...history, assistant("msg_plan", "plan"), user("msg_2")], build)
      persisted.length = 0

      const next = yield* settle([...switched, assistant("msg_build", "build"), user("msg_3")], build)

      expect(persisted).toHaveLength(0)
      expect(next.find((message) => message.info.id === "msg_3")!.parts).toHaveLength(0)
    }),
  )

  it.effect("writes no switch for a build turn when the history holds no plan note", () =>
    Effect.gen(function* () {
      const current = user("msg_2")
      const messages = [user("msg_1"), assistant("msg_plan", "plan"), assistant("msg_build", "build"), current]

      const next = yield* settle(messages, build)

      expect(persisted).toHaveLength(0)
      expect(next).toBe(messages)
    }),
  )

  it.effect("writes the plan prompt for a plan agent without mutating the input", () =>
    Effect.gen(function* () {
      const current = user("msg_2")
      const messages = deepFreeze([user("msg_1"), assistant("msg_build", "build"), current])

      const next = yield* settle(messages, plan)

      const appended = next.find((message) => message.info.id === "msg_2")!.parts
      expect(appended).toHaveLength(1)
      expect(appended[0]).toMatchObject({ type: "text", text: PLAN_REMINDER, synthetic: true })
      expect(persisted).toEqual([appended[0]])
      expect(current.parts).toHaveLength(0)
    }),
  )

  it.effect("writes the plan prompt once for the plan agent, not on every turn and step", () =>
    Effect.gen(function* () {
      const first = yield* planTurn
      persisted.length = 0
      const second = yield* settle([...first, assistant("msg_2", "plan"), user("msg_3")], plan)
      // A later step of the turn has the assistant message last: nothing is written at all.
      const step = yield* settle([...second, assistant("msg_4", "plan")], plan)
      expect(persisted).toHaveLength(0)
      expect(
        step.flatMap((message) => message.parts.filter((part) => part.type === "text" && part.text === PLAN_REMINDER)),
      ).toHaveLength(1)
    }),
  )

  it.effect("leaves the history as it is in the default plan mode", () =>
    Effect.gen(function* () {
      const scenarios: Array<[string, SessionV1.WithParts[], Agent.Info]> = [
        ["plan prompt", [user("msg_1"), assistant("msg_build", "build"), user("msg_2")], plan],
        ["leave plan", [user("msg_1"), assistant("msg_plan", "plan"), user("msg_2")], build],
        [
          "existing switch",
          [
            user("msg_1"),
            assistant("msg_plan", "plan"),
            user("msg_2", [textPart("prt_switch", BUILD_SWITCH_REMINDER)]),
          ],
          build,
        ],
        [
          "stale plan",
          [user("msg_1"), assistant("msg_plan", "plan"), assistant("msg_b", "build"), user("msg_2")],
          build,
        ],
      ]
      for (const [name, messages, agent] of scenarios) {
        const frozen = deepFreeze(structuredClone(messages))
        expect(yield* derive(frozen, agent), name).toBe(frozen)
      }
      expect(persisted).toHaveLength(0)
    }),
  )
})

describe("session.reminders experimental plan mode", () => {
  itPlan.instance(
    "persists the build switch and exposes it in the request copy",
    () =>
      Effect.gen(function* () {
        const current = user("msg_2")
        const messages = deepFreeze([user("msg_1"), assistant("msg_plan", "plan"), current])

        const next = yield* derive(messages)

        expect(persisted).toHaveLength(1)
        expect(persisted[0]).toMatchObject({ type: "text", text: BUILD_SWITCH_REMINDER, synthetic: true })
        const appended = next.find((message) => message.info.id === "msg_2")!.parts
        expect(appended).toHaveLength(1)
        expect(appended[0].type === "text" && appended[0].text).toBe(BUILD_SWITCH_REMINDER)
        expect(current.parts).toHaveLength(0)
      }),
    { git: true },
  )

  itPlan.instance(
    "refreshes every persisted plan reminder in the request copy without writing",
    () =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        const planPath = Session.plan(session, ctx)
        const previous = SessionReminders.planModePrompt({ plan: planPath, exists: false, tools: [] })
        const first = textPart("prt_old_1", previous, "msg_1")
        const second = textPart("prt_old_2", previous, "msg_2")
        const messages = deepFreeze([
          user("msg_1", [first]),
          assistant("msg_build", "build"),
          user("msg_2", [second]),
        ])

        const next = yield* derive(messages, plan, ["plan_exit"])

        expect(persisted).toHaveLength(0)
        expect(first.type === "text" && first.text).toBe(previous)
        expect(second.type === "text" && second.text).toBe(previous)
        const refreshed = next.flatMap((message) => message.parts).filter((part) => part.id === first.id || part.id === second.id)
        expect(refreshed).toHaveLength(2)
        for (const part of refreshed)
          expect(part.type === "text" && part.text).toBe(
            SessionReminders.planModePrompt({ plan: planPath, exists: false, tools: ["plan_exit"] }),
          )
      }),
    { git: true },
  )

  itPlan.instance(
    "refreshes a plan reminder persisted before the source attribute existed",
    () =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        const planPath = Session.plan(session, ctx)
        const legacyText =
          "<system-reminder>\n# Plan mode\n\nold wording\n\n# Plan file\nold file note\n</system-reminder>"
        const old = textPart("prt_legacy", legacyText, "msg_1")
        const messages = deepFreeze([user("msg_1", [old]), assistant("msg_build", "build"), user("msg_2")])

        const next = yield* derive(messages, plan, ["plan_exit"])

        expect(persisted).toHaveLength(0)
        const refreshed = next.flatMap((message) => message.parts).filter((part) => part.id === old.id)
        expect(refreshed).toHaveLength(1)
        expect(refreshed[0].type === "text" && refreshed[0].text).toBe(
          SessionReminders.planModePrompt({ plan: planPath, exists: false, tools: ["plan_exit"] }),
        )
        // No second reminder is added next to it.
        expect(next.find((message) => message.info.id === "msg_2")!.parts).toHaveLength(0)
      }),
    { git: true },
  )

  itPlan.instance(
    "persists a new plan reminder when history has none",
    () =>
      Effect.gen(function* () {
        const current = user("msg_2")
        const messages = [user("msg_1"), assistant("msg_build", "build"), current]

        const next = yield* derive(messages, plan, ["plan_exit"])

        expect(persisted).toHaveLength(1)
        const appended = next.find((message) => message.info.id === "msg_2")!.parts
        expect(appended).toHaveLength(1)
        expect(appended[0].type === "text" && appended[0].text).toContain("Call plan_exit")
        expect(current.parts).toHaveLength(0)
      }),
    { git: true },
  )

  itPlan.instance(
    "matches the previous implementation for the experimental scenarios",
    () =>
      Effect.gen(function* () {
        const scenarios: Array<[string, SessionV1.WithParts[], Agent.Info, readonly string[]]> = [
          ["leave plan", [user("msg_1"), assistant("msg_plan", "plan"), user("msg_2")], build, []],
          ["new plan reminder", [user("msg_1"), assistant("msg_build", "build"), user("msg_2")], plan, []],
        ]
        for (const [name, messages, agent, tools] of scenarios) {
          persisted.length = 0
          const frozen = deepFreeze(structuredClone(messages))
          const actual = yield* derive(frozen, agent, tools)
          const written: SessionV1.Part[] = []
          const expected = yield* legacy({
            messages,
            agent,
            tools,
            persist: (part) => (written.push(part), part),
          })
          expect(stripIDs(actual), name).toEqual(stripIDs(expected))
          const stripPart = (part: SessionV1.Part) => ({
            ...part,
            id: "<part>",
            messageID: "<message>",
            sessionID: "<session>",
          })
          expect(written.map(stripPart), name).toEqual(persisted.map(stripPart))
        }
      }),
    { git: true },
  )
})