import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"

export interface Interface {
  /** Append additionalContexts string to a session's pending start-context queue. */
  readonly append: (sessionID: SessionID, ctx: string) => Effect.Effect<void>
  /** Drain and return all pending start-contexts for a session. Idempotent — second call returns []. */
  readonly consume: (sessionID: SessionID) => Effect.Effect<readonly string[]>
  /**
   * Record that SessionStart already fired for this session in this instance (startup, via
   * SessionShare.create), so its first prompt admission is not mistaken for a resume.
   */
  readonly markStarted: (sessionID: SessionID) => Effect.Effect<void>
  /**
   * Claim the one-time `resume` SessionStart for a session. Returns true exactly once per
   * session per instance, and only for sessions this instance has not seen (not marked started):
   * i.e. sessions created before this process/instance started. The caller still decides whether
   * the session has prior messages. Subsequent calls return false.
   */
  readonly claimResume: (sessionID: SessionID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/HookStartContext") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(
      Effect.fn("HookStartContext.state")(() => Effect.succeed(new Map<SessionID, string[]>())),
    )
    // Sessions whose SessionStart lifecycle was already handled in this instance (startup fired
    // or resume claimed). Owned by InstanceState, so it is released with the instance. One id per
    // session touched in the instance's lifetime; deleted sessions are not pruned individually.
    const seen = yield* InstanceState.make(
      Effect.fn("HookStartContext.seen")(() => Effect.succeed(new Set<SessionID>())),
    )

    const append = Effect.fn("HookStartContext.append")(function* (sessionID: SessionID, ctx: string) {
      const data = yield* InstanceState.get(state)
      const arr = data.get(sessionID) ?? []
      arr.push(ctx)
      data.set(sessionID, arr)
    })

    const consume = Effect.fn("HookStartContext.consume")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const arr = data.get(sessionID) ?? []
      data.delete(sessionID)
      return arr as readonly string[]
    })

    const markStarted = Effect.fn("HookStartContext.markStarted")(function* (sessionID: SessionID) {
      ;(yield* InstanceState.get(seen)).add(sessionID)
    })

    const claimResume = Effect.fn("HookStartContext.claimResume")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(seen)
      if (data.has(sessionID)) return false
      data.add(sessionID)
      return true
    })

    return Service.of({ append, consume, markStarted, claimResume })
  }),
)

export const defaultLayer = layer

export const node = LayerNode.make(layer, [])

export * as HookStartContext from "./start-context"
