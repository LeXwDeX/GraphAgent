// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mocked service slices use `as never` shims.
// Regression: DagSummaryPublisher recomputes on every durable event that
// changes the pushed WorkflowSummary, including:
//   - NodeDeadlineExtended clears escalation_pending  -> summary.escalatedNodes drops
//   - NodeQueued moves pending -> queued              -> summary.queuedNodes rises
//   - WorkflowStepped moves running -> stepping       -> summary.status changes
import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { DagStore, type WorkflowRow, type WorkflowSummary } from "@opencode-ai/core/dag/store"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { DagSummaryPublisher } from "@/dag/runtime/summary-publisher"
import { GlobalBus } from "@/bus/global"
import { InstanceState } from "@/effect/instance-state"
import { it } from "../lib/effect"

const workflow = (id: string): WorkflowRow => ({
  id,
  projectId: "global",
  sessionId: "ses-one",
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
})

const realSleep = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))

describe("DagSummaryPublisher trigger coverage", () => {
  it.instance("pushes a fresh summary for every event that changes it", () => {
    const bus: { listener?: (event: never) => Effect.Effect<void> } = {}
    let reads = 0
    const store = Layer.mock(DagStore.Service, {
      getWorkflow: (dagID) => Effect.succeed(workflow(dagID)),
      getWorkflowSummaries: () =>
        Effect.sync(() => {
          reads++
          return [] as WorkflowSummary[]
        }),
    })
    const events = Layer.mock(EventV2Bridge.Service, {
      listen: (listener) =>
        Effect.sync(() => {
          bus.listener = listener as never
          return Effect.void
        }),
    })
    const emitted: string[] = []
    const handler = (event: { payload?: { type?: string } }) => {
      if (event.payload?.type === "dag.workflow.summary.updated") emitted.push("x")
    }
    return Effect.gen(function* () {
      GlobalBus.on("event", handler)
      yield* (yield* DagSummaryPublisher.Service).init()
      const instance = yield* InstanceState.context
      const ts = DateTime.makeUnsafe(1)
      const cases = [
        // control: an existing trigger
        { type: DagEvent.NodeStarted.type, data: { dagID: "dag-0", nodeID: "n", childSessionID: "c", timestamp: ts } },
        {
          type: DagEvent.NodeDeadlineExtended.type,
          data: { dagID: "dag-1", nodeID: "n", deadlineMs: 1, timeoutExtensions: 1, timestamp: ts },
        },
        { type: DagEvent.NodeQueued.type, data: { dagID: "dag-2", nodeID: "n", deadlineMs: 1, timestamp: ts } },
        { type: DagEvent.WorkflowStepped.type, data: { dagID: "dag-3", nodeID: "n", timestamp: ts } },
      ]
      const result: Record<string, number> = {}
      for (const event of cases) {
        const before = reads
        yield* bus.listener!({ ...event, location: { directory: instance.directory } } as never)
        yield* realSleep(200)
        result[event.type] = reads - before
      }
      GlobalBus.off("event", handler)
      // Each event triggers exactly one recompute.
      expect(result).toEqual({
        [DagEvent.NodeStarted.type]: 1,
        [DagEvent.NodeDeadlineExtended.type]: 1,
        [DagEvent.NodeQueued.type]: 1,
        [DagEvent.WorkflowStepped.type]: 1,
      })
    }).pipe(Effect.provide(Layer.provideMerge(DagSummaryPublisher.layer, Layer.mergeAll(events, store))))
  })
})
