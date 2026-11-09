import type { Event as SchemaEvent } from "@graphagent/schema/event"
import type { Definitions } from "@graphagent/schema/event-manifest"
import type { Stream } from "effect"

export type EventMap = {
  [D in (typeof Definitions)[number] as D["type"]]: SchemaEvent.Payload<D>
}

export interface Event {
  subscribe<Type extends keyof EventMap>(type: Type): Stream.Stream<EventMap[Type]>
}
