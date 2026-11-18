// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@graphagent/core/database/database"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { EventTable } from "@graphagent/core/event/sql"
import { Session as SessionNs } from "@/session/session"
import { BackgroundJob } from "@/background/job"
import { ExclusiveRegistry } from "@/session/engine-process"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Goal } from "@/goal/goal"
import { Dag } from "@/dag/dag"
import { DagControl } from "@/dag/control"
import { testEffect } from "../lib/effect"
import { testInstanceStoreLayer } from "../fixture/fixture"

// #1289: archiving a session pauses the workflows it owns, with reason
// `archived`. The layer mirrors the production sibling shape of
// session-remove-cleanup.test.ts: Session, Goal and Dag are `mergeAll`
// siblings, and Session self-provides its Dag.
const testLayer = Layer.mergeAll(
  SessionNs.defaultLayer,
  BackgroundJob.defaultLayer,
  Goal.defaultLayer,
  Dag.defaultLayer,
  DagControl.defaultLayer,
  ExclusiveRegistry.defaultLayer,
  Database.defaultLayer,
  testInstanceStoreLayer,
  CrossSpawnSpawner.defaultLayer,
)

const it = testEffect(testLayer)

const workflowConfig = (name: string) => ({
  name,
  nodes: [
    {
      id: "n1",
      name: "n1",
      worker_type: "build",
      depends_on: [],
      required: true,
      prompt_template: { inline: "do work" },
    },
  ],
})

type Owner = { readonly id: SessionNs.Info["id"]; readonly projectID: SessionNs.Info["projectID"] }

const start = (owner: Owner, title: string) =>
  Effect.gen(function* () {
    const dag = yield* Dag.Service
    return yield* dag.create({
      projectID: owner.projectID,
      sessionID: owner.id,
      title,
      config: workflowConfig(title),
    })
  })

const read = (dagID: string) =>
  Effect.gen(function* () {
    const dag = yield* Dag.Service
    const row = yield* dag.store.getWorkflow(dagID).pipe(Effect.orDie)
    return { status: row?.status, reason: row?.pauseReason ?? null }
  })

/** How many durable events the workflow's aggregate holds: an untouched workflow gains none. */
const eventCount = (dagID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select({ id: EventTable.id })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, dagID))
      .all()
      .pipe(Effect.orDie)
    return rows.length
  })

/** The toasts the process-wide bus carries while the test runs. */
const collectToasts = Effect.acquireRelease(
  Effect.sync(() => {
    const toasts: Array<{ title?: string; message: string; variant: string }> = []
    const listener = (event: GlobalEvent) => {
      if (event.payload?.type === "tui.toast.show") toasts.push(event.payload.properties)
    }
    GlobalBus.on("event", listener)
    return { toasts, listener }
  }),
  ({ listener }) => Effect.sync(() => void GlobalBus.off("event", listener)),
).pipe(Effect.map(({ toasts }) => toasts))

describe("Session archive and the workflows the session owns (#1289)", () => {
  it.instance("pauses a running workflow with reason archived", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dag = yield* Dag.Service

      const info = yield* session.create({})
      const dagID = yield* start(info, "archive-running")
      expect((yield* dag.store.getWorkflow(dagID).pipe(Effect.orDie))?.status).toBe("running")

      const archived = yield* session.applyUpdate({ sessionID: info.id, time: { archived: Date.now() } })
      expect(archived.time.archived).toBeDefined()

      const workflow = yield* dag.store.getWorkflow(dagID).pipe(Effect.orDie)
      expect(workflow?.status).toBe("paused")
      expect(workflow?.pauseReason).toBe("archived")
    }),
  )

  it.instance("holds every live workflow, reports the ones it paused, and leaves ended ones alone", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dag = yield* Dag.Service

      const info = yield* session.create({})
      const running = yield* start(info, "wf-running")
      const stepping = yield* start(info, "wf-stepping")
      expect(yield* dag.step(stepping)).toEqual({ status: "stepping", nodeID: "n1" })
      const manual = yield* start(info, "wf-manual")
      yield* dag.pause(manual)
      const checkpoint = yield* start(info, "wf-checkpoint")
      yield* dag.pause(checkpoint, "checkpoint")
      const budget = yield* start(info, "wf-budget")
      yield* dag.pause(budget, "budget_exhausted")
      const cancelled = yield* start(info, "wf-cancelled")
      yield* dag.cancel(cancelled)
      const failed = yield* start(info, "wf-failed")
      yield* dag.fail(failed, "boom")
      const endedEvents = [yield* eventCount(cancelled), yield* eventCount(failed)]

      // The receipt counts what the archive paused: the running and the
      // stepping workflow. The three already-paused ones were only relabeled.
      expect(yield* session.setArchived({ sessionID: info.id, time: 5 })).toEqual({ pausedWorkflows: 2 })

      for (const dagID of [running, stepping, manual, checkpoint, budget])
        expect(yield* read(dagID)).toEqual({ status: "paused", reason: "archived" })
      expect(yield* read(cancelled)).toEqual({ status: "cancelled", reason: null })
      expect(yield* read(failed)).toEqual({ status: "failed", reason: null })
      expect([yield* eventCount(cancelled), yield* eventCount(failed)]).toEqual(endedEvents)
      expect((yield* session.get(info.id)).time.archived).toBe(5)
    }),
  )

  it.instance("a repeated archive pauses nothing more and writes no event", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service

      const info = yield* session.create({})
      const dagID = yield* start(info, "wf-repeat")
      expect(yield* session.setArchived({ sessionID: info.id, time: 1 })).toEqual({ pausedWorkflows: 1 })
      const events = yield* eventCount(dagID)

      expect(yield* session.setArchived({ sessionID: info.id, time: 2 })).toEqual({ pausedWorkflows: 0 })
      expect(yield* read(dagID)).toEqual({ status: "paused", reason: "archived" })
      expect(yield* eventCount(dagID)).toBe(events)
    }),
  )

  it.instance("a session with no workflows, or only ended ones, archives as before", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dag = yield* Dag.Service

      const bare = yield* session.create({})
      expect(yield* session.setArchived({ sessionID: bare.id, time: 7 })).toEqual({ pausedWorkflows: 0 })
      expect((yield* session.get(bare.id)).time.archived).toBe(7)

      const done = yield* session.create({})
      const dagID = yield* start(done, "wf-ended")
      yield* dag.cancel(dagID)
      const events = yield* eventCount(dagID)
      expect(yield* session.setArchived({ sessionID: done.id, time: 8 })).toEqual({ pausedWorkflows: 0 })
      expect((yield* session.get(done.id)).time.archived).toBe(8)
      expect(yield* read(dagID)).toEqual({ status: "cancelled", reason: null })
      expect(yield* eventCount(dagID)).toBe(events)
    }),
  )

  it.instance("only the archived session's workflows are held", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service

      const first = yield* session.create({})
      const second = yield* session.create({})
      const mine = yield* start(first, "wf-first")
      const other = yield* start(second, "wf-second")

      yield* session.applyUpdate({ sessionID: first.id, time: { archived: 3 } })

      expect(yield* read(mine)).toEqual({ status: "paused", reason: "archived" })
      expect(yield* read(other)).toEqual({ status: "running", reason: null })
    }),
  )

  it.instance("un-archiving resumes nothing; the workflow control plane resumes it", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const control = yield* DagControl.Service

      const info = yield* session.create({})
      const dagID = yield* start(info, "wf-resume")
      yield* session.setArchived({ sessionID: info.id, time: 9 })

      // The opposite direction: no time, no workflow touched.
      expect(yield* session.setArchived({ sessionID: info.id })).toEqual({ pausedWorkflows: 0 })
      expect(yield* read(dagID)).toEqual({ status: "paused", reason: "archived" })

      // The main agent's `workflow` tool applies `resume` through the control
      // plane: the pause episode ends and its reason goes with it.
      yield* control.apply(dagID, { op: "resume" }, { sessionID: info.id })
      expect(yield* read(dagID)).toEqual({ status: "running", reason: null })
    }),
  )

  it.instance("tells the client what it paused through a toast, and only when it paused something", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const toasts = yield* collectToasts

      const quiet = yield* session.create({})
      yield* session.setArchived({ sessionID: quiet.id, time: 1 })
      expect(toasts).toEqual([])

      const busy = yield* session.create({})
      yield* start(busy, "wf-toast-1")
      yield* start(busy, "wf-toast-2")
      yield* session.setArchived({ sessionID: busy.id, time: 2 })
      expect(toasts).toHaveLength(1)
      expect(toasts[0]?.message).toContain("2 workflows paused")

      // The repeated archive paused nothing, so it says nothing.
      yield* session.setArchived({ sessionID: busy.id, time: 3 })
      expect(toasts).toHaveLength(1)
    }),
  )
})
