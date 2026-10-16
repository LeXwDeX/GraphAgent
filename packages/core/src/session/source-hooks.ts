export * as SessionSourceHooks from "./source-hooks"

import { Context, Effect } from "effect"
import type { AgentV2 } from "../agent"
import type { SkillV2 } from "../skill"
import type { SessionSchema } from "./schema"

/** Optional host notifications at actual session-context admission boundaries. */
export interface Interface {
  readonly syncAgent: (input: { sessionID: SessionSchema.ID; agentID: AgentV2.ID }) => Effect.Effect<void>
  readonly skillLoaded: (input: { sessionID: SessionSchema.ID; skill: SkillV2.Info }) => Effect.Effect<void>
  readonly instructionsLoaded: (input: {
    sessionID: SessionSchema.ID
    filePath: string
    memoryType?: "User" | "Project" | "Local" | "Managed"
    loadReason: "session_start" | "nested_traversal" | "path_glob_match" | "include" | "compact"
    parentFilePath?: string
    includeChain?: readonly string[]
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSourceHooks") {}
