// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { ProjectTrustEntry } from "@graphagent/sdk"

/** Entry-position → fingerprint snapshot taken when an import command starts. */
export type TrustSnapshot = ReadonlyMap<string, string>

export function snapshotTrust(entries: readonly ProjectTrustEntry[]): TrustSnapshot {
  return new Map(entries.map((entry) => [entry.id, entry.fp]))
}

/**
 * Entry ids created or rewritten since the snapshot (#1223). Both sides come
 * from the server's scan of the project files, so the model's report of what
 * it imported never decides which entries are presented for confirmation.
 * Entries removed by the import are absent from `entries` and cannot be
 * confirmed; unchanged entries keep their existing state.
 */
export function importedEntryIds(before: TrustSnapshot, entries: readonly ProjectTrustEntry[]): string[] {
  return entries.filter((entry) => before.get(entry.id) !== entry.fp).map((entry) => entry.id)
}
