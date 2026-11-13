// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
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
import { Goal } from "@/goal/goal"
import { ExclusiveRegistry } from "@/session/engine-process"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"
import { AgentScheduler } from "@/session/agent-scheduler"
import { mockSessionPrompt } from "../lib/child-runs"

// GOAL-FP-01-01 / GOAL-FP-01-03: the DAG exclusive-registry registration lifetime
// must be bound to WORKFLOW STATE, not to wake delivery.
//
//   -01: after a restart, a session whose snapshot contains only terminal
//        workflows (one already wake-reported) must not get a dag registration
//        from the startup wake sweep — the active goal must remain claimable.
//   -03: a workflow that terminalizes without a successful wake delivery must
//        release its dag registration from the terminal event handler.
//
// Real DagLoop startup sweep + real ExclusiveRegistry + real DagStore /
// Projector / EventV2 over an in-memory database; Session / SessionPrompt /
// Agent are mocked exactly like the wake-integration harness.

interface ChildPromptGate {
  readonly title: string
  readonly release: Deferred.Deferred<string>
}

const PARENT_SESSION = "ses_parent"
const PROJECT_ID = "project-1"

function node(id: string, dependsOn: string[] = []): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    required: true,
    prompt_template: { inline: id },
    report_to_parent: true,
  }
}

function reply(sessionID: string, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: SessionID.make(sessionID),
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: process.cwd(), root: process.cwd() },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: Model.ID.make("test-model"),
      providerID: Provider.ID.make("test"),
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: text
      ? [{ id: PartID.ascending(), sessionID: SessionID.make(sessionID), messageID: id, type: "text", text }]
      : [],
  }
}

function takeWithin<A>(queue: Queue.Queue<A>, message: string) {
  return Queue.take(queue).pipe(
    Effect.timeoutOption("1 second"),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new Error(message)),
        onSome: Effect.succeed,
      }),
    ),
  )
}

function leaseLifecycleLayer(input: { childPrompts: Queue.Queue<ChildPromptGate> }) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const goal = Goal.layer.pipe(Layer.provide(bridge), Layer.provide(database), Layer.provide(status))
  const base = Layer.mergeAll(
    database,
    events,
    bridge,
    store,
    projector,
    dag,
    goal,
    status,
    AgentScheduler.defaultLayer,
  )
  const childTitles = new Map<string, string>()
  const created: string[] = []
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: (sessionID) =>
      sessionID === "ses_child_ghost"
        ? // Simulated session-store DEFECT: a die passes through the checker's
          // catchTag("NotFoundError") (recovery.ts: "any other failure must
          // propagate"), so reconcileWorkflow aborts recoverWorkflow for the
          // ghost workflow — leaving its row non-terminal with NO runtime
          // entry, the P2-A registration-leak precondition.
          Effect.die("simulated session store defect (ghost child)")
        : Effect.succeed({
            id: SessionID.make(PARENT_SESSION),
            slug: "parent",
            projectID: Project.ID.make(PROJECT_ID),
            directory: process.cwd(),
            title: "Parent",
            version: "test",
            time: { created: 0, updated: 0 },
            permission: [],
            agent: "build",
          }),
    create: (value) =>
      Effect.sync(() => {
        const id = `ses_child_${created.length + 1}`
        created.push(id)
        childTitles.set(id, (value?.title ?? id).replace(" (DAG node)", ""))
        return {
          id: SessionID.make(id),
          slug: "child",
          projectID: Project.ID.make(PROJECT_ID),
          directory: process.cwd(),
          title: value?.title ?? id,
          version: "test",
          time: { created: 0, updated: 0 },
        }
      }),
    messages: () => Effect.succeed([]),
  })
  const deliver = Effect.fn("test.dagLease.SessionPrompt.deliver")(function* (value: SessionPrompt.PromptInput) {
    const sessionID = value.sessionID as string
    if (sessionID === PARENT_SESSION) {
      // Both scenarios require the parent wake delivery to FAIL (or never be
      // attempted): the release path under test is workflow state, not
      // delivery. Die loudly — if a parent wake is actually delivered here,
      // the test premise is broken and the failure must not be silent.
      return yield* Effect.die(new Error("parent wake delivery must not succeed in lease-lifecycle scenarios"))
    }
    const release = yield* Deferred.make<string>()
    yield* Queue.offer(input.childPrompts, { title: childTitles.get(sessionID) ?? sessionID, release })
    return reply(sessionID, yield* Deferred.await(release))
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
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(agent),
  )
  // DagLoop.layer consumes the lease internally (its Layer.provide does not
  // re-expose it). Merge the SAME module-level layer at the top so the test
  // body can observe the lease; Layer.build memoization dedups the shared
  // layer reference, so it is the very instance DagLoop and Goal use.
  return Layer.mergeAll(base, loop, ExclusiveRegistry.defaultLayer)
}

function runLeaseTest<A>(
  test: (services: {
    readonly dag: Dag.Interface
    readonly loop: DagLoop.Interface
    readonly store: DagStore.Interface
    readonly goal: Goal.Interface
    readonly status: SessionStatus.Interface
    readonly automation: ExclusiveRegistry.Interface
    readonly database: Database.Interface
    readonly childPrompts: Queue.Queue<ChildPromptGate>
  }) => Effect.Effect<A, Error>,
) {
  return Effect.gen(function* () {
    const childPrompts = yield* Queue.unbounded<ChildPromptGate>()
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const goal = yield* Goal.Service
      const status = yield* SessionStatus.Service
      const automation = yield* ExclusiveRegistry.Service
      const database = yield* Database.Service
      yield* database.db
        .insert(ProjectTable)
        .values({
          id: Project.ID.make(PROJECT_ID),
          worktree: AbsolutePath.make(process.cwd()),
          sandboxes: [],
        })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionTable)
        .values({
          id: SessionID.make(PARENT_SESSION),
          project_id: Project.ID.make(PROJECT_ID),
          slug: "parent",
          directory: AbsolutePath.make(process.cwd()),
          title: "Parent",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      return yield* test({ dag, loop, store, goal, status, automation, database, childPrompts })
    }).pipe(
      Effect.provide(leaseLifecycleLayer({ childPrompts })),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        root: process.cwd(),
        project: {
          id: Project.ID.make(PROJECT_ID),
          worktree: process.cwd(),
          time: { created: 0, updated: 0 },
          sandboxes: [],
        },
      }),
      Effect.scoped,
    )
  })
}

describe("DagLoop lease lifecycle — startup wake sweep (GOAL-FP-01-01)", () => {
  it("a restarted session whose snapshot holds only terminal workflows leaves the goal claimable", async () => {
    await Effect.runPromise(
      runLeaseTest(({ loop, goal, status, automation, database }) =>
        Effect.gen(function* () {
          const sid = SessionID.make(PARENT_SESSION)

          // Historical crash snapshot: two terminal workflows under the same
          // session. dag-wf-done was already wake-reported before the crash;
          // dag-wf-undone terminalized without a delivered wake (it is what
          // makes the session visible to the startup wake sweep).
          yield* database.db
            .insert(WorkflowTable)
            .values({
              id: "dag-wf-done",
              project_id: Project.ID.make(PROJECT_ID),
              session_id: SessionID.make(PARENT_SESSION),
              directory: process.cwd(),
              target_fingerprint: { kind: "none" },
              title: "already reported",
              status: "completed",
              config: "",
              seq: 1,
              wake_reported: true,
            })
            .run()
            .pipe(Effect.orDie)
          yield* database.db
            .insert(WorkflowTable)
            .values({
              id: "dag-wf-undone",
              project_id: Project.ID.make(PROJECT_ID),
              session_id: SessionID.make(PARENT_SESSION),
              directory: process.cwd(),
              target_fingerprint: { kind: "none" },
              title: "terminal before delivery",
              status: "failed",
              config: "",
              seq: 2,
              wake_reported: false,
            })
            .run()
            .pipe(Effect.orDie)

          // An active goal survived the restart (Goal.set registers the goal
          // owner with the shared ExclusiveRegistry, like GoalLoop).
          const goalState = yield* goal.set(sid, "ship the feature", 10)
          const goalOwner = { kind: "goal" as const, id: goalState.goal_id ?? "legacy" }

          // The session is NOT idle when DagLoop boots, so the forked wake
          // redelivery aborts before it can register or deliver anything:
          // the sweep's own registration decision is the only dag-lease input.
          yield* status.set(sid, { type: "busy" })

          // Restart: DagLoop.init runs the startup wake sweep synchronously.
          yield* loop.init()

          // Public contract: the goal must be claimable (owner() is goal, not
          // a leaked dag registration from a terminal workflow).
          expect(Option.isSome(yield* automation.claim(sid, goalOwner))).toBe(true)
          expect(Option.isNone(yield* automation.claim(sid, { kind: "dag" }))).toBe(true)
        }),
      ),
    )
  })
})

describe("DagLoop lease lifecycle — terminal event release (GOAL-FP-01-03)", () => {
  it("a workflow that terminalizes without a successful wake delivery releases its dag lease", async () => {
    await Effect.runPromise(
      runLeaseTest(({ dag, loop, store, goal, status, automation, childPrompts }) =>
        Effect.gen(function* () {
          const sid = SessionID.make(PARENT_SESSION)

          // The parent never goes idle: the wake redelivery aborts before
          // registering/delivering, so the terminal event handler is the only
          // possible release path for the dag registration.
          yield* status.set(sid, { type: "busy" })
          yield* loop.init()

          const dagID = yield* dag.create({
            projectID: PROJECT_ID,
            sessionID: PARENT_SESSION,
            title: "lease release",
            config: { name: "lease-release", nodes: [node("implement")] },
          })

          // Adoption (WorkflowStarted) registered the dag lease for the parent.
          const child = yield* takeWithin(childPrompts, "implement did not start")
          expect(Option.isSome(yield* automation.claim(sid, { kind: "dag" }))).toBe(true)

          // Complete the node → workflow terminalizes → terminal event handler.
          yield* Deferred.succeed(child.release, "done")
          yield* pollWithTimeout(
            store
              .getWorkflow(dagID)
              .pipe(Effect.map((workflow) => (workflow?.status === "completed" ? workflow : undefined))),
            "workflow did not complete",
          )

          // Public contract: the terminal event handler must release the dag
          // lease even though no wake delivery ever succeeded.
          yield* pollWithTimeout(
            automation
              .claim(sid, { kind: "dag" })
              .pipe(Effect.map((token) => (Option.isNone(token) ? true : undefined))),
            "dag lease was not released after workflow terminalization without wake delivery",
          )

          // A real active Goal can now be admitted. This fixture installs
          // Goal's durable authority, so an arbitrary id without a row is
          // correctly rejected even after the DAG has released its lease.
          const goalState = yield* goal.set(sid, "ship the feature", 10)
          const goalOwner = { kind: "goal" as const, id: goalState.goal_id ?? "legacy" }
          expect(Option.isSome(yield* automation.claim(sid, goalOwner))).toBe(true)
        }),
      ),
    )
  })
})

describe("DagLoop lease lifecycle — runtime-less terminal release (GOAL-FP-01-03 follow-up)", () => {
  it("releases a swept registration when a workflow with no runtime entry is terminalized by a control op", async () => {
    await Effect.runPromise(
      runLeaseTest(({ loop, dag, store, goal, status, automation, database }) =>
        Effect.gen(function* () {
          const sid = SessionID.make(PARENT_SESSION)

          // A workflow whose recovery FAILS at startup: its running node
          // references a child session the session store cannot read, so
          // reconcileWorkflow's checker failure aborts recoverWorkflow
          // BEFORE the runtime entry is created. The row stays non-terminal
          // with no runtime entry — the P2-A precondition.
          yield* database.db
            .insert(WorkflowTable)
            .values({
              id: "dag-wf-ghost",
              project_id: Project.ID.make(PROJECT_ID),
              session_id: SessionID.make(PARENT_SESSION),
              directory: process.cwd(),
              target_fingerprint: { kind: "none" },
              title: "unrecoverable",
              status: "running",
              config: "",
              seq: 1,
              wake_reported: true,
            })
            .run()
            .pipe(Effect.orDie)
          yield* database.db
            .insert(WorkflowNodeTable)
            .values({
              id: "n1",
              workflow_id: "dag-wf-ghost",
              name: "n1",
              worker_type: "build",
              status: "running",
              required: true,
              depends_on: [],
              child_session_id: "ses_child_ghost",
              seq: 1,
            })
            .run()
            .pipe(Effect.orDie)

          // An unreported terminal workflow makes the session visible to the
          // startup wake sweep — which registers the non-terminal ghost.
          yield* database.db
            .insert(WorkflowTable)
            .values({
              id: "dag-wf-undone",
              project_id: Project.ID.make(PROJECT_ID),
              session_id: SessionID.make(PARENT_SESSION),
              directory: process.cwd(),
              target_fingerprint: { kind: "none" },
              title: "terminal before delivery",
              status: "failed",
              config: "",
              seq: 2,
              wake_reported: false,
            })
            .run()
            .pipe(Effect.orDie)

          // The session is NOT idle when DagLoop boots, so the forked wake
          // redelivery aborts — no delivery-side register/unregister.
          yield* status.set(sid, { type: "busy" })
          yield* loop.init()

          // The sweep registered the ghost (non-terminal) even though its
          // recovery failed and no runtime entry exists.
          expect(Option.isSome(yield* automation.claim(sid, { kind: "dag" }))).toBe(true)
          expect((yield* store.getWorkflow("dag-wf-ghost"))?.status).toBe("running")

          // A control op terminalizes it — a real WorkflowCancelled event
          // that no runtime entry backs.
          yield* dag.cancel("dag-wf-ghost")
          yield* pollWithTimeout(
            store.getWorkflow("dag-wf-ghost").pipe(Effect.map((wf) => (wf?.status === "cancelled" ? wf : undefined))),
            "runtime-less workflow did not cancel",
          )

          // Public contract: the terminal event must release the swept
          // registration even though the workflow has no runtime entry.
          yield* pollWithTimeout(
            automation
              .claim(sid, { kind: "dag" })
              .pipe(Effect.map((token) => (Option.isNone(token) ? true : undefined))),
            "dag lease was not released when a runtime-less workflow terminalized",
          )

          const goalState = yield* goal.set(sid, "ship the feature", 10)
          const goalOwner = { kind: "goal" as const, id: goalState.goal_id ?? "legacy" }
          expect(Option.isSome(yield* automation.claim(sid, goalOwner))).toBe(true)
        }),
      ),
    )
  })
})
