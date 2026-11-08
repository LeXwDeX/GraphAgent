import { createSignal, type Accessor } from "solid-js"

/**
 * Streaming text buffer (#886 5.3).
 *
 * `message.part.delta` appends here instead of writing `store.part`. Views read
 * the store snapshot through `read()` and subscribe to `version`, which the
 * frame clock advances at most once per frame.
 */
export interface StreamPart {
  id: string
  type: string
  text?: string
  displayText?: string
}

export interface StreamBuffer {
  append(partID: string, field: "text" | "reasoning", delta: string): void
  /** The store snapshot plus deltas that have not settled yet. */
  read(part: StreamPart): string
  /** A `message.part.updated` snapshot replaced the part; drop the buffer. */
  settle(partID: string): void
  /** Drop buffers for removed or evicted parts. */
  clearParts(partIDs: Iterable<string>): void
  /** Drop every buffer, e.g. after a reconnect. */
  clear(): void
  /** Advance `version` if anything was appended since the last frame. */
  bump(): void
  version: Accessor<number>
}

type Pending = { text: string; reasoning: string }

export function createStreamBuffer(): StreamBuffer {
  const pending = new Map<string, Pending>()
  const [version, setVersion] = createSignal(0)
  let dirty = false

  return {
    append(partID, field, delta) {
      if (!delta) return
      const current = pending.get(partID) ?? { text: "", reasoning: "" }
      current[field] += delta
      pending.set(partID, current)
      dirty = true
    },
    read(part) {
      // Hook-managed text owns the visible body; raw deltas must not reach it.
      if (part.type === "text" && typeof part.displayText === "string") return part.displayText
      const buffered = pending.get(part.id)
      const field = part.type === "reasoning" ? "reasoning" : "text"
      return (part.text ?? "") + (buffered?.[field] ?? "")
    },
    settle(partID) {
      pending.delete(partID)
    },
    clearParts(partIDs) {
      for (const partID of partIDs) pending.delete(partID)
    },
    clear() {
      pending.clear()
    },
    bump() {
      if (!dirty) return
      dirty = false
      setVersion((value) => value + 1)
    },
    version,
  }
}
