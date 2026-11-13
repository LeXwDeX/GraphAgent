// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * DAG structured-output capture slot + validation.
 *
 * The owner of an attempt (spawn or recovery) holds its own slot in-memory;
 * the schema comes from the workflow config and a fresh slot is created on
 * every attempt and recovery episode. The validated payload is persisted to
 * the `captured_output` column of `workflow_node` via DagStore — surviving a
 * process crash (but reset to null on a replan-restart via NodeStarted, so
 * each attempt starts with a clean slate).
 */

import { acceptConsistencyErrors, validateReviewResult, type VerdictEvidence } from "../review-lifecycle"
import { validateAgainstSchema, type SchemaValidationFix } from "./schema-validator"
import { validateInWorker, type Validation } from "./schema-validation"
export { validateAgainstSchema, unsupportedSchemaKeywords } from "./schema-validator"
export type { SchemaValidationFix } from "./schema-validator"

export type CaptureSlot = {
  schema: Record<string, unknown>
  generation: number
  pending?: AbortController
  closed?: boolean
}

export function createCaptureSlot(schema: Record<string, unknown>): CaptureSlot {
  return { schema, generation: 1 }
}

/** A stale-input continuation keeps the attempt but must reject the older turn's result. */
export function resetCaptureSlot(slot: CaptureSlot, schema: Record<string, unknown>): void {
  slot.pending?.abort("capture slot changed")
  delete slot.pending
  slot.schema = schema
  slot.generation++
}

export function closeCaptureSlot(slot: CaptureSlot): void {
  slot.pending?.abort("capture slot changed")
  delete slot.pending
  slot.closed = true
}

export type CaptureValidation =
  | { ok: true; payload: unknown; generation: number }
  | { ok: false; error: string; notAvailable?: boolean; fix?: SchemaValidationFix }

/** One worker per admitted child session, owned by this exact slot generation. */
export async function validatePayloadAsync(
  slot: CaptureSlot,
  payload: unknown,
  signal: AbortSignal,
): Promise<CaptureValidation> {
  if (slot.closed) return { ok: false, error: "capture slot is closed", notAvailable: true }
  if (slot.pending) return { ok: false, error: "schema validation is already running in this session" }
  const pending = new AbortController()
  slot.pending = pending
  const cancel = () => {
    pending.abort()
    if (slot.pending === pending) delete slot.pending
  }
  signal.addEventListener("abort", cancel, { once: true })
  if (signal.aborted) cancel()
  try {
    const result: Validation = await validateInWorker(slot.schema, payload, pending.signal)
    if (slot.closed) return { ok: false, error: "capture slot changed during schema validation", notAvailable: true }
    return result.ok ? { ...result, generation: slot.generation } : result
  } finally {
    signal.removeEventListener("abort", cancel)
    if (slot.pending === pending) delete slot.pending
  }
}

/** Rechecked in the persistence effect, after asynchronous validation and admission. */
export function isCaptureValidationCurrent(slot: CaptureSlot, validated: { generation: number }): boolean {
  return !slot.closed && slot.generation === validated.generation
}

/**
 * Shared settlement decision for a node that declared an output_schema —
 * the single source of truth for spawn's completion gate AND crash recovery,
 * so the review-result contract cannot drift between the two paths again
 * (that drift was exactly the B1 recovery bypass). A falsy fingerprint means
 * there is no review contract to enforce (loop's validateReviewExecutionInput
 * guarantees diff reviews always reach spawn with one).
 */
export type CapturedSettlement =
  { readonly kind: "complete"; readonly output: unknown } | { readonly kind: "fail"; readonly reason: string }

export type PlainTextSettlement =
  { readonly kind: "complete"; readonly output: string } | { readonly kind: "fail"; readonly reason: string }

/** Shared live/recovery decision for nodes without an output schema. */
export function settlePlainTextOutput(text: string | undefined): PlainTextSettlement {
  if (text === undefined || text.trim() === "") {
    return { kind: "fail", reason: "provider returned empty output" }
  }
  return { kind: "complete", output: text }
}

export function settleCapturedOutput(
  captured: unknown,
  reviewFingerprint: string | undefined,
  suffix = "",
  submitted = captured !== undefined && captured !== null,
  evidence: readonly VerdictEvidence[] = [],
): CapturedSettlement {
  if (!submitted)
    return { kind: "fail", reason: `output_schema declared but no final structured response was captured${suffix}` }
  if (reviewFingerprint) {
    const result = validateReviewResult(captured, reviewFingerprint)
    if (!result.valid)
      return { kind: "fail", reason: `Review result contract failed${suffix}: ${result.errors.join("; ")}` }
  }
  const inconsistent = acceptConsistencyErrors(captured, evidence)
  if (inconsistent.length > 0)
    return { kind: "fail", reason: `Verdict consistency contract failed${suffix}: ${inconsistent.join("; ")}` }
  return { kind: "complete", output: captured }
}
