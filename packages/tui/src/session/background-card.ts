// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The card of a finished background run (#1058): what the message the server adds to the parent session when a run
 * ends is drawn as. Only the metadata of the part says that it is a result (`backgroundResultOf`); the text is never
 * trusted for that, so a model that writes `<task_result>` in its own words does not get a card. The text is read only
 * for what the card shows of it, the body. Pure: the part comes in as an argument, the title is made with `t()`, and
 * nothing here lays out a line (that needs the cell width, which the route does).
 */

import { backgroundResultOf, type BackgroundResult, type TextPartLike } from "../context/session-summary"
import { t, type MessageKey } from "../i18n"
import { Locale } from "../util/locale"
import { remoteLine, remoteText } from "../util/remote-text"
import { UNKNOWN } from "./subagent-record"

export interface BackgroundCard {
  /** The child session the run ran in: what a click on the card opens. */
  childSessionID: string
  status: BackgroundResult["status"]
  /** The Task description the run was started with, as one displayable line. */
  title: string
  /** The kind of agent that ran, as one displayable line: the Task link's, or `agent` when no link says. */
  kind: string
  /** Milliseconds the run took, from the moment it began running (its start when the server did not say) to its end; never negative. */
  elapsedMs: number
  /** What the run left: the content of the result (or error) element of the notice, trimmed. Empty when it left none. */
  body: string
  /** The first line of the body that has text, cleaned to one displayable line. Empty without one. */
  firstLine: string
}

/** The result of a part that has the metadata of one, with the child's kind when the caller knows it. */
export function backgroundCard(
  part: TextPartLike & { readonly text: string },
  kind?: string,
): BackgroundCard | undefined {
  const found = backgroundResultOf(part)
  if (!found) return undefined
  const { childSessionID, result } = found
  const body = remoteText(resultBody(typeof part.text === "string" ? part.text : "", result.title))
  return {
    childSessionID,
    status: result.status,
    title: remoteLine(result.title) || UNKNOWN,
    kind: remoteLine(kind ?? "") || "agent",
    elapsedMs: Math.max(0, result.endedAt - (result.runningAt ?? result.startedAt)),
    body,
    firstLine: firstTextLine(body),
  }
}

const RESULT_ELEMENTS = [
  { open: "<task_result>", close: "</task_result>" },
  { open: "<task_error>", close: "</task_error>" },
] as const
const SUMMARY_CLOSE = "</summary>"
// The server writes the notice inside a block with source="background-result": its opening tag, then the notice, then
// the closing tag (#1456). A run the user started has a line of instruction above the block.
const BLOCK_OPEN = /<system-reminder\s[^>]*\bsource="background-result"[^>]*>\s*/
const BLOCK_CLOSE = /\s*<\/system-reminder>\s*$/

/**
 * What the run left, out of the text of the notice (`renderTask` on the server): the content between the tags of the
 * result or error element, trimmed. A notice for a run the user started has a line of instruction above the task
 * element, which is not part of the result. The element is looked for after the summary, which holds the title and the
 * title is free text, and it ends at the last closing tag, because what the run wrote may hold one too. A text without
 * either element (a shape the server does not write today) is shown with the wrapper, and the block around the notice,
 * taken off.
 */
export function resultBody(text: string, title?: string): string {
  const from = afterSummary(text, title)
  let element: (typeof RESULT_ELEMENTS)[number] | undefined
  let open = -1
  for (const candidate of RESULT_ELEMENTS) {
    const at = text.indexOf(candidate.open, from)
    if (at !== -1 && (open === -1 || at < open)) {
      element = candidate
      open = at
    }
  }
  if (!element) return withoutWrapper(text)
  const start = open + element.open.length
  const close = text.lastIndexOf(element.close)
  return (
    close >= start
      ? text.slice(start, close)
      : text
          .slice(start)
          .replace(BLOCK_CLOSE, "")
          .replace(/\s*<\/task>\s*$/, "")
  ).trim()
}

/**
 * Where the summary element ends. The server writes it as `<summary>Background task <state>: <title></summary>` with
 * the title unescaped, so a title that holds `</summary>` would end a plain search early: with the title from the
 * metadata the end is found after it. Without a title, or when the text has no such summary, the first closing tag.
 */
function afterSummary(text: string, title: string | undefined): number {
  const open = text.indexOf("<summary>")
  if (title !== undefined && open !== -1) {
    const end = `: ${title}${SUMMARY_CLOSE}`
    const at = text.indexOf(end, open)
    if (at !== -1) return at + end.length
  }
  const close = text.indexOf(SUMMARY_CLOSE)
  return close === -1 ? 0 : close + SUMMARY_CLOSE.length
}

/** The text with the block around the notice, its `<task …>` tag, the `<summary>` element and the closing `</task>` taken off. */
function withoutWrapper(text: string): string {
  return text
    .replace(BLOCK_OPEN, "")
    .replace(/<task\b[^>]*>/, "")
    .replace(/<summary>[\s\S]*?<\/summary>/, "")
    .replace(BLOCK_CLOSE, "")
    .replace(/\s*<\/task>\s*$/, "")
    .trim()
}

/** The first line of `body` that has text once it is cleaned, as that text; none without one. */
function firstTextLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const text = remoteLine(line)
    if (text) return text
  }
  return ""
}

const STATUS_KEYS: Record<BackgroundCard["status"], MessageKey> = {
  completed: "background.card.status.completed",
  error: "background.card.status.error",
  interrupted: "background.card.status.interrupted",
}

/**
 * The first line of the card, without its mark: `background result · <kind> · <title> · <status> · <elapsed>`. A caller
 * that has to fit it to a width passes the `title` it cut, so the status and the time at its end stay.
 */
export function backgroundCardTitle(
  card: Pick<BackgroundCard, "kind" | "title" | "status" | "elapsedMs">,
  title: string = card.title,
): string {
  return t("background.card.title", {
    kind: card.kind,
    title,
    status: t(STATUS_KEYS[card.status]),
    elapsed: Locale.duration(card.elapsedMs),
  })
}
