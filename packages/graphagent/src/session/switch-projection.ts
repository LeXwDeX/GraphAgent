// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { ModelProfile } from "@graphagent/core/model-profile"
import type { SessionV1 } from "@graphagent/core/v1/session"
import type { ReasoningCarrier } from "@graphagent/llm"
import { ProviderProfile } from "@/provider/profile"
import type { Provider } from "@/provider/provider"
import * as Log from "@/util/log"

const log = Log.create({ service: "session.switch-projection" })

/**
 * What the projection of an earlier model's history reads from the model the request goes to. It is read from the
 * target alone: a message records only the `providerID` and `modelID` of its model, so the profile of the old model
 * is not known, and a model of the same family is a model of the same `providerID`.
 */
export type Target = {
  readonly providerID: string
  readonly replay: ModelProfile["reasoningMode"]["replay"]
}

export function targetOf(model: Provider.Model): Target {
  return { providerID: model.providerID, replay: ProviderProfile.profileOf(model).reasoningMode.replay }
}

/**
 * The part that stands for a reasoning part of an assistant message that has no `ThinkingReplay` origin, or
 * `undefined` when the request carries nothing for it.
 *
 * - The model that produced the part is the model of the request (`differentModel` is false): the reasoning that a
 *   compaction invalidated becomes assistant text, whatever the target replays. This is the only rewrite to text.
 * - Another model produced it: only a `field` target takes it, and only plain or mirrored reasoning of the same
 *   provider with text in it, as a reasoning part without the old metadata. `signed` and `encrypted` targets accept
 *   nothing but their own blocks, and `none` replays nothing. Everything else is dropped, with a debug entry that
 *   names the message and what was dropped and no text.
 */
export function reasoningPart(input: {
  readonly target: Target
  readonly source: Pick<SessionV1.Assistant, "id" | "providerID" | "modelID">
  readonly differentModel: boolean
  readonly carrierKind: ReasoningCarrier.ReasoningCarrier["kind"]
  readonly text: string
}): { type: "reasoning" | "text"; text: string } | undefined {
  const { target, source, differentModel, carrierKind, text } = input
  const present = text.trim().length > 0
  if (!differentModel) return present ? { type: "text", text } : undefined
  const plaintext = carrierKind === "plain" || carrierKind === "mirror"
  if (present && plaintext && target.replay === "field" && source.providerID === target.providerID)
    return { type: "reasoning", text }
  log.debug("reasoning dropped for model switch", {
    messageID: source.id,
    from: source.providerID + "/" + source.modelID,
    replay: target.replay,
    carrier: carrierKind,
  })
  return undefined
}

export * as SwitchProjection from "./switch-projection"
