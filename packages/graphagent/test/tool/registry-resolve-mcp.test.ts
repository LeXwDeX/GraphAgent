// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer, Logger, Schema } from "effect"
import { dynamicTool, jsonSchema } from "ai"
import { Client } from "@modelcontextprotocol/client"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { ModelV2 } from "@graphagent/core/model"
import { ProjectV2 } from "@graphagent/core/project"
import { ProviderV2 } from "@graphagent/core/provider"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { MCP_RESOURCE_ORDER, MCP_RESOURCE_TOOLS } from "@/tool/mcp-resource"
import { ROOT_ONLY_TOOLS, type DirectTool } from "@/tool/pipeline"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".agents")])),
})

const mcpTool = (server: string, name: string) =>
  McpCatalog.bindTool(
    dynamicTool({
      description: `remote ${name}`,
      inputSchema: jsonSchema({ type: "object", properties: { value: { type: "string" } } }),
      execute: async () => ({ content: [] }),
    }),
    { server, tool: name, source: "fixture" },
  )

const resourceClient = Object.assign(new Client({ name: "fixture", version: "0" }), {
  getServerCapabilities: () => ({ resources: {} }),
})

let mcpTools: Record<string, ReturnType<typeof mcpTool>> = {
  // The server exports the same key as the built-in `read`; the MCP tool wins.
  read: mcpTool("fixture", "read"),
  zzz_remote: mcpTool("fixture", "zzz"),
  aaa_remote: mcpTool("fixture", "aaa"),
}

const sessionInfo = (directory: string, overrides: Partial<Session.Info> = {}): Session.Info =>
  ({
    id: SessionID.make("ses_registry_mcp"),
    slug: "registry-mcp",
    projectID: ProjectV2.ID.global,
    directory,
    title: "registry mcp",
    version: "1.0.0",
    time: { created: 1, updated: 1 },
    ...overrides,
  }) as Session.Info

const directShell = {
  id: "bash",
  description: "Execute an explicit user shell command",
  parameters: Schema.Struct({ command: Schema.String }),
  // The registry must publish direct-shell entries as `unknown` regardless of
  // what the definition claims: the command text decides the effect.
  effects: "workspace_write",
  execute: () => Effect.succeed({ title: "bash", metadata: {}, output: "ok" }),
} satisfies DirectTool

// Deterministic LCG shuffle so repeated runs cover the same insertion orders.
const shuffledKeys = (keys: string[], seed: number) => {
  const result = [...keys]
  let state = seed
  for (let index = result.length - 1; index > 0; index--) {
    state = (state * 1664525 + 1013904223) % 4294967296
    const swap = state % (index + 1)
    ;[result[index], result[swap]] = [result[swap], result[index]]
  }
  return result
}

const mcpLayer = Layer.mock(MCP.Service, {
  clients: () => Effect.succeed({ fixture: resourceClient }),
  tools: () => Effect.succeed(mcpTools),
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
const it = testEffect(LayerNode.buildLayer(root, { replacements }))

const setup = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  const agents = yield* Agent.Service
  const build = yield* agents.get("build")
  if (!build) throw new Error("build agent not found")
  const directory = yield* InstanceState.directory
  const model = ProviderTest.model({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") })
  return { registry, build, directory, model }
})

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry MCP resolution", () => {
  it.instance("lets an MCP tool override a same-name built-in, orders MCP tools, and appends resource helpers", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("build agent not found")
      const directory = yield* InstanceState.directory
      const session = {
        id: SessionID.make("ses_registry_mcp"),
        slug: "registry-mcp",
        projectID: ProjectV2.ID.global,
        directory,
        title: "registry mcp",
        version: "1.0.0",
        time: { created: 1, updated: 1 },
      } as Session.Info
      const model = ProviderTest.model({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") })
      const logs: string[] = []
      const logger = Logger.make((options) => logs.push(JSON.stringify(options.message)))
      const entries = yield* registry.resolve({ model, agent: build, session }).pipe(Effect.withLogger(logger))
      const ids = entries.map((entry) => entry.id)

      // The MCP tool wins the name (the pre-registry merge assigned
      // `tools[key] = item` after the built-ins), so exactly one `read`
      // remains and it is sourced from the server.
      expect(ids.filter((id) => id === "read")).toHaveLength(1)
      expect(entries.find((entry) => entry.id === "read")?.source).toMatchObject({
        kind: "mcp",
        server: "fixture",
        tool: "read",
        canonicalName: "mcp__fixture__read",
      })
      expect(logs.join("\n")).toContain("collides with a built-in tool")
      expect(logs.join("\n")).toContain("read")

      // MCP tools follow their keys in locale order, after every built-in.
      expect(ids.indexOf("aaa_remote")).toBeLessThan(ids.indexOf("zzz_remote"))
      expect(ids.indexOf("zzz_remote")).toBeLessThan(ids.indexOf(MCP_RESOURCE_TOOLS.list))
      const aaa = entries.find((entry) => entry.id === "aaa_remote")
      expect(aaa?.source).toMatchObject({
        kind: "mcp",
        server: "fixture",
        tool: "aaa",
        source: "fixture",
        canonicalName: "mcp__fixture__aaa",
      })
      expect(aaa?.effects).toBe("unknown")

      // Resource helpers keep their fixed order and read-only effects.
      expect(ids.slice(-MCP_RESOURCE_ORDER.length)).toEqual(MCP_RESOURCE_ORDER.map((op) => MCP_RESOURCE_TOOLS[op]))
      for (const op of MCP_RESOURCE_ORDER) {
        const entry = entries.find((item) => item.id === MCP_RESOURCE_TOOLS[op])
        expect(entry?.source).toMatchObject({ kind: "mcp-resource", op })
        expect(entry?.effects).toBe("read")
      }

      // A second resolution is byte-identical.
      const again = yield* registry.resolve({ model, agent: build, session })
      expect(JSON.stringify(again.map((entry) => entry.id))).toBe(JSON.stringify(ids))
    }),
  )

  it.instance("filters tools denied by permission policy and per-message user switches", () =>
    Effect.gen(function* () {
      const { registry, build, directory, model } = yield* setup
      const session = sessionInfo(directory)

      // A wildcard deny on the `read` permission removes the read family: the
      // MCP `read` replacement plus every MCP resource helper.
      const denied = yield* registry.resolve({
        model,
        agent: build,
        session,
        permission: [{ permission: "read", pattern: "*", action: "deny" }],
      })
      const deniedIds = denied.map((entry) => entry.id)
      expect(deniedIds).not.toContain("read")
      for (const op of MCP_RESOURCE_ORDER) expect(deniedIds).not.toContain(MCP_RESOURCE_TOOLS[op])
      expect(deniedIds).toContain("grep")
      expect(deniedIds).toContain("aaa_remote")

      // Per-message switches are keyed by the model-facing tool id.
      const switched = yield* registry.resolve({
        model,
        agent: build,
        session,
        user: { tools: { read: false, aaa_remote: false, zzz_remote: true } },
      })
      const switchedIds = switched.map((entry) => entry.id)
      expect(switchedIds).not.toContain("read")
      expect(switchedIds).not.toContain("aaa_remote")
      expect(switchedIds).toContain("zzz_remote")
    }),
  )

  it.instance("drops root-only tools in child sessions", () =>
    Effect.gen(function* () {
      const { registry, build, directory, model } = yield* setup
      const rootIds = (yield* registry.resolve({ model, agent: build, session: sessionInfo(directory) })).map(
        (entry) => entry.id,
      )
      for (const id of ROOT_ONLY_TOOLS) expect(rootIds).toContain(id)

      const child = yield* registry.resolve({
        model,
        agent: build,
        session: sessionInfo(directory, { parentID: SessionID.make("ses_registry_parent") }),
      })
      const childIds = child.map((entry) => entry.id)
      for (const id of ROOT_ONLY_TOOLS) expect(childIds).not.toContain(id)
      expect(childIds).toContain("read")
    }),
  )

  it.instance("skips MCP tools without a source binding", () =>
    Effect.gen(function* () {
      const { registry, build, directory, model } = yield* setup
      const original = mcpTools
      const logs: string[] = []
      const logger = Logger.make((options) => logs.push(JSON.stringify(options.message)))
      try {
        mcpTools = {
          ...original,
          orphan_remote: dynamicTool({
            description: "unbound remote",
            inputSchema: jsonSchema({ type: "object", properties: {} }),
            execute: async () => ({ content: [] }),
          }),
        }
        const entries = yield* registry
          .resolve({ model, agent: build, session: sessionInfo(directory) })
          .pipe(Effect.withLogger(logger))
        const ids = entries.map((entry) => entry.id)
        expect(ids).not.toContain("orphan_remote")
        expect(ids).toContain("aaa_remote")
        expect(logs.join("\n")).toContain("MCP tool has no source binding; skipping an unresolvable tool")
      } finally {
        mcpTools = original
      }
    }),
  )

  it.instance("keeps the resolved tool order stable across MCP registration orders", () =>
    Effect.gen(function* () {
      const { registry, build, directory, model } = yield* setup
      const original = mcpTools
      try {
        const baseline = (yield* registry.resolve({ model, agent: build, session: sessionInfo(directory) })).map(
          (entry) => entry.id,
        )
        const keys = Object.keys(original)
        for (let attempt = 1; attempt <= 20; attempt++) {
          mcpTools = Object.fromEntries(shuffledKeys(keys, attempt * 7919).map((key) => [key, original[key]]))
          const ids = (yield* registry.resolve({ model, agent: build, session: sessionInfo(directory) })).map(
            (entry) => entry.id,
          )
          expect(ids).toEqual(baseline)
        }
      } finally {
        mcpTools = original
      }
    }),
  )

  it.instance("resolves direct-shell entries as unknown-effect and bypasses policy filters", () =>
    Effect.gen(function* () {
      const { registry, build, directory, model } = yield* setup
      const entries = yield* registry.resolve({
        directTool: directShell,
        model,
        agent: build,
        session: sessionInfo(directory),
        permission: [{ permission: "*", pattern: "*", action: "deny" }],
        user: { tools: { bash: false } },
      })
      expect(entries).toHaveLength(1)
      const entry = entries[0]
      expect(entry.id).toBe("bash")
      expect(entry.source).toEqual({ kind: "direct-shell" })
      expect(entry.effects).toBe("unknown")
      expect(entry.jsonSchema).toMatchObject({ type: "object" })
      if (!("definition" in entry)) throw new Error("Expected a definition-bearing entry")
      expect(entry.definition.jsonSchema).toMatchObject({ type: "object" })
    }),
  )
})

// `definition.effects ?? "unknown"` is unreachable with the real built-in set:
// every shipped tool declares effects. Probe it in a child process so the
// module mock cannot leak into the shared bun test process.
test("defaults an undeclared built-in effect to unknown", async () => {
  const probe = path.join(import.meta.dir, "fixtures", "registry-effects-probe.ts")
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
  if (exitCode !== 0) throw new Error(`effects probe failed (${exitCode})\n${stderr}\n${stdout}`)
  const line = stdout.split("\n").find((item) => item.startsWith("EFFECTS_RESULT "))
  if (!line) throw new Error(`effects probe produced no result\n${stderr}\n${stdout}`)
  expect(JSON.parse(line.slice("EFFECTS_RESULT ".length))).toEqual({
    id: "invalid",
    effects: "unknown",
    declared: null,
    source: { kind: "builtin", registrationID: "builtin:0:invalid" },
  })
}, 60_000)
