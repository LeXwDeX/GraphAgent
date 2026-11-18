// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { ToolOutcomeKind } from "@graphagent/core/session/outcome"
import type { SessionV1 } from "@graphagent/core/v1/session"

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

/** How many errors `classifyToolError` examines along `cause`: the error itself and those that wrap it. */
const MAX_CAUSE_DEPTH = 5

function classOf(error: object): ToolOutcomeKind | undefined {
  for (const key of ["_tag", "name"] as const) {
    const name = identity(error, key)
    if (name !== undefined && Object.hasOwn(OUTCOME_BY_ERROR, name)) return OUTCOME_BY_ERROR[name]
  }
  return undefined
}

/**
 * Class of a tool failure, recorded as the error part's `metadata.outcome`.
 * Errors are told apart by their `_tag` or `name`, so a class that crossed a
 * module or process boundary still matches. A hook that adds feedback, or the
 * bound on a long message, wraps the original error in another one and keeps it
 * as `cause`, so the chain is followed, five errors deep at most and never twice
 * through the same error. Anything else is an execution error.
 */
export function classifyToolError(error: unknown): ToolOutcomeKind {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (typeof current === "object" && current !== null && !seen.has(current) && seen.size < MAX_CAUSE_DEPTH) {
    seen.add(current)
    const kind = classOf(current)
    if (kind) return kind
    current = Reflect.get(current, "cause")
  }
  return "execution_error"
}

/**
 * Metadata for an error part written outside the processor, where a
 * command-driven subtask runs its tool directly: what the call reported while it
 * ran, plus how it ended.
 */
export function endedMetadata(state: SessionV1.ToolPart["state"], outcome: ToolOutcomeKind): Record<string, unknown> {
  return { ...(state.status === "running" ? state.metadata : undefined), outcome }
}

export * as ToolOutcome from "./tool-outcome"
