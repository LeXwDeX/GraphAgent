import { FinishReason, LLMEvent, ProviderMetadata, ToolResultValue } from "@opencode-ai/llm"
import { Effect, Schema } from "effect"
import { InvalidResponseDataError, type streamText } from "ai"
import { errorMessage } from "@/util/error"
import { ProviderError } from "@/provider/error"
import { isRecord } from "@/util/record"

type Result = Awaited<ReturnType<typeof streamText>>
type AISDKEvent = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

/**
 * Marks a tool error that the AI SDK produced because it rejected a tool
 * call's input before any execution was possible (unparsable or
 * schema-mismatched arguments). The adapter wraps such tool errors with this
 * class so the session processor can classify them by instance instead of
 * matching message text. Only meaningful in-process: persisted or decoded
 * events keep the message and cause but lose the class identity, which makes
 * consumers treat the error conservatively (as a real execution outcome).
 */
export class ToolInputRejectedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "ToolInputRejectedError"
  }
}

export function adapterState() {
  return {
    step: 0,
    text: 0,
    reasoning: 0,
    currentTextID: undefined as string | undefined,
    currentReasoningID: undefined as string | undefined,
    toolNames: {} as Record<string, string>,
    copilotTotalNanoAiu: undefined as number | undefined,
    missingFinishReason: false,
    /**
     * A suppressed (non-session-visible) AI SDK chunk — file, source, abort,
     * tool-approval-request, tool-output-denied — was seen in this stream.
     * Conveyed as a reserved internal flag on the synthesized step-finish and
     * finish providerMetadata (`opencode.suppressedActivity`) so consumers can
     * distinguish this activity from a completely empty response without a
     * public event variant.
     */
    suppressedActivity: false,
    /** Call IDs whose tool-call the SDK marked invalid (unexecuted input rejection). */
    invalidToolCalls: new Set<string>(),
  }
}

/**
 * Reserved metadata key marking that this stream carried non-empty provider
 * activity the adapter does not surface as session-visible events. Merged
 * into the step-finish/finish providerMetadata without disturbing provider
 * keys already present.
 */
const SUPPRESSED_ACTIVITY_METADATA = { suppressedActivity: true }

function withSuppressedActivity(
  metadata: ProviderMetadata | undefined,
  suppressed: boolean,
): ProviderMetadata | undefined {
  if (!suppressed) return metadata
  return { ...metadata, opencode: { ...metadata?.opencode, ...SUPPRESSED_ACTIVITY_METADATA } }
}

function finishReason(value: string | undefined): FinishReason {
  return Schema.is(FinishReason)(value) ? value : "unknown"
}

function providerMetadata(value: unknown): ProviderMetadata | undefined {
  if (value == null) return undefined
  return Schema.is(ProviderMetadata)(value) ? value : undefined
}

// Temporary AI SDK bridge: Copilot billing survives only in raw provider chunks here.
// Move this extraction into @opencode-ai/llm when Copilot is handled by the native runtime.
function copilotTotalNanoAiu(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const response = isRecord(value.response) ? value.response : undefined
  const usage = value.copilot_usage ?? response?.copilot_usage
  if (!isRecord(usage)) return undefined
  const total = usage.total_nano_aiu
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return undefined
  return total
}

function usage(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const item = value as {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
    outputTokenDetails?: { reasoningTokens?: number }
  }
  const entries = Object.entries({
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    totalTokens: item.totalTokens,
    reasoningTokens: item.outputTokenDetails?.reasoningTokens ?? item.reasoningTokens,
    cacheReadInputTokens: item.inputTokenDetails?.cacheReadTokens ?? item.cachedInputTokens,
    cacheWriteInputTokens: item.inputTokenDetails?.cacheWriteTokens,
  }).filter((entry) => entry[1] !== undefined)
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

function currentTextID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  state.currentTextID = id ?? state.currentTextID ?? `text-${state.text++}`
  return state.currentTextID
}

function currentReasoningID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  state.currentReasoningID = id ?? state.currentReasoningID ?? `reasoning-${state.reasoning++}`
  return state.currentReasoningID
}

function isMissingFinishReason(error: unknown) {
  if (!error || typeof error !== "object") return false
  if (!("message" in error) || error.message !== "Response stream ended without a finish reason.") return false
  return InvalidResponseDataError.isInstance(error) || ("name" in error && error.name === "AI_InvalidResponseDataError")
}

export function toLLMEvents(
  state: ReturnType<typeof adapterState>,
  event: AISDKEvent,
  onAttemptActivity?: (activity: "tool-executed" | "suppressed") => void,
): Effect.Effect<ReadonlyArray<LLMEvent>, unknown> {
  switch (event.type) {
    case "start":
      return Effect.succeed([])

    case "start-step":
      return Effect.succeed([LLMEvent.stepStart({ index: state.step })])

    case "finish-step":
      if (event.rawFinishReason === "network_error")
        return Effect.fail(new ProviderError.ResponseStreamError("Provider finish_reason: network_error"))
      return Effect.sync(() => {
        const original = providerMetadata(event.providerMetadata)
        const metadata =
          state.copilotTotalNanoAiu === undefined
            ? original
            : {
                ...original,
                copilot: {
                  ...original?.copilot,
                  totalNanoAiu: state.copilotTotalNanoAiu,
                },
              }
        state.copilotTotalNanoAiu = undefined
        return [
          LLMEvent.stepFinish({
            index: state.step++,
            reason: state.missingFinishReason ? "unknown" : finishReason(event.finishReason),
            usage: usage(event.usage),
            providerMetadata: withSuppressedActivity(metadata, state.suppressedActivity),
          }),
        ]
      })

    case "finish":
      return Effect.sync(() => {
        const suppressed = state.suppressedActivity
        const events = [
          LLMEvent.finish({
            reason: state.missingFinishReason ? "unknown" : finishReason(event.finishReason),
            usage: usage(event.totalUsage),
            providerMetadata: withSuppressedActivity(
              "providerMetadata" in event ? providerMetadata(event.providerMetadata) : undefined,
              suppressed,
            ),
          }),
        ]
        // Reset so the adapter can be reused for a follow-up stream without leaking
        // counters or block IDs. adapterState() is the single source of truth for shape.
        Object.assign(state, adapterState())
        return events
      })

    case "text-start":
      return Effect.sync(() => {
        state.currentTextID = currentTextID(state, event.id)
        return [
          LLMEvent.textStart({
            id: state.currentTextID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "text-delta":
      return Effect.succeed([
        LLMEvent.textDelta({
          id: currentTextID(state, event.id),
          text: event.text,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "text-end":
      return Effect.sync(() => {
        const id = currentTextID(state, event.id)
        state.currentTextID = undefined
        return [
          LLMEvent.textEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-start":
      return Effect.sync(() => {
        state.currentReasoningID = currentReasoningID(state, event.id)
        return [
          LLMEvent.reasoningStart({
            id: state.currentReasoningID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-delta":
      return Effect.succeed([
        LLMEvent.reasoningDelta({
          id: currentReasoningID(state, event.id),
          text: event.text,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "reasoning-end":
      return Effect.sync(() => {
        const id = currentReasoningID(state, event.id)
        state.currentReasoningID = undefined
        return [
          LLMEvent.reasoningEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-start":
      return Effect.sync(() => {
        state.toolNames[event.id] = event.toolName
        return [
          LLMEvent.toolInputStart({
            id: event.id,
            name: event.toolName,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-delta":
      return Effect.succeed([
        LLMEvent.toolInputDelta({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          text: event.delta ?? "",
        }),
      ])

    case "tool-input-end":
      return Effect.succeed([
        LLMEvent.toolInputEnd({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "tool-call":
      return Effect.sync(() => {
        state.toolNames[event.toolCallId] = event.toolName
        // The SDK marks a tool call whose input failed to parse. When the
        // provider did not execute it, nothing can run for this ID, so its
        // tool-error is an input rejection rather than an execution outcome.
        // Track the ID so the matching tool-error can be wrapped; the set is
        // per stream (adapterState) and only widened by exactly this shape.
        if (event.invalid === true && event.providerExecuted !== true) {
          state.invalidToolCalls.add(event.toolCallId)
        }
        return [
          LLMEvent.toolCall({
            id: event.toolCallId,
            name: event.toolName,
            input: event.input,
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-result":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? "unknown"
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolResult({
            id: event.toolCallId,
            name,
            result: ToolResultValue.make(event.output),
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-error":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? ("toolName" in event ? event.toolName : "unknown")
        delete state.toolNames[event.toolCallId]
        const message = errorMessage(event.error)
        // A tracked call ID means this error is the SDK's rejection of an
        // unparseable tool call, not a real execution failure: wrap it so the
        // processor can tell the two apart. Stale IDs (no matching invalid
        // tool-call) keep the plain error and are treated conservatively.
        const rejected = state.invalidToolCalls.delete(event.toolCallId)
        return [
          LLMEvent.toolError({
            id: event.toolCallId,
            name,
            message,
            error: rejected ? new ToolInputRejectedError(message, { cause: event.error }) : event.error,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "error":
      if (isMissingFinishReason(event.error))
        return Effect.sync(() => {
          state.missingFinishReason = true
          return []
        })
      return Effect.fail(event.error)

    case "abort":
    case "source":
    case "file":
    case "tool-output-denied":
    case "tool-approval-request":
      // Not session-visible, but the attempt was not empty: mark the stream
      // so the synthesized finish metadata can disqualify the empty-response
      // gate. Provider keys already in metadata are never overwritten.
      return Effect.sync(() => {
        state.suppressedActivity = true
        onAttemptActivity?.("suppressed")
        return []
      })

    case "raw":
      return Effect.sync(() => {
        state.copilotTotalNanoAiu = copilotTotalNanoAiu(event.rawValue) ?? state.copilotTotalNanoAiu
        return []
      })

    default: {
      const _exhaustive: never = event
      void _exhaustive
      return Effect.succeed([])
    }
  }
}

export * as LLMAISDK from "./ai-sdk"
