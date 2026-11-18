// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * What a background Task is doing, decided from what the data layer already holds (#1058): the Task link with the
 * result the server reported, the state of the job the run owns, and the child's session summary. The one place these
 * are decided: every surface that lists background tasks reads them from here. Pure: the data and the clock come in
 * through plain arguments; nothing here asks the server for anything.
 */

import type { LifecycleMirrorEntry } from "../context/lifecycle-mirror"
import type { SessionSummary, TaskIndexEntry } from "../context/session-summary"

/**
 * `queued` is the server's word when it reports the queue (the job's `queued`), and an inference on a server that does
 * not, see `backgroundStatus`; `unknown` means nothing says either way (a cold start).
 */
export type BackgroundStatus = "queued" | "running" | "completed" | "error" | "interrupted" | "cancelled" | "unknown"

/** The job of a background run is keyed by the child session id; the data layer mirrors its state. */
export type BackgroundJob = Pick<LifecycleMirrorEntry, "value" | "reason" | "since">

export type BackgroundSummary = Pick<SessionSummary, "status" | "toolCalls">

/**
 * The status of one background run; the first rule that matches wins, so a later source never overrides an earlier one:
 *
 * 1. The result the server reported for the run: its status (`completed`, `error` or `interrupted`).
 * 2. The state of its job when it has ended: `cancelled`, `completed`, `error`. An error whose reason is
 *    `process_restart` means the process died under the run, which is `interrupted`.
 * 3. The job that has not ended. A server that reports the queue (#1407) says `queued` for a run that waits for its
 *    slot and `running` once it holds it, and that word is taken as it is: a run that has begun is never `queued`
 *    because its child has not yet been busy or called a tool. Such a server marks the `running` it says with `since`.
 *    A server that does not report it says `running` for a run that still waits, so there `queued` is an inference:
 *    a job whose child is not working and has called no tool is waiting for its slot. (A summary's start time cannot
 *    tell: the session's creation sets it.) A `settling` job is finishing: `running`.
 * 4. No job state (none was reported, or its value is not one the contract names): `running` while the child's summary
 *    says busy or retrying, otherwise `unknown`.
 */
export function backgroundStatus(input: {
  entry: Pick<TaskIndexEntry, "result">
  job?: BackgroundJob
  summary?: BackgroundSummary
}): BackgroundStatus {
  const { entry, job, summary } = input
  if (entry.result) return entry.result.status
  const working = summary?.status === "busy" || summary?.status === "retry"
  switch (job?.value) {
    case "cancelled":
      return "cancelled"
    case "completed":
      return "completed"
    case "error":
      return job.reason === "process_restart" ? "interrupted" : "error"
    case "queued":
      return "queued"
    case "running":
      // `since` marks a server that reports the queue: its `running` is the run's own word.
      if (job.since !== undefined) return "running"
      return working || (summary?.toolCalls ?? 0) > 0 ? "running" : "queued"
    case "settling":
      return "running"
    default:
      return working ? "running" : "unknown"
  }
}

/** Still going: waiting for a slot or running. */
export function isActive(status: BackgroundStatus): boolean {
  return status === "queued" || status === "running"
}

/**
 * When a run began running, as the server says: the `since` of its `running` job. Only a server that reports the queue
 * says it. The `since` of a `queued` job is when the wait began, which is not a start.
 */
export function backgroundRunningAt(job: BackgroundJob | undefined): number | undefined {
  return job?.value === "running" ? job.since : undefined
}

export interface BackgroundItem {
  /** The child session, which is also the id of the run's job. */
  sessionID: string
  entry: TaskIndexEntry
  status: BackgroundStatus
  /** When the run began running, after the wait for its slot, when the server said; `backgroundElapsed` times it from there. */
  runningAt?: number
}

export interface BackgroundItems {
  running: BackgroundItem[]
  queued: BackgroundItem[]
  /** `completed`, `error`, `interrupted` and `cancelled`. */
  finished: BackgroundItem[]
  unknown: BackgroundItem[]
}

function groupOf(status: BackgroundStatus): keyof BackgroundItems {
  switch (status) {
    case "running":
    case "queued":
    case "unknown":
      return status
    default:
      return "finished"
  }
}

function startOf(item: BackgroundItem): number {
  return item.entry.startedAt ?? item.entry.result?.startedAt ?? 0
}

/** Newest start first; the session id settles a tie, ascending, so the order never depends on the store's. */
function byStart(a: BackgroundItem, b: BackgroundItem): number {
  const delta = startOf(b) - startOf(a)
  if (delta !== 0) return delta
  return a.sessionID < b.sessionID ? -1 : a.sessionID > b.sessionID ? 1 : 0
}

/**
 * The background runs of the session tree rooted at `rootID`, grouped by status: the Task links that are background
 * runs and were started from `rootID` itself. The state of each run comes through `job` and `summary`, looked up by
 * its child session id.
 */
export function backgroundItems(input: {
  taskIndex: Record<string, TaskIndexEntry | undefined>
  rootID: string
  job(childID: string): BackgroundJob | undefined
  summary(childID: string): BackgroundSummary | undefined
}): BackgroundItems {
  const groups: BackgroundItems = { running: [], queued: [], finished: [], unknown: [] }
  for (const [sessionID, entry] of Object.entries(input.taskIndex)) {
    if (!entry || entry.background !== true || entry.parentSessionID !== input.rootID) continue
    const job = input.job(sessionID)
    const status = backgroundStatus({ entry, job, summary: input.summary(sessionID) })
    const runningAt = status === "running" ? backgroundRunningAt(job) : undefined
    groups[groupOf(status)].push({ sessionID, entry, status, ...(runningAt === undefined ? {} : { runningAt }) })
  }
  return {
    running: groups.running.toSorted(byStart),
    queued: groups.queued.toSorted(byStart),
    finished: groups.finished.toSorted(byStart),
    unknown: groups.unknown.toSorted(byStart),
  }
}

/**
 * Milliseconds a run took or has taken, without the wait for its slot (#1407): `now` less the moment it began running
 * while it runs, the span of the reported result from the moment it began once it ended. The moment it began is what the
 * server reports; without it (an older server, a run lost with its process) the run is timed from the Task call that
 * started it, which includes the wait. A queued run has not begun: its time is the wait so far, from the Task call.
 * Undefined where no time is known (no start on an active run, an end that only the job state reported). Never
 * negative: a clock that reads before the start counts as zero.
 */
export function backgroundElapsed(item: BackgroundItem, now: number): number | undefined {
  if (isActive(item.status)) {
    const from = item.status === "running" ? (item.runningAt ?? item.entry.startedAt) : item.entry.startedAt
    return from === undefined ? undefined : Math.max(0, now - from)
  }
  const result = item.entry.result
  return result ? Math.max(0, result.endedAt - (result.runningAt ?? result.startedAt)) : undefined
}
