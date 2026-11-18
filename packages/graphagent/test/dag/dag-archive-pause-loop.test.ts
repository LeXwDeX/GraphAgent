// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mocked service slices use `as never` shims.
// #1289: what the running DagLoop does with a workflow the archive paused
// (`Dag.pauseForArchive`). The in-flight nodes finish, the node that depends on
// them does not start, the pause survives the owner's restart (the startup
// adoption), and only an explicit resume lets the waiting node run. Every wait
// is on a published signal (a prompt reaching the mocked runner, a wake
// reaching the owner), never on wall-clock time.
import { describe, expect, it } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { Model } from "@graphagent/schema/model"
import { Provider } from "@graphagent/schema/provider"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { AgentScheduler } from "@/session/agent-scheduler"
import { withIdleAdmission } from "../lib/session-prompt"
import { mockSessionPrompt } from "../lib/child-runs"
import { awaitWithTimeout, pollWithTimeout } from "../lib/effect"
import { transactLayer } from "./fixture/transact"

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

/** `reporting` makes the node a reporting leaf: its result is a wake for the owner, which the test waits on. */
function node(id: string, dependsOn: string[] = [], reporting = false): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    required: true,
    prompt_template: { inline: id },
    ...(reporting ? { report_to_parent: true } : {}),
  }
}

/** The next item of a harness queue; a missing one fails the test with `what` instead of hanging it. */
const take = <A>(queue: Queue.Queue<A>, what: string) =>
  awaitWithTimeout(Queue.take(queue), `${what} never arrived`, "5 seconds")

type ChildPrompt = { sessionID: string; release: Deferred.Deferred<string>; interrupted: Deferred.Deferred<void> }
type ParentPrompt = { text: string; release: Deferred.Deferred<void> }

/** A DagLoop over an in-memory database; child prompts wait in a queue for the test to release them. */
const harness = Effect.gen(function* () {
  const childPrompts = yield* Queue.unbounded<ChildPrompt>()
  const parentPrompts = yield* Queue.unbounded<ParentPrompt>()
  let created = 0

  const deliver = Effect.fn("test.deliver")(function* (value: SessionPrompt.PromptInput) {
    const sessionID = value.sessionID as string
    if (sessionID === "ses_parent") {
      const release = yield* Deferred.make<void>()
      const text = value.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")
      yield* Queue.offer(parentPrompts, { text, release })
      yield* Deferred.await(release)
      return reply(sessionID, "parent handled wake")
    }
    const release = yield* Deferred.make<string>()
    const interrupted = yield* Deferred.make<void>()
    yield* Queue.offer(childPrompts, { sessionID, release, interrupted })
    return reply(
      sessionID,
      yield* Deferred.await(release).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
    )
  })

  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store), Layer.provide(transactLayer(database)))
  const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status, AgentScheduler.defaultLayer)
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: () =>
      Effect.succeed({
        id: SessionID.make("ses_parent"),
        slug: "parent",
        role: "root",
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
  const prompt = mockSessionPrompt(
    withIdleAdmission({
      cancel: () => Effect.void,
      prompt: deliver,
      deliver: (value) => deliver(value).pipe(Effect.map(Option.some)),
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
  return { childPrompts, parentPrompts, layer: Layer.mergeAll(base, loopLayer), created: () => created }
})

const seedOwner = Effect.gen(function* () {
  const db = yield* Database.Service
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
})

const inOwnerInstance = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(InstanceRef, {
      directory: process.cwd(),
      worktree: process.cwd(),
      project: { id: "project-1" },
    } as never),
    Effect.scoped,
  )

describe("DagLoop and a workflow the archive paused (#1289)", () => {
  it("lets the in-flight nodes finish, starts the dependent only after an explicit resume", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { childPrompts, parentPrompts, created, layer } = yield* harness
        yield* Effect.gen(function* () {
          const dag = yield* Dag.Service
          const loop = yield* DagLoop.Service
          const store = yield* DagStore.Service
          yield* seedOwner
          yield* loop.init()

          // `a` and `c` are roots and run at once; `b` waits for `a`.
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "archived",
            config: { name: "archived", nodes: [node("a"), node("b", ["a"]), node("c", [], true)] },
          })
          const prompts = [
            yield* take(childPrompts, "the first prompt"),
            yield* take(childPrompts, "the second prompt"),
          ]
          const promptOf = (nodeID: string) =>
            Effect.gen(function* () {
              const row = yield* store.getNode(dagID, nodeID)
              return prompts.find((prompt) => prompt.sessionID === row?.childSessionId)!
            })
          expect(created()).toBe(2)
          expect((yield* store.getNode(dagID, "b"))?.status).toBe("pending")

          // The owner session is archived while `a` and `c` are in flight.
          expect(yield* dag.pauseForArchive(dagID)).toBe("paused")
          const held = yield* store.getWorkflow(dagID)
          expect({ status: held?.status, reason: held?.pauseReason }).toEqual({ status: "paused", reason: "archived" })

          // `a` finishes first: the scheduler is offered `b`, whose only
          // dependency is now settled, and must not start it. Then `c` finishes
          // and wakes the owner with its result, as for any paused workflow. The
          // loop handles node terminal events in order and forks that wake after
          // the handler, so the wake is the point after which a start of `b`
          // would already have happened. This harness's session slice is not
          // marked archived (the test is about the workflow's pause), so the
          // wake is delivered; an archived owner's is withheld, which
          // dag-delivery.test.ts covers.
          yield* Deferred.succeed((yield* promptOf("a")).release, "a finished")
          yield* pollWithTimeout(
            Effect.map(store.getNode(dagID, "a"), (row) => (row?.status === "completed" ? true : undefined)),
            "node a never completed",
          )
          yield* Deferred.succeed((yield* promptOf("c")).release, "c finished")
          const wake = yield* take(parentPrompts, "the wake that carries the result of node c")
          expect(wake.text).toContain('Node "c" completed')
          expect((yield* store.getNode(dagID, "b"))?.status).toBe("pending")
          expect(created()).toBe(2)
          const settled = yield* store.getWorkflow(dagID)
          expect({ status: settled?.status, reason: settled?.pauseReason }).toEqual({
            status: "paused",
            reason: "archived",
          })
          yield* Deferred.succeed(wake.release, undefined)

          // The main agent resumes through the workflow control plane: `b` runs.
          yield* dag.resume(dagID)
          const next = yield* take(childPrompts, "the prompt of node b after the resume")
          expect(created()).toBe(3)
          expect((yield* store.getWorkflow(dagID))?.pauseReason).toBeNull()
          yield* Deferred.succeed(next.release, "b finished")
          const done = yield* pollWithTimeout(
            Effect.map(store.getWorkflow(dagID), (row) => (row?.status === "completed" ? row : undefined)),
            "the resumed workflow never completed",
          )
          expect(done.status).toBe("completed")
        }).pipe(Effect.provide(layer), inOwnerInstance)
      }),
    )
  })

  it("keeps the pause across the owner's restart: the startup adoption starts nothing, and only a resume does", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { childPrompts, created, layer } = yield* harness
        yield* Effect.gen(function* () {
          const dag = yield* Dag.Service
          const loop = yield* DagLoop.Service
          const store = yield* DagStore.Service
          yield* seedOwner

          // The state the previous process left behind: `a` done, `b` waiting,
          // the owner archived, the workflow held. The loop is not running yet.
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "restart",
            config: { name: "restart", nodes: [node("a"), node("b", ["a"])] },
          })
          yield* dag.nodeStarted(dagID, "a", "ses_child_a")
          yield* dag.nodeCompleted(dagID, "a", "a finished")
          expect(yield* dag.pauseForArchive(dagID)).toBe("paused")

          // The restart. `init` returns once the startup round has adopted every
          // row it found, so a resume it made would already be durable here.
          yield* loop.init()
          const adopted = yield* store.getWorkflow(dagID)
          expect({ status: adopted?.status, reason: adopted?.pauseReason }).toEqual({
            status: "paused",
            reason: "archived",
          })
          expect((yield* store.getNode(dagID, "b"))?.status).toBe("pending")
          expect(created()).toBe(0)

          // Resuming it, as the main agent does, is what starts `b`.
          yield* dag.resume(dagID)
          const next = yield* take(childPrompts, "the prompt of node b after the resume")
          expect(created()).toBe(1)
          yield* Deferred.succeed(next.release, "b finished")
        }).pipe(Effect.provide(layer), inOwnerInstance)
      }),
    )
  })

  it("reruns the node a budget pause cancelled when the main agent resumes the workflow the archive relabeled", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { childPrompts, created, layer } = yield* harness
        yield* Effect.gen(function* () {
          const dag = yield* Dag.Service
          const loop = yield* DagLoop.Service
          const store = yield* DagStore.Service
          yield* seedOwner
          yield* loop.init()

          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "budget-archive",
            config: { name: "budget-archive", nodes: [node("a")] },
          })
          const first = yield* take(childPrompts, "the prompt of node a")

          // The budget pauses the workflow and cancels `a`; the loop ends its
          // attempt. Then the owner session is archived.
          expect(yield* dag.pauseForBudget(dagID)).toBe("paused")
          yield* awaitWithTimeout(Deferred.await(first.interrupted), "the cancelled attempt was never interrupted")
          expect(yield* dag.pauseForArchive(dagID)).toBe("relabeled")
          const held = yield* store.getWorkflow(dagID)
          expect({ status: held?.status, reason: held?.pauseReason }).toEqual({ status: "paused", reason: "archived" })
          expect((yield* store.getNode(dagID, "a"))?.status).toBe("pending")
          expect(created()).toBe(1)

          // The main agent resumes: `a` gets a fresh attempt and the workflow runs on.
          yield* dag.resume(dagID)
          const second = yield* take(childPrompts, "the prompt of the fresh attempt of node a")
          expect(created()).toBe(2)
          yield* Deferred.succeed(second.release, "a finished")
          const done = yield* pollWithTimeout(
            Effect.map(store.getWorkflow(dagID), (row) => (row?.status === "completed" ? row : undefined)),
            "the resumed workflow never completed",
          )
          expect(done.status).toBe("completed")
        }).pipe(Effect.provide(layer), inOwnerInstance)
      }),
    )
  })
})
