// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { SessionAdmission } from "@graphagent/core/session/admission"
import { Cause, Context, Effect, Layer, Option, type Deferred, type Scope } from "effect"
import { makeSessionRuntimes, type SessionRuntimes } from "./runtime"
import { SessionID } from "./schema"

/**
 * Process-wide engine state (Issue #1019, PR9).
 *
 * One process composes several ManagedRuntime layer graphs: `app-runtime.ts`,
 * `bootstrap-runtime.ts` and every runtime created by `run-service.ts`. Cancel
 * admission, cancellation epochs, abort reasons, the inbox routes and the
 * per-session caches must be shared by all of them, so this module owns the
 * only mutable process-level registry. Other modules may not define
 * module-level mutable Maps or Sets; they read the state below instead. The
 * exclusive automation registry is deliberately not process-level: each layer
 * build creates its own state and separate builds coordinate through the inbox
 * nudge hook.
 *
 * The object is intentionally the single addition point.
 */

export interface CancellationOwner {
  readonly epoch: number
  readonly directory?: string
  readonly snapshot: () => Effect.Effect<void>
}

export interface CancellationSession {
  epoch: number
  requests: number
  aborts: number
  goalCancels: number
  goalReleased?: Deferred.Deferred<void>
  owners: Set<CancellationOwner>
  barrier?: Effect.Effect<void>
}

export interface CancellationState {
  readonly sessions: Map<string, CancellationSession>
  readonly epochs: Map<string, number>
  /** Publication is innermost: never wait for a cancel decision while holding it. */
  readonly publication: KeyedMutex.KeyedMutex<string>
  /** The admission registry must be shared by every layer graph in this process. */
  readonly admissions: ReturnType<typeof SessionAdmission.make>
}

/** Runtime-initiated abort reasons, remembered until the interrupted turn finalizes its durable error. */
export interface AbortReasonState {
  readonly pending: Map<string, { readonly reason: string; readonly actor: string }>
}

/**
 * One loaded instance's inbox drain (Issue #1021, PR1). The inbox registers a
 * route when the instance boots and removes it from the instance scope, so a
 * process-level nudge can reach the instance that owns a session's directory
 * even when the caller lives in another layer graph.
 */
export interface InboxDrainRoute {
  readonly directory: string
  readonly drain: (sessionID: string) => Effect.Effect<void>
}

/** Session-inbox routing shared by every layer graph in the process. */
export interface InboxRouting {
  readonly drains: Set<InboxDrainRoute>
  /**
   * Installed by the session inbox (Issue #1021, PR2). The exclusive registry
   * calls it when the final DAG owner releases a session whose goal claim was
   * blocked; it replaces the old lease's synthetic `set idle` re-trigger with
   * the unified nudge route. The inbox installs the idle gate on its side so
   * a mid-turn release leaves the retry to the turn-end idle, exactly like the
   * old lease.
   */
  nudge?: (sessionID: SessionID) => Effect.Effect<void>
}

/** One session's exclusive automation ownership. */
export interface ExclusiveEntry {
  readonly goals: Set<string>
  readonly dags: Set<string>
  generation: number
}

export type GoalAuthority = (sessionID: SessionID) => Effect.Effect<string | undefined>

/**
 * Automation ownership state for one built service graph (Issue #1021, PR2).
 *
 * Goal and DAG register their active identities here; a DAG registration
 * gives the DAG priority while any workflow id remains. A claim carries the
 * ownership generation and any registration change bumps it, so a claim taken
 * before a competing registration cannot commit afterwards. `blockedGoalClaims`
 * records that a goal evaluation yielded to a DAG, which the final release
 * consumes to nudge the goal exactly once.
 */
export interface ExclusiveState {
  readonly sessions: Map<SessionID, ExclusiveEntry>
  /** Sessions whose goal claim a DAG rejected; consumed by the final release. */
  readonly blockedGoalClaims: Set<SessionID>
  /** Never reused: an old token must not become valid again. */
  generation: number
  goalAuthority?: { readonly resolve: GoalAuthority; users: number }
  readonly lock: KeyedMutex.KeyedMutex<SessionID>
}

export interface ExclusiveOwner {
  readonly kind: "goal" | "dag"
  readonly id: string
}

export interface ExclusiveToken {
  readonly sessionID: SessionID
  readonly owner: ExclusiveOwner
  readonly generation: number
}

export interface ExclusiveAfterFence<A, E = never, R = never> {
  readonly activate: Effect.Effect<void>
  readonly result: Effect.Effect<A, E, R>
  readonly abort: Effect.Effect<void>
}

export type ExclusiveRequest = { readonly kind: "goal"; readonly id: string } | { readonly kind: "dag" }

export interface ExclusiveRegistryInterface {
  /** Installed by the shared Goal layer for its lifetime; reads its shared durable store. */
  readonly installGoalAuthority: (resolve: GoalAuthority) => Effect.Effect<void, never, Scope.Scope>
  readonly register: (sessionID: SessionID, owner: ExclusiveOwner) => Effect.Effect<void>
  readonly unregister: (sessionID: SessionID, owner: ExclusiveOwner) => Effect.Effect<void>
  readonly claim: (sessionID: SessionID, request: ExclusiveRequest) => Effect.Effect<Option.Option<ExclusiveToken>>
  readonly use: <A, E, R>(
    token: ExclusiveToken,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>
  readonly handoff: <A, E, R, E2, R2>(
    token: ExclusiveToken,
    prepare: Effect.Effect<Option.Option<ExclusiveAfterFence<A, E, R>>, E2, R2>,
  ) => Effect.Effect<Option.Option<Effect.Effect<A, E, R>>, E2, R2>
  /** Drop every registration and retry obligation for a session (session deletion). */
  readonly purgeSession: (sessionID: SessionID) => Effect.Effect<void>
  /** Current ownership generation (0 when the session has no entry). */
  readonly generation: (sessionID: SessionID) => Effect.Effect<number>
  /**
   * True when `generation` still describes the DAG owner. An admission that
   * reads a false value after claiming must not commit (StaleExclusive).
   */
  readonly validate: (sessionID: SessionID, generation: number) => Effect.Effect<boolean>
}

/** Exclusive automation ownership (H2). */
export class Service extends Context.Service<Service, ExclusiveRegistryInterface>()("@graphagent/ExclusiveRegistry") {}

// Keep the former lease-era namespace shape (Issue #1021, PR2):
// the registry owns the same token vocabulary and is reached as
// `ExclusiveRegistry.Service` / `.layer` / `.node` while the remaining
// delivery sources migrate (PR3/PR4). The tag class cannot itself be named
// `ExclusiveRegistry`: merging a namespace member named `Service` would
// collide with the tag class's static `Service` shape declaration.
const ServiceTag = Service
type ServiceInstance = Service

export namespace ExclusiveRegistry {
  export const Service = ServiceTag
  export type Service = ServiceInstance
  export type Owner = ExclusiveOwner
  export type Token = ExclusiveToken
  export type Request = ExclusiveRequest
  export type AfterFence<A, E = never, R = never> = ExclusiveAfterFence<A, E, R>
  export type Interface = ExclusiveRegistryInterface
}

export interface EngineProcess {
  readonly runtimes: SessionRuntimes
  readonly cancellation: CancellationState
  readonly abort: AbortReasonState
  /** Sessions opened by the in-process client, used only to end their local hooks on shutdown. */
  readonly clientSessions: Map<string, string>
  readonly inbox: InboxRouting
}

export const EngineProcess: EngineProcess = {
  runtimes: makeSessionRuntimes(),
  cancellation: {
    sessions: new Map(),
    epochs: new Map(),
    publication: KeyedMutex.makeUnsafe<string>(),
    admissions: SessionAdmission.make(),
  },
  abort: {
    pending: new Map(),
  },
  clientSessions: new Map<string, string>(),
  inbox: {
    drains: new Set(),
  },
}

const entry = (state: ExclusiveState, sessionID: SessionID) => {
  const current = state.sessions.get(sessionID)
  if (current) return current
  const created = { goals: new Set<string>(), dags: new Set<string>(), generation: 0 }
  state.sessions.set(sessionID, created)
  return created
}

const owner = (state: ExclusiveState, sessionID: SessionID): ExclusiveOwner | undefined => {
  const current = state.sessions.get(sessionID)
  const dag = current?.dags.values().next().value
  if (dag) return { kind: "dag", id: dag }
  const goal = current?.goals.values().next().value
  if (goal) return { kind: "goal", id: goal }
  return undefined
}

// Called only while holding this session's lock. A durable transition may
// finish before a delayed register/unregister reaches us; its arguments are
// observations, so the current active row is the goal owner authority. Read
// errors propagate before touching registrations (fail closed).
const reconcileGoal = Effect.fnUntraced(function* (state: ExclusiveState, sessionID: SessionID) {
  const authority = state.goalAuthority
  if (!authority) return false
  const id = yield* authority.resolve(sessionID)
  if (state.goalAuthority !== authority) return true
  const current = state.sessions.get(sessionID)
  if (id === undefined && (!current || current.goals.size === 0)) return true
  if (id !== undefined && current?.goals.size === 1 && current.goals.has(id)) return true
  const next = current ?? entry(state, sessionID)
  next.goals.clear()
  if (id !== undefined) next.goals.add(id)
  next.generation = ++state.generation
  if (next.goals.size === 0 && next.dags.size === 0) state.sessions.delete(sessionID)
  return true
})

const installGoalAuthority = Effect.fn("ExclusiveRegistry.installGoalAuthority")(function* (
  state: ExclusiveState,
  resolve: GoalAuthority,
) {
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      if (state.goalAuthority && state.goalAuthority.resolve !== resolve)
        throw new Error("ExclusiveRegistry already has a different Goal authority")
      if (state.goalAuthority) state.goalAuthority.users += 1
      else state.goalAuthority = { resolve, users: 1 }
    }),
    () =>
      Effect.sync(() => {
        if (!state.goalAuthority || state.goalAuthority.resolve !== resolve || --state.goalAuthority.users > 0) return
        state.goalAuthority = undefined
        // The shared Goal scope has closed: do not retain its DB closure or
        // goal registrations in a registry whose DAG scope outlives it.
        for (const [sessionID, current] of state.sessions) {
          if (current.goals.size === 0) continue
          current.goals.clear()
          current.generation = ++state.generation
          state.blockedGoalClaims.delete(sessionID)
          if (current.dags.size === 0) state.sessions.delete(sessionID)
        }
      }),
  )
})

const register = Effect.fn("ExclusiveRegistry.register")(function* (
  state: ExclusiveState,
  sessionID: SessionID,
  value: ExclusiveOwner,
) {
  yield* state.lock.withLock(sessionID)(
    Effect.gen(function* () {
      if (value.kind === "goal" && (yield* reconcileGoal(state, sessionID))) return
      const current = entry(state, sessionID)
      const values = value.kind === "dag" ? current.dags : current.goals
      if (values.has(value.id)) return
      values.add(value.id)
      current.generation = ++state.generation
    }),
  )
})

const unregister = Effect.fn("ExclusiveRegistry.unregister")(function* (
  state: ExclusiveState,
  sessionID: SessionID,
  value: ExclusiveOwner,
) {
  // GOAL-FP-01-02: when the dag ownership actually disappears (owner
  // transitions dag → goal/none), re-trigger the goal evaluation through the
  // session inbox so a goal that yielded to the dag on the last idle event
  // gets a fresh evaluation. This replaces the old lease's synthetic
  // `sessionStatus.set(idle)` (Issue #1021, PR2): the inbox owns the idle
  // subscription and routes the nudge to the instance that owns the session.
  // Since issue #321 the final dag unregister of a wake delivery lands
  // MID-TURN at admit time (the mark moves with it), so the session is busy
  // when the owner flips: the inbox-side idle gate skips the nudge here, and
  // the in-flight wake turn re-emits idle on completion, which re-drives the
  // goal. Without this re-trigger path the goal silently stalls until the
  // next external idle. This is also the GOAL-FP-01-11 mitigation surface: a
  // claim that lost the ownership race gets another chance once the owner
  // actually transfers.
  //
  // The dag-release decision is computed atomically under the per-session
  // lock (compare owner before/after the Set removal, accounting for the
  // generation bump); the nudge itself runs AFTER the lock. Set.delete is
  // idempotent and only the removal of the LAST dag flips the owner, so the
  // nudge cannot duplicate.
  //
  // R1 (GOAL-FP-01-02 follow-up): the re-trigger fires ONLY when a goal claim
  // was actually rejected by the dag (blockedGoalClaims). A rejected claim's
  // evaluation fiber yields at the claim itself, so the retry evaluation it
  // spawns is the only evaluation in flight — the duplicate evaluation that
  // raced the turn-idle fiber (double commit / interrupt between commit and
  // dispatch) is unconstructible. A successful goal claim clears the flag
  // (under the same lock), so a release that a boundary evaluation already
  // picked up does not double-fire.
  const goalRetryDue = yield* state.lock.withLock(sessionID)(
    Effect.gen(function* () {
      const current = state.sessions.get(sessionID)
      const before = owner(state, sessionID)
      if (value.kind === "goal" && (yield* reconcileGoal(state, sessionID))) return false
      if (!current) return false
      const values = value.kind === "dag" ? current.dags : current.goals
      if (!values.delete(value.id)) return false
      current.generation = ++state.generation
      if (current.goals.size === 0 && current.dags.size === 0) state.sessions.delete(sessionID)
      const after = owner(state, sessionID)
      if (before?.kind !== "dag" || after?.kind === "dag") return false
      // Consume the retry obligation: exactly one re-trigger per blocked
      // claim, even when several dags release back-to-back.
      return state.blockedGoalClaims.delete(sessionID)
    }),
  )
  if (!goalRetryDue) return
  const nudge = EngineProcess.inbox.nudge
  if (!nudge) {
    // A process without the inbox layer (unit fixtures) has no re-trigger
    // route; the goal's own next idle boundary still drives it. Never silent.
    yield* Effect.logWarning("exclusive registry released a blocked goal claim without an inbox route", {
      sessionID,
    })
    return
  }
  yield* nudge(sessionID).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.void
        : Effect.logWarning("exclusive registry goal re-trigger failed", {
            sessionID,
            cause: Cause.pretty(cause),
          }),
    ),
  )
})

const claim = Effect.fn("ExclusiveRegistry.claim")(function* (
  state: ExclusiveState,
  sessionID: SessionID,
  request: ExclusiveRequest,
) {
  return yield* state.lock.withLock(sessionID)(
    Effect.gen(function* () {
      yield* reconcileGoal(state, sessionID)
      const current = state.sessions.get(sessionID)
      const selected = owner(state, sessionID)
      if (request.kind === "goal") {
        // Track dag-blocked goal claims: the unregister re-trigger only
        // fires for sessions whose goal evaluation was actually rejected by
        // a dag owner. Any other outcome (success, or a rejection that is
        // not dag-blocking) clears the obligation.
        if (selected?.kind === "dag") state.blockedGoalClaims.add(sessionID)
        else state.blockedGoalClaims.delete(sessionID)
      }
      if (!current || !selected) return Option.none<ExclusiveToken>()
      if (request.kind === "goal" && (selected.kind !== "goal" || selected.id !== request.id))
        return Option.none<ExclusiveToken>()
      if (request.kind === "dag" && selected.kind !== "dag") return Option.none<ExclusiveToken>()
      return Option.some({ sessionID, owner: selected, generation: current.generation })
    }),
  )
})

const use = <A, E, R>(
  state: ExclusiveState,
  token: ExclusiveToken,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, E, R> =>
  state.lock.withLock(token.sessionID)(
    Effect.gen(function* () {
      yield* reconcileGoal(state, token.sessionID)
      const current = state.sessions.get(token.sessionID)
      const selected = owner(state, token.sessionID)
      const valid = !(
        !current ||
        current.generation !== token.generation ||
        selected?.kind !== token.owner.kind ||
        selected.id !== token.owner.id
      )
      if (!valid) return Option.none()
      const result = yield* effect
      yield* reconcileGoal(state, token.sessionID)
      return Option.some(result)
    }),
  )

const handoff = <A, E, R, E2, R2>(
  state: ExclusiveState,
  token: ExclusiveToken,
  prepare: Effect.Effect<Option.Option<ExclusiveAfterFence<A, E, R>>, E2, R2>,
): Effect.Effect<Option.Option<Effect.Effect<A, E, R>>, E2, R2> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const prepared = yield* restore(
        state.lock.withLock(token.sessionID)(
          Effect.gen(function* () {
            yield* reconcileGoal(state, token.sessionID)
            const current = state.sessions.get(token.sessionID)
            const selected = owner(state, token.sessionID)
            if (
              !current ||
              current.generation !== token.generation ||
              selected?.kind !== token.owner.kind ||
              selected.id !== token.owner.id
            )
              return Option.none()
            return yield* prepare
          }),
        ),
      )
      if (Option.isNone(prepared)) return Option.none()
      yield* prepared.value.activate.pipe(Effect.onError(() => prepared.value.abort))
      return Option.some(prepared.value.result)
    }),
  )

// GOAL-FP-01-06: session deletion must drop every registration the session
// holds (goal, dag, and any wake-sweep registration) so the automation
// ownership map cannot keep a deleted session's claim alive until process
// exit. Runs under the per-session lock, same as every other mutation, and
// deliberately does NOT emit the unregister goal re-trigger — the session is
// being deleted, so a goal re-evaluation would be work on a dead session.
const purgeSession = Effect.fn("ExclusiveRegistry.purgeSession")(function* (
  state: ExclusiveState,
  sessionID: SessionID,
) {
  yield* state.lock.withLock(sessionID)(
    Effect.sync(() => {
      state.sessions.delete(sessionID)
      state.blockedGoalClaims.delete(sessionID)
    }),
  )
})

const generation = Effect.fn("ExclusiveRegistry.generation")(function* (state: ExclusiveState, sessionID: SessionID) {
  return yield* state.lock.withLock(sessionID)(
    Effect.gen(function* () {
      yield* reconcileGoal(state, sessionID)
      return state.sessions.get(sessionID)?.generation ?? 0
    }),
  )
})

const validate = Effect.fn("ExclusiveRegistry.validate")(function* (
  state: ExclusiveState,
  sessionID: SessionID,
  expected: number,
) {
  return yield* state.lock.withLock(sessionID)(
    Effect.gen(function* () {
      yield* reconcileGoal(state, sessionID)
      const current = state.sessions.get(sessionID)
      const selected = owner(state, sessionID)
      return current !== undefined && selected?.kind === "dag" && current.generation === expected
    }),
  )
})

const makeState = (): ExclusiveState => ({
  sessions: new Map(),
  blockedGoalClaims: new Set(),
  generation: 0,
  lock: KeyedMutex.makeUnsafe<SessionID>(),
})

// The registry owns per-build state, like the lease it replaces: a test or a
// nested layer graph that builds its own registry must not observe another
// build's registrations, blocked claims, or Goal authority. Cross-build
// coordination goes through the process-level inbox nudge hook.
const make = (state: ExclusiveState): ExclusiveRegistryInterface => ({
  installGoalAuthority: (resolve) => installGoalAuthority(state, resolve),
  register: (sessionID, value) => register(state, sessionID, value),
  unregister: (sessionID, value) => unregister(state, sessionID, value),
  claim: (sessionID, request) => claim(state, sessionID, request),
  use: (token, effect) => use(state, token, effect),
  handoff: (token, prepare) => handoff(state, token, prepare),
  purgeSession: (sessionID) => purgeSession(state, sessionID),
  generation: (sessionID) => generation(state, sessionID),
  validate: (sessionID, expected) => validate(state, sessionID, expected),
})

const registryLayer = Layer.effect(
  ServiceTag,
  Effect.sync(() => make(makeState())),
)
const registryNode = LayerNode.make(registryLayer, [])

export const layer = registryLayer

export const defaultLayer = registryLayer

export const node = registryNode

export namespace ExclusiveRegistry {
  export const layer = registryLayer
  export const defaultLayer = registryLayer
  export const node = registryNode
}
