// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1029, PR0: what goes wrong when two engine processes share one
 * database, reproduced on the dual-runner fixture (`fixture/dual-runner.ts`).
 *
 * A "known race" asserts the behavior the fix PR must deliver, so today its
 * body fails. It is registered with `test.failing`: the suite stays green while
 * the race exists, and goes red ("expected to fail, but passed") the moment a
 * fix lands. That is the signal to turn it into a plain test, as PR2 did for
 * race 1. To see the real assertion failure instead, run with
 * `DAG_RACES_STRICT=1`:
 *
 *   DAG_RACES_STRICT=1 bun test test/dag/dag-runner-races.test.ts
 *
 * The plain tests in "dual-runner fixture" pin the arrangement each known race
 * starts from, so a known race can only fail where it says it does.
 *
 * Every `Dag` command runs in one IMMEDIATE transaction since PR3a, so a hold
 * parks a command at its entry, ahead of its guard and its transaction (see the
 * fixture's module comment).
 */

import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Schema, Scope, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as TestConsole from "effect/testing/TestConsole"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EngineProcess, runnerAlive } from "@/session/engine-process"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import {
  PARENT_SESSION_ID,
  PROJECT_ID,
  deadRunnerIdentity,
  driveOnR1,
  makeDualRunner,
  makeRunnerIdentity,
  node,
  pollOnTestClock,
  withEngineRunner,
  type DualRunner,
} from "./fixture/dual-runner"

const it = testEffect(Layer.empty)

const strict = process.env["DAG_RACES_STRICT"] === "1"

/** A race whose body asserts the fixed behavior: expected to fail today (`test.failing`), a plain test in strict mode. */
const knownRace = <A, E>(name: string, body: Effect.Effect<A, E, Scope.Scope>, clock: "live" | "test" = "live") =>
  (strict ? test : test.failing)(
    name,
    () =>
      Effect.runPromise(
        body.pipe(
          Effect.scoped,
          Effect.provide(clock === "test" ? Layer.mergeAll(TestConsole.layer, TestClock.layer()) : TestConsole.layer),
        ),
      ),
    30_000,
  )

const stateOf = (dual: DualRunner, dagID: string, nodeID = "n1") =>
  Effect.gen(function* () {
    const row = yield* dual.r2.store.getNode(dagID, nodeID)
    const workflow = yield* dual.r2.store.getWorkflow(dagID)
    return { node: row, workflow: workflow?.status, log: (yield* dual.log(dagID)).map((entry) => entry.type) }
  })

/**
 * R1 stalls on its way to NodeStarted, parked at the command's entry (ahead of
 * its guard and its transaction, see the fixture): `n1` is durably queued and
 * R1's child session exists, nothing else is out. R2 then starts, claims the
 * lease, adopts the queued node and starts its own attempt of it. R2 may only
 * claim once R1's lease ran out, so the stall outlasts the TTL: it is modeled
 * on the lease row (`expireLease`), not by waiting out the TTL on the clock.
 */
const stalledBeforeStart = (dual: DualRunner) =>
  Effect.gen(function* () {
    yield* dual.r1.init
    const stalled = yield* dual.r1.hold((publish) => publish.type === "dag.node.started")
    const dagID = yield* dual.r1.dag.create({
      projectID: PROJECT_ID,
      sessionID: PARENT_SESSION_ID,
      title: "stale start",
      config: { name: "stale-start", nodes: [node("n1")] },
    })
    yield* awaitWithTimeout(stalled.reached, "R1 never reached its NodeStarted publish", "5 seconds")
    expect((yield* dual.r2.store.getNode(dagID, "n1"))?.status).toBe("queued")
    yield* dual.expireLease(dagID)
    yield* dual.r2.init
    const attempt = yield* dual.r2.nextPrompt("R2 did not start its own attempt of n1")
    return { dagID, stalled, attempt }
  })

describe("dual-runner fixture", () => {
  it.live("R1 drives a running node that R2 sees only through the database", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      // A sentinel on R2's own bus orders the check: nothing of R1 may precede it.
      const Sentinel = EventV2.define({ type: "test.dual.sentinel", schema: { text: Schema.String } })
      const onR2 = new Array<string>()
      const sentinelSeen = yield* Deferred.make<void>()
      yield* dual.r2.events.all().pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => onR2.push(event.type)).pipe(
            Effect.andThen(event.type === Sentinel.type ? Deferred.succeed(sentinelSeen, undefined) : Effect.void),
          ),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )

      const { dagID, gate } = yield* driveOnR1(dual)
      yield* dual.r2.events.publish(Sentinel, { text: "after R1" })
      yield* Deferred.await(sentinelSeen)

      const { node: row, workflow } = yield* stateOf(dual, dagID)
      expect(row?.status).toBe("running")
      expect(row?.childSessionId).toBe(gate.sessionID)
      expect(workflow).toBe("running")
      expect(dual.r1.identity.id).not.toBe(dual.r2.identity.id)
      expect(onR2).toEqual([Sentinel.type])

      // Two connections to one WAL file: what separate processes would have.
      expect(dual.r1.database).not.toBe(dual.r2.database)
      const mode = yield* dual.r2.database.db.get<{ journal_mode: string }>(sql`PRAGMA journal_mode`)
      expect(mode?.journal_mode).toBe("wal")
    }),
  )

  it.live("control: R1 settles the node and the workflow completes", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID, gate } = yield* driveOnR1(dual)

      yield* Deferred.succeed(gate.release, "r1 output")
      yield* pollWithTimeout(
        dual.r2.store
          .getWorkflow(dagID)
          .pipe(Effect.map((current) => (current?.status === "completed" ? true : undefined))),
        "R1 did not complete the workflow",
      )

      const { node: row, log } = yield* stateOf(dual, dagID)
      expect(row?.status).toBe("completed")
      expect(row?.output).toBe("r1 output")
      expect(log.filter((type) => type === "dag.node.started")).toHaveLength(1)
    }),
  )

  it.live("a stalled runner holds no database lock: R2 starts and takes over its queued node", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID, stalled, attempt } = yield* stalledBeforeStart(dual)

      const { node: row, log } = yield* stateOf(dual, dagID)
      expect(row?.status).toBe("running")
      expect(row?.childSessionId).toBe(attempt.sessionID)
      expect(dual.r1.created).toEqual(["ses_r1_child_1"])
      expect(dual.r2.created).toEqual(["ses_r2_child_1"])
      expect(log.filter((type) => type === "dag.node.started")).toHaveLength(1)
      // R2 could start because R1's lease ran out: it took the lease over.
      expect(yield* dual.leaseRow(dagID)).toMatchObject({ runnerID: dual.r2.identity.id, epoch: 2 })
      yield* stalled.release
    }),
  )
})

describe("dual-runner fixture holds", () => {
  // Every Dag command publishes inside one IMMEDIATE transaction (DagTransact), and parking there would keep
  // SQLite's write lock: the hold is at the command entry instead, before the guard and before BEGIN.
  it.live("a hold parks a Dag command at its entry: the runner holds no write lock while it waits", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID } = yield* driveOnR1(dual)
      const completion = yield* dual.r1.hold((publish) => publish.type === "dag.node.completed")

      const settling = yield* dual.r1.dag.nodeCompleted(dagID, "n1", "x").pipe(Effect.forkScoped)
      yield* awaitWithTimeout(completion.reached, "R1's nodeCompleted never reached its hold", "5 seconds")

      // Parked ahead of the transaction: R2 writes at once instead of waiting out the busy timeout, and R1's node is untouched.
      yield* dual.r2.database.db.run(sql`UPDATE workflow SET title = 'r2' WHERE id = ${dagID}`)
      expect((yield* stateOf(dual, dagID)).node?.status).toBe("running")
      yield* completion.release
      yield* Fiber.join(settling)
      expect((yield* stateOf(dual, dagID)).node?.status).toBe("completed")
    }),
  )

  const Note = EventV2.define({ type: "test.dual.note", schema: { text: Schema.String } })

  it.live("a hold on a publish inside an open transaction dies instead of keeping the write lock", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      yield* dual.r1.hold((publish) => publish.type === Note.type)

      // A publish that is not a Dag command, made inside a transaction of its own.
      const exit = yield* Effect.exit(
        dual.r1.run(
          Effect.gen(function* () {
            const { db } = yield* Database.Service
            const bridge = yield* EventV2Bridge.Service
            yield* db.transaction(() => bridge.publish(Note, { text: "parked" }))
          }),
        ),
      )

      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("inside an open SQLite transaction")
      // R1 holds no lock: R2 writes at once instead of waiting out the busy timeout.
      yield* dual.r2.database.db.run(sql`UPDATE workflow SET title = 'r2' WHERE id = 'none'`)
    }),
  )
})

describe("runner identity", () => {
  // The fixture's identities are `pid:nonce` values `runnerAlive` judges, so a test can
  // model another live process, an earlier life of this one, or a dead one.
  it.live("models another live process, an earlier life of this one and a dead one", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      expect(dual.r1.identity).toBe(EngineProcess.runner)
      expect(runnerAlive(dual.r1.identity.id)).toBe(true)
      expect(runnerAlive(dual.r2.identity.id)).toBe(true)
      expect(runnerAlive(makeRunnerIdentity().id)).toBe(false)
      const dead = deadRunnerIdentity()
      expect(runnerAlive(dead.id)).toBe(false)

      // Code that reads the process singleton sees the injected identity, then the real one again.
      yield* withEngineRunner(
        dual.r2.identity,
        Effect.sync(() => expect(EngineProcess.runner.id).toBe(dual.r2.identity.id)),
      )
      expect(EngineProcess.runner).toBe(dual.r1.identity)
    }),
  )
})

describe("races between two runners (#1029)", () => {
  // Race 1. A second runner that starts on the same directory recovers every
  // non-terminal workflow of it. `reconcileWorkflow` used to run before
  // `tryClaimAdoption` (which only compares the status), and it settles any
  // `running` node whose child is not finished as "execution ownership lost":
  // it cancels the child, fails the node and pauses the workflow. That the
  // node is in fact being driven by another live process was never asked. It
  // was deterministic, not a timing window.
  //
  // Fixed by PR2: a runner claims the workflow's lease before it reconciles,
  // and R1's lease is live, so R2's startup defers. R2 leaves R1's workflow
  // alone and builds no runtime entry for it; the loop's entry table is
  // private, so that is asserted by its effects: nothing failed, paused,
  // cancelled or started, and the lease still names R1.
  it.live("race 1: a starting R2 must not fail and pause the node R1 is driving", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID, gate } = yield* driveOnR1(dual)

      yield* dual.r2.init

      const { node: row, workflow, log } = yield* stateOf(dual, dagID)
      expect(log).not.toContain("dag.node.failed")
      expect(log).not.toContain("dag.workflow.paused")
      expect(row?.status).toBe("running")
      expect(row?.childSessionId).toBe(gate.sessionID)
      expect(workflow).toBe("running")
      // R2 behaves as a non-owner: it cancelled none of R1's work and started none of its own.
      expect(dual.r2.cancelled).toEqual([])
      expect(dual.r2.created).toEqual([])
      expect(yield* dual.leaseRow(dagID)).toMatchObject({ runnerID: dual.r1.identity.id, epoch: 1 })

      // R1 carries on and finishes the workflow.
      yield* Deferred.succeed(gate.release, "r1 output")
      yield* pollWithTimeout(
        dual.r2.store
          .getWorkflow(dagID)
          .pipe(Effect.map((current) => (current?.status === "completed" ? true : undefined))),
        "R1 could not complete the workflow after R2 started",
      )
    }),
  )

  // Race 2. R1 stalls on its way to NodeStarted; by the time it wakes up R2 has
  // taken the node over (R1's lease ran out while it was stalled, `expireLease`,
  // and R2 claimed it: PR2) and started its own attempt. Before PR3a the stall
  // sat between the guard read and the publish, two separate transactions: the
  // projector's conditional UPDATE only compares the status (`running`
  // matches), the in-process workflow lock is not shared, so the zombie's
  // NodeStarted landed, the node pointed at R1's child, R2's completion was
  // later rejected as a stale attempt and the zombie's attempt settled the
  // node.
  //
  // Fixed by PR3a for the case this arrangement models. The guard and the
  // publish share one IMMEDIATE transaction now, so there is no window between
  // them to stall in: a writer that stalls before the command meets a fresh
  // guard when it wakes (`running` -> `running` is not a transition) and is
  // refused, and a writer inside the transaction holds the write lock, so R2
  // could not have taken the node over meanwhile (dag-transact.test.ts holds a
  // second connection out at every publish). R1 aborts its stale attempt
  // instead of running it; PR2's eviction of R1 comes at its first renewal
  // after it wakes, a tick after the write that is already on its way, so it
  // is the guard that refuses the write here. What the guard cannot tell, a
  // write with no attempt identity that finds the node in a status it may
  // legally leave (R2 only queued it), is the fence token's: PR3b, which also
  // asserts that R1 drops its runtime entry.
  it.live("race 2: a zombie R1's late NodeStarted must not overwrite the attempt R2 started", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID, stalled, attempt } = yield* stalledBeforeStart(dual)

      // The zombie wakes up and its parked write runs against what R2 did meanwhile.
      yield* stalled.release
      const next = yield* pollWithTimeout(
        Effect.gen(function* () {
          if (dual.r1.cancelled.length > 0) return "aborted" as const
          return Option.isSome(yield* Queue.poll(dual.r1.prompts)) ? ("ran" as const) : undefined
        }),
        "R1 neither ran nor aborted its stale attempt",
      )

      const { node: row, log } = yield* stateOf(dual, dagID)
      expect(row?.childSessionId).toBe(attempt.sessionID)
      expect(row?.status).toBe("running")
      expect(log.filter((type) => type === "dag.node.started")).toHaveLength(1)
      expect(next).toBe("aborted")
      expect(dual.r1.cancelled).toContain("ses_r1_child_1")

      // R2's attempt is the one that settles the node.
      yield* Deferred.succeed(attempt.release, "r2 output")
      yield* pollWithTimeout(
        dual.r2.store
          .getWorkflow(dagID)
          .pipe(Effect.map((current) => (current?.status === "completed" ? true : undefined))),
        "R2's attempt could not complete the workflow",
      )
      expect((yield* stateOf(dual, dagID)).node?.output).toBe("r2 output")
    }),
  )

  // Race 2, completion half: this one is already protected. A completion
  // carries the attempt identity (child session and replan count), and
  // `guardNode` rejects it when R2 restarted the node, so the new attempt
  // survives. With the mailbox wired, as in production, the completion (and
  // the failure of a running attempt) is also re-checked against that identity
  // inside the same IMMEDIATE transaction that publishes it
  // (`DagMessages.guard`), so there is no guard-to-publish window to land in.
  // NodeStarted had no such second check before PR3a, which is why the start
  // half was the known race. Pinned here so restructuring the guards (PR3b)
  // cannot lose it.
  it.live("race 2: a completion of a superseded attempt is rejected and the new attempt survives", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID, gate } = yield* driveOnR1(dual)

      // R2 took the node over and restarted it: a new attempt with its own child.
      yield* dual.r2.dag.nodeRestarted(dagID, "n1", gate.sessionID)
      yield* dual.r2.dag.nodeStarted(dagID, "n1", "ses_r2_child_1")

      // R1's child finishes and R1 settles the attempt it no longer owns.
      yield* Deferred.succeed(gate.release, "stale output")
      yield* pollWithTimeout(
        Effect.sync(() => (dual.r1.childRuns.settled.length > 0 ? true : undefined)),
        "R1 did not settle its superseded attempt",
      )

      const { node: row, log } = yield* stateOf(dual, dagID)
      expect(row?.status).toBe("running")
      expect(row?.childSessionId).toBe("ses_r2_child_1")
      expect(row?.output).toBeNull()
      expect(log).not.toContain("dag.node.completed")
    }),
  )

  // Race 3. R1 stalls (a synchronous block, a suspended machine) and the wall
  // clock jumps past the lease TTL (90 s) while it is stuck. Everything on the
  // machine sees the jump, R2's first reconcile after it included: the lease
  // looks expired only because nobody got to renew it. Taking over on that
  // evidence is the false takeover the design rules out ("no preemption in
  // the first round after a jump; the owner renews").
  //
  // This is the minimal form: R2 must not preempt a live R1 after the jump,
  // and R1's write must still be accepted when it wakes. R1's stall includes
  // its renewals (`freeze()` parks the lease operations too), so the jump
  // leaves its lease expired and, since PR2, R2's claim takes it over: the
  // false takeover the design rules out. It still fails, now for that reason:
  // PR2 has the lease but not the clock rule.
  // Full assertions land with the reconcile tick (PR4a): R1's renewal succeeds
  // with an unchanged epoch; and when the stall really outlasts the TTL and R2
  // takes over, R1's first write is refused and produces no further side
  // effect (the zombie half is race 2's shape).
  // Fixed by PR4a (the clock rule: no preemption in the round after a jump).
  knownRace(
    "race 3: a wall-clock jump during R1's stall must not make R2 take over a live R1",
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID, gate } = yield* driveOnR1(dual)

      const stall = yield* dual.r1.freeze()
      yield* TestClock.adjust("2 minutes")

      yield* dual.r2.init

      const { node: row, workflow, log } = yield* stateOf(dual, dagID)
      expect(log).not.toContain("dag.node.failed")
      expect(row?.status).toBe("running")
      expect(workflow).toBe("running")
      expect(dual.r2.cancelled).toEqual([])

      // R1 wakes up; nobody took its workflow, so its settlement is accepted.
      yield* stall.release
      yield* Deferred.succeed(gate.release, "r1 output")
      yield* pollOnTestClock(
        dual.r2.store
          .getWorkflow(dagID)
          .pipe(Effect.map((current) => (current?.status === "completed" ? true : undefined))),
        "R1's settlement was not accepted after the clock jump",
      )
    }),
    "test",
  )
})
