import { Context, Effect, Schema } from "effect"
import { ModelV2 } from "../model"
import { SessionSchema } from "./schema"

/** Optional leaf port for runtimes with an interactive model-switch policy. */
export interface Interface {
  readonly switchModel: (input: { sessionID: SessionSchema.ID; model: ModelV2.Ref }) => Effect.Effect<void, Blocked>
}

export class Blocked extends Schema.TaggedErrorClass<Blocked>()("SessionModelSwitchBlocked", {
  reason: Schema.String,
}) {}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionModelSwitchHook") {}

export * as SessionModelSwitchHook from "./model-switch"
