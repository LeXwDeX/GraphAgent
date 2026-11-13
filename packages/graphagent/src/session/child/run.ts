// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "@graphagent/core/database/database"
import { Cause, Clock, Deferred, Effect, Option, Scope } from "effect"
import { randomUUID } from "node:crypto"
import { DagLocation } from "@/dag/location"
import { InstanceRef } from "@/effect/instance-ref"
import { registerDisposer } from "@/effect/instance-registry"
import type { SessionAbortReason } from "../abort-reason"
import { SessionCancellation } from "../cancellation"
import { EngineProcess, type ActiveChildRun } from "../engine-process"
import type { SessionID } from "../schema"
import { runnerAlive } from "../turns"
import { abortReasonOf, boundedCancel, CANCEL_BOUND_MS } from "./cancel"
import { ChildNotify as Notify } from "./notify"
import { ChildRegistry as Registry } from "./registry"
import { ChildStore as Store } from "./store"
import {
  ActiveRunExists,
  NotOwner,
  type ChildCancelBy,
  type ChildRunCancelResult,
  type ChildRunHandle,
  type ChildRunOutcome,
  type ChildRunReport,
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
  type ChildRunReport,
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
 * A cancelled run keeps its child session reserved until its driver stops (see
 * `Registry.end`). When no driver ever reports, because it is gone or lingers
 * past the bound the session cancellation itself gets, the entry leaves after
 * that bound with a warning: a child session is never reserved for good.
 */
const releaseAfterBound = (ctx: Ctx, entry: ActiveChildRun) =>
  Effect.race(
    Deferred.await(entry.released),
    Effect.sleep(CANCEL_BOUND_MS).pipe(
      // Warn first: the release wakes the other side of the race, which ends this one.
      Effect.andThen(
        Effect.suspend(() =>
          entry.held
            ? Effect.logWarning("cancelled child run was released without its driver reporting that it stopped", {
                runID: entry.id,
                childSessionID: entry.childSessionID,
              }).pipe(Effect.andThen(Effect.sync(() => Registry.driverStopped(entry))))
            : Effect.void,
        ),
      ),
    ),
  ).pipe(Effect.interruptible, Effect.forkIn(ctx.scope, { startImmediately: true }), Effect.asVoid)

/**
 * Records that this process saw a run end on its own (finished or failed), at
 * the moment of the swap and before the ending row can be seen by anyone, so a
 * tick that finds the row also finds the report. The report carries the
 * parent's cancellation epoch: the delivery tells a fresh result from one an
 * ESC overtook by comparing it. Whether the result is really owed is the row's
 * to say (`settleReport`). Interrupted and cancelled endings have no news: a
 * run its process lost is delivered from its row by whichever process loads
 * next, a cancelled run is delivered to nobody.
 */
const reportEnding = (ctx: Ctx, entry: ActiveChildRun, outcome: ChildRunOutcome, epoch: number): void => {
  if (outcome.type !== "completed" && outcome.type !== "error") return
  const directory = entry.directory === undefined ? undefined : DagLocation.canonicalDirectory(entry.directory)
  Registry.record({ runID: entry.id, parentSessionID: entry.parentSessionID, directory, epoch, owner: ctx.owner })
}

/**
 * After the ending write: a result that is owed to the ledger (a detached run
 * whose ending left `reported_at` empty) wakes the inbox of the instance that
 * owns the parent, so it does not wait for the tick. Any other ending has
 * nothing to deliver and its report is dropped.
 */
const settleReport = (ctx: Ctx, entry: ActiveChildRun, ended: Store.EndedRun | undefined): Effect.Effect<void> =>
  Effect.suspend(() => {
    const report = Registry.reportOf(entry.id)
    if (!report) return Effect.void
    // Only a task's result is this ledger's (`Store.unreportedOf`); a DAG node's is delivered by the DAG.
    if (!ended || !ended.detached || ended.reported || ended.ownerKind !== "task") {
      Registry.dropReport(entry.id)
      return Effect.void
    }
    if (report.directory === undefined) return Effect.void
    // Forked from an uninterruptible region: the nudge itself must stay interruptible with its scope.
    return Notify.nudge(report.directory, entry.parentSessionID).pipe(
      Effect.interruptible,
      Effect.forkIn(ctx.scope),
      Effect.asVoid,
    )
  })

/**
 * Ends a run: the in-memory compare-and-swap decides the winner, then the row
 * is written. `between` runs after the swap and before the write (the
 * cancellation fork); `persist: false` is for runs whose rows are already gone
 * with their session; `hold` keeps the entry, and the child session reserved,
 * until the run's driver has stopped as well as the row is written (a
 * cancellation, whose job may still be running). `report` is what a detached
 * run leaves for its parent. A failed write is logged and never undoes the
 * ending: the registry is authoritative inside this process.
 */
const finish = (
  ctx: Ctx,
  entry: ActiveChildRun,
  outcome: ChildRunOutcome,
  options: {
    readonly between?: Effect.Effect<void>
    readonly persist?: boolean
    readonly hold?: boolean
    readonly report?: ChildRunReport
  } = {},
): Effect.Effect<boolean> =>
  Effect.uninterruptible(
    Effect.suspend(() => {
      if (!Registry.end(entry, outcome, { hold: options.hold })) return Effect.succeed(false)
      // Taken at the swap, before anything else can run: an ESC that lands after it makes the delivery write only.
      if (options.persist !== false) reportEnding(ctx, entry, outcome, SessionCancellation.epoch(entry.parentSessionID))
      const persist =
        options.persist === false
          ? Effect.void
          : Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) => Store.endRun(ctx.db, entry.id, outcome, now, options.report)),
              Effect.flatMap((ended) => settleReport(ctx, entry, ended)),
              Effect.catchCause((cause) =>
                Effect.sync(() => Registry.dropReport(entry.id)).pipe(
                  Effect.andThen(
                    Effect.logWarning("child run end was not persisted", {
                      runID: entry.id,
                      cause: Cause.pretty(cause),
                    }),
                  ),
                ),
              ),
            )
      return (options.between ?? Effect.void).pipe(
        Effect.andThen(options.hold ? releaseAfterBound(ctx, entry) : Effect.void),
        Effect.andThen(persist),
        Effect.ensuring(Effect.sync(() => Registry.persisted(entry))),
        Effect.as(true),
      )
    }),
  )

// Lazy: the matching runs are read when the effect runs, not when it is described.
// Whoever tears runs down tears their drivers down with them, so a cancelled run
// still held for its driver leaves too.
const endWhere = (ctx: Ctx, predicate: (entry: ActiveChildRun) => boolean, outcome: ChildRunOutcome, persist = true) =>
  Effect.suspend(() =>
    Effect.forEach(
      Registry.activeWhere(predicate),
      (entry) =>
        finish(ctx, entry, outcome, { persist }).pipe(
          Effect.ensuring(Effect.sync(() => Registry.driverStopped(entry))),
        ),
      { discard: true },
    ),
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
  // Every settlement comes from the driver at the moment it stops (the watcher
  // once the job is terminal, the tool call at its exit), so it also tells the
  // registry that the driver is gone, even when it loses the race to a cancellation.
  settle: (outcome, report) =>
    Effect.uninterruptible(
      Effect.suspend(() => {
        Registry.driverStopped(entry)
        return finish(ctx, entry, outcome, { report })
      }),
    ),
  detach: detach(ctx)(entry.id),
  settled: Deferred.await(entry.done),
  cancelled: Deferred.await(entry.cancelled),
})

// A failed write is logged, not raised: a promotion must not fail because the row could not follow it.
const detach = (ctx: Ctx) => (runID: string) =>
  Effect.suspend(() => Store.detachRun(ctx.db, runID)).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.logWarning("child run detach was not persisted", { runID, cause: Cause.pretty(cause) }).pipe(
            Effect.as(false),
          ),
    ),
  )

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
    // A run that already ended but whose row is still being written, or whose
    // cancelled driver is still stopping, frees the child session in a moment:
    // wait for it instead of refusing. The wait is bounded: a held entry leaves
    // when its driver reports, after `CANCEL_BOUND_MS` at the latest, or when
    // its owner is torn down. Callers register inside an uninterruptible step;
    // nothing is registered yet here, so the wait itself stays interruptible.
    let driven = Registry.activeFor(spec.childSessionID)
    while (driven?.phase === "ended") {
      yield* Effect.interruptible(Deferred.await(driven.released))
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

/**
 * Signal-and-return: swap the state, revoke, start the bounded session
 * cancellation, write the row. The child session stays reserved after that
 * until the run's driver reports it stopped: the job (or the tool call) that
 * carries the run keeps running a moment longer, and a new run registered on
 * the session in that window would be handed the old job instead of its own.
 */
const cancel = (ctx: Ctx) =>
  Effect.fn("ChildRuns.cancel")(function* (runID: string, by: ChildCancelBy): Effect.fn.Return<ChildRunCancelResult> {
    const entry = Registry.get(runID)
    if (!entry) return "not_active"
    const cancelSession = boundedCancel(
      ctx.cancelSession(entry.childSessionID, { reason: abortReasonOf(by) }),
      `child-run:${entry.id}`,
    ).pipe(Effect.forkIn(ctx.scope, { startImmediately: true }), Effect.asVoid)
    const won = yield* finish(ctx, entry, { type: "cancelled", by }, { between: cancelSession, hold: true })
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

const listByParent = (ctx: Ctx) => (parentSessionID: SessionID, options?: { readonly limit?: number }) =>
  Store.runsOfParent(ctx.db, parentSessionID, options?.limit).pipe(
    Effect.map((rows) => rows.map((listed) => Store.viewOf(listed.run, listed))),
  )

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
    detach: detach(ctx),
    recover: () => recover({ db: ctx.db }),
    // Rows of a deleted session are gone with it (cascade); only the registry entries remain.
    forget: (sessionID) =>
      Effect.sync(() => {
        Registry.forgetParent(sessionID)
        Registry.dropReportsWhere((report) => report.parentSessionID === sessionID)
      }).pipe(
        Effect.andThen(
          endWhere(
            ctx,
            (entry) => entry.childSessionID === sessionID || entry.parentSessionID === sessionID,
            { type: "cancelled", by: { kind: "engine", reason: "session-deleted" } },
            false,
          ),
        ),
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
        // The reports this instance left go with it; their rows stay owed to the next process.
        Effect.andThen(Effect.sync(() => Registry.dropReportsWhere((report) => report.owner === ctx.owner))),
      ),
    )
    return assemble(ctx)
  })

export * as ChildRuns from "./run"
