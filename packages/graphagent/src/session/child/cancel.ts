// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Cause, Effect } from "effect"
import { SessionAbortReason } from "../abort-reason"
import type { ChildCancelBy } from "./types"

/** How long a forked session cancellation may run before a warning says it is still going. */
export const CANCEL_BOUND_MS = 5_000

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

/**
 * The abort reason the child session's interrupted turn records, so a later
 * reader can tell who stopped it. Abort reasons are lowercase slugs.
 */
export function abortReasonOf(by: ChildCancelBy): SessionAbortReason.Info {
  if (by.kind === "main_agent_tool") return SessionAbortReason.make("task-cancelled", "main-agent")
  const reason = slug(by.reason)
  const actor = slug(by.actor ?? "") || "child-runs"
  return SessionAbortReason.make(
    reason === "" ? "engine-cancel" : /^[a-z]/.test(reason) ? reason : `engine-${reason}`,
    /^[a-z]/.test(actor) ? actor : `engine-${actor}`,
  )
}

/**
 * Best-effort bounded cancellation. `SessionPrompt.cancel` is uninterruptible
 * and waits for the commit lock, so the bound is not a hard limit: when the
 * time runs out the warning is logged from the timer itself, because an
 * uninterruptible loser can keep the race from settling. The warning records
 * that the cancellation is still running instead of pretending it finished.
 * Failures are logged, never raised: the run already ended.
 */
export const boundedCancel = (
  effect: Effect.Effect<void>,
  label: string,
  timeoutMs = CANCEL_BOUND_MS,
): Effect.Effect<void> =>
  Effect.race(
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning("child run session cancellation failed", { label, cause: Cause.pretty(cause) }),
      ),
    ),
    Effect.sleep(timeoutMs).pipe(
      Effect.andThen(
        Effect.logWarning(
          "child run session cancellation exceeded its bound; the uninterruptible admission wait may still be running",
          { label },
        ),
      ),
    ),
  )
