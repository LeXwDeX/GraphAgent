// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1029 / ADR-0008, PR1: the `dag_runner` lease table and the `DagLease`
 * primitives (`claim`, `renew`, `release`, `held`).
 *
 * The primitives take the runner id and `now` as arguments and read neither
 * `EngineProcess.runner` nor a clock. The table-driven tests below therefore
 * pass literal runner ids and times; the TestClock tests read `now` from
 * `Clock.currentTimeMillis` the way the runtime will, and run both sides on
 * one clock.
 */

import { describe, expect, test } from "bun:test"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { DagLease } from "@graphagent/core/dag/lease"
import { Database } from "@graphagent/core/database/database"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// `pid:nonce`, the vocabulary of every runner id.
const A = "100:aaaa"
const B = "200:bbbb"
const TTL = DagLease.TTL_MS
const DAG = "wf"

const database = Database.layerFromPath(":memory:")
const it = testEffect(Layer.provideMerge(DagLease.layer, database))

interface LeaseRow {
  runner_id: string
  epoch: number
  expires_at: number
}

/** A parent session and one workflow per entry, in the given status. */
const seed = (workflows: Readonly<Record<string, string>> = { [DAG]: "running" }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(
      sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES ('p',${process.cwd()},'[]',1,1)`,
    )
    yield* db.run(
      sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES ('s','p',NULL,'s',${process.cwd()},'s','test',1,1)`,
    )
    for (const [id, status] of Object.entries(workflows))
      yield* db.run(
        sql`INSERT INTO workflow (id,project_id,session_id,directory,target_fingerprint,title,status,config,seq,time_created,time_updated) VALUES (${id},'p','s',${process.cwd()},'{"kind":"none"}','W',${status},'{}',1,1,1)`,
      )
  }).pipe(Effect.orDie)

/** Write a lease row directly, bypassing the primitives, to start a case from an exact state. */
const put = (runnerID: string, epoch: number, expiresAt: number, dagID = DAG) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(
      sql`INSERT INTO dag_runner (dag_id,runner_id,epoch,expires_at) VALUES (${dagID},${runnerID},${epoch},${expiresAt})`,
    )
  }).pipe(Effect.orDie)

/** The stored row of one workflow, straight from the table. */
const rowOf = (dagID = DAG) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db.get<LeaseRow>(sql`SELECT runner_id, epoch, expires_at FROM dag_runner WHERE dag_id = ${dagID}`)
  }).pipe(Effect.orDie)

const rowCount = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return (yield* db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM dag_runner`))?.n
}).pipe(Effect.orDie)

const lease = (runnerID: string, epoch: number, expiresAt: number, dagID = DAG): DagLease.Lease => ({
  dagID,
  runnerID,
  epoch,
  expiresAt,
})

const stored = (runnerID: string, epoch: number, expiresAt: number): LeaseRow => ({
  runner_id: runnerID,
  epoch,
  expires_at: expiresAt,
})

describe("DagLease constants", () => {
  test("the TTL is 90 seconds and the renewal period 30 seconds (ADR-0008 decision 1)", () => {
    expect(DagLease.TTL_MS).toBe(90_000)
    expect(DagLease.RENEWAL_PERIOD_MS).toBe(30_000)
  })
})

describe("DagLease.holds", () => {
  const current = lease(A, 3, 5_000)
  test("compares the runner and the epoch, never the expiry", () => {
    expect(DagLease.holds(current, { runnerID: A, epoch: 3 })).toBe(true)
    expect(DagLease.holds(current, current)).toBe(true)
    expect(DagLease.holds(current, { runnerID: B, epoch: 3 })).toBe(false)
    expect(DagLease.holds(current, { runnerID: A, epoch: 2 })).toBe(false)
    expect(DagLease.holds(current, { runnerID: A, epoch: 4 })).toBe(false)
    expect(DagLease.holds(undefined, { runnerID: A, epoch: 3 })).toBe(false)
  })
})

describe("DagLease.claim", () => {
  // `before` is the stored row (absent: no row), A claims at now = 1_000. A
  // granted claim names A with `epoch` and expires at now + TTL; a refused one
  // leaves the row exactly as it was.
  const now = 1_000
  const cases: ReadonlyArray<{
    readonly name: string
    readonly before: LeaseRow | undefined
    readonly epoch: number | undefined
  }> = [
    { name: "no row: the first claim starts at epoch 1", before: undefined, epoch: 1 },
    {
      name: "the same runner again, lease live: renews in place, the epoch stays",
      before: stored(A, 3, now + 5_000),
      epoch: 3,
    },
    {
      name: "the same runner again, lease expired and nobody took it: the epoch stays",
      before: stored(A, 3, 500),
      epoch: 3,
    },
    { name: "another runner holds a live lease: refused", before: stored(B, 3, now + 5_000), epoch: undefined },
    { name: "another runner, one millisecond left: refused", before: stored(B, 3, now + 1), epoch: undefined },
    { name: "another runner, expiring exactly now: taken over, epoch + 1", before: stored(B, 3, now), epoch: 4 },
    { name: "another runner, expired: taken over, epoch + 1", before: stored(B, 3, 500), epoch: 4 },
    { name: "another runner, expired long ago: taken over, epoch + 1", before: stored(B, 41, 0), epoch: 42 },
  ]
  for (const item of cases)
    it.effect(item.name, () =>
      Effect.gen(function* () {
        yield* seed()
        const leases = yield* DagLease.Service
        if (item.before) yield* put(item.before.runner_id, item.before.epoch, item.before.expires_at)

        const granted = yield* leases.claim({ dagID: DAG, runnerID: A, now })

        if (item.epoch === undefined) {
          expect(granted).toBeUndefined()
          expect(yield* rowOf()).toEqual(item.before)
          return
        }
        expect(granted).toEqual(lease(A, item.epoch, now + TTL))
        expect(yield* rowOf()).toEqual(stored(A, item.epoch, now + TTL))
      }),
    )

  it.effect("a refused claim does not move the other runner's expiry", () =>
    Effect.gen(function* () {
      yield* seed()
      const leases = yield* DagLease.Service
      yield* put(B, 2, 50_000)

      for (const at of [1_000, 20_000, 49_999])
        expect(yield* leases.claim({ dagID: DAG, runnerID: A, now: at })).toBeUndefined()

      expect(yield* rowOf()).toEqual(stored(B, 2, 50_000))
    }),
  )

  it.effect("claims are per workflow: one runner can hold several, and each epoch is its own", () =>
    Effect.gen(function* () {
      yield* seed({ one: "running", two: "paused" })
      const leases = yield* DagLease.Service
      yield* put(B, 5, 0, "two")

      expect(yield* leases.claim({ dagID: "one", runnerID: A, now: 1_000 })).toEqual(lease(A, 1, 1_000 + TTL, "one"))
      expect(yield* leases.claim({ dagID: "two", runnerID: A, now: 1_000 })).toEqual(lease(A, 6, 1_000 + TTL, "two"))
      expect(yield* leases.claim({ dagID: "one", runnerID: B, now: 1_000 })).toBeUndefined()
    }),
  )
})

describe("DagLease.claim admission (#270)", () => {
  for (const status of ["pending", "running", "paused", "stepping"])
    it.effect(`a ${status} workflow can be claimed`, () =>
      Effect.gen(function* () {
        yield* seed({ [DAG]: status })
        const leases = yield* DagLease.Service

        expect(yield* leases.claim({ dagID: DAG, runnerID: A, now: 1_000 })).toEqual(lease(A, 1, 1_000 + TTL))
      }),
    )

  for (const status of ["completed", "failed", "cancelled"]) {
    it.effect(`a ${status} workflow is refused and no row is written`, () =>
      Effect.gen(function* () {
        yield* seed({ [DAG]: status })
        const leases = yield* DagLease.Service

        expect(yield* leases.claim({ dagID: DAG, runnerID: A, now: 1_000 })).toBeUndefined()
        expect(yield* rowCount).toBe(0)
        expect(yield* leases.held(DAG)).toBeUndefined()
      }),
    )

    it.effect(`a ${status} workflow is refused even for the runner that holds its lease`, () =>
      Effect.gen(function* () {
        yield* seed({ [DAG]: "running" })
        const leases = yield* DagLease.Service
        const granted = yield* leases.claim({ dagID: DAG, runnerID: A, now: 1_000 })
        expect(granted).toBeDefined()
        const { db } = yield* Database.Service
        yield* db.run(sql`UPDATE workflow SET status = ${status} WHERE id = ${DAG}`).pipe(Effect.orDie)

        expect(yield* leases.claim({ dagID: DAG, runnerID: A, now: 2_000 })).toBeUndefined()
        // The row itself is untouched: a refused claim writes nothing.
        expect(yield* rowOf()).toEqual(stored(A, 1, 1_000 + TTL))
        expect(yield* leases.held(DAG)).toBeUndefined()
      }),
    )
  }

  it.effect("a workflow that does not exist is refused and no row is written", () =>
    Effect.gen(function* () {
      yield* seed()
      const leases = yield* DagLease.Service

      expect(yield* leases.claim({ dagID: "missing", runnerID: A, now: 1_000 })).toBeUndefined()
      expect(yield* rowCount).toBe(0)
      expect(yield* leases.held("missing")).toBeUndefined()
    }),
  )
})

describe("DagLease.renew", () => {
  // The stored row is (A, epoch 3, expires 2_000); renewal happens at now = 1_000.
  const now = 1_000
  const cases: ReadonlyArray<{
    readonly name: string
    readonly before: LeaseRow | undefined
    readonly token: DagLease.Token
    readonly renewed: boolean
  }> = [
    {
      name: "the holder's token renews: expiry moves to now + TTL, the epoch stays",
      before: stored(A, 3, 2_000),
      token: { runnerID: A, epoch: 3 },
      renewed: true,
    },
    {
      name: "an expired lease that nobody took can still be renewed (no time comparison)",
      before: stored(A, 3, 500),
      token: { runnerID: A, epoch: 3 },
      renewed: true,
    },
    {
      name: "another runner's token does not renew",
      before: stored(A, 3, 2_000),
      token: { runnerID: B, epoch: 3 },
      renewed: false,
    },
    {
      name: "the right runner with an older epoch does not renew",
      before: stored(A, 3, 2_000),
      token: { runnerID: A, epoch: 2 },
      renewed: false,
    },
    {
      name: "the right runner with a newer epoch does not renew",
      before: stored(A, 3, 2_000),
      token: { runnerID: A, epoch: 4 },
      renewed: false,
    },
    {
      name: "no row: nothing to renew, and no row is created",
      before: undefined,
      token: { runnerID: A, epoch: 1 },
      renewed: false,
    },
  ]
  for (const item of cases)
    it.effect(item.name, () =>
      Effect.gen(function* () {
        yield* seed()
        const leases = yield* DagLease.Service
        if (item.before) yield* put(item.before.runner_id, item.before.epoch, item.before.expires_at)

        const renewed = yield* leases.renew({ dagID: DAG, token: item.token, now })

        expect(renewed).toBe(item.renewed)
        expect(yield* rowOf()).toEqual(
          item.renewed && item.before ? stored(item.before.runner_id, item.before.epoch, now + TTL) : item.before,
        )
      }),
    )

  it.effect("renewal never changes the epoch, however often it runs", () =>
    Effect.gen(function* () {
      yield* seed()
      const leases = yield* DagLease.Service
      const granted = yield* leases.claim({ dagID: DAG, runnerID: A, now: 0 })
      expect(granted?.epoch).toBe(1)

      for (let tick = 1; tick <= 5; tick++)
        expect(
          yield* leases.renew({ dagID: DAG, token: { runnerID: A, epoch: 1 }, now: tick * DagLease.RENEWAL_PERIOD_MS }),
        ).toBe(true)

      expect(yield* rowOf()).toEqual(stored(A, 1, 5 * DagLease.RENEWAL_PERIOD_MS + TTL))
    }),
  )
})

describe("DagLease.release", () => {
  const now = 1_000
  const cases: ReadonlyArray<{
    readonly name: string
    readonly before: LeaseRow | undefined
    readonly token: DagLease.Token
    readonly released: boolean
  }> = [
    {
      name: "the holder's token releases: the lease expires now and the epoch is kept",
      before: stored(A, 3, now + 50_000),
      token: { runnerID: A, epoch: 3 },
      released: true,
    },
    {
      name: "another runner's token does not release",
      before: stored(A, 3, now + 50_000),
      token: { runnerID: B, epoch: 3 },
      released: false,
    },
    {
      name: "the right runner with an older epoch does not release the newer holding",
      before: stored(A, 3, now + 50_000),
      token: { runnerID: A, epoch: 2 },
      released: false,
    },
    { name: "no row: nothing to release", before: undefined, token: { runnerID: A, epoch: 1 }, released: false },
  ]
  for (const item of cases)
    it.effect(item.name, () =>
      Effect.gen(function* () {
        yield* seed()
        const leases = yield* DagLease.Service
        if (item.before) yield* put(item.before.runner_id, item.before.epoch, item.before.expires_at)

        const released = yield* leases.release({ dagID: DAG, token: item.token, now })

        expect(released).toBe(item.released)
        expect(yield* rowOf()).toEqual(
          item.released && item.before ? stored(item.before.runner_id, item.before.epoch, now) : item.before,
        )
      }),
    )

  it.effect("another runner can claim at once after a release, with epoch + 1", () =>
    Effect.gen(function* () {
      yield* seed()
      const leases = yield* DagLease.Service
      const first = yield* leases.claim({ dagID: DAG, runnerID: A, now: 1_000 })
      expect(yield* leases.claim({ dagID: DAG, runnerID: B, now: 1_000 })).toBeUndefined()

      expect(yield* leases.release({ dagID: DAG, token: first!, now: 1_000 })).toBe(true)

      expect(yield* leases.claim({ dagID: DAG, runnerID: B, now: 1_000 })).toEqual(lease(B, 2, 1_000 + TTL))
    }),
  )

  it.effect("a release never resets the epoch: it only ever grows across holders", () =>
    Effect.gen(function* () {
      yield* seed()
      const leases = yield* DagLease.Service
      const a1 = yield* leases.claim({ dagID: DAG, runnerID: A, now: 0 })
      yield* leases.release({ dagID: DAG, token: a1!, now: 0 })
      const b = yield* leases.claim({ dagID: DAG, runnerID: B, now: 0 })
      yield* leases.release({ dagID: DAG, token: b!, now: 0 })
      const a2 = yield* leases.claim({ dagID: DAG, runnerID: A, now: 0 })

      expect([a1?.epoch, b?.epoch, a2?.epoch]).toEqual([1, 2, 3])
    }),
  )

  it.effect("a stale holder's release after a takeover does not disturb the new holder", () =>
    Effect.gen(function* () {
      yield* seed()
      const leases = yield* DagLease.Service
      const a = yield* leases.claim({ dagID: DAG, runnerID: A, now: 0 })
      const b = yield* leases.claim({ dagID: DAG, runnerID: B, now: TTL })
      expect(b?.epoch).toBe(2)

      expect(yield* leases.release({ dagID: DAG, token: a!, now: TTL + 1 })).toBe(false)

      expect(yield* leases.held(DAG)).toEqual(b)
      expect(yield* leases.claim({ dagID: DAG, runnerID: A, now: TTL + 1 })).toBeUndefined()
    }),
  )
})

describe("DagLease.held", () => {
  it.effect("reports nothing before any claim", () =>
    Effect.gen(function* () {
      yield* seed()
      expect(yield* (yield* DagLease.Service).held(DAG)).toBeUndefined()
    }),
  )

  it.effect("reports the holder, its epoch and its expiry", () =>
    Effect.gen(function* () {
      yield* seed()
      const leases = yield* DagLease.Service
      yield* leases.claim({ dagID: DAG, runnerID: A, now: 1_000 })

      const current = yield* leases.held(DAG)

      expect(current).toEqual(lease(A, 1, 1_000 + TTL))
      expect(DagLease.holds(current, { runnerID: A, epoch: 1 })).toBe(true)
      expect(DagLease.holds(current, { runnerID: B, epoch: 1 })).toBe(false)
    }),
  )

  it.effect("follows a takeover: the new runner and the next epoch", () =>
    Effect.gen(function* () {
      yield* seed()
      const leases = yield* DagLease.Service
      yield* leases.claim({ dagID: DAG, runnerID: A, now: 0 })
      yield* leases.claim({ dagID: DAG, runnerID: B, now: TTL })

      const current = yield* leases.held(DAG)

      expect(current).toEqual(lease(B, 2, TTL + TTL))
      expect(DagLease.holds(current, { runnerID: A, epoch: 1 })).toBe(false)
    }),
  )

  it.effect("reports an expired lease too: liveness is for the caller to judge from `expiresAt`", () =>
    Effect.gen(function* () {
      yield* seed()
      const leases = yield* DagLease.Service
      yield* put(B, 4, 500)

      expect(yield* leases.held(DAG)).toEqual(lease(B, 4, 500))
    }),
  )

  it.effect("is per workflow", () =>
    Effect.gen(function* () {
      yield* seed({ one: "running", two: "running" })
      const leases = yield* DagLease.Service
      yield* leases.claim({ dagID: "one", runnerID: A, now: 0 })

      expect(yield* leases.held("one")).toEqual(lease(A, 1, TTL, "one"))
      expect(yield* leases.held("two")).toBeUndefined()
    }),
  )
})

describe("DagLease on the TestClock", () => {
  const clock = Clock.currentTimeMillis

  it.effect("a hold lasts one TTL; renewing every period keeps it, a missed TTL lets another runner take over", () =>
    Effect.gen(function* () {
      yield* seed()
      const leases = yield* DagLease.Service
      const a = yield* leases.claim({ dagID: DAG, runnerID: A, now: yield* clock })
      expect(a?.epoch).toBe(1)

      // A renews on its period for a while: B never gets in.
      for (let tick = 0; tick < 4; tick++) {
        yield* TestClock.adjust(`${DagLease.RENEWAL_PERIOD_MS} millis`)
        expect(yield* leases.renew({ dagID: DAG, token: a!, now: yield* clock })).toBe(true)
        expect(yield* leases.claim({ dagID: DAG, runnerID: B, now: yield* clock })).toBeUndefined()
      }

      // A goes quiet. One millisecond short of the TTL: still A's.
      yield* TestClock.adjust(`${TTL - 1} millis`)
      expect(yield* leases.claim({ dagID: DAG, runnerID: B, now: yield* clock })).toBeUndefined()

      // The TTL passes: B takes over with the next epoch.
      yield* TestClock.adjust("1 millis")
      const b = yield* leases.claim({ dagID: DAG, runnerID: B, now: yield* clock })
      expect(b?.runnerID).toBe(B)
      expect(b?.epoch).toBe(2)

      // A learns of it at its next renewal and cannot take the lease back.
      expect(yield* leases.renew({ dagID: DAG, token: a!, now: yield* clock })).toBe(false)
      expect(yield* leases.claim({ dagID: DAG, runnerID: A, now: yield* clock })).toBeUndefined()
      expect(DagLease.holds(yield* leases.held(DAG), a!)).toBe(false)
      expect(DagLease.holds(yield* leases.held(DAG), b!)).toBe(true)
      expect(yield* leases.renew({ dagID: DAG, token: b!, now: yield* clock })).toBe(true)
    }),
  )

  it.effect("a stalled holder that nobody took renews after any number of TTLs and keeps its epoch", () =>
    Effect.gen(function* () {
      yield* seed()
      const leases = yield* DagLease.Service
      const a = yield* leases.claim({ dagID: DAG, runnerID: A, now: yield* clock })

      // A wall-clock jump of five minutes while A is stuck: the lease looks expired to everyone.
      yield* TestClock.adjust("5 minutes")
      expect((yield* leases.held(DAG))?.expiresAt).toBeLessThan(yield* clock)

      expect(yield* leases.renew({ dagID: DAG, token: a!, now: yield* clock })).toBe(true)
      expect(yield* leases.held(DAG)).toEqual(lease(A, 1, (yield* clock) + TTL))
    }),
  )

  it.effect("a released lease is claimable at the same instant, with no wait for the TTL", () =>
    Effect.gen(function* () {
      yield* seed()
      const leases = yield* DagLease.Service
      const a = yield* leases.claim({ dagID: DAG, runnerID: A, now: yield* clock })
      yield* TestClock.adjust("10 seconds")

      yield* leases.release({ dagID: DAG, token: a!, now: yield* clock })

      expect(yield* leases.claim({ dagID: DAG, runnerID: B, now: yield* clock })).toMatchObject({
        runnerID: B,
        epoch: 2,
      })
    }),
  )
})

describe("dag_runner rows follow their workflow (ON DELETE CASCADE)", () => {
  it.effect("deleting the workflow deletes its lease row and nobody else's", () =>
    Effect.gen(function* () {
      yield* seed({ one: "running", two: "running" })
      const leases = yield* DagLease.Service
      const { db } = yield* Database.Service
      yield* leases.claim({ dagID: "one", runnerID: A, now: 0 })
      yield* leases.claim({ dagID: "two", runnerID: A, now: 0 })
      expect(yield* rowCount).toBe(2)

      yield* db.run(sql`DELETE FROM workflow WHERE id = 'one'`).pipe(Effect.orDie)

      expect(yield* rowOf("one")).toBeUndefined()
      expect(yield* rowOf("two")).toEqual(stored(A, 1, TTL))
      expect(yield* rowCount).toBe(1)
      // The workflow is gone, so nobody can claim it again.
      expect(yield* leases.claim({ dagID: "one", runnerID: B, now: TTL * 10 })).toBeUndefined()
    }),
  )

  it.effect("removing the owning session cascades through the workflow to the lease row", () =>
    Effect.gen(function* () {
      yield* seed()
      const leases = yield* DagLease.Service
      const { db } = yield* Database.Service
      yield* leases.claim({ dagID: DAG, runnerID: A, now: 0 })

      yield* db.run(sql`DELETE FROM session WHERE id = 's'`).pipe(Effect.orDie)

      expect(yield* rowCount).toBe(0)
      expect(yield* leases.held(DAG)).toBeUndefined()
    }),
  )

  it.effect("a lease row for a workflow that does not exist cannot be written", () =>
    Effect.gen(function* () {
      yield* seed()
      const { db } = yield* Database.Service

      const exit = yield* Effect.exit(
        db.run(sql`INSERT INTO dag_runner (dag_id,runner_id,epoch,expires_at) VALUES ('missing',${A},1,1)`),
      )

      expect(exit._tag).toBe("Failure")
      expect(yield* rowCount).toBe(0)
    }),
  )
})

describe("DagLease across two connections to one WAL file", () => {
  // Two engine processes: separate connections, one database file. What one
  // writes reaches the other only through the file.
  const connect = (filename: string) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      // A root memo map of its own: the two connections share no layer instance.
      const context = yield* Layer.buildWithMemoMap(
        Layer.provideMerge(DagLease.layer, Database.layerFromPath(filename)),
        Layer.makeMemoMapUnsafe(),
        scope,
      )
      return { db: Context.get(context, Database.Service).db, leases: Context.get(context, DagLease.Service) }
    })

  const twoRunners = Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const file = path.join(dir.path, "lease.sqlite")
    const r1 = yield* connect(file)
    const r2 = yield* connect(file)
    expect(r1.db).not.toBe(r2.db)
    // The parent session and workflows hang off the first connection.
    yield* r1.db
      .run(
        sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES ('p',${process.cwd()},'[]',1,1)`,
      )
      .pipe(Effect.orDie)
    yield* r1.db
      .run(
        sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES ('s','p',NULL,'s',${process.cwd()},'s','test',1,1)`,
      )
      .pipe(Effect.orDie)
    for (const id of [DAG, "other"])
      yield* r1.db
        .run(
          sql`INSERT INTO workflow (id,project_id,session_id,directory,target_fingerprint,title,status,config,seq,time_created,time_updated) VALUES (${id},'p','s',${process.cwd()},'{"kind":"none"}','W','running','{}',1,1,1)`,
        )
        .pipe(Effect.orDie)
    return { r1: r1.leases, r2: r2.leases, db: r2.db }
  })

  it.effect("a lease taken on one connection holds the other off and is visible to it", () =>
    Effect.gen(function* () {
      const { r1, r2 } = yield* twoRunners
      const a = yield* r1.claim({ dagID: DAG, runnerID: A, now: yield* Clock.currentTimeMillis })

      expect(yield* r2.claim({ dagID: DAG, runnerID: B, now: yield* Clock.currentTimeMillis })).toBeUndefined()
      expect(yield* r2.held(DAG)).toEqual(a)

      // The TestClock moves both sides together, as one wall clock would.
      yield* TestClock.adjust(`${TTL} millis`)
      const b = yield* r2.claim({ dagID: DAG, runnerID: B, now: yield* Clock.currentTimeMillis })
      expect(b).toMatchObject({ runnerID: B, epoch: 2 })

      // The first runner learns it on its next renewal, through the file.
      expect(yield* r1.renew({ dagID: DAG, token: a!, now: yield* Clock.currentTimeMillis })).toBe(false)
      expect(DagLease.holds(yield* r1.held(DAG), a!)).toBe(false)
      expect(DagLease.holds(yield* r1.held(DAG), b!)).toBe(true)
    }),
  )

  it.effect("two claims at once on a free workflow: exactly one wins, at epoch 1", () =>
    Effect.gen(function* () {
      const { r1, r2, db } = yield* twoRunners
      const now = yield* Clock.currentTimeMillis

      const results = yield* Effect.all(
        [r1.claim({ dagID: DAG, runnerID: A, now }), r2.claim({ dagID: DAG, runnerID: B, now })],
        { concurrency: "unbounded" },
      )

      const winners = results.filter((result) => result !== undefined)
      expect(winners).toHaveLength(1)
      expect(winners[0]?.epoch).toBe(1)
      const row = yield* db
        .get<LeaseRow>(sql`SELECT runner_id, epoch, expires_at FROM dag_runner WHERE dag_id = ${DAG}`)
        .pipe(Effect.orDie)
      expect(row).toEqual(stored(winners[0].runnerID, 1, now + TTL))
    }),
  )

  it.effect("two takeovers of one expired lease at once: exactly one wins, and the epoch rises by one", () =>
    Effect.gen(function* () {
      const { r1, r2 } = yield* twoRunners
      const stale = yield* r1.claim({ dagID: DAG, runnerID: "300:cccc", now: yield* Clock.currentTimeMillis })
      yield* TestClock.adjust(`${TTL} millis`)
      const now = yield* Clock.currentTimeMillis

      const results = yield* Effect.all(
        [r1.claim({ dagID: DAG, runnerID: A, now }), r2.claim({ dagID: DAG, runnerID: B, now })],
        { concurrency: "unbounded" },
      )

      const winners = results.filter((result) => result !== undefined)
      expect(winners).toHaveLength(1)
      expect(winners[0]?.epoch).toBe(stale!.epoch + 1)
    }),
  )
})
