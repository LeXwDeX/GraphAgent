// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process"
import { statSync } from "node:fs"
import { join } from "node:path"
import { Hash } from "@graphagent/core/util/hash"
import type { DagEvent } from "@graphagent/schema/dag-event"

/**
 * `DagLocation.fingerprintTarget` as it was before #1344 made it asynchronous:
 * the same git commands through `execFileSync`. It is the reference the
 * asynchronous version is held to, value for value and fallback for fallback,
 * because a workflow persisted by an older process is compared with the value
 * the new one computes. Do not "fix" it; change the production algorithm and
 * this reference together, deliberately, or not at all.
 */
const TIMEOUT_MS = 20_000
const MAX_BUFFER = 64 * 1024 * 1024
const UNTRACKED_HASH_FILES = 200
const UNTRACKED_HASH_BYTES = 32 * 1024 * 1024

const gitOutput = (directory: string, args: string[], input?: string): string | undefined => {
  try {
    return execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      ...(input !== undefined ? { input } : {}),
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    })
  } catch {
    return undefined
  }
}

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
      if (hashable.length >= UNTRACKED_HASH_FILES || bytes + stat.size > UNTRACKED_HASH_BYTES) continue
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

export const legacyFingerprintTarget = (directory: string): DagEvent.TargetFingerprint => {
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
