import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { WorkspaceV2 } from "@graphagent/core/workspace"
import { DagEvent } from "@graphagent/schema/dag-event"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Dag, type NodeConfig } from "@/dag/dag"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { InstanceContext } from "@/project/instance-context"
import { SessionID } from "@/session/schema"
import { isRecord } from "@/util/record"
import { pollWithTimeout, testEffect } from "../lib/effect"

interface BatchProbe {
  failAtConfig: boolean
  invalidRecoveryFence?: "workflow" | "node"
  holdRegistered?: {
    entered: Deferred.Deferred<void>
    release: Deferred.Deferred<void>
  }
}

const directory = process.cwd()
const projectID = Project.ID.make("project-1")
const workspaceID = WorkspaceV2.ID.make("wrk_1")
const instance = {
  directory,
  worktree: directory,
  root: directory,
  project: {
    id: projectID,
    worktree: AbsolutePath.make(directory),
    time: { created: 0, updated: 0 },
    sandboxes: [],
  },
} satisfies InstanceContext

function node(id: string, prompt: string): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: prompt },
  }
}

function atomicLayer(probe: BatchProbe) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const eventsWithPriorListener = Layer.effect(
    EventV2.Service,
    Effect.gen(function* () {
      const service = yield* EventV2.Service
      const unsubscribe = yield* service.listen((event) => {
        const hold = probe.holdRegistered
        const data: unknown = event.data
        if (!hold || event.type !== DagEvent.NodeRegistered.type || !isRecord(data) || data.nodeID !== "replacement") {
          return Effect.void
        }
        return Deferred.succeed(hold.entered, undefined).pipe(Effect.andThen(Deferred.await(hold.release)))
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      return service
    }),
  ).pipe(Layer.provide(events))
  const rawBridge = EventV2Bridge.layer.pipe(Layer.provide(eventsWithPriorListener))
  const bridge = Layer.effect(
    EventV2Bridge.Service,
    Effect.gen(function* () {
      const original = yield* EventV2Bridge.Service
      return EventV2Bridge.Service.of({
        ...original,
        publishMany: (entries, options) => {
          if (probe.invalidRecoveryFence) {
            entries = entries.map((entry) => {
              if (entry.definition !== DagEvent.WorkflowReplanned || !isRecord(entry.data) || !isRecord(entry.data.recovery)) return entry
              const recovery = entry.data.recovery
              return { ...entry, data: { ...entry.data, recovery: {
                ...recovery,
                ...(probe.invalidRecoveryFence === "workflow" ? { expectedSeq: -1 } : { nodeSeqs: [] }),
              } } }
            })
          }
          const staged = entries.map((entry) =>
            probe.failAtConfig && entry.definition === DagEvent.WorkflowConfigUpdated
              ? {
                  ...entry,
                  options: {
                    ...entry.options,
                    // This hook runs after the config projector and before the
                    // event/sequence inserts. A defect here exercises rollback
                    // at the real transaction boundary, after earlier projectors
                    // in the replan batch have already executed.
                    commit: () => Effect.die(new Error("injected replan commit failure")),
                  },
                }
              : entry,
          )
          return original.publishMany(staged, options)
        },
      })
    }),
  ).pipe(Layer.provide(rawBridge))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(eventsWithPriorListener), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  return Layer.mergeAll(database, eventsWithPriorListener, bridge, store, projector, dag)
}

function setup() {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: projectID, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values({
        id: SessionID.make("ses_parent"),
        project_id: projectID,
        slug: "parent",
        directory: AbsolutePath.make(directory),
        title: "Parent",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

describe("Dag.replan atomic transaction (DAG-A03)", () => {
  const probe: BatchProbe = { failAtConfig: true }
  const it = testEffect(atomicLayer(probe))

  for (const status of ["queued"] as const) {
    it.live(`rejects a dependency on an omitted ${status} node before any durable mutation`, () =>
      Effect.gen(function* () {
        probe.failAtConfig = false
        yield* setup()
        const dag = yield* Dag.Service
        const store = yield* DagStore.Service
        const database = yield* Database.Service
        const dagID = yield* dag.create({
          projectID,
          sessionID: SessionID.make("ses_parent"),
          title: "Dependency closure",
          config: { name: "dependency-closure", nodes: [node("old", "Existing task")] },
        })
        // Seed the admission/pause snapshot under review; the test exercises
        // the host's durable replan boundary, not those earlier transitions.
        yield* database.db.update(WorkflowNodeTable).set({ status }).where(eq(WorkflowNodeTable.workflow_id, dagID)).run()
        const before = { workflow: yield* store.getWorkflow(dagID), nodes: yield* store.getNodes(dagID) }
        const result = yield* dag.replan(dagID, {
          nodes: [{ ...node("new", "Must wait for old"), depends_on: ["old"] }],
        }).pipe(Effect.result)
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(result.failure.message).toContain('depends on "old"')
        expect({ workflow: yield* store.getWorkflow(dagID), nodes: yield* store.getNodes(dagID) }).toEqual(before)
        expect(yield* store.getNode(dagID, "new")).toBeUndefined()
      }).pipe(Effect.provideService(InstanceRef, instance)),
    )
  }

  it.live("rolls back recovery revision, superseded history, new attempts, and events as one batch", () =>
    Effect.gen(function* () {
      yield* setup()
      const dag = yield* Dag.Service
      const store = yield* DagStore.Service
      const dagID = yield* dag.create({ projectID, sessionID: SessionID.make("ses_parent"), title: "Atomic recovery", config: { name: "atomic-recovery", nodes: [node("old", "Original task")] } })
      yield* dag.pause(dagID)
      const before = { workflow: yield* store.getWorkflow(dagID), nodes: yield* store.getNodes(dagID) }
      probe.failAtConfig = true
      const failed = yield* dag.recover(dagID, { nodeIDs: ["old"], expectedGraphRev: before.workflow!.graphRev }).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      expect({ workflow: yield* store.getWorkflow(dagID), nodes: yield* store.getNodes(dagID) }).toEqual(before)
      probe.failAtConfig = false
      for (const fence of ["workflow", "node"] as const) {
        probe.invalidRecoveryFence = fence
        const raced = yield* dag.recover(dagID, { nodeIDs: ["old"], expectedGraphRev: before.workflow!.graphRev }).pipe(Effect.exit)
        expect(Exit.isFailure(raced)).toBe(true)
        expect({ workflow: yield* store.getWorkflow(dagID), nodes: yield* store.getNodes(dagID) }).toEqual(before)
      }
      delete probe.invalidRecoveryFence
      const recovered = yield* dag.recover(dagID, { nodeIDs: ["old"], expectedGraphRev: before.workflow!.graphRev })
      expect(recovered.graphRev).toBe(before.workflow!.graphRev + 1)
      expect((yield* store.getNodes(dagID)).length).toBe(2)
    }).pipe(Effect.provideService(InstanceRef, instance)),
  )

  it.live("rejects an unreadable durable definition before changing any graph row or revision", () =>
    Effect.gen(function* () {
      probe.failAtConfig = false
      yield* setup()
      const dag = yield* Dag.Service
      const store = yield* DagStore.Service
      const database = yield* Database.Service
      const dagID = yield* dag.create({
        projectID,
        sessionID: SessionID.make("ses_parent"),
        title: "Invalid config replan",
        config: { name: "invalid-config", nodes: [node("old", "Original task")] },
      })
      yield* database.db.update(WorkflowTable).set({ config: "{broken" }).where(eq(WorkflowTable.id, dagID)).run()
      const before = {
        workflow: yield* store.getWorkflow(dagID),
        nodes: yield* store.getNodes(dagID),
      }
      const result = yield* dag.replan(dagID, { nodes: [node("new", "Replacement task")] }).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.message).toContain("current workflow config is invalid")
      expect({
        workflow: yield* store.getWorkflow(dagID),
        nodes: yield* store.getNodes(dagID),
      }).toEqual(before)
    }).pipe(Effect.provideService(InstanceRef, instance)),
  )

  it.live("rolls back the graph and forwards a committed batch past a yielding prior listener", () =>
    Effect.gen(function* () {
      probe.failAtConfig = true
      const priorListenerEntered = yield* Deferred.make<void>()
      const releasePriorListener = yield* Deferred.make<void>()
      probe.holdRegistered = { entered: priorListenerEntered, release: releasePriorListener }
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(releasePriorListener, undefined).pipe(
          Effect.andThen(Effect.sync(() => delete probe.holdRegistered)),
          Effect.asVoid,
        ),
      )
      yield* setup()

      const dag = yield* Dag.Service
      const events = yield* EventV2.Service
      const store = yield* DagStore.Service
      const dagID = yield* dag.create({
        projectID,
        sessionID: SessionID.make("ses_parent"),
        title: "Atomic replan",
        config: { name: "atomic-replan", nodes: [node("old", "Original task")] },
      })
      const before = {
        workflow: yield* store.getWorkflow(dagID),
        nodes: yield* store.getNodes(dagID),
      }
      const globalEvents = new Array<{
        kind: "event" | "sync"
        type: string
        seq?: number
        directory?: string
        project?: string
        workspace?: string
      }>()
      const onGlobal = (event: GlobalEvent) => {
        const payload: unknown = event.payload
        if (!isRecord(payload)) return
        const sync = isRecord(payload.syncEvent) ? payload.syncEvent : undefined
        const properties = isRecord(payload.properties) ? payload.properties : undefined
        const aggregateID = typeof sync?.aggregateID === "string" ? sync.aggregateID : undefined
        const propertiesDagID = typeof properties?.dagID === "string" ? properties.dagID : undefined
        if (aggregateID !== dagID && propertiesDagID !== dagID) return
        const syncType = typeof sync?.type === "string" ? sync.type : undefined
        const syncSeq = typeof sync?.seq === "number" ? sync.seq : undefined
        const type = syncType ?? (typeof payload.type === "string" ? payload.type : "unknown")
        const data = sync ? (isRecord(sync.data) ? sync.data : undefined) : properties
        if (
          (type === DagEvent.NodeRegistered.type || type === EventV2.versionedType(DagEvent.NodeRegistered.type, 1)) &&
          data?.nodeID !== "replacement"
        ) {
          return
        }
        globalEvents.push({
          kind: sync ? "sync" : "event",
          type,
          ...(syncSeq === undefined ? {} : { seq: syncSeq }),
          directory: event.directory,
          project: event.project,
          workspace: event.workspace,
        })
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", onGlobal)),
        () => Effect.sync(() => GlobalBus.off("event", onGlobal)),
      )
      const observer = yield* events.all().pipe(
        Stream.filter((event) => event.durable?.aggregateID === dagID),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* Effect.yieldNow

      const failed = yield* dag
        .replan(dagID, { nodes: [node("replacement", "Perform the approved replacement task")] })
        .pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      expect({
        workflow: yield* store.getWorkflow(dagID),
        nodes: yield* store.getNodes(dagID),
      }).toEqual(before)
      expect(globalEvents).toEqual([])

      probe.failAtConfig = false
      const plan = yield* dag.replan(dagID, {
        nodes: [node("replacement", "Perform the approved replacement task")],
      })
      expect(plan).toEqual({
        cancel: ["old"],
        restart: [],
        replace: [],
        add: ["replacement"],
        ignore: [],
      })
      yield* Deferred.await(priorListenerEntered).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.fail(new Error("prior EventV2 listener did not block NodeRegistered")),
        }),
      )

      const firstForwarded = yield* pollWithTimeout(
        Effect.sync(() => globalEvents[0]),
        "EventV2Bridge did not forward while the prior listener was blocked",
      )
      expect(firstForwarded).toEqual(expect.objectContaining({ kind: "event", type: DagEvent.NodeRegistered.type }))

      const workflow = yield* store.getWorkflow(dagID)
      const rows = yield* store.getNodes(dagID)
      expect(workflow?.graphRev).toBe((before.workflow?.graphRev ?? 0) + 1)
      expect(JSON.parse(workflow?.config ?? "{}").nodes).toEqual([
        expect.objectContaining({
          id: "replacement",
          prompt_template: { inline: "Perform the approved replacement task" },
        }),
      ])
      expect(rows.find((row) => row.id === "old")).toEqual(
        expect.objectContaining({ status: "failed", superseded: true, errorReason: "cancelled via replan" }),
      )
      expect(rows.find((row) => row.id === "replacement")).toEqual(
        expect.objectContaining({ status: "pending", superseded: false }),
      )

      const observed = Array.from(yield* Fiber.join(observer))
      expect(observed.map((event) => event.type)).toEqual([
        DagEvent.NodeRegistered.type,
        DagEvent.NodeCancelled.type,
        DagEvent.WorkflowConfigUpdated.type,
        DagEvent.WorkflowReplanned.type,
      ])
      expect(observed.map((event) => event.durable?.seq)).toEqual(
        observed.map((_, index) => observed[0].durable!.seq + index),
      )
      for (const event of observed) {
        const location = event.location as
          | { directory?: string; project?: { id: string; directory: string }; workspaceID?: string }
          | undefined
        expect(location?.directory).toBe(directory)
        expect(location?.project?.id).toBe(projectID)
        expect(location?.project?.directory).toBe(directory)
        expect(location?.workspaceID).toBe(workspaceID)
      }

      const forwarded = yield* pollWithTimeout(
        Effect.sync(() => (globalEvents.length === 8 ? globalEvents : undefined)),
        "EventV2Bridge did not forward the complete committed replan batch",
      )
      const expectedTypes = [
        DagEvent.NodeRegistered.type,
        DagEvent.NodeCancelled.type,
        DagEvent.WorkflowConfigUpdated.type,
        DagEvent.WorkflowReplanned.type,
      ]
      expect(forwarded.map((event) => ({ kind: event.kind, type: event.type }))).toEqual(
        expectedTypes.flatMap((type) => [
          { kind: "event", type },
          { kind: "sync", type: EventV2.versionedType(type, 1) },
        ]),
      )
      const sync = forwarded.filter((event) => event.kind === "sync")
      expect(sync.map((event) => event.seq)).toEqual(sync.map((_, index) => sync[0].seq! + index))
      for (const event of forwarded) {
        expect(event.directory).toBe(directory)
        expect(event.project).toBe(projectID)
        expect(event.workspace).toBe(workspaceID)
      }
      yield* Deferred.succeed(releasePriorListener, undefined)
    }).pipe(Effect.provideService(InstanceRef, instance), Effect.provideService(WorkspaceRef, workspaceID)),
  )
})
