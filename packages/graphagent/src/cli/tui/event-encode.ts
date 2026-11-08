import { Schema } from "effect"
import { EventManifest } from "@/event-manifest"

/**
 * Events now cross the worker boundary through structured cloning, which does
 * not run `toJSON`. Normalize schema-backed payloads to their wire shape first,
 * so values like `DateTime` reach the TUI as the encoded form it is typed for
 * instead of as a cloned class instance.
 *
 * Unknown event types and payloads that fail to encode keep the previous
 * structured-clone behavior.
 */
export function encodeEventProperties(type: string, properties: unknown) {
  const definition = EventManifest.Latest.get(type)
  if (!definition) return properties
  try {
    return Schema.encodeUnknownSync(definition.data)(properties)
  } catch {
    return properties
  }
}

export function encodeEvent<E extends object>(event: E): E {
  const payload = (event as { payload?: any }).payload
  if (!payload || typeof payload !== "object" || typeof payload.type !== "string") return event
  if (payload.type === "sync") return event
  const properties = encodeEventProperties(payload.type, payload.properties)
  if (properties === payload.properties) return event
  return { ...event, payload: { ...payload, properties } } as E
}

export * as EventEncode from "./event-encode"
