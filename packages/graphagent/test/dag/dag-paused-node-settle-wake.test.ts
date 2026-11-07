// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mocked service slices use `as never` shims.
// Regression: a node that settles while its workflow is PAUSED. The node
// terminal handler calls checkCompletion with every node terminal; paused →
// completed/failed is not a legal transition, so checkCompletion must leave
// the workflow parked (completion is re-checked on resume) instead of failing
// the handler — which used to abort it BEFORE its `tryDeliverWake` fork, so the
// idle parent was never told the node result. A paused workflow is a wake
// delivery boundary: the parent is woken right away.
import { describe, expect, it } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { withIdleAdmission } from "../lib/session-prompt"

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
    parts: [{ type: "text", text }] as never,
  }
}

function node(id: string): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: id },
    report_to_parent: true,
  }
}

// Real-time wait that does not depend on the (virtual) Effect clock.
const realSleep = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))
const takeReal = <A>(queue: Queue.Queue<A>, ms = 3_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const item = yield* Queue.poll(queue)
      if (Option.isSome(item)) return item.value
      yield* realSleep(10)
    }
    return undefined
  })

describe("DagLoop node settling inside a paused workflow", () => {
  it("wakes the idle parent with the node result and completes on resume", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const childPrompts = yield* Queue.unbounded<{ sessionID: string; release: Deferred.Deferred<string> }>()
        const parentPrompts = yield* Queue.unbounded<{ text: string; release: Deferred.Deferred<void> }>()
        const parentSettled = yield* Queue.unbounded<void>()
        let created = 0

        const deliver = Effect.fn("test.deliver")(function* (value: SessionPrompt.PromptInput) {
          const sessionID = value.sessionID as string
          if (sessionID === "ses_parent") {
            const release = yield* Deferred.make<void>()
            const text = value.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")
            yield* Queue.offer(parentPrompts, { text, release })
            yield* Deferred.await(release).pipe(Effect.ensuring(Queue.offer(parentSettled, undefined)))
            return reply(sessionID, "parent handled wake")
          }
          const release = yield* Deferred.make<string>()
          yield* Queue.offer(childPrompts, { sessionID, release })
          return reply(sessionID, yield* Deferred.await(release))
        })

        const database = Database.layerFromPath(":memory:")
        const events = EventV2.layer.pipe(Layer.provide(database))
        const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
        const store = DagStore.layer.pipe(Layer.provide(database))
        const status = SessionStatus.layer.pipe(Layer.provide(bridge))
        const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
        const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
        const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status)
        const session = Layer.mock(Session.Service, {
          getPart: () => Effect.succeed(undefined),
          get: () =>
            Effect.succeed({
              id: SessionID.make("ses_parent"),
              slug: "parent",
              projectID: Project.ID.make("project-1"),
              directory: process.cwd(),
              title: "parent",
              agent: "build",
              model: { providerID: Provider.ID.make("test"), id: Model.ID.make("test-model") },
              version: "test",
              time: { created: 0, updated: 0 },
            }),
          create: () => Effect.sync(() => ({ id: `ses_child_${++created}` }) as never),
          messages: () => Effect.succeed([]),
        })
        const prompt = Layer.mock(
          SessionPrompt.Service,
          withIdleAdmission({
            cancel: () => Effect.void,
            prompt: deliver,
            promptIfIdle: (value) => deliver(value).pipe(Effect.map(Option.some)),
          }),
        )
        const agent = Layer.mock(Agent.Service, {
          get: () =>
            Effect.succeed({
              name: "build",
              mode: "all",
              permission: [],
              options: {},
              description: "",
              prompt: "",
              model: { providerID: Provider.ID.make("test"), modelID: Model.ID.make("test-model") },
              tools: {},
              hooks: {},
            }),
        })
        const loopLayer = DagLoop.layer.pipe(
          Layer.provide(base),
          Layer.provide(session),
          Layer.provide(prompt),
          Layer.provide(agent),
        )

        yield* Effect.gen(function* () {
          const dagSvc = yield* Dag.Service
          const loop = yield* DagLoop.Service
          const db = yield* Database.Service
          const storeSvc = yield* DagStore.Service
          const statusSvc = yield* SessionStatus.Service
          yield* db.db
            .insert(ProjectTable)
            .values({ id: Project.ID.make("project-1"), worktree: AbsolutePath.make(process.cwd()), sandboxes: [] })
            .run()
            .pipe(Effect.orDie)
          yield* db.db
            .insert(SessionTable)
            .values({
              id: SessionID.make("ses_parent"),
              project_id: Project.ID.make("project-1"),
              slug: "parent",
              directory: AbsolutePath.make(process.cwd()),
              title: "Parent",
              version: "test",
            })
            .run()
            .pipe(Effect.orDie)
          yield* loop.init()

          const dagID = yield* dagSvc.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Paused",
            config: { name: "paused", nodes: [node("a")] },
          })
          const child = yield* takeReal(childPrompts)
          expect(child).toBeDefined()
          // Parent parks the workflow, then ends its turn (session idle).
          yield* dagSvc.pause(dagID)
          expect((yield* storeSvc.getWorkflow(dagID))?.status).toBe("paused")
          // The in-flight node finishes while the workflow is paused.
          yield* Deferred.succeed(child!.release, "a finished")
          for (let i = 0; i < 100 && (yield* storeSvc.getNode(dagID, "a"))?.status !== "completed"; i++)
            yield* realSleep(10)
          expect((yield* storeSvc.getNode(dagID, "a"))?.status).toBe("completed")

          // Expected: the paused workflow is a delivery boundary, so the idle
          // parent is woken with node a's result right away.
          const wake = yield* takeReal(parentPrompts, 2_000)
          const delivered = wake?.text.includes('Node "a" completed') ?? false
          // Diagnostic: the batch WAS deliverable — any later idle event delivers it.
          let lateDelivered = false
          if (!delivered) {
            yield* statusSvc.set(SessionID.make("ses_parent"), { type: "idle" })
            lateDelivered = (yield* takeReal(parentPrompts, 2_000))?.text.includes('Node "a" completed') ?? false
          }
          expect({ delivered, lateDelivered }).toEqual({ delivered: true, lateDelivered: false })
          // The workflow stays parked: no illegal paused → terminal attempt.
          expect((yield* storeSvc.getWorkflow(dagID))?.status).toBe("paused")
          yield* Deferred.succeed(wake!.release, undefined)
          yield* takeReal(parentSettled, 500)

          // Resume re-checks completion and settles the fully-terminal graph.
          yield* dagSvc.resume(dagID)
          for (let i = 0; i < 200 && (yield* storeSvc.getWorkflow(dagID))?.status !== "completed"; i++)
            yield* realSleep(10)
          expect((yield* storeSvc.getWorkflow(dagID))?.status).toBe("completed")
        }).pipe(
          Effect.provide(Layer.mergeAll(base, loopLayer)),
          Effect.provideService(InstanceRef, {
            directory: process.cwd(),
            worktree: process.cwd(),
            project: { id: "project-1" },
          } as never),
          Effect.scoped,
        )
      }),
    )
  })
})
