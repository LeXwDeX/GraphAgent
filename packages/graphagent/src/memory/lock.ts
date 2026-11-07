export * as MemoryLock from "./lock"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Context, Effect, Layer } from "effect"

export interface Interface {
  readonly withProject: (projectID: ProjectV2.ID) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryLock") {}

export const layer = Layer.sync(Service, () => {
  const locks = KeyedMutex.makeUnsafe<ProjectV2.ID>()
  return Service.of({ withProject: (projectID) => locks.withLock(projectID) })
})

export const defaultLayer = layer

export const node = LayerNode.make(layer, [])
