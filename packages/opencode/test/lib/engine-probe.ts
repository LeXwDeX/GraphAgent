import { Database as BunDatabase, type SQLQueryBindings } from "bun:sqlite"
import { mock } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { AppProcess } from "@opencode-ai/core/process"
import { Context, Effect, Fiber, Layer, Schema, Scope, Semaphore, Stream } from "effect"
import * as Client from "effect/sql/SqlClient"
import type { Connection } from "effect/sql/SqlConnection"
import { SqlError, classifySqliteError } from "effect/sql/SqlError"
import * as Statement from "effect/sql/Statement"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as MessageV2 from "@/session/message-v2"
import * as ToolJsonSchema from "@/tool/json-schema"
import { Snapshot } from "@/snapshot"

// Engine-level counters for the H0 performance baseline (Issue #1009).
//
// The probe wraps the production layers instead of changing them: a counting
// SQL client mirrors packages/core/src/database/sqlite.bun.ts `make`, and thin
// layer decorators count EventV2 publishes and AppProcess git spawns. Counts
// are process-global because each Bun test file runs in its own process; call
// `reset()` after seeding and before measuring.
export type CounterKey =
  | "sql.read"
  | "sql.write"
  | "commits"
  | "json.parseBytes"
  | "json.encodeBytes"
  | "sha256Bytes"
  | "git.spawns"
  | "snapshot.lockWaits"
  | "events.durable"
  | "events.ephemeral"
  | "convert.messages"
  | "schema.fromSchema"

export type Counters = Record<CounterKey, number>

function zero(): Counters {
  return {
    "sql.read": 0,
    "sql.write": 0,
    commits: 0,
    "json.parseBytes": 0,
    "json.encodeBytes": 0,
    sha256Bytes: 0,
    "git.spawns": 0,
    "snapshot.lockWaits": 0,
    "events.durable": 0,
    "events.ephemeral": 0,
    "convert.messages": 0,
    "schema.fromSchema": 0,
  }
}

const counters = zero()
let activityTicks = 0
let inFlight = 0

/** Count one unit for a counter key and mark probe activity. */
export function note(key: CounterKey, amount = 1) {
  counters[key] += amount
  activityTicks += 1
}

/** Mark probe activity without counting (for request fingerprints and waits). */
export function touch() {
  activityTicks += 1
}

// JSON parse bytes. Event payloads live in `text({ mode: "json" })` columns
// (packages/core/src/event/sql.ts), so the driver parses them with whichever
// `JSON.parse` is current at call time; there is no project symbol to wrap
// without touching `src/`. Patching the process-global once per test process
// measures every parse the engine performs, including event reads and JSON
// columns of messages and parts. The probe's own serialization stays on the
// captured native function so it adds no engine bytes.
const nativeParse = JSON.parse
let jsonParseCounted = false
function installJsonParseCounter() {
  if (jsonParseCounted) return
  jsonParseCounted = true
  JSON.parse = ((text: string, reviver?: unknown) => {
    if (typeof text === "string") note("json.parseBytes", Buffer.byteLength(text))
    return nativeParse(text, reviver as never)
  }) as typeof JSON.parse
}
installJsonParseCounter()

// `convert.messages` and `schema.fromSchema` are plain module functions, not
// Effect services, so the probe replaces their exports for this test process.
// The mock factories spread the real namespace and delegate to the captured
// originals, so behavior is unchanged; each Bun test file runs in its own
// process, keeping the replacement scoped to the perf suite.
const messageV2Exports = { ...MessageV2 }
const jsonSchemaExports = { ...ToolJsonSchema }
const realToModelMessagesEffect = messageV2Exports.toModelMessagesEffect
const realFromSchema = jsonSchemaExports.fromSchema

mock.module("@/session/message-v2", () => ({
  ...messageV2Exports,
  toModelMessagesEffect: (...args: Parameters<typeof realToModelMessagesEffect>) =>
    Effect.suspend(() => {
      // One unit per input message converted for the next provider request.
      note("convert.messages", args[0]?.length ?? 0)
      return realToModelMessagesEffect(...args)
    }),
}))

mock.module("@/tool/json-schema", () => ({
  ...jsonSchemaExports,
  fromSchema: (...args: Parameters<typeof realFromSchema>) => {
    note("schema.fromSchema")
    return realFromSchema(...args)
  },
}))

export function snapshot(): Counters {
  return { ...counters }
}

/** Reset counters. Also resets the quiescence detector used by `settle()`. */
export function reset() {
  for (const key of Object.keys(counters) as CounterKey[]) counters[key] = 0
  activityTicks = 0
  inFlight = 0
}

export function inFlightCount() {
  return inFlight
}

export function activityCount() {
  return activityTicks
}

/**
 * Wait until background work has stopped touching the probe. Each round is a
 * real timer tick (not TestClock) because background forks wait on real I/O
 * such as SQLite and the fake provider stream. A quiet gap with no activity
 * ticks and no in-flight operation means fire-and-forget work has drained.
 */
export function settle(options?: {
  readonly quietMs?: number
  readonly timeoutMs?: number
  readonly activity?: () => number
  readonly pollMs?: number
}) {
  const quietMs = options?.quietMs ?? 250
  const timeoutMs = options?.timeoutMs ?? 10_000
  const pollMs = options?.pollMs ?? 20
  const activity = () => activityTicks + inFlight + (options?.activity?.() ?? 0)
  return Effect.gen(function* () {
    const started = Date.now()
    let last = activity()
    let quietSince = Date.now()
    while (true) {
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, pollMs)))
      yield* Effect.yieldNow
      const now = Date.now()
      const current = activity()
      if (current !== last) {
        last = current
        quietSince = now
        continue
      }
      if (inFlight === 0 && now - quietSince >= quietMs) return
      if (now - started >= timeoutMs) {
        return yield* Effect.die(
          new Error(
            `engine probe settle timed out after ${timeoutMs}ms (inFlight=${inFlight}, activity=${activityTicks})`,
          ),
        )
      }
    }
  })
}

function firstKeyword(statement: string) {
  return statement.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? ""
}

function countStatement(statement: string) {
  const keyword = firstKeyword(statement)
  if (keyword === "select" || keyword === "pragma" || keyword === "explain" || keyword === "with") {
    note("sql.read")
    return
  }
  if (keyword === "commit") {
    note("commits")
    return
  }
  if (
    keyword === "insert" ||
    keyword === "update" ||
    keyword === "delete" ||
    keyword === "replace" ||
    keyword === "create" ||
    keyword === "drop" ||
    keyword === "alter" ||
    keyword === "vacuum"
  ) {
    note("sql.write")
  }
}

// The Database layer's sqlite client is a closed graph (its native provider
// cannot be overridden from outside), so the probe builds its own SqlClient
// mirroring the driver's `make`, wrapping the native to count statements.
//
// This duplicates ~85 lines of packages/core/src/database/sqlite.bun.ts `make`
// (run/runValues/connection/semaphore/transactionAcquirer), the same deliberate
// debt recorded by test/session/fork-batch.test.ts. Keep both copies in sync.
export const countingClientLayer = Layer.effect(
  Client.SqlClient,
  Effect.gen(function* () {
    const native = new BunDatabase(":memory:")
    native.run("PRAGMA journal_mode = WAL;")
    const counting = new Proxy(native, {
      get(target, prop) {
        if (prop === "query") {
          return (statement: string) => {
            countStatement(statement)
            return target.query(statement)
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
      spanAttributes: [["db.system.name", "sqlite"]],
    })
  }),
)

/** Production Database layer backed by the counting SQL client. */
export const countingDatabaseLayer = Database.layer.pipe(
  Layer.provide(countingClientLayer.pipe(Layer.provide(Reactivity.layer))),
)

function countEvent(definition: EventV2.Definition, data: unknown) {
  const durable = definition.durable !== undefined
  if (durable) note("events.durable")
  else note("events.ephemeral")
  let encoded: unknown
  try {
    encoded = Schema.encodeUnknownSync(definition.data)(data)
  } catch {
    // The production publish path will surface the encoding failure itself.
    return
  }
  let text: string
  try {
    text = JSON.stringify(encoded)
  } catch {
    return
  }
  const bytes = Buffer.byteLength(text)
  note("json.encodeBytes", bytes)
  if (durable) note("sha256Bytes", bytes)
}

/**
 * Wrap an EventV2 layer so publishes are counted by durability class and the
 * serialized payload bytes that feed JSON encoding and sha256 are measured with
 * the same `Schema.encodeUnknownSync` + `JSON.stringify` the bus uses.
 */
export const countingEventLayer = (base: Layer.Layer<EventV2.Service>) =>
  Layer.effect(
    EventV2.Service,
    Effect.gen(function* () {
      const service = yield* EventV2.Service
      return EventV2.Service.of({
        ...service,
        publish: (definition, data, options) =>
          Effect.suspend(() => {
            countEvent(definition, data)
            inFlight += 1
            return service.publish(definition, data, options)
          }).pipe(Effect.ensuring(Effect.sync(() => inFlight--))),
        publishMany: (entries, options) =>
          Effect.suspend(() => {
            for (const entry of entries) countEvent(entry.definition, entry.data)
            inFlight += 1
            return service.publishMany(entries, options)
          }).pipe(Effect.ensuring(Effect.sync(() => inFlight--))),
      })
    }),
  ).pipe(Layer.provide(base))

function isGitCommand(command: Parameters<AppProcess.Interface["run"]>[0]): boolean {
  if (command._tag === "StandardCommand") return command.command === "git"
  return isGitCommand(command.left) || isGitCommand(command.right)
}

/** Wrap AppProcess so git child processes and long-running calls are observable. */
export const countingAppProcessLayer = Layer.effect(
  AppProcess.Service,
  Effect.gen(function* () {
    const service = yield* AppProcess.Service
    return AppProcess.Service.of({
      ...service,
      run: (command, options) =>
        Effect.suspend(() => {
          if (isGitCommand(command)) note("git.spawns")
          inFlight += 1
          return service.run(command, options)
        }).pipe(Effect.ensuring(Effect.sync(() => inFlight--))),
      runStream: (command, options) => {
        if (isGitCommand(command)) note("git.spawns")
        return Stream.unwrap(
          Effect.suspend(() => {
            inFlight += 1
            return Effect.succeed(
              service.runStream(command, options).pipe(Stream.ensuring(Effect.sync(() => inFlight--))),
            )
          }),
        )
      },
    })
  }),
).pipe(Layer.provide(AppProcess.defaultLayer))

/** Counting EventV2 layer on top of the counting database. */
export const countingEventBusLayer = countingEventLayer(EventV2.layer.pipe(Layer.provide(countingDatabaseLayer)))

/**
 * Wrap Snapshot so calls that queue behind the per-worktree git semaphore are
 * counted. `snapshot/index.ts` keeps its semaphore private, so the probe counts
 * service calls that enter while another locked call is still running: every
 * public locked method (cleanup/track/patch/restore/revert/diff/diffFull)
 * takes the same single-permit lock, making overlap equal to a lock wait.
 */
export const countingSnapshotLayer = <E, R>(base: Layer.Layer<Snapshot.Service, E, R>) =>
  Layer.effect(
    Snapshot.Service,
    Effect.gen(function* () {
      const service = yield* Snapshot.Service
      let active = 0
      const counted = <A, E2, R2>(fx: () => Effect.Effect<A, E2, R2>): Effect.Effect<A, E2, R2> =>
        Effect.suspend(() => {
          if (active > 0) note("snapshot.lockWaits")
          active += 1
          return fx().pipe(Effect.ensuring(Effect.sync(() => (active -= 1))))
        })
      return Snapshot.Service.of({
        init: service.init,
        cleanup: () => counted(() => service.cleanup()),
        track: () => counted(() => service.track()),
        patch: (hash) => counted(() => service.patch(hash)),
        restore: (snapshot) => counted(() => service.restore(snapshot)),
        revert: (patches) => counted(() => service.revert(patches)),
        diff: (hash) => counted(() => service.diff(hash)),
        diffFull: (from, to) => counted(() => service.diffFull(from, to)),
      })
    }),
  ).pipe(Layer.provide(base))
