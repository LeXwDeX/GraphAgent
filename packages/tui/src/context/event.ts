import type { Event, GlobalEvent } from "@graphagent/sdk"
import { useSDK } from "./sdk"
import type { EventScope, GateDecision } from "./event-gate"

type EventMetadata = {
  directory: string
  workspace: string | undefined
  scope?: EventScope
  decision?: GateDecision
}

export function useEvent() {
  const sdk = useSDK()

  // The SDK's dispatch routes each event by gate decision before emitting:
  // `drop` events never reach a subscriber, `summary` events go to the summary
  // channel only. Subscribers therefore do not re-evaluate the gate.
  function subscribeInternal(
    handler: (event: Event, metadata: EventMetadata) => void,
    decision: Exclude<GateDecision, "drop">,
  ) {
    const onEvent = (event: GlobalEvent) => {
      // `sync` carries durable replay frames and `config.updated` reports a
      // hot-read global config write; neither is an instance event payload.
      if (event.payload.type === "sync" || event.payload.type === "config.updated") {
        return
      }
      handler(event.payload, { directory: event.directory, workspace: event.workspace, decision })
    }
    if (decision === "summary") {
      return sdk.event.onSummary((event) => {
        const payload = event.payload
        if (payload.type === "sync" || payload.type === "config.updated") return
        handler(payload, { directory: event.directory, workspace: event.workspace, decision: "summary" })
      })
    }
    return sdk.event.on("event", onEvent)
  }

  /** Full events only. */
  function subscribe(handler: (event: Event, metadata: EventMetadata) => void) {
    return subscribeInternal(handler, "deliver")
  }

  /** Both channels; `sync` is the only full subscriber. */
  function subscribeAll(handler: (event: Event, metadata: EventMetadata) => void) {
    const full = subscribeInternal(handler, "deliver")
    const summary = subscribeInternal(handler, "summary")
    return () => {
      full()
      summary()
    }
  }

  function on<T extends Event["type"]>(
    type: T,
    handler: (event: Extract<Event, { type: T }>, metadata: EventMetadata) => void,
  ) {
    return subscribe((event: Event, metadata: EventMetadata) => {
      if (event.type !== type) return
      handler(event as Extract<Event, { type: T }>, metadata)
    })
  }

  return {
    subscribe,
    subscribeAll,
    on,
  }
}
