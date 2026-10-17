import { describe, expect } from "bun:test"
import { Cause, Context, Effect, Exit, Layer, Option } from "effect"
import { eq, inArray } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { GoalOutcomeTable, GoalStateTable } from "@opencode-ai/core/goal/sql"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session as SessionNs } from "@/session/session"
import { SessionAttention } from "@/notification/attention"
import { SessionAutomationLease } from "@/session/automation-lease"
import { Goal } from "@/goal/goal"
import { Dag } from "@/dag/dag"
import { testEffect } from "../lib/effect"
import { testInstanceStoreLayer } from "../fixture/fixture"

// GOAL-FP-01-05/-06/-16: `Session.remove` must be the single cleanup point for
// durable session-scoped state — goal_state + goal_outcome rows, the dag
// automation lease registrations, and owned workflows.
//
// The layer mirrors the production AppLayer (effect/app-runtime.ts) group-1
// composition: Session, Goal and Dag are `Layer.mergeAll` SIBLINGS. mergeAll
// builds every member concurrently against the parent context only, so
// siblings cannot see each other's outputs. In production that made
// `Effect.serviceOption(Goal.Service)` inside Session's layer yield None and
// the cleanup silently no-op. This test builds the same sibling shape, so it
// fails against that wiring and passes once Session.defaultLayer self-provides
// its cleanup dependencies.
const testLayer = Layer.mergeAll(
  SessionNs.defaultLayer,
  Goal.defaultLayer,
  Dag.defaultLayer,
  SessionAutomationLease.defaultLayer,
  Database.defaultLayer,
  testInstanceStoreLayer,
  CrossSpawnSpawner.defaultLayer,
)

const it = testEffect(testLayer)

describe("Session.remove goal cleanup (GOAL-FP-01-05/-16)", () => {
  it.instance("deletes goal_state and goal_outcome rows for the removed session", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const goal = yield* Goal.Service
      const { db } = yield* Database.Service

      const info = yield* session.create({})
      const sessionID = info.id
      // markDone terminalizes the active goal into a durable goal_outcome row.
      yield* goal.set(sessionID, "first goal", 10)
      yield* goal.markDone(sessionID, "done for cleanup test")
      // A fresh active goal leaves a goal_state row behind at remove time.
      yield* goal.set(sessionID, "second goal", 10)

      const outcomeBefore = yield* db
        .select()
        .from(GoalOutcomeTable)
        .where(eq(GoalOutcomeTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(outcomeBefore).not.toBeNull()

      yield* session.remove(sessionID)

      const stateRow = yield* db
        .select()
        .from(GoalStateTable)
        .where(eq(GoalStateTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(stateRow).toBeUndefined()

      const outcomeRow = yield* db
        .select()
        .from(GoalOutcomeTable)
        .where(eq(GoalOutcomeTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(outcomeRow).toBeUndefined()
    }),
  )
})

describe("Session.remove dag lease cleanup (GOAL-FP-01-06)", () => {
  it.instance("purges dag automation lease registrations for the removed session", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const lease = yield* SessionAutomationLease.Service

      const info = yield* session.create({})
      const sessionID = info.id
      yield* lease.register(sessionID, { kind: "dag", id: "wf-lease-test" })
      expect(Option.isSome(yield* lease.claim(sessionID, { kind: "dag" }))).toBe(true)

      yield* session.remove(sessionID)

      expect(Option.isNone(yield* lease.claim(sessionID, { kind: "dag" }))).toBe(true)
    }),
  )

  it.instance("cancels workflows owned by the removed session", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dag = yield* Dag.Service
      const { db } = yield* Database.Service

      const info = yield* session.create({})
      const sessionID = info.id
      const dagID = yield* dag.create({
        projectID: info.projectID,
        sessionID,
        title: "session-remove-cleanup-test",
        config: {
          name: "session-remove-cleanup-test",
          nodes: [
            {
              id: "n1",
              name: "n1",
              worker_type: "build",
              depends_on: [],
              required: true,
              prompt_template: { inline: "do work" },
            },
          ],
        },
      })
      expect((yield* dag.store.getWorkflow(dagID).pipe(Effect.orDie))?.status).toBe("running")

      // #524 supersession: this pin used to observe the cancel through the
      // durable dag.workflow.cancelled event row. Since Session.remove now
      // scrubs the whole dag event aggregate AFTER the cancel transition (the
      // transition itself is pinned by the dag lifecycle tests), the boundary
      // observable is the absence of residue: the cancelled workflow leaves no
      // read-model row and no event-store rows behind.
      yield* session.remove(sessionID)

      const sequences = yield* db
        .select({ aggregate: EventSequenceTable.aggregate_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, dagID))
        .all()
        .pipe(Effect.orDie)
      expect(sequences).toEqual([])

      const events = yield* db
        .select({ aggregate: EventTable.aggregate_id })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, dagID))
        .all()
        .pipe(Effect.orDie)
      expect(events).toEqual([])

      // Recovery scan contract (dag/runtime/loop.ts adopts only
      // running/paused/stepping rows): the workflow must not be re-adoptable.
      const adoptable = yield* dag.store.listByStatus("running").pipe(Effect.orDie)
      expect(adoptable.map((wf) => wf.id)).not.toContain(dagID)
    }),
  )
})

const workflowConfig = (name: string) => ({
  name,
  nodes: [
    {
      id: "n1",
      name: "n1",
      worker_type: "build",
      depends_on: [],
      required: true,
      prompt_template: { inline: "do work" },
    },
  ],
})

describe("Session.remove dag aggregate scrub (#524)", () => {
  it.instance("removes every related dag event aggregate including terminal workflows", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dag = yield* Dag.Service
      const { db } = yield* Database.Service

      const info = yield* session.create({})
      const sessionID = info.id
      const terminalDag = yield* dag.create({
        projectID: info.projectID,
        sessionID,
        title: "scrub-terminal",
        config: workflowConfig("scrub-terminal"),
      })
      // Terminal BEFORE remove: the pre-publish capture must include it even
      // though the cancel loop skips terminal rows as already inert.
      yield* dag.cancel(terminalDag)
      const liveDag = yield* dag.create({
        projectID: info.projectID,
        sessionID,
        title: "scrub-live",
        config: workflowConfig("scrub-live"),
      })

      const aggregateIDs = [terminalDag, liveDag, sessionID]
      const pre = yield* db
        .select({ aggregate: EventSequenceTable.aggregate_id })
        .from(EventSequenceTable)
        .where(inArray(EventSequenceTable.aggregate_id, aggregateIDs))
        .all()
        .pipe(Effect.orDie)
      expect(new Set(pre.map((row) => row.aggregate)).size).toBe(3)

      yield* session.remove(sessionID)

      const sequences = yield* db
        .select({ aggregate: EventSequenceTable.aggregate_id })
        .from(EventSequenceTable)
        .where(inArray(EventSequenceTable.aggregate_id, aggregateIDs))
        .all()
        .pipe(Effect.orDie)
      expect(sequences).toEqual([])
      const events = yield* db
        .select({ aggregate: EventTable.aggregate_id })
        .from(EventTable)
        .where(inArray(EventTable.aggregate_id, aggregateIDs))
        .all()
        .pipe(Effect.orDie)
      expect(events).toEqual([])
    }),
  )
})

// #524 interrupt-contract regression: the per-dag scrub catchCause must
// preserve interruption (the EventResidueSweep sibling discipline) instead of
// degrading it into a logWarning. The stub bridge fails events.remove with a
// self-thrown interrupt cause — the only cause shape catchCause can
// intercept; external interrupts bypass it — for every aggregate EXCEPT the
// session's own, so any interrupt surfacing from session.remove can only
// originate from the dag scrub step.
function interruptingScrubBridgeNode(gate: { sessionID?: string }) {
  return LayerNode.make(
    Layer.effect(
      EventV2Bridge.Service,
      Effect.gen(function* () {
        const bridge = Context.get(yield* Layer.build(EventV2Bridge.layer), EventV2Bridge.Service)
        return EventV2Bridge.Service.of({
          ...bridge,
          remove: (aggregateID) =>
            Effect.suspend(() =>
              gate.sessionID !== undefined && aggregateID !== gate.sessionID
                ? Effect.interrupt
                : bridge.remove(aggregateID),
            ),
        })
      }),
    ),
    [EventV2.node],
  )
}

const scrubGate: { sessionID?: string } = {}
const scrubInterruptIt = testEffect(
  Layer.mergeAll(
    LayerNode.buildLayer(LayerNode.group([SessionNs.node, SessionProjector.node, Dag.node]), {
      replacements: [LayerNode.replaceWithNode(EventV2Bridge.node, interruptingScrubBridgeNode(scrubGate))],
    }),
    CrossSpawnSpawner.defaultLayer,
  ),
)

describe("Session.remove dag aggregate scrub interrupt contract (#524)", () => {
  scrubInterruptIt.instance("scrub interruption propagates out of remove instead of degrading to a warning", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dag = yield* Dag.Service
      const info = yield* session.create({})
      const sessionID = info.id
      yield* dag.create({
        projectID: info.projectID,
        sessionID,
        title: "scrub-interrupt",
        config: workflowConfig("scrub-interrupt"),
      })

      scrubGate.sessionID = sessionID
      const exit = yield* session.remove(sessionID).pipe(Effect.exit)
      scrubGate.sessionID = undefined

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    }),
  )
})

// Instance fixture layers close before acquireRelease finalizers. Cleanup must
// use the captured directory instead of reopening the already-closed store.
const finalizerIt = testEffect(Layer.mergeAll(testLayer, SessionAttention.defaultLayer))
finalizerIt.instance("session deletion clears attention from a release finalizer without reloading its directory", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionNs.Service
    const attention = yield* SessionAttention.Service
    const session = yield* Effect.acquireRelease(sessions.create({ title: "finalizer cleanup" }), (info) =>
      Effect.gen(function* () {
        yield* sessions.remove(info.id).pipe(Effect.orDie)
        expect(yield* attention.viewing(info.id)).toBe(false)
        expect((yield* sessions.get(info.id).pipe(Effect.exit))._tag).toBe("Failure")
      }),
    )
    yield* attention.update(session.id, { clientID: "finalizer-client", clientType: "terminal", backgroundView: true })
    expect(yield* attention.viewing(session.id)).toBe(true)
  }),
)
