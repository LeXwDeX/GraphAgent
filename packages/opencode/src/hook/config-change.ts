import { Cause, Context, Effect, Layer, Schema } from "effect"
import path from "node:path"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
export interface Change {
  readonly path: string
  readonly source: "user_settings" | "project_settings" | "local_settings" | "skills"
}
export interface Decision {
  readonly blocked?: { readonly reason: string }
  /** Number of registered session listeners that were asked (only reported by `checkInstance`). */
  readonly checked?: number
}
export class ConfigChangeBlocked extends Schema.TaggedErrorClass<ConfigChangeBlocked>()("ConfigChangeBlocked", {
  message: Schema.String,
}) {}
export interface Interface {
  readonly register: (
    sessionID: string,
    directory: string,
    changed: (change: Change) => Effect.Effect<Decision>,
  ) => Effect.Effect<void>
  readonly clear: (sessionID: string) => Effect.Effect<void>
  readonly check: (change: Change) => Effect.Effect<Decision>
  /**
   * Ask only the sessions registered from the current directory instance. A local hooks.json
   * reload belongs to one instance; asking every instance would trigger each hook N times.
   */
  readonly checkInstance: (change: Change) => Effect.Effect<Decision>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/HookConfigChange") {}
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const listeners = new Map<string, { directory: string; changed: (change: Change) => Effect.Effect<Decision> }>()
    const owned = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        const keys = new Map<string, object>()
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const [key, owner] of keys) if (listeners.get(key) === owner) listeners.delete(key)
          }),
        )
        return keys
      }),
    )
    const register = Effect.fn("HookConfigChange.register")(function* (
      id: string,
      directory: string,
      changed: (change: Change) => Effect.Effect<Decision>,
    ) {
      const bridge = yield* EffectBridge.make()
      const listener = { directory, changed: (change: Change) => bridge.run(changed(change)) }
      ;(yield* InstanceState.get(owned)).set(id, listener)
      listeners.set(id, listener)
    })
    const clear = Effect.fn("HookConfigChange.clear")((id: string) =>
      Effect.sync(() => {
        listeners.delete(id)
      }),
    )
    const ask = Effect.fnUntraced(function* (
      change: Change,
      candidates: Iterable<{ directory: string; changed: (change: Change) => Effect.Effect<Decision> }>,
    ) {
      let checked = 0
      for (const listener of candidates) {
        const relative = path.relative(listener.directory, change.path)
        const ancestor = path.relative(path.dirname(change.path), listener.directory)
        const inside = !relative.startsWith("..") && !path.isAbsolute(relative)
        const inherited = !ancestor.startsWith("..") && !path.isAbsolute(ancestor)
        if (change.source !== "user_settings" && !inside && !inherited) continue
        checked++
        const decision = yield* listener
          .changed(change)
          .pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed<Decision>({}),
            ),
          )
        if (decision.blocked) return { ...decision, checked }
      }
      return { checked } as Decision
    })
    const check = Effect.fn("HookConfigChange.check")(function* (change: Change) {
      const decision = yield* ask(change, [...listeners.values()])
      return decision.blocked ? { blocked: decision.blocked } : ({} as Decision)
    })
    const checkInstance = Effect.fn("HookConfigChange.checkInstance")(function* (change: Change) {
      const mine = yield* InstanceState.get(owned)
      return yield* ask(
        change,
        [...mine].flatMap(([key, owner]) => (listeners.get(key) === owner ? [listeners.get(key)!] : [])),
      )
    })
    return Service.of({ register, clear, check, checkInstance })
  }),
)
export const defaultLayer = layer
export const node = LayerNode.make(layer, [])
export * as HookConfigChange from "./config-change"
