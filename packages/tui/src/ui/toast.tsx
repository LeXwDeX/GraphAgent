import { createContext, useContext, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"

export type ToastOptions = {
  title?: string
  message: string
  variant: "info" | "success" | "warning" | "error"
  duration: number
}
type ToastInput = Omit<ToastOptions, "duration"> & { duration?: number }

/** Compact record kept for the status panel. */
export type ToastRecord = {
  id: number
  title?: string
  message: string
}

const MAX_RECENT_ERRORS = 5

function init() {
  const [store, setStore] = createStore({
    currentToast: null as ToastOptions | null,
    recentErrors: [] as ToastRecord[],
  })
  let errorID = 0

  let timeoutHandle: NodeJS.Timeout | null = null

  const toast = {
    show(options: ToastInput) {
      const toastOptions = { ...options, duration: options.duration ?? 5000 }
      setStore("currentToast", toastOptions)
      if (toastOptions.variant === "error") {
        setStore("recentErrors", (records) =>
          [{ id: ++errorID, title: toastOptions.title, message: toastOptions.message }, ...records].slice(
            0,
            MAX_RECENT_ERRORS,
          ),
        )
      }
      if (timeoutHandle) clearTimeout(timeoutHandle)
      timeoutHandle = setTimeout(() => {
        setStore("currentToast", null)
      }, toastOptions.duration).unref()
    },
    error: (err: any) => {
      if (err instanceof Error)
        return toast.show({
          variant: "error",
          message: err.message,
        })
      toast.show({
        variant: "error",
        message: "An unknown error has occurred",
      })
    },
    get currentToast(): ToastOptions | null {
      return store.currentToast
    },
    get recentErrors(): readonly ToastRecord[] {
      return store.recentErrors
    },
  }
  return toast
}

export type ToastContext = ReturnType<typeof init>

const ctx = createContext<ToastContext>()

export function ToastProvider(props: ParentProps) {
  const value = init()
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useToast() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useToast must be used within a ToastProvider")
  }
  return value
}
