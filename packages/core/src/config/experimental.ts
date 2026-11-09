export * as ConfigExperimental from "./experimental"

import { Schema } from "effect"
import { Policy as PolicyV2 } from "../policy"

export const PolicyAction = Schema.Literals(["provider.use"])

export class Policy extends Schema.Class<Policy>("ConfigV2.Experimental.Policy")({
  ...PolicyV2.Info.fields,
  action: PolicyAction,
}) {}

export class Experimental extends Schema.Class<Experimental>("ConfigV2.Experimental")({
  policies: Policy.pipe(Schema.Array, Schema.optional),
}) {}
