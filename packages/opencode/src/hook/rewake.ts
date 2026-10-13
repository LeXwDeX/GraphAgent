/**
 * HookRewake — bridge service tag for async hook rewake delivery.
 *
 * Tag-only leaf module: imports nothing from prompt.ts or settings.ts, so
 * there is no import cycle. The live implementation lives in rewake-live.ts
 * (depends on this tag + SessionPrompt.Service); app-runtime and the httpapi
 * server node graph wire it.
 *
 * Deliberately NO default/no-op layer here: settings.ts resolves this service
 * via `Effect.serviceOption` and degrades gracefully (log.warn + skip) when it
 * is absent. A no-op layer would risk masking the live one if both were ever
 * wired into the same graph.
 *
 * `stopChain` is an opaque SettingsHook stop-chain token. When present, the
 * live implementation forwards it to SessionPrompt admission so a callback
 * whose chain was invalidated by a session cancel is refused at the actual
 * admission point, not just at callback completion.
 */
import { Context, Effect } from "effect"
import { SessionID } from "@/session/schema"

export interface Interface {
  readonly rewake: (input: { sessionID: SessionID; text: string; stopChain?: unknown }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/HookRewake") {}

export function bind(
  submit: (input: { sessionID: SessionID; text: string; stopChain?: unknown }) => Effect.Effect<unknown, unknown>,
): Interface {
  return {
    rewake: (input) =>
      submit(input).pipe(
        Effect.catch((error) =>
          Effect.logWarning("hook rewake prompt failed", { sessionID: input.sessionID, error: String(error) }),
        ),
        Effect.asVoid,
      ),
  }
}

export * as HookRewake from "./rewake"
