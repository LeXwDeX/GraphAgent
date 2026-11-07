// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

export * as DagLocation from "./location"

/**
 * DAG-LOC-01 — the execution-location authority.
 *
 * The DAG runtime (DagLoop, GoalLoop) is per-directory InstanceState, but the
 * durable store, the event bus, and the workflow rows are process-global. A
 * multi-directory server (sibling worktrees of ONE project — same project id)
 * would otherwise let every instance adopt, recover-cancel, wake, and spawn
 * for every workflow. This module is the SINGLE authority that decides which
 * instance may act: the location key is the DIRECTORY, not the project id.
 *
 * The key lives on the workflow row itself (WorkflowTable.directory), stamped
 * at dag.create from the creating instance's directory. Ownership predicates
 * re-read the durable row on every check, so a row whose durable identity was
 * repainted (identity migration) or deleted stops matching and its in-memory
 * runtime entry loses the right to publish transitions.
 *
 * Callers (the loops) pass their own instance directory and know nothing about
 * the SQL or the realpath internals. The Database service is resolved lazily
 * via serviceOption so the loops' static requirements stay unchanged (the
 * optional-cross-dependency pattern); production graphs always carry it.
 */

import { eq } from "drizzle-orm"
import { execFileSync } from "node:child_process"
import { realpathSync, statSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Hash } from "@opencode-ai/core/util/hash"
import { isTerminalWorkflowStatusValue } from "@opencode-ai/core/dag/core/types"
import { WorkflowTable } from "@opencode-ai/core/dag/sql"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { InstanceRef } from "@/effect/instance-ref"

/**
 * Canonical execution-location key: the directory's realpath when resolvable,
 * else the raw path (test directories like /wtA do not exist on disk; the
 * fallback keeps the comparison a plain string equality in that case). Both
 * stamping (dag.create) and checking go through this, so the two sides are
 * always comparable under the same normalization.
 */
export const canonicalDirectory = (directory: string): string => {
  try {
    return realpathSync(directory)
  } catch {
    return directory
  }
}

/** The directory to stamp on a workflow created by the ambient instance. */
export const stampDirectory = (): Effect.Effect<string> =>
  Effect.map(InstanceRef, (instance) => (instance ? canonicalDirectory(instance.directory) : ""))

/**
 * #949: the shared node-location view for status, observe, and HTTP node
 * payloads. Only populated fields are emitted; legacy rows and pre-#949
 * clients see the same shape as before.
 */
export function nodeLocationView(node: {
  directory?: string | null
  baseHead?: string | null
  targetFingerprint?: DagEvent.TargetFingerprint | null
  staleTarget?: boolean | null
  worktreeDirectory?: string | null
  worktreeBranch?: string | null
  worktreeCommit?: string | null
  worktreePatchPath?: string | null
  worktreePatchSha256?: string | null
  worktreeState?: string | null
  worktreeConflictsWith?: string[] | null
  touchedPaths?: string[] | null
  timeUpdated?: number
  startedAt?: number | null
  completedAt?: number | null
}) {
  const activity = node.timeUpdated ?? node.completedAt ?? node.startedAt
  return {
    ...(node.directory ? { directory: node.directory } : {}),
    ...(node.baseHead ? { head: node.baseHead.slice(0, 12) } : {}),
    ...(node.targetFingerprint ? { target_fingerprint: node.targetFingerprint } : {}),
    ...(node.staleTarget ? { stale_target: true } : {}),
    ...(node.worktreeDirectory
      ? {
          worktree: {
            directory: node.worktreeDirectory,
            ...(node.worktreeBranch ? { branch: node.worktreeBranch } : {}),
            ...(node.worktreeCommit ? { commit: node.worktreeCommit } : {}),
            ...(node.worktreePatchPath ? { patch_path: node.worktreePatchPath } : {}),
            ...(node.worktreePatchSha256 ? { patch_sha256: node.worktreePatchSha256 } : {}),
            ...(node.worktreeState ? { state: node.worktreeState } : {}),
            ...(node.touchedPaths?.length ? { touched_paths: node.touchedPaths } : {}),
            ...(node.worktreeConflictsWith?.length ? { conflicts_with: node.worktreeConflictsWith } : {}),
          },
        }
      : node.touchedPaths?.length
        ? { touched_paths: node.touchedPaths }
        : {}),
    ...(activity !== undefined && activity !== null ? { last_activity_at: new Date(activity).toISOString() } : {}),
  }
}

/**
 * #949: the working tree's HEAD when a node attempt starts. Synchronous on
 * purpose — it runs once per spawn, beside the existing synchronous location
 * checks, and a missing git binary, a non-git directory, or an unborn branch
 * all degrade to `undefined` instead of failing the spawn.
 */
export const gitHead = (directory: string): string | undefined => {
  try {
    const text = execFileSync("git", ["-C", directory, "rev-parse", "--verify", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return text || undefined
  } catch {
    return undefined
  }
}

// #944: fingerprint cost is bounded by these limits. A git diff or an
// untracked-file hash that exceeds them degrades to a stable marker instead
// of buffering an unbounded amount of data.
const FINGERPRINT_GIT_TIMEOUT_MS = 20_000
const FINGERPRINT_GIT_MAX_BUFFER = 64 * 1024 * 1024
const FINGERPRINT_UNTRACKED_HASH_FILES = 200
const FINGERPRINT_UNTRACKED_HASH_BYTES = 32 * 1024 * 1024

const gitOutput = (directory: string, args: string[], input?: string): string | undefined => {
  try {
    return execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      ...(input !== undefined ? { input } : {}),
      timeout: FINGERPRINT_GIT_TIMEOUT_MS,
      maxBuffer: FINGERPRINT_GIT_MAX_BUFFER,
    })
  } catch {
    return undefined
  }
}

/**
 * #944: identity of the untracked file set, respecting ignore rules.
 * Paths, sizes, and mtimes are always included; content hashes (git
 * hash-object) are added for a bounded number of files so an editor touch
 * with unchanged content does not change the value on ordinary trees.
 */
function untrackedFingerprint(directory: string): string {
  const listing = gitOutput(directory, ["ls-files", "-o", "--exclude-standard", "-z"])
  if (listing === undefined) return "unavailable"
  const paths = listing
    .split("\0")
    .filter((path) => path !== "")
    .sort()
  if (paths.length === 0) return "clean"
  const metadata: string[] = []
  const hashable: string[] = []
  let bytes = 0
  for (const path of paths) {
    try {
      const stat = statSync(join(directory, path))
      metadata.push(`${path}\0${stat.size}\0${stat.mtimeMs}\0${stat.isFile() ? "file" : "other"}`)
      if (!stat.isFile() || path.includes("\n")) continue
      if (hashable.length >= FINGERPRINT_UNTRACKED_HASH_FILES || bytes + stat.size > FINGERPRINT_UNTRACKED_HASH_BYTES)
        continue
      bytes += stat.size
      hashable.push(path)
    } catch {
      metadata.push(`${path}\0missing`)
    }
  }
  const content =
    hashable.length === 0
      ? "metadata-only"
      : (gitOutput(directory, ["hash-object", "--no-filters", "--stdin-paths"], `${hashable.join("\n")}\n`)?.trim() ??
        "metadata-only")
  return Hash.sha256(JSON.stringify([metadata, content]))
}

/**
 * #944: the target fingerprint recorded at workflow start and before a
 * target-sensitive node starts. Computed from git only (never model-reported).
 * Non-git directories and unborn HEADs get the stable `none` marker. The
 * computation runs a fixed set of git commands; `git diff --binary` is the
 * main cost and is bounded by FINGERPRINT_GIT_MAX_BUFFER.
 */
export const fingerprintTarget = (directory: string): DagEvent.TargetFingerprint => {
  if (!directory) return { kind: "none" }
  if (gitOutput(directory, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") return { kind: "none" }
  const head = gitOutput(directory, ["rev-parse", "--verify", "HEAD"])?.trim()
  if (!head) return { kind: "none" }
  const binary = gitOutput(directory, ["diff", "--binary", "HEAD"])
  const diff = binary === undefined ? "unavailable" : binary.length === 0 ? "clean" : Hash.sha256(binary)
  const untracked = untrackedFingerprint(directory)
  return {
    kind: "git",
    head,
    diff,
    untracked,
    value: Hash.sha256(JSON.stringify([head, diff, untracked])),
  }
}

/**
 * #944: a missing fingerprint cannot prove a mismatch (legacy rows), and two
 * `none` markers are the same stable non-git target. Any git/none transition
 * is a mismatch: the result was judged against a different kind of tree.
 */
export const sameFingerprint = (
  a: DagEvent.TargetFingerprint | null | undefined,
  b: DagEvent.TargetFingerprint | null | undefined,
): boolean => {
  if (!a || !b) return true
  if (a.kind === "git" && (a.diff === "unavailable" || a.untracked === "unavailable")) return false
  if (b.kind === "git" && (b.diff === "unavailable" || b.untracked === "unavailable")) return false
  if (a.kind === "none" && b.kind === "none") return true
  if (a.kind === "none" || b.kind === "none") return false
  return a.value === b.value
}

/**
 * #946: worktree isolation needs a git target with no uncommitted state. A
 * dirty target would leak unrelated edits into every isolated node's commit,
 * so validation fails before spawn.
 */
export const isGitWorktree = (directory: string): boolean =>
  gitOutput(directory, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true"

export const isCleanWorktree = (directory: string): boolean => {
  if (!isGitWorktree(directory)) return false
  const status = gitOutput(directory, ["status", "--porcelain"])
  return status !== undefined && status.trim() === ""
}

/**
 * #949: every worktree of the repository that contains `directory` (the main
 * checkout first). Returns undefined outside git so callers skip the check
 * rather than inventing a mismatch.
 */
export const gitWorktrees = (directory: string): string[] | undefined => {
  try {
    const text = execFileSync("git", ["-C", directory, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return text
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => canonicalDirectory(line.slice("worktree ".length).trim()))
  } catch {
    return undefined
  }
}

/**
 * #943: a node workspace must be an absolute path to a directory that belongs
 * to the same git project as the workflow owner and is listed by
 * `git worktree list`. The returned directory is the canonical realpath, so
 * the value persisted and used by spawn is stable across symlinks.
 */
export type WorkspaceResolution =
  { readonly _tag: "ok"; readonly directory: string } | { readonly _tag: "invalid"; readonly reason: string }

const gitCommonDir = (directory: string): string | undefined => {
  try {
    const text = execFileSync("git", ["-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return text ? canonicalDirectory(text) : undefined
  } catch {
    return undefined
  }
}

export const resolveWorkspace = (workspace: string, ownerDirectory: string): WorkspaceResolution => {
  const invalid = (reason: string): WorkspaceResolution => ({ _tag: "invalid", reason })
  if (!isAbsolute(workspace)) return invalid(`workspace must be an absolute path, got "${workspace}"`)
  let directory: string
  try {
    directory = realpathSync(workspace)
  } catch {
    return invalid(`workspace does not exist: "${workspace}"`)
  }
  try {
    if (!statSync(directory).isDirectory()) return invalid(`workspace is not a directory: "${workspace}"`)
  } catch {
    return invalid(`workspace does not exist: "${workspace}"`)
  }
  const ownerCommon = gitCommonDir(ownerDirectory)
  if (!ownerCommon) {
    return invalid(`workspace requires the workflow owner to be a git project: "${ownerDirectory}"`)
  }
  const workspaceCommon = gitCommonDir(directory)
  if (!workspaceCommon) {
    return invalid(`workspace is not part of a git project: "${workspace}"`)
  }
  if (workspaceCommon !== ownerCommon) {
    return invalid(`workspace belongs to a different project: "${workspace}"`)
  }
  const worktrees = gitWorktrees(ownerDirectory)
  if (!worktrees?.includes(directory)) {
    return invalid(`workspace is not a linked worktree of this project (see git worktree list): "${workspace}"`)
  }
  return { _tag: "ok", directory }
}

/**
 * The durable execution-location verdict shared by adoption, recovery, spawn,
 * and the host-level sweep. `directory` is the bound workspace when present
 * (#943) and the owner directory otherwise, so legacy rows keep their
 * DAG-LOC-01 behavior. `unstamped` covers both NULL (pre-DAG-LOC-01 rows) and
 * an empty stamp; `missing` covers a stamp that no longer names a directory.
 * An EXPLICIT bound workspace is additionally checked for identity on every
 * use: same git project, listed by `git worktree list`, and still resolving to
 * its persisted realpath. A legacy owner fallback keeps the existence-only
 * check, because non-git owner directories are valid.
 */
export type ExecutionLocation =
  | { readonly _tag: "ok"; readonly directory: string }
  | { readonly _tag: "missing"; readonly directory: string }
  | { readonly _tag: "invalid"; readonly directory: string; readonly reason: string }
  | { readonly _tag: "unstamped" }

const UNSTAMPED: ExecutionLocation = { _tag: "unstamped" }

const invalidExecution = (directory: string, reason: string): ExecutionLocation => ({
  _tag: "invalid",
  directory,
  reason,
})

/** Resolve whether a workflow's execution directory can still be used. */
export const resolveExecution = (row: {
  readonly directory: string | null
  readonly executionDirectory?: string | null
}): ExecutionLocation => {
  // A string (including "") is an explicit binding; null/absent means the
  // legacy owner fallback. The two must not share the strict identity check:
  // a non-git owner directory is a valid legacy execution location.
  const explicit = typeof row.executionDirectory === "string"
  const target = explicit ? row.executionDirectory : row.directory
  if (typeof target !== "string" || target === "")
    return explicit ? invalidExecution(target ?? "", "execution directory is empty") : UNSTAMPED
  try {
    if (!statSync(target).isDirectory()) return { _tag: "missing", directory: target }
  } catch {
    return { _tag: "missing", directory: target }
  }
  if (!explicit) return { _tag: "ok", directory: target }
  const canonical = canonicalDirectory(target)
  if (canonical !== target) {
    return invalidExecution(
      target,
      `execution directory resolves to "${canonical}" instead of the bound realpath "${target}"`,
    )
  }
  if (!row.directory) {
    return invalidExecution(target, "workflow has no owner directory to validate the workspace against")
  }
  const resolved = resolveWorkspace(target, row.directory)
  if (resolved._tag === "invalid") return invalidExecution(target, resolved.reason)
  return { _tag: "ok", directory: target }
}

/**
 * The explicit failure reason persisted on the WorkflowFailed event (and thus
 * visible through `workflow status`). Kept in one place so every path that
 * terminalizes an unusable execution location reports the same reason.
 */
export const executionFailureReason = (location: Exclude<ExecutionLocation, { _tag: "ok" }>): string => {
  if (location._tag === "unstamped")
    return "workspace_unstamped: workflow has no recorded execution directory (created before DAG-LOC-01); terminalized. Recreate the workflow to run it again."
  if (location._tag === "invalid")
    return `workspace_invalid: ${location.reason}. Restore the original linked worktree for "${location.directory}" (git worktree add <path> <branch>) or start a new workflow.`
  return `workspace_missing: execution directory "${location.directory}" no longer exists or is not a directory. Restore it (for a linked worktree: git worktree add <path> <branch>) or start a new workflow.`
}

/**
 * Owns the workflow iff its DURABLE row (re-read on every check) still belongs
 * to the ambient instance: the project id matches (fast-reject + R6 identity
 * revalidation — a repainted project_id must not keep driving the old entry)
 * and the stamped directory matches the caller's directory (the deciding
 * guard: sibling worktrees share the project id). Fail-closed: a missing
 * instance or a row without a stamp is never adopted.
 */
export const ownsWorkflow = (workflowID: string, directory: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const instance = yield* InstanceRef
    if (!instance) return false
    const db = yield* Effect.serviceOption(Database.Service)
    if (db._tag === "None") return false
    const row = yield* db.value.db
      .select()
      .from(WorkflowTable)
      .where(eq(WorkflowTable.id, workflowID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return false
    if (row.project_id !== instance.project.id) return false
    if (row.directory === null || row.directory === "") return false
    return canonicalDirectory(row.directory) === canonicalDirectory(directory)
  })

/**
 * Owns the session's EXECUTION wake iff every durable non-terminal workflow row
 * still belongs to the ambient instance (same project id + directory conjunct
 * as ownsWorkflow). Terminal rows are ignored here: they have no execution to
 * own, and a legacy NULL-terminal row must not permanently suppress wake
 * delivery for a later valid workflow in the same session (#948). Delivery of
 * a terminal-only batch is gated separately by the caller on the parent
 * session's directory, so ignoring terminal rows never widens execution
 * ownership. Vacuous-true when the session has no live workflow rows: there is
 * no execution data to deliver and goal-only sessions predate workflow
 * stamping. Also vacuous-true when the Database service is absent from the
 * runtime graph (synthetic goal tests; every production graph carries it) —
 * ownership cannot be disproven there and the gate must not silently disable
 * pre-existing loops. The workflow-row key keeps execution ownership free of
 * session-table reads (R7).
 */
export const ownsSession = (sessionID: string, directory: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const instance = yield* InstanceRef
    if (!instance) return false
    const db = yield* Effect.serviceOption(Database.Service)
    if (db._tag === "None") return true
    const rows = yield* db.value.db
      .select()
      .from(WorkflowTable)
      .where(eq(WorkflowTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    let owned = true
    for (const row of rows) {
      if (isTerminalWorkflowStatusValue(row.status)) continue
      if (row.project_id !== instance.project.id) {
        owned = false
      } else if (row.directory === null || row.directory === "") {
        owned = false
      } else if (canonicalDirectory(row.directory) !== canonicalDirectory(directory)) {
        owned = false
      }
    }
    return owned
  })
