// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * The L3 DAG-mode reminder (#1031 M2): one tail note per user-authored turn
 * while the mode is on.
 *
 * The note is static, but the condition to send it is evaluated once per turn
 * and kept: `/dag-mode` can run inside an active turn, and a switch must take
 * effect on the next user turn, not mid-turn. The request assembly appends the
 * text as a request-only part of the current user message, after the todo
 * reminder, so persisted transcripts never carry it.
 *
 * Automated user-role turns (DAG result deliveries, workflow wakes, node
 * mailbox messages, goal continuations) and local command exchanges never get
 * the note; a genuine message keeps at least one user-authored part.
 *
 * State is per instance and cleaned on instance disposal or session deletion.
 */
import { SessionV1 } from "@graphagent/core/v1/session"
import { Context, Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { DagMode } from "@/dag/mode"
import { MessageV2 } from "./message-v2"
import { SessionID, type MessageID } from "./schema"

type Turn = {
  readonly messageID: MessageID
  readonly text: string
}

type State = Map<SessionID, Turn>

export interface Interface {
  /** Reminder text for the current turn, or undefined when none applies. */
  readonly forRequest: (input: {
    sessionID: SessionID
    messages: SessionV1.WithParts[]
    /** The mode, session and publication conditions when the turn is first seen. */
    eligible: boolean
  }) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/SessionDagModeReminder") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("DagModeReminder.state")(function* () {
        const turns: State = new Map()
        // The subscription lives with the per-directory state, so an event is
        // handled in that directory's instance context. Disposal unsubscribes
        // and clears every stored reminder.
        yield* Effect.acquireRelease(
          events.listen((event) => {
            if (event.type !== SessionV1.Event.Deleted.type) return Effect.void
            const data = event.data
            if (typeof data !== "object" || data === null || !("sessionID" in data)) return Effect.void
            if (typeof data.sessionID !== "string") return Effect.void
            turns.delete(SessionID.make(data.sessionID))
            return Effect.void
          }),
          (unsubscribe) => unsubscribe,
        )
        yield* Effect.addFinalizer(() => Effect.sync(() => turns.clear()))
        return turns
      }),
    )

    const forRequest: Interface["forRequest"] = Effect.fn("DagModeReminder.forRequest")(function* (input) {
      const turns = yield* InstanceState.get(state)
      // A local command exchange is presentation state, not the user's turn;
      // `latestUser` skips it so the mode switch does not consume the latch.
      const current = MessageV2.latestUser(input.messages)
      if (!current) return undefined

      const previous = turns.get(input.sessionID)
      // Exactly one turn entry per session: a newer user turn replaces the old
      // one, so no earlier reminder survives into this request.
      if (previous && previous.messageID !== current.info.id) turns.delete(input.sessionID)

      if (!turns.has(input.sessionID)) {
        const authored =
          !MessageV2.isLocalCommand(current) && !MessageV2.isAutomationMessage(current)
        turns.set(input.sessionID, {
          messageID: current.info.id,
          text: input.eligible && authored ? DagMode.REMINDER : "",
        })
      }

      const active = turns.get(input.sessionID)
      if (!active || active.messageID !== current.info.id || !active.text) return undefined
      return active.text
    })

    return Service.of({ forRequest })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2Bridge.defaultLayer))

export * as DagModeReminder from "./dag-mode-reminder"