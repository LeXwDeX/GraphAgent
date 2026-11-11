// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- service mocks expose only the runtime surface exercised here
import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Option } from "effect"
import { and, eq } from "drizzle-orm"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { EventTable } from "@graphagent/core/event/sql"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagEvent } from "@graphagent/schema/dag-event"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { awaitWithTimeout, it, pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"
import { AgentScheduler } from "@/session/agent-scheduler"

interface Probe {
  readonly childCreated: Deferred.Deferred<string>
  readonly parentNotified: Deferred.Deferred<void>
  readonly created: string[]
}

function checkpointNodes(): NodeConfig[] {
  return [
    {
      id: "checkpoint",
      name: "Checkpoint",
      worker_type: "review",
      depends_on: [],
      required: true,
      report_to_parent: true,
      prompt_template: { inline: "decide" },
      output_schema: {
        type: "object",
        properties: { verdict: { type: "string" } },
        required: ["verdict"],
      },
    },
    {
      id: "downstream",
      name: "Downstream",
      worker_type: "build",
      depends_on: ["checkpoint"],
      required: true,
      condition: 'checkpoint.output.verdict == "continue"',
      skip_ok: true,
      prompt_template: { inline: "continue" },
    },
  ]
}

function reply(sessionID: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text: "acknowledged" }],
  } as never
}

function checkpointLayer(probe: Probe) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const base = Layer.mergeAll(database, events, bridge, store, projector, status, dag, AgentScheduler.defaultLayer)
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: () => Effect.succeed({ id: "ses_checkpoint_parent", permission: [], agent: "build" } as never),
    create: (input) =>
      Effect.gen(function* () {
        const id = `ses_checkpoint_child_${probe.created.length + 1}`
        probe.created.push(input?.title ?? id)
        yield* Deferred.succeed(probe.childCreated, id)
        return { id } as never
      }),
    messages: () => Effect.succeed([]),
  })
  const prompt = Layer.mock(
    SessionPrompt.Service,
    withIdleAdmission({
      cancel: () => Effect.void,
      prompt: (input: SessionPrompt.PromptInput) =>
        input.sessionID === "ses_checkpoint_parent"
          ? Deferred.succeed(probe.parentNotified, undefined).pipe(Effect.as(reply(input.sessionID)))
          : Effect.never,
      deliver: (input: SessionPrompt.PromptInput) =>
        input.sessionID === "ses_checkpoint_parent"
          ? Deferred.succeed(probe.parentNotified, undefined).pipe(Effect.as(Option.some(reply(input.sessionID))))
          : Effect.never,
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

function runCheckpointTest<A>(
  test: (services: {
    readonly dag: Dag.Interface
    readonly loop: DagLoop.Interface
    readonly store: DagStore.Interface
    readonly database: Database.Interface
    readonly probe: Probe
  }) => Effect.Effect<A, Error>,
) {
  return Effect.gen(function* () {
    const probe: Probe = {
      childCreated: yield* Deferred.make<string>(),
      parentNotified: yield* Deferred.make<void>(),
      created: [],
    }
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const database = yield* Database.Service
      yield* database.db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(process.cwd()), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionTable)
        .values({
          id: SessionID.make("ses_checkpoint_parent"),
          project_id: Project.ID.global,
          slug: "checkpoint-parent",
          directory: process.cwd(),
          title: "Checkpoint parent",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      return yield* test({ dag, loop, store, database, probe })
    }).pipe(
      Effect.provide(checkpointLayer(probe)),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: { id: Project.ID.global },
      } as never),
      Effect.scoped,
    )
  })
}

function persistCrashWindow(dag: Dag.Interface, output: unknown) {
  return Effect.gen(function* () {
    const dagID = yield* dag.create({
      projectID: Project.ID.global,
      sessionID: "ses_checkpoint_parent",
      title: "Checkpoint crash window",
      config: { name: "checkpoint-crash-window", nodes: checkpointNodes() },
    })
    yield* dag.nodeStarted(dagID, "checkpoint", "ses_checkpoint_worker", undefined, true)
    yield* dag.nodeCompleted(dagID, "checkpoint", output)
    return dagID
  })
}

function pauseEventCount(database: Database.Interface, dagID: string) {
  return database.db
    .select({ id: EventTable.id })
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, dagID),
        eq(EventTable.type, EventV2.versionedType(DagEvent.WorkflowPaused.type, 1)),
      ),
    )
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length),
    )
}

describe("DagLoop checkpoint crash recovery", () => {
  for (const [label, output] of [
    ["object", { verdict: "replan" }],
    ["JSON string", '{"verdict":"replan"}'],
  ] as const) {
    it.live(`recovers an unhandled ${label} veto before dispatch or completion`, () =>
      runCheckpointTest(({ dag, loop, store, probe }) =>
        Effect.gen(function* () {
          const dagID = yield* persistCrashWindow(dag, output)

          yield* loop.init()
          yield* awaitWithTimeout(
            Deferred.await(probe.parentNotified),
            "recovered checkpoint did not notify the parent",
          )

          expect(yield* store.getWorkflow(dagID)).toEqual(expect.objectContaining({ status: "paused" }))
          expect(yield* store.getNode(dagID, "checkpoint")).toEqual(
            expect.objectContaining({ status: "completed", output }),
          )
          expect(yield* store.getNode(dagID, "downstream")).toEqual(expect.objectContaining({ status: "pending" }))
          expect(probe.created).toEqual([])
        }),
      ),
    )
  }

  it.live("does not re-pause a veto acknowledged by resume", () =>
    runCheckpointTest(({ dag, loop, store, probe }) =>
      Effect.gen(function* () {
        const dagID = yield* persistCrashWindow(dag, { verdict: "replan" })
        yield* dag.pause(dagID)
        yield* dag.resume(dagID)

        yield* loop.init()
        yield* pollWithTimeout(
          store
            .getWorkflow(dagID)
            .pipe(Effect.map((workflow) => (workflow?.status === "completed" ? workflow : undefined))),
          "acknowledged checkpoint did not converge after recovery",
        )

        expect(yield* store.getNode(dagID, "downstream")).toEqual(
          expect.objectContaining({ status: "skipped", errorReason: "condition_false" }),
        )
        expect(probe.created).toEqual([])
      }),
    ),
  )

  it.live("preserves an explicit step after the checkpoint verdict", () =>
    runCheckpointTest(({ dag, loop, store, probe }) =>
      Effect.gen(function* () {
        const dagID = yield* persistCrashWindow(dag, { verdict: "replan" })
        expect(yield* dag.step(dagID)).toEqual({ status: "stepping", nodeID: "downstream" })

        yield* loop.init()

        expect(yield* store.getWorkflow(dagID)).toEqual(expect.objectContaining({ status: "stepping" }))
        expect(yield* store.getNode(dagID, "downstream")).toEqual(expect.objectContaining({ status: "pending" }))
        expect(probe.created).toEqual([])
      }),
    ),
  )

  it.live("keeps a later manual pause after replan without adding another pause", () =>
    runCheckpointTest(({ dag, loop, store, database, probe }) =>
      Effect.gen(function* () {
        const dagID = yield* persistCrashWindow(dag, { verdict: "replan" })
        yield* dag.pause(dagID)
        yield* dag.replan(dagID, { nodes: checkpointNodes() })
        expect(yield* pauseEventCount(database, dagID)).toBe(1)

        yield* loop.init()

        expect(yield* store.getWorkflow(dagID)).toEqual(expect.objectContaining({ status: "paused" }))
        expect(yield* pauseEventCount(database, dagID)).toBe(1)
        expect(probe.created).toEqual([])
      }),
    ),
  )

  it.live("treats a pause after the verdict as an unresolved hold without duplicating it", () =>
    runCheckpointTest(({ dag, loop, store, database, probe }) =>
      Effect.gen(function* () {
        const dagID = yield* persistCrashWindow(dag, { verdict: "replan" })
        yield* dag.pause(dagID)
        expect(yield* pauseEventCount(database, dagID)).toBe(1)

        yield* loop.init()
        yield* awaitWithTimeout(Deferred.await(probe.parentNotified), "paused checkpoint did not notify the parent")

        expect(yield* store.getWorkflow(dagID)).toEqual(expect.objectContaining({ status: "paused" }))
        expect(yield* store.getNode(dagID, "downstream")).toEqual(expect.objectContaining({ status: "pending" }))
        expect(yield* pauseEventCount(database, dagID)).toBe(1)
        expect(probe.created).toEqual([])
      }),
    ),
  )

  it.live("continues through recovery when the checkpoint verdict passes", () =>
    runCheckpointTest(({ dag, loop, store, probe }) =>
      Effect.gen(function* () {
        const dagID = yield* persistCrashWindow(dag, { verdict: "continue" })

        yield* loop.init()
        yield* awaitWithTimeout(
          Deferred.await(probe.childCreated),
          "passing checkpoint did not dispatch its downstream node",
        )
        yield* pollWithTimeout(
          store
            .getNode(dagID, "downstream")
            .pipe(Effect.map((node) => (node?.status === "running" ? node : undefined))),
          "passing checkpoint downstream did not start",
        )

        expect(yield* store.getWorkflow(dagID)).toEqual(expect.objectContaining({ status: "running" }))
        expect(yield* store.getNode(dagID, "downstream")).toEqual(expect.objectContaining({ status: "running" }))
      }),
    ),
  )
})
