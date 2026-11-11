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
 * `submit` is the admission port for automatic sources. PR4 wired it to
 * `SessionPrompt.admit`: the message is committed and classified, but the
 * caller never waits for the turn itself. A source with a ledger derives one
 * idempotency key, checks it before admission, and commits it inside the
 * admission transaction; a source without a ledger simply confirms at
 * admission time. `turn_boundary` has no implementation and reports
 * `UnsupportedDeliveryPolicy`; an `idle_only` source cannot skip its boundary
 * through `submit` either.
 *
 * PR3 adds the hint-only step port: a `StepSource` answers whether it may
 * have input at the next model step boundary, without taking ownership of the
 * payload. The turn pipeline keeps `freeze`/`associate` as the only delivery
 * and confirmation path; `pullForStep` is purely advisory and conservative
 * (any "maybe" wins). The full take/commit/abandon transaction is deferred
 * until a consumer actually needs step-level ownership.
 *
 * PR4 registers the built-in `hook.rewake` source (a submit whitelist only:
 * its hint is false and it never claims a drain) and the `hook.async_context`
 * step source. D1's `drainAsync` remains the only async-hook delivery path.
 */

import { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Cause, Context, Duration, Effect, Layer, Option, Schema, Scope, Stream } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import { DagLocation } from "@/dag/location"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionCancellation } from "./cancellation"
import { EngineProcess, type InboxDrainRoute } from "./engine-process"
import { SessionLocation } from "./location"
import { MessageID, SessionID } from "./schema"
import { SessionStatus } from "./status"
import type { AdmissionOptions, PromptInput } from "./prompt"

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
 * message and when it was created; `written` means the message was committed
 * without a turn following it (`noReply`, a declined admission, or a runner
 * that classified the request as busy); `skipped_busy` means the policy refused
 * this boundary before writing anything; `duplicate` means a ledger already
 * held this delivery's key, so nothing was written.
 */
export type Admission =
  | { readonly state: "pending" }
  | { readonly state: "started"; readonly messageID: MessageID; readonly createdAt: number }
  | { readonly state: "joined"; readonly messageID: MessageID; readonly createdAt: number }
  | { readonly state: "written"; readonly messageID: MessageID; readonly createdAt: number }
  | { readonly state: "skipped_busy" }
  | { readonly state: "duplicate" }

/** One deliverable item. Sources own the payload the admission port persists. */
export interface InboxItem {
  /** Write the user message without starting a turn (watch_pr outcome notices). */
  readonly noReply?: boolean
  /** The prompt content the admission port commits; `sessionID` comes from the call. */
  readonly prompt?: Omit<PromptInput, "sessionID">
  /** Admission options riding with the prompt (for example a rewake token). */
  readonly admissionOptions?: AdmissionOptions
}

/** The durable identity of one delivery, derived by the source's ledger. */
export interface LedgerScope {
  readonly source: InboxSourceID
  readonly sessionID: SessionID
  readonly idempotencyKey: string
}

/**
 * How a source keeps its durable ledger in step with admission (Issue #1021).
 * The ledger owns key derivation, so the item carries no second source of
 * truth. A ledger source delivers through `submit`; the admission transaction
 * commits the key atomically with the message, and a failed admission re-checks
 * `seen` to classify a concurrent loser as `duplicate`.
 */
export interface InboxLedger {
  /** Derive the stable key of one item for duplicate suppression. */
  readonly idempotencyKey: (item: InboxItem) => string
  /** Whether this scope's key is already durably committed. */
  readonly seen: (scope: LedgerScope) => Effect.Effect<boolean, unknown>
  /** Commit the key; `submit` runs it inside the admission transaction. */
  readonly commit: (scope: LedgerScope) => Effect.Effect<void, unknown>
}

/** Ambient facts a source may use while scanning or claiming. */
export interface InboxSourceContext {
  readonly directory: string
  /**
   * The session's cancellation epoch captured once per drain, before any
   * source runs. A claim passes it to a fenced admission
   * (`SessionCancellation.requestIfEpoch`) so an ESC that lands after this
   * capture but before the admission cannot be bypassed by binding a new
   * request to the advanced epoch.
   */
  readonly claimEpoch: number
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
  /** Durable backstop for sources whose items can outlive a missed nudge. The
   * scan runs per instance, before any session is known, so it sees only the
   * directory; the drain supplies `claimEpoch` to each claim. */
  readonly scan?: (ctx: Pick<InboxSourceContext, "directory">) => Effect.Effect<ReadonlyArray<SessionID>, unknown>
  /**
   * Take (or begin) one delivery for the session. `true` means this boundary
   * consumed the claim; `false` means nothing was deliverable.
   */
  readonly claim: (sessionID: SessionID, ctx: InboxSourceContext) => Effect.Effect<boolean, unknown, Scope.Scope>
}

/**
 * A hint-only step source (PR3). It never owns payloads: it only answers
 * whether it may have input for the next model step. Hints are allowed to be
 * false positives; a `false` must mean this source positively proved there is
 * nothing for it to deliver. `pullForStep` therefore returns true when any
 * registered source says maybe, and only false when every source said false.
 */
export interface StepSource {
  readonly id: InboxSourceID
  readonly hint: (sessionID: SessionID) => boolean
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

/** The caller's layer graph has no SessionPrompt service to admit the item. */
export class InboxAdmissionUnavailable extends Schema.TaggedError<InboxAdmissionUnavailable>()(
  "SessionInboxAdmissionUnavailable",
  {
    source: Schema.String,
    sessionID: Schema.String,
  },
) {
  override get message() {
    return `Session inbox source "${this.source}" cannot admit: no session prompt service in this context`
  }
}

/** The admission port refused the item; the error text is the prompt failure. */
export class InboxAdmissionFailed extends Schema.TaggedError<InboxAdmissionFailed>()("SessionInboxAdmissionFailed", {
  source: Schema.String,
  sessionID: Schema.String,
  cause: Schema.String,
}) {
  override get message() {
    return `Session inbox source "${this.source}" admission failed: ${this.cause}`
  }
}

export interface Interface {
  /** Resolve this instance's route, arm the tick, and register with the process. */
  readonly init: () => Effect.Effect<void>
  /** Add one source to this instance's drain set; a later registration for the same id replaces it. */
  readonly register: (source: InboxSource) => Effect.Effect<void>
  /** Add one step hint source; a later registration for the same id replaces it. */
  readonly registerStep: (source: StepSource) => Effect.Effect<void>
  /** Whether any step source may have input for this boundary. Conservative:
   * no source registered, a throwing hint, or any `true` returns true; false
   * only when every registered source explicitly returned false. */
  readonly pullForStep: (sessionID: SessionID) => Effect.Effect<boolean>
  /** Drain one session in the calling instance. */
  readonly drain: (sessionID: SessionID) => Effect.Effect<void>
  /** Process-level route: drain the loaded instance that owns the session's directory. */
  readonly nudge: (sessionID: SessionID) => Effect.Effect<void>
  /** Admission port for automatic sources. Commits the prompt and returns
   * without waiting for the turn; a ledger source's key is committed in the
   * same transaction, and an already-seen key returns `duplicate`. */
  readonly submit: (
    sourceID: InboxSourceID,
    sessionID: SessionID,
    item: InboxItem,
  ) => Effect.Effect<
    Admission,
    InboxNotWired | UnsupportedDeliveryPolicy | InboxAdmissionUnavailable | InboxAdmissionFailed
  >
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/SessionInbox") {}

interface InstanceData {
  readonly directory: string
  readonly scope: Scope.Scope
  readonly sources: Map<InboxSourceID, InboxSource>
  readonly steps: Map<InboxSourceID, StepSource>
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
      options: { readonly force?: boolean; readonly idle?: boolean } = {},
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        const force = options.force === true
        // One epoch for the whole drain: a source's admission is fenced
        // against the cancellation state this boundary observed, not against
        // an epoch re-read after an ESC has already advanced it.
        const claimEpoch = SessionCancellation.epoch(sessionID)
        const sources = [...data.sources.values()].sort(byPriority)
        // `idle_only` means exactly that: neither a nudge nor the forced tick
        // may deliver into a running turn. The idle subscription itself is
        // authoritative for its own drain: SessionStatus makes the new state
        // observable before it publishes the idle event, so an event-driven
        // read here already sees `idle` rather than the previous `busy`. Only
        // the non-idle triggers (nudge, tick) read the live status, and a
        // nudge can arrive mid-turn (release, report follow-up). The forced
        // tick only bypasses the in-memory hint, not this gate.
        let idleNow = options.idle === true ? true : undefined
        for (const source of sources) {
          if (!force && !source.hint(sessionID)) continue
          if (source.mode === "idle_only") {
            if (idleNow === undefined) idleNow = (yield* status.get(sessionID)).type === "idle"
            if (!idleNow) continue
          }
          const claimed = yield* source.claim(sessionID, { directory: data.directory, claimEpoch }).pipe(
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
    const drainFor = (
      data: InstanceData,
      sessionID: SessionID,
      options: { readonly force?: boolean; readonly idle?: boolean } = {},
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const active = data.inFlight.get(sessionID)
        if (active) {
          active.again = true
          return
        }
        const token = { again: false, force: options.force === true, idle: options.idle === true }
        data.inFlight.set(sessionID, token)
        yield* data.mutex
          .withLock(sessionID)(
            Effect.gen(function* () {
              do {
                token.again = false
                const trigger = { force: token.force, idle: token.idle }
                // Coalesced re-runs are driven by a nudge, not by the idle
                // event that opened this pass: they must re-check liveness.
                token.idle = false
                // Claim forks (goal evaluation) live on the instance scope,
                // not on a nudge caller's short-lived scope.
                yield* claimAll(data, sessionID, trigger).pipe(Scope.provide(data.scope))
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
          yield* drainFor(data, sessionID, { force: true }).pipe(
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
          // Built-in sources. `hook.rewake` is a submit whitelist only: a
          // rewake has no durable ledger, so a drain boundary has nothing to
          // claim; `hook.async_context` only marks that async hook results may
          // exist at the next step boundary. Neither takes part in a drain.
          sources: new Map<InboxSourceID, InboxSource>([
            [
              "hook.rewake",
              {
                id: "hook.rewake",
                priority: 20,
                mode: "join_or_start",
                hint: () => false,
                claim: () => Effect.succeed(false),
              },
            ],
          ]),
          steps: new Map<InboxSourceID, StepSource>([
            ["hook.async_context", { id: "hook.async_context", hint: () => true }],
          ]),
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
            drainFor(data, evt.data.sessionID, { idle: true }).pipe(
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

    const registerStep = Effect.fn("SessionInbox.registerStep")(function* (source: StepSource) {
      const data = yield* InstanceState.get(state)
      data.steps.set(source.id, source)
    })

    // Advisory only: never claims, never writes, never arms a subscription.
    // A source is allowed a false positive, so any "maybe" wins; `false` is
    // reserved for "every registered source positively proved empty". A hint
    // that throws is unknown, not empty.
    const pullForStep = Effect.fn("SessionInbox.pullForStep")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      if (data.steps.size === 0) return true
      for (const source of data.steps.values()) {
        try {
          if (source.hint(sessionID)) return true
        } catch (cause) {
          yield* Effect.logDebug("session inbox step hint failed; treating input as pending", {
            source: source.id,
            sessionID,
            cause,
          })
          return true
        }
      }
      return false
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
      // `join_or_start` is the only policy submit can honor: an idle-only
      // source must go through its drain boundary, and `turn_boundary` has no
      // implementation.
      if (source.mode !== "join_or_start") return yield* new UnsupportedDeliveryPolicy({ policy: source.mode })
      if (!item.prompt)
        return yield* new InboxAdmissionFailed({ source: sourceID, sessionID, cause: "missing prompt payload" })
      // Resolve the admission port from the caller's context. Drain claims run
      // in this instance's build context (no SessionPrompt), so a source must
      // never call submit from inside `claim`; only external callers that own
      // the app layer can.
      const { SessionPrompt } = yield* Effect.promise(() => import("./prompt"))
      const prompts = Option.getOrUndefined(yield* Effect.serviceOption(SessionPrompt.Service))
      if (!prompts) return yield* new InboxAdmissionUnavailable({ source: sourceID, sessionID })
      // One key, derived by the ledger: the item carries no identity of its
      // own. A ledger that already holds this scope is a redelivery; return
      // before admission so the caller cannot write a second message.
      const ledger = source.ledger
      const scope: LedgerScope | undefined = ledger
        ? { source: sourceID, sessionID, idempotencyKey: ledger.idempotencyKey(item) }
        : undefined
      const failed = (error: unknown) => new InboxAdmissionFailed({ source: sourceID, sessionID, cause: String(error) })
      if (ledger && scope) {
        const committed = yield* ledger.seen(scope).pipe(Effect.mapError(failed))
        if (committed) return { state: "duplicate" } as const
      }
      const admitted = yield* prompts
        .admit(
          { sessionID, ...item.prompt, ...(item.noReply === true ? { noReply: true } : {}) },
          item.admissionOptions,
          ledger && scope ? ledger.commit(scope) : undefined,
        )
        .pipe(
          Effect.map((value) => ({ tag: "admitted", value }) as const),
          // Admission failures are typed (`PromptError`); a ledger source
          // re-reads the durable truth here. A concurrent loser rolled back
          // its transaction after the winner committed, so `seen` now holds
          // and the item is a duplicate. Every other failure (including an
          // interrupt or defect, which this mapping never touches) propagates.
          Effect.mapError(failed),
          Effect.catchTag("SessionInboxAdmissionFailed", (failure) =>
            ledger && scope
              ? ledger.seen(scope).pipe(
                  Effect.mapError(failed),
                  Effect.flatMap((committed) =>
                    committed
                      ? Effect.succeed({ tag: "duplicate" } as const)
                      : Effect.fail(failure),
                  ),
                )
              : Effect.fail(failure),
          ),
        )
      if (admitted.tag === "duplicate") return { state: "duplicate" } as const
      const started = admitted.value
      // Never await `started.wait`: admission commits the message and returns;
      // the turn runs on its own. A committed message that did not start a turn
      // is `written`, not `pending` — the ledger-less source's confirmation
      // point is exactly this committed message.
      const message = started.message
      if (started.admission.kind === "started" && message)
        return { state: "started", messageID: message.info.id, createdAt: message.info.time.created } as const
      if (started.admission.kind === "joined" && message)
        return {
          state: "joined",
          messageID: started.admission.messageID,
          createdAt: message.info.time.created,
        } as const
      if (message)
        return { state: "written", messageID: message.info.id, createdAt: message.info.time.created } as const
      if (started.admission.kind === "skipped_busy") return { state: "skipped_busy" } as const
      return { state: "pending" } as const
    })

    return Service.of({ init, register, registerStep, drain, nudge, pullForStep, submit })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provide(SessionStatus.defaultLayer)),
)

export const node = LayerNode.make(layer, [EventV2Bridge.node, SessionStatus.node])
