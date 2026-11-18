// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Agent } from "@/agent/agent"
import PROMPT_ANALYSIS from "./prompt/analysis.txt"

export const NAME = "loop-steer"

/**
 * The hidden agent behind the loop's background analysis (#1328).
 *
 * It is a module constant, not an entry of the agent catalog: nothing can configure, list or select it, and
 * the model and thinking tier come from the session at run time (`LoopAnalysis`), never from here. Its
 * tools are assembled per run (`LoopTools`), read-only plus `submit_analysis`, and enforce their own
 * limits (steps and wall clock), so the catalog's permission rules do not apply.
 */
export const AGENT: Agent.Info = {
  name: NAME,
  mode: "primary",
  native: true,
  hidden: true,
  permission: [],
  options: {},
  prompt: PROMPT_ANALYSIS,
}

export * as LoopAgent from "./agent"
