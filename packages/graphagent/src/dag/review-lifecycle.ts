// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagReviewLifecycle from "./review-lifecycle"

import type { NodeConfig, WorkflowConfig } from "./dag"
import type { PriorFinding } from "./blocks"
import { isReadOnlyProfile } from "./blocks"
import { evaluateCondition } from "./runtime/eval"
import { normalizeOutput, verdictField } from "./runtime/verdict"

/** `grandfathered`: review nodes carried with a persisted definition (runtime
 * replan/extend/recover). Their PASS gate keeps the pre-evaluation textual check it
 * was accepted under, so a gate such as `verify.output.status == PASS` on an
 * existing — possibly terminal, unfixable — review never blocks later
 * mutations. Newly authored reviews always get the evaluated check. */
export function validateReviewLifecycle(
  config: WorkflowConfig,
  options: { grandfathered?: ReadonlySet<string> } = {},
) {
  // Deep mode always implies the strict gate; a standard-mode workflow can opt
  // into the same requirements with config.review_gate. The gate is fixed at
  // run.start, so later mutations validate against this persisted value.
  const strict = config.mode === "deep" || config.review_gate === "strict"
  const issues = config.nodes.flatMap((node) => {
    if (!node.review) {
      if (!isReviewWorker(node.worker_type)) return []
      if (!strict) return []
      return [`${node.id}: deep review worker must declare review.phase as "design" or "diff"`]
    }
    if (node.review.phase === "design") return []
    return [
      ...validateDiffReview(config, node.id, options.grandfathered?.has(node.id) ?? false),
      ...(strict ? validateFinalReviewGate(config, node.id) : []),
    ]
  })

  if (!strict) {
    return { valid: true, errors: [], warnings: issues }
  }
  return { valid: issues.length === 0, errors: issues, warnings: [] }
}

export function validateReviewExecutionInput(
  node: NodeConfig,
  resolvedMapping: Record<string, unknown>,
) {
  if (!node.review || node.review.phase === "design") {
    return {
      valid: true,
      phase: node.review?.phase,
      satisfies_diff_gate: false,
      errors: [],
    }
  }

  const implementationID = node.review.implementation_node_id
  const verificationID = node.review.verification_node_id
  const entries = Object.entries(node.input_mapping ?? {})
  const implementationKey = entries.find(([, source]) => {
    const [sourceID, output, field] = source.split(".")
    return sourceID === implementationID
      && output === "output"
      && field !== undefined
      && ["diff", "patch", "changed_files"].includes(field)
  })?.[0]
  const fingerprintKey = entries.find(([, source]) => {
    const [sourceID, output, field] = source.split(".")
    return sourceID === implementationID && output === "output" && field === "fingerprint"
  })?.[0]
  const verificationKey = entries.find(([, source]) => source.split(".")[0] === verificationID)?.[0]
  const errors = [
    ...(hasEvidence(implementationKey ? resolvedMapping[implementationKey] : undefined)
      ? []
      : [`${node.id}: implementation evidence is empty or unresolved`]),
    ...(hasEvidence(fingerprintKey ? resolvedMapping[fingerprintKey] : undefined)
      ? []
      : [`${node.id}: implementation fingerprint is empty or unresolved`]),
    ...(hasPassVerdict(verificationKey ? resolvedMapping[verificationKey] : undefined)
      ? []
      : [`${node.id}: verification evidence must contain verdict PASS`]),
  ]
  return {
    valid: errors.length === 0,
    phase: "diff" as const,
    satisfies_diff_gate: errors.length === 0,
    errors,
  }
}

export function reviewImplementationFingerprint(
  node: Pick<NodeConfig, "review" | "input_mapping">,
  resolvedMapping: Record<string, unknown>,
) {
  if (node.review?.phase !== "diff") return undefined
  const implementationID = node.review.implementation_node_id
  const fingerprintKey = Object.entries(node.input_mapping ?? {}).find(([, source]) => {
    const [sourceID, output, field] = source.split(".")
    return sourceID === implementationID && output === "output" && field === "fingerprint"
  })?.[0]
  const fingerprint = fingerprintKey ? resolvedMapping[fingerprintKey] : undefined
  return typeof fingerprint === "string" && fingerprint.trim() !== ""
    ? fingerprint
    : undefined
}

/**
 * Mapping keys that carry raw implementation artifacts for a diff review
 * (diff / patch / changed_files from the declared implementation node).
 * These must reach the reviewer VERBATIM — the destructive sanitizer corrupts
 * diffs that legitimately contain code fences or "system:" lines, so the
 * spawn path exempts these keys from sanitize (P1-2).
 */
export function reviewEvidenceKeys(node: NodeConfig): string[] {
  if (node.review?.phase !== "diff") return []
  const implementationID = node.review.implementation_node_id
  return Object.entries(node.input_mapping ?? {})
    .filter(([, source]) => {
      const [sourceID, output, field] = source.split(".")
      return sourceID === implementationID
        && output === "output"
        && field !== undefined
        && ["diff", "patch", "changed_files"].includes(field)
    })
    .map(([key]) => key)
}

export function validateReviewResult(output: unknown, currentFingerprint: string) {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return {
      valid: false,
      action: "invalidate" as const,
      reviewed_fingerprint: "",
      errors: ["review result must be a structured object"],
    }
  }

  const verdict = "verdict" in output ? output.verdict : undefined
  const fingerprint = "implementation_fingerprint" in output
    ? output.implementation_fingerprint
    : undefined
  const reviewedFingerprint = typeof fingerprint === "string" ? fingerprint : ""
  const errors = [
    ...(["ACCEPT", "REJECT"].includes(typeof verdict === "string" ? verdict : "")
      ? []
      : ["review result verdict must be ACCEPT or REJECT"]),
    ...(reviewedFingerprint.trim() === ""
      ? ["review result must include implementation_fingerprint"]
      : reviewedFingerprint.trim() === currentFingerprint.trim()
        ? []
        : [`review result fingerprint ${reviewedFingerprint} does not match current implementation ${currentFingerprint}`]),
  ]
  return {
    valid: errors.length === 0,
    action: errors.length > 0
      ? "invalidate" as const
      : verdict === "ACCEPT"
        ? "proceed" as const
        : "correct" as const,
    reviewed_fingerprint: reviewedFingerprint,
    errors,
  }
}

/** A completed direct dependency whose structured output may raise required actions. */
export interface VerdictEvidence {
  nodeID: string
  output: unknown
}

/**
 * ACCEPT means nothing blocking remains. A structured verdict output that says
 * ACCEPT must therefore carry no required_actions of its own, and every
 * required action raised by a structured evidence dependency (review lanes)
 * must be listed in `refuted` as { node, index, reason }. Anything else is a
 * silent gate opening, so settlement rejects it like a fingerprint mismatch.
 * Non-ACCEPT verdicts and free-text (unstructured) evidence are not constrained.
 */
export function acceptConsistencyErrors(output: unknown, evidence: readonly VerdictEvidence[] = []): string[] {
  const result = structuredRecord(output)
  if (result?.verdict !== "ACCEPT") return []
  const own = Array.isArray(result.required_actions) ? result.required_actions.length : 0
  const refuted = (Array.isArray(result.refuted) ? result.refuted : []).flatMap((entry) => {
    const item = structuredRecord(entry)
    return item && typeof item.reason === "string" && item.reason.trim() !== "" ? [item] : []
  })
  const unrefuted = evidence.flatMap((item) => {
    const raised = structuredRecord(item.output)?.required_actions
    if (!Array.isArray(raised)) return []
    return raised.flatMap((_, index) =>
      refuted.some((entry) => entry.node === item.nodeID && entry.index === index) ? [] : [`${item.nodeID}[${index}]`],
    )
  })
  return [
    ...(own > 0 ? [`ACCEPT must not list required_actions (${own} listed); submit REJECT instead`] : []),
    ...(unrefuted.length > 0
      ? [
          `ACCEPT leaves required actions unrefuted: ${unrefuted.join(", ")}; refute each as { node, index, reason } or submit REJECT`,
        ]
      : []),
  ]
}

/** Cross-round arbitration context: the prior findings a block-compiled
 * decision resolves and the strict-gate lane completeness requirement. */
export interface ArbitrationOptions {
  /** Findings carried from the referenced prior round (engine-resolved). */
  priorFindings?: readonly PriorFinding[]
  /** The workflow runs under the strict review gate. */
  strict?: boolean
  /** Lens/skeptic lanes of this decision that did not complete. */
  incompleteReviewLanes?: readonly string[]
}

interface Disposition {
  node: string
  index: number
  novelty: "new" | { dup_of: string }
  decision: "upheld" | "refuted"
}

interface Resolution {
  ref: string
  how: "fixed" | "refuted" | "still_open"
}

const keyOf = (node: string, index: number) => `${node}\u0000${index}`

function dispositionRecord(value: unknown): Disposition | undefined {
  const item = structuredRecord(value)
  const index = item?.index
  if (!item || typeof item.node !== "string" || typeof index !== "number" || !Number.isInteger(index))
    return undefined
  const decision = item.decision
  if (decision !== "upheld" && decision !== "refuted") return undefined
  const novelty = item.novelty
  if (novelty === "new") return { node: item.node, index, novelty, decision }
  const duplicate = structuredRecord(novelty)
  if (duplicate && typeof duplicate.dup_of === "string")
    return { node: item.node, index, novelty: { dup_of: duplicate.dup_of }, decision }
  return undefined
}

function resolutionRecord(value: unknown): Resolution | undefined {
  const item = structuredRecord(value)
  if (!item || typeof item.ref !== "string") return undefined
  if (item.how !== "fixed" && item.how !== "refuted" && item.how !== "still_open") return undefined
  return { ref: item.ref, how: item.how }
}

/**
 * Cross-round arbitration contract (#1031 M6). A block-compiled review decision
 * submits dispositions for every required action the lanes raised — regardless
 * of its verdict — and resolved for every prior finding. The runtime rejects
 * missing and dangling entries; an ACCEPT additionally rejects an upheld
 * disposition, any still-open resolution, and a duplicate of a still-open prior
 * finding. Under the strict gate an ACCEPT also requires every lane to have
 * completed.
 */
export function arbitrationConsistencyErrors(
  output: unknown,
  evidence: readonly VerdictEvidence[] = [],
  options: ArbitrationOptions = {},
): string[] {
  const result = structuredRecord(output)
  if (!result) return []
  const errors: string[] = []
  const rawDispositions = Array.isArray(result.dispositions) ? result.dispositions : undefined
  const rawResolved = Array.isArray(result.resolved) ? result.resolved : undefined
  if (rawDispositions === undefined)
    errors.push("decision must submit dispositions covering every lane required action")
  if (rawResolved === undefined) errors.push("decision must submit resolved covering every prior finding")

  const expectedActions = evidence.flatMap((item) => {
    const raised = structuredRecord(item.output)?.required_actions
    return Array.isArray(raised) ? raised.map((_, index) => keyOf(item.nodeID, index)) : []
  })
  const expectedSet = new Set(expectedActions)
  const dispositions = (rawDispositions ?? []).map(dispositionRecord)
  const malformed = dispositions.filter((item) => item === undefined).length
  if (malformed > 0)
    errors.push(
      `${malformed} disposition(s) are malformed; each needs { node, index, novelty: "new" or { dup_of }, decision: upheld|refuted, evidence }`,
    )
  const validDispositions = dispositions.filter((item): item is Disposition => item !== undefined)
  const dispositionKeys = validDispositions.map((item) => keyOf(item.node, item.index))
  const repeatedActions = uniqueKeys(dispositionKeys)
  if (repeatedActions.length > 0)
    errors.push(`dispositions repeat lane action(s): ${readableKeys(repeatedActions)}`)
  const dispositionSet = new Set(dispositionKeys)
  const missingDispositions = [...expectedSet].filter((key) => !dispositionSet.has(key))
  if (missingDispositions.length > 0)
    errors.push(`dispositions miss lane required action(s): ${readableKeys(missingDispositions)}`)
  const unknownDispositions = [...dispositionSet].filter((key) => !expectedSet.has(key))
  if (unknownDispositions.length > 0)
    errors.push(`dispositions name unknown lane required action(s): ${readableKeys(unknownDispositions)}`)

  const priorRefs = new Set((options.priorFindings ?? []).map((finding) => finding.ref))
  const danglingDuplicates = validDispositions.flatMap((item) =>
    typeof item.novelty === "object" && !priorRefs.has(item.novelty.dup_of) ? [item.novelty] : [],
  )
  if (danglingDuplicates.length > 0)
    errors.push(
      `dispositions name dup_of ref(s) that are not prior findings: ${danglingDuplicates.map((item) => item.dup_of).join(", ")}`,
    )

  const resolved = (rawResolved ?? []).map(resolutionRecord)
  const malformedResolved = resolved.filter((item) => item === undefined).length
  if (malformedResolved > 0)
    errors.push(`${malformedResolved} resolved entr(y/ies) are malformed; each needs { ref, how: fixed|refuted|still_open, evidence }`)
  const validResolved = resolved.filter((item): item is Resolution => item !== undefined)
  const resolvedRefs = validResolved.map((item) => item.ref)
  const repeatedResolved = uniqueKeys(resolvedRefs)
  if (repeatedResolved.length > 0) errors.push(`resolved repeats prior finding ref(s): ${repeatedResolved.join(", ")}`)
  const resolvedSet = new Set(resolvedRefs)
  const missingResolved = [...priorRefs].filter((ref) => !resolvedSet.has(ref))
  if (missingResolved.length > 0) errors.push(`resolved misses prior finding(s): ${missingResolved.join(", ")}`)
  const unknownResolved = [...resolvedSet].filter((ref) => !priorRefs.has(ref))
  if (unknownResolved.length > 0) errors.push(`resolved names ref(s) that are not prior findings: ${unknownResolved.join(", ")}`)

  const verdict = result.verdict === "ACCEPT" ? "ACCEPT" : undefined
  if (verdict === "ACCEPT") {
    const upheld = validDispositions
      .filter((item) => item.decision === "upheld")
      .map((item) => `${item.node}[${item.index}]`)
    if (upheld.length > 0)
      errors.push(`ACCEPT upholds finding(s) ${upheld.join(", ")}; fix them or submit a non-ACCEPT verdict`)
    const open = validResolved.filter((item) => item.how === "still_open").map((item) => item.ref)
    if (open.length > 0) errors.push(`ACCEPT leaves prior finding(s) still open: ${open.join(", ")}`)
    const openRefs = new Set(open)
    const duplicatesOfOpen = validDispositions.flatMap((item) =>
      typeof item.novelty === "object" && openRefs.has(item.novelty.dup_of)
        ? [`${item.node}[${item.index}] duplicates still-open ${item.novelty.dup_of}`]
        : [],
    )
    if (duplicatesOfOpen.length > 0)
      errors.push(`ACCEPT hides still-open work behind duplicates: ${duplicatesOfOpen.join(", ")}`)
    const incomplete = options.strict ? [...(options.incompleteReviewLanes ?? [])] : []
    if (incomplete.length > 0)
      errors.push(
        `ACCEPT requires every review lane to complete under the strict gate; not completed: ${incomplete.join(", ")}. Submit BLOCKED or REJECT`,
      )
  }
  return errors
}

function uniqueKeys(values: string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]
}

function readableKeys(keys: readonly string[]): string {
  return keys.map((key) => key.replace("\u0000", "[")).map((key) => `${key}]`).join(", ")
}

/** This round's disposition/resolution counts. */
export interface ReviewRoundMetrics {
  raised: number
  newFindings: number
  upheld: number
  refuted: number
  fixed: number
  resolvedRefuted: number
  stillOpen: number
}

export function reviewRoundMetrics(
  output: unknown,
  evidence: readonly VerdictEvidence[] = [],
): ReviewRoundMetrics {
  const result = structuredRecord(output)
  const rawDispositions = result && Array.isArray(result.dispositions) ? result.dispositions : []
  const rawResolved = result && Array.isArray(result.resolved) ? result.resolved : []
  const dispositions = rawDispositions
    .map(dispositionRecord)
    .filter((item): item is Disposition => item !== undefined)
  const resolved = rawResolved.map(resolutionRecord).filter((item): item is Resolution => item !== undefined)
  const raised = evidence.reduce((sum, item) => {
    const actions = structuredRecord(item.output)?.required_actions
    return sum + (Array.isArray(actions) ? actions.length : 0)
  }, 0)
  return {
    raised,
    newFindings: dispositions.filter((item) => item.novelty === "new" && item.decision === "upheld").length,
    upheld: dispositions.filter((item) => item.decision === "upheld").length,
    refuted: dispositions.filter((item) => item.decision === "refuted").length,
    fixed: resolved.filter((item) => item.how === "fixed").length,
    resolvedRefuted: resolved.filter((item) => item.how === "refuted").length,
    stillOpen: resolved.filter((item) => item.how === "still_open").length,
  }
}

/** The round-chain totals a workflow result reports: per-round new findings,
 * cumulative raised/fixed/refuted/open, and the trailing quiet-round streak. */
export interface ReviewRoundSummary {
  rounds: number
  newFindingsPerRound: number[]
  raised: number
  newFindings: number
  upheld: number
  refuted: number
  fixed: number
  resolvedRefuted: number
  stillOpen: number
  quietRounds: number
}

export function reviewRoundSummary(rounds: readonly ReviewRoundMetrics[]): ReviewRoundSummary {
  const trailingQuiet = [...rounds].reverse().findIndex((round) => round.newFindings > 0)
  const quietRounds = trailingQuiet === -1 ? rounds.length : trailingQuiet
  const total = (pick: (round: ReviewRoundMetrics) => number) => rounds.reduce((sum, round) => sum + pick(round), 0)
  return {
    rounds: rounds.length,
    newFindingsPerRound: rounds.map((round) => round.newFindings),
    raised: total((round) => round.raised),
    newFindings: total((round) => round.newFindings),
    upheld: total((round) => round.upheld),
    refuted: total((round) => round.refuted),
    fixed: total((round) => round.fixed),
    resolvedRefuted: total((round) => round.resolvedRefuted),
    stillOpen: total((round) => round.stillOpen),
    quietRounds,
  }
}

/** Strict review-coverage errors for an already-compiled graph (#1031 M6).
 * Block-compiled decisions carry their lenses, lane markers, and writer
 * markers through persistence, so recover/retry re-check the same contract
 * without the authored blocks. Hand-authored node graphs carry no marker and
 * are grandfathered: they were accepted by an earlier gate, and a persisted
 * deep workflow must stay recoverable. The non-block writer rejection lives
 * where the source shape is still known (authoring compileBlockSource). */
export function strictReviewCoverageErrors(input: {
  nodes: readonly NodeConfig[]
  acceptance?: readonly { id: string }[]
}): string[] {
  const nodes = input.nodes
  const decisions = nodes.filter((node) => node.review_arbitration === true)
  const lanes = nodes.filter((node) => node.review_lane !== undefined)
  const blockCompiled = decisions.length > 0 || lanes.length > 0 || nodes.some((node) => node.block !== undefined)
  const errors: string[] = []
  if (!blockCompiled) return errors

  const writers = nodes.filter(
    (node) => node.block === "coding" || node.block === "prototype" || node.aggregates_writers === true,
  )
  for (const writer of writers) {
    const covered = decisions.some((decision) => {
      const implementationID = decision.review?.implementation_node_id
      if (decision.review?.phase !== "diff" || !implementationID) return false
      if (!dependsOnTransitively(nodes, decision.id, writer.id)) return false
      return (
        implementationID === writer.id
        || (nodes.some((node) => node.id === implementationID) && dependsOnTransitively(nodes, implementationID, writer.id))
      )
    })
    if (!covered)
      errors.push(
        `${writer.id}: writer has no downstream diff review bound to its implementation fingerprint; every writer needs verify → review with implementation_node_id pointing at the writer or its fan-out aggregator`,
      )
  }
  for (const decision of decisions) {
    if (decision.required !== true) errors.push(`${decision.id}: strict review decision must set required: true`)
    if (decision.skip_ok !== false) errors.push(`${decision.id}: strict review decision must set skip_ok: false`)
    if (!(decision.review_lenses ?? []).includes("completeness"))
      errors.push(`${decision.id}: strict review decision must include the completeness lens`)
    if (!isReadOnlyProfile(decision.worker_type))
      errors.push(`${decision.id}: strict review arbitration uses write-capable worker "${decision.worker_type}"`)
  }
  for (const lane of lanes) {
    if (!isReadOnlyProfile(lane.worker_type))
      errors.push(`${lane.id}: strict review lane uses write-capable worker "${lane.worker_type}"`)
  }
  if (writers.length > 0) {
    const acceptance = input.acceptance ?? []
    if (acceptance.length === 0)
      errors.push("strict workflows with writers must declare config.acceptance for the completeness lane")
    if (acceptance.length > 50) errors.push(`config.acceptance has ${acceptance.length} items; the strict gate allows at most 50`)
    const repeated = uniqueKeys(acceptance.map((item) => item.id))
    if (repeated.length > 0) errors.push(`config.acceptance repeats id(s): ${repeated.join(", ")}`)
  }
  return errors
}

function dependsOnTransitively(nodes: readonly NodeConfig[], startID: string, targetID: string): boolean {
  const visited = new Set<string>()
  const visit = (nodeID: string): boolean => {
    if (visited.has(nodeID)) return false
    visited.add(nodeID)
    const node = nodes.find((candidate) => candidate.id === nodeID)
    if (!node) return false
    if (node.depends_on.includes(targetID)) return true
    return node.depends_on.some(visit)
  }
  return visit(startID)
}

// Same normalization as verdict gates: plain or fenced JSON strings count as
// structured output, so a lane that emits fenced JSON text cannot slip past refutation.
function structuredRecord(value: unknown): Record<string, unknown> | undefined {
  const parsed = normalizeOutput(value)
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? Object.fromEntries(Object.entries(parsed))
    : undefined
}

export function unresolvedReviewOutcomes(
  config: WorkflowConfig,
  nodes: ReadonlyArray<{ id: string; status: string; output: unknown; staleTarget?: boolean | null }>,
) {
  const rows = new Map(nodes.map((node) => [node.id, node]))
  const reviews = config.nodes.filter((node) => node.review?.phase === "diff")
  return reviews.flatMap((review) => {
    if (
      isCorrectionReview(config, reviews, review)
      && rows.get(review.id)?.status !== "completed"
    ) return []
    if (reviewAccepted(config, rows, review)) return []
    const corrected = reviews.some((candidate) => {
      const implementationID = candidate.review?.implementation_node_id
      if (!implementationID || !dependsTransitively(config, implementationID, review.id)) return false
      return reviewAccepted(config, rows, candidate)
    })
    return corrected ? [] : [review.id]
  })
}

function isCorrectionReview(config: WorkflowConfig, reviews: NodeConfig[], review: NodeConfig) {
  const implementationID = review.review?.implementation_node_id
  return implementationID !== undefined
    && reviews.some((candidate) =>
      candidate.id !== review.id
      && dependsTransitively(config, implementationID, candidate.id),
    )
}

export function reviewContractForNode(node: NodeConfig) {
  if (!node.review) return undefined
  if (node.review.phase === "design") {
    return [
      "Review contract: this is a design/specification review.",
      "Evaluate only the pre-implementation artifacts supplied by dependencies.",
      "You MUST NOT claim to have inspected an implementation diff or executed implementation tests.",
    ].join(" ")
  }
  return [
    "Review contract: this is an implementation diff review.",
    "Base the verdict on the supplied actual diff, implementation fingerprint, and verification PASS evidence.",
    "The structured result must report ACCEPT or REJECT and echo the reviewed implementation fingerprint.",
  ].join(" ")
}

function validateDiffReview(config: WorkflowConfig, reviewID: string, grandfathered: boolean) {
  const review = config.nodes.find((node) => node.id === reviewID)
  if (!review?.review || review.review.phase !== "diff") return []

  const implementationID = review.review.implementation_node_id
  const verificationID = review.review.verification_node_id
  const missing = [
    ...(!implementationID
      ? [`${reviewID}: diff review must declare implementation_node_id`]
      : config.nodes.some((node) => node.id === implementationID)
        ? []
        : [`${reviewID}: implementation node ${implementationID} does not exist`]),
    ...(!verificationID
      ? [`${reviewID}: diff review must declare verification_node_id`]
      : config.nodes.some((node) => node.id === verificationID)
        ? []
        : [`${reviewID}: verification node ${verificationID} does not exist`]),
  ]
  if (missing.length > 0 || !implementationID || !verificationID) return missing

  const sources = Object.values(review.input_mapping ?? {})
  const implementationArtifact = sources.some((source) => {
    const [nodeID, output, field] = source.split(".")
    return nodeID === implementationID
      && output === "output"
      && field !== undefined
      && ["diff", "patch", "changed_files"].includes(field)
  })
  const verificationOutput = sources.some((source) => source.split(".")[0] === verificationID)
  const implementationFingerprint = sources.some((source) => {
    const [nodeID, output, field] = source.split(".")
    return nodeID === implementationID && output === "output" && field === "fingerprint"
  })

  return [
    ...(dependsTransitively(config, reviewID, verificationID)
      ? []
      : [`${reviewID}: diff review must depend transitively on verification node ${verificationID}`]),
    ...(dependsTransitively(config, verificationID, implementationID)
      ? []
      : [`${reviewID}: verification node ${verificationID} must depend transitively on implementation node ${implementationID}`]),
    ...(implementationArtifact
      ? []
      : [`${reviewID}: input_mapping must map an actual diff or changed-file artifact from ${implementationID}`]),
    ...(implementationFingerprint
      ? []
      : [`${reviewID}: input_mapping must map implementation fingerprint from ${implementationID}`]),
    ...(verificationOutput
      ? []
      : [`${reviewID}: input_mapping must map verification output from ${verificationID}`]),
    ...((grandfathered
      ? textualMentionsVerificationPass(review.condition, verificationID)
      : requiresVerificationPass(review.condition, verificationID))
      ? []
      : [`${reviewID}: condition must require PASS from verification node ${verificationID}`]),
    ...(hasReviewResultSchema(review.output_schema)
      ? []
      : [`${reviewID}: output_schema must require verdict and implementation_fingerprint`]),
  ]
}

function validateFinalReviewGate(config: WorkflowConfig, reviewID: string) {
  const gate = finalReviewGates(config, reviewID).length > 0
  return gate
    ? []
    : [`${reviewID}: deep diff review must feed a required final gate conditioned on verdict ACCEPT`]
}

function finalReviewGates(config: WorkflowConfig, reviewID: string) {
  return config.nodes.filter((node) =>
    node.id !== reviewID
    && (node.required ?? config.node_defaults?.required ?? false)
    && dependsTransitively(config, node.id, reviewID)
    && Object.values(node.input_mapping ?? {}).some((source) =>
      source === `${reviewID}.output` || source.startsWith(`${reviewID}.output.`),
    )
    && acceptsReviewVerdict(node.condition, reviewID),
  )
}

function reviewAccepted(
  config: WorkflowConfig,
  rows: ReadonlyMap<string, { status: string; output: unknown; staleTarget?: boolean | null }>,
  review: NodeConfig,
) {
  const row = rows.get(review.id)
  return row?.status === "completed"
    // #944: a review judged against a tree that changed mid-run never counts
    // as ACCEPT, even if the model returned one.
    && row.staleTarget !== true
    && reviewVerdict(row.output) === "ACCEPT"
    && finalReviewGates(config, review.id).some((gate) => rows.get(gate.id)?.status === "completed")
}

function acceptsReviewVerdict(condition: string | undefined, reviewID: string) {
  const output = (verdict: "ACCEPT" | "REJECT") => ({
    [reviewID]: { output: { verdict } },
  })
  const accepted = evaluateCondition(condition, output("ACCEPT"))
  const rejected = evaluateCondition(condition, output("REJECT"))
  return accepted.ok && accepted.value && rejected.ok && !rejected.value
}

/** The diff review's condition must actually gate on a PASS verdict: it has to
 * run on PASS and stay closed on FAIL or a missing verdict. Evaluated, not
 * substring-matched — `verdict != "PASS"` mentions PASS but inverts the gate.
 * Both the structured `{ verdict }` and the raw-string output shapes the
 * runtime accepts as PASS evidence are recognized. */
/** The pre-evaluation textual check, kept only for grandfathered reviews. */
function textualMentionsVerificationPass(condition: string | undefined, verificationID: string) {
  return condition !== undefined && condition.includes(verificationID) && condition.includes("PASS")
}

function requiresVerificationPass(condition: string | undefined, verificationID: string) {
  const gates = (pass: unknown, fail: unknown, missing: unknown) => {
    const run = (output: unknown) => evaluateCondition(condition, { [verificationID]: { output } })
    const passed = run(pass)
    const failed = run(fail)
    const absent = run(missing)
    return passed.ok && passed.value && failed.ok && !failed.value && !(absent.ok && absent.value)
  }
  return gates({ verdict: "PASS" }, { verdict: "FAIL" }, {}) || gates("PASS", "FAIL", "")
}

function hasReviewResultSchema(schema: Record<string, unknown> | undefined) {
  if (!schema || schema.type !== "object") return false
  const required = schema.required
  if (!Array.isArray(required)) return false
  return ["verdict", "implementation_fingerprint"].every((field) =>
    required.includes(field),
  )
}

function hasEvidence(value: unknown): boolean {
  if (typeof value === "string") {
    const text = value.trim()
    return text.length > 0
      && !text.includes("{{")
      && !text.startsWith("Dependency ")
  }
  if (Array.isArray(value)) return value.some(hasEvidence)
  if (typeof value !== "object" || value === null) return false
  return Object.values(value).some(hasEvidence)
}

// Verdicts use the shared output normalization (JSON strings, code fences,
// verdict case) so a review input check never disagrees with the condition
// gate that admitted the same output.
function hasPassVerdict(value: unknown): boolean {
  const normalized = normalizeOutput(value)
  if (typeof normalized === "string") return normalized.trim().toUpperCase() === "PASS"
  return verdictField(normalized) === "PASS"
}

function reviewVerdict(value: unknown): "ACCEPT" | "REJECT" | undefined {
  const verdict = verdictField(value)
  return verdict === "ACCEPT" || verdict === "REJECT" ? verdict : undefined
}

function dependsTransitively(config: WorkflowConfig, startID: string, targetID: string) {
  const visited = new Set<string>()
  const visit = (nodeID: string): boolean => {
    if (visited.has(nodeID)) return false
    visited.add(nodeID)
    const node = config.nodes.find((candidate) => candidate.id === nodeID)
    if (!node) return false
    if (node.depends_on.includes(targetID)) return true
    return node.depends_on.some(visit)
  }
  return visit(startID)
}

export function isReviewWorker(workerType: string) {
  return workerType === "review" || workerType.startsWith("review-")
}

/** #1030 D9-h: worker types whose job is to judge the workspace, never to
 * change it. The built-in `auditor` agent is the read-only worker that review
 * lanes, skeptics, verification, and synthesis use by default. */
export function isReadOnlyWorker(workerType: string) {
  return isReviewWorker(workerType) || workerType === "auditor"
}

/** #1030 D9-h: the effective workspace-write policy of a node. An explicit
 * `workspace_writes` wins; otherwise read-only workers deny writes and every
 * other worker keeps its agent permission. */
export function workspaceWritesOf(
  node: Pick<NodeConfig, "workspace_writes"> | undefined,
  workerType: string,
): "allow" | "deny" {
  return node?.workspace_writes ?? (isReadOnlyWorker(workerType) ? "deny" : "allow")
}

/**
 * #944: a node judges the working tree when block compilation marks it
 * target-sensitive (review lanes, verify, synthesize) or when it follows the
 * review conventions (a review worker type or a `review` config). Custom nodes
 * without the marker keep their historical behavior.
 */
export function targetSensitiveNode(
  node: Pick<NodeConfig, "target_sensitive" | "review"> | undefined,
  workerType: string,
) {
  return node?.target_sensitive === true || isReviewWorker(workerType) || node?.review !== undefined
}
