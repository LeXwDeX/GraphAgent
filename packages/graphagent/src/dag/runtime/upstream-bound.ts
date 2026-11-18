// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * #1453: how much of an upstream string a downstream node is handed.
 *
 * A node's prompt carries the values its input mapping resolves from upstream outputs. A string among them has
 * no size of its own: a writer's report or a diff can run to megabytes, and every node downstream would carry
 * all of it. A top-level string past `UPSTREAM_INLINE_LIMIT_BYTES` is cut to its first `UPSTREAM_HEAD_BYTES`
 * and followed by the standard truncation notice, which names the file that holds the whole text and the read
 * that continues it. Objects, lists and file refs are left as they are, and so is every string within the limit.
 *
 * The caller runs it after the checks that judge a node's input (a review's evidence is checked on the whole
 * text) and before the template renders: what the model sees is bounded, what the engine decides on is not.
 */

import { Effect } from "effect"
import { Truncate } from "@/tool/truncate"

/** A top-level string of the input mapping with more UTF-8 bytes than this is not handed over whole. */
export const UPSTREAM_INLINE_LIMIT_BYTES = 16_384
/** The part of such a string that is handed over: its first bytes, cut at a character boundary. */
export const UPSTREAM_HEAD_BYTES = 4_096

function oversized(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf-8") > UPSTREAM_INLINE_LIMIT_BYTES
}

/** The head of `text`, then the notice that names the file `write` put all of it in. */
const headAndPointer = Effect.fnUntraced(function* (text: string, write: Truncate.Interface["write"]) {
  const preview = Truncate.headPreview(text, Truncate.MAX_LINES, UPSTREAM_HEAD_BYTES)
  // A text past the inline limit always cuts, so this only narrows the type.
  if (!preview.details) return text
  const file = yield* write(text)
  return `${preview.text}\n\n${Truncate.notice(file, preview.details)}`
})

/**
 * `mapping` with each oversized top-level string replaced by its head and a pointer; the full text is written
 * once per string. Without a `write` there is nowhere to put the rest, so the mapping comes back as it is. The
 * same object comes back when nothing was oversized; the one passed in is never changed.
 */
export const bound = Effect.fn("UpstreamBound.bound")(function* (
  mapping: Record<string, unknown>,
  write?: Truncate.Interface["write"],
) {
  if (write === undefined) return mapping
  let cut = false
  const entries: [string, unknown][] = []
  for (const [key, value] of Object.entries(mapping)) {
    if (!oversized(value)) {
      entries.push([key, value])
      continue
    }
    entries.push([key, yield* headAndPointer(value, write)])
    cut = true
  }
  return cut ? Object.fromEntries(entries) : mapping
})

export * as UpstreamBound from "./upstream-bound"
