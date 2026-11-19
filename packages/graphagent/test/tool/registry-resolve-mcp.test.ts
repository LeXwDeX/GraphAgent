// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer, Logger, Schema } from "effect"
import { dynamicTool, jsonSchema } from "ai"
import { Client } from "@modelcontextprotocol/client"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { EventV2 } from "@graphagent/core/event"
import { ModelV2 } from "@graphagent/core/model"
import type { ModelProfile } from "@graphagent/core/model-profile"
import { ProjectV2 } from "@graphagent/core/project"
import type { PermissionV1 } from "@graphagent/core/v1/permission"
import { ProviderV2 } from "@graphagent/core/provider"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { ProviderProfile } from "@/provider/profile"
import { TuiEvent } from "@/server/tui-event"
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

const mcpTool = (
  server: string,
  name: string,
  baseKey?: string,
  deferred?: boolean,
  description?: string,
  readOnly?: boolean,
) =>
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
      ...(readOnly === true ? { readOnly } : {}),
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

// The toasts the registry publishes, in order. A test that reads them starts from an empty list.
type Toast = { title?: string; message: string; variant: string; duration?: number }
const toasts: Toast[] = []

const isToast = (data: unknown): data is Toast =>
  typeof data === "object" && data !== null && "message" in data && "variant" in data

// The real bridge, except that it keeps what is published as a toast.
const capturingBridge = Layer.effect(
  EventV2Bridge.Service,
  Effect.gen(function* () {
    const original = yield* EventV2Bridge.Service
    const publish: EventV2.Interface["publish"] = (definition, data, options) => {
      if (definition.type === TuiEvent.ToastShow.type && isToast(data)) toasts.push(data)
      return original.publish(definition, data, options)
    }
    return EventV2Bridge.Service.of({ ...original, publish })
  }),
).pipe(Layer.provide(EventV2Bridge.layer))

const root = LayerNode.group([ToolRegistry.node, Agent.node])
const replacements = [
  LayerNode.replace(Config.node, configLayer),
  LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer()),
  LayerNode.replace(MCP.node, mcpLayer),
  LayerNode.replaceWithNode(EventV2Bridge.node, LayerNode.make(capturingBridge, [EventV2.node])),
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

  describe("read-only MCP tools (#1454)", () => {
    const READ_ONLY_AGENTS = ["explore", "researcher", "architect", "review", "auditor"]
    // Two tools that declare `readOnlyHint` when `readOnly` is set and one that never does, beside the suite's own.
    const fixture = (readOnly: boolean) => ({
      ...mcpTools,
      ro_lookup: mcpTool("ro", "lookup", undefined, undefined, undefined, readOnly),
      ro_other: mcpTool("ro", "other", undefined, undefined, undefined, readOnly),
      rw_update: mcpTool("rw", "update"),
    })
    // Runs `body` with `tools` as the MCP tools, and puts the suite's own back.
    const withTools = <A, E, R>(tools: Record<string, ReturnType<typeof mcpTool>>, body: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const original = mcpTools
        mcpTools = tools
        return body.pipe(Effect.ensuring(Effect.sync(() => (mcpTools = original))))
      })
    const agentNamed = (name: string) =>
      Agent.Service.use((agents) => agents.get(name)).pipe(
        Effect.flatMap((agent) =>
          agent ? Effect.succeed(agent) : Effect.die(new Error(`Expected the ${name} agent`)),
        ),
      )
    const deny = (permission: string): PermissionV1.Rule => ({ permission, pattern: "*", action: "deny" })
    // What the registry resolves for `agent`, with `permission` as the rules of the session.
    const resolved = (agent: Agent.Info, permission: PermissionV1.Ruleset = []) =>
      Effect.gen(function* () {
        const { registry, directory, model } = yield* setup
        return yield* registry.resolve({ model, agent, session: sessionInfo(directory), permission })
      })
    const idsOf = (agent: Agent.Info, permission: PermissionV1.Ruleset = []) =>
      resolved(agent, permission).pipe(Effect.map((entries) => entries.map((entry) => entry.id)))

    it.instance(
      "the five read-only built-in subagents see a tool that declares readOnlyHint and no other MCP tool",
      () =>
        withTools(
          fixture(true),
          Effect.gen(function* () {
            for (const name of READ_ONLY_AGENTS) {
              const entries = yield* resolved(yield* agentNamed(name))
              const ids = entries.map((entry) => entry.id)
              expect(ids, name).toContain("ro_lookup")
              expect(ids, name).toContain("ro_other")
              // A tool that did not declare it stays hidden, the suite's own among them.
              for (const hidden of ["rw_update", "aaa_remote", "zzz_remote"])
                expect(ids, `${name} ${hidden}`).not.toContain(hidden)
              // The entry says it declared the hint.
              expect(entries.find((entry) => entry.id === "ro_lookup")?.source).toEqual({
                kind: "mcp",
                server: "ro",
                tool: "lookup",
                source: "fixture",
                canonicalName: "mcp__ro__lookup",
                requiresUserInteraction: false,
                readOnly: true,
              })
            }
          }),
        ),
    )

    it.instance("every other agent resolves as before: build and general see every MCP tool, the rest none", () =>
      Effect.gen(function* () {
        // The same tools with and without the hint resolve to the same ids for the agents that are not among the five.
        for (const name of ["build", "plan", "general", "prototyper", "surveyor", "mapper"]) {
          const agent = yield* agentNamed(name)
          const without = yield* withTools(fixture(false), idsOf(agent))
          const declared = yield* withTools(fixture(true), idsOf(agent))
          expect(declared, name).toEqual(without)
        }
        yield* withTools(
          fixture(true),
          Effect.gen(function* () {
            for (const name of ["build", "general"]) {
              const ids = yield* idsOf(yield* agentNamed(name))
              for (const id of ["ro_lookup", "ro_other", "rw_update", "aaa_remote"])
                expect(ids, `${name} ${id}`).toContain(id)
            }
            for (const name of ["prototyper", "surveyor", "mapper"]) {
              const ids = yield* idsOf(yield* agentNamed(name))
              for (const id of ["ro_lookup", "ro_other", "rw_update"]) expect(ids, `${name} ${id}`).not.toContain(id)
            }
          }),
        )
      }),
    )

    it.instance("a deny for the tool closes it, in the rules of the session or of the agent; its neighbours stay", () =>
      withTools(
        fixture(true),
        Effect.gen(function* () {
          for (const name of READ_ONLY_AGENTS) {
            const agent = yield* agentNamed(name)
            expect(yield* idsOf(agent), name).toContain("ro_lookup")

            // In the rules of the session, as a deny of a parent reaches a child.
            const session = yield* idsOf(agent, [deny("ro_lookup")])
            expect(session, name).not.toContain("ro_lookup")
            expect(session, name).toContain("ro_other")

            // In the rules of the agent, which is where `agent.<name>.permission` puts it; a wildcard names the server.
            const own = yield* idsOf({ ...agent, permission: [...agent.permission, deny("ro_lookup")] })
            expect(own, name).not.toContain("ro_lookup")
            expect(own, name).toContain("ro_other")
            const server = yield* idsOf({ ...agent, permission: [...agent.permission, deny("ro_*")] })
            expect(server, name).not.toContain("ro_lookup")
            expect(server, name).not.toContain("ro_other")
          }
        }),
      ),
    )

    it.instance(
      "a rewritten key that declares readOnlyHint is seen, and a deny for the key it had before hides it",
      () =>
        withTools(
          { ...mcpTools, mcp_call_1a2b3c4d: mcpTool("mcp", "call", "mcp_call", undefined, undefined, true) },
          Effect.gen(function* () {
            const explore = yield* agentNamed("explore")
            const entries = yield* resolved(explore)
            expect(entries.find((entry) => entry.id === "mcp_call_1a2b3c4d")?.source).toMatchObject({
              baseKey: "mcp_call",
              readOnly: true,
            })
            expect(yield* idsOf(explore, [deny("mcp_call")])).not.toContain("mcp_call_1a2b3c4d")
          }),
        ),
    )

    it.instance(
      "the read-only tool of a deferred server is no tool of theirs: they have no mcp_describe or mcp_call",
      () =>
        withTools(
          { ...mcpTools, rod_lookup: mcpTool("rod", "lookup", undefined, true, undefined, true) },
          Effect.gen(function* () {
            for (const name of READ_ONLY_AGENTS) {
              const entries = yield* resolved(yield* agentNamed(name))
              expect(
                entries.filter((entry) => entry.source.kind === "mcp-deferred"),
                name,
              ).toEqual([])
              // Whatever is left of the tool is a member of the catalog, never one of the model's tools.
              for (const entry of entries)
                if (entry.id === "rod_lookup") expect(entry.source, name).toMatchObject({ deferred: true })
            }
          }),
        ),
    )
  })

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

  describe("tool limits of the model (#1459)", () => {
    const DESCRIBE = MCP_DEFERRED_TOOLS.describe
    const CALL = MCP_DEFERRED_TOOLS.call
    type Entry = ToolRegistry.ToolEntry
    const isDeferred = (entry: Entry) => entry.source.kind === "mcp" && entry.source.deferred === true
    const deferredIds = (entries: ReadonlyArray<Entry>) => entries.filter(isDeferred).map((entry) => entry.id)
    // What the model is sent as tools: not a deferred tool, and not `invalid`, which no request carries.
    const sent = (entries: ReadonlyArray<Entry>) =>
      entries.filter((entry) => !isDeferred(entry) && entry.id !== "invalid")
    const sentMcp = (entries: ReadonlyArray<Entry>) =>
      sent(entries)
        .filter((entry) => entry.source.kind === "mcp")
        .map((entry) => entry.id)
    // The tools that are neither MCP tools, nor the two helpers, nor `invalid`: what a count limit leaves room for.
    const nativeCount = (entries: ReadonlyArray<Entry>) =>
      entries.filter(
        (entry) => entry.source.kind !== "mcp" && entry.source.kind !== "mcp-deferred" && entry.id !== "invalid",
      ).length
    const catalogOf = (entries: ReadonlyArray<Entry>) =>
      (entries.find((entry) => entry.id === DESCRIBE)?.description ?? "")
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2, line.indexOf(":")))
    // A model whose profile carries `toolLimits`, as the provider layer hands it over.
    const limited = (toolLimits: ModelProfile["toolLimits"], id = "test-model") => {
      const model = ProviderTest.model({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make(id) })
      return { ...model, profile: { ...ProviderProfile.profileOf(model), toolLimits } }
    }
    const plain = (...keys: string[]) => Object.fromEntries(keys.map((key) => [key, mcpTool("srv", key)]))
    // Runs `body` with `tools` as the MCP tools, and puts the suite's own back.
    const withTools = <A, E, R>(tools: Record<string, ReturnType<typeof mcpTool>>, body: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const original = mcpTools
        mcpTools = tools
        toasts.length = 0
        return body.pipe(Effect.ensuring(Effect.sync(() => (mcpTools = original))))
      })

    it.instance("moves the MCP tools whose key is longer than nameMaxLength into the catalog", () =>
      Effect.gen(function* () {
        const { registry, build, directory } = yield* setup
        yield* withTools(
          plain("ab", "abcdef", "abcdefg", "abcdefgh"),
          Effect.gen(function* () {
            const entries = yield* registry.resolve({
              model: limited({ nameMaxLength: 6 }),
              agent: build,
              session: sessionInfo(directory),
            })
            // A key of exactly the length stays; the longer ones stay as entries, marked, and are in the catalog.
            expect(sentMcp(entries)).toEqual(["ab", "abcdef"])
            expect(deferredIds(entries)).toEqual(["abcdefg", "abcdefgh"])
            expect(catalogOf(entries)).toEqual(["abcdefg", "abcdefgh"])
            const ids = entries.map((entry) => entry.id)
            expect(ids.slice(-2)).toEqual([DESCRIBE, CALL])
            // Each tool is one of the two things only: a model-facing tool or a catalog line.
            expect(sentMcp(entries)).not.toContain("abcdefg")
          }),
        )
      }),
    )

    it.instance("moves the MCP tools whose key does not match namePattern", () =>
      Effect.gen(function* () {
        const { registry, build, directory } = yield* setup
        yield* withTools(
          plain("alpha", "beta", "gam_ma", "Delta"),
          Effect.gen(function* () {
            const entries = yield* registry.resolve({
              model: limited({ namePattern: "^[a-z]+$" }),
              agent: build,
              session: sessionInfo(directory),
            })
            expect(sentMcp(entries)).toEqual(["alpha", "beta"])
            expect(deferredIds(entries)).toEqual(["Delta", "gam_ma"])
            expect(catalogOf(entries)).toEqual(["Delta", "gam_ma"])
          }),
        )
      }),
    )

    it.instance("applies nameMaxLength and namePattern together, each only when declared", () =>
      Effect.gen(function* () {
        const { registry, build, directory } = yield* setup
        yield* withTools(
          plain("ab", "abcdefg", "Q1", "Q123456"),
          Effect.gen(function* () {
            const session = sessionInfo(directory)
            const both = yield* registry.resolve({
              model: limited({ nameMaxLength: 6, namePattern: "^[a-z]+$" }),
              agent: build,
              session,
            })
            expect(sentMcp(both)).toEqual(["ab"])
            const lengthOnly = yield* registry.resolve({
              model: limited({ nameMaxLength: 6 }, "other-model"),
              agent: build,
              session,
            })
            expect(sentMcp(lengthOnly)).toEqual(["ab", "Q1"])
            const patternOnly = yield* registry.resolve({
              model: limited({ namePattern: "^[a-z]+$" }, "third-model"),
              agent: build,
              session,
            })
            expect(sentMcp(patternOnly)).toEqual(["ab", "abcdefg"])
          }),
        )
      }),
    )

    it.instance("takes a namePattern that does not compile as not declared, and does not throw", () =>
      Effect.gen(function* () {
        const { registry, build, directory } = yield* setup
        yield* withTools(
          plain("ab", "abcdefg"),
          Effect.gen(function* () {
            const entries = yield* registry.resolve({
              model: limited({ namePattern: "(" }),
              agent: build,
              session: sessionInfo(directory),
            })
            expect(sentMcp(entries)).toEqual(["ab", "abcdefg"])
            expect(deferredIds(entries)).toEqual([])
            expect(entries.map((entry) => entry.id)).not.toContain(DESCRIBE)
            expect(toasts).toEqual([])
          }),
        )
      }),
    )

    it.instance("keeps only as many MCP tools as maxTools leaves room for, in key order, and counts the helpers", () =>
      Effect.gen(function* () {
        const { registry, build, directory, model } = yield* setup
        yield* withTools(
          // Registered out of order: the first by key is the one that stays.
          plain("d4", "a1", "c3", "b2"),
          Effect.gen(function* () {
            const session = sessionInfo(directory)
            const native = nativeCount(yield* registry.resolve({ model, agent: build, session }))
            // `invalid` is one of the entries, and no request carries it.
            expect((yield* registry.resolve({ model, agent: build, session })).map((entry) => entry.id)).toContain(
              "invalid",
            )

            // Room for three tools beyond the native ones: the two helpers and one MCP tool.
            const entries = yield* registry.resolve({
              model: limited({ maxTools: native + 3 }),
              agent: build,
              session,
            })
            expect(sentMcp(entries)).toEqual(["a1"])
            expect(deferredIds(entries)).toEqual(["b2", "c3", "d4"])
            expect(catalogOf(entries)).toEqual(["b2", "c3", "d4"])
            expect(entries.map((entry) => entry.id).slice(-2)).toEqual([DESCRIBE, CALL])
            // What the model is sent is exactly the limit.
            expect(sent(entries)).toHaveLength(native + 3)
          }),
        )
      }),
    )

    it.instance("moves nothing while the tool count is within maxTools, and moves from one over it", () =>
      Effect.gen(function* () {
        const { registry, build, directory, model } = yield* setup
        yield* withTools(
          plain("a1", "b2", "c3", "d4"),
          Effect.gen(function* () {
            const session = sessionInfo(directory)
            const baseline = yield* registry.resolve({ model, agent: build, session })
            const native = nativeCount(baseline)
            const atLimit = yield* registry.resolve({
              model: limited({ maxTools: native + 4 }, "at-limit"),
              agent: build,
              session,
            })
            expect(sentMcp(atLimit)).toEqual(["a1", "b2", "c3", "d4"])
            expect(atLimit.map((entry) => entry.id)).toEqual(baseline.map((entry) => entry.id))
            expect(toasts).toEqual([])

            const over = yield* registry.resolve({
              model: limited({ maxTools: native + 3 }, "over-limit"),
              agent: build,
              session,
            })
            expect(deferredIds(over)).toEqual(["b2", "c3", "d4"])
          }),
        )
      }),
    )

    it.instance(
      "counts the two helpers once a tool is deferred already, and leaves none of its own room when short",
      () =>
        Effect.gen(function* () {
          const { registry, build, directory, model } = yield* setup
          yield* withTools(
            {
              ...plain("a1", "b2", "c3"),
              z9: mcpTool("srv", "z9", undefined, true),
            },
            Effect.gen(function* () {
              const session = sessionInfo(directory)
              const native = nativeCount(yield* registry.resolve({ model, agent: build, session }))
              // One tool is deferred by its server, so the helpers are in already: three live tools and two helpers
              // do not fit native + 4, and the room is native + 4 - native - 2 = 2 tools.
              const entries = yield* registry.resolve({
                model: limited({ maxTools: native + 4 }),
                agent: build,
                session,
              })
              expect(sentMcp(entries)).toEqual(["a1", "b2"])
              expect(deferredIds(entries)).toEqual(["c3", "z9"])
              expect(sent(entries)).toHaveLength(native + 4)

              // A limit below what the helpers need leaves no MCP tool live, and does not go negative.
              const short = yield* registry.resolve({
                model: limited({ maxTools: native + 1 }, "short-model"),
                agent: build,
                session,
              })
              expect(sentMcp(short)).toEqual([])
              expect(deferredIds(short)).toEqual(["a1", "b2", "c3", "z9"])
            }),
          )
        }),
    )

    it.instance("moves by name first, so a tool moved by name does not count against maxTools", () =>
      Effect.gen(function* () {
        const { registry, build, directory, model } = yield* setup
        yield* withTools(
          plain("a1", "b2", "longname1", "longname2"),
          Effect.gen(function* () {
            const session = sessionInfo(directory)
            const native = nativeCount(yield* registry.resolve({ model, agent: build, session }))
            // The names move two tools; a1, b2 and the helpers then make native + 4 against a limit of native + 4.
            const fits = yield* registry.resolve({
              model: limited({ nameMaxLength: 4, maxTools: native + 4 }),
              agent: build,
              session,
            })
            expect(sentMcp(fits)).toEqual(["a1", "b2"])
            expect(deferredIds(fits)).toEqual(["longname1", "longname2"])
            // One short of that: the count moves one more, the later key.
            const tighter = yield* registry.resolve({
              model: limited({ nameMaxLength: 4, maxTools: native + 3 }, "tighter-model"),
              agent: build,
              session,
            })
            expect(sentMcp(tighter)).toEqual(["a1"])
            expect(deferredIds(tighter)).toEqual(["b2", "longname1", "longname2"])
          }),
        )
      }),
    )

    it.instance("changes nothing while toolLimits declares nothing", () =>
      Effect.gen(function* () {
        const { registry, build, directory, model } = yield* setup
        yield* withTools(
          { ...plain("a1", "abcdefghij"), z9: mcpTool("srv", "z9", undefined, true) },
          Effect.gen(function* () {
            const session = sessionInfo(directory)
            const shape = (entries: ReadonlyArray<Entry>) =>
              JSON.stringify(
                entries.map((entry) => [entry.id, entry.source, entry.description, entry.jsonSchema, entry.effects]),
              )
            const baseline = shape(yield* registry.resolve({ model, agent: build, session }))
            expect(shape(yield* registry.resolve({ model: limited({}, "empty-limits"), agent: build, session }))).toBe(
              baseline,
            )
            expect(toasts).toEqual([])
          }),
        )
      }),
    )

    it.instance("moves nothing when a rule or a switch hides either helper, so the tools stay where they were", () =>
      Effect.gen(function* () {
        const { registry, build, directory } = yield* setup
        yield* withTools(
          plain("a1", "longname1", "longname2"),
          Effect.gen(function* () {
            const session = sessionInfo(directory)
            const model = limited({ nameMaxLength: 4, maxTools: 1 })
            const extras: Array<{ permission?: PermissionV1.Ruleset; user?: { tools: Record<string, boolean> } }> = [
              { permission: [{ permission: CALL, pattern: "*", action: "deny" }] },
              { permission: [{ permission: DESCRIBE, pattern: "*", action: "deny" }] },
              { user: { tools: { [CALL]: false } } },
            ]
            for (const extra of extras) {
              const entries = yield* registry.resolve({ model, agent: build, session, ...extra })
              expect(sentMcp(entries)).toEqual(["a1", "longname1", "longname2"])
              expect(deferredIds(entries)).toEqual([])
            }
            expect(toasts).toEqual([])
          }),
        )
      }),
    )

    it.instance("announces the tools it moved once for each model, whatever the number of resolutions", () =>
      Effect.gen(function* () {
        const { registry, build, directory } = yield* setup
        yield* withTools(
          plain("a1", "b2", "longname1", "longname2"),
          Effect.gen(function* () {
            const session = sessionInfo(directory)
            const first = limited({ nameMaxLength: 4, maxTools: 1000 })
            yield* registry.resolve({ model: first, agent: build, session })
            yield* registry.resolve({ model: first, agent: build, session })
            yield* registry.resolve({
              model: first,
              agent: build,
              session: sessionInfo(directory, { id: SessionID.make("ses_other") }),
            })
            expect(toasts).toEqual([
              {
                title: "MCP tools moved to the deferred catalog",
                message: "2 tools do not fit the limits of test/test-model",
                variant: "warning",
                duration: 8000,
              },
            ])

            // Another model is announced once as well, with its own count.
            const second = limited({ nameMaxLength: 2 }, "other-model")
            yield* registry.resolve({ model: second, agent: build, session })
            yield* registry.resolve({ model: second, agent: build, session })
            expect(toasts.map((toast) => toast.message)).toEqual([
              "2 tools do not fit the limits of test/test-model",
              "2 tools do not fit the limits of test/other-model",
            ])
          }),
        )
      }),
    )

    it.instance("announces the number moved by both rules together, and one tool in the singular", () =>
      Effect.gen(function* () {
        const { registry, build, directory, model } = yield* setup
        yield* withTools(
          plain("a1", "b2", "longname1", "longname2"),
          Effect.gen(function* () {
            const session = sessionInfo(directory)
            const native = nativeCount(yield* registry.resolve({ model, agent: build, session }))
            // Two tools by their names and one by the count.
            yield* registry.resolve({
              model: limited({ nameMaxLength: 4, maxTools: native + 3 }, "both"),
              agent: build,
              session,
            })
            expect(toasts.map((toast) => toast.message)).toEqual(["3 tools do not fit the limits of test/both"])
          }),
        )
        yield* withTools(
          plain("a1", "longname1"),
          Effect.gen(function* () {
            yield* registry.resolve({
              model: limited({ nameMaxLength: 4 }, "single"),
              agent: build,
              session: sessionInfo(directory),
            })
            expect(toasts.map((toast) => toast.message)).toEqual(["1 tool does not fit the limits of test/single"])
          }),
        )
      }),
    )

    it.instance("says nothing when no tool was moved, and a tool deferred by its server does not count as moved", () =>
      Effect.gen(function* () {
        const { registry, build, directory, model } = yield* setup
        yield* withTools(
          { ...plain("a1"), longname9: mcpTool("srv", "longname9", undefined, true) },
          Effect.gen(function* () {
            const session = sessionInfo(directory)
            // The limits fit every live tool, and the long key is in the catalog already.
            yield* registry.resolve({ model: limited({ nameMaxLength: 4, maxTools: 1000 }), agent: build, session })
            yield* registry.resolve({ model, agent: build, session })
            expect(toasts).toEqual([])
          }),
        )
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
