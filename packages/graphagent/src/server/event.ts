import { Schema } from "effect"
import { ServerEvent } from "@graphagent/schema/server-event"

export const Event = ServerEvent

export const InstanceDisposed = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("server.instance.disposed"),
  properties: Schema.Struct({ directory: Schema.String }),
}).annotate({ identifier: "Event.server.instance.disposed" })

// #1013 (C1 PR5): a hot-read global config update keeps instances alive, so
// it reports the changed top-level keys instead of disposing them.
export const ConfigUpdated = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("config.updated"),
  properties: Schema.Struct({ keys: Schema.Array(Schema.String) }),
}).annotate({ identifier: "Event.config.updated" })
