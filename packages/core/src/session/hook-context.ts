export * as SessionHookContext from "./hook-context"

import { Context } from "effect"
import type { AgentV2 } from "../agent"
import type { SessionSchema } from "./schema"

/** Identity of the provider turn whose real context/tool reads are in progress. */
export interface Interface {
  readonly sessionID: SessionSchema.ID
  readonly agentID: AgentV2.ID
  /** Only an actual post-compaction reload carries compact, never a normal turn. */
  readonly loadReason?: "session_start" | "compact"
  /** Unique identity of the completed compaction, stable across reads of its next turn. */
  readonly loadBatch?: string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionHookContext") {}
