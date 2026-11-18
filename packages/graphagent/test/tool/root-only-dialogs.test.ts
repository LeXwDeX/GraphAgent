// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { ProjectV2 } from "@graphagent/core/project"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * #1031 M9: `question` and `plan_exit` are the human dialog and belong to the
 * root session only. Even the `plan` agent — which allows both — must not offer
 * them to a task child or a DAG node; those ask their parent instead.
 */

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".agents")])),
})

const root = LayerNode.group([ToolRegistry.node, Agent.node])
const it = testEffect(
  LayerNode.buildLayer(root, {
    replacements: [
      LayerNode.replace(Config.node, configLayer),
      LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer({ experimentalPlanMode: true, client: "cli" })),
    ],
  }),
)

afterEach(async () => {
  await disposeAllInstances()
})

const session = (id: SessionID, parentID?: SessionID, directory = "") =>
  ({
    id,
    ...(parentID ? { parentID } : {}),
    slug: id,
    role: parentID ? "task_child" : "root",
    projectID: ProjectV2.ID.global,
    directory,
    title: id,
    version: "1.0.0",
    time: { created: 1, updated: 1 },
  }) as Session.Info

describe("root-only dialog tools", () => {
  it.instance("offers question and plan_exit to the root but not to any child session", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const plan = yield* agents.get("plan")
      if (!plan) throw new Error("plan agent not found")
      const directory = yield* InstanceState.directory
      const model = ProviderTest.model()
      const parentID = SessionID.make(`ses_root_only_${crypto.randomUUID()}`)

      const parent = yield* registry.resolve({ model, agent: plan, session: session(parentID, undefined, directory) })
      const parentIDs = parent.map((entry) => entry.id)
      expect(parentIDs).toContain("question")
      expect(parentIDs).toContain("plan_exit")

      for (const childID of [
        SessionID.make(`ses_root_only_task_${crypto.randomUUID()}`),
        SessionID.make(`ses_root_only_node_${crypto.randomUUID()}`),
      ]) {
        const child = yield* registry.resolve({
          model,
          agent: plan,
          session: session(childID, parentID, directory),
        })
        const ids = child.map((entry) => entry.id)
        expect(ids).not.toContain("question")
        expect(ids).not.toContain("plan_exit")
      }
    }),
  )
})