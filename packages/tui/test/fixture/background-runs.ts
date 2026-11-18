// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { LifecycleMirrorEntry } from "../../src/context/lifecycle-mirror"
import type { SessionSummary, TaskIndexEntry } from "../../src/context/session-summary"
import type { useSync } from "../../src/context/sync"

/**
 * The store entries a background run leaves in the data layer (#1058): the Task link of the parent, the job the run
 * owns and its child's session summary. The band and the drawer read nothing else, so a test that wants a run in a
 * given state sets these, the way the event path would, and needs no server.
 *
 * - `running`: the job runs and the child is busy.
 * - `queued`: the job runs and the child has not run a turn (the inference `backgroundStatus` documents).
 * - `started`: the server reports the queue (#1407) and says the job `running`, with the moment it began, while its
 *   child has not been busy or called a tool yet: a run that just got its slot, which the inference calls queued.
 * - `waiting`: the server reports the queue and says the job `queued`.
 * - `completed`, `error`: the server reported the end of the run in the result message.
 * - `unknown`: nothing says how it stands (a cold start).
 */
export type RunState = "running" | "queued" | "started" | "waiting" | "completed" | "error" | "unknown"

type Sync = Pick<ReturnType<typeof useSync>, "set">

export interface RunSeed {
  /** The session that started the run. */
  readonly parent: string
  /** Names the child session: `ses_run_<key>`. */
  readonly key: string
  readonly state: RunState
  readonly kind?: string
  readonly description?: string
  /** A run in the foreground is not a background run at all. */
  readonly background?: boolean
  /** Epoch milliseconds; later starts are newer. */
  readonly startedAt?: number
  /** For a `started` run: the moment it got its slot. Defaults to `startedAt`, as a run that never waited. */
  readonly runningAt?: number
}

/** The child session of a run. */
export const runSessionID = (key: string) => `ses_run_${key}`

/** The clock the runs of a test start from. */
export const RUN_START = 1_000_000

export function seedRun(sync: Sync, input: RunSeed) {
  const id = runSessionID(input.key)
  const startedAt = input.startedAt ?? RUN_START
  const entry: TaskIndexEntry = {
    parentSessionID: input.parent,
    parentMessageID: `msg_run_${input.key}`,
    partID: `prt_run_${input.key}`,
    kind: input.kind ?? "explore",
    description: input.description ?? `Scan ${input.key}`,
    background: input.background ?? true,
    initiator: "agent",
    startedAt,
    ...(input.state === "completed" || input.state === "error"
      ? {
          result: {
            status: input.state,
            title: input.description ?? `Scan ${input.key}`,
            startedAt,
            endedAt: startedAt + 65_000,
            messageID: `msg_run_result_${input.key}`,
            partID: `prt_run_result_${input.key}`,
          },
        }
      : {}),
  }
  sync.set("taskIndex", id, entry)
  if (input.state === "running" || input.state === "queued") {
    const job: LifecycleMirrorEntry = { domain: "job", id, value: "running", phase: "running", at: startedAt }
    sync.set("lifecycle", `job:${id}`, job)
  }
  if (input.state === "started") {
    const job: LifecycleMirrorEntry = {
      domain: "job",
      id,
      value: "running",
      phase: "running",
      at: startedAt,
      since: input.runningAt ?? startedAt,
    }
    sync.set("lifecycle", `job:${id}`, job)
  }
  if (input.state === "waiting") {
    const job: LifecycleMirrorEntry = {
      domain: "job",
      id,
      value: "queued",
      phase: "pending",
      at: startedAt,
      since: startedAt,
    }
    sync.set("lifecycle", `job:${id}`, job)
  }
  if (input.state === "running") {
    const summary: SessionSummary = {
      id,
      parentID: input.parent,
      status: "busy",
      toolCalls: 3,
      lastActivityAt: startedAt,
    }
    sync.set("summary", id, summary)
  }
}

/** The job of the run `key` finishing: the run is no longer going, whatever the child's summary says. */
export function endRun(sync: Sync, key: string, state: "completed" | "error" = "completed") {
  const id = runSessionID(key)
  const job: LifecycleMirrorEntry = {
    domain: "job",
    id,
    value: state,
    phase: state === "completed" ? "succeeded" : "failed",
    at: RUN_START + 1,
  }
  sync.set("lifecycle", `job:${id}`, job)
}
