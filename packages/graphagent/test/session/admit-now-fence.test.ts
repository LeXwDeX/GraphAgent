// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the admission port is a narrow stub; the unstarted turn handle stands in for a real one

// Issue #1026 PR3a: `admitNowUnderFence`, the `join_or_start` sibling of
// `admitIdleUnderFence` (see admit-fence.test.ts). The fence is the
// cancellation epoch the caller observed at its claim: a stale epoch must not
// reach admission (nothing is committed), an unchanged one admits under a
// request the fence registered and releases, and an ESC that lands during the
// admission ends it as `cancelled` instead of failing the caller.
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { SessionCancellation } from "@/session/cancellation"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { AdmissionPersistFailed } from "@/session/turn/prepare"
import type { AdmissionExtras, TurnStart } from "@/session/turns"
import { it } from "../lib/effect"

const input = (sessionID: SessionID): SessionPrompt.PromptInput => ({
  sessionID,
  parts: [{ type: "text", text: "a child result", synthetic: true }],
})

const started = { admission: { kind: "started", turn: undefined as never }, wait: Effect.void } as unknown as TurnStart
const ORIGIN = { kind: "inbox", source: "child.result", key: "crun_1" } as const

/** An admission port that records what the fence handed it. */
const port = (admit: (extras: AdmissionExtras | undefined) => Effect.Effect<TurnStart>) => {
  const seen: Array<AdmissionExtras | undefined> = []
  const service: Pick<SessionPrompt.Interface, "admit"> = {
    admit: (_input, _options, _persist, extras) => {
      seen.push(extras)
      return admit(extras)
    },
  }
  return { service, seen }
}

describe("admitNowUnderFence", () => {
  it.effect("a stale claim epoch returns cancelled without reaching the admission port", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.descending()
      const observed = SessionCancellation.epoch(sessionID)
      SessionCancellation.begin(sessionID).finish()
      const { service, seen } = port(() => Effect.succeed(started))

      const admitted = yield* SessionPrompt.admitNowUnderFence(
        service,
        input(sessionID),
        undefined,
        undefined,
        observed,
      )

      expect(admitted).toEqual({ tag: "cancelled" })
      expect(seen).toEqual([])
    }),
  )

  it.effect("an unchanged epoch admits under the registered request and the origin, then releases the request", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.descending()
      const observed = SessionCancellation.epoch(sessionID)
      const { service, seen } = port(() => Effect.succeed(started))

      const admitted = yield* SessionPrompt.admitNowUnderFence(
        service,
        input(sessionID),
        { continueToolBudget: true },
        Effect.void,
        observed,
        ORIGIN,
      )

      expect(admitted).toEqual({ tag: "admitted", start: started })
      expect(seen).toHaveLength(1)
      expect(seen[0]?.origin).toEqual(ORIGIN)
      // The request the port ran under was valid then and is spent now: the fence released it.
      expect(seen[0]?.request?.epoch).toBe(observed)
      expect(seen[0]?.request?.valid()).toBe(false)
    }),
  )

  it.effect("no claim epoch keeps the unfenced request behavior", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.descending()
      SessionCancellation.begin(sessionID).finish()
      const { service, seen } = port(() => Effect.succeed(started))

      const admitted = yield* SessionPrompt.admitNowUnderFence(service, input(sessionID))

      expect(admitted.tag).toBe("admitted")
      expect(seen).toHaveLength(1)
      expect(seen[0]?.origin).toBeUndefined()
      expect(seen[0]?.request?.epoch).toBe(SessionCancellation.epoch(sessionID))
    }),
  )

  it.effect("an ESC that lands during the admission ends it as cancelled", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.descending()
      const observed = SessionCancellation.epoch(sessionID)
      // What `Turns.start` does when its request lost the epoch: it interrupts its own fiber.
      const { service } = port((extras) =>
        Effect.suspend(() => {
          SessionCancellation.begin(sessionID).finish()
          return extras?.request?.valid() ? Effect.succeed(started) : Effect.interrupt
        }),
      )

      const admitted = yield* SessionPrompt.admitNowUnderFence(
        service,
        input(sessionID),
        undefined,
        undefined,
        observed,
      )

      expect(admitted).toEqual({ tag: "cancelled" })
    }),
  )

  it.effect("an interruption the fence did not cause is not absorbed", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.descending()
      const observed = SessionCancellation.epoch(sessionID)
      const { service } = port(() => Effect.interrupt)

      const exit = yield* SessionPrompt.admitNowUnderFence(
        service,
        input(sessionID),
        undefined,
        undefined,
        observed,
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    }),
  )

  it.effect("an admission failure reaches the caller, and the request is still released", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.descending()
      const observed = SessionCancellation.epoch(sessionID)
      const failure = new AdmissionPersistFailed({ cause: "the mark lost" })
      const { service, seen } = port(() => Effect.fail(failure) as never)

      const exit = yield* SessionPrompt.admitNowUnderFence(
        service,
        input(sessionID),
        undefined,
        undefined,
        observed,
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure)
      expect(seen[0]?.request?.valid()).toBe(false)
    }),
  )
})
