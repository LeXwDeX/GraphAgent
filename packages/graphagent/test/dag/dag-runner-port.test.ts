// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1029 / ADR-0008 decisions 4 and 5, PR3b: the runner port.
 *
 * A runner write is a `Dag` command whose decision rests on the runner's own
 * scheduling state; it carries the lease token of the runtime entry, and the
 * fence in front of its transaction refuses a token the lease no longer names.
 * The port (`RunnerPort.make`) binds the token to every such command and is the
 * only place that handles the refusal: it starts the runner's reaction (`lost`)
 * and fails the call with an existing transition rejection, never with the
 * fence's own `StaleRunnerError`.
 *
 * The harness is the real stack under a port (SQLite file, event bus,
 * projectors, DagStore, DagMessages, DagLease, DagTransact), with no DagLoop: the
 * lease table is driven by hand, with the explicit clocks `DagLease` takes, so
 * each case sets the runners up in one statement. What the loop does with the
 * port (eviction, which writes it routes) is covered on two runners in
 * dag-runner-races.test.ts and dag-runner-lease.test.ts.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { asc, eq, sql } from "drizzle-orm"
import { Cause, Context, DateTime, Effect, Exit, Fiber, Layer, Option } from "effect"
import type { Scope } from "effect"
import { InvalidTransitionError, isTransitionRejection } from "@graphagent/core/dag/core/types"
import { DagLease } from "@graphagent/core/dag/lease"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { DagTransact } from "@graphagent/core/dag/transact"
import { Database } from "@graphagent/core/database/database"
import { layer as sqliteLayer } from "@graphagent/core/database/sqlite.bun"
import { EventV2 } from "@graphagent/core/event"
import { EventSequenceTable, EventTable } from "@graphagent/core/event/sql"
import { Project } from "@graphagent/core/project"
import { DagEvent } from "@graphagent/schema/dag-event"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagReconciler } from "@/dag/runtime/reconciler"
import { RunnerPort } from "@/dag/runtime/runner-port"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const PROJECT = "p"
const PARENT = "ses_parent"
/** `pid:nonce`: the runner that drove the workflow and the one that took it over. */
const R1 = "10:one"
const R2 = "11:two"

const it = testEffect(Layer.empty)

const node = (id: string, dependsOn: string[] = []): NodeConfig => ({
  id,
  name: id,
  worker_type: "build",
  depends_on: dependsOn,
  required: false,
  prompt_template: { inline: id },
})

// -- the harness -------------------------------------------------------------

interface Harness {
  readonly directory: string
  /** The token of every transaction a `Dag` command ran, in order: `undefined` for a write that carried none. */
  readonly tokens: Array<DagLease.Token | undefined>
}

type Services = Dag.Service | Database.Service | DagStore.Service | DagLease.Service | EventV2.Service | Scope.Scope

const withHarness = <A, E>(body: (harness: Harness) => Effect.Effect<A, E, Services>) =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(async () => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dag-runner-port-")))),
      (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
    )
    const tokens: Array<DagLease.Token | undefined> = []
    const sqlite = sqliteLayer({ filename: path.join(directory, "dag.sqlite") })
    const database = Database.layer.pipe(Layer.provide(sqlite))
    const events = EventV2.layer.pipe(Layer.provide(database))
    const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
    const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
    const store = DagStore.layer.pipe(Layer.provide(database))
    const messages = DagMessages.layer.pipe(Layer.provide(database))
    const lease = DagLease.layer.pipe(Layer.provide(database))
    // The real fence, behind a record of the token each transaction was asked for.
    const transact = Layer.effect(
      DagTransact.Service,
      Effect.gen(function* () {
        const real = yield* DagTransact.Service
        return DagTransact.Service.of({
          transact: (dagID, token, body) =>
            Effect.sync(() => void tokens.push(token)).pipe(Effect.andThen(real.transact(dagID, token, body))),
        })
      }),
    ).pipe(Layer.provide(DagTransact.layer.pipe(Layer.provide(Layer.merge(database, lease)))))
    const dag = Dag.layer.pipe(Layer.provide(Layer.mergeAll(bridge, store, messages, transact)))
    const services = Layer.mergeAll(sqlite, database, events, projector, store, messages, lease, dag)

    return yield* Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(
        sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES (${PROJECT},${directory},'[]',1,1)`,
      )
      yield* db.run(
        sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES (${PARENT},${PROJECT},NULL,${PARENT},${directory},'Parent','test',1,1)`,
      )
      return yield* body({ directory, tokens })
    }).pipe(Effect.provide(services), Effect.orDie)
  })

const createWorkflow = (nodes: NodeConfig[] = [node("a"), node("b", ["a"])]) =>
  Effect.gen(function* () {
    const dag = yield* Dag.Service
    return yield* dag.create({ projectID: PROJECT, sessionID: PARENT, title: "t", config: { name: "t", nodes } })
  })

/**
 * The `pending` workflow an older version left behind, all its nodes still `pending` (ADR-0008 decision 6, row 8):
 * the durable prefix that `Dag.create` wrote before it became one transaction, and nothing after it.
 */
const createOrphan = (harness: Harness, nodes: ReadonlyArray<string> = ["a", "b"]) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const dagID = DagEvent.DagID.create()
    yield* events.publish(DagEvent.WorkflowCreated, {
      dagID,
      projectID: Project.ID.make(PROJECT),
      sessionID: SessionID.make(PARENT),
      title: "orphan",
      config: JSON.stringify({ name: "orphan", nodes: [] }),
      status: "pending",
      timestamp: yield* DateTime.now,
      directory: harness.directory,
    })
    for (const nodeID of nodes)
      yield* events.publish(DagEvent.NodeRegistered, {
        dagID,
        nodeID: DagEvent.NodeID.make(nodeID),
        name: nodeID,
        workerType: "build",
        dependsOn: [],
        required: true,
        timestamp: yield* DateTime.now,
      })
    return dagID
  })

/** Queue and start a node the way the spawn path does, with the child session row the mailbox guard binds a settlement to. */
const start = (dag: Dag.Interface, dagID: string, nodeID: string, harness: Harness) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(
      sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES (${`ses_${nodeID}`},${PROJECT},${PARENT},${`ses_${nodeID}`},${harness.directory},'child','test',1,1)`,
    )
    yield* dag.nodeQueued(dagID, nodeID)
    yield* dag.nodeStarted(dagID, nodeID, `ses_${nodeID}`)
  })

/** The event log of one workflow: what a refused write must leave untouched. */
const logOf = (dagID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, dagID))
      .orderBy(asc(EventTable.seq))
      .all()
    // Stored types carry their schema version: `dag.node.failed.1`.
    return rows.map((row) => row.type.replace(/\.\d+$/, ""))
  })

/** The read model of one workflow, without the local write times. */
const snapshot = (dagID: string) =>
  Effect.gen(function* () {
    const store = yield* DagStore.Service
    const workflow = yield* store.getWorkflow(dagID)
    const nodes = yield* store.getNodes(dagID)
    const strip = <T extends { timeCreated?: number; timeUpdated?: number }>(row: T) => {
      const { timeCreated: _created, timeUpdated: _updated, ...durable } = row
      return durable
    }
    return { workflow: workflow ? strip(workflow) : undefined, nodes: nodes.map(strip) }
  })

/** R1 drove the workflow (epoch 1), stalled past its TTL, and R2 took it over (epoch 2). */
const takenOver = (dagID: string) =>
  Effect.gen(function* () {
    const leases = yield* DagLease.Service
    expect((yield* leases.claim({ dagID, runnerID: R1, now: 0 }))?.epoch).toBe(1)
    expect((yield* leases.claim({ dagID, runnerID: R2, now: DagLease.TTL_MS }))?.epoch).toBe(2)
    return { stale: { runnerID: R1, epoch: 1 }, holder: { runnerID: R2, epoch: 2 } } satisfies Record<
      string,
      DagLease.Token
    >
  })

/** A port whose `lost` counts: what the runner would be told about its refused write. */
const portOf = (dag: Dag.Interface, token: DagLease.Token) => {
  const refused: string[] = []
  const port = RunnerPort.make({
    dag,
    token,
    lost: Effect.sync(() => void refused.push(`${token.runnerID}@${token.epoch}`)),
  })
  return { port, refused }
}

const errorOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "")

// -- the classification --------------------------------------------------------

/**
 * ADR-0008 decision 4, one entry per member of the `Dag` service, so that a new
 * command cannot be added without deciding which kind of write it is. "runner":
 * only the runtime's own decisions issue it; "both": the runtime issues it as a
 * runner write on its port and a user, an agent, a policy or the host sweep issues
 * it without a token; "intent": a user, an agent or a policy asked for it, no
 * token; "durable": rests on the row's execution location alone, no token;
 * "read": not a write.
 */
const CLASSES = {
  create: "intent",
  store: "read",
  pause: "both",
  pauseForCheckpoint: "runner",
  pauseForBudget: "intent",
  pauseForArchive: "intent",
  requeueNodes: "intent",
  resume: "intent",
  resumeIfPausedFor: "intent",
  step: "intent",
  cancel: "intent",
  complete: "intent",
  fail: "both",
  failOrphan: "runner",
  failUnrecoverable: "durable",
  settleCompletion: "both",
  exclusive: "read",
  replan: "intent",
  extend: "both",
  recover: "intent",
  retarget: "intent",
  nodeQueued: "runner",
  nodeStarted: "runner",
  nodeCompleted: "runner",
  nodeFailed: "runner",
  nodeSkipped: "runner",
  nodeCancelled: "intent",
  nodeRestarted: "intent",
  nodeTimeoutEscalated: "runner",
  nodeExtendTimeout: "runner",
  extendTimeout: "intent",
} as const satisfies Record<keyof Dag.Interface, "runner" | "both" | "intent" | "durable" | "read">

describe("the classification of the Dag commands (ADR-0008 decision 4)", () => {
  it.live("every member of the service is classified, and the port binds exactly the runner writes", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const dag = yield* Dag.Service

        expect(Object.keys(dag).sort()).toEqual(Object.keys(CLASSES).sort())
        const runnerWrites = Object.entries(CLASSES)
          .filter(([, kind]) => kind === "runner" || kind === "both")
          .map(([name]) => name)
        expect([...RunnerPort.COMMANDS].map(String).sort()).toEqual(runnerWrites.sort())
      }),
    ),
  )
})

// -- every runner write, refused after a takeover ----------------------------

interface Scenario {
  readonly command: (typeof RunnerPort.COMMANDS)[number]
  /** The workflow the command runs on; by default a running one with nodes `a` and `b` (depends on `a`), neither required. */
  readonly create?: (harness: Harness) => Effect.Effect<string, unknown, Services>
  /** The state the command needs, on top of that workflow. */
  readonly prepare?: (dag: Dag.Interface, dagID: string, harness: Harness) => Effect.Effect<unknown, unknown, Services>
  readonly run: (dag: Dag.Interface, dagID: string) => Effect.Effect<unknown, unknown>
  /** An event the command publishes, so that an empty log cannot pass for a command that ran. */
  readonly publishes: string
}

const scenarios: ReadonlyArray<Scenario> = [
  { command: "nodeQueued", run: (dag, id) => dag.nodeQueued(id, "a"), publishes: "dag.node.queued" },
  {
    command: "nodeStarted",
    prepare: (dag, id) => dag.nodeQueued(id, "a"),
    run: (dag, id) => dag.nodeStarted(id, "a", "ses_a"),
    publishes: "dag.node.started",
  },
  {
    command: "nodeCompleted",
    prepare: (dag, id, harness) => start(dag, id, "a", harness),
    run: (dag, id) => dag.nodeCompleted(id, "a", "done"),
    publishes: "dag.node.completed",
  },
  {
    command: "nodeFailed",
    prepare: (dag, id, harness) => start(dag, id, "a", harness),
    run: (dag, id) => dag.nodeFailed(id, "a", "boom", "exec_failed"),
    publishes: "dag.node.failed",
  },
  {
    command: "nodeSkipped",
    run: (dag, id) => dag.nodeSkipped(id, "b", "condition_false"),
    publishes: "dag.node.skipped",
  },
  {
    command: "nodeTimeoutEscalated",
    prepare: (dag, id, harness) => start(dag, id, "a", harness),
    run: (dag, id) => dag.nodeTimeoutEscalated(id, "a", "ses_a", 1),
    publishes: "dag.node.timeout_escalated",
  },
  {
    command: "nodeExtendTimeout",
    prepare: (dag, id, harness) => start(dag, id, "a", harness),
    run: (dag, id) => dag.nodeExtendTimeout(id, "a", 60_000),
    publishes: "dag.node.deadline_extended",
  },
  {
    command: "settleCompletion",
    prepare: (dag, id, harness) =>
      Effect.gen(function* () {
        for (const nodeID of ["a", "b"]) {
          yield* start(dag, id, nodeID, harness)
          yield* dag.nodeCompleted(id, nodeID, `${nodeID} output`)
        }
      }),
    run: (dag, id) => dag.settleCompletion(id),
    publishes: "dag.workflow.completed",
  },
  {
    command: "extend",
    run: (dag, id) => dag.extend(id, [node("c", ["a"])]),
    publishes: "dag.workflow.replanned",
  },
  { command: "pause", run: (dag, id) => dag.pause(id), publishes: "dag.workflow.paused" },
  { command: "pauseForCheckpoint", run: (dag, id) => dag.pauseForCheckpoint(id, 1), publishes: "dag.workflow.paused" },
  { command: "fail", run: (dag, id) => dag.fail(id, "boom"), publishes: "dag.workflow.failed" },
  {
    command: "failOrphan",
    create: (harness) => createOrphan(harness),
    run: (dag, id) => dag.failOrphan(id, "orphan"),
    publishes: "dag.workflow.failed",
  },
]

describe("a runner write is refused once another runner took the workflow over (ADR-0008 decisions 4 and 5)", () => {
  it.live("the scenarios cover every command of the port", () =>
    Effect.sync(() => {
      expect(scenarios.map((scenario) => scenario.command).sort()).toEqual([...RunnerPort.COMMANDS].sort())
    }),
  )

  for (const scenario of scenarios)
    it.live(
      `${scenario.command}: the old holder's write fails as an obsolete transition and leaves no trace; the holder's goes through`,
      () =>
        withHarness((harness) =>
          Effect.gen(function* () {
            const dag = yield* Dag.Service
            const dagID = yield* scenario.create?.(harness) ?? createWorkflow()
            if (scenario.prepare) yield* scenario.prepare(dag, dagID, harness)
            const { stale, holder } = yield* takenOver(dagID)
            const zombie = portOf(dag, stale)
            const before = { log: yield* logOf(dagID), state: yield* snapshot(dagID) }

            const exit = yield* Effect.exit(scenario.run(zombie.port, dagID))

            // An existing transition rejection, which every call site carries on from: not the fence's own error.
            const error = errorOf(exit)
            expect(Exit.isFailure(exit)).toBe(true)
            expect(isTransitionRejection(error)).toBe(true)
            expect(error).toBeInstanceOf(InvalidTransitionError)
            expect(error).not.toBeInstanceOf(DagTransact.StaleRunnerError)
            expect(messageOf(error)).toContain("lease of runner 10:one (epoch 1) lost")
            // The runner was told, once, and nothing reached the log or the read model: no event, and above all no node failure.
            expect(zombie.refused).toEqual(["10:one@1"])
            expect(yield* logOf(dagID)).toEqual(before.log)
            expect(yield* snapshot(dagID)).toEqual(before.state)

            // The holder's token passes, and the command does what it is for.
            const current = portOf(dag, holder)
            yield* scenario.run(current.port, dagID)
            expect(current.refused).toEqual([])
            expect((yield* logOf(dagID)).slice(before.log.length)).toContain(scenario.publishes)
          }),
        ),
    )

  it.live("the token is the pair: the same runner at an older epoch is refused too", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const leases = yield* DagLease.Service
        const dagID = yield* createWorkflow()
        // R1 loses the workflow to R2 and takes it back: the row names R1 again, at epoch 3.
        yield* leases.claim({ dagID, runnerID: R1, now: 0 })
        yield* leases.claim({ dagID, runnerID: R2, now: DagLease.TTL_MS })
        yield* leases.claim({ dagID, runnerID: R1, now: 2 * DagLease.TTL_MS })
        const earlier = portOf(dag, { runnerID: R1, epoch: 1 })
        const current = portOf(dag, { runnerID: R1, epoch: 3 })

        const exit = yield* Effect.exit(earlier.port.nodeQueued(dagID, "a"))

        expect(isTransitionRejection(errorOf(exit))).toBe(true)
        expect(earlier.refused).toHaveLength(1)
        yield* current.port.nodeQueued(dagID, "a")
        expect(current.refused).toEqual([])
      }),
    ),
  )

  it.live("a workflow that ended has no holder: a late runner write is refused, not applied", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const dagID = yield* createWorkflow()
        yield* start(dag, dagID, "a", harness)
        const { holder } = yield* takenOver(dagID)
        yield* dag.cancel(dagID)
        const late = portOf(dag, holder)
        const before = yield* logOf(dagID)

        const exit = yield* Effect.exit(late.port.nodeCompleted(dagID, "a", "late"))

        expect(isTransitionRejection(errorOf(exit))).toBe(true)
        expect(yield* logOf(dagID)).toEqual(before)
      }),
    ),
  )
})

// -- the orphan's terminalization, one command ----------------------------------

/** The event log of one workflow, wiped from the read model, and the log itself to replay it from. */
const wipeKeepingLog = (dagID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, dagID))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, dagID)).run().pipe(Effect.orDie)
    yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, dagID)).run().pipe(Effect.orDie)
    yield* db.run(sql`DELETE FROM workflow_node WHERE workflow_id = ${dagID}`).pipe(Effect.orDie)
    yield* db.run(sql`DELETE FROM workflow WHERE id = ${dagID}`).pipe(Effect.orDie)
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      seq: row.seq,
      aggregateID: row.aggregate_id,
      data: row.data,
    }))
  })

/**
 * ADR-0008 Amendment 3, 4b-C: the projector accepts `WorkflowFailed` only from running or stepping, so failing an orphan
 * `pending` workflow takes `WorkflowStarted` first. The reconciler used to publish that one bare, outside the fence, and
 * then fail through the port. `failOrphan` does both in the one fenced transaction of a runner write.
 */
describe("failOrphan: the orphan's terminalization is one fenced transaction (ADR-0008 Amendment 3, 4b-C)", () => {
  const REASON = DagReconciler.ORPHAN_REASON

  it.live(
    "one call writes WorkflowStarted straight into WorkflowFailed, in one transaction under the holder's token",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const dag = yield* Dag.Service
          const store = yield* DagStore.Service
          const dagID = yield* createOrphan(harness)
          const { holder } = yield* takenOver(dagID)
          const { port, refused } = portOf(dag, holder)
          const before = yield* logOf(dagID)
          harness.tokens.length = 0

          yield* port.failOrphan(dagID, REASON)

          // One transaction, which is what the fence of the runner write answers for: it is a single command.
          expect(harness.tokens).toEqual([holder])
          expect(refused).toEqual([])
          // The two existing events, back to back, and then the nodes the failure ends; no event type is new.
          expect((yield* logOf(dagID)).slice(before.length)).toEqual([
            "dag.workflow.started",
            "dag.workflow.failed",
            "dag.node.skipped",
            "dag.node.skipped",
          ])
          // Failed, not cancelled: the interrupted-create semantics, with the reason on the durable event.
          expect((yield* store.getWorkflow(dagID))?.status).toBe("failed")
          expect(yield* store.getWorkflowFailureReason?.(dagID) ?? Effect.succeed(undefined)).toBe(REASON)
          expect((yield* store.getNodes(dagID)).map((node) => node.status)).toEqual(["skipped", "skipped"])
        }),
      ),
  )

  it.live("a workflow with no node at all is failed the same way", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const store = yield* DagStore.Service
        const dagID = yield* createOrphan(harness, [])
        const before = yield* logOf(dagID)

        yield* dag.failOrphan(dagID, REASON)

        expect((yield* logOf(dagID)).slice(before.length)).toEqual(["dag.workflow.started", "dag.workflow.failed"])
        expect((yield* store.getWorkflow(dagID))?.status).toBe("failed")
      }),
    ),
  )

  // The two legs are one transaction: a failure of the second takes the first back with it, so nothing is left that
  // reads as a `running` workflow with every node still `pending` (an adoption would start its nodes).
  it.live("rolls back as a whole when its second leg cannot be written: no WorkflowStarted is left behind", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const store = yield* DagStore.Service
        const { db } = yield* Database.Service
        const dagID = yield* createOrphan(harness)
        const { holder } = yield* takenOver(dagID)
        const { port } = portOf(dag, holder)
        const before = { log: yield* logOf(dagID), state: yield* snapshot(dagID) }
        yield* db.run(
          sql`CREATE TRIGGER fail_orphan_probe BEFORE UPDATE OF status ON workflow WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'the failure leg cannot be written'); END`,
        )

        const exit = yield* Effect.exit(port.failOrphan(dagID, REASON))

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* logOf(dagID)).toEqual(before.log)
        expect(yield* snapshot(dagID)).toEqual(before.state)
        expect((yield* store.getWorkflow(dagID))?.status).toBe("pending")

        // Without the fault the same call goes through.
        yield* db.run(sql`DROP TRIGGER fail_orphan_probe`)
        yield* port.failOrphan(dagID, REASON)
        expect((yield* store.getWorkflow(dagID))?.status).toBe("failed")
      }),
    ),
  )

  it.live("a refused token leaves neither event, and the runner is told once", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const store = yield* DagStore.Service
        const dagID = yield* createOrphan(harness)
        const { stale } = yield* takenOver(dagID)
        const zombie = portOf(dag, stale)
        const before = yield* logOf(dagID)

        const error = errorOf(yield* Effect.exit(zombie.port.failOrphan(dagID, REASON)))

        expect(error).toBeInstanceOf(InvalidTransitionError)
        expect(zombie.refused).toEqual(["10:one@1"])
        expect(yield* logOf(dagID)).toEqual(before)
        expect((yield* store.getWorkflow(dagID))?.status).toBe("pending")
      }),
    ),
  )

  // `guardWorkflow` alone would let a paused workflow through (paused -> running is legal): no create sequence leaves one.
  // Every refusal names the leg that the command starts with, `-> running`, and not the failure that would follow it.
  it.live("takes a `pending` workflow only: a running, a paused and a terminal one are refused untouched", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const running = yield* createWorkflow()
        const paused = yield* createWorkflow()
        yield* dag.pause(paused)
        const cancelled = yield* createWorkflow()
        yield* dag.cancel(cancelled)

        for (const [status, dagID] of [
          ["running", running],
          ["paused", paused],
          ["cancelled", cancelled],
        ] as const) {
          const before = { log: yield* logOf(dagID), state: yield* snapshot(dagID) }

          const error = errorOf(yield* Effect.exit(dag.failOrphan(dagID, REASON)))

          expect(error).toBeInstanceOf(InvalidTransitionError)
          expect(isTransitionRejection(error)).toBe(true)
          expect(messageOf(error)).toContain(`(${status} -> running)`)
          expect(yield* logOf(dagID)).toEqual(before.log)
          expect(yield* snapshot(dagID)).toEqual(before.state)
        }
      }),
    ),
  )

  it.live("replays to the same read model: the log is the two existing events in order", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const events = yield* EventV2.Service
        const dagID = yield* createOrphan(harness)
        yield* dag.failOrphan(dagID, REASON)
        const original = yield* snapshot(dagID)

        const serialized = yield* wipeKeepingLog(dagID)
        yield* events.replayAll(serialized)

        expect(yield* snapshot(dagID)).toEqual(original)
        expect(original.workflow?.status).toBe("failed")
      }),
    ),
  )
})

// -- what the port leaves alone ------------------------------------------------

describe("what the port does not touch (ADR-0008 decisions 4 and 5)", () => {
  it.live("an intent write carries no token and a lease never refuses it, whoever holds the workflow", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const dagID = yield* createWorkflow()
        yield* start(dag, dagID, "a", harness)
        yield* takenOver(dagID)
        harness.tokens.length = 0

        // A user pauses, resumes, replans and cancels a node; the budget pauses and requeues: R2's lease is live and none of it is R2's.
        yield* dag.pause(dagID)
        yield* dag.resume(dagID)
        yield* dag.replan(dagID, { nodes: [node("a"), node("b", ["a"]), node("c", ["a"])] })
        yield* dag.nodeCancelled(dagID, "c", "no longer needed")
        yield* dag.pauseForBudget(dagID)
        yield* dag.requeueNodes(dagID, ["a"], "budget raised by the user")
        yield* dag.resume(dagID)
        yield* dag.cancel(dagID)

        expect((yield* DagStore.Service.pipe(Effect.flatMap((store) => store.getWorkflow(dagID))))?.status).toBe(
          "cancelled",
        )
        expect(harness.tokens.length).toBeGreaterThan(0)
        expect(harness.tokens.filter((token) => token !== undefined)).toEqual([])
      }),
    ),
  )

  it.live("a command the port does not bind is the service itself: no token, and reads are the same object", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const dagID = yield* createWorkflow()
        const { holder } = yield* takenOver(dagID)
        const { port } = portOf(dag, holder)

        expect(port.store).toBe(dag.store)
        expect(port.create).toBe(dag.create)
        expect(port.cancel).toBe(dag.cancel)
        expect(port.failUnrecoverable).toBe(dag.failUnrecoverable)
      }),
    ),
  )

  it.live("every runner write carries the port's token, and only the port's commands do", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const dagID = yield* createWorkflow()
        const { holder } = yield* takenOver(dagID)
        const { port } = portOf(dag, holder)
        harness.tokens.length = 0

        yield* port.nodeQueued(dagID, "a")
        yield* port.nodeStarted(dagID, "a", "ses_a")
        yield* port.pause(dagID)
        // The port is the service: a command it does not bind goes through unfenced.
        yield* port.resume(dagID)
        yield* port.cancel(dagID)

        expect(harness.tokens).toEqual([holder, holder, holder, undefined, undefined])
      }),
    ),
  )

  it.live("a failure that is not a refusal passes through unchanged, and the runner is not told", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const dagID = yield* createWorkflow()
        const { holder } = yield* takenOver(dagID)
        const current = portOf(dag, holder)

        // The holder's own token, an illegal transition: the guard's rejection, as it is without a port.
        const viaPort = errorOf(yield* Effect.exit(current.port.nodeCompleted(dagID, "a", "x")))
        const direct = errorOf(yield* Effect.exit(dag.nodeCompleted(dagID, "a", "x")))

        expect(isTransitionRejection(viaPort)).toBe(true)
        expect(messageOf(viaPort)).toBe(messageOf(direct))
        expect(current.refused).toEqual([])
      }),
    ),
  )

  it.live("an interrupted command stays interrupted, and the runner is not told", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const dagID = yield* createWorkflow()
        const { holder } = yield* takenOver(dagID)
        const current = portOf(dag, holder)

        const fiber = yield* Effect.forkChild(current.port.nodeQueued(dagID, "a").pipe(Effect.andThen(Effect.never)))
        yield* Fiber.interrupt(fiber)

        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
        expect(current.refused).toEqual([])
      }),
    ),
  )
})

// The behavior above is the port's. That the runtime goes through it is the wiring of the loop and the
// delivery, which hold the plain service as well (for reads and for the writes that carry no token): one
// call site that named it would write without the token and no behavioral case would notice. `spawn.ts`
// and `recovery.ts` have only the service their caller provides, which is the port. The reconciler is given
// `portFor` and nothing else of `Dag`, so it cannot name the plain service; the pin below keeps it so.
describe("the loop and the delivery write runner commands through the port only (ADR-0008 decision 5)", () => {
  /** The source of a runtime file, comments stripped. */
  const source = (file: string) =>
    readFileSync(path.join(import.meta.dir, "../../src/dag/runtime", file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")

  // #1344: `teardown.ts` holds the plain service for the failure and the settlement of a workflow, so it is held to the same rule.
  for (const file of ["loop.ts", "teardown.ts", "delivery.ts", "reconciler.ts"])
    test(`${file} calls no runner command on the plain service`, () => {
      const plain = new RegExp(`\\bdag\\s*\\.\\s*(${RunnerPort.COMMANDS.join("|")})\\b`, "g")

      expect(source(file).match(plain) ?? []).toEqual([])
    })

  test("loop.ts provides the port, never the plain service, as the Dag service of the spawn, the recovery and the watchers", () => {
    // #1344: the handlers split out of loop.ts keep their provide sites, so they are counted with the loop's.
    const loop = ["loop.ts", "replan-handler.ts", "message-continuation.ts"].map(source).join("\n")
    const plain = /provideService\(\s*Dag\.Service\s*,\s*dag\s*\)/g

    expect(loop.match(plain) ?? []).toEqual([])
    // ... and it does provide the port in each of those places: the spawn, the continuation and its watcher, the
    // adoption's reconciliation, and the watcher a replan re-arms.
    expect(loop.match(/provideService\(\s*Dag\.Service\s*,\s*(?:entry\.port|port)\s*\)/g)).toHaveLength(5)
  })

  // The re-read before a child session exists is a side-effect check, not a write: a spawn that loses its slot
  // to the fence's refusal never reaches it in a loop-level case, so its wiring is pinned here and its behavior in
  // dag-spawn-pause-fence.test.ts and the `verify` cases of dag-runner-lease.test.ts.
  test("loop.ts hands every spawn the lease re-read of its entry", () => {
    expect(source("loop.ts")).toContain("leaseHeld: runnerLease.verify(dagID, entry)")
  })
})

describe("the port over a partial service (the unit harnesses that mock Dag)", () => {
  it.live(
    "a method the mock does not implement stays unimplemented through the port, a defect and not a TypeError",
    () =>
      withHarness(() =>
        Effect.gen(function* () {
          const store = yield* DagStore.Service
          const context = yield* Layer.build(Layer.mock(Dag.Service, { store, nodeCompleted: () => Effect.void }))
          const { port, refused } = portOf(Context.get(context, Dag.Service), { runnerID: R1, epoch: 1 })

          yield* port.nodeCompleted("dag", "n", "out")
          const exit = yield* Effect.exit(port.nodeFailed("dag", "n", "boom", "exec_failed"))

          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
          expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("Unimplemented method")
          expect(refused).toEqual([])
        }),
      ),
  )
})
