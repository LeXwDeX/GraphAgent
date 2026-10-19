import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { Context, Effect, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

export interface Interface {
  /** Claim a live child attempt. Recovery must not call this for a historical attempt. */
  readonly claimChildStart: (sessionID: string, attempt: string) => Effect.Effect<boolean>
  /** Only the matching live attempt may finish, at most once. */
  readonly claimChildStop: (sessionID: string, attempt: string) => Effect.Effect<boolean>
  /** DAG owners, including recovery, own clean child Stop rather than each prompt loop. */
  readonly delegateChildStop: (sessionID: string) => Effect.Effect<void>
  readonly isChildStopDelegated: (sessionID: string) => Effect.Effect<boolean>
  readonly attach: (sessionID: string) => Effect.Effect<void>
  readonly detach: (sessionID: string) => Effect.Effect<void>
  readonly claimEnd: (sessionID: string) => Effect.Effect<boolean>
  readonly serializeTranscript: <A, E, R>(sessionID: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly environment: (
    sessionID: string,
    signature: string,
    load: Effect.Effect<Record<string, string | undefined>>,
  ) => Effect.Effect<Record<string, string | undefined>>
  readonly queueInitial: (sessionID: string, text: string) => Effect.Effect<void>
  readonly consumeInitial: (sessionID: string) => Effect.Effect<string | undefined>
  readonly attached: () => Effect.Effect<readonly string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/HookLifecycle") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(() =>
      Effect.succeed({
        attached: new Set<string>(),
        ended: new Set<string>(),
        delegatedChildren: new Set<string>(),
        children: new Map<string, { attempt: string; stopped: boolean }>(),
        seen: new Map<string, Set<string>>(),
        environments: new Map<
          string,
          { signature: string; value: Effect.Effect<Record<string, string | undefined>> }
        >(),
        initial: new Map<string, string>(),
        transcript: KeyedMutex.makeUnsafe<string>(),
      }),
    )
    const claimChildStart = Effect.fn("HookLifecycle.claimChildStart")(function* (sessionID: string, attempt: string) {
      const data = yield* InstanceState.get(state)
      const seen = data.seen.get(sessionID) ?? new Set<string>()
      if (seen.has(attempt)) return false
      seen.add(attempt)
      data.seen.set(sessionID, seen)
      data.children.set(sessionID, { attempt, stopped: false })
      return true
    })
    const claimChildStop = Effect.fn("HookLifecycle.claimChildStop")(function* (sessionID: string, attempt: string) {
      const child = (yield* InstanceState.get(state)).children.get(sessionID)
      if (!child || child.attempt !== attempt || child.stopped) return false
      child.stopped = true
      return true
    })
    const delegateChildStop = Effect.fn("HookLifecycle.delegateChildStop")(function* (sessionID: string) {
      ;(yield* InstanceState.get(state)).delegatedChildren.add(sessionID)
    })
    const isChildStopDelegated = Effect.fn("HookLifecycle.isChildStopDelegated")(function* (sessionID: string) {
      return (yield* InstanceState.get(state)).delegatedChildren.has(sessionID)
    })
    const attach = Effect.fn("HookLifecycle.attach")(function* (sessionID: string) {
      const data = yield* InstanceState.get(state)
      data.ended.delete(sessionID)
      data.attached.add(sessionID)
    })
    const detach = Effect.fn("HookLifecycle.detach")(function* (sessionID: string) {
      const data = yield* InstanceState.get(state)
      data.attached.delete(sessionID)
      data.environments.delete(sessionID)
    })
    const claimEnd = Effect.fn("HookLifecycle.claimEnd")(function* (sessionID: string) {
      const data = yield* InstanceState.get(state)
      if (!data.attached.has(sessionID) || data.ended.has(sessionID)) return false
      data.ended.add(sessionID)
      data.attached.delete(sessionID)
      data.environments.delete(sessionID)
      data.initial.delete(sessionID)
      return true
    })
    const attached = Effect.fn("HookLifecycle.attached")(function* () {
      return [...(yield* InstanceState.get(state)).attached]
    })
    const environment = Effect.fn("HookLifecycle.environment")(function* (
      sessionID: string,
      signature: string,
      load: Effect.Effect<Record<string, string | undefined>>,
    ) {
      const data = yield* InstanceState.get(state)
      const prior = data.environments.get(sessionID)
      if (prior?.signature === signature) return yield* prior.value
      const value = yield* Effect.cached(load)
      data.environments.set(sessionID, { signature, value })
      return yield* value
    })
    const queueInitial = Effect.fn("HookLifecycle.queueInitial")(function* (id: string, text: string) {
      ;(yield* InstanceState.get(state)).initial.set(id, text)
    })
    const consumeInitial = Effect.fn("HookLifecycle.consumeInitial")(function* (id: string) {
      const data = yield* InstanceState.get(state)
      const text = data.initial.get(id)
      data.initial.delete(id)
      return text
    })
    const serializeTranscript = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const data = yield* InstanceState.get(state)
        return yield* data.transcript.withLock(id)(effect)
      })
    return Service.of({
      serializeTranscript,
      claimChildStart,
      claimChildStop,
      delegateChildStop,
      isChildStopDelegated,
      attach,
      detach,
      claimEnd,
      attached,
      environment,
      queueInitial,
      consumeInitial,
    })
  }),
)
export const defaultLayer = layer
export const node = LayerNode.make(layer, [])
export * as HookLifecycle from "./lifecycle"
