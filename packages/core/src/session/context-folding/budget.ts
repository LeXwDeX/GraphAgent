// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Token } from "../../util/token"
import type { BudgetSkipReason, ContextFoldingBudget, PreparedRequestBudgetInput } from "./types"
import { serializeWireValue } from "./wire-value"

const emptyBudget = (skipReason: BudgetSkipReason): ContextFoldingBudget => ({
  usableInputTokens: undefined,
  targetTokens: undefined,
  estimatedInputTokens: undefined,
  overBudget: undefined,
  inputBytes: undefined,
  skipReason,
})

const positiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
const nonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const softTarget = (usableInputTokens: number) => {
  // Keep floor(U * 0.7) exact near Number.MAX_SAFE_INTEGER instead of relying on binary floating-point rounding.
  const quotient = Math.floor(usableInputTokens / 10)
  const remainder = usableInputTokens % 10
  return quotient * 7 + Math.floor((remainder * 7) / 10)
}

const estimate = (input: PreparedRequestBudgetInput): ContextFoldingBudget => {
  if (!positiveSafeInteger(input.contextLimit)) return emptyBudget("invalid-context-limit")

  let inputLimit = input.contextLimit
  if (input.inputLimit.kind === "value") {
    if (!positiveSafeInteger(input.inputLimit.value)) return emptyBudget("invalid-input-limit")
    inputLimit = input.inputLimit.value
  }

  if (!positiveSafeInteger(input.outputReserve) || input.outputReserve >= input.contextLimit) {
    return emptyBudget("invalid-output-reserve")
  }
  if (!nonNegativeSafeInteger(input.protocolOverheadTokens)) return emptyBudget("invalid-protocol-overhead")
  if (input.media !== "none") return emptyBudget("unknown-media")
  if (input.system.kind === "unknown") return emptyBudget("unknown-system")

  const transmitted =
    input.system.kind === "instructions"
      ? { instructions: input.system.value, messages: input.messages, tools: input.tools }
      : { messages: input.messages, tools: input.tools }
  const serialized = serializeWireValue(transmitted)
  if (!serialized.ok) return emptyBudget(serialized.reason)

  const usableInputTokens = Math.min(inputLimit, input.contextLimit - input.outputReserve)
  if (!positiveSafeInteger(usableInputTokens)) return emptyBudget("invalid-output-reserve")
  const targetTokens = softTarget(usableInputTokens)
  const serializedTokens = Token.estimate(serialized.value)
  const estimatedInputTokens = serializedTokens + input.protocolOverheadTokens
  if (!Number.isSafeInteger(estimatedInputTokens)) return emptyBudget("unknown-content")
  const overBudget = estimatedInputTokens > targetTokens

  return {
    usableInputTokens,
    targetTokens,
    estimatedInputTokens,
    overBudget,
    inputBytes: serialized.inputBytes,
    skipReason: overBudget ? undefined : "below-target",
  }
}

export const estimateContextFoldingBudget = (input: PreparedRequestBudgetInput): ContextFoldingBudget => {
  try {
    return estimate(input)
  } catch {
    return emptyBudget("unknown-content")
  }
}
