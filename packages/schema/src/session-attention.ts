import { Schema } from "effect"

/** Client activity carries no typed content and grants no permission capability. */
export const SessionAttentionInput = Schema.Struct({
  clientID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  clientType: Schema.optional(Schema.Literals(["terminal", "web"])),
  activity: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  backgroundView: Schema.optional(Schema.Boolean),
  closed: Schema.optional(Schema.Boolean),
})
export type SessionAttentionInput = typeof SessionAttentionInput.Type
