// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Project identity for project trust (T1).
 *
 * `trust.json` is keyed by the hash of the project root's real path, so the
 * same repository cloned into two directories is two projects that must each be
 * confirmed. The display path and the optional git remote are recorded for the
 * panel only; neither participates in the identity.
 */
import { Hash } from "@graphagent/core/util/hash"

export interface ProjectIdentity {
  /** sha256 hex of the resolved (symlink-free) project root. */
  id: string
  /** Path shown in the trust record. */
  root: string
  /** Git remote, display only. */
  remote?: string
}

/** Build the identity record for one project. */
export function projectIdentity(input: { root: string; realRoot: string; remote?: string }): ProjectIdentity {
  return {
    id: Hash.sha256(input.realRoot),
    root: input.root,
    ...(input.remote ? { remote: input.remote } : {}),
  }
}

/** Hash a resolved project root. Callers resolve symlinks before calling. */
export function projectId(realRoot: string): string {
  return Hash.sha256(realRoot)
}
