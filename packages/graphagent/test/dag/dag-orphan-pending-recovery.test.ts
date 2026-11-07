import { describe, expect, it } from "bun:test"
import { DateTime, Effect, Layer, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { Agent } from "@/agent/agent"
import { Dag } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

const ORPHAN_REASON = "orphan pending workflow recovered at startup"

function orphanRecoveryLayer(input: { promptCalls: string[] }) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
  )
  const dag = Dag.layer.pipe(
    Layer.provide(bridge),
    Layer.provide(store),
  )
  const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status)
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    create: Effect.fn("test.Session.create")((_value?: unknown) =>
      Effect.sync(() => ({}) as never),
    ),
    get: Effect.fn("test.Session.get")(() => Effect.succeed({} as never)),
    messages: Effect.fn("test.Session.messages")(() => Effect.succeed([])),
  })
  const prompt = Layer.mock(SessionPrompt.Service, withIdleAdmission({
    cancel: Effect.fn("test.SessionPrompt.cancel")(() => Effect.void),
    prompt: Effect.fn("test.SessionPrompt.prompt")(() => {
      input.promptCalls.push("prompt")
      return Effect.never
    }),
    promptIfIdle: () => Effect.succeed(Option.none()),
  }))
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(Layer.mock(Agent.Service, {})),
  )
  return Layer.merge(base, loop)
}

function runOrphanRecovery<A>(
  test: (services: {
    dag: Dag.Interface
    database: Database.Interface
    loop: DagLoop.Interface
    events: EventV2.Interface
    store: DagStore.Interface
    promptCalls: string[]
  }) => Effect.Effect<A, Error>,
) {
  const promptCalls: string[] = []
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const database = yield* Database.Service
    const loop = yield* DagLoop.Service
    const events = yield* EventV2.Service
    const store = yield* DagStore.Service
    return yield* test({ dag, database, loop, events, store, promptCalls })
  }).pipe(
    Effect.provide(orphanRecoveryLayer({ promptCalls })),
    Effect.provideService(InstanceRef, {
      directory: process.cwd(),
      worktree: process.cwd(),
      project: { id: "project-1" },
    } as never),
    Effect.scoped,
  )
}

function seedProjectAndSession(database: Database.Interface) {
  return Effect.gen(function* () {
    yield* database.db.insert(ProjectTable).values({
      id: "project-1" as never,
      worktree: process.cwd() as never,
      sandboxes: [],
    }).run().pipe(Effect.orDie)
    yield* database.db.insert(SessionTable).values({
      id: "ses_parent1" as never,
      project_id: "project-1" as never,
      slug: "parent",
      directory: process.cwd() as never,
      title: "Parent",
      version: "test",
    }).run().pipe(Effect.orDie)
  })
}

// Publish the exact durable prefix Dag.create would write, then stop before
// WorkflowStarted — simulating a process crash between the create transactions.
function publishInterruptedCreate(
  events: EventV2.Interface,
  dagID: DagEvent.DagID,
  ts: DateTime.Utc,
  nodeCount: number,
) {
  return Effect.gen(function* () {
    yield* events.publish(DagEvent.WorkflowCreated, {
      dagID,
      projectID: "project-1" as never,
      sessionID: "ses_parent1" as never,
      title: "Orphan",
      config: JSON.stringify({ name: "orphan", nodes: [] }),
      status: "pending",
      timestamp: ts,
      directory: process.cwd(),
    })
    for (let i = 1; i <= nodeCount; i++) {
      yield* events.publish(DagEvent.NodeRegistered, {
        dagID,
        nodeID: `n${i}` as never,
        name: `Node ${i}`,
        workerType: "build",
        dependsOn: [],
        required: true,
        timestamp: ts,
      })
    }
  })
}

describe("DagLoop orphan pending recovery", () => {
  it("terminalizes a pending workflow whose create crashed before WorkflowStarted", async () => {
    await Effect.runPromise(
      runOrphanRecovery(({ database, loop, events, store, promptCalls }) =>
        Effect.gen(function* () {
          yield* seedProjectAndSession(database)
          const dagID = DagEvent.DagID.create()
          yield* publishInterruptedCreate(events, dagID, yield* DateTime.now, 2)

          const failures: Array<{ reason: string }> = []
          const unsubscribe = yield* events.listen((event) =>
            event.type === DagEvent.WorkflowFailed.type
              ? Effect.sync(() => failures.push(event.data as never))
              : Effect.void,
          )

          yield* loop.init()
          // Listener fan-out is async-ordered relative to publish (never rely
          // on it having run by the time init returns) — wait for the durable
          // failure to surface before unsubscribing.
          yield* pollWithTimeout(
            Effect.sync(() => (failures.some((f) => f.reason === ORPHAN_REASON) ? failures : undefined)),
            "WorkflowFailed recovery reason was not observed",
          )
          yield* unsubscribe

          const wf = yield* store.getWorkflow(dagID)
          expect(wf?.status).toBe("failed")
          expect((yield* store.getNodes(dagID)).map((n) => n.status)).toEqual(["skipped", "skipped"])
          expect(failures).toContainEqual(expect.objectContaining({ reason: ORPHAN_REASON }))
          // The WorkflowStarted published for the terminalization leg must not
          // be adopted: no node may be scheduled on a dead workflow.
          expect(promptCalls).toEqual([])
        }),
      ),
    )
  })

  it("terminalizes a zero-node orphan pending workflow", async () => {
    await Effect.runPromise(
      runOrphanRecovery(({ database, loop, events, store }) =>
        Effect.gen(function* () {
          yield* seedProjectAndSession(database)
          const dagID = DagEvent.DagID.create()
          yield* publishInterruptedCreate(events, dagID, yield* DateTime.now, 0)

          yield* loop.init()

          expect((yield* store.getWorkflow(dagID))?.status).toBe("failed")
        }),
      ),
    )
  })

  it("leaves a pending workflow with a non-pending node untouched", async () => {
    await Effect.runPromise(
      runOrphanRecovery(({ database, loop, events, store }) =>
        Effect.gen(function* () {
          yield* seedProjectAndSession(database)
          const dagID = DagEvent.DagID.create()
          const ts = yield* DateTime.now
          yield* publishInterruptedCreate(events, dagID, ts, 1)
          // A node that already progressed proves the workflow was adopted and
          // mid-flight — the defensive criterion must not terminalize it.
          yield* events.publish(DagEvent.NodeStarted, {
            dagID,
            nodeID: "n1" as never,
            childSessionID: "ses_child1" as never,
            timestamp: yield* DateTime.now,
          })

          yield* loop.init()

          expect((yield* store.getWorkflow(dagID))?.status).toBe("pending")
          expect((yield* store.getNode(dagID, "n1"))?.status).toBe("running")
        }),
      ),
    )
  })
})
