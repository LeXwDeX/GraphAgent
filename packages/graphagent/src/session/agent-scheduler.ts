// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as AgentScheduler from "./agent-scheduler"

import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Clock, Context, Deferred, Duration, Effect, Layer, Option, Schema, Scope } from "effect"
import { Config } from "@/config/config"
import {
  DEFAULT_LIMITS,
  type CacheGroupState,
  type Lane,
  type LimitKey,
  type RequestWaiter,
  type SchedulerLimits,
  type SchedulerState,
  type SlotWaiter,
} from "./agent-scheduler-state"
import { EngineProcess } from "./engine-process"

/**
 * Process-level two-tier concurrency scheduler (Issue #1021, PR5).
 *
 * # Model-stream requests
 *
 * One permit covers one provider stream. It is acquired before the request is
 * sent and released when the underlying stream ends, fails, or is interrupted
 * — never after tool execution. The release point is the stream's own scope, so
 * a tool that waits on another agent cannot deadlock the pool even when the
 * global cap is 1.
 *
 * Lanes order the queue. `interactive` and `side` keep reserved headroom: a
 * background job, title generation, or a child run may never consume the slots
 * kept for a user turn or an aside. Below three concurrent streams the
 * reservation is disabled so a small pool cannot starve child work.
 *
 * # Child runs
 *
 * A slot covers one spawned child run (a DAG node or a task subagent). DAG
 * nodes hold the workflow layer (`max_concurrency`, truncated to the child
 * pool) and the DAG-wide layer (`dag.concurrency`, hot-read by the caller in
 * E4) at the same time. Task runs draw from the two slots reserved inside the
 * child pool and are not counted against the DAG-wide layer.
 *
 * # Penalties
 *
 * A rate-limited provider/model pair refuses new child and background permits
 * until its retry-after elapses. Interactive and side requests may still try:
 * a user turn that the provider rejects is reported, not delayed silently.
 *
 * # Waiting
 *
 * Every waiter wakes on its grant. Because a penalty has no timer, a waiting
 * request also polls once per second while queued; the poll re-runs the pump so
 * a permit becomes available when the penalty expires without any release.
 *
 * # Cache groups (Issue #1028, PR4)
 *
 * Child runs whose agent prompt, system fragments and tools hash to the same
 * cache group may share a provider-side prompt cache. When sibling staggering
 * is enabled, only one request per closed group — the leader — is in flight;
 * its siblings queue. The group opens on the leader's first streamed content,
 * when the leader releases (end, failure, or interruption), or when the
 * `STAGGER_WINDOW_MS` timer expires. Invariant: while a group is closed, its
 * leader is the only inflight request among that group's staggered siblings.
 */

/** One provider stream permit. `release` is idempotent. */
export interface Permit {
  readonly release: Effect.Effect<void>
}

/** One child-run permit. `release` is idempotent. */
export interface SlotPermit {
  readonly release: Effect.Effect<void>
}

export interface RequestInput {
  readonly lane: Lane
  readonly providerID: string
  readonly modelID: string
  readonly sessionID: string
  /** Prompt-cache group shared by sibling child runs, when known. */
  readonly cacheGroup?: string
  /** Opt child-lane requests into sibling staggering within their cache group. */
  readonly staggerSiblings?: boolean
}

export interface RequestOptions {
  /** Omit to wait indefinitely; interruption always returns immediately. */
  readonly timeoutMs?: number
}

export interface ChildSlotOptions {
  /** Session the child run belongs to; the queue rotates between roots. */
  readonly rootSessionID?: string
  readonly timeoutMs?: number
}

export interface CapacitySnapshot {
  readonly children: {
    readonly running: number
    readonly cap: number
    /** #1027 D6: DAG-wide running child slots shared by every workflow. */
    readonly dagRunning: number
    /** The `dag.concurrency` layer, additionally bounded by the child pool. */
    readonly dagCap: number
  }
  readonly requests: { readonly inflight: number; readonly cap: number }
  readonly providers: Record<
    string,
    { readonly inflight: number; readonly cap: number; readonly penalizedUntil?: number }
  >
  readonly laneQueued: Record<Lane, number>
  readonly limit?: { readonly key: LimitKey; readonly used: number; readonly cap: number }
}

/** A bounded wait over the scheduler expired. Cancellation is interruption, not this error. */
export class SchedulerTimeout extends Schema.TaggedError<SchedulerTimeout>()("AgentSchedulerTimeout", {
  wait: Schema.String,
  subject: Schema.String,
  waitMs: Schema.Number,
}) {
  override get message() {
    return `Agent scheduler timed out after ${this.waitMs}ms waiting for ${this.wait} "${this.subject}"`
  }
}

export interface Interface {
  /** Wait for a model-stream permit inside the caller's scope. */
  readonly request: (
    input: RequestInput,
    options?: RequestOptions,
  ) => Effect.Effect<Permit, SchedulerTimeout, Scope.Scope>
  /** Take a model-stream permit only if one is available now; never queues. */
  readonly tryRequest: (input: RequestInput) => Effect.Effect<Option.Option<Permit>, never, Scope.Scope>
  /**
   * Open a cache group so its queued siblings may start. Idempotent; an
   * untracked group is a no-op. While a group stays closed, only its leader
   * holds an inflight request among that group's staggered siblings.
   */
  readonly prime: (cacheGroup: string) => Effect.Effect<void>
  /** Wait for a child-run slot inside the caller's scope. */
  readonly childSlot: (
    limit: LimitKey,
    cap: number,
    options?: ChildSlotOptions,
  ) => Effect.Effect<SlotPermit, SchedulerTimeout, Scope.Scope>
  /** Refuse new child and background model permits for this provider/model until the deadline. */
  readonly penalize: (providerID: string, modelID: string, retryAfterMs: number) => Effect.Effect<void>
  /** Current counters and caps, optionally for one limit key. */
  readonly capacity: (limit?: LimitKey) => Effect.Effect<CapacitySnapshot>
  /** Current effective limits, refreshed from configuration on each call. */
  readonly limits: () => Effect.Effect<SchedulerLimits>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/AgentScheduler") {}

const LANE_RANK: Record<Lane, number> = {
  interactive: 0,
  side: 1,
  parent_wake: 2,
  child: 3,
  background: 4,
  auxiliary: 5,
}

const modelKey = (providerID: string, modelID: string) => `${providerID}\u0000${modelID}`

/**
 * How long a cache-group leader may run before its siblings are released even
 * without a first stream event. A leader that ends, fails, or is interrupted
 * opens the group immediately through its permit release instead of waiting.
 */
export const STAGGER_WINDOW_MS = 3_000

type StaggeringInput = RequestInput & { readonly cacheGroup: string }

const staggering = (input: RequestInput): input is StaggeringInput =>
  input.lane === "child" && input.staggerSiblings === true && input.cacheGroup !== undefined

const increment = (map: Map<string, number>, key: string) => {
  map.set(key, (map.get(key) ?? 0) + 1)
}

const decrement = (map: Map<string, number>, key: string) => {
  const next = (map.get(key) ?? 0) - 1
  if (next <= 0) map.delete(key)
  else map.set(key, next)
}

const incrementLane = (map: Map<Lane, number>, lane: Lane) => {
  map.set(lane, (map.get(lane) ?? 0) + 1)
}

const decrementLane = (map: Map<Lane, number>, lane: Lane) => {
  const next = (map.get(lane) ?? 0) - 1
  if (next <= 0) map.delete(lane)
  else map.set(lane, next)
}

/**
 * Slots kept outside the shared draw. Disabled below three concurrent streams:
 * with one or two slots the reservation would starve every non-interactive
 * lane forever instead of leaving headroom.
 */
const othersCap = (limits: SchedulerLimits) => (limits.global <= 2 ? limits.global : limits.global - 2)

/**
 * Child-pool arithmetic. `childGlobal - taskReserve` is the ceiling for DAG
 * child runs; the reserved slots stay available to the task tool. The DAG-wide
 * layer is `dag.concurrency`, additionally bounded by that ceiling.
 */
const childCaps = (limits: SchedulerLimits) => {
  const workflowPool = Math.max(1, limits.childGlobal - limits.taskReserve)
  return {
    workflowPool,
    dagLayer: Math.max(1, Math.min(limits.dagConcurrency, workflowPool)),
    childGlobal: Math.max(1, limits.childGlobal),
  }
}

const effectiveWorkflowCap = (limits: SchedulerLimits, cap: number) =>
  Math.max(1, Math.min(cap, childCaps(limits).workflowPool))

const canRequest = (state: SchedulerState, input: RequestInput, nowMs: number): boolean => {
  const requests = state.requests
  const limits = state.limits
  if (requests.inflight >= limits.global) return false
  if ((requests.byProvider.get(input.providerID) ?? 0) >= limits.perProvider) return false
  if (input.lane === "side" && (requests.byLane.get("side") ?? 0) >= 1) return false
  if (input.lane === "child" || input.lane === "background") {
    const until = requests.penalizedUntil.get(modelKey(input.providerID, input.modelID)) ?? 0
    if (nowMs < until) return false
  }
  if (input.lane !== "interactive" && input.lane !== "side" && requests.inflight >= othersCap(limits)) return false
  // A closed group admits only its leader; siblings queue until it primes or
  // releases. Groups without an entry are not yet started, so they admit.
  if (staggering(input)) {
    const group = state.cacheGroups.get(input.cacheGroup)
    if (group !== undefined && !group.open) return false
  }
  return true
}

const grantRequest = (state: SchedulerState, input: RequestInput) => {
  state.requests.inflight += 1
  increment(state.requests.byProvider, input.providerID)
  incrementLane(state.requests.byLane, input.lane)
  state.requests.lastGrantedLane = input.lane
  if (!staggering(input)) return
  const entry: CacheGroupState = state.cacheGroups.get(input.cacheGroup) ?? { open: false, inflight: 0 }
  if (!state.cacheGroups.has(input.cacheGroup)) state.cacheGroups.set(input.cacheGroup, entry)
  entry.inflight += 1
}

const hasGroupWaiter = (state: SchedulerState, cacheGroup: string) =>
  state.requests.waiters.some(
    (waiter) =>
      !waiter.cancelled && !waiter.granted && waiter.staggerSiblings === true && waiter.cacheGroup === cacheGroup,
  )

const releaseRequest = (state: SchedulerState, input: RequestInput) => {
  state.requests.inflight = Math.max(0, state.requests.inflight - 1)
  decrement(state.requests.byProvider, input.providerID)
  decrementLane(state.requests.byLane, input.lane)
  if (!staggering(input)) return
  const entry = state.cacheGroups.get(input.cacheGroup)
  if (entry === undefined) return
  entry.inflight = Math.max(0, entry.inflight - 1)
  // A leader that ends, fails, or is interrupted before its first token still
  // opens the group: siblings must never wait for a stream that cannot report.
  if (!entry.open) entry.open = true
  if (entry.inflight === 0 && !hasGroupWaiter(state, input.cacheGroup)) state.cacheGroups.delete(input.cacheGroup)
}

/**
 * Open a cache group and admit its queued siblings. Idempotent: an absent or
 * already-open group does nothing. `expected` is the entry captured when the
 * leader armed its timer; an entry recreated in the meantime must not be
 * opened by the stale timer.
 */
const primeGroup = (state: SchedulerState, cacheGroup: string, expected?: CacheGroupState) =>
  Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis
    yield* Effect.sync(() => {
      const entry = state.cacheGroups.get(cacheGroup)
      if (entry === undefined || entry.open) return
      if (expected !== undefined && entry !== expected) return
      entry.open = true
      pumpRequests(state, nowMs)
    })
  })

/**
 * Arm the stagger window for a leader: if it has not opened its group within
 * `STAGGER_WINDOW_MS`, open it so siblings are not blocked by a slow first
 * token. The timer lives in the caller's scope and is interrupted with the
 * stream, so it cannot outlive the request that armed it.
 */
const armStagger = (state: SchedulerState, input: RequestInput) =>
  Effect.suspend(() => {
    if (!staggering(input)) return Effect.void
    const entry = state.cacheGroups.get(input.cacheGroup)
    // Only the first inflight request of a closed group is the leader.
    if (entry === undefined || entry.open || entry.inflight !== 1) return Effect.void
    return Effect.sleep(Duration.millis(STAGGER_WINDOW_MS)).pipe(
      Effect.andThen(primeGroup(state, input.cacheGroup, entry)),
      Effect.forkScoped,
      Effect.asVoid,
    )
  })

/**
 * Grant as many queued requests as the counters allow. Lane order is strict;
 * within one lane the queue is FIFO. Every grant, counter update, and Deferred
 * completion runs in one synchronous block, so a waiter cannot observe a
 * half-granted permit.
 */
const pumpRequests = (state: SchedulerState, nowMs: number) => {
  for (;;) {
    let selected = -1
    for (let index = 0; index < state.requests.waiters.length; index++) {
      const waiter = state.requests.waiters[index]
      if (waiter.cancelled || waiter.granted) continue
      if (!canRequest(state, waiter, nowMs)) continue
      if (selected === -1 || LANE_RANK[waiter.lane] < LANE_RANK[state.requests.waiters[selected].lane]) selected = index
    }
    if (selected === -1) return
    const [waiter] = state.requests.waiters.splice(selected, 1)
    waiter.granted = true
    grantRequest(state, waiter)
    Deferred.doneUnsafe(waiter.grant, Effect.void)
  }
}

const slotAdmissible = (state: SchedulerState, limit: LimitKey, cap: number): boolean => {
  const { workflowPool, dagLayer, childGlobal } = childCaps(state.limits)
  if (limit.kind === "workflow") {
    if ((state.children.byWorkflow.get(limit.workflowID) ?? 0) >= effectiveWorkflowCap(state.limits, cap)) return false
    if (state.children.dagGlobal >= dagLayer) return false
    // The task reserve is excluded from `workflowPool`, so a running task must
    // not count against the workflow ceiling as well; the shared draw is still
    // bounded by the total child pool.
    if (state.children.dagGlobal >= workflowPool) return false
    return state.children.inflight < childGlobal
  }
  if ((state.children.byTaskParent.get(limit.parentSessionID) ?? 0) >= Math.max(1, cap)) return false
  return state.children.inflight < childGlobal
}

/** The part of a waiter a released permit needs to give its reservation back. */
type SlotHeld = Pick<SlotWaiter, "limit" | "cap" | "rootSessionID">

const grantSlot = (state: SchedulerState, held: SlotHeld) => {
  state.children.inflight += 1
  state.children.lastGrantedRoot = held.rootSessionID
  if (held.limit.kind === "workflow") {
    state.children.dagGlobal += 1
    increment(state.children.byWorkflow, held.limit.workflowID)
    state.children.workflowCaps.set(held.limit.workflowID, effectiveWorkflowCap(state.limits, held.cap))
  } else {
    increment(state.children.byTaskParent, held.limit.parentSessionID)
    state.children.taskCaps.set(held.limit.parentSessionID, Math.max(1, held.cap))
  }
}

const releaseSlot = (state: SchedulerState, held: SlotHeld) => {
  state.children.inflight = Math.max(0, state.children.inflight - 1)
  if (held.limit.kind === "workflow") {
    state.children.dagGlobal = Math.max(0, state.children.dagGlobal - 1)
    decrement(state.children.byWorkflow, held.limit.workflowID)
  } else {
    decrement(state.children.byTaskParent, held.limit.parentSessionID)
  }
}

/**
 * Grant queued child runs. Within a root the queue is FIFO; when several roots
 * are waiting, the next slot goes to a root other than the last one served.
 */
const pumpSlots = (state: SchedulerState) => {
  for (;;) {
    let selected = -1
    for (let index = 0; index < state.children.waiters.length; index++) {
      const waiter = state.children.waiters[index]
      if (waiter.cancelled || waiter.granted) continue
      if (!slotAdmissible(state, waiter.limit, waiter.cap)) continue
      if (selected === -1) {
        selected = index
        continue
      }
      const chosen = state.children.waiters[selected]
      if (
        chosen.rootSessionID === state.children.lastGrantedRoot &&
        waiter.rootSessionID !== state.children.lastGrantedRoot
      )
        selected = index
    }
    if (selected === -1) return
    const [waiter] = state.children.waiters.splice(selected, 1)
    waiter.granted = true
    grantSlot(state, waiter)
    Deferred.doneUnsafe(waiter.grant, Effect.void)
  }
}

const requestPermit = (state: SchedulerState, input: RequestInput): Permit => {
  let released = false
  return {
    release: Effect.suspend(() => {
      if (released) return Effect.void
      released = true
      return Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis
        yield* Effect.sync(() => {
          releaseRequest(state, input)
          pumpRequests(state, nowMs)
        })
      })
    }),
  }
}

const slotPermit = (state: SchedulerState, held: SlotHeld): SlotPermit => {
  let released = false
  return {
    release: Effect.suspend(() => {
      if (released) return Effect.void
      released = true
      return Effect.sync(() => {
        releaseSlot(state, held)
        pumpSlots(state)
      })
    }),
  }
}

const removeWaiter = <W extends { cancelled: boolean }>(waiters: W[], waiter: W) => {
  waiter.cancelled = true
  const index = waiters.indexOf(waiter)
  if (index >= 0) waiters.splice(index, 1)
}

/**
 * A grant can race the cancellation of the waiter that was about to receive it.
 * The reservation must then go back to the pool (and the next waiter pumped)
 * instead of leaking a permit nobody will release.
 */
const cancelRequestWaiter = (state: SchedulerState, waiter: RequestWaiter) =>
  Effect.suspend(() => {
    if (!waiter.granted) {
      return Effect.sync(() => removeWaiter(state.requests.waiters, waiter))
    }
    return Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis
      yield* Effect.sync(() => {
        waiter.cancelled = true
        releaseRequest(state, waiter)
        pumpRequests(state, nowMs)
      })
    })
  })

const cancelSlotWaiter = (state: SchedulerState, waiter: SlotWaiter) =>
  Effect.suspend(() => {
    if (!waiter.granted) {
      return Effect.sync(() => removeWaiter(state.children.waiters, waiter))
    }
    return Effect.sync(() => {
      waiter.cancelled = true
      releaseSlot(state, waiter)
      pumpSlots(state)
    })
  })

interface AwaitGrantOptions {
  readonly timeoutMs?: number
  readonly pump: (nowMs: number) => void
  readonly onCancel: Effect.Effect<void>
  readonly timeout: SchedulerTimeout
}

/**
 * Wait for a grant. Interruption aborts the wait and runs the caller's
 * cancellation cleanup. While queued, the loop wakes once per second and runs
 * the pump again, so a penalty that expires or a cap that changed without a
 * release still eventually admits the waiter.
 */
const awaitGrant = (
  waiter: { readonly grant: Deferred.Deferred<void>; granted: boolean; cancelled: boolean },
  options: AwaitGrantOptions,
) =>
  Effect.gen(function* () {
    const deadline = options.timeoutMs === undefined ? undefined : (yield* Clock.currentTimeMillis) + options.timeoutMs
    while (!waiter.granted && !waiter.cancelled) {
      const nowMs = yield* Clock.currentTimeMillis
      if (deadline !== undefined && nowMs >= deadline) {
        yield* options.onCancel
        return yield* Effect.fail(options.timeout)
      }
      const tickMs = deadline === undefined ? 1000 : Math.max(1, Math.min(1000, deadline - nowMs))
      yield* Effect.race(
        Deferred.await(waiter.grant).pipe(Effect.as(true)),
        Effect.sleep(Duration.millis(tickMs)).pipe(Effect.as(false)),
      )
      const afterMs = yield* Clock.currentTimeMillis
      yield* Effect.sync(() => options.pump(afterMs))
    }
  })

const refresh = (state: SchedulerState, readLimits: () => Effect.Effect<SchedulerLimits>) =>
  Effect.gen(function* () {
    const limits = yield* readLimits()
    yield* Effect.sync(() => {
      state.limits = limits
    })
  })

const acquireRequest = (state: SchedulerState, input: RequestInput, options?: RequestOptions) =>
  Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis
    const immediate = yield* Effect.sync(() => {
      if (!canRequest(state, input, nowMs)) return false
      grantRequest(state, input)
      return true
    })
    if (immediate) return requestPermit(state, input)

    const grant = yield* Deferred.make<void>()
    const waiter: RequestWaiter = { ...input, grant, granted: false, cancelled: false }
    yield* Effect.sync(() => {
      state.requests.waiters.push(waiter)
      // A release between the failed check above and this insertion pumped
      // without seeing this waiter; pump once more so it is not stranded.
      pumpRequests(state, nowMs)
    })
    if (waiter.granted) return requestPermit(state, input)
    return yield* awaitGrant(waiter, {
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      pump: (at) => pumpRequests(state, at),
      onCancel: cancelRequestWaiter(state, waiter),
      timeout: new SchedulerTimeout({
        wait: "model stream",
        subject: `${input.providerID}/${input.modelID}`,
        waitMs: options?.timeoutMs ?? 0,
      }),
    }).pipe(
      Effect.onInterrupt(() => cancelRequestWaiter(state, waiter)),
      Effect.as(requestPermit(state, input)),
    )
  })

const acquireSlot = (state: SchedulerState, limit: LimitKey, cap: number, options?: ChildSlotOptions) =>
  Effect.gen(function* () {
    const rootSessionID =
      options?.rootSessionID ?? (limit.kind === "workflow" ? limit.workflowID : limit.parentSessionID)
    const subject = limit.kind === "workflow" ? limit.workflowID : limit.parentSessionID
    if (limit.kind === "workflow") {
      const effective = effectiveWorkflowCap(state.limits, cap)
      if (cap > effective && state.children.warnedCaps.get(limit.workflowID) !== effective) {
        yield* Effect.sync(() => state.children.warnedCaps.set(limit.workflowID, effective))
        yield* Effect.logWarning("workflow concurrency truncated to the child pool", {
          workflowID: limit.workflowID,
          requested: cap,
          effective,
        })
      }
    }
    const immediate = yield* Effect.sync(() => {
      if (!slotAdmissible(state, limit, cap)) return false
      grantSlot(state, { limit, cap, rootSessionID })
      return true
    })
    if (immediate) return slotPermit(state, { limit, cap, rootSessionID })

    const grant = yield* Deferred.make<void>()
    const waiter: SlotWaiter = { limit, cap, rootSessionID, grant, granted: false, cancelled: false }
    yield* Effect.sync(() => {
      state.children.waiters.push(waiter)
      pumpSlots(state)
    })
    if (waiter.granted) return slotPermit(state, waiter)
    return yield* awaitGrant(waiter, {
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      pump: () => pumpSlots(state),
      onCancel: cancelSlotWaiter(state, waiter),
      timeout: new SchedulerTimeout({
        wait: limit.kind === "workflow" ? "workflow child slot" : "task child slot",
        subject,
        waitMs: options?.timeoutMs ?? 0,
      }),
    }).pipe(
      Effect.onInterrupt(() => cancelSlotWaiter(state, waiter)),
      Effect.as(slotPermit(state, waiter)),
    )
  })

const laneQueued = (state: SchedulerState): Record<Lane, number> => {
  const queued: Record<Lane, number> = {
    interactive: 0,
    side: 0,
    parent_wake: 0,
    child: 0,
    background: 0,
    auxiliary: 0,
  }
  for (const waiter of state.requests.waiters) {
    if (waiter.cancelled || waiter.granted) continue
    queued[waiter.lane] += 1
  }
  return queued
}

const providerSnapshot = (state: SchedulerState): CapacitySnapshot["providers"] => {
  const providers = new Set<string>(state.requests.byProvider.keys())
  for (const key of state.requests.penalizedUntil.keys()) {
    const separator = key.indexOf("\u0000")
    if (separator >= 0) providers.add(key.slice(0, separator))
  }
  const snapshot: CapacitySnapshot["providers"] = {}
  for (const providerID of providers) {
    let penalizedUntil: number | undefined
    for (const [key, until] of state.requests.penalizedUntil) {
      if (!key.startsWith(`${providerID}\u0000`)) continue
      penalizedUntil = penalizedUntil === undefined ? until : Math.max(penalizedUntil, until)
    }
    snapshot[providerID] = {
      inflight: state.requests.byProvider.get(providerID) ?? 0,
      cap: state.limits.perProvider,
      ...(penalizedUntil !== undefined ? { penalizedUntil } : {}),
    }
  }
  return snapshot
}

const capacity = (state: SchedulerState, limit?: LimitKey): CapacitySnapshot => {
  const limitSnapshot =
    limit === undefined
      ? undefined
      : limit.kind === "workflow"
        ? {
            key: limit,
            used: state.children.byWorkflow.get(limit.workflowID) ?? 0,
            cap: state.children.workflowCaps.get(limit.workflowID) ?? 0,
          }
        : {
            key: limit,
            used: state.children.byTaskParent.get(limit.parentSessionID) ?? 0,
            cap: state.children.taskCaps.get(limit.parentSessionID) ?? 0,
          }
  return {
    children: {
      running: state.children.inflight,
      cap: state.limits.childGlobal,
      dagRunning: state.children.dagGlobal,
      dagCap: childCaps(state.limits).dagLayer,
    },
    requests: { inflight: state.requests.inflight, cap: state.limits.global },
    providers: providerSnapshot(state),
    laneQueued: laneQueued(state),
    ...(limitSnapshot !== undefined ? { limit: limitSnapshot } : {}),
  }
}

/**
 * Build the scheduler over one state object. `readLimits` runs before every
 * acquisition; releases and pumps use the limits last observed there.
 */
export const make = (
  state: SchedulerState,
  readLimits: () => Effect.Effect<SchedulerLimits> = () => Effect.succeed(state.limits),
): Interface => ({
  request: (input, options) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        yield* refresh(state, readLimits)
        const permit = yield* acquireRequest(state, input, options)
        yield* armStagger(state, input)
        return permit
      }),
      (permit) => permit.release,
      { interruptible: true },
    ),
  tryRequest: (input) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        yield* refresh(state, readLimits)
        const nowMs = yield* Clock.currentTimeMillis
        // No cache-group accounting here: its only caller is the background
        // reasoning rewrite, which never joins a sibling cache group.
        const granted = yield* Effect.sync(() => {
          if (!canRequest(state, input, nowMs)) return false
          grantRequest(state, input)
          return true
        })
        return granted ? Option.some(requestPermit(state, input)) : Option.none<Permit>()
      }),
      (permit) => (Option.isSome(permit) ? permit.value.release : Effect.void),
    ),
  prime: (cacheGroup) => primeGroup(state, cacheGroup),
  childSlot: (limit, cap, options) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        yield* refresh(state, readLimits)
        return yield* acquireSlot(state, limit, cap, options)
      }),
      (permit) => permit.release,
      { interruptible: true },
    ),
  penalize: (providerID, modelID, retryAfterMs) =>
    Effect.gen(function* () {
      if (retryAfterMs <= 0) return
      const nowMs = yield* Clock.currentTimeMillis
      yield* Effect.sync(() => {
        const key = modelKey(providerID, modelID)
        const until = nowMs + retryAfterMs
        const current = state.requests.penalizedUntil.get(key) ?? 0
        if (until > current) state.requests.penalizedUntil.set(key, until)
      })
    }),
  capacity: (limit) =>
    Effect.gen(function* () {
      // Refresh lazily so the snapshot reports configured caps even before the
      // first acquisition; the live layer must not read config while building
      // (that context has no observability logger and would leak to stdout).
      yield* refresh(state, readLimits)
      return capacity(state, limit)
    }),
  limits: () => refresh(state, readLimits).pipe(Effect.map(() => state.limits)),
})

const liveLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Capture the config service at layer construction: the pool is
    // process-wide, so it reads the global layer only — a project file must
    // not resize the budget for every other directory sharing this process,
    // and a changed global file is observed without rebuilding the instance.
    // `dag.concurrency` is already stripped from project files.
    const config = yield* Config.Service
    const readLimits = Effect.gen(function* () {
      const info = yield* config.getGlobal()
      return {
        global: info.engine?.concurrency?.global ?? DEFAULT_LIMITS.global,
        perProvider: info.engine?.concurrency?.perProvider ?? DEFAULT_LIMITS.perProvider,
        childGlobal: info.engine?.concurrency?.childGlobal ?? DEFAULT_LIMITS.childGlobal,
        taskReserve: info.engine?.concurrency?.taskReserve ?? DEFAULT_LIMITS.taskReserve,
        dagConcurrency: info.dag?.concurrency ?? DEFAULT_LIMITS.dagConcurrency,
      }
    })
    return make(EngineProcess.scheduler, () => readLimits)
  }),
)

/**
 * The process-level scheduler service. Limits are re-read on every
 * acquisition. Config is provided here so the layer composes as a mergeAll
 * sibling of Config.defaultLayer without requiring an ambient Config.
 */
export const defaultLayer = Layer.suspend(() => liveLayer.pipe(Layer.provide(Config.defaultLayer)))

export const node = LayerNode.make(liveLayer, [Config.node])

export { DEFAULT_LIMITS }
