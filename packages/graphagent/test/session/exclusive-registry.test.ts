// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Option } from "effect"
import { EngineProcess, ExclusiveRegistry } from "@/session/engine-process"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// The registry keeps its state per layer build, like the lease it replaces,
// and no longer depends on SessionStatus (Issue #1021, PR2): the dag-release
// re-trigger reaches the session inbox through the process nudge hook, which
// the nudge tests install directly.
const it = testEffect(ExclusiveRegistry.defaultLayer)

describe("ExclusiveRegistry", () => {
  it.live("durable Goal authority overrides stale register and unregister observations", () =>
    Effect.gen(function* () {
      const lease = yield* ExclusiveRegistry.Service
      const sessionID = SessionID.descending()
      let activeID: string | undefined = "current-goal"
      yield* lease.installGoalAuthority(() => Effect.sync(() => activeID))
      yield* lease.register(sessionID, { kind: "goal", id: "old-goal" })
      expect(Option.isNone(yield* lease.claim(sessionID, { kind: "goal", id: "old-goal" }))).toBe(true)
      const current = { kind: "goal" as const, id: "current-goal" }
      expect(Option.isSome(yield* lease.claim(sessionID, current))).toBe(true)
      yield* lease.unregister(sessionID, current)
      expect(Option.isSome(yield* lease.claim(sessionID, current))).toBe(true)
      activeID = undefined
      expect(Option.isNone(yield* lease.claim(sessionID, current))).toBe(true)
    }),
  )

  it.live("authority read failure blocks admission without erasing the last registration", () =>
    Effect.gen(function* () {
      const lease = yield* ExclusiveRegistry.Service
      const sessionID = SessionID.descending()
      const goal = { kind: "goal" as const, id: "current-goal" }
      let unavailable = false
      yield* lease.installGoalAuthority(() =>
        Effect.suspend(() => (unavailable ? Effect.die("durable read failed") : Effect.succeed(goal.id))),
      )
      yield* lease.register(sessionID, goal)
      const before = Option.getOrThrow(yield* lease.claim(sessionID, goal))
      unavailable = true
      expect(Exit.isFailure(yield* lease.claim(sessionID, goal).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* lease.register(sessionID, { kind: "goal", id: "stale" }).pipe(Effect.exit))).toBe(
        true,
      )
      expect(Exit.isFailure(yield* lease.use(before, Effect.void).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* lease.handoff(before, Effect.succeed(Option.none())).pipe(Effect.exit))).toBe(true)
      unavailable = false
      const after = Option.getOrThrow(yield* lease.claim(sessionID, goal))
      expect(after.generation).toBe(before.generation)
      expect(Option.isSome(yield* lease.use(before, Effect.void))).toBe(true)
    }),
  )

  it.live("rejects a second different durable authority in the same shared lease", () =>
    Effect.gen(function* () {
      const lease = yield* ExclusiveRegistry.Service
      const first = () => Effect.succeed("first")
      yield* lease.installGoalAuthority(first)
      const second = yield* lease.installGoalAuthority(() => Effect.succeed("second")).pipe(Effect.exit)
      expect(Exit.isFailure(second)).toBe(true)
      // A rejected installation must not replace the original resolver.
      const sessionID = SessionID.descending()
      expect(Option.isSome(yield* lease.claim(sessionID, { kind: "goal", id: "first" }))).toBe(true)
    }),
  )

  it.live("scope disposal removes the authority closure and Goal registrations while preserving DAG ownership", () =>
    Effect.gen(function* () {
      const lease = yield* ExclusiveRegistry.Service
      const sessionID = SessionID.descending()
      const goal = { kind: "goal" as const, id: "old-goal" }
      const dag = { kind: "dag" as const, id: "dag" }
      let reads = 0
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lease.installGoalAuthority(() =>
            Effect.sync(() => {
              reads += 1
              return goal.id
            }),
          )
          yield* lease.register(sessionID, goal)
          yield* lease.register(sessionID, dag)
          expect(Option.isSome(yield* lease.claim(sessionID, { kind: "dag" }))).toBe(true)
        }),
      )
      const before = reads
      expect(Option.isSome(yield* lease.claim(sessionID, { kind: "dag" }))).toBe(true)
      yield* lease.unregister(sessionID, dag)
      expect(Option.isNone(yield* lease.claim(sessionID, goal))).toBe(true)
      // Independent lease fixtures retain their explicit-registration semantics.
      yield* lease.register(sessionID, { kind: "goal", id: "fixture-goal" })
      expect(Option.isSome(yield* lease.claim(sessionID, { kind: "goal", id: "fixture-goal" }))).toBe(true)
      expect(reads).toBe(before)
    }),
  )

  it.instance("DAG registration preempts Goal and invalidates its generation", () =>
    Effect.gen(function* () {
      const lease = yield* ExclusiveRegistry.Service
      const sessionID = SessionID.descending()
      const goal = { kind: "goal" as const, id: "goal-1" }
      const dag = { kind: "dag" as const, id: "dag-1" }

      yield* lease.register(sessionID, goal)
      const goalToken = Option.getOrThrow(yield* lease.claim(sessionID, goal))
      yield* lease.register(sessionID, dag)

      expect(Option.isNone(yield* lease.use(goalToken, Effect.succeed("goal")))).toBe(true)
      const dagToken = Option.getOrThrow(yield* lease.claim(sessionID, { kind: "dag" }))
      expect(Option.getOrThrow(yield* lease.use(dagToken, Effect.succeed("dag")))).toBe("dag")
    }),
  )

  it.instance("DAG cannot claim before a Goal fenced commit finishes", () =>
    Effect.gen(function* () {
      const lease = yield* ExclusiveRegistry.Service
      const sessionID = SessionID.descending()
      const goal = { kind: "goal" as const, id: "goal-1" }
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let dagClaimedBeforeCommit = false

      yield* lease.register(sessionID, goal)
      const token = Option.getOrThrow(yield* lease.claim(sessionID, goal))
      const commit = yield* lease
        .use(token, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.forkChild)

      yield* Deferred.await(entered)
      const dag = yield* Effect.gen(function* () {
        yield* lease.register(sessionID, { kind: "dag", id: "dag-1" })
        dagClaimedBeforeCommit = Option.isSome(yield* lease.claim(sessionID, { kind: "dag" }))
      }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(dagClaimedBeforeCommit).toBe(false)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(commit)
      yield* Fiber.join(dag)
      expect(dagClaimedBeforeCommit).toBe(true)
    }),
  )

  it.instance("handoff activates outside the fence", () =>
    Effect.gen(function* () {
      const lease = yield* ExclusiveRegistry.Service
      const sessionID = SessionID.descending()
      const goal = { kind: "goal" as const, id: "goal-1" }
      const activationEntered = yield* Deferred.make<void>()
      const releaseActivation = yield* Deferred.make<void>()

      yield* lease.register(sessionID, goal)
      const token = Option.getOrThrow(yield* lease.claim(sessionID, goal))
      const handoff = yield* lease
        .handoff(
          token,
          Effect.succeed(
            Option.some({
              activate: Deferred.succeed(activationEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseActivation)),
              ),
              result: Effect.void,
              abort: Effect.void,
            }),
          ),
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(activationEntered)
      yield* lease.register(sessionID, { kind: "dag", id: "dag-1" }).pipe(
        Effect.timeoutOrElse({
          duration: "250 millis",
          orElse: () => Effect.die("activation still held the automation fence"),
        }),
        Effect.ensuring(Deferred.succeed(releaseActivation, undefined)),
      )
      expect(Option.isSome(yield* lease.claim(sessionID, { kind: "dag" }))).toBe(true)
      yield* Fiber.join(handoff)
    }),
  )

  it.instance("handoff activation survives interruption", () =>
    Effect.gen(function* () {
      const lease = yield* ExclusiveRegistry.Service
      const sessionID = SessionID.descending()
      const goal = { kind: "goal" as const, id: "goal-1" }
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let activated = false
      let aborted = false

      yield* lease.register(sessionID, goal)
      const token = Option.getOrThrow(yield* lease.claim(sessionID, goal))
      const handoff = yield* lease
        .handoff(
          token,
          Effect.succeed(
            Option.some({
              activate: Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.sync(() => (activated = true))),
              ),
              result: Effect.void,
              abort: Effect.sync(() => (aborted = true)),
            }),
          ),
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(entered)
      const interrupted = yield* Fiber.interrupt(handoff).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interrupted)
      expect({ activated, aborted }).toEqual({ activated: true, aborted: false })
    }),
  )

  it.instance("handoff interruption cancels a blocked preparation and releases the fence", () =>
    Effect.gen(function* () {
      const lease = yield* ExclusiveRegistry.Service
      const sessionID = SessionID.descending()
      const goal = { kind: "goal" as const, id: "goal-1" }
      const entered = yield* Deferred.make<void>()
      let finalized = false

      yield* lease.register(sessionID, goal)
      const token = Option.getOrThrow(yield* lease.claim(sessionID, goal))
      const handoff = yield* lease
        .handoff(
          token,
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => (finalized = true))),
          ),
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(entered)
      yield* Fiber.interrupt(handoff)
      yield* lease.register(sessionID, { kind: "dag", id: "dag-1" }).pipe(
        Effect.timeoutOrElse({
          duration: "250 millis",
          orElse: () => Effect.die("interrupted preparation retained the automation fence"),
        }),
      )
      expect(finalized).toBe(true)
    }),
  )

  it.instance("Goal becomes owner again after the final DAG unregisters", () =>
    Effect.gen(function* () {
      const lease = yield* ExclusiveRegistry.Service
      const sessionID = SessionID.descending()
      const goal = { kind: "goal" as const, id: "goal-1" }
      const first = { kind: "dag" as const, id: "dag-1" }
      const second = { kind: "dag" as const, id: "dag-2" }

      yield* lease.register(sessionID, goal)
      yield* lease.register(sessionID, first)
      yield* lease.register(sessionID, second)
      yield* lease.unregister(sessionID, first)
      expect(Option.isSome(yield* lease.claim(sessionID, { kind: "dag" }))).toBe(true)

      yield* lease.unregister(sessionID, second)
      expect(Option.isSome(yield* lease.claim(sessionID, goal))).toBe(true)
    }),
  )

  // Issue #1021 PR2 (3c): the dag-release re-trigger travels through the
  // session inbox's process nudge, replacing the old lease's synthetic
  // `set idle`. The obligation is consumed exactly once, even when several
  // dags release back-to-back (only the LAST one flips the owner).
  it.instance("a blocked goal claim is nudged exactly once when the final DAG releases", () =>
    Effect.gen(function* () {
      const lease = yield* ExclusiveRegistry.Service
      const nudged: string[] = []
      const previous = EngineProcess.inbox.nudge
      EngineProcess.inbox.nudge = (sessionID) =>
        Effect.sync(() => {
          nudged.push(String(sessionID))
        })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (EngineProcess.inbox.nudge) EngineProcess.inbox.nudge = previous
        }),
      )

      const sessionID = SessionID.descending()
      yield* lease.register(sessionID, { kind: "dag", id: "dag-1" })
      yield* lease.register(sessionID, { kind: "dag", id: "dag-2" })
      // A goal claim rejected by the dag records the blocked obligation.
      expect(Option.isNone(yield* lease.claim(sessionID, { kind: "goal", id: "goal-1" }))).toBe(true)

      // The first release leaves a DAG owner and must not consume the retry.
      yield* lease.unregister(sessionID, { kind: "dag", id: "dag-1" })
      expect(nudged).toEqual([])

      // The final release nudges exactly once.
      yield* lease.unregister(sessionID, { kind: "dag", id: "dag-2" })
      expect(nudged).toEqual([String(sessionID)])

      // Consumed: an idempotent release cannot duplicate the re-trigger.
      yield* lease.unregister(sessionID, { kind: "dag", id: "dag-2" })
      expect(nudged).toEqual([String(sessionID)])
    }),
  )

  it.instance("a release without a blocked claim never nudges the inbox", () =>
    Effect.gen(function* () {
      const lease = yield* ExclusiveRegistry.Service
      let nudges = 0
      const previous = EngineProcess.inbox.nudge
      EngineProcess.inbox.nudge = () =>
        Effect.sync(() => {
          nudges += 1
        })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (EngineProcess.inbox.nudge) EngineProcess.inbox.nudge = previous
        }),
      )

      const sessionID = SessionID.descending()
      // A successful goal claim clears any retry obligation.
      yield* lease.register(sessionID, { kind: "goal", id: "goal-1" })
      expect(Option.isSome(yield* lease.claim(sessionID, { kind: "goal", id: "goal-1" }))).toBe(true)
      yield* lease.register(sessionID, { kind: "dag", id: "dag-1" })
      yield* lease.unregister(sessionID, { kind: "dag", id: "dag-1" })
      expect(nudges).toBe(0)
    }),
  )

  it.instance("generation changes on every registration and validate rejects a stale DAG claim", () =>
    Effect.gen(function* () {
      const lease = yield* ExclusiveRegistry.Service
      const sessionID = SessionID.descending()
      yield* lease.register(sessionID, { kind: "dag", id: "dag-1" })
      const observed = yield* lease.generation(sessionID)
      expect(observed).toBeGreaterThan(0)
      expect(yield* lease.validate(sessionID, observed)).toBe(true)

      // Claim, then register a competing dag before the admission commits:
      // the recorded generation is stale and the claim must not commit.
      const token = Option.getOrThrow(yield* lease.claim(sessionID, { kind: "dag" }))
      yield* lease.register(sessionID, { kind: "dag", id: "dag-2" })
      expect(yield* lease.validate(sessionID, observed)).toBe(false)
      expect(Option.isNone(yield* lease.use(token, Effect.void))).toBe(true)

      // Goal-owned sessions have no DAG generation to validate.
      const goalOnly = SessionID.descending()
      yield* lease.register(goalOnly, { kind: "goal", id: "goal-1" })
      expect(yield* lease.validate(goalOnly, yield* lease.generation(goalOnly))).toBe(false)
    }),
  )

  it.instance("purgeSession drops registrations and the blocked retry obligation", () =>
    Effect.gen(function* () {
      const lease = yield* ExclusiveRegistry.Service
      let nudges = 0
      const previous = EngineProcess.inbox.nudge
      EngineProcess.inbox.nudge = () =>
        Effect.sync(() => {
          nudges += 1
        })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (EngineProcess.inbox.nudge) EngineProcess.inbox.nudge = previous
        }),
      )

      const sessionID = SessionID.descending()
      yield* lease.register(sessionID, { kind: "goal", id: "goal-1" })
      yield* lease.register(sessionID, { kind: "dag", id: "dag-1" })
      expect(Option.isNone(yield* lease.claim(sessionID, { kind: "goal", id: "goal-1" }))).toBe(true)

      yield* lease.purgeSession(sessionID)
      expect(Option.isNone(yield* lease.claim(sessionID, { kind: "dag" }))).toBe(true)
      expect(Option.isNone(yield* lease.claim(sessionID, { kind: "goal", id: "goal-1" }))).toBe(true)
      // The deleted session must not re-trigger a goal on a late release.
      yield* lease.unregister(sessionID, { kind: "dag", id: "dag-1" })
      expect(nudges).toBe(0)
    }),
  )
})
