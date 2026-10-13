/**
 * Live HookRewake implementation — drives the V1 SessionPrompt loop.
 *
 * Dependency graph (no cycle):
 *   rewake.ts (tag only) ← settings.ts ← prompt.ts ← this file → rewake.ts
 *
 * SessionPrompt.Service is resolved lazily at call time (not at construction)
 * so this layer has no construction-time requirements and composes cleanly
 * in Layer.mergeAll. The rewake runs from the SettingsHook trigger context
 * (inside AppLayer), so SessionPrompt is always available there.
 *
 * The loop guard in prompt.ts (UserPromptSubmit trigger skips prompts whose
 * text starts with HOOK_REWAKE_SENTINEL) IS on this path — SessionPrompt.prompt
 * fires UserPromptSubmit hooks internally, so rewake prompts are guarded.
 */
import { Effect, Layer, Option } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { HookRewake } from "./rewake"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"

export const liveLayer = Layer.succeed(
  HookRewake.Service,
  HookRewake.Service.of({
    rewake: (input) =>
      Effect.gen(function* () {
        const sessionPrompt = Option.getOrUndefined(yield* Effect.serviceOption(SessionPrompt.Service))
        if (!sessionPrompt) return
        yield* sessionPrompt
          .prompt(
            {
              sessionID: SessionID.make(input.sessionID),
              parts: [{ type: "text", text: input.text }],
            },
            // Forward the stop-chain token: admission and the run path
            // re-validate it, refusing callbacks whose chain was invalidated
            // by a session cancel after their completion check.
            { stopChainToken: input.stopChain },
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("hook rewake prompt failed", {
                sessionID: input.sessionID,
                error: String(error),
              }),
            ),
            Effect.asVoid,
          )
      }),
  }),
)

// SessionPrompt is resolved lazily at call time, so the node declares no
// construction-time dependencies. The httpapi server app graph and AppLayer
// both contain SessionPrompt, which is what the call-time serviceOption sees.
export const node = LayerNode.make(liveLayer, [])

export * as HookRewakeLive from "./rewake-live"
