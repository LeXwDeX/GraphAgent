// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * #1344: the gates of DagLoop (`runtime/gates.ts`), called directly with scripted
 * collaborators. The loop's own cases drive them through events. The cases here are
 * what those cannot reach without racing the loop: a checkpoint pause that fails twice
 * while the durable row cannot be read, and a cascade skip that the durable row has
 * already moved past.
 */
import { expect } from "bun:test"
import { Context, Effect, Layer, Semaphore } from "effect"
import { WorkflowRuntime, toSchedulingNodes } from "@graphagent/core/dag/core/scheduling"
import { TerminalViolationError } from "@graphagent/core/dag/core/types"
import { DagStore } from "@graphagent/core/dag/store"
import { Project } from "@graphagent/core/project"
import { Dag } from "@/dag/dag"
import type { WorkflowEntry } from "@/dag/runtime/entry"
import { DagLoopGates } from "@/dag/runtime/gates"
import type { InstanceContext } from "@/project/instance-context"
import { testEffect } from "../lib/effect"
import { makeNodeRow } from "./fixtures"

const it = testEffect(Layer.empty)

const ctx: InstanceContext = {
  directory: process.cwd(),
  worktree: process.cwd(),
  root: process.cwd(),
  project: {
    id: Project.ID.make("project-1"),
    worktree: process.cwd(),
    time: { created: 0, updated: 0 },
    sandboxes: [],
  },
}

const storeOf = (partial: Partial<DagStore.Interface>) =>
  Layer.build(Layer.mock(DagStore.Service, partial)).pipe(
    Effect.map((context) => Context.get(context, DagStore.Service)),
  )

const portOf = (store: DagStore.Interface, partial: Omit<Partial<Dag.Interface>, "store">) =>
  Layer.build(Layer.mock(Dag.Service, { store, ...partial })).pipe(
    Effect.map((context) => Context.get(context, Dag.Service)),
  )

const entryOf = (port: Dag.Interface, runtime: WorkflowRuntime): WorkflowEntry => ({
  token: { runnerID: "1:me", epoch: 1 },
  port,
  runtime,
  concurrency: 1,
  evalLock: Semaphore.makeUnsafe(1),
  parentSessionID: "ses_parent",
  config: undefined,
  graphRev: 5,
  fibers: new Map(),
  watchers: new Map(),
  attemptChild: new WeakMap(),
  messageContinuations: new Set(),
  vetoHold: false,
})

const skippedA = makeNodeRow({ id: "a", status: "skipped" })
const pendingB = makeNodeRow({ id: "b", status: "pending", dependsOn: ["a"], seq: 3 })

it.effect("a checkpoint whose pause failed twice and whose durable row cannot be read is inactive", () =>
  Effect.gen(function* () {
    const store = yield* storeOf({ getWorkflow: () => Effect.die(new Error("database unavailable")) })
    const port = yield* portOf(store, { pauseForCheckpoint: () => Effect.fail(new Error("pause failed")) })
    const gates = DagLoopGates.make({ store, runtimes: new Map(), ctx })

    expect(yield* gates.checkpointDisposition("wf-1", { id: "review", seq: 2 }, port)).toBe("inactive")
  }),
)

it.effect("a cascade skip the durable row has already moved past is dropped without touching the runtime", () =>
  Effect.gen(function* () {
    const skips: unknown[][] = []
    const store = yield* storeOf({ getNode: (_dagID, nodeID) => Effect.succeed(nodeID === "b" ? pendingB : skippedA) })
    const port = yield* portOf(store, {
      nodeSkipped: (...args) =>
        Effect.sync(() => skips.push(args)).pipe(
          Effect.andThen(Effect.fail(new TerminalViolationError("b", "skipped", "skipped"))),
        ),
    })
    const runtime = new WorkflowRuntime(toSchedulingNodes([skippedA, pendingB]), 1)
    const gates = DagLoopGates.make({ store, runtimes: new Map(), ctx })

    yield* gates.convergeSkippedNodes("wf-1", entryOf(port, runtime))

    // The write was refused as a transition rejection, so the runtime still holds `b` as a candidate: the
    // handler of the event that settled it (a replan, say) owns the rebuild.
    expect(skips).toEqual([["wf-1", "b", "orphan_cascade", { replanAttempts: 0, nodeSeq: 3, graphRev: 5 }]])
    expect(runtime.getCascadeSkipNodes()).toEqual(["b"])
  }),
)

it.effect("a cascade whose node row is gone ends without a write", () =>
  Effect.gen(function* () {
    const store = yield* storeOf({ getNode: () => Effect.succeed(undefined) })
    const port = yield* portOf(store, {})
    const runtime = new WorkflowRuntime(toSchedulingNodes([skippedA, pendingB]), 1)
    const gates = DagLoopGates.make({ store, runtimes: new Map(), ctx })

    yield* gates.convergeSkippedNodes("wf-1", entryOf(port, runtime))

    expect(runtime.getCascadeSkipNodes()).toEqual(["b"])
  }),
)
