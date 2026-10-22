// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

export * as DagReviewLifecycle from "./review-lifecycle"

import type { NodeConfig, WorkflowConfig } from "./dag"
import { evaluateCondition } from "./runtime/eval"
import { normalizeOutput, verdictField } from "./runtime/verdict"

/** `grandfathered`: review nodes carried with a persisted definition (runtime
 * replan/extend/recover). Their PASS gate keeps the legacy textual check it
 * was accepted under, so a gate such as `verify.output.status == PASS` on an
 * existing — possibly terminal, unfixable — review never blocks later
 * mutations. Newly authored reviews always get the evaluated check. */
export function validateReviewLifecycle(
  config: WorkflowConfig,
  options: { grandfathered?: ReadonlySet<string> } = {},
) {
  const issues = config.nodes.flatMap((node) => {
    if (!node.review) {
      if (!isReviewWorker(node.worker_type)) return []
      if ((config.mode ?? "standard") === "standard") return []
      return [`${node.id}: deep review worker must declare review.phase as "design" or "diff"`]
    }
    if (node.review.phase === "design") return []
    return [
      ...validateDiffReview(config, node.id, options.grandfathered?.has(node.id) ?? false),
      ...((config.mode ?? "standard") === "deep"
        ? validateFinalReviewGate(config, node.id)
        : []),
    ]
  })

  if ((config.mode ?? "standard") === "standard") {
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
 * Non-ACCEPT verdicts and free-text (legacy) evidence are not constrained.
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

function structuredRecord(value: unknown): Record<string, unknown> | undefined {
  const parsed = typeof value === "string" ? parseJson(value) : value
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? Object.fromEntries(Object.entries(parsed))
    : undefined
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function unresolvedReviewOutcomes(
  config: WorkflowConfig,
  nodes: ReadonlyArray<{ id: string; status: string; output: unknown }>,
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
      ? legacyMentionsVerificationPass(review.condition, verificationID)
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
  rows: ReadonlyMap<string, { status: string; output: unknown }>,
  review: NodeConfig,
) {
  const row = rows.get(review.id)
  return row?.status === "completed"
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
function legacyMentionsVerificationPass(condition: string | undefined, verificationID: string) {
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
