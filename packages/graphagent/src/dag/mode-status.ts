// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1013 (C1 PR5): read-only DAG mode status exposed as
// `GET /session/:sessionID/dag-mode`. The wire shape is fixed by the Issue;
// the availability rules mirror E4's degradation conditions.
import { DagMode } from "@graphagent/schema/dag-mode"
import { WorkflowQuality } from "@graphagent/schema/dag-summary"
import { Schema } from "effect"

export const UnavailableReason = Schema.Literals([
  "start_denied",
  "workflow_tool_disabled",
  "model_no_tool_calling",
  "no_worker",
])
export type UnavailableReason = typeof UnavailableReason.Type

export const Status = Schema.Struct({
  mode: DagMode,
  defaultMode: DagMode,
  availability: Schema.Literals(["available", "unavailable"]),
  unavailableReason: Schema.NullOr(UnavailableReason),
  budget: Schema.Struct({
    tokens: Schema.NullOr(Schema.Finite),
    used: Schema.Finite,
    usedCacheRead: Schema.Finite,
    warnRatio: Schema.Finite,
  }),
  // #1290: each limit comes as the value the engine enforces and the value the
  // user configured (null while unset), so a configured value the engine cuts
  // down can be shown next to what is in force.
  limits: Schema.Struct({
    /**
     * Most DAG nodes running at once across the process: the scheduler's DAG
     * layer, `dag.concurrency` (or its default) cut to the child pool.
     */
    concurrency: Schema.Finite,
    /** `dag.concurrency` in the global configuration; null while unset. */
    configuredConcurrency: Schema.NullOr(Schema.Finite),
    /** Most nodes one workflow may hold: the user's `dag.max_total_nodes`, or its default while unset. */
    maxTotalNodes: Schema.Finite,
    /** `dag.max_total_nodes` in the global configuration; null while unset. */
    configuredMaxTotalNodes: Schema.NullOr(Schema.Finite),
    running: Schema.Finite,
  }),
  // #1027 D6b: the review quality of the session's workflows, combined (the
  // same fields a workflow summary carries); null when no workflow reports one.
  quality: Schema.NullOr(WorkflowQuality),
}).annotate({ identifier: "SessionDagMode" })
export type Status = typeof Status.Type

/** `dag.budget.warn_ratio` default from Issue #1013 §9. */
export const DEFAULT_BUDGET_WARN_RATIO = 0.8

export interface AvailabilityFacts {
  /** `tools.workflow === false` in the merged configuration layer. */
  readonly workflowToolDisabled: boolean
  /** The session's effective agent/session permission rules deny the workflow tool. */
  readonly startDenied: boolean
  /** `undefined` when no model could be resolved. */
  readonly modelToolCalling: boolean | undefined
  /** At least one worker-capable agent exists in the catalog. */
  readonly hasWorker: boolean
}

/**
 * E4 degradation order: an explicit tool switch is reported before the deny
 * rule it produces, then permission, then model capabilities, then worker
 * availability.
 */
export function unavailableReason(facts: AvailabilityFacts): UnavailableReason | null {
  if (facts.workflowToolDisabled) return "workflow_tool_disabled"
  if (facts.startDenied) return "start_denied"
  if (facts.modelToolCalling === false) return "model_no_tool_calling"
  if (facts.modelToolCalling === undefined || !facts.hasWorker) return "no_worker"
  return null
}

export interface TokenUsage {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: {
    readonly read: number
    readonly write: number
  }
}

/**
 * E4 budget accounting: `input + cache.write + output + reasoning`. Cache
 * reads are reported separately and do not consume the budget.
 */
export function sumUsage(usages: Iterable<TokenUsage>): { used: number; usedCacheRead: number } {
  let used = 0
  let usedCacheRead = 0
  for (const usage of usages) {
    used += usage.input + usage.cache.write + usage.output + usage.reasoning
    usedCacheRead += usage.cache.read
  }
  return { used, usedCacheRead }
}

export * as DagModeStatus from "./mode-status"
