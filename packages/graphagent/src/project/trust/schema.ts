// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Wire shapes for the project-trust service (T1 PR2).
 *
 * The HTTP routes and generated SDK use these schemas. They are the display
 * projection of an enumerated entry plus its trust state; they never carry the
 * raw canonical fields used for fingerprinting.
 */
import { Schema } from "effect"
import { RISK_CODES, type RiskLevel } from "./risk"
import { TRUST_CATEGORIES } from "./types"

export const TrustStateSchema = Schema.Literals(["trusted", "declined", "pending"]).annotate({
  identifier: "ProjectTrustState",
})
export type TrustState = typeof TrustStateSchema.Type

export const TrustChangeSchema = Schema.Literals(["new", "modified"]).annotate({
  identifier: "ProjectTrustChange",
})
export type TrustChange = typeof TrustChangeSchema.Type

const RiskLevelSchema = Schema.Literals(["high", "caution"] satisfies RiskLevel[]).annotate({
  identifier: "ProjectTrustRiskLevel",
})

export const TrustRiskSchema = Schema.Struct({
  code: Schema.Literals(RISK_CODES),
  level: RiskLevelSchema,
  detail: Schema.optional(Schema.String),
}).annotate({ identifier: "ProjectTrustRisk" })
export type TrustRisk = typeof TrustRiskSchema.Type

export const TrustSourceSchema = Schema.Struct({
  file: Schema.String,
  line: Schema.optional(Schema.Number),
}).annotate({ identifier: "ProjectTrustSource" })
export type TrustSourceView = typeof TrustSourceSchema.Type

export const TrustEntryViewSchema = Schema.Struct({
  id: Schema.String,
  category: Schema.Literals(TRUST_CATEGORIES),
  fp: Schema.String,
  state: TrustStateSchema,
  change: Schema.optional(TrustChangeSchema),
  previous: Schema.optional(Schema.String),
  source: TrustSourceSchema,
  when: Schema.String,
  command: Schema.String,
  risks: Schema.Array(TrustRiskSchema),
}).annotate({ identifier: "ProjectTrustEntry" })
export type TrustEntryView = typeof TrustEntryViewSchema.Type

export const TrustListSchema = Schema.Struct({
  entries: Schema.Array(TrustEntryViewSchema),
}).annotate({ identifier: "ProjectTrustList" })
export type TrustList = typeof TrustListSchema.Type

export const TrustDecisionInputSchema = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["trusted", "declined", "revoked"]),
}).annotate({ identifier: "ProjectTrustDecision" })
export type TrustDecisionInput = typeof TrustDecisionInputSchema.Type

export const TrustDecidePayloadSchema = Schema.Struct({
  decisions: Schema.Array(TrustDecisionInputSchema),
}).annotate({ identifier: "ProjectTrustDecideInput" })
export type TrustDecidePayload = typeof TrustDecidePayloadSchema.Type
