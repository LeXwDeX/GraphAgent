// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

export * as DagAdmission from "./admission"

import { Schema } from "effect"

export const States = [
  "UNASSESSED",
  "QUESTIONING",
  "READY",
  "NOT_READY",
  "WAIVED",
  "INVALIDATED",
  "CONSUMED",
] as const

export type State = (typeof States)[number]

export const Modes = ["LIGHT", "STANDARD", "GRILL"] as const
export type Mode = (typeof Modes)[number]

export const ExecutionModes = ["standard", "deep"] as const
export const ExecutionMode = Schema.Literals(ExecutionModes)
export type ExecutionMode = typeof ExecutionMode.Type

export const QaPolicies = {
  LIGHT: { max_rounds: 1 },
  STANDARD: { max_rounds: 3 },
  GRILL: { max_rounds: 5 },
} as const satisfies Record<Mode, { max_rounds: number }>

export const Verdicts = ["READY", "NOT_READY", "WAIVED"] as const
export type Verdict = (typeof Verdicts)[number]

const StringArray = Schema.Array(Schema.String)

export const RequirementBrief = Schema.Struct({
  goal: Schema.String,
  scope: Schema.Struct({
    in: StringArray,
    out: StringArray,
  }),
  constraints: StringArray,
  assumptions: StringArray,
  acceptance_criteria: StringArray,
  evidence_required: StringArray,
  risks: StringArray,
  review_plan: StringArray,
  open_questions: StringArray,
  blocking_questions: StringArray,
})
export type RequirementBrief = typeof RequirementBrief.Type

export const AdmissionRecord = Schema.Struct({
  protocol_version: Schema.Number,
  brief_revision: Schema.Number,
  qa_mode: Schema.Literals(Modes),
  verdict: Schema.Literals(Verdicts),
  state: Schema.Literals(States),
  fingerprint: Schema.String,
  brief: RequirementBrief,
  waiver_reason: Schema.optional(Schema.String),
  acknowledged_risks: Schema.optional(StringArray),
})
export type AdmissionRecord = typeof AdmissionRecord.Type

export const AdmissionInput = Schema.Struct({
  brief_revision: Schema.Number,
  qa_mode: Schema.Literals(Modes),
  verdict: Schema.Literals(Verdicts),
  brief: RequirementBrief,
  waiver_reason: Schema.optional(Schema.String),
  acknowledged_risks: Schema.optional(StringArray),
})
export type AdmissionInput = typeof AdmissionInput.Type

const Transitions = {
  UNASSESSED: ["QUESTIONING", "WAIVED"],
  QUESTIONING: ["READY", "NOT_READY", "WAIVED"],
  READY: ["INVALIDATED", "CONSUMED"],
  NOT_READY: ["QUESTIONING", "WAIVED", "INVALIDATED"],
  WAIVED: ["INVALIDATED", "CONSUMED"],
  INVALIDATED: ["QUESTIONING"],
  CONSUMED: [],
} satisfies Record<State, readonly State[]>

export class AdmissionTransitionError extends Error {
  constructor(current: State, target: State) {
    super(`Invalid admission transition: ${current} -> ${target}`)
    this.name = "AdmissionTransitionError"
  }
}

export function transitionAdmission(current: State, target: State) {
  const allowed: readonly State[] = Transitions[current]
  if (allowed.includes(target)) return target
  throw new AdmissionTransitionError(current, target)
}

export function fingerprintBrief(brief: RequirementBrief) {
  const canonical = {
    goal: brief.goal.trim(),
    scope: {
      in: normalizedStrings(brief.scope.in),
      out: normalizedStrings(brief.scope.out),
    },
    constraints: normalizedStrings(brief.constraints),
    assumptions: normalizedStrings(brief.assumptions),
    acceptance_criteria: normalizedStrings(brief.acceptance_criteria),
    evidence_required: normalizedStrings(brief.evidence_required),
    risks: normalizedStrings(brief.risks),
    review_plan: normalizedStrings(brief.review_plan),
    open_questions: normalizedStrings(brief.open_questions),
    blocking_questions: normalizedStrings(brief.blocking_questions),
  }
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(canonical)).digest("hex")
}

export function createAdmissionRecord(input: AdmissionInput): AdmissionRecord {
  return {
    protocol_version: 1,
    brief_revision: input.brief_revision,
    qa_mode: input.qa_mode,
    verdict: input.verdict,
    state: input.verdict,
    fingerprint: fingerprintBrief(input.brief),
    brief: input.brief,
    ...(input.waiver_reason ? { waiver_reason: input.waiver_reason } : {}),
    ...(input.acknowledged_risks ? { acknowledged_risks: input.acknowledged_risks } : {}),
  }
}

export function validateAdmission(record: AdmissionRecord) {
  const errors = [
    ...(record.protocol_version === 1 ? [] : ["protocol_version must be 1"]),
    ...(Number.isInteger(record.brief_revision) && record.brief_revision > 0
      ? []
      : ["brief_revision must be a positive integer"]),
    ...briefReadinessErrors(record.brief),
    ...(record.verdict === "READY" && record.brief.blocking_questions.some((value) => value.trim())
      ? ["READY admission must not contain blocking_questions"]
      : []),
    ...(record.verdict === "NOT_READY" && !record.brief.blocking_questions.some((value) => value.trim())
      ? ["NOT_READY admission requires blocking_questions"]
      : []),
    ...(record.verdict === "WAIVED" && !record.waiver_reason?.trim()
      ? ["WAIVED admission requires waiver_reason"]
      : []),
    ...(record.verdict === "WAIVED" && !record.acknowledged_risks?.some((value) => value.trim())
      ? ["WAIVED admission requires acknowledged_risks"]
      : []),
    ...(record.state === record.verdict || (
      record.state === "CONSUMED"
      && (record.verdict === "READY" || record.verdict === "WAIVED")
    )
      ? []
      : ["state must match the final admission verdict"]),
    ...(record.fingerprint === fingerprintBrief(record.brief)
      ? []
      : ["fingerprint does not match the canonical Requirement Brief"]),
  ]
  if (errors.length > 0) return { valid: false as const, errors }
  return { valid: true as const }
}

export function evaluateQa(input: {
  qa_mode: Mode
  rounds_completed: number
  brief: RequirementBrief
}) {
  const maxRounds = QaPolicies[input.qa_mode].max_rounds
  const roundsRemaining = Math.max(0, maxRounds - input.rounds_completed)
  const blockers = [
    ...briefReadinessErrors(input.brief),
    ...input.brief.blocking_questions.map((value) => value.trim()).filter(Boolean),
  ]
  if (blockers.length === 0) {
    return {
      state: "READY" as const,
      blockers,
      rounds_remaining: roundsRemaining,
    }
  }
  if (roundsRemaining === 0) {
    return {
      state: "NOT_READY" as const,
      blockers,
      rounds_remaining: roundsRemaining,
    }
  }
  return {
    state: "QUESTIONING" as const,
    blockers,
    rounds_remaining: roundsRemaining,
  }
}

export function projectBriefForNode(brief: RequirementBrief) {
  return {
    goal: brief.goal.trim().slice(0, 2_000),
    scope: {
      in: boundedStrings(brief.scope.in),
      out: boundedStrings(brief.scope.out),
    },
    constraints: boundedStrings(brief.constraints),
    assumptions: boundedStrings(brief.assumptions),
    acceptance_criteria: boundedStrings(brief.acceptance_criteria),
    evidence_required: boundedStrings(brief.evidence_required),
    risks: boundedStrings(brief.risks),
    review_plan: boundedStrings(brief.review_plan),
  }
}

function normalizedStrings(values: readonly string[]) {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .sort()
}

function boundedStrings(values: readonly string[]) {
  return values.slice(0, 20).map((value) => value.trim().slice(0, 500))
}

function briefReadinessErrors(brief: RequirementBrief) {
  return [
    ...(brief.goal.trim() ? [] : ["brief.goal must not be blank"]),
    ...(brief.scope.in.some((value) => value.trim())
      ? []
      : ["brief.scope.in must contain at least one item"]),
    ...(brief.acceptance_criteria.some((value) => value.trim())
      ? []
      : ["brief.acceptance_criteria must contain at least one item"]),
    ...(brief.evidence_required.some((value) => value.trim())
      ? []
      : ["brief.evidence_required must contain at least one item"]),
    ...(brief.review_plan.some((value) => value.trim())
      ? []
      : ["brief.review_plan must contain at least one item"]),
  ]
}
