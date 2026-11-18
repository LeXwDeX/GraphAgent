// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1158 PR3b-1: a child the engine expands from a plan never writes. The expansion marks every child
// `workspace_writes: "deny"`; the loop registers that policy with the node's run (dag-compose-runtime.test.ts);
// here the policy meets the tool registry, which is what refuses edit, write and apply_patch to the run.
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Database } from "@graphagent/core/database/database"
import { ModelV2 } from "@graphagent/core/model"
import { ProjectV2 } from "@graphagent/core/project"
import { ToolRegistry } from "@/tool/registry"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { ChildRegistry } from "@/session/child/registry"
import { DagCompose } from "@/dag/compose"
import { workspaceWritesOf } from "@/dag/review-lifecycle"
import { disposeAllInstances } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { catalog, composerOf } from "./compose-fixtures"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".agents")])),
})
const root = LayerNode.group([ToolRegistry.node, Agent.node, Database.node])
const replacements = [
  LayerNode.replace(Config.node, configLayer),
  LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer()),
]
const it = testEffect(LayerNode.buildLayer(root, { replacements }))

afterEach(async () => {
  await disposeAllInstances()
})

const WRITING_TOOLS = ["edit", "write", "apply_patch"]

/** Every child of a plan that names a researcher, an explorer and an auditor: what the engine would write. */
function children() {
  const slot = DagCompose.compileNodes(
    [
      {
        id: "survey",
        name: "survey",
        worker_type: "surveyor",
        block: "compose",
        depends_on: [],
        required: false,
        prompt_template: { inline: "Compare the designs" },
      },
    ],
    catalog(),
    DagCompose.DEFAULT_LIMITS,
  ).nodes.find((node) => node.id === "survey")
  if (!slot) throw new Error("no slot")
  const planned = DagCompose.planExpansion({
    slot,
    composer: composerOf("surveyor"),
    limits: DagCompose.DEFAULT_LIMITS,
    source: {
      status: "completed",
      output: {
        rationale: "by source",
        items: [
          { id: "a", agent: "researcher", instruction: "a" },
          { id: "b", agent: "explore", instruction: "b" },
          { id: "c", agent: "auditor", instruction: "c" },
        ],
        not_planned: [],
      },
    },
    existingNodeIDs: new Set(),
  })
  if (planned.kind !== "expand") throw new Error("expected an expansion")
  return planned.nodes.filter((node) => node.id !== "survey")
}

describe("expanded children are read-only runs", () => {
  test("every child's policy resolves to deny, whatever its agent's own rules say", () => {
    const all = children()
    expect(all.map((node) => node.id)).toEqual(["survey--a", "survey--b", "survey--c"])
    for (const node of all) expect(workspaceWritesOf(node, node.worker_type), node.id).toBe("deny")
  })

  it.instance("the tool registry hides edit, write and apply_patch from a run registered with that policy", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      // The most capable agent there is: with the run's policy it still gets no writing tool.
      const build = yield* agents.get("build")
      if (!build) throw new Error("build agent not found")
      const directory = yield* InstanceState.directory
      for (const node of children()) {
        const parentID = SessionID.make(`ses_compose_ro_parent_${crypto.randomUUID()}`)
        const childID = SessionID.make(`ses_compose_ro_child_${crypto.randomUUID()}`)
        const session = {
          id: childID,
          parentID,
          slug: "compose-readonly",
          role: "task_child",
          projectID: ProjectV2.ID.global,
          directory,
          title: "compose read-only child",
          version: "1.0.0",
          time: { created: 1, updated: 1 },
        } as Session.Info
        const policy = workspaceWritesOf(node, node.worker_type)
        const entry = ChildRegistry.create({
          id: `crun_${crypto.randomUUID()}`,
          childSessionID: childID,
          parentSessionID: parentID,
          ownerKind: "dag_node",
          ownerKey: { kind: "dag_node", workflowID: "wf_compose", nodeID: node.id, attempt: 0 },
          permission: { ask: "auto", ...(policy === "deny" ? { workspaceWrites: "deny" as const } : {}) },
          detached: false,
          directory: undefined,
          owner: {},
        })
        expect(ChildRegistry.register(entry)).toBe(true)
        yield* Effect.gen(function* () {
          // gpt-oss edits through edit/write, gpt-5 through apply_patch.
          for (const model of [
            ProviderTest.model({ id: ModelV2.ID.make("gpt-oss-120b") }),
            ProviderTest.model({ id: ModelV2.ID.make("gpt-5") }),
          ]) {
            const ids = (yield* registry.resolve({ model, agent: build, session })).map((resolved) => resolved.id)
            for (const writing of WRITING_TOOLS) expect(ids, `${node.id} ${writing}`).not.toContain(writing)
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ChildRegistry.end(entry, { type: "completed" })
              ChildRegistry.release(entry)
            }),
          ),
        )
      }
    }),
  )
})
