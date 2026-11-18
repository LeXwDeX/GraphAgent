// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { SessionV1 } from "@graphagent/core/v1/session"
import { headChars } from "@/util/text"
import { Truncate } from "./truncate"

/**
 * The log of a task the parent can read back (#1453): the subagent's final message and an index of the tool calls
 * its session recorded, cut into pages the parent asks for one at a time. The result of a task is what the subagent
 * chose to tell; this is what its session holds, for a parent that wants to see how it got there. The text is read by
 * a model, so it stays English.
 */

/** The characters of the log one page carries. */
export const PAGE_CHARS = 8000
/** The characters of a call's input the index shows before it cuts. */
const INPUT_CHARS = 80

export type Page =
  | { readonly ok: true; readonly text: string; readonly page: number; readonly pages: number }
  | { readonly ok: false; readonly error: string }

// One index line is one call: a line break in anything a tool recorded (its name, its input, the path of its saved
// result) would start a line of its own.
const oneLine = (text: string): string => text.replace(/[\r\n\u2028\u2029]+/g, " ")

// What the call was given, as the JSON it was written in, cut so an index line stays short. A cut that falls between
// the two halves of a surrogate pair takes one character fewer (`headChars`).
function inputSummary(input: SessionV1.ToolState["input"]): string {
  const json = JSON.stringify(input)
  const head = headChars(json, INPUT_CHARS)
  return head.length < json.length ? `${head}...` : head
}

// The bytes of what the call stored as its result; a call that has not finished has none yet.
function resultSize(state: SessionV1.ToolState): string {
  if (state.status === "completed") return Truncate.formatSize(Buffer.byteLength(state.output))
  if (state.status === "error") return Truncate.formatSize(Buffer.byteLength(state.error))
  return "-"
}

// Where the whole result was saved when the tool had to cut it (`outputPath`), if it was.
function savedPath(state: SessionV1.ToolState): string | undefined {
  if (state.status === "pending") return undefined
  const path = state.metadata?.outputPath
  return typeof path === "string" && path !== "" ? path : undefined
}

function indexLine(part: SessionV1.ToolPart, number: number): string {
  const saved = savedPath(part.state)
  return oneLine(
    [
      `${number}. ${part.tool} ${inputSummary(part.state.input)}`,
      part.state.status,
      resultSize(part.state),
      ...(saved === undefined ? [] : [`saved: ${saved}`]),
    ].join(" | "),
  )
}

// All the text of the latest assistant message that has any. A message of tool calls alone, or of blank text, has none.
function finalMessage(messages: ReadonlyArray<SessionV1.WithParts>): string {
  for (const message of messages.toReversed()) {
    if (message.info.role !== "assistant") continue
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    if (text.trim() !== "") return text
  }
  return "(none)"
}

/**
 * The log of a child session, from the messages it recorded, oldest first: its final message, then an index of every
 * tool call it made, one to a line, in the order it made them.
 */
export function document(messages: ReadonlyArray<SessionV1.WithParts>): string {
  const calls = messages.flatMap((message) => message.parts.filter((part) => part.type === "tool"))
  return [
    "Final message:",
    finalMessage(messages),
    "",
    `Tool calls (${calls.length}):`,
    ...calls.map((part, index) => indexLine(part, index + 1)),
  ].join("\n")
}

function pagesOf(text: string): string[] {
  const pages: string[] = []
  let rest = text
  do {
    const page = headChars(rest, PAGE_CHARS)
    pages.push(page)
    rest = rest.slice(page.length)
  } while (rest.length > 0)
  return pages
}

/**
 * One page of the log. Pages count from 1 and `-1` is the last; every other number is refused with what the log
 * holds, since a page asked for by guess is a call spent. A page ends where `headChars` ends it, so no page leaves
 * half a surrogate pair at its edge.
 */
export function slice(text: string, page: number): Page {
  if (page === 0) return { ok: false, error: "page must not be 0; use 1 for the first page or -1 for the last." }
  const pages = pagesOf(text)
  const number = page === -1 ? pages.length : page
  const found = number >= 1 ? pages[number - 1] : undefined
  if (found === undefined)
    return {
      ok: false,
      error: `page ${page} is out of range: this log has ${pages.length} page(s). Use 1 to ${pages.length}, or -1 for the last page.`,
    }
  return { ok: true, text: found, page: number, pages: pages.length }
}

export * as TaskRead from "./task-read"
