// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import * as TestClock from "effect/testing/TestClock"
import type { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionCancellation } from "@/session/cancellation"
import { SessionInbox, type InboxItem, type InboxSource, type InboxSourceContext } from "@/session/inbox"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import type { TurnStart } from "@/session/turns"
import { SessionStatus } from "@/session/status"
import type { InstanceContext } from "@/project/instance-context"
import { it as bare, pollWithTimeout, testEffect } from "../lib/effect"

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
  // provideMerge exposes the same status instance the inbox gates with, so
  // claim tests can move the session between idle and busy.
  Layer.provideMerge(SessionStatus.defaultLayer),
)
const it = testEffect(layer)

// Let TestClock-resumed fibers run. `adjust` only wakes sleepers; the resumed
// work runs on the next scheduler ticks.
const drainFibers = Effect.gen(function* () {
  for (let i = 0; i < 15; i++) yield* Effect.yieldNow
})

// Wait for an observable result instead of a fixed number of scheduler turns.
// The tick forks each session's drain, so the pass ending says nothing about
// the claims having run. Bounded in scheduler turns, never in wall time, so it
// also holds under TestClock.
const until = (done: Effect.Effect<boolean>, message: string) =>
  Effect.gen(function* () {
    let turns = 0
    while (!(yield* done)) {
      if (++turns > 500) yield* Effect.fail(new Error(message))
      yield* Effect.yieldNow
    }
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
          source("goal.continue", 10, (sid) => Ref.update(claims, (seen) => [...seen, sid]).pipe(Effect.as(true)), {
            // A stale in-memory hint (possible after a restart): the idle
            // boundary skips the claim, the durable scan must not.
            hint: () => false,
            scan: () => Ref.updateAndGet(scans, (n) => n + 1).pipe(Effect.as([sessionID])),
          }),
        )
        .pipe(Effect.provideService(InstanceRef, ctx))
      yield* inbox.init().pipe(Effect.provideService(InstanceRef, ctx))

      yield* inbox.drain(sessionID).pipe(Effect.provideService(InstanceRef, ctx))
      expect(yield* Ref.get(claims)).toEqual([])

      yield* TestClock.adjust("30 seconds")
      yield* until(
        Ref.get(claims).pipe(Effect.map((seen) => seen.length === 1)),
        "the tick did not claim the scanned session",
      )
      expect(yield* Ref.get(scans)).toBe(1)
      expect(yield* Ref.get(claims)).toEqual([sessionID])
    }),
  )

  it.effect("the tick forks every scanned session's drain: a held claim blocks neither its pass nor the next tick", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      const ctx = context(nextDirectory("tick-fork"))
      const held = SessionID.descending()
      const free = SessionID.descending()
      const late = SessionID.descending()
      const gate = yield* Deferred.make<void>()
      const started = yield* Ref.make<ReadonlyArray<SessionID>>([])
      const scanned = yield* Ref.make<ReadonlyArray<SessionID>>([held, free])
      const startsOf = (sessionID: SessionID) =>
        Ref.get(started).pipe(Effect.map((seen) => seen.filter((sid) => sid === sessionID).length))
      yield* inbox
        .register(
          // A long model turn: the claim for `held` does not return until the
          // gate opens. Every other session's claim returns at once.
          source(
            "goal.continue",
            10,
            (sid) =>
              Ref.update(started, (seen) => [...seen, sid]).pipe(
                Effect.andThen(sid === held ? Deferred.await(gate) : Effect.void),
                Effect.as(true),
              ),
            { hint: () => false, scan: () => Ref.get(scanned) },
          ),
        )
        .pipe(Effect.provideService(InstanceRef, ctx))
      yield* inbox.init().pipe(Effect.provideService(InstanceRef, ctx))

      // Tick 1 scans `held` first, and its claim never returns. `free`, later
      // in the same pass, is still claimed.
      yield* TestClock.adjust("30 seconds")
      yield* until(
        startsOf(free).pipe(Effect.map((count) => count === 1)),
        "the held claim kept the rest of its pass from running",
      )
      expect(yield* startsOf(held)).toBe(1)

      // Tick 2 still runs while `held` is in flight and claims a new session.
      yield* Ref.set(scanned, [held, free, late])
      yield* TestClock.adjust("30 seconds")
      yield* until(
        startsOf(late).pipe(Effect.map((count) => count === 1)),
        "the held claim kept the next tick from running",
      )
      // `held` was scanned again, but its drain is in flight: the request is
      // folded into one extra pass instead of a concurrent claim. `free`'s
      // earlier drain had ended, so it ran a fresh one.
      expect(yield* startsOf(held)).toBe(1)
      expect(yield* startsOf(free)).toBe(2)

      // The long turn ends: the folded request runs as exactly one more pass.
      yield* Deferred.succeed(gate, void 0)
      yield* until(
        startsOf(held).pipe(Effect.map((count) => count === 2)),
        "the folded tick request did not run after the held claim ended",
      )
      yield* drainFibers
      expect(yield* startsOf(held)).toBe(2)
    }),
  )

  bare.effect("closing the instance interrupts a tick drain that is still waiting on its claim", () =>
    Effect.gen(function* () {
      const ctx = context(nextDirectory("tick-dispose"))
      const sessionID = SessionID.descending()
      const started = yield* Ref.make(false)
      const interrupted = yield* Ref.make<ReadonlyArray<SessionID>>([])
      // The inbox lives only inside this block: its layer scope closes when
      // the block ends, which is how an instance is disposed.
      yield* Effect.gen(function* () {
        const inbox = yield* SessionInbox.Service
        yield* inbox
          .register(
            source(
              "goal.continue",
              10,
              (sid) =>
                Ref.set(started, true).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Ref.update(interrupted, (seen) => [...seen, sid])),
                ),
              { scan: () => Effect.succeed([sessionID]) },
            ),
          )
          .pipe(Effect.provideService(InstanceRef, ctx))
        yield* inbox.init().pipe(Effect.provideService(InstanceRef, ctx))
        yield* TestClock.adjust("30 seconds")
        yield* until(Ref.get(started), "the tick never started the claim")
        expect(yield* Ref.get(interrupted)).toEqual([])
      }).pipe(Effect.provide(layer))
      expect(yield* Ref.get(interrupted)).toEqual([sessionID])
    }),
  )

  it.effect("a nudge without a durable row or an ambient instance is a no-op", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      yield* inbox.nudge(SessionID.descending())
    }),
  )

  it.instance("pullForStep is conservative across registered step sources", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      const sessionID = SessionID.descending()
      // The built-in async-context step is a "maybe" on its own: no source can
      // prove emptiness before every hint answers explicitly.
      expect(yield* inbox.pullForStep(sessionID)).toBe(true)

      // One explicit "empty" cannot outvote the built-in conservative hint.
      yield* inbox.registerStep({ id: "dag.mailbox.step", hint: () => false })
      expect(yield* inbox.pullForStep(sessionID)).toBe(true)

      // Only when every registered source answers "empty" is the session
      // provably empty.
      yield* inbox.registerStep({ id: "hook.async_context", hint: () => false })
      expect(yield* inbox.pullForStep(sessionID)).toBe(false)

      // A throwing hint is unknown, not empty.
      yield* inbox.registerStep({
        id: "dag.mailbox.step",
        hint: () => {
          throw new Error("hint failed")
        },
      })
      expect(yield* inbox.pullForStep(sessionID)).toBe(true)

      // A later registration for the same id replaces the previous hint.
      yield* inbox.registerStep({ id: "dag.mailbox.step", hint: () => false })
      expect(yield* inbox.pullForStep(sessionID)).toBe(false)
    }),
  )

  it.instance("step sources never claim or subscribe", () =>
    Effect.gen(function* () {
      subscribeCalls = 0
      const inbox = yield* SessionInbox.Service
      const claims = yield* Ref.make(0)
      const sessionID = SessionID.descending()
      // Loading the per-instance state arms the inbox's single idle
      // subscription; that baseline is unrelated to step sources.
      expect(yield* inbox.pullForStep(sessionID)).toBe(true)
      const baseline = subscribeCalls
      yield* inbox.registerStep({ id: "dag.mailbox.step", hint: () => true })
      yield* inbox.register(source("goal.continue", 10, () => Ref.update(claims, (n) => n + 1).pipe(Effect.as(true))))
      yield* inbox.drain(sessionID)
      expect(yield* Ref.get(claims)).toBe(1)
      expect(yield* inbox.pullForStep(sessionID)).toBe(true)
      expect(yield* Ref.get(claims)).toBe(1)
      expect(subscribeCalls).toBe(baseline)
    }),
  )

  it.instance("idle_only sources do not claim into a running turn", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      const status = yield* SessionStatus.Service
      const claims = yield* Ref.make(0)
      yield* inbox.register(source("goal.continue", 10, () => Ref.update(claims, (n) => n + 1).pipe(Effect.as(true))))
      const sessionID = SessionID.descending()
      yield* status.set(sessionID, { type: "busy" })
      yield* inbox.drain(sessionID)
      expect(yield* Ref.get(claims)).toBe(0)

      // The idle transition itself drives the drain through the subscription;
      // the inbox treats that event as the idle proof for the pass.
      yield* status.set(sessionID, { type: "idle" })
      yield* pollWithTimeout(
        Ref.get(claims).pipe(Effect.map((n) => (n === 1 ? n : undefined))),
        "idle transition did not claim",
      )
      expect(yield* Ref.get(claims)).toBe(1)
    }),
  )

  it.effect("the forced tick still honors the idle_only gate", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      const status = yield* SessionStatus.Service
      const ctx = context(nextDirectory("idle-gate"))
      const sessionID = SessionID.descending()
      const claims = yield* Ref.make<ReadonlyArray<SessionID>>([])
      yield* inbox
        .register(
          source("goal.continue", 10, (sid) => Ref.update(claims, (seen) => [...seen, sid]).pipe(Effect.as(true)), {
            scan: () => Effect.succeed([sessionID]),
          }),
        )
        .pipe(Effect.provideService(InstanceRef, ctx))
      yield* inbox.init().pipe(Effect.provideService(InstanceRef, ctx))

      yield* status.set(sessionID, { type: "busy" }).pipe(Effect.provideService(InstanceRef, ctx))
      yield* TestClock.adjust("30 seconds")
      yield* drainFibers
      expect(yield* Ref.get(claims)).toEqual([])

      yield* status.set(sessionID, { type: "idle" }).pipe(Effect.provideService(InstanceRef, ctx))
      // The idle event claims once (the subscription is the primary trigger)…
      for (let i = 0; i < 50 && (yield* Ref.get(claims)).length === 0; i++) yield* Effect.yieldNow
      expect(yield* Ref.get(claims)).toEqual([sessionID])

      // …and the next forced tick passes the gate again because the session
      // is now idle. The busy tick above proves the gate blocks a forced pass.
      yield* TestClock.adjust("30 seconds")
      yield* until(
        Ref.get(claims).pipe(Effect.map((seen) => seen.length === 2)),
        "the forced tick did not claim once the session was idle",
      )
      expect(yield* Ref.get(claims)).toEqual([sessionID, sessionID])
    }),
  )

  it.instance("submit honors the delivery policy and maps admission outcomes", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      const sessionID = SessionID.descending()

      // No source is registered under that id.
      const missing = yield* Effect.flip(inbox.submit("goal.continue", sessionID, {}))
      expect(missing._tag).toBe("SessionInboxNotWired")

      // `turn_boundary` has no implementation; overriding the built-in rewake
      // source proves the policy rejection.
      yield* inbox.register(source("hook.rewake", 10, () => Effect.succeed(true), { mode: "turn_boundary" }))
      const unsupported = yield* Effect.flip(inbox.submit("hook.rewake", sessionID, {}))
      expect(unsupported._tag).toBe("SessionInboxUnsupportedDeliveryPolicy")

      // `idle_only` sources must go through their drain boundary instead.
      yield* inbox.register(source("goal.continue", 10, () => Effect.succeed(true)))
      const idleOnly = yield* Effect.flip(inbox.submit("goal.continue", sessionID, {}))
      expect(idleOnly._tag).toBe("SessionInboxUnsupportedDeliveryPolicy")

      // A join_or_start source without a prompt payload has nothing to admit.
      yield* inbox.register(source("child.result", 10, () => Effect.succeed(true), { mode: "join_or_start" }))
      const payload = yield* Effect.flip(inbox.submit("child.result", sessionID, { noReply: true }))
      expect(payload._tag).toBe("SessionInboxAdmissionFailed")

      // Ledger-less sources deliver through the built-in rewake source. A
      // submit with no app-layer admission port reports the port as absent.
      yield* inbox.register(source("hook.rewake", 10, () => Effect.succeed(true), { mode: "join_or_start" }))
      const item: InboxItem = {
        prompt: { parts: [{ type: "text", text: "rewake" }] },
        admissionOptions: { continueToolBudget: true },
      }
      const unavailable = yield* Effect.flip(inbox.submit("hook.rewake", sessionID, item))
      expect(unavailable._tag).toBe("SessionInboxAdmissionUnavailable")

      // With an admission port, submit maps the outcome without awaiting the
      // turn: `wait` never resolves here and submit still returns.
      const seen: { input: { sessionID: string; noReply?: boolean }; options?: unknown }[] = []
      const createdAt = 1_700_000_000_000
      const startedID = MessageID.make("msg_started")
      const joinedID = MessageID.make("msg_joined")
      const writtenID = MessageID.make("msg_written")
      const message = (id: MessageID) =>
        ({
          info: { id, sessionID, role: "user", time: { created: createdAt } },
          parts: [{ type: "text", text: "rewake" }],
        }) as never as SessionV1.WithParts
      const start = (admission: TurnStart["admission"], admitted?: SessionV1.WithParts): TurnStart => ({
        admission,
        ...(admitted === undefined ? {} : { message: admitted }),
        wait: Effect.never,
      })
      let outcome = start({ kind: "not_started", reason: "test" })
      const promptMock = Layer.mock(SessionPrompt.Service, {
        admit: (input, options) =>
          Effect.sync(() => {
            seen.push({ input, options })
            return outcome
          }),
      })
      const submit = () => inbox.submit("hook.rewake", sessionID, item).pipe(Effect.provide(promptMock))

      outcome = start({ kind: "started", turn: undefined as never }, message(startedID))
      expect(yield* submit()).toEqual({ state: "started", messageID: startedID, createdAt })
      expect(seen[0].input).toMatchObject({ sessionID, parts: [{ type: "text", text: "rewake" }] })
      expect(seen[0].input.noReply).toBeUndefined()
      expect(seen[0].options).toEqual({ continueToolBudget: true })

      outcome = start({ kind: "joined", turn: undefined as never, messageID: joinedID }, message(joinedID))
      expect(yield* submit()).toEqual({ state: "joined", messageID: joinedID, createdAt })

      // A committed message without a started turn is written, not pending.
      outcome = start({ kind: "not_started", reason: "admission_declined" }, message(writtenID))
      expect(yield* submit()).toEqual({ state: "written", messageID: writtenID, createdAt })

      // `noReply` rides with the prompt.
      expect(
        yield* inbox.submit("hook.rewake", sessionID, { ...item, noReply: true }).pipe(Effect.provide(promptMock)),
      ).toEqual({ state: "written", messageID: writtenID, createdAt })
      expect(seen.at(-1)?.input.noReply).toBe(true)

      outcome = start({ kind: "skipped_busy" })
      expect(yield* submit()).toEqual({ state: "skipped_busy" })

      outcome = start({ kind: "not_started", reason: "test" })
      expect(yield* submit()).toEqual({ state: "pending" })
    }),
  )
})

describe("SessionInbox claim epoch", () => {
  it.instance("passes the claim-time cancellation epoch to the source", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      const sessionID = SessionID.descending()
      const claimed = yield* Ref.make<ReadonlyArray<number>>([])
      yield* inbox.register(
        source("goal.continue", 10, (_sid, ctx) =>
          Ref.update(claimed, (epochs) => [...epochs, ctx.claimEpoch]).pipe(Effect.as(false)),
        ),
      )

      yield* inbox.drain(sessionID)
      expect(yield* Ref.get(claimed)).toEqual([SessionCancellation.epoch(sessionID)])
    }),
  )

  it.instance("a cancellation after the capture fences every source in the same drain", () =>
    Effect.gen(function* () {
      const inbox = yield* SessionInbox.Service
      const sessionID = SessionID.descending()
      const delivered = yield* Ref.make<ReadonlyArray<string>>([])
      const claimed = yield* Ref.make<ReadonlyArray<number>>([])
      // Models a real source: the drain's captured epoch is the only fence a
      // fenced admission may use.
      const attempt = (label: string, cancel: boolean) => (id: SessionID, ctx: InboxSourceContext) =>
        Effect.gen(function* () {
          yield* Ref.update(claimed, (epochs) => [...epochs, ctx.claimEpoch])
          if (cancel) {
            // ESC lands after the drain captured its epoch, before this
            // claim's admission.
            const abort = SessionCancellation.begin(id)
            abort.finish()
          }
          const request = SessionCancellation.requestIfEpoch(id, ctx.claimEpoch)
          if (!request) return false
          request.release()
          yield* Ref.update(delivered, (labels) => [...labels, label])
          return true
        })
      yield* inbox.register(source("goal.continue", 10, attempt("first", true)))
      yield* inbox.register(source("watch_pr", 20, attempt("second", false)))

      yield* inbox.drain(sessionID)
      expect(yield* Ref.get(delivered)).toEqual([])
      const epochs = yield* Ref.get(claimed)
      expect(epochs).toHaveLength(2)
      expect(epochs[0]).toBe(epochs[1])
      expect(SessionCancellation.epoch(sessionID)).toBe(epochs[0] + 1)
    }),
  )
})
