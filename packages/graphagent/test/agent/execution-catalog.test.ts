// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// Issue #1357: which agents of the catalog the hard constraints of task execution cover. The constraints
// themselves are covered by task-execution.test.ts; this file reads them over the agents as the catalog returns them.

import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LocationServiceMap } from "@graphagent/core/location-layer"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { Skill } from "@/skill"
import { TaskExecution } from "@/tool/task-execution"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Agent.layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provideMerge(Config.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(LocationServiceMap.layer),
    Layer.provide(RuntimeFlags.layer({})),
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const constrained = (agents: ReadonlyArray<Agent.Info>) =>
  Object.fromEntries(
    agents.flatMap((agent) => {
      const constraint = TaskExecution.constraintOf(agent)
      return constraint === undefined ? [] : [[agent.name, constraint.id] as const]
    }),
  )

// F-1 covers the interactive agents, the ones whose own rules name `question` or `plan_exit` and allow it: build
// and plan. F-2 covers compaction, which rewrites the context the main agent works from. title and summary are
// internal one-shot generators, not delegation targets, and every worker agent leaves the choice to the call.
it.instance("the built-in agents the hard constraints cover are build, plan and compaction", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service.use((svc) => svc.list())
    expect(constrained(agents)).toEqual({ build: "F-1", plan: "F-1", compaction: "F-2" })
  }),
)

it.instance("every worker agent can be backgrounded: none of them is interactive", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service.use((svc) => svc.list())
    const workers = ["general", "explore", "researcher", "architect", "prototyper", "review", "auditor"]
    for (const name of workers) {
      const agent = agents.find((item) => item.name === name)
      expect(agent, name).toBeDefined()
      expect(TaskExecution.constraintOf(agent!), name).toBeUndefined()
    }
  }),
)

// A user who opts an agent in by naming `question` makes it interactive: the rule follows the effective rules, not a
// name. A blanket `"*": "allow"` is not an opt-in.
it.instance(
  "a custom agent that names question is constrained; a blanket allow and no rule are not",
  () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service.use((svc) => svc.list())
      expect(constrained(agents)).toMatchObject({ "custom-asker": "F-1" })
      expect(constrained(agents)).not.toHaveProperty("custom-quiet")
      expect(constrained(agents)).not.toHaveProperty("custom-open")
    }),
  {
    config: {
      agent: {
        "custom-asker": { description: "Asks questions", mode: "subagent", permission: { question: "allow" } },
        "custom-quiet": { description: "Asks nothing", mode: "subagent" },
        "custom-open": { description: "Allows everything", mode: "subagent", permission: { "*": "allow" } },
      },
    },
  },
)
