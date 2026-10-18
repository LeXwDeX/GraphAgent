// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

export * as DagSupervisionSweep from "./supervision-sweep"

import { Cause, Context, Effect, Fiber, Layer, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Logging } from "@opencode-ai/core/observability/logging"
import { DagStore } from "@opencode-ai/core/dag/store"
import { WorkflowNodeTable } from "@opencode-ai/core/dag/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { isNodeTerminalStatus, isTransitionRejection, isWorkflowTerminalStatus } from "@opencode-ai/core/dag/core/types"
import { and, eq, sql } from "drizzle-orm"
import { Dag, parseWorkflowConfig } from "@/dag/dag"
import { SessionPrompt } from "@/session/prompt"
import { SessionAutomationLease } from "@/session/automation-lease"
import { InstanceRef } from "@/effect/instance-ref"

/**
 * Host-level deadline-supervision sweep — the fallback retry for the
 * production incident (2026-08-18, dag_fe5feabfcae607fqVdRh47lN1B):
 *
 * A per-directory instance teardown (lifecycle cleanup, directory switch,
 * config change) silently reaps every fiber forked into its scope — the
 * DagLoop subscriptions, the spawn execution fiber, AND the deadline
 * watcher — while the durable node row stays `running`. Because the host
 * process keeps running, nothing ever re-arms supervision: the node rots in
 * `running` past its deadline with `timeout_extensions` frozen for hours
 * (7.5h observed). Re-init/crash recovery CAN settle such rows, but only
 * when something re-triggers the instance — and in a live host nothing
 * does.
 *
 * This sweep is deliberately NOT forked into any per-directory
 * InstanceState scope: its repeating fiber is forked into the LAYER scope
 * at construction and lives for the process lifetime. It must therefore
 * never depend on ambient per-instance context (InstanceRef) — its fiber's
 * context is the layer-build context, which has none. Ownership is decided
 * from the durable rows alone: this process's Database owns every workflow
 * row it can read. Same-host races (a live watcher, the DagLoop) are
 * serialized by the workflow's in-process lock; a second host sharing the
 * DB is handled by the durable guardNode status read plus the projector's
 * conditional UPDATE (only the first NodeFailed folds a non-terminal row) —
 * double settles collapse to one.
 *
 * False-positive safety: a LIVE watcher escalates on
 * escalateIntervalMs == max(1s, timeout_ms ?? 10min) and nodeTimeoutEscalated
 * does NOT move deadline_ms — so a live overdue node legitimately shows a
 * flat timeout_extensions for up to one full escalate interval (10 minutes
 * on the default config). The freeze window is therefore expressed in
 * ticks: a node is only declared dead once its counter has stayed flat for
 * frozenTicksNeeded(escalateIntervalMs) consecutive sweep ticks — the
 * default 10-minute cadence needs 11 ticks (≈11 minutes), so a live watcher
 * always moves the counter well inside the window, while a dead one (the
 * incident shape: 7.5h frozen) is settled in bounded time.
 */

export interface Interface {
  /** Re-arm the periodic sweep fiber (idempotent; production layers fork it at construction). */
  readonly init: () => Effect.Effect<void>
  /** One scan pass. Exported for deterministic tests: loop it frozenTicksNeeded times to simulate a dead watcher. */
  readonly sweepOnce: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DagSupervisionSweep") {}

export const SWEEP_INTERVAL = "60 seconds"
const SWEEP_INTERVAL_MS = 60_000

/**
 * Flat ticks before declaring supervision dead, derived from the node's own
 * escalation cadence: a LIVE watcher escalates every
 * escalateIntervalMs == max(1s, timeout_ms ?? 10min) and never moves
 * deadline_ms, so its counter can legitimately stay flat for up to one full
 * interval. Requiring ceil(interval / sweep interval) + 1 consecutive flat
 * ticks means a live watcher — at ANY configured timeout, including the
 * doc-recommended 30-minute verifier timeouts — always moves the counter
 * inside the window, while a dead one (the incident shape: hours frozen) is
 * settled in bounded time. The config lookup happens once a node has been
 * overdue-flat for at least one tick, so healthy graphs pay nothing.
 */
export const frozenTicksNeeded = (escalateIntervalMs: number) =>
  Math.ceil(Math.max(escalateIntervalMs, 1_000) / SWEEP_INTERVAL_MS) + 1

/**
 * The node's escalation cadence derived from a persisted config row. Pure —
 * exported for unit tests. parseWorkflowConfig is the repo's defensive
 * parser: malformed JSON or shape-divergent rows return undefined instead of
 * throwing, and every degrade path lands on the DEFAULT cadence (the widest
 * guaranteed-safe window) — a single corrupt row must never defect the sweep.
 */
export const escalateIntervalFromConfig = (raw: string | undefined, nodeId: string) => {
  const node = raw === undefined ? undefined : parseWorkflowConfig(raw)?.nodes.find((n) => n.id === nodeId)
  const timeoutMs = node?.worker_config?.timeout_ms
  return Math.max(1_000, typeof timeoutMs === "number" ? timeoutMs : Dag.DEFAULT_WORKFLOW_CONFIG.nodeTimeoutMs)
}

/**
 * An upper bound on the cadence the LIVE watcher actually runs at,
 * back-derived from durable columns. deadline_ms is only ever written as
 * `grant time + timeout_ms` — at spawn (started_at + T0) and at each
 * deadline extension (now + Ti) — while escalations move only the counter,
 * never the deadline. The granted total (deadline − started_at) is therefore
 * the sum of the initial grant plus every extension grant, which is always
 * ≥ the LAST grant, and the last grant's timeout IS the live watcher's
 * cadence (a re-time replaces the watcher at the new timeout). Issue #342:
 * replan can lower a running node's persisted timeout_ms while the A1/Q2
 * re-time gate deliberately keeps the old watcher on its old (longer)
 * cadence — a config-only window would then be shorter than the live
 * watcher's cycle and sweep a healthy node. Taking the max with the config
 * cadence covers both shapes: re-timed watchers match the config (the
 * durable value merely over-estimates by the accumulated grants, delaying —
 * never causing — a settle), gate-skipped ones are caught by the durable
 * bound. Returns 0 when the columns are missing (legacy rows) so the config
 * value decides alone.
 */
export const escalateIntervalDurable = (
  deadlineMs: number | null | undefined,
  startedAt: number | null | undefined,
) => {
  if (deadlineMs == null || startedAt == null) return 0
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(startedAt)) return 0
  const granted = deadlineMs - startedAt
  if (granted <= 0) return 0
  return Math.max(1_000, granted)
}

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const store = yield* DagStore.Service
    const dag = yield* Dag.Service
    const promptSvc = yield* SessionPrompt.Service
    const automation = yield* SessionAutomationLease.Service
    const scope = yield* Scope.Scope

    // nodeKey -> {extensions, flatTicks}: the counter value last observed and
    // how many consecutive sweep ticks it has stayed flat while the node was
    // running and overdue. Reset on any counter movement, terminal status, or
    // disappearance from the query.
    const flatStreak = new Map<string, { attempt: string; extensions: number; flatTicks: number }>()

    // The node's escalation cadence, from the workflow's persisted config —
    // the same source spawn.ts derived the watcher's escalateIntervalMs from.
    // Only nodes already flat for a tick pay this lookup; a store read
    // failure degrades to the DEFAULT cadence (the widest guaranteed-safe
    // window).
    const escalateIntervalFor = Effect.fnUntraced(function* (workflowId: string, nodeId: string) {
      const wf = yield* store.getWorkflow(workflowId).pipe(
        Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(undefined))),
      )
      return escalateIntervalFromConfig(wf?.config, nodeId)
    })

    // #349/SW-L1: publish-side location stamping. The sweep's layer context
    // has no ambient InstanceRef, so its durable events used to carry an
    // empty location — live instances' summary publishers filter by
    // directory, so the TUI never got a summary push for a swept settle
    // (bootstrap refetch only). Providing a reference derived from the
    // workflow's own durable row (directory + project) stamps the events so
    // the owning directory's consumers see them. Falls back to unstamped
    // when the row cannot be resolved — same visibility as before, never
    // worse.
    const withWorkflowLocation = Effect.fnUntraced(function* (workflowId: string, body: Effect.Effect<void, Error>) {
      const wf = yield* store.getWorkflow(workflowId).pipe(
        Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(undefined))),
      )
      if (!wf?.directory) return yield* body
      const project = yield* db
        .select()
        .from(ProjectTable)
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the durable column is typed string; ProjectTable.id is branded.
        .where(eq(ProjectTable.id, wf.projectId as never))
        .get()
        .pipe(Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(undefined))))
      yield* body.pipe(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- partial InstanceContext: only directory/worktree/project.id are read by the publish-side location stamp.
        Effect.provideService(InstanceRef, {
          directory: wf.directory,
          worktree: project?.worktree ?? wf.directory,
          project: { id: wf.projectId },
        } as never),
      )
    })

    const sweepOnce = Effect.fn("DagSupervisionSweep.sweepOnce")(function* () {
      const rows = yield* db
        .select({
          workflowId: WorkflowNodeTable.workflow_id,
          nodeId: WorkflowNodeTable.id,
          childSessionId: WorkflowNodeTable.child_session_id,
          replanAttempts: WorkflowNodeTable.replan_attempts,
          extensions: WorkflowNodeTable.timeout_extensions,
          deadlineMs: WorkflowNodeTable.deadline_ms,
          startedAt: WorkflowNodeTable.started_at,
        })
        .from(WorkflowNodeTable)
        .where(
          and(
            eq(WorkflowNodeTable.status, "running"),
            sql`${WorkflowNodeTable.deadline_ms} IS NOT NULL AND ${WorkflowNodeTable.deadline_ms} <= ${Date.now()}`,
          ),
        )
        .all()
        .pipe(
          // A store defect must not kill the sweep — the same silent-death
          // class this service exists to eliminate. Degrade to an empty
          // pass and retry next tick (mirror of spawn.ts's R13 hardening).
          // Interrupts (scope disposal) still propagate — the repo's
          // background-loop discipline.
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.gen(function* () {
                  yield* Effect.logWarning("DagSupervisionSweep store query failed — skipping tick", { cause })
                  return []
                }),
          ),
        )

      const observed = new Map<string, { attempt: string; extensions: number; flatTicks: number }>()
      for (const row of rows) {
        const key = `${row.workflowId}\0${row.nodeId}`
        // The streak belongs to ONE execution attempt: a restarted/replanned
        // attempt (new replan counter or child session) starts a fresh window.
        const attempt = `${row.replanAttempts}\0${row.childSessionId ?? ""}`
        const prior = flatStreak.get(key)
        const flatTicks =
          prior && prior.attempt === attempt && prior.extensions === row.extensions ? prior.flatTicks + 1 : 0
        observed.set(key, { attempt, extensions: row.extensions, flatTicks })
        // Only nodes already flat for a tick pay the config lookup.
        if (flatTicks < 1) continue
        const escalateIntervalMs = yield* escalateIntervalFor(row.workflowId, row.nodeId)
        // #342: the window must cover the LIVE watcher's actual cadence, not
        // just the current config's — replan may have lowered the persisted
        // timeout while the re-time gate kept the old watcher.
        const windowIntervalMs = Math.max(
          escalateIntervalMs,
          escalateIntervalDurable(row.deadlineMs, row.startedAt),
        )
        if (flatTicks < frozenTicksNeeded(windowIntervalMs)) continue
        // Frozen across the full window: cancel the (possibly dead) child and
        // settle the node. Same-host races (a live watcher) are serialized by
        // the workflow's in-process lock; another host's sweep is collapsed
        // by the durable terminal-status guard — either way at most one
        // settle lands.
        if (row.childSessionId) {
          // File-only DEBUG attribution for the sweep-initiated interruption
          // (#777): correlation IDs only, never prompt text. backgroundDebug
          // owns its logger selection, so it needs no ambient InstanceRef.
          yield* Logging.backgroundDebug("lifecycle.dag.execution.aborted", {
            source: "dag.supervisionSweep.frozen",
            workflowID: row.workflowId,
            nodeID: row.nodeId,
            replanAttempts: row.replanAttempts,
            childSessionID: row.childSessionId,
          })
          // Best-effort cancel, recovered at CAUSE level: the sweep's layer
          // context has no ambient InstanceRef, so a real SessionPrompt.cancel
          // dies at InstanceState.context ("InstanceRef not provided") — and
          // cancel's channel is E=never, where Effect.ignore recovers nothing.
          // In the incident shape (instance disposed) the child fiber died
          // with the scope, so a skipped cancel is also the correct outcome;
          // the durable settle below is the source of truth either way.
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the durable column is typed string|null; the cancel seam brands SessionID.
          yield* promptSvc.cancel(row.childSessionId as never).pipe(
            Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.void)),
          )
        }
        const settled = yield* withWorkflowLocation(
          row.workflowId,
          dag
            .nodeFailed(
              row.workflowId,
              row.nodeId,
              `deadline supervision lost (no escalation progress across ${flatTicks} sweep ticks, escalate cadence ${escalateIntervalMs}ms) — swept, extensions ${row.extensions}`,
              "timeout",
              // Settle only the attempt this tick observed frozen. The SELECT
              // above and this write are separated by yields (config read,
              // cancel, location lookup); a restart in that window starts a
              // fresh attempt that the identity guard must protect.
              {
                replanAttempts: row.replanAttempts,
                ...(row.childSessionId ? { childSessionID: row.childSessionId } : {}),
              },
            )
            .pipe(Effect.asVoid),
        ).pipe(
          Effect.as(true),
          // The observed attempt already settled or was replaced: nothing to
          // sweep. The next tick re-reads the row (a new attempt restarts its
          // own freeze window).
          Effect.catchIf(isTransitionRejection, (error) =>
            Effect.logDebug("DagSupervisionSweep skipped a settled or replaced attempt", {
              dagID: row.workflowId,
              nodeID: row.nodeId,
              error,
            }).pipe(Effect.as(false)),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.gen(function* () {
                  yield* Effect.logWarning("DagSupervisionSweep nodeFailed failed — retrying next tick", {
                    dagID: row.workflowId,
                    nodeID: row.nodeId,
                    cause,
                  })
                  return false
                }),
          ),
        )
        // On a failed settle keep the streak so the next tick retries
        // immediately instead of deferring by a full freeze window.
        if (!settled) continue
        yield* Effect.logWarning("DagSupervisionSweep settled a node with dead deadline supervision", {
          dagID: row.workflowId,
          nodeID: row.nodeId,
          extensions: row.extensions,
        })
        observed.delete(key)
        // #343: node rot is fixed, workflow rot is next. checkCompletion
        // lives inside DagLoop — with the owning instance torn down nothing
        // advances the workflow's terminal state, releases its automation
        // lease, or tells the parent. Terminalize durably from the host
        // level once EVERY current-revision node is terminal; parent wake
        // delivery stays with the owning instance (session context) and
        // converges through the DagLoop init drain on the next instance
        // load. A live DagLoop racing this is serialized by the same
        // workflow lock and its terminal-status guards — double settles
        // collapse to one.
        yield* withWorkflowLocation(row.workflowId, settleWorkflowIfComplete(row.workflowId)).pipe(
          Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.void)),
        )
      }
      // Retain only what is still overdue-running so settled/restarted nodes
      // do not accumulate.
      flatStreak.clear()
      for (const [key, streak] of observed) flatStreak.set(key, streak)
    })

    // #343 host-level mirror of DagLoop.checkCompletion's durable half: when
    // every current-revision node is terminal and the workflow row is not,
    // land the terminal transition (fail on required-node failure, complete
    // otherwise) and release the workflow's automation lease registration.
    // Wake delivery to the parent session stays with the owning instance —
    // it needs session context (ownsSession guard, prompt injection) — and
    // converges through the DagLoop init drain on the next instance load.
    // Transition rejections (a live DagLoop completed first, or a replan
    // re-registered nodes between the reads and the write) are expected and
    // silent; the next tick re-evaluates from the durable rows.
    const settleWorkflowIfComplete = Effect.fnUntraced(function* (workflowId: string) {
      const wf = yield* store.getWorkflow(workflowId).pipe(
        Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(undefined))),
      )
      if (!wf || isWorkflowTerminalStatus(wf.status as never)) return
      const nodes = yield* store.getCurrentNodes(workflowId).pipe(
        Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed([]))),
      )
      if (nodes.length === 0 || nodes.some((node) => !isNodeTerminalStatus(node.status as never))) return
      const failed = nodes.filter((node) => node.status === "failed" && node.required).map((node) => node.id)
      const transition = failed.length > 0
        ? yield* dag.fail(workflowId, `required node(s) failed: ${failed.join(", ")}`).pipe(
            Effect.as("failed" as const),
            Effect.catchIf(isTransitionRejection, () => Effect.succeed(undefined)),
          )
        : yield* dag.complete(workflowId, { skipReviewGate: true }).pipe(
            Effect.as("completed" as const),
            Effect.catchIf(isTransitionRejection, () => Effect.succeed(undefined)),
          )
      if (transition === undefined) return
      yield* Effect.logWarning("DagSupervisionSweep terminalized a workflow whose instance is gone", {
        dagID: workflowId,
        outcome: transition,
      })
      // The lease registration outlived the owning DagLoop's handlers; this
      // process's registry entry must not pin the parent session's automation
      // forever. Cross-process registries are untouched (a no-op here).
      yield* automation
        .unregister(wf.sessionId as never, { kind: "dag", id: workflowId })
        .pipe(Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.void)))
    })

    let sweepFiber: Fiber.Fiber<void> | undefined

    const init = Effect.fn("DagSupervisionSweep.init")(function* () {
      if (sweepFiber) return
      sweepFiber = yield* Effect.gen(function* () {
        for (;;) {
          yield* Effect.sleep(SWEEP_INTERVAL)
          yield* sweepOnce().pipe(
            // Per-tick guard: any residual defect inside a tick degrades to
            // a logged skip — the loop itself must outlive every failure.
            // Interrupts (scope disposal) still exit the loop.
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.logWarning("DagSupervisionSweep tick failed — retrying next interval", { cause }),
            ),
          )
        }
      }).pipe(Effect.forkIn(scope))
    })

    // AGENTS.md background-loop convention: fork at construction so the sweep
    // survives without any caller remembering to init it.
    yield* init()

    return Service.of({ init, sweepOnce })
  }),
)

/** The bare effect layer — bring your own Database/Dag/SessionPrompt. Tests compose this against their mocks; production uses `defaultLayer`. */
export const layerWithoutDeps = serviceLayer

export const layer = serviceLayer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(DagStore.defaultLayer),
  Layer.provide(Dag.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
  Layer.provide(SessionAutomationLease.defaultLayer),
)

export const defaultLayer = layer

export const node = LayerNode.make(serviceLayer, [
  Database.node,
  DagStore.node,
  Dag.node,
  SessionPrompt.node,
  SessionAutomationLease.node,
])
