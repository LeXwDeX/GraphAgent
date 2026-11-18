// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Records in a result's `metadata.corrections` what the harness dropped or rewrote on the model's behalf (#1447), so
 * a per-model count can tell which models run into which correction. A kind that is already recorded stays once,
 * and with no kind to record the key is not written. This has the shape of `addCorrections` in
 * `packages/core/src/session/outcome.ts` (#1473); once that merges, import it there and delete this file.
 */
export function addCorrections<M extends Record<string, unknown>>(
  metadata: M,
  ...kinds: string[]
): M & { corrections?: string[] } {
  const recorded = Array.isArray(metadata.corrections)
    ? metadata.corrections.filter((kind): kind is string => typeof kind === "string")
    : []
  const merged = [...recorded]
  for (const kind of kinds) if (!merged.includes(kind)) merged.push(kind)
  return merged.length > 0 ? { ...metadata, corrections: merged } : { ...metadata }
}
