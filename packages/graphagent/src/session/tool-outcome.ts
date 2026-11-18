// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { ToolOutcomeKind } from "@graphagent/core/session/outcome"

/** Error identities (`_tag` or `name`) that map to a failure class other than `execution_error`. */
const OUTCOME_BY_ERROR: Readonly<Record<string, ToolOutcomeKind>> = {
  ToolInvalidArgumentsError: "validation_error",
  ToolInputRejectedError: "validation_error",
  PermissionRejectedError: "denied",
  PermissionCorrectedError: "denied",
  PermissionDeniedError: "denied",
  QuestionRejectedError: "denied",
  AbortError: "aborted",
}

function identity(error: unknown, key: "_tag" | "name"): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const value = Reflect.get(error, key)
  return typeof value === "string" ? value : undefined
}

/**
 * Class of a tool failure, recorded as the error part's `metadata.outcome`.
 * Errors are told apart by their `_tag` or `name`, so a class that crossed a
 * module or process boundary still matches; anything else is an execution error.
 */
export function classifyToolError(error: unknown): ToolOutcomeKind {
  for (const key of ["_tag", "name"] as const) {
    const name = identity(error, key)
    if (name !== undefined && Object.hasOwn(OUTCOME_BY_ERROR, name)) return OUTCOME_BY_ERROR[name]
  }
  return "execution_error"
}

export * as ToolOutcome from "./tool-outcome"
