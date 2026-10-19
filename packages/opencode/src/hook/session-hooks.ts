/**
 * Session-scoped hook store (WP-5D).
 *
 * Holds hook entries that were dynamically attached to a single session. The
 * canonical producer is the HTTP API session-hook endpoints (POST/GET/DELETE
 * under `/session/:id/hook`); anything that can speak HTTP — plugins, the TUI,
 * external clients, tests — can register a hook for the session's lifetime.
 * These hooks live alongside the 6-layer settings file chain — `SettingsHook.trigger`
 * concatenates session entries into the matcher list so they participate in
 * the same matcher / aggregation pipeline as on-disk hooks.
 *
 * Lifecycle:
 *   - `add(sessionID, entry)` — append; returns a uuid for later precise removal
 *   - `list(sessionID, event)` — query active entries for one event
 *   - `listAll(sessionID)` — query all active entries for a session (HTTP GET)
 *   - `remove(sessionID, id)` — drop a single entry (used by `once: true` cleanup)
 *   - `take` / `restore` — detach and re-attach the whole bucket when the
 *     session's directory changes; reservations and origins travel with it
 *   - `clear(sessionID)` — drop the whole session bucket (call on session end)
 *
 * Uses `InstanceState` for per-directory isolation (mirrors `start-context.ts`).
 * Storage is process-local memory — entries do NOT survive a restart; users
 * wanting persistent hooks should use the on-disk hooks.json chain.
 */
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import type { HookEvent, HookJSONOutput, HookCommand } from "./settings"
import { HookCommandSchema } from "./schema"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export type SessionHookCommand = HookCommand

export class InvalidHookError extends Schema.TaggedErrorClass<InvalidHookError>()("InvalidHookError", {
  message: Schema.String,
}) {}

export interface SessionHookEntryInput {
  event: HookEvent
  /** CC matcher pattern (exact / pipe-list / regex / "*"). Undefined = match all. */
  matcher?: string
  hooks: SessionHookCommand[]
  /** When true, the entry is removed after its first successful execution. */
  once?: boolean
  /** Frontmatter source. Absent for ordinary HTTP/session registrations. */
  origin?: string
  kind?: "skill" | "agent"
  child?: boolean
}

export interface ScopedHooksInput {
  kind: "skill" | "agent"
  /** Stable skill path or one active agent invocation; registration is idempotent by origin. */
  origin: string
  hooks: unknown
  /** Explicit loader provenance; never inferred from the filename itself. */
  source?: "project" | "user" | "plugin" | "builtin"
  /** Only a child agent's frontmatter Stop hook becomes SubagentStop. */
  child?: boolean
}

export interface SessionHookEntry extends SessionHookEntryInput {
  /** Auto-generated uuid. Stable for the entry's lifetime; used by remove(). */
  id: string
}

/**
 * One session's complete hook state, detached from a directory instance so it
 * can follow the session when CwdChanged moves it. Entries keep their ids
 * (remove/claim still address the same hook), reservations keep in-flight
 * `once` ownership, and scoped origins keep skill/agent registration idempotent.
 */
export interface SessionHookTransfer {
  readonly entries: readonly SessionHookEntry[]
  readonly reservations: ReadonlyMap<string, string>
  readonly origins: readonly string[]
}

export interface Interface {
  readonly add: (sessionID: SessionID, entry: SessionHookEntryInput) => Effect.Effect<string, InvalidHookError>
  /** Atomically reserve a once registration; returns a unique ownership token. */
  readonly claim: (sessionID: SessionID, id: string) => Effect.Effect<string | undefined>
  /** Complete only this reservation; a late finalizer cannot release a later run. */
  readonly complete: (sessionID: SessionID, id: string, token: string, succeeded: boolean) => Effect.Effect<void>
  readonly registerScoped: (sessionID: SessionID, input: ScopedHooksInput) => Effect.Effect<void, InvalidHookError>
  readonly unregisterScoped: (sessionID: SessionID, origin: string) => Effect.Effect<void>
  readonly remove: (sessionID: SessionID, id: string) => Effect.Effect<void>
  readonly list: (sessionID: SessionID, event: HookEvent) => Effect.Effect<readonly SessionHookEntry[]>
  /** All entries for a session across every event (backs the HTTP GET endpoint). */
  readonly listAll: (sessionID: SessionID) => Effect.Effect<readonly SessionHookEntry[]>
  /**
   * O(1) existence probe — answers "does this session have any hook for this event?"
   * Used by WP-6A short-circuit in SettingsHook.trigger to skip the matcher pipeline
   * when no session-scoped hook (and no on-disk hook) targets the current event.
   */
  readonly hasForEvent: (sessionID: SessionID, event: HookEvent) => Effect.Effect<boolean>
  /**
   * Detach one session's entries, reservations and scoped origins from the
   * ambient directory instance. Used by CwdChanged to move them to the new
   * directory; the read and the delete happen in one synchronous step so a
   * concurrent registration cannot be dropped between them.
   */
  readonly take: (sessionID: SessionID) => Effect.Effect<SessionHookTransfer>
  /** Attach a taken transfer to the ambient directory instance. */
  readonly restore: (sessionID: SessionID, transfer: SessionHookTransfer) => Effect.Effect<void>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionHooks") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(
      Effect.fn("SessionHooks.state")(() => Effect.succeed(new Map<SessionID, SessionHookEntry[]>())),
    )
    const reservations = yield* InstanceState.make(
      Effect.fn("SessionHooks.reservations")(() => Effect.succeed(new Map<SessionID, Map<string, string>>())),
    )
    const scopedOrigins = yield* InstanceState.make(
      Effect.fn("SessionHooks.scopedOrigins")(() => Effect.succeed(new Map<SessionID, Set<string>>())),
    )

    const add = Effect.fn("SessionHooks.add")(function* (sessionID: SessionID, entry: SessionHookEntryInput) {
      const parsed = HookCommandSchema.array().min(1).safeParse(entry.hooks)
      if (!parsed.success) return yield* new InvalidHookError({ message: parsed.error.message })
      if (entry.matcher !== undefined && typeof entry.matcher !== "string")
        return yield* new InvalidHookError({ message: "matcher must be a string" })
      const data = yield* InstanceState.get(state)
      const list = data.get(sessionID) ?? []
      const id = crypto.randomUUID()
      list.push({ ...entry, id, hooks: parsed.data })
      data.set(sessionID, list)
      return id
    })

    const claim = Effect.fn("SessionHooks.claim")(function* (sessionID: SessionID, id: string) {
      const data = yield* InstanceState.get(state)
      const list = data.get(sessionID)
      if (!list?.some((entry) => entry.id === id)) return undefined
      const locks = yield* InstanceState.get(reservations)
      const owned = locks.get(sessionID) ?? new Map<string, string>()
      if (owned.has(id)) return undefined
      const token = crypto.randomUUID()
      owned.set(id, token)
      locks.set(sessionID, owned)
      return token
    })

    const complete = Effect.fn("SessionHooks.complete")(function* (
      sessionID: SessionID,
      id: string,
      token: string,
      succeeded: boolean,
    ) {
      const locks = yield* InstanceState.get(reservations)
      const owned = locks.get(sessionID)
      if (owned?.get(id) !== token) return
      owned.delete(id)
      if (!succeeded) return
      const data = yield* InstanceState.get(state)
      const next = (data.get(sessionID) ?? []).filter((entry) => entry.id !== id)
      if (next.length) data.set(sessionID, next)
      else data.delete(sessionID)
    })

    const remove = Effect.fn("SessionHooks.remove")(function* (sessionID: SessionID, id: string) {
      const locks = yield* InstanceState.get(reservations)
      locks.get(sessionID)?.delete(id)
      const data = yield* InstanceState.get(state)
      const next = (data.get(sessionID) ?? []).filter((entry) => entry.id !== id)
      if (next.length) data.set(sessionID, next)
      else data.delete(sessionID)
    })

    const registerScoped = Effect.fn("SessionHooks.registerScoped")(function* (
      sessionID: SessionID,
      input: ScopedHooksInput,
    ) {
      if (!input.origin || (input.kind !== "skill" && input.kind !== "agent"))
        return yield* new InvalidHookError({ message: "scoped hook requires kind and origin" })
      const raw = input.hooks
      if (!isRecord(raw)) return yield* new InvalidHookError({ message: "scoped hooks must be an event map" })
      // Resolve the event vocabulary only when registering. A static import
      // would form a module-initialization cycle: settings owns SessionHooks,
      // while permission and MCP also compose the settings layer.
      const { VALID_HOOK_EVENTS } = yield* Effect.promise(() => import("./settings"))
      const isEvent = (name: string): name is HookEvent => VALID_HOOK_EVENTS.has(name)
      const entries: SessionHookEntry[] = []
      for (const [name, groups] of Object.entries(raw)) {
        if (!isEvent(name) || !Array.isArray(groups))
          return yield* new InvalidHookError({ message: `invalid scoped hook event: ${name}` })
        for (const group of groups) {
          const item: unknown = group
          if (!isRecord(item)) return yield* new InvalidHookError({ message: `invalid scoped hook group: ${name}` })
          if (item.matcher !== undefined && typeof item.matcher !== "string")
            return yield* new InvalidHookError({ message: `invalid scoped hook matcher: ${name}` })
          const parsed = HookCommandSchema.array().min(1).safeParse(item.hooks)
          if (!parsed.success) return yield* new InvalidHookError({ message: parsed.error.message })
          const event = input.kind === "agent" && input.child && name === "Stop" ? "SubagentStop" : name
          entries.push({
            id: crypto.randomUUID(),
            event,
            matcher: item.matcher,
            hooks: parsed.data,
            once: input.kind === "skill" && item.once === true,
            origin: input.origin,
            kind: input.kind,
            child: input.child,
          })
        }
      }
      const data = yield* InstanceState.get(state)
      const current = data.get(sessionID) ?? []
      const registered = yield* InstanceState.get(scopedOrigins)
      const origins = registered.get(sessionID) ?? new Set<string>()
      if (origins.has(input.origin)) return undefined
      origins.add(input.origin)
      registered.set(sessionID, origins)
      data.set(sessionID, [...current, ...entries])
      return undefined
    })

    const unregisterScoped = Effect.fn("SessionHooks.unregisterScoped")(function* (
      sessionID: SessionID,
      origin: string,
    ) {
      const data = yield* InstanceState.get(state)
      const removed = (data.get(sessionID) ?? []).filter((entry) => entry.origin === origin)
      const next = (data.get(sessionID) ?? []).filter((entry) => entry.origin !== origin)
      if (next.length) data.set(sessionID, next)
      else data.delete(sessionID)
      const locks = yield* InstanceState.get(reservations)
      for (const entry of removed) locks.get(sessionID)?.delete(entry.id)
      const registered = yield* InstanceState.get(scopedOrigins)
      registered.get(sessionID)?.delete(origin)
    })

    const list = Effect.fn("SessionHooks.list")(function* (sessionID: SessionID, event: HookEvent) {
      const data = yield* InstanceState.get(state)
      const arr = data.get(sessionID) ?? []
      return arr.filter((e) => e.event === event) as readonly SessionHookEntry[]
    })

    const listAll = Effect.fn("SessionHooks.listAll")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return (data.get(sessionID) ?? []) as readonly SessionHookEntry[]
    })

    const hasForEvent = Effect.fn("SessionHooks.hasForEvent")(function* (sessionID: SessionID, event: HookEvent) {
      const data = yield* InstanceState.get(state)
      const arr = data.get(sessionID)
      if (!arr || arr.length === 0) return false
      return arr.some((e) => e.event === event)
    })

    const clear = Effect.fn("SessionHooks.clear")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      data.delete(sessionID)
      const locks = yield* InstanceState.get(reservations)
      locks.delete(sessionID)
      const registered = yield* InstanceState.get(scopedOrigins)
      registered.delete(sessionID)
    })

    const take = Effect.fn("SessionHooks.take")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const entries = data.get(sessionID) ?? []
      data.delete(sessionID)
      const locks = yield* InstanceState.get(reservations)
      // Never name this `reservations`: that would shadow the InstanceState
      // above and hit its TDZ on the `InstanceState.get(reservations)` call.
      const reservationState = locks.get(sessionID) ?? new Map<string, string>()
      locks.delete(sessionID)
      const registered = yield* InstanceState.get(scopedOrigins)
      const origins = registered.get(sessionID) ?? new Set<string>()
      registered.delete(sessionID)
      // Copy the mutable containers: the caller owns the result after this
      // point and the next mutation of the source map must not reach it.
      return { entries, reservations: new Map(reservationState), origins: [...origins] }
    })

    const restore = Effect.fn("SessionHooks.restore")(function* (sessionID: SessionID, transfer: SessionHookTransfer) {
      const data = yield* InstanceState.get(state)
      if (transfer.entries.length) data.set(sessionID, [...(data.get(sessionID) ?? []), ...transfer.entries])
      const locks = yield* InstanceState.get(reservations)
      if (transfer.reservations.size) {
        const owned = locks.get(sessionID) ?? new Map<string, string>()
        for (const [id, token] of transfer.reservations) owned.set(id, token)
        locks.set(sessionID, owned)
      }
      const registered = yield* InstanceState.get(scopedOrigins)
      if (transfer.origins.length) {
        const origins = registered.get(sessionID) ?? new Set<string>()
        for (const origin of transfer.origins) origins.add(origin)
        registered.set(sessionID, origins)
      }
    })

    return Service.of({
      add,
      claim,
      complete,
      registerScoped,
      unregisterScoped,
      remove,
      list,
      listAll,
      hasForEvent,
      take,
      restore,
      clear,
    })
  }),
)

export const defaultLayer = layer

export const node = LayerNode.make(layer, [])

// Re-export HookJSONOutput so consumers building entries don't need a second import.
export type { HookJSONOutput }

export * as SessionHooks from "./session-hooks"
