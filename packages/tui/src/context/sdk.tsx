import { createOpencodeClient } from "@graphagent/sdk/v2"
import type { Event, GlobalEvent } from "@graphagent/sdk/v2"
import { Flag } from "@graphagent/core/flag/flag"
import { BoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { batch, onCleanup, onMount } from "solid-js"
import { createSimpleContext } from "./helper"
import { createFrameClock, type FrameClock } from "./frame-clock"
import type { GateDecision } from "./event-gate"

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

const URGENT_TYPES = new Set([
  "permission.asked",
  "permission.replied",
  "permission.v2.asked",
  "permission.v2.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "question.interacted",
  "question.timed_out",
  "question.v2.asked",
  "question.v2.replied",
  "question.v2.rejected",
  "question.v2.interacted",
  "question.v2.timed_out",
  "session.status",
  "session.idle",
  "session.error",
])

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
    const renderer = useRenderer()
    const frameClock: FrameClock = createFrameClock({
      requestRender: () => renderer.requestRender(),
      registerPass: (run) => {
        try {
          const pass = new BoxRenderable(renderer, {
            position: "absolute",
            left: 0,
            top: 0,
            width: 0,
            height: 0,
            visible: false,
          })
          pass.onLifecyclePass = run
          renderer.registerLifecyclePass(pass)
          return () => {
            renderer.unregisterLifecyclePass(pass)
            pass.destroy()
          }
        } catch {
          // Headless or test renderers without lifecycle passes still flush
          // through the fallback timer.
          return () => {}
        }
      },
    })
    let eventGate: ((event: Event) => GateDecision) | undefined

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

    let pending: GlobalEvent[] = []
    const dispatch = () => {
      const events = pending
      pending = []
      if (events.length === 0) return
      batch(() => {
        for (const event of events) emitter.emit("event", event)
      })
    }

    onMount(async () => {
      const events = props.events
      // The TUI always receives events from the worker transport. There is no
      // SSE fallback: a missing source means no event delivery, not a second
      // retry loop with its own 16ms queue.
      if (!events) return

      const emitBatch = (batchEvents: GlobalEvent[]) => {
        if (batchEvents.length === 0) return
        pending.push(...batchEvents)
        frameClock.schedule(dispatch)
        // Permission and question prompts must not wait for the next frame.
        if (batchEvents.some((event) => URGENT_TYPES.has(event.payload.type))) frameClock.flushNow()
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
      pending = []
      frameClock.dispose()
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
      frameClock,
      /** Client-side defence applied by `useEvent` before subscribers see the event. */
      get eventGate() {
        return eventGate
      },
      setEventGate(gate: ((event: Event) => GateDecision) | undefined) {
        eventGate = gate
      },
      /** Replace the full-session interest set, e.g. from the F1 aggregator. */
      setInterest: (full: readonly string[]) => props.events?.setInterest?.(full) ?? Promise.resolve(),
      url: props.url,
    }
  },
})
