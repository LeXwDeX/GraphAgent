// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the admission mock narrows a hand-built message and an unstarted turn handle into the service contract

import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Layer, Ref } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionInbox, type InboxItem, type InboxLedger, type LedgerScope } from "@/session/inbox"
import { MessageID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { AdmissionPersistFailed } from "@/session/turn/prepare"
import type { TurnStart } from "@/session/turns"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { mockSessionPrompt } from "../lib/child-runs"

type Db = Database.Interface["db"]

// The ledger fixture stands in for a source-owned table: the unique constraint
// is real, so a concurrent loser fails inside the admission transaction and
// rolls its message back. It is created by raw DDL on purpose: the ledger
// schema belongs to the source (PR B), not to the database baseline.
const createLedgerTable = (db: Db) =>
  db.run(
    sql`CREATE TABLE IF NOT EXISTS inbox_ledger (
      source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE
    )`,
  )

const seedSession = (db: Db, sessionID: SessionID, directory: string) =>
  Effect.gen(function* () {
    const projectID = `prj_ledger_${crypto.randomUUID()}`
    const now = Date.now()
    yield* db.run(
      sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES (${projectID}, ${directory}, ${"[]"}, ${now}, ${now})`,
    )
    yield* db.run(
      sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES (${sessionID}, ${projectID}, ${"ledger"}, ${directory}, ${"ledger"}, ${"1"}, ${now}, ${now})`,
    )
  })

const count = (db: Db, table: "inbox_ledger" | "message" | "session_turn") =>
  db.get<{ n: number }>(sql.raw(`SELECT COUNT(*) AS n FROM ${table}`)).pipe(Effect.map((row) => row?.n ?? 0))

const item = (key: string, extra: Partial<InboxItem> = {}): InboxItem => ({
  prompt: { parts: [{ type: "text", text: key }] },
  ...extra,
})

/** Derive the key from the prompt text; the item has no identity of its own. */
const keyOf = (value: InboxItem) =>
  value.prompt?.parts.map((part) => (part.type === "text" ? part.text : "")).join("|") ?? ""

const makeLedger = (db: Db, commit?: InboxLedger["commit"]): InboxLedger => ({
  idempotencyKey: keyOf,
  seen: (scope: LedgerScope) =>
    db
      .get<{ hit: number }>(
        sql`SELECT 1 AS hit FROM inbox_ledger
            WHERE source = ${scope.source} AND session_id = ${scope.sessionID}
              AND idempotency_key = ${scope.idempotencyKey}`,
      )
      .pipe(Effect.map((row) => row !== undefined)),
  commit:
    commit ??
    ((scope) =>
      db.run(
        sql`INSERT INTO inbox_ledger (source, session_id, idempotency_key)
            VALUES (${scope.source}, ${scope.sessionID}, ${scope.idempotencyKey})`,
      )),
})

const source = (ledger: InboxLedger) =>
  ({
    id: "child.result",
    priority: 10,
    mode: "join_or_start",
    hint: () => false,
    claim: () => Effect.succeed(false),
    ledger,
  }) as const

let admitCalls = 0

// The admission port is the real transaction boundary from `prepare.ts`: the
// message row and the ledger commit share one immediate transaction, and a
// failed commit keeps its typed error. The mock is the smallest port that
// still proves submit's re-check sees only what the transaction committed.
const admission = Layer.unwrap(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return mockSessionPrompt({
      admit: (input, _options, persistAdmission) =>
        Effect.gen(function* () {
          admitCalls += 1
          const now = Date.now()
          const id = MessageID.make(`msg_${crypto.randomUUID()}`)
          const message = {
            info: { id, sessionID: input.sessionID, role: "user", time: { created: now } },
            parts: [],
          } as unknown as SessionV1.WithParts
          const persistMessages = db.run(
            sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
                VALUES (${id}, ${input.sessionID}, ${now}, ${now}, ${JSON.stringify({
                  role: "user",
                  time: { created: now },
                  agent: "build",
                  model: { providerID: "test", modelID: "test-model" },
                })})`,
          )
          const reserved = persistAdmission
            ? db.transaction(() => persistMessages.pipe(Effect.andThen(persistAdmission)), {
                behavior: "immediate",
              })
            : persistMessages
          yield* reserved.pipe(Effect.mapError((cause) => new AdmissionPersistFailed({ cause: String(cause) })))
          return {
            admission:
              input.noReply === true
                ? ({ kind: "not_started", reason: "admission_declined" } as const)
                : ({ kind: "started", turn: undefined as never } as const),
            message,
            wait: Effect.succeed(message),
          } satisfies TurnStart
        }),
    })
  }),
).pipe(Layer.provide(Database.defaultLayer))

const bridge = EventV2Bridge.layer.pipe(Layer.provide(EventV2.layer), Layer.provide(Database.defaultLayer))
const status = SessionStatus.layer.pipe(Layer.provide(bridge))
const inbox = SessionInbox.layer.pipe(Layer.provideMerge(bridge), Layer.provideMerge(status))

const layer = Layer.mergeAll(inbox, admission, Database.defaultLayer)
const it = testEffect(layer)

/** Build a fresh inbox over the same durable database (a restart). */
const withInbox = <A, E>(db: Database.Interface, work: Effect.Effect<A, E, SessionInbox.Service>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = Layer.succeed(Database.Service, db)
      const events = EventV2.layer.pipe(Layer.provide(database))
      const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
      const status = SessionStatus.layer.pipe(Layer.provide(bridge))
      const context = yield* Layer.build(
        SessionInbox.layer.pipe(Layer.provideMerge(bridge), Layer.provideMerge(status)),
      )
      return yield* work.pipe(Effect.provideService(SessionInbox.Service, Context.get(context, SessionInbox.Service)))
    }),
  )

describe("SessionInbox ledger", () => {
  it.instance("admits one sequential delivery and suppresses the rest as duplicates", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      const { db } = yield* Database.Service
      const directory = (yield* TestInstance).directory
      yield* createLedgerTable(db)
      const sessionID = SessionID.descending()
      yield* seedSession(db, sessionID, directory)
      admitCalls = 0
      yield* inbox.register(source(makeLedger(db)))

      const results = yield* Effect.forEach(Array.from({ length: 100 }), () =>
        inbox.submit("child.result", sessionID, item("sequential-key")),
      )
      expect(results[0].state).toBe("started")
      expect(results.slice(1).every((result) => result.state === "duplicate")).toBe(true)
      expect(admitCalls).toBe(1)
      expect(yield* count(db, "message")).toBe(1)
      expect(yield* count(db, "inbox_ledger")).toBe(1)
    }),
  )

  it.instance("lets exactly one concurrent delivery win the unique constraint", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      const { db } = yield* Database.Service
      const directory = (yield* TestInstance).directory
      yield* createLedgerTable(db)
      const sessionID = SessionID.descending()
      yield* seedSession(db, sessionID, directory)
      // Hold every pre-check in two phases: first until all 100 submissions
      // have entered, then until all of them have read "not seen". Only then
      // can all of them enter the admission transaction, so the duplicate
      // classification below must come from the unique constraint and
      // submit's post-failure re-check, not from the early seen() gate.
      const makeBarrier = (count: number) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          const arrived = yield* Ref.make(0)
          return Effect.gen(function* () {
            const seen = yield* Ref.updateAndGet(arrived, (value) => value + 1)
            if (seen >= count) yield* Deferred.succeed(gate, undefined).pipe(Effect.ignore)
            yield* Deferred.await(gate)
          })
        })
      const entered = yield* makeBarrier(100)
      const queried = yield* makeBarrier(100)
      const base = makeLedger(db)
      admitCalls = 0
      yield* inbox.register(
        source({
          idempotencyKey: base.idempotencyKey,
          seen: (scope) =>
            Effect.gen(function* () {
              yield* entered
              const committed = yield* base.seen(scope)
              yield* queried
              return committed
            }),
          commit: base.commit,
        }),
      )

      const results = yield* Effect.forEach(
        Array.from({ length: 100 }),
        () => inbox.submit("child.result", sessionID, item("concurrent-key")),
        { concurrency: "unbounded" },
      )
      const states = results.map((result) => result.state)
      expect(states.filter((state) => state === "started")).toHaveLength(1)
      expect(states.filter((state) => state === "duplicate")).toHaveLength(99)
      // Every submission passed the early gate, so the 99 losers reached the
      // admission transaction and were classified by its unique constraint.
      expect(admitCalls).toBe(100)
      expect(yield* count(db, "message")).toBe(1)
      expect(yield* count(db, "inbox_ledger")).toBe(1)
    }),
  )

  it.instance("a rebuilt inbox still suppresses a committed key", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const directory = (yield* TestInstance).directory
      yield* createLedgerTable(db)
      const sessionID = SessionID.descending()
      yield* seedSession(db, sessionID, directory)

      admitCalls = 0
      const first = yield* withInbox(
        { db },
        Effect.gen(function* () {
          const inbox = yield* SessionInbox.Service
          yield* inbox.register(source(makeLedger(db)))
          return yield* inbox.submit("child.result", sessionID, item("restart-key"))
        }),
      )
      expect(first.state).toBe("started")
      expect(admitCalls).toBe(1)

      // A new process/layer has no in-memory state; only the durable key
      // remains, and it must still suppress the redelivery.
      admitCalls = 0
      const second = yield* withInbox(
        { db },
        Effect.gen(function* () {
          const inbox = yield* SessionInbox.Service
          yield* inbox.register(source(makeLedger(db)))
          return yield* inbox.submit("child.result", sessionID, item("restart-key"))
        }),
      )
      expect(second).toEqual({ state: "duplicate" })
      expect(admitCalls).toBe(0)
      expect(yield* count(db, "message")).toBe(1)
      expect(yield* count(db, "inbox_ledger")).toBe(1)
    }),
  )

  it.instance("a failed ledger commit rolls the message back and surfaces the admission failure", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      const { db } = yield* Database.Service
      const directory = (yield* TestInstance).directory
      yield* createLedgerTable(db)
      const sessionID = SessionID.descending()
      yield* seedSession(db, sessionID, directory)
      admitCalls = 0
      yield* inbox.register(source(makeLedger(db, () => Effect.fail(new Error("ledger commit failed")))))

      const failure = yield* Effect.flip(inbox.submit("child.result", sessionID, item("failing-key")))
      expect(failure._tag).toBe("SessionInboxAdmissionFailed")
      // The ledger never committed, so the item is not misreported as a
      // duplicate; the message written by the same transaction rolled back too.
      expect(yield* count(db, "message")).toBe(0)
      expect(yield* count(db, "inbox_ledger")).toBe(0)
      expect(admitCalls).toBe(1)
    }),
  )

  it.instance("a noReply delivery commits the key with the message and writes no turn", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      const { db } = yield* Database.Service
      const directory = (yield* TestInstance).directory
      yield* createLedgerTable(db)
      const sessionID = SessionID.descending()
      yield* seedSession(db, sessionID, directory)
      admitCalls = 0
      yield* inbox.register(source(makeLedger(db)))

      const first = yield* inbox.submit("child.result", sessionID, item("no-reply-key", { noReply: true }))
      expect(first.state).toBe("written")
      expect(yield* count(db, "message")).toBe(1)
      expect(yield* count(db, "session_turn")).toBe(0)
      expect(yield* count(db, "inbox_ledger")).toBe(1)

      const second = yield* inbox.submit("child.result", sessionID, item("no-reply-key", { noReply: true }))
      expect(second).toEqual({ state: "duplicate" })
      expect(admitCalls).toBe(1)
      expect(yield* count(db, "message")).toBe(1)
    }),
  )
})
