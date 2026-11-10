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

// `canUseAgentMessages` reads the workflow list first; counting that call is
// the probe for one visibility evaluation per turn (Issue #1022, HS6b).
let checks = 0
let usable = false

const workflow: DagStore.WorkflowRow = {
  id: "workflow_owned",
  projectId: ProjectV2.ID.global,
  sessionId: SessionID.make("ses_turn_cache"),
  directory: "/tmp/opencode",
  targetFingerprint: { kind: "none" },
  title: "Owned workflow",
  status: "running",
  pauseReason: null,
  config: "{}",
  seq: 1,
  wakeReported: false,
  graphRev: 0,
  startedAt: 1,
  completedAt: null,
  timeCreated: 1,
  timeUpdated: 1,
}

const storeLayer = Layer.mock(DagStore.Service, {
  listBySession: () => {
    checks += 1
    return Effect.succeed(usable ? [workflow] : [])
  },
})

const messagesLayer = Layer.mock(DagMessages.Service, {
  resolve: (caller) =>
    Effect.succeed({
      ok: true,
      value: { id: "mailbox_main", kind: "main", sessionID: caller.sessionID },
    } satisfies DagMessages.Result<DagMessages.Endpoint>),
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
// `canUseAgentMessages` resolves its optional DAG services from the fiber
// context, so the mocks must also be part of the test layer's output.
const it = testEffect(Layer.merge(LayerNode.buildLayer(root, { replacements }), Layer.merge(storeLayer, messagesLayer)))

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry agent turn cache", () => {
  it.instance("evaluates agent-tool visibility once per user turn", () =>
    Effect.gen(function* () {
      checks = 0
      usable = false
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
      expect(checks).toBe(1)

      // The mailbox becomes reachable mid-turn: the toolset stays stable for
      // the turn that already made the decision.
      usable = true
      const sameTurn = yield* registry.resolve({ model, agent: build, session, turnID: "turn-1" })
      expect(ids(sameTurn)).not.toContain("agent")
      expect(checks).toBe(1)

      // A new user turn re-evaluates and sees the tool.
      const nextTurn = yield* registry.resolve({ model, agent: build, session, turnID: "turn-2" })
      expect(ids(nextTurn)).toContain("agent")
      expect(checks).toBe(2)

      // Callers without a turn identity keep the unbounded per-resolve read.
      const untagged = yield* registry.resolve({ model, agent: build, session })
      expect(ids(untagged)).toContain("agent")
      expect(checks).toBe(3)
    }),
  )
})
