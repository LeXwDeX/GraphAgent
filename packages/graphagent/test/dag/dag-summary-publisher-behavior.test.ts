import { describe, expect } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Layer } from "effect"
import { DagStore, type WorkflowRow, type WorkflowSummary } from "@opencode-ai/core/dag/store"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { logLines } from "effect/testing/TestConsole"
import { EventV2Bridge } from "@/event-v2-bridge"
import { DagSummaryPublisher } from "@/dag/runtime/summary-publisher"
import { GlobalBus } from "@/bus/global"
import { InstanceState } from "@/effect/instance-state"
import { it, pollWithTimeout } from "../lib/effect"

const ts = (n: number) => DateTime.makeUnsafe(n)

interface SummaryEmission {
  sessionID: string
  summaries: WorkflowSummary[]
  workspace?: string
}

interface StoreControl {
  failures: number
  failuresAfterGate: number
  /** DAG-04: fail the summary read with an interrupt cause (the shape a
   * scoped disposal delivers mid-publish). */
  interruptRead?: boolean
  readGate?: {
    started: Deferred.Deferred<void>
    release: Deferred.Deferred<void>
  }
  reads: Map<string, number>
  lookups: Map<string, number>
  projects: Map<string, string>
  sessions: Map<string, string>
  summaries: Map<string, WorkflowSummary[]>
}

interface EventControl {
  listener?: (event: never) => Effect.Effect<void>
}

function control(): StoreControl {
  return {
    failures: 0,
    failuresAfterGate: 0,
    reads: new Map<string, number>(),
    lookups: new Map<string, number>(),
    projects: new Map<string, string>(),
    sessions: new Map<string, string>(),
    summaries: new Map<string, WorkflowSummary[]>(),
  }
}

function workflow(id: string, sessionId: string, projectId: string): WorkflowRow {
  return {
    id,
    projectId,
    sessionId,
    directory: null,
    title: id,
    status: "running",
    config: "",
    seq: 0,
    wakeReported: false,
    graphRev: 1,
    startedAt: null,
    completedAt: null,
    timeCreated: 0,
    timeUpdated: 0,
  }
}

function summary(id: string, completedNodes: number, graphRev = 1): WorkflowSummary {
  return {
    id,
    title: id,
    status: "running",
    graphRev,
    nodeCount: completedNodes,
    completedNodes,
    runningNodes: 0,
    failedNodes: 0,
    skippedNodes: 0,
    queuedNodes: 0,
    escalatedNodes: 0,
  }
}

function runtime(state: StoreControl, bus: EventControl) {
  const store = Layer.mock(DagStore.Service, {
    getWorkflow: (dagID) =>
      Effect.sync(() => {
        state.lookups.set(dagID, (state.lookups.get(dagID) ?? 0) + 1)
        const sid = state.sessions.get(dagID)
        return sid ? workflow(dagID, sid, state.projects.get(dagID) ?? "global") : undefined
      }),
    getWorkflowSummaries: (sessionID) =>
      Effect.gen(function* () {
        state.reads.set(sessionID, (state.reads.get(sessionID) ?? 0) + 1)
        if (state.interruptRead) {
          // The defined fiber id matters: Cause.interruptors() only collects
          // defined ids (the F1 shape pinned by the goal e2e interrupt tests).
          return yield* Effect.failCause(Cause.interrupt(0))
        }
        if (state.failures > 0) {
          state.failures -= 1
          throw new Error("simulated summary read failure")
        }
        const summaries = state.summaries.get(sessionID) ?? []
        const gate = state.readGate
        state.readGate = undefined
        if (gate) {
          yield* Deferred.succeed(gate.started, undefined)
          yield* Deferred.await(gate.release)
        }
        if (state.failuresAfterGate > 0) {
          state.failuresAfterGate -= 1
          throw new Error("simulated summary read failure after gate")
        }
        return summaries
      }),
  })
  const events = Layer.mock(EventV2Bridge.Service, {
    listen: (listener) =>
      Effect.sync(() => {
        bus.listener = listener as never
        return Effect.sync(() => {
          bus.listener = undefined
        })
      }),
  })
  const base = Layer.mergeAll(events, store)
  return Layer.provideMerge(DagSummaryPublisher.layer, base)
}

function startCollector() {
  const emissions: SummaryEmission[] = []
  const handler = (event: {
    workspace?: string
    payload?: { type?: string; properties?: { sessionID?: string; summaries?: WorkflowSummary[] } }
  }) => {
    if (event.payload?.type !== "dag.workflow.summary.updated") return
    emissions.push({
      sessionID: event.payload.properties!.sessionID!,
      summaries: event.payload.properties!.summaries!,
      ...(event.workspace ? { workspace: event.workspace } : {}),
    })
  }
  GlobalBus.on("event", handler)
  return { emissions, stop: () => GlobalBus.off("event", handler) }
}

function publishNodeEvents(
  bus: EventControl,
  dagID: string,
  count: number,
  foreignDirectory = false,
  workspaceID?: string,
) {
  if (!bus.listener) return Effect.die(new Error("publisher listener is not ready"))
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    yield* Effect.forEach(
      Array.from({ length: count }, (_, index) => index),
      (index) => bus.listener!({
        type: DagEvent.NodeRegistered.type,
        data: {
          dagID,
          nodeID: `${dagID}-node-${index}`,
          name: `Node ${index}`,
          workerType: "build",
          dependsOn: [],
          required: true,
          timestamp: ts(index),
        },
        location: {
          directory: foreignDirectory ? `${instance.directory}-foreign` : instance.directory,
          ...(workspaceID ? { workspaceID } : {}),
        },
      } as never),
      { discard: true },
    )
  })
}

function publishTimeoutEscalation(
  bus: EventControl,
  dagID: string,
  nodeID: string,
  extensions: number,
) {
  if (!bus.listener) return Effect.die(new Error("publisher listener is not ready"))
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    yield* bus.listener!({
      type: DagEvent.NodeTimeoutEscalated.type,
      data: {
        dagID,
        nodeID,
        childSessionID: `ses-${nodeID}`,
        timeoutExtensions: extensions,
        timestamp: ts(extensions),
      },
      location: { directory: instance.directory },
    } as never)
  })
}

function withCollector<A, E, R>(use: (collector: ReturnType<typeof startCollector>) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(startCollector),
    use,
    (collector) => Effect.sync(collector.stop),
  )
}

describe("DagSummaryPublisher behavior", () => {
  it.instance("a node completion triggers one fresh summary recompute", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.sessions.set("dag-one", "ses-one")
    state.summaries.set("ses-one", [summary("dag-one", 1)])

    return withCollector((collector) =>
      Effect.gen(function* () {
        yield* (yield* DagSummaryPublisher.Service).init()
        yield* publishNodeEvents(bus, "dag-one", 1)
        yield* pollWithTimeout(
          Effect.sync(() => collector.emissions.length === 1 ? collector.emissions[0] : undefined),
          "summary publisher did not emit",
        )

        expect(state.reads.get("ses-one")).toBe(1)
        expect(collector.emissions[0]).toEqual({ sessionID: "ses-one", summaries: [summary("dag-one", 1)] })
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })

  it.instance("five same-session node events coalesce into one read and emission", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.sessions.set("dag-burst", "ses-burst")
    state.summaries.set("ses-burst", [summary("dag-burst", 5)])

    return withCollector((collector) =>
      Effect.gen(function* () {
        yield* (yield* DagSummaryPublisher.Service).init()
        yield* publishNodeEvents(bus, "dag-burst", 5)
        yield* pollWithTimeout(
          Effect.sync(() => collector.emissions.length === 1 ? true : undefined),
          "coalesced summary was not emitted",
        )

        expect(state.reads.get("ses-burst")).toBe(1)
        // P1-4: the sessionID lookup for sessionID-less node events happens
        // once per debounce window, not once per event.
        expect(state.lookups.get("dag-burst")).toBe(1)
        expect(collector.emissions).toEqual([
          { sessionID: "ses-burst", summaries: [summary("dag-burst", 5)] },
        ])
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })

  it.instance("an event arriving during an in-flight read schedules a fresh recompute", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.sessions.set("dag-inflight", "ses-inflight")
    state.summaries.set("ses-inflight", [summary("dag-inflight", 1)])

    return withCollector((collector) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        state.readGate = { started, release }

        yield* (yield* DagSummaryPublisher.Service).init()
        yield* publishNodeEvents(bus, "dag-inflight", 1)
        yield* Deferred.await(started).pipe(Effect.timeout("1 second"))

        state.summaries.set("ses-inflight", [summary("dag-inflight", 2)])
        yield* publishNodeEvents(bus, "dag-inflight", 1)
        yield* Effect.sleep("20 millis")
        yield* Deferred.succeed(release, undefined)

        yield* pollWithTimeout(
          Effect.sync(() => (collector.emissions.at(-1)?.summaries[0]?.completedNodes === 2 ? true : undefined)),
          () =>
            `event coalesced during an in-flight read was lost (lookups=${state.lookups.get("dag-inflight") ?? 0}, reads=${state.reads.get("ses-inflight") ?? 0}, emissions=${collector.emissions.length})`,
          "500 millis",
        )

        expect(state.reads.get("ses-inflight")).toBe(2)
        expect(collector.emissions.at(-1)?.summaries).toEqual([summary("dag-inflight", 2)])
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })

  it.instance("another DAG event arriving during a shared session read schedules a fresh recompute", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.sessions.set("dag-session-a", "ses-shared")
    state.sessions.set("dag-session-b", "ses-shared")
    state.summaries.set("ses-shared", [summary("dag-session-a", 1)])

    return withCollector((collector) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        state.readGate = { started, release }

        yield* (yield* DagSummaryPublisher.Service).init()
        yield* publishNodeEvents(bus, "dag-session-a", 1)
        yield* Deferred.await(started).pipe(Effect.timeout("1 second"))

        state.summaries.set("ses-shared", [summary("dag-session-a", 2)])
        yield* publishNodeEvents(bus, "dag-session-b", 1)
        yield* Effect.sleep("80 millis")
        yield* Deferred.succeed(release, undefined)

        yield* pollWithTimeout(
          Effect.sync(() => (collector.emissions.at(-1)?.summaries[0]?.completedNodes === 2 ? true : undefined)),
          () =>
            `shared session event was lost (reads=${state.reads.get("ses-shared") ?? 0}, emissions=${collector.emissions.length})`,
          "500 millis",
        )

        expect(state.reads.get("ses-shared")).toBe(2)
        expect(state.lookups).toEqual(
          new Map([
            ["dag-session-a", 1],
            ["dag-session-b", 1],
          ]),
        )
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })

  it.instance("an event arriving during a failed in-flight read schedules a fresh recompute", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.failuresAfterGate = 1
    state.sessions.set("dag-failed-inflight", "ses-failed-inflight")
    state.summaries.set("ses-failed-inflight", [summary("dag-failed-inflight", 1)])

    return withCollector((collector) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        state.readGate = { started, release }

        yield* (yield* DagSummaryPublisher.Service).init()
        yield* publishNodeEvents(bus, "dag-failed-inflight", 1)
        yield* Deferred.await(started).pipe(Effect.timeout("1 second"))

        state.summaries.set("ses-failed-inflight", [summary("dag-failed-inflight", 2)])
        yield* publishNodeEvents(bus, "dag-failed-inflight", 1)
        yield* Effect.sleep("20 millis")
        yield* Deferred.succeed(release, undefined)

        yield* pollWithTimeout(
          Effect.sync(() => (collector.emissions.at(-1)?.summaries[0]?.completedNodes === 2 ? true : undefined)),
          () =>
            `event coalesced during a failed in-flight read was lost (reads=${state.reads.get("ses-failed-inflight") ?? 0}, emissions=${collector.emissions.length})`,
          "500 millis",
        )

        expect(state.reads.get("ses-failed-inflight")).toBe(2)
        expect(collector.emissions).toEqual([
          { sessionID: "ses-failed-inflight", summaries: [summary("dag-failed-inflight", 2)] },
        ])
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })

  it.instance("different sessions coalesce independently", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.sessions.set("dag-a", "ses-a")
    state.sessions.set("dag-b", "ses-b")
    state.summaries.set("ses-a", [summary("dag-a", 1)])
    state.summaries.set("ses-b", [summary("dag-b", 1)])

    return withCollector((collector) =>
      Effect.gen(function* () {
        yield* (yield* DagSummaryPublisher.Service).init()
        yield* Effect.all([publishNodeEvents(bus, "dag-a", 3), publishNodeEvents(bus, "dag-b", 3)], {
          concurrency: "unbounded",
        })
        yield* pollWithTimeout(
          Effect.sync(() => collector.emissions.length === 2 ? true : undefined),
          "independent session summaries were not emitted",
        )

        expect(state.reads).toEqual(new Map([["ses-a", 1], ["ses-b", 1]]))
        expect(collector.emissions.map((item) => item.sessionID).toSorted()).toEqual(["ses-a", "ses-b"])
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })

  it.instance("failed reads release coordination and later events read fresh state", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.failures = 1
    state.sessions.set("dag-retry", "ses-retry")
    state.summaries.set("ses-retry", [summary("dag-retry", 1)])

    return withCollector((collector) =>
      Effect.gen(function* () {
        yield* (yield* DagSummaryPublisher.Service).init()
        yield* publishNodeEvents(bus, "dag-retry", 1)
        yield* pollWithTimeout(
          Effect.sync(() => state.reads.get("ses-retry") === 1 ? true : undefined),
          "failed summary read did not run",
        )
        expect(collector.emissions).toEqual([])

        state.summaries.set("ses-retry", [summary("dag-retry", 2)])
        yield* publishNodeEvents(bus, "dag-retry", 1)
        yield* pollWithTimeout(
          Effect.sync(() => collector.emissions.length === 1 ? true : undefined),
          "summary publisher did not recover after failure",
        )

        expect(state.reads.get("ses-retry")).toBe(2)
        expect(collector.emissions[0].summaries).toEqual([summary("dag-retry", 2)])
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })

  it.instance("ignores DAG events emitted by another project instance", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.sessions.set("dag-foreign", "ses-foreign")
    state.summaries.set("ses-foreign", [summary("dag-foreign", 1)])

    return withCollector((collector) =>
      Effect.gen(function* () {
        yield* (yield* DagSummaryPublisher.Service).init()
        yield* publishNodeEvents(bus, "dag-foreign", 1, true)
        yield* Effect.sleep("150 millis")

        expect(state.lookups.size).toBe(0)
        expect(state.reads.size).toBe(0)
        expect(collector.emissions).toEqual([])
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })

  it.instance("ignores another project even when its event uses the same directory", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.sessions.set("dag-foreign-project", "ses-foreign-project")
    state.projects.set("dag-foreign-project", "foreign-project")
    state.summaries.set("ses-foreign-project", [summary("dag-foreign-project", 1)])

    return withCollector((collector) =>
      Effect.gen(function* () {
        yield* (yield* DagSummaryPublisher.Service).init()
        yield* publishNodeEvents(bus, "dag-foreign-project", 1)
        yield* Effect.sleep("150 millis")

        expect(state.lookups.get("dag-foreign-project")).toBe(1)
        expect(state.reads.size).toBe(0)
        expect(collector.emissions).toEqual([])
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })

  it.instance("routes summary emissions to the workspace carried by the DAG event", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.sessions.set("dag-workspace", "ses-workspace")
    state.summaries.set("ses-workspace", [summary("dag-workspace", 1)])

    return withCollector((collector) =>
      Effect.gen(function* () {
        yield* (yield* DagSummaryPublisher.Service).init()
        yield* publishNodeEvents(bus, "dag-workspace", 1, false, "wrk-origin")
        yield* pollWithTimeout(
          Effect.sync(() => collector.emissions[0]),
          "workspace summary was not emitted",
        )

        expect(collector.emissions[0]).toEqual({
          sessionID: "ses-workspace",
          summaries: [summary("dag-workspace", 1)],
          workspace: "wrk-origin",
        })
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })

  it.instance("an equal-count replan (graphRev-only change) still emits a fresh summary", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.sessions.set("dag-replan", "ses-replan")
    state.summaries.set("ses-replan", [summary("dag-replan", 3, 1)])

    return withCollector((collector) =>
      Effect.gen(function* () {
        yield* (yield* DagSummaryPublisher.Service).init()
        yield* publishNodeEvents(bus, "dag-replan", 1)
        yield* pollWithTimeout(
          Effect.sync(() => collector.emissions.length === 1 ? true : undefined),
          "pre-replan summary was not emitted",
        )

        // Equal-count replan: node counts and statuses are identical, only the
        // topology revision moved. The publisher must NOT content-dedupe — the
        // TUI change signatures depend on seeing the new graphRev propagate.
        state.summaries.set("ses-replan", [summary("dag-replan", 3, 2)])
        yield* publishNodeEvents(bus, "dag-replan", 1)
        yield* pollWithTimeout(
          Effect.sync(() => (collector.emissions.at(-1)?.summaries[0]?.graphRev === 2 ? true : undefined)),
          "graphRev-only replan change was not emitted",
        )

        expect(state.reads.get("ses-replan")).toBe(2)
        expect(collector.emissions[1].summaries).toEqual([summary("dag-replan", 3, 2)])
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })

  it.instance("a timeout escalation triggers a fresh summary recompute (F10)", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.sessions.set("dag-escalated", "ses-escalated")
    state.summaries.set("ses-escalated", [{
      ...summary("dag-escalated", 0),
      runningNodes: 1,
      escalatedNodes: 1,
    }])

    return withCollector((collector) =>
      Effect.gen(function* () {
        yield* (yield* DagSummaryPublisher.Service).init()
        // Escalation is a pure counter change on a running node — no status
        // transition — so the publisher must still re-emit or the TUI would
        // keep showing a plain RUNNING node (F10).
        yield* publishTimeoutEscalation(bus, "dag-escalated", "dag-escalated-a", 1)
        yield* pollWithTimeout(
          Effect.sync(() => collector.emissions.length === 1 ? collector.emissions[0] : undefined),
          "escalation did not trigger a summary emission",
        )

        expect(state.reads.get("ses-escalated")).toBe(1)
        expect(collector.emissions[0].summaries[0].escalatedNodes).toBe(1)
        expect(collector.emissions[0].summaries[0].runningNodes).toBe(1)
      }),
    ).pipe(Effect.provide(runtime(state, bus)))
  })
})

// DAG-04 (#316): the coalescer deliberately rethrows interrupt causes (a
// scoped disposal mid-publish must unwind, not be mistaken for a failure).
// The outer listener boundary must preserve that: pre-fix its catchCause
// swallowed the interrupt and logged a spurious "failed to publish
// summaries" on every normal shutdown. F1 discipline, same as spawn.ts.
describe("DagSummaryPublisher interrupt discipline (DAG-04)", () => {
  it.instance("an interrupt cause from the read path is rethrown, not reported as a publish failure", () => {
    const state = control()
    const bus = {} satisfies EventControl
    state.interruptRead = true
    state.sessions.set("dag-interrupt", "ses-interrupt")
    state.summaries.set("ses-interrupt", [summary("dag-interrupt", 1)])

    return Effect.gen(function* () {
      yield* (yield* DagSummaryPublisher.Service).init()
      yield* publishNodeEvents(bus, "dag-interrupt", 1)
      // Wait for the coalesce window to run the (interrupted) read.
      yield* pollWithTimeout(
        Effect.sync(() => (state.reads.get("ses-interrupt") === 1 ? true : undefined)),
        "interrupted summary read never ran",
      )
      yield* Effect.sleep("150 millis")
      expect(JSON.stringify(yield* logLines)).not.toContain("failed to publish summaries")
    }).pipe(Effect.provide(runtime(state, bus)))
  })
})
