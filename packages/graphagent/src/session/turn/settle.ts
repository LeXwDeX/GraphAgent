// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import type { DagMessages } from "@graphagent/core/dag/messages"
import { NamedError } from "@graphagent/core/util/error"
import { SessionV1 } from "@graphagent/core/v1/session"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SettingsHook } from "@/hook"
import { Cause, Effect } from "effect"
import type { Context } from "effect"
import { SessionAbortReason } from "../abort-reason"
import type { SessionCompaction } from "../compaction"
import { MessageV2 } from "../message-v2"
import type { Handle as ProcessorHandle, Result as ProcessorResult } from "../processor"
import { PartID, type MessageID, type SessionID } from "../schema"
import { Session } from "../session"

/** A turn interrupted only by disposal is still an interrupt for finalization;
 * a mixed cause keeps its real failure and must take the error path. */
export function isClosingOnlyCause(cause: Cause.Cause<never>): boolean {
  return (
    cause.reasons.length > 0 &&
    cause.reasons.every(
      (reason) =>
        Cause.isInterruptReason(reason) ||
        (Cause.isDieReason(reason) && reason.defect instanceof InstanceState.Closing),
    )
  )
}

export interface SettleDeps {
  readonly sessions: Session.Interface
  readonly events: Context.Service.Shape<typeof EventV2Bridge.Service>
  readonly database: Database.Interface
  readonly compaction: SessionCompaction.Interface
  readonly settingsHook: SettingsHook.Interface | undefined
  readonly agentMessages: DagMessages.Interface | undefined
}

export interface FinalizeFailedInput {
  readonly cause: Cause.Cause<never>
  readonly sessionID: SessionID
  readonly msg: SessionV1.Assistant
  readonly identity: DagMessages.Caller
  readonly modelMessageID: MessageID
  readonly agentSnapshot: DagMessages.Snapshot | undefined
}

export interface SettleAttemptInput {
  readonly sessionID: SessionID
  readonly lastUser: SessionV1.User
  readonly msg: SessionV1.Assistant
  readonly handle: ProcessorHandle
  readonly format: NonNullable<SessionV1.User["format"]>
  readonly result: ProcessorResult
  readonly structured: unknown
  readonly toolsDisabled: boolean
  readonly isLastStep: boolean
  readonly toolLimitReached: boolean
  readonly agentInputBlocked: boolean
  readonly agentSnapshot: DagMessages.Snapshot | undefined
  readonly identity: DagMessages.Caller
}

export interface SettleAttemptResult {
  readonly outcome: "break" | "continue"
  readonly agentInputBlocked: boolean
  readonly resetStopContinuations: boolean
}

export function makeSettle(deps: SettleDeps) {
  const { sessions, events, database, compaction, settingsHook, agentMessages } = deps

  // PostToolBatch for one assistant message's settled tool calls. Returns true when a hook stopped the turn.
  // Feedback is hidden model context attached to the turn's user message as synthetic parts.
  const postToolBatch = Effect.fnUntraced(function* (input: {
    sessionID: SessionID
    batch: readonly SessionV1.ToolPart[]
    feedbackMessageID: MessageID
  }) {
    if (!settingsHook) return false
    const afterBatch = yield* settingsHook.trigger(
      {
        event: "PostToolBatch",
        toolCalls: input.batch.map((part) => ({
          toolName: part.tool,
          toolInput: part.state.input,
          toolUseID: part.callID,
          toolResponse:
            part.state.status === "completed"
              ? part.state.output
              : part.state.status === "error"
                ? part.state.error
                : "",
        })),
      },
      { sessionID: input.sessionID },
    )
    yield* SettingsHook.landSystemMessages(afterBatch, { sessionID: input.sessionID })
    const feedback = [...afterBatch.additionalContexts]
    const stop = !!(afterBatch.blocked || afterBatch.preventContinuation)
    if (stop) feedback.push(afterBatch.stopReason ?? afterBatch.blocked?.reason ?? "Hook requested stop")
    for (const text of feedback) {
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: input.feedbackMessageID,
        sessionID: input.sessionID,
        type: "text",
        text,
        synthetic: true,
      })
    }
    return stop
  })

  const finalizeInterruptedAssistant = Effect.fnUntraced(function* (sessionID: SessionID, msg: SessionV1.Assistant) {
    const abort = SessionAbortReason.peek(sessionID)
    const legacyAbort =
      msg.error?.name === "MessageAbortedError" &&
      SessionAbortReason.replaceableByCancellation(
        "message" in msg.error.data && typeof msg.error.data.message === "string" ? msg.error.data.message : undefined,
      )
    const interrupted = MessageV2.fromError(
      new DOMException(abort ? SessionAbortReason.format(abort) : "Aborted", "AbortError"),
      {
        providerID: msg.providerID,
        aborted: true,
      },
    )
    if (msg.time.completed) {
      // The processor can complete the message with a bare abort before
      // this finalizer runs. Upgrade that placeholder to the named
      // reason, but never overwrite a real failure.
      if (!abort || !legacyAbort) return
      msg.error = interrupted
      yield* sessions.updateMessage(msg)
      return
    }
    if (abort) {
      if (!msg.error || legacyAbort) msg.error = interrupted
    } else msg.error ??= interrupted
    msg.time.completed = Date.now()
    yield* sessions.updateMessage(msg)
  })

  const finalizeFailedAssistant = Effect.fnUntraced(function* (args: FinalizeFailedInput) {
    const { cause, sessionID, msg, identity, modelMessageID, agentSnapshot } = args
    // `onInterrupt` handles pure interrupts. `onError` may still see a
    // mixed cause; only a closing-only remainder may use the interrupt
    // path. Any real failure keeps its error and runs input cleanup.
    const closing = isClosingOnlyCause(cause)
    if (closing) return yield* finalizeInterruptedAssistant(sessionID, msg)
    msg.error ??= MessageV2.fromError(Cause.squash(cause), { providerID: msg.providerID })
    msg.time.completed ??= Date.now()
    yield* sessions.updateMessage(msg)
    if (!agentMessages || !agentSnapshot) return
    const input = yield* agentMessages.snapshotForTurn(identity, modelMessageID)
    // Preparation failures retain unassociated input for a later admitted
    // turn. An already associated request has a permanent failed outcome.
    if (input.ok && input.value?.associated) {
      yield* agentMessages.markStopped(identity, input.value.id, "model_error")
      yield* agentMessages.discardPending(identity, "model_error")
    }
  })

  const settleAttempt = Effect.fn("SessionPrompt.settleAttempt")(function* (input: SettleAttemptInput) {
    const {
      sessionID,
      lastUser,
      msg,
      handle,
      format,
      structured,
      toolsDisabled,
      isLastStep,
      toolLimitReached,
      agentSnapshot,
      identity,
    } = input
    let result = input.result
    let agentInputBlocked = input.agentInputBlocked
    let resetStopContinuations = false
    if (result === "deferred") return { outcome: "break" as const, agentInputBlocked, resetStopContinuations }
    const settledParts = yield* MessageV2.parts(msg.id).pipe(Effect.provideService(Database.Service, database))
    const batch = settledParts.filter(
      (part): part is SessionV1.ToolPart =>
        part.type === "tool" && (part.state.status === "completed" || part.state.status === "error"),
    )
    if (batch.length > 0) {
      // The cap counts consecutive Stop continuations with no tool work.
      resetStopContinuations = true
      if (settingsHook && (yield* postToolBatch({ sessionID, batch, feedbackMessageID: lastUser.id }))) result = "stop"
    }
    if (result === "stop" || handle.message.error) {
      agentInputBlocked = true
      const reason = handle.message.error ? "model_error" : "turn_blocked"
      if (agentMessages) {
        if (agentSnapshot) yield* agentMessages.markStopped(identity, agentSnapshot.id, reason)
        yield* agentMessages.discardPending(identity, reason)
        if (result === "stop" && !handle.message.error) {
          const endpoint = yield* agentMessages.revisions(identity)
          if (endpoint.ok && endpoint.value.endpoint.kind === "node") {
            handle.message.error = new NamedError.Unknown({
              message: "DAG child turn blocked; continuation requires user action",
            }).toObject()
            yield* sessions.updateMessage(handle.message)
          }
        }
      }
    }

    if (handle.message.finish === "content-filter" && !handle.message.error) {
      handle.message.error = new SessionV1.ContentFilterError({
        message: "The response was blocked by the provider's content filter",
      }).toObject()
      yield* sessions.updateMessage(handle.message)
      yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
      return { outcome: "break" as const, agentInputBlocked, resetStopContinuations }
    }

    if (structured !== undefined && !handle.message.error) {
      handle.message.structured = structured
      handle.message.finish = handle.message.finish ?? "stop"
      yield* sessions.updateMessage(handle.message)
      return { outcome: "break" as const, agentInputBlocked, resetStopContinuations }
    }

    const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
    if (finished && !handle.message.error) {
      // Surface any content-filter finish (e.g. Anthropic stop_reason:
      // refusal) as an error. These turns may have produced no visible
      // output at all — previously the session went idle silently — or
      // partial text that was cut off by the provider's filter.
      if (handle.message.finish === "content-filter") {
        handle.message.error = new SessionV1.ContentFilterError({
          message: "The response was blocked by the provider's content filter",
        }).toObject()
        yield* sessions.updateMessage(handle.message)
        yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
        return { outcome: "break" as const, agentInputBlocked, resetStopContinuations }
      }
    }

    if (format.type === "json_schema" && !handle.message.error && (finished || toolsDisabled)) {
      handle.message.error = new SessionV1.StructuredOutputError({
        message: toolLimitReached
          ? "Maximum tool calls reached before producing structured output"
          : isLastStep
            ? "Maximum agent steps reached before producing structured output"
            : "Model did not produce structured output",
        retries: 0,
      }).toObject()
      yield* sessions.updateMessage(handle.message)
      if (toolsDisabled) yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
      return { outcome: "break" as const, agentInputBlocked, resetStopContinuations }
    }

    if (toolsDisabled || result === "stop")
      return { outcome: "break" as const, agentInputBlocked, resetStopContinuations }
    if (result === "compact") {
      yield* compaction.create({
        sessionID,
        agent: lastUser.agent,
        model: lastUser.model,
        auto: true,
        overflow: !handle.message.finish,
      })
    }
    return { outcome: "continue" as const, agentInputBlocked, resetStopContinuations }
  })

  return { postToolBatch, finalizeFailed: finalizeFailedAssistant, settleAttempt }
}

export * as Settle from "./settle"
