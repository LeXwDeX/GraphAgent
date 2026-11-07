import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"

import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderTest } from "../fake/provider"
import { SystemPrompt } from "@/session/system"
import { SessionReminders } from "@/session/reminders"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".agents")])),
})

const root = LayerNode.group([ToolRegistry.node, Agent.node])
const replacements = [
  LayerNode.replace(Config.node, configLayer),
  LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer()),
]

const it = testEffect(LayerNode.buildLayer(root, { replacements }))

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry", () => {
  for (const id of ["gpt-oss-120b", "gpt-5", "gpt-5-codex", "gpt-4.1", "Claude-Sonnet-4"])
    it.instance(`editing instructions match registered tools for ${id}`, () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const agent = yield* agents.get("plan")
        if (!agent) throw new Error("plan agent not found")
        const model = ProviderTest.model({ id: ModelV2.ID.make(id) })
        const tools = (yield* registry.tools({ modelID: model.id, providerID: model.providerID, agent })).map(
          (t) => t.id,
        )
        expect(tools.filter((name) => ["apply_patch", "edit", "write"].includes(name))).toEqual(
          id === "gpt-5" || id === "gpt-5-codex" ? ["apply_patch"] : ["edit", "write"],
        )
        for (const exists of [false, true]) {
          const text = [
            ...SystemPrompt.provider(tools),
            SessionReminders.planModePrompt({ plan: "/plans/test.md", exists, tools }),
          ].join("\n")
          const references = [...text.matchAll(/Use (apply_patch|edit(?: and write)?|write) for manual file edits\./g)]
          expect(references.length).toBeGreaterThan(0)
          for (const reference of references)
            for (const name of reference[1].split(" and ")) expect(tools).toContain(name)
          for (const name of ["apply_patch", "edit", "write"])
            if (!tools.includes(name)) expect(text).not.toContain(`using the ${name} tool`)
          expect(text).not.toContain("${")
        }
        const disabled = SystemPrompt.provider([]).join("\n")
        expect(disabled).not.toContain("apply_patch")
        const reminder = SessionReminders.planModePrompt({ plan: "/plans/test.md", exists: false, tools: [] })
        expect(reminder).not.toContain("plan_exit")
        expect(reminder).toContain("No file-editing tool is available")
        expect(
          SessionReminders.planModePrompt({ plan: "/plans/test.md", exists: true, tools: ["plan_exit"] }),
        ).toContain("Call plan_exit")
      }),
    )
  it.instance("registers agent messaging as a built-in tool", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* registry.ids()).toContain("agent")
    }),
  )

  it.instance("registers memory_search as a built-in tool", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      expect(yield* registry.ids()).toContain("memory_search")
    }),
  )

  it.instance("does not expose task_status", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).not.toContain("task_status")
    }),
  )

  it.instance("hides task background parameter unless experimental background subagents are enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      if (!build) throw new Error("build agent not found")
      const task = (yield* registry.tools({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test"),
        agent: build,
      })).find((tool) => tool.id === "task")

      expect(task?.jsonSchema).toBeDefined()
      expect((task?.jsonSchema?.properties as Record<string, unknown> | undefined)?.background).toBeUndefined()
    }),
  )
})
