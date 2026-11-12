// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mocked service slices use `as never` shims (same idiom as dag-fan-out-runtime.test.ts).
import { expect } from "bun:test"
import { Deferred, Effect, Layer, Option } from "effect"
import { logLines } from "effect/testing/TestConsole"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Model } from "@graphagent/schema/model"
import { Provider } from "@graphagent/schema/provider"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AgentScheduler } from "@/session/agent-scheduler"
import * as AgentSchedulerState from "@/session/agent-scheduler-state"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

// Issue #1021 acceptance: with the process-wide child-run limit at ONE, a
// workflow still completes. A node's slot is a single reservation that spans
// the workflow layer, the DAG-wide layer and the global child pool at once, so
// a pool of one is enough for one running node. The `max_concurrency` the
// workflow asks for (5 here) is truncated to the pool, which also makes nodes
// of one workflow run strictly one after another instead of deadlocking on a
// second slot.

/** One child-run slot for the whole process (the floor keeps a workflow slot available). */
const limits: AgentSchedulerState.SchedulerLimits = {
  ...AgentSchedulerState.DEFAULT_LIMITS,
  childGlobal: 1,
  taskReserve: 1,
}

const DIRECTORY = process.cwd()
const PROJECT_ID = "project-child-global-one"
const PARENT = "ses_child_global_one_parent"

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
      path: { cwd: DIRECTORY, root: DIRECTORY },
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
  }
}

/** A real DagLoop on a fresh scheduler with a pool of one child slot; children answer when the test lets them. */
function harness() {
  const scheduler = AgentScheduler.make(AgentSchedulerState.makeState(limits), () => Effect.succeed(limits))
  /** Peak child slots in use, read right after every grant (the only moment it can rise). */
  const peaks = { children: 0, workflow: 0 }
  const observed: AgentScheduler.Interface = {
    ...scheduler,
    childSlot: (limit, cap, options) =>
      scheduler.childSlot(limit, cap, options).pipe(
        Effect.tap(() =>
          Effect.gen(function* () {
            const snapshot = yield* scheduler.capacity(limit)
            peaks.children = Math.max(peaks.children, snapshot.children.running)
            peaks.workflow = Math.max(peaks.workflow, snapshot.limit?.used ?? 0)
          }),
        ),
      ),
  }

  const prompts = { started: [] as string[], active: 0, peak: 0, gates: [] as Deferred.Deferred<void>[] }
  const created: string[] = []

  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const base = Layer.mergeAll(
    database,
    events,
    bridge,
    store,
    projector,
    dag,
    status,
    Layer.succeed(AgentScheduler.Service, observed),
  )
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: () =>
      Effect.succeed({
        id: SessionID.make(PARENT),
        slug: "parent",
        projectID: Project.ID.make(PROJECT_ID),
        directory: DIRECTORY,
        title: "parent",
        agent: "build",
        model: { providerID: Provider.ID.make("test"), id: Model.ID.make("test-model") },
        version: "test",
        time: { created: 0, updated: 0 },
      }),
    create: () =>
      Effect.sync(() => {
        const id = `ses_child_global_one_${created.length + 1}`
        created.push(id)
        return { id } as never
      }),
    messages: () => Effect.succeed([]),
  })
  // A child answers once its gate opens; the parent (workflow wake) answers at once.
  const answer = (input: SessionPrompt.PromptInput) =>
    Effect.gen(function* () {
      const sessionID = input.sessionID as string
      if (sessionID === PARENT) return reply(sessionID, "parent handled wake")
      const gate = yield* Deferred.make<void>()
      prompts.started.push(sessionID)
      prompts.gates.push(gate)
      prompts.active += 1
      prompts.peak = Math.max(prompts.peak, prompts.active)
      yield* Deferred.await(gate).pipe(Effect.ensuring(Effect.sync(() => void (prompts.active -= 1))))
      return reply(sessionID, "node done")
    })
  const prompt = Layer.mock(
    SessionPrompt.Service,
    withIdleAdmission({
      cancel: () => Effect.void,
      prompt: answer,
      deliver: (input: SessionPrompt.PromptInput) => answer(input).pipe(Effect.map(Option.some)),
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
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(agent),
  )
  return { scheduler, peaks, prompts, created, layer: Layer.mergeAll(base, loop) }
}

const it = testEffect(Layer.empty)

/** Create a workflow with `nodes` asking for `max_concurrency: 5`, and start the loop. */
const start = (nodes: ReadonlyArray<NodeConfig>) =>
  Effect.gen(function* () {
    const dag = yield* Dag.Service
    const loop = yield* DagLoop.Service
    const db = yield* Database.Service
    yield* db.db
      .insert(ProjectTable)
      .values({ id: Project.ID.make(PROJECT_ID), worktree: AbsolutePath.make(DIRECTORY), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db.db
      .insert(SessionTable)
      .values({
        id: SessionID.make(PARENT),
        project_id: Project.ID.make(PROJECT_ID),
        slug: "parent",
        directory: AbsolutePath.make(DIRECTORY),
        title: "Parent",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    const dagID = yield* dag.create({
      projectID: PROJECT_ID,
      sessionID: PARENT,
      title: "child global one",
      config: { name: "child-global-one", max_concurrency: 5, nodes: [...nodes] },
    })
    yield* loop.init()
    return dagID
  })

const instance = Effect.provideService(InstanceRef, {
  directory: DIRECTORY,
  worktree: DIRECTORY,
  project: { id: PROJECT_ID },
} as never)

const waitForCompleted = (dagID: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const workflow = yield* (yield* DagStore.Service).getWorkflow(dagID)
      return workflow?.status === "completed" ? (true as const) : undefined
    }),
    "the workflow never completed with a child pool of one",
    "20 seconds",
  )

/** Wait (real time) until `count` child prompts have started. */
const waitForStarted = (prompts: { readonly started: string[] }, count: number) =>
  pollWithTimeout(
    Effect.sync(() => (prompts.started.length >= count ? (true as const) : undefined)),
    `fewer than ${count} child prompts started`,
    "20 seconds",
  )

it.live("a single-node workflow completes when the process child pool has one slot", () => {
  const h = harness()
  return Effect.gen(function* () {
    const dagID = yield* start([node("only")])
    yield* waitForStarted(h.prompts, 1)
    // The node holds the whole pool while it runs.
    expect((yield* h.scheduler.capacity()).children.running).toBe(1)
    expect((yield* h.scheduler.capacity({ kind: "workflow", workflowID: dagID })).limit?.used).toBe(1)
    yield* Deferred.succeed(h.prompts.gates[0], undefined)
    yield* waitForCompleted(dagID)

    expect(h.created).toHaveLength(1)
    expect(h.peaks.children).toBe(1)
    const settled = yield* h.scheduler.capacity()
    expect(settled.children.running).toBe(0)
    expect(settled.children.dagRunning).toBe(0)
  }).pipe(Effect.provide(h.layer), instance, Effect.scoped)
})

it.live("a workflow asking for max_concurrency 5 runs its nodes one at a time on a pool of one", () => {
  const h = harness()
  return Effect.gen(function* () {
    const dagID = yield* start([node("a"), node("b"), node("c")])
    const store = yield* DagStore.Service
    const statuses = () =>
      store.getNodes(dagID).pipe(Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.id, row.status]))))

    // Three independent nodes, five allowed: only one gets the slot; the others
    // wait queued instead of starting or deadlocking.
    yield* waitForStarted(h.prompts, 1)
    yield* pollWithTimeout(
      statuses().pipe(
        Effect.map((rows) =>
          Object.values(rows).filter((value) => value === "queued").length === 2 ? (true as const) : undefined,
        ),
      ),
      "the two other nodes never queued behind the single slot",
      "20 seconds",
    )
    expect(h.prompts.started).toHaveLength(1)
    expect(h.created).toHaveLength(1)
    const capacity = yield* h.scheduler.capacity({ kind: "workflow", workflowID: dagID })
    expect(capacity.children.running).toBe(1)
    // The requested cap of 5 was cut to the pool.
    expect(capacity.limit).toEqual({ key: { kind: "workflow", workflowID: dagID }, used: 1, cap: 1 })

    // Each finished node frees the slot for the next, until all three are done.
    for (let finished = 1; finished <= 3; finished++) {
      yield* Deferred.succeed(h.prompts.gates[finished - 1], undefined)
      if (finished < 3) yield* waitForStarted(h.prompts, finished + 1)
    }
    yield* waitForCompleted(dagID)

    expect(h.created).toHaveLength(3)
    expect(h.prompts.peak).toBe(1)
    expect(h.peaks).toEqual({ children: 1, workflow: 1 })
    expect(JSON.stringify(yield* logLines)).toContain("workflow concurrency truncated to the child pool")
    const settled = yield* h.scheduler.capacity()
    expect(settled.children.running).toBe(0)
    expect(settled.children.dagRunning).toBe(0)
  }).pipe(Effect.provide(h.layer), instance, Effect.scoped)
})
