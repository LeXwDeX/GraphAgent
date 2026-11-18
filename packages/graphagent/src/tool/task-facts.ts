// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Database } from "@graphagent/core/database/database"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Cause, Effect } from "effect"
import type { ChildRunFacts } from "../session/child/types"
import { MessageV2 } from "../session/message-v2"
import type { MessageID, SessionID } from "../session/schema"
import { endedTurnsSince, type EndedTurn, type TurnOutcome } from "../session/turns"

/**
 * The facts a task result carries (#1453): what the engine measured of the child run, as a block written ahead of
 * what the subagent wrote. What a subagent says of its own work is not evidence of it; the turns it took, the tokens
 * it spent, the tool calls that failed and the files its snapshots saw change are. The block is read by a model, so
 * it stays English and one item to a line, in a fixed order.
 */

/** The most changed files one block lists; the rest are counted. */
const MAX_FILES = 20
/** Messages read per page when the run's transcript is totalled. */
const PAGE = 50
const NO_SNAPSHOT = "unknown (no snapshot: not a git repository, or snapshots are disabled)"

/** How the run ended: the outcome of its last turn, or `step_limit` for a turn that ended on its agent's step cap. */
export type End = TurnOutcome["type"] | "step_limit" | "unknown"

export interface Tokens {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** `changed_files`: the paths, no change, no snapshot to tell it by, or unread. */
export type Changed =
  | { readonly kind: "files"; readonly files: readonly string[] }
  | { readonly kind: "none" }
  | { readonly kind: "no_snapshot" }
  | { readonly kind: "unknown" }

/** What was measured of one run; an item that could not be read is `undefined`. */
export interface Measured {
  readonly end: End
  readonly steps: number | undefined
  readonly tokens: Tokens | undefined
  readonly toolErrors: number | undefined
  readonly changed: Changed
}

/**
 * How a run ended, from its turns, oldest first: the last turn decides. A completed turn that took as many steps as
 * its agent allows is `step_limit`: the loop makes that last step answer without tools, so the turn ends completed
 * there, and a turn that finished on its own at that very step reads the same (the turn row does not tell them
 * apart). No turn, or one whose outcome cannot be read, is `unknown`.
 */
export function endOf(turns: ReadonlyArray<EndedTurn>, agentSteps: number | undefined): End {
  const last = turns.at(-1)
  if (!last?.outcome) return "unknown"
  if (last.outcome.type === "completed" && agentSteps !== undefined && last.steps >= agentSteps) return "step_limit"
  return last.outcome.type
}

// Line breaks and the other control characters of a path, written as escapes: a path is one item on one line of the
// block, and one that carried a newline could start an item of its own.
const LINE_BREAKING = /[\u0000-\u0008\u000a-\u001f\u007f\u0085\u2028\u2029]/g

function onePath(path: string): string {
  return path.replace(LINE_BREAKING, (char) =>
    char === "\n" ? "\\n" : char === "\r" ? "\\r" : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}

function tokensLine(tokens: Tokens | undefined): string {
  if (!tokens) return "unknown"
  return `input=${tokens.input} output=${tokens.output} reasoning=${tokens.reasoning} cache_read=${tokens.cacheRead} cache_write=${tokens.cacheWrite}`
}

function changedLine(changed: Changed): string {
  if (changed.kind === "none") return "changed_files: none"
  if (changed.kind === "no_snapshot") return `changed_files: ${NO_SNAPSHOT}`
  if (changed.kind === "unknown") return "changed_files: unknown"
  const listed = changed.files.slice(0, MAX_FILES).map(onePath).join(", ")
  const more = changed.files.length - MAX_FILES
  return `changed_files (${changed.files.length}): ${listed}${more > 0 ? `, ... ${more} more` : ""}`
}

/** The `<task_facts>` block: one item per line, in a fixed order, and `unknown` for what could not be read. */
export function render(measured: Measured): string {
  return [
    "<task_facts>",
    `end: ${measured.end}`,
    `steps: ${measured.steps ?? "unknown"}`,
    `tokens: ${tokensLine(measured.tokens)}`,
    `tool_errors: ${measured.toolErrors ?? "unknown"}`,
    changedLine(measured.changed),
    "</task_facts>",
  ].join("\n")
}

/** What the assistant messages of a run add up to. */
interface Tally {
  assistants: number
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  toolErrors: number
  /** A step of the run started from a snapshot: the files it changed were recorded. */
  snapshots: boolean
  /** The files of the run's patch parts, each once, in the order they were first changed. */
  files: Set<string>
}

function addMessage(tally: Tally, message: SessionV1.WithParts): void {
  if (message.info.role !== "assistant") return
  const { tokens } = message.info
  tally.assistants += 1
  tally.tokens.input += tokens.input
  tally.tokens.output += tokens.output
  tally.tokens.reasoning += tokens.reasoning
  tally.tokens.cacheRead += tokens.cache.read
  tally.tokens.cacheWrite += tokens.cache.write
  for (const part of message.parts) {
    if (part.type === "tool" && part.state.status === "error") tally.toolErrors += 1
    else if (part.type === "step-start" && part.snapshot) tally.snapshots = true
    else if (part.type === "patch") for (const file of part.files) tally.files.add(file)
  }
}

// The messages after the one the run's first prompt wrote, a page at a time like the task tool's own scan for tool
// work. The start message is read first: the cursor is its place in the session, not the time its id was made.
const tallyMessages = Effect.fnUntraced(function* (sessionID: SessionID, sinceMessageID: MessageID) {
  const start = yield* MessageV2.get({ sessionID, messageID: sinceMessageID }).pipe(Effect.orDie)
  const tally: Tally = {
    assistants: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    toolErrors: 0,
    snapshots: false,
    files: new Set(),
  }
  let cursor = MessageV2.cursor.encode({ id: start.info.id, time: start.info.time.created })
  while (true) {
    const page = yield* MessageV2.after({ sessionID, limit: PAGE, after: cursor }).pipe(Effect.orDie)
    for (const message of page.items) addMessage(tally, message)
    if (!page.more || !page.cursor) return tally
    cursor = page.cursor
  }
})

// A source that cannot be read leaves the items it feeds unknown. An interruption is not a failed read: it goes on.
function readable<A, R>(read: Effect.Effect<A, never, R>): Effect.Effect<A | undefined, never, R> {
  return read.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.logDebug("task facts: a source could not be read", Cause.pretty(cause)).pipe(Effect.as(undefined)),
    ),
  )
}

function changedOf(tally: Tally): Changed {
  if (tally.files.size > 0) return { kind: "files", files: [...tally.files] }
  return tally.snapshots ? { kind: "none" } : { kind: "no_snapshot" }
}

/**
 * Measures a run: its turns (the end and the steps) from the turn rows that answer `sinceMessageID` or later, and its
 * tokens, failed tool calls and changed files from the messages after it. The two sources are read apart, so one that
 * cannot be read leaves its own items `unknown` and not the other's; a session with no assistant message has nothing
 * to total and reads the same. It never fails; only an interruption passes through.
 */
export const collect = Effect.fn("TaskFacts.collect")(function* (input: {
  readonly sessionID: SessionID
  readonly sinceMessageID: MessageID
  readonly agentSteps: number | undefined
}): Effect.fn.Return<ChildRunFacts, never, Database.Service> {
  const { db } = yield* Database.Service
  const turns = yield* readable(endedTurnsSince({ db }, input.sessionID, input.sinceMessageID))
  const read = yield* readable(tallyMessages(input.sessionID, input.sinceMessageID))
  const tally = read && read.assistants > 0 ? read : undefined
  const end: End = turns ? endOf(turns, input.agentSteps) : "unknown"
  const block = render({
    end,
    steps: turns && turns.length > 0 ? turns.reduce((sum, turn) => sum + turn.steps, 0) : undefined,
    tokens: tally?.tokens,
    toolErrors: tally?.toolErrors,
    changed: tally ? changedOf(tally) : { kind: "unknown" },
  })
  return end === "step_limit" || end === "tool_budget_exhausted" ? { block, incomplete: end } : { block }
})

export * as TaskFacts from "./task-facts"
