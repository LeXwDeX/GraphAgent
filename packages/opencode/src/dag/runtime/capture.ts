// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DAG structured-output schema registry + validation.
 *
 * The schema for each child session is held in-memory (it comes from the
 * workflow config and is re-registered on recovery). The validated payload
 * is persisted to the `captured_output` column of `workflow_node` via
 * DagStore — surviving a process crash (but reset to null on a replan-restart
 * via NodeStarted, so each attempt starts with a clean slate).
 */

import { validateReviewResult } from "../review-lifecycle"
import { validateAgainstSchema } from "./schema-validator"
import { validateInWorker, type Validation } from "./schema-validation"
export { validateAgainstSchema, unsupportedSchemaKeywords } from "./schema-validator"

type CaptureSlot = { schema: Record<string, unknown>; generation: number; pending?: AbortController }
const schemas = new Map<string, CaptureSlot>()
let generation = 0
const snapshots = new Map<string, string>()
// A child session owns its protocol. This is registered before prompting and
// removed with the execution fiber, so unrelated sessions keep their tools.
const finalResponseSessions = new Set<string>()

export function registerFinalResponseSession(sessionID: string): void {
  finalResponseSessions.add(sessionID)
}

export function isFinalResponseSession(sessionID: string): boolean {
  return finalResponseSessions.has(sessionID)
}

export function clearFinalResponseSession(sessionID: string): void {
  finalResponseSessions.delete(sessionID)
}

export function setCaptureSnapshot(sessionID: string, snapshotID: string): void {
  snapshots.set(sessionID, snapshotID)
}

export function getCaptureSnapshot(sessionID: string): string | undefined {
  return snapshots.get(sessionID)
}

export function registerCaptureSlot(sessionID: string, schema: Record<string, unknown>): void {
  schemas.get(sessionID)?.pending?.abort("capture slot changed")
  schemas.set(sessionID, { schema, generation: ++generation })
}

export function hasCaptureSlot(sessionID: string): boolean {
  return schemas.has(sessionID)
}

export function getCaptureSchema(sessionID: string): Record<string, unknown> | undefined {
  return schemas.get(sessionID)?.schema
}

export function clearCaptureSlot(sessionID: string): void {
  schemas.get(sessionID)?.pending?.abort("capture slot changed")
  schemas.delete(sessionID)
  snapshots.delete(sessionID)
}

export function validatePayload(
  sessionID: string,
  payload: unknown,
): { ok: true } | { ok: false; error: string; notAvailable?: boolean } {
  const schema = schemas.get(sessionID)?.schema
  if (!schema) return { ok: false, error: "submit_result is not available in this session", notAvailable: true }
  return validateAgainstSchema(payload, schema)
}

export type CaptureValidation =
  { ok: true; payload: unknown; generation: number } | { ok: false; error: string; notAvailable?: boolean }

/** One worker per admitted child session, owned by this exact slot generation. */
export async function validatePayloadAsync(
  sessionID: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<CaptureValidation> {
  const slot = schemas.get(sessionID)
  if (!slot) return { ok: false, error: "submit_result is not available in this session", notAvailable: true }
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
    if (schemas.get(sessionID) !== slot)
      return { ok: false, error: "capture slot changed during schema validation", notAvailable: true }
    return result.ok ? { ...result, generation: slot.generation } : result
  } finally {
    signal.removeEventListener("abort", cancel)
    if (slot.pending === pending) delete slot.pending
  }
}

/** Rechecked in the persistence effect, after asynchronous validation and admission. */
export function isCaptureValidationCurrent(sessionID: string, validated: { generation: number }): boolean {
  return schemas.get(sessionID)?.generation === validated.generation
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
): CapturedSettlement {
  if (!submitted)
    return { kind: "fail", reason: `output_schema declared but submit_result was never successfully called${suffix}` }
  if (reviewFingerprint) {
    const result = validateReviewResult(captured, reviewFingerprint)
    if (!result.valid)
      return { kind: "fail", reason: `Review result contract failed${suffix}: ${result.errors.join("; ")}` }
  }
  return { kind: "complete", output: captured }
}
