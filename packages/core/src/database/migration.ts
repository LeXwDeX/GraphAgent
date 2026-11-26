export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Schema, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@graphagent/effect-drizzle-sqlite"
import { baseline, migrations } from "./migration.gen"
import schema from "./schema.gen"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

/**
 * The stored fingerprint does not match the one this build writes. The pre-release
 * baseline moves in place, so this is an expected state with a user action attached;
 * it must stay a typed error the CLI formats with that action instead of a defect.
 */
export class BaselineMismatch extends Schema.TaggedError<BaselineMismatch>()("DatabaseBaselineMismatch", {
  filename: Schema.String,
  found: Schema.String,
  expected: Schema.String,
}) {
  override get message() {
    return `数据库基线 ${this.found} 与当前版本 ${this.expected} 不一致：${this.filename} 需要删除后重建`
  }
}

/** The file holds tables but no session table, so it is not one of our databases. */
export class NotADatabase extends Schema.TaggedError<NotADatabase>()("DatabaseNotADatabase", {
  filename: Schema.String,
  tables: Schema.Number,
}) {
  override get message() {
    return `${this.filename} 已有 ${this.tables} 张表但没有 session 表，不是 GraphAgent 的数据库`
  }
}

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

export function apply(db: Database, filename: string = "database") {
  return lock.withPermit(
    Effect.gen(function* () {
      const tables = yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      if (tables.some((table) => table.name === "session")) {
        const completed = tables.some((table) => table.name === "migration")
          ? (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id)
          : []
        if (!completed.includes(baseline.id))
          return yield* Effect.fail(new BaselineMismatch({ filename, found: completed.join(",") || "none", expected: baseline.id }))
        return yield* applyOnly(db, migrations)
      }
      if (tables.length > 0) return yield* Effect.fail(new NotADatabase({ filename, tables: tables.length }))
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* schema.up(tx)
          yield* tx.run(
            sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
          )
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${baseline.id}, ${Date.now()})`,
          )
        }),
      )
    }),
  )
}

export function applyOnly(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    const completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    for (const migration of input) {
      if (completed.has(migration.id)) continue
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* migration.up(tx)
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }),
      )
    }
  })
}
