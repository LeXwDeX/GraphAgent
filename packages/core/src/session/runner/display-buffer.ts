export * as SessionDisplayBuffer from "./display-buffer"

export type Mode = "interactive" | "noninteractive"
export interface Batch {
  readonly textID: string
  readonly delta: string
  readonly index: number
  readonly final: boolean
}

/** Build the same cross-part display batches seen by a foreground turn. */
export function create(mode: Mode) {
  const parts = new Map<string, string>()
  const order: string[] = []
  let pending = ""
  let segments: Array<{ textID: string; length: number }> = []
  let index = 0
  let finished = false
  let lastTextID: string | undefined

  function take(final: boolean): Batch | undefined {
    if (finished) return undefined
    if (final && mode === "noninteractive") {
      pending = order.map((id) => parts.get(id) ?? "").join("")
      segments = order
        .map((textID) => ({ textID, length: parts.get(textID)?.length ?? 0 }))
        .filter((segment) => segment.length > 0)
    }
    const target = segments[0]?.textID ?? lastTextID
    if (!target) return undefined
    const end = final ? pending.length : pending.lastIndexOf("\n") + 1
    if (!final && (mode !== "interactive" || end === 0)) return undefined
    const delta = pending.slice(0, end)
    pending = pending.slice(end)
    let remaining = end
    while (remaining > 0 && segments.length > 0) {
      const first = segments[0]
      const consumed = Math.min(remaining, first.length)
      first.length -= consumed
      remaining -= consumed
      if (first.length === 0) segments.shift()
    }
    lastTextID = target
    finished = final
    return { textID: target, delta, index: index++, final }
  }

  return {
    start(textID: string) {
      if (parts.has(textID)) return
      parts.set(textID, "")
      order.push(textID)
      lastTextID = textID
    },
    append(textID: string, delta: string) {
      if (!parts.has(textID)) return undefined
      parts.set(textID, `${parts.get(textID)}${delta}`)
      pending += delta
      if (delta.length > 0) segments.push({ textID, length: delta.length })
      return take(false)
    },
    finish: () => take(true),
  }
}
