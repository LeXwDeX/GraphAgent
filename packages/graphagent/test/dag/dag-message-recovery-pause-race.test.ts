import { describe, expect } from "bun:test"
import { DateTime, Deferred, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { Project } from "@opencode-ai/schema/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Agent } from "@/agent/agent"
import { Dag } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const parent = SessionID.make("ses_recovery_parent")
const child = SessionID.make("ses_recovery_child")
const workflowID = DagEvent.DagID.make("dag_message_pause_race")

function recoveryLayer(probe: {
  gate: Deferred.Deferred<void>
  release: Deferred.Deferred<void>
  resumed: string[]
  armed: boolean
  fail?: boolean
}) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const rawStore = DagStore.layer.pipe(Layer.provide(database))
  const store = Layer.effect(
    DagStore.Service,
    Effect.gen(function* () {
      const original = yield* DagStore.Service
      let reads = 0
      return DagStore.Service.of({
        ...original,
        getNode: (dagID, nodeID) =>
          Effect.gen(function* () {
            // The loop reads the attempt once before forking; hold the helper's
            // first read so an explicit pause wins before its phase check.
            if (probe.armed && dagID === workflowID && nodeID === "worker" && ++reads === 2) {
              yield* Deferred.succeed(probe.gate, undefined)
              yield* Deferred.await(probe.release)
            }
            return yield* original.getNode(dagID, nodeID)
          }),
      })
    }),
  ).pipe(Layer.provide(rawStore))
  const projector = DagProjector.layer.pipe(Layer.provide(Layer.merge(database, events)))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const base = Layer.mergeAll(database, events, bridge, store, projector, status, dag)
  const messages = Layer.mock(DagMessages.Service, {
    pendingRecipients: () => Effect.succeed([]),
    latestSnapshot: () => Effect.succeed({ ok: true, value: undefined }),
    revisions: () =>
      Effect.succeed({
        ok: true,
        value: {
          endpoint: { id: "child-endpoint", kind: "node", sessionID: child },
          accepted: 1,
          snapshot: 0,
          queued: 1,
          delivered: 0,
          undeliverable: 0,
        },
      }),
  })
  const session = Layer.unwrap(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return Layer.mock(Session.Service, {
        get: (sessionID) =>
          db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get()
            .pipe(
              Effect.orDie,
              Effect.flatMap((row) =>
                row ? Effect.succeed(Session.fromRow(row)) : Effect.die(new Error("missing fixture session")),
              ),
            ),
        messages: () => Effect.succeed([]),
        getPart: () => Effect.succeed(undefined),
      })
    }),
  ).pipe(Layer.provide(database))
  const prompt = Layer.mock(SessionPrompt.Service, {
    cancel: () => Effect.void,
    loop: (input) =>
      Effect.sync(() => probe.resumed.push(input.sessionID)).pipe(
        Effect.andThen(
          Effect.suspend(() => (probe.fail ? Effect.die(new Error("recovered provider defect")) : Effect.never)),
        ),
      ),
  })
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(messages),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(Layer.mock(Agent.Service, {})),
  )
  return Layer.mergeAll(base, loop)
}

const it = testEffect(Layer.empty)

describe("DAG message recovery initial pause race", () => {
  for (const failure of [false, true])
    it.instance(
      failure
        ? "settles a recovered helper defect without leaving its attempt in flight"
        : "re-arms the original child attempt when pause wins before the continuation begins",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const probe = {
            gate: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
            resumed: [] as string[],
            armed: false,
            fail: failure,
          }
          const project = {
            id: Project.ID.make("project-message-race"),
            worktree: test.directory,
            time: { created: 0, updated: 0 },
            sandboxes: [],
          }
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            const events = yield* EventV2.Service
            const dag = yield* Dag.Service
            const store = yield* DagStore.Service
            yield* db
              .insert(ProjectTable)
              .values({ id: project.id, worktree: AbsolutePath.make(test.directory), sandboxes: [] })
              .run()
              .pipe(Effect.orDie)
            for (const sessionID of [parent, child])
              yield* db
                .insert(SessionTable)
                .values({
                  id: sessionID,
                  project_id: project.id,
                  directory: AbsolutePath.make(test.directory),
                  parent_id: sessionID === child ? parent : undefined,
                  slug: sessionID,
                  title: sessionID,
                  version: "test",
                })
                .run()
                .pipe(Effect.orDie)
            const timestamp = yield* DateTime.now
            yield* events.publish(DagEvent.WorkflowCreated, {
              dagID: workflowID,
              projectID: project.id,
              sessionID: parent,
              title: "Message recovery",
              directory: test.directory,
              status: "pending",
              timestamp,
              config: JSON.stringify({
                name: "message recovery",
                nodes: [
                  {
                    id: "worker",
                    name: "Worker",
                    worker_type: "build",
                    depends_on: [],
                    required: true,
                    prompt_template: { inline: "Investigate" },
                  },
                ],
              }),
            })
            yield* events.publish(DagEvent.NodeRegistered, {
              dagID: workflowID,
              nodeID: DagEvent.NodeID.make("worker"),
              name: "Worker",
              workerType: "build",
              dependsOn: [],
              required: true,
              timestamp,
            })
            yield* events.publish(DagEvent.WorkflowStarted, { dagID: workflowID, timestamp })
            yield* dag.nodeQueued(workflowID, "worker")
            yield* dag.nodeStarted(workflowID, "worker", child)
            expect((yield* store.getNode(workflowID, "worker"))?.status).toBe("running")
            probe.armed = true
            yield* (yield* DagLoop.Service).init()
            yield* Deferred.await(probe.gate).pipe(Effect.timeout("2 seconds"))
            if (failure) {
              yield* Deferred.succeed(probe.release, undefined)
              yield* pollWithTimeout(
                store
                  .getNode(workflowID, "worker")
                  .pipe(Effect.map((node) => (node?.status === "failed" ? true : undefined))),
                "defective recovered helper left its attempt running",
              )
              const failed = yield* store.getNode(workflowID, "worker")
              expect(failed).toMatchObject({
                status: "failed",
                childSessionId: child,
                replanAttempts: 0,
                errorClass: "exec_failed",
              })
              expect(failed?.errorReason).toContain("recovered provider defect")
              expect(probe.resumed).toEqual([child])
              yield* pollWithTimeout(
                store
                  .getWorkflow(workflowID)
                  .pipe(Effect.map((workflow) => (workflow?.status === "failed" ? true : undefined))),
                "dead recovered fiber suppressed durable failure completion",
              )
              expect((yield* store.getWorkflow(workflowID))?.status).toBe("failed")
              return
            }
            yield* dag.pause(workflowID)
            yield* Deferred.succeed(probe.release, undefined)
            yield* Effect.sleep(100)
            expect(probe.resumed).toEqual([])
            yield* dag.resume(workflowID)
            yield* pollWithTimeout(
              Effect.sync(() => (probe.resumed.length > 0 ? true : undefined)),
              "resumed attempt was stranded",
            )
            expect(probe.resumed).toEqual([child])
            const node = yield* store.getNode(workflowID, "worker")
            expect(node?.childSessionId).toBe(child)
            expect(node?.replanAttempts).toBe(0)
          }).pipe(
            Effect.provide(recoveryLayer(probe)),
            Effect.provideService(InstanceRef, {
              directory: test.directory,
              worktree: test.directory,
              root: test.directory,
              project,
            }),
            Effect.scoped,
          )
        }),
    )
})
