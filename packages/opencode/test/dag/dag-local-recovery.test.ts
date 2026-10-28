import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import fs from "node:fs/promises"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { WorkflowRuntime, toSchedulingNodes } from "@opencode-ai/core/dag/core/scheduling"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { WorkflowNodeTable, WorkflowTable } from "@opencode-ai/core/dag/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Dag, type NodeConfig } from "@/dag/dag"
import { commitOutputFileRef } from "@/dag/runtime/output-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { isRecord } from "@/util/record"
import { tmpdirScoped } from "../fixture/fixture"
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

const setup = Effect.fn(function* (nodes: NodeConfig[], maxAttempts = 5) {
  const { db } = yield* Database.Service
  const sessionID = SessionID.make("ses_recovery_parent")
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
    title: "Recover in place",
    config: {
      name: "recover",
      nodes,
      max_node_replan_attempts: maxAttempts,
    },
  })
  return { dag, id }
})

const start = Effect.fn(function* (dag: Dag.Interface, id: string, nodeID: string) {
  yield* dag.nodeQueued(id, nodeID)
  yield* dag.nodeStarted(id, nodeID, `ses_${nodeID}`)
})
const complete = Effect.fn(function* (dag: Dag.Interface, id: string, nodeID: string, output: unknown) {
  yield* start(dag, id, nodeID)
  yield* dag.nodeCompleted(id, nodeID, output)
})

describe("DAG local recovery", () => {
  it.effect("rejects live scheduling, incomplete selections, and corrupt definitions", () =>
    Effect.gen(function* () {
      const { dag, id } = yield* setup([node("A"), node("B")])
      const rev = (yield* dag.store.getWorkflow(id))!.graphRev
      expect((yield* dag.recover("missing", { nodeIDs: ["A"], expectedGraphRev: rev }).pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* dag.recover(id, { nodeIDs: ["A"], expectedGraphRev: rev }).pipe(Effect.result))._tag).toBe("Failure")
      for (const nodeID of ["A", "B"]) {
        yield* start(dag, id, nodeID)
        yield* dag.nodeFailed(id, nodeID, "transport failed", "exec_failed")
      }
      yield* dag.pause(id)
      const snapshot = { workflow: yield* dag.store.getWorkflow(id), nodes: yield* dag.store.getNodes(id) }
      for (const nodeIDs of [[], ["missing"], ["A", "A"], ["A"]]) {
        expect((yield* dag.recover(id, { nodeIDs, expectedGraphRev: rev }).pipe(Effect.result))._tag).toBe("Failure")
        expect({ workflow: yield* dag.store.getWorkflow(id), nodes: yield* dag.store.getNodes(id) }).toEqual(snapshot)
      }
      const { db } = yield* Database.Service
      const original = Dag.parseWorkflowConfig(snapshot.workflow!.config)!
      for (const config of ["{broken", JSON.stringify({ ...original, nodes: [] })]) {
        yield* db.update(WorkflowTable).set({ config }).where(eq(WorkflowTable.id, id)).run().pipe(Effect.orDie)
        expect((yield* dag.recover(id, { nodeIDs: ["A", "B"], expectedGraphRev: rev }).pipe(Effect.result))._tag).toBe("Failure")
        expect(yield* dag.store.getNodes(id)).toEqual(snapshot.nodes)
        expect((yield* dag.store.getWorkflow(id))!.graphRev).toBe(rev)
      }
    }),
  )

  it.effect("retries failed C and skipped D in the same workflow while retaining A/B and late-result isolation", () =>
    Effect.gen(function* () {
      const { dag, id } = yield* setup([
        node("A"),
        node("B", ["A"]),
        node("C", ["B"]),
        {
          ...node("D", ["C"]),
          input_mapping: { gate: "C.output.passed" },
          condition: "C.output.passed == true",
          prompt_template: { inline: "Use {{gate}}" },
        },
      ])
      yield* complete(dag, id, "A", "analysis")
      yield* complete(dag, id, "B", "implementation")
      yield* start(dag, id, "C")
      yield* dag.nodeFailed(id, "C", "verification transport failed", "exec_failed")
      yield* dag.fail(id, "required verification failed")
      const before = yield* dag.store.getNodes(id)
      const workflow = (yield* dag.store.getWorkflow(id))!
      const recovered = yield* dag.recover(id, { nodeIDs: ["C"], expectedGraphRev: workflow.graphRev })
      expect((yield* dag.store.getWorkflow(id))?.status).toBe("running")
      expect(recovered.graphRev).toBe(workflow.graphRev + 1)
      expect(recovered.reused.sort()).toEqual(["A", "B"])
      expect(recovered.superseded.sort()).toEqual(["C", "D"])
      for (const key of ["A", "B"])
        expect(yield* dag.store.getNode(id, key)).toEqual(before.find((row) => row.id === key))
      expect((yield* dag.store.getNode(id, "C"))?.errorReason).toBe("verification transport failed")
      expect((yield* dag.store.getNode(id, "D"))?.status).toBe("skipped")
      const retryC = recovered.replacements.find((item) => item.previous === "C")!.current
      const retryD = recovered.replacements.find((item) => item.previous === "D")!.current
      const current = yield* dag.store.getCurrentNodes(id)
      expect(current.map((row) => row.id).sort()).toEqual(["A", "B", retryC, retryD].sort())
      const config = Dag.parseWorkflowConfig((yield* dag.store.getWorkflow(id))!.config)!
      const definition = config.nodes.find((item) => item.id === retryD)!
      expect(definition.depends_on).toEqual([retryC])
      expect(definition.input_mapping).toEqual({ gate: `${retryC}.output.passed` })
      expect(definition.condition).toBe(`${retryC}.output.passed == true`)
      expect(config.nodes.find((item) => item.id === retryC)?.recovery).toEqual({
        logical_node_id: "C",
        attempt: 2,
        previous_node_id: "C",
      })
      const late = yield* dag
        .nodeCompleted(id, "C", "stale pass", { replanAttempts: 0, childSessionID: "ses_C" })
        .pipe(Effect.result)
      expect(late._tag).toBe("Failure")
      expect((yield* dag.store.getNode(id, retryC))?.status).toBe("pending")
      yield* complete(dag, id, retryC, { passed: true })
      yield* complete(dag, id, retryD, "done")
      yield* dag.complete(id)
      expect((yield* dag.store.getWorkflow(id))?.status).toBe("completed")
      // A completed graph points the parent at a successor workflow instead of
      // a pause it cannot perform, so it keeps working rather than stopping.
      const terminal = yield* dag
        .recover(id, { nodeIDs: [retryC], expectedGraphRev: (yield* dag.store.getWorkflow(id))!.graphRev })
        .pipe(Effect.flip)
      expect(terminal.message).toContain("bounded successor workflow")
      expect(terminal.message).not.toContain("pause live scheduling first")
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const snapshot = { workflow: (yield* dag.store.getWorkflow(id))!, nodes: yield* dag.store.getNodes(id) }
      const rows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, id)).orderBy(EventTable.seq).all().pipe(Effect.orDie)
      const serialized = rows.map((row): EventV2.SerializedEvent => {
        if (!isRecord(row.data)) throw new Error("Expected durable object payload")
        return { id: row.id, type: row.type, seq: row.seq, aggregateID: row.aggregate_id, data: row.data }
      })
      yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, id)).run().pipe(Effect.orDie)
      yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, id)).run().pipe(Effect.orDie)
      yield* db.delete(WorkflowNodeTable).where(eq(WorkflowNodeTable.workflow_id, id)).run().pipe(Effect.orDie)
      yield* db.delete(WorkflowTable).where(eq(WorkflowTable.id, id)).run().pipe(Effect.orDie)
      yield* events.replayAll(serialized)
      const replayed = (yield* dag.store.getWorkflow(id))!
      // Creation time is a local database default, not a durable event field.
      expect({ workflow: { ...replayed, timeCreated: snapshot.workflow.timeCreated }, nodes: yield* dag.store.getNodes(id) }).toEqual(snapshot)
    }),
  )

  it.effect("invalidates already completed descendants and preserves unrelated pending work", () =>
    Effect.gen(function* () {
      const { dag, id } = yield* setup([
        node("A"),
        node("B", ["A"]),
        { ...node("C", ["B"]), prompt_template: { inline: "Verify {{B}}" } },
        node("independent"),
      ])
      yield* complete(dag, id, "A", "analysis")
      yield* complete(dag, id, "B", "old implementation")
      yield* complete(dag, id, "C", "old PASS")
      yield* dag.pause(id)
      const before = (yield* dag.store.getWorkflow(id))!
      const result = yield* dag.recover(id, { nodeIDs: ["B"], expectedGraphRev: before.graphRev })
      expect(result.superseded.sort()).toEqual(["B", "C"])
      expect((yield* dag.store.getNode(id, "independent"))?.status).toBe("pending")
      expect((yield* dag.store.getNode(id, "C"))?.output).toBe("old PASS")
      expect((yield* dag.store.getNode(id, "C"))?.superseded).toBe(true)
      const config = Dag.parseWorkflowConfig((yield* dag.store.getWorkflow(id))!.config)!
      const replacementC = config.nodes.find((item) => item.recovery?.previous_node_id === "C")!
      const replacementB = config.nodes.find((item) => item.recovery?.previous_node_id === "B")!
      expect(replacementC.prompt_template.inline).toBe("Verify {{B}}")
      expect(replacementC.input_mapping).toEqual({ B: replacementB.id })
    }),
  )

  it.effect("rejects stale revisions and requires explicit cancelled recovery", () =>
    Effect.gen(function* () {
      const { dag, id } = yield* setup([node("A")])
      yield* dag.cancel(id)
      const snapshot = (yield* dag.store.getWorkflow(id))!
      expect(
        (yield* dag.recover(id, { nodeIDs: ["A"], expectedGraphRev: snapshot.graphRev }).pipe(Effect.result))._tag,
      ).toBe("Failure")
      expect(
        (yield* dag
          .recover(id, { nodeIDs: ["A"], expectedGraphRev: snapshot.graphRev + 1, resumeCancelled: true })
          .pipe(Effect.result))._tag,
      ).toBe("Failure")
      expect(yield* dag.store.getWorkflow(id)).toEqual(snapshot)
      const result = yield* dag.recover(id, {
        nodeIDs: ["A"],
        expectedGraphRev: snapshot.graphRev,
        resumeCancelled: true,
      })
      expect((yield* dag.store.getWorkflow(id))?.status).toBe("running")
      yield* dag.pause(id)
      expect(
        (yield* dag
          .recover(id, { nodeIDs: [result.replacements[0].current], expectedGraphRev: snapshot.graphRev })
          .pipe(Effect.result))._tag,
      ).toBe("Failure")
    }),
  )

  it.effect("does not reuse a missing managed artifact and commits captured receipts with completion", () =>
    Effect.gen(function* () {
      const temporary = yield* tmpdirScoped({})
      const source = path.join(temporary, "report.md")
      yield* Effect.promise(() => fs.writeFile(source, "Completed research"))
      const { dag, id } = yield* setup([node("A"), node("B", ["A"])])
      const ref = yield* commitOutputFileRef(source, {
        workflow_id: id,
        node_id: "A",
        child_session_id: "ses_A",
        replan_attempt: 0,
      })
      expect(ref).toBeDefined()
      yield* start(dag, id, "A")
      yield* dag.nodeCompleted(id, "A", ref!.path, undefined, ref)
      expect((yield* dag.store.getNode(id, "A"))?.capturedOutput).toEqual(ref)
      yield* dag.pause(id)
      const snapshot = (yield* dag.store.getWorkflow(id))!
      yield* Effect.promise(async () => {
        await fs.chmod(ref!.path, 0o644)
        await fs.unlink(ref!.path)
      })
      const rejected = yield* dag
        .recover(id, { nodeIDs: ["B"], expectedGraphRev: snapshot.graphRev })
        .pipe(Effect.result)
      expect(rejected._tag).toBe("Failure")
      if (rejected._tag === "Failure") expect(rejected.failure.message).toContain('cannot reuse artifact from node "A"')
      expect(yield* dag.store.getWorkflow(id)).toEqual(snapshot)
      const result = yield* dag.recover(id, { nodeIDs: ["A"], expectedGraphRev: snapshot.graphRev })
      expect(result.superseded.sort()).toEqual(["A", "B"])
      expect(result.reused).toEqual([])
    }).pipe(Effect.scoped),
  )

  it.effect("bounds retries across new node IDs and excludes superseded attempts from later recovery", () =>
    Effect.gen(function* () {
      const { dag, id } = yield* setup([node("A")], 1)
      yield* dag.pause(id)
      const first = yield* dag.recover(id, {
        nodeIDs: ["A"],
        expectedGraphRev: (yield* dag.store.getWorkflow(id))!.graphRev,
      })
      yield* TestClock.adjust(1)
      yield* dag.pause(id)
      expect((yield* dag.store.getWorkflow(id))?.status).toBe("paused")
      const rev = (yield* dag.store.getWorkflow(id))!.graphRev
      const old = yield* dag.recover(id, { nodeIDs: ["A"], expectedGraphRev: rev }).pipe(Effect.result)
      expect(old._tag).toBe("Failure")
      const exhausted = yield* dag
        .recover(id, { nodeIDs: [first.replacements[0].current], expectedGraphRev: rev })
        .pipe(Effect.result)
      expect(exhausted._tag).toBe("Failure")
      if (exhausted._tag === "Failure") expect(exhausted.failure.message).toContain("attempt ceiling")
      expect((yield* dag.store.getNodes(id)).length).toBe(2)
    }),
  )
})

// Dag.fail / Dag.cancel terminalize collateral rows without a node verdict:
// pending work becomes skipped(workflow_failed|workflow_cancelled) and running
// work aborted. Recovery must resume that work, not treat it as finished.
describe("DAG local recovery of workflow-termination collateral", () => {
  // Mirrors loop.ts rebuild: the runtime is seeded from getCurrentNodes.
  const runtimeOf = Effect.fn(function* (dag: Dag.Interface, id: string) {
    return new WorkflowRuntime(toSchedulingNodes(yield* dag.store.getCurrentNodes(id)), 4)
  })

  it.effect("reruns independent work skipped by workflow_failed alongside the selected failure", () =>
    Effect.gen(function* () {
      const { dag, id } = yield* setup([node("a"), node("c", ["a"]), node("e", ["a"])])
      yield* complete(dag, id, "a", "a done")
      yield* start(dag, id, "c")
      yield* dag.nodeFailed(id, "c", "boom", "exec_failed")
      yield* dag.fail(id, "required node(s) failed: c")
      expect(yield* dag.store.getNode(id, "e")).toMatchObject({ status: "skipped", errorReason: "workflow_failed" })

      const wf = (yield* dag.store.getWorkflow(id))!
      const recovered = yield* dag.recover(id, { nodeIDs: ["c"], expectedGraphRev: wf.graphRev })
      expect((yield* dag.store.getWorkflow(id))?.status).toBe("running")
      expect(recovered.superseded.sort()).toEqual(["c", "e"])
      expect(recovered.reused).toEqual(["a"])
      const retryC = recovered.replacements.find((r) => r.previous === "c")!.current
      const retryE = recovered.replacements.find((r) => r.previous === "e")!.current
      const config = Dag.parseWorkflowConfig((yield* dag.store.getWorkflow(id))!.config)!
      expect(config.nodes.find((n) => n.id === retryE)?.prompt_template.input?.__workflow_recovery).toMatchObject({
        previous_node_id: "e",
        previous_status: "skipped",
        previous_error: "workflow_failed",
      })
      expect((yield* runtimeOf(dag, id)).getReadyNodes().sort()).toEqual([retryC, retryE].sort())

      yield* complete(dag, id, retryC, "c done")
      const runtime = yield* runtimeOf(dag, id)
      expect(runtime.isComplete()).toBe(false)
      expect(runtime.getReadyNodes()).toEqual([retryE])
    }),
  )

  it.effect("reruns a required node aborted by cancellation when resuming the cancelled workflow", () =>
    Effect.gen(function* () {
      const { dag, id } = yield* setup([node("a"), node("b"), node("d", ["b"])])
      yield* start(dag, id, "a")
      yield* dag.nodeFailed(id, "a", "boom", "exec_failed")
      yield* start(dag, id, "b")
      yield* dag.cancel(id)
      expect(yield* dag.store.getNode(id, "b")).toMatchObject({ status: "aborted", errorReason: "workflow_cancelled" })
      expect(yield* dag.store.getNode(id, "d")).toMatchObject({ status: "skipped", errorReason: "workflow_cancelled" })

      const wf = (yield* dag.store.getWorkflow(id))!
      const recovered = yield* dag.recover(id, { nodeIDs: ["a"], expectedGraphRev: wf.graphRev, resumeCancelled: true })
      expect(recovered.superseded.sort()).toEqual(["a", "b", "d"])
      const retryA = recovered.replacements.find((r) => r.previous === "a")!.current
      const retryB = recovered.replacements.find((r) => r.previous === "b")!.current
      yield* complete(dag, id, retryA, "a done")

      const runtime = yield* runtimeOf(dag, id)
      expect(runtime.isComplete()).toBe(false)
      expect(runtime.getReadyNodes()).toEqual([retryB])
    }),
  )

  it.effect("keeps condition-skipped nodes out of the rerun set", () =>
    Effect.gen(function* () {
      const { dag, id } = yield* setup([node("a"), node("b", ["a"]), node("gated")])
      yield* start(dag, id, "gated")
      yield* dag.nodeSkipped(id, "gated", "condition_false")
      yield* start(dag, id, "a")
      yield* dag.nodeFailed(id, "a", "boom", "exec_failed")
      yield* dag.pause(id)
      const wf = (yield* dag.store.getWorkflow(id))!
      const recovered = yield* dag.recover(id, { nodeIDs: ["a"], expectedGraphRev: wf.graphRev })
      expect(recovered.superseded.sort()).toEqual(["a", "b"])
      expect(recovered.preserved).toEqual(["gated"])
    }),
  )
})
