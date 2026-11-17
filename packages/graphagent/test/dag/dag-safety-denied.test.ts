// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagEvent } from "@graphagent/schema/dag-event"
import { Session } from "@graphagent/schema/session"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagCoverage } from "@/dag/coverage"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { renderStatus } from "@/tool/workflow/render"
import { nodeSafetyWakeLine, workflowSafetyWakeLine } from "@/dag/runtime/delivery"
import { isRecord } from "@/util/record"
import { transactLayer } from "./fixture/transact"

/**
 * #1031 M7: a safety denial is durable node evidence, not a lifecycle
 * transition. The projection keeps at most 20 entries and a total count; the
 * same data feeds inspect, coverage and the parent report.
 */

function node(id: string): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: id },
  }
}

const harness = (() => {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store), Layer.provide(transactLayer(database)))
  return Layer.mergeAll(database, events, bridge, store, projector, dag)
})()

const runTest = <A, E>(test: (services: {
  readonly dag: Dag.Interface
  readonly store: DagStore.Interface
  readonly events: EventV2.Interface
}) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db
        .insert(ProjectTable)
        .values({
          id: Project.ID.make("project-safety"),
          worktree: AbsolutePath.make(process.cwd()),
          sandboxes: [],
        })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionTable)
        .values({
          id: Session.ID.make("ses_safety_parent"),
          project_id: Project.ID.make("project-safety"),
          slug: "parent",
          directory: AbsolutePath.make(process.cwd()),
          title: "Parent",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const dag = yield* Dag.Service
      const store = yield* DagStore.Service
      const events = yield* EventV2Bridge.Service
      return yield* test({ dag, store, events })
    }).pipe(
      Effect.provide(harness),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        root: process.cwd(),
        project: {
          id: Project.ID.make("project-safety"),
          worktree: process.cwd(),
          time: { created: 0, updated: 0 },
          sandboxes: [],
        },
      }),
      Effect.scoped,
    )
  })

const started = (dag: Dag.Interface) =>
  Effect.gen(function* () {
    const dagID = yield* dag.create({
      projectID: "project-safety",
      sessionID: "ses_safety_parent",
      title: "safety",
      config: { name: "safety", nodes: [node("a")] },
    })
    yield* dag.nodeQueued(dagID, "a")
    yield* dag.nodeStarted(dagID, "a", "ses_safety_child", Date.now() + 60_000, true)
    return dagID
  })

const denied = (events: EventV2.Interface, dagID: string, ruleID: string, index: number) =>
  events.publish(DagEvent.NodeSafetyDenied, {
    dagID: DagEvent.DagID.make(dagID),
    nodeID: DagEvent.NodeID.make("a"),
    attempt: 0,
    ruleID,
    permission: "bash",
    summary: `${ruleID}: denied command ${index}`,
    timestamp: DateTime.makeUnsafe(1_700_000_000_000 + index),
  })

describe("safety wake text", () => {
  it("names the denied call count for nodes and workflows, and stays empty at zero", () => {
    expect(nodeSafetyWakeLine(0)).toBe("")
    expect(nodeSafetyWakeLine(1)).toContain("1 tool call in this node was denied")
    expect(nodeSafetyWakeLine(2)).toContain("2 tool calls in this node were denied")
    expect(workflowSafetyWakeLine(0)).toBe("")
    expect(workflowSafetyWakeLine(3)).toContain("Safety policy denied 3 tool calls in this workflow")
  })
})

describe("dag.node.safety_denied projection", () => {
  it("keeps bounded items and an honest total, without changing node status", () =>
    Effect.runPromise(
      runTest(({ dag, store, events }) =>
        Effect.gen(function* () {
          const dagID = yield* started(dag)
          yield* denied(events, dagID, "SF-3", 1)
          yield* denied(events, dagID, "SF-4", 2)

          const row = yield* store.getNode(dagID, "a")
          expect(row?.status).toBe("running")
          expect(row?.wakeReported).toBe(false)
          expect(row?.safetyDenials?.total).toBe(2)
          expect(row?.safetyDenials?.items.map((item) => item.ruleID)).toEqual(["SF-3", "SF-4"])
          expect(row?.safetyDenials?.items[0]?.permission).toBe("bash")
        }),
      ),
    ),
  )

  it("stops storing items at 20 but keeps counting", () =>
    Effect.runPromise(
      runTest(({ dag, store, events }) =>
        Effect.gen(function* () {
          const dagID = yield* started(dag)
          for (let index = 0; index < 22; index++) yield* denied(events, dagID, `SX-${index + 1}`, index)
          const row = yield* store.getNode(dagID, "a")
          expect(row?.safetyDenials?.items).toHaveLength(20)
          expect(row?.safetyDenials?.total).toBe(22)
        }),
      ),
    ),
  )

  it("feeds inspect status and the coverage section", () =>
    Effect.runPromise(
      runTest(({ dag, store, events }) =>
        Effect.gen(function* () {
          const dagID = yield* started(dag)
          yield* denied(events, dagID, "SF-2", 1)
          const workflow = yield* store.getWorkflow(dagID)
          const nodes = yield* store.getCurrentNodes(dagID)
          if (!workflow) throw new Error("workflow missing")
          const config = Dag.parseWorkflowConfig(workflow.config)
          const coverage = DagCoverage.workflowCoverage({
            config,
            nodes,
            workflow: { status: workflow.status, pauseReason: workflow.pauseReason },
          })
          expect(coverage).toContainEqual({ node_id: "a", reason: "safety denied: SF-2" })

          const rendered = renderStatus({ workflow, nodes, allNodes: nodes, coverage })
          const parsed: unknown = JSON.parse(rendered.output)
          if (!isRecord(parsed) || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.coverage))
            throw new Error("unexpected status shape")
          const row = parsed.nodes.find((item): item is Record<string, unknown> => isRecord(item) && item.id === "a")
          expect(isRecord(row?.safety_denials) ? row.safety_denials.total : undefined).toBe(1)
          expect(parsed.coverage).toContainEqual({ node_id: "a", reason: "safety denied: SF-2" })
          expect(DagCoverage.coverageSection(coverage, "en")).toContain("safety denied: SF-2")
        }),
      ),
    ),
  )
})