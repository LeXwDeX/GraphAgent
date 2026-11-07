import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { WorkflowRuntime, toSchedulingNodes } from "@opencode-ai/core/dag/core/scheduling"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Dag, type NodeConfig } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const persistence = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
  EventV2Bridge.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)
const it = testEffect(Layer.provideMerge(Dag.layer, persistence))

function node(id: string, dependsOn: string[] = []): NodeConfig {
  return { id, name: id, worker_type: "build", depends_on: dependsOn, required: true, prompt_template: { inline: id } }
}

const setup = Effect.fn(function* (nodes: NodeConfig[]) {
  const { db } = yield* Database.Service
  const sessionID = SessionID.make("ses_replan_parent")
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory: AbsolutePath.make("/project"),
      title: sessionID,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  const dag = yield* Dag.Service
  const id = yield* dag.create({
    projectID: Project.ID.global,
    sessionID,
    title: "replan",
    config: { name: "replan", nodes, max_node_replan_attempts: 5 },
  })
  return { dag, id }
})

const start = Effect.fn(function* (dag: Dag.Interface, id: string, nodeID: string) {
  yield* dag.nodeQueued(id, nodeID)
  yield* dag.nodeStarted(id, nodeID, `ses_${nodeID}`)
})

// Mirrors loop.ts rebuild: the runtime is seeded from getCurrentNodes.
const runtimeOf = Effect.fn(function* (dag: Dag.Interface, id: string) {
  return new WorkflowRuntime(toSchedulingNodes(yield* dag.store.getCurrentNodes(id)), 4)
})

// Rev-view: a replan supersedes failed rows the new revision routes around.
// A failed row that a still-executable node depends on must stay in the current
// view, or buildGraph drops the edge and runs the dependent as a root.
describe("replan supersede of failed rows with surviving dependents", () => {
  it.effect("an additive extend keeps a pending dependent blocked by its failed required upstream", () =>
    Effect.gen(function* () {
      const { dag, id } = yield* setup([node("a"), node("c", ["a"]), node("d", ["c"]), node("z")])
      yield* start(dag, id, "a")
      yield* dag.nodeCompleted(id, "a", "a done")
      yield* start(dag, id, "z")
      yield* start(dag, id, "c")
      yield* dag.nodeFailed(id, "c", "boom", "exec_failed")
      const before = yield* runtimeOf(dag, id)
      expect(before.getReadyNodes()).not.toContain("d")
      expect(before.hasRequiredFailure()).toBe(true)

      // d is carried forward unchanged and still depends on failed c.
      yield* dag.extend(id, [node("n")])
      expect(yield* dag.store.getNode(id, "d")).toMatchObject({ status: "pending", dependsOn: ["c"] })
      expect((yield* dag.store.getNode(id, "c"))?.superseded).toBe(false)

      const after = yield* runtimeOf(dag, id)
      expect(after.getReadyNodes()).toEqual(["n"])
      expect(after.hasRequiredFailure()).toBe(true)
    }),
  )

  it.effect("a replan that rewires the dependent to a replacement still supersedes the failed row", () =>
    Effect.gen(function* () {
      const { dag, id } = yield* setup([node("a"), node("c", ["a"]), node("d", ["c"]), node("z")])
      yield* start(dag, id, "a")
      yield* dag.nodeCompleted(id, "a", "a done")
      yield* start(dag, id, "z")
      yield* start(dag, id, "c")
      yield* dag.nodeFailed(id, "c", "boom", "exec_failed")

      yield* dag.replan(id, { nodes: [node("c2", ["a"]), node("d", ["c2"])] })
      expect((yield* dag.store.getNode(id, "c"))?.superseded).toBe(true)
      expect(yield* dag.store.getNode(id, "d")).toMatchObject({ status: "pending", dependsOn: ["c2"] })

      const after = yield* runtimeOf(dag, id)
      expect(after.hasRequiredFailure()).toBe(false)
      expect(after.getReadyNodes()).toEqual(["c2"])
    }),
  )

  it.effect("a replan that cancels the only dependent supersedes the failed row", () =>
    Effect.gen(function* () {
      const { dag, id } = yield* setup([node("a"), node("c", ["a"]), node("d", ["c"]), node("z")])
      yield* start(dag, id, "a")
      yield* dag.nodeCompleted(id, "a", "a done")
      yield* start(dag, id, "z")
      yield* start(dag, id, "c")
      yield* dag.nodeFailed(id, "c", "boom", "exec_failed")

      // d is omitted from the fragment, so the replan cancels it.
      yield* dag.replan(id, { nodes: [node("n")] })
      expect((yield* dag.store.getNode(id, "c"))?.superseded).toBe(true)
      expect((yield* dag.store.getNode(id, "d"))?.superseded).toBe(true)
      const after = yield* runtimeOf(dag, id)
      expect(after.hasRequiredFailure()).toBe(false)
      expect(after.getReadyNodes()).toEqual(["n"])
    }),
  )
})
