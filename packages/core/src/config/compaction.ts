export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export class Keep extends Schema.Class<Keep>("ConfigV2.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  auto: Schema.Boolean.pipe(Schema.optional),
  keep: Keep.pipe(Schema.optional),
  buffer: NonNegativeInt.pipe(Schema.optional),
  triggerRatio: Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 1 })).pipe(Schema.optional),
  mode: Schema.Literals(["small", "shared", "auto"]).pipe(Schema.optional),
}) {}
