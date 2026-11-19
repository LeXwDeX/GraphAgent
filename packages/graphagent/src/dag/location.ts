// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

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
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { Cause, Effect } from "effect"
import { ChildProcess } from "effect/process"
import { Database } from "@graphagent/core/database/database"
import { AppProcess } from "@graphagent/core/process"
import { Hash } from "@graphagent/core/util/hash"
import { isTerminalWorkflowStatusValue } from "@graphagent/core/dag/core/types"
import { WorkflowTable } from "@graphagent/core/dag/sql"
import { DagEvent } from "@graphagent/schema/dag-event"
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

/**
 * #1583: `canonicalDirectory` that waits for the disk off the event loop, for the
 * checks a caller that holds the workflow lock makes: the realpath when it
 * resolves, else the raw path. `realpath` of `node:fs/promises` answers what
 * `realpathSync` does for every path these checks hand it (a directory that
 * exists or does not, a link, a link loop, a path too long); it differs only for
 * the empty path and for a file followed by a separator or by `/.`, which
 * neither the output of git nor a directory that was just found to exist can be.
 * Never rejects.
 */
const canonicalDirectoryAsync = async (directory: string): Promise<string> => {
  try {
    return await realpath(directory)
  } catch {
    return directory
  }
}

/** The directory to stamp on a workflow created by the ambient instance. */
export const stampDirectory = (): Effect.Effect<string> =>
  Effect.map(InstanceRef, (instance) => (instance ? canonicalDirectory(instance.directory) : ""))

/**
 * #949: the shared node-location view for status, observe, and HTTP node
 * payloads. Only populated fields are emitted, so a node that recorded no
 * location (non-git target, non-isolated run) keeps the same short shape.
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

/** #1030: the worktree's current branch name, or undefined when detached or
 * outside git. Settlement reports the branch next to the final commit. */
export const gitBranch = (directory: string): string | undefined => {
  try {
    const text = execFileSync("git", ["-C", directory, "symbolic-ref", "--quiet", "--short", "HEAD"], {
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
// #1583: how many untracked files are looked at on the disk at once.
const FINGERPRINT_STAT_BATCH = 64

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
 * #1344: `gitOutput` for the target fingerprint, as a child process of the app's
 * process runner (`AppProcess`, the one every effectful git caller uses) instead
 * of `execFileSync`: waiting for git no longer blocks the event loop, and an
 * interrupted caller kills the child. The command line, the limits, and the
 * degradation are exactly `gitOutput`'s: a git that cannot be spawned (or be
 * given the path), exits non-zero, times out, or overruns the output cap yields
 * `undefined`; only an interruption gets through. No config flags are added
 * (unlike `Git.Service`), so the value is the one `execFileSync` produced for
 * the same tree.
 */
const gitOutputAsync = Effect.fnUntraced(
  function* (directory: string, args: string[], input?: string) {
    const appProcess = yield* AppProcess.Service
    const result = yield* appProcess.run(
      ChildProcess.make("git", ["-C", directory, ...args], {
        extendEnv: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      }),
      {
        timeout: FINGERPRINT_GIT_TIMEOUT_MS,
        maxOutputBytes: FINGERPRINT_GIT_MAX_BUFFER,
        ...(input !== undefined ? { stdin: input } : {}),
      },
    )
    return result.exitCode === 0 && !result.stdoutTruncated ? result.stdout.toString("utf8") : undefined
  },
  Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(undefined))),
)

/**
 * #1344: `gitHead` for a caller that holds the workflow lock: the same command
 * and the same degradation to `undefined`, waiting for git without blocking the
 * event loop and bounded by the limits of the fingerprint's git commands (the
 * synchronous call had none). Never fails; only an interruption gets through.
 */
export const gitHeadAsync = Effect.fn("DagLocation.gitHeadAsync")(function* (
  directory: string,
): Effect.fn.Return<string | undefined, never, AppProcess.Service> {
  const text = (yield* gitOutputAsync(directory, ["rev-parse", "--verify", "HEAD"]))?.trim()
  return text || undefined
}, Effect.provide(AppProcess.defaultLayer))

/**
 * #1583: the metadata of the untracked paths, and the ones whose content is worth
 * hashing, with the stats waited for off the event loop, a batch of them at a
 * time so that a tree with many untracked files neither floods the thread pool
 * nor takes much longer than the synchronous loop did. Every batch is decided
 * before the next one is asked for, in the order of `paths`, as the synchronous
 * loop decided one stat at a time, so the metadata and the hashed set are the
 * same, and no more is held than that loop held. A path that cannot be looked at
 * (deleted since git listed it, a link to nothing) is `missing`, as the `catch`
 * of that loop took it. An interrupted caller no longer waits for the answer, so
 * the batches stop at the next one instead of finishing a long listing for nobody.
 */
const lookAtUntracked = async (directory: string, paths: readonly string[], signal: AbortSignal) => {
  const metadata: string[] = []
  const hashable: string[] = []
  let bytes = 0
  for (let start = 0; start < paths.length && !signal.aborted; start += FINGERPRINT_STAT_BATCH) {
    const batch = paths.slice(start, start + FINGERPRINT_STAT_BATCH)
    const stats = await Promise.all(batch.map((path) => stat(join(directory, path)).catch(() => undefined)))
    for (const [index, path] of batch.entries()) {
      const info = stats[index]
      if (!info) {
        metadata.push(`${path}\0missing`)
        continue
      }
      metadata.push(`${path}\0${info.size}\0${info.mtimeMs}\0${info.isFile() ? "file" : "other"}`)
      if (!info.isFile() || path.includes("\n")) continue
      if (hashable.length >= FINGERPRINT_UNTRACKED_HASH_FILES || bytes + info.size > FINGERPRINT_UNTRACKED_HASH_BYTES)
        continue
      bytes += info.size
      hashable.push(path)
    }
  }
  return { metadata, hashable }
}

/**
 * #944: identity of the untracked file set, respecting ignore rules.
 * Paths, sizes, and mtimes are always included; content hashes (git
 * hash-object) are added for a bounded number of files so an editor touch
 * with unchanged content does not change the value on ordinary trees.
 *
 * #1583: the per-file stats are waited for off the event loop (`lookAtUntracked`).
 */
const untrackedFingerprint = Effect.fnUntraced(function* (
  directory: string,
): Effect.fn.Return<string, never, AppProcess.Service> {
  const listing = yield* gitOutputAsync(directory, ["ls-files", "-o", "--exclude-standard", "-z"])
  if (listing === undefined) return "unavailable"
  const paths = listing
    .split("\0")
    .filter((path) => path !== "")
    .sort()
  if (paths.length === 0) return "clean"
  const { metadata, hashable } = yield* Effect.promise((signal) => lookAtUntracked(directory, paths, signal))
  const hashed =
    hashable.length === 0
      ? undefined
      : yield* gitOutputAsync(directory, ["hash-object", "--no-filters", "--stdin-paths"], `${hashable.join("\n")}\n`)
  const content = hashed?.trim() ?? "metadata-only"
  return Hash.sha256(JSON.stringify([metadata, content]))
})

/**
 * #944: the target fingerprint recorded at workflow start and before a
 * target-sensitive node starts. Computed from git only (never model-reported).
 * Non-git directories and unborn HEADs get the stable `none` marker. The
 * computation runs a fixed set of git commands; `git diff --binary` is the
 * main cost and is bounded by FINGERPRINT_GIT_MAX_BUFFER.
 *
 * #1344: asynchronous. Every git command is a child process of the app's
 * process runner, so the event loop keeps turning while they run; the hashing
 * and the per-file stats of the untracked listing stay inline. The value, the
 * comparison, and the fallbacks are those of the synchronous version it
 * replaced. The runner comes from its default layer, so no caller's layer
 * requirements change. Never fails.
 */
export const fingerprintTarget = Effect.fn("DagLocation.fingerprintTarget")(function* (
  directory: string,
): Effect.fn.Return<DagEvent.TargetFingerprint, never, AppProcess.Service> {
  if (!directory) return { kind: "none" }
  const inside = yield* gitOutputAsync(directory, ["rev-parse", "--is-inside-work-tree"])
  if (inside?.trim() !== "true") return { kind: "none" }
  const head = (yield* gitOutputAsync(directory, ["rev-parse", "--verify", "HEAD"]))?.trim()
  if (!head) return { kind: "none" }
  const binary = yield* gitOutputAsync(directory, ["diff", "--binary", "HEAD"])
  const diff = binary === undefined ? "unavailable" : binary.length === 0 ? "clean" : Hash.sha256(binary)
  const untracked = yield* untrackedFingerprint(directory)
  return {
    kind: "git",
    head,
    diff,
    untracked,
    value: Hash.sha256(JSON.stringify([head, diff, untracked])),
  }
}, Effect.provide(AppProcess.defaultLayer))

/**
 * #944: a missing fingerprint cannot prove a mismatch, and two `none` markers
 * are the same stable non-git target. Any git/none transition is a mismatch:
 * the result was judged against a different kind of tree.
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
  // An empty path must never fall back to the ambient process cwd: `git -C ""`
  // does, which would report the test runner's own repository as the target.
  directory !== "" && gitOutput(directory, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true"

export const isCleanWorktree = (directory: string): boolean => {
  if (!isGitWorktree(directory)) return false
  const status = gitOutput(directory, ["status", "--porcelain"])
  return status !== undefined && status.trim() === ""
}

/** The directories `git worktree list --porcelain` names, as it spells them, the main checkout first. */
const worktreeDirectories = (text: string): string[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())

/** The canonical directories `git worktree list --porcelain` names, the main checkout first. */
const worktreePaths = (text: string): string[] => worktreeDirectories(text).map((line) => canonicalDirectory(line))

/** `worktreePaths` that waits for the disk off the event loop (#1583), the directories in the same order. */
const worktreePathsAsync = (text: string): Promise<string[]> =>
  Promise.all(worktreeDirectories(text).map((line) => canonicalDirectoryAsync(line)))

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
    return worktreePaths(text)
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

const invalidWorkspace = (reason: string): WorkspaceResolution => ({ _tag: "invalid", reason })

type WorkspaceDirectory = { readonly directory: string } | { readonly reason: string }

// The three reasons a workspace is refused without git, written once for
// `workspaceDirectory` and `workspaceDirectoryAsync` so that the two cannot drift apart.
const workspaceNotAbsolute = (workspace: string): WorkspaceDirectory => ({
  reason: `workspace must be an absolute path, got "${workspace}"`,
})
const workspaceMissing = (workspace: string): WorkspaceDirectory => ({
  reason: `workspace does not exist: "${workspace}"`,
})
const workspaceNotDirectory = (workspace: string): WorkspaceDirectory => ({
  reason: `workspace is not a directory: "${workspace}"`,
})

/**
 * The checks of `resolveWorkspace` that need no git: the path is absolute and
 * names an existing directory. Returns its realpath, or the reason it is not one.
 */
const workspaceDirectory = (workspace: string): WorkspaceDirectory => {
  if (!isAbsolute(workspace)) return workspaceNotAbsolute(workspace)
  let directory: string
  try {
    directory = realpathSync(workspace)
  } catch {
    return workspaceMissing(workspace)
  }
  try {
    if (!statSync(directory).isDirectory()) return workspaceNotDirectory(workspace)
  } catch {
    return workspaceMissing(workspace)
  }
  return { directory }
}

/**
 * #1583: `workspaceDirectory` for a caller that holds the workflow lock: the
 * same checks in the same order with the same reasons, the realpath and the stat
 * waited for off the event loop. The one input answered differently is a path
 * that names a regular file followed by a separator or by `/.`: `realpathSync`
 * resolves it as the file ("is not a directory") where `realpath` of
 * `node:fs/promises` refuses it ("does not exist"); either way the workspace is
 * refused. Never rejects.
 */
const workspaceDirectoryAsync = async (workspace: string): Promise<WorkspaceDirectory> => {
  if (!isAbsolute(workspace)) return workspaceNotAbsolute(workspace)
  let directory: string
  try {
    directory = await realpath(workspace)
  } catch {
    return workspaceMissing(workspace)
  }
  try {
    if (!(await stat(directory)).isDirectory()) return workspaceNotDirectory(workspace)
  } catch {
    return workspaceMissing(workspace)
  }
  return { directory }
}

export const resolveWorkspace = (workspace: string, ownerDirectory: string): WorkspaceResolution => {
  const checked = workspaceDirectory(workspace)
  if ("reason" in checked) return invalidWorkspace(checked.reason)
  const { directory } = checked
  const ownerCommon = gitCommonDir(ownerDirectory)
  if (!ownerCommon) {
    return invalidWorkspace(`workspace requires the workflow owner to be a git project: "${ownerDirectory}"`)
  }
  const workspaceCommon = gitCommonDir(directory)
  if (!workspaceCommon) {
    return invalidWorkspace(`workspace is not part of a git project: "${workspace}"`)
  }
  if (workspaceCommon !== ownerCommon) {
    return invalidWorkspace(`workspace belongs to a different project: "${workspace}"`)
  }
  const worktrees = gitWorktrees(ownerDirectory)
  if (!worktrees?.includes(directory)) {
    return invalidWorkspace(
      `workspace is not a linked worktree of this project (see git worktree list): "${workspace}"`,
    )
  }
  return { _tag: "ok", directory }
}

const gitCommonDirAsync = Effect.fnUntraced(function* (directory: string) {
  const text = (yield* gitOutputAsync(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))?.trim()
  return text ? yield* Effect.promise(() => canonicalDirectoryAsync(text)) : undefined
})

const gitWorktreesAsync = Effect.fnUntraced(function* (directory: string) {
  const text = yield* gitOutputAsync(directory, ["worktree", "list", "--porcelain"])
  return text === undefined ? undefined : yield* Effect.promise(() => worktreePathsAsync(text))
})

/**
 * #1344: `resolveWorkspace` for a caller that holds the workflow lock. The
 * verdicts, their reasons, and the order of the git commands are the
 * synchronous version's; every command is a child process of the app's process
 * runner, so waiting for git does not block the event loop, and each one is
 * bounded by the fingerprint's limits (the synchronous commands had none).
 * #1583: the canonical-path and stat checks wait off the event loop as well
 * (`workspaceDirectoryAsync`, and the canonical paths of what git names).
 * Never fails; only an interruption gets through.
 */
export const resolveWorkspaceAsync = Effect.fn("DagLocation.resolveWorkspaceAsync")(function* (
  workspace: string,
  ownerDirectory: string,
): Effect.fn.Return<WorkspaceResolution, never, AppProcess.Service> {
  const checked = yield* Effect.promise(() => workspaceDirectoryAsync(workspace))
  if ("reason" in checked) return invalidWorkspace(checked.reason)
  const { directory } = checked
  const ownerCommon = yield* gitCommonDirAsync(ownerDirectory)
  if (!ownerCommon) {
    return invalidWorkspace(`workspace requires the workflow owner to be a git project: "${ownerDirectory}"`)
  }
  const workspaceCommon = yield* gitCommonDirAsync(directory)
  if (!workspaceCommon) {
    return invalidWorkspace(`workspace is not part of a git project: "${workspace}"`)
  }
  if (workspaceCommon !== ownerCommon) {
    return invalidWorkspace(`workspace belongs to a different project: "${workspace}"`)
  }
  const worktrees = yield* gitWorktreesAsync(ownerDirectory)
  if (!worktrees?.includes(directory)) {
    return invalidWorkspace(
      `workspace is not a linked worktree of this project (see git worktree list): "${workspace}"`,
    )
  }
  return { _tag: "ok", directory }
}, Effect.provide(AppProcess.defaultLayer))

/**
 * #1344: what `retarget` reads from git and the disk. It is taken before the
 * write transaction opens (ADR-0008 decision 3: a transaction body takes
 * database work only), against the workflow row as the workflow lock sees it,
 * and the transaction applies it only while the row still names the same
 * directories (`observationHolds`). A row that moved in between, which only
 * another process or a session re-stamp can cause, rejects the call and leaves
 * the retry to the caller.
 */
export type TargetObservation =
  | {
      readonly _tag: "ok"
      /** The owner directory the workspace was resolved against. */
      readonly ownerDirectory: string
      /** The resolved workspace the call asked for; undefined when it asked for none. */
      readonly toDirectory: string | undefined
      /** The tree that was fingerprinted: the new workspace, else the bound one, else the owner. */
      readonly executionDirectory: string
      readonly fingerprint: DagEvent.TargetFingerprint
    }
  | { readonly _tag: "invalid"; readonly ownerDirectory: string; readonly reason: string }

/**
 * Resolve the requested workspace (when there is one) and fingerprint the tree
 * the retarget will bind. An invalid workspace is reported as such and nothing
 * is fingerprinted, as the check order of `retarget` has always been.
 */
export const observeTarget = Effect.fn("DagLocation.observeTarget")(function* (
  row: { readonly directory: string; readonly executionDirectory?: string | null },
  workspace: string | undefined,
): Effect.fn.Return<TargetObservation> {
  const ownerDirectory = row.directory
  const resolved = workspace === undefined ? undefined : yield* resolveWorkspaceAsync(workspace, ownerDirectory)
  if (resolved?._tag === "invalid") return { _tag: "invalid", ownerDirectory, reason: resolved.reason }
  const toDirectory = resolved?.directory
  const executionDirectory = toDirectory ?? row.executionDirectory ?? row.directory
  return {
    _tag: "ok",
    ownerDirectory,
    toDirectory,
    executionDirectory,
    fingerprint: yield* fingerprintTarget(executionDirectory),
  }
})

/** Whether the row still names the directories `observed` was taken against. */
export const observationHolds = (
  observed: TargetObservation,
  row: { readonly directory: string; readonly executionDirectory?: string | null },
): boolean =>
  observed.ownerDirectory === row.directory &&
  (observed._tag === "invalid" ||
    observed.executionDirectory === (observed.toDirectory ?? row.executionDirectory ?? row.directory))

/**
 * The durable execution-location verdict shared by adoption, recovery, spawn,
 * and the host-level sweep. `directory` is the bound workspace when present
 * (#943) and the owner directory otherwise. `missing` covers a directory that
 * no longer exists; `invalid` covers an empty stamp or a bound workspace that
 * fails its identity check. An EXPLICIT bound workspace is checked for identity
 * on every use: same git project, listed by `git worktree list`, and still
 * resolving to its persisted realpath. The owner fallback keeps the
 * existence-only check, because non-git owner directories are valid.
 */
export type ExecutionLocation =
  | { readonly _tag: "ok"; readonly directory: string }
  | { readonly _tag: "missing"; readonly directory: string }
  | { readonly _tag: "invalid"; readonly directory: string; readonly reason: string }

const invalidExecution = (directory: string, reason: string): ExecutionLocation => ({
  _tag: "invalid",
  directory,
  reason,
})

/**
 * What `resolveExecution` decides without git: the verdict, or the explicitly
 * bound directory whose identity git still has to vouch for.
 */
type ExecutionPrecheck = ExecutionLocation | { readonly _tag: "identity"; readonly directory: string }

/** The directory a row's execution is judged on, and whether the row binds it explicitly. */
const executionTarget = (row: { readonly directory: string; readonly executionDirectory?: string | null }) => {
  // An explicit binding is a string (including ""); null/absent means the
  // owner fallback. The two must not share the strict identity check: a
  // non-git owner directory is a valid execution location.
  const explicit = typeof row.executionDirectory === "string"
  const target = explicit ? row.executionDirectory : row.directory
  return { explicit, target }
}

// What `executionPrecheck` and `executionPrecheckAsync` decide from the target and what the disk told of
// it, written once so that the two cannot drift apart.
const emptyExecution = (target: string, explicit: boolean): ExecutionLocation =>
  invalidExecution(target, explicit ? "execution directory is empty" : "workflow has no recorded execution directory")

const missingExecution = (target: string): ExecutionLocation => ({ _tag: "missing", directory: target })

/** An explicitly bound directory that exists, given its realpath: identical to the binding, with an owner to vouch for it. */
const boundExecution = (row: { readonly directory: string }, target: string, canonical: string): ExecutionPrecheck => {
  if (canonical !== target) {
    return invalidExecution(
      target,
      `execution directory resolves to "${canonical}" instead of the bound realpath "${target}"`,
    )
  }
  if (row.directory === "") {
    return invalidExecution(target, "workflow has no owner directory to validate the workspace against")
  }
  return { _tag: "identity", directory: target }
}

const executionPrecheck = (row: {
  readonly directory: string
  readonly executionDirectory?: string | null
}): ExecutionPrecheck => {
  const { explicit, target } = executionTarget(row)
  if (target === "") return emptyExecution(target, explicit)
  try {
    if (!statSync(target).isDirectory()) return missingExecution(target)
  } catch {
    return missingExecution(target)
  }
  if (!explicit) return { _tag: "ok", directory: target }
  return boundExecution(row, target, canonicalDirectory(target))
}

/**
 * #1583: `executionPrecheck` for a caller that holds the workflow lock: the same
 * checks in the same order with the same verdicts, the stat and the canonical
 * path waited for off the event loop. Never rejects.
 */
const executionPrecheckAsync = async (row: {
  readonly directory: string
  readonly executionDirectory?: string | null
}): Promise<ExecutionPrecheck> => {
  const { explicit, target } = executionTarget(row)
  if (target === "") return emptyExecution(target, explicit)
  try {
    if (!(await stat(target)).isDirectory()) return missingExecution(target)
  } catch {
    return missingExecution(target)
  }
  if (!explicit) return { _tag: "ok", directory: target }
  return boundExecution(row, target, await canonicalDirectoryAsync(target))
}

/** Resolve whether a workflow's execution directory can still be used. */
export const resolveExecution = (row: {
  readonly directory: string
  readonly executionDirectory?: string | null
}): ExecutionLocation => {
  const checked = executionPrecheck(row)
  if (checked._tag !== "identity") return checked
  const resolved = resolveWorkspace(checked.directory, row.directory)
  if (resolved._tag === "invalid") return invalidExecution(checked.directory, resolved.reason)
  return { _tag: "ok", directory: checked.directory }
}

/**
 * #1344: `resolveExecution` for a caller that holds the workflow lock. The
 * identity check of an explicit binding waits for git without blocking the event
 * loop (`resolveWorkspaceAsync`); the verdicts are the synchronous version's.
 * #1583: the stat and the canonical path of the precheck wait off the event loop
 * too (`executionPrecheckAsync`).
 * Never fails; only an interruption gets through.
 */
export const resolveExecutionAsync = Effect.fn("DagLocation.resolveExecutionAsync")(function* (row: {
  readonly directory: string
  readonly executionDirectory?: string | null
}): Effect.fn.Return<ExecutionLocation> {
  const checked = yield* Effect.promise(() => executionPrecheckAsync(row))
  if (checked._tag !== "identity") return checked
  const resolved = yield* resolveWorkspaceAsync(checked.directory, row.directory)
  if (resolved._tag === "invalid") return invalidExecution(checked.directory, resolved.reason)
  return { _tag: "ok", directory: checked.directory }
})

/**
 * #1344: what `failUnrecoverable` reads before its transaction opens: the
 * verdict on the execution location, which waits for git (ADR-0008 decision 3:
 * a transaction body takes database work only), with the directories it was
 * taken against. The transaction applies it only while the row still names them
 * (`executionObservationHolds`), as `TargetObservation` does for `retarget`:
 * a session move that re-stamped the row in between wins.
 */
export interface ExecutionObservation {
  readonly directory: string
  readonly executionDirectory: string | null | undefined
  readonly location: ExecutionLocation
}

export const observeExecution = Effect.fn("DagLocation.observeExecution")(function* (row: {
  readonly directory: string
  readonly executionDirectory?: string | null
}): Effect.fn.Return<ExecutionObservation> {
  return {
    directory: row.directory,
    executionDirectory: row.executionDirectory,
    location: yield* resolveExecutionAsync(row),
  }
})

/** Whether the row still names the directories `observed` was taken against. */
export const executionObservationHolds = (
  observed: ExecutionObservation,
  row: { readonly directory: string; readonly executionDirectory?: string | null },
): boolean =>
  observed.directory === row.directory && (observed.executionDirectory ?? null) === (row.executionDirectory ?? null)

/**
 * The explicit failure reason persisted on the WorkflowFailed event (and thus
 * visible through `workflow status`). Kept in one place so every path that
 * terminalizes an unusable execution location reports the same reason.
 */
export const executionFailureReason = (location: Exclude<ExecutionLocation, { _tag: "ok" }>): string => {
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
    if (row.directory === "") return false
    return canonicalDirectory(row.directory) === canonicalDirectory(directory)
  })

/**
 * Owns the session's EXECUTION wake iff every durable non-terminal workflow row
 * still belongs to the ambient instance (same project id + directory conjunct
 * as ownsWorkflow). Terminal rows are ignored here: they have no execution to
 * own, so a terminal row must not permanently suppress wake delivery for a
 * later valid workflow in the same session (#948). Delivery of a
 * terminal-only batch is gated separately by the caller on the parent
 * session's directory, so ignoring terminal rows never widens execution
 * ownership. Vacuous-true when the session has no live workflow rows: there is
 * no execution data to deliver and goal-only sessions have no workflow rows.
 * Also vacuous-true when the Database service is absent from the runtime graph
 * (synthetic goal tests; every production graph carries it) — ownership cannot
 * be disproven there and the gate must not silently disable pre-existing
 * loops. The workflow-row key keeps execution ownership free of session-table
 * reads (R7).
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
      } else if (row.directory === "") {
        owned = false
      } else if (canonicalDirectory(row.directory) !== canonicalDirectory(directory)) {
        owned = false
      }
    }
    return owned
  })
