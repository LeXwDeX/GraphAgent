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
import type { PermissionV1 } from "@graphagent/core/v1/permission"
import { ProviderV2 } from "@graphagent/core/provider"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { MCP_DEFERRED_TOOLS } from "@/tool/mcp-deferred"
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

const mcpTool = (server: string, name: string, baseKey?: string, deferred?: boolean, description?: string) =>
  McpCatalog.bindTool(
    dynamicTool({
      description: description ?? `remote ${name}`,
      inputSchema: jsonSchema({ type: "object", properties: { value: { type: "string" } } }),
      execute: async () => ({ content: [] }),
    }),
    {
      server,
      tool: name,
      source: "fixture",
      ...(baseKey === undefined ? {} : { baseKey }),
      ...(deferred === true ? { deferred } : {}),
    },
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
    role: overrides.parentID ? "task_child" : "root",
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
        role: "root",
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

  it.instance("hides a rewritten MCP key by a deny of the key it had before; an ask or another key does not", () =>
    Effect.gen(function* () {
      const { registry, build, directory, model } = yield* setup
      const original = mcpTools
      const session = sessionInfo(directory)
      const resolveIds = (permission: PermissionV1.Ruleset) =>
        registry
          .resolve({ model, agent: build, session, permission })
          .pipe(Effect.map((entries) => entries.map((e) => e.id)))
      try {
        // Server `mcp`'s `call` is a reserved name, so it got a hash suffix: its key was `mcp_call` before (#1459).
        mcpTools = { ...original, mcp_call_1a2b3c4d: mcpTool("mcp", "call", "mcp_call") }

        const everything = yield* resolveIds([])
        expect(everything).toContain("mcp_call_1a2b3c4d")

        // A deny written for the old key hides the tool, whatever else the rules say about the new key.
        expect(yield* resolveIds([{ permission: "mcp_call", pattern: "*", action: "deny" }])).not.toContain(
          "mcp_call_1a2b3c4d",
        )
        expect(yield* resolveIds([{ permission: "mcp_*", pattern: "*", action: "deny" }])).not.toContain(
          "mcp_call_1a2b3c4d",
        )
        // The new key's own deny hides it as before; an ask, an allow and a rule about another key do not.
        expect(yield* resolveIds([{ permission: "mcp_call_1a2b3c4d", pattern: "*", action: "deny" }])).not.toContain(
          "mcp_call_1a2b3c4d",
        )
        for (const rule of [
          { permission: "mcp_call", pattern: "*", action: "ask" as const },
          { permission: "mcp_call", pattern: "*", action: "allow" as const },
          { permission: "mcp_other", pattern: "*", action: "deny" as const },
        ])
          expect(yield* resolveIds([rule])).toContain("mcp_call_1a2b3c4d")
        // A later allow for the old key lifts the deny, as it always did.
        expect(
          yield* resolveIds([
            { permission: "mcp_call", pattern: "*", action: "deny" },
            { permission: "mcp_call", pattern: "*", action: "allow" },
          ]),
        ).toContain("mcp_call_1a2b3c4d")
        // Nothing else is hidden by the old key's deny.
        expect(yield* resolveIds([{ permission: "mcp_call", pattern: "*", action: "deny" }])).toEqual(
          everything.filter((id) => id !== "mcp_call_1a2b3c4d"),
        )
      } finally {
        mcpTools = original
      }
    }),
  )

  it.instance("carries the old key only on a rewritten MCP key, and a plain key's source is unchanged", () =>
    Effect.gen(function* () {
      const { registry, build, directory, model } = yield* setup
      const original = mcpTools
      try {
        mcpTools = { ...original, mcp_call_1a2b3c4d: mcpTool("mcp", "call", "mcp_call") }
        const entries = yield* registry.resolve({ model, agent: build, session: sessionInfo(directory) })
        expect(entries.find((entry) => entry.id === "mcp_call_1a2b3c4d")?.source).toEqual({
          kind: "mcp",
          server: "mcp",
          tool: "call",
          source: "fixture",
          canonicalName: "mcp__mcp__call",
          requiresUserInteraction: false,
          baseKey: "mcp_call",
        })
        // A tool whose key never changed has exactly the source it had before: no `baseKey` at all.
        expect(entries.find((entry) => entry.id === "aaa_remote")?.source).toEqual({
          kind: "mcp",
          server: "fixture",
          tool: "aaa",
          source: "fixture",
          canonicalName: "mcp__fixture__aaa",
          requiresUserInteraction: false,
        })
      } finally {
        mcpTools = original
      }
    }),
  )

  describe("deferred servers (#1459)", () => {
    const DESCRIBE = MCP_DEFERRED_TOOLS.describe
    const CALL = MCP_DEFERRED_TOOLS.call
    const LONG =
      "A very long first sentence that keeps going and going without any stop so the line has to be cut " +
      "x".repeat(60)
    // Two deferred tools and one that is not, beside the suite's eager ones.
    const withDeferred = () => ({
      ...mcpTools,
      zdef_remote: mcpTool("fixture", "zdef", undefined, true, "Zed does it. Then something else."),
      adef_remote: mcpTool("fixture", "adef", undefined, true, "Alpha\ndoes it. Second line."),
      long_remote: mcpTool("fixture", "long", undefined, true, LONG),
      blank_remote: mcpTool("fixture", "blank", undefined, true, ""),
    })
    const idsOf = (entries: ReadonlyArray<{ id: string }>) => entries.map((entry) => entry.id)

    it.instance("keeps deferred tools among the entries and adds the two helpers last, with a one-line catalog", () =>
      Effect.gen(function* () {
        const { registry, build, directory, model } = yield* setup
        const original = mcpTools
        try {
          mcpTools = withDeferred()
          const entries = yield* registry.resolve({ model, agent: build, session: sessionInfo(directory) })
          const ids = idsOf(entries)

          // A deferred tool is still an entry, marked so; an eager one has no mark at all.
          for (const id of ["zdef_remote", "adef_remote", "long_remote", "blank_remote"]) {
            expect(entries.find((entry) => entry.id === id)?.source).toMatchObject({ kind: "mcp", deferred: true })
          }
          expect(entries.find((entry) => entry.id === "aaa_remote")?.source).not.toHaveProperty("deferred")

          // The helpers come after every other entry, the resource helpers included: describe, then call.
          expect(ids.slice(-2)).toEqual([DESCRIBE, CALL])
          const describe = entries.find((entry) => entry.id === DESCRIBE)
          const call = entries.find((entry) => entry.id === CALL)
          expect(describe?.source).toEqual({
            kind: "mcp-deferred",
            op: "describe",
            registrationID: `mcp-deferred:${DESCRIBE}`,
          })
          expect(call?.source).toEqual({ kind: "mcp-deferred", op: "call", registrationID: `mcp-deferred:${CALL}` })
          expect(describe?.effects).toBe("read")
          expect(call?.effects).toBe("unknown")
          expect(call?.description).toBe("Call a deferred MCP tool by its catalog name.")

          // The catalog is the description of mcp_describe: one line per deferred tool, by key, first sentence only.
          const lines = (describe?.description ?? "").split("\n")
          expect(lines.slice(0, 2)).toEqual([
            "Read the input schema of deferred MCP tools before calling them with mcp_call.",
            "Deferred tools:",
          ])
          expect(lines.slice(2)).toEqual([
            "- adef_remote: Alpha",
            "- blank_remote: (no description)",
            `- long_remote: ${Array.from(LONG)
              .slice(0, 120 - "- long_remote: ".length - 1)
              .join("")}…`,
            "- zdef_remote: Zed does it.",
          ])
          for (const line of lines.slice(2)) expect(Array.from(line).length).toBeLessThanOrEqual(120)

          // Both helpers take an object with required fields and refuse anything else. The test model is an OpenAI one,
          // whose schemas lose `minItems` and `maxItems` in the provider's rewrite, like every other tool's.
          expect(describe?.jsonSchema).toMatchObject({
            type: "object",
            required: ["tools"],
            additionalProperties: false,
            properties: { tools: { type: "array", items: { type: "string" } } },
          })
          expect(call?.jsonSchema).toMatchObject({
            type: "object",
            required: ["tool"],
            additionalProperties: false,
            properties: { tool: { type: "string" }, arguments: { type: "object" } },
          })
        } finally {
          mcpTools = original
        }
      }),
    )

    it.instance(
      "puts the helpers' schemas through the provider's rewrite, and keeps their bounds where it keeps them",
      () =>
        Effect.gen(function* () {
          const { registry, build, directory } = yield* setup
          const original = mcpTools
          const other = ProviderTest.model({
            providerID: ProviderV2.ID.make("test"),
            id: ModelV2.ID.make("test-model"),
            api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/anthropic" },
          })
          try {
            mcpTools = withDeferred()
            const entries = yield* registry.resolve({ model: other, agent: build, session: sessionInfo(directory) })
            expect(entries.find((entry) => entry.id === DESCRIBE)?.jsonSchema).toMatchObject({
              properties: { tools: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 } },
            })
          } finally {
            mcpTools = original
          }
        }),
    )

    it.instance("adds no helper and changes nothing while no server is deferred", () =>
      Effect.gen(function* () {
        const { registry, build, directory, model } = yield* setup
        const ids = idsOf(yield* registry.resolve({ model, agent: build, session: sessionInfo(directory) }))
        expect(ids).not.toContain(DESCRIBE)
        expect(ids).not.toContain(CALL)
        // The eager tools and the resource helpers end the list, as before.
        expect(ids.slice(-MCP_RESOURCE_ORDER.length)).toEqual(MCP_RESOURCE_ORDER.map((op) => MCP_RESOURCE_TOOLS[op]))
      }),
    )

    it.instance("lists only the deferred tools the agent may use and the user left on", () =>
      Effect.gen(function* () {
        const { registry, build, directory, model } = yield* setup
        const original = mcpTools
        const catalogOf = (entries: ReadonlyArray<{ id: string; description: string }>) =>
          (entries.find((entry) => entry.id === DESCRIBE)?.description ?? "")
            .split("\n")
            .filter((line) => line.startsWith("- "))
            .map((line) => line.slice(2, line.indexOf(":")))
        try {
          mcpTools = withDeferred()
          const session = sessionInfo(directory)
          // A deny hides the tool from the catalog; so does a per-message switch.
          const denied = yield* registry.resolve({
            model,
            agent: build,
            session,
            permission: [{ permission: "zdef_remote", pattern: "*", action: "deny" }],
          })
          expect(catalogOf(denied)).toEqual(["adef_remote", "blank_remote", "long_remote"])
          expect(idsOf(denied)).not.toContain("zdef_remote")
          const switched = yield* registry.resolve({
            model,
            agent: build,
            session,
            user: { tools: { adef_remote: false, blank_remote: false, long_remote: false } },
          })
          expect(catalogOf(switched)).toEqual(["zdef_remote"])

          // With no deferred tool left there is no catalog, so no helper.
          const none = yield* registry.resolve({
            model,
            agent: build,
            session,
            user: { tools: { zdef_remote: false, adef_remote: false, blank_remote: false, long_remote: false } },
          })
          expect(idsOf(none)).not.toContain(DESCRIBE)
          expect(idsOf(none)).not.toContain(CALL)
        } finally {
          mcpTools = original
        }
      }),
    )

    it.instance("hides both helpers when a rule or a switch removes either; the deferred entries stay", () =>
      Effect.gen(function* () {
        const { registry, build, directory, model } = yield* setup
        const original = mcpTools
        try {
          mcpTools = withDeferred()
          const session = sessionInfo(directory)
          const resolveIds = (extra: {
            permission?: PermissionV1.Ruleset
            user?: { tools: Record<string, boolean> }
          }) => registry.resolve({ model, agent: build, session, ...extra }).pipe(Effect.map(idsOf))
          const present = yield* resolveIds({})
          expect(present).toContain(DESCRIBE)
          expect(present).toContain(CALL)

          const hiding: Array<{ permission?: PermissionV1.Ruleset; user?: { tools: Record<string, boolean> } }> = [
            { permission: [{ permission: CALL, pattern: "*", action: "deny" }] },
            { permission: [{ permission: DESCRIBE, pattern: "*", action: "deny" }] },
            { permission: [{ permission: "mcp_*", pattern: "*", action: "deny" }] },
            { user: { tools: { [DESCRIBE]: false } } },
            { user: { tools: { [CALL]: false } } },
          ]
          for (const extra of hiding) {
            const ids = yield* resolveIds(extra)
            expect(ids).not.toContain(DESCRIBE)
            expect(ids).not.toContain(CALL)
            // The deferred tools themselves are untouched by a rule about the helpers.
            expect(ids).toContain("zdef_remote")
            expect(ids).toContain("adef_remote")
          }
          // An ask or an allow for the helpers hides nothing.
          const asked = yield* resolveIds({
            permission: [
              { permission: CALL, pattern: "*", action: "ask" },
              { permission: DESCRIBE, pattern: "*", action: "allow" },
            ],
          })
          expect(asked).toEqual(present)
        } finally {
          mcpTools = original
        }
      }),
    )

    it.instance("hides the helpers from a read-only agent whose rules start with a deny of everything", () =>
      Effect.gen(function* () {
        const { registry, build, directory, model } = yield* setup
        const original = mcpTools
        try {
          mcpTools = withDeferred()
          const entries = yield* registry.resolve({
            model,
            agent: {
              ...build,
              permission: [
                { permission: "*", pattern: "*", action: "deny" },
                { permission: "grep", pattern: "*", action: "allow" },
              ],
            },
            session: sessionInfo(directory),
          })
          const ids = idsOf(entries)
          expect(ids).toContain("grep")
          expect(ids).not.toContain("zdef_remote")
          expect(ids).not.toContain(DESCRIBE)
          expect(ids).not.toContain(CALL)
        } finally {
          mcpTools = original
        }
      }),
    )

    it.instance("keeps the tools in the same order across resolutions and registration orders", () =>
      Effect.gen(function* () {
        const { registry, build, directory, model } = yield* setup
        const original = mcpTools
        try {
          mcpTools = withDeferred()
          const baseline = idsOf(yield* registry.resolve({ model, agent: build, session: sessionInfo(directory) }))
          const keys = Object.keys(mcpTools)
          for (let attempt = 1; attempt <= 10; attempt++) {
            const shuffled = shuffledKeys(keys, attempt * 7919)
            const source = mcpTools
            mcpTools = Object.fromEntries(shuffled.map((key) => [key, source[key]]))
            const ids = idsOf(yield* registry.resolve({ model, agent: build, session: sessionInfo(directory) }))
            expect(ids).toEqual(baseline)
          }
        } finally {
          mcpTools = original
        }
      }),
    )
  })

  it.instance("drops root-only tools in child sessions", () =>
    Effect.gen(function* () {
      const { registry, build, directory, model } = yield* setup
      const rootIds = (yield* registry.resolve({ model, agent: build, session: sessionInfo(directory) })).map(
        (entry) => entry.id,
      )
      // `plan_exit` joins the registry only under plan mode (`plan` agent);
      // this suite runs with the default flags, so `build` never exposes it.
      // test/tool/root-only-dialogs.test.ts covers its root/child split.
      expect(rootIds).not.toContain("plan_exit")
      for (const id of ROOT_ONLY_TOOLS) if (id !== "plan_exit") expect(rootIds).toContain(id)

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
