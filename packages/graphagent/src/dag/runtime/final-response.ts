// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect, Option, Scheduler } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagMessages } from "@graphagent/core/dag/messages"
import type { DagStore } from "@graphagent/core/dag/store"
import type { SessionV1 } from "@graphagent/core/v1/session"
import {
  isCaptureValidationCurrent,
  validatePayloadAsync,
  type CaptureSlot,
  type CaptureValidation,
  type SchemaValidationFix,
} from "./capture"

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

/** Readable settlement reason for a child turn that ended at the output token cap. */
export function outputLimitReason(input: {
  cap: number | undefined
  output: number
  reasoning: number
  continued: boolean
}): string {
  // Session tokens.output already excludes reasoning tokens.
  const text = Math.max(0, input.output)
  const cap = input.cap === undefined ? "configured output limit" : String(input.cap)
  return `child turn hit the output token cap (${cap}; reasoning ${input.reasoning}, text ${text})${
    input.continued ? " after one continuation" : ""
  }. Raise this model's limit.output or GRAPHAGENT_OUTPUT_TOKEN_MAX, or use a lower reasoning variant.`
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
  | { ok: true; output: unknown; snapshotID?: string }
  | {
      ok: false
      reason: string
      code?: string
      /** The turn ended normally but its final output failed the schema contract. Empty output, a turn that
       * did not end normally and a failure of the validation facility itself never carry it. */
      schemaInvalid?: boolean
      /** Present only for a near-miss worth a field-level correction prompt. */
      fix?: SchemaValidationFix
      /** What a correction turn tells the model was wrong: the parse failure, or the validator's message cut to
       * `REPAIR_DETAIL_MAX` code units. Present exactly when the failure is the model's to correct. */
      repairDetail?: string
    }

/** Quote only the failing field and its allowed values, never the draft or the
 * whole schema: the correction turn must stay cheap and must not echo secrets. */
export function repairPrompt(fix: SchemaValidationFix): string {
  const subject = `Field "${fix.path}"`
  const expected = fix.kind === "enum" ? `must be one of ${fix.allowed}` : `must have ${fix.expected}`
  return `${subject} ${expected}; got ${fix.got}. Do not redo the work. Resubmit the same result as one JSON value with only that field corrected.`
}

/** The prompt of the one correction turn a failed capture earns, or `undefined` when the failure is not the
 * model's to correct (empty output, a turn that ended abnormally, a validation facility failure). A near-miss
 * on a present field keeps its field-level prompt; every other schema failure quotes the bounded detail. */
export function correctionPrompt(failed: { fix?: SchemaValidationFix; repairDetail?: string }): string | undefined {
  if (failed.fix) return repairPrompt(failed.fix)
  if (failed.repairDetail === undefined) return undefined
  return `Your final response was rejected: ${failed.repairDetail}. Do not redo the work. Resubmit the same result as exactly one JSON value, with no Markdown fence and no surrounding prose.`
}

/** Longest validator message a correction prompt quotes, in UTF-16 code units. */
const REPAIR_DETAIL_MAX = 400
/** Longest consistency error text a correction prompt quotes, in UTF-16 code units. */
const CONSISTENCY_DETAIL_MAX = 2000

/** Cut at `max` code units without splitting a surrogate pair. */
function clipDetail(text: string, max: number): string {
  if (text.length <= max) return text
  const last = text.charCodeAt(max - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
}

function clipRepairDetail(text: string): string {
  return clipDetail(text, REPAIR_DETAIL_MAX)
}

/** The prompt of the one correction turn a block review decision earns when its dispositions contradict its lanes
 * (#1556): the contract's own error text, so the model fixes exactly what the runtime refused. The text names every
 * lane action it got wrong, so its bound is wider than a schema message's; the draft itself is never quoted. */
export function consistencyCorrectionPrompt(errors: readonly string[]): string {
  return `Your final response was rejected: ${clipDetail(errors.join("; "), CONSISTENCY_DETAIL_MAX)}. Do not redo the work. Correct exactly what is listed and resubmit the full result as exactly one JSON value, with no Markdown fence and no surrounding prose.`
}

/** Shared guarded persistence for final-response capture. */
export function persistValidatedCapture(input: {
  store: DagStore.Interface
  sessionID: string
  slot: CaptureSlot
  validated: Extract<CaptureValidation, { ok: true }>
  abort: AbortSignal
  snapshotID?: string
  caller?: DagMessages.Caller
  guard?: Omit<DagMessages.Guard, "snapshotID" | "close">
}) {
  return Effect.gen(function* () {
    const messages = yield* Effect.serviceOption(DagMessages.Service)
    const commit = Effect.gen(function* () {
      if (input.abort.aborted || !isCaptureValidationCurrent(input.slot, input.validated)) return false
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
  slot: CaptureSlot
  message: SessionV1.WithParts
  abort?: AbortSignal
  snapshotID?: string
  caller?: DagMessages.Caller
  guard?: Omit<DagMessages.Guard, "snapshotID" | "close">
}): Effect.Effect<FinalCaptureResult> {
  return Effect.gen(function* () {
    const final = finalAssistantText(input.message, true)
    // Empty output and a turn that did not end normally are not a schema failure: no correction, no class.
    if (!final.ok) return { ...final, code: undefined } as const
    // The worker protocol is one JSON value. Decode that outer value once;
    // a string schema then receives the decoded string as data. An assistant
    // object JSON under a string schema must not be rescued as raw text.
    const parsed = parseFinalResponse(final.text)
    if (!parsed.ok)
      return {
        ...parsed,
        code: undefined,
        schemaInvalid: true,
        repairDetail: "the final response is not exactly one JSON value",
      } as const
    let validationSignal: AbortSignal | undefined
    const validated = yield* Effect.promise((signal) => {
      validationSignal = signal
      return validatePayloadAsync(
        input.slot,
        parsed.payload,
        input.abort ? AbortSignal.any([signal, input.abort]) : signal,
      )
    })
    if (!validated.ok)
      return {
        ok: false,
        reason: `final response schema validation failed: ${validated.error}`,
        // A failure of the validation facility is not the model's to correct.
        ...(validated.notAvailable === true
          ? {}
          : { schemaInvalid: true, repairDetail: clipRepairDetail(validated.error) }),
        ...(validated.fix ? { fix: validated.fix } : {}),
      } as const
    const receipt = yield* persistValidatedCapture({ ...input, validated, abort: input.abort ?? validationSignal! })
    if (!receipt.ok)
      return { ok: false, reason: `final response capture rejected: ${receipt.reason}`, code: receipt.code } as const
    return { ok: true, output: validated.payload, snapshotID: input.snapshotID } as const
  })
}
