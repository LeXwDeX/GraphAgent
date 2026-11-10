// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as SessionInbox from "./inbox"

/**
 * The single port for automatic input entering a session (Issue #1021, PR1).
 *
 * Before this module, every automatic-input mechanism subscribed to idle on
 * its own and re-implemented its own gating. PR1 freezes the contract and
 * moves `goal.continue` in:
 *
 * - one idle subscription per loaded instance, all automatic input drains
 *   through the registered sources;
 * - per-session serial drains, where a nudge that arrives mid-drain coalesces
 *   into exactly one re-run after the current one;
 * - a per-instance 30s tick that re-reads durable ledgers so a missed nudge
 *   (or a false-negative `hint`) cannot strand an item forever;
 * - a process-level nudge route: callers only know a session, the inbox finds
 *   the loaded instance that owns the session's directory.
 *
 * `submit` is part of the frozen port but its admission wiring (Turns.start)
 * lands with PR4. Until then it reports the item as not wired instead of
 * accepting and silently dropping it. `turn_boundary` has no implementation
 * yet and reports `UnsupportedDeliveryPolicy`; PR4 decides whether it is still
 * needed once join-or-start covers the same sources.
 */

import { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Cause, Context, Duration, Effect, Layer, Option, Schema, Scope, Stream } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import { DagLocation } from "@/dag/location"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EngineProcess, type InboxDrainRoute } from "./engine-process"
import { SessionLocation } from "./location"
import { MessageID, SessionID } from "./schema"
import { SessionStatus } from "./status"

/**
 * How an automatic input may enter a session.
 *
 * - `idle_only`: deliver only from an idle boundary; never joins a running
 *   turn (goal.continue, dag.delivery).
 * - `join_or_start`: join the running turn, or start one when idle
 *   (hook.rewake, watch_pr, child.result).
 * - `turn_boundary`: hold the item until the current turn ends. Declared so
 *   the policy vocabulary is frozen; not wired in PR1.
 */
export type DeliveryPolicy = "idle_only" | "join_or_start" | "turn_boundary"

export type InboxSourceID =
  | "child.result"
  | "dag.delivery"
  | "dag.mailbox.step"
  | "hook.followup"
  | "hook.rewake"
  | "hook.async_context"
  | "goal.continue"
  | "watch_pr"

/**
 * What happened to one submitted item. `pending` means the item is queued for
 * a later boundary and has no user message yet; an admitted item names the
 * message and when it was created; `skipped_busy` means the policy refused
 * this boundary.
 */
export type Admission =
  | { readonly state: "pending" }
  | { readonly state: "started"; readonly messageID: MessageID; readonly createdAt: number }
  | { readonly state: "joined"; readonly messageID: MessageID; readonly createdAt: number }
  | { readonly state: "skipped_busy" }

/** One deliverable item. Sources own the payload the admission port persists. */
export interface InboxItem {
  /** Stable identity of this delivery; the same key yields at most one user message. */
  readonly idempotencyKey?: string
  /** Write the user message without starting a turn (watch_pr outcome notices). */
  readonly noReply?: boolean
}

/**
 * How a source keeps its durable ledger in step with admission. Sources
 * without a ledger deliver through `submit` and confirm at admission time.
 */
export interface InboxLedger {
  /** Derive the stable key of one item for duplicate suppression. */
  readonly idempotencyKey: (item: InboxItem) => string
  /** Who confirms the entry: the admission transaction (#321) or an associate step. */
  readonly confirm: "admission" | "associate"
  /** Confirm inside the admission transaction instead of after it. */
  readonly onAdmit?: boolean
}

/** Ambient facts a source may use while scanning or claiming. */
export interface InboxSourceContext {
  readonly directory: string
}

export interface InboxSource {
  readonly id: InboxSourceID
  /** Lower runs first; the first successful claim ends the drain. */
  readonly priority: number
  readonly mode: DeliveryPolicy
  /** Only goal-class claims stay exclusive against DAG registration (PR2). */
  readonly exclusiveClass?: "goal"
  /** Only goal.continue yields to a newer user message (GOAL-FP-01-02). */
  readonly preemptGuard?: boolean
  readonly ledger?: InboxLedger
  /**
   * Cheap in-memory check, allowed to be a false positive. A true hint runs
   * `claim`; a false hint skips this boundary and leaves correction to the
   * tick.
   */
  readonly hint: (sessionID: SessionID) => boolean
  /** Durable backstop for sources whose items can outlive a missed nudge. */
  readonly scan?: (ctx: InboxSourceContext) => Effect.Effect<ReadonlyArray<SessionID>, unknown>
  /**
   * Take (or begin) one delivery for the session. `true` means this boundary
   * consumed the claim; `false` means nothing was deliverable.
   */
  readonly claim: (sessionID: SessionID, ctx: InboxSourceContext) => Effect.Effect<boolean, unknown, Scope.Scope>
}

export class InboxNotWired extends Schema.TaggedError<InboxNotWired>()("SessionInboxNotWired", {
  source: Schema.String,
}) {
  override get message() {
    return `Session inbox source "${this.source}" is not wired to the admission port yet`
  }
}

export class UnsupportedDeliveryPolicy extends Schema.TaggedError<UnsupportedDeliveryPolicy>()(
  "SessionInboxUnsupportedDeliveryPolicy",
  {
    policy: Schema.String,
  },
) {
  override get message() {
    return `Session inbox delivery policy "${this.policy}" is not supported yet`
  }
}

export interface Interface {
  /** Resolve this instance's route, arm the tick, and register with the process. */
  readonly init: () => Effect.Effect<void>
  /** Add one source to this instance's drain set; a later registration for the same id replaces it. */
  readonly register: (source: InboxSource) => Effect.Effect<void>
  /** Drain one session in the calling instance. */
  readonly drain: (sessionID: SessionID) => Effect.Effect<void>
  /** Process-level route: drain the loaded instance that owns the session's directory. */
  readonly nudge: (sessionID: SessionID) => Effect.Effect<void>
  /** Admission port for ledger-less sources (PR4). Reports an explicit error until wired. */
  readonly submit: (
    sourceID: InboxSourceID,
    sessionID: SessionID,
    item: InboxItem,
  ) => Effect.Effect<Admission, InboxNotWired | UnsupportedDeliveryPolicy>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/SessionInbox") {}

interface InstanceData {
  readonly directory: string
  readonly scope: Scope.Scope
  readonly sources: Map<InboxSourceID, InboxSource>
  readonly mutex: KeyedMutex.KeyedMutex<SessionID>
  /** Sessions with a drain running; `again` coalesces nudges into one re-run. */
  readonly inFlight: Map<SessionID, { again: boolean }>
  /** Registered with the process-level nudge router by `init`. */
  route: InboxDrainRoute | undefined
  started: boolean
}

type ScannableSource = InboxSource & { readonly scan: NonNullable<InboxSource["scan"]> }

const hasScan = (source: InboxSource): source is ScannableSource => source.scan !== undefined

const byPriority = (a: InboxSource, b: InboxSource) => a.priority - b.priority

const TICK_INTERVAL = Duration.seconds(30)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    // The exclusive registry's dag-release re-trigger uses this instance's
    // status map for its idle gate (Issue #1021, PR2).
    const status = yield* SessionStatus.Service
    // The service graph this inbox was built in. A nudge can arrive from a
    // process-level caller in another layer graph; re-entering the owning
    // instance must resolve services the drain's sources use (for example an
    // injected judge) against this graph, not the caller's context.
    const buildContext = yield* Effect.context<never>()

    // One claim sequence. Sources run in priority order and the first
    // successful claim ends the drain: a second source must observe the
    // session's new state at the next boundary (or tick), never race the
    // first delivery into the same boundary. A forced pass (tick) skips the
    // in-memory hint because the durable scan already proved the item exists;
    // the hint may be a false negative after a restart.
    const claimAll = (
      data: InstanceData,
      sessionID: SessionID,
      force = false,
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        const sources = [...data.sources.values()].sort(byPriority)
        for (const source of sources) {
          if (!force && !source.hint(sessionID)) continue
          const claimed = yield* source.claim(sessionID, { directory: data.directory }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.succeed(false)
                : Effect.logWarning("session inbox claim failed", {
                    source: source.id,
                    sessionID,
                    cause: Cause.pretty(cause),
                  }).pipe(Effect.as(false)),
            ),
          )
          if (claimed) return
        }
      })

    // Per-session serial drain with nudge coalescing: while one drain holds
    // the session, every additional nudge only asks for one more pass.
    const drainFor = (data: InstanceData, sessionID: SessionID, force = false): Effect.Effect<void> =>
      Effect.gen(function* () {
        const active = data.inFlight.get(sessionID)
        if (active) {
          active.again = true
          return
        }
        const token = { again: false }
        data.inFlight.set(sessionID, token)
        yield* data.mutex
          .withLock(sessionID)(
            Effect.gen(function* () {
              do {
                token.again = false
                // Claim forks (goal evaluation) live on the instance scope,
                // not on a nudge caller's short-lived scope.
                yield* claimAll(data, sessionID, force).pipe(Scope.provide(data.scope))
              } while (token.again)
            }),
          )
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (data.inFlight.get(sessionID) === token) data.inFlight.delete(sessionID)
              }),
            ),
          )
      })

    const tickSource = (data: InstanceData, source: ScannableSource): Effect.Effect<void> =>
      Effect.gen(function* () {
        const sessionIDs = yield* source.scan({ directory: data.directory }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.succeed([] as ReadonlyArray<SessionID>)
              : Effect.logWarning("session inbox scan failed", {
                  source: source.id,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as([] as ReadonlyArray<SessionID>)),
          ),
        )
        for (const sessionID of sessionIDs) {
          // Forced: the durable scan is the authority, so a stale in-memory
          // hint must not hide the item from this backstop pass.
          yield* drainFor(data, sessionID, true).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.void
                : Effect.logWarning("session inbox tick drain failed", {
                    source: source.id,
                    sessionID,
                    cause: Cause.pretty(cause),
                  }),
            ),
          )
        }
      })

    // The first pass runs one interval after the instance is ready so the
    // registration order (sources register before or during init) cannot hide
    // a source from a tick that fired at build time.
    const tick = (data: InstanceData): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(TICK_INTERVAL)
          yield* Effect.forEach([...data.sources.values()].filter(hasScan).sort(byPriority), (source) =>
            tickSource(data, source),
          ).pipe(Effect.asVoid)
        }
      })

    const state = yield* InstanceState.make(
      Effect.fn("SessionInbox.state")(function* (ctx: InstanceContext) {
        const scope = yield* Scope.Scope
        const data: InstanceData = {
          directory: ctx.directory,
          scope,
          sources: new Map(),
          mutex: KeyedMutex.makeUnsafe<SessionID>(),
          inFlight: new Map(),
          route: undefined,
          started: false,
        }
        // Whatever path registered a source, the process router must stop
        // pointing at this instance when its scope closes.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (data.route) EngineProcess.inbox.drains.delete(data.route)
          }),
        )
        // PR2: the exclusive registry re-triggers a dag-blocked goal through
        // this process router. Register the route as soon as the instance's
        // inbox state exists — a blocked claim can only be recorded by a
        // source in this instance, so the route must already be reachable
        // without waiting for bootstrap's explicit `init`. The route keeps
        // the generation it was created in and re-enters this instance's
        // services explicitly.
        const generation = yield* InstanceState.currentGeneration
        const route: InboxDrainRoute = {
          directory: DagLocation.canonicalDirectory(ctx.directory),
          // A nudge can arrive from any layer graph in the process: re-enter
          // the owning instance explicitly — its captured service graph plus
          // its instance ref and generation — instead of inheriting the
          // caller's context.
          drain: (sessionID) =>
            drainFor(data, SessionID.make(sessionID)).pipe(
              Effect.provideContext(
                Context.add(InstanceState.contextWithGeneration(generation, buildContext), InstanceRef, ctx),
              ),
            ),
        }
        data.route = route
        EngineProcess.inbox.drains.add(route)
        // Invariant 1: exactly one SessionStatus subscription per instance.
        // Idle Status events are store-global; sources check ownership in
        // their claim (goal.continue uses Goal.ownsSession).
        yield* events.subscribe(SessionStatus.Event.Status).pipe(
          Stream.filter((evt) => evt.data.status.type === "idle"),
          Stream.runForEach((evt) =>
            drainFor(data, evt.data.sessionID).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.void
                  : Effect.logWarning("session inbox idle drain failed", {
                      sessionID: evt.data.sessionID,
                      cause: Cause.pretty(cause),
                    }),
              ),
            ),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )
        return data
      }),
    )

    const register = Effect.fn("SessionInbox.register")(function* (source: InboxSource) {
      const data = yield* InstanceState.get(state)
      data.sources.set(source.id, source)
    })

    const drain = Effect.fn("SessionInbox.drain")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      yield* drainFor(data, sessionID)
    })

    const nudge = Effect.fn("SessionInbox.nudge")(function* (sessionID: SessionID) {
      // The durable session row is the authority when present; sessions
      // without one (synthetic callers) fall back to the ambient instance.
      const durable = yield* SessionLocation.sessionDirectory(sessionID)
      const ambient = yield* InstanceRef
      const directory = Option.isSome(durable) ? durable.value : ambient?.directory
      if (!directory) {
        yield* Effect.logDebug("session inbox nudge has no directory", { sessionID })
        return
      }
      const location = DagLocation.canonicalDirectory(directory)
      const routes = [...EngineProcess.inbox.drains].filter((route) => route.directory === location)
      if (routes.length === 0) {
        // No loaded instance owns the directory right now. The instance tick
        // re-reads durable ledgers when it loads, so a missed nudge does not
        // lose the item.
        yield* Effect.logDebug("session inbox nudge has no loaded instance", { sessionID, directory: location })
        return
      }
      yield* Effect.forEach(
        routes,
        (route) =>
          route.drain(sessionID).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.void
                : Effect.logWarning("session inbox nudge drain failed", {
                    sessionID,
                    cause: Cause.pretty(cause),
                  }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      )
    })

    // Issue #1021 PR2: the exclusive registry owns Goal/DAG arbitration, but
    // the re-trigger itself now travels through this inbox instead of a
    // synthetic idle status. The idle gate preserves the old lease behavior:
    // the final dag unregister of a wake delivery lands mid-turn at admit
    // time, where the in-flight turn's own end-of-turn idle re-drives the
    // goal; nudging here would evaluate mid-turn (wasted judge call).
    const goalReleaseNudge = (sessionID: SessionID) =>
      status.get(sessionID).pipe(Effect.flatMap((info) => (info.type === "idle" ? nudge(sessionID) : Effect.void)))
    // The hook slot holds one inbox per process. Keep the hook that was
    // installed before this build so closing this layer restores it instead of
    // stranding a sibling instance that is still open (Issue #1021, PR2).
    const previousNudge = EngineProcess.inbox.nudge
    EngineProcess.inbox.nudge = goalReleaseNudge
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (EngineProcess.inbox.nudge === goalReleaseNudge) EngineProcess.inbox.nudge = previousNudge
      }),
    )

    const init = Effect.fn("SessionInbox.init")(function* () {
      const data = yield* InstanceState.get(state)
      if (data.started) return
      data.started = true
      // The process route is installed by the state builder (PR2); init only
      // arms the durable tick once per instance.
      yield* tick(data).pipe(Effect.forkIn(data.scope))
    })

    const submit = Effect.fn("SessionInbox.submit")(function* (
      sourceID: InboxSourceID,
      sessionID: SessionID,
      item: InboxItem,
    ) {
      const data = yield* InstanceState.get(state)
      const source = data.sources.get(sourceID)
      if (!source) return yield* new InboxNotWired({ source: sourceID })
      if (source.mode === "turn_boundary") return yield* new UnsupportedDeliveryPolicy({ policy: source.mode })
      // PR4 calls Turns.start (origin kind "inbox") here and maps the admission
      // to `Admission`; ledger-less sources confirm on the returned admission.
      yield* Effect.logDebug("session inbox submit is not wired yet", {
        source: sourceID,
        sessionID,
        noReply: item.noReply === true,
      })
      return yield* new InboxNotWired({ source: sourceID })
    })

    return Service.of({ init, register, drain, nudge, submit })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provide(SessionStatus.defaultLayer)),
)

export const node = LayerNode.make(layer, [EventV2Bridge.node, SessionStatus.node])
