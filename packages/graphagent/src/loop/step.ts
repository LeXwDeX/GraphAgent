// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * One model request of the analysis conversation (#1328), kept in memory.
 *
 * `llm.stream` answers one request. The analysis runs several, so the driver folds each response into a
 * `Collected` and turns it back into the messages the next request carries: the assistant turn (reasoning,
 * text, tool calls, with the provider metadata that signed or identifies them, exactly as the session would
 * persist and replay it) and the tool results. Nothing here touches the session.
 */
import type { AssistantContent, ModelMessage, ToolContent } from "ai"
import type { LLMEvent, ProviderMetadata } from "@graphagent/llm"

type Block =
  | { kind: "reasoning" | "text"; id: string; text: string; metadata: ProviderMetadata | undefined }
  | { kind: "tool"; id: string; name: string; input: unknown; metadata: ProviderMetadata | undefined }

export interface Tokens {
  input: number
  output: number
  reasoning: number
}

/** What one response contained. */
export interface Collected {
  readonly blocks: Block[]
  /** Tool failures the stream reported by call id: input the SDK rejected, or a tool that threw. */
  readonly failures: Map<string, string>
  usage: Tokens | undefined
  finish: string | undefined
}

export function collected(): Collected {
  return { blocks: [], failures: new Map(), usage: undefined, finish: undefined }
}

function open(state: Collected, kind: "reasoning" | "text", id: string, metadata: ProviderMetadata | undefined) {
  if (state.blocks.some((block) => block.kind === kind && block.id === id)) return
  state.blocks.push({ kind, id, text: "", metadata })
}

function append(
  state: Collected,
  kind: "reasoning" | "text",
  id: string,
  text: string,
  metadata: ProviderMetadata | undefined,
) {
  open(state, kind, id, undefined)
  const block = state.blocks.find((item) => item.kind === kind && item.id === id)
  if (block?.kind !== kind) return
  block.text += text
  // The session keeps the latest metadata an event carries; a signature arrives late.
  if (metadata) block.metadata = metadata
}

function tokens(usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | undefined) {
  if (!usage) return undefined
  return { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0, reasoning: usage.reasoningTokens ?? 0 }
}

/** Folds one stream event in. Returns a failure the retry policy should see, as the processor does. */
export function add(state: Collected, event: LLMEvent): unknown {
  switch (event.type) {
    case "reasoning-start":
    case "text-start":
      open(state, event.type === "text-start" ? "text" : "reasoning", event.id, event.providerMetadata)
      return undefined
    case "reasoning-delta":
    case "text-delta":
      append(state, event.type === "text-delta" ? "text" : "reasoning", event.id, event.text, event.providerMetadata)
      return undefined
    case "reasoning-end":
    case "text-end": {
      const kind = event.type === "text-end" ? "text" : "reasoning"
      const block = state.blocks.find((item) => item.kind === kind && item.id === event.id)
      if (block && event.providerMetadata) block.metadata = event.providerMetadata
      return undefined
    }
    case "tool-call":
      // Provider-hosted tools run on the provider's side and have no result for us to replay.
      if (!event.providerExecuted)
        state.blocks.push({
          kind: "tool",
          id: event.id,
          name: event.name,
          input: event.input,
          metadata: event.providerMetadata,
        })
      return undefined
    case "tool-error":
      state.failures.set(event.id, event.message)
      return undefined
    case "tool-result":
      if (event.result.type === "error") state.failures.set(event.id, String(event.result.value))
      return undefined
    case "step-finish":
      state.usage ??= tokens(event.usage)
      return undefined
    case "finish":
      state.usage = tokens(event.usage) ?? state.usage
      state.finish = event.reason
      return undefined
    case "provider-error":
      return event
    default:
      return undefined
  }
}

export interface Call {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

export function calls(state: Collected): Call[] {
  return state.blocks.flatMap((block) =>
    block.kind === "tool" ? [{ id: block.id, name: block.name, input: block.input }] : [],
  )
}

// The event's provider metadata is what the SDK calls provider options on the next request: signatures and
// ids it attached to the blocks come back exactly as received.
function options(metadata: ProviderMetadata | undefined): { providerOptions?: Record<string, any> } {
  return metadata ? { providerOptions: metadata } : {}
}

/**
 * The assistant turn as the next request replays it. Undefined when the response said nothing a request can
 * carry: a turn of reasoning alone is not replayed, since providers reject an assistant message without text
 * or a tool call.
 */
export function assistant(state: Collected): ModelMessage | undefined {
  if (!state.blocks.some((block) => block.kind === "tool" || (block.kind === "text" && block.text !== "")))
    return undefined
  const content: Exclude<AssistantContent, string> = []
  for (const block of state.blocks) {
    if (block.kind === "tool") {
      content.push({
        type: "tool-call",
        toolCallId: block.id,
        toolName: block.name,
        input: block.input,
        ...options(block.metadata),
      })
    } else if (block.kind === "reasoning") {
      content.push({ type: "reasoning", text: block.text, ...options(block.metadata) })
    } else if (block.text !== "") {
      content.push({ type: "text", text: block.text, ...options(block.metadata) })
    }
  }
  return { role: "assistant", content }
}

/** The tool results of the response's calls, in call order. Undefined when there were no calls. */
export function results(state: Collected, outputs: ReadonlyMap<string, string>): ModelMessage | undefined {
  const content: ToolContent = []
  for (const call of calls(state)) {
    const output = outputs.get(call.id)
    const failure = state.failures.get(call.id)
    content.push({
      type: "tool-result",
      toolCallId: call.id,
      toolName: call.name,
      output:
        output !== undefined
          ? { type: "text", value: output }
          : { type: "error-text", value: failure ?? "The tool did not run: no result was recorded." },
    })
  }
  return content.length === 0 ? undefined : { role: "tool", content }
}

export * as LoopStep from "./step"
