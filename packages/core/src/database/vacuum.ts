// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as Vacuum from "./vacuum"

import { EffectDrizzleSqlite } from "@graphagent/effect-drizzle-sqlite"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem, Schema } from "effect"
import { sql } from "drizzle-orm"
import { layer } from "#sqlite"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

export interface ConvertResult {
  /** Readback of `PRAGMA auto_vacuum` after conversion: 1 == FULL. */
  readonly autoVacuum: number
}

export class Refused extends Schema.TaggedError<Refused>()("VacuumRefused", {
  filename: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `refusing to vacuum ${this.filename}: ${this.reason}`
  }
}

export class NotFull extends Schema.TaggedError<NotFull>()("VacuumNotFull", {
  filename: Schema.String,
  // -1 encodes an unreadable readback (the pragma returned no row).
  autoVacuum: Schema.Number,
}) {
  override get message() {
    return `vacuum did not take full effect for ${this.filename}: PRAGMA auto_vacuum reads back ${this.autoVacuum}, expected 1 (FULL) — close running opencode processes that use this file and retry`
  }
}

/**
 * #524 Phase 2 gate and the only success path of `convertToFull`: after the
 * FULL -> VACUUM -> wal_checkpoint(TRUNCATE) sequence the readback must be
 * exactly FULL (1), otherwise the conversion silently failed (e.g. a writer
 * kept the file alive through VACUUM) and must surface as a nonzero failure
 * with actionable diagnostics — never as a success result. Exported as the
 * deterministic seam that lets tests prove a non-FULL readback cannot report
 * success.
 */
export const verifyFull = (filename: string, readback: number | undefined): Effect.Effect<ConvertResult, NotFull> =>
  readback === 1
    ? Effect.succeed({ autoVacuum: readback })
    : Effect.fail(new NotFull({ filename, autoVacuum: readback ?? -1 }))

// #524: refuse every target that is not an existing regular file BEFORE any
// SQLite open — the driver opens with create enabled, so a typo'd path would
// otherwise silently materialize a fresh empty database.
const validateTarget = Effect.fn("Vacuum.validateTarget")(function* (fs: FileSystem.FileSystem, filename: string) {
  if (filename === ":memory:") yield* new Refused({ filename, reason: ":memory: is not a file on disk" })
  const info = yield* fs.stat(filename).pipe(Effect.catch(() => Effect.void))
  if (info === undefined) {
    yield* new Refused({
      filename,
      reason: "no such file — vacuum never creates a database (print the default path with `opencode db path`)",
    })
    return
  }
  if (info.type !== "File") yield* new Refused({ filename, reason: `not a regular file (${info.type})` })
})

const convert = (filename: string) =>
  Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run(sql`PRAGMA busy_timeout = 5000`)
    yield* db.run(sql`PRAGMA auto_vacuum = FULL`)
    yield* db.run(sql`VACUUM`)
    yield* db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`)
    const mode = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`)
    return mode?.auto_vacuum
  }).pipe(Effect.provide(layer({ filename })))

/**
 * #524 Phase 2: explicit, user-triggered conversion of a legacy
 * auto_vacuum=NONE database to FULL. Runs OUTSIDE startup and never touches a
 * default database path implicitly — the caller names the file (the CLI
 * surface requires an explicit `--db`, so tests only ever pass disposable
 * temp paths), and the target must already exist as a regular file: vacuum
 * never creates a database. The FULL → VACUUM → wal_checkpoint(TRUNCATE)
 * sequence rebuilds the database with FULL enabled and truncates the WAL; a
 * concurrent writer makes VACUUM fail with SQLITE_BUSY instead of corrupting
 * anything, and a non-FULL readback fails via `verifyFull`. Incremental
 * auto-vacuum is deliberately never used anywhere.
 */
export const convertToFull = (filename: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* validateTarget(fs, filename)
    const readback = yield* convert(filename)
    return yield* verifyFull(filename, readback)
  }).pipe(Effect.provide(NodeFileSystem.layer))
