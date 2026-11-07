// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Prompt-injection sanitizer for DAG template input.
 *
 * Strips/neutralizes common prompt-injection patterns from user-supplied
 * template input before it's interpolated into a node's prompt.
 *
 * This is a first-line defense — the node's child session also has its own
 * system-prompt boundary. This sanitizer prevents template input from
 * overriding the node's role/instructions.
 */

/**
 * Neutralize common injection patterns in a string value.
 * Returns the sanitized string.
 */
export function sanitize(value: string): string {
  return value
    // Strip "ignore previous instructions" variants
    .replace(/ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/gi, "[REDACTED]")
    // Strip "you are now" role-hijack attempts
    .replace(/you\s+are\s+now\s+a\s+/gi, "[REDACTED] ")
    // Strip "system:" prefix attempts
    .replace(/^system\s*:/gim, "[REDACTED]:")
    // Strip markdown code-fence escapes that could break out of the template
    .replace(/```/g, "``")
    // Strip HTML-like tags that could confuse prompt parsers
    .replace(/<\/?(system|prompt|instructions?|role)>/gi, "[REDACTED]")
}

/**
 * Recursively sanitize an object's string values at any depth.
 *
 * Handles nested objects and arrays — every string encountered at any level
 * is passed through `sanitize`. Non-string primitives (numbers, booleans,
 * null) are returned as-is. This is load-bearing for the dynamic node-output
 * surface (`input_mapping` → `resolvedMapping`), where `JSON.stringify`
 * serializes nested values verbatim into the child prompt.
 *
 * Called from two surfaces:
 * - Static template `input` at `templates/resolve.ts` (config-time values)
 * - Dynamic node-output `resolvedMapping` at `runtime/loop.ts` (LLM-generated)
 *
 * This is a first-line defense — the node's child session also has its own
 * system-prompt boundary. Both layers are present for the dynamic surface.
 *
 * `exemptKeys` (P1-2): top-level keys carrying review implementation evidence
 * (diffs / patches) are preserved verbatim instead of destructively rewritten
 * — a diff legitimately contains code fences and "system:" lines, and the
 * diff-review contract requires the reviewer to see the real artifact. The
 * exempted value is delimiter-wrapped and only an embedded closing delimiter
 * is escaped, so the untrusted region stays marked without content loss.
 */
export function sanitizeInput(
  input: Record<string, unknown>,
  exemptKeys?: readonly string[],
): Record<string, unknown> {
  const exempt = new Set(exemptKeys ?? [])
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    result[key] = exempt.has(key) ? preserveEvidence(value) : sanitizeValue(value)
  }
  return result
}

function preserveEvidence(value: unknown): unknown {
  if (typeof value === "string") {
    return `<implementation-evidence>\n${escapeEvidenceDelimiter(value)}\n</implementation-evidence>`
  }
  if (Array.isArray(value)) return value.map(escapeEvidenceDeep)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, escapeEvidenceDeep(entry)]),
    )
  }
  return value
}

function escapeEvidenceDeep(value: unknown): unknown {
  if (typeof value === "string") return escapeEvidenceDelimiter(value)
  if (Array.isArray(value)) return value.map(escapeEvidenceDeep)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, escapeEvidenceDeep(entry)]),
    )
  }
  return value
}

function escapeEvidenceDelimiter(value: string): string {
  return value.replace(/<(\/?)(implementation-evidence)>/gi, "<\\$1$2>")
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return sanitize(value)
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (value !== null && typeof value === "object") return sanitizeInput(value as Record<string, unknown>)
  return value
}
