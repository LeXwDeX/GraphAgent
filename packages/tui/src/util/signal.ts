import { createSignal, onCleanup, type Accessor } from "solid-js"

/** Schedules `callback` once after `ms`, returning its cancel function. */
export type Scheduler = (callback: () => void, ms: number) => () => void

export function createDebouncedSignal<T>(value: T, ms: number, schedule: Scheduler): [Accessor<T>, (value: T) => void] {
  const [get, set] = createSignal(value)
  let cancel: (() => void) | undefined
  const debounced = (next: T) => {
    cancel?.()
    cancel = schedule(() => {
      cancel = undefined
      set(() => next)
    }, ms)
  }
  onCleanup(() => cancel?.())
  return [get, debounced]
}
