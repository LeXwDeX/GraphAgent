// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1289: the `archived` pause reason. Archiving the owner session holds its
// workflows (`Dag.pauseForArchive`): a running or stepping workflow is paused,
// a workflow that is already paused only has its reason changed, and the
// projector accepts the pause event from `paused` for this reason alone. The
// automatic resume (`Dag.resumeIfPausedFor`) re-checks the reason where it
// publishes, so an archive that lands before it is not undone.
import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { DagTransact } from "@graphagent/core/dag/transact"
import { WorkflowTable } from "@graphagent/core/dag/sql"
import { DagEvent } from "@graphagent/schema/dag-event"
import {
  ERROR_CLASS_BUDGET_EXHAUSTED,
  PAUSE_REASON_ARCHIVED,
  PAUSE_REASON_BUDGET_EXHAUSTED,
  PAUSE_REASON_CHECKPOINT,
  type PauseReason,
} from "@graphagent/schema/dag-status"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { Dag } from "@/dag/dag"
import { ResumeBlockedError, ResumeGuard } from "@/dag/resume-guard"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const layer = Layer.provideMerge(
  Dag.layer,
  Layer.mergeAll(
    Database.defaultLayer,
    EventV2.defaultLayer,
    DagProjector.defaultLayer,
    DagStore.defaultLayer,
    DagTransact.defaultLayer,
    EventV2Bridge.defaultLayer,
  ),
)

const it = testEffect(layer)

const dagID = DagEvent.DagID.make("dag_pause_archived")
const sessionID = SessionID.make("ses_pause_archived")
const ts = (n: number) => DateTime.makeUnsafe(n)

/** The pauses a workflow can already be in when the archive reaches it: a manual or recovery pause (no reason), a budget pause and a checkpoint pause. */
const priorPauses: ReadonlyArray<{ readonly label: string; readonly reason: PauseReason | undefined }> = [
  { label: "manual", reason: undefined },
  { label: "budget_exhausted", reason: PAUSE_REASON_BUDGET_EXHAUSTED },
  { label: "checkpoint", reason: PAUSE_REASON_CHECKPOINT },
]

const setupFKs = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "pause-archived",
      directory: "/project",
      title: "pause-archived",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

const create = Effect.gen(function* () {
  const events = yield* EventV2.Service
  yield* events.publish(DagEvent.WorkflowCreated, {
    dagID,
    projectID: Project.ID.global,
    sessionID,
    title: "pause-archived-test",
    config: JSON.stringify({ name: "test", nodes: [] }),
    status: "pending",
    timestamp: ts(0),
  })
})

const createRunning = Effect.gen(function* () {
  yield* setupFKs
  yield* create
  const events = yield* EventV2.Service
  yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(1) })
})

const pause = (reason?: string, at = 2) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(DagEvent.WorkflowPaused, {
      dagID,
      timestamp: ts(at),
      ...(reason === undefined ? {} : { reason }),
    })
  })

const readRow = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const row = yield* db.select().from(WorkflowTable).where(eq(WorkflowTable.id, dagID)).get().pipe(Effect.orDie)
  return row!
})

/** The status and pause reason of the workflow row, the pair every assertion below is about. */
const readState = Effect.map(readRow, (row) => ({ status: row.status, reason: row.pause_reason }))

/** The status and error class of every node of the workflow, by node id. */
const readNodes = Effect.gen(function* () {
  const store = yield* DagStore.Service
  const rows = yield* store.getNodes(dagID)
  return Object.fromEntries(rows.map((row) => [row.id, { status: row.status, errorClass: row.errorClass }]))
})

const markReminderDelivered = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .update(WorkflowTable)
    .set({ wake_reported: true })
    .where(eq(WorkflowTable.id, dagID))
    .run()
    .pipe(Effect.orDie)
})

describe("#1289: the archived pause reason", () => {
  test("is the literal the durable column carries", () => {
    expect(PAUSE_REASON_ARCHIVED).toBe("archived")
  })

  for (const { label, reason } of priorPauses)
    it.live(`a pause event with the archived reason relabels a ${label} pause`, () =>
      Effect.gen(function* () {
        yield* createRunning
        yield* pause(reason)
        const before = yield* readRow
        expect({ status: before.status, reason: before.pause_reason }).toEqual({
          status: "paused",
          reason: reason ?? null,
        })

        yield* pause(PAUSE_REASON_ARCHIVED, 3)

        const after = yield* readRow
        expect({ status: after.status, reason: after.pause_reason }).toEqual({
          status: "paused",
          reason: PAUSE_REASON_ARCHIVED,
        })
        expect(after.seq).toBeGreaterThan(before.seq)
      }),
    )

  it.live("a relabel joins the pause episode it finds: the reminder marker is neither re-armed nor cleared", () =>
    Effect.gen(function* () {
      yield* createRunning
      yield* pause()
      yield* markReminderDelivered
      yield* pause(PAUSE_REASON_ARCHIVED, 3)
      expect((yield* readRow).wake_reported).toBe(true)
    }),
  )

  it.live("a pause that is not a relabel opens an episode of its own, with a fresh reminder", () =>
    Effect.gen(function* () {
      yield* createRunning
      yield* markReminderDelivered
      yield* pause(PAUSE_REASON_ARCHIVED)
      expect((yield* readRow).wake_reported).toBe(false)
    }),
  )

  it.live("is idempotent: a second archived pause event changes nothing", () =>
    Effect.gen(function* () {
      yield* createRunning
      yield* pause(PAUSE_REASON_ARCHIVED)
      const first = yield* readRow
      yield* pause(PAUSE_REASON_ARCHIVED, 5)
      const second = yield* readRow
      expect({ seq: second.seq, updated: second.time_updated, reason: second.pause_reason }).toEqual({
        seq: first.seq,
        updated: first.time_updated,
        reason: PAUSE_REASON_ARCHIVED,
      })
    }),
  )

  it.live(
    "only the archived reason is accepted from paused: any other reason still leaves a paused workflow alone",
    () =>
      Effect.gen(function* () {
        yield* createRunning
        yield* pause()
        const before = yield* readRow
        yield* pause(PAUSE_REASON_BUDGET_EXHAUSTED, 3)
        yield* pause(PAUSE_REASON_CHECKPOINT, 4)
        yield* pause(undefined, 5)
        const after = yield* readRow
        expect({ seq: after.seq, reason: after.pause_reason }).toEqual({ seq: before.seq, reason: null })
      }),
  )

  it.live("never reaches a workflow that is not paused or running: terminal rows stay as they are", () =>
    Effect.gen(function* () {
      yield* createRunning
      const events = yield* EventV2.Service
      yield* events.publish(DagEvent.WorkflowCompleted, { dagID, durationMs: 1, timestamp: ts(2) })
      yield* pause(PAUSE_REASON_ARCHIVED, 3)
      expect(yield* readState).toEqual({ status: "completed", reason: null })
    }),
  )

  it.live("a resume ends the episode and clears the reason", () =>
    Effect.gen(function* () {
      yield* createRunning
      yield* pause(PAUSE_REASON_BUDGET_EXHAUSTED)
      yield* pause(PAUSE_REASON_ARCHIVED, 3)
      const events = yield* EventV2.Service
      yield* events.publish(DagEvent.WorkflowResumed, { dagID, timestamp: ts(4) })
      expect(yield* readState).toEqual({ status: "running", reason: null })
    }),
  )
})

describe("#1289: Dag.pauseForArchive", () => {
  it.live("pauses a running workflow with the archived reason", () =>
    Effect.gen(function* () {
      yield* createRunning
      const dag = yield* Dag.Service
      expect(yield* dag.pauseForArchive(dagID)).toBe("paused")
      expect(yield* readState).toEqual({ status: "paused", reason: PAUSE_REASON_ARCHIVED })
    }),
  )

  it.live("pauses a stepping workflow too", () =>
    Effect.gen(function* () {
      yield* createRunning
      const events = yield* EventV2.Service
      yield* events.publish(DagEvent.WorkflowStepped, { dagID, timestamp: ts(2) })
      expect((yield* readRow).status).toBe("stepping")
      const dag = yield* Dag.Service
      expect(yield* dag.pauseForArchive(dagID)).toBe("paused")
      expect(yield* readState).toEqual({ status: "paused", reason: PAUSE_REASON_ARCHIVED })
    }),
  )

  for (const { label, reason } of priorPauses)
    it.live(`relabels a ${label} pause without a second pause`, () =>
      Effect.gen(function* () {
        yield* createRunning
        const dag = yield* Dag.Service
        yield* dag.pause(dagID, reason)
        expect(yield* dag.pauseForArchive(dagID)).toBe("relabeled")
        expect(yield* readState).toEqual({ status: "paused", reason: PAUSE_REASON_ARCHIVED })
      }),
    )

  it.live("relabeling a budget pause requeues the nodes the budget cancelled, so a resume reruns them", () =>
    Effect.gen(function* () {
      yield* setupFKs
      yield* create
      const events = yield* EventV2.Service
      for (const nodeID of ["a", "b"])
        yield* events.publish(DagEvent.NodeRegistered, {
          dagID,
          nodeID: DagEvent.NodeID.make(nodeID),
          name: nodeID,
          workerType: "build",
          dependsOn: [],
          required: true,
          timestamp: ts(1),
        })
      yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(2) })
      yield* events.publish(DagEvent.NodeQueued, { dagID, nodeID: DagEvent.NodeID.make("a"), timestamp: ts(3) })
      const dag = yield* Dag.Service
      expect(yield* dag.pauseForBudget(dagID)).toBe("paused")
      expect(yield* readNodes).toEqual({
        a: { status: "failed", errorClass: ERROR_CLASS_BUDGET_EXHAUSTED },
        b: { status: "pending", errorClass: null },
      })

      // Only the budget's own resume requeues those attempts, and it stops
      // seeing the workflow once its reason changes: the relabel requeues them.
      expect(yield* dag.pauseForArchive(dagID)).toBe("relabeled")
      expect(yield* readState).toEqual({ status: "paused", reason: PAUSE_REASON_ARCHIVED })
      expect(yield* readNodes).toEqual({
        a: { status: "pending", errorClass: null },
        b: { status: "pending", errorClass: null },
      })

      yield* dag.resume(dagID)
      expect(yield* readState).toEqual({ status: "running", reason: null })
    }),
  )

  it.live("relabeling a manual or checkpoint pause leaves the nodes as they are", () =>
    Effect.gen(function* () {
      yield* createRunning
      const events = yield* EventV2.Service
      yield* events.publish(DagEvent.NodeRegistered, {
        dagID,
        nodeID: DagEvent.NodeID.make("a"),
        name: "a",
        workerType: "build",
        dependsOn: [],
        required: true,
        timestamp: ts(1),
      })
      yield* events.publish(DagEvent.NodeFailed, {
        dagID,
        nodeID: DagEvent.NodeID.make("a"),
        reason: "boom",
        trigger: "exec_failed",
        timestamp: ts(2),
      })
      const dag = yield* Dag.Service
      yield* dag.pause(dagID, PAUSE_REASON_CHECKPOINT)
      expect(yield* dag.pauseForArchive(dagID)).toBe("relabeled")
      expect(yield* readNodes).toEqual({ a: { status: "failed", errorClass: "exec_failed" } })
    }),
  )

  it.live("leaves a workflow already held for the archive, a pending one, a terminal one and a missing one alone", () =>
    Effect.gen(function* () {
      yield* setupFKs
      const dag = yield* Dag.Service
      expect(yield* dag.pauseForArchive("dag_missing")).toBe("ignored")

      yield* create
      expect(yield* dag.pauseForArchive(dagID)).toBe("ignored")
      expect((yield* readRow).status).toBe("pending")

      const events = yield* EventV2.Service
      yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(1) })
      expect(yield* dag.pauseForArchive(dagID)).toBe("paused")
      const held = yield* readRow
      expect(yield* dag.pauseForArchive(dagID)).toBe("ignored")
      expect((yield* readRow).seq).toBe(held.seq)

      yield* dag.cancel(dagID)
      const ended = yield* readRow
      expect(yield* dag.pauseForArchive(dagID)).toBe("ignored")
      const after = yield* readRow
      expect({ status: after.status, reason: after.pause_reason, seq: after.seq }).toEqual({
        status: "cancelled",
        reason: null,
        seq: ended.seq,
      })
    }),
  )

  it.live("an archived workflow can still be resumed and cancelled, and a user pause of it is refused as before", () =>
    Effect.gen(function* () {
      yield* createRunning
      const dag = yield* Dag.Service
      yield* dag.pauseForArchive(dagID)
      // paused -> paused stays outside the state machine for every caller but the archive.
      expect(yield* dag.pause(dagID).pipe(Effect.flip)).toBeInstanceOf(Error)
      yield* dag.resume(dagID)
      expect((yield* readRow).status).toBe("running")
      yield* dag.pauseForArchive(dagID)
      yield* dag.cancel(dagID)
      expect((yield* readRow).status).toBe("cancelled")
    }),
  )
})

describe("#1289: Dag.resumeIfPausedFor", () => {
  it.live("resumes a workflow that is still paused for the reason", () =>
    Effect.gen(function* () {
      yield* createRunning
      const dag = yield* Dag.Service
      yield* dag.pause(dagID, PAUSE_REASON_BUDGET_EXHAUSTED)
      expect(yield* dag.resumeIfPausedFor(dagID, PAUSE_REASON_BUDGET_EXHAUSTED)).toBe("resumed")
      expect(yield* readState).toEqual({ status: "running", reason: null })
    }),
  )

  it.live(
    "skips, without an error or an event, a pause the archive relabeled; the explicit resume still lifts it",
    () =>
      Effect.gen(function* () {
        yield* createRunning
        const dag = yield* Dag.Service
        yield* dag.pause(dagID, PAUSE_REASON_BUDGET_EXHAUSTED)
        expect(yield* dag.pauseForArchive(dagID)).toBe("relabeled")
        const held = yield* readRow

        expect(yield* dag.resumeIfPausedFor(dagID, PAUSE_REASON_BUDGET_EXHAUSTED)).toBe("skipped")
        const after = yield* readRow
        expect({ status: after.status, reason: after.pause_reason, seq: after.seq }).toEqual({
          status: "paused",
          reason: PAUSE_REASON_ARCHIVED,
          seq: held.seq,
        })

        // The main agent's resume is the explicit one, and it is not conditional.
        yield* dag.resume(dagID)
        expect(yield* readState).toEqual({ status: "running", reason: null })
      }),
  )

  it.live("skips every other state: another reason, running, ended, pending and missing", () =>
    Effect.gen(function* () {
      yield* setupFKs
      const dag = yield* Dag.Service
      expect(yield* dag.resumeIfPausedFor("dag_missing", PAUSE_REASON_BUDGET_EXHAUSTED)).toBe("skipped")

      yield* create
      expect(yield* dag.resumeIfPausedFor(dagID, PAUSE_REASON_BUDGET_EXHAUSTED)).toBe("skipped")
      expect((yield* readRow).status).toBe("pending")

      const events = yield* EventV2.Service
      yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(1) })
      expect(yield* dag.resumeIfPausedFor(dagID, PAUSE_REASON_BUDGET_EXHAUSTED)).toBe("skipped")
      expect((yield* readRow).status).toBe("running")

      yield* dag.pause(dagID, PAUSE_REASON_CHECKPOINT)
      expect(yield* dag.resumeIfPausedFor(dagID, PAUSE_REASON_BUDGET_EXHAUSTED)).toBe("skipped")
      expect(yield* readState).toEqual({ status: "paused", reason: PAUSE_REASON_CHECKPOINT })

      yield* dag.cancel(dagID)
      expect(yield* dag.resumeIfPausedFor(dagID, PAUSE_REASON_BUDGET_EXHAUSTED)).toBe("skipped")
      expect((yield* readRow).status).toBe("cancelled")
    }),
  )

  it.live(
    "re-checks the reason inside the transaction: an archive committed after the policy check is not undone",
    () =>
      Effect.gen(function* () {
        yield* createRunning
        const dag = yield* Dag.Service
        const events = yield* EventV2.Service
        yield* dag.pause(dagID, PAUSE_REASON_BUDGET_EXHAUSTED)

        // Another process's archive: it commits after this call has read the
        // workflow and passed the policy, and it does not hold this process's lock.
        const archiveAfterPolicy = {
          check: () =>
            events
              .publish(DagEvent.WorkflowPaused, { dagID, timestamp: ts(5), reason: PAUSE_REASON_ARCHIVED })
              .pipe(Effect.asVoid, Effect.orDie),
        }
        const outcome = yield* dag
          .resumeIfPausedFor(dagID, PAUSE_REASON_BUDGET_EXHAUSTED)
          .pipe(Effect.provideService(ResumeGuard.Service, archiveAfterPolicy))

        expect(outcome).toBe("skipped")
        expect(yield* readState).toEqual({ status: "paused", reason: PAUSE_REASON_ARCHIVED })
      }),
  )

  it.live("a resume that goes ahead still meets the ResumeGuard, and a skip never reaches it", () =>
    Effect.gen(function* () {
      yield* createRunning
      const dag = yield* Dag.Service
      let consulted = 0
      const guarded = <A, E, R>(effect: Effect.Effect<A, E, R>, verdict: "allow" | "veto") =>
        effect.pipe(
          Effect.provideService(ResumeGuard.Service, {
            check: (workflow) =>
              Effect.suspend(() => {
                consulted++
                return verdict === "veto"
                  ? Effect.fail(
                      new ResumeBlockedError({
                        workflowID: workflow.id,
                        pauseReason: workflow.pauseReason ?? undefined,
                      }),
                    )
                  : Effect.void
              }),
          }),
        )
      yield* dag.pause(dagID, PAUSE_REASON_BUDGET_EXHAUSTED)

      const vetoed = yield* guarded(dag.resumeIfPausedFor(dagID, PAUSE_REASON_BUDGET_EXHAUSTED), "veto").pipe(
        Effect.flip,
      )
      expect(vetoed).toBeInstanceOf(ResumeBlockedError)
      expect(consulted).toBe(1)
      expect(yield* readState).toEqual({ status: "paused", reason: PAUSE_REASON_BUDGET_EXHAUSTED })

      // The archive takes the pause over; a vetoing guard (an exhausted budget)
      // would have turned the budget's attempt into an error, and is not asked.
      yield* dag.pauseForArchive(dagID)
      expect(yield* guarded(dag.resumeIfPausedFor(dagID, PAUSE_REASON_BUDGET_EXHAUSTED), "veto")).toBe("skipped")
      expect(consulted).toBe(1)
    }),
  )
})
