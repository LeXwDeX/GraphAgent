export * as SessionCwdHooks from "./cwd-hooks"

import { Cause, Context, Effect, Option } from "effect"

export interface Change {
  readonly sessionID: string
  readonly previousDirectory: string
  readonly directory: string
}
export interface Interface {
  readonly changed: (change: Change) => Effect.Effect<void>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCwdHooks") {}

/** Observes an already committed move; hook failures cannot undo its durable location. */
export const changed = Effect.fn("SessionCwdHooks.changed")(function* (change: Change) {
  const hooks = Option.getOrUndefined(yield* Effect.serviceOption(Service))
  if (!hooks) return
  yield* hooks
    .changed(change)
    .pipe(Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.void)))
})
