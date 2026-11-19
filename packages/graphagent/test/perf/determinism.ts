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

// Payload byte totals are never bit-identical between two identical passes, so
// the scenario tests compare every other counter exactly and these within a
// band (#1654).
//   - `json.encodeBytes` and `sha256Bytes` measure published event payloads,
//     which embed timestamps and sequence numbers.
//   - `json.parseBytes` measures every `JSON.parse` of the window, including the
//     message and part rows that each history read loads again. A `step-finish`
//     part persists `metrics.prepareMs`, `metrics.requestMs` and
//     `metrics.ttftMs`: whole milliseconds taken from `performance.now()`
//     (`recordStepMetrics` in src/session/processor.ts). Their digit count
//     follows machine speed (9 ms against 10 ms) and every read parses the part
//     again, so one extra digit moves the total by the number of reads of that
//     part in the window: 3 in S1 and S3, 3 to 13 in S2, up to 23 in S4. Linux
//     CI measured gaps of 6 and 7 bytes (S1 77615/77621 and 77473/77467, S2
//     2680076/2680069). Timestamps are always 13 digits and ids have a fixed
//     width, so they never change the length.
const BYTES: ReadonlyArray<CounterKey> = ["json.parseBytes", "json.encodeBytes", "sha256Bytes"]

const VOLATILE: ReadonlySet<CounterKey> = new Set<CounterKey>(["sql.read", "sql.write", ...BYTES])

/** Band for encoded event bytes, and for parsed bytes when a window reads each step-finish part a few times (S1-S3). */
const BYTE_TOLERANCE = 64

// A turn that runs many steps re-reads every earlier step-finish part on each
// later request. S4 parses 273 of them in one window (21 steps): one duration
// crossing a digit boundary on its first step moves `json.parseBytes` by 23
// (observed +23 on a loaded machine), and a crossing on every step by 273. The
// band covers the latter; S6 uses the same 512 for its parsed bytes.
const LONG_TURN_PARSE_TOLERANCE = 512

/** Counters that the dedup gate can move between two identical passes. */
export const GATE_VOLATILE: ReadonlyArray<CounterKey> = [...VOLATILE]

export function withoutVolatile(counts: Counters) {
  return Object.fromEntries(Object.entries(counts).filter(([key]) => !VOLATILE.has(key as CounterKey)))
}

/** Every counter except the payload byte totals, for scenarios that compare the SQL book exactly. */
export function withoutBytes(counts: Counters) {
  return Object.fromEntries(Object.entries(counts).filter(([key]) => !BYTES.some((bytes) => bytes === key)))
}

/**
 * Assert the encoded and parsed byte totals of two identical passes stay in the
 * same small band. `parseTolerance` widens only the parsed side, for turns whose
 * history re-reads multiply the digit noise.
 */
export function expectBytesWithinTolerance(actual: Counters, first: Counters, parseTolerance = BYTE_TOLERANCE) {
  expect(Math.abs(actual["json.encodeBytes"] - first["json.encodeBytes"])).toBeLessThanOrEqual(BYTE_TOLERANCE)
  expect(Math.abs(actual["json.parseBytes"] - first["json.parseBytes"])).toBeLessThanOrEqual(parseTolerance)
}

/**
 * Assert two measured passes of the same scripted turn performed the same
 * timing-independent work. The SQL counters are compared by accounting rather
 * than exact value because the dedup gate's real-time skips are not repeatable.
 */
export function expectDeterministicPasses(actual: Counters, first: Counters) {
  expect(withoutVolatile(actual)).toEqual(withoutVolatile(first))
  expectBytesWithinTolerance(actual, first, LONG_TURN_PARSE_TOLERANCE)

  const readDelta = actual["sql.read"] - first["sql.read"]
  const writeDelta = actual["sql.write"] - first["sql.write"]
  expect(writeDelta).toBe(readDelta)
  // `%` yields -0 for negative multiples; compare the boolean instead.
  expect(readDelta % APPEND_UNIT === 0).toBe(true)
}
