// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Entry fingerprinting for project trust (T1 PR1).
 *
 * A fingerprint is the sha256 of the canonical execution fields plus the
 * contents of every project file the command names. Referenced files are
 * resolved relative to the entry's cwd (the project root by default), symlinks
 * are followed, and only regular files inside the project root are hashed.
 * Directories, paths outside the project, paths inside `.agents/worktree/` and
 * symlinks that resolve outside the project are ignored. A referenced file that
 * does not exist contributes a fixed marker, so creating it changes the
 * fingerprint.
 *
 * The module is pure: realpath/stat/read are injected so the same function runs
 * in tests and, in a later PR, against the filesystem adapter.
 */
import path from "path"
import { Hash } from "@graphagent/core/util/hash"
import { canonicalJSON } from "./normalize"
import type { TrustEntry } from "./types"

/** Digest placeholder recorded for a referenced path that does not exist yet. */
export const MISSING_FILE_MARKER = "missing"

export interface FingerprintFileSystem {
  /** Follow symlinks; undefined when the path does not exist. */
  realpath: (candidate: string) => string | undefined
  /** True only for regular files. */
  isFile: (resolved: string) => boolean
  /** File contents; undefined when the file cannot be read. */
  read: (resolved: string) => string | Buffer | undefined
}

export interface FingerprintInput {
  /** Project root used to resolve relative reference tokens and the cwd. */
  root: string
  /** Real path of the project root, used for containment checks. */
  realRoot: string
  files: FingerprintFileSystem
  /** Project-relative directory excluded from hashing (default `.agents/worktree`). */
  worktreeDirectory?: string
}

export type ReferencedFile = {
  /** Path relative to the project root's real path, POSIX separators. */
  path: string
  /** sha256 of the file contents, or `MISSING_FILE_MARKER`. */
  sha256: string
}

/** Resolve and hash every project file the entry's command names. */
export function referencedFiles(entry: TrustEntry, input: FingerprintInput): ReferencedFile[] {
  const base = entry.cwd === undefined ? input.root : path.resolve(input.root, entry.cwd)
  const worktree = normalizeRelative(input.worktreeDirectory ?? ".agents/worktree")
  const hashed = new Map<string, string>()

  for (const token of [...entry.references].toSorted()) {
    if (!token || token.startsWith("-") || token.includes("://") || token.includes("$")) continue
    const lexical = path.resolve(base, token)
    if (!isInside(input.root, lexical)) continue
    const lexicalRelative = posix(path.relative(input.root, lexical))
    if (!lexicalRelative || inWorktree(lexicalRelative, worktree)) continue

    const resolved = input.files.realpath(lexical)
    if (resolved === undefined) {
      hashed.set(lexicalRelative, MISSING_FILE_MARKER)
      continue
    }
    if (!isInside(input.realRoot, resolved)) continue

    const relative = posix(path.relative(input.realRoot, resolved))
    if (!relative || inWorktree(relative, worktree)) continue
    if (!input.files.isFile(resolved)) continue

    const contents = input.files.read(resolved)
    if (contents === undefined) continue
    hashed.set(relative, Hash.sha256(contents))
  }

  return [...hashed.entries()]
    .map(([file, sha256]) => ({ path: file, sha256 }))
    .toSorted((a, b) => a.path.localeCompare(b.path))
}

/** Hash the canonical execution fields and referenced file contents. */
export function fingerprint(entry: TrustEntry, input: FingerprintInput): string {
  return Hash.sha256(canonicalJSON({ entry: entry.canonical, files: referencedFiles(entry, input) }))
}

function normalizeRelative(value: string) {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "")
}

function inWorktree(relative: string, worktree: string) {
  if (!worktree) return false
  return relative === worktree || relative.startsWith(worktree + "/")
}

function isInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate)
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
}

function posix(value: string) {
  return value.replaceAll("\\", "/")
}
