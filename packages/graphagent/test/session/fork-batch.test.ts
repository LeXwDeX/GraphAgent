// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Database as BunDatabase, type SQLQueryBindings } from "bun:sqlite"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { EventTable } from "@graphagent/core/event/sql"
import { SessionProjector } from "@graphagent/core/session/projector"
import { SessionV1 } from "@graphagent/core/v1/session"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Context, Effect, Exit, Fiber, Layer, Scope, Semaphore, Stream } from "effect"
import * as Client from "effect/sql/SqlClient"
import type { Connection } from "effect/sql/SqlConnection"
import { SqlError, classifySqliteError } from "effect/sql/SqlError"
import * as Statement from "effect/sql/Statement"
import * as Reactivity from "effect/reactivity/Reactivity"
import { eq, sql } from "drizzle-orm"
import { Session as SessionNs } from "@/session/session"
import { Goal } from "@/goal/goal"
import { SessionAutomationLease } from "@/session/automation-lease"
import { Dag } from "@/dag/dag"
import { MessageID, PartID } from "../../src/session/schema"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Storage } from "@/storage/storage"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"

interface SqlCounter {
  begins: number
  commits: number
  savepoints: number
  releases: number
  savepointRollbacks: number
}

const counter: SqlCounter = { begins: 0, commits: 0, savepoints: 0, releases: 0, savepointRollbacks: 0 }

// The Database layer's sqlite client is a closed graph (its native provider
// cannot be overridden from outside), so this test builds its own SqlClient
// mirroring the driver's `make`, wrapping the native so real BEGIN/COMMIT/
// SAVEPOINT statements are countable.
//
// This duplicates ~85 lines of packages/core/src/database/sqlite.bun.ts `make`
// (run/runValues/connection/semaphore/transactionAcquirer). Tracked debt: if
// sqlite.bun.ts exposed a provider seam (an injectable native Database, or a
// `make({ native })` overload), this test could reuse the production client and
// the copy would collapse. Until then the duplication is intentional and must
// be kept in sync with sqlite.bun.ts `run`/`runValues`.
const countingClientLayer = Layer.effect(
  Client.SqlClient,
  Effect.gen(function* () {
    const native = new BunDatabase(":memory:")
    native.run("PRAGMA journal_mode = WAL;")
    const counting = new Proxy(native, {
      get(target, prop) {
        if (prop === "query") {
          return (sql: string) => {
            if (/^\s*begin\b/i.test(sql)) counter.begins++
            else if (/^\s*commit\b/i.test(sql)) counter.commits++
            else if (/^\s*savepoint\b/i.test(sql)) counter.savepoints++
            else if (/^\s*release\b/i.test(sql)) counter.releases++
            else if (/^\s*rollback to\b/i.test(sql)) counter.savepointRollbacks++
            return target.query(sql)
          }
        }
        return Reflect.get(target, prop)
      },
    }) as BunDatabase

    const compiler = Statement.makeCompilerSqlite(undefined)
    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<Record<string, unknown>>, SqlError>((fiber) => {
        const statement = counting.query(query)
        // @ts-ignore bun-types missing safeIntegers method
        statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
        try {
          return Effect.succeed(
            (statement.all(...(params as SQLQueryBindings[])) ?? []) as Array<Record<string, unknown>>,
          )
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })
    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<unknown[]>, SqlError>((fiber) => {
        const statement = counting.query(query)
        // @ts-ignore bun-types missing safeIntegers method
        statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
        try {
          return Effect.succeed((statement.values(...(params as SQLQueryBindings[])) ?? []) as Array<unknown[]>)
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })
    const connection: Connection = {
      execute(query, params, transformRows) {
        return transformRows ? Effect.map(run(query, params), transformRows) : run(query, params)
      },
      executeRaw(query, params) {
        return run(query, params)
      },
      executeValues(query, params) {
        return runValues(query, params)
      },
      executeValuesUnprepared(query, params) {
        return runValues(query, params)
      },
      executeUnprepared(query, params, transformRows) {
        return this.execute(query, params, transformRows)
      },
      executeStream() {
        return Stream.die("executeStream not implemented")
      },
    }
    const semaphore = yield* Semaphore.make(1)
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection))
    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!
      const scope = Context.getUnsafe(fiber.context, Scope.Scope)
      return Effect.as(
        Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
        connection,
      )
    })
    return yield* Client.make({
      acquirer,
      compiler,
      driver: "sqlite-bun",
      transactionAcquirer,
      // Mirror sqlite.bun.ts: nested transactions release their savepoints.
      releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
      spanAttributes: [["db.system.name", "sqlite"]],
    })
  }),
)

const dbLayer = Database.layer.pipe(Layer.provide(countingClientLayer.pipe(Layer.provide(Reactivity.layer))))
const eventV2Layer = EventV2.layer.pipe(Layer.provide(dbLayer))
const eventV2BridgeLayer = EventV2Bridge.layer.pipe(Layer.provide(eventV2Layer))
const projectorLayer = SessionProjector.layer.pipe(Layer.provide(eventV2Layer), Layer.provide(dbLayer))

const it = testEffect(
  Layer.mergeAll(
    dbLayer,
    SessionNs.layer.pipe(
      Layer.provide(Storage.defaultLayer),
      Layer.provide(dbLayer),
      Layer.provide(eventV2BridgeLayer),
      Layer.provide(projectorLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
      Layer.provide(Goal.defaultLayer),
      Layer.provide(SessionAutomationLease.defaultLayer),
      Layer.provide(Dag.defaultLayer),
    ),
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  ),
)

const userInfo = (sessionID: string, id: string) =>
  ({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "user",
    model: { providerID: "test", modelID: "test" },
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- persisted test fixture mirrors the V1 schema shape
  }) as unknown as SessionV1.Info

const assistantInfo = (sessionID: string, id: string, parentID: string) =>
  ({
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: "test",
    providerID: "test",
    mode: "",
    agent: "assistant",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- persisted test fixture mirrors the V1 schema shape
  }) as unknown as SessionV1.Info

const textPart = (sessionID: string, messageID: string, text: string) =>
  ({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "text",
    text,
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- persisted test fixture mirrors the V1 schema shape
  }) as unknown as SessionV1.Part

describe("Session.fork", () => {
  it.instance("fork result is equivalent: message/part counts, parentID chain, compaction tail_start_id", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const original = yield* Effect.acquireRelease(session.create({ title: "fork-source" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      const m1 = MessageID.ascending()
      const m2 = MessageID.ascending()
      const m3 = MessageID.ascending()
      yield* session.updateMessage(userInfo(original.id, m1))
      yield* session.updateMessage(assistantInfo(original.id, m2, m1))
      yield* session.updateMessage(userInfo(original.id, m3))
      yield* session.updatePart(textPart(original.id, m1, "hello"))
      yield* session.updatePart(textPart(original.id, m2, "world"))
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: original.id,
        messageID: m3,
        type: "compaction",
        auto: true,
        tail_start_id: m1,
      })

      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: original.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      const source = yield* session.messages({ sessionID: original.id })
      const target = yield* session.messages({ sessionID: fork.id })

      expect(target.length).toBe(source.length)
      expect(target.length).toBe(3)

      const [f1, f2, f3] = target
      expect(f1.info.id).not.toBe(m1)
      expect(f1.parts.map((p) => p.type)).toEqual(["text"])
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- persisted test fixture mirrors the V1 schema shape
      expect((f1.parts[0] as unknown as SessionV1.TextPart).text).toBe("hello")
      // parentID chain maps through the idMap
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- persisted test fixture mirrors the V1 schema shape
      expect((f2.info as unknown as SessionV1.Assistant).parentID).toBe(f1.info.id)
      expect(f2.parts.map((p) => p.type)).toEqual(["text"])
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- persisted test fixture mirrors the V1 schema shape
      expect((f2.parts[0] as unknown as SessionV1.TextPart).text).toBe("world")
      // compaction tail_start_id maps to the forked message id
      const compaction = f3.parts.find((p) => p.type === "compaction")
      expect(compaction?.type).toBe("compaction")
      if (compaction?.type === "compaction") expect(compaction.tail_start_id).toBe(f1.info.id)
    }),
  )

  it.instance("fork copies the whole session in one batch transaction regardless of session size", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const original = yield* Effect.acquireRelease(session.create({ title: "fork-source" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      const messageCount = 30
      for (let i = 0; i < messageCount; i++) {
        const id = MessageID.ascending()
        yield* session.updateMessage(userInfo(original.id, id))
        yield* session.updatePart(textPart(original.id, id, `part ${i}-a`))
        yield* session.updatePart(textPart(original.id, id, `part ${i}-b`))
      }

      counter.begins = 0
      counter.commits = 0
      counter.savepoints = 0
      counter.releases = 0
      counter.savepointRollbacks = 0

      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: original.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      // One BEGIN/COMMIT for the fork session's Created event, one for the
      // batch copy transaction — never one per message/part (that would be
      // 91 BEGINs for 30 messages with 2 parts each).
      expect(counter.begins).toBe(2)
      expect(counter.commits).toBe(2)
      // Each per-event publish inside the batch becomes a savepoint.
      expect(counter.savepoints).toBe(messageCount * 3)

      const target = yield* session.messages({ sessionID: fork.id })
      expect(target.length).toBe(messageCount)
      for (const msg of target) expect(msg.parts.length).toBe(2)
    }),
  )

  it.instance("fork rolls back copied durable events and projections when a nested publication fails", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const session = yield* SessionNs.Service
      const original = yield* Effect.acquireRelease(session.create({ title: "fork-source" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      const firstMessageID = MessageID.ascending()
      const failingMessageID = MessageID.ascending()
      yield* session.updateMessage(userInfo(original.id, firstMessageID))
      yield* session.updatePart(textPart(original.id, firstMessageID, "copied before failure"))
      yield* session.updateMessage(userInfo(original.id, failingMessageID))
      yield* session.updatePart(textPart(original.id, failingMessageID, "force fork copy failure"))
      const sourceBefore = yield* session.messages({ sessionID: original.id })

      yield* database.db
        .run(
          sql`
          CREATE TRIGGER reject_fork_copy
          BEFORE INSERT ON event
          WHEN NEW.type = 'message.part.updated.1'
            AND json_extract(NEW.data, '$.part.text') = 'force fork copy failure'
          BEGIN
            SELECT RAISE(ABORT, 'forced fork copy failure');
          END
        `,
        )
        .pipe(Effect.orDie)

      counter.begins = 0
      counter.commits = 0
      counter.savepoints = 0
      counter.releases = 0
      counter.savepointRollbacks = 0

      const forkExit = yield* Effect.exit(session.fork({ sessionID: original.id }))

      expect(Exit.isFailure(forkExit)).toBe(true)

      const forkedSessions = (yield* session.list()).filter((info) => info.id !== original.id)
      expect(forkedSessions).toHaveLength(1)
      const forked = forkedSessions[0]
      if (!forked) return
      yield* Effect.addFinalizer(() => session.remove(forked.id).pipe(Effect.ignore))

      expect(yield* session.messages({ sessionID: forked.id })).toEqual([])
      expect(yield* session.messages({ sessionID: original.id })).toEqual(sourceBefore)

      const durableEvents = yield* database.db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, forked.id))
      expect(durableEvents).toEqual([{ type: "session.created.1" }])

      expect(counter.savepoints).toBe(4)
      expect(counter.releases).toBe(4)
      expect(counter.savepointRollbacks).toBe(1)
    }),
  )
})
