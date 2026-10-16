export * as PermissionHookCapabilities from "./hook-capabilities"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"

/** Host-held, ephemeral startup authority; no settings or Hook output can create it. */
export const make = Effect.fn("PermissionHookCapabilities.make")(function* () {
  const state = yield* InstanceState.make(() => Effect.succeed(new Set<string>()))
  return {
    grant: (sessionID: string) =>
      InstanceState.use(state, (sessions) => {
        sessions.add(sessionID)
      }),
    has: (sessionID: string) => InstanceState.use(state, (sessions) => sessions.has(sessionID)),
    clear: (sessionID: string) =>
      InstanceState.use(state, (sessions) => {
        sessions.delete(sessionID)
      }),
  }
})
