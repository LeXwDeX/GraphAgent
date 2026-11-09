import { createContext, useContext, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"

export type ToastLevel = "info" | "success" | "warning" | "error"

/**
 * A transient footer message. Display and dismissal timing belong to the
 * footer (the only `ticker` consumer), so this store never owns a timer.
 */
export type ToastOptions = {
  text: string
  level: ToastLevel
  duration?: number
  /** Click handler while the toast is visible. */
  onActivate?: () => void
  /** New toasts declare their key so repeats within ten seconds merge. */
  dedupeKey?: string
}

/** Compact record kept for the status panel's recent messages. */
export type ToastRecord = {
  id: number
  text: string
  level: ToastLevel
  at: number
}

export type CurrentToast = ToastOptions & { id: number }

type Entry = { id: number; options: ToastOptions; at: number }

export const TOAST_QUEUE_LIMIT = 3
export const TOAST_RECENT_LIMIT = 20
export const TOAST_DEDUPE_MS = 10_000
export const TOAST_DEFAULT_MS = 4_000
export const TOAST_ERROR_MS = 8_000

export function toastDuration(options: ToastOptions): number {
  return options.duration ?? (options.level === "error" ? TOAST_ERROR_MS : TOAST_DEFAULT_MS)
}

function init() {
  const [store, setStore] = createStore({
    current: null as Entry | null,
    queue: [] as Entry[],
    recent: [] as ToastRecord[],
  })
  let nextID = 0

  function record(entry: Entry) {
    if (entry.options.level !== "error") return
    setStore("recent", (records) =>
      [{ id: entry.id, text: entry.options.text, level: entry.options.level, at: entry.at }, ...records].slice(
        0,
        TOAST_RECENT_LIMIT,
      ),
    )
  }

  /** Replaces an existing entry with the new options and refreshes its window. */
  function merge(entry: Entry, options: ToastOptions): Entry {
    return { id: entry.id, options, at: Date.now() }
  }

  function enqueue(options: ToastOptions) {
    const now = Date.now()
    const key = options.dedupeKey ?? options.text
    const keyOf = (entry: Entry) => entry.options.dedupeKey ?? entry.options.text
    const current = store.current
    if (current && keyOf(current) === key && now - current.at < TOAST_DEDUPE_MS) {
      const merged = merge(current, options)
      setStore("current", merged)
      record(merged)
      return
    }
    const index = store.queue.findIndex((entry) => keyOf(entry) === key && now - entry.at < TOAST_DEDUPE_MS)
    if (index >= 0) {
      const merged = merge(store.queue[index]!, options)
      setStore("queue", index, merged)
      record(merged)
      return
    }

    const entry: Entry = { id: ++nextID, options, at: now }
    if (!current) {
      setStore("current", entry)
      record(entry)
      return
    }
    const queue = [...store.queue, entry]
    if (queue.length > TOAST_QUEUE_LIMIT) {
      // Overflow drops the oldest info first; a queue of warnings keeps its
      // oldest entry instead of silently discarding a more urgent message.
      const info = queue.findIndex((item) => item.options.level === "info")
      queue.splice(info >= 0 ? info : 0, 1)
    }
    setStore("queue", queue)
    record(entry)
  }

  const toast = {
    show(options: ToastOptions) {
      enqueue(options)
    },
    error(err: unknown, dedupeKey = "toast.error") {
      if (err instanceof Error) return toast.show({ text: err.message, level: "error", dedupeKey })
      toast.show({ text: "An unknown error has occurred", level: "error", dedupeKey })
    },
    /** Hides the current toast and promotes the next queued entry. */
    dismiss() {
      setStore("current", store.queue[0] ?? null)
      setStore("queue", store.queue.slice(1))
    },
    get currentToast(): CurrentToast | null {
      const current = store.current
      return current ? { ...current.options, id: current.id } : null
    },
    get queued(): readonly ToastOptions[] {
      return store.queue.map((entry) => entry.options)
    },
    get recentMessages(): readonly ToastRecord[] {
      return store.recent
    },
    /** Test/escape hatch: drop everything without touching recent messages. */
    clear() {
      setStore("current", null)
      setStore("queue", [])
    },
  }
  return toast
}

export type FooterToasts = ReturnType<typeof init>

const ctx = createContext<FooterToasts>()

export function FooterToastProvider(props: ParentProps) {
  const value = init()
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useToast() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useToast must be used within a FooterToastProvider")
  }
  return value
}
