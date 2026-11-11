// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { BackgroundJob } from "@/background/job"
import type { SessionID } from "@/session/schema"
import { Effect } from "effect"

/**
 * Cancel every running background job owned by a session, its direct jobs, or
 * descendants of those jobs. Both turn cancellation and session removal use
 * this helper so they share one semantic:
 *
 * - jobs marked `survivesSessionCancel` are left alone;
 * - `skipCoordinated` leaves jobs registered with `SessionCancellation` to that
 *   owner, which reacts to the session cancellation request itself.
 */
export const cancelSessionJobs = Effect.fn("BackgroundJob.cancelSessionJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
  skipCoordinated = false,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (job.metadata?.survivesSessionCancel === true) return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        Effect.gen(function* () {
          const captured = skipCoordinated ? yield* background.capture(job) : undefined
          // The owner snapshot has the old identities; this local list may include later jobs.
          if (captured && BackgroundJob.isCoordinated(captured.identity)) return
          yield* captured ? captured.cancel : background.cancel(job.id)
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})
