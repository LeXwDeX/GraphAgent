// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * What `graphagent providers probe` sends and what it looks for. The probe is a plan of at most six small
 * requests against one OpenAI-compatible endpoint; this file holds the limits and vocabulary the other probe
 * modules share, and imports nothing.
 */

/** Requests in one probe, the `GET /models` request included. */
export const MAX_REQUESTS = 6
/** Output cap of every chat request, except the length probe. */
export const MAX_OUTPUT_TOKENS = 256
/** Output cap of the length probe, small enough that any answer to its prompt is cut off. */
export const LENGTH_PROBE_TOKENS = 16
/** Deadline of one request, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 60_000
/** Longest evidence text on a report line. */
export const EVIDENCE_MAX = 200
/** The tool the tool probe offers. */
export const TOOL_NAME = "probe_echo"

export type Probe = "models" | "stream" | "tool" | "replay_with" | "replay_without" | "length"

/** The probes, in the order they run. Each sends exactly one request, or none when it is skipped. */
export const PROBES: readonly Probe[] = ["models", "stream", "tool", "replay_with", "replay_without", "length"]

/** Keys a `/models` entry may carry its context window under, in the order they are tried. */
export const CONTEXT_KEYS: readonly string[] = [
  "context_length",
  "context_window",
  "max_model_len",
  "max_context_length",
  "max_input_tokens",
  "input_token_limit",
]

export type ReasoningField = "reasoning_content" | "reasoning" | "reasoning_details"

/** Delta fields a response may carry its reasoning under, in the order they are tried. */
export const REASONING_FIELDS: readonly ReasoningField[] = ["reasoning_content", "reasoning", "reasoning_details"]

/** The `finish_reason` values of the OpenAI chat API. Any other value is reported as unknown. */
export const KNOWN_FINISH_REASONS: readonly string[] = [
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "function_call",
]

/** The model under probe, as the analysis and the report need to know it. */
export interface Context {
  readonly providerID: string
  readonly modelID: string
  /** The id the endpoint knows the model by: the entry to look for in `GET /models`. */
  readonly apiID: string
  /** The model's `interleaved` capability as configured, shown next to the measured reasoning field. */
  readonly interleaved: boolean | { readonly field: string }
  /** Every credential text that must never be printed. */
  readonly secrets: readonly string[]
}

export * as ProbePlan from "./plan"
