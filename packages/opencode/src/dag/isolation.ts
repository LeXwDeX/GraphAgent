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
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, normalize, sep } from "node:path"

export type WorktreeState = "active" | "removed" | "kept"

export interface WorktreeMetadata {
  directory: string
  branch?: string
  commit?: string
  baseHead?: string
  patchPath?: string
  patchSha256?: string
  touchedPaths: readonly string[]
  state: WorktreeState
  conflictsWith: readonly string[]
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
  const status = git(directory, ["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=all"])
  return status.ok ? parsePorcelain(status.text) : []
}

function parseNameList(text: string): string[] {
  return [...new Set(text.split("\0").filter(Boolean).map(normalizeTouchedPath))].sort()
}

function mergePaths(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].sort()
}

/** Commit everything in an isolated worktree. No changes is a successful
 * no-op; a failed `git add`/`git commit`/`git diff` surfaces the git reason.
 * A clean working tree can still be a committed attempt from a crash before
 * the completion event was persisted; `baseHead..HEAD` then carries the work. */
export function commitWorktree(directory: string, baseHead: string, message: string): WorktreeCommitResult {
  const status = git(directory, ["status", "--porcelain", "--untracked-files=all"])
  if (!status.ok) return { ok: false, reason: `git status failed: ${status.reason}` }
  const touched = parsePorcelain(status.text)
  if (touched.length === 0) {
    if (!baseHead) return { ok: true }
    const head = git(directory, ["rev-parse", "HEAD"])
    if (!head.ok) return { ok: false, reason: `git rev-parse failed: ${head.reason}` }
    if (head.text.trim() === baseHead) return { ok: true }
    const patch = git(directory, ["diff", "--binary", baseHead, "HEAD"])
    if (!patch.ok) return { ok: false, reason: `git diff failed: ${patch.reason}` }
    if (patch.text.length === 0) return { ok: true }
    const names = git(directory, ["diff", "--name-only", "-z", "--no-renames", baseHead, "HEAD"])
    if (!names.ok) return { ok: false, reason: `git diff --name-only failed: ${names.reason}` }
    return {
      ok: true,
      change: {
        commit: head.text.trim(),
        touchedPaths: parseNameList(names.text),
        patch: patch.text,
      },
    }
  }
  const added = git(directory, ["add", "-A"])
  if (!added.ok) return { ok: false, reason: `git add failed: ${added.reason}` }
  const committed = git(directory, ["commit", "-m", message])
  if (!committed.ok) return { ok: false, reason: `git commit failed: ${committed.reason}` }
  const afterCommit = git(directory, [
    "-c",
    "core.quotePath=false",
    "status",
    "--porcelain",
    "--untracked-files=all",
  ])
  if (!afterCommit.ok) return { ok: false, reason: `git status after commit failed: ${afterCommit.reason}` }
  const touchedAfterCommit = mergePaths(touched, parsePorcelain(afterCommit.text))
  if (afterCommit.text.length > 0)
    return { ok: false, reason: `git commit left uncommitted changes; touched paths: ${touchedAfterCommit.join(", ")}` }
  const head = git(directory, ["rev-parse", "HEAD"])
  if (!head.ok) return { ok: false, reason: `git rev-parse failed: ${head.reason}` }
  // #946: a child may have committed earlier in this attempt. The completion
  // status only lists what is dirty now, so union the committed range too —
  // conflict detection must see every path this attempt changed.
  const names = baseHead
    ? git(directory, ["diff", "--name-only", "-z", "--no-renames", baseHead, "HEAD"])
    : undefined
  if (names && !names.ok) return { ok: false, reason: `git diff --name-only failed: ${names.reason}` }
  const touchedPaths = names ? mergePaths(touchedAfterCommit, parseNameList(names.text)) : touchedAfterCommit
  const patch = git(directory, ["diff", "--binary", baseHead, "HEAD"])
  if (!patch.ok) return { ok: false, reason: `git diff failed: ${patch.reason}` }
  return {
    ok: true,
    change: {
      commit: head.text.trim(),
      touchedPaths,
      patch: patch.text,
    },
  }
}

/** A path component written by an isolated node's own identifiers. Durable
 * event IDs are free-form strings, so reject traversal before joining them
 * into the shared report directory. */
function safePathComponent(value: string, label: string): string {
  if (!value || value === "." || value === ".." || /[\\/\0]/.test(value))
    throw new Error(`invalid ${label} for patch artifact: ${JSON.stringify(value)}`)
  return value
}

/** Write an isolated node's patch under the shared report area so it survives
 * the worktree removal. Returns the absolute path and its sha256. */
export function writePatchArtifact(
  reportRoot: string,
  dagID: string,
  nodeID: string,
  patch: string,
): { path: string; sha256: string } {
  const directory = join(reportRoot, ".opencode", "workflow-reports", safePathComponent(dagID, "workflow ID"))
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${safePathComponent(nodeID, "node ID")}.patch`)
  writeFileSync(path, patch)
  return { path, sha256: createHash("sha256").update(patch).digest("hex") }
}

export interface WorktreeCompletion {
  worktree: WorktreeMetadata
  touchedPaths: string[]
}

export type WorktreeCompletionResult =
  | { ok: true; completion: WorktreeCompletion }
  | { ok: false; reason: string }

/** The shared completion step for an isolated node: commit pending work,
 * persist a patch, and return the metadata the caller records. Removal is the
 * caller's job because it needs the owner instance context. */
export function completeWorktree(input: {
  worktree: WorktreeMetadata
  reportRoot: string
  dagID: string
  nodeID: string
  message: string
}): WorktreeCompletionResult {
  if (!existsSync(input.worktree.directory)) {
    if (input.worktree.state === "active")
      return { ok: false, reason: `active worktree directory is missing: ${input.worktree.directory}` }
    return {
      ok: true,
      completion: { worktree: { ...input.worktree, state: "removed" }, touchedPaths: [] },
    }
  }
  const commit = commitWorktree(input.worktree.directory, input.worktree.baseHead ?? "", input.message)
  if (!commit.ok) return commit
  if (!commit.change)
    return {
      ok: true,
      completion: {
        worktree: { ...input.worktree, touchedPaths: [], state: input.worktree.state },
        touchedPaths: [],
      },
    }
  try {
    const artifact = writePatchArtifact(input.reportRoot, input.dagID, input.nodeID, commit.change.patch)
    return {
      ok: true,
      completion: {
        worktree: {
          ...input.worktree,
          commit: commit.change.commit,
          patchPath: artifact.path,
          patchSha256: artifact.sha256,
          touchedPaths: commit.change.touchedPaths,
          state: input.worktree.state,
        },
        touchedPaths: commit.change.touchedPaths,
      },
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** True when two touched paths name the same file or one contains the other.
 * Git status reports files, but a writer may add a path below a directory
 * another writer touched; treating that as overlap keeps the conflict report
 * conservative. */
export function pathOverlaps(a: string, b: string): boolean {
  const first = normalizeTouchedPath(a)
  const second = normalizeTouchedPath(b)
  return first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`)
}

export function conflictsFor(touched: readonly string[], others: readonly TouchedNode[]): ConflictingNode[] {
  const current = touched.map(normalizeTouchedPath)
  if (current.length === 0) return []
  return others.flatMap((node) => {
    const overlap = node.touchedPaths
      .map(normalizeTouchedPath)
      .filter((path) => current.some((candidate) => pathOverlaps(candidate, path)))
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
      const touched = other.touchedPaths.map(normalizeTouchedPath)
      const paths = [
        ...new Set(
          node.touchedPaths
            .map(normalizeTouchedPath)
            .filter((path) => touched.some((candidate) => pathOverlaps(candidate, path))),
        ),
      ].sort()
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
      const touched = second.touchedPaths.map(normalizeTouchedPath)
      const paths = [
        ...new Set(
          first.touchedPaths
            .map(normalizeTouchedPath)
            .filter((path) => touched.some((candidate) => pathOverlaps(candidate, path))),
        ),
      ].sort()
      if (paths.length === 0) continue
      overlaps.push({ nodes: orderedPair(first.id, second.id), paths })
    }
  }
  return overlaps
}
