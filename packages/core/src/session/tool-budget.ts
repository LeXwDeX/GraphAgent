// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export const DEFAULT_MAX_TOOL_CALLS = 0

export const MaxToolCalls = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)).annotate({
  description:
    "Maximum tool execution attempts per input-driven model run; 0 means unlimited (default); each parallel tool call counts separately",
})

/** Apply the default after configuration layers have been merged. */
export function resolveMaxToolCalls(value?: number): number {
  const max = value ?? DEFAULT_MAX_TOOL_CALLS
  if (!Number.isSafeInteger(max) || max < 0) throw new RangeError("maxToolCalls must be a non-negative safe integer")
  return max
}

export interface Budget {
  readonly max: number
  readonly used: number
  readonly remaining: number
  readonly exhausted: boolean
  /** Reserve before execution. Failures and interruptions do not refund a reservation. */
  readonly tryReserve: () => boolean
}

/** Own one budget per input-driven run; keep it across provider requests and compaction. */
export function create(value?: number): Budget {
  const max = resolveMaxToolCalls(value)
  let used = 0
  return {
    get max() {
      return max
    },
    get used() {
      return used
    },
    get remaining() {
      return max === 0 ? Infinity : max - used
    },
    get exhausted() {
      return max > 0 && used >= max
    },
    tryReserve() {
      // No asynchronous boundary may separate checking from consuming a slot.
      if (max > 0 && used >= max) return false
      used += 1
      return true
    },
  }
}

export function exhaustedMessage(max: number): string {
  return `Maximum tool calls (${max}) reached for this user input.`
}

export function renderExhaustedPrompt(max: number): string {
  return `${exhaustedMessage(max)} Tools are disabled until the next user input. Respond with text summarizing completed work, remaining work, and next steps.`
}

export * as ToolBudget from "./tool-budget"
