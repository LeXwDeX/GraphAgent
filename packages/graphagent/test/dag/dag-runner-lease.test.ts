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
 * (TTL 90 s, renewal every 30 s). Two things to keep in mind when reading:
 *   - a stalled process is `runner.freeze()`: it parks the lease operations too,
 *     so a frozen runner renews nothing while the clock moves on;
 *   - a renewal is a background tick, so a test waits for its effect with
 *     `pollOnTestClock` (which moves the clock by a few milliseconds per round)
 *     and compares with inequalities, not with the exact tick time.
 * The last group has no database at all: it runs `RunnerLease` over a scripted
 * `DagLease` and a plain table of entries, one rule per test.
 */

import { describe, expect } from "bun:test"
import { Clock, Deferred, Effect, Exit, Layer, Option, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { DagLease } from "@graphagent/core/dag/lease"
import { RunnerLease } from "@/dag/runtime/runner-lease"
import { EngineProcess } from "@/session/engine-process"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import {
  PARENT_SESSION_ID,
  PROJECT_ID,
  driveOnR1,
  makeDualRunner,
  node,
  pollOnTestClock,
  type DualRunner,
} from "./fixture/dual-runner"

const it = testEffect(Layer.empty)

const PERIOD = `${DagLease.RENEWAL_PERIOD_MS} millis`
/** More than `DagLease.TTL_MS`: what a stall has to outlast for another runner to take its lease. */
const PAST_TTL = "2 minutes"

const now = Clock.currentTimeMillis

/** Let the runners' background fibers run: a real tick of the event loop, which the TestClock does not give. */
const drain = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 25)))

const rowOf = (dual: DualRunner, dagID: string) =>
  dual
    .leaseRow(dagID)
    .pipe(
      Effect.flatMap((row) =>
        row === undefined ? Effect.die(new Error(`no lease row for ${dagID}`)) : Effect.succeed(row),
      ),
    )

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

      // R2's WorkflowReplanned handler finds no entry and tries to recover the workflow.
      yield* dual.r2.dag.extend(dagID, [node("m")])
      yield* drain

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
      // The terminal event handler drops the runtime entry.
      yield* drain
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
      yield* dual.r1.dag.extend(dagID, [node("m")])
      yield* drain
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
  ) => {
    const effect = RunnerLease.make({
      leases,
      runnerID: RUNNER,
      entries: table,
      evict: (dagID) => Effect.sync(() => void evicted.push(dagID)),
    })
    return scope ? Effect.provideService(effect, Scope.Scope, scope) : effect
  }

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

  it.effect("it renews every entry once per period and evicts the ones whose lease it lost", () =>
    Effect.gen(function* () {
      const { leases, calls } = scripted({ renew: (dagID) => Effect.succeed(dagID !== "dag-lost") })
      const evicted: string[] = []
      yield* started(leases, entries({ "dag-a": token(1), "dag-lost": token(2), "dag-b": token(3) }), evicted)

      yield* TestClock.adjust(`${DagLease.RENEWAL_PERIOD_MS - 1} millis`)
      yield* drain
      expect(calls.renew).toEqual([])

      yield* TestClock.adjust("1 millis")
      yield* drain
      expect(calls.renew).toEqual([
        { dagID: "dag-a", token: token(1), now: DagLease.RENEWAL_PERIOD_MS },
        { dagID: "dag-lost", token: token(2), now: DagLease.RENEWAL_PERIOD_MS },
        { dagID: "dag-b", token: token(3), now: DagLease.RENEWAL_PERIOD_MS },
      ])
      expect(evicted).toEqual(["dag-lost"])

      // The evicted workflow stays in the table here (the loop drops it in `evict`), so it is asked again.
      yield* TestClock.adjust(PERIOD)
      yield* drain
      expect(calls.renew).toHaveLength(6)
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
      yield* drain
      expect(calls.renew).toHaveLength(1)
      expect(evicted).toEqual([])

      yield* TestClock.adjust(PERIOD)
      yield* drain
      expect(calls.renew).toHaveLength(2)
      expect(evicted).toEqual([])
    }),
  )

  it.effect("at a clean exit it releases what it holds, after its own fiber stopped", () =>
    Effect.gen(function* () {
      const { leases, calls } = scripted({})
      const scope = yield* Scope.make()
      yield* started(leases, entries({ "dag-a": token(1), "dag-b": token(2) }), [], scope)

      yield* TestClock.adjust(PERIOD)
      yield* drain
      expect(calls.renew).toHaveLength(2)
      expect(calls.release).toEqual([])

      yield* Scope.close(scope, Exit.void)
      expect(calls.release.map((call) => [call.dagID, call.token])).toEqual([
        ["dag-a", token(1)],
        ["dag-b", token(2)],
      ])
      // The renewal fiber is gone: time passing renews nothing more.
      yield* TestClock.adjust(`${DagLease.RENEWAL_PERIOD_MS * 3} millis`)
      yield* drain
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
