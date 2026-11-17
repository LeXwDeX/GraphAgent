// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1029 / ADR-0008 decision 3, PR3a: `DagTransact.transact(dagID, token,
 * body)`, the one IMMEDIATE transaction in which a DAG write fences, guards and
 * publishes.
 *
 * What is pinned here is the primitive itself: the transaction shape (the
 * write reservation comes before the first read, and the fence, the body's
 * reads and its writes run between one BEGIN and one COMMIT), the failure
 * contract (a typed failure of the body passes through and rolls everything
 * back, a database failure is a defect), and the fence (`(runner_id, epoch)`
 * decides, never `expires_at`). The wiring of every `Dag` command through it is
 * `packages/graphagent/test/dag/dag-transact.test.ts`.
 */

import { describe, expect } from "bun:test"
import path from "node:path"
import { Database as NativeDatabase } from "bun:sqlite"
import { sql } from "drizzle-orm"
import { Cause, Clock, Effect, Exit, Layer, Option, Scheduler, Schema, Stream } from "effect"
import type { Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { DagLease } from "@graphagent/core/dag/lease"
import { DagTransact } from "@graphagent/core/dag/transact"
import { Database } from "@graphagent/core/database/database"
import { layer as sqliteLayer } from "@graphagent/core/database/sqlite.bun"
import { Sqlite } from "@graphagent/core/database/sqlite"
import { EventV2 } from "@graphagent/core/event"
import { EventTable } from "@graphagent/core/event/sql"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// `pid:nonce`, the vocabulary of every runner id.
const A = "100:aaaa"
const B = "200:bbbb"
const TTL = DagLease.TTL_MS
const DAG = "wf"

const Note = EventV2.define({
  type: "test.transact.note",
  durable: { version: 1, aggregate: "id" },
  schema: { id: Schema.String, text: Schema.String },
})

/** What a guard that rejects fails with. */
class GuardRejected extends Error {
  override readonly name = "GuardRejected"
}

/** One file database with a Native handle, the lease, the transaction primitive and an event bus. */
const fileLayer = (filename: string) => {
  const sqlite = sqliteLayer({ filename })
  const database = Database.layer.pipe(Layer.provide(sqlite))
  const lease = DagLease.layer.pipe(Layer.provide(database))
  return Layer.mergeAll(
    sqlite,
    database,
    lease,
    DagTransact.layer.pipe(Layer.provide(Layer.mergeAll(database, lease))),
    EventV2.layerWith().pipe(Layer.provide(database)),
  )
}

type Services =
  Sqlite.Native | Database.Service | DagLease.Service | DagTransact.Service | EventV2.Service | Scope.Scope

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.run(
    sql`INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES ('p',${process.cwd()},'[]',1,1)`,
  )
  yield* db.run(
    sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES ('s','p',NULL,'s',${process.cwd()},'s','test',1,1)`,
  )
  yield* db.run(
    sql`INSERT INTO workflow (id,project_id,session_id,directory,target_fingerprint,title,status,config,seq,time_created,time_updated) VALUES (${DAG},'p','s',${process.cwd()},'{"kind":"none"}','untouched','running','{}',1,1,1)`,
  )
}).pipe(Effect.orDie)

/** Run `effect` over a fresh file database seeded with one running workflow; `file` is the database path. */
const onFile = <A, E>(effect: (file: string) => Effect.Effect<A, E, Services>) =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const file = path.join(dir.path, "transact.sqlite")
    return yield* Effect.gen(function* () {
      yield* seed
      return yield* effect(file)
    }).pipe(Effect.provide(fileLayer(file)))
  })

const it = testEffect(Layer.empty)

const titleOf = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return (yield* db.get<{ title: string }>(sql`SELECT title FROM workflow WHERE id = ${DAG}`).pipe(Effect.orDie))?.title
})

/** A body that writes: the read model changes only if the transaction commits. */
const touch = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.run(sql`UPDATE workflow SET title = 'touched' WHERE id = ${DAG}`).pipe(Effect.orDie)
})

const transact = <A, E, R>(token: DagLease.Token | undefined, body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const service = yield* DagTransact.Service
    return yield* service.transact(DAG, token, body)
  })

interface Queryable {
  query: (query: string) => unknown
}
const isQueryable = (value: unknown): value is Queryable =>
  typeof value === "object" && value !== null && "query" in value && typeof value.query === "function"

/** Every SQL statement the native handle runs while `effect` runs, in order. */
const tracing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const native = yield* Sqlite.Native
    if (!isQueryable(native)) return yield* Effect.die(new Error("the native sqlite handle has no query()"))
    const original = native.query.bind(native)
    const statements = new Array<string>()
    native.query = (query: string) => {
      statements.push(query.trim().replace(/\s+/g, " "))
      return original(query)
    }
    const result = yield* effect.pipe(Effect.ensuring(Effect.sync(() => void (native.query = original))))
    return { result, statements }
  })

const isBegin = (statement: string) => /^begin/i.test(statement)
const isCommit = (statement: string) => /^commit/i.test(statement)

/** `runnerID` claims the workflow's lease at the TestClock's now; the token it holds by. */
const claim = (runnerID: string) =>
  Effect.gen(function* () {
    const leases = yield* DagLease.Service
    const lease = yield* leases.claim({ dagID: DAG, runnerID, now: yield* Clock.currentTimeMillis })
    return lease!
  })

describe("DagTransact.transact: the transaction", () => {
  it.effect("runs the body once and returns its value", () =>
    onFile(() =>
      Effect.gen(function* () {
        let runs = 0
        const value = yield* transact(
          undefined,
          Effect.sync(() => {
            runs++
            return "done"
          }),
        )

        expect(value).toBe("done")
        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("runs the body without scheduler yields, and only the body", () =>
    onFile(() =>
      Effect.gen(function* () {
        const yields = Effect.gen(function* () {
          return yield* Scheduler.PreventSchedulerYield
        })
        const outside = yield* yields

        const inside = yield* transact(undefined, yields)
        const fenced = yield* transact(yield* claim(A), yields)

        // A fiber that gave up the thread mid-transaction would stretch the time the write lock is held.
        expect([outside, inside, fenced]).toEqual([false, true, true])
        expect(yield* yields).toBe(false)
      }),
    ),
  )

  it.effect("is IMMEDIATE: a second connection cannot write once the body has only read", () =>
    onFile((file) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const other = new NativeDatabase(file)
        // A short busy timeout keeps the synchronous probe from hanging the only JS thread.
        other.run("PRAGMA busy_timeout = 1")
        try {
          const blocked = yield* transact(
            undefined,
            Effect.gen(function* () {
              // A guard's read: a DEFERRED transaction would hold no write reservation yet.
              yield* db.get(sql`SELECT status FROM workflow WHERE id = ${DAG}`).pipe(Effect.orDie)
              return yield* Effect.sync(() => {
                try {
                  other.run("UPDATE workflow SET title = 'other' WHERE id = 'wf'")
                  return false
                } catch {
                  return true
                }
              })
            }),
          )
          expect(blocked).toBe(true)
          // The transaction is over: the other connection writes again.
          other.run("UPDATE workflow SET title = 'other' WHERE id = 'wf'")
          expect(yield* titleOf).toBe("other")
        } finally {
          other.close()
        }
      }),
    ),
  )

  it.effect("runs the fence, the guard's reads and the publish between one BEGIN and one COMMIT", () =>
    onFile(() =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const events = yield* EventV2.Service
        const lease = yield* claim(A)

        const { statements } = yield* tracing(
          transact(
            lease,
            Effect.gen(function* () {
              yield* db.get(sql`SELECT status FROM workflow WHERE id = ${DAG}`).pipe(Effect.orDie)
              yield* events.publish(Note, { id: DAG, text: "published" })
            }),
          ),
        )

        const begin = statements.findIndex(isBegin)
        const fence = statements.findIndex((statement) => /dag_runner/i.test(statement))
        const guard = statements.findIndex((statement) => /select status from workflow/i.test(statement))
        const publish = statements.findIndex((statement) => /insert into "?event"? /i.test(statement))
        expect(statements.filter(isBegin)).toHaveLength(1)
        expect(statements.filter(isCommit)).toHaveLength(1)
        // BEGIN first, then the fence, the guard and the publish in that order, COMMIT last.
        expect(begin).toBe(0)
        expect(fence).toBeGreaterThan(begin)
        expect(guard).toBeGreaterThan(fence)
        expect(publish).toBeGreaterThan(guard)
        expect(isCommit(statements.at(-1)!)).toBe(true)
        expect(statements.findIndex(isCommit)).toBe(statements.length - 1)
      }),
    ),
  )

  it.effect("a typed failure of the body passes through unchanged and rolls the whole transaction back", () =>
    onFile(() =>
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const rejected = new GuardRejected("stale attempt")

        const exit = yield* Effect.exit(
          transact(
            undefined,
            Effect.gen(function* () {
              yield* touch
              yield* events.publish(Note, { id: DAG, text: "never committed" })
              return yield* Effect.fail(rejected)
            }),
          ),
        )

        expect(Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined).toBe(
          rejected,
        )
        expect(yield* titleOf).toBe("untouched")
        const { db } = yield* Database.Service
        expect(yield* db.select({ id: EventTable.id }).from(EventTable).all().pipe(Effect.orDie)).toEqual([])
      }),
    ),
  )

  it.effect("a database failure inside the body is a defect, not a typed failure", () =>
    onFile(() =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service

        const exit = yield* Effect.exit(
          transact(
            undefined,
            Effect.gen(function* () {
              yield* touch
              yield* db.run(sql`SELECT * FROM no_such_table`)
            }),
          ),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true)
          expect(Option.isNone(Cause.findErrorOption(exit.cause))).toBe(true)
        }
        expect(yield* titleOf).toBe("untouched")
      }),
    ),
  )

  it.effect("delivers what the body published only after it commits, and nothing when it rolls back", () =>
    onFile(() =>
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const seen = new Array<string>()
        yield* events.subscribe(Note).pipe(
          Stream.runForEach((event) => Effect.sync(() => void seen.push(event.data.text))),
          Effect.forkScoped({ startImmediately: true }),
        )

        yield* Effect.exit(
          transact(
            undefined,
            Effect.gen(function* () {
              yield* events.publish(Note, { id: DAG, text: "phantom" })
              return yield* Effect.fail(new GuardRejected("rolled back"))
            }),
          ),
        )
        const inside = yield* transact(
          undefined,
          Effect.gen(function* () {
            yield* events.publish(Note, { id: DAG, text: "committed" })
            for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow
            return [...seen]
          }),
        )
        for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow

        expect(inside).toEqual([])
        expect(seen).toEqual(["committed"])
      }),
    ),
  )

  it.effect("joins an enclosing transaction as a savepoint", () =>
    onFile(() =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service

        const { statements } = yield* tracing(
          db.transaction(() => transact(undefined, touch), { behavior: "immediate" }),
        )

        expect(statements.filter(isBegin)).toHaveLength(1)
        expect(statements.some((statement) => /^savepoint/i.test(statement))).toBe(true)
        expect(yield* titleOf).toBe("touched")
      }),
    ),
  )
})

describe("DagTransact.transact: the fence", () => {
  const stale = (exit: Exit.Exit<unknown, unknown>) => {
    const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
    return error instanceof DagTransact.StaleRunnerError ? error : undefined
  }

  it.effect("no token: the lease is not consulted and an unowned workflow is written", () =>
    onFile(() =>
      Effect.gen(function* () {
        const { statements } = yield* tracing(transact(undefined, touch))

        expect(statements.some((statement) => /dag_runner/i.test(statement))).toBe(false)
        expect(yield* titleOf).toBe("touched")
      }),
    ),
  )

  it.effect("the token that holds the lease is let through", () =>
    onFile(() =>
      Effect.gen(function* () {
        const lease = yield* claim(A)

        yield* transact(lease, touch)

        expect(yield* titleOf).toBe("touched")
      }),
    ),
  )

  it.effect("a lease that has expired but was not taken still holds: expiry is never compared", () =>
    onFile(() =>
      Effect.gen(function* () {
        const lease = yield* claim(A)
        yield* TestClock.adjust(`${TTL * 10} millis`)

        yield* transact(lease, touch)

        expect(yield* titleOf).toBe("touched")
      }),
    ),
  )

  it.effect("after a takeover the old token is refused and writes nothing; the new one passes", () =>
    onFile(() =>
      Effect.gen(function* () {
        const a = yield* claim(A)
        yield* TestClock.adjust(`${TTL} millis`)
        const b = yield* claim(B)
        expect(b.epoch).toBe(a.epoch + 1)
        let ran = false

        const exit = yield* Effect.exit(transact(a, Effect.sync(() => void (ran = true)).pipe(Effect.andThen(touch))))

        expect(stale(exit)).toMatchObject({ dagID: DAG, runnerID: A, epoch: a.epoch })
        expect(ran).toBe(false)
        expect(yield* titleOf).toBe("untouched")
        yield* transact(b, touch)
        expect(yield* titleOf).toBe("touched")
      }),
    ),
  )

  it.effect("the same runner at an older epoch is refused: the token is the pair", () =>
    onFile(() =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const first = yield* claim(A)
        yield* db.run(sql`UPDATE dag_runner SET epoch = 3 WHERE dag_id = ${DAG}`).pipe(Effect.orDie)

        const exit = yield* Effect.exit(transact(first, touch))

        expect(stale(exit)).toBeDefined()
        expect(yield* titleOf).toBe("untouched")
        yield* transact({ runnerID: A, epoch: 3 }, touch)
        expect(yield* titleOf).toBe("touched")
      }),
    ),
  )

  it.effect("a workflow nobody claimed refuses every token", () =>
    onFile(() =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(transact({ runnerID: A, epoch: 1 }, touch))

        expect(stale(exit)).toMatchObject({ runnerID: A, epoch: 1 })
        expect(yield* titleOf).toBe("untouched")
      }),
    ),
  )

  it.effect("a terminal workflow has no owner: its old holder is refused", () =>
    onFile(() =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const lease = yield* claim(A)
        yield* db.run(sql`UPDATE workflow SET status = 'completed' WHERE id = ${DAG}`).pipe(Effect.orDie)

        const exit = yield* Effect.exit(transact(lease, touch))

        expect(stale(exit)).toBeDefined()
        expect(yield* titleOf).toBe("untouched")
      }),
    ),
  )

  it.effect("the fence read and the body share one write reservation: no takeover fits between them", () =>
    onFile((file) =>
      Effect.gen(function* () {
        const lease = yield* claim(A)
        const other = new NativeDatabase(file)
        other.run("PRAGMA busy_timeout = 1")
        try {
          const takeoverBlocked = yield* transact(
            lease,
            Effect.sync(() => {
              try {
                // Another process's takeover: the lease row is expired for it.
                other.run("UPDATE dag_runner SET runner_id = 'thief', epoch = epoch + 1 WHERE dag_id = 'wf'")
                return false
              } catch {
                return true
              }
            }),
          )

          expect(takeoverBlocked).toBe(true)
          expect(DagLease.holds(yield* (yield* DagLease.Service).held(DAG), lease)).toBe(true)
        } finally {
          other.close()
        }
      }),
    ),
  )
})
