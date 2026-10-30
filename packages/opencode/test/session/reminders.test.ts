import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionReminders } from "@/session/reminders"
import { SessionID } from "@/session/schema"
import BUILD_SWITCH from "@/session/prompt/build-switch.txt"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("ses_reminders")

const layer = Layer.mergeAll(
  RuntimeFlags.layer({ experimentalPlanMode: false }),
  FSUtil.defaultLayer,
  Layer.mock(Session.Service, {}),
)
const it = testEffect(layer)

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

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const apply = (messages: SessionV1.WithParts[]) =>
  SessionReminders.apply({
    messages,
    agent: build,
    session: {} as Session.Info,
    tools: [],
  })

describe("session.reminders plan transition", () => {
  it.effect("injects the build switch once on the turn that leaves plan mode", () =>
    Effect.gen(function* () {
      const first = user("msg_1")
      const current = user("msg_2")
      const messages = [first, assistant("msg_plan", "plan"), current]

      yield* apply(messages)
      yield* apply(messages)

      const switches = current.parts.filter(
        (part) => part.type === "text" && part.synthetic === true && part.text === BUILD_SWITCH,
      )
      expect(switches).toHaveLength(1)
      expect(first.parts).toHaveLength(0)
    }),
  )

  it.effect("does not re-inject the switch on later build turns", () =>
    Effect.gen(function* () {
      const switched = user("msg_2", [
        {
          id: "prt_switch",
          sessionID,
          messageID: "msg_2",
          type: "text",
          text: BUILD_SWITCH,
          synthetic: true,
        } as SessionV1.Part,
      ])
      const current = user("msg_3")
      const messages = [user("msg_1"), assistant("msg_plan", "plan"), switched, assistant("msg_build", "build"), current]

      yield* apply(messages)

      expect(current.parts).toHaveLength(0)
    }),
  )

  it.effect("ignores a plan turn that is not the last assistant message", () =>
    Effect.gen(function* () {
      const current = user("msg_2")
      const messages = [user("msg_1"), assistant("msg_plan", "plan"), assistant("msg_build", "build"), current]

      yield* apply(messages)

      expect(current.parts).toHaveLength(0)
    }),
  )
})
