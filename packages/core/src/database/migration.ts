export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { baseline, migrations } from "./migration.gen"
import schema from "./schema.gen"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

const mismatch = "数据库基线与当前版本不一致；v2.0.0 发布前请删除开发库后重新启动（v1 的库不能直接复制，见迁移指南）"

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

export function apply(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      const tables = yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      if (tables.some((table) => table.name === "session")) {
        const completed = tables.some((table) => table.name === "migration")
          ? (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id)
          : []
        if (!completed.includes(baseline.id)) return yield* Effect.die(mismatch)
        return yield* applyOnly(db, migrations)
      }
      if (tables.length > 0) return yield* Effect.die("Database is not empty and has no session table")
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
