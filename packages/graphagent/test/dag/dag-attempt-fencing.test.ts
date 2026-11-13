// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { Dag, type NodeConfig, type NodeExecutionAttempt } from "@/dag/dag"
import { reconcileWorkflow } from "@/dag/runtime/recovery"
import { makeDeadlineWatcher } from "@/dag/runtime/spawn"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { InstanceContext } from "@/project/instance-context"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { mockSessionPrompt } from "../lib/child-runs"

const directory = process.cwd()
const projectID = Project.ID.make("project-attempt-fence")
const sessionID = SessionID.make("ses_attempt_fence")
const instance = {
  directory,
  worktree: directory,
  root: directory,
  project: {
    id: projectID,
    worktree: AbsolutePath.make(directory),
    time: { created: 0, updated: 0 },
    sandboxes: [],
  },
} satisfies InstanceContext
const cancellations: string[] = []

function node(name = "a"): NodeConfig {
  return {
    id: "a",
    name,
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: name },
  }
}

const harness = (() => {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const prompt = mockSessionPrompt({
    cancel: (childSessionID) =>
      Effect.sync(() => {
        cancellations.push(childSessionID)
      }),
  })
  return Layer.mergeAll(database, events, bridge, store, projector, dag, prompt)
})()

function setup() {
  return Effect.gen(function* () {
    cancellations.length = 0
    const database = yield* Database.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: projectID, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        slug: "attempt-fence",
        directory: AbsolutePath.make(directory),
        title: "Attempt fence",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    const dag = yield* Dag.Service
    const dagID = yield* dag.create({
      projectID,
      sessionID,
      title: "Attempt fence",
      config: { name: "attempt-fence", nodes: [node()] },
    })
    return { dag, dagID, store: yield* DagStore.Service }
  })
}

function attempt(row: DagStore.NodeRow, childSessionID?: string): NodeExecutionAttempt {
  return {
    replanAttempts: row.replanAttempts,
    ...(childSessionID ? { childSessionID } : {}),
  }
}

function requireValue<A>(value: A | null | undefined, message: string): Effect.Effect<A> {
  return value == null ? Effect.die(new Error(message)) : Effect.succeed(value)
}

describe("DAG execution-attempt fencing (DAG-A01)", () => {
  const it = testEffect(harness)

  it.live("rejects delayed success and failure from the replaced child while the current attempt can complete", () =>
    Effect.gen(function* () {
      const { dag, dagID, store } = yield* setup()
      const initial = (yield* store.getNode(dagID, "a"))!
      yield* dag.nodeQueued(dagID, "a", Date.now() + 60_000, {
        ...attempt(initial),
        nodeSeq: initial.seq,
      })
      yield* dag.nodeStarted(dagID, "a", "ses_old", Date.now() + 60_000, false, attempt(initial))
      const oldAttempt = attempt(initial, "ses_old")

      yield* dag.replan(dagID, { nodes: [{ ...node(), restart: true }] })
      const replacement = (yield* store.getNode(dagID, "a"))!
      yield* dag.nodeQueued(dagID, "a", Date.now() + 60_000, {
        ...attempt(replacement),
        nodeSeq: replacement.seq,
      })
      yield* dag.nodeStarted(dagID, "a", "ses_new", Date.now() + 60_000, false, attempt(replacement))

      expect(Exit.isFailure(yield* dag.nodeCompleted(dagID, "a", "old success", oldAttempt).pipe(Effect.exit))).toBe(
        true,
      )
      expect(
        Exit.isFailure(yield* dag.nodeFailed(dagID, "a", "old failure", "exec_failed", oldAttempt).pipe(Effect.exit)),
      ).toBe(true)
      expect(yield* store.getNode(dagID, "a")).toEqual(
        expect.objectContaining({ status: "running", childSessionId: "ses_new", replanAttempts: 1 }),
      )

      yield* dag.nodeCompleted(dagID, "a", "current success", attempt(replacement, "ses_new"))
      expect(yield* store.getNode(dagID, "a")).toEqual(
        expect.objectContaining({ status: "completed", output: "current success" }),
      )
    }).pipe(Effect.provideService(InstanceRef, instance)),
  )

  it.live("rejects admission and pre-admission failure from a stale pending definition snapshot", () =>
    Effect.gen(function* () {
      const { dag, dagID, store } = yield* setup()
      const stale = (yield* store.getNode(dagID, "a"))!
      const staleWorkflow = yield* requireValue(yield* store.getWorkflow(dagID), "workflow row missing before replan")
      const staleGraphRev = staleWorkflow.graphRev
      yield* dag.replan(dagID, { nodes: [node("replacement definition")] })

      const staleAdmission = { ...attempt(stale), nodeSeq: stale.seq }
      expect(
        Exit.isFailure(yield* dag.nodeQueued(dagID, "a", Date.now() + 60_000, staleAdmission).pipe(Effect.exit)),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* dag.nodeFailed(dagID, "a", "stale setup failure", "exec_failed", staleAdmission).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(yield* dag.nodeSkipped(dagID, "a", "condition_false", staleAdmission).pipe(Effect.exit)),
      ).toBe(true)
      const current = (yield* store.getNode(dagID, "a"))!
      expect(current).toEqual(expect.objectContaining({ status: "pending", name: "replacement definition" }))
      const currentWorkflow = yield* requireValue(yield* store.getWorkflow(dagID), "workflow row missing after replan")
      expect(
        Exit.isFailure(
          yield* dag
            .nodeQueued(dagID, "a", Date.now() + 60_000, {
              ...attempt(current),
              nodeSeq: current.seq,
              graphRev: staleGraphRev,
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      yield* dag.nodeQueued(dagID, "a", Date.now() + 60_000, {
        ...attempt(current),
        nodeSeq: current.seq,
        graphRev: currentWorkflow.graphRev,
      })
      expect((yield* store.getNode(dagID, "a"))?.status).toBe("queued")
    }).pipe(Effect.provideService(InstanceRef, instance)),
  )

  it.live("ends a stale deadline watcher before it can fail or cancel the replacement child", () =>
    Effect.gen(function* () {
      const { dag, dagID, store } = yield* setup()
      const initial = (yield* store.getNode(dagID, "a"))!
      yield* dag.nodeQueued(dagID, "a", Date.now() - 1, { ...attempt(initial), nodeSeq: initial.seq })
      yield* dag.nodeStarted(dagID, "a", "ses_old", Date.now() - 1, false, attempt(initial))
      const oldAttempt = attempt(initial, "ses_old")

      yield* dag.replan(dagID, { nodes: [{ ...node(), restart: true }] })
      const replacement = (yield* store.getNode(dagID, "a"))!
      yield* dag.nodeQueued(dagID, "a", Date.now() + 60_000, {
        ...attempt(replacement),
        nodeSeq: replacement.seq,
      })
      yield* dag.nodeStarted(dagID, "a", "ses_new", Date.now() + 60_000, false, attempt(replacement))

      yield* makeDeadlineWatcher({
        dagID,
        nodeID: "a",
        attempt: oldAttempt,
        timeoutMs: 1,
        maxTimeoutExtensions: 0,
      })
      expect(cancellations).toEqual([])
      expect(yield* store.getNode(dagID, "a")).toEqual(
        expect.objectContaining({ status: "running", childSessionId: "ses_new", timeoutExtensions: 0 }),
      )
    }).pipe(Effect.provideService(InstanceRef, instance)),
  )

  it.live("rejects a late timeout escalation after the current attempt completed", () =>
    Effect.gen(function* () {
      const { dag, dagID, store } = yield* setup()
      const initial = (yield* store.getNode(dagID, "a"))!
      yield* dag.nodeQueued(dagID, "a", Date.now() - 1, { ...attempt(initial), nodeSeq: initial.seq })
      yield* dag.nodeStarted(dagID, "a", "ses_current", Date.now() - 1, false, attempt(initial))
      const currentAttempt = attempt(initial, "ses_current")
      yield* dag.nodeCompleted(dagID, "a", "done", currentAttempt)

      expect(
        Exit.isFailure(
          yield* dag
            .nodeTimeoutEscalated(dagID, "a", "ses_current", 1, Date.now() - 1, currentAttempt)
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* store.getNode(dagID, "a")).toEqual(
        expect.objectContaining({ status: "completed", timeoutExtensions: 0 }),
      )
    }).pipe(Effect.provideService(InstanceRef, instance)),
  )

  it.live("rejects a recovery result captured before restart", () =>
    Effect.gen(function* () {
      const { dag, dagID, store } = yield* setup()
      const initial = (yield* store.getNode(dagID, "a"))!
      yield* dag.nodeQueued(dagID, "a", Date.now() + 60_000, { ...attempt(initial), nodeSeq: initial.seq })
      yield* dag.nodeStarted(dagID, "a", "ses_old", Date.now() + 60_000, false, attempt(initial))
      const checked = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const recovery = yield* reconcileWorkflow(
        dagID,
        () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(checked, undefined)
            yield* Deferred.await(release)
            return "completed" as const
          }),
        undefined,
        { nodes: [node()] },
        () => Effect.succeed("old recovered output"),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(checked)

      yield* dag.replan(dagID, { nodes: [{ ...node(), restart: true }] })
      const replacement = (yield* store.getNode(dagID, "a"))!
      yield* dag.nodeQueued(dagID, "a", Date.now() + 60_000, {
        ...attempt(replacement),
        nodeSeq: replacement.seq,
      })
      yield* dag.nodeStarted(dagID, "a", "ses_new", Date.now() + 60_000, false, attempt(replacement))
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(recovery)).toEqual({ reconciled: 0, ownershipLost: 0 })

      expect(yield* store.getNode(dagID, "a")).toEqual(
        expect.objectContaining({ status: "running", childSessionId: "ses_new", output: null }),
      )
    }).pipe(Effect.provideService(InstanceRef, instance)),
  )
})
