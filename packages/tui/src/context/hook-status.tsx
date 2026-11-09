// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"

export type HookPhase = "started" | "finished" | "cancelled" | "timeout"

/** One foreground hook handler as reported by `session.hook.status`. */
export type HookRun = {
  sessionID: string
  hookID: string
  event: string
  descriptor: string
  statusMessage?: string
  phase: HookPhase
  timeoutMs: number
  cancellable: boolean
  startedAt: number
}

/** Wire shape of `session.hook.status`; Effect Schema encodes non-finite numbers as strings. */
export type HookStatusEvent = Omit<HookRun, "timeoutMs" | "startedAt"> & {
  timeoutMs: number | string
  startedAt: number | string
}

function toNumber(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function init() {
  const [store, setStore] = createStore<{ runs: Record<string, HookRun | undefined> }>({ runs: {} })

  const key = (sessionID: string, hookID: string) => `${sessionID}\u0000${hookID}`

  const status = {
    /** Applies one status event; terminal phases remove the running entry. */
    update(event: HookStatusEvent) {
      if (event.phase !== "started") {
        // Solid's store merge cannot delete keys through a functional update;
        // writing `undefined` to an explicit path removes the entry.
        setStore("runs", key(event.sessionID, event.hookID), undefined)
        return
      }
      setStore("runs", key(event.sessionID, event.hookID), {
        sessionID: event.sessionID,
        hookID: event.hookID,
        event: event.event,
        descriptor: event.descriptor,
        statusMessage: event.statusMessage,
        phase: event.phase,
        timeoutMs: toNumber(event.timeoutMs),
        cancellable: event.cancellable,
        startedAt: toNumber(event.startedAt),
      })
    },
    /** Drops an entry after an explicit cancel request. */
    remove(sessionID: string, hookID: string) {
      setStore("runs", key(sessionID, hookID), undefined)
    },
    /** Running hooks oldest-first, optionally narrowed to one session. */
    list(sessionID?: string): HookRun[] {
      return Object.values(store.runs)
        .filter(
          (run): run is HookRun =>
            run !== undefined && run.phase === "started" && (sessionID === undefined || run.sessionID === sessionID),
        )
        .sort((left, right) => left.startedAt - right.startedAt)
    },
    get count(): number {
      return status.list().length
    },
  }
  return status
}

export type HookStatusContext = ReturnType<typeof init>

const ctx = createContext<HookStatusContext>()

export function HookStatusProvider(props: ParentProps) {
  const value = init()
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useHookStatus() {
  const value = useContext(ctx)
  if (!value) throw new Error("useHookStatus must be used within a HookStatusProvider")
  return value
}
