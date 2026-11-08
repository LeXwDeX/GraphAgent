import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer, Logger } from "effect"
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

const mcpTools = {
  // The server exports the same key as the built-in `read`; the MCP tool wins.
  read: mcpTool("fixture", "read"),
  zzz_remote: mcpTool("fixture", "zzz"),
  aaa_remote: mcpTool("fixture", "aaa"),
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
})
