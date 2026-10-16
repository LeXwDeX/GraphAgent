export * as ConfigAgent from "./agent"

import { Schema } from "effect"
import { Permission } from "@opencode-ai/schema/permission"
import { ConfigProvider } from "./provider"
import { NonNegativeInt, PositiveInt } from "../schema"

export const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

export class Info extends Schema.Class<Info>("ConfigV2.Agent")({
  model: Schema.String.pipe(Schema.optional),
  variant: Schema.String.pipe(Schema.optional),
  request: ConfigProvider.Request.pipe(Schema.optional),
  system: Schema.String.pipe(Schema.optional),
  hooks: Schema.Record(Schema.String, Schema.Any).pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  mode: Schema.Literals(["subagent", "primary", "all"]).pipe(Schema.optional),
  hidden: Schema.Boolean.pipe(Schema.optional),
  color: Color.pipe(Schema.optional),
  steps: PositiveInt.pipe(Schema.optional),
  timeout: NonNegativeInt.pipe(Schema.optional).annotate({
    description:
      "Provider turn timeout in seconds for sessions running this agent (default 600). Bounds the provider stream and the tool-wait after it.",
  }),
  disabled: Schema.Boolean.pipe(Schema.optional),
  permissions: Permission.Ruleset.pipe(Schema.optional),
}) {}
