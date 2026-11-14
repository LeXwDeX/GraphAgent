// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as PrWatchPoller from "./poller"

import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { PrWatchTable } from "@graphagent/core/lifecycle/pr-watch.sql"
import { isTerminalValue } from "@graphagent/core/lifecycle/vocabulary"
import { and, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm"
import { Cause, Clock, Context, Deferred, Duration, Effect, Fiber, Layer, Option, Scope } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { randomUUID } from "node:crypto"
import { EngineProcess, runnerAlive } from "@/session/engine-process"
import { Lifecycle } from "@/lifecycle/service"
import {
  classifyPoll,
  DEFAULT_DEADLINE_SECONDS,
  makeProcessRunner,
  MAX_DEADLINE_SECONDS,
  MIN_DEADLINE_SECONDS,
  readSnapshot,
  type Baseline,
  type Request,
  type Runner,
  type Snapshot,
} from "./forge"

/**
 * Process-level PR/MR poller (#1071 PR2).
 *
 * The durable `pr_watch` row is the authority; this layer is a single repeating
 * fiber that finds due rows, claims each one with a conditional UPDATE, reads
 * the forge and writes the observation back. Nothing lives only in memory:
 * several layer graphs of one process and several processes share the database,
 * so the per-row CAS — not a singleton — is what keeps one poll and one
 * `lifecycle.transition` per observation.
 *
 * Claim protocol: a due row's `next_poll_at` is cleared to NULL and its
 * `process_id` set to this process's `pid:nonce` identity in one UPDATE ...
 * RETURNING. A crash mid-read leaves the row owned by a dead process with no
 * `next_poll_at`; the construction-time takeover pass (`recoverOnce`) hands
 * those rows to this process and reschedules them — unlike `RuntimeJobRecovery`
 * a leftover watch is resumed, never failed.
 *
 * Baseline rule (differs from the one-shot tool): a new head is not terminal.
 * `classifyPoll` rebaselines the row onto the new head and the watch keeps
 * running, so a push to the PR does not orphan the watch. An observed outcome
 * moves the row to `delivering` and publishes the transition; delivery itself
 * is the inbox source of PR3, not this layer.
 *
 * Deadline is checked before every forge read and also by the due scan, so an
 * overdue watch expires (`expired`, outcome `deadline`) without spawning
 * `gh`/`glab`.
 */

/** The poll cadence after a successful read. The row stores the next absolute time. */
export const POLL_INTERVAL_MS = 15_000
/** How long the loop sleeps when no watch exists. A registration wakes it early. */
const IDLE_SLEEP_MS = 60_000
/** Upper bound for one loop sleep, so a clock jump or a far deadline cannot park the loop. */
const MAX_SLEEP_MS = 60_000
const BATCH_LIMIT = 32
const READ_TIMEOUT = Duration.seconds(30)

export interface RegisterInput {
  readonly sessionID: string
  readonly request: Request
  /** Absolute watch length; clamped to the tool's published bounds. */
  readonly deadlineSeconds?: number
  /** A known head/review baseline; when absent the first successful read establishes it. */
  readonly head?: string
  readonly baselineReview?: string
  readonly id?: string
}

export interface RegisterResult {
  readonly id: string
  readonly created: boolean
}

export interface Interface {
  /**
   * Durably register a watch for one session+URL. Idempotent while a watch is
   * live; a terminal row for the same URL is replaced. Returns the watch id so
   * the caller (the `watch_pr` tool rewrite and `gh pr create` auto-registration
   * in PR4) can name it in a goal wait.
   */
  readonly register: (input: RegisterInput) => Effect.Effect<RegisterResult>
  /** One scan pass over due rows. Exported for deterministic tests. */
  readonly pollOnce: () => Effect.Effect<number>
  /** One takeover pass for rows whose owner process is gone. Returns rows taken over. */
  readonly recoverOnce: () => Effect.Effect<number>
  /** Re-arm the loop (idempotent; the startup layer forks it at construction). */
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/PrWatchPoller") {}

/**
 * The forge runner the poller spawns `gh`/`glab` through. A service rather
 * than an ambient `serviceOption` so tests can script reads; production binds
 * it to `CrossSpawnSpawner`.
 */
export class ForgeRunner extends Context.Service<ForgeRunner, { readonly run: Runner }>()(
  "@graphagent/PrWatchForgeRunner",
) {}

/** The owner token of this process's rows, the same `pid:nonce` identity `runtime_job` uses. */
export const prWatchProcessID = EngineProcess.runner.id

const ownedBy = (processID: string | null) =>
  processID === null ? isNull(PrWatchTable.process_id) : eq(PrWatchTable.process_id, processID)

const rowRequest = (row: typeof PrWatchTable.$inferSelect): Request => {
  // `host` has no port; a self-hosted forge keeps its port in the URL, and
  // `glab api --hostname` needs the authority form.
  let authority = row.host
  try {
    authority = new URL(row.url).host.toLowerCase()
  } catch {
    // A malformed persisted URL still names no live forge; keep the host.
  }
  return {
    provider: row.forge === "gitlab" ? "gitlab" : "github",
    host: row.host,
    authority,
    url: row.url,
    number: row.number,
    path: row.repo,
  }
}

const clampDeadline = (seconds: number | undefined) => {
  const value = Math.round(seconds ?? DEFAULT_DEADLINE_SECONDS)
  return Math.min(Math.max(value, MIN_DEADLINE_SECONDS), MAX_DEADLINE_SECONDS) * 1000
}

const logTickFailure = (cause: Cause.Cause<never>) =>
  Cause.hasInterrupts(cause)
    ? Effect.failCause(cause)
    : Effect.logWarning("PrWatchPoller tick failed — retrying on the next interval", { cause })

export const make = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const lifecycle = yield* Lifecycle.Service
  const forge = yield* ForgeRunner
  const scope = yield* Scope.Scope
  const owner = prWatchProcessID

  // One wake-up gate per loop iteration. Registration completes the current
  // gate so a new watch is polled at once instead of after the idle sleep; a
  // wake lost in a race is harmless because every iteration re-reads due rows.
  let wake: Deferred.Deferred<void> | undefined
  let loop: Fiber.Fiber<void> | undefined

  const publish = (id: string, from: string | null, to: string, reason: string, sessionID: string) =>
    lifecycle.transition({ ref: { domain: "pr_watch", id }, expect: from, to, reason, sessionID })

  const observeLive = (id: string, sessionID: string, phase: string) =>
    EngineProcess.prWatch.watches.set(id, { phase, sessionID, observedAt: Date.now() })

  const forgetLive = (id: string) => EngineProcess.prWatch.watches.delete(id)

  const wakeLoop = Effect.suspend(() =>
    wake === undefined ? Effect.void : Deferred.succeed(wake, undefined).pipe(Effect.asVoid),
  )

  /**
   * Converge one watching row to `expired`. The deadline condition is the
   * guard, so two processes racing the same row publish one transition.
   */
  const expire = Effect.fnUntraced(function* (id: string, sessionID: string) {
    const now = yield* Clock.currentTimeMillis
    const updated = yield* db
      .update(PrWatchTable)
      .set({ phase: "expired", outcome: "deadline", next_poll_at: null, updated_at: now })
      .where(
        and(
          eq(PrWatchTable.id, id),
          eq(PrWatchTable.phase, "watching"),
          lte(PrWatchTable.deadline_at, now),
        ),
      )
      .returning({ id: PrWatchTable.id })
      .get()
      .pipe(Effect.orDie)
    // Another process may have moved the row (expired it, or owns it now).
    // Either way this process no longer speaks for it: drop the live entry so
    // the resolver reads the durable truth.
    forgetLive(id)
    if (!updated) return false
    yield* publish(id, "watching", "expired", "deadline", sessionID)
    return true
  })

  /** The durable baseline a poll compares against; a row without a head takes the snapshot as its baseline. */
  const baselineOf = (row: typeof PrWatchTable.$inferSelect, current: Snapshot): Baseline =>
    row.head === null
      ? { head: current.head, review: current.review }
      : { head: row.head, review: row.baseline_review ?? current.review }

  /** Guarded write: only the claiming owner and a still-watching row may advance. */
  const advance = (id: string, values: Partial<typeof PrWatchTable.$inferInsert>) =>
    db
      .update(PrWatchTable)
      .set(values)
      .where(
        and(
          eq(PrWatchTable.id, id),
          eq(PrWatchTable.phase, "watching"),
          eq(PrWatchTable.process_id, owner),
        ),
      )
      .returning({ id: PrWatchTable.id })
      .get()
      .pipe(Effect.orDie)

  const pollOne = Effect.fnUntraced(function* (row: typeof PrWatchTable.$inferSelect) {
    const claimedAt = yield* Clock.currentTimeMillis
    if (claimedAt >= row.deadline_at) return yield* expire(row.id, row.session_id)

    const read = yield* readSnapshot(forge.run, rowRequest(row)).pipe(Effect.timeoutOption(READ_TIMEOUT))
    const now = yield* Clock.currentTimeMillis
    if (now >= row.deadline_at) return yield* expire(row.id, row.session_id)
    if (Option.isNone(read) || !read.value.ok) {
      // A forge read is retried until the deadline: one transient CLI failure
      // must not end a durable watch. The row keeps its baseline and stays
      // due at the next interval.
      const updated = yield* advance(row.id, { next_poll_at: now + POLL_INTERVAL_MS, updated_at: now })
      if (!updated) forgetLive(row.id)
      yield* Effect.logWarning("PrWatchPoller forge read failed — retrying", {
        watchID: row.id,
        url: row.url,
        reason: Option.isSome(read) && !read.value.ok ? read.value.reason : "read timed out",
      })
      return
    }

    const current = read.value.snapshot
    const decision = classifyPoll(baselineOf(row, current), current)
    switch (decision.kind) {
      case "observe": {
        const updated = yield* advance(row.id, {
          head: current.head,
          baseline_review: current.review,
          outcome: decision.outcome,
          phase: "delivering",
          next_poll_at: null,
          updated_at: now,
        })
        if (!updated) {
          forgetLive(row.id)
          return
        }
        observeLive(row.id, row.session_id, "delivering")
        yield* publish(row.id, "watching", "delivering", decision.outcome, row.session_id)
        return
      }
      case "rebaseline": {
        const updated = yield* advance(row.id, {
          head: decision.head,
          baseline_review: decision.review,
          next_poll_at: now + POLL_INTERVAL_MS,
          updated_at: now,
        })
        if (!updated) {
          forgetLive(row.id)
          return
        }
        observeLive(row.id, row.session_id, "watching")
        // No lifecycle value exists for "the baseline moved"; the durable row
        // is the record, and the log marks the moment for operators.
        yield* Effect.logInfo("PrWatchPoller rebaselined a watch onto a new head", {
          watchID: row.id,
          url: row.url,
          head: decision.head,
        })
        return
      }
      case "continue": {
        const updated = yield* advance(row.id, {
          ...(row.head === null ? { head: current.head, baseline_review: current.review } : {}),
          next_poll_at: now + POLL_INTERVAL_MS,
          updated_at: now,
        })
        if (!updated) {
          forgetLive(row.id)
          return
        }
        observeLive(row.id, row.session_id, "watching")
        return
      }
    }
  })

  const pollOnce = Effect.fn("PrWatchPoller.pollOnce")(function* () {
    const now = yield* Clock.currentTimeMillis
    let handled = 0
    // Overdue rows converge first and without a forge read, even when their
    // next_poll_at is still in the future (a restart can leave it that way).
    const overdue = yield* db
      .select()
      .from(PrWatchTable)
      .where(and(eq(PrWatchTable.phase, "watching"), lte(PrWatchTable.deadline_at, now)))
      .limit(BATCH_LIMIT)
      .all()
      .pipe(Effect.orDie)
    for (const row of overdue) {
      // A failure legitimately stops the pass; a defect inside one row only
      // costs that row this tick, and the loop re-reads it next time.
      const expired = yield* expire(row.id, row.session_id).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("PrWatchPoller deadline convergence failed", { cause }).pipe(Effect.as(false)),
        ),
      )
      if (expired) handled++
    }

    const due = yield* db
      .select({ id: PrWatchTable.id })
      .from(PrWatchTable)
      .where(and(eq(PrWatchTable.phase, "watching"), lte(PrWatchTable.next_poll_at, now)))
      .limit(BATCH_LIMIT)
      .all()
      .pipe(Effect.orDie)
    for (const { id } of due) {
      // The CAS claim is the only ownership test: whichever process flips
      // next_poll_at to NULL first owns this poll.
      const claimed = yield* db
        .update(PrWatchTable)
        .set({ process_id: owner, next_poll_at: null, updated_at: now })
        .where(and(eq(PrWatchTable.id, id), eq(PrWatchTable.phase, "watching"), lte(PrWatchTable.next_poll_at, now)))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!claimed) continue
      yield* pollOne(claimed).pipe(
        // A single bad row must not stop the pass; interrupts still unwind.
        Effect.catchCause(logTickFailure),
      )
      handled++
    }
    return handled
  })

  const recoverOnce = Effect.fn("PrWatchPoller.recoverOnce")(function* () {
    const rows = yield* db
      .select()
      .from(PrWatchTable)
      .where(
        and(
          inArray(PrWatchTable.phase, ["watching", "delivering"]),
          or(isNull(PrWatchTable.process_id), ne(PrWatchTable.process_id, owner)),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    const now = yield* Clock.currentTimeMillis
    let recovered = 0
    for (const row of rows) {
      // This query only excludes this process; another live process keeps its
      // rows. A `null` owner and an unparseable legacy token count as gone.
      if (runnerAlive(row.process_id)) continue
      const updated = yield* db
        .update(PrWatchTable)
        .set({
          process_id: owner,
          // A crash between claim and write leaves next_poll_at NULL; make it
          // due. A future scheduled time stays as it is.
          ...(row.phase === "watching" ? { next_poll_at: row.next_poll_at ?? now } : {}),
          updated_at: now,
        })
        .where(and(eq(PrWatchTable.id, row.id), eq(PrWatchTable.phase, row.phase), ownedBy(row.process_id)))
        .returning({ id: PrWatchTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!updated) continue
      observeLive(row.id, row.session_id, row.phase)
      recovered++
    }
    if (recovered > 0) {
      yield* Effect.logInfo("PrWatchPoller took over watches left by a dead process", { recovered })
      yield* wakeLoop
    }
    return recovered
  })

  const nextDueAt = db
    .select({ at: sql<number | null>`min(${PrWatchTable.next_poll_at})` })
    .from(PrWatchTable)
    .where(eq(PrWatchTable.phase, "watching"))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.at ?? undefined),
    )

  const loopEffect = Effect.gen(function* () {
    for (;;) {
      const gate = yield* Deferred.make<void>()
      wake = gate
      // The whole tick is guarded: a dead database or a bad row degrades to a
      // logged interval skip, never a dead loop. Scope disposal still unwinds.
      const wait = yield* Effect.gen(function* () {
        yield* pollOnce()
        const now = yield* Clock.currentTimeMillis
        const due = yield* nextDueAt
        return due === undefined ? IDLE_SLEEP_MS : Math.max(0, Math.min(due - now, MAX_SLEEP_MS))
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("PrWatchPoller tick failed — retrying next interval", { cause }).pipe(
                Effect.as(IDLE_SLEEP_MS),
              ),
        ),
      )
      yield* Effect.raceFirst(Effect.sleep(Duration.millis(wait)), Deferred.await(gate))
    }
  })

  const init = Effect.fn("PrWatchPoller.init")(function* () {
    if (loop) return
    loop = yield* loopEffect.pipe(Effect.forkIn(scope))
  })

  const register = Effect.fn("PrWatchPoller.register")(function* (input: RegisterInput) {
    const now = yield* Clock.currentTimeMillis
    const id = input.id ?? `watch_${randomUUID()}`
    const values: typeof PrWatchTable.$inferInsert = {
      id,
      forge: input.request.provider,
      host: input.request.host,
      url: input.request.url,
      repo: input.request.path,
      number: input.request.number,
      session_id: input.sessionID,
      head: input.head ?? null,
      baseline_review: input.baselineReview ?? null,
      phase: "watching",
      next_poll_at: now,
      deadline_at: now + clampDeadline(input.deadlineSeconds),
      outcome: null,
      delivery: null,
      process_id: owner,
      created_at: now,
      updated_at: now,
    }
    const insert = () =>
      db
        .insert(PrWatchTable)
        .values(values)
        .onConflictDoNothing()
        .returning({ id: PrWatchTable.id })
        .get()
        .pipe(Effect.orDie)
    const existing = () =>
      db
        .select()
        .from(PrWatchTable)
        .where(and(eq(PrWatchTable.session_id, input.sessionID), eq(PrWatchTable.url, input.request.url)))
        .get()
        .pipe(Effect.orDie)
    const created = Effect.fnUntraced(function* () {
      yield* publish(id, null, "watching", "registered", input.sessionID)
      observeLive(id, input.sessionID, "watching")
      yield* wakeLoop
      return { id, created: true } satisfies RegisterResult
    })

    if (yield* insert()) return yield* created()
    const current = yield* existing()
    if (current && !isTerminalValue("pr_watch", current.phase)) {
      // Same session+URL already watched: one durable row, one poller.
      yield* wakeLoop
      return { id: current.id, created: false } satisfies RegisterResult
    }
    if (current) {
      // The unique (session_id,url) row is terminal. A new watch is a new
      // lifecycle state, so the finished record is removed and the URL is
      // registered under a fresh id.
      yield* db
        .delete(PrWatchTable)
        .where(and(eq(PrWatchTable.id, current.id), eq(PrWatchTable.phase, current.phase)))
        .run()
        .pipe(Effect.orDie)
    }
    if (yield* insert()) return yield* created()
    // Another process won the retry; reuse whatever is now durable.
    const winner = yield* existing()
    if (!winner) return yield* Effect.die(new Error("pr_watch registration lost its row"))
    yield* wakeLoop
    return { id: winner.id, created: false } satisfies RegisterResult
  })

  return Service.of({ register, pollOnce, recoverOnce, init })
})

/** Bare service without process-start side effects; tests provide Database, Lifecycle and ForgeRunner. */
export const layer = Layer.effect(Service, make)

const startupLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const service = yield* make
    const scope = yield* Scope.Scope
    // Take over rows whose owner died, then start polling. Both are forked so
    // a slow database never blocks layer construction; the loop only reads.
    yield* service.recoverOnce().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning("PrWatchPoller takeover pass failed — a later tick retries them", { cause }),
      ),
      Effect.forkIn(scope),
    )
    yield* service.init()
    return service
  }),
)

export const runnerLayer = Layer.effect(
  ForgeRunner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return ForgeRunner.of({ run: makeProcessRunner(spawner) })
  }),
)

export const runnerNode = LayerNode.make(runnerLayer, [CrossSpawnSpawner.node])

export const defaultLayer = startupLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Database.defaultLayer,
      Lifecycle.defaultLayer,
      runnerLayer.pipe(Layer.provide(CrossSpawnSpawner.defaultLayer)),
    ),
  ),
)

export const node = LayerNode.make(startupLayer, [Database.node, Lifecycle.node, runnerNode])