// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "@graphagent/core/database/database"
import { Cause, Clock, Deferred, Effect, Option, Scope } from "effect"
import { randomUUID } from "node:crypto"
import { InstanceRef } from "@/effect/instance-ref"
import { registerDisposer } from "@/effect/instance-registry"
import type { SessionAbortReason } from "../abort-reason"
import { EngineProcess, type ActiveChildRun } from "../engine-process"
import type { SessionID } from "../schema"
import { runnerAlive } from "../turns"
import { abortReasonOf, boundedCancel } from "./cancel"
import { ChildRegistry as Registry } from "./registry"
import { ChildStore as Store } from "./store"
import {
  ActiveRunExists,
  NotOwner,
  type ChildCancelBy,
  type ChildRunCancelResult,
  type ChildRunHandle,
  type ChildRunOutcome,
  type ChildRunSpec,
  type ChildRunsInterface,
  type ChildRunsScoped,
} from "./types"

export {
  ActiveRunExists,
  NotOwner,
  type ChildCancelBy,
  type ChildOwner,
  type ChildOwnerKind,
  type ChildRunCancelResult,
  type ChildRunError,
  type ChildRunHandle,
  type ChildRunOutcome,
  type ChildRunSpec,
  type ChildRunState,
  type ChildRunView,
} from "./types"

/**
 * Child runs (Issue #1026, PR1: the thin core).
 *
 * A child run is one episode of delegated work: the durable binding of a child
 * session to its owner, one `child_run` row per episode, an admission
 * credential placeholder and a cancellation signal. The turn loop stays with
 * the owner (the task tool today, DAG nodes from PR4); `ChildRuns` records who
 * owns a child session, whether it is running, and how it ended.
 *
 * Within one process the registry (`EngineProcess.children`) decides every race
 * synchronously (who ended a run first, whether a child session already has an
 * active run); the rows follow it. Across processes the partial unique index
 * `child_run_active` and the `runner_id` identity are the backstop.
 *
 * Assembled inside `SessionPrompt.layer` next to the turns and admission
 * factories, so it never depends on the tool registry and cannot form a cycle
 * with the task tool.
 */

export interface Deps {
  readonly db: Database.Interface["db"]
  /** Long-lived scope that owns the forked session cancellations (one fiber per cancelled run). */
  readonly scope: Scope.Scope
  /** `SessionPrompt.cancel`. Late-bound by the assembler: admission is built after the child runs. */
  readonly cancelSession: (
    sessionID: SessionID,
    options?: { readonly reason?: SessionAbortReason.Info },
  ) => Effect.Effect<void>
}

export type Interface = ChildRunsInterface
export type Scoped = ChildRunsScoped

/** One built instance of the factory. `owner` is its identity in the registry. */
interface Ctx extends Deps {
  readonly owner: object
}

const softly = (label: string, runID: string) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) =>
    Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.logWarning(label, { runID, cause: Cause.pretty(cause) }),
  )

/**
 * Ends a run: the in-memory compare-and-swap decides the winner, then the row
 * is written. `between` runs after the swap and before the write (the
 * cancellation fork); `persist: false` is for runs whose rows are already gone
 * with their session. A failed write is logged and never undoes the ending:
 * the registry is authoritative inside this process.
 */
const finish = (
  ctx: Ctx,
  entry: ActiveChildRun,
  outcome: ChildRunOutcome,
  options: { readonly between?: Effect.Effect<void>; readonly persist?: boolean } = {},
): Effect.Effect<boolean> =>
  Effect.uninterruptible(
    Effect.suspend(() => {
      if (!Registry.end(entry, outcome)) return Effect.succeed(false)
      const persist =
        options.persist === false
          ? Effect.void
          : Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) => Store.endRun(ctx.db, entry.id, outcome, now)),
              Effect.asVoid,
              Effect.catchCause((cause) =>
                Effect.logWarning("child run end was not persisted", { runID: entry.id, cause: Cause.pretty(cause) }),
              ),
            )
      return (options.between ?? Effect.void).pipe(
        Effect.andThen(persist),
        Effect.ensuring(Effect.sync(() => Registry.release(entry))),
        Effect.as(true),
      )
    }),
  )

// Lazy: the matching runs are read when the effect runs, not when it is described.
const endWhere = (ctx: Ctx, predicate: (entry: ActiveChildRun) => boolean, outcome: ChildRunOutcome, persist = true) =>
  Effect.suspend(() =>
    Effect.forEach(Registry.activeWhere(predicate), (entry) => finish(ctx, entry, outcome, { persist }), {
      discard: true,
    }),
  )

const markRunning = (ctx: Ctx, entry: ActiveChildRun): Effect.Effect<boolean> =>
  Effect.suspend(() => {
    if (!Registry.begin(entry)) return Effect.succeed(false)
    return Store.markRunning(ctx.db, entry.id).pipe(
      Effect.asVoid,
      softly("child run running state was not persisted", entry.id),
      Effect.as(true),
    )
  })

const handleOf = (ctx: Ctx, entry: ActiveChildRun, attempt: number): ChildRunHandle => ({
  id: entry.id,
  childSessionID: entry.childSessionID,
  attempt,
  markRunning: markRunning(ctx, entry),
  settle: (outcome) => finish(ctx, entry, outcome),
  settled: Deferred.await(entry.done),
  cancelled: Deferred.await(entry.cancelled),
})

/** A fresh queued entry, not yet registered. The directory is the starting instance's, when there is one. */
const newEntry = (ctx: Ctx, spec: ChildRunSpec) =>
  Effect.gen(function* () {
    const instance = yield* InstanceRef
    return Registry.create({
      id: `crun_${randomUUID()}`,
      childSessionID: spec.childSessionID,
      parentSessionID: spec.parentSessionID,
      directory: instance?.directory,
      owner: ctx.owner,
    })
  })

const newRun = (ctx: Ctx, entry: ActiveChildRun, spec: ChildRunSpec, attempt: number, now: number): Store.NewRun => ({
  id: entry.id,
  childSessionID: spec.childSessionID,
  parentSessionID: spec.parentSessionID,
  owner: spec.owner,
  attempt,
  detached: spec.detached,
  runnerID: EngineProcess.runner.id,
  now,
})

// A registration whose row was never written leaves no trace.
const dropRegistration = (entry: ActiveChildRun) =>
  Effect.sync(() => {
    Registry.end(entry, { type: "error", message: "child run registration failed" })
    Registry.release(entry)
  })

const start = (ctx: Ctx) =>
  Effect.fn("ChildRuns.start")(function* (spec: ChildRunSpec) {
    const entry = yield* newEntry(ctx, spec)
    if (!Registry.register(entry))
      return yield* Effect.die(new Error(`child session ${spec.childSessionID} already has an active run`))
    const now = yield* Clock.currentTimeMillis
    yield* Store.insertFirst(ctx.db, newRun(ctx, entry, spec, 1, now)).pipe(
      Effect.onError(() => dropRegistration(entry)),
    )
    return handleOf(ctx, entry, 1)
  })

/**
 * An active row with no registry entry belongs to a run nobody drives: a dead
 * or earlier-life process left it, or this process lost its ending write. A
 * live foreign process keeps its row. Returns whether the row was released.
 *
 * A row of this process is re-checked against the registry first: a concurrent
 * adopt registers its entry before inserting its row, so a row read after that
 * insert always finds its entry here and is not an orphan.
 */
const releaseOrphan = (ctx: Ctx, row: Store.RunRow) =>
  Effect.suspend(() => {
    if (Registry.get(row.id)) return Effect.succeed(false)
    if (row.runner_id !== EngineProcess.runner.id && runnerAlive(row.runner_id)) return Effect.succeed(false)
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => Store.endRun(ctx.db, row.id, { type: "interrupted", reason: "orphaned" }, now)),
      Effect.as(true),
    )
  })

const adopt = (ctx: Ctx) =>
  Effect.fn("ChildRuns.adopt")(function* (spec: ChildRunSpec) {
    const binding = yield* Store.bindingOf(ctx.db, spec.childSessionID)
    // One verdict for every refusal: the caller learns nothing about sessions it does not own.
    if (!binding || binding.parent_session_id !== spec.parentSessionID || binding.owner_kind !== spec.owner.kind)
      return yield* new NotOwner({ childSessionID: spec.childSessionID })
    // A run that already ended but whose row is still being written frees the
    // child session in a moment: wait for it instead of refusing.
    let driven = Registry.activeFor(spec.childSessionID)
    while (driven?.phase === "ended") {
      yield* Deferred.await(driven.released)
      driven = Registry.activeFor(spec.childSessionID)
    }
    if (driven) return yield* new ActiveRunExists({ childSessionID: spec.childSessionID, runID: driven.id })
    const latest = yield* Store.latestOf(ctx.db, spec.childSessionID)
    if (latest && Store.ACTIVE_STATES.some((state) => state === latest.state)) {
      if (!(yield* releaseOrphan(ctx, latest)))
        return yield* new ActiveRunExists({ childSessionID: spec.childSessionID, runID: latest.id })
    }
    const attempt = (latest?.attempt ?? 0) + 1
    const entry = yield* newEntry(ctx, spec)
    if (!Registry.register(entry))
      return yield* new ActiveRunExists({
        childSessionID: spec.childSessionID,
        runID: Registry.activeFor(spec.childSessionID)?.id ?? "unknown",
      })
    const now = yield* Clock.currentTimeMillis
    const inserted = yield* Store.insertNext(ctx.db, newRun(ctx, entry, spec, attempt, now)).pipe(
      Effect.onError(() => dropRegistration(entry)),
    )
    if (!inserted) {
      yield* dropRegistration(entry)
      return yield* new ActiveRunExists({ childSessionID: spec.childSessionID, runID: latest?.id ?? "unknown" })
    }
    return handleOf(ctx, entry, attempt)
  })

/** Signal-and-return: swap the state, revoke, start the bounded session cancellation, write the row. */
const cancel = (ctx: Ctx) =>
  Effect.fn("ChildRuns.cancel")(function* (runID: string, by: ChildCancelBy): Effect.fn.Return<ChildRunCancelResult> {
    const entry = Registry.get(runID)
    if (!entry) return "not_active"
    const cancelSession = boundedCancel(
      ctx.cancelSession(entry.childSessionID, { reason: abortReasonOf(by) }),
      `child-run:${entry.id}`,
    ).pipe(Effect.forkIn(ctx.scope, { startImmediately: true }), Effect.asVoid)
    const won = yield* finish(ctx, entry, { type: "cancelled", by }, { between: cancelSession })
    return won ? "cancelled" : "not_active"
  })

/**
 * Ends the runs a dead or earlier-life process left active. Rows of this
 * process and of live foreign processes are untouched: another instance of this
 * process may be driving them right now.
 */
export const recover = (database: Database.Interface): Effect.Effect<void> =>
  Effect.gen(function* () {
    const rows = yield* Store.activeRows(database.db)
    const now = yield* Clock.currentTimeMillis
    yield* Effect.forEach(
      rows,
      (row) =>
        runnerAlive(row.runner_id)
          ? Effect.void
          : Store.endRun(database.db, row.id, { type: "interrupted", reason: "process-restart" }, now).pipe(
              Effect.asVoid,
              softly("child run recovery write failed", row.id),
            ),
      { concurrency: 1, discard: true },
    )
  })

const inspect = (ctx: Ctx) => (runID: string) => Store.runOf(ctx.db, runID).pipe(Effect.map(Option.map(Store.viewOf)))

const latestView = (ctx: Ctx) => (childSessionID: SessionID) =>
  Store.latestOf(ctx.db, childSessionID).pipe(Effect.map((row) => Option.map(Option.fromNullishOr(row), Store.viewOf)))

const listByParent = (ctx: Ctx) => (parentSessionID: SessionID) =>
  Store.runsOfParent(ctx.db, parentSessionID).pipe(Effect.map((rows) => rows.map(Store.viewOf)))

/** The registry knows a parent's runs by session id; a run of another parent is never reachable through the scoped view. */
const scoped = (api: Omit<ChildRunsInterface, "forParent">, parentSessionID: SessionID): ChildRunsScoped => ({
  parentSessionID,
  start: (spec) => api.start({ ...spec, parentSessionID }),
  adopt: (spec) => api.adopt({ ...spec, parentSessionID }),
  latest: (childSessionID) =>
    api.latest(childSessionID).pipe(Effect.map(Option.filter((view) => view.parentSessionID === parentSessionID))),
  list: () => api.listByParent(parentSessionID),
  cancel: (runID, by) => {
    const entry = Registry.get(runID)
    return entry && entry.parentSessionID === parentSessionID
      ? api.cancel(runID, by)
      : Effect.succeed<ChildRunCancelResult>("not_active")
  },
})

const assemble = (ctx: Ctx): ChildRunsInterface => {
  const api: Omit<ChildRunsInterface, "forParent"> = {
    start: start(ctx),
    adopt: adopt(ctx),
    inspect: inspect(ctx),
    latest: latestView(ctx),
    listByParent: listByParent(ctx),
    cancel: cancel(ctx),
    recover: () => recover({ db: ctx.db }),
    // Rows of a deleted session are gone with it (cascade); only the registry entries remain.
    forget: (sessionID) =>
      endWhere(
        ctx,
        (entry) => entry.childSessionID === sessionID || entry.parentSessionID === sessionID,
        { type: "cancelled", by: { kind: "engine", reason: "session-deleted" } },
        false,
      ),
  }
  return { ...api, forParent: (parentSessionID) => scoped(api, parentSessionID) }
}

/**
 * Builds the child runs. The instances this builds end the runs they started
 * when their directory is disposed and when `deps.scope` closes, so neither
 * leaves an active row behind for a driver that no longer exists.
 */
export const makeChildRuns = (deps: Deps): Effect.Effect<Interface> =>
  Effect.gen(function* () {
    const ctx: Ctx = { ...deps, owner: {} }
    const interrupted = (reason: string): ChildRunOutcome => ({ type: "interrupted", reason })
    const off = registerDisposer((directory) =>
      Effect.runPromise(
        endWhere(
          ctx,
          (entry) => entry.owner === ctx.owner && entry.directory === directory,
          interrupted("instance-disposed"),
        ),
      ),
    )
    yield* Scope.addFinalizer(
      deps.scope,
      Effect.sync(off).pipe(
        Effect.andThen(endWhere(ctx, (entry) => entry.owner === ctx.owner, interrupted("runtime-closed"))),
      ),
    )
    return assemble(ctx)
  })

export * as ChildRuns from "./run"
