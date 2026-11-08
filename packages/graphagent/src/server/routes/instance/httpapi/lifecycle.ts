export * as AfterResponse from "./lifecycle"

import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { Context, Effect, Ref } from "effect"
import { HttpMiddleware, HttpRouter } from "effect/http"

type Action = Effect.Effect<void>

/**
 * Request-scoped handoff for work that must run after the handler produced its
 * response (instance disposal and reload). The middleware owns one queue per
 * request and provides this service to the handler; no request identity map is
 * needed.
 */
export interface Interface {
  /** Disposes the instance after the response for this request has been produced. */
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void, never, InstanceStore.Service>
  /** Reloads the instance store after the response for this request has been produced. */
  readonly reload: (next: InstanceStore.LoadInput) => Effect.Effect<void, never, InstanceStore.Service>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/AfterResponse") {}

export const make = (pending: Ref.Ref<readonly Action[]>): Interface => {
  const enqueue = (action: Action) => Ref.update(pending, (actions) => [...actions, action])
  return {
    dispose: (ctx) =>
      Effect.gen(function* () {
        const store = yield* InstanceStore.Service
        const bridge = yield* EffectBridge.make()
        yield* enqueue(Effect.uninterruptible(bridge.run(store.dispose(ctx))))
      }),
    reload: (next) =>
      Effect.gen(function* () {
        const store = yield* InstanceStore.Service
        const bridge = yield* EffectBridge.make()
        yield* enqueue(Effect.uninterruptible(bridge.run(store.reload(next))))
      }),
  }
}

export const afterResponseMiddleware: HttpMiddleware.HttpMiddleware = (effect) =>
  Effect.gen(function* () {
    const pending = yield* Ref.make<readonly Action[]>([])
    const response = yield* effect.pipe(Effect.provideService(Service, make(pending)))
    for (const action of yield* Ref.get(pending)) {
      yield* action.pipe(Effect.catchCause((cause) => Effect.logWarning("after-response action failed", { cause })))
    }
    return response
  })

/**
 * Global middleware layer, part of the routes graph so every server entrypoint
 * (`HttpRouter.serve`, `toWebHandler`, test harnesses) runs after-response
 * actions. It must live in the routes layer rather than in a per-call option:
 * routes are also served directly from `HttpApiApp.routes`.
 */
export const afterResponseLayer = HttpRouter.middleware(afterResponseMiddleware, { global: true })
