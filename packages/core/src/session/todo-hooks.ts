export * as SessionTodoHooks from "./todo-hooks"

import { createHash } from "node:crypto"
import { Context, Effect, Option, Schema } from "effect"
import { KeyedMutex } from "../effect/keyed-mutex"

export interface Item {
  readonly content: string
  readonly status: string
}
export interface Change {
  readonly event: "TaskCreated" | "TaskCompleted"
  readonly sessionID: string
  readonly taskID: string
  readonly subject: string
}
export interface Decision {
  readonly blocked?: { readonly reason: string }
}
export class Blocked extends Schema.TaggedErrorClass<Blocked>()("TodoHookBlocked", { message: Schema.String }) {}
export interface Interface {
  readonly check: (change: Change) => Effect.Effect<Decision>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTodoHooks") {}

// Shared by v1 and v2 adapters; hooks never execute while holding a database transaction.
const mutex = KeyedMutex.makeUnsafe<string>()
export const withLock = <A, E, R>(sessionID: string, effect: Effect.Effect<A, E, R>) =>
  mutex.withLock(sessionID)(effect)

/** Bulk replacement has no persisted task ID. Renaming creates a new identity; reordering does not. */
export function identified(sessionID: string, items: readonly Item[]) {
  const occurrences = new Map<string, number>()
  return items.map((item) => {
    const ordinal = occurrences.get(item.content) ?? 0
    occurrences.set(item.content, ordinal + 1)
    const id = createHash("sha256")
      .update(JSON.stringify([sessionID, item.content, ordinal]))
      .digest("hex")
    return { ...item, id }
  })
}
export function changes(sessionID: string, previous: readonly Item[], next: readonly Item[]): Change[] {
  const old = new Map(identified(sessionID, previous).map((item) => [item.id, item]))
  return identified(sessionID, next).flatMap((item) => {
    const prior = old.get(item.id)
    const base = { sessionID, taskID: item.id, subject: item.content }
    return [
      ...(!prior ? [{ ...base, event: "TaskCreated" as const }] : []),
      ...(item.status === "completed" && prior?.status !== "completed"
        ? [{ ...base, event: "TaskCompleted" as const }]
        : []),
    ]
  })
}
export const check = Effect.fn("SessionTodoHooks.check")(function* (
  sessionID: string,
  previous: readonly Item[],
  next: readonly Item[],
) {
  const hooks = Option.getOrUndefined(yield* Effect.serviceOption(Service))
  if (!hooks) return
  for (const change of changes(sessionID, previous, next)) {
    const decision = yield* hooks.check(change)
    if (decision.blocked) yield* new Blocked({ message: decision.blocked.reason })
  }
})
