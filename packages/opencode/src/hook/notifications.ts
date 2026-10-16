import { Effect, Option } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LegacyEvent } from "@opencode-ai/schema/legacy-event"
import { SessionID } from "@/session/schema"

/** Ephemeral UI notifications; clients may ignore them in non-interactive runs. */
export const HookNotification = {
  status: (sessionID: string, hookID: string, statusMessage: string, phase: "started" | "finished") =>
    Effect.gen(function* () {
      const events = Option.getOrUndefined(yield* Effect.serviceOption(EventV2Bridge.Service))
      if (events)
        yield* events.publish(LegacyEvent.HookStatus, {
          sessionID: SessionID.make(sessionID),
          hookID,
          statusMessage,
          phase,
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
