import type { Event } from "@graphagent/sdk"
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

  function subscribe(handler: (event: Event, metadata: EventMetadata) => void) {
    return sdk.event.on("event", (event) => {
      // `sync` carries durable replay frames and `config.updated` reports a
      // hot-read global config write; neither is an instance event payload.
      if (event.payload.type === "sync" || event.payload.type === "config.updated") {
        return
      }

      const decision = sdk.eventGate?.(event.payload) ?? "deliver"
      if (decision === "drop") return

      handler(event.payload, {
        directory: event.directory,
        workspace: event.workspace,
        decision,
      })
    })
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
    on,
  }
}
