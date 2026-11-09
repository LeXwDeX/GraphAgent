// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect, Option } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LegacyEvent } from "@graphagent/schema/legacy-event"
import { SessionID } from "@/session/schema"
import type { HookEvent } from "./types"

export interface HookStatusInput {
  readonly sessionID: string
  readonly hookID: string
  readonly event: HookEvent
  readonly descriptor: string
  readonly statusMessage?: string
  readonly phase: "started" | "finished" | "cancelled" | "timeout"
  readonly timeoutMs: number
  readonly cancellable: boolean
  readonly startedAt: number
}

/** Ephemeral UI notifications; clients may ignore them in non-interactive runs. */
export const HookNotification = {
  status: (input: HookStatusInput) =>
    Effect.gen(function* () {
      const events = Option.getOrUndefined(yield* Effect.serviceOption(EventV2Bridge.Service))
      if (events)
        yield* events.publish(LegacyEvent.HookStatus, {
          sessionID: SessionID.make(input.sessionID),
          hookID: input.hookID,
          event: input.event,
          descriptor: input.descriptor,
          ...(input.statusMessage === undefined ? {} : { statusMessage: input.statusMessage }),
          phase: input.phase,
          timeoutMs: input.timeoutMs,
          cancellable: input.cancellable,
          startedAt: input.startedAt,
        })
    }),
  terminal: (sessionID: string, sequence: string) =>
    Effect.gen(function* () {
      const events = Option.getOrUndefined(yield* Effect.serviceOption(EventV2Bridge.Service))
      if (events) yield* events.publish(LegacyEvent.HookTerminal, { sessionID: SessionID.make(sessionID), sequence })
    }),
  message: (sessionID: string, message: string) =>
    Effect.gen(function* () {
      const events = Option.getOrUndefined(yield* Effect.serviceOption(EventV2Bridge.Service))
      if (events) yield* events.publish(LegacyEvent.HookMessage, { sessionID: SessionID.make(sessionID), message })
    }),
}
