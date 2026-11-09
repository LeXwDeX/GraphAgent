// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Database as BunSqlite } from "bun:sqlite"
import { EffectDrizzleSqlite } from "@graphagent/effect-drizzle-sqlite"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Cause, Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { classifySqliteError, SqlError } from "effect/sql/SqlError"
import { existsSync } from "fs"
import { sql } from "drizzle-orm"
import path from "path"
import { Database } from "@graphagent/core/database/database"
import { DatabaseMigration } from "@graphagent/core/database/migration"
import { Vacuum } from "@graphagent/core/database/vacuum"
import { ProjectV2 } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionSchema } from "@graphagent/core/session/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { layer as repoSqliteLayer } from "#sqlite"
import { tmpdir } from "./fixture/tmpdir"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

// Seeds an application-created LEGACY database shape: WAL initialized,
// auto_vacuum left at its NONE default, real migrations applied, user rows
// present. Disposable temp files only — never a real graphagent.db path.
const seedLegacyDatabase = (filename: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run(sql`PRAGMA journal_mode = WAL`)
      yield* DatabaseMigration.apply(db)
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.make("proj_legacy"), worktree: AbsolutePath.make("/legacy"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionSchema.ID.make("ses_legacy"),
          project_id: ProjectV2.ID.make("proj_legacy"),
          slug: "legacy",
          directory: "/legacy",
          title: "legacy",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped),
  )

const readFileMode = (filename: string) => {
  const native = new BunSqlite(filename, { readonly: true, create: false })
  try {
    const autoVacuum = native.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()
    const freelist = native.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()
    const integrity = native.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
    const rows = native.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session").get()
    return {
      autoVacuum: autoVacuum?.auto_vacuum ?? -1,
      freelist: freelist?.freelist_count ?? -1,
      integrity: integrity?.integrity_check ?? "unknown",
      sessionRows: rows?.count ?? -1,
    }
  } finally {
    native.close()
  }
}

describe("Database auto_vacuum (#524 Phase 2)", () => {
  test("initializes genuinely new databases with auto_vacuum=FULL before WAL", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "new.sqlite")
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service

        const mode = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(Effect.orDie)
        expect(mode?.auto_vacuum).toBe(1)
        const journal = yield* db.get<{ journal_mode: string }>(sql`PRAGMA journal_mode`).pipe(Effect.orDie)
        expect(String(journal?.journal_mode).toLowerCase()).toBe("wal")

        // The real application layer (migrations included) preserves the mode.
        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.make("proj_new"), worktree: AbsolutePath.make("/new"), sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        const after = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(Effect.orDie)
        expect(after?.auto_vacuum).toBe(1)
      }).pipe(Effect.provide(Database.layerFromPath(filename))),
    )
  })

  test("never converts an existing auto_vacuum=NONE database at startup", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "legacy.sqlite")
    await seedLegacyDatabase(filename)
    expect(readFileMode(filename).autoVacuum).toBe(0)

    // The production startup sequence (driver pragmas + migrations) must be a
    // silent no-op for the legacy mode — converting without the explicit
    // user-triggered command is forbidden.
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const mode = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(Effect.orDie)
        expect(mode?.auto_vacuum).toBe(0)
        expect(
          (yield* db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM session`).pipe(Effect.orDie))?.count,
        ).toBe(1)
      }).pipe(Effect.provide(Database.layerFromPath(filename))),
    )
    const after = readFileMode(filename)
    expect(after.autoVacuum).toBe(0)
    expect(after.sessionRows).toBe(1)
    expect(after.integrity).toBe("ok")
  })

  test("explicit conversion runs FULL -> VACUUM -> wal TRUNCATE with data intact", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "legacy-convert.sqlite")
    await seedLegacyDatabase(filename)
    expect(readFileMode(filename).autoVacuum).toBe(0)

    const result = await Effect.runPromise(Vacuum.convertToFull(filename))
    expect(result.autoVacuum).toBe(1)

    const after = readFileMode(filename)
    expect(after.autoVacuum).toBe(1)
    expect(after.freelist).toBe(0)
    expect(after.sessionRows).toBe(1)
    expect(after.integrity).toBe("ok")
  })

  test("refuses a nonexistent target before opening SQLite and never creates it", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "typo.sqlite")

    const exit = await Effect.runPromiseExit(Vacuum.convertToFull(filename))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const rendered = Cause.pretty(exit.cause)
      expect(rendered).toContain("refusing to vacuum")
      expect(rendered).toContain("no such file")
    }
    // The typo must not have materialized a database (nor WAL/SHM siblings).
    expect(existsSync(filename)).toBe(false)
    expect(existsSync(`${filename}-wal`)).toBe(false)
    expect(existsSync(`${filename}-shm`)).toBe(false)
  })

  test("refuses :memory: and non-file targets", async () => {
    const memory = await Effect.runPromiseExit(Vacuum.convertToFull(":memory:"))
    expect(Exit.isFailure(memory)).toBe(true)
    if (Exit.isFailure(memory)) expect(Cause.pretty(memory.cause)).toContain("not a file on disk")

    await using tmp = await tmpdir()
    const directory = await Effect.runPromiseExit(Vacuum.convertToFull(tmp.path))
    expect(Exit.isFailure(directory)).toBe(true)
    if (Exit.isFailure(directory)) expect(Cause.pretty(directory.cause)).toContain("not a regular file")
    expect(existsSync(tmp.path)).toBe(true)
  })

  // Deterministic proof that a non-FULL readback can never report success:
  // `verifyFull` is the only success path of `convertToFull`.
  test("a non-FULL readback fails with actionable diagnostics via verifyFull", async () => {
    const zero = await Effect.runPromiseExit(Vacuum.verifyFull("stuck.sqlite", 0))
    expect(Exit.isFailure(zero)).toBe(true)
    if (Exit.isFailure(zero)) {
      const rendered = Cause.pretty(zero.cause)
      expect(rendered).toContain("VacuumNotFull")
      expect(rendered).toContain("stuck.sqlite")
      expect(rendered).toContain("expected 1 (FULL)")
      expect(rendered).toContain("retry")
    }

    const unreadable = await Effect.runPromiseExit(Vacuum.verifyFull("stuck.sqlite", undefined))
    expect(Exit.isFailure(unreadable)).toBe(true)

    const ok = await Effect.runPromise(Vacuum.verifyFull("converted.sqlite", 1))
    expect(ok.autoVacuum).toBe(1)
  })

  // Layer/failure regression: a failed auto_vacuum readback must soft-degrade
  // with a warning — the startup layer must not die (its body is orDie'd), so
  // migrations still apply and the service stays usable.
  test("a failed auto_vacuum readback soft-degrades instead of killing startup", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "readback-failure.sqlite")

    // Real repository sqlite client stack (#sqlite = the production driver),
    // except every auto_vacuum statement fails at the Database.layer level.
    const failingReadbackLayer = Layer.effect(
      SqlClient,
      Effect.gen(function* () {
        const client = yield* SqlClient
        const failure = new SqlError({
          reason: classifySqliteError(new Error("simulated auto_vacuum readback failure"), {
            message: "Failed to execute statement",
            operation: "execute",
          }),
        })
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test decorator over the real client, shape-preserving at runtime
        return Object.assign({}, client, {
          unsafe: (query: string, params?: ReadonlyArray<unknown>) => {
            const statement = client.unsafe(query, params)
            if (!query.toLowerCase().includes("auto_vacuum")) return statement
            return Object.assign({}, statement, {
              withoutTransform: Effect.fail(failure),
              values: Effect.fail(failure),
            })
          },
        }) as SqlClient
      }),
    ).pipe(Layer.provide(repoSqliteLayer({ filename })))

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        // Startup ran past the failed readback: migrations were applied and
        // the service is usable.
        const tables = yield* db
          .get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'session'`)
          .pipe(Effect.orDie)
        expect(tables?.count).toBe(1)
      }).pipe(Effect.provide(Database.layer.pipe(Layer.provide(failingReadbackLayer)))),
    )
    // The database file itself was created and initialized normally.
    expect(readFileMode(filename).autoVacuum).toBe(1)
  })

  test("incremental_vacuum never appears in executable database code", async () => {
    const databaseDir = path.join(import.meta.dir, "..", "src", "database")
    const glob = new Bun.Glob("**/*.ts")
    const offenders: string[] = []
    for await (const file of glob.scan({ cwd: databaseDir })) {
      const content = await Bun.file(path.join(databaseDir, file)).text()
      if (/incremental_vacuum/i.test(content)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})
