// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

export * as DagIsolation from "./isolation"

/**
 * #946: per-node worktree evidence and conflict detection.
 *
 * This module owns the small, side-effect-free comparisons used by completion
 * (conflict marking), status (workflow-level conflict and overlap views) and
 * the git reads that turn a finished worktree into a commit, a touched-path
 * list and a patch. It never creates or removes worktrees: that lifecycle
 * belongs to the Worktree service.
 */

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, normalize, sep } from "node:path"

export type WorktreeState = "active" | "removed" | "kept"

export interface WorktreeMetadata {
  directory: string
  branch?: string
  commit?: string
  baseHead?: string
  patchPath?: string
  patchSha256?: string
  touchedPaths: string[]
  state: WorktreeState
  conflictsWith: string[]
}

export interface WorktreeCommit {
  commit: string
  touchedPaths: string[]
  patch: string
}

export type WorktreeCommitResult =
  | { ok: true; change?: WorktreeCommit }
  | { ok: false; reason: string }

export interface TouchedNode {
  readonly id: string
  readonly touchedPaths: readonly string[]
}

export interface ConflictingNode {
  readonly nodeID: string
  readonly paths: string[]
}

export interface ConflictGroup {
  readonly nodes: [string, string]
  readonly paths: string[]
}

function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

export interface OverlapNode extends TouchedNode {
  readonly dependsOn: readonly string[]
  readonly isolated: boolean
}

export interface ParallelOverlap {
  readonly nodes: [string, string]
  readonly paths: string[]
}

const GIT_TIMEOUT_MS = 20_000
const GIT_MAX_BUFFER = 64 * 1024 * 1024

function git(directory: string, args: string[]): { ok: true; text: string } | { ok: false; reason: string } {
  try {
    return {
      ok: true,
      text: execFileSync("git", ["-C", directory, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      }),
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, reason }
  }
}

/** Status paths use `/` even on Windows; normalize both sides before compare. */
export function normalizeTouchedPath(value: string): string {
  const normalized = normalize(value).split(sep).join("/")
  return normalized.startsWith("./") ? normalized.slice(2) : normalized
}

/** Parse `git status --porcelain` output into unique, normalized paths. A
 * rename/copy line reports its destination path (`old -> new`). */
export function parsePorcelain(text: string): string[] {
  const paths = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 3)
    .map((line) => {
      const path = line.slice(3)
      const renamed = path.includes(" -> ") ? path.slice(path.lastIndexOf(" -> ") + 4) : path
      return normalizeTouchedPath(renamed.replace(/^"(.*)"$/, "$1"))
    })
    .filter((path) => path.length > 0)
  return [...new Set(paths)].sort()
}

/** The working tree's touched paths at completion. Non-git directories and
 * git failures yield an empty list instead of failing the node. */
export function touchedPaths(directory: string): string[] {
  const status = git(directory, ["status", "--porcelain"])
  return status.ok ? parsePorcelain(status.text) : []
}

/** Commit everything in an isolated worktree. No changes is a successful
 * no-op; a failed `git add`/`git commit`/`git diff` surfaces the git reason. */
export function commitWorktree(directory: string, baseHead: string, message: string): WorktreeCommitResult {
  const status = git(directory, ["status", "--porcelain"])
  if (!status.ok) return { ok: false, reason: `git status failed: ${status.reason}` }
  const touched = parsePorcelain(status.text)
  if (touched.length === 0) return { ok: true }
  const added = git(directory, ["add", "-A"])
  if (!added.ok) return { ok: false, reason: `git add failed: ${added.reason}` }
  const committed = git(directory, ["commit", "-m", message])
  if (!committed.ok) return { ok: false, reason: `git commit failed: ${committed.reason}` }
  const head = git(directory, ["rev-parse", "HEAD"])
  if (!head.ok) return { ok: false, reason: `git rev-parse failed: ${head.reason}` }
  const patch = git(directory, ["diff", "--binary", baseHead, "HEAD"])
  if (!patch.ok) return { ok: false, reason: `git diff failed: ${patch.reason}` }
  return {
    ok: true,
    change: {
      commit: head.text.trim(),
      touchedPaths: touched,
      patch: patch.text,
    },
  }
}

/** Write an isolated node's patch under the shared report area so it survives
 * the worktree removal. Returns the absolute path and its sha256. */
export function writePatchArtifact(
  reportRoot: string,
  dagID: string,
  nodeID: string,
  patch: string,
): { path: string; sha256: string } {
  const directory = join(reportRoot, ".opencode", "workflow-reports", dagID)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${nodeID}.patch`)
  writeFileSync(path, patch)
  return { path, sha256: createHash("sha256").update(patch).digest("hex") }
}

export function conflictsFor(touched: readonly string[], others: readonly TouchedNode[]): ConflictingNode[] {
  const current = new Set(touched.map(normalizeTouchedPath))
  if (current.size === 0) return []
  return others.flatMap((node) => {
    const overlap = node.touchedPaths
      .map(normalizeTouchedPath)
      .filter((path) => current.has(path))
    if (overlap.length === 0) return []
    return [{ nodeID: node.id, paths: [...new Set(overlap)].sort() }]
  })
}

export interface ConflictNode extends TouchedNode {
  readonly conflictsWith: readonly string[]
}

/** Workflow-level conflict groups. Each pair is reported once, with the paths
 * both sides changed. Only nodes that recorded a conflict participate. */
export function conflictGroups(nodes: readonly ConflictNode[]): ConflictGroup[] {
  const byID = new Map(nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  const groups: ConflictGroup[] = []
  for (const node of nodes) {
    for (const otherID of node.conflictsWith) {
      if (otherID === node.id) continue
      const other = byID.get(otherID)
      if (!other) continue
      const key = [node.id, otherID].sort().join("\0")
      if (seen.has(key)) continue
      seen.add(key)
      const touched = new Set(other.touchedPaths.map(normalizeTouchedPath))
      const paths = [...new Set(node.touchedPaths.map(normalizeTouchedPath).filter((path) => touched.has(path)))].sort()
      groups.push({ nodes: orderedPair(node.id, otherID), paths })
    }
  }
  return groups.sort((a, b) => a.nodes.join("\0").localeCompare(b.nodes.join("\0")))
}

function reaches(nodes: ReadonlyMap<string, OverlapNode>, from: string, target: string): boolean {
  const pending = [...(nodes.get(from)?.dependsOn ?? [])]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current === target) return true
    if (seen.has(current)) continue
    seen.add(current)
    pending.push(...(nodes.get(current)?.dependsOn ?? []))
  }
  return false
}

/** Non-isolated writers that edited the same paths without an ordering edge
 * between them. Ordered pairs are not "parallel" and are left out. */
export function parallelOverlaps(nodes: readonly OverlapNode[]): ParallelOverlap[] {
  const byID = new Map(nodes.map((node) => [node.id, node]))
  const writers = nodes.filter((node) => !node.isolated && node.touchedPaths.length > 0)
  const overlaps: ParallelOverlap[] = []
  for (let a = 0; a < writers.length; a++) {
    for (let b = a + 1; b < writers.length; b++) {
      const first = writers[a]
      const second = writers[b]
      if (reaches(byID, first.id, second.id) || reaches(byID, second.id, first.id)) continue
      const touched = new Set(second.touchedPaths.map(normalizeTouchedPath))
      const paths = [...new Set(first.touchedPaths.map(normalizeTouchedPath).filter((path) => touched.has(path)))].sort()
      if (paths.length === 0) continue
      overlaps.push({ nodes: orderedPair(first.id, second.id), paths })
    }
  }
  return overlaps
}
