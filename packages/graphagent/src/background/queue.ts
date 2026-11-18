// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as BackgroundQueue from "./queue"

import type { BackgroundJob } from "@graphagent/core/background-job"
import { Lifecycle } from "@/lifecycle/service"
import { ChildRegistry } from "@/session/child/registry"
import { Cause, Effect, Option } from "effect"
import { sessionIDOf } from "./session-metadata"

/**
 * The queue of background task jobs, as the lifecycle contract tells it (#1407).
 *
 * A task job is `running` in the registry from the moment it starts, even while
 * the child run it carries waits for a slot (`AgentScheduler.childSlot`). The
 * run knows better: it is `queued` until it holds the slot and `running` after
 * (`ChildRegistry.begin`). The `job` lifecycle domain reports that difference,
 * so a client reads the queue instead of inferring it. Nothing here writes
 * state: the registry stays the only writer of job state, `child_run` the owner
 * of the run's, and `runtime_job` keeps persisting the registry status, so a
 * job is never durably `queued` and restart recovery has nothing new to fail.
 *
 * Pure reads of the in-process run registry, plus one publication: the edge
 * out of the queue, which the registry cannot see because it is not a job
 * transition.
 */

/** A job as the lifecycle names it: the registry status, with the wait for a slot told apart from `running`. */
export type Value = "queued" | BackgroundJob.Status

export interface Observed {
  readonly value: Value
  /**
   * When the job entered `value` (epoch milliseconds). A `queued` job entered it when it started; a `running` one when
   * its run began, or when it started if no run of this process carries it. A job in any other state has none.
   */
  readonly since?: number
}

type JobFacts = Pick<BackgroundJob.Info, "status" | "started_at" | "metadata">

const runOf = (metadata: Record<string, unknown> | undefined) => {
  const runID = metadata?.childRunID
  return typeof runID === "string" ? ChildRegistry.get(runID) : undefined
}

/**
 * Whether the child run that carries a job has not begun: it waits for its slot, or it was cancelled in the queue and
 * never held one. The registry asks it in the step that moves a job (`MakeOptions.waiting`).
 */
export function waiting(job: Pick<BackgroundJob.Info, "metadata">): boolean {
  const run = runOf(job.metadata)
  return run !== undefined && ChildRegistry.waiting(run)
}

/**
 * The lifecycle value of a live job. A job carried by a child run of this process is `queued` while the run waits for
 * its slot; any other job keeps its registry status.
 */
export function observe(job: JobFacts): Observed {
  if (job.status !== "running") return { value: job.status }
  if (waiting(job)) return { value: "queued", since: job.started_at }
  const run = runOf(job.metadata)
  return { value: "running", since: run?.runningAt ?? job.started_at }
}

/**
 * The lifecycle edge of one registry transition, from what the registry saw when it moved the job. The registry starts
 * a task job `running` while its run is still queued, so the edge that creates it is `null -> queued`, and the edge
 * that ends it before its run began is `queued -> cancelled`. `queued -> running` is not a registry transition at all:
 * see `announceRunning`.
 */
export function edge(transition: Pick<BackgroundJob.Transition, "from" | "to" | "waiting">): {
  readonly from: Value | null
  readonly to: Value
} {
  const refined = (status: BackgroundJob.Status): Value =>
    status === "running" && transition.waiting === true ? "queued" : status
  return { from: transition.from === null ? null : refined(transition.from), to: refined(transition.to) }
}

/**
 * The run that carries the job left the queue: the job is `running` now. Called by the one place that moves a task
 * run out of the queue, right after it did. A job that is no longer running (it ended in the moment between) already
 * said how, and says nothing more. Without the lifecycle service (a harness) nothing is published. It is an
 * observation: a failure of it is logged and never reaches the run.
 */
export const announceRunning = Effect.fn("BackgroundQueue.announceRunning")(
  function* (jobs: Pick<BackgroundJob.Interface, "get">, id: string) {
    const job = yield* jobs.get(id)
    if (job?.status !== "running") return
    const lifecycle = Option.getOrUndefined(yield* Effect.serviceOption(Lifecycle.Service))
    if (!lifecycle) return
    yield* lifecycle.transition({
      ref: { domain: "job", id },
      expect: "queued",
      to: "running",
      sessionID: sessionIDOf(job.metadata),
    })
  },
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.interrupt
      : Effect.logWarning("background job queue announcement failed", { cause: Cause.pretty(cause) }),
  ),
)
