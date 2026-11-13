// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the probe stubs the services the tick never reaches (`as never`) while measuring the real stores' reads.

import { expect } from "bun:test"
import { Effect, Layer, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Database } from "@graphagent/core/database/database"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { DagDelivery } from "@/dag/runtime/delivery"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Goal } from "@/goal/goal"
import { GoalLoop } from "@/goal/loop"
import type { InstanceContext } from "@/project/instance-context"
import { Provider } from "@/provider/provider"
import { ChildResults } from "@/session/child/result-source"
import { SessionInbox } from "@/session/inbox"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { countingDatabaseLayer, countingEventLayer, reset, settle, snapshot } from "../lib/engine-probe"
import { it } from "../lib/effect"
import { mockSessionPrompt } from "../lib/child-runs"

// H0 read budget for the whole inbox tick (Issue #1021, invariant 7).
// `dag-tick-reads.test.ts` pins the DAG ledgers on their own; this probe pins
// what one instance really pays: the REAL `SessionInbox` with the production
// `goal.continue` source (registered by `GoalLoop.init`), the production
// `dag.delivery` source (registered by `DagDelivery.make`) and the production
// `child.result` source (registered by `ChildResults.make`, Issue #1026 PR3a)
// on one counting database, driven by the inbox's own 30s timer under
// TestClock. With nothing to deliver a tick may issue at most four reads: goal
// 1 (`listWaitingSessions`) + DAG 2 (one wake + due-paused UNION, one mailbox
// page) + child 1 (one directory-filtered query over `child_run_unreported`),
// which spends the whole budget. Reads are the statements the production SQL
// client issues, not an assumed shape.
const DIRECTORY = "/work/inbox-tick-reads"
const PROJECT_ID = "project-inbox-tick-reads"

/** Invariant 7: the most reads one instance's tick may issue with nothing to deliver. */
const TICK_READ_BUDGET = 4

// What the three sources pay today. Their sum is the whole budget: no source
// can add a read without another giving one up.
const GOAL_TICK_READS = 1
const DAG_TICK_READS = 2
const CHILD_TICK_READS = 1

const context: InstanceContext = {
  directory: DIRECTORY,
  worktree: DIRECTORY,
  root: DIRECTORY,
  project: { id: Project.ID.make(PROJECT_ID), worktree: DIRECTORY, time: { created: 0, updated: 0 }, sandboxes: [] },
}

// One counting database shared by every store the tick reads. The event bus
// and status map sit on it too, so nothing the sources touch escapes the count.
const databaseLayer = countingDatabaseLayer
const bridgeLayer = EventV2Bridge.layer.pipe(
  Layer.provide(countingEventLayer(EventV2.layer.pipe(Layer.provide(databaseLayer)))),
)
const statusLayer = SessionStatus.layer.pipe(Layer.provide(bridgeLayer))
const goalLayer = Goal.layer.pipe(Layer.provide(databaseLayer), Layer.provide(statusLayer), Layer.provide(bridgeLayer))
const storeLayer = DagStore.layer.pipe(Layer.provide(databaseLayer))
const messagesLayer = DagMessages.layer.pipe(Layer.provide(databaseLayer))

// The tick never reaches the session, prompt or provider services: they only
// have to exist for the goal loop to build. The inbox the goal loop registers
// into is `SessionInbox.defaultLayer`; merging that same layer object exposes
// the identical instance to the test body (layer memoization is by reference).
const loopLayer = GoalLoop.layer.pipe(
  Layer.provide(Layer.mock(Session.Service, {})),
  Layer.provide(mockSessionPrompt({})),
  Layer.provide(Layer.mock(Provider.Service, {})),
  Layer.provideMerge(goalLayer),
  Layer.provideMerge(statusLayer),
)
const layer = Layer.mergeAll(databaseLayer, storeLayer, messagesLayer, loopLayer, SessionInbox.defaultLayer)

interface Sources {
  readonly goal: boolean
  readonly dag: boolean
  readonly child: boolean
}

interface Tick {
  readonly reads: number
  readonly writes: number
  readonly events: number
}

/** Wait on a real signal: the tick's first SQL statement, not a fixed number of turns. */
const waitForReads = Effect.gen(function* () {
  const deadline = Date.now() + 10_000
  while (snapshot()["sql.read"] === 0) {
    if (Date.now() > deadline) yield* Effect.die(new Error("the 30s tick never read a ledger"))
    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1)))
  }
})

/**
 * Boot a fresh inbox instance with the chosen production sources registered,
 * advance the virtual clock to its first 30s tick, and count the tick's SQL.
 */
const measureTick = (sources: Sources): Effect.Effect<Tick> =>
  Effect.gen(function* () {
    const inbox = yield* SessionInbox.Service
    const scope = yield* Scope.Scope

    // Production registration paths: DagDelivery.make registers
    // `dag.delivery` (plus the mailbox step hint), GoalLoop.init registers
    // `goal.continue`, both with this instance's inbox.
    if (sources.dag) {
      yield* DagDelivery.make({
        directory: DIRECTORY,
        projectID: PROJECT_ID,
        scope,
        store: yield* DagStore.Service,
        messages: yield* DagMessages.Service,
        database: yield* Database.Service,
        // The tick only reads the ledgers; delivery paths are unreachable with
        // nothing to deliver, so their services stay unused.
        dag: undefined as never,
        sessions: undefined as never,
        prompts: undefined as never,
        status: undefined as never,
        automation: undefined as never,
        events: undefined as never,
        inbox,
        entries: () => undefined,
        lastAssistantMessage: () => Effect.succeed(undefined),
      })
    }
    if (sources.goal) yield* (yield* GoalLoop.Service).init()
    // The admission port is only reached when a result is owed, which an empty tick never finds.
    if (sources.child)
      yield* ChildResults.make({
        db: (yield* Database.Service).db,
        inbox,
        prompts: undefined as never,
        directory: DIRECTORY,
        scope,
      })
    // Arms the instance's 30s timer exactly like bootstrap does.
    yield* inbox.init()

    // Drop construction reads (startup scans); only the timed pass is measured.
    yield* settle()
    reset()
    yield* TestClock.adjust("30 seconds")
    yield* waitForReads
    // The pass is a handful of synchronous statements; a quiet gap proves it
    // ended, so a read issued late in the pass is still counted.
    yield* settle()

    const counts = snapshot()
    return {
      reads: counts["sql.read"],
      writes: counts["sql.write"],
      events: counts["events.durable"] + counts["events.ephemeral"],
    }
  }).pipe(Effect.provide(layer), Effect.provideService(InstanceRef, context), Effect.scoped)

it.effect(
  "an empty 30s tick of the goal, DAG and child.result sources reads all four budgeted ledgers and writes nothing",
  () =>
    Effect.gen(function* () {
      const goalOnly = yield* measureTick({ goal: true, dag: false, child: false })
      const dagOnly = yield* measureTick({ goal: false, dag: true, child: false })
      const childOnly = yield* measureTick({ goal: false, dag: false, child: true })
      const joint = yield* measureTick({ goal: true, dag: true, child: true })
      // The measured values ride along in the CI log, not just a pass/fail.
      process.stderr.write(
        `[inbox-tick-reads] goal=${goalOnly.reads} dag=${dagOnly.reads} child=${childOnly.reads} joint=${joint.reads} budget=${TICK_READ_BUDGET}\n`,
      )

      // The gate (invariant 7).
      expect(joint.reads).toBeLessThanOrEqual(TICK_READ_BUDGET)
      // Each source really scans on its own, and the joint pass is exactly their
      // sum: the inbox adds no read of its own, and a source that silently
      // dropped out of the shared inbox cannot pass the budget vacuously. The
      // sum is the whole budget: goal 1 + DAG 2 + child 1.
      expect(goalOnly.reads).toBe(GOAL_TICK_READS)
      expect(dagOnly.reads).toBe(DAG_TICK_READS)
      expect(childOnly.reads).toBe(CHILD_TICK_READS)
      expect(joint.reads).toBe(goalOnly.reads + dagOnly.reads + childOnly.reads)
      expect(joint.reads).toBe(GOAL_TICK_READS + DAG_TICK_READS + CHILD_TICK_READS)
      expect(joint.reads).toBe(TICK_READ_BUDGET)
      // A tick with nothing to deliver neither writes a row nor publishes an event.
      for (const tick of [goalOnly, dagOnly, childOnly, joint]) {
        expect(tick.writes).toBe(0)
        expect(tick.events).toBe(0)
      }
    }),
)
