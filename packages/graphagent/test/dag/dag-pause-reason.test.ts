// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { WorkflowTable } from "@graphagent/core/dag/sql"
import { DagEvent } from "@graphagent/schema/dag-event"
import { PAUSE_REASON_BUDGET_EXHAUSTED } from "@graphagent/schema/dag-status"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { Dag } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"

const testLayer = Layer.mergeAll(
  Database.defaultLayer,
  EventV2.defaultLayer,
  DagProjector.defaultLayer,
  DagStore.defaultLayer,
  EventV2Bridge.defaultLayer,
)

const dagLayer = Layer.provideMerge(Dag.layer, testLayer)

const dagID = "dag_pause_reason" as never
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
        id: "ses_pause_reason" as never,
        project_id: Project.ID.global,
        slug: "pause-reason",
        directory: "/project",
        title: "pause-reason",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

const createRunningWorkflow = Effect.gen(function* () {
  const events = yield* EventV2.Service
  yield* events.publish(DagEvent.WorkflowCreated, {
    dagID,
    projectID: Project.ID.global as never,
    sessionID: "ses_pause_reason" as never,
    title: "pause-reason-test",
    config: JSON.stringify({ name: "test", nodes: [] }),
    status: "pending",
    timestamp: ts(0),
  })
  yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(1) })
})

const pause = (reason?: string) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(DagEvent.WorkflowPaused, {
      dagID,
      timestamp: ts(2),
      ...(reason === undefined ? {} : { reason }),
    })
  })

const readPauseReason = Effect.gen(function* () {
  const store = yield* DagStore.Service
  return (yield* store.getWorkflow(dagID).pipe(Effect.orDie))?.pauseReason
})

/** Simulate a stale reason left on a row by an older/partial projection. */
const stampPauseReason = (reason: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(WorkflowTable)
      .set({ pause_reason: reason })
      .where(eq(WorkflowTable.id, dagID))
      .run()
      .pipe(Effect.orDie)
  })

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(testLayer)) as Effect.Effect<A, E>)

describe("D12: workflow.pause_reason", () => {
  it("projects an absent reason to NULL (legacy event shape)", async () => {
    await run(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createRunningWorkflow
        yield* pause()
        expect(yield* readPauseReason).toBeNull()
      }),
    )
  })

  it("projects budget_exhausted onto the durable column", async () => {
    await run(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createRunningWorkflow
        yield* pause(PAUSE_REASON_BUDGET_EXHAUSTED)
        expect(yield* readPauseReason).toBe(PAUSE_REASON_BUDGET_EXHAUSTED)

        // The store is a pure read model over the DB, so a fresh read after the
        // publish (the restart/replay path) still reconstructs the reason.
        const { db } = yield* Database.Service
        const row = yield* db.select().from(WorkflowTable).where(eq(WorkflowTable.id, dagID)).get().pipe(Effect.orDie)
        expect(row?.pause_reason).toBe(PAUSE_REASON_BUDGET_EXHAUSTED)
      }),
    )
  })

  it("still decodes a stored WorkflowPaused event that predates the reason field", () => {
    const decoded = Schema.decodeUnknownSync(DagEvent.WorkflowPaused.data)({
      dagID: DagEvent.DagID.make("dag_legacy"),
      timestamp: 0,
    })
    expect(decoded.reason).toBeUndefined()
  })

  it("Dag.Service.pause writes the reason supplied by the engine", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createRunningWorkflow
        const dag = yield* Dag.Service
        yield* dag.pause(dagID, PAUSE_REASON_BUDGET_EXHAUSTED)
        expect(yield* readPauseReason).toBe(PAUSE_REASON_BUDGET_EXHAUSTED)
      }).pipe(Effect.scoped, Effect.provide(dagLayer)) as Effect.Effect<never>,
    )
  })

  it("WorkflowResumed clears the reason", async () => {
    await run(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createRunningWorkflow
        yield* pause(PAUSE_REASON_BUDGET_EXHAUSTED)
        const events = yield* EventV2.Service
        yield* events.publish(DagEvent.WorkflowResumed, { dagID, timestamp: ts(3) })
        expect(yield* readPauseReason).toBeNull()
      }),
    )
  })

  it("terminal transitions clear a stale reason (completed / failed / cancelled)", async () => {
    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      await run(
        Effect.gen(function* () {
          const id = `dag_pause_reason_${terminal}` as never
          const events = yield* EventV2.Service
          const { db } = yield* Database.Service
          const store = yield* DagStore.Service
          yield* setupFKs()
          yield* events.publish(DagEvent.WorkflowCreated, {
            dagID: id,
            projectID: Project.ID.global as never,
            sessionID: "ses_pause_reason" as never,
            title: terminal,
            config: JSON.stringify({ name: terminal, nodes: [] }),
            status: "pending",
            timestamp: ts(0),
          })
          yield* events.publish(DagEvent.WorkflowStarted, { dagID: id, timestamp: ts(1) })
          yield* db
            .update(WorkflowTable)
            .set({ pause_reason: "stale" })
            .where(eq(WorkflowTable.id, id))
            .run()
            .pipe(Effect.orDie)

          if (terminal === "completed") {
            yield* events.publish(DagEvent.WorkflowCompleted, { dagID: id, durationMs: 2, timestamp: ts(2) })
          } else if (terminal === "failed") {
            yield* events.publish(DagEvent.WorkflowFailed, {
              dagID: id,
              reason: "boom",
              failedNodes: [],
              timestamp: ts(2),
            })
          } else {
            // cancelled is legal from paused, so exercise that path too.
            yield* events.publish(DagEvent.WorkflowPaused, {
              dagID: id,
              reason: PAUSE_REASON_BUDGET_EXHAUSTED,
              timestamp: ts(2),
            })
            yield* events.publish(DagEvent.WorkflowCancelled, { dagID: id, timestamp: ts(3) })
          }

          expect((yield* store.getWorkflow(id).pipe(Effect.orDie))?.pauseReason).toBeNull()
        }),
      )
    }
  })

  it("WorkflowReplanned recovery clears the reason and resumes the workflow", async () => {
    await run(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createRunningWorkflow
        yield* pause(PAUSE_REASON_BUDGET_EXHAUSTED)
        const store = yield* DagStore.Service
        const events = yield* EventV2.Service
        const paused = (yield* store.getWorkflow(dagID).pipe(Effect.orDie))!
        yield* events.publish(DagEvent.WorkflowReplanned, {
          dagID,
          added: 0,
          removed: 0,
          replaced: 0,
          restarted: 0,
          recovery: {
            expectedGraphRev: paused.graphRev,
            expectedSeq: paused.seq,
            nodeSeqs: [],
            resumeCancelled: false,
          },
          timestamp: ts(3),
        })
        const recovered = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
        expect(recovered?.status).toBe("running")
        expect(recovered?.pauseReason).toBeNull()
      }),
    )
  })

  it("WorkflowReplanned reopen clears a stale reason on a completed workflow", async () => {
    await run(
      Effect.gen(function* () {
        yield* setupFKs()
        yield* createRunningWorkflow
        const events = yield* EventV2.Service
        yield* events.publish(DagEvent.WorkflowCompleted, { dagID, durationMs: 2, timestamp: ts(2) })
        yield* stampPauseReason("stale")
        yield* events.publish(DagEvent.WorkflowReplanned, {
          dagID,
          added: 1,
          removed: 0,
          replaced: 0,
          restarted: 0,
          timestamp: ts(3),
        })
        const store = yield* DagStore.Service
        const reopened = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
        expect(reopened?.status).toBe("running")
        expect(reopened?.pauseReason).toBeNull()
      }),
    )
  })
})
