export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Cause, Context, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { LayerNode } from "../effect/layer-node"
import { APP_NAME } from "../brand"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    // #524: genuinely new databases were switched to auto_vacuum=FULL by the
    // sqlite driver BEFORE WAL init. A legacy database keeps its NONE mode —
    // converting one silently at startup would need a blocking full VACUUM —
    // so it is only detected and surfaced softly here; conversion is the
    // explicit user-triggered `opencode db vacuum --db <path>` command.
    // Detect-only means detect-only: a failed readback degrades to a warning
    // (the layer body is orDie'd, so an unhandled failure would kill startup),
    // while an interruption is always re-raised.
    const autoVacuum = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning("database auto_vacuum readback failed — skipping the detect-only check", { cause }).pipe(
              Effect.as(undefined),
            ),
      ),
    )
    if (autoVacuum?.auto_vacuum === 0)
      yield* Effect.logWarning(
        "database auto_vacuum is NONE — deleted pages stay allocated until converted; run `opencode db vacuum --db <path>` (prints its path with `opencode db path`)",
      )
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

export function path() {
  if (Flag.GRAPHAGENT_DB) {
    if (Flag.GRAPHAGENT_DB === ":memory:" || isAbsolute(Flag.GRAPHAGENT_DB)) return Flag.GRAPHAGENT_DB
    return join(Global.Path.data, Flag.GRAPHAGENT_DB)
  }
  if (["latest", "beta", "prod"].includes(InstallationChannel)) return join(Global.Path.data, `${APP_NAME}.db`)
  return join(Global.Path.data, `${APP_NAME}-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

export const defaultLayer = Layer.unwrap(
  Effect.gen(function* () {
    return layerFromPath(path())
  }),
).pipe(Layer.provide(Global.defaultLayer))

export const node = LayerNode.make(layerFromPath(path()), [])
