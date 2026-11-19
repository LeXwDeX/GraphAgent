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

import { realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
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
  /** #1581: the part of `reportedNotRecorded` that is an absolute path below neither the writer's worktree nor the
   * repository, so it cannot be one of the recorded paths; the block says so. Absent when there is none. */
  reportedOutside?: string[]
  /** Recorded, reported by no writer. Empty unless some writer reported. */
  recordedNotReported: string[]
}

type FactNode = Pick<DagStore.NodeRow, "id" | "status" | "dependsOn" | "output" | "touchedPaths" | "worktreeDirectory">

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
 * #1581: `value` as an absolute path with its symlinks resolved as far as it exists: the nearest existing ancestor
 * (the path itself, when it exists) is replaced by its real path and the rest is appended as written. A worktree is
 * removed once its node completes, so a path under it may not exist, and a temporary directory can itself be a
 * symlink (macOS), so two spellings of one place have to meet in one string.
 */
function canonicalPath(value: string): string {
  const real = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      return undefined
    }
  }
  const rest: string[] = []
  let head = resolve(value)
  let resolved = real(head)
  while (resolved === undefined && dirname(head) !== head) {
    rest.unshift(basename(head))
    head = dirname(head)
    resolved = real(head)
  }
  // At the root nothing is left to climb: keep the path as resolved.
  return join(resolved ?? head, ...rest)
}

/**
 * #1581: reads the paths a writer reported the way the engine records them, relative to the root of the writer's
 * worktree, or to the repository root of `directory` for a writer that shared the checkout. A model also reports
 * absolute paths. Left as they are they never match, so one file would show up as reported but not recorded beside
 * the same file recorded but not reported. An absolute path below the writer's worktree, else below the repository,
 * is made relative to that root (the worktree first: it can sit inside the repository, and its record is relative to
 * its own root). One below neither is kept as it is and noted in `outside`.
 */
function makePathReader(directory: string | undefined) {
  const outside = new Set<string>()
  const canonical = new Map<string, string>()
  const real = (value: string) => {
    const known = canonical.get(value)
    if (known !== undefined) return known
    const path = canonicalPath(value)
    canonical.set(value, path)
    return path
  }
  let probed = false
  let root: string | undefined
  const repository = () => {
    if (!probed) {
      probed = true
      root = directory ? DagIsolation.repoRoot(directory) : undefined
    }
    return root
  }
  // The file's own name stays as written (git records a symlink, not its target); only its directory is resolved.
  const below = (base: string | null | undefined, file: string): string | undefined => {
    if (!base) return undefined
    const inside = relative(real(base), join(real(dirname(file)), basename(file)))
    return isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`) ? undefined : inside
  }
  return {
    outside,
    read(worktree: string | null | undefined, reported: string): string {
      if (!isAbsolute(reported)) return DagIsolation.normalizeTouchedPath(reported)
      const inside = below(worktree, reported) ?? below(repository(), reported)
      const path = DagIsolation.normalizeTouchedPath(inside ?? reported)
      if (inside === undefined) outside.add(path)
      return path
    },
  }
}

/**
 * The facts for `node`, or `undefined` when it is not a judging node or no writer upstream has anything to show.
 * A completed ancestor counts when the engine recorded its paths (`touchedPaths` is null for a node settled by
 * recovery outside a worktree) and it either changed something or reported a change. Paths a writer left dirty
 * before it started, and what it committed itself, are not recorded and so are not attributed to it. A path a
 * writer reported as an absolute one is compared as the relative path it names (`makePathReader`).
 */
export function collectChangeFacts(input: {
  node: Pick<DagStore.NodeRow, "dependsOn" | "workerType">
  nodeConfig: Pick<NodeConfig, "block" | "review"> | undefined
  nodes: readonly FactNode[]
  directory: string | undefined
}): ChangeFacts | undefined {
  if (!judgesChanges(input.node, input.nodeConfig)) return undefined
  const reader = makePathReader(input.directory)
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
    for (const path of claimed) reported.add(reader.read(row.worktreeDirectory, path))
    if (claimed.length > 0) anyReported = true
  }
  if (selected === 0) return undefined
  const paths = [...recorded].sort()
  const counts = input.directory && paths.length > 0 ? DagIsolation.numstat(input.directory) : undefined
  const reportedNotRecorded = anyReported ? [...reported].filter((path) => !recorded.has(path)).sort() : []
  const reportedOutside = reportedNotRecorded.filter((path) => reader.outside.has(path))
  return {
    recorded: paths,
    ...(counts ? { counts } : {}),
    reportedNotRecorded,
    ...(reportedOutside.length > 0 ? { reportedOutside } : {}),
    recordedNotReported: anyReported ? paths.filter((path) => !reported.has(path)) : [],
  }
}

// Characters that end or break a line, plus the other control characters; a tab stays as it is.
const LINE_BREAKING = /[\u0000-\u0008\u000a-\u001f\u007f\u0085\u2028\u2029]/g

/**
 * A path as one line of the block: envelope tags escaped, and every line break or control character written as
 * an escape (`\n`, `\r`, `\u000b`, ...). A reported path is model text; without this a newline in it would start an
 * unprefixed line inside the engine's block and slip past the line budget.
 */
function factPath(path: string): string {
  return escapeEnvelopeTags(path).replace(LINE_BREAKING, (char) =>
    char === "\n" ? "\\n" : char === "\r" ? "\\r" : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}

/** What ends the line of a reported path that is below no root the engine records against (`reportedOutside`). */
const OUTSIDE_NOTE = " (outside the repository)"

/** The `<engine-facts>` block: differences first, then the recorded paths with their counts, at most
 * `MAX_FACT_LINES` of those lines, the remainder counted. Paths pass through `factPath`. */
export function renderChangeFacts(facts: ChangeFacts): string {
  const outside = new Set(facts.reportedOutside)
  const differences = [
    ...facts.reportedNotRecorded.map(
      (path) => `reported, not recorded: ${factPath(path)}${outside.has(path) ? OUTSIDE_NOTE : ""}`,
    ),
    ...facts.recordedNotReported.map((path) => `recorded, not reported: ${factPath(path)}`),
  ]
  const paths = facts.recorded.map((path) => `- ${factPath(path)} ${facts.counts?.get(path) ?? "(no line counts)"}`)
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
