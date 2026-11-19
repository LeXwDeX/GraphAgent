// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the mocked EventV2 listener receives partial event payloads via `as never` shims.
// #1618: a workflow's worktree on the summary, over the real store, projector and publisher. The summary is pushed
// after every event and read over HTTP by whoever asks; for one workflow the two must say the same thing at every
// point, the settlement of the worktree included. That settlement is written after the terminal event without moving
// the workflow's seq or update time, so it is the case a change marker or a trigger list that forgot it would get
// wrong: the push would keep the live pointer (a directory that is already gone) while the read says it is cleaned up.
import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { DagProjector } from "@graphagent/core/dag/projector"
import { WorkflowTable } from "@graphagent/core/dag/sql"
import { DagStore } from "@graphagent/core/dag/store"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionSchema } from "@graphagent/core/session/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { DagEvent } from "@graphagent/schema/dag-event"
import type { DagSummary } from "@graphagent/schema/dag-summary"
import { GlobalBus } from "@/bus/global"
import { DagSummaryDerived } from "@/dag/summary-derived"
import { DagSummaryPublisher } from "@/dag/runtime/summary-publisher"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { it, pollWithTimeout } from "../lib/effect"

const SESSION = "ses_parent"
const DAG = "dag_isolated"
const pointer = {
  directory: "/repo/.agents/worktree/dag-isolated-workflow",
  branch: "graphagent/dag-isolated-workflow",
}

const database = Database.layerFromPath(":memory:")
const eventLayer = EventV2.layer.pipe(Layer.provide(database))
const projector = DagProjector.layer.pipe(Layer.provide(Layer.merge(database, eventLayer)))
const store = DagStore.layer.pipe(Layer.provide(database))

interface BusControl {
  listener?: (event: never) => Effect.Effect<void>
}

describe("workflow worktree: the pushed summary and the read agree (#1618)", () => {
  it.instance("the live pointer, the terminal event, and then the settlement", () => {
    const bus: BusControl = {}
    const events = Layer.mock(EventV2Bridge.Service, {
      listen: (listener) =>
        Effect.sync(() => {
          bus.listener = listener as never
          return Effect.void
        }),
    })
    const pushed: DagSummary.WorkflowSummary[][] = []
    const handler = (event: {
      payload?: { type?: string; properties?: { summaries?: DagSummary.WorkflowSummary[] } }
    }) => {
      if (event.payload?.type === "dag.workflow.summary.updated") pushed.push(event.payload.properties!.summaries!)
    }

    return Effect.gen(function* () {
      const { db } = yield* Database.Service
      const dagStore = yield* DagStore.Service
      const eventBus = yield* EventV2.Service
      const instance = yield* InstanceState.context
      const projectID = Project.ID.make(instance.project.id)
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make(process.cwd()), sandboxes: [] })
        // A project with no repository is the shared `global` one, which a fresh database already holds.
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionSchema.ID.make(SESSION),
          project_id: projectID,
          slug: "parent",
          directory: AbsolutePath.make(process.cwd()),
          title: "Parent",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(WorkflowTable)
        .values([
          {
            id: DAG,
            project_id: projectID,
            session_id: SessionSchema.ID.make(SESSION),
            title: "Isolated",
            status: "running",
            config: JSON.stringify({ name: "isolated", isolation: "worktree", worktree: pointer, nodes: [] }),
            seq: 1,
            wake_reported: false,
            directory: instance.directory,
            target_fingerprint: { kind: "none" },
          },
          {
            id: "dag_plain",
            project_id: projectID,
            session_id: SessionSchema.ID.make(SESSION),
            title: "Plain",
            status: "running",
            config: JSON.stringify({ name: "plain", nodes: [] }),
            seq: 1,
            wake_reported: false,
            directory: instance.directory,
            target_fingerprint: { kind: "none" },
          },
        ])
        .run()
        .pipe(Effect.orDie)

      // The HTTP route's own composition: the aggregates, every workflow row, and one derivation over them.
      const read = Effect.gen(function* () {
        const summaries = yield* dagStore.getWorkflowSummaries(SESSION)
        const workflows = yield* dagStore.listBySession(SESSION)
        const derived = yield* DagSummaryDerived.forWorkflows(dagStore, workflows)
        return summaries.map((summary) => DagSummaryDerived.toWire(summary, derived.get(summary.id)))
      })
      const worktreeOf = (summaries: readonly { id: string; worktree?: unknown }[], id = DAG) =>
        summaries.find((summary) => summary.id === id)?.worktree

      // An event for the workflow, as the bridge hands it to the publisher; one more push is awaited per call.
      const notify = (type: string, data: object) =>
        Effect.gen(function* () {
          const before = pushed.length
          yield* bus.listener!({
            type,
            data: { dagID: DAG, timestamp: DateTime.makeUnsafe(1), ...data },
            location: { directory: instance.directory },
          } as never)
          return yield* pollWithTimeout(
            Effect.sync(() => (pushed.length > before ? pushed[pushed.length - 1] : undefined)),
            `no summary was pushed after ${type}`,
          )
        })

      yield* (yield* DagSummaryPublisher.Service).init()
      GlobalBus.on("event", handler)
      try {
        // While the workflow runs the live pointer is all there is: the push and the read both say active, and
        // the workflow without isolation has no field in either.
        const started = yield* notify(DagEvent.WorkflowStarted.type, {})
        const live = { ...pointer, state: "active" }
        expect(worktreeOf(started)).toEqual(live)
        expect(worktreeOf(yield* read)).toEqual(live)
        for (const summaries of [started, yield* read]) {
          expect(summaries.find((summary) => summary.id === "dag_plain")).toBeDefined()
          expect("worktree" in summaries.find((summary) => summary.id === "dag_plain")!).toBe(false)
        }

        // The terminal event comes before the settlement, so what it carries is still the pointer, and so is a read
        // made then.
        const terminal = yield* notify(DagEvent.WorkflowCompleted.type, { durationMs: 1 })
        expect(worktreeOf(terminal)).toEqual(live)
        expect(worktreeOf(yield* read)).toEqual(live)

        // The settlement removes the directory: the projection writes the row without moving seq or update time.
        const row = yield* dagStore.getWorkflow(DAG)
        yield* eventBus.publish(DagEvent.WorkflowWorktreeSettled, {
          dagID: DagEvent.DagID.make(DAG),
          worktree: {
            ...pointer,
            baseHead: "base-sha",
            head: "head-sha",
            touchedPaths: ["src/a.ts"],
            state: "removed",
          },
          episode: { graphRev: row!.graphRev, seq: row!.seq },
          timestamp: DateTime.makeUnsafe(2),
        })
        expect(yield* dagStore.getWorkflow(DAG)).toMatchObject({ seq: row!.seq, timeUpdated: row!.timeUpdated })

        const settled = yield* notify(DagEvent.WorkflowWorktreeSettled.type, {
          worktree: {},
          episode: { graphRev: row!.graphRev, seq: row!.seq },
        })
        const removed = { ...pointer, state: "removed" }
        expect(worktreeOf(settled)).toEqual(removed)
        expect(worktreeOf(yield* read)).toEqual(removed)
        // Same value for every field of the workflow, not only this one.
        expect(settled.find((summary) => summary.id === DAG)).toEqual(
          (yield* read).find((summary) => summary.id === DAG),
        )
      } finally {
        GlobalBus.off("event", handler)
      }
    }).pipe(
      Effect.provide(
        Layer.provideMerge(DagSummaryPublisher.layer, Layer.mergeAll(database, eventLayer, projector, store, events)),
      ),
    )
  })
})
