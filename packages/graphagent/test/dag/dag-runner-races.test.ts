// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1029: what goes wrong when two engine processes share one database,
 * reproduced on the dual-runner fixture (`fixture/dual-runner.ts`) and pinned
 * as the fix PRs landed (PR0 registered the races, PR2, PR3a/3b and PR4a fixed
 * them). The plain tests in "dual-runner fixture" pin the arrangement each race
 * starts from.
 *
 * Every `Dag` command runs in one IMMEDIATE transaction since PR3a, so a hold
 * parks a command at its entry, ahead of its guard and its transaction (see the
 * fixture's module comment). Since PR3b every write a runner makes about its own
 * workflow also carries its lease token, which the last group of cases pins: what
 * the guard cannot tell (a zombie's write that is a legal transition, or the very
 * attempt the new holder took over), the token does. Since PR4a the reconcile tick
 * of each runner (ADR-0008 decision 6) judges a lease that has run out only
 * after it has ruled out a clock jump (race 3), which the runner's clock watch
 * sees in the first reading of its clock after the jump, a tick's or an
 * observation's.
 */

import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Schema, Scope, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Database } from "@graphagent/core/database/database"
import { DagLease } from "@graphagent/core/dag/lease"
import { EventV2 } from "@graphagent/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EngineProcess, runnerAlive } from "@/session/engine-process"
import { SessionID } from "@/session/schema"
import { isRecord } from "@/util/record"
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
  type PublishView,
  type Runner,
} from "./fixture/dual-runner"

const it = testEffect(Layer.empty)

/** The arguments of the `Dag` command a hold parked: `data.args` of the fixture's command-entry hold. */
const commandArgs = (publish: PublishView): ReadonlyArray<unknown> =>
  isRecord(publish.data) && Array.isArray(publish.data.args) ? publish.data.args : []

const stateOf = (dual: DualRunner, dagID: string, nodeID = "n1") =>
  Effect.gen(function* () {
    const row = yield* dual.r2.store.getNode(dagID, nodeID)
    const workflow = yield* dual.r2.store.getWorkflow(dagID)
    return { node: row, workflow: workflow?.status, log: (yield* dual.log(dagID)).map((entry) => entry.type) }
  })

const rowOf = (dual: DualRunner, dagID: string) =>
  dual
    .leaseRow(dagID)
    .pipe(
      Effect.flatMap((row) =>
        row === undefined ? Effect.die(new Error(`no lease row for ${dagID}`)) : Effect.succeed(row),
      ),
    )

/** How many times a runner's reconcile rounds (and its adoptions) have read the lease of `dagID`. */
const heldBy = (runner: Runner, dagID: string) =>
  runner.leaseCalls.filter((call) => call.operation === "held" && call.dagID === dagID).length

/**
 * Move the TestClock on, a period at a time, until `runner`'s tick has read the
 * lease of `dagID` once more: its next reconcile round ran (the round reads the
 * lease row first). A tick starts a round only when the previous one is over, so
 * the rounds do not overlap.
 */
const nextRound = (runner: Runner, dagID: string) =>
  Effect.gen(function* () {
    const before = heldBy(runner, dagID)
    for (let period = 0; period < 3; period++) {
      yield* TestClock.adjust(`${DagLease.RENEWAL_PERIOD_MS} millis`)
      // The round is a fiber the clock woke: give it a few milliseconds of virtual time to reach the lease.
      for (let wait = 0; wait < 100; wait++) {
        if (heldBy(runner, dagID) > before) return
        yield* TestClock.adjust("1 millis")
      }
    }
    yield* Effect.fail(new Error(`${runner.name} ran no reconcile round`))
  })

/**
 * R2 drives a workflow of its own, so that its renewal tick has a renewal to be
 * parked in when the machine stalls. On the TestClock a sleeping tick is woken
 * at every period, however far the clock is moved: a suspension only shows to a
 * tick that is parked when the clock jumps (`freeze()` parks a renewal), exactly
 * as a real one stops the process in the middle of whatever it was doing.
 */
const driveOnR2 = (dual: DualRunner) =>
  Effect.gen(function* () {
    const dagID = yield* dual.r2.dag.create({
      projectID: PROJECT_ID,
      sessionID: PARENT_SESSION_ID,
      title: "r2 own",
      config: { name: "r2-own", nodes: [node("m1")] },
    })
    yield* dual.r2.nextPrompt("R2 did not start the child prompt of m1")
    return dagID
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
  // legally leave (R2 only queued it), is the fence token's: PR3b, in the group
  // of cases at the end of this file, which also assert that R1 drops its runtime
  // entry.
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
  // half was the known race. Pinned here so that restructuring the guards
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

  // Race 3. The machine is suspended (a laptop sleeps, a VM is paused) and the wall clock jumps past the lease TTL
  // (90 s) while it is. Everything on it stalls, R1 included, so nothing renewed R1's lease, and when the machine
  // wakes up the lease looks expired only because nobody could renew it. R2 must not take the workflow over on that
  // evidence: the first reading of its clock after the wake-up sees the jump, and R2 leaves R1 alone for two periods of
  // the clock from there (ADR-0008 decision 2 and decision 6, row 7). R1's renewal succeeds with an unchanged epoch and
  // its settlement is accepted.
  //
  // This is the case decision 2 describes. A single runner that stalls past the TTL while the rest of the machine
  // runs on is a different one, and there the opposite is right: another runner takes its workflows over (see
  // "a runner takes a lease over once it has expired" in dag-runner-lease.test.ts, and the next case).
  //
  // R2 drives a workflow of its own (`driveOnR2`) in both cases: that is what its frozen tick is parked in.
  it.effect("race 3: a wall-clock jump while the whole machine is suspended must not make R2 take over a live R1", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID, gate } = yield* driveOnR1(dual)
      yield* dual.r2.init
      const ownDagID = yield* driveOnR2(dual)
      const created = [...dual.r2.created]
      expect(yield* rowOf(dual, dagID)).toMatchObject({ runnerID: dual.r1.identity.id, epoch: 1 })
      expect(heldBy(dual.r2, dagID)).toBe(1)

      // The machine suspends: both runners stall at their first touch of the lease while the clock moves on.
      const r2Stall = yield* dual.r2.freeze()
      const r1Stall = yield* dual.r1.freeze()
      yield* TestClock.adjust("2 minutes")

      // It wakes up. R2 is released first, so that it is the first to look at the lease: the round that its tick
      // starts after its renewal reads the clock two minutes on, which is the jump, and the next rounds follow it.
      yield* r2Stall.release
      yield* r1Stall.release
      yield* pollOnTestClock(
        Effect.sync(() => (heldBy(dual.r2, dagID) >= 2 ? true : undefined)),
        "R2's round did not run after the machine woke up",
      )
      for (let round = 0; round < 3; round++) yield* nextRound(dual.r2, dagID)

      const { node: row, workflow, log } = yield* stateOf(dual, dagID)
      expect(log).not.toContain("dag.node.failed")
      expect(log).not.toContain("dag.workflow.paused")
      expect(row?.status).toBe("running")
      expect(workflow).toBe("running")
      expect(dual.r2.cancelled).toEqual([])
      expect(dual.r2.created).toEqual(created)
      // R2 looked at the lease in every round and claimed nothing of R1's; R1 claimed nothing of R2's either.
      expect(heldBy(dual.r2, dagID)).toBe(5)
      expect(dual.r2.leaseCalls.filter((call) => call.operation === "claim" && call.dagID === dagID)).toEqual([])
      expect(dual.r1.leaseCalls.filter((call) => call.operation === "claim" && call.dagID === ownDagID)).toEqual([])
      // R1 kept its lease at the epoch it had, and renewed it.
      const renewed = yield* rowOf(dual, dagID)
      expect(renewed).toMatchObject({ runnerID: dual.r1.identity.id, epoch: 1 })
      expect(renewed.expiresAt).toBeGreaterThan(yield* Clock.currentTimeMillis)

      // R1 settles the node with its own token, and the write is accepted.
      yield* Deferred.succeed(gate.release, "r1 output")
      yield* pollOnTestClock(
        dual.r2.store
          .getWorkflow(dagID)
          .pipe(Effect.map((current) => (current?.status === "completed" ? true : undefined))),
        "R1's settlement was not accepted after the clock jump",
      )
      expect(dual.r1.fenced.filter((write) => write.outcome === "refused")).toEqual([])
      expect((yield* stateOf(dual, dagID)).node?.output).toBe("r1 output")
    }),
  )

  // The other half of race 3: the clock rule is a delay, not a veto. R1 has the round that sees the jump and the one
  // after it to renew (two periods of the clock from the first reading after the wake-up); a lease that is still
  // unrenewed at the third round is a stall, and R2 takes the workflow over at the next epoch.
  it.effect("race 3: R2 gives a silent R1 two rounds after the clock jump, and takes over at the third", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID } = yield* driveOnR1(dual)
      yield* dual.r2.init
      yield* driveOnR2(dual)

      // The machine suspends, then wakes up; only R1 stays stalled (a process that did not come back).
      const r2Stall = yield* dual.r2.freeze()
      const r1Stall = yield* dual.r1.freeze()
      yield* TestClock.adjust("2 minutes")
      yield* r2Stall.release
      yield* pollOnTestClock(
        Effect.sync(() => (heldBy(dual.r2, dagID) >= 2 ? true : undefined)),
        "R2's round did not run after the machine woke up",
      )

      // The round that sees the jump (the one that just ran) and the one after it find R1's lease expired and leave it
      // alone.
      const claimsOnR1 = () => dual.r2.leaseCalls.filter((call) => call.operation === "claim" && call.dagID === dagID)
      expect(claimsOnR1()).toEqual([])
      yield* nextRound(dual.r2, dagID)
      expect(claimsOnR1()).toEqual([])
      expect(yield* rowOf(dual, dagID)).toMatchObject({ runnerID: dual.r1.identity.id, epoch: 1 })

      // The third one does not: R2 claims the workflow right after it looked.
      yield* nextRound(dual.r2, dagID)
      const adopted = yield* pollOnTestClock(
        dual.leaseRow(dagID).pipe(Effect.map((row) => (row?.runnerID === dual.r2.identity.id ? row : undefined))),
        "R2 did not take over a lease that nobody renewed",
      )
      expect(adopted.epoch).toBe(2)
      const calls = dual.r2.leaseCalls.filter((call) => call.dagID === dagID).map((call) => call.operation)
      expect(calls.slice(0, 4)).toEqual(["held", "held", "held", "held"])
      expect(calls[4]).toBe("claim")
      yield* r1Stall.release
    }),
  )
})

/**
 * ADR-0008 decisions 4 and 5 (PR3b). Every write a runner's DagLoop makes about a
 * workflow it drives carries the token of its runtime entry, and the fence in
 * front of the transaction refuses a token the lease no longer names. The guard
 * inside the transaction cannot do that job alone: it judges the node (its
 * status, its attempt identity), and a zombie's write is often one the node may
 * legally take, because the new holder has not touched the node yet, or took it
 * over with the very attempt the zombie started.
 *
 * Each case stalls R1 at the command's entry (`hold`, ahead of the transaction),
 * moves the lease to R2, and lets R1's write go on. What R1's write finds is the
 * state R2 left; what the test waits for is the fence's answer
 * (`Runner.fenced`), not a sleep.
 */
describe("a runner that lost the lease: its writes are refused and it drops the workflow (#1029, ADR-0008 decisions 4 and 5)", () => {
  /** The first write of `runner` that the fence refused, once there is one. */
  const refusedWrite = (runner: Runner, message: string) =>
    pollWithTimeout(
      Effect.sync(() => runner.fenced.find((write) => write.outcome === "refused")),
      message,
    )

  /** Whether the dag registration of the parent session names a workflow in `runner`'s exclusive registry. */
  const dagOwner = (runner: Runner) =>
    Effect.map(runner.exclusive.claim(SessionID.make(PARENT_SESSION_ID), { kind: "dag" }), (claimed) =>
      Option.isSome(claimed) ? claimed.value.owner.id : undefined,
    )

  /** R1 gave the workflow up: its runtime entry is gone, so its dag registration is too. */
  const droppedBy = (runner: Runner) =>
    pollWithTimeout(
      Effect.map(dagOwner(runner), (owner) => (owner === undefined ? true : undefined)),
      `${runner.name} kept the runtime entry of the workflow it lost`,
    )

  const claimAsR2 = (dual: DualRunner, dagID: string) =>
    Effect.gen(function* () {
      yield* dual.expireLease(dagID)
      const claimed = yield* dual.r2.lease.claim({
        dagID,
        runnerID: dual.r2.identity.id,
        now: yield* Clock.currentTimeMillis,
      })
      expect(claimed?.epoch).toBe(2)
    })

  const completed = (dual: DualRunner, dagID: string) =>
    pollWithTimeout(
      dual.r2.store
        .getWorkflow(dagID)
        .pipe(Effect.map((current) => (current?.status === "completed" ? true : undefined))),
      `${dagID} did not complete`,
    )

  it.live("every write a runner makes about its workflow carries its token, and an intent write carries none", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID, gate } = yield* driveOnR1(dual, { nodes: [node("n1"), node("n2", ["n1"])] })
      // A user's pause and resume are intent writes: no token, whoever holds the lease.
      yield* dual.r1.dag.pause(dagID)
      yield* dual.r1.dag.resume(dagID)

      yield* Deferred.succeed(gate.release, "n1 output")
      const second = yield* dual.r1.nextPrompt("R1 did not start the child prompt of n2")
      yield* Deferred.succeed(second.release, "n2 output")
      yield* completed(dual, dagID)

      // admission, start and settlement of both nodes, then the workflow's own completion.
      const token = { runnerID: dual.r1.identity.id, epoch: 1 }
      expect(dual.r1.fenced).toEqual([
        { dagID, token, outcome: "committed" },
        { dagID, token, outcome: "committed" },
        { dagID, token, outcome: "committed" },
        { dagID, token, outcome: "committed" },
        { dagID, token, outcome: "committed" },
        { dagID, token, outcome: "committed" },
        { dagID, token, outcome: "committed" },
      ])
      expect(dual.r2.fenced).toEqual([])
    }),
  )

  // The case the guard cannot tell. R2 adopted the workflow and went as far as its
  // own NodeStarted, which it holds: the node is `queued`, a status the zombie's
  // start may legally leave, and its attempt identity (the replan count) is still
  // the one R1 admitted. Without the token R1's start lands, the node points at
  // R1's child, and R2's own start is then the one the guard refuses.
  it.live("NodeStarted: a node R2 only queued is not started by R1's late write", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      yield* dual.r1.init
      const r1Start = yield* dual.r1.hold((publish) => publish.type === "dag.node.started")
      const dagID = yield* dual.r1.dag.create({
        projectID: PROJECT_ID,
        sessionID: PARENT_SESSION_ID,
        title: "queued start",
        config: { name: "queued-start", nodes: [node("n1")] },
      })
      yield* awaitWithTimeout(r1Start.reached, "R1 never reached its NodeStarted", "5 seconds")
      yield* dual.expireLease(dagID)
      const r2Start = yield* dual.r2.hold((publish) => publish.type === "dag.node.started")
      yield* dual.r2.init
      yield* awaitWithTimeout(r2Start.reached, "R2 never reached its NodeStarted", "5 seconds")
      expect((yield* stateOf(dual, dagID)).node?.status).toBe("queued")
      expect(yield* dual.leaseRow(dagID)).toMatchObject({ runnerID: dual.r2.identity.id, epoch: 2 })

      yield* r1Start.release
      yield* refusedWrite(dual.r1, "R1's late NodeStarted was never refused")

      const { node: row, log } = yield* stateOf(dual, dagID)
      expect(row?.status).toBe("queued")
      expect(row?.childSessionId).toBeNull()
      expect(log).not.toContain("dag.node.started")
      expect(log).not.toContain("dag.node.failed")
      // R1 ends the attempt it can no longer settle (it cancels its child) and drops the workflow.
      yield* pollWithTimeout(
        Effect.sync(() => (dual.r1.cancelled.includes("ses_r1_child_1") ? true : undefined)),
        "R1 did not cancel the child of the attempt it lost",
      )
      yield* droppedBy(dual.r1)

      // R2 carries on: its start lands now and its attempt is the one that settles the node.
      yield* r2Start.release
      const attempt = yield* dual.r2.nextPrompt("R2 did not start its own attempt of n1")
      expect((yield* stateOf(dual, dagID)).node?.childSessionId).toBe(attempt.sessionID)
      yield* Deferred.succeed(attempt.release, "r2 output")
      yield* completed(dual, dagID)
      expect((yield* stateOf(dual, dagID)).node?.output).toBe("r2 output")
    }),
  )

  // R1 decides to admit the next node and stalls at the write. R2 takes the lease
  // and has not touched n2 (it is `pending`), so the admission is a legal
  // transition for the guard. R1 has to leave n2 to the holder: no `queued` event
  // for a node it does not own.
  it.live("NodeQueued: R1's late admission of the next node is refused and the node is left to the holder", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID, gate } = yield* driveOnR1(dual, { nodes: [node("n1"), node("n2", ["n1"])] })
      const admission = yield* dual.r1.hold(
        (publish) => publish.type === "dag.node.queued" && commandArgs(publish)[1] === "n2",
      )
      yield* Deferred.succeed(gate.release, "n1 output")
      yield* awaitWithTimeout(admission.reached, "R1 never reached its admission of n2", "5 seconds")
      yield* claimAsR2(dual, dagID)
      const before = (yield* dual.log(dagID)).length

      yield* admission.release
      yield* refusedWrite(dual.r1, "R1's late NodeQueued was never refused")

      // Nothing at all: not a queued node, not a failure.
      expect((yield* dual.log(dagID)).slice(before)).toEqual([])
      expect((yield* dual.r2.store.getNode(dagID, "n2"))?.status).toBe("pending")
      expect(dual.r1.created).toEqual([gate.sessionID])
      yield* droppedBy(dual.r1)
    }),
  )

  // R1's deadline watcher found the node overdue and stalls at the escalation. The
  // node is still R1's attempt as far as the guard can see (running, R1's child,
  // the replan count it carries), but the workflow is R2's: an escalation wakes the
  // parent, and the parent hears it from the holder.
  it.effect("NodeTimeoutEscalated: R1's watcher escalates a node whose workflow is R2's, and is refused", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID } = yield* driveOnR1(dual, { nodes: [{ ...node("n1"), worker_config: { timeout_ms: 5_000 } }] })
      const escalation = yield* dual.r1.hold((publish) => publish.type === "dag.node.timeout_escalated")
      yield* TestClock.adjust("6 seconds")
      yield* escalation.reached
      yield* claimAsR2(dual, dagID)
      const before = (yield* dual.log(dagID)).length

      yield* escalation.release
      yield* pollOnTestClock(
        Effect.sync(() => dual.r1.fenced.find((write) => write.outcome === "refused")),
        "R1's late NodeTimeoutEscalated was never refused",
      )

      expect((yield* dual.log(dagID)).slice(before)).toEqual([])
      expect((yield* dual.r2.store.getNode(dagID, "n1"))?.status).toBe("running")
      yield* pollOnTestClock(
        Effect.map(dagOwner(dual.r1), (owner) => (owner === undefined ? true : undefined)),
        "R1 kept the runtime entry of the workflow it lost",
      )
    }),
  )

  // An adoption writes before its runtime entry exists: the node-level reconciliation
  // judges the node it found running and fails it ("execution ownership lost"), then
  // pauses the workflow. Those are runner writes under the claim's token, so an
  // adopter that lost its claim half-way (R1 took the lease back while R2 was about
  // to write) judges nothing more.
  it.live("adoption: a runner whose claim was taken before its reconciliation wrote leaves the workflow alone", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID } = yield* driveOnR1(dual)
      yield* dual.expireLease(dagID)
      // R2 claims the workflow and decides the running node is lost: parked at the command's entry.
      const judgement = yield* dual.r2.hold((publish) => publish.type === "dag.node.failed")
      const starting = yield* dual.r2.init.pipe(Effect.forkScoped)
      yield* awaitWithTimeout(judgement.reached, "R2 never judged the node it found running", "5 seconds")
      expect(yield* dual.leaseRow(dagID)).toMatchObject({ runnerID: dual.r2.identity.id, epoch: 2 })
      // R1 takes the lease back before R2's write.
      yield* dual.expireLease(dagID)
      expect(
        (yield* dual.r1.lease.claim({
          dagID,
          runnerID: dual.r1.identity.id,
          now: yield* Clock.currentTimeMillis,
        }))?.epoch,
      ).toBe(3)
      const before = (yield* dual.log(dagID)).length

      yield* judgement.release
      yield* Fiber.join(starting)
      yield* refusedWrite(dual.r2, "R2's late judgement of the node was never refused")

      // No failure, no pause: nothing of R2's adoption reached the workflow, and R1's lease is untouched.
      expect((yield* dual.log(dagID)).slice(before)).toEqual([])
      expect((yield* stateOf(dual, dagID)).node?.status).toBe("running")
      expect(yield* dual.leaseRow(dagID)).toMatchObject({ runnerID: dual.r1.identity.id, epoch: 3 })
    }),
  )

  // A replan that carries a new timeout for a running node re-times it: R1's loop
  // writes the new deadline (`nodeExtendTimeout`) from the WorkflowReplanned handler.
  // R1 stalls at that write, R2 takes the workflow, and the deadline it moves is a
  // deadline of R2's now. The guard cannot tell: the node is R1's attempt as far as
  // it can see.
  it.effect("NodeExtendTimeout: R1's re-timing of a node whose workflow is R2's now is refused", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID } = yield* driveOnR1(dual, { nodes: [{ ...node("n1"), worker_config: { timeout_ms: 5_000 } }] })
      // The watcher finds the node overdue; its escalation stays parked, so the re-time below is the write that lands first.
      const escalation = yield* dual.r1.hold((publish) => publish.type === "dag.node.timeout_escalated")
      yield* TestClock.adjust("6 seconds")
      yield* escalation.reached
      const retime = yield* dual.r1.hold((publish) => publish.type === "dag.node.deadline_extended")
      yield* dual.r1.dag.replan(dagID, { nodes: [{ ...node("n1"), worker_config: { timeout_ms: 60_000 } }] })
      yield* retime.reached
      yield* claimAsR2(dual, dagID)
      const before = (yield* dual.log(dagID)).length

      yield* retime.release
      yield* escalation.release
      yield* pollOnTestClock(
        Effect.sync(() =>
          dual.r1.fenced.filter((write) => write.outcome === "refused").length >= 2 ? true : undefined,
        ),
        "R1's late re-timing and escalation were not both refused",
      )

      expect((yield* dual.log(dagID)).slice(before)).toEqual([])
      expect((yield* dual.r2.store.getNode(dagID, "n1"))?.status).toBe("running")
      yield* pollOnTestClock(
        Effect.map(dagOwner(dual.r1), (owner) => (owner === undefined ? true : undefined)),
        "R1 kept the runtime entry of the workflow it lost",
      )
    }),
  )

  // The same attempt, two drivers. R2 took the workflow and settles the very child
  // R1 started (same session, same replan count), so the attempt identity cannot
  // tell the two writers apart. R1 answers first.
  it.live("NodeCompleted: the attempt R2 took over is settled by R2, not by the zombie that started it", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID, gate } = yield* driveOnR1(dual)
      const settlement = yield* dual.r1.hold((publish) => publish.type === "dag.node.completed")
      yield* Deferred.succeed(gate.release, "r1 output")
      yield* awaitWithTimeout(settlement.reached, "R1 never reached its settlement of n1", "5 seconds")
      yield* claimAsR2(dual, dagID)

      yield* settlement.release
      yield* refusedWrite(dual.r1, "R1's late NodeCompleted was never refused")
      expect((yield* stateOf(dual, dagID)).log).not.toContain("dag.node.completed")
      expect((yield* stateOf(dual, dagID)).node?.status).toBe("running")

      // R2 settles the same attempt and its answer is the one the node keeps.
      yield* dual.r2.dag.nodeCompleted(dagID, "n1", "r2 output", { replanAttempts: 0, childSessionID: gate.sessionID })
      const { node: row, log } = yield* stateOf(dual, dagID)
      expect(row?.status).toBe("completed")
      expect(row?.output).toBe("r2 output")
      expect(log.filter((type) => type === "dag.node.completed")).toHaveLength(1)
      expect(log).not.toContain("dag.node.failed")
      yield* droppedBy(dual.r1)
    }),
  )
})
