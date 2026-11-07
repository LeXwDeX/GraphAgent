import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { Session } from "@opencode-ai/schema/session"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Dag, type NodeConfig } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"

// ============================================================================
// Ticket B — spurious T8 (stale-read budget consumption), method-A.
//
// The deadline watcher reads the durable row WITHOUT the workflow lock
// (spawn.ts readNode). When that stale snapshot shows an expired deadline it
// calls dag.nodeTimeoutEscalated, which acquires the workflow lock and would
// unconditionally publish NodeTimeoutEscalated (incrementing timeout_extensions).
// If a replan's nodeExtendTimeout moved the deadline into the future BETWEEN the
// stale read and the lock acquisition, the escalation charges a budget unit for
// a node that is no longer overdue — a spurious T8 (domain 3; the cosmetic
// residue self-documented at loop.ts:870-880).
//
// Method-A fix: the watchdog passes the deadline it observed (node.deadlineMs).
// nodeTimeoutEscalated re-reads the node FRESH under the workflow lock and, when
// the deadline has moved strictly past the observed value, suppresses the
// escalation (no publish, no budget increment). Budget only counts a real
// extension (a deadline that actually moved), not a stale-read cosmetic recount.
//
// N1 (running node never loses its watcher): nodeTimeoutEscalated returns void
// whether it publishes or suppresses, and the watcher's self-renewal loop
// (spawn.ts:126-199) only exits on a terminal status or fiber interrupt — a
// suppressed escalation flows into the same post-escalation sleep+re-read as a
// published one, so supervision cannot end on the suppression path.
// ============================================================================

function node(id: string, timeoutMs?: number): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: id },
    ...(timeoutMs !== undefined ? { worker_config: { timeout_ms: timeoutMs } } : {}),
  }
}

const harness = (() => {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  return Layer.mergeAll(database, events, bridge, store, projector, dag)
})()

function runTest<A>(
  test: (services: { readonly dag: Dag.Interface; readonly store: DagStore.Interface; readonly db: Database.Interface["db"] }) => Effect.Effect<A, Error>,
) {
  return Effect.gen(function* () {
    return yield* Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.insert(ProjectTable).values({
        id: Project.ID.make("project-1"),
        worktree: AbsolutePath.make(process.cwd()),
        sandboxes: [],
      }).run().pipe(Effect.orDie)
      yield* database.db.insert(SessionTable).values({
        id: Session.ID.make("ses_parent"),
        project_id: Project.ID.make("project-1"),
        slug: "parent",
        directory: AbsolutePath.make(process.cwd()),
        title: "Parent",
        version: "test",
      }).run().pipe(Effect.orDie)
      const dag = yield* Dag.Service
      const store = yield* DagStore.Service
      return yield* test({ dag, store, db: database.db })
    }).pipe(
      Effect.provide(harness),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        root: process.cwd(),
        project: {
          id: Project.ID.make("project-1"),
          worktree: process.cwd(),
          time: { created: 0, updated: 0 },
          sandboxes: [],
        },
      }),
      Effect.scoped,
    )
  })
}

function createWorkflow(dag: Dag.Interface, title: string, nodeID = "a") {
  return dag.create({
    projectID: Project.ID.make("project-1"),
    sessionID: Session.ID.make("ses_parent"),
    title,
    config: { name: title, nodes: [node(nodeID)] },
  })
}

// Count durable NodeTimeoutEscalated rows for a node. The stored type is
// versioned (`dag.node.timeout_escalated.1`), so match the prefix. Narrowing
// the JSON `data` column to a struct is a safe downcast (not an unsafe
// assertion) — it never inflates the no-unsafe-type-assertion ratchet.
function timeoutEscalatedCount(db: Database.Interface["db"], dagID: string, nodeID: string) {
  return Effect.gen(function* () {
    const rows = yield* db
      .select({ type: EventTable.type, data: EventTable.data })
      .from(EventTable)
      .where(sql`${EventTable.aggregate_id} = ${dagID} AND ${EventTable.type} LIKE 'dag.node.timeout_escalated.%'`)
      .all()
      .pipe(Effect.orDie)
    return rows.filter((row) => (row.data as { nodeID?: string }).nodeID === nodeID).length
  })
}

describe("nodeTimeoutEscalated stale-read suppression (ticket B, method-A)", () => {
  it("suppresses the escalation when the deadline was extended after the watcher's stale read (spurious T8)", async () => {
    await Effect.runPromise(
      runTest(({ dag, store, db }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "stale-suppressed")
          // The node started with an EXPIRED deadline — this is the value the
          // watcher's stale snapshot would have read.
          const expiredDeadline = Date.now() - 5_000
          yield* dag.nodeQueued(dagID, "a", expiredDeadline)
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", expiredDeadline, true)

          // A replan adjudicates the timeout by extending the deadline into the
          // future AFTER the watcher's snapshot read but BEFORE its escalation
          // acquires the workflow lock. nodeExtendTimeout publishes
          // NodeDeadlineExtended (no budget change — extensions never increment
          // timeout_extensions).
          const extendedDeadline = Date.now() + 60_000
          const written = yield* dag.nodeExtendTimeout(dagID, "a", extendedDeadline)
          expect(written).toBe(1)
          const extended = yield* store.getNode(dagID, "a")
          expect(extended?.deadlineMs).toBe(extendedDeadline)
          expect(extended?.timeoutExtensions).toBe(0)

          // The watcher fires nodeTimeoutEscalated carrying the deadline it
          // OBSERVED (the stale expired value). Under the workflow lock the
          // command re-reads the node: its deadline is now strictly past the
          // observed value → the stale read is invalidated → the escalation is
          // suppressed. No NodeTimeoutEscalated event, no budget increment.
          yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_1", 1, expiredDeadline)

          const eventCount = yield* timeoutEscalatedCount(db, dagID, "a")
          expect(eventCount).toBe(0)

          const row = yield* store.getNode(dagID, "a")
          expect(row?.status).toBe("running")
          expect(row?.timeoutExtensions).toBe(0)
          expect(row?.escalationPending).toBe(false)
          expect(row?.deadlineMs).toBe(extendedDeadline)
        }),
      ),
    )
  })

  it("still escalates when the deadline was NOT extended (legitimate escalation — regression arm)", async () => {
    await Effect.runPromise(
      runTest(({ dag, store, db }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "stale-legitimate")
          const expiredDeadline = Date.now() - 5_000
          yield* dag.nodeQueued(dagID, "a", expiredDeadline)
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", expiredDeadline, true)
          // No replan extend: the fresh in-lock deadline equals the observed
          // value, so the escalation is NOT a stale read and must publish.
          yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_1", 1, expiredDeadline)

          const eventCount = yield* timeoutEscalatedCount(db, dagID, "a")
          expect(eventCount).toBe(1)

          const row = yield* store.getNode(dagID, "a")
          expect(row?.status).toBe("running")
          expect(row?.timeoutExtensions).toBe(1)
          expect(row?.escalationPending).toBe(true)
          expect(row?.wakeReported).toBe(false)
        }),
      ),
    )
  })

  it("preserves back-compat: a 4-arg call (no observed deadline) never suppresses", async () => {
    await Effect.runPromise(
      runTest(({ dag, store, db }) =>
        Effect.gen(function* () {
          const dagID = yield* createWorkflow(dag, "stale-backcompat")
          // A future-deadline node is escalated directly (the idiom existing
          // tests use to set up escalation_pending). With no observed-deadline
          // argument the suppression guard is inert — callers that do not opt
          // into the stale-read protocol keep the unconditional-publish
          // behavior, so existing 4-arg call sites are unaffected.
          yield* dag.nodeQueued(dagID, "a", Date.now() + 60_000)
          yield* dag.nodeStarted(dagID, "a", "ses_child_1", Date.now() + 60_000, true)
          yield* dag.nodeTimeoutEscalated(dagID, "a", "ses_child_1", 1)

          const eventCount = yield* timeoutEscalatedCount(db, dagID, "a")
          expect(eventCount).toBe(1)

          const row = yield* store.getNode(dagID, "a")
          expect(row?.timeoutExtensions).toBe(1)
          expect(row?.escalationPending).toBe(true)
        }),
      ),
    )
  })
})
