// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Foreground hook observability: debounced `session.hook.status` events and the
 * running-fiber registry behind `Hooks.cancel`.
 *
 * Only a foreground handler can stall a turn, emit progress, or be cancelled by
 * the user. Background (`async`/`asyncRewake`) handlers keep their existing
 * no-status behavior. Events are published after the debounce so a fast hook
 * never flashes the TUI footer; a handler that finishes (or is cancelled
 * before) the debounce window publishes nothing.
 */
import { Effect, Exit, Fiber } from "effect"
import { descriptorFor } from "../config/chain"
import { timeoutFor } from "../exec/command"
import { blocksOnFailure, type HookExecution } from "../handlers/shared"
import { HookNotification } from "../notifications"
import type { HookCommand, HookEvent } from "../types"
import { hookIDFor } from "./plan"
import type { RunningHook, State } from "./state"

export const STATUS_DEBOUNCE_MS = 1_000

export function runMonitored(input: {
  state: State
  sessionID: string | undefined
  event: HookEvent
  entry: HookCommand
  origin?: string
  execute: Effect.Effect<HookExecution>
}): Effect.Effect<HookExecution> {
  // Headless triggers have no session to report to and no cancel endpoint.
  if (!input.sessionID) return input.execute
  const { state, sessionID, event, entry, origin, execute } = input

  // The local scope makes the registry cleanup run as soon as the handler
  // settles, so a finished or cancelled hook can no longer be addressed.
  return Effect.scoped(
    Effect.gen(function* () {
      // Never publish the handler definition: commands and HTTP headers can
      // contain private values. The digest only correlates start/finish events
      // and addresses the cancel route.
      const hookID = hookIDFor(entry, origin)
      const key = `${sessionID}:${hookID}`
      const status = {
        sessionID,
        hookID,
        event,
        descriptor: descriptorFor(entry),
        ...(entry.statusMessage === undefined ? {} : { statusMessage: entry.statusMessage }),
        timeoutMs: timeoutFor(entry, event),
        startedAt: Date.now(),
      }
      const running: RunningHook = state.runningHooks.get(key) ?? { fibers: new Set(), cancelled: new Set() }
      state.runningHooks.set(key, running)

      const fiber = yield* Effect.forkChild(execute)
      running.fibers.add(fiber)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          running.fibers.delete(fiber)
          running.cancelled.delete(fiber)
          if (running.fibers.size === 0 && state.runningHooks.get(key) === running) state.runningHooks.delete(key)
        }),
      )

      // Race the debounce against the handler. Losing the race interrupts the
      // waiting effect, not the handler fiber itself.
      const started = yield* Effect.race(
        Effect.sleep(STATUS_DEBOUNCE_MS).pipe(Effect.as(true)),
        Fiber.await(fiber).pipe(Effect.as(false)),
      )
      if (started) yield* HookNotification.status({ ...status, phase: "started", cancellable: true })

      const exit = yield* Fiber.await(fiber)
      const wasCancelled = running.cancelled.has(fiber)
      if (started) {
        const phase = Exit.isSuccess(exit)
          ? exit.value.exitCode === null || exit.value.timedOut === true
            ? "timeout"
            : "finished"
          : wasCancelled
            ? "cancelled"
            : "finished"
        yield* HookNotification.status({ ...status, phase, cancellable: false })
      }

      if (Exit.isSuccess(exit)) return exit.value
      // A user cancel is a non-blocking failure; `onFailure: "block"` still blocks,
      // matching the timeout policy. Any other interruption keeps propagating.
      if (wasCancelled)
        return {
          json: undefined,
          exitBlock: blocksOnFailure(entry, event)
            ? 'hook cancelled; blocking because onFailure is "block"'
            : undefined,
          rawStdout: undefined,
          exitCode: undefined,
          succeeded: false,
          failureMessage: "hook cancelled",
        }
      return yield* Effect.failCause(exit.cause)
    }),
  )
}
