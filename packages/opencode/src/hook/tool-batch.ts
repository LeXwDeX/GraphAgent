/** Raw provider boundary used only to decide whether a deferred call is the sole call. */
export interface ToolBatch {
  readonly add: (id: string) => void
  readonly finish: (valid?: boolean) => void
  readonly isSingle: (id: string, signal?: AbortSignal) => Promise<boolean>
}

export function create(): ToolBatch {
  const calls = new Set<string>()
  let finished = false
  let release!: (valid: boolean) => void
  const ready = new Promise<boolean>((resolve) => {
    release = resolve
  })
  return {
    add(id) {
      if (!finished) calls.add(id)
    },
    finish(valid = true) {
      if (finished) return
      finished = true
      release(valid)
    },
    async isSingle(id, signal) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError")
      let cancel: (() => void) | undefined
      const interrupted = new Promise<never>((_, reject) => {
        if (!signal) return
        cancel = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
        signal.addEventListener("abort", cancel, { once: true })
      })
      try {
        if (!(await Promise.race([ready, interrupted])))
          throw new Error("The tool batch ended before its finish boundary")
        return calls.size === 1 && calls.has(id)
      } finally {
        if (cancel) signal?.removeEventListener("abort", cancel)
      }
    },
  }
}

export * as HookToolBatch from "./tool-batch"
