// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1029, PR2 (ADR-0008 decisions 1, 2 and 6): the DagLoop takes a
 * workflow only through a lease claim, renews what it holds, gives it back at a
 * clean exit and drops what it lost. Two engine processes are modeled on the
 * dual-runner fixture (`fixture/dual-runner.ts`): two layer graphs over one WAL
 * database file, each claiming as its own `pid:nonce`.
 *
 * Everything here runs on the TestClock, because the lease is a matter of time
 * (TTL 90 s, renewal every 30 s). Things to keep in mind when reading:
 *   - a stalled process is `runner.freeze()`: it parks the lease operations too,
 *     so a frozen runner renews nothing while the clock moves on;
 *   - a renewal is a background tick, so a test waits for its effect with
 *     `pollOnTestClock` (which moves the clock by a few milliseconds per round)
 *     and compares with inequalities, not with the exact tick time;
 *   - nothing here sleeps for a background fiber: a test waits for something the
 *     fiber publishes (the lease row, `runner.leaseCalls`, the exclusive
 *     registry, the child cancellations, the child prompt a runner starts), and
 *     for what a loop decided NOT to do it waits for the decision that ends the
 *     path (a refused claim, an eviction) before it looks;
 *   - a wait is bounded in real time, not in rounds of the clock: what a runner's
 *     fibers do on the way (an adoption) takes real time, which a round of the
 *     TestClock does not wait for. A wait that gives up says what the runner did
 *     (`describeRunner`), to tell a slow runner from one that was refused.
 * The last two groups have no database at all: they run `RunnerLease` over a
 * scripted `DagLease` and a plain table of entries, one rule per test.
 *
 * Since PR4a the same tick that renews also starts the instance's reconcile round
 * (ADR-0008 decision 6, `reconciler.ts`) in a fiber of its own, never two at once and
 * never waited for: "the reconcile tick" below is what that adds to a runner that is
 * already up, and the clock watch the tick and the reconciler's observations feed
 * (decision 2). On the TestClock a sleeping tick is woken at every period, so a tick
 * only sees a gap in the clock when it is parked mid-renewal (`freeze()` of a runner
 * that drives a workflow, a renewal that waits in a scripted lease).
 */

import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Clock, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Scope, Semaphore } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { DagLease } from "@graphagent/core/dag/lease"
import { Project } from "@graphagent/core/project"
import { DagEvent } from "@graphagent/schema/dag-event"
import { RunnerLease } from "@/dag/runtime/runner-lease"
import { EngineProcess } from "@/session/engine-process"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import {
  PARENT_SESSION_ID,
  PROJECT_ID,
  describeRunner,
  driveOnR1,
  makeDualRunner,
  node,
  pollOnTestClock,
  type DualRunner,
  type Runner,
} from "./fixture/dual-runner"

const it = testEffect(Layer.empty)

const PERIOD = `${DagLease.RENEWAL_PERIOD_MS} millis`
/** More than `DagLease.TTL_MS`: what a stall has to outlast for another runner to take its lease. */
const PAST_TTL = "2 minutes"

const now = Clock.currentTimeMillis

const rowOf = (dual: DualRunner, dagID: string) =>
  dual
    .leaseRow(dagID)
    .pipe(
      Effect.flatMap((row) =>
        row === undefined ? Effect.die(new Error(`no lease row for ${dagID}`)) : Effect.succeed(row),
      ),
    )

/** The lease row of a workflow whose lease was given back: it has run out, and it keeps its holder and epoch. */
const givenBackRow = (dual: DualRunner, dagID: string) =>
  Effect.gen(function* () {
    const row = yield* rowOf(dual, dagID)
    expect(row.expiresAt).toBeLessThanOrEqual(yield* now)
    return row
  })

/** Wait for the renewal tick: the row's expiry moved past `after`. */
const renewedPast = (dual: DualRunner, dagID: string, after: number) =>
  pollOnTestClock(
    dual.leaseRow(dagID).pipe(Effect.map((row) => (row !== undefined && row.expiresAt > after ? row : undefined))),
    `the lease of ${dagID} was not renewed past ${after}`,
  )

const completed = (dual: DualRunner, dagID: string) =>
  pollOnTestClock(
    dual.r2.store
      .getWorkflow(dagID)
      .pipe(Effect.map((workflow) => (workflow?.status === "completed" ? true : undefined))),
    `${dagID} did not complete`,
  )

/**
 * Wait until the runner's loop has read the lease of `dagID` `count` times after its first `seen` lease calls, and
 * answer the reads. A workflow that a trigger hands to the reconciler is judged from that read (decision 6): another
 * runner's live lease ends the evaluation right there, with no claim made at all.
 */
const heldAfter = (runner: Runner, dagID: string, seen: number, count = 1) =>
  pollOnTestClock(
    Effect.sync(() => {
      const reads = runner.leaseCalls.slice(seen).filter((call) => call.operation === "held" && call.dagID === dagID)
      return reads.length >= count ? reads : undefined
    }),
    `${runner.name} read the lease of ${dagID} fewer than ${count} times`,
  )

/**
 * Replan twice on a runner that has no runtime entry for `dagID` and whose reconciler leaves the workflow to another
 * runner's live lease. A trigger waits for the evaluation under way (`reconcileAfter`), so the first evaluation is
 * over, and has claimed nothing, once the second has begun: the two reads of the lease are the proof, and the answers
 * of both are returned.
 */
const replanLeftAlone = (runner: Runner, dagID: string, ids: readonly [string, string]) =>
  Effect.gen(function* () {
    const seen = runner.leaseCalls.length
    yield* runner.dag.extend(dagID, [node(ids[0])])
    yield* heldAfter(runner, dagID, seen, 1)
    yield* runner.dag.extend(dagID, [node(ids[1])])
    return yield* heldAfter(runner, dagID, seen, 2)
  })

/** Which workflow the registry of `runner` names as the dag owner of the parent session (the first one registered), if any. */
const dagOwner = (runner: Runner) =>
  Effect.map(runner.exclusive.claim(SessionID.make(PARENT_SESSION_ID), { kind: "dag" }), (claimed) =>
    Option.isSome(claimed) ? claimed.value.owner.id : undefined,
  )

describe("claiming (ADR-0008 decision 6: the claim comes first)", () => {
  it.effect("a runner claims the lease of a workflow when it first drives it", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID } = yield* driveOnR1(dual)

      expect(yield* rowOf(dual, dagID)).toEqual({
        runnerID: dual.r1.identity.id,
        epoch: 1,
        expiresAt: (yield* now) + DagLease.TTL_MS,
      })
    }),
  )

  it.effect("a runner that starts while another holds a live lease leaves the workflow and its lease alone", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID, gate } = yield* driveOnR1(dual)
      const events = yield* dual.log(dagID)

      yield* TestClock.adjust("45 seconds")
      yield* dual.r2.init

      // R2 wrote nothing: not an event, not a lease, not a child.
      expect(yield* dual.log(dagID)).toEqual(events)
      const row = yield* rowOf(dual, dagID)
      expect(row).toMatchObject({ runnerID: dual.r1.identity.id, epoch: 1 })
      expect(row.expiresAt).toBeGreaterThan(yield* now)
      expect(dual.r2.created).toEqual([])
      expect(dual.r2.cancelled).toEqual([])

      // R1 still owns the workflow and settles it.
      yield* Deferred.succeed(gate.release, "r1 output")
      yield* completed(dual, dagID)
    }),
  )

  it.effect("a replan that finds no runtime entry defers to a live lease instead of adopting the workflow", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID } = yield* driveOnR1(dual)
      yield* dual.r2.init
      const events = yield* dual.log(dagID)

      // R2's WorkflowReplanned handler finds no entry and hands the workflow to its reconciler: R1's live lease
      // is what the evaluation reads, and where it ends. R2 claims nothing.
      const reads = yield* replanLeftAlone(dual.r2, dagID, ["m", "m-again"])
      expect(reads.map((read) => read.answer)).toMatchObject([
        { runnerID: dual.r1.identity.id },
        { runnerID: dual.r1.identity.id },
      ])
      expect(dual.r2.leaseCalls.filter((call) => call.operation === "claim")).toEqual([])

      const added = (yield* dual.log(dagID)).slice(events.length).map((event) => event.type)
      expect(added).not.toContain("dag.node.failed")
      expect(added).not.toContain("dag.workflow.paused")
      expect(dual.r2.created).toEqual([])
      expect(dual.r2.cancelled).toEqual([])
      expect(yield* rowOf(dual, dagID)).toMatchObject({ runnerID: dual.r1.identity.id, epoch: 1 })
    }),
  )

  it.effect("a runner takes a lease over once it has expired, with the next epoch", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID } = yield* driveOnR1(dual)
      const frozen = yield* dual.r1.freeze()

      // R1 is stalled past its TTL: nothing renewed the lease.
      yield* TestClock.adjust(PAST_TTL)
      expect((yield* rowOf(dual, dagID)).expiresAt).toBeLessThan(yield* now)
      yield* dual.r2.init

      const row = yield* rowOf(dual, dagID)
      expect(row).toMatchObject({ runnerID: dual.r2.identity.id, epoch: 2 })
      expect(row.expiresAt).toBeGreaterThan(yield* now)
      yield* frozen.release
    }),
  )

  it.effect("a lease given back at a clean exit is claimed at once, without waiting for the TTL", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID } = yield* driveOnR1(dual)

      yield* dual.r1.stop

      // R1's row stays (it keeps its epoch) but is expired.
      const released = yield* rowOf(dual, dagID)
      expect(released).toMatchObject({ runnerID: dual.r1.identity.id, epoch: 1 })
      expect(released.expiresAt).toBeLessThanOrEqual(yield* now)
      yield* dual.r2.init
      expect(yield* rowOf(dual, dagID)).toMatchObject({ runnerID: dual.r2.identity.id, epoch: 2 })
    }),
  )

  it.effect("a second instance of the same process claims without a new epoch", () =>
    Effect.gen(function* () {
      // The same `pid:nonce` twice: a session that moved between two directories of one process.
      const dual = yield* makeDualRunner({ r2: EngineProcess.runner })
      const { dagID } = yield* driveOnR1(dual)
      const events = (yield* dual.log(dagID)).length

      yield* dual.r2.init

      // R2 took the workflow (its recovery judged the running node, which R1 still drives, as lost)...
      const types = (yield* dual.log(dagID)).map((event) => event.type)
      expect((yield* dual.log(dagID)).length).toBeGreaterThan(events)
      expect(types).toContain("dag.workflow.paused")
      // ...under the lease the process already held.
      expect(yield* rowOf(dual, dagID)).toMatchObject({ runnerID: EngineProcess.runner.id, epoch: 1 })
    }),
  )

  it.effect("an adoption that ends without a runtime entry gives the lease back", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID, gate } = yield* driveOnR1(dual)
      yield* dual.r1.stop
      // R2 claims, then its recovery cannot read the child session and aborts the adoption.
      dual.children.set(gate.sessionID, "defect")

      yield* dual.r2.init

      const row = yield* rowOf(dual, dagID)
      expect(row).toMatchObject({ runnerID: dual.r2.identity.id, epoch: 2 })
      expect(row.expiresAt).toBeLessThanOrEqual(yield* now)
      // Nobody waits out a TTL for a workflow nobody drives: the next runner claims it at once.
      expect(yield* dual.r2.lease.claim({ dagID, runnerID: "1:other", now: yield* now })).toMatchObject({
        runnerID: "1:other",
        epoch: 3,
      })
    }),
  )
})

describe("renewal (ADR-0008 decision 2)", () => {
  it.effect("the lease is renewed every period and keeps its epoch", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID } = yield* driveOnR1(dual)
      const claimed = yield* rowOf(dual, dagID)

      // Not before the period is over.
      yield* TestClock.adjust(`${DagLease.RENEWAL_PERIOD_MS - 1} millis`)
      expect(yield* rowOf(dual, dagID)).toEqual(claimed)

      let previous = claimed.expiresAt
      for (let tick = 0; tick < 4; tick++) {
        yield* TestClock.adjust(tick === 0 ? "1 millis" : PERIOD)
        const row = yield* renewedPast(dual, dagID, previous)
        expect(row.runnerID).toBe(dual.r1.identity.id)
        expect(row.epoch).toBe(1)
        // The renewal ran during the last period and set the expiry one TTL after itself.
        expect(row.expiresAt).toBeLessThanOrEqual((yield* now) + DagLease.TTL_MS)
        expect(row.expiresAt).toBeGreaterThan((yield* now) + DagLease.TTL_MS - DagLease.RENEWAL_PERIOD_MS)
        previous = row.expiresAt
      }
    }),
  )

  it.effect("a runner that keeps renewing is never taken over, however long it runs", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID } = yield* driveOnR1(dual)

      // Ten minutes in renewal-sized steps: R2 starts late and finds a live lease.
      let previous = (yield* rowOf(dual, dagID)).expiresAt
      for (let tick = 0; tick < 20; tick++) {
        yield* TestClock.adjust(PERIOD)
        previous = (yield* renewedPast(dual, dagID, previous)).expiresAt
      }
      yield* dual.r2.init

      expect(yield* rowOf(dual, dagID)).toMatchObject({ runnerID: dual.r1.identity.id, epoch: 1 })
      expect(dual.r2.cancelled).toEqual([])
    }),
  )

  it.effect("a paused workflow is still renewed", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID } = yield* driveOnR1(dual)
      yield* dual.r1.dag.pause(dagID)
      const before = yield* rowOf(dual, dagID)

      yield* TestClock.adjust(PERIOD)

      expect((yield* renewedPast(dual, dagID, before.expiresAt)).epoch).toBe(1)
      expect((yield* dual.r1.store.getWorkflow(dagID))?.status).toBe("paused")
    }),
  )

  it.effect("a workflow that ended is no longer renewed, while the others still are", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const first = yield* driveOnR1(dual, { name: "first" })
      const secondID = yield* dual.r1.dag.create({
        projectID: PROJECT_ID,
        sessionID: PARENT_SESSION_ID,
        title: "second",
        config: { name: "second", nodes: [node("n2")] },
      })
      yield* dual.r1.nextPrompt("R1 did not start the child prompt of n2")

      yield* Deferred.succeed(first.gate.release, "done")
      yield* completed(dual, first.dagID)
      // The terminal event handler drops the runtime entry and then the workflow's registration:
      // from then on the registry names the second workflow as the dag owner of the parent session.
      yield* pollOnTestClock(
        Effect.map(dagOwner(dual.r1), (owner) => (owner === secondID ? true : undefined)),
        "R1 did not finish with the workflow that ended",
      )
      const ended = yield* rowOf(dual, first.dagID)
      const running = yield* rowOf(dual, secondID)

      for (let tick = 0; tick < 3; tick++) yield* TestClock.adjust(PERIOD)

      // The tick ran (the running workflow's lease moved) and passed the ended one by.
      yield* renewedPast(dual, secondID, running.expiresAt)
      expect(yield* rowOf(dual, first.dagID)).toEqual(ended)
    }),
  )

  it.effect("a failing renewal is retried at the next tick and is not read as a lost lease", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID, gate } = yield* driveOnR1(dual)
      const claimed = yield* rowOf(dual, dagID)
      // The first tick hits a database failure (SQLITE_BUSY past the busy timeout).
      dual.r1.failLease("renew", 1)

      yield* TestClock.adjust(PERIOD)
      yield* TestClock.adjust(PERIOD)

      // The second tick renewed: the entry survived the first.
      expect((yield* renewedPast(dual, dagID, claimed.expiresAt)).epoch).toBe(1)
      expect(dual.r1.cancelled).toEqual([])
      yield* Deferred.succeed(gate.release, "r1 output")
      yield* completed(dual, dagID)
    }),
  )
})

describe("a runner that lost its lease evicts the workflow (ADR-0008 decision 2)", () => {
  it.effect("it stops driving at its next renewal and writes nothing for the workflow", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID, gate } = yield* driveOnR1(dual)
      // R1's loop registered the workflow: a dag registration keeps goals off the parent session.
      const parent = SessionID.make(PARENT_SESSION_ID)
      const registered = Effect.map(dual.r1.exclusive.claim(parent, { kind: "dag" }), Option.isSome)
      expect(yield* registered).toBe(true)
      const frozen = yield* dual.r1.freeze()
      yield* TestClock.adjust(PAST_TTL)
      yield* dual.r2.init
      // R2 decides the workflow's outcome: it adopted at epoch 2 and judged the node it found running.
      expect(yield* rowOf(dual, dagID)).toMatchObject({ runnerID: dual.r2.identity.id, epoch: 2 })
      expect(dual.r1.cancelled).toEqual([])

      // R1 wakes up. Its renewal finds the lease gone.
      yield* frozen.release
      yield* pollOnTestClock(
        Effect.sync(() => (dual.r1.cancelled.includes(gate.sessionID) ? true : undefined)),
        "R1 did not abort its child after it lost the lease",
      )
      expect(dual.r1.childRuns.cancelled.map((entry) => entry.by)).toContainEqual({
        kind: "engine",
        reason: "lease-lost",
        actor: "dag-lease",
      })
      // The registration is the new holder's concern now: it must not pin the session in this process.
      yield* pollOnTestClock(
        Effect.map(registered, (still) => (still ? undefined : true)),
        "R1 kept its dag registration of the workflow it lost",
      )

      // From here on R1 acts on nothing: its child's reply starts no settlement, and the log does not move.
      const events = yield* dual.log(dagID)
      yield* Deferred.succeed(gate.release, "late output")
      for (let tick = 0; tick < 3; tick++) yield* TestClock.adjust(PERIOD)
      expect(yield* dual.log(dagID)).toEqual(events)
      expect(dual.r1.created).toEqual([gate.sessionID])
      // It dropped the entry and does not adopt the workflow again: a replan on R1 finds no entry, and R2's lease is live.
      const reads = yield* replanLeftAlone(dual.r1, dagID, ["m", "m-again"])
      expect(reads.map((read) => read.answer)).toMatchObject([
        { runnerID: dual.r2.identity.id },
        { runnerID: dual.r2.identity.id },
      ])
      expect(dual.r1.leaseCalls.filter((call) => call.operation === "claim")).toHaveLength(1)
      expect(dual.r1.created).toEqual([gate.sessionID])
      // And it does not take the lease back: that is R2's.
      expect(yield* rowOf(dual, dagID)).toMatchObject({ runnerID: dual.r2.identity.id, epoch: 2 })

      // Eviction left no entry in R1's way: once R2's lease runs out, the next replan adopts the workflow anew.
      yield* dual.expireLease(dagID)
      yield* dual.r1.dag.extend(dagID, [node("m2")])
      yield* pollOnTestClock(
        dual.leaseRow(dagID).pipe(Effect.map((row) => (row?.runnerID === dual.r1.identity.id ? row : undefined))),
        "R1 did not adopt the workflow once the lease was free",
      )
      expect(yield* rowOf(dual, dagID)).toMatchObject({ runnerID: dual.r1.identity.id, epoch: 3 })
    }),
  )

  it.effect(
    "it cancels the child its own attempt created, not the one the node row names after the new holder restarted the node",
    () =>
      Effect.gen(function* () {
        const R2_CHILD = "ses_r2_child_1"
        const dual = yield* makeDualRunner()
        const { dagID, gate } = yield* driveOnR1(dual)
        expect(yield* dagOwner(dual.r1)).toBe(dagID)

        // R1 stalls past its TTL. R2 takes the lease over and restarts n1 as an attempt with a child session of its own.
        const frozen = yield* dual.r1.freeze()
        yield* TestClock.adjust(PAST_TTL)
        expect(yield* dual.r2.lease.claim({ dagID, runnerID: dual.r2.identity.id, now: yield* now })).toMatchObject({
          epoch: 2,
        })
        yield* dual.r2.dag.nodeRestarted(dagID, "n1", gate.sessionID)
        yield* dual.r2.dag.nodeStarted(dagID, "n1", R2_CHILD)
        // The row names R2's child now, which is what R1's eviction must not go by.
        expect((yield* dual.r2.store.getNode(dagID, "n1"))?.childSessionId).toBe(R2_CHILD)
        const events = yield* dual.log(dagID)

        // R1 wakes up, its renewal finds the lease gone and it evicts the workflow.
        yield* frozen.release
        yield* pollOnTestClock(
          Effect.map(dagOwner(dual.r1), (owner) => (owner === undefined ? true : undefined)),
          "R1 did not evict the workflow it lost",
        )

        // It cancelled the child of its own attempt with the eviction's reason, and nothing else...
        const evicted = dual.r1.childRuns.cancelled.filter(
          (entry) => entry.by.kind === "engine" && entry.by.reason === "lease-lost",
        )
        expect(evicted.map((entry) => entry.id)).toEqual([gate.sessionID])
        expect(dual.r1.cancelled).toContain(gate.sessionID)
        // ...R2's child was left alone: neither its run cancelled nor `SessionPrompt.cancel` called on it, and that
        // call is the one that reaches the admission seam which marks a session's input snapshot stopped and drops its mailbox.
        expect(dual.r1.childRuns.cancelled.map((entry) => entry.id)).not.toContain(R2_CHILD)
        expect(dual.r1.cancelled).not.toContain(R2_CHILD)
        // R1 wrote nothing, and the node is still R2's attempt.
        expect(yield* dual.log(dagID)).toEqual(events)
        expect((yield* dual.r2.store.getNode(dagID, "n1"))?.childSessionId).toBe(R2_CHILD)
      }),
  )
})

describe("a runner re-reads its lease before it creates a child session (ADR-0008 decision 2)", () => {
  // `n1 -> n2`: R1 drives n1; the child session of n2 is the next thing it would create.
  const chain = { nodes: [node("n1"), node("n2", ["n1"])] }

  it.effect("a runner that holds the lease creates the child session of its next node", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID, gate } = yield* driveOnR1(dual, chain)

      yield* Deferred.succeed(gate.release, "n1 output")
      const second = yield* dual.r1.nextPrompt("R1 did not start the child prompt of n2")

      expect(dual.r1.created).toEqual([gate.sessionID, second.sessionID])
      yield* Deferred.succeed(second.release, "n2 output")
      yield* completed(dual, dagID)
      expect(yield* rowOf(dual, dagID)).toMatchObject({ runnerID: dual.r1.identity.id, epoch: 1 })
    }),
  )

  it.effect(
    "a runner that lost the lease admits no node, creates no child session and writes no failure, and evicts the workflow",
    () =>
      Effect.gen(function* () {
        const dual = yield* makeDualRunner()
        const { dagID, gate } = yield* driveOnR1(dual, chain)
        const registered = Effect.map(
          dual.r1.exclusive.claim(SessionID.make(PARENT_SESSION_ID), { kind: "dag" }),
          Option.isSome,
        )
        expect(yield* registered).toBe(true)
        // R2 takes the lease while R1 is not looking: R1's own renewal tick is a period away.
        yield* dual.expireLease(dagID)
        expect(yield* dual.r2.lease.claim({ dagID, runnerID: dual.r2.identity.id, now: yield* now })).toMatchObject({
          epoch: 2,
        })
        const before = (yield* dual.log(dagID)).length

        // n1 finishes and R1's scheduler goes on to n2: its admission is a write under R1's token, and the fence
        // refuses it (ADR-0008 decision 4), which is also what makes R1 drop the workflow.
        yield* Deferred.succeed(gate.release, "n1 output")
        yield* pollOnTestClock(
          Effect.map(registered, (still) => (still ? undefined : true)),
          "R1 did not evict the workflow after its admission was refused",
        )

        expect(dual.r1.created).toEqual([gate.sessionID])
        expect(dual.r1.fenced.filter((write) => write.outcome === "refused")).toHaveLength(1)
        // Nothing of n2 reached the log (not even the admission), and it is not R1's failure either.
        const added = (yield* dual.log(dagID)).slice(before).map((event) => event.type)
        expect(added).toEqual([])
        // n2 is left untouched for the holder; R1 took nothing back.
        expect((yield* dual.r2.store.getNode(dagID, "n2"))?.status).toBe("pending")
        expect(yield* rowOf(dual, dagID)).toMatchObject({ runnerID: dual.r2.identity.id, epoch: 2 })
      }),
  )
})

describe("giving the leases back at a clean exit", () => {
  it.effect("a runner releases the workflows it holds and leaves another runner's alone", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const first = yield* driveOnR1(dual, { name: "first" })
      yield* dual.r2.init
      const secondID = yield* dual.r2.dag.create({
        projectID: PROJECT_ID,
        sessionID: PARENT_SESSION_ID,
        title: "second",
        config: { name: "second", nodes: [node("n2")] },
      })
      yield* dual.r2.nextPrompt("R2 did not start the child prompt of n2")
      expect(yield* rowOf(dual, secondID)).toMatchObject({ runnerID: dual.r2.identity.id, epoch: 1 })

      yield* dual.r1.stop

      expect((yield* rowOf(dual, first.dagID)).expiresAt).toBeLessThanOrEqual(yield* now)
      expect((yield* rowOf(dual, secondID)).expiresAt).toBeGreaterThan(yield* now)
    }),
  )

  it.effect("a frozen runner that is torn down does not wait for its stall to end", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID } = yield* driveOnR1(dual)
      yield* dual.r1.freeze()

      // `stop` runs the finalizer, whose release goes through the frozen lease operations: it must not park.
      yield* dual.r1.stop

      expect((yield* rowOf(dual, dagID)).expiresAt).toBeLessThanOrEqual(yield* now)
    }),
  )
})

describe("a workflow that ended gives its lease back (ADR-0008)", () => {
  /** Wait until the lease row of `dagID` has run out: given back, since nothing is left to renew it. */
  const givenBack = (dual: DualRunner, dagID: string) =>
    pollOnTestClock(
      Effect.gen(function* () {
        const row = yield* dual.leaseRow(dagID)
        return row !== undefined && row.expiresAt <= (yield* now) ? row : undefined
      }),
      describeRunner(dual, dual.r1, dagID).pipe(
        Effect.map((state) => `the lease of ${dagID} was not given back\n  ${state}`),
      ),
    )

  /** A runner that adopted the workflow: it holds the lease at the epoch after R1's, and drives the node it was reopened with. */
  const adoptedByR2 = (dual: DualRunner, dagID: string) =>
    Effect.gen(function* () {
      // As `driveOnR1` waits for R1: on the child prompt R2 starts, not on rounds of the clock. What R2 does on the
      // way takes real time that a round does not wait for, and a loaded machine makes it longer.
      yield* dual.r2.nextPrompt(
        describeRunner(dual, dual.r2, dagID).pipe(
          Effect.map((state) => `R2 did not adopt the reopened workflow: it started no child prompt\n  ${state}`),
        ),
      )
      const row = yield* rowOf(dual, dagID)
      expect(row).toMatchObject({ runnerID: dual.r2.identity.id, epoch: 2 })
      expect(row.expiresAt).toBeGreaterThan(yield* now)
      // Nobody waited for the TTL: the clock only moved by the waits above.
      expect(yield* now).toBeLessThan(DagLease.TTL_MS)
    })

  it.effect("the loop gives the lease back as its entry is dropped, and the row keeps its holder and epoch", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID, gate } = yield* driveOnR1(dual)
      expect((yield* rowOf(dual, dagID)).expiresAt).toBeGreaterThan(yield* now)

      yield* Deferred.succeed(gate.release, "done")
      yield* completed(dual, dagID)

      // Not left to run out: the workflow ended, nothing renews it, and the row is expired now.
      expect(yield* givenBack(dual, dagID)).toMatchObject({ runnerID: dual.r1.identity.id, epoch: 1 })
    }),
  )

  it.effect("a workflow extended by another runner after the first one exited is adopted at once", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      // A completed workflow can be reopened by an additive extend when a reporting leaf completed it.
      const { dagID, gate } = yield* driveOnR1(dual, { nodes: [{ ...node("n1"), report_to_parent: true }] })
      yield* Deferred.succeed(gate.release, "done")
      yield* completed(dual, dagID)
      yield* givenBack(dual, dagID)
      // R1 exits cleanly. Its exit gives back what its entries hold, and the ended workflow has none.
      yield* dual.r1.stop

      // R2 reopens the workflow with one more node and adopts it: its claim is not refused by a lease nobody renews.
      yield* dual.r2.init
      yield* dual.r2.dag.extend(dagID, [node("m", ["n1"])])

      yield* adoptedByR2(dual, dagID)
    }),
  )

  it.effect("a failed workflow recovered by another runner after the first one exited is adopted at once", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID } = yield* driveOnR1(dual)
      yield* dual.r1.dag.nodeFailed(dagID, "n1", "boom", "exec_failed")
      yield* pollOnTestClock(
        dual.r2.store
          .getWorkflow(dagID)
          .pipe(Effect.map((workflow) => (workflow?.status === "failed" ? workflow : undefined))),
        `${dagID} did not fail`,
      )
      yield* givenBack(dual, dagID)
      yield* dual.r1.stop

      yield* dual.r2.init
      const failed = yield* dual.r2.store.getWorkflow(dagID)
      yield* dual.r2.dag.recover(dagID, { nodeIDs: ["n1"], expectedGraphRev: failed?.graphRev ?? 0 })

      yield* adoptedByR2(dual, dagID)
    }),
  )
})

describe("the reconcile tick (ADR-0008 decision 6)", () => {
  /** How many times `runner` has read the lease of `dagID` (a reconcile round, or an adoption's confirm). */
  const heldBy = (runner: Runner, dagID: string) =>
    runner.leaseCalls.filter((call) => call.operation === "held" && call.dagID === dagID).length

  /** The clock on, a period at a time, until `runner`'s tick has read the lease of `dagID` once more. */
  const nextRound = (runner: Runner, dagID: string) =>
    Effect.gen(function* () {
      const before = heldBy(runner, dagID)
      for (let period = 0; period < 3; period++) {
        yield* TestClock.adjust(PERIOD)
        for (let wait = 0; wait < 100; wait++) {
          if (heldBy(runner, dagID) > before) return
          yield* TestClock.adjust("1 millis")
        }
      }
      yield* Effect.fail(new Error(`${runner.name} ran no reconcile round`))
    })

  it.effect("a runner that is already up takes over a lease that ran out at its next tick, without a restart", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID } = yield* driveOnR1(dual)
      yield* dual.r2.init
      // R2 saw a live lease at startup and left it alone.
      expect(dual.r2.leaseCalls.filter((call) => call.operation === "claim")).toEqual([])

      // R1 stalls and renews nothing. R2's ticks are on time every period, so no clock jump holds it back: the
      // first tick after the lease ran out takes it over.
      const frozen = yield* dual.r1.freeze()
      yield* TestClock.adjust(PAST_TTL)
      const row = yield* pollOnTestClock(
        dual
          .leaseRow(dagID)
          .pipe(Effect.map((current) => (current?.runnerID === dual.r2.identity.id ? current : undefined))),
        "R2's tick did not take the lease over",
      )

      expect(row.epoch).toBe(2)
      // A fresh lease of R2's own, claimed by the tick and not left over from R1.
      expect(row.expiresAt).toBeGreaterThan(yield* now)
      expect(row.expiresAt).toBeLessThanOrEqual((yield* now) + DagLease.TTL_MS)
      yield* frozen.release
    }),
  )

  it.effect(
    "a runner that holds live leases is not disturbed by its own rounds: the tick renews and the round only looks",
    () =>
      Effect.gen(function* () {
        const dual = yield* makeDualRunner()
        const { dagID, gate } = yield* driveOnR1(dual)
        const events = yield* dual.log(dagID)
        const claims = () => dual.r1.leaseCalls.filter((call) => call.operation === "claim")

        for (let round = 0; round < 3; round++) yield* nextRound(dual.r1, dagID)

        expect(claims()).toHaveLength(1)
        expect(yield* rowOf(dual, dagID)).toMatchObject({ runnerID: dual.r1.identity.id, epoch: 1 })
        expect(yield* dual.log(dagID)).toEqual(events)
        yield* Deferred.succeed(gate.release, "done")
        yield* completed(dual, dagID)
      }),
  )

  // ADR-0008 decisions 2 and 6: the round runs beside the renewals, not in front of them. A round can wait for a
  // worktree removal, the lifecycle lock or a user hook, and R1 is still driving its workflow while it does: its
  // renewals go on, and R2, whose rounds are on time, never sees a lease that ran out.
  it.effect(
    "a reconcile round that is stuck past the TTL does not stop the renewals: nobody takes the workflow over",
    () =>
      Effect.gen(function* () {
        const dual = yield* makeDualRunner()
        const { dagID, gate } = yield* driveOnR1(dual)
        yield* dual.r2.init
        // R1's first round from here on parks at its first read of the lease, and stays there.
        const stuck = yield* dual.r1.hold((publish) => publish.type === "dag.lease.held")
        const renewals = () =>
          dual.r1.leaseCalls.filter((call) => call.operation === "renew" && call.dagID === dagID).length

        yield* TestClock.adjust(PERIOD)
        yield* stuck.reached
        // Five periods in all, more than the TTL: every tick renews, with the round of the first one still parked.
        for (let tick = 2; tick <= 5; tick++) {
          yield* TestClock.adjust(PERIOD)
          yield* pollOnTestClock(
            Effect.sync(() => (renewals() >= tick ? true : undefined)),
            `R1's tick ${tick} did not renew: its round held the tick up`,
          )
        }

        const row = yield* rowOf(dual, dagID)
        expect(row).toMatchObject({ runnerID: dual.r1.identity.id, epoch: 1 })
        expect(row.expiresAt).toBeGreaterThan(yield* now)
        expect(dual.r2.leaseCalls.filter((call) => call.operation === "claim")).toEqual([])
        expect(dual.r1.leaseCalls.filter((call) => call.operation === "claim")).toHaveLength(1)

        // The round ends, and the workflow completes under the lease R1 kept.
        yield* stuck.release
        yield* Deferred.succeed(gate.release, "done")
        yield* completed(dual, dagID)
        expect(dual.r1.fenced.filter((write) => write.outcome === "refused")).toEqual([])
      }),
  )

  // Row 4 against row 5: the location is a durable fact, but a runner that is driving the workflow judges it itself.
  it.effect("a workflow whose workspace is gone is failed once nobody holds a live lease on it, not before", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      const { dagID } = yield* driveOnR1(dual)
      yield* dual.r1.database.db
        .run(sql`UPDATE workflow SET execution_directory = '/nonexistent/dag-reconcile-workspace' WHERE id = ${dagID}`)
        .pipe(Effect.orDie)

      // R2 starts: the location is unusable, but R1's lease is live. R2 neither fails nor claims.
      const events = yield* dual.log(dagID)
      yield* dual.r2.init
      expect(yield* dual.log(dagID)).toEqual(events)
      expect((yield* dual.r2.store.getWorkflow(dagID))?.status).toBe("running")
      expect(heldBy(dual.r2, dagID)).toBe(1)
      expect(dual.r2.leaseCalls.filter((call) => call.operation === "claim")).toEqual([])

      // R1 exits and gives the lease back: R2's next round fails the workflow, durably, with the reason of the location.
      yield* dual.r1.stop
      yield* nextRound(dual.r2, dagID)
      const failed = yield* pollOnTestClock(
        dual.r2.store
          .getWorkflow(dagID)
          .pipe(Effect.map((workflow) => (workflow?.status === "failed" ? workflow : undefined))),
        "R2 did not fail the workflow whose workspace is gone",
      )
      expect(failed.status).toBe("failed")
      expect(yield* dual.r2.store.getWorkflowFailureReason?.(dagID) ?? Effect.succeed(undefined)).toContain(
        "workspace_missing",
      )
      expect((yield* dual.log(dagID)).map((event) => event.type)).toContain("dag.workflow.failed")
    }),
  )

  // The event triggers are calls of `reconcileAfter` as well, and the observation they end in judges the location (row
  // 4) before anything is claimed: a workflow whose workspace is gone is failed, not adopted, whoever raised it.
  it.effect("a replan that finds no entry fails a workflow whose workspace is gone, instead of adopting it", () =>
    Effect.gen(function* () {
      const dual = yield* makeDualRunner()
      // A completed workflow can be reopened by an additive extend when a reporting leaf completed it.
      const { dagID, gate } = yield* driveOnR1(dual, { nodes: [{ ...node("n1"), report_to_parent: true }] })
      yield* Deferred.succeed(gate.release, "done")
      yield* completed(dual, dagID)
      yield* dual.r1.stop
      yield* dual.r2.init
      yield* dual.r2.database.db
        .run(sql`UPDATE workflow SET execution_directory = '/nonexistent/dag-reconcile-workspace' WHERE id = ${dagID}`)
        .pipe(Effect.orDie)

      // The reopened workflow is running again and R2 has no entry for it: its replan handler adopts, and finds
      // that the workspace cannot be used.
      yield* dual.r2.dag.extend(dagID, [node("m", ["n1"])])
      yield* pollOnTestClock(
        dual.r2.store
          .getWorkflow(dagID)
          .pipe(Effect.map((workflow) => (workflow?.status === "failed" ? true : undefined))),
        "the replan did not fail the workflow whose workspace is gone",
      )
      expect(yield* dual.r2.store.getWorkflowFailureReason?.(dagID) ?? Effect.succeed(undefined)).toContain(
        "workspace_missing",
      )
      // It never claimed the lease for a workflow it could not run, and started none of its nodes.
      expect(dual.r2.leaseCalls.filter((call) => call.operation === "claim")).toEqual([])
      expect(dual.r2.created).toEqual([])
    }),
  )

  describe("an orphan pending workflow", () => {
    const createOrphan = (dual: DualRunner) =>
      Effect.gen(function* () {
        const dagID = DagEvent.DagID.create()
        yield* dual.r1.events.publish(DagEvent.WorkflowCreated, {
          dagID,
          projectID: Project.ID.make(PROJECT_ID),
          sessionID: SessionID.make(PARENT_SESSION_ID),
          title: "orphan",
          config: JSON.stringify({ name: "orphan", nodes: [] }),
          status: "pending",
          timestamp: yield* DateTime.now,
          directory: process.cwd(),
        })
        yield* dual.r1.events.publish(DagEvent.NodeRegistered, {
          dagID,
          nodeID: DagEvent.NodeID.make("n1"),
          name: "n1",
          workerType: "build",
          dependsOn: [],
          required: true,
          timestamp: yield* DateTime.now,
        })
        // Created at the start of the TestClock's time: it is as old as the clock has run.
        yield* dual.r1.database.db.run(sql`UPDATE workflow SET time_created = 0 WHERE id = ${dagID}`).pipe(Effect.orDie)
        return dagID
      })

    it.effect("is left alone through its grace period and terminalized by the first tick after it", () =>
      Effect.gen(function* () {
        const dual = yield* makeDualRunner()
        const dagID = yield* createOrphan(dual)
        yield* dual.r1.init

        // Created a moment ago, as far as the clock knows: the startup round and the tick after it wait.
        const status = () => dual.r1.store.getWorkflow(dagID).pipe(Effect.map((workflow) => workflow?.status))
        expect(yield* status()).toBe("pending")
        yield* nextRound(dual.r1, dagID)
        expect(yield* status()).toBe("pending")
        expect(dual.r1.leaseCalls.filter((call) => call.operation === "claim")).toEqual([])

        // Past the grace period, with every node still pending: claimed and failed with the orphan reason.
        yield* nextRound(dual.r1, dagID)
        yield* pollOnTestClock(
          status().pipe(Effect.map((current) => (current === "failed" ? true : undefined))),
          "the tick did not terminalize the orphan",
        )
        const types = (yield* dual.log(dagID)).map((event) => event.type)
        expect(types).toContain("dag.workflow.failed")
        expect((yield* dual.r1.store.getNode(dagID, "n1"))?.status).toBe("skipped")
        // It gave its claim back: the workflow ended and nothing renews it.
        expect(yield* givenBackRow(dual, dagID)).toMatchObject({ runnerID: dual.r1.identity.id, epoch: 1 })
        expect(dual.r1.created).toEqual([])
      }),
    )
  })
})

/**
 * `RunnerLease` over a scripted `DagLease`: what the loop's use of the
 * primitives promises, one rule at a time and without a database. The script
 * answers each call and every call is recorded with the `now` it was given (the
 * TestClock's).
 */
describe("RunnerLease over a scripted lease", () => {
  const RUNNER = "10:test"
  const token = (epoch: number): DagLease.Token => ({ runnerID: RUNNER, epoch })
  const lease = (dagID: string, epoch: number, runnerID = RUNNER): DagLease.Lease => ({
    dagID,
    runnerID,
    epoch,
    expiresAt: 0,
  })

  interface Calls {
    readonly claim: Array<{ dagID: string; runnerID: string; now: number }>
    readonly renew: Array<{ dagID: string; token: DagLease.Token; now: number }>
    readonly release: Array<{ dagID: string; token: DagLease.Token; now: number }>
  }

  const scripted = (answers: {
    readonly claim?: (dagID: string) => DagLease.Lease | undefined
    readonly held?: (dagID: string) => DagLease.Lease | undefined
    readonly renew?: (dagID: string) => Effect.Effect<boolean>
    readonly release?: () => Effect.Effect<boolean>
  }) => {
    const calls: Calls = { claim: [], renew: [], release: [] }
    const leases: DagLease.Interface = {
      claim: (input) =>
        Effect.sync(() => {
          calls.claim.push(input)
          return answers.claim?.(input.dagID)
        }),
      held: (dagID) => Effect.sync(() => answers.held?.(dagID)),
      renew: (input) =>
        Effect.suspend(() => {
          calls.renew.push(input)
          return answers.renew?.(input.dagID) ?? Effect.succeed(true)
        }),
      release: (input) =>
        Effect.suspend(() => {
          calls.release.push(input)
          return answers.release?.() ?? Effect.succeed(true)
        }),
    }
    return { leases, calls }
  }

  /** A runtime entry is only its token, as far as the lease is concerned. */
  const entries = (init: Record<string, DagLease.Token>) =>
    new Map(Object.entries(init).map(([dagID, held]) => [dagID, { token: held }]))

  const started = (
    leases: DagLease.Interface,
    table: Map<string, { token: DagLease.Token }>,
    evicted: string[] = [],
    scope?: Scope.Scope,
    round?: (input: { readonly afterClockJump: boolean }) => Effect.Effect<void>,
  ) => {
    const effect = RunnerLease.make({
      leases,
      runnerID: RUNNER,
      entries: table,
      evict: (dagID) => Effect.sync(() => void evicted.push(dagID)),
      round,
    })
    return scope ? Effect.provideService(effect, Scope.Scope, scope) : effect
  }

  /**
   * Wait on the TestClock for what a background fiber of the runner lease has
   * to record before a test looks at its effects. A tick records its calls as
   * it goes and ends with its evictions, and the next tick only starts once the
   * one before has ended, so a call counted in tick N means tick N-1 is over.
   */
  const until = (done: () => boolean, message: string) =>
    pollOnTestClock(
      Effect.sync(() => (done() ? true : undefined)),
      message,
    )

  it.effect("claim asks for the lease as this runner, at the clock's time, and hands back its token", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("5 seconds")
      const { leases, calls } = scripted({ claim: (dagID) => lease(dagID, 7) })
      const runnerLease = yield* started(leases, entries({}))

      expect(yield* runnerLease.claim("dag-a")).toEqual(token(7))
      expect(calls.claim).toEqual([{ dagID: "dag-a", runnerID: RUNNER, now: yield* now }])
    }),
  )

  it.effect("claim is refused when the lease is not this runner's to take", () =>
    Effect.gen(function* () {
      const { leases } = scripted({ claim: () => undefined })

      expect(yield* (yield* started(leases, entries({}))).claim("dag-a")).toBeUndefined()
    }),
  )

  it.effect("confirm holds only while the lease names the token, whatever its expiry", () =>
    Effect.gen(function* () {
      const held = new Map<string, DagLease.Lease | undefined>()
      const { leases } = scripted({ held: (dagID) => held.get(dagID) })
      const runnerLease = yield* started(leases, entries({}))

      held.set("dag-a", lease("dag-a", 3))
      expect(yield* runnerLease.confirm("dag-a", token(3))).toBe(true)
      expect(yield* runnerLease.confirm("dag-a", token(2))).toBe(false)
      held.set("dag-a", lease("dag-a", 3, "11:other"))
      expect(yield* runnerLease.confirm("dag-a", token(3))).toBe(false)
      // A workflow that is gone or terminal has no lease to hold.
      held.set("dag-a", undefined)
      expect(yield* runnerLease.confirm("dag-a", token(3))).toBe(false)
    }),
  )

  it.effect("abandon gives a claim back unless an entry carries it", () =>
    Effect.gen(function* () {
      const { leases, calls } = scripted({})
      const runnerLease = yield* started(leases, entries({ "dag-kept": token(2) }))

      yield* runnerLease.abandon("dag-none", undefined)
      yield* runnerLease.abandon("dag-kept", token(2))
      expect(calls.release).toEqual([])

      yield* runnerLease.abandon("dag-gone", token(4))
      // An entry that carries another token does not hold this claim.
      yield* runnerLease.abandon("dag-kept", token(1))
      expect(calls.release).toEqual([
        { dagID: "dag-gone", token: token(4), now: yield* now },
        { dagID: "dag-kept", token: token(1), now: yield* now },
      ])
    }),
  )

  it.effect(
    "verify holds while the lease names the entry's token, and evicts the entry from a fiber of its own when it does not",
    () =>
      Effect.gen(function* () {
        const held = new Map<string, DagLease.Lease | undefined>([["dag-a", lease("dag-a", 3)]])
        const { leases } = scripted({ held: (dagID) => held.get(dagID) })
        const evicted: string[] = []
        const entry = { token: token(3) }
        const runnerLease = yield* started(leases, entries({ "dag-a": token(3) }), evicted)

        // The lease holds: nothing forks, nothing is evicted.
        expect(yield* runnerLease.verify("dag-a", entry)).toBe(true)
        expect(evicted).toEqual([])

        // Another runner took the lease over.
        held.set("dag-a", lease("dag-a", 4, "11:other"))
        expect(yield* runnerLease.verify("dag-a", entry)).toBe(false)
        yield* until(() => evicted.length === 1, "verify did not evict the entry whose lease another runner took")
        expect(evicted).toEqual(["dag-a"])

        // The workflow is gone or terminal: no lease to hold, the same verdict.
        held.set("dag-a", undefined)
        expect(yield* runnerLease.verify("dag-a", entry)).toBe(false)
        yield* until(() => evicted.length === 2, "verify did not evict the entry of a workflow that ended")
        expect(evicted).toEqual(["dag-a", "dag-a"])
      }),
  )

  describe("refused: a write under the entry's token that the write fence refused (ADR-0008 decision 5)", () => {
    /** `held` reads, counted: the fiber `refused` forks has made its decision once it has read. */
    const counted = (answer: (dagID: string) => Effect.Effect<DagLease.Lease | undefined>) => {
      const reads: string[] = []
      const { leases } = scripted({})
      return {
        reads,
        leases: {
          ...leases,
          held: (dagID: string) => Effect.sync(() => void reads.push(dagID)).pipe(Effect.andThen(() => answer(dagID))),
        } satisfies DagLease.Interface,
      }
    }

    it.effect(
      "evicts the entry that carries the token, from a fiber of its own, when another runner holds the lease",
      () =>
        Effect.gen(function* () {
          const { leases, reads } = counted(() => Effect.succeed(lease("dag-a", 4, "11:other")))
          const evicted: string[] = []
          const runnerLease = yield* started(leases, entries({ "dag-a": token(3) }), evicted)

          yield* runnerLease.refused("dag-a", token(3))

          yield* until(() => evicted.length === 1, "a refused write did not evict the entry whose lease was taken")
          expect(evicted).toEqual(["dag-a"])
          expect(reads).toEqual(["dag-a"])
        }),
    )

    it.effect("evicts when the same runner holds the row at a later epoch: the token is the pair", () =>
      Effect.gen(function* () {
        const { leases } = counted(() => Effect.succeed(lease("dag-a", 5)))
        const evicted: string[] = []
        const runnerLease = yield* started(leases, entries({ "dag-a": token(3) }), evicted)

        yield* runnerLease.refused("dag-a", token(3))

        yield* until(() => evicted.length === 1, "a refused write did not evict the entry of an older epoch")
      }),
    )

    it.effect(
      "leaves an entry alone that does not carry the token: an adoption in flight, or an entry that replaced it",
      () =>
        Effect.gen(function* () {
          const { leases, reads } = counted(() => Effect.succeed(lease("dag-a", 4, "11:other")))
          const evicted: string[] = []
          const runnerLease = yield* started(leases, entries({ "dag-b": token(3), "dag-a": token(4) }), evicted)

          // No entry at all for the workflow (the claim has not published one yet), and an entry of a later epoch.
          yield* runnerLease.refused("dag-none", token(3))
          yield* runnerLease.refused("dag-a", token(3))

          // Neither reads the lease: there is nothing to decide.
          expect(reads).toEqual([])
          expect(evicted).toEqual([])
        }),
    )

    it.effect(
      "leaves the entry of a workflow that ended to its terminal handler: no lease to read is not a takeover",
      () =>
        Effect.gen(function* () {
          const { leases, reads } = counted(() => Effect.succeed(undefined))
          const evicted: string[] = []
          const runnerLease = yield* started(leases, entries({ "dag-a": token(3) }), evicted)

          yield* runnerLease.refused("dag-a", token(3))

          yield* until(() => reads.length === 1, "the refused write's decision never read the lease")
          expect(evicted).toEqual([])
        }),
    )

    it.effect("leaves the entry alone when the row still names its token: the refusal was not a loss", () =>
      Effect.gen(function* () {
        const { leases, reads } = counted(() => Effect.succeed(lease("dag-a", 3)))
        const evicted: string[] = []
        const runnerLease = yield* started(leases, entries({ "dag-a": token(3) }), evicted)

        yield* runnerLease.refused("dag-a", token(3))

        yield* until(() => reads.length === 1, "the refused write's decision never read the lease")
        expect(evicted).toEqual([])
      }),
    )

    it.effect("a lease that cannot be read is not a lost lease: no eviction, and the next refusal looks again", () =>
      Effect.gen(function* () {
        let failures = 1
        const { leases, reads } = counted(() =>
          failures-- > 0
            ? Effect.die(new Error("SQLITE_BUSY: database is locked"))
            : Effect.succeed(lease("dag-a", 4, "11:other")),
        )
        const evicted: string[] = []
        const runnerLease = yield* started(leases, entries({ "dag-a": token(3) }), evicted)

        yield* runnerLease.refused("dag-a", token(3))
        yield* until(() => reads.length === 1, "the first refused write never read the lease")
        expect(evicted).toEqual([])

        yield* runnerLease.refused("dag-a", token(3))
        yield* until(() => evicted.length === 1, "the second refused write did not evict")
        expect(reads).toHaveLength(2)
      }),
    )

    it.effect(
      "refusals that arrive while an eviction is in flight start one eviction, and the next one may start another",
      () =>
        Effect.gen(function* () {
          const proceed = yield* Deferred.make<void>()
          const { leases, reads } = counted(() =>
            Deferred.await(proceed).pipe(Effect.as(lease("dag-a", 4, "11:other"))),
          )
          const evicted: string[] = []
          const runnerLease = yield* started(leases, entries({ "dag-a": token(3) }), evicted)

          // One refusal per fiber of the entry, all before the first decision is made.
          yield* runnerLease.refused("dag-a", token(3))
          yield* until(() => reads.length === 1, "the first refused write never started its decision")
          yield* runnerLease.refused("dag-a", token(3))
          yield* runnerLease.refused("dag-a", token(3))
          yield* Deferred.succeed(proceed, undefined)
          yield* until(() => evicted.length === 1, "the eviction never ran")

          expect(reads).toHaveLength(1)
          expect(evicted).toEqual(["dag-a"])

          // The first eviction is over: a refusal after it is a new decision (the stub keeps the entry in the table).
          yield* runnerLease.refused("dag-a", token(3))
          yield* until(() => evicted.length === 2, "a refusal after the eviction was swallowed by the guard")
          expect(reads).toHaveLength(2)
        }),
    )
  })

  it.effect("it renews every entry once per period and evicts the ones whose lease it lost", () =>
    Effect.gen(function* () {
      const { leases, calls } = scripted({ renew: (dagID) => Effect.succeed(dagID !== "dag-lost") })
      const evicted: string[] = []
      yield* started(leases, entries({ "dag-a": token(1), "dag-lost": token(2), "dag-b": token(3) }), evicted)

      // Not a period yet: the renewal fiber is still asleep.
      yield* TestClock.adjust(`${DagLease.RENEWAL_PERIOD_MS - 1} millis`)
      expect(calls.renew).toEqual([])

      yield* TestClock.adjust("1 millis")
      yield* until(() => evicted.length === 1, "the first tick did not evict the workflow whose lease was lost")
      expect(calls.renew).toEqual([
        { dagID: "dag-a", token: token(1), now: DagLease.RENEWAL_PERIOD_MS },
        { dagID: "dag-lost", token: token(2), now: DagLease.RENEWAL_PERIOD_MS },
        { dagID: "dag-b", token: token(3), now: DagLease.RENEWAL_PERIOD_MS },
      ])
      expect(evicted).toEqual(["dag-lost"])

      // The evicted workflow stays in the table here (the loop drops it in `evict`), so it is asked again.
      yield* TestClock.adjust(PERIOD)
      yield* until(() => evicted.length === 2, "the second tick did not run")
      expect(calls.renew).toHaveLength(6)
    }),
  )

  it.effect(
    "it runs the round after the renewals of every tick, and tells it nothing about the clock while the ticks are on time",
    () =>
      Effect.gen(function* () {
        const { leases, calls } = scripted({})
        const rounds: Array<{ readonly afterClockJump: boolean; readonly renewed: number }> = []
        yield* started(leases, entries({ "dag-a": token(1) }), [], undefined, (input) =>
          Effect.sync(() => void rounds.push({ afterClockJump: input.afterClockJump, renewed: calls.renew.length })),
        )

        // Not a period yet: no tick, no round.
        yield* TestClock.adjust(`${DagLease.RENEWAL_PERIOD_MS - 1} millis`)
        expect(rounds).toEqual([])
        yield* TestClock.adjust("1 millis")
        yield* until(() => rounds.length === 1, "the first tick did not run its round")
        for (let tick = 1; tick < 4; tick++) {
          yield* TestClock.adjust(PERIOD)
          yield* until(() => rounds.length === tick + 1, `tick ${tick + 1} did not run its round`)
        }

        // The renewal of a tick is over when its round starts, and a tick every period is no jump.
        expect(rounds).toEqual([1, 2, 3, 4].map((renewed) => ({ afterClockJump: false, renewed })))
      }),
  )

  // ADR-0008 decision 2: the gap is between the starts of two ticks, and the quiet period that follows it is two periods
  // of the clock. A tick whose renewal is stuck (a suspended machine stops the process in the middle of it) is not late
  // itself: it started on time. The tick after it is.
  it.effect(
    "it tells the round of a clock jump: the tick that starts more than two periods after the one before, and the ticks of the two periods after it",
    () =>
      Effect.gen(function* () {
        const suspended = yield* Deferred.make<void>()
        let renewals = 0
        const { leases } = scripted({
          // The first renewal is the one the machine went to sleep in.
          renew: () => (++renewals === 1 ? Deferred.await(suspended).pipe(Effect.as(true)) : Effect.succeed(true)),
        })
        const rounds: boolean[] = []
        yield* started(leases, entries({ "dag-a": token(1) }), [], undefined, (input) =>
          Effect.sync(() => void rounds.push(input.afterClockJump)),
        )

        yield* TestClock.adjust(PERIOD)
        yield* until(() => renewals === 1, "the first tick did not start its renewal")
        yield* TestClock.adjust(PAST_TTL)
        yield* Deferred.succeed(suspended, undefined)
        yield* until(() => rounds.length === 1, "the round of the first tick did not run after the machine woke up")

        // The tick that was stuck started on time; the three after it start 30 s apart, the first of them 150 s late.
        for (let tick = 1; tick < 4; tick++) {
          yield* TestClock.adjust(PERIOD)
          yield* until(() => rounds.length === tick + 1, `tick ${tick + 1} did not run its round`)
        }
        expect(rounds).toEqual([false, true, true, false])
      }),
  )

  // The watch is one value: the reading that sees the jump first, a tick's or an observation's, starts the quiet period
  // for the other.
  it.effect(
    "a jump that an observation of the reconciler was the first to see starts the quiet period of the ticks too",
    () =>
      Effect.gen(function* () {
        const suspended = yield* Deferred.make<void>()
        let renewals = 0
        const { leases } = scripted({
          renew: () => (++renewals === 1 ? Deferred.await(suspended).pipe(Effect.as(true)) : Effect.succeed(true)),
        })
        const rounds: boolean[] = []
        const runnerLease = yield* started(leases, entries({ "dag-a": token(1) }), [], undefined, (input) =>
          Effect.sync(() => void rounds.push(input.afterClockJump)),
        )

        // The machine sleeps in the middle of the first tick's renewal, and when it wakes an observation of the
        // reconciler is the first to read the clock.
        yield* TestClock.adjust(PERIOD)
        yield* until(() => renewals === 1, "the first tick did not start its renewal")
        yield* TestClock.adjust(PAST_TTL)
        expect(runnerLease.noteClock(yield* now)).toBe(true)
        yield* Deferred.succeed(suspended, undefined)
        yield* until(() => rounds.length === 1, "the round of the first tick did not run")

        // The tick 30 s after it is on time with respect to that reading and still follows the jump; the one after is
        // two periods on and does not.
        for (let tick = 1; tick < 3; tick++) {
          yield* TestClock.adjust(PERIOD)
          yield* until(() => rounds.length === tick + 1, `tick ${tick + 1} did not run its round`)
        }
        expect(rounds).toEqual([false, true, false])
      }),
  )

  it.effect(
    "noteClock answers for the instance's watch, which starts with the instance and tells a jump from two periods on",
    () =>
      Effect.gen(function* () {
        const { leases } = scripted({})
        const runnerLease = yield* started(leases, entries({}))
        const PERIOD_MS = DagLease.RENEWAL_PERIOD_MS

        // Seeded at the start of the instance, the clock's 0: a first reading two periods on is not a jump, one a
        // millisecond later is, and every reading within two periods of that is after it.
        expect(runnerLease.noteClock(2 * PERIOD_MS)).toBe(false)
        expect(runnerLease.noteClock(4 * PERIOD_MS + 1)).toBe(true)
        expect(runnerLease.noteClock(5 * PERIOD_MS)).toBe(true)
        expect(runnerLease.noteClock(6 * PERIOD_MS + 1)).toBe(false)
      }),
  )

  it.effect(
    "noteClock sees the readings of the ticks: a tick is the reading that a late observation is measured from",
    () =>
      Effect.gen(function* () {
        const { leases } = scripted({})
        const runnerLease = yield* started(leases, entries({}))

        // The first tick reads the clock at 30 s. 85 s is 55 s after that and 85 s after the start, which is a jump if
        // the tick did not feed the watch.
        yield* TestClock.adjust(PERIOD)
        expect(runnerLease.noteClock(85_000)).toBe(false)
      }),
  )

  it.effect("it keeps renewing when its round dies, and runs the round again at the next tick", () =>
    Effect.gen(function* () {
      const { leases, calls } = scripted({})
      let failures = 1
      let runs = 0
      yield* started(leases, entries({ "dag-a": token(1) }), [], undefined, () =>
        Effect.suspend(() => {
          runs++
          return failures-- > 0 ? Effect.die(new Error("SQLITE_BUSY: database is locked")) : Effect.void
        }),
      )

      yield* TestClock.adjust(PERIOD)
      yield* until(() => runs === 1, "the first tick did not run its round")
      yield* TestClock.adjust(PERIOD)
      yield* until(() => runs === 2, "the second tick did not run its round")

      // The renewals of both ticks went through: a round that dies costs nothing but itself.
      expect(calls.renew).toHaveLength(2)
    }),
  )

  it.effect("a round that throws instead of returning an effect costs the tick nothing and frees the slot", () =>
    Effect.gen(function* () {
      const { leases, calls } = scripted({})
      let runs = 0
      yield* started(leases, entries({ "dag-a": token(1) }), [], undefined, () => {
        if (++runs === 1) throw new Error("not an effect")
        return Effect.void
      })

      yield* TestClock.adjust(PERIOD)
      yield* until(() => runs === 1, "the first tick did not start its round")
      yield* TestClock.adjust(PERIOD)
      yield* until(() => runs === 2, "the next tick did not start another round: the slot was never freed")

      expect(calls.renew).toHaveLength(2)
    }),
  )

  // ADR-0008 decision 2: the renewals are the owner's proof of life, and a round can wait for a worktree removal, the
  // lifecycle lock or a user hook for longer than the TTL. It must not hold them up, or another runner takes over a
  // workflow this one still drives.
  it.effect("a round that outlasts the TTL delays no renewal, and no second round starts beside it", () =>
    Effect.gen(function* () {
      const { leases, calls } = scripted({})
      const blocked = yield* Deferred.make<void>()
      const told: boolean[] = []
      yield* started(leases, entries({ "dag-a": token(1) }), [], undefined, (input) =>
        Effect.suspend(() => {
          told.push(input.afterClockJump)
          return told.length === 1 ? Deferred.await(blocked) : Effect.void
        }),
      )

      // Five periods, more than the TTL, and the round of the first tick never ends.
      for (let tick = 1; tick <= 5; tick++) {
        yield* TestClock.adjust(PERIOD)
        yield* until(() => calls.renew.length === tick, `tick ${tick} did not renew: the round held the tick up`)
      }
      expect(DagLease.RENEWAL_PERIOD_MS * 5).toBeGreaterThan(DagLease.TTL_MS)
      expect(calls.renew.map((call) => call.now)).toEqual(
        [1, 2, 3, 4, 5].map((tick) => tick * DagLease.RENEWAL_PERIOD_MS),
      )
      // The first tick started the round; the four after it found it running and started none.
      expect(told).toEqual([false])

      // It ends, and the next tick starts another. A round that is only long is no clock jump: every tick fed the
      // watch on time, so the tick after it is told none.
      yield* Deferred.succeed(blocked, undefined)
      yield* TestClock.adjust(PERIOD)
      yield* until(() => told.length === 2, "the tick after the round ended did not start another")
      expect(told).toEqual([false, false])
    }),
  )

  it.effect("a round in flight when the instance closes is interrupted, and the leases are given back after it", () =>
    Effect.gen(function* () {
      const order: string[] = []
      const { leases } = scripted({ release: () => Effect.sync(() => (order.push("release"), true)) })
      const scope = yield* Scope.make()
      let running = false
      yield* started(leases, entries({ "dag-a": token(1) }), [], scope, () =>
        Effect.sync(() => void (running = true)).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(() => void order.push("round interrupted"))),
        ),
      )
      yield* TestClock.adjust(PERIOD)
      yield* until(() => running, "the first tick did not start its round")

      yield* Scope.close(scope, Exit.void)

      expect(order).toEqual(["round interrupted", "release"])
    }),
  )

  it.effect("evict drops an entry whose lease the reconciler found lost, as a renewal that finds the same does", () =>
    Effect.gen(function* () {
      const { leases } = scripted({})
      const evicted: string[] = []
      const entry = { token: token(2) }
      const runnerLease = yield* started(leases, entries({ "dag-a": token(2) }), evicted)

      yield* runnerLease.evict("dag-a", entry)

      expect(evicted).toEqual(["dag-a"])
    }),
  )

  it.effect("a renewal that dies is retried at the next tick and never read as a lost lease", () =>
    Effect.gen(function* () {
      let failures = 1
      const { leases, calls } = scripted({
        renew: () => (failures-- > 0 ? Effect.die(new Error("SQLITE_BUSY: database is locked")) : Effect.succeed(true)),
      })
      const evicted: string[] = []
      yield* started(leases, entries({ "dag-a": token(1) }), evicted)

      yield* TestClock.adjust(PERIOD)
      yield* until(() => calls.renew.length === 1, "the first tick did not renew")

      // The second tick can only start after the first one ended, and that one died without evicting.
      yield* TestClock.adjust(PERIOD)
      yield* until(() => calls.renew.length === 2, "the second tick did not renew")
      expect(evicted).toEqual([])
    }),
  )

  it.effect("at a clean exit it releases what it holds, after its own fiber stopped", () =>
    Effect.gen(function* () {
      const { leases, calls } = scripted({})
      const scope = yield* Scope.make()
      yield* started(leases, entries({ "dag-a": token(1), "dag-b": token(2) }), [], scope)

      yield* TestClock.adjust(PERIOD)
      yield* until(() => calls.renew.length === 2, "the tick did not renew both entries")
      expect(calls.release).toEqual([])

      yield* Scope.close(scope, Exit.void)
      expect(calls.release.map((call) => [call.dagID, call.token])).toEqual([
        ["dag-a", token(1)],
        ["dag-b", token(2)],
      ])
      // The renewal fiber is gone: three periods go by and nothing wakes to renew
      // (`adjust` runs every fiber it wakes to its next suspension before it returns).
      yield* TestClock.adjust(`${DagLease.RENEWAL_PERIOD_MS * 3} millis`)
      expect(calls.renew).toHaveLength(2)
    }),
  )

  it.effect("a release that dies at exit does not stop the others or the exit", () =>
    Effect.gen(function* () {
      let failures = 1
      const { leases, calls } = scripted({
        release: () => (failures-- > 0 ? Effect.die(new Error("SQLITE_BUSY")) : Effect.succeed(true)),
      })
      const scope = yield* Scope.make()
      yield* started(leases, entries({ "dag-a": token(1), "dag-b": token(2) }), [], scope)

      yield* Scope.close(scope, Exit.void)

      expect(calls.release.map((call) => call.dagID)).toEqual(["dag-a", "dag-b"])
    }),
  )
})

describe("RunnerLease.evictor", () => {
  const own = RunnerLease.attached

  /**
   * An entry with a fiber and a watcher per node, all alive until the evictor
   * interrupts them. `children` is what each node's attempt recorded of its
   * child session: a function that answers it (or `undefined` while the attempt
   * has none), or `null` for a fiber nobody recorded anything for.
   */
  const entryOf = (children: Record<string, (() => string | undefined) | null>) =>
    Effect.gen(function* () {
      const fibers = new Map<string, Fiber.Fiber<unknown, unknown>>()
      const watchers = new Map<string, Fiber.Fiber<unknown, unknown>>()
      const attemptChild: RunnerLease.Evictable["attemptChild"] = new WeakMap()
      for (const [nodeID, child] of Object.entries(children)) {
        const fiber = yield* Effect.forkScoped(Effect.never)
        fibers.set(nodeID, fiber)
        watchers.set(nodeID, yield* Effect.forkScoped(Effect.never))
        if (child !== null) attemptChild.set(fiber, child)
      }
      return {
        token: { runnerID: "10:test", epoch: 1 },
        parentSessionID: "ses_parent",
        evalLock: Semaphore.makeUnsafe(1),
        fibers,
        watchers,
        attemptChild,
      }
    })

  const evictorOver = (
    table: Map<string, RunnerLease.Evictable>,
    log: { readonly aborted: string[]; readonly unregistered: string[] },
    unregister?: Effect.Effect<void>,
  ) =>
    RunnerLease.evictor({
      entries: table,
      abort: (_dagID, nodeID, childSessionID) =>
        Effect.sync(() => void log.aborted.push(`${nodeID}:${childSessionID}`)),
      unregister: (_entry, dagID) => unregister ?? Effect.sync(() => void log.unregistered.push(dagID)),
    })

  const interrupted = (fiber: Fiber.Fiber<unknown, unknown>) =>
    Fiber.await(fiber).pipe(Effect.map((exit) => Exit.isFailure(exit)))

  it.effect(
    "aborts the children, interrupts the fibers and watchers, drops the entry and gives up the registration, once",
    () =>
      Effect.gen(function* () {
        const entry = yield* entryOf({ n1: own("ses_n1"), n2: own("ses_n2") })
        const fibers = [...entry.fibers.values(), ...entry.watchers.values()]
        const table = new Map([["dag-a", entry]])
        const log = { aborted: [] as string[], unregistered: [] as string[] }
        const evict = evictorOver(table, log)

        yield* evict("dag-a", entry)

        expect(log.aborted).toEqual(["n1:ses_n1", "n2:ses_n2"])
        for (const fiber of fibers) expect(yield* interrupted(fiber)).toBe(true)
        expect(table.has("dag-a")).toBe(false)
        expect(entry.fibers.size + entry.watchers.size).toBe(0)
        expect(log.unregistered).toEqual(["dag-a"])

        // A second eviction finds nothing to do.
        yield* evict("dag-a", entry)
        expect(log.aborted).toHaveLength(2)
        expect(log.unregistered).toEqual(["dag-a"])
      }),
  )

  it.effect(
    "aborts what each fiber's own attempt recorded, as it stands at eviction, and nothing for a fiber without a child",
    () =>
      Effect.gen(function* () {
        let created: string | undefined
        // n1 has its child. n2's attempt still waits for its permit. n3's attempt creates its child after its fiber was
        // registered and before the eviction. n4's fiber has no record at all.
        const entry = yield* entryOf({ n1: own("ses_n1"), n2: () => undefined, n3: () => created, n4: null })
        created = "ses_n3"
        const fibers = [...entry.fibers.values()]
        const log = { aborted: [] as string[], unregistered: [] as string[] }

        yield* evictorOver(new Map([["dag-a", entry]]), log)("dag-a", entry)

        expect(log.aborted).toEqual(["n1:ses_n1", "n3:ses_n3"])
        // A fiber without a child is interrupted all the same.
        for (const fiber of fibers) expect(yield* interrupted(fiber)).toBe(true)
      }),
  )

  it.effect("leaves an entry alone that the table no longer holds", () =>
    Effect.gen(function* () {
      const entry = yield* entryOf({ n1: own("ses_n1") })
      const log = { aborted: [] as string[], unregistered: [] as string[] }

      yield* evictorOver(new Map(), log)("dag-a", entry)

      expect(log).toEqual({ aborted: [], unregistered: [] })
      expect(entry.fibers.size).toBe(1)
      // Still running: nobody interrupted it.
      expect(entry.fibers.get("n1")?.pollUnsafe()).toBeUndefined()
    }),
  )

  it.effect("a registration that cannot be given up does not fail the eviction", () =>
    Effect.gen(function* () {
      const entry = yield* entryOf({ n1: own("ses_n1") })
      const table = new Map([["dag-a", entry]])
      const log = { aborted: [] as string[], unregistered: [] as string[] }

      yield* evictorOver(table, log, Effect.die(new Error("registry defect")))("dag-a", entry)

      expect(table.has("dag-a")).toBe(false)
      expect(log.aborted).toEqual(["n1:ses_n1"])
    }),
  )
})

/**
 * The reconciler's eviction (`RunnerLease.Interface.evict`, ADR-0008 decision 6, row 3) over the real evictor and a
 * scripted lease. Its verdict rests on reads that are older than the entry's lock, and a workflow that ended meanwhile
 * belongs to its terminal handler (the worktree settlement, the wake of the parent): the eviction reads the lease row
 * again under the lock, and goes on only while the row shows another holder.
 */
describe("RunnerLease.evict: the reconciler's eviction re-reads the lease under the entry's lock", () => {
  const RUNNER = "10:test"
  const OTHER = "11:other"
  const token = (epoch: number): DagLease.Token => ({ runnerID: RUNNER, epoch })
  const lease = (epoch: number, runnerID: string): DagLease.Lease => ({ dagID: "dag-a", runnerID, epoch, expiresAt: 0 })

  /** An entry with one running fiber and the child its attempt recorded. */
  const entryOf = Effect.gen(function* () {
    const fiber = yield* Effect.forkScoped(Effect.never)
    const attemptChild: RunnerLease.Evictable["attemptChild"] = new WeakMap()
    attemptChild.set(fiber, RunnerLease.attached("ses_n1"))
    return {
      token: token(3),
      parentSessionID: "ses_parent",
      evalLock: Semaphore.makeUnsafe(1),
      fibers: new Map([["n1", fiber]]),
      watchers: new Map<string, Fiber.Fiber<unknown, unknown>>(),
      attemptChild,
    }
  })

  const setup = (answer: () => Effect.Effect<DagLease.Lease | undefined>) =>
    Effect.gen(function* () {
      const entry = yield* entryOf
      const table = new Map([["dag-a", entry]])
      const log = { aborted: [] as string[], unregistered: [] as string[] }
      const leases: DagLease.Interface = {
        claim: () => Effect.succeed(undefined),
        renew: () => Effect.succeed(true),
        release: () => Effect.succeed(true),
        held: () => answer(),
      }
      const runnerLease = yield* RunnerLease.make({
        leases,
        runnerID: RUNNER,
        entries: table,
        evict: RunnerLease.evictor({
          entries: table,
          abort: (_dagID, nodeID, childSessionID) =>
            Effect.sync(() => void log.aborted.push(`${nodeID}:${childSessionID}`)),
          unregister: (_entry, dagID) => Effect.sync(() => void log.unregistered.push(dagID)),
        }),
      })
      return { entry, table, log, runnerLease }
    })

  const untouched = (input: Effect.Success<ReturnType<typeof setup>>) => {
    expect(input.table.get("dag-a")).toBe(input.entry)
    expect(input.log).toEqual({ aborted: [], unregistered: [] })
    expect(input.entry.fibers.size).toBe(1)
    // Still running: nobody interrupted it.
    expect(input.entry.fibers.get("n1")?.pollUnsafe()).toBeUndefined()
  }

  it.effect("evicts the entry while the row shows another holder", () =>
    Effect.gen(function* () {
      const input = yield* setup(() => Effect.succeed(lease(4, OTHER)))

      yield* input.runnerLease.evict("dag-a", input.entry)

      expect(input.table.has("dag-a")).toBe(false)
      expect(input.log).toEqual({ aborted: ["n1:ses_n1"], unregistered: ["dag-a"] })
    }),
  )

  it.effect("evicts it when the same runner holds the row at a later epoch: the token is the pair", () =>
    Effect.gen(function* () {
      const input = yield* setup(() => Effect.succeed(lease(4, RUNNER)))

      yield* input.runnerLease.evict("dag-a", input.entry)

      expect(input.table.has("dag-a")).toBe(false)
    }),
  )

  // The workflow ended: `DagLease.held` has no row for it, and its terminal handler is the one to settle the entry.
  it.effect("leaves the entry of a workflow that ended to its terminal handler", () =>
    Effect.gen(function* () {
      const input = yield* setup(() => Effect.succeed(undefined))

      yield* input.runnerLease.evict("dag-a", input.entry)

      untouched(input)
    }),
  )

  it.effect("leaves the entry alone when the row names its token after all", () =>
    Effect.gen(function* () {
      const input = yield* setup(() => Effect.succeed(lease(3, RUNNER)))

      yield* input.runnerLease.evict("dag-a", input.entry)

      untouched(input)
    }),
  )

  it.effect(
    "leaves the entry alone when the row cannot be read: that is not a lost lease, and the next round looks",
    () =>
      Effect.gen(function* () {
        const input = yield* setup(() => Effect.die(new Error("SQLITE_BUSY: database is locked")))

        yield* input.runnerLease.evict("dag-a", input.entry)

        untouched(input)
      }),
  )

  // What makes it a re-read "under the lock": a handler of the entry holds `evalLock` when the eviction starts, and the
  // workflow ends while the eviction waits for it. A read before the lock would still have seen the other holder.
  it.effect("reads the row once it holds the entry's lock, not before it", () =>
    Effect.gen(function* () {
      let row: DagLease.Lease | undefined = lease(4, OTHER)
      const input = yield* setup(() => Effect.sync(() => row))
      yield* input.entry.evalLock.take(1)

      const eviction = yield* input.runnerLease
        .evict("dag-a", input.entry)
        .pipe(Effect.forkChild({ startImmediately: true }))
      row = undefined
      yield* input.entry.evalLock.release(1)
      yield* Fiber.join(eviction)

      untouched(input)
    }),
  )

  // PR2's `verify` and the renewal evict a workflow whose row is gone as before: bringing them in line is PR4b's.
  it.effect("is the reconciler's alone: verify still evicts the entry of a workflow that ended", () =>
    Effect.gen(function* () {
      const input = yield* setup(() => Effect.succeed(undefined))

      expect(yield* input.runnerLease.verify("dag-a", input.entry)).toBe(false)
      yield* pollOnTestClock(
        Effect.sync(() => (input.table.has("dag-a") ? undefined : true)),
        "verify did not evict the entry of a workflow that ended",
      )

      expect(input.log.unregistered).toEqual(["dag-a"])
    }),
  )
})
