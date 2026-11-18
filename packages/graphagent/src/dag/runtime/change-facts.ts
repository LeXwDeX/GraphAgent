// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * #1455: the change facts a verify or review node is given.
 *
 * Completion is judged by checks, not by what a model says about its own work. The engine records the paths a
 * writer actually changed (`touched_paths`, written when the node completes); a writer also reports its own
 * `changed_files`. This module hands a judging node both, side by side, with the line counts git measured,
 * so a claim the engine did not see (or a change nobody claimed) is visible where the verdict is made.
 */

import type { DagStore } from "@graphagent/core/dag/store"
import type { NodeConfig } from "../dag"
import { DagIsolation } from "../isolation"
import { isReviewWorker } from "../review-lifecycle"
import { escapeEnvelopeTags } from "../templates/envelope"

/** Most difference and path lines one block shows; the rest is counted, not listed. */
export const MAX_FACT_LINES = 60

export interface ChangeFacts {
  /** Paths the engine recorded for the completed writers upstream, normalized and ascending. */
  recorded: string[]
  /** `+<added> -<deleted>` per recorded path that git measured; absent when nothing was measured. */
  counts?: Map<string, string>
  /** Reported by a writer, not among the recorded paths. Empty unless some writer reported. */
  reportedNotRecorded: string[]
  /** Recorded, reported by no writer. Empty unless some writer reported. */
  recordedNotReported: string[]
}

type FactNode = Pick<DagStore.NodeRow, "id" | "status" | "dependsOn" | "output" | "touchedPaths">

/** Only a node that judges the work gets facts: a verify or review block, a review config, a review worker. */
function judgesChanges(
  node: Pick<DagStore.NodeRow, "workerType">,
  nodeConfig: Pick<NodeConfig, "block" | "review"> | undefined,
): boolean {
  return (
    nodeConfig?.block === "verify" ||
    nodeConfig?.block === "review" ||
    nodeConfig?.review !== undefined ||
    isReviewWorker(node.workerType)
  )
}

/** The `changed_files` a writer reported in its output: the strings of an array, empty for any other shape. */
function reportedPaths(output: unknown): string[] {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return []
  const files = (output as { changed_files?: unknown }).changed_files
  return Array.isArray(files)
    ? files.filter((file): file is string => typeof file === "string" && file.trim() !== "")
    : []
}

/**
 * The facts for `node`, or `undefined` when it is not a judging node or no writer upstream has anything to show.
 * A completed ancestor counts when the engine recorded its paths (`touchedPaths` is null for a node settled by
 * recovery outside a worktree) and it either changed something or reported a change. Paths a writer left dirty
 * before it started, and what it committed itself, are not recorded and so are not attributed to it.
 */
export function collectChangeFacts(input: {
  node: Pick<DagStore.NodeRow, "dependsOn" | "workerType">
  nodeConfig: Pick<NodeConfig, "block" | "review"> | undefined
  nodes: readonly FactNode[]
  directory: string | undefined
}): ChangeFacts | undefined {
  if (!judgesChanges(input.node, input.nodeConfig)) return undefined
  const byID = new Map(input.nodes.map((row) => [row.id, row]))
  const recorded = new Set<string>()
  const reported = new Set<string>()
  const seen = new Set<string>()
  const pending = [...input.node.dependsOn]
  let selected = 0
  let anyReported = false
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (seen.has(id)) continue
    seen.add(id)
    const row = byID.get(id)
    if (!row) continue
    pending.push(...row.dependsOn)
    if (row.status !== "completed" || row.touchedPaths == null) continue
    const claimed = reportedPaths(row.output)
    if (row.touchedPaths.length === 0 && claimed.length === 0) continue
    selected++
    for (const path of row.touchedPaths) recorded.add(DagIsolation.normalizeTouchedPath(path))
    for (const path of claimed) reported.add(DagIsolation.normalizeTouchedPath(path))
    if (claimed.length > 0) anyReported = true
  }
  if (selected === 0) return undefined
  const paths = [...recorded].sort()
  const counts = input.directory && paths.length > 0 ? DagIsolation.numstat(input.directory) : undefined
  return {
    recorded: paths,
    ...(counts ? { counts } : {}),
    reportedNotRecorded: anyReported ? [...reported].filter((path) => !recorded.has(path)).sort() : [],
    recordedNotReported: anyReported ? paths.filter((path) => !reported.has(path)) : [],
  }
}

/** The `<engine-facts>` block: differences first, then the recorded paths with their counts, at most
 * `MAX_FACT_LINES` of those lines, the remainder counted. Paths pass through `escapeEnvelopeTags`. */
export function renderChangeFacts(facts: ChangeFacts): string {
  const differences = [
    ...facts.reportedNotRecorded.map((path) => `reported, not recorded: ${escapeEnvelopeTags(path)}`),
    ...facts.recordedNotReported.map((path) => `recorded, not reported: ${escapeEnvelopeTags(path)}`),
  ]
  const paths = facts.recorded.map(
    (path) => `- ${escapeEnvelopeTags(path)} ${facts.counts?.get(path) ?? "(no line counts)"}`,
  )
  const shownDifferences = differences.slice(0, MAX_FACT_LINES)
  const shownPaths = paths.slice(0, MAX_FACT_LINES - shownDifferences.length)
  const hidden = differences.length + paths.length - shownDifferences.length - shownPaths.length
  return [
    '<engine-facts source="git">',
    "Measured by the engine from git, not reported by any model.",
    ...shownDifferences,
    `recorded paths (${facts.recorded.length}):`,
    ...shownPaths,
    ...(hidden > 0 ? [`... ${hidden} more not shown`] : []),
    "</engine-facts>",
  ].join("\n")
}
