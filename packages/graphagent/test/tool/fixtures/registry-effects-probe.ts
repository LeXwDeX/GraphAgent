// Standalone probe: bun's `mock.module` is process-wide, so removing the
// built-in `invalid` tool's `effects` declaration here keeps the shared test
// process untouched. The real ToolRegistry must then fall back to "unknown".
//
// Everything below the mock installation is imported dynamically on purpose:
// a static import of a module that reaches `src/tool/registry.ts` would load
// the real `invalid` module before the mock can intercept it.
import path from "node:path"

const invalidPath = path.resolve(import.meta.dir, "../../../src/tool/invalid.ts")

const { Effect, Layer, Schema } = await import("effect")
const Tool = await import("../../../src/tool/tool")

const parameters = Schema.Struct({ tool: Schema.String, error: Schema.String })
const InvalidTool = Tool.define(
  "invalid",
  Effect.succeed({
    description: "Do not use",
    parameters,
    execute: (input: { tool: string; error: string }) =>
      Effect.succeed({ title: "Invalid Tool", output: `mock: ${input.error}`, metadata: {} }),
  }),
)

const { mock } = await import("bun:test")
void mock.module(invalidPath, () => ({ InvalidTool, Parameters: parameters }))

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
    id: SessionID.make("ses_registry_effects_probe"),
    slug: "registry-effects-probe",
    projectID: ProjectV2.ID.global,
    directory,
    title: "registry effects probe",
    version: "1.0.0",
    time: { created: 1, updated: 1 },
  } as import("@/session/session").Session.Info
  const model = ProviderTest.model({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") })
  const entries = yield* registry.resolve({ model, agent: build, session })
  const entry = entries.find((item) => item.id === "invalid")
  return {
    id: entry?.id ?? null,
    effects: entry?.effects ?? null,
    // Only definition-bearing entries (built-in / direct-shell) declare effects.
    declared: entry && "definition" in entry ? (entry.definition.effects ?? null) : null,
    source: entry?.source ?? null,
  }
})

const result = await Effect.runPromise(
  program.pipe(withTmpdirInstance(), Effect.scoped, Effect.provide(LayerNode.buildLayer(root, { replacements }))),
)

await disposeAllInstances()
console.log("EFFECTS_RESULT " + JSON.stringify(result))
process.exit(0)
