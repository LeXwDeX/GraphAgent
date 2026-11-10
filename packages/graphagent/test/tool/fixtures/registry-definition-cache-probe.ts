// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// Standalone probe: bun's `mock.module` is process-wide, so the counter below
// lives in a child process. The second identical resolution must reuse the
// definition-stage cache and derive no tool JSON Schema again.
//
// Everything that reaches `src/tool/registry.ts` is imported dynamically on
// purpose: a static import of `json-schema.ts` would win the real implementation
// before the mock installs and the counter would miss every call.
import path from "node:path"

const jsonSchemaPath = path.resolve(import.meta.dir, "../../../src/tool/json-schema.ts")
const jsonSchema = await import("../../../src/tool/json-schema")

let fromSchemaCalls = 0
// Capture the real functions before `mock.module` replaces the module record:
// reading them back through the namespace afterwards would resolve to this mock
// and recurse forever.
const originalFromSchema = jsonSchema.ToolJsonSchema.fromSchema
const originalFromTool = jsonSchema.ToolJsonSchema.fromTool
const ToolJsonSchema = {
  fromSchema: (schema: Parameters<typeof originalFromSchema>[0]) => {
    fromSchemaCalls += 1
    return originalFromSchema(schema)
  },
  fromTool: originalFromTool,
}

const { mock } = await import("bun:test")
void mock.module(jsonSchemaPath, () => ({ ...jsonSchema, ToolJsonSchema }))

const { Effect, Layer } = await import("effect")
const { LayerNode } = await import("@graphagent/core/effect/layer-node")
const { ModelV2 } = await import("@graphagent/core/model")
const { ProjectV2 } = await import("@graphagent/core/project")
const { ProviderV2 } = await import("@graphagent/core/provider")
const { Agent } = await import("@/agent/agent")
const { Config } = await import("@/config/config")
const { InstanceState } = await import("@/effect/instance-state")
const { RuntimeFlags } = await import("@/effect/runtime-flags")
const { MCP } = await import("@/mcp")
const { SessionID } = await import("@/session/schema")
const { ToolRegistry } = await import("@/tool/registry")
const { TestConfig } = await import("../../fixture/config")
const { disposeAllInstances, withTmpdirInstance } = await import("../../fixture/fixture")
const { ProviderTest } = await import("../../fake/provider")

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".agents")])),
})

const mcpLayer = Layer.mock(MCP.Service, {
  clients: () => Effect.succeed({}),
  tools: () => Effect.succeed({}),
  resources: () => Effect.succeed({}),
  resourceTemplates: () => Effect.succeed({}),
  readResource: () => Effect.succeed(undefined),
})

const root = LayerNode.group([ToolRegistry.node, Agent.node])
const replacements = [
  LayerNode.replace(Config.node, configLayer),
  LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer()),
  LayerNode.replace(MCP.node, mcpLayer),
]

const program = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  const agents = yield* Agent.Service
  const build = yield* agents.get("build")
  if (!build) throw new Error("build agent not found")
  const directory = yield* InstanceState.directory
  const session = {
    id: SessionID.make("ses_registry_definition_probe"),
    slug: "registry-definition-probe",
    projectID: ProjectV2.ID.global,
    directory,
    title: "registry definition probe",
    version: "1.0.0",
    time: { created: 1, updated: 1 },
  } as import("@/session/session").Session.Info
  const model = ProviderTest.model({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") })

  const first = yield* registry.resolve({ model, agent: build, session })
  const firstCalls = fromSchemaCalls
  const second = yield* registry.resolve({ model, agent: build, session })
  const secondCalls = fromSchemaCalls - firstCalls

  return {
    firstCalls,
    secondCalls,
    sameIds: JSON.stringify(first.map((entry) => entry.id)) === JSON.stringify(second.map((entry) => entry.id)),
    firstKey: ToolRegistry.resolveKey(first) ?? null,
    secondKey: ToolRegistry.resolveKey(second) ?? null,
  }
})

const result = await Effect.runPromise(
  program.pipe(withTmpdirInstance(), Effect.scoped, Effect.provide(LayerNode.buildLayer(root, { replacements }))),
)

await disposeAllInstances()
console.log("CACHE_RESULT " + JSON.stringify(result))
process.exit(0)
