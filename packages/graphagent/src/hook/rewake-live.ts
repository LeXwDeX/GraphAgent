/**
 * Live HookRewake implementation — routes V1 hook feedback to SessionPrompt.
 *
 * Dependency graph (no cycle):
 *   rewake.ts (tag only) ← index.ts ← prompt.ts ← this file → rewake.ts
 *
 * SessionPrompt is resolved lazily from the ambient request context. The loop
 * guard in prompt.ts (UserPromptSubmit trigger skips prompts whose text starts
 * with HOOK_REWAKE_SENTINEL) IS on this path — SessionPrompt.prompt fires
 * UserPromptSubmit hooks internally, so rewake prompts are guarded.
 */
import { Effect, Layer, Option } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { HookRewake } from "./rewake"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"

export const liveLayer = Layer.effect(
  HookRewake.Service,
  Effect.gen(function* () {
    return HookRewake.Service.of({
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
    })
  }),
)

export const node = LayerNode.make(liveLayer, [])

export * as HookRewakeLive from "./rewake-live"
