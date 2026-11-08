import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { encodeEvent, encodeEventProperties } from "../../../src/cli/tui/event-encode"

const properties = {
  timestamp: DateTime.makeUnsafe(1_700_000_000_000),
  sessionID: "ses_event_encode",
  location: { directory: "/tmp/project" },
}

const event = {
  directory: "/tmp/project",
  payload: { id: "evt_1", type: "session.next.moved", properties },
}

describe("event encode", () => {
  test("encodes schema-backed values to their wire shape", () => {
    const encoded = encodeEvent(event)
    const wire = encoded.payload.properties as unknown as { timestamp: number }
    expect(wire.timestamp).toBe(1_700_000_000_000)
    expect(typeof wire.timestamp).toBe("number")
    expect(wire).toEqual({ ...properties, timestamp: 1_700_000_000_000 })
    // JSON.stringify would call DateTime.toJSON and send an ISO string instead.
    expect(JSON.parse(JSON.stringify(properties)).timestamp).toBe("2023-11-14T22:13:20.000Z")
  })

  test("encoded payload survives structured cloning without prototype loss", () => {
    const cloned = structuredClone(encodeEvent(event))
    const wire = cloned.payload.properties as unknown as { timestamp: number; sessionID: string }
    expect(wire.timestamp).toBe(1_700_000_000_000)
    expect(wire.sessionID).toBe("ses_event_encode")
  })

  test("keeps the original event for unknown types", () => {
    const unknown = { payload: { id: "evt_2", type: "not.a.real.event", properties: { nested: new Map() } } }
    expect(encodeEvent(unknown)).toBe(unknown)
  })

  test("leaves sync payloads untouched", () => {
    const sync = { payload: { type: "sync", syncEvent: { id: "evt_3" } } }
    expect(encodeEvent(sync)).toBe(sync)
  })

  test("leaves events without a payload untouched", () => {
    const empty = { directory: "/tmp/project" }
    expect(encodeEvent(empty)).toBe(empty)
  })

  test("falls back to the original properties when encoding fails", () => {
    const invalid = { timestamp: "not-a-date" }
    expect(encodeEventProperties("session.next.moved", invalid)).toBe(invalid)
  })
})
