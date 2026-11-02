// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- durable row fixtures use branded-column shims.
/**
 * #948: a workflow whose execution directory is missing or was never stamped
 * must terminalize once instead of rotting forever or failing node by node.
 * These probes drive the host-level supervision sweep with the real durable
 * Dag projector so the observable contract is the projected row, the durable
 * WorkflowFailed event, and the single unreported parent wake.
 */
import { describe, expect, it } from "bun:test"
import { Effect, Fiber, Layer, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import { WorkflowTable } from "@opencode-ai/core/dag/sql"
import { EventTable } from "@opencode-ai/core/event/sql"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Dag } from "@/dag/dag"
import { DagSupervisionSweep } from "@/dag/runtime/supervision-sweep"
import { continueRecoveredMessageNode } from "@/dag/runtime/recovery"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { SessionAutomationLease } from "@/session/automation-lease"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import { and, eq } from "drizzle-orm"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const workflowFailureCount = (database: Database.Interface, dagID: string) =>
  database.db
    .select({ type: EventTable.type })
    .from(EventTable)
    .where(and(eq(EventTable.aggregate_id, dagID)))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.filter((row) => row.type.startsWith("dag.workflow.failed")).length),
    )

function sweepHarness() {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status)
  const prompt = Layer.mock(SessionPrompt.Service, {
    cancel: () => Effect.void,
  })
  const automation = SessionAutomationLease.defaultLayer
  // provideMerge keeps the lease instance shared with the service the test
  // observes; a sibling provide would build a second registry and make the
  // release assertion meaningless.
  const sweep = DagSupervisionSweep.layerWithoutDeps.pipe(
    Layer.provide(base),
    Layer.provide(prompt),
    Layer.provideMerge(automation),
  )
  return Layer.mergeAll(base, sweep)
}

const createWorkflow = (input: {
  readonly directory: string
  readonly title: string
  readonly nodes?: Dag.NodeConfig[]
}) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const dag = yield* Dag.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: "project-1" as never, worktree: input.directory as never, sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values({
        id: "ses_parent" as never,
        project_id: "project-1" as never,
        slug: "p",
        directory: input.directory as never,
        title: "P",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    return yield* dag.create({
      projectID: "project-1",
      sessionID: "ses_parent",
      title: input.title,
      config: {
        name: input.title,
        nodes: input.nodes ?? [
          {
            id: "n1",
            name: "n1",
            worker_type: "build",
            depends_on: [],
            required: true,
            prompt_template: { inline: "x" },
          },
        ],
      },
    })
  })

const runSweepTest = <A>(
  directory: string,
  test: (services: {
    readonly database: Database.Interface
    readonly store: DagStore.Interface
    readonly sweep: DagSupervisionSweep.Interface
    readonly automation: SessionAutomationLease.Interface
    readonly dagID: string
  }) => Effect.Effect<A, Error>,
) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const store = yield* DagStore.Service
    const sweep = yield* DagSupervisionSweep.Service
    const automation = yield* SessionAutomationLease.Service
    const dagID = yield* createWorkflow({ directory, title: path.basename(directory) })
    yield* automation.register(SessionID.make("ses_parent"), { kind: "dag", id: dagID })
    return yield* test({ database, store, sweep, automation, dagID })
  }).pipe(
    Effect.provide(sweepHarness()),
    Effect.provideService(InstanceRef, {
      directory,
      worktree: directory,
      project: { id: "project-1" },
    } as never),
    Effect.scoped,
  )

describe("DAG workspace failure terminalization (#948)", () => {
  it("terminalizes a NULL-directory row once and releases its lease", async () => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-workspace-null-")))
    try {
      await Effect.runPromise(
        runSweepTest(directory, ({ database, store, sweep, automation, dagID }) =>
          Effect.gen(function* () {
            yield* database.db
              .update(WorkflowTable)
              .set({ directory: null })
              .where(eq(WorkflowTable.id, dagID))
              .run()
              .pipe(Effect.orDie)

            yield* sweep.sweepOnce()

            const workflow = yield* store.getWorkflow(dagID)
            expect(workflow?.status).toBe("failed")
            expect(yield* store.getWorkflowFailureReason!(dagID)).toContain("workspace_unstamped")
            expect(yield* workflowFailureCount(database, dagID)).toBe(1)
            // One durable terminal wake row, not a per-node error cascade.
            expect((yield* store.getUnreportedWakeWorkflows("ses_parent")).map((row) => row.id)).toEqual([dagID])
            // The dead graph no longer pins the parent's automation lease.
            expect(Option.isNone(yield* automation.claim(SessionID.make("ses_parent"), { kind: "dag" }))).toBe(true)

            // A second tick is a no-op: terminal rows are not failed twice and
            // a delivered/queued wake episode is not re-armed.
            yield* sweep.sweepOnce()
            expect(yield* workflowFailureCount(database, dagID)).toBe(1)
            expect((yield* store.getWorkflow(dagID))?.status).toBe("failed")
          }),
        ),
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("terminalizes a workflow whose linked worktree was removed", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-workspace-missing-")))
    const directory = path.join(root, "linked-worktree")
    try {
      await Effect.runPromise(
        runSweepTest(directory, ({ database, store, sweep, automation, dagID }) =>
          Effect.gen(function* () {
            rmSync(directory, { recursive: true, force: true })

            yield* sweep.sweepOnce()

            const workflow = yield* store.getWorkflow(dagID)
            expect(workflow?.status).toBe("failed")
            const reason = yield* store.getWorkflowFailureReason!(dagID)
            expect(reason).toContain("workspace_missing")
            expect(reason).toContain(directory)
            expect(reason).toContain("git worktree add")
            expect(yield* workflowFailureCount(database, dagID)).toBe(1)
            expect((yield* store.getUnreportedWakeWorkflows("ses_parent")).map((row) => row.id)).toEqual([dagID])
            expect(Option.isNone(yield* automation.claim(SessionID.make("ses_parent"), { kind: "dag" }))).toBe(true)

            yield* sweep.sweepOnce()
            expect(yield* workflowFailureCount(database, dagID)).toBe(1)
          }),
        ),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("recovered continuation fails the workflow before dispatching into a missing workspace", async () => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-continuation-missing-")))
    let loops = 0
    try {
      const database = Database.layerFromPath(":memory:")
      const events = EventV2.layer.pipe(Layer.provide(database))
      const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
      const store = DagStore.layer.pipe(Layer.provide(database))
      const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
      const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
      const prompt = Layer.mock(SessionPrompt.Service, {
        loop: () =>
          Effect.sync(() => {
            loops++
            return undefined as never
          }),
      })
      const layer = Layer.mergeAll(database, events, bridge, store, projector, dag, prompt)
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* Database.Service
          const dagSvc = yield* Dag.Service
          const storeSvc = yield* DagStore.Service
          yield* db.db
            .insert(ProjectTable)
            .values({ id: "project-1" as never, worktree: directory as never, sandboxes: [] })
            .run()
            .pipe(Effect.orDie)
          yield* db.db
            .insert(SessionTable)
            .values({
              id: "ses_parent" as never,
              project_id: "project-1" as never,
              slug: "p",
              directory: directory as never,
              title: "P",
              version: "test",
            })
            .run()
            .pipe(Effect.orDie)
          const dagID = yield* dagSvc.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "continuation",
            config: {
              name: "continuation",
              nodes: [
                {
                  id: "n1",
                  name: "n1",
                  worker_type: "build",
                  depends_on: [],
                  required: true,
                  prompt_template: { inline: "x" },
                },
              ],
            },
          })
          rmSync(directory, { recursive: true, force: true })

          yield* continueRecoveredMessageNode(dagID, "n1", undefined)

          expect(loops).toBe(0)
          expect((yield* storeSvc.getWorkflow(dagID))?.status).toBe("failed")
          expect(yield* storeSvc.getWorkflowFailureReason!(dagID)).toContain("workspace_missing")
        }).pipe(
          Effect.provide(layer),
          Effect.provideService(InstanceRef, {
            directory,
            worktree: directory,
            project: { id: "project-1" },
          } as never),
          Effect.scoped,
        ),
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("recovered continuation fails the workflow when the directory disappears during the admit wait", async () => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-continuation-pause-")))
    let loops = 0
    let enteredSnapshot = () => {}
    let releaseSnapshot = () => {}
    const snapshotEntered = new Promise<void>((resolve) => {
      enteredSnapshot = resolve
    })
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve
    })
    try {
      const database = Database.layerFromPath(":memory:")
      const events = EventV2.layer.pipe(Layer.provide(database))
      const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
      const store = DagStore.layer.pipe(Layer.provide(database))
      const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
      const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
      const prompt = Layer.mock(SessionPrompt.Service, {
        loop: () =>
          Effect.sync(() => {
            loops++
            return undefined as never
          }),
      })
      const messages = Layer.mock(DagMessages.Service, {
        latestSnapshot: () =>
          Effect.promise(async () => {
            // Park after the entry guard passed, while the continuation is
            // waiting to revalidate. The test pauses and removes the workspace
            // before releasing this boundary.
            enteredSnapshot()
            await snapshotGate
            return { ok: true, value: undefined } as never
          }),
      })
      const layer = Layer.mergeAll(database, events, bridge, store, projector, dag, prompt, messages)
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* Database.Service
          const dagSvc = yield* Dag.Service
          const storeSvc = yield* DagStore.Service
          yield* db.db
            .insert(ProjectTable)
            .values({ id: "project-1" as never, worktree: directory as never, sandboxes: [] })
            .run()
            .pipe(Effect.orDie)
          yield* db.db
            .insert(SessionTable)
            .values({
              id: "ses_parent" as never,
              project_id: "project-1" as never,
              slug: "p",
              directory: directory as never,
              title: "P",
              version: "test",
            })
            .run()
            .pipe(Effect.orDie)
          const dagID = yield* dagSvc.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "dag-continuation-pause",
            config: {
              name: "dag-continuation-pause",
              nodes: [
                {
                  id: "n1",
                  name: "n1",
                  worker_type: "build",
                  depends_on: [],
                  required: true,
                  prompt_template: { inline: "x" },
                },
              ],
            },
          })
          yield* dagSvc.nodeQueued(dagID, "n1")
          yield* dagSvc.nodeStarted(dagID, "n1", "ses_child", Date.now() + 60_000)

          const continuation = yield* continueRecoveredMessageNode(
            dagID,
            "n1",
            { result_protocol: "submit_result", nodes: [{ id: "n1" }] },
            directory,
          ).pipe(Effect.forkScoped)
          yield* Effect.promise(() => snapshotEntered)
          yield* dagSvc.pause(dagID)
          rmSync(directory, { recursive: true, force: true })
          releaseSnapshot()
          yield* Fiber.await(continuation).pipe(Effect.timeout("5 seconds"))
          expect(loops).toBe(0)
          expect((yield* storeSvc.getWorkflow(dagID))?.status).toBe("failed")
          expect(yield* storeSvc.getWorkflowFailureReason!(dagID)).toContain("workspace_missing")
        }).pipe(
          Effect.provide(layer),
          Effect.provideService(InstanceRef, {
            directory,
            worktree: directory,
            project: { id: "project-1" },
          } as never),
          Effect.scoped,
        ),
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("keeps an existing worktree live", async () => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "dag-workspace-live-")))
    try {
      await Effect.runPromise(
        runSweepTest(directory, ({ database, store, sweep, dagID }) =>
          Effect.gen(function* () {
            yield* sweep.sweepOnce()
            expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
            expect(yield* workflowFailureCount(database, dagID)).toBe(0)
          }),
        ),
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
