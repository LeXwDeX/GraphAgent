// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { LLMEvent } from "@graphagent/llm"
import type { Types } from "effect"
import * as Stream from "effect/Stream"

/**
 * Splits `<tag>…</tag>` out of the text blocks of an `LLMEvent` stream and emits it as reasoning blocks, for a model
 * that writes its reasoning into the answer text. The AI SDK path does the same with `extractReasoningMiddleware`
 * (`wrapInlineReasoning` in `provider/inline-reasoning.ts`); the native runtime has no such wrapper, so the stream is
 * rewritten here, and both paths read the same reasoning and the same answer out of the same text:
 *
 * - Text between the tags is reasoning, the rest stays text. A tag cut between two deltas is held back until it can be
 *   told from other text. A tag that is opened and never closed keeps the rest of its block as reasoning.
 * - After a tag, the first piece of a kind that already had a piece starts with a newline, the `separator` of
 *   `extractReasoningMiddleware`.
 * - The `text-start` of a block waits for its first text, so reasoning that comes before the answer is delivered
 *   before the block of the answer.
 *
 * It differs from the middleware in three places: a start of a tag that the text ends in (`<th` with nothing after it)
 * is delivered as text at the end of the block instead of being dropped, an empty tag pair makes no reasoning block, and
 * the reasoning block that a missing closing tag leaves open ends with the text block (or with the stream).
 *
 * The functions are pure: `step` returns the next state and the events to emit, and never changes the state it gets.
 */

const SEPARATOR = "\n"

type TextStart = Extract<LLMEvent, { type: "text-start" }>

/** One text block while it is split. */
export interface Block {
  /** Text held back because it may be the start of the next tag. */
  readonly buffer: string
  /** Between the tags: what arrives is reasoning. */
  readonly inside: boolean
  /** A tag was just taken, so the next piece of a kind that already had one starts with the separator. */
  readonly afterTag: boolean
  readonly hadText: boolean
  readonly hadReasoning: boolean
  /** Candidate ids tried for the reasoning blocks of this text block so far. */
  readonly opened: number
  /** The reasoning block that is started and not yet ended. */
  readonly open: string | undefined
  /** The `text-start` that is not delivered yet. */
  readonly held: TextStart | undefined
}

export interface State {
  /** The blocks that are started and not ended, by the id of their text block. */
  readonly blocks: ReadonlyMap<string, Block>
  /** Ids of the reasoning blocks of the stream so far, the endpoint's own and the ones made here. */
  readonly ids: ReadonlySet<string>
}

/** The working copy of a block and the stream state around it while one event is handled. */
interface Work {
  readonly textID: string
  readonly opening: string
  readonly closing: string
  readonly block: Types.Mutable<Block>
  readonly out: LLMEvent[]
  ids: ReadonlySet<string>
}

const FRESH: Block = {
  buffer: "",
  inside: false,
  afterTag: false,
  hadText: false,
  hadReasoning: false,
  opened: 0,
  open: undefined,
  held: undefined,
}

export const initial = (): State => ({ blocks: new Map(), ids: new Set() })

/**
 * Where `searched` starts in `text`, or where `text` ends in the start of it; undefined when neither. The search is the
 * one of `extractReasoningMiddleware`, limited to the suffixes that are shorter than `searched` (a longer one cannot be
 * the start of it, and an equal one was found by `indexOf`).
 */
function potentialStart(text: string, searched: string): number | undefined {
  const direct = text.indexOf(searched)
  if (direct !== -1) return direct
  for (let index = text.length - 1; index >= 0 && index > text.length - searched.length; index--) {
    if (searched.startsWith(text.slice(index))) return index
  }
  return undefined
}

function begin(tag: string, state: State, textID: string, block: Block = state.blocks.get(textID) ?? FRESH): Work {
  return { textID, opening: `<${tag}>`, closing: `</${tag}>`, block: { ...block }, out: [], ids: state.ids }
}

/** Starts a reasoning block under an id the stream has not used. */
function openReasoning(work: Work): string {
  const candidate = () => `${work.textID}:inline-${work.block.opened++}`
  let id = candidate()
  while (work.ids.has(id)) id = candidate()
  work.ids = new Set(work.ids).add(id)
  work.out.push(LLMEvent.reasoningStart({ id }))
  return id
}

function closeReasoning(work: Work) {
  if (work.block.open === undefined) return
  work.out.push(LLMEvent.reasoningEnd({ id: work.block.open }))
  work.block.open = undefined
}

/** Delivers `text` as reasoning or as answer, the way the block currently is. */
function publish(work: Work, text: string) {
  if (text.length === 0) return
  const { block } = work
  const separator = block.afterTag && (block.inside ? block.hadReasoning : block.hadText) ? SEPARATOR : ""
  if (block.inside) {
    block.open ??= openReasoning(work)
    work.out.push(LLMEvent.reasoningDelta({ id: block.open, text: separator + text }))
    block.hadReasoning = true
  } else {
    if (block.held) work.out.push(block.held)
    block.held = undefined
    work.out.push(LLMEvent.textDelta({ id: work.textID, text: separator + text }))
    block.hadText = true
  }
  block.afterTag = false
}

/** Takes one delta: delivers what is clear, takes the tags it holds, and keeps a start of a tag back. */
function feed(work: Work, text: string) {
  const { block } = work
  block.buffer += text
  for (;;) {
    const tag = block.inside ? work.closing : work.opening
    const at = potentialStart(block.buffer, tag)
    if (at === undefined) {
      publish(work, block.buffer)
      block.buffer = ""
      return
    }
    publish(work, block.buffer.slice(0, at))
    if (at + tag.length > block.buffer.length) {
      block.buffer = block.buffer.slice(at)
      return
    }
    block.buffer = block.buffer.slice(at + tag.length)
    if (block.inside) closeReasoning(work)
    block.inside = !block.inside
    block.afterTag = true
  }
}

/** Delivers what is held back and ends the reasoning block that is still open. */
function drain(work: Work) {
  publish(work, work.block.buffer)
  work.block.buffer = ""
  closeReasoning(work)
}

function settled(state: State, work: Work): readonly [State, ReadonlyArray<LLMEvent>] {
  return [{ blocks: new Map(state.blocks).set(work.textID, work.block), ids: work.ids }, work.out]
}

/** Handles one event. Events other than the three of a text block, and `reasoning-start` for its id, go on as they are. */
export function step(tag: string, state: State, event: LLMEvent): readonly [State, ReadonlyArray<LLMEvent>] {
  switch (event.type) {
    case "reasoning-start":
      return [{ ...state, ids: new Set(state.ids).add(event.id) }, [event]]
    case "text-start":
      return settled(state, begin(tag, state, event.id, { ...FRESH, held: event }))
    case "text-delta": {
      const work = begin(tag, state, event.id)
      feed(work, event.text)
      return settled(state, work)
    }
    case "text-end": {
      if (!state.blocks.has(event.id)) return [state, [event]]
      const work = begin(tag, state, event.id)
      drain(work)
      if (work.block.held) work.out.push(work.block.held)
      work.out.push(event)
      const blocks = new Map(state.blocks)
      blocks.delete(event.id)
      return [{ blocks, ids: work.ids }, work.out]
    }
    default:
      return [state, [event]]
  }
}

/** What the blocks still open at the end of the stream deliver: their held text, and the end of their reasoning. */
export function halt(tag: string, state: State): ReadonlyArray<LLMEvent> {
  return Array.from(state.blocks.keys()).flatMap((id) => {
    const work = begin(tag, state, id)
    drain(work)
    return work.out
  })
}

/** The stream operator: splits `<tag>…</tag>` out of the text of a stream. `tag` is not empty. */
export function split(tag: string): <E, R>(self: Stream.Stream<LLMEvent, E, R>) => Stream.Stream<LLMEvent, E, R> {
  return Stream.mapAccum(initial, (state: State, event: LLMEvent) => step(tag, state, event), {
    onHalt: (state: State) => halt(tag, state),
  })
}

export * as LLMInlineReasoning from "./inline-reasoning"
