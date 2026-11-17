// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1031 M5: the session token budget. Accounting comes from the durable
// attempt ledger, the gate is DagBudget.check, exhaustion pauses and cancels,
// and a user raise requeues + resumes (exactly one engine wake).
import { describe, expect, test } from "bun:test"
import { DateTime, Deferred, Effect, Layer, Schema } from "effect"
import { ConfigV1 } from "@graphagent/core/v1/config/config"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { SessionTable } from "@graphagent/core/session/sql"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { DagEvent } from "@graphagent/schema/dag-event"
import { TuiEvent } from "@graphagent/schema/tui-event"
import { PAUSE_REASON_BUDGET_EXHAUSTED, ERROR_CLASS_BUDGET_EXHAUSTED } from "@graphagent/schema/dag-status"
import { Dag } from "@/dag/dag"
import { DagBudget, tierOf } from "@/dag/budget"
import { DagMode } from "@/dag/mode"
import { ResumeBlockedError, ResumeGuard } from "@/dag/resume-guard"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance } from "@/effect/instance-registry"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { SessionInbox } from "@/session/inbox"
import { EngineProcess } from "@/session/engine-process"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { pollWithTimeout } from "../lib/effect"
import { transactLayer } from "./fixture/transact"

const dagID = DagEvent.DagID.make("dag_budget")
const parent = SessionID.make("ses_budget")
const child = SessionID.make("ses_budget_child")
const ts = (n: number) => DateTime.makeUnsafe(n)

interface HarnessState {
  sessionBudget: number | null
  unlimited: boolean
  globalBudget: number | null
  warnRatio: number
}

/** Services the composed harness layer provides. */
type LayerServices =
  | Database.Service
  | EventV2.Service
  | EventV2Bridge.Service
  | DagStore.Service
  | Dag.Service
  | Session.Service
  | Config.Service
  | SessionInbox.Service
  | DagBudget.Service
  | ResumeGuard.Service

interface Harness {
  readonly state: HarnessState
  readonly wakes: Array<{ sessionID: string; text: string }>
  readonly counters: { pauseCalls: number; requeueCalls: number }
  readonly layer: Layer.Layer<LayerServices>
}

interface HarnessOptions {
  /** Blocks the transition toast after the pass read usage, exposing the
   *  window between the read and the end of a reconciliation. */
  readonly toastGate?: { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
  /** Fails the first N pauseForBudget calls (a transient workflow lock timeout). */
  readonly failPauseForBudget?: number
  /** Scripted requeueNodes outcomes: "fail" throws, "partial" requeues all but
   *  the last requested node (the rest stay failed). */
  readonly requeueOutcomes?: ReadonlyArray<"fail" | "partial">
  /** Scripted resume outcomes: "fail" throws a transient workflow lock error. */
  readonly resumeOutcomes?: ReadonlyArray<"fail">
  /** The inbox mock requires an instance context, like the real submit. */
  readonly inboxRequiresInstance?: boolean
}

function makeHarness(initial: Partial<HarnessState> = {}, options: HarnessOptions = {}): Harness {
  const state: HarnessState = {
    sessionBudget: null,
    unlimited: false,
    globalBudget: 1000,
    warnRatio: 0.8,
    ...initial,
  }
  const wakes: Array<{ sessionID: string; text: string }> = []
  const counters = { pauseCalls: 0, requeueCalls: 0 }
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const rawBridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const toastGate = options.toastGate
  const bridge =
    toastGate === undefined
      ? rawBridge
      : Layer.effect(
          EventV2Bridge.Service,
          Effect.gen(function* () {
            const original = yield* EventV2Bridge.Service
            const publish: EventV2.Interface["publish"] = (definition, data, publishOptions) =>
              definition.type === TuiEvent.ToastShow.type
                ? Deferred.succeed(toastGate.entered, undefined).pipe(
                    Effect.andThen(Deferred.await(toastGate.release)),
                    Effect.andThen(original.publish(definition, data, publishOptions)),
                  )
                : original.publish(definition, data, publishOptions)
            return EventV2Bridge.Service.of({ ...original, publish })
          }),
        ).pipe(Layer.provide(rawBridge))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const rawDag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store), Layer.provide(transactLayer(database)))
  const failPause = options.failPauseForBudget ?? 0
  const requeueOutcomes = options.requeueOutcomes ?? []
  const resumeOutcomes = options.resumeOutcomes ?? []
  const dag =
    failPause === 0 && requeueOutcomes.length === 0 && resumeOutcomes.length === 0
      ? rawDag
      : Layer.effect(
          Dag.Service,
          Effect.gen(function* () {
            const original = yield* Dag.Service
            let pauseRemaining = failPause
            let requeueCall = 0
            let resumeCall = 0
            return Dag.Service.of({
              ...original,
              pauseForBudget: (dagID) =>
                Effect.suspend(() => {
                  counters.pauseCalls++
                  if (pauseRemaining === 0) return original.pauseForBudget(dagID)
                  pauseRemaining--
                  return Effect.fail(new Error("workflow lock timeout"))
                }),
              requeueNodes: (dagID, nodeIDs, reason) =>
                Effect.suspend(() => {
                  counters.requeueCalls++
                  const scripted = requeueOutcomes[requeueCall++]
                  if (scripted === "fail") return Effect.fail(new Error("workflow lock timeout"))
                  if (scripted === "partial")
                    return original.requeueNodes(dagID, nodeIDs.slice(0, -1), reason)
                  return original.requeueNodes(dagID, nodeIDs, reason)
                }),
              resume: (dagID) =>
                Effect.suspend(() => {
                  if (resumeOutcomes[resumeCall++] !== "fail") return original.resume(dagID)
                  return Effect.fail(new Error("workflow lock timeout"))
                }),
            })
          }),
        ).pipe(Layer.provide(rawDag))
  const sessions = Layer.mock(Session.Service, {
    get: () =>
      Effect.succeed({
        id: parent,
        slug: "budget",
        projectID: Project.ID.global,
        directory: process.cwd(),
        title: "budget",
        agent: "build",
        version: "test",
        time: { created: 0, updated: 0 },
        dagBudgetTokens: state.sessionBudget ?? undefined,
        dagBudgetUnlimited: state.unlimited,
      }),
  })
  const config = Layer.mock(Config.Service, {
    dagGlobal: () =>
      Effect.sync(() =>
        Schema.decodeUnknownSync(ConfigV1.Dag)({
          budget: { tokens: state.globalBudget, warn_ratio: state.warnRatio },
        }),
      ),
  })
  const inbox = Layer.mock(SessionInbox.Service, {
    submit: (_source, sessionID, item) =>
      Effect.gen(function* () {
        if (options.inboxRequiresInstance) {
          const instance = yield* InstanceRef
          if (!instance) return yield* Effect.die(new Error("inbox submit ran without an instance context"))
        }
        const text = (item.prompt?.parts ?? [])
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n")
        wakes.push({ sessionID, text })
        return { state: "duplicate" as const }
      }),
  })
  const base = Layer.mergeAll(
    database,
    events,
    bridge,
    store,
    projector,
    dag,
    sessions,
    config,
    inbox,
  )
  const budget = Layer.merge(
    DagBudget.layer,
    // The policy is output, so a Dag.resume called by the test carries it.
    DagBudget.resumeGuardLayer.pipe(Layer.provide(DagBudget.layer)),
  )
  return { state, wakes, counters, layer: Layer.provideMerge(budget, base) }
}

const run = <A, E>(
  harness: Harness,
  effect: Effect.Effect<A, E, LayerServices>,
) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(harness.layer)))

function seed() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(process.cwd()), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: parent,
        project_id: Project.ID.global,
        slug: "budget",
        directory: process.cwd(),
        title: "budget",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: child,
        project_id: Project.ID.global,
        slug: "budget-child",
        directory: process.cwd(),
        title: "budget-child",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

/** Create a running workflow with two registered nodes. */
function createWorkflow() {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(DagEvent.WorkflowCreated, {
      dagID,
      projectID: Project.ID.global,
      sessionID: parent,
      title: "budget-test",
      config: JSON.stringify({ name: "budget", nodes: [{ id: "a" }, { id: "b" }] }),
      status: "pending",
      directory: process.cwd(),
      timestamp: ts(0),
    })
    for (const id of ["a", "b"]) {
      yield* events.publish(DagEvent.NodeRegistered, {
        dagID,
        nodeID: DagEvent.NodeID.make(id),
        name: id,
        workerType: "build",
        dependsOn: [],
        required: true,
        timestamp: ts(1),
      })
    }
    yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: ts(2) })
  })
}

const startNode = (nodeID: string, childSessionID: SessionID) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(DagEvent.NodeStarted, {
      dagID,
      nodeID: DagEvent.NodeID.make(nodeID),
      childSessionID,
      timestamp: ts(3),
    })
  })

const queueNode = (nodeID: string) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(DagEvent.NodeQueued, { dagID, nodeID: DagEvent.NodeID.make(nodeID), timestamp: ts(3) })
  })

/** Publish the child's step boundary that carries the durable usage trigger. */
const publishStepFinish = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(SessionV1.Event.PartUpdated, {
      sessionID,
      time: Date.now(),
      part: {
        id: PartID.ascending(),
        messageID: MessageID.ascending(),
        sessionID,
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })
  })

const setChildTokens = (input: {
  input: number
  output: number
  reasoning: number
  cacheWrite: number
  cacheRead: number
}) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({
        tokens_input: input.input,
        tokens_output: input.output,
        tokens_reasoning: input.reasoning,
        tokens_cache_write: input.cacheWrite,
        tokens_cache_read: input.cacheRead,
      })
      .run()
      .pipe(Effect.orDie)
  })

const readWorkflow = Effect.gen(function* () {
  const store = yield* DagStore.Service
  return (yield* store.getWorkflow(dagID).pipe(Effect.orDie))!
})

const readNodes = Effect.gen(function* () {
  const store = yield* DagStore.Service
  return yield* store.getCurrentNodes(dagID).pipe(Effect.orDie)
})

/** The owner instance a bootstrap `init` runs under. */
const ownerInstance = {
  directory: process.cwd(),
  worktree: process.cwd(),
  root: process.cwd(),
  project: {
    id: Project.ID.global,
    worktree: process.cwd(),
    time: { created: 0, updated: 0 },
    sandboxes: [],
  },
  trustProject: true,
}

describe("DagBudget accounting", () => {
  test("tier thresholds: warn at the ratio, exhausted at the budget, unlimited never", () => {
    expect(tierOf(799, 1000, 0.8)).toBe("normal")
    expect(tierOf(800, 1000, 0.8)).toBe("warn")
    expect(tierOf(999, 1000, 0.8)).toBe("warn")
    expect(tierOf(1000, 1000, 0.8)).toBe("exhausted")
    expect(tierOf(10_000_000, null, 0.8)).toBe("normal")
  })

  test("sums every attempt as input+cache_write+output+reasoning and reports cache reads separately", async () => {
    const harness = makeHarness()
    await run(
      harness,
      Effect.gen(function* () {
        yield* seed()
        yield* createWorkflow()
        yield* startNode("a", child)
        yield* setChildTokens({ input: 400, output: 200, reasoning: 100, cacheWrite: 100, cacheRead: 5000 })
        const budget = yield* DagBudget.Service
        const state = yield* budget.state(parent)
        expect(state.used).toBe(800)
        expect(state.cacheRead).toBe(5000)
        expect(state.budget).toBe(1000)
        expect(state.tier).toBe("warn")
        // At 800/1000 the gate passes; at 1000 it fails.
        yield* budget.check(parent)
        harness.state.sessionBudget = 800
        const failure = yield* budget.check(parent).pipe(Effect.flip)
        expect(failure.sessionID).toBe(parent)
        expect(failure.budget).toBe(800)
      }),
    )
  })

  test("a session `budget off` override is unlimited, not the global default", async () => {
    const harness = makeHarness({ unlimited: true, globalBudget: 1000 })
    await run(
      harness,
      Effect.gen(function* () {
        yield* seed()
        yield* createWorkflow()
        yield* startNode("a", child)
        yield* setChildTokens({ input: 5000, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0 })
        const budget = yield* DagBudget.Service
        expect((yield* budget.state(parent)).budget).toBeNull()
        yield* budget.check(parent)
      }),
    )
  })
})

describe("DagBudget exhaustion", () => {
  test("pauses live workflows, cancels in-flight nodes, and blocks resume", async () => {
    const harness = makeHarness({ globalBudget: 1000 })
    await run(
      harness,
      Effect.gen(function* () {
        yield* seed()
        yield* createWorkflow()
        yield* startNode("a", child)
        yield* queueNode("b")
        yield* setChildTokens({ input: 1200, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0 })
        const budget = yield* DagBudget.Service
        const dag = yield* Dag.Service

        expect(yield* budget.exhaust(parent)).toBe(1)
        const workflow = yield* readWorkflow
        expect(workflow.status).toBe("paused")
        expect(workflow.pauseReason).toBe(PAUSE_REASON_BUDGET_EXHAUSTED)
        const nodes = yield* readNodes
        expect(
          nodes
            .map((node) => [node.id, node.status, node.errorClass])
            .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
        ).toEqual([
          ["a", "failed", ERROR_CLASS_BUDGET_EXHAUSTED],
          ["b", "failed", ERROR_CLASS_BUDGET_EXHAUSTED],
        ])
        // The ResumeGuard policy (DagBudget) vetoes the paused workflow.
        const failure = yield* dag.resume(dagID).pipe(Effect.flip)
        expect(failure).toBeInstanceOf(ResumeBlockedError)
        expect(failure instanceof ResumeBlockedError ? failure.pauseReason : undefined).toBe(
          PAUSE_REASON_BUDGET_EXHAUSTED,
        )
        // Step is rejected too. A paused workflow fails the state-machine check
        // before the guard (paused→stepping is not a legal transition), so any
        // refusal is correct here; the guard's own step path is covered by
        // dag-resume-guard.test.ts against a running workflow.
        expect(yield* dag.step(dagID).pipe(Effect.flip)).toBeInstanceOf(Error)
      }),
    )
  })
})

describe("DagBudget raise", () => {
  test("requeues budget-cancelled nodes, resumes the workflow, and wakes once", async () => {
    const harness = makeHarness({ globalBudget: 1000 })
    await run(
      harness,
      Effect.gen(function* () {
        yield* seed()
        yield* createWorkflow()
        yield* startNode("a", child)
        yield* queueNode("b")
        yield* setChildTokens({ input: 1200, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0 })
        const budget = yield* DagBudget.Service
        yield* budget.exhaust(parent)

        // The user raises the budget through /dag-mode budget or /config.
        harness.state.globalBudget = 5000
        expect(yield* budget.onBudgetChanged(parent)).toBe(1)

        const workflow = yield* readWorkflow
        expect(workflow.status).toBe("running")
        expect(workflow.pauseReason).toBeNull()
        const nodes = yield* readNodes
        expect(
          nodes
            .map((node) => [node.id, node.status, node.childSessionId, node.replanAttempts])
            .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
        ).toEqual([
          ["a", "pending", null, 0],
          ["b", "pending", null, 0],
        ])
        expect(harness.wakes).toHaveLength(1)
        expect(harness.wakes[0]?.text).toBe("budget raised by the user; 1 workflows resumed")

        // A repeated reconcile finds nothing paused: no second wake.
        expect(yield* budget.onBudgetChanged(parent)).toBe(0)
        expect(harness.wakes).toHaveLength(1)
      }),
    )
  })
})

describe("Dag D12 budget primitives", () => {
  test("pauseForBudget ignores missing, pending, and manually paused workflows", async () => {
    const harness = makeHarness()
    await run(
      harness,
      Effect.gen(function* () {
        yield* seed()
        const dag = yield* Dag.Service
        expect(yield* dag.pauseForBudget("dag_missing")).toBe("ignored")

        // A pending workflow has no schedulable work to pause.
        const events = yield* EventV2.Service
        yield* events.publish(DagEvent.WorkflowCreated, {
          dagID: DagEvent.DagID.make("dag_pending"),
          projectID: Project.ID.global,
          sessionID: parent,
          title: "pending",
          config: JSON.stringify({ name: "pending", nodes: [] }),
          status: "pending",
          directory: process.cwd(),
          timestamp: ts(0),
        })
        expect(yield* dag.pauseForBudget("dag_pending")).toBe("ignored")

        // A checkpoint pause owns its own in-flight policy.
        yield* createWorkflow()
        yield* startNode("a", child)
        yield* events.publish(DagEvent.WorkflowPaused, {
          dagID,
          reason: "checkpoint",
          timestamp: ts(4),
        })
        expect(yield* dag.pauseForBudget(dagID)).toBe("ignored")
        expect((yield* readNodes)[0]?.status).toBe("running")
      }),
    )
  })

  test("pauseForBudget is idempotent once the workflow is already budget-paused", async () => {
    const harness = makeHarness({ globalBudget: 1000 })
    await run(
      harness,
      Effect.gen(function* () {
        yield* seed()
        yield* createWorkflow()
        yield* startNode("a", child)
        yield* setChildTokens({ input: 1200, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0 })
        const dag = yield* Dag.Service
        expect(yield* dag.pauseForBudget(dagID)).toBe("paused")
        expect(yield* dag.pauseForBudget(dagID)).toBe("paused")
        expect((yield* readNodes)[0]?.status).toBe("failed")
      }),
    )
  })

  test("requeueNodes validates its target state and node scope", async () => {
    const harness = makeHarness()
    await run(
      harness,
      Effect.gen(function* () {
        yield* seed()
        const dag = yield* Dag.Service
        const missing = yield* dag.requeueNodes("dag_missing", ["a"], "raise").pipe(Effect.flip)
        expect(String(missing)).toContain("Workflow not found")

        yield* createWorkflow()
        // Running workflows are not a requeue target.
        expect((yield* dag.requeueNodes(dagID, ["a"], "raise")).requeued).toEqual([])

        yield* startNode("a", child)
        yield* queueNode("b")
        yield* setChildTokens({ input: 1200, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0 })
        const budget = yield* DagBudget.Service
        yield* budget.exhaust(parent)
        // Only budget-cancelled rows are eligible; a node that never started
        // is not in the cancelled set, and an unknown id is rejected.
        const unknown = yield* dag.requeueNodes(dagID, ["nope"], "raise").pipe(Effect.flip)
        expect(String(unknown)).toContain("Node not found")
        const pendingAgain = yield* dag.requeueNodes(dagID, ["a"], "raise")
        expect(pendingAgain.requeued).toEqual(["a"])
        // Requeuing an already-pending node is a no-op.
        expect((yield* dag.requeueNodes(dagID, ["a"], "raise")).requeued).toEqual([])
      }),
    )
  })
})

describe("DagBudget in-flight detection", () => {
  test("a child step-finish recomputes the tier and republishes L2", async () => {
    const harness = makeHarness({ globalBudget: 1000 })
    await run(
      harness,
      Effect.gen(function* () {
        yield* seed()
        yield* createWorkflow()
        yield* startNode("a", child)
        yield* setChildTokens({ input: 700, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0 })
        const budget = yield* DagBudget.Service
        yield* budget.init()
        DagMode.set(parent, { mode: "on", budget: 1000, concurrency: 4, maxTotalNodes: 100 })

        const events = yield* EventV2.Service
        yield* setChildTokens({ input: 850, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0 })
        yield* events.publish(SessionV1.Event.PartUpdated, {
          sessionID: child,
          time: Date.now(),
          part: {
            id: PartID.make("prt_budget_step"),
            messageID: MessageID.make("msg_budget_step"),
            sessionID: child,
            type: "step-finish",
            reason: "stop",
            cost: 0,
            tokens: { input: 850, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        })
        // The coalescer waits 100 ms before reading the durable projection.
        yield* Effect.sleep("400 millis")
        expect(DagMode.budgetState(parent)?.tier).toBe("warn")
        const slot = (yield* Effect.sync(() =>
          EngineProcess.runtimes.runtimeSlots.list(parent).find((item) => item.key === "dag_mode"),
        ))!
        expect(slot.parts.join("\n")).toContain("DAG token budget: over 85% used")
      }),
    )
  })
})

describe("DagBudget coalescing", () => {
  test("a usage trigger that lands during a reconciliation still exhausts", async () => {
    const entered = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const harness = makeHarness({ globalBudget: 1000 }, { toastGate: { entered, release } })
    await run(
      harness,
      Effect.gen(function* () {
        yield* seed()
        yield* createWorkflow()
        yield* startNode("a", child)
        yield* setChildTokens({ input: 700, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0 })
        const budget = yield* DagBudget.Service
        // Baseline pass: 700/1000 is normal, so the next pass is the first
        // normal→warn transition and publishes the gated toast.
        yield* budget.init()

        yield* setChildTokens({ input: 850, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0 })
        yield* publishStepFinish(child)
        // The pass has read 850 and is blocked publishing its transition toast.
        yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))

        // This update lands after the read and crosses the budget. Its trigger
        // must schedule a trailing pass instead of being coalesced away.
        yield* setChildTokens({ input: 1200, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0 })
        yield* publishStepFinish(child)
        yield* Deferred.succeed(release, undefined)

        const workflow = yield* pollWithTimeout(
          readWorkflow.pipe(Effect.map((workflow) => (workflow.status === "paused" ? workflow : undefined))),
          "trailing reconciliation did not exhaust the budget",
        )
        expect(workflow.pauseReason).toBe(PAUSE_REASON_BUDGET_EXHAUSTED)
        expect((yield* readNodes).find((node) => node.id === "a")?.errorClass).toBe(ERROR_CLASS_BUDGET_EXHAUSTED)
      }),
    )
  })
})

describe("DagBudget instance context", () => {
  test("a background budget raise re-enters the owner instance to deliver the wake", async () => {
    const harness = makeHarness({ globalBudget: 1000 }, { inboxRequiresInstance: true })
    await run(
      harness,
      Effect.gen(function* () {
        yield* seed()
        yield* createWorkflow()
        yield* startNode("a", child)
        yield* setChildTokens({ input: 1200, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0 })
        const budget = yield* DagBudget.Service
        yield* budget.exhaust(parent)
        expect((yield* readWorkflow).status).toBe("paused")

        // Instance bootstrap runs init inside the owner instance; the captured
        // context is what the background raise paths must re-enter.
        yield* budget.init().pipe(Effect.provideService(InstanceRef, ownerInstance))

        // The raise arrives as a durable session update. Its listener runs in
        // the EventV2 background runtime, which carries no instance context.
        harness.state.globalBudget = 5000
        const events = yield* EventV2.Service
        yield* events.publish(SessionV1.Event.Updated, {
          sessionID: parent,
          info: {
            id: parent,
            slug: "budget",
            projectID: Project.ID.global,
            directory: process.cwd(),
            title: "budget",
            version: "test",
            time: { created: 0, updated: 1 },
            dagBudgetTokens: 5000,
          },
        })

        yield* pollWithTimeout(
          Effect.sync(() => (harness.wakes.length > 0 ? harness.wakes : undefined)),
          "background budget raise did not deliver the resume wake",
        )
        expect(harness.wakes).toHaveLength(1)
        expect(harness.wakes[0]?.sessionID).toBe(parent)
        expect(harness.wakes[0]?.text).toBe("budget raised by the user; 1 workflows resumed")
        expect((yield* readWorkflow).status).toBe("running")
      }),
    )
  })
})

describe("DagBudget exhaustion retry", () => {
  test("retries a transiently failed pause on the next reconciliation", async () => {
    const harness = makeHarness({ globalBudget: 1000 }, { failPauseForBudget: 1 })
    await run(
      harness,
      Effect.gen(function* () {
        yield* seed()
        yield* createWorkflow()
        yield* startNode("a", child)
        yield* setChildTokens({ input: 1200, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0 })
        const budget = yield* DagBudget.Service

        // The first pass records the exhausted tier but the pause fails
        // transiently (a workflow lock timeout): the workflow keeps running.
        expect(yield* budget.onBudgetChanged(parent)).toBe(0)
        expect((yield* readWorkflow).status).toBe("running")

        // A later reconciliation retries enforcement independently of the
        // tier transition, which is already recorded as exhausted.
        expect(yield* budget.onBudgetChanged(parent)).toBe(0)
        const workflow = yield* pollWithTimeout(
          readWorkflow.pipe(Effect.map((workflow) => (workflow.status === "paused" ? workflow : undefined))),
          "the retried exhaustion did not pause the workflow",
        )
        expect(workflow.pauseReason).toBe(PAUSE_REASON_BUDGET_EXHAUSTED)
        expect((yield* readNodes).find((node) => node.id === "a")?.errorClass).toBe(ERROR_CLASS_BUDGET_EXHAUSTED)

        // Once enforcement succeeded the session is disarmed: a further pass
        // does not re-run it.
        const calls = harness.counters.pauseCalls
        yield* budget.onBudgetChanged(parent)
        expect(harness.counters.pauseCalls).toBe(calls)
      }),
    )
  })
})

describe("DagBudget raise requeue failure", () => {
  test("keeps the workflow budget-paused until every cancelled node is requeued", async () => {
    const harness = makeHarness({ globalBudget: 1000 }, { requeueOutcomes: ["fail", "partial"] })
    await run(
      harness,
      Effect.gen(function* () {
        yield* seed()
        yield* createWorkflow()
        yield* startNode("a", child)
        yield* queueNode("b")
        yield* setChildTokens({ input: 1200, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0 })
        const budget = yield* DagBudget.Service
        yield* budget.exhaust(parent)
        expect((yield* readWorkflow).status).toBe("paused")

        harness.state.globalBudget = 5000

        // A transient workflow-lock failure requeues nothing: resuming now
        // would settle the workflow as a required-node failure instead of
        // rerunning the cancelled attempts.
        expect(yield* budget.onBudgetChanged(parent)).toBe(0)
        let workflow = yield* readWorkflow
        expect(workflow.status).toBe("paused")
        expect(workflow.pauseReason).toBe(PAUSE_REASON_BUDGET_EXHAUSTED)
        expect(
          (yield* readNodes).every(
            (node) => node.status === "failed" && node.errorClass === ERROR_CLASS_BUDGET_EXHAUSTED,
          ),
        ).toBe(true)
        expect(harness.wakes).toHaveLength(0)

        // A partial replay (another actor moved a target row) is not enough:
        // only a fresh read of the remaining cancelled rows may resume.
        expect(yield* budget.onBudgetChanged(parent)).toBe(0)
        workflow = yield* readWorkflow
        expect(workflow.status).toBe("paused")
        expect((yield* readNodes).some((node) => node.status === "failed")).toBe(true)
        expect(harness.wakes).toHaveLength(0)

        // A usage-triggered reconciliation (no new raise) retries the blocked
        // replay, requeues the remaining rows and resumes exactly once.
        yield* publishStepFinish(child)
        yield* pollWithTimeout(
          Effect.sync(() => (harness.wakes.length > 0 ? harness.wakes : undefined)),
          "the blocked raise was not retried on the next reconciliation",
        )
        workflow = yield* readWorkflow
        expect(workflow.status).toBe("running")
        expect(
          (yield* readNodes).every((node) => node.status === "pending" && node.childSessionId === null),
        ).toBe(true)
        expect(harness.wakes).toHaveLength(1)
      }),
    )
  })
})

describe("DagBudget instance lifecycle", () => {
  test("does not resume or wake a disposed instance's workflows, and reopens them on init", async () => {
    const harness = makeHarness({ globalBudget: 1000 })
    await run(
      harness,
      Effect.gen(function* () {
        yield* seed()
        yield* createWorkflow()
        yield* startNode("a", child)
        yield* setChildTokens({ input: 1200, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0 })
        const budget = yield* DagBudget.Service
        yield* budget.exhaust(parent)
        expect((yield* readWorkflow).status).toBe("paused")

        // Bootstrap the owner instance, then dispose it. The registered
        // disposer runs before a reload would bootstrap the next generation,
        // so the captured context is gone rather than stale.
        yield* budget.init().pipe(Effect.provideService(InstanceRef, ownerInstance))
        expect(DagMode.budgetState(parent)?.tier).toBe("exhausted")
        yield* Effect.promise(() => disposeInstance(process.cwd()))

        // A `/config` raise reaches the process-wide consumer while the owner
        // is gone. It must neither resume the workflow from a background
        // context nor submit the wake into the closed generation.
        harness.state.globalBudget = 5000
        const events = yield* EventV2.Service
        yield* events.publish(SessionV1.Event.Updated, {
          sessionID: parent,
          info: {
            id: parent,
            slug: "budget",
            projectID: Project.ID.global,
            directory: process.cwd(),
            title: "budget",
            version: "test",
            time: { created: 0, updated: 1 },
            dagBudgetTokens: 5000,
          },
        })
        yield* pollWithTimeout(
          Effect.sync(() => (DagMode.budgetState(parent)?.tier === "normal" ? true : undefined)),
          "the background raise did not reconcile",
        )
        const paused = yield* readWorkflow
        expect(paused.status).toBe("paused")
        expect(paused.pauseReason).toBe(PAUSE_REASON_BUDGET_EXHAUSTED)
        expect(harness.wakes).toHaveLength(0)

        // The owner loads again: its bootstrap reconciles the still-paused
        // workflow below the raised budget and delivers the wake through the
        // new generation's context.
        yield* budget.init().pipe(Effect.provideService(InstanceRef, ownerInstance))
        yield* pollWithTimeout(
          Effect.sync(() => (harness.wakes.length > 0 ? harness.wakes : undefined)),
          "the reopened instance did not resume and wake the workflow",
        )
        expect(harness.wakes).toHaveLength(1)
        expect(harness.wakes[0]?.text).toBe("budget raised by the user; 1 workflows resumed")
        expect((yield* readWorkflow).status).toBe("running")
      }),
    )
  })
})

describe("DagBudget resume failure", () => {
  test("retries a transiently failed resume on the next reconciliation", async () => {
    const harness = makeHarness({ globalBudget: 1000 }, { resumeOutcomes: ["fail"] })
    await run(
      harness,
      Effect.gen(function* () {
        yield* seed()
        yield* createWorkflow()
        yield* startNode("a", child)
        yield* queueNode("b")
        yield* setChildTokens({ input: 1200, output: 0, reasoning: 0, cacheWrite: 0, cacheRead: 0 })
        const budget = yield* DagBudget.Service
        yield* budget.exhaust(parent)
        expect((yield* readWorkflow).status).toBe("paused")

        harness.state.globalBudget = 5000

        // The replay succeeds but the resume hits a transient workflow-lock
        // failure. The cancelled rows are already pending, so the workflow must
        // stay budget-paused with the session armed for a retry, not silently
        // settle as a required-node failure or park until another raise.
        expect(yield* budget.onBudgetChanged(parent)).toBe(0)
        let workflow = yield* readWorkflow
        expect(workflow.status).toBe("paused")
        expect(workflow.pauseReason).toBe(PAUSE_REASON_BUDGET_EXHAUSTED)
        expect(
          (yield* readNodes).every((node) => node.status === "pending" && node.childSessionId === null),
        ).toBe(true)
        expect(harness.wakes).toHaveLength(0)

        // A usage-triggered reconciliation (no new raise) finds nothing left to
        // replay and retries only the resume, which now succeeds once.
        yield* publishStepFinish(child)
        yield* pollWithTimeout(
          Effect.sync(() => (harness.wakes.length > 0 ? harness.wakes : undefined)),
          "the failed resume was not retried on the next reconciliation",
        )
        workflow = yield* readWorkflow
        expect(workflow.status).toBe("running")
        expect(harness.wakes).toHaveLength(1)
        expect(harness.wakes[0]?.text).toBe("budget raised by the user; 1 workflows resumed")
        // No second resume: the retry saw the already-requeued rows.
        expect(harness.counters.requeueCalls).toBe(1)
      }),
    )
  })
})
