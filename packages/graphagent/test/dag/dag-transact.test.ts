// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1029 / ADR-0008 decision 3, PR3a: every `Dag` command that changes
 * workflow state runs through `DagTransact.transact`, so its guard and its
 * publish share one IMMEDIATE transaction.
 *
 * Before PR3a a command read its guard (the attempt identity, the transition
 * table) in one statement and published in another, except where `DagMessages`
 * wrapped both in one transaction. `nodeQueued`, `nodeStarted`,
 * `nodeTimeoutEscalated` and `nodeExtendTimeout` (and `pause`, `resume`, `step`
 * and the budget commands) left a window in which another process could change
 * the workflow, and the late write then landed on a stale guard.
 *
 * The harness is the real stack (SQLite file, event bus, projectors, DagStore,
 * DagMessages, DagLease, DagTransact) with three spies in front of the services
 * the commands use: the store (a read), the bridge (a publish) and the
 * transaction (its begin and end). One command is run at a time and the order
 * the spies saw is the evidence. A second SQLite connection to the same file
 * stands for the other process.
 */

import { describe, expect } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Database as NativeDatabase } from "bun:sqlite"
import { asc, eq, sql } from "drizzle-orm"
import { Effect, Layer, Option, Queue, Stream } from "effect"
import type { Scope } from "effect"
import { DagLease } from "@graphagent/core/dag/lease"
import { DagMessages } from "@graphagent/core/dag/messages"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { DagTransact } from "@graphagent/core/dag/transact"
import { Database } from "@graphagent/core/database/database"
import { layer as sqliteLayer } from "@graphagent/core/database/sqlite.bun"
import { EventV2 } from "@graphagent/core/event"
import { EventSequenceTable, EventTable } from "@graphagent/core/event/sql"
import { DagEvent } from "@graphagent/schema/dag-event"
import { Dag, type NodeConfig } from "@/dag/dag"
import { EventV2Bridge } from "@/event-v2-bridge"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const PROJECT = "p"
const PARENT = "ses_parent"

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

/** What the spies saw, in order: `begin`/`end` (the transaction), `read:<store method>`, `publish:<event type>`. */
interface Spy {
  readonly trace: string[]
  recording: boolean
  /** Runs when a publish is about to happen, before the event bus is called. */
  onPublish?: (type: string) => void
}

/** Every `get*` function of `service` records its call, when it returns an effect. */
function readSpy<S extends object>(service: S, spy: Spy): S {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (typeof value !== "function" || typeof property !== "string" || !property.startsWith("get")) return value
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args)
        if (!Effect.isEffect(result)) return result
        return Effect.suspend(() => {
          if (spy.recording) spy.trace.push(`read:${property}`)
          return result
        })
      }
    },
  })
}

const spyLayers = (spy: Spy) => {
  const publishing = (types: ReadonlyArray<string>) =>
    Effect.sync(() => {
      if (!spy.recording) return
      for (const type of types) {
        spy.trace.push(`publish:${type}`)
        spy.onPublish?.(type)
      }
    })
  return {
    store: Layer.effect(
      DagStore.Service,
      Effect.gen(function* () {
        return readSpy(yield* DagStore.Service, spy)
      }),
    ),
    bridge: Layer.effect(
      EventV2Bridge.Service,
      Effect.gen(function* () {
        const real = yield* EventV2Bridge.Service
        return EventV2Bridge.Service.of({
          ...real,
          publish: (definition, data, options) =>
            publishing([definition.type]).pipe(Effect.andThen(real.publish(definition, data, options))),
          publishMany: (entries, options) =>
            publishing(entries.map((entry) => entry.definition.type)).pipe(
              Effect.andThen(real.publishMany(entries, options)),
            ),
        })
      }),
    ),
    transact: Layer.effect(
      DagTransact.Service,
      Effect.gen(function* () {
        const real = yield* DagTransact.Service
        return DagTransact.Service.of({
          transact: (dagID, token, body) =>
            real.transact(
              dagID,
              token,
              Effect.suspend(() => {
                if (spy.recording) spy.trace.push("begin")
                return body
              }).pipe(Effect.ensuring(Effect.sync(() => void (spy.recording && spy.trace.push("end"))))),
            ),
        })
      }),
    ),
  }
}

interface Harness {
  readonly file: string
  /** The parent session's directory (a realpath, as the workflow stores it). */
  readonly directory: string
  readonly spy: Spy
  readonly events: EventV2.Interface
}

interface HarnessOptions {
  /** Wire `DagMessages` as production does. Default true. */
  readonly mailbox?: boolean
}

type Services = Dag.Service | Database.Service | DagStore.Service | Scope.Scope

/** A fresh SQLite file, the real services with spies in front of them, and one parent session in a plain directory. */
const withHarness = <A, E>(options: HarnessOptions, body: (harness: Harness) => Effect.Effect<A, E, Services>) =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(async () => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dag-transact-")))),
      (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
    )
    const file = path.join(directory, "dag.sqlite")
    const spy: Spy = { trace: [], recording: false }
    const spies = spyLayers(spy)

    const sqlite = sqliteLayer({ filename: file })
    const database = Database.layer.pipe(Layer.provide(sqlite))
    const events = EventV2.layer.pipe(Layer.provide(database))
    const bridge = spies.bridge.pipe(Layer.provide(EventV2Bridge.layer.pipe(Layer.provide(events))))
    const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
    const store = spies.store.pipe(Layer.provide(DagStore.layer.pipe(Layer.provide(database))))
    const messages = options.mailbox === false ? Layer.empty : DagMessages.layer.pipe(Layer.provide(database))
    const lease = DagLease.layer.pipe(Layer.provide(database))
    const transact = spies.transact.pipe(
      Layer.provide(DagTransact.layer.pipe(Layer.provide(Layer.merge(database, lease)))),
    )
    const dag = Dag.layer.pipe(Layer.provide(Layer.mergeAll(bridge, store, messages, transact)))
    const services = Layer.mergeAll(sqlite, database, events, projector, store, messages, dag)

    return yield* Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(
        sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES (${PROJECT},${directory},'[]',1,1)`,
      )
      yield* db.run(
        sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES (${PARENT},${PROJECT},NULL,${PARENT},${directory},'Parent','test',1,1)`,
      )
      return yield* body({ file, directory, spy, events: yield* EventV2.Service })
    }).pipe(Effect.provide(services), Effect.orDie)
  })

/** Run `effect` with the spies recording, from an empty trace. */
const recorded = <A, E, R>(spy: Spy, effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    spy.trace.length = 0
    spy.recording = true
    return effect
  }).pipe(Effect.ensuring(Effect.sync(() => void (spy.recording = false))))

const createWorkflow = (nodes: NodeConfig[] = [node("a"), node("b", ["a"])]) =>
  Effect.gen(function* () {
    const dag = yield* Dag.Service
    return yield* dag.create({ projectID: PROJECT, sessionID: PARENT, title: "t", config: { name: "t", nodes } })
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

// -- every command, one transaction -----------------------------------------

interface Scenario {
  readonly name: string
  /** The workflow when the command runs: nodes `a` and `b` (depends on `a`), neither required. */
  readonly prepare?: (
    dag: Dag.Interface,
    dagID: string,
    harness: Harness,
  ) => Effect.Effect<unknown, unknown, Database.Service>
  readonly run: (dag: Dag.Interface, dagID: string) => Effect.Effect<unknown, unknown>
  /** An event the command publishes, so that an empty trace cannot pass for a wired command. */
  readonly publishes: string
}

const rev = (dag: Dag.Interface, dagID: string) =>
  Effect.map(dag.store.getWorkflow(dagID), (workflow) => workflow!.graphRev)

const scenarios: ReadonlyArray<Scenario> = [
  { name: "pause", run: (dag, id) => dag.pause(id), publishes: "dag.workflow.paused" },
  {
    name: "resume",
    prepare: (dag, id) => dag.pause(id),
    run: (dag, id) => dag.resume(id),
    publishes: "dag.workflow.resumed",
  },
  {
    name: "resumeIfPausedFor",
    prepare: (dag, id) => dag.pause(id, "budget_exhausted"),
    run: (dag, id) => dag.resumeIfPausedFor(id, "budget_exhausted"),
    publishes: "dag.workflow.resumed",
  },
  { name: "step", run: (dag, id) => dag.step(id), publishes: "dag.workflow.stepped" },
  { name: "pauseForCheckpoint", run: (dag, id) => dag.pauseForCheckpoint(id, 1), publishes: "dag.workflow.paused" },
  {
    name: "pauseForBudget",
    prepare: (dag, id, harness) => start(dag, id, "a", harness),
    run: (dag, id) => dag.pauseForBudget(id),
    publishes: "dag.node.failed",
  },
  { name: "pauseForArchive", run: (dag, id) => dag.pauseForArchive(id), publishes: "dag.workflow.paused" },
  {
    name: "pauseForArchive (a workflow that is already paused)",
    prepare: (dag, id) => dag.pause(id),
    run: (dag, id) => dag.pauseForArchive(id),
    publishes: "dag.workflow.paused",
  },
  {
    name: "requeueNodes",
    prepare: (dag, id, harness) => Effect.andThen(start(dag, id, "a", harness), dag.pauseForBudget(id)),
    run: (dag, id) => dag.requeueNodes(id, ["a"], "again"),
    publishes: "dag.node.requeued",
  },
  { name: "cancel", run: (dag, id) => dag.cancel(id), publishes: "dag.workflow.cancelled" },
  {
    name: "complete",
    run: (dag, id) => dag.complete(id, { skipReviewGate: true }),
    publishes: "dag.workflow.completed",
  },
  { name: "fail", run: (dag, id) => dag.fail(id, "boom"), publishes: "dag.workflow.failed" },
  {
    name: "failUnrecoverable",
    prepare: (_dag, id) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(sql`UPDATE workflow SET execution_directory = '/dag-transact/missing' WHERE id = ${id}`)
      }),
    run: (dag, id) => dag.failUnrecoverable(id, "workspace gone"),
    publishes: "dag.workflow.failed",
  },
  {
    name: "settleCompletion",
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
    name: "replan",
    run: (dag, id) => dag.replan(id, { nodes: [node("a"), node("c", ["a"])] }),
    publishes: "dag.workflow.replanned",
  },
  { name: "extend", run: (dag, id) => dag.extend(id, [node("c", ["a"])]), publishes: "dag.workflow.replanned" },
  {
    name: "recover",
    prepare: (dag, id, harness) =>
      Effect.gen(function* () {
        for (const nodeID of ["a", "b"]) {
          yield* start(dag, id, nodeID, harness)
          yield* dag.nodeFailed(id, nodeID, "transport failed", "exec_failed")
        }
        yield* dag.pause(id)
      }),
    run: (dag, id) =>
      Effect.flatMap(rev(dag, id), (expectedGraphRev) => dag.recover(id, { nodeIDs: ["a", "b"], expectedGraphRev })),
    publishes: "dag.workflow.replanned",
  },
  {
    name: "retarget",
    run: (dag, id) => dag.retarget(id, { fingerprint: "none" }),
    publishes: "dag.workflow.replanned",
  },
  { name: "nodeQueued", run: (dag, id) => dag.nodeQueued(id, "a"), publishes: "dag.node.queued" },
  {
    name: "nodeStarted",
    prepare: (dag, id) => dag.nodeQueued(id, "a"),
    run: (dag, id) => dag.nodeStarted(id, "a", "ses_a"),
    publishes: "dag.node.started",
  },
  {
    name: "nodeCompleted",
    prepare: (dag, id, harness) => start(dag, id, "a", harness),
    run: (dag, id) => dag.nodeCompleted(id, "a", "done"),
    publishes: "dag.node.completed",
  },
  {
    name: "nodeFailed",
    prepare: (dag, id, harness) => start(dag, id, "a", harness),
    run: (dag, id) => dag.nodeFailed(id, "a", "boom", "exec_failed"),
    publishes: "dag.node.failed",
  },
  { name: "nodeSkipped", run: (dag, id) => dag.nodeSkipped(id, "b", "condition_false"), publishes: "dag.node.skipped" },
  {
    name: "nodeCancelled",
    run: (dag, id) => dag.nodeCancelled(id, "a", "no longer needed"),
    publishes: "dag.node.cancelled",
  },
  {
    name: "nodeRestarted",
    prepare: (dag, id, harness) => start(dag, id, "a", harness),
    run: (dag, id) => dag.nodeRestarted(id, "a", "ses_a"),
    publishes: "dag.node.restarted",
  },
  {
    name: "nodeTimeoutEscalated",
    prepare: (dag, id, harness) => start(dag, id, "a", harness),
    run: (dag, id) => dag.nodeTimeoutEscalated(id, "a", "ses_a", 1),
    publishes: "dag.node.timeout_escalated",
  },
  {
    name: "nodeExtendTimeout",
    prepare: (dag, id, harness) => start(dag, id, "a", harness),
    run: (dag, id) => dag.nodeExtendTimeout(id, "a", 60_000),
    publishes: "dag.node.deadline_extended",
  },
  {
    name: "extendTimeout",
    prepare: (dag, id, harness) =>
      Effect.gen(function* () {
        yield* start(dag, id, "a", harness)
        yield* dag.nodeTimeoutEscalated(id, "a", "ses_a", 1)
        const { db } = yield* Database.Service
        // The escalation has been delivered to the parent: its adjudication may follow.
        yield* db.run(sql`UPDATE workflow_node SET wake_reported = 1 WHERE workflow_id = ${id} AND id = 'a'`)
      }),
    run: (dag, id) => dag.extendTimeout(id, "a", 60_000),
    publishes: "dag.node.deadline_extended",
  },
]

/** Where the guard's last read and the publishes fall, relative to the one transaction. */
const shape = (trace: ReadonlyArray<string>) => {
  const indexes = (match: (entry: string) => boolean) => trace.flatMap((entry, index) => (match(entry) ? [index] : []))
  const begins = indexes((entry) => entry === "begin")
  const ends = indexes((entry) => entry === "end")
  const publishes = indexes((entry) => entry.startsWith("publish:"))
  const reads = indexes((entry) => entry.startsWith("read:")).filter((index) => index < (publishes[0] ?? -1))
  const inside = (index: number | undefined) =>
    index !== undefined && index > (begins[0] ?? Infinity) && index < (ends[0] ?? -Infinity)
  return {
    transactions: begins.length,
    ended: ends.length,
    publishesInside: publishes.length > 0 && publishes.every(inside),
    guardReadInside: inside(reads.at(-1)),
  }
}

describe("every state-changing Dag command runs in one transaction (ADR-0008 decision 3)", () => {
  for (const scenario of scenarios)
    it.live(
      `${scenario.name}: its guard read and its publishes share one IMMEDIATE transaction, closed to a second connection`,
      () =>
        withHarness({}, (harness) =>
          Effect.gen(function* () {
            const dag = yield* Dag.Service
            const dagID = yield* createWorkflow()
            if (scenario.prepare) yield* scenario.prepare(dag, dagID, harness)
            // The other process: it writes at every publish of the command, i.e. between its guard and its publish.
            const other = yield* Effect.acquireRelease(
              Effect.sync(() => {
                const connection = new NativeDatabase(harness.file)
                // A short busy timeout keeps the synchronous probe from hanging the only JS thread.
                connection.run("PRAGMA busy_timeout = 1")
                return connection
              }),
              (connection) => Effect.sync(() => connection.close()),
            )
            const concurrent = new Array<"landed" | "refused">()
            harness.spy.onPublish = () => {
              try {
                other.run("UPDATE workflow SET title = 'concurrent' WHERE id = ?", [dagID])
                concurrent.push("landed")
              } catch {
                concurrent.push("refused")
              }
            }

            yield* recorded(harness.spy, scenario.run(dag, dagID))

            const { trace } = harness.spy
            expect(trace).toContain(`publish:${scenario.publishes}`)
            // Nothing could write between the guard and the publish: the write reservation was taken before the first read.
            expect(concurrent.length).toBeGreaterThan(0)
            expect(concurrent.filter((write) => write === "landed")).toEqual([])
            // One transaction for the whole command: the guard's last read and every publish happen inside it.
            expect(shape(trace)).toEqual({ transactions: 1, ended: 1, publishesInside: true, guardReadInside: true })
          }),
        ),
    )
})

// -- one transaction means all or nothing -----------------------------------

describe("a command that fails part-way leaves nothing behind", () => {
  it.live("pauseForBudget: a node write that fails rolls the pause back", () =>
    withHarness({}, (harness) =>
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const dagID = yield* createWorkflow()
        yield* start(dag, dagID, "a", harness)
        // The pause is published first and the failure of the running node second.
        yield* harness.events.project(DagEvent.NodeFailed, () => Effect.die("projector failed"))
        const before = (yield* dag.store.getWorkflow(dagID))!

        const exit = yield* Effect.exit(dag.pauseForBudget(dagID))

        expect(exit._tag).toBe("Failure")
        const after = (yield* dag.store.getWorkflow(dagID))!
        expect(after.status).toBe("running")
        expect(after.seq).toBe(before.seq)
        expect((yield* dag.store.getNode(dagID, "a"))?.status).toBe("running")
        const { db } = yield* Database.Service
        const types = (yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, dagID))
          .all()).map((row) => row.type)
        expect(types.some((type) => type.startsWith("dag.workflow.paused"))).toBe(false)
      }),
    ),
  )

  it.live("cancel: a node write that fails rolls the workflow's cancellation back", () =>
    withHarness({}, (harness) =>
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const dagID = yield* createWorkflow()
        yield* harness.events.project(DagEvent.NodeSkipped, () => Effect.die("projector failed"))

        const exit = yield* Effect.exit(dag.cancel(dagID))

        expect(exit._tag).toBe("Failure")
        expect((yield* dag.store.getWorkflow(dagID))?.status).toBe("running")
      }),
    ),
  )

  it.live("a refused guard publishes nothing: a stale start on a running node leaves the log untouched", () =>
    withHarness({}, (harness) =>
      Effect.gen(function* () {
        const dag = yield* Dag.Service
        const dagID = yield* createWorkflow()
        yield* start(dag, dagID, "a", harness)
        const { db } = yield* Database.Service
        const count = db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, dagID))
          .all()
        const events = (yield* count).length

        // Another runner's attempt is already running: this start is a running -> running transition.
        const exit = yield* Effect.exit(dag.nodeStarted(dagID, "a", "ses_other"))

        expect(exit._tag).toBe("Failure")
        expect((yield* count).length).toBe(events)
        expect((yield* dag.store.getNode(dagID, "a"))?.childSessionId).toBe("ses_a")
      }),
    ),
  )
})

// -- the mailbox change stream -----------------------------------------------

describe("the mailbox change a command makes follows the outermost commit", () => {
  /** The changes `DagMessages.changed` delivers from now on, in the order the subscriber took them. */
  const watchChanges = Effect.gen(function* () {
    const messages = yield* Effect.serviceOption(DagMessages.Service)
    if (Option.isNone(messages)) return yield* Effect.die(new Error("this harness has no mailbox"))
    const arrived = yield* Queue.unbounded<DagMessages.Change>()
    yield* messages.value.changed.pipe(
      Stream.runForEach((change) => Queue.offer(arrived, change)),
      Effect.forkScoped({ startImmediately: true }),
    )
    return arrived
  })

  /**
   * Take what the subscriber took, up to and including the first change of `nodeID`. The stream is FIFO, so that is
   * everything delivered before it: a settlement of that node, committed after the one under test, is the sentinel
   * that proves an absence without waiting for it.
   */
  const takeThrough = (arrived: Queue.Queue<DagMessages.Change>, nodeID: string) =>
    awaitWithTimeout(
      Effect.gen(function* () {
        const taken = new Array<{ nodeID: string | undefined; kind: string }>()
        while (true) {
          const change = yield* Queue.take(arrived)
          taken.push({ nodeID: change.nodeID, kind: change.kind })
          if (change.nodeID === nodeID) return taken
        }
      }),
      `the mailbox change of node ${nodeID} never arrived`,
    )

  /** Two independent nodes, both running: `a` is the settlement under test, `b` the sentinel behind it. */
  const twoRunning = (harness: Harness) =>
    Effect.gen(function* () {
      const dag = yield* Dag.Service
      const dagID = yield* createWorkflow([node("a"), node("b")])
      yield* start(dag, dagID, "a", harness)
      yield* start(dag, dagID, "b", harness)
      return { dag, dagID }
    })

  it.live("a settlement's mailbox close is delivered once, after the transaction that made it commits", () =>
    withHarness({}, (harness) =>
      Effect.gen(function* () {
        const { dag, dagID } = yield* twoRunning(harness)
        const arrived = yield* watchChanges

        yield* dag.nodeCompleted(dagID, "a", "done")
        yield* dag.nodeCompleted(dagID, "b", "done")

        // The guard closes the node's mailbox inside the settlement transaction (a savepoint of the command's): one
        // change for `a`, then the sentinel's.
        expect(yield* takeThrough(arrived, "b")).toEqual([
          { nodeID: "a", kind: "closed" },
          { nodeID: "b", kind: "closed" },
        ])
      }),
    ),
  )

  it.live("a settlement that rolls back closes nothing and delivers no change", () =>
    withHarness({}, (harness) =>
      Effect.gen(function* () {
        const { dag, dagID } = yield* twoRunning(harness)
        const arrived = yield* watchChanges
        yield* harness.events.project(DagEvent.NodeCompleted, () => Effect.die("projector failed"))

        const exit = yield* Effect.exit(dag.nodeCompleted(dagID, "a", "done"))
        // The projector fails every NodeCompleted, so the sentinel is a failure of the other node.
        yield* dag.nodeFailed(dagID, "b", "boom", "exec_failed")

        expect(exit._tag).toBe("Failure")
        expect(yield* takeThrough(arrived, "b")).toEqual([{ nodeID: "b", kind: "closed" }])
        expect((yield* dag.store.getNode(dagID, "a"))?.status).toBe("running")
      }),
    ),
  )

  it.live("a settlement inside an enclosing transaction that rolls back later delivers no change", () =>
    withHarness({}, (harness) =>
      Effect.gen(function* () {
        const { dag, dagID } = yield* twoRunning(harness)
        const arrived = yield* watchChanges
        const { db } = yield* Database.Service

        // The command's own transaction is a savepoint here: its guard has closed the
        // mailbox and released the savepoint by the time the enclosing level fails.
        const exit = yield* db
          .transaction(() => dag.nodeCompleted(dagID, "a", "done").pipe(Effect.andThen(Effect.fail("rolled back"))), {
            behavior: "immediate",
          })
          .pipe(Effect.exit)
        yield* dag.nodeCompleted(dagID, "b", "done")

        expect(exit._tag).toBe("Failure")
        expect(yield* takeThrough(arrived, "b")).toEqual([{ nodeID: "b", kind: "closed" }])
        expect((yield* dag.store.getNode(dagID, "a"))?.status).toBe("running")

        // The same settlement in a transaction that commits delivers its change once.
        yield* dag.nodeCompleted(dagID, "a", "done")
        expect(yield* takeThrough(arrived, "a")).toEqual([{ nodeID: "a", kind: "closed" }])
      }),
    ),
  )
})

// -- replay ------------------------------------------------------------------

describe("events published under transact replay to the same read model (#523, replay idempotency)", () => {
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

  it.live(
    "a completed workflow, replayed into an empty read model, projects identically and replays idempotently",
    () =>
      withHarness({ mailbox: false }, (harness) =>
        Effect.gen(function* () {
          const dag = yield* Dag.Service
          const dagID = yield* createWorkflow()
          for (const nodeID of ["a", "b"]) {
            yield* start(dag, dagID, nodeID, harness)
            yield* dag.nodeCompleted(dagID, nodeID, `${nodeID} output`)
          }
          yield* dag.pause(dagID)
          yield* dag.resume(dagID)
          yield* dag.settleCompletion(dagID)
          const original = yield* snapshot(dagID)
          expect(original.workflow?.status).toBe("completed")

          const { db } = yield* Database.Service
          const rows = yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, dagID))
            .orderBy(asc(EventTable.seq))
            .all()
          const log = rows.map((row) => ({
            id: row.id,
            type: row.type,
            seq: row.seq,
            aggregateID: row.aggregate_id,
            data: row.data,
          }))
          // Wipe the aggregate and its projections, then rebuild them from the log alone.
          yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, dagID))
          yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, dagID))
          yield* db.run(sql`DELETE FROM workflow_node WHERE workflow_id = ${dagID}`)
          yield* db.run(sql`DELETE FROM workflow WHERE id = ${dagID}`)
          yield* harness.events.replayAll(log)

          expect(yield* snapshot(dagID)).toEqual(original)
          // A second replay of the same log changes nothing.
          yield* harness.events.replayAll(log)
          expect(yield* snapshot(dagID)).toEqual(original)
        }),
      ),
  )
})
