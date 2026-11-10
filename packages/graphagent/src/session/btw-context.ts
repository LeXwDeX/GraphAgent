// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { ConfigV1 } from "@graphagent/core/v1/config/config"
import type { ModelMessage } from "ai"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Effect } from "effect"

import type { Provider } from "@/provider/provider"
import { Token } from "@/util/token"
import { MessageV2 } from "./message-v2"
import { usable } from "./overflow"
import type { Session } from "./session"

/** Keeps attachments and oversized tool output out of an auxiliary request, same as compaction. */
export const TOOL_OUTPUT_MAX_CHARS = 2_000
/** Headroom for the system prompt, language block, environment block, and the question itself. */
export const SYSTEM_RESERVE_TOKENS = 1_500
export const DEFAULT_MAX_CONTEXT_TOKENS = 48_000
export const IN_FLIGHT_HINT = "(The agent is still working; its latest step is not included above.)"

export interface SelectInput {
  readonly history: SessionV1.WithParts[]
  readonly revert?: Session.Info["revert"]
  readonly model: Provider.Model
  readonly cfg: ConfigV1.Info
  readonly question: string
  readonly reasoningDistillationEnabled: boolean
  /** Test override for the computed token budget. */
  readonly budget?: number
  readonly maxContextTokens?: number
}

export interface SelectedContext {
  readonly messages: ModelMessage[]
  readonly estimatedTokens: number
  readonly truncated: boolean
  readonly inFlightDropped: boolean
}

const isCompactionMarker = (msg: SessionV1.WithParts) =>
  msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction")

/**
 * Applies a stashed revert without writing anything: the boundary message is
 * kept only when the revert names a part inside it, and everything after the
 * boundary is hidden. Mirrors the cleanup rules in `SessionRevert`.
 */
function applyRevert(history: SessionV1.WithParts[], revert: Session.Info["revert"] | undefined) {
  if (!revert) return history
  const boundary = history.find((msg) => msg.info.id === revert.messageID)
  if (!boundary) return history
  const result: SessionV1.WithParts[] = []
  for (const msg of history) {
    if (MessageV2.before(msg.info, boundary.info)) {
      result.push(msg)
      continue
    }
    if (msg.info.id !== boundary.info.id) continue
    if (!revert.partID) continue
    const index = msg.parts.findIndex((part) => part.id === revert.partID)
    if (index < 0) {
      result.push(msg)
      continue
    }
    result.push({ ...msg, parts: msg.parts.slice(0, index) })
  }
  return result
}

/** The converted prefix of a completed compaction (marker + summary) is never dropped by the budget. */
function protectedPrefix(history: SessionV1.WithParts[]) {
  const marker = history.findIndex(isCompactionMarker)
  if (marker < 0) return 0
  const summary = history.findIndex(
    (msg, index) =>
      index > marker &&
      msg.info.role === "assistant" &&
      msg.info.summary &&
      msg.info.parentID === history[marker].info.id,
  )
  return summary < 0 ? 0 : summary + 1
}

/** Disjoint `[start, end)` ranges that can be dropped without splitting a tool call/result pair. */
function droppableRanges(history: SessionV1.WithParts[], prefix: number) {
  const turns: number[] = []
  for (let index = prefix; index < history.length; index++) {
    const msg = history[index]
    if (msg.info.role === "user" && !isCompactionMarker(msg)) turns.push(index)
  }
  if (turns.length <= 1) return []
  const ranges: Array<readonly [number, number]> = []
  if (prefix > 0 && turns[0] > prefix) ranges.push([prefix, turns[0]])
  for (let index = 0; index < turns.length - 1; index++) ranges.push([turns[index], turns[index + 1]])
  return ranges
}

function trimLeading(history: SessionV1.WithParts[], prefix: number) {
  if (prefix > 0) return history
  const firstUser = history.findIndex((msg) => msg.info.role === "user")
  return firstUser <= 0 ? history : history.slice(firstUser)
}

const convertOptions = (reasoningDistillationEnabled: boolean) => ({
  stripMedia: true,
  toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
  stripOpaqueReasoning: true,
  reasoningDistillationEnabled,
})

function appendQuestion(messages: ModelMessage[], question: string): ModelMessage[] {
  const last = messages.at(-1)
  if (last?.role === "user") {
    if (typeof last.content === "string") {
      return [...messages.slice(0, -1), { ...last, content: `${last.content}\n\n${question}` }]
    }
    return [...messages.slice(0, -1), { ...last, content: [...last.content, { type: "text", text: question }] }]
  }
  return [...messages, { role: "user", content: question }]
}

/**
 * Builds the read-only model context for a side question.
 *
 * Drops unfinished assistant turns, applies a stashed revert, converts with the
 * compaction conversion options, then removes the oldest whole turns until the
 * reserve estimate fits the budget. The completed compaction summary and the
 * newest turn always survive. Nothing here reads or writes beyond the provided
 * history.
 */
export const selectBtwContext = Effect.fn("SessionBtw.selectContext")(function* (input: SelectInput) {
  const reverted = applyRevert(input.history, input.revert)
  const inFlightDropped = reverted.some((msg) => msg.info.role === "assistant" && msg.info.time.completed === undefined)
  const history = reverted.filter((msg) => !(msg.info.role === "assistant" && msg.info.time.completed === undefined))

  const prefix = protectedPrefix(history)
  const trimmed = trimLeading(history, prefix)
  const ranges = droppableRanges(trimmed, prefix)

  const contextLimit = input.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
  const contextWindow = usable({ cfg: input.cfg, model: input.model })
  const budget =
    input.budget ??
    (contextWindow <= 0 ? contextLimit : Math.max(0, Math.min(contextWindow - SYSTEM_RESERVE_TOKENS, contextLimit)))

  const convert = (messages: SessionV1.WithParts[]) =>
    MessageV2.toModelMessagesEffect(messages, input.model, convertOptions(input.reasoningDistillationEnabled))

  let retained = trimmed
  let converted = yield* convert(retained)
  const removed = new Set<number>()
  let dropped = 0
  while (Token.estimateReserve(JSON.stringify(converted)) > budget && dropped < ranges.length) {
    const [start, end] = ranges[dropped]
    for (let index = start; index < end; index++) removed.add(index)
    retained = trimmed.filter((_, index) => !removed.has(index))
    dropped++
    converted = yield* convert(retained)
  }

  const suffix = inFlightDropped ? `${input.question}\n\n${IN_FLIGHT_HINT}` : input.question
  const messages = appendQuestion(converted, suffix)

  return {
    messages,
    estimatedTokens: Token.estimateReserve(JSON.stringify(converted)),
    truncated: dropped > 0,
    inFlightDropped,
  } satisfies SelectedContext
})

export * as SessionBtwContext from "./btw-context"
