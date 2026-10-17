export * as SessionRewakeBridge from "./rewake-bridge"

import { Context, Effect, Layer } from "effect"
import { LayerNode } from "../../effect/layer-node"
import { SessionExecution } from "../execution"

type Rewake = NonNullable<SessionExecution.Interface["rewake"]>

/** Scoped handoff between the host hook graph and the V2 execution graph. */
export interface Interface {
  readonly register: (handler: Rewake) => Effect.Effect<void>
  readonly unregister: (handler: Rewake) => Effect.Effect<void>
  /** Undefined means no V2 execution layer is registered in this host. */
  readonly invoke: (input: Parameters<Rewake>[0]) => Effect.Effect<boolean | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRewakeBridge") {}

export const layer = Layer.sync(Service, () => {
  let current: Rewake | undefined
  return Service.of({
    register: (handler) =>
      Effect.sync(() => {
        current = handler
      }),
    unregister: (handler) =>
      Effect.sync(() => {
        if (current === handler) current = undefined
      }),
    invoke: (input) => Effect.suspend(() => (current ? current(input) : Effect.succeed(undefined))),
  })
})

export const node = LayerNode.make(layer, [])
