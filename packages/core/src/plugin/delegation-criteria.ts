// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The three tiers of delegation (#1454): do it directly, hand it to a `task` subagent, or run a `workflow` DAG.
 * Defined once. The `task` tool description, the workflow routing text and the `dag-auto` skill each carry the
 * `{{delegation_criteria}}` placeholder and take this text once, when their module loads; no other place restates the
 * criteria.
 * Static text: it never reads the DAG mode, which the `dag_mode` runtime-context block reports.
 */
export const DELEGATION_CRITERIA = [
  "Choose the lightest tier that fits.",
  "- Do it yourself when about five tool calls or fewer finish it.",
  "- Use a `task` subagent when the middle steps are large (many files, long pages or logs), you need only the conclusion, and the job can be described without this conversation.",
  "- Use a `workflow` DAG only when the path can be written out in advance and each node can be verified on its own.",
].join("\n")
