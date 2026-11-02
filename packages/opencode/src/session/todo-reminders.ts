// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Todo reminder injected at model request assembly (issue #953, replacing the
 * pre-tool-call seam from #429/#930).
 *
 * The reminder must not reach persisted tool output: stored transcripts and
 * compactions would carry one copy per call. This service returns request-only
 * text; request assembly appends it as a text part of the persisted user
 * message, so plugin transforms, redactions, and removals stay authoritative.
 *
 * Exactly one reminder per turn: only the current user message receives one.
 * The text is computed once per turn and kept for later steps of the same turn.
 * todowrite changes land on the next user turn. Earlier turns never carry a
 * reminder: replacing the current entry keeps every request at exactly one
 * reminder while the persisted user content remains an unchanged prefix.
 *
 * `enabled` shows whether the agent can call todowrite. On a transition to
 * false, an existing turn entry stays (a last-step tools-disabled request must
 * not rewrite the prefix), but no new entry is created. Sessions without
 * todowrite (DAG nodes, delegated agents) therefore receive none.
 *
 * State is per instance and cleaned on instance disposal or session deletion.
 */
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { ModelMessage } from "ai"
import { Cause, Context, Effect, Layer, Option } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { SessionID, type MessageID } from "./schema"
import { RuntimeContext } from "./runtime-context"
import { Todo } from "./todo"
import { isRecord } from "@/util/record"

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
    enabled: boolean
  }) => Effect.Effect<string | undefined>
}

/**
 * Append the request-only reminder after the persisted content. The provider
 * cache policy has already marked stable messages, so this ephemeral user
 * message stays outside the positional cache boundary.
 */
const ephemeral = (part: unknown) => {
  if (typeof part !== "object" || part === null || !("providerOptions" in part)) return false
  const options = part.providerOptions
  return (
    typeof options === "object" &&
    options !== null &&
    "opencode" in options &&
    typeof options.opencode === "object" &&
    options.opencode !== null &&
    "cache" in options.opencode &&
    options.opencode.cache === "none"
  )
}

/**
 * Append the request-only reminder as a text part of the existing current user
 * message. A separate user message would create consecutive user turns, which
 * providers reject or merge; appending here keeps the persisted role sequence
 * and tool-call/result ordering intact.
 */
export function append(messages: ModelMessage[], reminder: string | undefined): ModelMessage[] {
  if (!reminder) return messages
  // Runtime context inserts a synthetic user message after the persisted user.
  // Role alone would attach the reminder to that block and separate it from the
  // persisted turn; use the runtime-context provenance instead.
  const synthetic = (message: ModelMessage) => {
    const messageOptions = isRecord(message.providerOptions) ? message.providerOptions : undefined
    const messageOpencode = isRecord(messageOptions?.opencode) ? messageOptions.opencode : undefined
    if (messageOpencode?.synthetic === "attachment") return true
    if (!Array.isArray(message.content)) return false
    return message.content.some((part) => {
      const options = "providerOptions" in part && isRecord(part.providerOptions) ? part.providerOptions : undefined
      const opencode = isRecord(options?.opencode) ? options.opencode : undefined
      return opencode?.synthetic === "attachment"
    })
  }
  const at = messages.findLastIndex(
    (message) => message.role === "user" && !RuntimeContext.isMessage(message) && !synthetic(message),
  )
  if (at < 0) return messages
  // Normalize persisted user messages to part arrays whenever a reminder is
  // sent. Otherwise the same historical user message would be a string in one
  // request and a part array in another (the current turn), and the wire prefix
  // would differ before the reminder even appears. Runtime-context messages
  // keep their original shape.
  const next = messages.map((message) => {
    // Runtime context is a request-tail block, not persisted turn content.
    // Mark it uncached so provider breakpoints stay on the persisted user.
    if (RuntimeContext.isMessage(message)) {
      const options = isRecord(message.providerOptions) ? message.providerOptions : {}
      return {
        ...message,
        providerOptions: {
          ...options,
          opencode: {
            ...(isRecord(options.opencode) ? options.opencode : {}),
            cache: "none",
          },
        },
      } as typeof message
    }
    if (message.role !== "user" || synthetic(message) || typeof message.content !== "string") return message
    return { ...message, content: [{ type: "text" as const, text: message.content }] }
  })
  const message = next[at]
  if (!message || message.role !== "user" || typeof message.content === "string") return messages
  const content = [...message.content]
  if (content.at(-1) && ephemeral(content.at(-1))) return next
  next[at] = {
    ...message,
    content: [...content, { type: "text", text: reminder, providerOptions: { opencode: { cache: "none" } } }],
  }
  return next
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTodoReminders") {}

function uncompletedOf(todos: Todo.Info[]): Todo.Info[] {
  return todos.filter((item) => item.status !== "completed" && item.status !== "cancelled")
}

export function renderReminder(uncompleted: Todo.Info[]): string {
  const lines = uncompleted.map((todo) => `- ${todo.status}: ${todo.content}`)
  return [
    `[todo reminder] ${uncompleted.length} uncompleted todo item${uncompleted.length === 1 ? "" : "s"}:`,
    ...lines,
    "Keep the list current: mark items completed when done, adjust stale entries, and set in_progress only for the item you are actively working on. Update via todowrite.",
  ].join("\n")
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("TodoReminders.state")(function* () {
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

    const forRequest: Interface["forRequest"] = Effect.fn("TodoReminders.forRequest")(function* (input) {
      const turns = yield* InstanceState.get(state)
      const current = input.messages.findLast((message) => message.info.role === "user")
      if (!current) return undefined

      const previous = turns.get(input.sessionID)
      // Exactly one turn entry per session: a newer user turn replaces the old
      // one, so no earlier reminder survives into this request.
      if (previous && previous.messageID !== current.info.id) turns.delete(input.sessionID)

      if (input.enabled && !turns.has(input.sessionID)) {
        // The reminder is decoration on top of the request: a missing or failing
        // Todo service must degrade to "no reminder", never fail the turn.
        const uncompleted = yield* Effect.gen(function* () {
          const todo = yield* Effect.serviceOption(Todo.Service)
          if (Option.isNone(todo)) return [] as Todo.Info[]
          return uncompletedOf(yield* todo.value.get(input.sessionID))
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed([] as Todo.Info[]),
          ),
        )
        turns.set(input.sessionID, {
          messageID: current.info.id,
          text: uncompleted.length === 0 ? "" : renderReminder(uncompleted),
        })
      }

      const active = turns.get(input.sessionID)
      if (!active || active.messageID !== current.info.id || !active.text) return undefined
      return active.text
    })

    return Service.of({ forRequest })
  }),
)

export * as TodoReminders from "./todo-reminders"
