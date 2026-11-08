import { createOpencodeClient } from "@graphagent/sdk/v2"
import type { GlobalEvent } from "@graphagent/sdk/v2"
import { Flag } from "@graphagent/core/flag/flag"
import { createSimpleContext } from "./helper"
import { batch, onCleanup, onMount } from "solid-js"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
  /**
   * Preferred transport: one worker frame per batch. The worker already merged
   * deltas and aligned the batch to its frame budget, so the client only wraps
   * the emissions in a single Solid `batch`.
   */
  subscribeBatch?: (handler: (events: GlobalEvent[]) => void) => Promise<() => void>
  /** Replace the session set whose full event stream the worker forwards. */
  setInterest?: (full: readonly string[]) => Promise<void>
  /**
   * Optional reconnect notifier. When the transport re-establishes a stream
   * after a disconnect, this hook fires so the SDK can emit its local
   * `reconnected` lifecycle signal.
   */
  onReconnect?: (handler: () => void) => () => void
}

export interface SdkEventEmitter {
  emit(type: "event", event: GlobalEvent): void
  emit(type: "reconnected"): void
  on(type: "event", handler: (event: GlobalEvent) => void): () => void
  on(type: "reconnected", handler: () => void): () => void
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()

    function createSDK() {
      return createOpencodeClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: props.directory,
        fetch: props.fetch,
        headers: props.headers,
      })
    }

    let sdk = createSDK()

    const eventHandlers = new Set<(event: GlobalEvent) => void>()
    const reconnectHandlers = new Set<() => void>()
    const emitter: SdkEventEmitter = {
      emit(type: "event" | "reconnected", event?: GlobalEvent) {
        if (type === "event") {
          for (const handler of eventHandlers) handler(event!)
        } else {
          for (const handler of reconnectHandlers) handler()
        }
      },
      on(type: "event" | "reconnected", handler: ((event: GlobalEvent) => void) | (() => void)) {
        if (type === "event") {
          eventHandlers.add(handler as (event: GlobalEvent) => void)
          return () => {
            eventHandlers.delete(handler as (event: GlobalEvent) => void)
          }
        }
        reconnectHandlers.add(handler as () => void)
        return () => {
          reconnectHandlers.delete(handler as () => void)
        }
      },
    }

    onMount(async () => {
      const events = props.events
      // The TUI always receives events from the worker transport. There is no
      // SSE fallback: a missing source means no event delivery, not a second
      // retry loop with its own 16ms queue.
      if (!events) return

      const emitBatch = (batchEvents: GlobalEvent[]) => {
        if (batchEvents.length === 0) return
        batch(() => {
          for (const event of batchEvents) {
            emitter.emit("event", event)
          }
        })
      }

      const unsub = events.subscribeBatch
        ? await events.subscribeBatch(emitBatch)
        : await events.subscribe((event) => emitBatch([event]))
      onCleanup(unsub)

      if (events.onReconnect) {
        const unsubReconnect = events.onReconnect(() => emitter.emit("reconnected"))
        onCleanup(unsubReconnect)
      }

      if (Flag.GRAPHAGENT_WORKSPACES) {
        // Start syncing workspaces, it's important to do this after
        // we've started listening to events
        await sdk.sync.start().catch(() => {})
      }
    })

    onCleanup(() => {
      abort.abort()
      eventHandlers.clear()
      reconnectHandlers.clear()
    })

    return {
      get client() {
        return sdk
      },
      directory: props.directory,
      event: emitter,
      fetch: props.fetch ?? fetch,
      /** Replace the full-session interest set, e.g. from the F1 aggregator. */
      setInterest: (full: readonly string[]) => props.events?.setInterest?.(full) ?? Promise.resolve(),
      url: props.url,
    }
  },
})
