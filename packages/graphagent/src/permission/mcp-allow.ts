// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * What the user can say about one MCP tool (#1324).
 *
 * An MCP server tool asks with its model-facing key (`server_tool`) as the
 * permission and `*` as its only pattern, so the concrete-pattern test that makes
 * a `bash` or `edit` allow explicit can never hold for it. The allow that counts
 * is one that names exactly that tool: a permission key with no wildcard, and the
 * pattern `*`. A server-wide wildcard (`server_*`) names a family and a whole-key
 * allow (`"*": "allow"`) names everything, so neither counts.
 *
 * The `ask` tier of `dag.permission` frees such a tool from its question; the
 * `readonly` tier lets it through the read-only tool surface (Q8). Both ask the
 * same question, so the answer lives here.
 */
import { Wildcard } from "@graphagent/core/util/wildcard"
import type { PermissionV1 } from "@graphagent/core/v1/permission"

/** `Wildcard.match` honors `*` and `?`: a key without either names one tool. */
export function namesOneTool(permission: string) {
  return !/[*?]/.test(permission)
}

/**
 * Whether the rule that decides an MCP tool's request is an allow the user wrote
 * for that one tool. The deciding rule is the last one in `ruleset` matching the
 * tool's key and the pattern `*`, as `evaluate` picks it; a later ask, deny or
 * wildcard rule decides instead of an earlier exact allow.
 *
 * `userWrote` says whether the rule at an index is the user's own, the same
 * provenance test the safety list applies to `explicit`: a role or default allow
 * never counts, whatever its key.
 */
export function userAllowsMcpTool(ruleset: PermissionV1.Ruleset, tool: string, userWrote: (index: number) => boolean) {
  const index = ruleset.findLastIndex(
    (rule) => Wildcard.match(tool, rule.permission) && Wildcard.match("*", rule.pattern),
  )
  if (index < 0) return false
  const rule = ruleset[index]
  return rule.action === "allow" && namesOneTool(rule.permission) && rule.pattern === "*" && userWrote(index)
}
