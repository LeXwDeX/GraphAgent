export * as MemoryIdentityFence from "./identity-fence"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Context, Effect, Layer, Option } from "effect"
import { eq } from "drizzle-orm"
import { MemoryHome } from "./home"

/**
 * Single authority for the `memory-identity:<id>` fence protocol.
 *
 * Every reader/writer that serializes against identity retirement goes through
 * `withLiveIdentity`, which owns the whole protocol: the lock key, the lock
 * directory, AND the in-fence identity-liveness recheck. Before this module
 * the protocol was hand-duplicated at four sites across three files, which let
 * the admission path diverge from the writer discipline (a retired identity
 * could re-create its Home). With the protocol here, no new path can forget
 * the recheck.
 *
 * The retirement seam (ProjectIdentityMigration.migrate) is the only raw
 * holder: it deletes the identity row inside the fence, so it cannot recheck
 * liveness. It builds its key from `MemoryIdentityFence.key` so the key
 * convention still has exactly one source.
 */
export interface Interface {
  /**
   * Run `body` inside the cross-process `memory-identity:<id>` fence, and only
   * if the identity row still exists. Returns `Option.none()` when the row was
   * retired between the caller's earlier check and fence acquisition — the
   * caller must then fail closed instead of writing under a retired identity.
   */
  readonly withLiveIdentity: <A, E, R>(
    id: ProjectV2.ID,
    body: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E | EffectFlock.LockError, R>
}

export const key = (id: ProjectV2.ID) => `memory-identity:${id}`

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryIdentityFence") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const flock = yield* EffectFlock.Service
    const home = yield* MemoryHome.Service
    const { db } = yield* Database.Service
    return Service.of({
      withLiveIdentity: (id, body) =>
        flock.withLock(
          Effect.gen(function* () {
            // Same fail-closed stance as Project.get: a query error here means
            // the storage layer is unusable — die loudly rather than silently
            // importing into a possibly-retired Home.
            const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get().pipe(Effect.orDie)
            if (!row) return Option.none()
            return Option.some(yield* body)
          }),
          key(id),
          home.locks,
        ),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(MemoryHome.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

export const node = LayerNode.make(layer, [EffectFlock.node, MemoryHome.node, Database.node])
