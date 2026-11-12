// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createSignal, type Accessor } from "solid-js"

/**
 * Streaming text buffer (#886 5.3).
 *
 * `message.part.delta` appends here instead of writing `store.part`. Views read
 * the store snapshot through `read()` and subscribe to `version`, which the
 * frame clock advances at most once per frame.
 *
 * The running preview of a tool part (`message.part.preview`) shares the same
 * path with a different write rule: a preview carries the current tail window
 * of the output, so it replaces the previous window instead of being appended
 * to it.
 */
export interface StreamPart {
  id: string
  type: string
  text?: string
  displayText?: string
}

/** The tail window of a running tool part's output. */
export interface PartPreview {
  tail: string
  /** Full output length, kept apart from the (bounded) tail. */
  totalLength: number
  /** Worker sequence number; only a newer window replaces the stored one. */
  seq: number
}

export interface StreamBuffer {
  append(partID: string, field: "text" | "reasoning", delta: string): void
  /**
   * Replace the preview window of a running tool part. A window whose `seq` is
   * not newer than the stored one is stale (reordered or repeated) and ignored.
   */
  preview(partID: string, tail: string, totalLength: number, seq: number): void
  /** The store snapshot plus deltas that have not settled yet. */
  read(part: StreamPart): string
  /** The latest preview window of a part that has not settled yet. */
  readPreview(partID: string): PartPreview | undefined
  /** A `message.part.updated` snapshot replaced the part; drop deltas and preview. */
  settle(partID: string): void
  /** Drop buffers for removed or evicted parts. */
  clearParts(partIDs: Iterable<string>): void
  /** Drop every buffer, e.g. after a reconnect. */
  clear(): void
  /** Advance `version` if anything changed since the last frame. */
  bump(): void
  version: Accessor<number>
}

type Pending = { text: string; reasoning: string }

export function createStreamBuffer(): StreamBuffer {
  const pending = new Map<string, Pending>()
  const previews = new Map<string, PartPreview>()
  const [version, setVersion] = createSignal(0)
  let dirty = false

  // A preview overlays the store instead of extending it, so views must re-read
  // when the overlay goes away. Text views refresh through the store write that
  // settles a delta; a preview needs the version bump to do the same.
  function dropPreview(partID: string) {
    if (previews.delete(partID)) dirty = true
  }

  return {
    append(partID, field, delta) {
      if (!delta) return
      const current = pending.get(partID) ?? { text: "", reasoning: "" }
      current[field] += delta
      pending.set(partID, current)
      dirty = true
    },
    preview(partID, tail, totalLength, seq) {
      const current = previews.get(partID)
      if (current && seq <= current.seq) return
      previews.set(partID, { tail, totalLength, seq })
      dirty = true
    },
    read(part) {
      // Hook-managed text owns the visible body; raw deltas must not reach it.
      if (part.type === "text" && typeof part.displayText === "string") return part.displayText
      const buffered = pending.get(part.id)
      const field = part.type === "reasoning" ? "reasoning" : "text"
      return (part.text ?? "") + (buffered?.[field] ?? "")
    },
    readPreview(partID) {
      return previews.get(partID)
    },
    settle(partID) {
      pending.delete(partID)
      dropPreview(partID)
    },
    clearParts(partIDs) {
      for (const partID of partIDs) {
        pending.delete(partID)
        dropPreview(partID)
      }
    },
    clear() {
      pending.clear()
      if (previews.size > 0) {
        previews.clear()
        dirty = true
      }
    },
    bump() {
      if (!dirty) return
      dirty = false
      setVersion((value) => value + 1)
    },
    version,
  }
}
