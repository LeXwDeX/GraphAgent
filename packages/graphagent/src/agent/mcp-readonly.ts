// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { PermissionV1 } from "@graphagent/core/v1/permission"
import { McpCatalog } from "@/mcp/catalog"
import type { Agent } from "./agent"
import { AgentContract } from "./contract"

/**
 * The MCP tools that declare `annotations.readOnlyHint: true` are open to the read-only built-in subagents (#1454).
 * Those agents deny every tool they do not list (`"*": "deny"`) in their native rules, and a native deny is final: the
 * tool list and `Permission.ask` read the native rules apart from the user's, so no allow the user writes lifts it.
 * The grant is therefore made in the native rules: one allow for each such tool, after the rest of them and before the
 * rules the user wrote, so a deny the user writes for the tool, or for its server, still closes it.
 *
 * The hint is the word of a server the user configured, and it is trusted as given. The MCP SDK says a hint is no more
 * than a hint, so a server that misreports a tool opens it to these agents; a deny for the tool shuts it.
 */

/** What `qualifies` reads of an agent. */
type Subject = Pick<Agent.Info, "name" | "native" | "mode" | "permission" | "contract">

/** The rules `Agent.permissionPolicy` returns: the native rules, then all the rules, the user's after the native ones. */
export interface Policy {
  readonly native: PermissionV1.Ruleset
  readonly rules: PermissionV1.Ruleset
  /** Indices into `rules` of the rules the user wrote. */
  readonly userRuleIndices?: readonly number[]
}

/**
 * Whether the grant is for this agent: a built-in subagent that cannot write files and is not a composer. Of the
 * built-in agents these are `explore`, `researcher`, `architect`, `review` and `auditor`. `general` and `prototyper`
 * can write, the composers plan and join, and a custom agent is not known to be read-only.
 */
export function qualifies(agent: Subject): boolean {
  return (
    agent.native === true &&
    agent.mode === "subagent" &&
    !AgentContract.isWriterAgent(agent) &&
    !AgentContract.isComposer(agent)
  )
}

const sameRule = (left: PermissionV1.Rule, right: PermissionV1.Rule) =>
  left.permission === right.permission && left.pattern === right.pattern && left.action === right.action

// `Agent.permissionPolicy` builds `rules` with the native rules first. Rules that do not begin with them leave no way to
// tell the agent's own rules from the user's, and nothing is added.
const leadsWith = (rules: PermissionV1.Ruleset, prefix: PermissionV1.Ruleset) =>
  rules.length >= prefix.length && prefix.every((rule, index) => sameRule(rule, rules[index]))

/**
 * `policy` with an allow for each of `ids` added, when `agent` qualifies. The allows follow the native rules and
 * precede the rest of `rules`, so the rules of the user are decided after them. The indices of the user's rules move
 * by the number of allows put before them; the allows are no rule of the user's, so a tier of `dag.permission` that
 * asks for an allow the user wrote does not take one for it. `policy` is not changed. It is returned as it is when
 * there is nothing to add: no ids, an agent that does not qualify, or rules that do not begin with the native rules.
 */
export function adjust(agent: Subject, policy: Policy, ids: readonly string[]): Policy {
  if (ids.length === 0 || !qualifies(agent) || !leadsWith(policy.rules, policy.native)) return policy
  const allows = [...new Set(ids)].map((id): PermissionV1.Rule => ({ permission: id, pattern: "*", action: "allow" }))
  const at = policy.native.length
  return {
    native: [...policy.native, ...allows],
    rules: [...policy.rules.slice(0, at), ...allows, ...policy.rules.slice(at)],
    ...(policy.userRuleIndices === undefined
      ? {}
      : { userRuleIndices: policy.userRuleIndices.map((index) => (index >= at ? index + allows.length : index)) }),
  }
}

/**
 * The ids of the MCP server tools among `entries` that declare themselves read-only. A tool of a deferred server is one
 * of them: the grant is for the key of the tool, as it is for a direct call, and the agents it is made for have no
 * `mcp_describe` or `mcp_call` to reach such a tool with.
 */
export function idsOfEntries(
  entries: Iterable<{ readonly id: string; readonly source: { readonly kind: string; readonly readOnly?: boolean } }>,
): string[] {
  const ids: string[] = []
  for (const entry of entries) if (entry.source.kind === "mcp" && entry.source.readOnly === true) ids.push(entry.id)
  return ids
}

/** The keys of the MCP server tools among `tools` whose binding says they declare themselves read-only. */
export function idsOfTools(tools: Readonly<Record<string, object>>): string[] {
  return Object.entries(tools).flatMap(([id, item]) => (McpCatalog.toolBinding(item)?.readOnly === true ? [id] : []))
}

export * as McpReadonly from "./mcp-readonly"
