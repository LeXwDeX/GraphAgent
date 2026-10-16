import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { define } from "@opencode-ai/plugin/v2/effect"
import { SkillV2 } from "@opencode-ai/core/skill"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SourceProvenance } from "@opencode-ai/core/session/source-provenance"
import { AgentV2 } from "@opencode-ai/core/agent"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

describe("PluginV2", () => {
  it.effect("waits for a plugin and returns immediately once active", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const id = PluginV2.ID.make("waited")
      const waiting = yield* plugins.wait(id).pipe(Effect.forkChild)

      yield* plugins.add(id, () => Effect.void)
      yield* Fiber.join(waiting)
      yield* plugins.wait(id)
    }),
  )

  it.effect("propagates plugin activation defects to waiters", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const id = PluginV2.ID.make("failed")
      const waiting = yield* plugins.wait(id).pipe(Effect.exit, Effect.forkChild)

      const added = yield* plugins.add(id, () => Effect.die("boom")).pipe(Effect.exit)
      const pending = yield* Fiber.join(waiting)
      const later = yield* plugins.wait(id).pipe(Effect.exit)

      expect(Exit.isFailure(added)).toBe(true)
      expect(Exit.isFailure(pending)).toBe(true)
      expect(Exit.isFailure(later)).toBe(true)
    }),
  )

  it.effect("adds, replaces, and removes plugins", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      let description = "first"

      const managed = () =>
        define({
          id: "managed",
          effect: (ctx) =>
            ctx.agent
              .transform((agents) =>
                agents.update("configured", (agent) => {
                  agent.description = description
                }),
              )
              .pipe(Effect.asVoid),
        })

      yield* plugins.add(PluginV2.ID.make("managed"), managed().effect)

      expect((yield* agents.get(AgentV2.ID.make("configured")))?.description).toBe("first")

      description = "second"
      yield* plugins.add(PluginV2.ID.make("managed"), managed().effect)
      expect((yield* agents.get(AgentV2.ID.make("configured")))?.description).toBe("second")

      yield* plugins.remove(PluginV2.ID.make("managed"))
      expect(yield* agents.get(AgentV2.ID.make("configured"))).toBeUndefined()
    }),
  )
})

it.effect("records hook provenance from the actual plugin execution boundary", () =>
  Effect.gen(function* () {
    const plugins = yield* PluginV2.Service
    const agents = yield* AgentV2.Service
    const id = PluginV2.ID.make("actual-hook-owner")
    yield* plugins.add(id, (ctx) =>
      ctx.agent
        .transform((draft) => {
          draft.update("scoped", (agent) =>
            Object.assign(agent, { hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }),
          )
        })
        .pipe(Effect.asVoid),
    )
    expect((yield* agents.get(AgentV2.ID.make("scoped")))?.hooks).toBeDefined()
    expect(SourceProvenance.agent(agents, "scoped")).toEqual({
      source: "plugin",
      origin: "actual-hook-owner:agent:scoped",
    })
    yield* agents.reload()
    expect(SourceProvenance.agent(agents, "scoped")?.source).toBe("plugin")
  }),
)

it.effect("records only actually registered plugin skill hooks as plugin sources", () =>
  Effect.gen(function* () {
    const plugins = yield* PluginV2.Service
    const skills = yield* SkillV2.Service
    yield* plugins.add(PluginV2.ID.make("actual-skill-owner"), (ctx) =>
      ctx.skill
        .transform((draft) => {
          draft.source({
            type: "embedded",
            skill: SkillV2.Info.make({
              name: "plugin-hook-skill",
              location: AbsolutePath.make("/fixture/plugin/SKILL.md"),
              content: "fixture",
              hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] },
            }),
          })
        })
        .pipe(Effect.asVoid),
    )
    const loaded = (yield* skills.list()).find((item) => item.name === "plugin-hook-skill")
    expect(loaded?.hooks).toBeDefined()
    expect(loaded && SourceProvenance.skill(loaded)).toEqual({
      source: "plugin",
      origin: "actual-skill-owner:skill:embedded:plugin-hook-skill",
    })
  }),
)
