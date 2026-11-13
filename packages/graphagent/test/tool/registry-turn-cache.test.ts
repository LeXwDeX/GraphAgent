// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagStore } from "@graphagent/core/dag/store"
import { ModelV2 } from "@graphagent/core/model"
import { ProjectV2 } from "@graphagent/core/project"
import { ProviderV2 } from "@graphagent/core/provider"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { ChildRegistry } from "@/session/child/registry"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".agents")])),
})

// `canUseAgentMessages` answers from the child registry; the database calls the
// old visibility query made must stay at zero (Issue #1026, PR6).
const calls = { listBySession: 0, getNodes: 0, resolve: 0, revisions: 0 }

const storeLayer = Layer.mock(DagStore.Service, {
  listBySession: () => {
    calls.listBySession += 1
    return Effect.succeed([])
  },
  getNodes: () => {
    calls.getNodes += 1
    return Effect.succeed([])
  },
})

const messagesLayer = Layer.mock(DagMessages.Service, {
  resolve: () => {
    calls.resolve += 1
    return Effect.succeed({ ok: false, reason: "unauthorized" } as const)
  },
  revisions: () => {
    calls.revisions += 1
    return Effect.succeed({ ok: false, reason: "unauthorized" } as const)
  },
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
  LayerNode.replace(DagStore.node, storeLayer),
  LayerNode.replace(DagMessages.node, messagesLayer),
]
// The visibility path no longer resolves either DAG service; the mocks stay
// because the registry's own layer still provides them.
const it = testEffect(LayerNode.buildLayer(root, { replacements }))

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry agent turn cache", () => {
  it.instance("evaluates agent-tool visibility once per user turn without a query", () =>
    Effect.gen(function* () {
      for (const key of Object.keys(calls) as Array<keyof typeof calls>) calls[key] = 0
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("build agent not found")
      const directory = yield* InstanceState.directory
      const session = {
        id: SessionID.make("ses_turn_cache"),
        slug: "turn-cache",
        projectID: ProjectV2.ID.global,
        directory,
        title: "turn cache",
        version: "1.0.0",
        time: { created: 1, updated: 1 },
      } as Session.Info
      const model = ProviderTest.model({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") })
      const ids = (entries: ToolRegistry.ToolEntry[]) => entries.map((entry) => entry.id)

      const first = yield* registry.resolve({ model, agent: build, session, turnID: "turn-1" })
      expect(ids(first)).not.toContain("agent")

      // A DAG node run appears mid-turn: the toolset stays stable for the turn
      // that already made the decision.
      const entry = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const entry = ChildRegistry.create({
            id: "crun_turn_cache",
            childSessionID: SessionID.make("ses_turn_cache_node"),
            parentSessionID: session.id,
            ownerKind: "dag_node",
            ownerKey: { kind: "dag_node", workflowID: "workflow_owned", nodeID: "node_1", attempt: 0 },
            permission: { ask: "auto" },
            detached: false,
            directory: undefined,
            owner: {},
          })
          expect(ChildRegistry.register(entry)).toBe(true)
          return entry
        }),
        (entry) =>
          Effect.sync(() => {
            ChildRegistry.end(entry, { type: "completed" })
            ChildRegistry.release(entry)
          }),
      )
      const sameTurn = yield* registry.resolve({ model, agent: build, session, turnID: "turn-1" })
      expect(ids(sameTurn)).not.toContain("agent")

      // Callers without a turn identity are never served the cached decision.
      const untagged = yield* registry.resolve({ model, agent: build, session })
      expect(ids(untagged)).toContain("agent")

      // A new user turn re-evaluates and sees the tool.
      const nextTurn = yield* registry.resolve({ model, agent: build, session, turnID: "turn-2" })
      expect(ids(nextTurn)).toContain("agent")

      // An ended run is no longer exchangeable: the next turn hides the tool.
      ChildRegistry.end(entry, { type: "completed" })
      const endedTurn = yield* registry.resolve({ model, agent: build, session, turnID: "turn-3" })
      expect(ids(endedTurn)).not.toContain("agent")

      expect(calls).toEqual({ listBySession: 0, getNodes: 0, resolve: 0, revisions: 0 })
    }),
  )
})
