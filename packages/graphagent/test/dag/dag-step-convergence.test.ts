// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion --
 * Branded test fixtures and Effect service mocks use the established DAG harness narrowing pattern. */
import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

const it = testEffect(Layer.empty)

interface PromptGate {
  readonly title: string
  readonly release: Deferred.Deferred<string>
}

function node(id: string, dependsOn: string[] = [], condition?: string): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    required: true,
    prompt_template: { inline: id },
    report_to_parent: false,
    ...(condition ? { condition } : {}),
  }
}

function reply(sessionID: string, text: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      sessionID: sessionID as never,
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text }] as never,
  } as never
}

function takeWithin<A>(queue: Queue.Queue<A>, message: string) {
  return Queue.take(queue).pipe(
    Effect.timeoutOption("2 seconds"),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new Error(message)),
        onSome: Effect.succeed,
      }),
    ),
  )
}

function stepLayer(childPrompts: Queue.Queue<PromptGate>) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status)
  const titles = new Map<string, string>()
  let created = 0
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: () => Effect.succeed({ id: "ses_parent", permission: [], agent: "build" } as never),
    create: (value) =>
      Effect.sync(() => {
        const id = `ses_child_${++created}`
        titles.set(id, (value?.title ?? id).replace(" (DAG node)", ""))
        return { id } as never
      }),
    messages: () => Effect.succeed([]),
  })
  const deliver = Effect.fn("test.SessionPrompt.deliver")(function* (value: SessionPrompt.PromptInput) {
    const sessionID = value.sessionID as string
    if (sessionID === "ses_parent") return reply(sessionID, "parent handled wake")
    const release = yield* Deferred.make<string>()
    yield* Queue.offer(childPrompts, { title: titles.get(sessionID) ?? sessionID, release })
    return reply(sessionID, yield* Deferred.await(release))
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

function runStepTest<A>(
  test: (services: {
    readonly dag: Dag.Interface
    readonly loop: DagLoop.Interface
    readonly store: DagStore.Interface
    readonly childPrompts: Queue.Queue<PromptGate>
  }) => Effect.Effect<A, Error>,
) {
  return Effect.gen(function* () {
    const childPrompts = yield* Queue.unbounded<PromptGate>()
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const database = yield* Database.Service
      yield* database.db
        .insert(ProjectTable)
        .values({ id: "project-1" as never, worktree: process.cwd() as never, sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionTable)
        .values({
          id: "ses_parent" as never,
          project_id: "project-1" as never,
          slug: "parent",
          directory: process.cwd() as never,
          title: "Parent",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      return yield* test({ dag, loop, store, childPrompts })
    }).pipe(
      Effect.provide(stepLayer(childPrompts)),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: { id: "project-1" },
      } as never),
    )
  })
}

function createGatedWorkflow(dag: Dag.Interface, withSibling = false) {
  return dag.create({
    projectID: "project-1",
    sessionID: "ses_parent",
    title: "Step convergence",
    config: {
      name: "step-convergence",
      nodes: [
        node("p"),
        { ...node("a", ["p"], 'p.output == "yes"'), skip_ok: true },
        { ...node("b", ["a"]), skip_ok: true },
        ...(withSibling ? [node("c")] : []),
      ],
    },
  })
}

function completeParent(dag: Dag.Interface, dagID: string) {
  return Effect.gen(function* () {
    yield* dag.nodeQueued(dagID, "p")
    yield* dag.nodeStarted(dagID, "p", "ses_parent_result")
    yield* dag.nodeCompleted(dagID, "p", "no")
  })
}

describe("Dag single-step skip convergence", () => {
  it.live("converges condition-false and dependent skips to workflow completion in one step", () =>
    runStepTest(({ dag, loop, store, childPrompts }) =>
      Effect.gen(function* () {
        const dagID = yield* createGatedWorkflow(dag)
        yield* completeParent(dag, dagID)

        // Reproduce a step event that occurred before the loop subscribed.
        expect(yield* dag.step(dagID)).toEqual({ status: "stepping", nodeID: "a" })
        yield* loop.init()
        expect(yield* dag.step(dagID)).toEqual({ status: "stepping", nodeID: "a" })

        const settled = yield* pollWithTimeout(
          Effect.gen(function* () {
            const workflow = yield* store.getWorkflow(dagID)
            const a = yield* store.getNode(dagID, "a")
            const b = yield* store.getNode(dagID, "b")
            return workflow?.status === "completed" ? { a, b } : undefined
          }),
          "step did not converge the skipped branch to completion",
        )
        expect(settled.a?.status).toBe("skipped")
        expect(settled.b?.status).toBe("skipped")
        expect(Option.isNone(yield* Queue.poll(childPrompts))).toBe(true)
      }),
    ),
  )

  it.live("uses a later step to recover an already-stranded skip cascade", () =>
    runStepTest(({ dag, loop, store, childPrompts }) =>
      Effect.gen(function* () {
        const dagID = yield* createGatedWorkflow(dag)
        yield* completeParent(dag, dagID)
        yield* dag.nodeSkipped(dagID, "a", "condition_false")

        expect(yield* dag.step(dagID)).toEqual({ status: "stepping", nodeID: "b" })
        yield* loop.init()
        expect(yield* dag.step(dagID)).toEqual({ status: "stepping", nodeID: "b" })

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const workflow = yield* store.getWorkflow(dagID)
            const b = yield* store.getNode(dagID, "b")
            return workflow?.status === "completed" && b?.status === "skipped" ? true : undefined
          }),
          "repeated step did not recover the stranded skip cascade",
        )
        expect(Option.isNone(yield* Queue.poll(childPrompts))).toBe(true)
      }),
    ),
  )

  it.live("does not dispatch a runnable sibling while the selected skip branch converges", () =>
    runStepTest(({ dag, loop, store, childPrompts }) =>
      Effect.gen(function* () {
        const dagID = yield* createGatedWorkflow(dag, true)
        yield* completeParent(dag, dagID)
        expect(yield* dag.step(dagID)).toEqual({ status: "stepping", nodeID: "a" })
        yield* loop.init()

        expect(yield* dag.step(dagID)).toEqual({ status: "stepping", nodeID: "a" })
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const a = yield* store.getNode(dagID, "a")
            const b = yield* store.getNode(dagID, "b")
            return a?.status === "skipped" && b?.status === "skipped" ? true : undefined
          }),
          "selected skip branch did not converge",
        )
        expect((yield* store.getNode(dagID, "c"))?.status).toBe("pending")
        expect(Option.isNone(yield* Queue.poll(childPrompts))).toBe(true)

        expect(yield* dag.step(dagID)).toEqual({ status: "stepping", nodeID: "c" })
        const child = yield* takeWithin(childPrompts, "runnable sibling did not start on its own step")
        expect(child.title).toBe("c")
        expect(Option.isNone(yield* Queue.poll(childPrompts))).toBe(true)
        yield* Deferred.succeed(child.release, "done")
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const workflow = yield* store.getWorkflow(dagID)
            return workflow?.status === "completed" ? true : undefined
          }),
          "workflow did not complete after the single dispatched sibling",
        )
      }),
    ),
  )
})
