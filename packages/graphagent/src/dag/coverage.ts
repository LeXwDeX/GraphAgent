// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Workflow coverage and truncation (#1031 M6).
 *
 * The engine, not the delivering model, accounts for what did not run or was
 * not read: condition-gated and failed nodes, a fan-out that fell back to a
 * serial writer, a compose expansion that degraded or did not split an item, a
 * budget pause, review lanes that declared gaps, and result pages the caller
 * stopped short of. `inspect` renders the list and the final report appends a
 * deterministic section. M7 adds safety denials to the same list; no safety
 * policy lives here.
 */
export * as DagCoverage from "./coverage"

import { PAUSE_REASON_BUDGET_EXHAUSTED } from "@graphagent/core/dag/core/types"
import type { DagStore } from "@graphagent/core/dag/store"
import type { UiLanguage } from "@graphagent/core/config/language"
import type { WorkflowConfig } from "./dag"
import { reviewRoundQuietStreak } from "./review-lifecycle"
import { normalizeOutput } from "./runtime/verdict"
import { isRecord } from "@/util/record"

/** Page window a result read covered, when coverage records paging. */
export interface CoveragePage {
  current: number
  total: number
}

/** One node-level reason the caller did not see the whole picture. */
export interface CoverageEntry {
  node_id: string
  reason: string
  page?: CoveragePage
}

/** `output` may be absent for a row whose output the caller did not load: such
 * a row simply has no `not_examined` entries or review stop to contribute. */
type CoverageNode = Pick<
  DagStore.NodeRow,
  "id" | "status" | "errorReason" | "errorClass" | "superseded" | "safetyDenials"
> & { output?: unknown }

const record = (value: unknown): Record<string, unknown> | undefined => {
  const parsed = normalizeOutput(value)
  return isRecord(parsed) ? parsed : undefined
}

/**
 * Deterministic coverage entries for a workflow snapshot. `workflow` carries
 * the terminal/paused state reasons that belong to no single node (currently
 * the budget pause).
 */
export function workflowCoverage(input: {
  config: WorkflowConfig | undefined
  nodes: readonly CoverageNode[]
  workflow?: { status: string; pauseReason?: string | null }
}): CoverageEntry[] {
  const entries: CoverageEntry[] = []
  const definitions = new Map((input.config?.nodes ?? []).map((node) => [node.id, node]))
  const current = input.nodes.filter((node) => !node.superseded)
  for (const node of current) {
    const definition = definitions.get(node.id)
    if (node.status === "skipped") {
      entries.push({
        node_id: node.id,
        reason: definition?.condition
          ? `gated: condition evaluated false (${definition.condition})`
          : "skipped",
      })
    } else if (node.status === "aborted") {
      entries.push({ node_id: node.id, reason: `aborted${node.errorReason ? `: ${node.errorReason}` : ""}` })
    } else if (node.status === "failed") {
      const details = [node.errorClass, node.errorReason].filter(Boolean).join(": ")
      entries.push({ node_id: node.id, reason: `failed${details ? `: ${details}` : ""}` })
    }
    // #1031 M7: a denied tool call is not a node failure, but the caller must
    // still know the node did not try the whole task. The stored entries are
    // bounded; the total keeps the count honest past the bound.
    const denials = node.safetyDenials
    if (denials && denials.total > 0) {
      const rules = denials.items.map((item) => item.ruleID).join(", ")
      const overflow = denials.total - denials.items.length
      entries.push({
        node_id: node.id,
        reason: `safety denied: ${rules || "recorded"}${
          overflow > 0 ? ` (${overflow} more not listed)` : ""
        }`,
      })
    }
    const notExamined = record(node.output)?.not_examined
    if (Array.isArray(notExamined)) {
      for (const item of notExamined) {
        if (typeof item === "string" && item.trim() !== "")
          entries.push({ node_id: node.id, reason: `not examined: ${item}` })
      }
    }
  }

  // A fan-out writer that never expanded ran every package serially. The
  // runtime decline rewrites the persisted definition (the marker is gone and
  // the reason is baked into its prompt); a marker that is still present means
  // the expansion never committed. Both shapes are reported.
  for (const definition of input.config?.nodes ?? []) {
    // The persisted config is parsed tolerantly (an older row may omit
    // prompt_template), so never assume the field exists.
    const declined = /Parallel fan-out was declined \(([^)]*)\)/.exec(definition.prompt_template?.inline ?? "")
    if (declined) {
      entries.push({ node_id: definition.id, reason: `parallel fan-out declined: ${declined[1]}` })
      continue
    }
    if (definition.fan_out === undefined) continue
    const expanded = current.some((node) => node.id.startsWith(`${definition.id}--`))
    const ran = current.some(
      (node) =>
        node.id === definition.id
        && ["running", "completed", "failed", "skipped", "aborted"].includes(node.status),
    )
    if (!expanded && ran)
      entries.push({ node_id: definition.id, reason: "parallel fan-out declined; the writer ran serially" })
  }

  // #1158: a compose expansion that did not follow its plan is reported the way a declined fan-out is. The join
  // node keeps why in its persisted `join` (a recovery rewrites it to the attempts that now count): the plan could
  // not be expanded and one fallback worker took the whole task, or an item that asked to be split again ran as one
  // worker. A join the admission check refused (`compose_required_missing`, `compose_no_results`) is a failed node,
  // which the node entries above already list with its error class and reason.
  for (const definition of input.config?.nodes ?? []) {
    const join = definition.join
    if (join === undefined) continue
    if (join.degraded !== undefined)
      entries.push({ node_id: definition.id, reason: `compose expansion degraded: ${join.degraded}` })
    for (const item of join.items) {
      if (item.unsplit === undefined) continue
      entries.push({ node_id: item.node, reason: `compose split declined: ${item.unsplit}` })
    }
  }

  // A review loop that stopped for its own rule (not the dry-run default)
  // reports why: the caller must surface the remaining open findings. The
  // quiet streak is measured from the completed decision's own dispositions
  // (the same accounting as the prior-round loader), never from the compiled
  // `review_quiet_rounds`: that field is the streak the round entered with,
  // and a pending or raised round must not report a stop.
  for (const definition of input.config?.nodes ?? []) {
    if (definition.review_arbitration !== true) continue
    if ((definition.review_round ?? 1) >= 5) {
      entries.push({ node_id: definition.id, reason: "review loop stopped: five rounds reached" })
      continue
    }
    const completed = current.find((node) => node.id === definition.id && node.status === "completed")
    if (!completed) continue
    const raisedWithoutDispositions = definition.depends_on.reduce((sum, laneID) => {
      if (definitions.get(laneID)?.review_lane === undefined) return sum
      const actions = record(current.find((node) => node.id === laneID)?.output)?.required_actions
      return sum + (Array.isArray(actions) ? actions.length : 0)
    }, 0)
    const { quietRounds } = reviewRoundQuietStreak(
      completed.output,
      definition.review_quiet_rounds ?? 0,
      raisedWithoutDispositions,
    )
    if (quietRounds >= 2)
      entries.push({ node_id: definition.id, reason: "review loop stopped: two consecutive quiet rounds" })
  }

  if (input.workflow?.pauseReason === PAUSE_REASON_BUDGET_EXHAUSTED)
    entries.push({ node_id: "workflow", reason: "paused: DAG token budget exhausted" })
  return entries
}

/** The result read stopped at `page`; later pages were never shown. */
export function withResultPageCoverage(
  entries: readonly CoverageEntry[],
  input: { nodeID: string; page: CoveragePage; truncated: boolean },
): CoverageEntry[] {
  if (!input.truncated) return [...entries]
  return [
    ...entries,
    { node_id: input.nodeID, reason: "result pages were not fully read", page: input.page },
  ]
}

/** Page window for a byte/char offset read, or undefined when it fit one page. */
export function resultPage(totalChars: number, pageEnd: number, limit: number): CoveragePage {
  const total = Math.max(1, Math.ceil(totalChars / limit))
  const currentPage = Math.max(1, Math.ceil(pageEnd / limit))
  return { current: Math.min(currentPage, total), total }
}

/**
 * The deterministic section the final report appends. Empty coverage means no
 * section at all; the title follows the configured interface language.
 */
export function coverageSection(entries: readonly CoverageEntry[], language: UiLanguage): string | undefined {
  if (entries.length === 0) return undefined
  const title = language === "zh-CN" ? "覆盖与截断" : "Coverage and truncation"
  const lines = entries.map((entry) => {
    if (entry.page === undefined) return `- ${entry.node_id}: ${entry.reason}`
    return language === "zh-CN"
      ? `- ${entry.node_id}: 未读页（第 ${entry.page.current} 页，共 ${entry.page.total} 页）`
      : `- ${entry.node_id}: unread pages (page ${entry.page.current} of ${entry.page.total})`
  })
  return [`## ${title}`, ...lines].join("\n")
}