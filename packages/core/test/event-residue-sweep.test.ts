import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { eq, inArray } from "drizzle-orm"
import { Database } from "@graphagent/core/database/database"
import { EventSequenceTable, EventTable } from "@graphagent/core/event/sql"
import { EventV2 } from "@graphagent/core/event"
import { EventResidueSweep } from "@graphagent/core/event/residue-sweep"
import { SessionSchema } from "@graphagent/core/session/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { WorkflowTable } from "@graphagent/core/dag/sql"
import { ProjectTable } from "@graphagent/core/project/sql"
import { ProjectV2 } from "@graphagent/core/project"
import { AbsolutePath } from "@graphagent/core/schema"

// #524 Phase 1: crash/in-flight zombie residue — a Session.remove (or a project
// cascade) that crashed between the session-row delete and the event-store
// scrub leaves durable event aggregates whose SessionTable and WorkflowTable
// read models are both gone. The default-on residue sweep removes exactly
// those aggregates and never touches live or archived ones.
const testLayer = Layer.mergeAll(Database.defaultLayer, EventResidueSweep.defaultLayer)

const seedAggregate = (aggregateID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(EventSequenceTable).values({ aggregate_id: aggregateID, seq: 1 }).run().pipe(Effect.orDie)
    yield* db
      .insert(EventTable)
      .values({ id: EventV2.ID.make(`evt_${aggregateID}`), aggregate_id: aggregateID, seq: 1, type: "session.updated.1", data: {} })
      .run()
      .pipe(Effect.orDie)
  })

const seedProject = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.make("proj_sweep"), worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
})

const remainingAggregates = (ids: readonly string[]) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ aggregate: EventSequenceTable.aggregate_id })
      .from(EventSequenceTable)
      .where(inArray(EventSequenceTable.aggregate_id, [...ids]))
      .all()
      .pipe(Effect.orDie)
  })

describe("EventResidueSweep (#524)", () => {
  test("removes only aggregates whose session and workflow read models are both absent", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const sweep = yield* EventResidueSweep.Service

        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.make("proj_sweep"), worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({ id: SessionSchema.ID.make("ses_live"), project_id: ProjectV2.ID.make("proj_sweep"), slug: "live", directory: "/project", title: "live", version: "test" })
          .run()
          .pipe(Effect.orDie)
        // Archived sessions keep their read-model row — never eligible.
        yield* db
          .insert(SessionTable)
          .values({ id: SessionSchema.ID.make("ses_archived"), project_id: ProjectV2.ID.make("proj_sweep"), slug: "archived", directory: "/project", title: "archived", version: "test", time_archived: 123 })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(WorkflowTable)
          .values({ id: "dag_live", project_id: ProjectV2.ID.make("proj_sweep"), session_id: "ses_live", title: "live", status: "running", config: "{}", seq: 0, directory: "/project", target_fingerprint: { kind: "none" } })
          .run()
          .pipe(Effect.orDie)

        yield* seedAggregate("ses_live")
        yield* seedAggregate("ses_archived")
        yield* seedAggregate("dag_live")
        yield* seedAggregate("ses_zombie")
        yield* seedAggregate("dag_zombie")

        const removed = yield* sweep.sweepOnce()
        expect(removed).toBe(2)

        const survivors = yield* remainingAggregates(["ses_live", "ses_archived", "dag_live", "ses_zombie", "dag_zombie"])
        expect(survivors.map((row) => row.aggregate).sort()).toEqual(["dag_live", "ses_archived", "ses_live"])
        // Read models of live/archived aggregates are untouched.
        expect((yield* db.select().from(SessionTable).where(eq(SessionTable.id, SessionSchema.ID.make("ses_live"))).all().pipe(Effect.orDie)).length).toBe(1)
        expect((yield* db.select().from(SessionTable).where(eq(SessionTable.id, SessionSchema.ID.make("ses_archived"))).all().pipe(Effect.orDie)).length).toBe(1)
        expect((yield* db.select().from(WorkflowTable).where(eq(WorkflowTable.id, "dag_live")).all().pipe(Effect.orDie)).length).toBe(1)
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("a repeated pass finds nothing to remove", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sweep = yield* EventResidueSweep.Service
        expect(yield* sweep.sweepOnce()).toBe(0)
      }).pipe(Effect.provide(testLayer)),
    )
  })

  // Deterministic TOCTOU regression: a read model recreated between candidate
  // selection and deletion (the concurrent replay/publish race) survives the
  // guarded delete. Uses the sweep's own select/remove seam instead of sleeps.
  test("a read model recreated after candidate selection survives the guarded delete", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedProject
        const { db } = yield* Database.Service

        yield* seedAggregate("ses_zombie")
        yield* seedAggregate("dag_zombie")

        const candidates = yield* EventResidueSweep.selectResidues(db).pipe(Effect.orDie)
        expect(candidates.map((row) => row.aggregate_id).sort()).toEqual(["dag_zombie", "ses_zombie"])

        // Concurrent replay/publish lands here: the session read model is
        // re-materialized after selection, before deletion.
        yield* db
          .insert(SessionTable)
          .values({
            id: SessionSchema.ID.make("ses_zombie"),
            project_id: ProjectV2.ID.make("proj_sweep"),
            slug: "reanimated",
            directory: "/project",
            title: "reanimated",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)

        expect(yield* EventResidueSweep.removeResidue(db, "ses_zombie").pipe(Effect.orDie)).toBe(false)
        // The still-zombie aggregate is removed, its event rows cascading with it.
        expect(yield* EventResidueSweep.removeResidue(db, "dag_zombie").pipe(Effect.orDie)).toBe(true)

        const survivors = yield* remainingAggregates(["ses_zombie", "dag_zombie"])
        expect(survivors.map((row) => row.aggregate)).toEqual(["ses_zombie"])
        expect(
          (yield* db.select({ id: EventTable.id }).from(EventTable).where(eq(EventTable.aggregate_id, "ses_zombie")).all().pipe(Effect.orDie))
            .length,
        ).toBe(1)
        expect(
          yield* db.select({ id: EventTable.id }).from(EventTable).where(eq(EventTable.aggregate_id, "dag_zombie")).all().pipe(Effect.orDie),
        ).toEqual([])
      }).pipe(Effect.provide(testLayer)),
    )
  })
})
