/**
 * Service methods that read or mutate per-instance hook state.
 *
 * Pure-move extraction from the former monolithic settings module (D1 PR1).
 * Runtime behavior is unchanged; see `hook/index.ts` for the public surface.
 */
import { Effect, Fiber } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import * as Log from "@/util/log"
import type { SessionHooks, ScopedHooksInput } from "../session-hooks"
import type { HookEvent } from "../types"
import { advanceRewakeGeneration, rewakeTokenValid, staticWatchPaths } from "./state"
import type { State } from "./state"

const log = Log.create({ service: "hook.settings" })

export function makeServiceMethods(state: InstanceState<State>, sessionHooks: SessionHooks.Interface) {
  const list = Effect.fn("SettingsHook.list")(function* () {
    const s = yield* InstanceState.get(state)
    // The kill switch disables every trigger; reporting the configured
    // entries would advertise hooks and background wakes that never run.
    return s.settings.disableAllHooks === true ? [] : s.hooksList
  })

  const hasEvent = Effect.fn("SettingsHook.hasEvent")(function* (event: HookEvent, sessionID?: SessionID | string) {
    const s = yield* InstanceState.get(state)
    if (s.settings.disableAllHooks === true) return false
    if ((s.settings.hooks?.[event]?.length ?? 0) > 0) return true
    return sessionID ? yield* sessionHooks.hasForEvent(SessionID.make(sessionID), event) : false
  })

  const drainAsync = Effect.fn("SettingsHook.drainAsync")(function* (sessionID: SessionID | string) {
    const s = yield* InstanceState.get(state)
    const queued = s.asyncResults.get(sessionID) ?? { additionalContexts: [], systemMessages: [] }
    s.asyncResults.delete(sessionID)
    return queued
  })

  const clearSession = Effect.fn("SettingsHook.clearSession")(function* (sessionID: SessionID | string) {
    const s = yield* InstanceState.get(state)
    s.asyncResults.delete(sessionID)
    s.seen.delete(sessionID)
    s.once.delete(sessionID)
    s.onceRunning.delete(sessionID)
    advanceRewakeGeneration(s, String(sessionID))
    for (const fiber of s.asyncFibers.get(sessionID) ?? []) yield* Fiber.interrupt(fiber)
    s.asyncFibers.delete(sessionID)
    yield* sessionHooks.clear(SessionID.make(String(sessionID)))
  })

  const cancel = Effect.fn("SettingsHook.cancel")(function* (sessionID: SessionID | string, hookID: string) {
    const s = yield* InstanceState.get(state)
    const running = s.runningHooks.get(`${sessionID}:${hookID}`)
    if (!running || running.fibers.size === 0) return false
    // Snapshot first: interrupting a fiber runs its finalizer, which removes it
    // from the live set.
    const fibers = [...running.fibers]
    for (const fiber of fibers) running.cancelled.add(fiber)
    yield* Effect.forEach(fibers, (fiber) => Fiber.interrupt(fiber), { concurrency: "unbounded", discard: true })
    return true
  })

  const fileWatchPaths = Effect.fn("SettingsHook.fileWatchPaths")(function* () {
    const s = yield* InstanceState.get(state)
    return s.settings.disableAllHooks === true ? [] : staticWatchPaths(s.settings)
  })

  const sessionEndTimeout = Effect.fn("SettingsHook.sessionEndTimeout")(function* () {
    const override = Number(process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS)
    if (Number.isFinite(override) && override > 0) return override
    const s = yield* InstanceState.get(state)
    const configured = (s.settings.hooks?.SessionEnd ?? [])
      .flatMap((group) => group.hooks)
      .map((entry) => (entry.timeout === undefined ? 1_500 : entry.timeout * 1000))
    return Math.min(60_000, Math.max(1_500, ...configured))
  })

  // Async SessionEnd commands run for side effects after the session ends. A headless client waits for the
  // configured SessionEnd budget, then cancels what remains; an instance that outlives the process keeps them.
  const settleSessionEnd = Effect.fn("SettingsHook.settleSessionEnd")(function* () {
    const s = yield* InstanceState.get(state)
    const fibers = [...s.endFibers]
    if (fibers.length === 0) return
    yield* Effect.forEach(fibers, (fiber) => Fiber.await(fiber), { concurrency: "unbounded" }).pipe(
      Effect.onInterrupt(() => Effect.forEach(fibers, (fiber) => Fiber.interrupt(fiber), { concurrency: "unbounded" })),
      Effect.asVoid,
    )
  })

  const registerScoped = Effect.fn("SettingsHook.registerScoped")(
    (sessionID: SessionID | string, input: ScopedHooksInput) =>
      sessionHooks.registerScoped(SessionID.make(String(sessionID)), input).pipe(
        Effect.catchTag("InvalidHookError", (error) => {
          log.warn("invalid scoped hooks ignored", { kind: input.kind, origin: input.origin, error: error.message })
          return Effect.void
        }),
      ),
  )

  const unregisterScoped = Effect.fn("SettingsHook.unregisterScoped")((sessionID: SessionID | string, origin: string) =>
    sessionHooks.unregisterScoped(SessionID.make(String(sessionID)), origin),
  )

  // A pending Stop/SubagentStop rewake dies with the user's cancel intent.
  // The generation is monotonic across abort/prompt cycles: after a bump, a
  // later Stop trigger captures the new value, so an old token cannot match.
  // The cancellation epoch is compared too, covering cancels that land while
  // a callback is being admitted.
  const validateRewakeToken = Effect.fn("SettingsHook.validateRewakeToken")(function* (
    sessionID: SessionID | string,
    token: unknown,
  ) {
    const s = yield* InstanceState.get(state)
    return rewakeTokenValid(s, String(sessionID), token)
  })

  const bumpRewakeGeneration = Effect.fn("SettingsHook.bumpRewakeGeneration")(function* (
    sessionID: SessionID | string,
  ) {
    const s = yield* InstanceState.get(state)
    advanceRewakeGeneration(s, String(sessionID))
    log.debug("rewake generation advanced", { sessionID })
  })
  return {
    list,
    hasEvent,
    drainAsync,
    cancel,
    clearSession,
    fileWatchPaths,
    sessionEndTimeout,
    settleSessionEnd,
    registerScoped,
    unregisterScoped,
    validateRewakeToken,
    bumpRewakeGeneration,
  }
}
