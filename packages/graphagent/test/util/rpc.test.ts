// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { Arbitrary, Effect, Schema } from "effect"
import { EventManifest } from "@/event-manifest"
import { cloneEventData } from "@/util/rpc"

const SEED = 1

/**
 * EventPump encodes every schema-backed event to its wire shape before it
 * crosses the worker boundary. The bridge then structured-clones the frame, so
 * each encoded payload must survive the clone with the same shape a JSON round
 * trip produces. A mismatch means the TUI receives a different shape depending
 * on which normalization path the clone uses.
 */
test("every event payload survives the RPC structured clone unchanged", () => {
  const failures: string[] = []
  for (const definition of EventManifest.Latest.values()) {
    const arbitrary = Arbitrary.schema(definition.data)
    const samples = Effect.runSync(Arbitrary.sampleEffect(arbitrary, { count: 1, size: 5, seed: SEED }))
    const wire = Schema.encodeSync(definition.data)(samples[0])
    const cloned = cloneEventData(wire)
    const json = JSON.parse(JSON.stringify(wire))

    if (!Bun.deepEquals(cloned, wire)) failures.push(`${definition.type}: structured clone changed the payload`)
    if (!Bun.deepEquals(cloned, json)) failures.push(`${definition.type}: structured clone differs from JSON`)
  }
  expect(failures).toEqual([])
}, 30_000)

test("an uncloneable payload is rejected instead of JSON-normalized", () => {
  expect(() => cloneEventData({ callback: () => undefined })).toThrow()
})
