export * as SessionEvent from "./session-event"

import { Schema } from "effect"
import { Event } from "./event"
import { DateTimeUtcFromMillis, RelativePath } from "./schema"
import { SessionID } from "./session-id"
import { Location } from "./location"

const Base = {
  timestamp: DateTimeUtcFromMillis,
  sessionID: SessionID,
}

const options = {
  durable: {
    aggregate: "sessionID",
    version: 1,
  },
} as const

export const Moved = Event.define({
  type: "session.next.moved",
  ...options,
  schema: {
    ...Base,
    location: Location.Ref,
    subdirectory: RelativePath.pipe(Schema.optional),
  },
})
export type Moved = typeof Moved.Type

export const DurableDefinitions = Event.inventory(Moved)

export const Definitions = Event.inventory(Moved)

export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type"))
export type DurableEvent = typeof Durable.Type

export const All = Schema.Union(Definitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type"))
export type Event = typeof All.Type
export type Type = Event["type"]
