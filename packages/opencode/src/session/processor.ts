import { ThinkingReplay } from "./thinking-replay"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Deferred, Effect, Exit, Layer, Context, Scope, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import {
  SessionRetry,
  EmptyResponseError,
  EMPTY_RESPONSE_MESSAGE,
  IncompleteResponseError,
  INCOMPLETE_RESPONSE_MESSAGE,
  IncompleteReasoningResponseError,
  INCOMPLETE_REASONING_RESPONSE_MESSAGE,
} from "./retry"
import { ToolInputRejectedError } from "./llm/ai-sdk"
import { hookToolStop } from "@/hook/trigger-result"
import { CompactionTimeoutError, watchCompactionStream } from "./compaction-timeout"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import * as DateTime from "effect/DateTime"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLMError, Usage, type LLMEvent } from "@opencode-ai/llm"

const DOOM_LOOP_THRESHOLD = 3
export type Result = "compact" | "stop" | "continue" | "timeout" | "deferred" | "split"

export interface Handle {
  readonly message: SessionV1.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
  ) => Effect.Effect<SessionV1.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: SessionV1.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly resumeToolCall: (part: SessionV1.ToolPart, execute: Effect.Effect<unknown, unknown>) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput, options?: { allowSplit?: boolean }) => Effect.Effect<Result>
}

type Input = {
  assistantMessage: SessionV1.Assistant
  sessionID: SessionID
  model: Provider.Model
  /**
   * Called once per reasoning part that ended normally, after it is persisted. `canSplit` is false when this request
   * may not stop for a continuation, so the host must organize the part in place. Returns `split` when the host wants
   * to stop this stream before content or tools start, organize the reasoning, and continue in a second request.
   */
  onReasoningSettled?: (part: SessionV1.ReasoningPart, canSplit: boolean) => Effect.Effect<"split" | "continue">
  displayMode?: "interactive" | "noninteractive"
  onTextDisplay?: (batch: { delta: string; index: number; final: boolean }) => Effect.Effect<string>
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  assistantMessageID?: SessionMessage.ID
  partID: SessionV1.ToolPart["id"]
  messageID: SessionV1.ToolPart["messageID"]
  sessionID: SessionV1.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
  inputEnded: boolean
  raw: string
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  /** Stop the current stream at a settled reasoning part so the host can organize it before content starts. */
  splitForContinuation: boolean
  /** Whether this attempt may split; the continuation request disables further splits. */
  allowSplit: boolean
  currentText: SessionV1.TextPart | undefined
  currentTextID: string | undefined
  reasoningMap: Record<string, SessionV1.ReasoningPart>
  v2AssistantMessageID: SessionMessage.ID | undefined
  /** A tool call admission/result/error signal was seen in the current stream. */
  anyToolCalled: boolean
  /** Tool-call events admitted in the current stream (repair artifacts included). */
  admittedToolCalls: number
  /**
   * Tool calls admitted by a tool-call event whose execution has not been
   * confirmed (no real result/error yet). Conservatively treated as executed:
   * an in-flight async execute may still be running after the stream drains.
   */
  pendingToolExecutions: Set<string>
  /** Finish reason of the current attempt only (assistant.finish persists across attempts). */
  attemptFinish: string | undefined
  /** Sum of text-delta lengths in the current attempt; zero means no visible text. */
  attemptTextLength: number
  /** Sum of reasoning-delta lengths in the current attempt; zero means no visible reasoning. */
  attemptReasoningLength: number
  /** Includes opaque-only reasoning parts and orphan reasoning deltas. */
  attemptReasoningActivity: boolean
  /** Nonempty provider metadata can carry encrypted reasoning without text. */
  attemptOpaqueReasoning: boolean
  /** Persisted reasoning from this attempt must be removed if it fails. */
  attemptReasoningParts: Map<PartID, { reasoningID: string; assistantMessageID?: SessionMessage.ID }>
  /**
   * Any tool input/call/result/error signal was observed in the current
   * attempt. Input-level signals count even without an admitted tool call so
   * a stream that only produced tool input never takes the empty path; the
   * separate #773 admission gate still owns its own executable-call rules.
   */
  attemptToolActivity: boolean
  /**
   * The adapter marked the current attempt's finish metadata with
   * `opencode.suppressedActivity`: provider activity that is not
   * session-visible (files, sources, approvals, denials, aborts). Such an
   * attempt is never treated as an empty response.
   */
  attemptSuppressedActivity: boolean
  /** Suppressed abort/approval/denial or unknown activity forbids replay. */
  attemptRetryBlockingSuppressedActivity: boolean
}

type StreamEvent = LLMEvent

function hasReasoningMetadata(value: unknown): boolean {
  const pending = [value]
  const seen = new Set<object>()
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === "string" && item.length > 0) return true
    if (typeof item === "number" && Number.isFinite(item) && item !== 0) return true
    if (item === true) return true
    if (!item || typeof item !== "object" || seen.has(item)) continue
    seen.add(item)
    if (Array.isArray(item)) {
      for (const entry of item) pending.push(entry)
    } else if (isRecord(item)) {
      for (const entry of Object.values(item)) pending.push(entry)
    }
  }
  return false
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        splitForContinuation: false,
        allowSplit: true,
        currentText: undefined,
        currentTextID: undefined,
        reasoningMap: {},
        v2AssistantMessageID: undefined,
        anyToolCalled: false,
        admittedToolCalls: 0,
        pendingToolExecutions: new Set<string>(),
        attemptFinish: undefined,
        attemptTextLength: 0,
        attemptReasoningLength: 0,
        attemptReasoningActivity: false,
        attemptOpaqueReasoning: false,
        attemptReasoningParts: new Map(),
        attemptToolActivity: false,
        attemptSuppressedActivity: false,
        attemptRetryBlockingSuppressedActivity: false,
      }
      let mirrorAssistant = flags.experimentalEventSystem && !input.assistantMessage.summary
      let aborted = false
      let deferred = false
      let displayPending = ""
      let displayIndex = 0
      let displayFinished = false
      const displayParts: SessionV1.TextPart[] = []
      let displaySegments: Array<{ part: SessionV1.TextPart; length: number }> = []
      let lastDisplayPart: SessionV1.TextPart | undefined
      const display = Effect.fn("SessionProcessor.display")(function* (final: boolean) {
        if (!input.onTextDisplay || displayFinished) return
        if (final && input.displayMode !== "interactive") {
          // Noninteractive consumers receive the completed message once,
          // including changes made by experimental.text.complete.
          displayPending = displayParts.map((part) => part.text).join("")
          displaySegments = displayParts
            .filter((part) => part.text.length > 0)
            .map((part) => ({ part, length: part.text.length }))
        }
        const target = displaySegments[0]?.part ?? lastDisplayPart
        if (!target) return
        const end = final ? displayPending.length : displayPending.lastIndexOf("\n") + 1
        if (!final && (input.displayMode !== "interactive" || end === 0)) return
        const delta = displayPending.slice(0, end)
        displayPending = displayPending.slice(end)
        let remaining = end
        while (remaining > 0 && displaySegments.length > 0) {
          const first = displaySegments[0]
          const consumed = Math.min(remaining, first.length)
          first.length -= consumed
          remaining -= consumed
          if (first.length === 0) displaySegments.shift()
        }
        const text = yield* input.onTextDisplay({ delta, index: displayIndex++, final })
        target.displayText = (target.displayText ?? "") + text
        yield* session.updatePart(target)
        lastDisplayPart = target
        displayFinished = final
      })

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const ensureV2AssistantMessage = Effect.fn("SessionProcessor.ensureV2AssistantMessage")(function* () {
        if (ctx.v2AssistantMessageID) return ctx.v2AssistantMessageID
        ctx.v2AssistantMessageID = SessionMessage.ID.create()
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID: ctx.sessionID,
          assistantMessageID: ctx.v2AssistantMessageID,
          agent: input.assistantMessage.agent,
          model: {
            id: ModelV2.ID.make(ctx.model.id),
            providerID: ProviderV2.ID.make(ctx.model.providerID),
            variant: ModelV2.VariantID.make(input.assistantMessage.variant ?? "default"),
          },
          snapshot: ctx.snapshot,
          timestamp: DateTime.makeUnsafe(Date.now()),
        })
        return ctx.v2AssistantMessageID
      })

      const requireV2AssistantMessage = (toolCall?: ToolCall) =>
        toolCall?.assistantMessageID === undefined
          ? Effect.die("V2 tool settlement has no owning assistant message")
          : Effect.succeed(toolCall.assistantMessageID)

      const currentV2AssistantMessage = () =>
        ctx.v2AssistantMessageID === undefined
          ? Effect.die("V2 step settlement has no owning assistant message")
          : Effect.succeed(ctx.v2AssistantMessageID)

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return undefined
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return undefined
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: SessionV1.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: output.metadata,
            title: output.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments: output.attachments,
          },
        })
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        if (error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const finishReasoning = Effect.fn("SessionProcessor.finishReasoning")(function* (
        reasoningID: string,
        allowSplit: boolean,
      ) {
        if (!(reasoningID in ctx.reasoningMap)) return
        const part = ctx.reasoningMap[reasoningID]
        // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
        if (mirrorAssistant) {
          yield* events.publish(SessionEvent.Reasoning.Ended, {
            sessionID: ctx.sessionID,
            assistantMessageID: yield* currentV2AssistantMessage(),
            reasoningID: part.v2?.reasoningID ?? reasoningID,
            text: part.text,
            providerMetadata: part.metadata,
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }
        // oxlint-disable-next-line no-self-assign -- reactivity trigger
        ctx.reasoningMap[reasoningID].text = ctx.reasoningMap[reasoningID].text
        ctx.reasoningMap[reasoningID].time = { ...ctx.reasoningMap[reasoningID].time, end: Date.now() }
        const settled = yield* session.updatePart(ctx.reasoningMap[reasoningID])
        delete ctx.reasoningMap[reasoningID]
        if (!input.onReasoningSettled || ctx.assistantMessage.summary) return
        // A part may only stop the stream while this attempt has produced no visible text or tool activity. The host
        // uses the same flag to decide whether it can defer organization to the continuation loop or must organize
        // the part in place.
        const canSplit =
          allowSplit &&
          ctx.allowSplit &&
          ctx.currentText === undefined &&
          ctx.attemptTextLength === 0 &&
          Object.keys(ctx.toolcalls).length === 0 &&
          ctx.admittedToolCalls === 0 &&
          !ctx.attemptToolActivity
        const decision = yield* input.onReasoningSettled(settled, canSplit)
        if (canSplit && decision === "split") ctx.splitForContinuation = true
      })

      const flushV2Fragments = Effect.fn("SessionProcessor.flushV2Fragments")(function* () {
        if (!mirrorAssistant) return
        if (!ctx.assistantMessage.summary && ctx.currentText && ctx.currentTextID) {
          yield* events.publish(SessionEvent.Text.Ended, {
            sessionID: ctx.sessionID,
            assistantMessageID: yield* currentV2AssistantMessage(),
            textID: ctx.currentTextID,
            text: ctx.currentText.text,
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }
        yield* Effect.forEach(Object.entries(ctx.reasoningMap), ([reasoningID, part]) =>
          currentV2AssistantMessage().pipe(
            Effect.flatMap((assistantMessageID) =>
              events.publish(SessionEvent.Reasoning.Ended, {
                sessionID: ctx.sessionID,
                assistantMessageID,
                reasoningID: part.v2?.reasoningID ?? reasoningID,
                text: part.text,
                providerMetadata: part.metadata,
                timestamp: DateTime.makeUnsafe(Date.now()),
              }),
            ),
          ),
        )
      })

      const ensureToolCall = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
        id: string
        name: string
        providerExecuted?: boolean
      }) {
        const existing = yield* readToolCall(input.id)
        if (existing) {
          if (!input.providerExecuted || existing.part.metadata?.providerExecuted) return existing
          const part = yield* session.updatePart({
            ...existing.part,
            metadata: { ...existing.part.metadata, providerExecuted: true },
          })
          ctx.toolcalls[input.id] = {
            ...existing.call,
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
          }
          return { call: ctx.toolcalls[input.id], part }
        }
        // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
        const assistantMessageID = mirrorAssistant ? yield* ensureV2AssistantMessage() : undefined
        if (assistantMessageID) {
          yield* events.publish(SessionEvent.Tool.Input.Started, {
            sessionID: ctx.sessionID,
            assistantMessageID,
            callID: input.id,
            name: input.name,
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }
        const part = yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "tool",
          tool: input.name,
          callID: input.id,
          state: { status: "pending", input: {}, raw: "" },
          metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
          ...(assistantMessageID ? { v2: { messageID: assistantMessageID } } : {}),
        } satisfies SessionV1.ToolPart)
        ctx.toolcalls[input.id] = {
          assistantMessageID,
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
          inputEnded: false,
          raw: "",
        }
        return { call: ctx.toolcalls[input.id], part }
      })

      const isFilePart = (value: unknown): value is SessionV1.FilePart => Schema.is(SessionV1.FilePart)(value)

      const toolResultOutput = (
        value: Extract<StreamEvent, { type: "tool-result" }>,
      ): { title: string; metadata: Record<string, any>; output: string; attachments?: SessionV1.FilePart[] } => {
        if (isRecord(value.result.value) && typeof value.result.value.output === "string") {
          return {
            title: typeof value.result.value.title === "string" ? value.result.value.title : value.name,
            metadata: isRecord(value.result.value.metadata) ? value.result.value.metadata : {},
            output: value.result.value.output,
            attachments: Array.isArray(value.result.value.attachments)
              ? value.result.value.attachments.filter(isFilePart)
              : undefined,
          }
        }
        return {
          title: value.name,
          metadata: value.result.type === "json" && isRecord(value.result.value) ? value.result.value : {},
          output:
            typeof value.result.value === "string" ? value.result.value : (JSON.stringify(value.result.value) ?? ""),
        }
      }

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "reasoning-start": {
            ctx.attemptReasoningActivity = true
            if (hasReasoningMetadata(value.providerMetadata)) ctx.attemptOpaqueReasoning = true
            if (value.id in ctx.reasoningMap) return
            // The provider restarts its stream-local ids for every request. A continuation reuses this assistant
            // message, so the v2 mirror identity must come from the globally unique part id instead.
            const partID = PartID.ascending()
            const v2AssistantMessageID = mirrorAssistant ? yield* ensureV2AssistantMessage() : undefined
            const part: SessionV1.ReasoningPart = {
              id: partID,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              ...(v2AssistantMessageID
                ? { v2: { messageID: v2AssistantMessageID, reasoningID: partID } }
                : {}),
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (v2AssistantMessageID) {
              yield* events.publish(SessionEvent.Reasoning.Started, {
                sessionID: ctx.sessionID,
                assistantMessageID: v2AssistantMessageID,
                reasoningID: partID,
                providerMetadata: value.providerMetadata,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            ctx.reasoningMap[value.id] = part
            ctx.attemptReasoningParts.set(partID, {
              reasoningID: partID,
              assistantMessageID: v2AssistantMessageID,
            })
            yield* session.updatePart(part)
            return
          }

          case "reasoning-delta":
            ctx.attemptReasoningActivity = true
            if (hasReasoningMetadata(value.providerMetadata)) ctx.attemptOpaqueReasoning = true
            ctx.attemptReasoningLength += value.text.length
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            if (mirrorAssistant) {
              yield* events.publish(SessionEvent.Reasoning.Delta, {
                sessionID: ctx.sessionID,
                assistantMessageID: yield* currentV2AssistantMessage(),
                reasoningID: ctx.reasoningMap[value.id].v2?.reasoningID ?? value.id,
                delta: value.text,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            ctx.attemptReasoningActivity = true
            if (hasReasoningMetadata(value.providerMetadata)) ctx.attemptOpaqueReasoning = true
            if (value.providerMetadata && value.id in ctx.reasoningMap) {
              ctx.reasoningMap[value.id].metadata = value.providerMetadata
            }
            yield* finishReasoning(value.id, true)
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            ctx.attemptToolActivity = true
            yield* ensureToolCall(value)
            return

          case "tool-input-delta":
            {
              ctx.attemptToolActivity = true
              const toolCall = yield* ensureToolCall(value)
              const assistantMessageID = mirrorAssistant ? yield* requireV2AssistantMessage(toolCall.call) : undefined
              if (assistantMessageID) {
                yield* events.publish(SessionEvent.Tool.Input.Delta, {
                  sessionID: ctx.sessionID,
                  assistantMessageID,
                  callID: value.id,
                  delta: value.text,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
              ctx.toolcalls[value.id] = { ...toolCall.call, raw: toolCall.call.raw + value.text }
            }
            return

          case "tool-input-end": {
            ctx.attemptToolActivity = true
            const toolCall = yield* ensureToolCall(value)
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (mirrorAssistant) {
              const assistantMessageID = yield* requireV2AssistantMessage(toolCall.call)
              yield* events.publish(SessionEvent.Tool.Input.Ended, {
                sessionID: ctx.sessionID,
                assistantMessageID,
                callID: value.id,
                text: toolCall.call.raw,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            ctx.toolcalls[value.id] = { ...toolCall.call, inputEnded: true }
            return
          }

          case "tool-call": {
            // A tool call admission signal was emitted: the execution pipeline
            // may already be running asynchronously, so a stream failure from
            // this point on must never be auto-retried. Record the call as
            // pending; it is only revoked below when the adapter reports the
            // SDK's input rejection (a call that was never executed).
            ctx.pendingToolExecutions.add(value.id)
            ctx.admittedToolCalls += 1
            ctx.attemptToolActivity = true
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            const toolCall = yield* ensureToolCall(value)
            const input = isRecord(value.input) ? value.input : { value: value.input }
            if (!toolCall.call.inputEnded) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (mirrorAssistant) {
                const assistantMessageID = yield* requireV2AssistantMessage(toolCall.call)
                yield* events.publish(SessionEvent.Tool.Input.Ended, {
                  sessionID: ctx.sessionID,
                  assistantMessageID,
                  callID: value.id,
                  text: toolCall.call.raw,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
            }
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (mirrorAssistant) {
              const assistantMessageID = yield* requireV2AssistantMessage(toolCall.call)
              yield* events.publish(SessionEvent.Tool.Called, {
                sessionID: ctx.sessionID,
                assistantMessageID,
                callID: value.id,
                tool: value.name,
                input,
                provider: {
                  executed: toolCall.part.metadata?.providerExecuted === true,
                  ...(value.providerMetadata ? { metadata: value.providerMetadata } : {}),
                },
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state:
                match.state.status === "running"
                  ? { ...match.state, input }
                  : {
                      status: "running",
                      input,
                      time: { start: Date.now() },
                    },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            const parts = yield* MessageV2.parts(ctx.assistantMessage.id).pipe(
              Effect.provideService(Database.Service, database),
            )
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.name &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(input),
              )
            ) {
              return
            }

            const agent = yield* agents.get(ctx.assistantMessage.agent)
            if (!agent) return yield* Effect.die(new Error(`Agent ${ctx.assistantMessage.agent} is unavailable`))
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.name],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.name, input },
              always: [value.name],
              ruleset: agent.permission,
            })
            return
          }

          case "tool-result": {
            ctx.anyToolCalled = true
            ctx.attemptToolActivity = true
            const toolCall = yield* readToolCall(value.id)
            if (!toolCall && value.result.type === "error") return
            if (value.result.type === "error") {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (mirrorAssistant) {
                const assistantMessageID = yield* requireV2AssistantMessage(toolCall?.call)
                yield* events.publish(SessionEvent.Tool.Failed, {
                  sessionID: ctx.sessionID,
                  assistantMessageID,
                  callID: value.id,
                  error: { type: "unknown", message: errorMessage(value.result.value) },
                  result: value.result,
                  provider: {
                    executed: value.providerExecuted === true || toolCall?.part.metadata?.providerExecuted === true,
                    ...(value.providerMetadata ? { metadata: value.providerMetadata } : {}),
                  },
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
              yield* failToolCall(value.id, value.result.value)
              return
            }
            const rawOutput = toolResultOutput(value)
            if (rawOutput.metadata.hookDeferred === true && toolCall) {
              deferred = true
              ctx.pendingToolExecutions.delete(value.id)
              if (mirrorAssistant) {
                yield* events.publish(SessionEvent.Tool.Progress, {
                  sessionID: ctx.sessionID,
                  assistantMessageID: yield* requireV2AssistantMessage(toolCall.call),
                  callID: value.id,
                  structured: { hookDeferred: true },
                  content: [],
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
              yield* session.updatePart({
                ...toolCall.part,
                state: {
                  status: "pending",
                  input: toolCall.part.state.input,
                  raw: JSON.stringify(toolCall.part.state.input),
                  deferred: true,
                },
              })
              yield* settleToolCall(value.id)
              return
            }
            const normalized = yield* Effect.forEach(rawOutput.attachments ?? [], (attachment) =>
              attachment.mime.startsWith("image/")
                ? image.normalize(attachment).pipe(
                    Effect.catchIf(
                      (error) => error instanceof Image.ResizerUnavailableError,
                      () => Effect.succeed(attachment),
                    ),
                    Effect.exit,
                  )
                : Effect.succeed(Exit.succeed(attachment)),
            )
            const omitted = normalized.filter(Exit.isFailure).length
            const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
            const output = {
              ...rawOutput,
              output:
                omitted === 0
                  ? rawOutput.output
                  : `${rawOutput.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
              attachments: attachments.length ? attachments : undefined,
            }
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (mirrorAssistant) {
              const assistantMessageID = yield* requireV2AssistantMessage(toolCall?.call)
              const content = [
                { type: "text" as const, text: output.output },
                ...(output.attachments?.map(
                  (item: SessionV1.FilePart) =>
                    ({
                      type: "file",
                      uri: item.url,
                      mime: item.mime,
                      name: item.filename,
                    }) as const,
                ) ?? []),
              ]
              const unsupported = content.find((item) => item.type === "file" && !item.uri.startsWith("data:"))
              if (unsupported?.type === "file") {
                const error = new Error(
                  `Tool attachment URI "${unsupported.uri}" must be materialized before durable V2 settlement`,
                )
                yield* events.publish(SessionEvent.Tool.Failed, {
                  sessionID: ctx.sessionID,
                  assistantMessageID,
                  callID: value.id,
                  error: {
                    type: "unknown",
                    message: error.message,
                  },
                  provider: {
                    executed: value.providerExecuted === true || toolCall?.part.metadata?.providerExecuted === true,
                    ...(value.providerMetadata ? { metadata: value.providerMetadata } : {}),
                  },
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
                yield* failToolCall(value.id, error)
                return
              } else
                yield* events.publish(SessionEvent.Tool.Success, {
                  sessionID: ctx.sessionID,
                  assistantMessageID,
                  callID: value.id,
                  structured: output.metadata,
                  content,
                  result: value.result,
                  provider: {
                    executed: value.providerExecuted === true || toolCall?.part.metadata?.providerExecuted === true,
                    ...(value.providerMetadata ? { metadata: value.providerMetadata } : {}),
                  },
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
            }
            yield* completeToolCall(value.id, output)
            // A hook `continue:false` (PreToolUse/PostToolUse) ends the agent turn after this result.
            if (output.metadata.hookStopped === true) ctx.blocked = true
            return
          }

          case "tool-error": {
            // A rejected tool input is the SDK's refusal to parse a tool call
            // before any execution was possible: revoke the pending admission
            // instead of counting it as an execution signal. Real tool
            // results, errors, provider-executed outputs, and anything without
            // the adapter's sentinel always count conservatively.
            if (value.error instanceof ToolInputRejectedError) {
              ctx.pendingToolExecutions.delete(value.id)
            } else {
              ctx.anyToolCalled = true
            }
            // Rejected or not, a tool-error signal is tool activity in this
            // attempt; the #773 admission rules decide its retry separately.
            ctx.attemptToolActivity = true
            const toolCall = yield* readToolCall(value.id)
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (mirrorAssistant) {
              const assistantMessageID = yield* requireV2AssistantMessage(toolCall?.call)
              yield* events.publish(SessionEvent.Tool.Failed, {
                sessionID: ctx.sessionID,
                assistantMessageID,
                callID: value.id,
                error: {
                  type: "unknown",
                  message: value.message,
                },
                provider: {
                  executed: toolCall?.part.metadata?.providerExecuted === true,
                  ...(value.providerMetadata ? { metadata: value.providerMetadata } : {}),
                },
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            // A PostToolUseFailure `continue:false` ends the agent turn once the error is recorded.
            if (hookToolStop(value.error)) ctx.blocked = true
            return
          }

          case "provider-error":
            yield* Effect.fail(value)
            return

          case "step-start":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (mirrorAssistant) {
                yield* ensureV2AssistantMessage()
              }
            }
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "step-finish": {
            const completedSnapshot = yield* snapshot.track()
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), (reasoningID) => finishReasoning(reasoningID, false))
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
            })
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (mirrorAssistant) {
                yield* events.publish(SessionEvent.Step.Ended, {
                  sessionID: ctx.sessionID,
                  assistantMessageID: yield* currentV2AssistantMessage(),
                  finish: value.reason,
                  cost: usage.cost,
                  tokens: usage.tokens,
                  snapshot: completedSnapshot,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
                ctx.v2AssistantMessageID = undefined
              }
            }
            ctx.assistantMessage.finish = value.reason
            ctx.attemptFinish = value.reason
            const suppressed =
              isRecord(value.providerMetadata) &&
              isRecord(value.providerMetadata.opencode) &&
              value.providerMetadata.opencode.suppressedActivity === true
            if (suppressed && !ctx.attemptSuppressedActivity) ctx.attemptRetryBlockingSuppressedActivity = true
            ctx.attemptSuppressedActivity ||= suppressed
            ctx.assistantMessage.cost += usage.cost
            // A synchronous continuation reuses this message for a second provider request. Accumulate both
            // requests so the persisted message reports the full cost and usage of the visible turn.
            ctx.assistantMessage.tokens = {
              input: ctx.assistantMessage.tokens.input + usage.tokens.input,
              output: ctx.assistantMessage.tokens.output + usage.tokens.output,
              reasoning: ctx.assistantMessage.tokens.reasoning + usage.tokens.reasoning,
              cache: {
                read: ctx.assistantMessage.tokens.cache.read + usage.tokens.cache.read,
                write: ctx.assistantMessage.tokens.cache.write + usage.tokens.cache.write,
              },
            }
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.reason,
              snapshot: completedSnapshot,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (mirrorAssistant) {
                yield* events.publish(SessionEvent.Text.Started, {
                  sessionID: ctx.sessionID,
                  assistantMessageID: yield* ensureV2AssistantMessage(),
                  timestamp: DateTime.makeUnsafe(Date.now()),
                  textID: value.id,
                })
              }
            }
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              ...(input.onTextDisplay ? { displayText: "" } : {}),
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            ctx.currentTextID = value.id
            if (input.onTextDisplay) displayParts.push(ctx.currentText)
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            ctx.attemptTextLength += value.text.length
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            if (input.onTextDisplay) {
              displayPending += value.text
              if (value.text.length > 0) displaySegments.push({ part: ctx.currentText, length: value.text.length })
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            if (mirrorAssistant) {
              yield* events.publish(SessionEvent.Text.Delta, {
                sessionID: ctx.sessionID,
                assistantMessageID: yield* currentV2AssistantMessage(),
                textID: value.id,
                delta: value.text,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            yield* display(false)
            return

          case "text-end":
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (mirrorAssistant) {
                yield* events.publish(SessionEvent.Text.Ended, {
                  sessionID: ctx.sessionID,
                  assistantMessageID: yield* currentV2AssistantMessage(),
                  text: ctx.currentText.text,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                  textID: value.id,
                })
              }
            }
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
            ctx.currentTextID = undefined
            return

          case "finish":
            if (ctx.attemptFinish === undefined || ctx.attemptFinish === "unknown") ctx.attemptFinish = value.reason
            if (
              isRecord(value.providerMetadata) &&
              isRecord(value.providerMetadata.opencode) &&
              value.providerMetadata.opencode.suppressedActivity === true
            ) {
              if (!ctx.attemptSuppressedActivity) ctx.attemptRetryBlockingSuppressedActivity = true
              ctx.attemptSuppressedActivity = true
            }
            return
        }
      })

      // Force-abort one leftover tool call. The claim-before-abort pattern
      // (sync delete + status re-check) prevents a concurrent completeToolCall
      // or failToolCall from settling it while the forced error is persisted.
      const forceAbortToolCall = Effect.fn("SessionProcessor.forceAbortToolCall")(function* (toolCallID: string) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return
        const part = match.part
        // The tool may have settled between the grace period and this read;
        // never overwrite a completed/errored part with a forced abort.
        if (part.state.status !== "running" && part.state.status !== "pending") return
        delete ctx.toolcalls[toolCallID]
        if (mirrorAssistant && match.call.assistantMessageID) {
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID: ctx.sessionID,
            assistantMessageID: match.call.assistantMessageID,
            callID: toolCallID,
            error: { type: "unknown", message: "Tool execution aborted" },
            provider: { executed: part.metadata?.providerExecuted === true },
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }
        const end = Date.now()
        const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
        yield* session.updatePart({
          ...part,
          state: {
            ...part.state,
            status: "error",
            error: "Tool execution aborted",
            metadata: { ...metadata, interrupted: true },
            time: { start: "time" in part.state ? part.state.time.start : end, end },
          },
        })
      })

      // Sever the leftovers of a failed attempt whose tools never executed:
      // abort the pending placeholders and clear them so a newer attempt (or
      // late stale events) cannot settle them.
      const severUnexecutedToolCalls = Effect.fn("SessionProcessor.severUnexecutedToolCalls")(function* () {
        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          yield* forceAbortToolCall(toolCallID)
        }
        ctx.toolcalls = {}
      })

      // Failed opaque reasoning must not enter a later model request. Remove
      // its V1 parts and overwrite mirrored V2 content through the existing
      // Reasoning.Ended event, including parts that had already ended.
      const discardFailedReasoning = Effect.fn("SessionProcessor.discardFailedReasoning")(function* () {
        for (const [partID, part] of ctx.attemptReasoningParts) {
          if (mirrorAssistant && part.assistantMessageID) {
            yield* events.publish(SessionEvent.Reasoning.Ended, {
              sessionID: ctx.sessionID,
              assistantMessageID: part.assistantMessageID,
              reasoningID: part.reasoningID,
              text: "",
              providerMetadata: { opencode: { failedAttempt: true } },
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
          }
          yield* session.removePart({ sessionID: ctx.sessionID, messageID: ctx.assistantMessage.id, partID })
        }
        ctx.attemptReasoningParts.clear()
        ctx.reasoningMap = {}
      })

      // A retry retains the assistant message but must close partial parts and
      // discard unexecuted tool placeholders before the next attempt starts.
      const settleRetryAttempt = Effect.fn("SessionProcessor.settleRetryAttempt")(function* () {
        if (ctx.currentText) {
          if (mirrorAssistant && ctx.currentTextID) {
            yield* events.publish(SessionEvent.Text.Ended, {
              sessionID: ctx.sessionID,
              assistantMessageID: yield* currentV2AssistantMessage(),
              textID: ctx.currentTextID,
              text: ctx.currentText.text,
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
          }
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
          ctx.currentTextID = undefined
        }
        yield* discardFailedReasoning()
        yield* severUnexecutedToolCalls()
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
          ctx.currentTextID = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          yield* forceAbortToolCall(toolCallID)
        }
        ctx.toolcalls = {}
        if (deferred) ctx.assistantMessage.finish = "tool_deferred"
        yield* display(true)
        if (ctx.splitForContinuation) return
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        yield* Effect.logError("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
          error: errorMessage(e),
          stack: e instanceof Error ? e.stack : undefined,
        })
        const error = IncompleteResponseError.isInstance(e)
          ? // Persist the meaningful terminal failure in the existing error
            // shape; a custom name cannot satisfy the assistant error union.
            new SessionV1.APIError({
              message: e.data.message,
              isRetryable: false,
              metadata: { code: "incomplete_response" },
            }).toObject()
          : EmptyResponseError.isInstance(e)
            ? new SessionV1.APIError({
                message: e.data.message,
                isRetryable: false,
                metadata: { code: "empty_response" },
              }).toObject()
            : IncompleteReasoningResponseError.isInstance(e)
              ? new SessionV1.APIError({
                  message: e.data.message,
                  isRetryable: false,
                  metadata: { code: "incomplete_reasoning_response" },
                }).toObject()
              : parse(e)
        if (
          !aborted &&
          !ctx.attemptToolActivity &&
          !ctx.anyToolCalled &&
          (EmptyResponseError.isInstance(e) ||
            IncompleteReasoningResponseError.isInstance(e) ||
            SessionRetry.retryable(error, input.model.providerID) !== undefined)
        )
          yield* discardFailedReasoning()
        yield* flushV2Fragments()
        if (SessionV1.ContextOverflowError.isInstance(error)) {
          if ((yield* config.get()).compaction?.auto === false && !ctx.assistantMessage.summary) {
            ctx.assistantMessage.error = error
            ctx.assistantMessage.finish = "error"
            yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            yield* status.set(ctx.sessionID, { type: "idle" })
            return
          }
          ctx.needsCompaction = true
          yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        if (!ctx.assistantMessage.summary) {
          // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
          if (mirrorAssistant) {
            yield* events.publish(SessionEvent.Step.Failed, {
              sessionID: ctx.sessionID,
              assistantMessageID: yield* ensureV2AssistantMessage(),
              error: {
                type: "unknown",
                message: errorMessage(e),
              },
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
          }
        }
        ctx.assistantMessage.error = error
        yield* events.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (
        streamInput: LLM.StreamInput,
        options?: { allowSplit?: boolean },
      ) {
        yield* Effect.logInfo("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
        })
        ctx.needsCompaction = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true
        let timedOut = false
        let attemptGeneration = 0
        const isCompactionTimeout = (error: unknown) => {
          if (streamInput.purpose !== "compaction" || aborted) return false
          const parsed = parse(error)
          if (SessionV1.AbortedError.isInstance(parsed) || SessionV1.ContextOverflowError.isInstance(parsed))
            return false
          return (
            error instanceof CompactionTimeoutError ||
            (error instanceof LLMError && error.isTimeout) ||
            (error instanceof Error && error.name.endsWith("TimeoutError")) ||
            (SessionV1.APIError.isInstance(parsed) && [408, 504].includes(parsed.data.statusCode ?? 0)) ||
            (isRecord(parsed.data) &&
              typeof parsed.data.message === "string" &&
              /\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i.test(
                parsed.data.message,
              ))
          )
        }

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.currentTextID = undefined
            ctx.reasoningMap = {}
            ctx.splitForContinuation = false
            ctx.allowSplit = options?.allowSplit !== false
            // Detection state is per attempt: a retried attempt must not
            // inherit the previous attempt's admissions, and its finish reason
            // is tracked separately so the persisted assistant.finish (last
            // attempt to report one) is not involved in the decision.
            ctx.anyToolCalled = false
            ctx.admittedToolCalls = 0
            ctx.pendingToolExecutions = new Set()
            ctx.attemptFinish = undefined
            ctx.attemptTextLength = 0
            ctx.attemptReasoningLength = 0
            ctx.attemptReasoningActivity = false
            ctx.attemptOpaqueReasoning = false
            ctx.attemptReasoningParts = new Map()
            ctx.attemptToolActivity = false
            ctx.attemptSuppressedActivity = false
            ctx.attemptRetryBlockingSuppressedActivity = false
            yield* status.set(ctx.sessionID, { type: "busy" })
            const generation = ++attemptGeneration
            const source = llm.stream({
              ...streamInput,
              onThinkingInvalidated: (blocks) =>
                Effect.gen(function* () {
                  const invalidated = new Set(blocks)
                  for (const message of yield* session.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)) {
                    for (const part of message.parts) {
                      if (part.type !== "reasoning" || part.time.end === undefined) continue
                      const saved = ThinkingReplay.origin(part.metadata)
                      if (!saved || saved.invalidated || !invalidated.has(saved.block)) continue
                      const current = yield* session.getPart({
                        sessionID: ctx.sessionID,
                        messageID: part.messageID,
                        partID: part.id,
                      })
                      if (current?.type !== "reasoning" || current.time.end === undefined) continue
                      const latest = ThinkingReplay.origin(current.metadata)
                      if (!latest || latest.invalidated || latest.block !== saved.block) continue
                      const metadata = ThinkingReplay.invalidate(current.metadata)
                      if (metadata) yield* session.updatePart({ ...current, metadata })
                    }
                  }
                  if (streamInput.onThinkingInvalidated) yield* streamInput.onThinkingInvalidated(blocks)
                }),
              onAttemptActivity: (activity) => {
                if (generation !== attemptGeneration) return
                if (activity === "tool-executed") ctx.anyToolCalled = true
                else {
                  ctx.attemptSuppressedActivity = true
                  if (activity !== "observational") ctx.attemptRetryBlockingSuppressedActivity = true
                }
                streamInput.onAttemptActivity?.(activity)
              },
            })
            const stream = streamInput.purpose === "compaction" ? watchCompactionStream(source) : source

            yield* stream.pipe(
              Stream.tap((event) => handleEvent(event)),
              Stream.takeUntil(() => ctx.needsCompaction || ctx.splitForContinuation),
              Stream.runDrain,
            )

            // Detect an incomplete response before cleanup loses the
            // execution-state information: the stream drained normally with an
            // unknown/missing finish reason while the model started a tool
            // call that never became executable, and no tool in the failed
            // request executed or could have executed. Fail explicitly inside
            // the retry boundary so the existing schedule, status reporting,
            // and cancellation apply.
            const unfinishedToolInput = Object.values(ctx.toolcalls).some((call) => !call.inputEnded)
            if (
              !aborted &&
              !ctx.needsCompaction &&
              !ctx.splitForContinuation &&
              !ctx.blocked &&
              !ctx.assistantMessage.error &&
              !ctx.anyToolCalled &&
              ctx.pendingToolExecutions.size === 0 &&
              (ctx.attemptFinish === "unknown" || ctx.attemptFinish === undefined) &&
              (unfinishedToolInput || ctx.admittedToolCalls > 0)
            ) {
              yield* severUnexecutedToolCalls()
              return yield* Effect.fail(new IncompleteResponseError({ message: INCOMPLETE_RESPONSE_MESSAGE }))
            }

            // A completely empty normal-conversation attempt (no text, no
            // reasoning, no tool input/call/result/error activity —
            // bookkeeping signals only) must not end the turn silently. Fail
            // inside the retry boundary so the existing bounded schedule,
            // retry statuses, and cancellation apply; exhaustion persists a
            // clear terminal error. Explicit provider outcomes (length,
            // content-filter, error) and compaction/auxiliary requests keep
            // their own policies.
            if (
              (streamInput.purpose === "conversation" || streamInput.purpose === undefined) &&
              !aborted &&
              !ctx.needsCompaction &&
              !ctx.splitForContinuation &&
              !ctx.blocked &&
              !ctx.assistantMessage.error &&
              !ctx.attemptToolActivity &&
              !ctx.attemptSuppressedActivity &&
              ctx.attemptTextLength === 0 &&
              ctx.attemptReasoningLength === 0 &&
              !ctx.attemptOpaqueReasoning &&
              (ctx.attemptFinish === undefined || ctx.attemptFinish === "unknown" || ctx.attemptFinish === "stop")
            ) {
              return yield* Effect.fail(new EmptyResponseError({ message: EMPTY_RESPONSE_MESSAGE }))
            }

            // An abnormal finish after reasoning alone never delivered an
            // answer. Opaque reasoning metadata counts as reasoning activity;
            // a completed stop remains a valid provider-specific outcome.
            if (
              (streamInput.purpose === "conversation" || streamInput.purpose === undefined) &&
              !aborted &&
              !ctx.needsCompaction &&
              !ctx.splitForContinuation &&
              !ctx.blocked &&
              !ctx.assistantMessage.error &&
              !ctx.attemptToolActivity &&
              !ctx.attemptSuppressedActivity &&
              ctx.attemptTextLength === 0 &&
              ctx.attemptReasoningActivity &&
              (ctx.attemptFinish === undefined || ctx.attemptFinish === "unknown")
            ) {
              return yield* Effect.fail(
                new IncompleteReasoningResponseError({ message: INCOMPLETE_REASONING_RESPONSE_MESSAGE }),
              )
            }
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.retry(
              SessionRetry.policy({
                provider: input.model.providerID,
                shouldRetry: () =>
                  !aborted &&
                  !ctx.blocked &&
                  !ctx.needsCompaction &&
                  !ctx.anyToolCalled &&
                  ctx.pendingToolExecutions.size === 0 &&
                  !ctx.attemptRetryBlockingSuppressedActivity,
                // Compaction timeouts immediately advance the model ladder, without retry backoff.
                parse: (error) =>
                  IncompleteResponseError.isInstance(error)
                    ? // fromError has no branch that preserves this identity;
                      // classify the explicit protocol failure for the policy.
                      error.toObject()
                    : EmptyResponseError.isInstance(error)
                      ? error.toObject()
                      : IncompleteReasoningResponseError.isInstance(error)
                        ? error.toObject()
                        : isCompactionTimeout(error)
                          ? new SessionV1.AbortedError({
                              message: "Compaction timeout; advancing model fallback",
                            }).toObject()
                          : parse(error),
                set: (info) => {
                  // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
                  const event = mirrorAssistant
                    ? events.publish(SessionEvent.Retried, {
                        sessionID: ctx.sessionID,
                        attempt: info.attempt,
                        error: {
                          message: info.message,
                          isRetryable: true,
                        },
                        timestamp: DateTime.makeUnsafe(Date.now()),
                      })
                    : Effect.void
                  return settleRetryAttempt().pipe(
                    Effect.andThen(event),
                    Effect.andThen(
                      status.set(ctx.sessionID, {
                        type: "retry",
                        attempt: info.attempt,
                        message: info.message,
                        action: info.action,
                        next: info.next,
                      }),
                    ),
                  )
                },
              }),
            ),
            Effect.catch((error) => {
              if (!isCompactionTimeout(error)) return halt(error)
              timedOut = true
              ctx.assistantMessage.error = parse(error)
              ctx.assistantMessage.finish = "error"
              return Effect.void
            }),
            Effect.ensuring(cleanup()),
          )

          if (ctx.needsCompaction) return "compact"
          if (ctx.splitForContinuation) return "split"
          if (timedOut) return "timeout"
          if (deferred) return "deferred"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      const resumeToolCall: Handle["resumeToolCall"] = Effect.fn("SessionProcessor.resumeToolCall")(
        function* (part, execute) {
          const messageID = part.v2 ? SessionMessage.ID.make(part.v2.messageID) : undefined
          // A deferred call created while V2 mirroring was disabled has no durable V2 owner.
          mirrorAssistant = mirrorAssistant && messageID !== undefined
          ctx.v2AssistantMessageID = messageID
          ctx.toolcalls[part.callID] = {
            assistantMessageID: messageID,
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
            done: yield* Deferred.make<void>(),
            inputEnded: true,
            raw: JSON.stringify(part.state.input),
          }
          yield* session.updatePart({
            ...part,
            state: { status: "running", input: part.state.input, time: { start: Date.now() } },
          })
          const result = yield* execute.pipe(Effect.exit)
          if (Exit.isSuccess(result)) {
            yield* handleEvent({
              type: "tool-result",
              id: part.callID,
              name: part.tool,
              result: { type: "json", value: result.value },
            }).pipe(Effect.orDie)
          } else {
            const error = Cause.squash(result.cause)
            yield* handleEvent({
              type: "tool-error",
              id: part.callID,
              name: part.tool,
              error,
              message: errorMessage(error),
            }).pipe(Effect.orDie)
            if (Cause.hasInterrupts(result.cause)) return yield* Effect.failCause(result.cause).pipe(Effect.orDie)
          }
          ctx.assistantMessage.finish = deferred ? "tool_deferred" : "tool-calls"
          yield* cleanup()
          return undefined
        },
      )
      return {
        get message() {
          return ctx.assistantMessage
        },
        resumeToolCall,
        updateToolCall,
        completeToolCall,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
  ),
)

export const node = LayerNode.make(layer, [
  Session.node,
  Config.node,
  Snapshot.node,
  Agent.node,
  LLM.node,
  Permission.node,
  Plugin.node,
  SessionSummary.node,
  SessionStatus.node,
  Image.node,
  EventV2Bridge.node,
  RuntimeFlags.node,
  Database.node,
])

export * as SessionProcessor from "./processor"
