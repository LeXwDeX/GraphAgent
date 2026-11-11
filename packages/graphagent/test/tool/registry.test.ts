import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { ToolRegistry, definitionKey } from "@/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { ProjectV2 } from "@graphagent/core/project"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

import { RuntimeFlags } from "@/effect/runtime-flags"
import { ModelV2 } from "@graphagent/core/model"
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

  it.instance("does not load legacy JavaScript tools from project tool directories", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const directory = yield* InstanceState.directory
      yield* Effect.promise(async () => {
        for (const name of ["tool", "tools", ".agents/tool", ".agents/tools"]) {
          const dir = path.join(directory, name)
          await mkdir(dir, { recursive: true })
          await writeFile(
            path.join(dir, "legacy.ts"),
            `export const legacy = { description: "legacy", args: {}, execute: async () => "legacy" }\n`,
          )
        }
      })

      const ids = yield* registry.ids()
      expect(ids).not.toContain("legacy")
    }),
  )

  it.instance("exposes the task background parameter unconditionally", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("build agent not found")
      const directory = yield* InstanceState.directory
      const session = {
        id: SessionID.make("ses_registry_task_background"),
        slug: "registry-task-background",
        projectID: ProjectV2.ID.global,
        directory,
        title: "registry task background",
        version: "1.0.0",
        time: { created: 1, updated: 1 },
      } as Session.Info
      const model = ProviderTest.model()
      const task = (yield* registry.resolve({ model, agent: build, session })).find((entry) => entry.id === "task")

      expect(task?.jsonSchema).toBeDefined()
      expect((task?.jsonSchema?.properties as Record<string, unknown> | undefined)?.background).toBeDefined()
    }),
  )

  it.instance("every built-in tool declares a known effects class", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("build agent not found")
      const registered = yield* registry.all()
      expect(registered.length).toBeGreaterThanOrEqual(16)
      const missing = registered
        .filter((definition) => definition.effects === undefined)
        .map((definition) => definition.id)
      expect(missing).toEqual([])
      for (const definition of registered) {
        expect(["read", "workspace_write", "unknown"]).toContain(definition.effects ?? "")
      }
      // The definition-stage rebuild used by `tools` must preserve the declaration too.
      const rebuilt = []
      for (const id of ["test-model", "gpt-5"]) {
        const model = id === "gpt-5" ? ProviderTest.model({ id: ModelV2.ID.make(id) }) : ProviderTest.model()
        rebuilt.push(...(yield* registry.tools({ providerID: model.providerID, modelID: model.id, agent: build })))
      }
      for (const definition of rebuilt) expect(definition.effects).toBeDefined()
    }),
  )

  it.instance("resolves entries deterministically in registration order", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("build agent not found")
      const directory = yield* InstanceState.directory
      const session = {
        id: SessionID.make("ses_registry_order"),
        slug: "registry-order",
        projectID: ProjectV2.ID.global,
        directory,
        title: "registry order",
        version: "1.0.0",
        time: { created: 1, updated: 1 },
      } as Session.Info
      const model = ProviderTest.model()
      const first = yield* registry.resolve({ model, agent: build, session })
      const second = yield* registry.resolve({ model, agent: build, session })
      expect(JSON.stringify(first.map((entry) => entry.id))).toBe(JSON.stringify(second.map((entry) => entry.id)))
      const order = (yield* registry.tools({ providerID: model.providerID, modelID: model.id, agent: build })).map(
        (definition) => definition.id,
      )
      const resolved = first.map((entry) => entry.id)
      expect(resolved).toEqual(order.filter((id) => resolved.includes(id)))
    }),
  )
})

// The definition-stage cache must eliminate repeated schema derivation. Probe
// it in a child process: `mock.module` is process-wide and would leak into
// every other test file.
test("reuses definition-stage work across identical resolutions", async () => {
  const probe = path.join(import.meta.dir, "fixtures", "registry-definition-cache-probe.ts")
  const proc = Bun.spawn([process.execPath, probe], {
    cwd: path.join(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error(`definition cache probe failed (${exitCode})\n${stderr}\n${stdout}`)
  const line = stdout.split("\n").find((item) => item.startsWith("CACHE_RESULT "))
  if (!line) throw new Error(`definition cache probe produced no result\n${stderr}\n${stdout}`)
  const result = JSON.parse(line.slice("CACHE_RESULT ".length))
  expect(result.firstCalls).toBeGreaterThan(0)
  expect(result.secondCalls).toBe(0)
  expect(result.sameIds).toBe(true)
  expect(result.firstKey).toBeTruthy()
  expect(result.secondKey).toBe(result.firstKey)
}, 60_000)

test("every definition-stage input invalidates the cache key", () => {
  const base = {
    origin: "directory-a",
    model: { providerID: "provider-a", id: "model-a", apiID: "api-a", npm: "@ai-sdk/test" },
    flags: { webSearch: false, lsp: false, plan: false, question: false, client: "cli", usePatch: false },
  }
  const key = definitionKey(base)
  expect(definitionKey(base)).toBe(key)

  const variants = {
    origin: { ...base, origin: "directory-b" },
    providerID: { ...base, model: { ...base.model, providerID: "provider-b" } },
    id: { ...base, model: { ...base.model, id: "model-b" } },
    apiID: { ...base, model: { ...base.model, apiID: "api-b" } },
    npm: { ...base, model: { ...base.model, npm: "@ai-sdk/other" } },
    webSearch: { ...base, flags: { ...base.flags, webSearch: true } },
    lsp: { ...base, flags: { ...base.flags, lsp: true } },
    plan: { ...base, flags: { ...base.flags, plan: true } },
    question: { ...base, flags: { ...base.flags, question: true } },
    client: { ...base, flags: { ...base.flags, client: "tui" } },
    usePatch: { ...base, flags: { ...base.flags, usePatch: true } },
  } as const
  for (const [field, variant] of Object.entries(variants)) {
    if (definitionKey(variant) === key) throw new Error(`definition key did not change for ${field}`)
  }
})
