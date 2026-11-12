// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { PermissionV1 } from "@graphagent/core/v1/permission"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Deferred, Effect, Semaphore } from "effect"
import type { Context } from "effect"
import type { EventV2Bridge } from "@/event-v2-bridge"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { HistoryView } from "./history/view"
import { MessageV2 } from "./message-v2"
import { PartID } from "./schema"
import type { Session } from "./session"

export type ToolCall = {
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

/** The slice of the processor context that tool-call transitions read and write. */
export interface ToolCallScope {
  readonly assistantMessage: SessionV1.Assistant
  toolcalls: Record<string, ToolCall>
  blocked: boolean
  shouldBreak: boolean
}

export interface ToolCallDeps {
  readonly session: Session.Interface
  readonly events: Context.Service.Shape<typeof EventV2Bridge.Service>
  readonly ctx: ToolCallScope
}

/**
 * Tool-call state machine of the session processor (Issue #1019, PR-b). Moved
 * verbatim out of `processor.ts`: every transition of one call's part
 * (pending, running, completed, error, aborted) runs under that call's lock and
 * keeps the processor's in-memory copy of the part in step with the store.
 */
export function makeToolCalls(deps: ToolCallDeps) {
  const { session, events, ctx } = deps

  // Per-call preview sequence; the TUI applies previews latest-wins within
  // a frame, and the sequence lets it discard an older frame.
  const previewSeqs = new Map<string, number>()

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

  return {
    settleToolCall,
    currentToolCall,
    cacheWrittenPart,
    updateToolCall,
    previewToolCall,
    completeToolCall,
    failToolCall,
    ensureToolCall,
    forceAbortToolCall,
    severUnexecutedToolCalls,
  }
}
