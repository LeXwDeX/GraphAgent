// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagBudget from "./budget"

/**
 * #1031 M5: the DAG token budget for one main session.
 *
 * Accounting (Issue §4.3): every attempt child session recorded in the durable
 * `dag_node_attempt` ledger — across every workflow the main session owns —
 * contributes `tokens_input + tokens_cache_write + tokens_output +
 * tokens_reasoning`. `tokens_input` already excludes cache reads/writes, cache
 * reads are tracked separately and do not consume the budget, and the main
 * session's own usage plus task subagents never enter the sum. The read is
 * `DagStore.getWorkflowSummaries`, which aggregates the ledger in one query per
 * session.
 *
 * The service is the single gate: spawn admission (authoritative, before a
 * child session exists), `Dag.resume`/`Dag.step` through the ResumeGuard
 * policy exported here, and `DagControl`'s work-admitting ops. Exhaustion
 * pauses every active workflow with reason `budget_exhausted` and cancels its
 * in-flight nodes; a user raise requeues those nodes and resumes the workflows.
 *
 * Only the user changes the budget (`/dag-mode budget` or `/config`). This
 * module never writes a budget, only reacts to one.
 */
import { Cause, Clock, Context, Effect, Exit, Layer, Option, Queue, Schema, Scope, Stream } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { DagStore } from "@graphagent/core/dag/store"
import { SessionV1 } from "@graphagent/core/v1/session"
import {
  ERROR_CLASS_BUDGET_EXHAUSTED,
  PAUSE_REASON_BUDGET_EXHAUSTED,
  isTerminalWorkflowStatusValue,
} from "@graphagent/core/dag/core/types"
import { isRecord } from "@/util/record"
import { TuiEvent } from "@graphagent/schema/tui-event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { ConfigHotReload } from "@/config/hot-reload"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { registerDisposer } from "@/effect/instance-registry"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionInbox } from "@/session/inbox"
import { Dag } from "./dag"
import { DagLocation } from "./location"
import { DagMode, type BudgetState, type BudgetTier } from "./mode"
import { DEFAULT_BUDGET_WARN_RATIO } from "./mode-status"
import { ResumeBlockedError, ResumeGuard } from "./resume-guard"

/** Tier thresholds: `>= budget` is exhausted, `>= budget × warn_ratio` warns. */
export function tierOf(used: number, budget: number | null, warnRatio: number): BudgetTier {
  if (budget === null || budget <= 0) return "normal"
  if (used >= budget) return "exhausted"
  return used >= Math.floor(budget * warnRatio) ? "warn" : "normal"
}

/** The typed gate failure shared by spawn admission, control, and resume. */
export class BudgetExhaustedError extends Schema.TaggedError<BudgetExhaustedError>()("BudgetExhausted", {
  sessionID: Schema.String,
  used: Schema.Number,
  budget: Schema.Number,
}) {
  override get message() {
    return `DAG token budget exhausted for this session: ${this.used} of ${this.budget} tokens used. Only the user can raise it (/dag-mode budget <tokens> or /config); the engine resumes paused workflows when it is raised.`
  }
}

export interface Interface {
  /** Current usage/tier without a verdict. */
  readonly state: (mainSessionID: SessionID) => Effect.Effect<BudgetState>
  /** The single budget gate: fails when usage has reached the budget. */
  readonly check: (mainSessionID: SessionID) => Effect.Effect<BudgetState, BudgetExhaustedError>
  /** Pause every active workflow and cancel its in-flight attempts. */
  readonly exhaust: (mainSessionID: SessionID) => Effect.Effect<number>
  /** Recompute after a user budget change; resume requeued workflows below budget. */
  readonly onBudgetChanged: (mainSessionID: SessionID) => Effect.Effect<number>
  /** Subscribe and reconcile sessions left mid-episode by an earlier process. */
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/DagBudget") {}

const ownsWorkflow = (
  workflow: { readonly projectId: string; readonly directory: string | null },
  instance: { readonly project: { readonly id: string }; readonly directory: string } | undefined,
): boolean => {
  if (!instance) return true
  if (workflow.projectId !== instance.project.id) return false
  if (!workflow.directory) return false
  return DagLocation.canonicalDirectory(workflow.directory) === DagLocation.canonicalDirectory(instance.directory)
}

const make = Effect.gen(function* () {
  const events = yield* EventV2Bridge.Service
  const store = yield* DagStore.Service
  const sessions = yield* Session.Service
  const config = yield* Config.Service
  const dag = yield* Dag.Service
  const inbox = Option.getOrUndefined(yield* Effect.serviceOption(SessionInbox.Service))
  const scope = yield* Scope.Scope

  // Tier history is request-coalescing state: dropping it only re-announces a
  // tier once after a restart, never changes an accounting result.
  const tiers = new Map<string, BudgetTier>()
  // Sessions whose exhaustion enforcement failed and must be retried. This is
  // deliberately separate from `tiers`: the tier is the announcement state, so
  // a transient pause failure cannot be masked by an already-recorded
  // "exhausted".
  const enforcing = new Set<string>()
  // Sessions whose raise could not requeue every budget-cancelled node. The
  // affected workflows stay budget-paused; the next reconciliation — a usage
  // trigger, a session update or another raise — retries the replay instead of
  // waiting for a new user action.
  const resumePending = new Set<string>()
  // Effective budget last observed on a Session.Updated event (null = unlimited).
  const seenBudget = new Map<string, number | null>()
  // Child-session routing for step-finish usage; mirrors the summary publisher.
  const children = new Map<string, { sessionID: string; projectID: string; directory: string }>()
  const notChildren = new Set<string>()
  // One scheduled reconcile per session. `budgetChanged` records "the resume
  // path must run"; `reconciling` says the pass is past its coalescing sleep,
  // so a trigger arriving now may race its usage read and needs one trailing
  // rerun; `rerun` is that pass.
  const pending = new Map<string, { budgetChanged: boolean; reconciling: boolean; rerun: boolean }>()
  // Instance context per directory, captured by bootstrap `init`. The event
  // listeners and the `/config` queue run in background fibers that carry no
  // instance context, while `SessionInbox.submit` resolves its instance state
  // and the prompt service from one. A reload re-runs init and replaces it.
  const instanceContexts = new Map<string, Context.Context<never>>()
  // Set once any bootstrap captured a context. From then on this process-wide
  // service is instance-managed: a directory without an entry is not loaded
  // (disposed, or between reload generations), so its workflows must neither
  // be resumed nor woken from a background context. Unit graphs that never run
  // a bootstrap keep the unmanaged fallback.
  let instanceManaged = false
  // Captured contexts die with their instance. The instance store runs this
  // registry's disposers (the same hook InstanceState uses to invalidate its
  // caches) before a reload creates the next generation, so a disposed
  // directory can never be re-entered with a stale context.
  const unregisterDisposer = registerDisposer(async (directory) => {
    instanceContexts.delete(DagLocation.canonicalDirectory(directory))
  })
  yield* Effect.addFinalizer(() => Effect.sync(unregisterDisposer))

  /** Whether the directory still holds a live captured instance context. */
  const directoryLoaded = (directory: string): boolean =>
    instanceContexts.has(DagLocation.canonicalDirectory(directory))

  const compute = Effect.fn("DagBudget.state")(function* (sessionID: string) {
    const [info, dagConfig, summaries] = yield* Effect.all([
      sessions.get(SessionID.make(sessionID)).pipe(Effect.catch(() => Effect.succeed(undefined))),
      config.dagGlobal(),
      store.getWorkflowSummaries(sessionID),
    ])
    let used = 0
    let cacheRead = 0
    for (const summary of summaries) {
      used += summary.tokens ?? 0
      cacheRead += summary.tokensCacheRead ?? 0
    }
    // #1031 M1: `budget off` is an explicit unlimited choice, not "inherit the
    // global default"; the flag keeps the two apart.
    const budget =
      info === undefined || info.dagBudgetUnlimited
        ? null
        : (info.dagBudgetTokens ?? dagConfig.budget?.tokens ?? null)
    const warnRatio = dagConfig.budget?.warn_ratio ?? DEFAULT_BUDGET_WARN_RATIO
    return {
      used,
      cacheRead,
      budget,
      warnRatio,
      tier: tierOf(used, budget, warnRatio),
    } satisfies BudgetState
  })

  const check = Effect.fn("DagBudget.check")(function* (mainSessionID: SessionID) {
    const next = yield* compute(mainSessionID)
    if (next.budget !== null && next.used >= next.budget) {
      return yield* new BudgetExhaustedError({
        sessionID: mainSessionID,
        used: next.used,
        budget: next.budget,
      })
    }
    return next
  })

  const toast = (variant: "warning" | "error", message: string) =>
    events
      .publish(TuiEvent.ToastShow, { title: "DAG token budget", message, variant, duration: 8000 })
      .pipe(Effect.catchCause(() => Effect.void))

  /**
   * Pause every live workflow of the session and cancel its in-flight
   * attempts. Failure is tracked apart from the announced tier: enforcement
   * must retry on a later reconciliation even though `tiers` already records
   * "exhausted".
   */
  const enforce = Effect.fn("DagBudget.enforce")(function* (mainSessionID: SessionID) {
    const instance = yield* InstanceRef
    const workflows = yield* store.listBySession(mainSessionID)
    let paused = 0
    let failed = false
    for (const workflow of workflows) {
      if (isTerminalWorkflowStatusValue(workflow.status)) continue
      const budgetPaused =
        workflow.status === "paused" && workflow.pauseReason === PAUSE_REASON_BUDGET_EXHAUSTED
      if (workflow.status !== "running" && workflow.status !== "stepping" && !budgetPaused) continue
      if (!ownsWorkflow(workflow, instance)) continue
      const outcome = yield* dag.pauseForBudget(workflow.id).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("DagBudget could not pause a workflow", {
                dagID: workflow.id,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as("failed" as const)),
        ),
      )
      if (outcome === "paused") paused++
      if (outcome === "failed") failed = true
    }
    if (failed) enforcing.add(mainSessionID)
    else enforcing.delete(mainSessionID)
    return { paused, failed }
  })

  const exhaust = Effect.fn("DagBudget.exhaust")(function* (mainSessionID: SessionID) {
    return (yield* enforce(mainSessionID)).paused
  })

  const wake = (sessionID: string, resumed: number, directory: string | undefined) =>
    Effect.gen(function* () {
      if (!inbox) return
      const at = yield* Clock.currentTimeMillis
      const text = `budget raised by the user; ${resumed} workflows resumed`
      const submit = inbox
        .submit("dag.budget", SessionID.make(sessionID), {
          prompt: { parts: [{ type: "text", text }] },
          admissionOptions: { continueToolBudget: true },
          // The notice is engine-owned, not user input; the inbox origin keeps
          // it out of user-prompt hooks and the turn's provenance honest.
          origin: { kind: "inbox", source: "dag.budget", key: `${sessionID}:${at}` },
        })
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.logWarning("DagBudget wake submit failed", {
                  sessionID,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.asVoid),
          ),
        )
      // The automatic raise paths (Session.Updated listener, `/config` queue)
      // run in background fibers without the owner instance's context, but
      // submit resolves its instance state and prompt service from one. Re-enter
      // the context bootstrap captured for the workflow's directory.
      const captured =
        directory === undefined ? undefined : instanceContexts.get(DagLocation.canonicalDirectory(directory))
      if (captured === undefined) {
        // Instance-managed graphs must not submit into a directory whose owner
        // was disposed between the resume and this delivery: the captured
        // generation is closed and the resumption is already durable. The
        // owner's next bootstrap reconciles the now-running workflow.
        if (instanceManaged) {
          yield* Effect.logDebug("DagBudget wake skipped for an unloaded directory", { sessionID, directory })
          return
        }
        yield* submit
        return
      }
      yield* Effect.provideContext(submit, captured)
    })

  /**
   * Requeue the rows a budget cancel left failed, returning whether every
   * requested node is pending again. `Dag.requeueNodes` commits the whole batch
   * in one transaction under the workflow lock, so a failure requeued nothing;
   * a partial result means another actor changed a target row between the read
   * and the locked replay. Either way the workflow must stay budget-paused:
   * resuming with budget-cancelled rows still failed would let the resumed
   * scheduling settle it as a required-node failure instead of rerunning the
   * cancelled attempts.
   */
  const requeueCancelled = Effect.fn("DagBudget.requeueCancelled")(function* (
    dagID: string,
    nodeIDs: readonly string[],
  ) {
    const outcome = yield* dag.requeueNodes(dagID, nodeIDs, "budget raised by the user").pipe(Effect.exit)
    if (Exit.isFailure(outcome)) {
      if (Cause.hasInterrupts(outcome.cause)) return yield* Effect.interrupt
      yield* Effect.logWarning("DagBudget could not requeue budget-cancelled nodes", {
        dagID,
        cause: Cause.pretty(outcome.cause),
      })
      return false
    }
    const requeued = new Set(outcome.value.requeued)
    if (nodeIDs.every((id) => requeued.has(id))) return true
    yield* Effect.logWarning("DagBudget requeued only part of the budget-cancelled nodes; keeping the workflow paused", {
      dagID,
      requested: nodeIDs,
      requeued: outcome.value.requeued,
    })
    return false
  })

  /**
   * Resume every budget-paused workflow of the session when usage is below the
   * new budget. Budget-cancelled nodes go back to pending first (a fresh
   * attempt, no replan count); the resume re-enters scheduling through the
   * normal WorkflowResumed path. Returns how many workflows resumed.
   *
   * The pause reason is the selector, so a pause held for another reason is
   * not this gate's to lift: in particular a workflow the owner's archive holds
   * (reason `archived`, #1289, relabeled over a budget pause too) stays paused
   * until the main agent resumes it. The relabel already requeued the nodes
   * this gate cancelled, so nothing is left for the gate to replay. The filter
   * below is only a first read: the resume itself re-checks the reason in its
   * transaction (`Dag.resumeIfPausedFor`), so an archive that lands between the
   * two is not undone. `enforce`, `init` and the `/config` scan below read the
   * reason the same way.
   */
  const resumePaused = Effect.fn("DagBudget.resumePaused")(function* (sessionID: string, next: BudgetState) {
    if (next.budget !== null && next.used >= next.budget) return 0
    const instance = yield* InstanceRef
    const workflows = (yield* store.listBySession(sessionID)).filter(
      (workflow) =>
        workflow.status === "paused" &&
        workflow.pauseReason === PAUSE_REASON_BUDGET_EXHAUSTED &&
        ownsWorkflow(workflow, instance),
    )
    let resumed = 0
    let blocked = false
    let resumedDirectory: string | undefined
    for (const workflow of workflows) {
      // This process-wide service also sees workflows of directories whose
      // instance is gone (disposed, or between reload generations). Resuming
      // one here would run it from a background context with no live owner,
      // and the owner's reopen reconcile would no longer see it paused. Leave
      // it budget-paused: that reconcile retries the raise.
      if (instanceManaged && !directoryLoaded(workflow.directory)) continue
      const nodes = yield* store.getCurrentNodes(workflow.id)
      const requeue = nodes
        .filter((node) => node.status === "failed" && node.errorClass === ERROR_CLASS_BUDGET_EXHAUSTED)
        .map((node) => node.id)
      // No budget-cancelled rows means there is nothing to replay (a queued or
      // pending workflow); only a failed requeue blocks the resume.
      if (requeue.length > 0 && !(yield* requeueCancelled(workflow.id, requeue))) {
        blocked = true
        continue
      }
      // Usage can cross the new budget between the raise and this resume; a
      // resumed workflow must not slip one step past it.
      const gate = yield* compute(sessionID)
      if (gate.budget !== null && gate.used >= gate.budget) break
      // The pause is re-checked where the resume is published, under the workflow
      // lock and inside its transaction: the filter above ran earlier, and the
      // owner's archive may have relabeled this pause since (#1289). A pause that
      // is no longer the budget's leaves nothing to resume and nothing to retry.
      const outcome = yield* dag.resumeIfPausedFor(workflow.id, PAUSE_REASON_BUDGET_EXHAUSTED).pipe(Effect.exit)
      if (Exit.isFailure(outcome)) {
        if (Cause.hasInterrupts(outcome.cause)) return yield* Effect.interrupt
        yield* Effect.logWarning("DagBudget could not resume a budget-paused workflow", {
          dagID: workflow.id,
          cause: Cause.pretty(outcome.cause),
        })
        // The nodes are already requeued, so the retry resumes without
        // replaying them; but only keeping the session armed makes that retry
        // happen at all. A transient lock failure must not park the raise
        // until the user changes the budget again.
        blocked = true
        continue
      }
      if (outcome.value === "skipped") continue
      resumed++
      resumedDirectory ??= workflow.directory
    }
    if (blocked) resumePending.add(sessionID)
    else resumePending.delete(sessionID)
    if (resumed > 0) yield* wake(sessionID, resumed, resumedDirectory)
    return resumed
  })

  const announce = Effect.fn("DagBudget.announce")(function* (sessionID: string, next: BudgetState) {
    const previous = tiers.get(sessionID)
    tiers.set(sessionID, next.tier)
    DagMode.setBudget(SessionID.make(sessionID), next)
    if (next.tier === "warn") {
      // Toast only on an observed normal→warn transition; a process that
      // starts already in the warning band has no transition to announce.
      if (previous === "normal") {
        const pct = next.budget === null ? 0 : Math.floor((next.used / next.budget) * 100)
        yield* toast("warning", `DAG token budget: over ${pct}% used`)
      }
      return
    }
    if (next.tier !== "exhausted") {
      enforcing.delete(sessionID)
      return
    }
    if (previous !== "exhausted") yield* toast("error", "DAG token budget exhausted: workflows paused")
    // The tier marker above is not the enforcement receipt: a transient
    // pauseForBudget failure must be retried on the next reconciliation instead
    // of being masked by the already-recorded "exhausted".
    if (previous === "exhausted" && !enforcing.has(sessionID)) return
    yield* enforce(SessionID.make(sessionID))
  })

  const reconcile = Effect.fn("DagBudget.reconcile")(function* (
    sessionID: string,
    options: { readonly budgetChanged: boolean },
  ) {
    const next = yield* compute(sessionID)
    yield* announce(sessionID, next)
    // A blocked raise keeps retrying on any later reconciliation, not only on
    // another user-visible budget change.
    if ((options.budgetChanged || resumePending.has(sessionID)) && next.tier !== "exhausted") {
      return yield* resumePaused(sessionID, next)
    }
    return 0
  })

  /**
   * Coalesce triggers per session (100 ms window so the durable usage
   * projection lands first, trailing rerun for events that raced the read).
   * `budgetChanged` is sticky: one budget-change event inside the window is
   * enough to run the resume path. A trigger that lands while a pass is
   * reconciling must schedule one trailing pass: dropping it would lose the
   * step that crossed the budget, leaving the children running.
   */
  const schedule = (sessionID: string, budgetChanged: boolean): Effect.Effect<void> =>
    Effect.gen(function* () {
      const running = pending.get(sessionID)
      if (running !== undefined) {
        if (budgetChanged) running.budgetChanged = true
        // A trigger during the coalescing sleep is covered by the read that
        // follows it; a trigger past the sleep may race that read, so it gets
        // its own trailing pass.
        if (running.reconciling) running.rerun = true
        return
      }
      const state = { budgetChanged, reconciling: false, rerun: false }
      pending.set(sessionID, state)
      yield* Effect.gen(function* () {
        for (;;) {
          const changed = state.budgetChanged
          state.budgetChanged = false
          yield* Effect.sleep("100 millis")
          state.reconciling = true
          yield* reconcile(sessionID, { budgetChanged: changed }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.logWarning("DagBudget reconcile failed", {
                    sessionID,
                    cause: Cause.pretty(cause),
                  }),
            ),
          )
          state.reconciling = false
          if (!state.rerun && !state.budgetChanged) {
            pending.delete(sessionID)
            return
          }
          state.rerun = false
        }
      }).pipe(Effect.forkIn(scope))
    })

  const onChildUsage = Effect.fnUntraced(function* (childSessionID: string) {
    let owner = children.get(childSessionID)
    if (owner === undefined) {
      if (notChildren.has(childSessionID)) return
      const resolve = store.getWorkflowByChildSession
      if (resolve === undefined) return
      const workflow = yield* resolve(childSessionID)
      if (!workflow || !workflow.directory) {
        notChildren.add(childSessionID)
        return
      }
      owner = { sessionID: workflow.sessionId, projectID: workflow.projectId, directory: workflow.directory }
      children.set(childSessionID, owner)
    }
    const instance = yield* InstanceRef
    if (!ownsWorkflow({ projectId: owner.projectID, directory: owner.directory }, instance)) return
    yield* schedule(owner.sessionID, false)
  })

  const onSessionUpdated = Effect.fnUntraced(function* (event: { data: unknown; location?: { directory?: string } }) {
    if (!isRecord(event.data) || typeof event.data.sessionID !== "string" || !isRecord(event.data.info)) return
    const sessionID = event.data.sessionID
    const info = event.data.info
    // Child sessions never own a DAG budget.
    if (typeof info.parentID === "string") return
    const instance = yield* InstanceRef
    const directory = event.location?.directory
    if (instance && directory) {
      if (DagLocation.canonicalDirectory(directory) !== DagLocation.canonicalDirectory(instance.directory)) return
    }
    const dagConfig = yield* config.dagGlobal()
    const unlimited = Boolean(info.dagBudgetUnlimited)
    const tokens = typeof info.dagBudgetTokens === "number" ? info.dagBudgetTokens : undefined
    const effective = unlimited ? null : (tokens ?? dagConfig.budget?.tokens ?? null)
    const known = seenBudget.has(sessionID)
    const previous = seenBudget.get(sessionID) ?? null
    seenBudget.set(sessionID, effective)
    // The first observation after a restart is treated as a change: a budget
    // raise may have happened while the process was down, and the durable
    // paused rows are the evidence that reconciles it safely.
    if (!known || previous !== effective) yield* schedule(sessionID, true)
  })

  const onConfigUpdated = Effect.fnUntraced(function* (event: GlobalEvent) {
    const payload = event.payload
    if (!payload || typeof payload !== "object" || payload.type !== ConfigHotReload.CONFIG_UPDATED_EVENT) return
    const keys = payload.properties?.keys
    if (!Array.isArray(keys) || !keys.includes("dag")) return
    const instance = yield* InstanceRef
    const sessionsOf = new Set<string>()
    for (const status of ["running", "stepping", "paused"]) {
      for (const workflow of yield* store.listByStatus(status)) {
        if (status === "paused" && workflow.pauseReason !== PAUSE_REASON_BUDGET_EXHAUSTED) continue
        if (!ownsWorkflow(workflow, instance)) continue
        sessionsOf.add(workflow.sessionId)
      }
    }
    for (const sessionID of sessionsOf) {
      // A config raise changes the inherited budget without a Session.Updated
      // event, so this is the `/config` half of the raise contract.
      seenBudget.delete(sessionID)
      yield* schedule(sessionID, true)
    }
  })

  const unsubscribe = yield* events.listen((evt) => {
    if (evt.type === SessionV1.Event.PartUpdated.type) {
      if (!isRecord(evt.data) || typeof evt.data.sessionID !== "string") return Effect.void
      const childSessionID = evt.data.sessionID
      if (!isRecord(evt.data.part) || evt.data.part.type !== "step-finish") return Effect.void
      return onChildUsage(childSessionID).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("DagBudget child usage routing failed", {
                sessionID: childSessionID,
                cause: Cause.pretty(cause),
              }),
        ),
      )
    }
    if (evt.type === SessionV1.Event.Updated.type) {
      return onSessionUpdated(evt).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("DagBudget session budget routing failed", { cause: Cause.pretty(cause) }),
        ),
      )
    }
    return Effect.void
  })
  yield* Effect.addFinalizer(() => unsubscribe.pipe(Effect.catchCause(() => Effect.void)))

  // `/config` updates arrive on the process-wide bus because the HTTP handler
  // is not instance-scoped. Route them through a queue so the handler itself
  // stays synchronous and the work runs in this service's scope.
  const configQueue = yield* Queue.unbounded<GlobalEvent>()
  const configListener = (event: GlobalEvent) => {
    Queue.offerUnsafe(configQueue, event)
  }
  GlobalBus.on("event", configListener)
  yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", configListener)))
  yield* Stream.fromQueue(configQueue).pipe(
    Stream.runForEach((event) =>
      onConfigUpdated(event).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("DagBudget config routing failed", { cause: Cause.pretty(cause) }),
        ),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )

  const init = Effect.fn("DagBudget.init")(function* () {
    const instance = yield* InstanceRef
    // Keep the bootstrap context for the background raise paths (see wake); a
    // reload bootstraps again and replaces the entry for the directory (the
    // disposal hook removed the previous generation's entry first).
    if (instance) {
      instanceManaged = true
      instanceContexts.set(DagLocation.canonicalDirectory(instance.directory), yield* Effect.context())
    }
    const sessionIDs = new Set<string>()
    for (const status of ["running", "stepping", "paused"]) {
      for (const workflow of yield* store.listByStatus(status)) {
        if (status === "paused" && workflow.pauseReason !== PAUSE_REASON_BUDGET_EXHAUSTED) continue
        if (!ownsWorkflow(workflow, instance)) continue
        sessionIDs.add(workflow.sessionId)
      }
    }
    for (const sessionID of sessionIDs) {
      yield* reconcile(sessionID, { budgetChanged: true }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("DagBudget startup reconcile failed", {
                sessionID,
                cause: Cause.pretty(cause),
              }),
        ),
      )
    }
  })

  return Service.of({
    state: compute,
    check,
    exhaust,
    onBudgetChanged: (sessionID) => reconcile(sessionID, { budgetChanged: true }),
    init,
  })
})

export const layer: Layer.Layer<
  Service,
  never,
  EventV2Bridge.Service | DagStore.Service | Dag.Service | Config.Service | Session.Service
> = Layer.effect(Service, make)

/**
 * ResumeGuard policy supplied by the budget gate: `Dag.resume` and `Dag.step`
 * are refused while the owning session's budget is exhausted. The policy
 * converts the accounting failure into the D12 refusal shape so control and
 * tool copy render the durable pause reason.
 */
export const resumeGuardLayer: Layer.Layer<ResumeGuard.Service, never, Service> = Layer.effect(
  ResumeGuard.Service,
  Effect.gen(function* () {
    const budget = yield* Service
    return ResumeGuard.Service.of({
      check: (workflow) =>
        budget.check(SessionID.make(workflow.sessionId)).pipe(
          Effect.asVoid,
          Effect.catchTag("BudgetExhausted", (error) =>
            Effect.fail(
              new ResumeBlockedError({
                workflowID: workflow.id,
                pauseReason: workflow.pauseReason ?? PAUSE_REASON_BUDGET_EXHAUSTED,
                detail: error.message,
              }),
            ),
          ),
        ),
    })
  }),
)

export const defaultLayer: Layer.Layer<Service | ResumeGuard.Service> = Layer.merge(
  layer,
  resumeGuardLayer.pipe(Layer.provide(layer)),
).pipe(
  Layer.provide(Dag.defaultLayer),
  Layer.provide(DagStore.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionInbox.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
)

export const node = LayerNode.make(layer, [
  EventV2Bridge.node,
  DagStore.node,
  Dag.node,
  Config.node,
  Session.node,
])