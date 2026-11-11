import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { drizzle } from "drizzle-orm/node-sqlite"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as Client from "effect/sql/SqlClient"
import type { Connection } from "effect/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/sql/SqlError"
import * as Statement from "effect/sql/Statement"
import { Sqlite } from "./sqlite"
import { DatabaseMetrics } from "./metrics"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const TypeId = "~@graphagent/core/database/SqliteNode" as const
type TypeId = typeof TypeId

interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: Config
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
  readonly updateValues: never
}

interface Config {
  readonly filename: string
  readonly readonly?: boolean
  readonly create?: boolean
  readonly readwrite?: boolean
  readonly disableWAL?: boolean
  readonly timeout?: number
  readonly allowExtension?: boolean
  readonly spanAttributes?: Record<string, unknown>
  readonly transformResultNames?: (str: string) => string
  readonly transformQueryNames?: (str: string) => string
}

interface SqliteConnection extends Connection {
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
}

const make = (options: Config) =>
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as DatabaseSync

    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<Record<string, unknown>>, SqlError>((fiber) => {
        DatabaseMetrics.recordSql(query)
        const statement = native.prepare(query)
        statement.setReadBigInts(Context.get(fiber.context, Client.SafeIntegers))
        try {
          return Effect.succeed(statement.all(...(params as SQLInputValue[])) as Array<Record<string, unknown>>)
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })

    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>((fiber) => {
        DatabaseMetrics.recordSql(query)
        const statement = native.prepare(query)
        statement.setReadBigInts(Context.get(fiber.context, Client.SafeIntegers))
        statement.setReturnArrays(true)
        try {
          return Effect.succeed(
            statement.all(...(params as SQLInputValue[])) as unknown as ReadonlyArray<ReadonlyArray<unknown>>,
          )
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })

    const connection = identity<SqliteConnection>({
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
      loadExtension: (path) =>
        Effect.try({
          try: () => native.loadExtension(path),
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to load extension", operation: "loadExtension" }),
            }),
        }),
    })

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

    const client = Object.assign(
      (yield* Client.make({
        acquirer,
        compiler,
        driver: "sqlite-node",
        transactionAcquirer,
        // SQLite keeps the transaction open after deferred constraint commit
        // failures, so a failed COMMIT rolls back before releasing the
        // connection. A rollback that fails as well only poisons this attempt;
        // the original commit error still surfaces.
        onCommitFailure: (conn) => Effect.ignore(conn.executeUnprepared("ROLLBACK", [], undefined)),
        // SQLite supports releasing nested savepoints; nested transactions are
        // only released when the client declares the statement.
        releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
        spanAttributes: [
          ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
          [ATTR_DB_SYSTEM_NAME, "sqlite"],
        ],
        transformRows,
      })) as SqliteClient,
      {
        [TypeId]: TypeId,
        config: options,
        loadExtension: (path: string) => Effect.flatMap(acquirer, (_) => _.loadExtension(path)),
      },
    )

    return client
  })

const nativeLayer = (config: Config) =>
  Layer.effect(
    Sqlite.Native,
    Effect.gen(function* () {
      const native = new DatabaseSync(config.filename, {
        readOnly: config.readonly,
        timeout: config.timeout,
        allowExtension: config.allowExtension,
        enableForeignKeyConstraints: true,
        open: true,
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => native.close()))
      // #524: auto_vacuum must be set BEFORE any WAL initialization — after
      // WAL init the pragma silently yields NONE even on an empty database.
      // On an existing non-empty database the pragma is a SQLite no-op, so
      // legacy NONE databases are never converted here (startup stays
      // detect-only; the explicit conversion lives in ./vacuum).
      native.exec("PRAGMA busy_timeout = 5000;")
      if (config.readonly !== true) setAutoVacuumFull(native)
      if (config.disableWAL !== true && config.readonly !== true) native.exec("PRAGMA journal_mode = WAL;")
      return native
    }),
  )

/**
 * Setting auto_vacuum needs the write lock of a read-header-then-write
 * upgrade, which SQLite fails with an immediate SQLITE_BUSY the busy handler
 * cannot retry — a second opener racing the first one's initialization on the
 * same new file hits it. Skipping on BUSY is safe: auto_vacuum is a
 * persistent header property and every opener runs this pragma BEFORE any
 * WAL/migration write, so whichever connection wins the first-write race sets
 * FULL for the database.
 */
function setAutoVacuumFull(native: DatabaseSync) {
  const page: unknown = native.prepare("PRAGMA page_count").get()
  const pageCount = typeof page === "object" && page !== null && "page_count" in page ? page.page_count : undefined
  if (typeof pageCount !== "number" || pageCount !== 0) return
  try {
    native.exec("PRAGMA auto_vacuum = FULL;")
  } catch (cause) {
    if (!isSqliteBusy(cause)) throw cause
  }
}

const isSqliteBusy = (cause: unknown) => cause instanceof Error && /SQLITE_BUSY|database is locked/i.test(cause.message)

const sqliteLayer = (config: Config) => Layer.effect(Client.SqlClient, make(config))

const drizzleLayer = Layer.effect(
  Sqlite.Drizzle,
  Effect.gen(function* () {
    return drizzle({ client: (yield* Sqlite.Native) as DatabaseSync }) as unknown as Sqlite.DrizzleClient
  }),
)

export const layer = (config: Config) => {
  const native = nativeLayer(config)
  return Layer.merge(native, Layer.merge(sqliteLayer(config), drizzleLayer).pipe(Layer.provide(native))).pipe(
    Layer.provide(Reactivity.layer),
  )
}
