import type { Effect, Scope } from "effect"
import type { PluginContext } from "./context"

export interface Plugin<R = Scope.Scope> {
  readonly id: string
  readonly effect: (context: PluginContext) => Effect.Effect<void, never, R>
}

export function define<R = Scope.Scope>(plugin: Plugin<R>) {
  return plugin
}
