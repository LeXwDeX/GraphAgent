// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect } from "bun:test"
import { BackgroundQueue } from "@/background/queue"
import { Lifecycle } from "@/lifecycle/service"
import { ChildRegistry } from "@/session/child/registry"
import type { ActiveChildRun } from "@/session/engine-process"
import { SessionID } from "@/session/schema"
import type { TransitionRequest } from "@graphagent/core/lifecycle/transition"
import type { BackgroundJob } from "@graphagent/core/background-job"
import { Effect, Option } from "effect"
import { it } from "../lib/effect"

/**
 * #1407: the queue of a task job, as the lifecycle contract tells it. The registry keeps such a job `running` while its
 * child run waits for a slot; `BackgroundQueue` reads the run's own state and says `queued` for that wait. Everything
 * here is the in-process run registry and the pure projection over it: the integration with the task tool and the
 * scheduler is in `tool/task-queue.test.ts`.
 */

const entries: ActiveChildRun[] = []

/** A queued run of this process, as `ChildRuns.start` registers it. */
const queuedRun = (name: string): ActiveChildRun => {
  const entry = ChildRegistry.create({
    id: `crun_queue_${name}`,
    childSessionID: SessionID.make(`ses_queue_${name}`),
    parentSessionID: SessionID.make(`ses_queue_parent_${name}`),
    ownerKind: "task",
    ownerKey: { kind: "task" },
    permission: { ask: "user" },
    detached: true,
    directory: undefined,
    owner: {},
  })
  expect(ChildRegistry.register(entry)).toBe(true)
  entries.push(entry)
  return entry
}

afterEach(() => {
  for (const entry of entries.splice(0)) {
    ChildRegistry.end(entry, { type: "completed" })
    ChildRegistry.driverStopped(entry)
    ChildRegistry.persisted(entry)
  }
})

const job = (
  status: BackgroundJob.Status,
  extra: { readonly runID?: string; readonly started_at?: number } = {},
): Pick<BackgroundJob.Info, "status" | "started_at" | "metadata"> => ({
  status,
  started_at: extra.started_at ?? 1_000,
  ...(extra.runID === undefined ? {} : { metadata: { childRunID: extra.runID, sessionID: "ses_job" } }),
})

describe("the lifecycle value of a job", () => {
  it.effect("a running job whose run waits for its slot is queued, since it started", () =>
    Effect.sync(() => {
      const run = queuedRun("waiting")
      expect(BackgroundQueue.observe(job("running", { runID: run.id, started_at: 1_000 }))).toEqual({
        value: "queued",
        since: 1_000,
      })
    }),
  )

  it.effect("is running from the moment its run begins, since then", () =>
    Effect.sync(() => {
      const run = queuedRun("begun")
      expect(ChildRegistry.begin(run, 4_500)).toBe(true)
      expect(run.runningAt).toBe(4_500)
      expect(BackgroundQueue.observe(job("running", { runID: run.id, started_at: 1_000 }))).toEqual({
        value: "running",
        since: 4_500,
      })
      // The moment is the first one: a run that is already running is not moved again.
      expect(ChildRegistry.begin(run, 9_000)).toBe(true)
      expect(run.runningAt).toBe(4_500)
    }),
  )

  it.effect("a run cancelled in the queue never ran: its job is still queued when it ends a moment later", () =>
    Effect.sync(() => {
      const run = queuedRun("cancelled")
      ChildRegistry.end(run, { type: "cancelled", by: { kind: "engine", reason: "test" } }, { hold: true })
      expect(ChildRegistry.waiting(run)).toBe(true)
      expect(BackgroundQueue.observe(job("running", { runID: run.id })).value).toBe("queued")
    }),
  )

  it.effect("a run that ended after it ran has left the queue for good", () =>
    Effect.sync(() => {
      const run = queuedRun("ran")
      ChildRegistry.begin(run, 2_000)
      ChildRegistry.end(run, { type: "completed" }, { hold: true })
      expect(ChildRegistry.waiting(run)).toBe(false)
      expect(BackgroundQueue.observe(job("running", { runID: run.id }))).toEqual({ value: "running", since: 2_000 })
    }),
  )

  it.effect(
    "a job no run of this process carries keeps its status, and a running one is running since it started",
    () =>
      Effect.sync(() => {
        expect(BackgroundQueue.observe(job("running", { started_at: 700 }))).toEqual({ value: "running", since: 700 })
        // The run is not in this process's registry (a restart, a shell job that never had one).
        expect(BackgroundQueue.observe(job("running", { runID: "crun_unknown", started_at: 800 }))).toEqual({
          value: "running",
          since: 800,
        })
        for (const status of ["settling", "completed", "error", "cancelled"] as const) {
          const run = queuedRun(`other_${status}`)
          // The queue is the wait of a running job: any other status is the registry's own word, with no time.
          expect(BackgroundQueue.observe(job(status, { runID: run.id }))).toEqual({ value: status })
        }
      }),
  )

  it.effect("a zero is a moment like any other", () =>
    Effect.sync(() => {
      const run = queuedRun("zero")
      ChildRegistry.begin(run, 0)
      expect(BackgroundQueue.observe(job("running", { runID: run.id, started_at: 500 }))).toEqual({
        value: "running",
        since: 0,
      })
    }),
  )
})

describe("whether the run that carries a job has not begun", () => {
  it.effect("is the wait for the slot, and the end of a run cancelled in it", () =>
    Effect.sync(() => {
      const run = queuedRun("probe")
      const carried = { metadata: { childRunID: run.id } }
      expect(BackgroundQueue.waiting(carried)).toBe(true)
      ChildRegistry.begin(run, 10)
      expect(BackgroundQueue.waiting(carried)).toBe(false)
      const cancelled = queuedRun("probe_cancelled")
      ChildRegistry.end(cancelled, { type: "cancelled", by: { kind: "engine", reason: "test" } }, { hold: true })
      expect(BackgroundQueue.waiting({ metadata: { childRunID: cancelled.id } })).toBe(true)
    }),
  )

  it.effect("is no for a job no run of this process carries", () =>
    Effect.sync(() => {
      expect(BackgroundQueue.waiting({})).toBe(false)
      expect(BackgroundQueue.waiting({ metadata: { sessionID: "ses_job" } })).toBe(false)
      expect(BackgroundQueue.waiting({ metadata: { childRunID: "crun_unknown" } })).toBe(false)
      expect(BackgroundQueue.waiting({ metadata: { childRunID: 7 } })).toBe(false)
    }),
  )
})

describe("the lifecycle edge of a registry transition", () => {
  const transition = (
    from: BackgroundJob.Status | null,
    to: BackgroundJob.Status,
    waiting?: boolean,
  ): Pick<BackgroundJob.Transition, "from" | "to" | "waiting"> => ({
    from,
    to,
    ...(waiting === undefined ? {} : { waiting }),
  })

  it.effect("starting a job whose run waits is `null -> queued`; the registry itself says `running`", () =>
    Effect.sync(() => {
      expect(BackgroundQueue.edge(transition(null, "running", true))).toEqual({ from: null, to: "queued" })
    }),
  )

  it.effect("ending a job before its run began leaves the queue, and ending it after leaves running", () =>
    Effect.sync(() => {
      expect(BackgroundQueue.edge(transition("running", "cancelled", true))).toEqual({
        from: "queued",
        to: "cancelled",
      })
      expect(BackgroundQueue.edge(transition("running", "completed", false))).toEqual({
        from: "running",
        to: "completed",
      })
      expect(BackgroundQueue.edge(transition("running", "settling"))).toEqual({
        from: "running",
        to: "settling",
      })
    }),
  )

  it.effect("a job without a run of this process has the edge the registry reports", () =>
    Effect.sync(() => {
      expect(BackgroundQueue.edge(transition(null, "running"))).toEqual({ from: null, to: "running" })
      expect(BackgroundQueue.edge(transition("running", "error"))).toEqual({ from: "running", to: "error" })
      expect(BackgroundQueue.edge(transition("settling", "completed"))).toEqual({
        from: "settling",
        to: "completed",
      })
    }),
  )
})

describe("announcing that a run left the queue", () => {
  /** Records every transition asked of the lifecycle service; the rest of the contract is not used here. */
  const recording = () => {
    const requests: TransitionRequest[] = []
    const service = Lifecycle.Service.of({
      transition: (request) =>
        Effect.sync(() => {
          requests.push(request)
          return { published: true }
        }),
      get: () => Effect.succeed(Option.none()),
      register: () => Effect.void,
    })
    return { requests, service }
  }

  const jobs = (info: BackgroundJob.Info | undefined): Pick<BackgroundJob.Interface, "get"> => ({
    get: () => Effect.succeed(info),
  })

  const info = (status: BackgroundJob.Status): BackgroundJob.Info => ({
    id: "ses_job",
    type: "task",
    status,
    started_at: 1_000,
    metadata: { sessionID: "ses_job", parentSessionID: "ses_parent" },
  })

  it.effect("tells the lifecycle the job is running now, once, with the session it belongs to", () =>
    Effect.gen(function* () {
      const { requests, service } = recording()
      yield* BackgroundQueue.announceRunning(jobs(info("running")), "ses_job").pipe(
        Effect.provideService(Lifecycle.Service, service),
      )
      expect(requests).toEqual([
        { ref: { domain: "job", id: "ses_job" }, expect: "queued", to: "running", sessionID: "ses_job" },
      ])
    }),
  )

  it.effect("says nothing for a job that already ended or is gone: its own transition said how", () =>
    Effect.gen(function* () {
      const { requests, service } = recording()
      for (const found of [info("cancelled"), info("completed"), info("error"), info("settling"), undefined]) {
        yield* BackgroundQueue.announceRunning(jobs(found), "ses_job").pipe(
          Effect.provideService(Lifecycle.Service, service),
        )
      }
      expect(requests).toEqual([])
    }),
  )

  it.effect("says nothing where there is no lifecycle service, as in a harness", () =>
    Effect.gen(function* () {
      // Nothing to assert beyond not failing: the announcement is an observation and never a precondition.
      yield* BackgroundQueue.announceRunning(jobs(info("running")), "ses_job")
    }),
  )
})
