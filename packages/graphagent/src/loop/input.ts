// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Input assembly for the loop's background analysis (#1328).
 *
 * The analysis model gets one instruction. Sections 1-5 are the anchor: the user's first description,
 * the frozen first analysis, the current state, what the agent declared this round, and the human
 * messages that may justify an intent change. They are never trimmed. Section 6 is the conversation
 * history as the main agent sees it, rendered as a transcript; it is the only part that is cut to fit,
 * oldest message first, and the compaction summary is never cut.
 */
import type { LoopIntent, LoopProgress, LoopVerdict } from "@graphagent/schema/loop"
import { SessionV1 } from "@graphagent/core/v1/session"
import { MessageV2 } from "@/session/message-v2"
import type { TurnOutcome } from "@/session/turn/decide"
import { Token } from "@/util/token"

/** A human message of the basis window, as the caller read it. `text` is shown to the model verbatim. */
export interface Human {
  readonly id: string
  readonly text: string
}

/** The verdict and reason of an earlier analysis. */
export interface Recent {
  readonly verdict: LoopVerdict
  readonly reason: string
}

/** What the agent declared at the end of the round (the `loop` tool's `done`, `blocked`, `await`). */
export interface Declaration {
  readonly kind: "done" | "blocked" | "await"
  /** The evidence for done, the reason for blocked, the thing waited for (or its result) for await. */
  readonly text: string
}

/** The state after the first successful analysis. Absent before it. */
export interface Prior {
  /** The frozen first analysis. */
  readonly firstAnalysis: LoopIntent
  /** The latest committed intent, the version V2 and V3 compare against. */
  readonly intent: LoopIntent
  readonly progress: LoopProgress
  /** The prompt sent for the round that just ended. */
  readonly prompt?: string
  /** Earlier analyses, oldest first. Only the last `RECENT_LIMIT` are shown. */
  readonly recent: ReadonlyArray<Recent>
}

export interface Anchor {
  /** The user's own words that started the loop. */
  readonly firstDescription: string
  readonly prior?: Prior
  readonly declaration?: Declaration
  readonly outcome: TurnOutcome
  /** Human messages after the last committed analysis, oldest first. */
  readonly humans: ReadonlyArray<Human>
}

export const RECENT_LIMIT = 5
/** Tool inputs and outputs in the transcript are shortened to these sizes, in characters. */
export const TOOL_INPUT_CHARS = 400
export const TOOL_OUTPUT_CHARS = 2_000
/** The share of the usable context window the history may take; the rest is for tool results. */
export const HISTORY_SHARE = 0.8
/** Stand-in for a model that does not report its context window. */
export const UNKNOWN_WINDOW_TOKENS = 48_000

const json = (value: unknown) => JSON.stringify(value, null, 2)

function block(tag: string, text: string, attributes = "") {
  return `<${tag}${attributes}>\n${text}\n</${tag}>`
}

function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max)} ...[truncated ${text.length - max} chars]`
}

export function outcomeText(outcome: TurnOutcome): string {
  switch (outcome.type) {
    case "error":
      return `error (code ${outcome.code}, ${outcome.retryable ? "retryable" : "not retryable"})`
    case "cancelled":
      return outcome.reason ? `cancelled (${outcome.reason})` : "cancelled"
    case "blocked":
      return `blocked (by ${outcome.by}, code ${outcome.code})`
    default:
      return outcome.type
  }
}

const DECLARATION_LEAD: Record<Declaration["kind"], string> = {
  done: "done. The agent says the goal is complete and gives this evidence (verify it, do not take it on trust):",
  blocked: "blocked. The agent says it cannot continue without the user:",
  await: "await. The agent waits for:",
}

function declarationText(declaration: Declaration | undefined) {
  return declaration ? `${DECLARATION_LEAD[declaration.kind]}\n${declaration.text}` : "none"
}

const FIRST_ANALYSIS_NOTE =
  "None. This is the FIRST analysis of this loop. Derive the intent only from the first description, " +
  "the conversation before the loop started, the human messages in section 5 and facts you verify in the " +
  "repository. Everything the agent said or did before this analysis counts as progress evidence only; it " +
  "must not define or reshape the goal."

/** Sections 1-5 of the instruction. Never trimmed. */
export function anchor(input: Anchor): string {
  const { prior } = input
  const recent = prior?.recent.slice(-RECENT_LIMIT) ?? []
  const state = prior
    ? [
        "Current intent:",
        block("current_intent", json(prior.intent)),
        "Current progress:",
        block("current_progress", json(prior.progress)),
        "Prompt sent for the round that just ended:",
        block("last_prompt", prior.prompt ?? "(none)"),
        `Recent analyses, oldest first:${recent.length === 0 ? " none" : ""}`,
        ...recent.map((item) => `- ${item.verdict}: ${item.reason}`),
      ]
    : ["There is no earlier analysis, so there is no current intent, progress or last prompt."]
  const humans =
    input.humans.length === 0
      ? [
          "None. No human message arrived since the last analysis, so the intent must stay verbatim and no " +
            "intent_change basis, goal_changed or user_stop verdict is possible.",
        ]
      : [
          "These are the human messages since the last analysis, oldest first. They are the highest-priority " +
            "evidence of what the user wants now. Only these IDs can be cited as `basis_message_id`.",
          ...input.humans.map((human) => block("human_message", human.text, ` id="${human.id}"`)),
        ]
  return [
    "# Loop analysis request",
    "Analyse the loop below and finish by calling submit_analysis.",
    "## 1. First description (the user's own words; never changes)",
    block("first_description", input.firstDescription),
    "## 2. First analysis (frozen)",
    ...(prior ? [block("first_analysis", json(prior.firstAnalysis))] : [FIRST_ANALYSIS_NOTE]),
    "## 3. Current state",
    ...state,
    "## 4. This round",
    `Agent declaration: ${declarationText(input.declaration)}`,
    `How the round ended: ${outcomeText(input.outcome)}`,
    "## 5. Human messages in the basis window",
    ...humans,
  ].join("\n\n")
}

/** The full instruction: the anchor, then the history. */
export function frame(anchorText: string, history: string): string {
  return [
    anchorText,
    "## 6. Conversation history",
    "The conversation as the agent sees it (a compaction summary stands in for what was compacted). " +
      "Older messages may be omitted. Message IDs are not shown here; cite only IDs from section 5.",
    block("history", history === "" ? "(empty)" : history),
  ].join("\n\n")
}

/**
 * Whether a message is something the user typed: a user-role message with real text that is neither
 * synthetic (loop continuations, wake-ups, hook and workflow injections) nor a command exchange. A message
 * typed while an automatic turn was running is human too, whatever turn it was merged into. Follows the
 * rules Memory uses to tell human input apart, plus presentation-only messages, which the model never sees.
 */
export function isHuman(message: SessionV1.WithParts): boolean {
  if (message.info.role !== "user") return false
  if (message.parts.some((part) => part.type === "compaction")) return false
  if (MessageV2.isIgnoredUser(message)) return false
  const text = message.parts.filter((part): part is SessionV1.TextPart => part.type === "text" && !part.synthetic)
  if (text.some(isCommand)) return false
  return text.some((part) => part.text.trim() !== "")
}

// A command exchange marks its invocation with `metadata.command`; unmarked text is user input, except the
// single-segment `/name args` shape of invocations persisted before commands were marked.
function isCommand(part: SessionV1.TextPart) {
  return typeof part.metadata?.command === "string" || /^\/[^\s/:]+(?:\s|$)/.test(part.text.trim())
}

/** One message of the transcript. The summary a compaction produced is protected from trimming. */
export interface Entry {
  readonly text: string
  readonly summary: boolean
}

function userEntry(message: SessionV1.WithParts): Entry | undefined {
  if (message.parts.some((part) => part.type === "compaction")) return undefined
  if (MessageV2.isIgnoredUser(message)) return undefined
  const lines: string[] = []
  let synthetic = false
  for (const part of message.parts) {
    if (part.type === "text" && !part.ignored && part.text !== "") {
      lines.push(part.text)
      if (part.synthetic) synthetic = true
    } else if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
      lines.push(`[Attached ${part.mime}: ${part.filename ?? "file"}]`)
    } else if (part.type === "subtask") {
      lines.push(`[The user ran the ${part.agent} subagent: ${part.description}]`)
    }
  }
  if (lines.length === 0) return undefined
  return {
    text: `[${isHuman(message) || !synthetic ? "user" : "automatic message"}]\n${lines.join("\n")}`,
    summary: false,
  }
}

function toolText(part: SessionV1.ToolPart): string {
  const head = `[tool ${part.tool}] ${truncate(JSON.stringify(part.state.input) ?? "", TOOL_INPUT_CHARS)}`
  switch (part.state.status) {
    case "completed":
      return `${head}\n=> ${part.state.time.compacted ? "[Old tool result content cleared]" : truncate(part.state.output, TOOL_OUTPUT_CHARS)}`
    case "error":
      return `${head}\n=> error: ${truncate(part.state.error, TOOL_OUTPUT_CHARS)}`
    default:
      return `${head}\n=> (interrupted before it finished)`
  }
}

function assistantEntry(info: SessionV1.Assistant, parts: ReadonlyArray<SessionV1.Part>): Entry | undefined {
  const blocks: string[] = []
  for (const part of parts) {
    if (part.type === "text" && !part.ignored && part.text.trim() !== "") blocks.push(part.text)
    else if (part.type === "tool") blocks.push(toolText(part))
  }
  if (blocks.length === 0) return undefined
  const summary = info.summary === true
  return { text: `[${summary ? "summary of the earlier conversation" : "assistant"}]\n${blocks.join("\n")}`, summary }
}

/** The transcript entries of a history view, in order. Reasoning, media and bookkeeping parts are left out. */
export function entries(messages: ReadonlyArray<SessionV1.WithParts>): Entry[] {
  const result: Entry[] = []
  for (const message of messages) {
    const entry = message.info.role === "assistant" ? assistantEntry(message.info, message.parts) : userEntry(message)
    if (entry) result.push(entry)
  }
  return result
}

export interface Fitted {
  readonly text: string
  readonly kept: number
  readonly omitted: number
  /** Estimated tokens of the kept entries. */
  readonly tokens: number
}

/**
 * Cuts the transcript to `budget` estimated tokens, dropping the oldest entries first and never the
 * compaction summary. If only protected entries remain the result may still exceed the budget.
 */
export function fit(all: ReadonlyArray<Entry>, budget: number): Fitted {
  const sizes = all.map((entry) => Token.estimateReserve(entry.text))
  let total = sizes.reduce((sum, size) => sum + size, 0)
  const dropped = new Set<number>()
  for (let index = 0; index < all.length && total > budget; index++) {
    if (all[index].summary) continue
    dropped.add(index)
    total -= sizes[index]
  }
  const kept = all.filter((_, index) => !dropped.has(index))
  const notice = dropped.size > 0 ? [`(${dropped.size} older message(s) omitted to fit the context window)`] : []
  return {
    text: [...notice, ...kept.map((entry) => entry.text)].join("\n\n"),
    kept: kept.length,
    omitted: dropped.size,
    tokens: total,
  }
}

export * as LoopInput from "./input"
