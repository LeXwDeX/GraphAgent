export * as SessionCompactionHooks from "./compaction-hooks"

import { Context, Effect } from "effect"
import { SessionSchema } from "./schema"

/** Optional host hook boundary around an actual automatic V2 summary. */
export interface Interface {
  readonly before: (sessionID: SessionSchema.ID) => Effect.Effect<{ blocked: boolean }>
  readonly after: (input: {
    sessionID: SessionSchema.ID
    summary: string
  }) => Effect.Effect<{ additionalContext?: string }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompactionHooks") {}
