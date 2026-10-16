/**
 * Live HookRewake implementation — routes V2 feedback to its runner and
 * retains the V1 SessionPrompt path for legacy sessions.
 *
 * Dependency graph (no cycle):
 *   rewake.ts (tag only) ← settings.ts ← prompt.ts ← this file → rewake.ts
 *
 * The scoped V2 execution bridge is captured when this layer is constructed
 * by the server graph. This avoids relying on an ambient execution service
 * that may disappear when the asynchronous command settles. V1 stays lazy.
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
import { SessionRewakeBridge } from "@opencode-ai/core/session/execution/rewake-bridge"
import { SessionSchema } from "@opencode-ai/core/session/schema"

export const liveLayer = Layer.effect(
  HookRewake.Service,
  Effect.gen(function* () {
    const v2 = Option.getOrUndefined(yield* Effect.serviceOption(SessionRewakeBridge.Service))
    return HookRewake.Service.of({
      rewake: (input) =>
        Effect.gen(function* () {
          if (v2) {
            const handled = yield* v2.invoke({
              sessionID: SessionSchema.ID.make(input.sessionID),
              text: input.text,
              valid: input.valid ?? (() => Effect.succeed(true)),
            })
            if (handled) return
          }
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

// SessionPrompt is resolved lazily; V2 SessionExecution is captured when the
// server graph supplies it. AppLayer without a V2 executor keeps V1 behavior.
export const node = LayerNode.make(liveLayer, [SessionRewakeBridge.node])

export * as HookRewakeLive from "./rewake-live"
