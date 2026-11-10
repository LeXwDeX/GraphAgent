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
import { SessionReminders } from "@/session/reminders"
import { PartID, SessionID } from "@/session/schema"
import PROMPT_PLAN from "@/session/prompt/plan.txt"
import BUILD_SWITCH from "@/session/prompt/build-switch.txt"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("ses_reminders")
const session = { slug: "reminders", time: { created: 1 } } as Session.Info

const persisted: SessionV1.Part[] = []

const standard = Layer.mergeAll(
  RuntimeFlags.layer({ experimentalPlanMode: false }),
  FSUtil.defaultLayer,
  Layer.mock(Session.Service, {}),
)
const it = testEffect(standard)

const experimental = Layer.mergeAll(
  RuntimeFlags.layer({ experimentalPlanMode: true }),
  FSUtil.defaultLayer,
  Layer.mock(Session.Service, {
    updatePart: <T extends SessionV1.Part>(part: T) => Effect.sync(() => (persisted.push(part), part)),
  }),
)
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

/** The pre-derivation implementation, kept as the byte-equality oracle. */
function legacy(input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  experimental: boolean
  tools: readonly string[]
  persist: (part: SessionV1.Part) => SessionV1.Part
}): Effect.Effect<SessionV1.WithParts[], never, FSUtil.Service> {
  return Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const messages = structuredClone(input.messages)
    const userMessage = messages.findLast((msg) => msg.info.role === "user")
    if (!userMessage) return messages
    if (!input.experimental) {
      if (input.agent.name === "plan") userMessage.parts.push(textPart(String(PartID.ascending()), PROMPT_PLAN))
      const lastAssistant = messages.findLast((msg) => msg.info.role === "assistant")
      if (lastAssistant?.info.agent === "plan" && input.agent.name === "build") {
        const already = userMessage.parts.some(
          (part) => part.type === "text" && part.synthetic === true && part.text === BUILD_SWITCH,
        )
        if (!already) userMessage.parts.push(textPart(String(PartID.ascending()), BUILD_SWITCH))
      }
      return messages
    }
    const assistantMessage = messages.findLast((msg) => msg.info.role === "assistant")
    const ctx = yield* InstanceState.context
    const target = Session.plan(session, ctx)
    if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
      const exists = yield* fsys.existsSafe(target)
      const part = input.persist(
        textPart(
          String(PartID.ascending()),
          exists ? `${BUILD_SWITCH}\n\nA plan file exists at ${target}. You should execute on the plan defined within it` : BUILD_SWITCH,
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
          part.text.startsWith("<system-reminder>\n# Plan mode") &&
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

describe("session.reminders plan transition", () => {
  it.effect("injects the build switch once on the turn that leaves plan mode", () =>
    Effect.gen(function* () {
      const first = user("msg_1")
      const current = user("msg_2")
      const messages = [first, assistant("msg_plan", "plan"), current]

      const once = yield* derive(messages)
      const twice = yield* derive(messages)

      for (const next of [once, twice]) {
        const switches = next
          .find((message) => message.info.id === "msg_2")!
          .parts.filter((part) => part.type === "text" && part.synthetic === true && part.text === BUILD_SWITCH)
        expect(switches).toHaveLength(1)
        expect(next.find((message) => message.info.id === "msg_1")!.parts).toHaveLength(0)
      }
      expect(current.parts).toHaveLength(0)
    }),
  )

  it.effect("does not re-inject the switch on later build turns", () =>
    Effect.gen(function* () {
      const switched = user("msg_2", [textPart("prt_switch", BUILD_SWITCH)])
      const current = user("msg_3")
      const messages = [user("msg_1"), assistant("msg_plan", "plan"), switched, assistant("msg_build", "build"), current]

      const next = yield* derive(messages)

      expect(next.find((message) => message.info.id === "msg_3")!.parts).toHaveLength(0)
    }),
  )

  it.effect("ignores a plan turn that is not the last assistant message", () =>
    Effect.gen(function* () {
      const current = user("msg_2")
      const messages = [user("msg_1"), assistant("msg_plan", "plan"), assistant("msg_build", "build"), current]

      const next = yield* derive(messages)

      expect(next.find((message) => message.info.id === "msg_2")!.parts).toHaveLength(0)
    }),
  )

  it.effect("appends the plan prompt for a plan agent without mutating the input", () =>
    Effect.gen(function* () {
      const current = user("msg_2")
      const messages = deepFreeze([user("msg_1"), assistant("msg_build", "build"), current])

      const next = yield* derive(messages, plan)

      const appended = next.find((message) => message.info.id === "msg_2")!.parts
      expect(appended).toHaveLength(1)
      expect(appended[0]).toMatchObject({ type: "text", text: PROMPT_PLAN, synthetic: true })
      expect(current.parts).toHaveLength(0)
    }),
  )

  it.effect("matches the previous implementation for the non-experimental scenarios", () =>
    Effect.gen(function* () {
      const scenarios: Array<[string, SessionV1.WithParts[], Agent.Info]> = [
        ["plan prompt", [user("msg_1"), assistant("msg_build", "build"), user("msg_2")], plan],
        ["leave plan", [user("msg_1"), assistant("msg_plan", "plan"), user("msg_2")], build],
        [
          "existing switch",
          [user("msg_1"), assistant("msg_plan", "plan"), user("msg_2", [textPart("prt_switch", BUILD_SWITCH)])],
          build,
        ],
        ["stale plan", [user("msg_1"), assistant("msg_plan", "plan"), assistant("msg_b", "build"), user("msg_2")], build],
      ]
      for (const [name, messages, agent] of scenarios) {
        const frozen = deepFreeze(structuredClone(messages))
        const actual = yield* derive(frozen, agent)
        const expected = yield* legacy({ messages, agent, experimental: false, tools: [], persist: (part) => part })
        expect(stripIDs(actual), name).toEqual(stripIDs(expected))
      }
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
        expect(persisted[0]).toMatchObject({ type: "text", text: BUILD_SWITCH, synthetic: true })
        const appended = next.find((message) => message.info.id === "msg_2")!.parts
        expect(appended).toHaveLength(1)
        expect(appended[0].type === "text" && appended[0].text).toBe(BUILD_SWITCH)
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
            experimental: true,
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