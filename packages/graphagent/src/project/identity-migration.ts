export * as ProjectIdentityMigration from "./identity-migration"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Context, Effect, Layer } from "effect"
import { MemoryHome } from "@/memory/home"
import { MemoryIdentityFence } from "@/memory/identity-fence"
import { MemoryIdentityMigration } from "@/memory/identity-migration"

export interface Interface {
  /**
   * Retire `oldID` in favor of `newID` as ONE fenced retirement. Holds the
   * cross-process `memory-identity:<oldID>` fence for the whole retirement —
   * the Memory Home migration AND the caller's reference/row retirement — so an
   * in-flight writer still producing under oldID either completes before the
   * retirement (its writes move with the Home) or sees the row gone on its
   * in-fence liveness recheck and stops. Callers pass their reference/row
   * retirement as `retireReferences` and do not touch the fence themselves.
   */
  readonly migrate: (
    oldID: ProjectV2.ID,
    newID: ProjectV2.ID,
    retireReferences: () => Effect.Effect<void>,
  ) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectIdentityMigration") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const memory = yield* MemoryIdentityMigration.Service
    const flock = yield* EffectFlock.Service
    const home = yield* MemoryHome.Service
    return Service.of({
      migrate: (oldID, newID, retireReferences) =>
        flock
          .withLock(
            Effect.gen(function* () {
              yield* memory.migrateHome(oldID, newID)
              yield* retireReferences()
            }),
            MemoryIdentityFence.key(oldID),
            home.locks,
          )
          .pipe(Effect.orDie, Effect.withSpan("ProjectIdentityMigration.migrate")),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(MemoryIdentityMigration.defaultLayer),
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(MemoryHome.defaultLayer),
)

export const node = LayerNode.make(layer, [
  MemoryIdentityMigration.node,
  EffectFlock.node,
  MemoryHome.node,
])
