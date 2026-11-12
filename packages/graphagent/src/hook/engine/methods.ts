// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Service methods that read or mutate per-instance hook state.
 *
 * Pure-move extraction from the former monolithic settings module (D1 PR1).
 * Runtime behavior is unchanged; see `hook/index.ts` for the public surface.
 */
import { Effect, Fiber } from "effect"
import path from "path"
import { PROJECT_DIR } from "@graphagent/core/brand"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { filterFrontmatterHooks, frontmatterHookEntries } from "@/project/trust/entries"
import type { ProjectTrust } from "@/project/trust/service"
import { SessionID } from "@/session/schema"
import * as Log from "@/util/log"
import type { SessionHooks, ScopedHooksInput } from "../session-hooks"
import type { HookEvent } from "../types"
import { advanceRewakeGeneration, rewakeTokenValid, staticWatchPaths } from "./state"
import type { State } from "./state"

const log = Log.create({ service: "hook.settings" })

/**
 * Origins that name a project-layer file for a scoped hook. The suffix after
 * the prefix is the absolute path recorded by the skill/agent loaders.
 */
const SCOPED_ORIGINS = {
  "skill:": "skill-hook",
  "agent:": "agent-hook",
} as const

/**
 * Apply the project-trust decision to a scoped skill/agent hook registration.
 * Returns the input unchanged when there is nothing to gate, a filtered copy
 * when some hooks are refused, and undefined when every hook is refused.
 * Exported so a trust change can re-evaluate existing registrations from their
 * source file with the same rules.
 */
export const scopedHooksWithTrust = Effect.fnUntraced(function* (
  input: ScopedHooksInput,
  trust: Pick<ProjectTrust.Interface, "gate"> | undefined,
  ctx: InstanceContext | undefined,
) {
  if (!trust || input.source !== "project" || !ctx || ctx.trustProject === true) return input
  const prefix = Object.keys(SCOPED_ORIGINS).find((candidate) => input.origin.startsWith(candidate))
  if (!prefix) return input
  const category = SCOPED_ORIGINS[prefix as keyof typeof SCOPED_ORIGINS]
  const absolute = path.resolve(input.origin.slice(prefix.length))
  const relative = path.relative(path.join(ctx.root, PROJECT_DIR), absolute).split(path.sep).join("/")
  if (!relative || relative === ".." || relative.startsWith("../")) {
    // A project-source origin outside `<root>/.agents` (for example a
    // `skills.paths` directory elsewhere in the repo or outside it, or a
    // skill pulled from `skills.urls`) is not among the entries the trust
    // panel enumerates, so no recorded decision can ever match it. Fail
    // closed: refuse the whole declaration as a single "not enumerated"
    // entry instead of registering it unchecked.
    if (frontmatterHookEntries(absolute, input.hooks, category).length === 0) return input
    const result = yield* trust.gate([{ scope: "project", file: absolute, entry: undefined }])
    return result.allowed[0] ? input : undefined
  }
  const entries = frontmatterHookEntries(relative, input.hooks, category)
  if (entries.length === 0) return input
  const result = yield* trust.gate(entries.map((entry) => ({ scope: "project", file: relative, entry })))
  if (result.allowed.every(Boolean)) return input
  const allowed = new Set(entries.filter((_, index) => result.allowed[index]).map((entry) => entry.id))
  if (allowed.size === 0) return undefined
  return {
    ...input,
    hooks: filterFrontmatterHooks(relative, input.hooks, category, (entry) => allowed.has(entry.id)),
  }
})

export function makeServiceMethods(
  state: InstanceState<State>,
  sessionHooks: SessionHooks.Interface,
  trust?: Pick<ProjectTrust.Interface, "gate">,
) {
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

  // Project skills and agents carry their own frontmatter hooks. The loaders
  // pass them through unmodified, so registration is where the project-trust
  // decision applies: enumerate the same entries the trust list shows, drop
  // refused hooks, and register nothing when every hook is refused.
  const gateScoped = Effect.fn("SettingsHook.gateScoped")(function* (input: ScopedHooksInput) {
    const ctx = yield* InstanceRef
    return yield* scopedHooksWithTrust(input, trust, ctx)
  })

  const registerScoped = Effect.fn("SettingsHook.registerScoped")(
    (sessionID: SessionID | string, input: ScopedHooksInput) =>
      Effect.gen(function* () {
        const gated = yield* gateScoped(input)
        if (gated === undefined) {
          log.info("project scoped hooks refused", { kind: input.kind, origin: input.origin })
          return
        }
        yield* sessionHooks.registerScoped(SessionID.make(String(sessionID)), gated).pipe(
          Effect.catchTag("InvalidHookError", (error) => {
            log.warn("invalid scoped hooks ignored", { kind: input.kind, origin: input.origin, error: error.message })
            return Effect.void
          }),
        )
      }),
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
