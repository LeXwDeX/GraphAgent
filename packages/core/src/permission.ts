export * as PermissionV2 from "./permission"

import { Permission } from "@graphagent/schema/permission"
import { Wildcard } from "./util/wildcard"

export { Effect, Rule, Ruleset } from "@graphagent/schema/permission"

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}
