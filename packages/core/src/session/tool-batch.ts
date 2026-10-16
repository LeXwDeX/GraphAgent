export * as SessionToolBatch from "./tool-batch"

/** Raw provider-call membership; settle can wait for the stream's terminal boundary. */
export interface Interface {
  readonly add: (toolCallID: string) => void
  readonly finish: (valid?: boolean) => void
  readonly isSingle: (toolCallID: string, signal?: AbortSignal) => Promise<boolean>
}

export function create(): Interface {
  const calls = new Set<string>()
  let finished = false
  let release!: (valid: boolean) => void
  const ready = new Promise<boolean>((resolve) => {
    release = resolve
  })
  return {
    add(toolCallID) {
      if (!finished) calls.add(toolCallID)
    },
    finish(valid = true) {
      if (finished) return
      finished = true
      release(valid)
    },
    async isSingle(toolCallID, signal) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError")
      let cancel: (() => void) | undefined
      const interrupted = new Promise<never>((_, reject) => {
        if (!signal) return
        cancel = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
        signal.addEventListener("abort", cancel, { once: true })
      })
      try {
        if (!(await Promise.race([ready, interrupted]))) throw new Error("Provider tool batch failed")
        return calls.size === 1 && calls.has(toolCallID)
      } finally {
        if (cancel) signal?.removeEventListener("abort", cancel)
      }
    },
  }
}
