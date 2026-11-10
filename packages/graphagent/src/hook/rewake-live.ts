// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Live HookRewake implementation — routes V1 hook feedback through the session
 * inbox admission port.
 *
 * Dependency graph (no cycle):
 *   rewake.ts (tag only) ← index.ts ← prompt.ts; this file → inbox.ts
 *
 * `SessionInbox` is resolved lazily from the ambient request context. The loop
 * guard that keeps UserPromptSubmit from running on a rewake is the
 * `isRewake` check in admission (`HOOK_REWAKE_SENTINEL`), which `submit`
 * reaches through `SessionPrompt.admit` exactly like `prompt` did.
 */
import { Effect, Layer, Option } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { HookRewake } from "./rewake"
import { SessionInbox } from "@/session/inbox"
import { SessionID } from "@/session/schema"

export const liveLayer = Layer.effect(
  HookRewake.Service,
  Effect.gen(function* () {
    return HookRewake.Service.of({
      rewake: (input) =>
        Effect.gen(function* () {
          const inbox = Option.getOrUndefined(yield* Effect.serviceOption(SessionInbox.Service))
          if (!inbox) return
          yield* inbox
            .submit("hook.rewake", SessionID.make(input.sessionID), {
              prompt: { parts: [{ type: "text", text: input.text }] },
              // A rewake continues the turn that produced it: keep the current
              // input's tool budget instead of starting a fresh one, and carry
              // the rewake token so admission and the run path can refuse a
              // callback whose chain was reset after its completion check.
              admissionOptions: { continueToolBudget: true, rewakeToken: input.rewakeToken },
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("hook rewake submit failed", {
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

export const node = LayerNode.make(liveLayer, [SessionInbox.node])

export * as HookRewakeLive from "./rewake-live"
