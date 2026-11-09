// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test"
import type { CounterKey, Counters } from "../lib/engine-probe"

// The #523 idempotency gate skips a fresh durable append whose type and payload
// hash repeat the aggregate's latest event. For tool-part and preview updates a
// repeated publish carries identical payload bytes only when both land in the
// same real millisecond, so the number of skips — and the SQL book each skip
// moves — varies with machine speed and load. A fixed ceiling flakes on a
// loaded runner (S4 observed deltas of -18, -3, 0, +15 and +33 between two
// identical passes), so the scenario tests assert the gate's accounting
// instead: read and write move together in whole append units and every
// timing-independent counter matches exactly.
export const APPEND_UNIT = 3

const VOLATILE: ReadonlySet<CounterKey> = new Set<CounterKey>([
  "sql.read",
  "sql.write",
  "json.parseBytes",
  "json.encodeBytes",
  "sha256Bytes",
])

// Payload byte totals embed timestamps and sequence numbers; two passes stay in
// the same small band.
const BYTE_TOLERANCE = 64

/** Counters that the dedup gate can move between two identical passes. */
export const GATE_VOLATILE: ReadonlyArray<CounterKey> = [...VOLATILE]

export function withoutVolatile(counts: Counters) {
  return Object.fromEntries(Object.entries(counts).filter(([key]) => !VOLATILE.has(key as CounterKey)))
}

/**
 * Assert two measured passes of the same scripted turn performed the same
 * timing-independent work. The SQL counters are compared by accounting rather
 * than exact value because the dedup gate's real-time skips are not repeatable.
 */
export function expectDeterministicPasses(actual: Counters, first: Counters) {
  expect(withoutVolatile(actual)).toEqual(withoutVolatile(first))
  expect(Math.abs(actual["json.encodeBytes"] - first["json.encodeBytes"])).toBeLessThanOrEqual(BYTE_TOLERANCE)

  const readDelta = actual["sql.read"] - first["sql.read"]
  const writeDelta = actual["sql.write"] - first["sql.write"]
  expect(writeDelta).toBe(readDelta)
  // `%` yields -0 for negative multiples; compare the boolean instead.
  expect(readDelta % APPEND_UNIT === 0).toBe(true)
}