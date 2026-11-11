// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// Issue #1021 gap 2: an idle admission fenced by the cancellation epoch
// observed at its claim. A stale epoch must not enter prepare (nothing is
// committed); an unchanged epoch keeps the old busy/lease classification.
import { describe, expect } from "bun:test"
import { Effect, Option } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { SessionCancellation } from "@/session/cancellation"
import { ExclusiveRegistry } from "@/session/engine-process"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(ExclusiveRegistry.defaultLayer)

const message = (sessionID: SessionID): SessionV1.WithParts =>
  ({
    info: {
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      time: { created: 1_700_000_000_000 },
    },
    parts: [],
  }) as never

const input = (sessionID: SessionID): SessionPrompt.PromptInput => ({
  sessionID,
  parts: [{ type: "text", text: "continue", synthetic: true }],
})

const promptWith = (prepareTurn: SessionPrompt.Interface["prepareTurn"]): SessionPrompt.Interface =>
  ({ prepareTurn }) as never

const claimToken = (automation: ExclusiveRegistry.Interface, sessionID: SessionID) =>
  Effect.gen(function* () {
    yield* automation.register(sessionID, { kind: "dag", id: "admit-fence" })
    return Option.getOrThrow(yield* automation.claim(sessionID, { kind: "dag" }))
  })

describe("admitIdleUnderFence epoch fence", () => {
  it.effect("a stale claim epoch returns cancelled without entering prepare", () =>
    Effect.gen(function* () {
      const automation = yield* ExclusiveRegistry.Service
      const sessionID = SessionID.descending()
      const token = yield* claimToken(automation, sessionID)
      const observed = SessionCancellation.epoch(sessionID)
      const abort = SessionCancellation.begin(sessionID)
      abort.finish()
      let prepared = 0
      const prompt = promptWith(() =>
        Effect.sync(() => {
          prepared += 1
          return Option.none()
        }),
      )

      const admitted = yield* SessionPrompt.admitIdleUnderFence(
        prompt,
        automation,
        token,
        input(sessionID),
        undefined,
        undefined,
        observed,
      )
      expect(admitted).toEqual({ tag: "cancelled" })
      expect(prepared).toBe(0)
    }),
  )

  it.effect("a declined prepare under an unchanged epoch is skipped", () =>
    Effect.gen(function* () {
      const automation = yield* ExclusiveRegistry.Service
      const sessionID = SessionID.descending()
      const token = yield* claimToken(automation, sessionID)
      const observed = SessionCancellation.epoch(sessionID)
      let prepared = 0
      const prompt = promptWith(() =>
        Effect.sync(() => {
          prepared += 1
          return Option.none()
        }),
      )

      const admitted = yield* SessionPrompt.admitIdleUnderFence(
        prompt,
        automation,
        token,
        input(sessionID),
        undefined,
        undefined,
        observed,
      )
      expect(admitted).toEqual({ tag: "skipped" })
      expect(prepared).toBe(1)
    }),
  )

  it.effect("an admitted prepare returns its turn effect", () =>
    Effect.gen(function* () {
      const automation = yield* ExclusiveRegistry.Service
      const sessionID = SessionID.descending()
      const token = yield* claimToken(automation, sessionID)
      const observed = SessionCancellation.epoch(sessionID)
      const reply = message(sessionID)
      const prompt = promptWith(() =>
        Effect.succeed(
          Option.some({
            turn: undefined,
            run: true,
            message: reply,
            activate: Effect.void,
            result: Effect.succeed(reply),
            abort: Effect.void,
          }),
        ),
      )

      const admitted = yield* SessionPrompt.admitIdleUnderFence(
        prompt,
        automation,
        token,
        input(sessionID),
        undefined,
        undefined,
        observed,
      )
      expect(admitted.tag).toBe("admitted")
      if (admitted.tag !== "admitted") throw new Error("unreachable")
      expect(yield* admitted.turn).toBe(reply)
    }),
  )

  it.effect("no claim epoch keeps the unfenced request behavior", () =>
    Effect.gen(function* () {
      const automation = yield* ExclusiveRegistry.Service
      const sessionID = SessionID.descending()
      const token = yield* claimToken(automation, sessionID)
      let prepared = 0
      const prompt = promptWith(() =>
        Effect.sync(() => {
          prepared += 1
          return Option.none()
        }),
      )

      const admitted = yield* SessionPrompt.admitIdleUnderFence(prompt, automation, token, input(sessionID))
      expect(admitted).toEqual({ tag: "skipped" })
      expect(prepared).toBe(1)
    }),
  )
})
