/**
 * HookRewake — bridge service tag for async hook rewake delivery.
 *
 * Tag-only leaf module: imports nothing from prompt.ts or the hook barrel, so
 * there is no import cycle. The live implementation lives in rewake-live.ts
 * (depends on this tag + SessionPrompt.Service); app-runtime and the httpapi
 * server node graph wire it.
 *
 * Deliberately NO default/no-op layer here: service.ts resolves this service
 * via `Effect.serviceOption` and degrades gracefully (log.warn + skip) when it
 * is absent. A no-op layer would risk masking the live one if both were ever
 * wired into the same graph.
 *
 * `rewakeToken` identifies the Stop-continuation chain that produced the
 * callback. The live implementation forwards it to SessionPrompt admission so
 * a callback whose chain was reset (cancel, newer prompt, SessionEnd) is
 * refused at the actual admission point, not just at callback completion.
 */
import { Context, Effect } from "effect"
import { SessionID } from "@/session/schema"
import type { RewakeToken } from "./types"

export interface Interface {
  readonly rewake: (input: { sessionID: SessionID; text: string; rewakeToken?: RewakeToken }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/HookRewake") {}

export * as HookRewake from "./rewake"
