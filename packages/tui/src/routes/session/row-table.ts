// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, mapArray, untrack, type Accessor } from "solid-js"
import type { Message, Part } from "@graphagent/sdk"
import { renderUserTextPart } from "../../i18n/receipt"
import { errorMessage } from "../../util/error"
import {
  createTextFacts,
  delegationFoldID,
  longestLine,
  rowRevision,
  settledPartText,
  stableRows,
  type Row,
  type SessionViewState,
  type TextFactsCache,
} from "./rows"
import { hideToolDetails } from "./tool-attention"

/** The user message a sub-agent view draws as the task its parent delegated to it (#1033 3.4). */
export interface Delegation {
  messageID: string
  /** The Task description shown above the prompt; part of the row's revision, since it can wrap. */
  description: string
}

/** The row table of a session: every row in order, plus what the window and the height estimate read about them. */
export interface RowTable {
  rows: Row[]
  /** Longest line of the rows that hold text, for the height estimate of a row that is not measured yet. */
  chars: ReadonlyMap<string, number>
  /** Rows that are still being written; the transcript keeps them mounted. */
  streaming: ReadonlySet<string>
}

export interface RowTableDeps {
  /** Messages of the session, in order. */
  messages: Accessor<readonly Message[]>
  /** Parts of one message (a store read). */
  parts: (messageID: string) => readonly Part[]
  /** Text of a part that is still streaming: its snapshot plus what its buffer holds. Follows the stream version. */
  readPartText: (part: Part) => string
  view: SessionViewState
  showDetails: Accessor<boolean>
  /** Id of the last assistant message, which always shows its summary. */
  lastAssistantID: Accessor<string | undefined>
  /** Id of the message the session is reverted to; the revert marker takes its place. */
  revertMessageID: Accessor<string | undefined>
  /** Revision of the revert marker row. */
  revertRevision: () => number
  /** Whether a message sits at or after the revert boundary, where nothing is shown. */
  reverted: (message: Message) => boolean
  /**
   * The message a sub-agent view shows as its task: the row of that user message becomes a `delegation` row, so the
   * prompt is drawn once, in the task block, and not again as a user message. Nothing in a main session.
   */
  delegation?: Accessor<Delegation | undefined>
  /**
   * Revision of the closing line of a sub-agent that has finished. The line is the last row, and only a table that has
   * rows gets one; nothing while the agent runs or in a main session.
   */
  handback?: Accessor<number | undefined>
  /** Factory of the per-message text cache; a test swaps it to count derivations. */
  textFacts?: () => TextFactsCache
}

/** The rows one message contributes. */
interface MessageRows {
  rows: Row[]
  chars: Map<string, number>
  streaming: string[]
}

const NO_ROWS: MessageRows = { rows: [], chars: new Map(), streaming: [] }

const normalizeText = (raw: string) => raw.trim()
// OpenRouter encrypts some reasoning blocks; the placeholder is not text.
const normalizeReasoning = (raw: string) => raw.replace("[REDACTED]", "").trim()

/**
 * What a change to a message does to the table: the rows and the streaming set. The height estimate is
 * not compared. It only differs for a row that is still streaming, whose revision does not move with its
 * text (see `buildMessageRows`), and a row on screen reports its measured height every layout pass.
 */
function sameMessageRows(previous: MessageRows | undefined, next: MessageRows) {
  if (!previous) return false
  if (previous.rows.length !== next.rows.length || previous.streaming.length !== next.streaming.length) return false
  for (let index = 0; index < next.rows.length; index++) {
    const before = previous.rows[index]
    const after = next.rows[index]
    if (before.key !== after.key || before.kind !== after.kind || before.revision !== after.revision) return false
  }
  return next.streaming.every((key, index) => key === previous.streaming[index])
}

/**
 * The row table of a session, kept per message. Each message owns a memo over its own parts, so a store
 * write, or a streamed frame, re-runs the one message it concerns and nothing else; the table below only
 * stitches the messages together, and it re-runs when one of them changed what it contributes. A message
 * whose parts are all finished does not even follow the stream version.
 */
export function createRowTable(deps: RowTableDeps): Accessor<RowTable> {
  const units = mapArray(deps.messages, (message) => ({ message, rows: createMessageRows(message, deps) }))
  // Whether the reader opened the task block. A memo of its own: the table follows the flag of this one row, and a
  // flag of any other block leaves it alone.
  const delegationOpen = createMemo(() => {
    const delegation = deps.delegation?.()
    return delegation ? deps.view.get(delegationFoldID(delegation.messageID), "expanded") : false
  })
  let previous: ReadonlyMap<string, Row> = new Map()

  return createMemo(() => {
    const list: Row[] = []
    const chars = new Map<string, number>()
    const streaming = new Set<string>()

    const delegation = deps.delegation?.()
    let last: Message | undefined

    for (const { message, rows } of units()) {
      last = message
      if (message.id === deps.revertMessageID()) {
        list.push({
          key: `revert:${message.id}`,
          messageID: message.id,
          kind: "revert",
          revision: deps.revertRevision(),
        })
      }
      if (deps.reverted(message)) continue
      const built = rows()
      const delegated = delegation?.messageID === message.id
      for (const row of built.rows) {
        const shown =
          delegated && row.kind === "user" ? delegationRow(row, delegation.description, delegationOpen()) : row
        list.push(shown)
        const count = built.chars.get(row.key)
        if (count !== undefined) chars.set(shown.key, count)
      }
      for (const key of built.streaming) streaming.add(key)
    }

    const handback = deps.handback?.()
    if (handback !== undefined && last && list.length > 0) {
      list.push({ key: `handback:${last.sessionID}`, messageID: last.id, kind: "handback", revision: handback })
    }

    const stable = stableRows(previous, list)
    previous = stable.byKey
    return { rows: stable.rows, chars, streaming }
  })
}

/**
 * The row of the delegated user message, drawn as the task block: same message, its own key and revision. It folds
 * under its key, which is its `partID` too, and being open changes its revision as it does for a tool row.
 */
function delegationRow(row: Row, description: string, expanded: boolean): Row {
  const id = delegationFoldID(row.messageID)
  return {
    key: id,
    messageID: row.messageID,
    partID: id,
    kind: "delegation",
    revision: rowRevision(row.revision, description, expanded),
  }
}

function createMessageRows(message: Message, deps: RowTableDeps): Accessor<MessageRows> {
  const facts = deps.textFacts?.() ?? createTextFacts()
  // A boolean memo only wakes the message when the answer changes, not on every new last message.
  const isLast = message.role === "assistant" ? createMemo(() => deps.lastAssistantID() === message.id) : () => false
  return createMemo(() => buildMessageRows(message, deps, isLast, facts), NO_ROWS, { equals: sameMessageRows })
}

function buildMessageRows(
  message: Message,
  deps: RowTableDeps,
  isLast: Accessor<boolean>,
  facts: TextFactsCache,
): MessageRows {
  const parts = deps.parts(message.id)
  const rows: Row[] = []
  const chars = new Map<string, number>()
  const streaming: string[] = []

  if (message.role === "user") {
    const texts: string[] = []
    for (const part of parts) {
      if (part.type === "text" && !part.synthetic) texts.push(renderUserTextPart(part, { key: "" }))
    }
    const text = texts.join("\n\n")
    const compaction = parts.some((part) => part.type === "compaction")
    if (text || compaction) {
      const key = `user:${message.id}`
      rows.push({ key, messageID: message.id, kind: "user", revision: rowRevision(text, compaction) })
      chars.set(key, longestLine(text))
    }
    return { rows, chars, streaming }
  }

  const live = new Set<string>()
  for (const part of parts) {
    if (part.type === "text" || part.type === "reasoning") {
      live.add(part.id)
      const done = part.time?.end !== undefined
      // The stream version re-runs whatever reads it on every frame, so the table follows it only where a
      // row can change. A part that is done holds its whole text in its snapshot, and a part that is being
      // written is read once from the snapshot and its buffer, without the version.
      const snapshot = settledPartText(part)
      const body = facts.read(
        part.id,
        done ? snapshot : untrack(() => deps.readPartText(part)),
        part.type === "text" ? normalizeText : normalizeReasoning,
      )
      if (!body.text) {
        // The first words of a part that is being written are what give it a row, so until they come the
        // table follows the stream. After them its row no longer depends on the text (see below).
        if (!done) deps.readPartText(part)
        continue
      }
      const key = `part:${part.id}`
      // The text of a row that is still being written is left out of its revision. A revision that moved
      // with every delta would make a new row of it on every frame: the transcript would mount it again,
      // and every row below would be invalidated. Its height is measured while it is on screen, which the
      // streaming row always is; the finished text is hashed once, when it stops changing.
      const content = done ? body.hash() : 0
      rows.push({
        key,
        messageID: message.id,
        partID: part.id,
        kind: part.type,
        revision:
          part.type === "text"
            ? rowRevision(content, done)
            : rowRevision(content, done, deps.view.get(part.id, "expanded")),
      })
      chars.set(key, body.chars)
      if (!done) streaming.push(key)
    } else if (part.type === "tool") {
      if (hideToolDetails(part.tool, part.state, deps.showDetails())) continue
      const key = `part:${part.id}`
      const output = part.state.status === "completed" ? part.state.output : ""
      rows.push({
        key,
        messageID: message.id,
        partID: part.id,
        kind: "tool",
        revision: rowRevision(
          part.state.status,
          output.length,
          part.state.status === "pending" ? false : Boolean(part.state.metadata?.background),
          deps.view.get(part.id, "expanded"),
          deps.view.get(part.id, "errorExpanded"),
        ),
      })
      if (part.state.status === "pending" || part.state.status === "running") streaming.push(key)
    }
  }
  facts.retain(live)

  if (parts.some((part) => part.type === "tool" && part.tool === "task")) {
    rows.push({
      key: `task:${message.id}`,
      messageID: message.id,
      kind: "notice",
      revision: rowRevision(
        parts.some(
          (part) =>
            part.type === "tool" &&
            part.tool === "task" &&
            part.state.status === "running" &&
            part.state.metadata?.background !== true,
        ),
      ),
    })
  }

  if (message.error && message.error.name !== "MessageAbortedError") {
    rows.push({
      key: `error:${message.id}`,
      messageID: message.id,
      kind: "notice",
      revision: rowRevision(errorMessage(message.error), message.error.name),
    })
  }

  const final = message.finish && !["tool-calls", "unknown"].includes(message.finish)
  if (isLast() || final || message.error?.name === "MessageAbortedError") {
    rows.push({
      key: `summary:${message.id}`,
      messageID: message.id,
      kind: "meta",
      revision: rowRevision(message.finish, message.time.completed, message.error?.name, message.agent, message.mode),
    })
  }

  return { rows, chars, streaming }
}
