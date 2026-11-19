// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import path from "path"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { isHookRewake } from "@/hook"
import { Token } from "@/util/token"
import { isRecord } from "@/util/record"

/**
 * What the continuation text after an automatic compaction states as fact (Issue #1469): the user's own words and the
 * files the session touched. The harness reads both from the stored messages, so they come out exactly as they were;
 * the summary only narrates, it is never their source.
 */

/** One request of the user: its text and one `[Attached ...]` line per file part. */
export interface Request {
  readonly text: string
  readonly attachments: readonly string[]
}

export interface Requests {
  /** The newest human request. */
  readonly latest?: Request
  /** A child session's first human request, its task prompt; absent when it is the latest one. */
  readonly first?: Request
}

export interface SessionFiles {
  /** Absolute paths, oldest touch first; a path repeats nowhere and sits at its most recent touch. */
  readonly changed: readonly string[]
  /** Read and never changed. */
  readonly read: readonly string[]
  /** How many older paths of each list the limit left out. */
  readonly omittedChanged: number
  readonly omittedRead: number
}

// A human request is a user turn that carries the user's own text or files. Compaction markers, subtask turns,
// synthetic and ignored text (the engine's own notes) and hook rewake prompts are not requests.
function requestOf(message: SessionV1.WithParts): Request | undefined {
  if (message.info.role !== "user") return undefined
  if (message.parts.some((part) => part.type === "compaction" || part.type === "subtask")) return undefined
  const texts = message.parts.flatMap((part) =>
    part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : [],
  )
  // The internal rewake convention prefixes the assembled original text.
  if (isHookRewake(texts.join("\n"))) return undefined
  const text = texts
    .map((item) => item.trim())
    .filter(Boolean)
    .join("\n")
  const attachments = message.parts.flatMap((part) =>
    part.type === "file" ? [`[Attached ${part.mime}: ${part.filename ?? "file"}]`] : [],
  )
  if (!text && attachments.length === 0) return undefined
  return { text, attachments }
}

/** The newest human request and, for a child session, its first one. No length limit: the text is the user's. */
export function requestsOf(input: { messages: readonly SessionV1.WithParts[]; child: boolean }): Requests {
  const { messages } = input
  let latestAt = messages.length - 1
  let latest: Request | undefined
  for (; latestAt >= 0; latestAt--) {
    latest = requestOf(messages[latestAt])
    if (latest) break
  }
  if (!latest) return {}
  if (!input.child) return { latest }
  // The scan stops before the latest turn: a first request that is the latest one is left out.
  for (let index = 0; index < latestAt; index++) {
    const first = requestOf(messages[index])
    if (first) return { latest, first }
  }
  return { latest }
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

// `text` while it fits `budget` tokens; otherwise its beginning and its end with the omitted middle counted between
// them, so an excerpt is never taken for the whole text.
function excerpt(text: string, budget: number) {
  const tokens = Token.estimateReserve(text)
  if (tokens <= budget) return text
  // The text's own density turns the token budget into characters.
  const keep = Math.floor((text.length * Math.max(0, budget)) / tokens)
  let head = Math.ceil(keep / 2)
  let tail = text.length - Math.floor(keep / 2)
  // A cut never splits a surrogate pair.
  if (head > 0 && isHighSurrogate(text.charCodeAt(head - 1))) head--
  if (tail < text.length && isLowSurrogate(text.charCodeAt(tail))) tail++
  return [text.slice(0, head), `[... ${tail - head} characters omitted ...]`, text.slice(tail)]
    .filter(Boolean)
    .join("\n")
}

/**
 * The requests as the continuation text may carry them. A request is the user's own words and stays whole while it
 * fits its share of `budget` tokens (the first and the latest request of a child share it). A longer one would take
 * the room the compacted conversation needs, so it keeps its beginning and its end with the omitted middle counted.
 * The attachment lines are never cut.
 */
export function fitRequests(requests: Requests, budget: number): Requests {
  const share = Math.floor(budget / (requests.first ? 2 : 1))
  const fit = (request: Request): Request => ({ ...request, text: excerpt(request.text, share) })
  return {
    ...(requests.latest ? { latest: fit(requests.latest) } : {}),
    ...(requests.first ? { first: fit(requests.first) } : {}),
  }
}

// Every path is kept once, at the position of its latest touch.
function touch(set: Set<string>, directory: string, file: unknown) {
  if (typeof file !== "string" || !file) return
  const resolved = path.resolve(directory, file)
  set.delete(resolved)
  set.add(resolved)
}

function newest(paths: readonly string[], limit: number) {
  const kept = paths.slice(Math.max(0, paths.length - Math.max(0, limit)))
  return { kept, omitted: paths.length - kept.length }
}

/**
 * The files the history changed (patch parts, completed `edit`, `write` and `apply_patch` calls) and the files it only
 * read (completed `read` calls), as absolute paths, the most recent `limit` of each. A file the history changed is not
 * listed as read.
 */
export function sessionFiles(input: {
  messages: readonly SessionV1.WithParts[]
  directory: string
  limit?: number
}): SessionFiles {
  const changed = new Set<string>()
  const read = new Set<string>()
  for (const message of input.messages)
    for (const part of message.parts) {
      if (part.type === "patch") {
        for (const file of part.files) touch(changed, input.directory, file)
        continue
      }
      if (part.type !== "tool" || part.state.status !== "completed") continue
      if (part.tool === "edit" || part.tool === "write") touch(changed, input.directory, part.state.input.filePath)
      else if (part.tool === "read") touch(read, input.directory, part.state.input.filePath)
      else if (part.tool === "apply_patch") {
        const entries = part.state.metadata.files
        if (Array.isArray(entries))
          for (const item of entries)
            if (isRecord(item)) touch(changed, input.directory, item.movePath ?? item.filePath)
      }
    }
  const limit = input.limit ?? 100
  const lastChanged = newest([...changed], limit)
  const lastRead = newest(
    [...read].filter((file) => !changed.has(file)),
    limit,
  )
  return {
    changed: lastChanged.kept,
    read: lastRead.kept,
    omittedChanged: lastChanged.omitted,
    omittedRead: lastRead.omitted,
  }
}

// Reads the compacted summary's pending-work sections: the bullets under the exact heading. The next heading ends
// the section; blank lines, text that is not a bullet and "(none)" placeholders are skipped.
export function summaryItems(summary: string | undefined, heading: string) {
  if (!summary) return []
  const lines = summary.split("\n")
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start < 0) return []
  const items: string[] = []
  for (const line of lines.slice(start + 1)) {
    const text = line.trim()
    if (!text) continue
    if (text.startsWith("#")) break
    if (!text.startsWith("- ")) continue
    const item = text.slice(2).trim()
    if (!item || item === "(none)") continue
    items.push(item)
  }
  return items
}

// The sections the continuation text reads. A summary without any of them is not the template's output.
const REQUIRED_HEADINGS = ["## Goal", "### In Progress", "## Next Steps"] as const

/**
 * Whether `text` has the summary template's shape: each section the continuation reads on a line of its own, and at least
 * one goal. Everything else of the template may be missing; a summary is only checked for what the continuation needs.
 */
export function validateSummary(text: string | undefined): boolean {
  if (!text) return false
  const lines = new Set(text.split("\n").map((line) => line.trim()))
  return REQUIRED_HEADINGS.every((heading) => lines.has(heading)) && summaryItems(text, "## Goal").length > 0
}

export * as CompactionFacts from "./compaction-facts"
