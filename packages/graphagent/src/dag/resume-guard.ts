// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

export * as ResumeGuard from "./resume-guard"

import { Context, Effect, Option, Schema } from "effect"
import type { WorkflowRow } from "@graphagent/core/dag/store"

/**
 * D12: raised when a workflow may not leave its suspended state through
 * resume/step. Carries the durable pause reason so the workflow tool can
 * explain the refusal to the calling agent.
 */
export class ResumeBlockedError extends Schema.TaggedError<ResumeBlockedError>()("ResumeBlockedError", {
  workflowID: Schema.String,
  pauseReason: Schema.optional(Schema.String),
}) {
  override get message() {
    return this.pauseReason
      ? `Workflow ${this.workflowID} is paused (${this.pauseReason}) and cannot resume until the budget guard allows it`
      : `Workflow ${this.workflowID} cannot resume right now`
  }
}

/**
 * Injectable resume policy. E4 (DagBudget) supplies the real implementation
 * and owns the final contract (which states are resumable, how the budget is
 * queried, how fast `check` must be). PR3 defines only this minimal shape.
 *
 * The policy is looked up lazily via `Effect.serviceOption`, so the Dag layer
 * needs no hard dependency on E4: without a provided policy the guard is
 * fail-open. E4 integration tests must cover the "policy provided and denies"
 * path, because forgetting to inject the layer silently allows resumption.
 */
export interface Policy {
  /** Fail with ResumeBlockedError to veto the transition; succeed to allow. */
  readonly check: (workflow: WorkflowRow) => Effect.Effect<void, ResumeBlockedError>
}

export class Service extends Context.Service<Service, Policy>()("@graphagent/DagResumeGuard") {}

/**
 * Check a resume/step transition against the optional policy. A missing
 * policy allows the transition (default layer semantics without a hard
 * dependency); a present policy's typed failure propagates unchanged.
 */
export const check = (workflow: WorkflowRow): Effect.Effect<void, ResumeBlockedError> =>
  Effect.serviceOption(Service).pipe(
    Effect.flatMap((policy) => (Option.isSome(policy) ? policy.value.check(workflow) : Effect.void)),
  )
