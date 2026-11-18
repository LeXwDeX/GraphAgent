export * as PermissionV1 from "./permission"

import { Schema } from "effect"
export * from "@graphagent/schema/permission-v1"
import { ID } from "@graphagent/schema/permission-v1"

export class RejectedError extends Schema.TaggedError<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call. Do not retry this call; choose another approach or ask the user."
  }
}

export class CorrectedError extends Schema.TaggedError<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

const RULES_SHOWN = 5
const RULE_CHARS = 120

/** `<permission> <pattern> <action>` for a rule whose three fields are all strings, cut to 120 characters. */
function ruleText(rule: unknown): string | undefined {
  if (typeof rule !== "object" || rule === null) return undefined
  const fields = [Reflect.get(rule, "permission"), Reflect.get(rule, "pattern"), Reflect.get(rule, "action")]
  if (!fields.every((field) => typeof field === "string")) return undefined
  return Array.from(fields.join(" ")).slice(0, RULE_CHARS).join("")
}

/** `Relevant rules: ... ` for the first readable rules of a ruleset (rest counted), or nothing when none is readable. */
function relevantRules(ruleset: unknown): string {
  const rules = (Array.isArray(ruleset) ? ruleset : []).flatMap((rule: unknown) => ruleText(rule) ?? [])
  if (rules.length === 0) return ""
  const more = rules.length > RULES_SHOWN ? `; +${rules.length - RULES_SHOWN} more` : ""
  return `Relevant rules: ${rules.slice(0, RULES_SHOWN).join("; ")}${more}. `
}

export class DeniedError extends Schema.TaggedError<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
  /** Role-derived denial text. User-configured rules keep the default message. */
  reason: Schema.optional(Schema.String),
}) {
  override get message() {
    return (
      this.reason ??
      `The user has specified a rule which prevents you from using this specific tool call. ${relevantRules(this.ruleset)}Do not retry this call; choose another approach.`
    )
  }
}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = DeniedError | RejectedError | CorrectedError
