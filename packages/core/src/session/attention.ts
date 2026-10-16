import { Context, Effect } from "effect"
import type { SessionSchema } from "./schema"

/** Host-only attention signals. No prompt content or authorization is carried. */
export interface Interface {
  readonly update: (input: {
    sessionID: SessionSchema.ID
    clientID: string
    clientType?: "terminal" | "web"
    activity?: number
    backgroundView?: boolean
    closed?: boolean
  }) => Effect.Effect<void>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionAttentionHost") {}
export * as SessionAttentionHost from "./attention"
