import { PermissionV1 } from "@graphagent/core/v1/permission"
import type { Agent } from "./agent"

const DEFAULT_DENIED_TOOLS = ["todowrite", "task"] as const

/**
 * Tools a child session denies because the worker's own ruleset has no rule
 * for them. A configured allow or pattern-scoped rule opts the tool out.
 */
export function subagentDefaultDeniedTools(agent: Agent.Info): Array<(typeof DEFAULT_DENIED_TOOLS)[number]> {
  return DEFAULT_DENIED_TOOLS.filter((permission) => !agent.permission.some((rule) => rule.permission === permission))
}

/**
 * Internal role-default rules. These are always the first rules in a derived
 * child-session permission; no public rule field marks their provenance.
 */
export function subagentRoleDefaultDenies(agent: Agent.Info): PermissionV1.Rule[] {
  return subagentDefaultDeniedTools(agent).map((permission) => ({
    permission,
    pattern: "*",
    action: "deny",
  }))
}

/**
 * Locate the role-default rules inside a persisted child-session permission.
 * New sessions place them first; sessions created before the layout change
 * placed inherited parent rules first and role defaults after them. A run that
 * matches both a parent rule and a role default is ambiguous; returning no
 * indices keeps the denial attribution on the conservative user wording.
 */
export function subagentRoleDefaultRuleIndices(ruleset: PermissionV1.Ruleset, agent: Agent.Info): number[] {
  const defaults = subagentRoleDefaultDenies(agent)
  if (defaults.length === 0) return []
  const matches = (rule: PermissionV1.Rule, fallback: PermissionV1.Rule) =>
    rule.permission === fallback.permission && rule.pattern === fallback.pattern && rule.action === fallback.action

  const runs: Array<{ start: number; end: number }> = []
  let start = -1
  for (let index = 0; index <= ruleset.length; index++) {
    const current = ruleset[index]
    if (current && defaults.some((rule) => matches(current, rule))) {
      if (start === -1) start = index
    } else if (start !== -1) {
      runs.push({ start, end: index })
      start = -1
    }
  }
  if (runs.length !== 1) return []
  const run = runs[0]
  if (!run) return []
  const length = run.end - run.start
  if (length < defaults.length) return []

  // New layout: the default run starts the session permission. If a parent
  // deny has the same contents it extends the run, making the provenance
  // ambiguous, so do not label it as a role default.
  if (run.start === 0) {
    if (length !== defaults.length) return []
    return defaults.map((_, index) => index)
  }

  // Legacy layout: inherited parent rules came first, then the role defaults.
  const first = run.end - defaults.length
  return defaults.map((_, index) => first + index)
}

export function subagentRoleDefaultRuleCount(ruleset: PermissionV1.Ruleset, agent: Agent.Info): number {
  return subagentRoleDefaultRuleIndices(ruleset, agent).length
}

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Role defaults lead the list; inherited parent rules follow
 * them so an inherited matching rule wins and keeps user-rule attribution.
 *
 * 1. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 * 2. The parent session's deny rules and external_directory rules. Parent
 *    agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const parent = input.parentSessionPermission.filter(
    (rule) => rule.permission === "external_directory" || rule.action === "deny",
  )
  return [...subagentRoleDefaultDenies(input.subagent), ...parent]
}
