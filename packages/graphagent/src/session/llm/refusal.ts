// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { FINAL_STEP_REFUSAL_MESSAGE } from "../turn/final-policy"

/**
 * Raised when a tool executes on a request whose `toolPolicy` is `refuse`.
 *
 * It is deliberately a plain `Error` subclass: the processor counts any other
 * tool error as real attempt activity, which keeps the incomplete-response and
 * retry gates closed. `ToolInputRejectedError` would delete the pending call
 * without setting that marker and could trigger an `IncompleteResponseError`
 * retry after a refused final step.
 */
export class ToolRefusedError extends Error {
  override readonly name = "ToolRefusedError"

  constructor() {
    super(FINAL_STEP_REFUSAL_MESSAGE)
  }
}

export * as ToolRefusal from "./refusal"
