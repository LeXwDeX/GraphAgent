import { describe, expect, it } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { DagEvent } from "@graphagent/schema/dag-event"
import { PAUSE_REASON_BUDGET_EXHAUSTED } from "@graphagent/schema/dag-status"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { Dag } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ResumeGuard, ResumeBlockedError } from "@/dag/resume-guard"

const testLayer = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
  EventV2Bridge.defaultLayer,
)

const dagLayer = Layer.provideMerge(Dag.layer, testLayer)

const dagID = "dag_resume_guard" as never
const ts = (n: number) => DateTime.makeUnsafe(n)

function setupFKs() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: "ses_resume_guard" as never,
        project_id: Project.ID.global,
        slug: "resume-guard",
        directory: "/project",
        title: "resume-guard",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

const createWorkflow = Effect.gen(function* () {
  const events = yield* EventV2.Service
  yield* events.publish(DagEvent.WorkflowCreated, {
    dagID,
    projectID: Project.ID.global as never,
    sessionID: "ses_resume_guard" as never,
    title: "resume-guard-test",
    config: JSON.stringify({ name: "test", nodes: [{ id: "a" }] }),
    status: "pending",
    timestamp: ts(0),
  })
  yield* events.publish(DagEvent.NodeRegistered, {
    dagID,
    nodeID: "a" as never,
    name: "a",
    workerType: "build",
    dependsOn: [],
    required: true,
    timestamp: ts(1),
  })
  yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(2) })
})

const pauseWithBudgetReason = Effect.gen(function* () {
  const events = yield* EventV2.Service
  yield* events.publish(DagEvent.WorkflowPaused, {
    dagID,
    reason: PAUSE_REASON_BUDGET_EXHAUSTED,
    timestamp: ts(3),
  })
})

const denyAll: ResumeGuard.Policy = {
  check: (workflow) =>
    Effect.fail(
      new ResumeBlockedError({
        workflowID: workflow.id,
        pauseReason: workflow.pauseReason ?? undefined,
      }),
    ),
}

const readWorkflow = Effect.gen(function* () {
  const store = yield* DagStore.Service
  return (yield* store.getWorkflow(dagID).pipe(Effect.orDie))!
})

describe("D12: ResumeGuard", () => {
  it("a provided policy vetoes Dag.resume and leaves the workflow paused", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createWorkflow
        yield* pauseWithBudgetReason
        const dag = yield* Dag.Service

        const failure = yield* dag.resume(dagID).pipe(Effect.flip)
        expect(failure).toBeInstanceOf(ResumeBlockedError)
        expect((failure as ResumeBlockedError).pauseReason).toBe(PAUSE_REASON_BUDGET_EXHAUSTED)
        expect((yield* readWorkflow).status).toBe("paused")
      }).pipe(
        Effect.provideService(ResumeGuard.Service, denyAll),
        Effect.scoped,
        Effect.provide(dagLayer),
      ) as Effect.Effect<never>,
    )
  })

  it("without a policy Dag.resume proceeds (fail-open default)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createWorkflow
        yield* pauseWithBudgetReason
        const dag = yield* Dag.Service

        yield* dag.resume(dagID)
        expect((yield* readWorkflow).status).toBe("running")
        expect((yield* readWorkflow).pauseReason).toBeNull()
      }).pipe(Effect.scoped, Effect.provide(dagLayer)) as Effect.Effect<never>,
    )
  })

  it("a provided policy vetoes Dag.step and leaves the workflow running", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createWorkflow
        const dag = yield* Dag.Service

        const failure = yield* dag.step(dagID).pipe(Effect.flip)
        expect(failure).toBeInstanceOf(ResumeBlockedError)
        expect((yield* readWorkflow).status).toBe("running")
      }).pipe(
        Effect.provideService(ResumeGuard.Service, denyAll),
        Effect.scoped,
        Effect.provide(dagLayer),
      ) as Effect.Effect<never>,
    )
  })

  it("without a policy Dag.step proceeds", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createWorkflow
        const dag = yield* Dag.Service

        yield* dag.step(dagID)
        expect((yield* readWorkflow).status).toBe("stepping")
      }).pipe(Effect.scoped, Effect.provide(dagLayer)) as Effect.Effect<never>,
    )
  })

  it("failUnrecoverable's internal resume bypasses the guard", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createWorkflow
        yield* pauseWithBudgetReason
        const dag = yield* Dag.Service

        // The workflow's recorded directory is empty, so failUnrecoverable
        // takes the terminal path (internal resume + fail) instead of returning
        // "ignored". A denying policy must not turn this into a defect and
        // leave the workflow paused forever.
        const verdict = yield* dag.failUnrecoverable(dagID, "unrecoverable location")
        expect(verdict).toBe("failed")
        expect((yield* readWorkflow).status).toBe("failed")
      }).pipe(
        Effect.provideService(ResumeGuard.Service, denyAll),
        Effect.scoped,
        Effect.provide(dagLayer),
      ) as Effect.Effect<never>,
    )
  })
})
