// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mocked service slices use `as never` shims.
// Regression: DagLoop.deliverWake must release its per-session `wakeInFlight`
// reservation through an Effect finalizer. A generator `finally` does not run
// when the delivery fiber is interrupted (the 7-minute `tryDeliverWake` lease),
// fails, or dies, so the reservation used to leak and every later wake for
// that parent session was parked in `wakePending` until process restart.
import { describe, expect, it } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue } from "effect"
import * as TestClock from "effect/testing/TestClock"
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

const scenario = (mode: "none" | "expire" | "defect") =>
  Effect.runPromise(
    Effect.gen(function* () {
      const childPrompts = yield* Queue.unbounded<{ sessionID: string; release: Deferred.Deferred<string> }>()
      const parentPrompts = yield* Queue.unbounded<{ text: string; release: Deferred.Deferred<void> }>()
      const parentSettled = yield* Queue.unbounded<void>()
      let created = 0
      let getPartCalls = 0

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
        // "defect": the first durable-receipt lookup dies (any store/session
        // defect inside the delivery body has the same effect).
        getPart: () =>
          mode === "defect" && getPartCalls++ === 0 ? Effect.die(new Error("transient")) : Effect.succeed(undefined),
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

        // Workflow A completes; its terminal wake is admitted and the parent's
        // wake turn starts but runs past the 7-minute delivery lease.
        const first = yield* dagSvc.create({
          projectID: "project-1",
          sessionID: "ses_parent",
          title: "First",
          config: { name: "first", result_protocol: "submit_result", nodes: [node("a")] },
        })
        const childA = yield* takeReal(childPrompts)
        expect(childA).toBeDefined()
        yield* Deferred.succeed(childA!.release, "a done")
        for (let i = 0; i < 100 && (yield* storeSvc.getWorkflow(first))?.status !== "completed"; i++)
          yield* realSleep(10)
        expect((yield* storeSvc.getWorkflow(first))?.status).toBe("completed")
        if (mode !== "defect") {
          const wakeA = yield* takeReal(parentPrompts)
          expect(wakeA?.text).toContain("First")
          // The parent turn outlives the lease: the delivery fiber is interrupted.
          if (mode === "expire") yield* TestClock.adjust("7 minutes")
          // The parent turn itself then finishes normally (session idle again).
          yield* Deferred.succeed(wakeA!.release, undefined)
          yield* takeReal(parentSettled, 500)
        }

        // Workflow B later completes for the same, now-idle parent session.
        const second = yield* dagSvc.create({
          projectID: "project-1",
          sessionID: "ses_parent",
          title: "Second",
          config: { name: "second", result_protocol: "submit_result", nodes: [node("b")] },
        })
        const childB = yield* takeReal(childPrompts)
        expect(childB).toBeDefined()
        yield* Deferred.succeed(childB!.release, "b done")
        for (let i = 0; i < 100 && (yield* storeSvc.getWorkflow(second))?.status !== "completed"; i++)
          yield* realSleep(10)
        expect((yield* storeSvc.getWorkflow(second))?.status).toBe("completed")

        // The parent is woken with workflow B's terminal result. After a
        // died delivery, workflow A's batch is still unreported and is
        // (correctly) redelivered first; drain until B's wake arrives.
        let wakeB: { text: string; release: Deferred.Deferred<void> } | undefined
        for (let i = 0; i < 3; i++) {
          const wake = yield* takeReal(parentPrompts, 2_000)
          if (!wake) break
          yield* Deferred.succeed(wake.release, undefined)
          if (wake.text.includes("Second")) {
            wakeB = wake
            break
          }
        }
        expect(wakeB?.text).toContain("Second")
        expect((yield* storeSvc.getWorkflow(second))?.wakeReported).toBe(true)
      }).pipe(
        Effect.provide(Layer.mergeAll(base, loopLayer)),
        Effect.provideService(InstanceRef, {
          directory: process.cwd(),
          worktree: process.cwd(),
          project: { id: "project-1" },
        } as never),
        Effect.scoped,
      )
    }).pipe(Effect.provide(TestClock.layer())),
  )

describe("DagLoop wake in-flight reservation release", () => {
  it("delivers a later wake is delivered when the first wake turn finishes within the lease", async () => {
    await scenario("none")
  })
  it("delivers later wakes after a wake delivery hits the 7-minute lease timeout", async () => {
    await scenario("expire")
  })
  it("delivers later wakes after one wake delivery attempt dies with a defect", async () => {
    await scenario("defect")
  })
})
