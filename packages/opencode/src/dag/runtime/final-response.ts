// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Effect, Option, Scheduler } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DagMessages } from "@opencode-ai/core/dag/messages"
import type { DagStore } from "@opencode-ai/core/dag/store"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { isCaptureValidationCurrent, validatePayloadAsync, type CaptureValidation } from "./capture"

export type FinalText = { ok: true; text: string } | { ok: false; reason: string }

/** Read one completed assistant message, preserving every visible text part. */
export function finalAssistantText(message: SessionV1.WithParts | undefined, allowMissingFinish = false): FinalText {
  if (!message || message.info.role !== "assistant" || message.info.error)
    return { ok: false, reason: "child model turn stopped before a successful result" }
  const finish = message.info.finish
  if (finish !== "stop" && !(allowMissingFinish && finish === undefined))
    return { ok: false, reason: `child model turn did not end normally (${finish ?? "unfinished"})` }
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text)
    .join("")
  if (text.trim() === "") return { ok: false, reason: "provider returned empty output" }
  return { ok: true, text }
}

export type ParsedFinalResponse = { ok: true; payload: unknown } | { ok: false; reason: string }

/** JSON.parse consumes exactly one complete JSON value (including falsy values). */
export function parseFinalResponse(text: string): ParsedFinalResponse {
  try {
    return { ok: true, payload: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, reason: "final response must be one JSON value matching output_schema" }
  }
}

export type CaptureReceipt = { ok: true } | { ok: false; reason: string; code?: string }
export type FinalCaptureResult =
  { ok: true; output: unknown; snapshotID?: string } | { ok: false; reason: string; code?: string }

/** Shared guarded persistence for submit_result and final-response capture. */
export function persistValidatedCapture(input: {
  store: DagStore.Interface
  sessionID: string
  validated: Extract<CaptureValidation, { ok: true }>
  abort: AbortSignal
  snapshotID?: string
  caller?: DagMessages.Caller
  guard?: Omit<DagMessages.Guard, "snapshotID" | "close">
}) {
  return Effect.gen(function* () {
    const messages = yield* Effect.serviceOption(DagMessages.Service)
    const commit = Effect.gen(function* () {
      if (input.abort.aborted || !isCaptureValidationCurrent(input.sessionID, input.validated)) return false
      yield* input.store
        .setCapturedOutput(input.sessionID, input.validated.payload, input.snapshotID)
        .pipe(Effect.orDie)
      return true
    }).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true))
    if (Option.isSome(messages) && input.caller && input.guard) {
      const receipt = yield* messages.value.guard(
        input.caller,
        { ...input.guard, snapshotID: input.snapshotID, close: false },
        commit,
      )
      if (!receipt.ok) return { ok: false, reason: receipt.reason, code: receipt.reason } as const
      if (!receipt.value) return { ok: false, reason: "capture slot changed or cancelled" } as const
      return { ok: true } as const
    }
    const database = yield* Effect.serviceOption(Database.Service)
    const captured = yield* Option.isSome(database)
      ? database.value.db.transaction(() => commit).pipe(Effect.orDie)
      : commit
    return captured ? ({ ok: true } as const) : ({ ok: false, reason: "capture slot changed or cancelled" } as const)
  })
}

export function captureFinalResponse(input: {
  store: DagStore.Interface
  sessionID: string
  message: SessionV1.WithParts
  abort?: AbortSignal
  snapshotID?: string
  caller?: DagMessages.Caller
  guard?: Omit<DagMessages.Guard, "snapshotID" | "close">
}) {
  return Effect.gen(function* () {
    const final = finalAssistantText(input.message, true)
    if (!final.ok) return { ...final, code: undefined } as const
    const parsed = parseFinalResponse(final.text)
    if (!parsed.ok) return { ...parsed, code: undefined } as const
    let validationSignal: AbortSignal | undefined
    const validated = yield* Effect.promise((signal) => {
      validationSignal = signal
      return validatePayloadAsync(
        input.sessionID,
        parsed.payload,
        input.abort ? AbortSignal.any([signal, input.abort]) : signal,
      )
    })
    if (!validated.ok) return { ok: false, reason: `final response schema validation failed: ${validated.error}` } as const
    const receipt = yield* persistValidatedCapture({ ...input, validated, abort: input.abort ?? validationSignal! })
    if (!receipt.ok)
      return { ok: false, reason: `final response capture rejected: ${receipt.reason}`, code: receipt.code } as const
    return { ok: true, output: validated.payload, snapshotID: input.snapshotID } as const
  })
}
