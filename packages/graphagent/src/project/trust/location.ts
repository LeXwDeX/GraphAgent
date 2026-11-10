// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Entry location identity and change classification for project trust (T1).
 *
 * A location id is `<file relative to .agents/>|<category>|<label>|<matcher>|<index>`.
 * The index is the 1-based occurrence among entries sharing the same file,
 * category, label and matcher. Inserting an entry before another of the same
 * kind shifts the later indexes; that can re-report a change (ask again) but can
 * never match the wrong entry's record.
 */
import type { TrustCategory, TrustEntry } from "./types"

/** The parts that make up one location id. */
export interface LocationParts {
  /** Path relative to the project layer directory, POSIX separators. */
  file: string
  category: TrustCategory
  label: string
  matcher?: string
  index: number
}

/** Escape the separators so a matcher such as `Edit|Write` cannot split the id. */
export function escapeLocationPart(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("|", "%7C").replaceAll("\n", "%0A").replaceAll("\r", "%0D")
}

/** Build the stable location id of one entry. */
export function entryLocation(parts: LocationParts): string {
  return [
    escapeLocationPart(parts.file.replaceAll("\\", "/")),
    escapeLocationPart(parts.category),
    escapeLocationPart(parts.label),
    escapeLocationPart(parts.matcher ?? ""),
    String(parts.index),
  ].join("|")
}

export type EntryChange = "new" | "modified"

/** One record from `trust.json`: the location id and the fingerprint last decided on. */
export interface PreviousTrustRecord {
  id: string
  fp: string
}

export interface FingerprintedEntry {
  entry: TrustEntry
  fingerprint: string
}

export interface EntryClassification extends FingerprintedEntry {
  /** Absent when the location exists with the recorded fingerprint. */
  change?: EntryChange
}

export interface LocationClassification {
  entries: EntryClassification[]
  /** Recorded locations that no longer exist in the project; their records are cleared. */
  removed: string[]
}

/**
 * Compare the current entries with the previous record set. A missing location
 * is `new`, a location with a different fingerprint is `modified`, and locations
 * present only in the record are reported as `removed`.
 */
export function classifyEntryChanges(
  previous: readonly PreviousTrustRecord[],
  current: readonly FingerprintedEntry[],
): LocationClassification {
  const recorded = new Map(previous.map((record) => [record.id, record.fp]))
  const currentIds = new Set(current.map((item) => item.entry.id))
  const entries = current.map((item): EntryClassification => {
    const prior = recorded.get(item.entry.id)
    if (prior === undefined) return { ...item, change: "new" }
    if (prior !== item.fingerprint) return { ...item, change: "modified" }
    return item
  })
  const removed = previous.filter((record) => !currentIds.has(record.id)).map((record) => record.id)
  return { entries, removed }
}
