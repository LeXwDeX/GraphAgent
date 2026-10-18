import type { DynamicResolution } from "../../config/compaction"
import type { CandidateSkipReason, ContextFoldingProjectionPlan, FoldPlan } from "./types"
import { ContextFoldingPolicy } from "./policy"

export type ContextFoldingRuntime = "opencode-ai-sdk" | "opencode-native" | "core-runner"
export type ContextFoldingPurpose = "conversation" | "compaction" | "auxiliary" | "unknown"

type UnknownNumber = number | "unknown"
type UnknownBoolean = boolean | "unknown"
type ExclusionCounts = Readonly<Record<CandidateSkipReason, number>>

const emptyExclusionCounts = (): Record<CandidateSkipReason, number> => ({
  attachments: 0,
  "incomplete-content": 0,
  "instruction-content": 0,
  "invalid-provenance": 0,
  "normalization-failed": 0,
  "provider-executed": 0,
  "unknown-content": 0,
  "unknown-read-target": 0,
  "unsafe-error-payload": 0,
  unsuccessful: 0,
  "unsupported-tool": 0,
  "untrusted-source": 0,
})

const exclusionCounts = (plan: FoldPlan | undefined): ExclusionCounts | "unknown" => {
  if (!plan) return "unknown"
  const counts = emptyExclusionCounts()
  for (const exclusion of plan.exclusions) {
    // Only the fixed reason vocabulary can enter logs, even if a caller supplies a malformed plan.
    if (Object.hasOwn(counts, exclusion.reason)) counts[exclusion.reason]++
  }
  return counts
}

export type ContextFoldingDiagnostic = Readonly<{
  policyVersion: typeof ContextFoldingPolicy.version
  runtime: ContextFoldingRuntime
  requestPurpose: ContextFoldingPurpose
  enabledSource: DynamicResolution["source"]
  configured: boolean
  enabled: boolean
  externalDcp: DynamicResolution["externalDcp"]
  applied: boolean
  duplicateGroups: UnknownNumber
  foldedOutputs: number
  excludedOutputs: UnknownNumber
  excludedByReason: ExclusionCounts | "unknown"
  protectedSteps: UnknownNumber
  estimatedBefore: UnknownNumber
  estimatedAfter: UnknownNumber
  estimatedSavings: UnknownNumber
  targetTokens: UnknownNumber
  overBudget: UnknownBoolean
  skipReason: string
}>

const numberOrUnknown = (value: number | undefined): UnknownNumber => value ?? "unknown"

/**
 * Builds the complete allow-listed context-folding log payload. The input types intentionally exclude requests,
 * messages, tool inputs, paths, fingerprints, and plugin specs so callers cannot accidentally log content.
 */
export function contextFoldingDiagnostic(input: {
  readonly runtime: ContextFoldingRuntime
  readonly requestPurpose: ContextFoldingPurpose
  readonly resolution: DynamicResolution
  readonly duplicatePlan?: FoldPlan
  readonly projectionPlan?: ContextFoldingProjectionPlan
}): ContextFoldingDiagnostic {
  const before = input.projectionPlan?.estimatedBefore
  const after = input.projectionPlan?.estimatedAfter
  const witnesses = input.duplicatePlan
    ? new Set(input.duplicatePlan.replacements.map((replacement) => JSON.stringify(replacement.witness))).size
    : input.projectionPlan
      ? new Set(input.projectionPlan.replacements.map((replacement) => JSON.stringify(replacement.witness))).size
      : undefined
  const policySkip = input.resolution.skipped
  const purposeSkip = input.requestPurpose === "conversation" ? undefined : "non-conversation"
  const evaluation = input.projectionPlan ? (input.projectionPlan.skipReason ?? "none") : "not-evaluated"
  const skipReason = policySkip ?? purposeSkip ?? evaluation

  return {
    policyVersion: ContextFoldingPolicy.version,
    runtime: input.runtime,
    requestPurpose: input.requestPurpose,
    enabledSource: input.resolution.source,
    configured: input.resolution.configured,
    enabled: input.resolution.enabled,
    externalDcp: input.resolution.externalDcp,
    applied: (input.projectionPlan?.replacements.length ?? 0) > 0,
    duplicateGroups: witnesses ?? "unknown",
    foldedOutputs: input.projectionPlan?.replacements.length ?? 0,
    excludedOutputs: input.duplicatePlan?.exclusions.length ?? "unknown",
    excludedByReason: exclusionCounts(input.duplicatePlan),
    protectedSteps: numberOrUnknown(input.duplicatePlan?.protectedStepIDs.length),
    estimatedBefore: numberOrUnknown(before),
    estimatedAfter: numberOrUnknown(after),
    estimatedSavings: before === undefined || after === undefined ? "unknown" : Math.max(0, before - after),
    targetTokens: numberOrUnknown(input.projectionPlan?.targetTokens),
    overBudget: input.projectionPlan?.overBudget ?? "unknown",
    skipReason,
  }
}
