// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { mergeDeep } from "remeda"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { ProbeTransport } from "./transport"

/** The session id the options derive a cache key from; the probe has no session of its own. */
const SESSION_ID = "probe"

/**
 * The request-level provider options a normal turn sends for this model, for the probe's chat requests. Some
 * endpoints answer differently with them (`alibaba-cn` returns no reasoning without `enable_thinking`), so a probe
 * without them would measure a mode the engine never uses. The steps are the engine's own, in its order: the
 * options the engine derives from the model and its provider (`ProviderTransform.options`), the model's configured
 * `options` merged over them, and the result wrapped under the key the SDK reads (`ProviderTransform.providerOptions`),
 * as `LLMRequestPrep.prepare` and the stream call in `session/llm.ts` do. The agent's options and the selected
 * variant are left out: they belong to a session, and the probe has none.
 */
export function resolve(input: {
  readonly model: Provider.Model
  /** The provider's `options`, which carry `setCacheKey`. */
  readonly providerOptions: Provider.Info["options"]
}): ProbeTransport.ProviderOptions {
  const base = ProviderTransform.options({
    model: input.model,
    sessionID: SESSION_ID,
    providerOptions: input.providerOptions,
  })
  return ProviderTransform.providerOptions(input.model, mergeDeep(base, input.model.options))
}

export * as ProbeOptions from "./options"
