import { describe, expect, it } from "bun:test"
import { DateTime, Deferred, Effect, Fiber, Layer, Option, Queue } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { WorkflowNodeTable, WorkflowTable } from "@opencode-ai/core/dag/sql"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

interface PromptGate {
  readonly title: string
  readonly release: Deferred.Deferred<string>
}

function takeWithin<A>(queue: Queue.Queue<A>, message: string) {
  return Queue.take(queue).pipe(
    Effect.timeoutOption("2 seconds"),
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new Error(message)),
      onSome: Effect.succeed,
    })),
  )
}

function reply(sessionID: string, text: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: sessionID as never,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: process.cwd(), root: process.cwd() },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never,
      providerID: "test" as never,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: text ? [{ type: "text", text }] as never : [],
  }
}

function nodeConfig(id: string, dependsOn: string[] = []): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    required: true,
    prompt_template: { inline: id },
    report_to_parent: false,
  }
}

function raceLayer(input: {
  readonly childPrompts: Queue.Queue<PromptGate>
  readonly cancelled: string[]
  readonly messages: (value: { sessionID: string; limit?: number }) => Effect.Effect<SessionV1.WithParts[]>
}) {
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
  const childTitles = new Map<string, string>()
  const created: string[] = []
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: () => Effect.succeed({ id: "ses_parent", permission: [], agent: "build" } as never),
    create: (value) =>
      Effect.sync(() => {
        const id = `ses_child_${created.length + 1}`
        created.push(id)
        childTitles.set(id, (value?.title ?? id).replace(" (DAG node)", ""))
        return { id } as never
      }),
    messages: (value) => input.messages(value as never) as never,
  })
  const prompt = Layer.mock(SessionPrompt.Service, withIdleAdmission({
    cancel: (sessionID) => Effect.sync(() => void input.cancelled.push(sessionID as string)),
    prompt: Effect.fn("test.SessionPrompt.prompt")(function* (value: SessionPrompt.PromptInput) {
      const sessionID = value.sessionID as string
      const release = yield* Deferred.make<string>()
      yield* Queue.offer(input.childPrompts, {
        title: childTitles.get(sessionID) ?? sessionID,
        release,
      })
      return reply(sessionID, yield* Deferred.await(release))
    }),
    // Keep wake delivery pending so the tests observe scheduling only.
    promptIfIdle: () => Effect.succeed(Option.none()),
  }))
  const agent = Layer.mock(Agent.Service, {
    get: () => Effect.succeed({
      name: "build",
      mode: "all",
      permission: [],
      options: {},
      description: "",
      prompt: "",
      model: { providerID: "test" as never, modelID: "test-model" as never },
      tools: {},
      hooks: {},
    }),
  })
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(agent),
  )
  return Layer.merge(base, loop)
}

function runRaceTest<A>(
  input: {
    readonly messages: (value: { sessionID: string; limit?: number }) => Effect.Effect<SessionV1.WithParts[]>
  },
  test: (services: {
    readonly dag: Dag.Interface
    readonly loop: DagLoop.Interface
    readonly store: DagStore.Interface
    readonly events: EventV2.Interface
    readonly database: Database.Interface
    readonly childPrompts: Queue.Queue<PromptGate>
    readonly cancelled: string[]
  }) => Effect.Effect<A, Error>,
) {
  return Effect.gen(function* () {
    const childPrompts = yield* Queue.unbounded<PromptGate>()
    const cancelled: string[] = []
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      yield* database.db.insert(ProjectTable).values({
        id: "project-1" as never,
        worktree: process.cwd() as never,
        sandboxes: [],
      }).run().pipe(Effect.orDie)
      yield* database.db.insert(SessionTable).values({
        id: "ses_parent" as never,
        project_id: "project-1" as never,
        slug: "parent",
        directory: process.cwd(),
        title: "Parent",
        version: "test",
      }).run().pipe(Effect.orDie)
      return yield* test({ dag, loop, store, events, database, childPrompts, cancelled })
    }).pipe(
      Effect.provide(raceLayer({ childPrompts, cancelled, messages: input.messages })),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: { id: "project-1" },
      } as never),
      Effect.scoped,
    )
  })
}

const activeReply = [{ info: { role: "assistant", finish: undefined } }] as never as SessionV1.WithParts[]

describe("DagLoop adoption idempotency", () => {
  it("adopts a workflow exactly once when a replan event races the startup scan", async () => {
    // The startup scan blocks inside reconciliation (first child status
    // probe); a WorkflowReplanned event arriving in that window finds no
    // runtimes entry and takes the re-adoption path. Without the synchronous
    // recovering reservation both adoptions run: reconciliation executes
    // twice (double child-session cancel) and the second runtimes.set
    // orphans the first entry's fibers.
    const gate = await Effect.runPromise(Deferred.make<void>())
    const childStatusCalls = { count: 0 }
    await Effect.runPromise(
      runRaceTest(
        {
          messages: (value) => {
            if (value.sessionID !== "ses_child1") return Effect.succeed([])
            childStatusCalls.count += 1
            if (childStatusCalls.count === 1) {
              return Deferred.await(gate).pipe(Effect.as(activeReply))
            }
            return Effect.succeed(activeReply)
          },
        },
        ({ dag, loop, store, events, cancelled }) =>
          Effect.gen(function* () {
            const dagID = yield* dag.create({
              projectID: "project-1",
              sessionID: "ses_parent",
              title: "Adoption race",
              config: { name: "adoption-race", nodes: [nodeConfig("n1"), nodeConfig("n2", ["n1"])] },
            })
            yield* dag.nodeStarted(dagID, "n1", "ses_child1")

            const initFiber = yield* loop.init().pipe(Effect.forkChild)
            yield* pollWithTimeout(
              Effect.sync(() => childStatusCalls.count === 1 ? true as const : undefined),
              "startup scan did not reach the child status probe",
            )
            yield* events.publish(DagEvent.WorkflowReplanned, {
              dagID: dagID as never,
              added: 0 as never,
              removed: 0 as never,
              replaced: 0 as never,
              restarted: 0 as never,
              timestamp: yield* DateTime.now,
            })
            // Give the WorkflowReplanned handler time to attempt re-adoption
            // while the scan is still blocked, then let the scan finish.
            yield* Effect.sleep("150 millis")
            yield* Deferred.succeed(gate, undefined)
            yield* Fiber.join(initFiber)

            expect(childStatusCalls.count).toBe(1)
            expect(cancelled).toEqual(["ses_child1"])
            expect((yield* store.getWorkflow(dagID))?.status).toBe("paused")
            expect((yield* store.getNode(dagID, "n1"))?.status).toBe("failed")
            expect((yield* store.getNode(dagID, "n2"))?.status).toBe("pending")
          }),
      ),
    )
  })
})

describe("DagLoop stepping race window", () => {
  it("does not spawn a second node when a stale stepped event lands while one is in flight", async () => {
    await Effect.runPromise(
      runRaceTest(
        { messages: () => Effect.succeed([]) },
        ({ dag, loop, store, events, database, childPrompts }) =>
          Effect.gen(function* () {
            const dagID = "dag_step_race"
            yield* database.db.transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.insert(WorkflowTable).values({
                  id: dagID,
                  project_id: "project-1" as never,
                  session_id: "ses_parent" as never,
                  directory: process.cwd(),
                  title: "Step race",
                  status: "stepping",
                  config: JSON.stringify({ name: "step-race", nodes: [nodeConfig("a"), nodeConfig("b")] }),
                  seq: 2,
                  wake_reported: false,
                }).run()
                yield* tx.insert(WorkflowNodeTable).values([
                  {
                    id: "a",
                    workflow_id: dagID,
                    name: "a",
                    worker_type: "build",
                    status: "pending",
                    required: true,
                    depends_on: [],
                    wake_eligible: false,
                    wake_reported: false,
                    seq: 1,
                  },
                  {
                    id: "b",
                    workflow_id: dagID,
                    name: "b",
                    worker_type: "build",
                    status: "pending",
                    required: true,
                    depends_on: [],
                    wake_eligible: false,
                    wake_reported: false,
                    seq: 0,
                  },
                ]).run()
              }),
            ).pipe(Effect.orDie)

            yield* loop.init()
            expect(yield* dag.step(dagID)).toEqual({ status: "stepping", nodeID: "a" })
            const first = yield* takeWithin(childPrompts, "stepped node a did not start")
            expect(first.title).toBe("a")

            // A second stepped event admitted on a snapshot that predated a's
            // spawn (the step race): the handler must re-check in-flight work
            // under the evalLock and refuse to put a second node in flight.
            yield* events.publish(DagEvent.WorkflowStepped, {
              dagID: dagID as never,
              nodeID: "b" as never,
              timestamp: yield* DateTime.now,
            })
            yield* Effect.sleep("150 millis")
            expect(Option.isNone(yield* Queue.poll(childPrompts))).toBe(true)
            expect((yield* store.getNode(dagID, "b"))?.status).toBe("pending")
            expect((yield* store.getNode(dagID, "a"))?.status).toBe("running")

            // The next explicit step after a settles advances exactly one node.
            yield* Deferred.succeed(first.release, "done")
            yield* pollWithTimeout(
              store.getNode(dagID, "a").pipe(
                Effect.map((item) => item?.status === "completed" ? item : undefined),
              ),
              "stepped node a did not complete",
            )
            expect(yield* dag.step(dagID)).toEqual({ status: "stepping", nodeID: "b" })
            const second = yield* takeWithin(childPrompts, "next step did not start node b")
            expect(second.title).toBe("b")
            yield* Deferred.succeed(second.release, "done")
            yield* pollWithTimeout(
              store.getWorkflow(dagID).pipe(
                Effect.map((workflow) => workflow?.status === "completed" ? workflow : undefined),
              ),
              "step-race workflow did not complete",
            )
          }),
      ),
    )
  })
})
