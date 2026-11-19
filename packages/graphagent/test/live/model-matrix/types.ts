// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The shapes and constants of the model consistency matrix (Issue #1474): what a scenario is, what a run leaves
 * behind for its judge, and the numbers both tiers share.
 *
 * Two tiers run the same scenarios. The replay tier (`replay.test.ts`, part of `bun test`) answers every model
 * request from a script, so the real session runtime and the real tools are exercised without a model and the
 * wording of what a tool returns is checked. The live tier (`run.ts`, run by hand) asks the configured QWEN, GLM
 * and DeepSeek models and judges only what they achieved.
 */

import type { Reply } from "../lib/script-server"

export type { Reply }

/** Runs per (model, scenario) cell in the live tier. */
export const RUNS_PER_CELL = 3
/** Runs of a cell that must pass (or must error) for its verdict. */
export const PASS_MIN = 2
/** Model steps a run may take: `agent.build.steps` of the host. */
export const STEPS = 8
export const TURN_TIMEOUT_MS = 360_000
/** Runs in flight at once on one host. */
export const CONCURRENCY = 3

/**
 * A scripted conversation. `replies` are the turns of the model; `trap` and `contract` are checked in the replay
 * tier only (a live model may never make the mistake a trap waits for) and constrain two different kinds of call:
 *
 * - `trap`: counting every call from 0, call number `call` must be a failure whose text holds every `includes`
 *   entry (an empty list only asks for the failure);
 * - `contract`: for each entry, `tool` has at least one completed call whose result holds every `includes` entry.
 *   A call the trap caught failed, so it does not count here.
 */
export interface Script {
  readonly replies: readonly Reply[]
  readonly trap?: { readonly call: number; readonly includes: readonly (string | RegExp)[] }
  readonly contract?: readonly { readonly tool: string; readonly includes: readonly (string | RegExp)[] }[]
}

/** The edit tools differ by model family: `default` has `edit` and `write`, `apply_patch` has only `apply_patch`. */
export type ScriptFamily = "default" | "apply_patch"

export interface Call {
  readonly tool: string
  readonly input: Record<string, unknown>
  readonly status: "completed" | "error"
  /** The #1473 outcome: one of `TOOL_OUTCOME_KINDS`. */
  readonly outcome: string
  /** `state.output` of a completed call, `state.error` of a failed one; see `clipToolText` for the cap. */
  readonly text: string
}

/** What a run leaves for its judge. */
export interface RunView {
  /** Every file of the workspace after the run except `.git`, by path, each cut to its first 20000 characters. */
  readonly files: Record<string, string>
  /** In message order, and in part order within a message. */
  readonly calls: readonly Call[]
  /** The last non-synthetic assistant text. */
  readonly reply: string
  readonly todos: readonly { content: string; status: string }[]
  /** Child sessions the run started. */
  readonly children: number
}

export interface Scenario {
  readonly id: string
  /** The workspace before the run, by relative path. */
  readonly files: Record<string, string>
  /** The user message, verbatim. The replay tier adds a `[case <id>]` line after it. */
  readonly prompt: string
  readonly scripts: { readonly default: Script; readonly apply_patch?: Script }
  /** The criteria the run did not meet, in words (`reply: missing "4200"`); empty means the run passed. */
  readonly judge: (run: RunView) => string[]
}
