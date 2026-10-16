import { SessionAttentionHost } from "@opencode-ai/core/session/attention"
import { Location } from "@opencode-ai/core/location"
import { Effect, Layer, Option } from "effect"
import { InstanceStore } from "@/project/instance-store"
import { SessionAttention } from "./attention"

export const layer = Layer.effect(
  SessionAttentionHost.Service,
  Effect.gen(function* () {
    const instances = yield* InstanceStore.Service
    const attention = yield* SessionAttention.Service
    return SessionAttentionHost.Service.of({
      update: (input) =>
        Effect.gen(function* () {
          const location = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
          if (!location) return yield* Effect.die(new Error("Session attention location unavailable"))
          return yield* instances.provide({ directory: location.directory }, attention.update(input.sessionID, input))
        }),
    })
  }),
)
export * as HookAttentionHost from "./attention-host"
