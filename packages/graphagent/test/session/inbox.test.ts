// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import * as TestClock from "effect/testing/TestClock"
import type { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionInbox, type InboxSource } from "@/session/inbox"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import type { InstanceContext } from "@/project/instance-context"
import { pollWithTimeout, testEffect } from "../lib/effect"

// Counts the inbox's own SessionStatus subscriptions: the invariant under
// test is one subscription per loaded instance, regardless of how many
// sources register or how often init runs.
let subscribeCalls = 0
const countingBridge = Layer.effect(
  EventV2Bridge.Service,
  Effect.gen(function* () {
    const inner = yield* EventV2Bridge.Service
    const subscribe: EventV2.Interface["subscribe"] = (definition) => {
      subscribeCalls += 1
      return inner.subscribe(definition)
    }
    return EventV2Bridge.Service.of({ ...inner, subscribe })
  }),
).pipe(Layer.provide(EventV2Bridge.defaultLayer))

// provideMerge so the body observes the same bridge instance the inbox
// subscribed through (publishing on a second bridge would not deliver).
// PR2: the inbox owns the dag-release idle gate, so SessionStatus is now a
// hard requirement of its layer.
const layer = SessionInbox.layer.pipe(
  Layer.provideMerge(countingBridge),
  Layer.provide(SessionStatus.defaultLayer),
)
const it = testEffect(layer)

// Let TestClock-resumed fibers run. `adjust` only wakes sleepers; the resumed
// work runs on the next scheduler ticks.
const drainFibers = Effect.gen(function* () {
  for (let i = 0; i < 15; i++) yield* Effect.yieldNow
})

const context = (directory: string): InstanceContext => ({
  directory,
  worktree: directory,
  root: directory,
  project: {
    id: Project.ID.global,
    worktree: directory,
    time: { created: 0, updated: 0 },
    sandboxes: [],
  },
})

let sequence = 0
const nextDirectory = (label: string) => `/inbox-${label}-${process.pid}-${sequence++}`

const source = (
  id: InboxSource["id"],
  priority: number,
  claim: InboxSource["claim"],
  extra: Partial<InboxSource> = {},
): InboxSource => ({ id, priority, mode: "idle_only", hint: () => true, claim, ...extra })

describe("SessionInbox", () => {
  it.instance("arms exactly one idle subscription per instance and drains it", () =>
    Effect.gen(function* () {
      subscribeCalls = 0
      const inbox = yield* SessionInbox.Service
      const claims = yield* Ref.make(0)
      yield* inbox.register(
        source("goal.continue", 10, () => Ref.updateAndGet(claims, (n) => n + 1).pipe(Effect.as(true))),
      )
      yield* inbox.init()
      // A second init (or any later register) must not add another subscriber.
      yield* inbox.init()
      expect(subscribeCalls).toBe(1)

      const events = yield* EventV2Bridge.Service
      const sessionID = SessionID.descending()
      yield* events.publish(SessionStatus.Event.Status, { sessionID, status: { type: "idle" } })
      yield* pollWithTimeout(
        Ref.get(claims).pipe(Effect.map((n) => (n > 0 ? n : undefined))),
        "idle event did not drain the inbox",
      )
      expect(yield* Ref.get(claims)).toBe(1)
    }),
  )

  it.instance("runs sources in priority order and stops after the first claim", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      const order = yield* Ref.make<ReadonlyArray<string>>([])
      const record = (label: string, claimed: boolean) => () =>
        Ref.updateAndGet(order, (seen) => [...seen, label]).pipe(Effect.as(claimed))
      yield* inbox.register(source("watch_pr", 30, record("third", true)))
      yield* inbox.register(source("goal.continue", 10, record("first", false)))
      yield* inbox.register(source("hook.rewake", 20, record("second", true)))

      yield* inbox.drain(SessionID.descending())
      expect(yield* Ref.get(order)).toEqual(["first", "second"])
    }),
  )

  it.instance("coalesces nudges that arrive during a drain into one re-run", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const claims = yield* Ref.make(0)
      yield* inbox.register(
        source("goal.continue", 10, () =>
          Effect.gen(function* () {
            yield* Ref.update(claims, (n) => n + 1)
            yield* Deferred.succeed(started, void 0).pipe(Effect.ignore)
            yield* Deferred.await(gate)
            return true
          }),
        ),
      )
      const sessionID = SessionID.descending()
      const running = yield* inbox.drain(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      for (let i = 0; i < 100; i++) yield* inbox.drain(sessionID)
      yield* Deferred.succeed(gate, void 0)
      yield* Fiber.join(running)
      // One running pass plus exactly one coalesced re-run, not 101.
      expect(yield* Ref.get(claims)).toBe(2)
    }),
  )

  it.instance("routes a nudge to the loaded instance that owns the session directory", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      const ambient = yield* InstanceRef
      if (!ambient) throw new Error("test instance missing")
      const claims = yield* Ref.make<Readonly<Record<string, number>>>({ a: 0, b: 0 })
      const bump = (which: "a" | "b") =>
        Ref.update(claims, (current) => ({ ...current, [which]: current[which] + 1 })).pipe(Effect.as(true))
      const tag = SessionID.descending()
      const contextA = context(`${nextDirectory(`${tag}-a`)}`)
      const contextB = context(`${nextDirectory(`${tag}-b`)}`)

      yield* inbox
        .register(source("goal.continue", 10, () => bump("a")))
        .pipe(Effect.provideService(InstanceRef, contextA))
      yield* inbox
        .register(source("goal.continue", 10, () => bump("b")))
        .pipe(Effect.provideService(InstanceRef, contextB))
      yield* inbox.init().pipe(Effect.provideService(InstanceRef, contextA))
      yield* inbox.init().pipe(Effect.provideService(InstanceRef, contextB))

      // No durable session row exists, so the ambient instance decides.
      yield* inbox.nudge(SessionID.descending()).pipe(Effect.provideService(InstanceRef, contextB))
      expect(yield* Ref.get(claims)).toEqual({ a: 0, b: 1 })
    }),
  )

  it.effect("the 30s tick rescans durable ledgers and forces a missed claim", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      const ctx = context(nextDirectory("tick"))
      const sessionID = SessionID.descending()
      const claims = yield* Ref.make<ReadonlyArray<SessionID>>([])
      const scans = yield* Ref.make(0)
      yield* inbox
        .register(
          source(
            "goal.continue",
            10,
            (sid) => Ref.update(claims, (seen) => [...seen, sid]).pipe(Effect.as(true)),
            {
              // A stale in-memory hint (possible after a restart): the idle
              // boundary skips the claim, the durable scan must not.
              hint: () => false,
              scan: () => Ref.updateAndGet(scans, (n) => n + 1).pipe(Effect.as([sessionID])),
            },
          ),
        )
        .pipe(Effect.provideService(InstanceRef, ctx))
      yield* inbox.init().pipe(Effect.provideService(InstanceRef, ctx))

      yield* inbox.drain(sessionID).pipe(Effect.provideService(InstanceRef, ctx))
      expect(yield* Ref.get(claims)).toEqual([])

      yield* TestClock.adjust("30 seconds")
      yield* drainFibers
      expect(yield* Ref.get(scans)).toBe(1)
      expect(yield* Ref.get(claims)).toEqual([sessionID])
    }),
  )

  it.effect("a nudge without a durable row or an ambient instance is a no-op", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      yield* inbox.nudge(SessionID.descending())
    }),
  )

  it.instance("submit reports the admission port as not wired and rejects turn_boundary", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      const sessionID = SessionID.descending()
      const missing = yield* Effect.flip(inbox.submit("goal.continue", sessionID, {}))
      expect(missing._tag).toBe("SessionInboxNotWired")

      yield* inbox.register(source("hook.rewake", 10, () => Effect.succeed(true), { mode: "turn_boundary" }))
      const unsupported = yield* Effect.flip(inbox.submit("hook.rewake", sessionID, {}))
      expect(unsupported._tag).toBe("SessionInboxUnsupportedDeliveryPolicy")

      yield* inbox.register(source("child.result", 10, () => Effect.succeed(true), { mode: "join_or_start" }))
      const unwired = yield* Effect.flip(
        inbox.submit("child.result", sessionID, { idempotencyKey: "key", noReply: true }),
      )
      expect(unwired._tag).toBe("SessionInboxNotWired")
    }),
  )
})