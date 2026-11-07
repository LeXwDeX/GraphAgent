import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { fileURLToPath } from "url"
import path from "path"
import fs from "fs/promises"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { baseline } from "@opencode-ai/core/database/migration.gen"
import { Database } from "@opencode-ai/core/database/database"
import type { SqlClient as SqlClientService } from "effect/sql/SqlClient"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

describe("DatabaseMigration", () => {
  test("serializes concurrent embedded initialization for one database path", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "embedded.sqlite")
    const layers = [Database.layerFromPath(filename), Database.layerFromPath(filename)]

    await Effect.runPromise(
      Effect.all(
        layers.map((layer) => Effect.scoped(Layer.build(layer))),
        { concurrency: "unbounded" },
      ),
    )
  })
  if (process.platform === "linux") {
    test("declared schema has no ungenerated migrations", async () => {
      const result = await $`bun ${fileURLToPath(new URL("../script/migration.ts", import.meta.url))} --check`
        .quiet()
        .nothrow()
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toContain("No schema changes, nothing to migrate")
    }, 30_000)

    test("pre-release generation refuses incremental migrations", async () => {
      const result = await $`bun ${fileURLToPath(new URL("../script/migration.ts", import.meta.url))}`.quiet().nothrow()
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain("--rebaseline")
    }, 30_000)

    test("check rejects a manually added incremental migration in pre-release", async () => {
      const probe = path.join(
        fileURLToPath(new URL("../src/database/migration", import.meta.url)),
        "20990101000000_probe.ts",
      )
      await Bun.write(probe, 'export default { id: "20990101000000_probe", up() {} }\n')
      try {
        const result = await $`bun ${fileURLToPath(new URL("../script/migration.ts", import.meta.url))} --check`
          .quiet()
          .nothrow()
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr.toString()).toContain("must not contain incremental migrations")
      } finally {
        await fs.rm(probe, { force: true })
      }
    }, 30_000)

    test("freeze blocks rebaseline and restores incremental generation", async () => {
      const script = fileURLToPath(new URL("../script/migration.ts", import.meta.url))
      const lock = fileURLToPath(new URL("../baseline.lock", import.meta.url))
      expect(await Bun.file(lock).exists()).toBe(false)
      try {
        const freeze = await $`bun ${script} --freeze-baseline`.quiet().nothrow()
        expect(freeze.exitCode, freeze.stderr.toString()).toBe(0)
        expect((await Bun.file(lock).text()).trim()).toBe(baseline.id)

        const rebaseline = await $`bun ${script} --rebaseline`.quiet().nothrow()
        expect(rebaseline.exitCode).not.toBe(0)

        const generate = await $`bun ${script}`.quiet().nothrow()
        expect(generate.exitCode, generate.stderr.toString()).toBe(0)

        const check = await $`bun ${script} --check`.quiet().nothrow()
        expect(check.exitCode, check.stderr.toString()).toBe(0)
      } finally {
        await fs.rm(lock, { force: true })
      }
    }, 60_000)
  }

  test("applies the baseline to an empty database", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)

        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'`)).toEqual({
          name: "session",
        })
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('event', 'project', 'workflow', 'workflow_node', 'agent_message') ORDER BY name`,
          ),
        ).toEqual([
          { name: "agent_message" },
          { name: "event" },
          { name: "project" },
          { name: "workflow" },
          { name: "workflow_node" },
        ])
        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: baseline.id }])
      }),
    )
  })

  test("reopening a baseline database is idempotent", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "reopen.sqlite")
    await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))
    await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* makeDb
        return yield* db.all<{ id: string }>(sql`SELECT id FROM migration`)
      }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped),
    )
    expect(rows).toEqual([{ id: baseline.id }])
  })

  test("rejects a non-empty database without a session table", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE other (id TEXT PRIMARY KEY)`)
        const exit = yield* Effect.exit(DatabaseMigration.apply(db))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration'`)).toBe(
          undefined,
        )
      }),
    )
  })

  test("rejects a baseline fingerprint mismatch without writing", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('baseline-stale', 0)`)
        const exit = yield* Effect.exit(DatabaseMigration.apply(db))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: "baseline-stale" }])
      }),
    )
  })

  test("rejects a baseline database whose migration journal is missing", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
        const exit = yield* Effect.exit(DatabaseMigration.apply(db))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration'`)).toBe(
          undefined,
        )
      }),
    )
  })
})
