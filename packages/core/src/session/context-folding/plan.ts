import { Hash } from "../../util/hash"
import { normalizeParameters, type NormalizedParameters } from "./normalize"
import { ContextFoldingPolicy } from "./policy"
import {
  consumeContainerEntries,
  consumeOutputCharacters,
  consumeString,
  createWorkBudget,
  type WorkBudget,
} from "./work-budget"
import type {
  CandidateExclusion,
  CandidateResult,
  CandidateSkipReason,
  FoldCandidate,
  FoldPlan,
  FoldRef,
  FoldReplacement,
  FoldStep,
  PlannerDependencies,
  PlanSkipReason,
} from "./types"

type PreparedCandidate = Readonly<{
  candidate: FoldCandidate
  normalizedInput: string
  normalizedResultMetadata: string
  sequence: number
  stepIndex: number
  taskEpoch: number
}>

const allowedTools = new Set<string>(ContextFoldingPolicy.allowedTools)
const protectedInstructionBasenames = new Set<string>(ContextFoldingPolicy.protectedInstructionBasenames)

const copyRef = (ref: FoldRef): FoldRef => ({
  messageID: ref.messageID,
  partID: ref.partID,
  callID: ref.callID,
})

const emptyPlan = (
  skipReason: PlanSkipReason,
  protectedStepIDs: readonly string[] = [],
  exclusions: readonly CandidateExclusion[] = [],
): FoldPlan => ({
  replacements: [],
  protectedStepIDs: [...protectedStepIDs],
  exclusions: [...exclusions],
  skipReason,
})

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0
const exactlyTrue = (value: unknown): value is true => value === true

const normalizeComparisonMetadata = (result: CandidateResult, budget: WorkBudget): NormalizedParameters => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(result, "comparisonMetadata")
    if (!descriptor) return { ok: true, value: "absent;" }
    if (!("value" in descriptor)) return { ok: false }
    const normalized = normalizeParameters(descriptor.value, budget)
    if (!normalized.ok) return normalized
    return { ok: true, value: `present:${normalized.value}` }
  } catch {
    return { ok: false }
  }
}

const identityPart = (value: string) => `${value.length}:${value}`
const refKey = (ref: FoldRef) => `${identityPart(ref.messageID)}${identityPart(ref.partID)}${identityPart(ref.callID)}`

const stepIDsOrEmpty = (steps: readonly FoldStep[]): readonly string[] => {
  try {
    return steps.map((step) => step.id)
  } catch {
    return []
  }
}

const validateStructure = (steps: readonly FoldStep[], budget: WorkBudget): PlanSkipReason | undefined => {
  if (!Array.isArray(steps)) return "invalid-structure"
  if (steps.length > ContextFoldingPolicy.maximumSteps || !consumeContainerEntries(budget, steps.length)) {
    return "work-limit"
  }

  const stepIDs = new Set<string>()
  const refs = new Set<string>()
  let candidateCount = 0

  try {
    for (const step of steps) {
      if (!nonEmpty(step.id) || stepIDs.has(step.id) || !Array.isArray(step.candidates)) return "invalid-structure"
      if (!consumeString(budget, step.id)) return "work-limit"
      stepIDs.add(step.id)

      if (!Number.isSafeInteger(step.estimatedTokens) || step.estimatedTokens < 0) return "unknown-step-tokens"
      candidateCount += step.candidates.length
      if (
        !Number.isSafeInteger(candidateCount) ||
        candidateCount > ContextFoldingPolicy.maximumCandidates ||
        !consumeContainerEntries(budget, step.candidates.length)
      ) {
        return "work-limit"
      }

      for (const candidate of step.candidates) {
        if (
          !candidate ||
          !candidate.ref ||
          !nonEmpty(candidate.ref.messageID) ||
          !nonEmpty(candidate.ref.partID) ||
          !nonEmpty(candidate.ref.callID)
        ) {
          return "invalid-structure"
        }
        if (
          !consumeString(budget, candidate.ref.messageID) ||
          !consumeString(budget, candidate.ref.partID) ||
          !consumeString(budget, candidate.ref.callID)
        ) {
          return "work-limit"
        }
        if (
          candidate.taskEpoch !== undefined &&
          (!Number.isSafeInteger(candidate.taskEpoch) || candidate.taskEpoch < 0)
        ) {
          return "invalid-structure"
        }
        const key = refKey(candidate.ref)
        if (refs.has(key)) return "invalid-structure"
        refs.add(key)
      }
    }
  } catch {
    return budget.exceeded ? "work-limit" : "invalid-structure"
  }

  return undefined
}

const recentProtection = (steps: readonly FoldStep[]): ReadonlySet<number> | undefined => {
  const protectedIndexes = new Set<number>()
  let protectedTokens = 0
  let protectedSteps = 0

  for (
    let index = steps.length - 1;
    index >= 0 &&
    (protectedSteps < ContextFoldingPolicy.protectRecentSteps ||
      protectedTokens < ContextFoldingPolicy.protectRecentTokens);
    index--
  ) {
    const tokens = steps[index].estimatedTokens
    if (!Number.isSafeInteger(protectedTokens + tokens)) return undefined
    protectedTokens += tokens
    protectedSteps++
    protectedIndexes.add(index)
  }

  return protectedIndexes
}

const readTargetIsProtected = (candidate: FoldCandidate): boolean | undefined => {
  if (candidate.toolName !== "read") return false
  if (!nonEmpty(candidate.targetPath)) return undefined
  const basename = candidate.targetPath.split(/[\\/]/).at(-1)?.toLowerCase()
  if (!basename) return undefined
  return protectedInstructionBasenames.has(basename)
}

const exclusionReason = (candidate: FoldCandidate): CandidateSkipReason | undefined => {
  try {
    if (!allowedTools.has(candidate.toolName)) return "unsupported-tool"
    if (candidate.source.sourceKind !== "host-builtin") return "untrusted-source"
    if (
      !nonEmpty(candidate.source.sessionID) ||
      candidate.source.assistantMessageID !== candidate.ref.messageID ||
      candidate.source.callID !== candidate.ref.callID ||
      candidate.source.toolName !== candidate.toolName ||
      !nonEmpty(candidate.source.registrationID) ||
      !nonEmpty(candidate.source.registrationGeneration)
    ) {
      return "invalid-provenance"
    }
    if (candidate.status !== "completed" && candidate.status !== "error") return "unsuccessful"
    if (candidate.safety.attachments !== "none") return "attachments"
    if (candidate.safety.instructions !== "none") return "instruction-content"
    if (candidate.safety.providerExecuted !== false) return "provider-executed"

    const protectedTarget = readTargetIsProtected(candidate)
    if (protectedTarget === undefined) return "unknown-read-target"
    if (protectedTarget) return "instruction-content"

    if (candidate.status === "error") {
      // Errors are foldable only as a complete, class-tagged payload. An adapter that cannot prove the full
      // visible error fails closed instead of letting a partial payload share a text identity.
      if (
        candidate.result.kind !== "error" ||
        typeof candidate.result.text !== "string" ||
        typeof candidate.result.failureClass !== "string" ||
        candidate.result.failureClass.length === 0 ||
        !candidate.result.complete
      ) {
        return "unsafe-error-payload"
      }
      return undefined
    }

    if (candidate.result.kind !== "text" || typeof candidate.result.text !== "string") return "unknown-content"
    if (!exactlyTrue(candidate.result.complete)) return "incomplete-content"
  } catch {
    return "unknown-content"
  }

  return undefined
}

const chargeCandidateStrings = (candidate: FoldCandidate, budget: WorkBudget) => {
  const values = [
    candidate.toolName,
    candidate.source.sessionID,
    candidate.source.assistantMessageID,
    candidate.source.callID,
    candidate.source.toolName,
    candidate.source.sourceKind,
    candidate.source.registrationID,
    candidate.source.registrationGeneration,
    candidate.status,
    candidate.safety.attachments,
    candidate.safety.instructions,
    String(candidate.safety.providerExecuted),
  ]
  if (typeof candidate.targetPath === "string") values.push(candidate.targetPath)
  if (candidate.result.kind === "text") values.push(candidate.result.text)
  if (candidate.result.kind === "error") values.push(candidate.result.text, candidate.result.failureClass)
  return values.every((value) => consumeString(budget, value))
}

const resultIdentityClass = (result: CandidateResult) =>
  result.kind === "error" ? `error:${result.failureClass}` : result.kind

const exactIdentity = (prepared: PreparedCandidate, budget: WorkBudget): string | undefined => {
  const { candidate, normalizedInput, normalizedResultMetadata } = prepared
  if (candidate.result.kind !== "text" && candidate.result.kind !== "error")
    throw new Error("prepared candidate must contain a foldable result")
  const parts = [
    resultIdentityClass(candidate.result),
    candidate.toolName,
    candidate.source.sessionID,
    candidate.source.sourceKind,
    candidate.source.registrationID,
    candidate.source.registrationGeneration,
    normalizedInput,
    normalizedResultMetadata,
    candidate.result.text,
  ]
  const length = parts.reduce((total, part) => total + String(part.length).length + 1 + part.length, 0)
  if (!Number.isSafeInteger(length) || !consumeOutputCharacters(budget, length)) return undefined
  return parts.map(identityPart).join("")
}

/**
 * Finds safe duplicate relationships without applying them. The caller remains responsible for S03 budget selection,
 * placeholder construction, mapping validation, and atomic request projection.
 */
const plan = (steps: readonly FoldStep[], dependencies: PlannerDependencies): FoldPlan => {
  const budget = createWorkBudget(ContextFoldingPolicy.workLimits)
  const structureError = validateStructure(steps, budget)
  if (structureError) {
    const protectedStepIDs = structureError === "unknown-step-tokens" ? stepIDsOrEmpty(steps) : []
    return emptyPlan(structureError, protectedStepIDs)
  }

  const protectedIndexes = recentProtection(steps)
  if (!protectedIndexes) return emptyPlan("unknown-step-tokens", stepIDsOrEmpty(steps))
  const protectedStepIDs = [...protectedIndexes].sort((a, b) => a - b).map((index) => steps[index].id)

  const exclusions: CandidateExclusion[] = []
  const prepared: PreparedCandidate[] = []
  let sequence = 0

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    for (const candidate of steps[stepIndex].candidates) {
      if (!chargeCandidateStrings(candidate, budget)) return emptyPlan("work-limit", protectedStepIDs, exclusions)
      const reason = exclusionReason(candidate)
      if (reason) {
        exclusions.push({ ref: copyRef(candidate.ref), reason })
        sequence++
        continue
      }

      let normalizedInput: NormalizedParameters
      let normalizedResultMetadata: NormalizedParameters
      try {
        normalizedInput = normalizeParameters(candidate.input, budget)
        normalizedResultMetadata = normalizeComparisonMetadata(candidate.result, budget)
      } catch {
        normalizedInput = { ok: false }
        normalizedResultMetadata = { ok: false }
      }
      if (budget.exceeded) return emptyPlan("work-limit", protectedStepIDs, exclusions)
      if (!normalizedInput.ok || !normalizedResultMetadata.ok) {
        exclusions.push({ ref: copyRef(candidate.ref), reason: "normalization-failed" })
        sequence++
        continue
      }

      prepared.push({
        candidate,
        normalizedInput: normalizedInput.value,
        normalizedResultMetadata: normalizedResultMetadata.value,
        sequence,
        stepIndex,
        taskEpoch: candidate.taskEpoch ?? 0,
      })
      sequence++
    }
  }

  const fingerprint = dependencies.fingerprint ?? Hash.sha256
  const buckets = new Map<string, Map<string, PreparedCandidate[]>>()
  const bucketEntries = new Map<string, number>()

  try {
    for (const item of prepared) {
      // The fingerprint only narrows the bucket. The complete identity string (including the full body) is compared next.
      const identity = exactIdentity(item, budget)
      if (identity === undefined) return emptyPlan("work-limit", protectedStepIDs, exclusions)
      const hash = fingerprint(identity)
      if (typeof hash !== "string") throw new Error("fingerprint must be a string")
      if (hash.length > ContextFoldingPolicy.maximumFingerprintCharacters) {
        return emptyPlan("work-limit", protectedStepIDs, exclusions)
      }
      const nextBucketEntries = (bucketEntries.get(hash) ?? 0) + 1
      if (nextBucketEntries > ContextFoldingPolicy.maximumFingerprintBucketEntries) {
        return emptyPlan("work-limit", protectedStepIDs, exclusions)
      }
      bucketEntries.set(hash, nextBucketEntries)
      const bucket = buckets.get(hash) ?? new Map<string, PreparedCandidate[]>()
      const group = bucket.get(identity) ?? []
      group.push(item)
      bucket.set(identity, group)
      buckets.set(hash, bucket)
    }
  } catch {
    return emptyPlan(budget.exceeded ? "work-limit" : "fingerprint-failed", protectedStepIDs, exclusions)
  }

  const replacements: Array<FoldReplacement & { readonly sequence: number }> = []
  let duplicateGroups = 0
  // The latest adapter-supplied epoch is the current task. Its duplicate sources are the "anchor": exact folding
  // keeps them semantically intact, but selection uses them only after unrelated-task duplicates.
  const latestTaskEpoch = prepared.reduce((latest, item) => Math.max(latest, item.taskEpoch), 0)

  for (const bucket of buckets.values()) {
    for (const group of bucket.values()) {
      if (group.length < 2) continue
      duplicateGroups++
      const witness = group.at(-1)!

      for (const source of group.slice(0, -1)) {
        if (protectedIndexes.has(source.stepIndex)) continue
        replacements.push({
          source: copyRef(source.candidate.ref),
          witness: copyRef(witness.candidate.ref),
          resultKind: source.candidate.result.kind === "error" ? "error" : "text",
          anchor: source.taskEpoch === latestTaskEpoch,
          sequence: source.sequence,
        })
      }
    }
  }

  replacements.sort((a, b) => a.sequence - b.sequence)
  if (replacements.length === 0) {
    return emptyPlan(
      duplicateGroups > 0 ? "all-sources-protected" : "no-eligible-duplicates",
      protectedStepIDs,
      exclusions,
    )
  }

  return {
    replacements: replacements.map(({ source, witness, resultKind, anchor }) => ({
      source,
      witness,
      resultKind,
      anchor,
    })),
    protectedStepIDs,
    exclusions,
    skipReason: undefined,
  }
}

export const planContextFolding = (steps: readonly FoldStep[], dependencies: PlannerDependencies = {}): FoldPlan => {
  try {
    return plan(steps, dependencies)
  } catch {
    return emptyPlan("invalid-structure")
  }
}
