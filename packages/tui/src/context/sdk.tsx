import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createSimpleContext } from "./helper"
import { batch, onCleanup, onMount } from "solid-js"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
  /**
   * Optional reconnect notifier. When the transport re-establishes a stream
   * after a disconnect, this hook fires so the SDK can emit its local
   * `reconnected` lifecycle signal. Absent in production (the SSE retry loop
   * emits the signal directly); present in tests for deterministic injection.
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
    let sse: AbortController | undefined

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

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit("event", event)
        }
      })
    }

    const handleEvent = (event: GlobalEvent) => {
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        let attempt = 0
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break

          const events = await sdk.global.event({
            signal: ctrl.signal,
            sseMaxRetryAttempts: 0,
          })

          // A retry that successfully acquires a stream is a reconnect —
          // emit the lifecycle signal so consumers can recover state they
          // may have missed while the transport was down. The first
          // connection (attempt 0) is NOT a reconnect.
          if (attempt > 0) emitter.emit("reconnected")

          if (Flag.GRAPHAGENT_WORKSPACES) {
            // Start syncing workspaces, it's important to do this after
            // we've started listening to events
            await sdk.sync.start().catch(() => {})
          }

          for await (const event of events.stream) {
            if (ctrl.signal.aborted) break
            handleEvent(event)
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          attempt += 1
          if (abort.signal.aborted || ctrl.signal.aborted) break

          // Exponential backoff
          const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          await new Promise((resolve) => setTimeout(resolve, backoff))
        }
      })().catch(() => {})
    }

    onMount(async () => {
      if (props.events) {
        const unsub = await props.events.subscribe(handleEvent)
        onCleanup(unsub)

        // Plumb the optional reconnect notifier through the same local signal
        // so tests and desktop event sources can trigger recovery without the
        // SSE retry loop.
        if (props.events.onReconnect) {
          const unsubReconnect = props.events.onReconnect(() => emitter.emit("reconnected"))
          onCleanup(unsubReconnect)
        }

        if (Flag.GRAPHAGENT_WORKSPACES) {
          // Start syncing workspaces, it's important to do this after
          // we've started listening to events
          await sdk.sync.start().catch(() => {})
        }
      } else {
        startSSE()
      }
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      if (timer) clearTimeout(timer)
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
      url: props.url,
    }
  },
})
