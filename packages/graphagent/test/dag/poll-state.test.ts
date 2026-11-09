// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Deferred, Duration, Effect, Fiber, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import {
  bumpPollState,
  ensurePollEntry,
  prunePollState,
  POLL_MAX_ENTRIES,
  POLL_TTL_MS,
  withPollReadSlot,
  withPollSlot,
  type PollEntry,
} from "@/dag/poll-state"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

describe("DAG poll state", () => {
  test("prunes expired entries after a rejected hit changed LRU order", () => {
    const state = new Map<string, PollEntry>()
    bumpPollState(state, "old", true, 1_000)
    bumpPollState(state, "new", true, 2_000)
    ensurePollEntry(state, "old")
    prunePollState(state, 1_000 + POLL_TTL_MS)
    expect(state.has("old")).toBe(false)
    expect(state.has("new")).toBe(true)
    expect(bumpPollState(state, "old", true, 1_001 + POLL_TTL_MS)).toBe(1)
  })
  it.effect("bounds active entries and rejects contention without waiting or extending cooldown", () =>
    Effect.gen(function* () {
      const state = new Map<string, PollEntry>()
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let started = 0
      const fibers = yield* Effect.forEach(Array.from({ length: POLL_MAX_ENTRIES }, (_, i) => i), (i) =>
        withPollReadSlot(state, `busy-${i}`, 1_000, () => 0, () => Effect.gen(function* () {
          if (++started === POLL_MAX_ENTRIES) yield* Deferred.succeed(ready, undefined)
          yield* Deferred.await(release)
          return i
        })).pipe(Effect.forkChild))
      yield* Deferred.await(ready)
      expect(state.size).toBe(POLL_MAX_ENTRIES)
      const first = state.get("busy-0")!
      first.lastReadAt = 123
      const busy = yield* withPollReadSlot(state, "busy-0", 1_000, () => 0, () => Effect.succeed(-1))
      const overflow = yield* withPollReadSlot(state, "overflow", 1_000, () => 0, () => Effect.succeed(-1))
      expect(busy.kind).toBe("rate_limited")
      expect(overflow.kind).toBe("rate_limited")
      expect(first.lastReadAt).toBe(123)
      expect(state.size).toBe(POLL_MAX_ENTRIES)
      yield* Fiber.interrupt(fibers[0])
      expect(state.get("busy-0")?.active).toBe(0)
      yield* Deferred.succeed(release, undefined)
      yield* Effect.forEach(fibers.slice(1), Fiber.join, { concurrency: "unbounded" })
      expect([...state.values()].every((entry) => entry.active === 0)).toBe(true)
    }),
  )

  test("expires a stale counter before counting a new poll", () => {
    const state = new Map()
    expect(bumpPollState(state, "wf", true, 1_000)).toBe(1)
    expect(bumpPollState(state, "wf", true, 2_000)).toBe(2)
    expect(bumpPollState(state, "wf", true, 2_000 + POLL_TTL_MS)).toBe(1)
  })

  test("bounds the map and evicts the least recently used key", () => {
    const state = new Map()
    for (let index = 0; index < POLL_MAX_ENTRIES; index++) bumpPollState(state, `k${index}`, true, 1)
    expect(state.size).toBe(POLL_MAX_ENTRIES)
    expect(bumpPollState(state, "k0", true, 2)).toBe(2)
    bumpPollState(state, "new", true, 3)
    expect(state.size).toBe(POLL_MAX_ENTRIES)
    expect(state.has("k0")).toBe(true)
    expect(state.has("k1")).toBe(false)
    expect(state.has("new")).toBe(true)
  })

  test("a fresh instance starts with a fresh counter", () => {
    const first = new Map()
    expect(bumpPollState(first, "wf", true, 1)).toBe(1)
    expect(bumpPollState(first, "wf", true, 2)).toBe(2)
    expect(bumpPollState(new Map(), "wf", true, 3)).toBe(1)
  })

  test("a durable change resets the counter", () => {
    const state = new Map()
    expect(bumpPollState(state, "wf", true, 1, 100)).toBe(1)
    expect(bumpPollState(state, "wf", true, 2, 100)).toBe(2)
    expect(bumpPollState(state, "wf", true, 3, 200)).toBe(1)
    expect(bumpPollState(state, "wf", true, 4)).toBe(2)
  })

  it.effect("does not extend cooldown when a read is rejected", () =>
    Effect.gen(function* () {
      const state = new Map<string, PollEntry>()
      yield* withPollReadSlot(state, "k", 1_000, () => 0, () => Effect.succeed({ ok: true }))
      const entry = state.get("k")!
      const lastReadAt = entry.lastReadAt
      yield* TestClock.adjust(Duration.millis(100))
      yield* withPollReadSlot(state, "k", 1_000, () => 0, () => Effect.succeed({ ok: false }), (value) => value.ok)
      expect(entry.lastReadAt).toBe(lastReadAt)
    }),
  )

  it.effect("serializes reads and delays the fourth empty read until the interval", () =>
    Effect.gen(function* () {
      const state = new Map<string, PollEntry>()
      let reads = 0
      const read = () =>
        withPollSlot(state, "k", 1_000, true, (entry) =>
          Effect.gen(function* () {
            reads += 1
            bumpPollState(state, "k", true, 0, 1)
            return entry.count
          }),
        )

      yield* read()
      yield* read()
      yield* read()
      expect(reads).toBe(3)
      const fiber = yield* read().pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.millis(999))
      expect(reads).toBe(3)
      yield* TestClock.adjust(Duration.millis(1))
      yield* Fiber.join(fiber)
      expect(reads).toBe(4)
    }),
  )

  it.effect("returns rate_limited instead of exceeding the wait budget", () =>
    Effect.gen(function* () {
      const state = new Map<string, PollEntry>()
      let reads = 0
      const read = (budget: number) =>
        withPollReadSlot(
          state,
          "k",
          1_000,
          () => budget,
          (entry) =>
            Effect.gen(function* () {
              reads += 1
              bumpPollState(state, "k", true, 0, 1)
              return entry.count
            }),
        )

      yield* read(0)
      yield* read(0)
      yield* read(0)
      expect(reads).toBe(3)
      const limited = yield* read(0)
      expect(limited).toMatchObject({ kind: "rate_limited", count: 3 })
      expect(reads).toBe(3)
      const small = yield* read(10)
      expect(small).toMatchObject({ kind: "rate_limited", count: 3 })
      expect(reads).toBe(3)
      const allowed = yield* read(1_000).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.millis(1_000))
      expect(yield* Fiber.join(allowed)).toMatchObject({ kind: "read", value: 4 })
      expect(reads).toBe(4)
    }),
  )

  it.effect("releases a waiting slot when interrupted", () =>
    Effect.gen(function* () {
      const state = new Map<string, PollEntry>()
      let reads = 0
      const read = () =>
        withPollSlot(state, "k", 1_000, true, (entry) =>
          Effect.gen(function* () {
            reads += 1
            bumpPollState(state, "k", true, 0, 1)
            return entry.count
          }),
        )

      yield* read()
      yield* read()
      yield* read()
      const fiber = yield* read().pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.millis(100))
      yield* Fiber.interrupt(fiber)
      expect(reads).toBe(3)
      expect(state.get("k")?.active).toBe(0)
      const next = yield* read().pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.millis(1_000))
      expect(yield* Fiber.join(next)).toBe(4)
      expect(reads).toBe(4)
    }),
  )

  test("a non-empty poll resets the counter", () => {
    const state = new Map()
    expect(bumpPollState(state, "wf", true, 1)).toBe(1)
    expect(bumpPollState(state, "wf", true, 2)).toBe(2)
    expect(bumpPollState(state, "wf", false, 3)).toBe(0)
    expect(state.get("wf")?.count).toBe(0)
    expect(bumpPollState(state, "wf", true, 4)).toBe(1)
  })
})
