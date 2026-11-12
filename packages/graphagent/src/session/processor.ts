import { ThinkingReplay } from "./thinking-replay"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@graphagent/core/v1/session"
import { METADATA_NAMESPACE } from "@graphagent/core/brand"
import { Cause, Deferred, Effect, Exit, Layer, Context, Scope, Schema, Semaphore } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow, serializedTools } from "./overflow"
import { counters, fingerprintOf, recordStep, type PrefixFingerprint } from "./step-metrics"
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
import { AgentScheduler } from "./agent-scheduler"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { HistoryView } from "./history/view"
import { LLMError, Usage, type LLMEvent } from "@graphagent/llm"
import { beginAttempt, initialAttemptState, type AttemptState } from "./turn/attempt"

const DOOM_LOOP_THRESHOLD = 3
export type Result = "compact" | "stop" | "continue" | "timeout" | "deferred"

/** Accumulate one provider request's usage into the assistant message that owns both requests. */
function accumulateUsage(message: SessionV1.Assistant, usage: ReturnType<typeof Session.getUsage>) {
  message.cost += usage.cost
  message.tokens = {
    input: message.tokens.input + usage.tokens.input,
    output: message.tokens.output + usage.tokens.output,
    reasoning: message.tokens.reasoning + usage.tokens.reasoning,
    cache: {
      read: message.tokens.cache.read + usage.tokens.cache.read,
      write: message.tokens.cache.write + usage.tokens.cache.write,
    },
  }
}

export interface Handle {
  readonly message: SessionV1.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
  ) => Effect.Effect<SessionV1.ToolPart | undefined>
  /**
   * Non-durable running preview (#1016 HS4a): publishes the output tail for a
   * live tool call without writing the part. State transitions and final
   * results still go through `updateToolCall` / `completeToolCall`.
   */
  readonly previewToolCall: (toolCallID: string, preview: { tail: string; totalLength: number }) => Effect.Effect<void>
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
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
}

type Input = {
  assistantMessage: SessionV1.Assistant
  sessionID: SessionID
  model: Provider.Model
  /** Enqueue background work after persistence; this callback must never wait for organization. */
  onReasoningSettled?: (part: SessionV1.ReasoningPart) => Effect.Effect<void>
  displayMode?: "interactive" | "noninteractive"
  onTextDisplay?: (batch: { delta: string; index: number; final: boolean }) => Effect.Effect<string>
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: SessionV1.ToolPart["id"]
  messageID: SessionV1.ToolPart["messageID"]
  sessionID: SessionV1.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
  inputEnded: boolean
  raw: string
  /** Last persisted part observed or written by this processor (HS8). */
  part: SessionV1.ToolPart
  /** Process write version `part` was derived at; a newer version forces a reload. */
  version: number
  /** Serializes every read-modify-write transition of this call. */
  lock: Semaphore.Semaphore
}

interface ProcessorContext extends Input {
  /** Replaced as a whole at the start of every attempt (`beginAttempt`); never reset field by field. */
  attempt: AttemptState
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  /**
   * Any tool signal (input, call, result, error) in the current step. Until
   * the tool layer declares read-only effects (C2), only a step without tool
   * signals counts as read-only for snapshot purposes.
   */
  stepToolActivity: boolean
  /** Newest last; the doom-loop check only needs the last three call signatures. */
  recentToolSignatures: { name: string; input: string }[]
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

export class Service extends Context.Service<Service, Interface>()("@graphagent/SessionProcessor") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const scheduler = yield* AgentScheduler.Service
    const permission = yield* Permission.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const events = yield* EventV2Bridge.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        attempt: initialAttemptState(),
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        stepToolActivity: false,
        recentToolSignatures: [],
      }
      // Per-call preview sequence; the TUI applies previews latest-wins within
      // a frame, and the sequence lets it discard an older frame.
      const previewSeqs = new Map<string, number>()
      let aborted = false
      let deferred = false
      let displayPending = ""
      let displayIndex = 0
      let displayFinished = false
      // HS14 step observability (#1028 PR1). `handleEvent` and `process` share
      // this closure: the request fingerprint is taken once per provider
      // request, and the counters are scoped to the span between two
      // step-finish events (the first span starts at process entry).
      let metricsProcessStartedAt = 0
      let metricsStepStartedAt = 0
      let metricsFirstTokenAt: number | undefined
      let metricsFingerprint: PrefixFingerprint | undefined
      let metricsCounterBase = counters()
      let metricsStep = 0
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
        previewSeqs.delete(toolCallID)
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      /**
       * The processor's in-memory copy of one call's part is authoritative
       * between transitions (HS8). A writer outside these transitions raises
       * the session's process write version; reload the part until the read is
       * stable so a stale copy is never trusted.
       */
      const refreshToolCall = Effect.fnUntraced(function* (call: ToolCall) {
        let version = HistoryView.version(call.sessionID)
        if (version === call.version) return call.part
        for (let attempt = 0; ; attempt++) {
          const before = version
          const fresh = yield* session.getPart({
            partID: call.partID,
            messageID: call.messageID,
            sessionID: call.sessionID,
          })
          version = HistoryView.version(call.sessionID)
          if (!fresh || fresh.type !== "tool") return undefined
          if (version === before) {
            call.part = fresh
            call.version = version
            return fresh
          }
          // An unregistered write landed during the read: the copy may mix
          // revisions, so retry and stop caching if writes keep coming.
          if (attempt >= 2) return fresh
        }
      })

      const currentToolCall = Effect.fnUntraced(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        const part = yield* refreshToolCall(call)
        if (!part) {
          if (ctx.toolcalls[toolCallID] === call) delete ctx.toolcalls[toolCallID]
          return undefined
        }
        return { call, part }
      })

      /**
       * Cache a part this processor just persisted. `expected` is the version
       * the transition read at; if another commit interleaved, the cached copy
       * is no longer known to be current, so keep the version mark behind and
       * reload on the next transition.
       */
      const cacheWrittenPart = (call: ToolCall, part: SessionV1.ToolPart, expected: number) => {
        call.part = part
        const version = HistoryView.version(part.sessionID)
        if (version === expected) call.version = version
      }

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
      ) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        return yield* call.lock.withPermits(1)(
          Effect.gen(function* () {
            // A call claimed by abort/cleanup or replaced by a resume must not
            // be settled through this handle.
            if (ctx.toolcalls[toolCallID] !== call) return undefined
            const match = yield* currentToolCall(toolCallID)
            if (!match) return undefined
            const part = yield* session.updatePart(update(match.part))
            cacheWrittenPart(call, part, match.call.version + 1)
            return part
          }),
        )
      })

      const previewToolCall = Effect.fnUntraced(function* (
        toolCallID: string,
        preview: { tail: string; totalLength: number },
      ) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return
        const seq = (previewSeqs.get(toolCallID) ?? 0) + 1
        previewSeqs.set(toolCallID, seq)
        yield* events.publish(MessageV2.Event.PartPreview, {
          sessionID: call.sessionID,
          messageID: call.messageID,
          partID: call.partID,
          tail: preview.tail,
          totalLength: preview.totalLength,
          seq,
        })
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
        const call = ctx.toolcalls[toolCallID]
        if (!call) return
        yield* call.lock.withPermits(1)(
          Effect.gen(function* () {
            if (ctx.toolcalls[toolCallID] !== call) return
            const match = yield* currentToolCall(toolCallID)
            if (!match || match.part.state.status !== "running") return
            const part = yield* session.updatePart({
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
            cacheWrittenPart(call, part, match.call.version + 1)
            yield* settleToolCall(toolCallID)
          }),
        )
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return false
        return (
          (yield* call.lock.withPermits(1)(
            Effect.gen(function* () {
              if (ctx.toolcalls[toolCallID] !== call) return false
              const match = yield* currentToolCall(toolCallID)
              if (!match || match.part.state.status !== "running") return false
              const part = yield* session.updatePart({
                ...match.part,
                state: {
                  status: "error",
                  input: match.part.state.input,
                  error: errorMessage(error),
                  time: { start: match.part.state.time.start, end: Date.now() },
                },
              })
              cacheWrittenPart(call, part, match.call.version + 1)
              if (error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError) {
                ctx.blocked = ctx.shouldBreak
              }
              yield* settleToolCall(toolCallID)
              return true
            }),
          )) ?? false
        )
      })

      const finishReasoning = Effect.fn("SessionProcessor.finishReasoning")(function* (reasoningID: string) {
        if (!(reasoningID in ctx.attempt.reasoningMap)) return
        // oxlint-disable-next-line no-self-assign -- reactivity trigger
        ctx.attempt.reasoningMap[reasoningID].text = ctx.attempt.reasoningMap[reasoningID].text
        ctx.attempt.reasoningMap[reasoningID].time = { ...ctx.attempt.reasoningMap[reasoningID].time, end: Date.now() }
        const settled = yield* session.updatePart(ctx.attempt.reasoningMap[reasoningID])
        delete ctx.attempt.reasoningMap[reasoningID]
        if (!input.onReasoningSettled || ctx.assistantMessage.summary) return
        yield* input.onReasoningSettled(settled)
      })

      const ensureToolCall = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
        id: string
        name: string
        providerExecuted?: boolean
      }) {
        const existing = ctx.toolcalls[input.id]
        if (existing) {
          const result = yield* existing.lock.withPermits(1)(
            Effect.gen(function* () {
              if (ctx.toolcalls[input.id] !== existing) return undefined
              const match = yield* currentToolCall(input.id)
              if (!match) return undefined
              if (!input.providerExecuted || match.part.metadata?.providerExecuted) return match
              const part = yield* session.updatePart({
                ...match.part,
                metadata: { ...match.part.metadata, providerExecuted: true },
              })
              cacheWrittenPart(match.call, part, match.call.version + 1)
              return { call: match.call, part }
            }),
          )
          if (result) return result
          const latest = ctx.toolcalls[input.id]
          if (latest && latest !== existing) return { call: latest, part: latest.part }
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
        } satisfies SessionV1.ToolPart)
        const call: ToolCall = {
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
          inputEnded: false,
          raw: "",
          part,
          version: HistoryView.version(part.sessionID),
          lock: Semaphore.makeUnsafe(1),
        }
        ctx.toolcalls[input.id] = call
        return { call, part }
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
            ctx.attempt.reasoningActivity = true
            if (hasReasoningMetadata(value.providerMetadata)) ctx.attempt.opaqueReasoning = true
            if (value.id in ctx.attempt.reasoningMap) return
            // The provider restarts its stream-local ids for every request. A continuation reuses this assistant
            // message, so persisted identity must come from the globally unique part id instead.
            const partID = PartID.ascending()
            const part: SessionV1.ReasoningPart = {
              id: partID,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            ctx.attempt.reasoningMap[value.id] = part
            ctx.attempt.reasoningParts.add(partID)
            yield* session.updatePart(part)
            return
          }

          case "reasoning-delta":
            metricsFirstTokenAt ??= performance.now()
            ctx.attempt.reasoningActivity = true
            if (hasReasoningMetadata(value.providerMetadata)) ctx.attempt.opaqueReasoning = true
            ctx.attempt.reasoningLength += value.text.length
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            if (!(value.id in ctx.attempt.reasoningMap)) return
            ctx.attempt.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.attempt.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.attempt.reasoningMap[value.id].sessionID,
              messageID: ctx.attempt.reasoningMap[value.id].messageID,
              partID: ctx.attempt.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            ctx.attempt.reasoningActivity = true
            if (hasReasoningMetadata(value.providerMetadata)) ctx.attempt.opaqueReasoning = true
            if (value.providerMetadata && value.id in ctx.attempt.reasoningMap) {
              ctx.attempt.reasoningMap[value.id].metadata = value.providerMetadata
            }
            yield* finishReasoning(value.id)
            return

          case "tool-input-start":
            metricsFirstTokenAt ??= performance.now()
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            ctx.attempt.toolActivity = true
            ctx.stepToolActivity = true
            yield* ensureToolCall(value)
            return

          case "tool-input-delta":
            {
              ctx.attempt.toolActivity = true
              ctx.stepToolActivity = true
              const toolCall = yield* ensureToolCall(value)
              toolCall.call.raw += value.text
            }
            return

          case "tool-input-end": {
            ctx.attempt.toolActivity = true
            ctx.stepToolActivity = true
            const toolCall = yield* ensureToolCall(value)
            toolCall.call.inputEnded = true
            return
          }

          case "tool-call": {
            // A tool call admission signal was emitted: the execution pipeline
            // may already be running asynchronously, so a stream failure from
            // this point on must never be auto-retried. Record the call as
            // pending; it is only revoked below when the adapter reports the
            // SDK's input rejection (a call that was never executed).
            ctx.attempt.pendingToolExecutions.add(value.id)
            ctx.attempt.admittedToolCalls += 1
            ctx.attempt.toolActivity = true
            ctx.stepToolActivity = true
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            const input = isRecord(value.input) ? value.input : { value: value.input }
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

            // Only the last three call signatures matter. The in-memory list
            // mirrors the persisted tool parts without reading them back.
            const signature = { name: value.name, input: JSON.stringify(input) }
            ctx.recentToolSignatures.push(signature)
            if (ctx.recentToolSignatures.length > DOOM_LOOP_THRESHOLD) {
              ctx.recentToolSignatures.splice(0, ctx.recentToolSignatures.length - DOOM_LOOP_THRESHOLD)
            }
            if (
              ctx.recentToolSignatures.length !== DOOM_LOOP_THRESHOLD ||
              !ctx.recentToolSignatures.every((item) => item.name === signature.name && item.input === signature.input)
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
            ctx.attempt.anyToolCalled = true
            ctx.attempt.toolActivity = true
            ctx.stepToolActivity = true
            const hasToolCall = ctx.toolcalls[value.id] !== undefined
            if (!hasToolCall && value.result.type === "error") return
            if (value.result.type === "error") {
              yield* failToolCall(value.id, value.result.value)
              return
            }
            const rawOutput = toolResultOutput(value)
            const deferredCall = ctx.toolcalls[value.id]
            if (rawOutput.metadata.hookDeferred === true && deferredCall) {
              const settled = yield* deferredCall.lock.withPermits(1)(
                Effect.gen(function* () {
                  if (ctx.toolcalls[value.id] !== deferredCall) return false
                  const match = yield* currentToolCall(value.id)
                  if (!match) return false
                  const part = yield* session.updatePart({
                    ...match.part,
                    state: {
                      status: "pending",
                      input: match.part.state.input,
                      raw: JSON.stringify(match.part.state.input),
                      deferred: true,
                    },
                  })
                  cacheWrittenPart(deferredCall, part, match.call.version + 1)
                  yield* settleToolCall(value.id)
                  return true
                }),
              )
              if (settled) {
                deferred = true
                ctx.attempt.pendingToolExecutions.delete(value.id)
                return
              }
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
              ctx.attempt.pendingToolExecutions.delete(value.id)
            } else {
              ctx.attempt.anyToolCalled = true
            }
            // Rejected or not, a tool-error signal is tool activity in this
            // attempt; the #773 admission rules decide its retry separately.
            ctx.attempt.toolActivity = true
            ctx.stepToolActivity = true
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            // A PostToolUseFailure `continue:false` ends the agent turn once the error is recorded.
            if (hookToolStop(value.error)) ctx.blocked = true
            return
          }

          case "provider-error":
            yield* Effect.fail(value)
            return

          case "step-start":
            ctx.stepToolActivity = false
            metricsStepStartedAt = performance.now()
            metricsFirstTokenAt = undefined
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "step-finish": {
            // A step without tool signals cannot have changed files, so it
            // reuses its start snapshot and skips both the end track and the
            // patch. External changes and hooks stay with the next step, whose
            // start track records them.
            const completedSnapshot = ctx.stepToolActivity
              ? yield* snapshot.track()
              : (ctx.snapshot ?? (yield* snapshot.track()))
            yield* Effect.forEach(Object.keys(ctx.attempt.reasoningMap), (reasoningID) => finishReasoning(reasoningID))
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
            })
            ctx.assistantMessage.finish = value.reason
            ctx.attempt.finish = value.reason
            const suppressed =
              isRecord(value.providerMetadata) &&
              isRecord(value.providerMetadata[METADATA_NAMESPACE]) &&
              value.providerMetadata[METADATA_NAMESPACE].suppressedActivity === true
            if (suppressed && !ctx.attempt.suppressedActivity) ctx.attempt.retryBlockingSuppressedActivity = true
            ctx.attempt.suppressedActivity ||= suppressed
            // A synchronous continuation reuses this message for a second provider request. Accumulate both
            // requests so the persisted message reports the full cost and usage of the visible turn.
            accumulateUsage(ctx.assistantMessage, usage)
            // HS14 (#1028 PR1): one record per completed provider response.
            // The counter span runs from the previous step-finish (or process
            // entry) so settle writes and tool work between steps stay
            // attributed to the step that caused them.
            const fingerprint = metricsFingerprint
            if (fingerprint) {
              const current = counters()
              const now = performance.now()
              metricsStep += 1
              yield* recordStep({
                sessionID: ctx.sessionID,
                step: metricsStep,
                prepareMs: metricsStepStartedAt - metricsProcessStartedAt,
                requestMs: now - metricsStepStartedAt,
                ttftMs: metricsFirstTokenAt === undefined ? 0 : metricsFirstTokenAt - metricsStepStartedAt,
                cacheRead: usage.tokens.cache.read,
                cacheWrite: usage.tokens.cache.write,
                input: usage.tokens.input,
                sqlCount: current.sqlCount - metricsCounterBase.sqlCount,
                commits: current.commits - metricsCounterBase.commits,
                gitSpawns: current.gitSpawns - metricsCounterBase.gitSpawns,
                fingerprint,
              })
              metricsCounterBase = current
            }
            // One settle batch: the step-finish part, the assistant message and
            // the optional patch part commit as a single durable transaction.
            const settled: SessionV1.Part[] = [
              {
                id: PartID.ascending(),
                reason: value.reason,
                snapshot: completedSnapshot,
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "step-finish",
                tokens: usage.tokens,
                cost: usage.cost,
              },
            ]
            if (ctx.snapshot && ctx.stepToolActivity) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                settled.push({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
            }
            yield* session.settle({ messages: [ctx.assistantMessage], parts: settled })
            ctx.snapshot = undefined
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            ctx.attempt.openText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              ...(input.onTextDisplay ? { displayText: "" } : {}),
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            ctx.attempt.openTextID = value.id
            if (input.onTextDisplay) displayParts.push(ctx.attempt.openText)
            yield* session.updatePart(ctx.attempt.openText)
            return

          case "text-delta":
            metricsFirstTokenAt ??= performance.now()
            ctx.attempt.textLength += value.text.length
            if (!ctx.attempt.openText) return
            ctx.attempt.openText.text += value.text
            if (input.onTextDisplay) {
              displayPending += value.text
              if (value.text.length > 0) displaySegments.push({ part: ctx.attempt.openText, length: value.text.length })
            }
            if (value.providerMetadata) ctx.attempt.openText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.attempt.openText.sessionID,
              messageID: ctx.attempt.openText.messageID,
              partID: ctx.attempt.openText.id,
              field: "text",
              delta: value.text,
            })
            yield* display(false)
            return

          case "text-end":
            if (!ctx.attempt.openText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.attempt.openText.text = ctx.attempt.openText.text
            {
              const end = Date.now()
              ctx.attempt.openText.time = { start: ctx.attempt.openText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.attempt.openText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.attempt.openText)
            ctx.attempt.openText = undefined
            ctx.attempt.openTextID = undefined
            return

          case "finish":
            if (ctx.attempt.finish === undefined || ctx.attempt.finish === "unknown") ctx.attempt.finish = value.reason
            if (
              isRecord(value.providerMetadata) &&
              isRecord(value.providerMetadata[METADATA_NAMESPACE]) &&
              value.providerMetadata[METADATA_NAMESPACE].suppressedActivity === true
            ) {
              if (!ctx.attempt.suppressedActivity) ctx.attempt.retryBlockingSuppressedActivity = true
              ctx.attempt.suppressedActivity = true
            }
            return
        }
      })

      // Force-abort one leftover tool call. The claim-before-abort pattern
      // (delete under the call lock, then re-read the part) prevents a
      // concurrent completeToolCall or failToolCall from settling it while the
      // forced error is persisted.
      const forceAbortToolCall = Effect.fn("SessionProcessor.forceAbortToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return
        yield* call.lock.withPermits(1)(
          Effect.gen(function* () {
            if (ctx.toolcalls[toolCallID] !== call) return
            delete ctx.toolcalls[toolCallID]
            const part = yield* refreshToolCall(call)
            // The tool may have settled between the grace period and this
            // read; never overwrite a completed/errored part with a forced
            // abort.
            if (!part || (part.state.status !== "running" && part.state.status !== "pending")) return
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
          }),
        )
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

      // Failed opaque reasoning must not enter a later model request. Remove its
      // persisted parts, including ones that had already ended.
      const discardFailedReasoning = Effect.fn("SessionProcessor.discardFailedReasoning")(function* () {
        for (const partID of ctx.attempt.reasoningParts) {
          yield* session.removePart({ sessionID: ctx.sessionID, messageID: ctx.assistantMessage.id, partID })
        }
        ctx.attempt.reasoningParts.clear()
        ctx.attempt.reasoningMap = {}
      })

      // A retry retains the assistant message but must close partial parts and
      // discard unexecuted tool placeholders before the next attempt starts.
      const settleRetryAttempt = Effect.fn("SessionProcessor.settleRetryAttempt")(function* () {
        if (ctx.attempt.openText) {
          const end = Date.now()
          ctx.attempt.openText.time = { start: ctx.attempt.openText.time?.start ?? end, end }
          yield* session.updatePart(ctx.attempt.openText)
          ctx.attempt.openText = undefined
          ctx.attempt.openTextID = undefined
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

        if (ctx.attempt.openText) {
          const end = Date.now()
          ctx.attempt.openText.time = { start: ctx.attempt.openText.time?.start ?? end, end }
          yield* session.updatePart(ctx.attempt.openText)
          ctx.attempt.openText = undefined
          ctx.attempt.openTextID = undefined
        }

        for (const part of Object.values(ctx.attempt.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.attempt.reasoningMap = {}

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
        let error = IncompleteResponseError.isInstance(e)
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
        // The safety gate overrides only retryability and records why. The
        // provider status, message, headers, and body stay untouched.
        if (ctx.attempt.retryBlockedBy && SessionV1.APIError.isInstance(error)) {
          error = new SessionV1.APIError({
            ...error.data,
            isRetryable: false,
            metadata: { ...error.data.metadata, retryBlockedBy: ctx.attempt.retryBlockedBy },
          }).toObject()
        }
        if (
          !aborted &&
          !ctx.attempt.toolActivity &&
          !ctx.attempt.anyToolCalled &&
          (EmptyResponseError.isInstance(e) ||
            IncompleteReasoningResponseError.isInstance(e) ||
            SessionRetry.retryable(error, input.model.providerID) !== undefined)
        )
          yield* discardFailedReasoning()
        if (SessionRetry.isCompactionFailure(error)) {
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
        ctx.assistantMessage.error = error
        yield* events.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        yield* Effect.logInfo("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
        })
        metricsProcessStartedAt = performance.now()
        metricsStepStartedAt = metricsProcessStartedAt
        metricsFirstTokenAt = undefined
        metricsCounterBase = counters()
        metricsFingerprint = fingerprintOf({
          tools: serializedTools(streamInput.tools),
          system: streamInput.system,
          messages: streamInput.messages,
          toolChoice: streamInput.toolChoice,
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
            // Detection state is per attempt: a retried attempt must not
            // inherit the previous attempt's admissions, and its finish reason
            // is tracked separately so the persisted assistant.finish (last
            // attempt to report one) is not involved in the decision.
            beginAttempt(ctx)
            yield* status.set(ctx.sessionID, { type: "busy" })
            const generation = ++attemptGeneration
            const source = llm.stream({
              ...streamInput,
              sessionRetry: true,
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
                if (activity === "tool-executed") ctx.attempt.anyToolCalled = true
                else {
                  ctx.attempt.suppressedActivity = true
                  if (activity !== "observational") ctx.attempt.retryBlockingSuppressedActivity = true
                }
                streamInput.onAttemptActivity?.(activity)
              },
              // A refused final-step tool call is still real activity: it must
              // close the incomplete-response and retry gates exactly like a
              // tool that executed.
              onToolRefused: () => {
                if (generation !== attemptGeneration) return
                ctx.attempt.anyToolCalled = true
                streamInput.onToolRefused?.()
              },
            })
            const stream = streamInput.purpose === "compaction" ? watchCompactionStream(source) : source

            yield* stream.pipe(
              Stream.tap((event) => handleEvent(event)),
              Stream.takeUntil(() => ctx.needsCompaction),
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
              !ctx.blocked &&
              !ctx.assistantMessage.error &&
              !ctx.attempt.anyToolCalled &&
              ctx.attempt.pendingToolExecutions.size === 0 &&
              (ctx.attempt.finish === "unknown" || ctx.attempt.finish === undefined) &&
              (unfinishedToolInput || ctx.attempt.admittedToolCalls > 0)
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
              !ctx.blocked &&
              !ctx.assistantMessage.error &&
              !ctx.attempt.toolActivity &&
              !ctx.attempt.suppressedActivity &&
              ctx.attempt.textLength === 0 &&
              ctx.attempt.reasoningLength === 0 &&
              !ctx.attempt.opaqueReasoning &&
              (ctx.attempt.finish === undefined || ctx.attempt.finish === "unknown" || ctx.attempt.finish === "stop")
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
              !ctx.blocked &&
              !ctx.assistantMessage.error &&
              !ctx.attempt.toolActivity &&
              !ctx.attempt.suppressedActivity &&
              ctx.attempt.textLength === 0 &&
              ctx.attempt.reasoningActivity &&
              (ctx.attempt.finish === undefined || ctx.attempt.finish === "unknown")
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
                // A rate-limited lane pauses new requests to this provider/model
                // until the backoff elapses (#1021), so queued work does not
                // burn capacity on requests the provider will reject anyway.
                onRateLimit: ({ retryAfterMs }) =>
                  scheduler.penalize(input.model.providerID, input.model.id, retryAfterMs),
                shouldRetry: () =>
                  !aborted &&
                  !ctx.blocked &&
                  !ctx.needsCompaction &&
                  !ctx.attempt.anyToolCalled &&
                  ctx.attempt.pendingToolExecutions.size === 0 &&
                  !ctx.attempt.retryBlockingSuppressedActivity,
                onGated: () => {
                  if (ctx.attempt.pendingToolExecutions.size > 0) ctx.attempt.retryBlockedBy = "pending-tools"
                  else if (ctx.attempt.anyToolCalled) ctx.attempt.retryBlockedBy = "tool-executed"
                },
                gates: () => ({
                  aborted,
                  blocked: ctx.blocked,
                  needsCompaction: ctx.needsCompaction,
                  anyToolCalled: ctx.attempt.anyToolCalled,
                  pendingToolExecutions: ctx.attempt.pendingToolExecutions.size,
                  suppressedActivity: ctx.attempt.retryBlockingSuppressedActivity,
                }),
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
                set: (info) =>
                  settleRetryAttempt().pipe(
                    Effect.andThen(
                      status.set(ctx.sessionID, {
                        type: "retry",
                        attempt: info.attempt,
                        message: info.message,
                        action: info.action,
                        next: info.next,
                      }),
                    ),
                  ),
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
          if (timedOut) return "timeout"
          if (deferred) return "deferred"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      const resumeToolCall: Handle["resumeToolCall"] = Effect.fn("SessionProcessor.resumeToolCall")(
        function* (part, execute) {
          const call: ToolCall = {
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
            done: yield* Deferred.make<void>(),
            inputEnded: true,
            raw: JSON.stringify(part.state.input),
            part,
            version: HistoryView.version(part.sessionID),
            lock: Semaphore.makeUnsafe(1),
          }
          ctx.toolcalls[part.callID] = call
          yield* call.lock.withPermits(1)(
            Effect.gen(function* () {
              const match = yield* currentToolCall(part.callID)
              if (!match) return
              const updated = yield* session.updatePart({
                ...match.part,
                state: { status: "running", input: match.part.state.input, time: { start: Date.now() } },
              })
              cacheWrittenPart(call, updated, match.call.version + 1)
            }),
          )
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
        previewToolCall,
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
    Layer.provide(AgentScheduler.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
  ),
)

export const node = LayerNode.make(layer, [
  Session.node,
  Config.node,
  Snapshot.node,
  Agent.node,
  LLM.node,
  AgentScheduler.node,
  Permission.node,
  SessionStatus.node,
  Image.node,
  EventV2Bridge.node,
])

export * as SessionProcessor from "./processor"
