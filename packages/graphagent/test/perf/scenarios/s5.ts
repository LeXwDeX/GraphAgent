// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect, Fiber, Stream } from "effect"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { DagEvent } from "@graphagent/schema/dag-event"
import { DagStore } from "@graphagent/core/dag/store"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { Dag } from "@/dag/dag"
import type { NodeConfig, WorkflowConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AgentScheduler } from "@/session/agent-scheduler"
import { makeFakeProvider } from "../../lib/fake-provider"
import { reset, settle, snapshot, stepBook } from "../../lib/engine-probe"
import type { BaselineRequest } from "../fingerprint"
import { fingerprintRequests } from "../fingerprint"
import { makeDagPerfLayer, perfConfig } from "../harness"
import type { Measurement, Scenario } from "./types"

// S5: three DAG workflows of ten nodes each plus four background tasks, all
// sharing one worktree. The DAG loop schedules and spawns real child sessions;
// the background jobs run the same prompt path through BackgroundJob.start
// rather than the literal task tool, whose background mode requires an
// experimental flag and injects a parent turn on completion (non-deterministic).
//
// The parent session stays busy for the whole run, so wake delivery ends at
// the status gate and never turns into a parent prompt. That keeps the parent
// transcript empty and makes `events.durable` independent of delivery timing.
//
// Clock: real. SQLite, git subprocesses and the scripted provider stream are
// real I/O, so TestClock cannot drive them; this deviates from the issue's
// "all scenarios use TestClock" wording and is recorded on the issue.
const WORKERS = 8
const DELIVERY = "n10"
const WORKFLOWS = 3
const BACKGROUND = 4
/** What each workflow asks for; the scheduler holds its active child runs to this. */
export const MAX_CONCURRENCY = 5
const WORKER_IDS = Array.from({ length: WORKERS }, (_, index) => `n${String(index + 2).padStart(2, "0")}`)

const model = { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test") }
const promptModel = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

function buildConfig(name: string, workers: number): WorkflowConfig {
  const ids = WORKER_IDS.slice(0, workers)
  const nodes: NodeConfig[] = [
    {
      id: "n01",
      name: "entry",
      worker_type: "build",
      depends_on: [],
      prompt_template: { inline: "Acknowledge the task." },
    },
    ...ids.map((id) => ({
      id,
      name: `worker ${id}`,
      worker_type: "build",
      depends_on: ["n01"],
      prompt_template: { inline: `Work item ${id}.` },
    })),
    {
      id: DELIVERY,
      name: "delivery",
      worker_type: "build",
      depends_on: ids,
      prompt_template: { inline: "Deliver the final answer." },
    },
  ]
  return { name, delivery_node: DELIVERY, max_concurrency: MAX_CONCURRENCY, nodes }
}

/** Services `makeDagPerfLayer` provides and this scenario consumes. */
export type S5Services =
  | Session.Service
  | SessionPrompt.Service
  | Dag.Service
  | DagLoop.Service
  | DagStore.Service
  | BackgroundJob.Service
  | SessionStatus.Service
  | EventV2Bridge.Service
  | AgentScheduler.Service

/**
 * Highest scheduler occupancy seen during one measured pass (Issue #1021),
 * next to the caps the same snapshots reported. Model-stream numbers are exact:
 * the scripted provider records a `capacity()` snapshot at every permit grant,
 * and in-flight can only rise at a grant. Child-run numbers come from a
 * polling fiber (a node holds its slot for the whole run, far longer than the
 * poll interval). Reading `capacity()` touches no engine counter.
 */
export interface S5Capacity {
  /** Polling samples taken; zero would make the child-run peaks vacuous. */
  readonly samples: number
  /** Model-stream grants observed (one per provider request). */
  readonly grants: number
  readonly requests: { readonly inflight: number; readonly cap: number }
  readonly providers: Readonly<Record<string, { readonly inflight: number; readonly cap: number }>>
  readonly children: {
    readonly running: number
    readonly cap: number
    readonly dagRunning: number
    readonly dagCap: number
  }
  /** Active child runs per workflow against the cap that workflow was held to. */
  readonly workflows: ReadonlyArray<{ readonly peak: number; readonly cap: number }>
}

/** One measured pass: engine counters plus the workflow facts S5 asserts. */
export interface S5PassResult extends Measurement {
  readonly workflows: ReadonlyArray<{
    readonly status: string
    readonly wakeReported: boolean
    readonly nodes: ReadonlyArray<{
      readonly status: string
      readonly childSessionId: string | null
      readonly wakeReported: boolean
      readonly worktreeState: string | null | undefined
    }>
  }>
  readonly waited: ReadonlyArray<{ readonly timedOut: boolean; readonly status: string | undefined }>
  readonly requests: ReadonlyArray<BaselineRequest>
  readonly parentMessages: number
  readonly parentStatus: string
  readonly capacity: S5Capacity
}

export interface S5Result extends Measurement {
  /** Request shapes of the last measured pass; the gate mirrors this book. */
  readonly requests: ReadonlyArray<BaselineRequest>
  /** Workflows completed by the single-worker warm-up pass. */
  readonly warmupWorkflows: number
  readonly first: S5PassResult
  readonly second: S5PassResult
}

interface Peaks {
  samples: number
  requests: { inflight: number; cap: number }
  providers: Record<string, { inflight: number; cap: number }>
  children: { running: number; cap: number; dagRunning: number; dagCap: number }
  workflows: Map<string, { peak: number; cap: number }>
}

const emptyPeaks = (): Peaks => ({
  samples: 0,
  requests: { inflight: 0, cap: 0 },
  providers: {},
  children: { running: 0, cap: 0, dagRunning: 0, dagCap: 0 },
  workflows: new Map(),
})

/** Fold one scheduler snapshot into the running maxima; caps are whatever the snapshot reported. */
function record(peaks: Peaks, snapshot: AgentScheduler.CapacitySnapshot) {
  peaks.requests = {
    inflight: Math.max(peaks.requests.inflight, snapshot.requests.inflight),
    cap: snapshot.requests.cap,
  }
  for (const [providerID, provider] of Object.entries(snapshot.providers)) {
    peaks.providers[providerID] = {
      inflight: Math.max(peaks.providers[providerID]?.inflight ?? 0, provider.inflight),
      cap: provider.cap,
    }
  }
  peaks.children = {
    running: Math.max(peaks.children.running, snapshot.children.running),
    cap: snapshot.children.cap,
    dagRunning: Math.max(peaks.children.dagRunning, snapshot.children.dagRunning),
    dagCap: snapshot.children.dagCap,
  }
  if (snapshot.limit?.key.kind === "workflow") {
    const previous = peaks.workflows.get(snapshot.limit.key.workflowID)
    peaks.workflows.set(snapshot.limit.key.workflowID, {
      peak: Math.max(previous?.peak ?? 0, snapshot.limit.used),
      cap: Math.max(previous?.cap ?? 0, snapshot.limit.cap),
    })
  }
}

/**
 * Poll the process scheduler until interrupted. It reads the scheduler's own
 * counters only (no store, event or process access), so it adds nothing to the
 * engine counts the gate compares. Workflow IDs are appended by the caller as
 * the workflows are created.
 */
const sampleCapacity = (scheduler: AgentScheduler.Interface, workflowIDs: ReadonlyArray<string>, peaks: Peaks) =>
  Effect.gen(function* () {
    for (;;) {
      if (workflowIDs.length === 0) record(peaks, yield* scheduler.capacity())
      for (const workflowID of workflowIDs) {
        record(peaks, yield* scheduler.capacity({ kind: "workflow", workflowID }))
      }
      peaks.samples += 1
      yield* Effect.sleep("1 millis")
    }
  })

export function s5Scenario(): Scenario<S5Result, S5Services> {
  // `scheduled`: the scripted provider holds a scheduler permit for each stream
  // like the production LLM service, so model-stream occupancy is observable.
  const fake = makeFakeProvider({ title: "S5", reply: "ok", scheduled: true })
  const run = Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const dag = yield* Dag.Service
    const store = yield* DagStore.Service
    const loop = yield* DagLoop.Service
    const jobs = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service
    const events = yield* EventV2Bridge.Service
    const scheduler = yield* AgentScheduler.Service

    yield* loop.init()
    yield* Effect.sleep("50 millis")

    const runOnce = (label: string, workers: number) =>
      Effect.gen(function* () {
        const parent = yield* sessions.create({ title: `${label} parent`, model })
        const children = yield* Effect.forEach(
          Array.from({ length: BACKGROUND }, (_, index) => index),
          (index) => sessions.create({ parentID: parent.id, title: `${label} bg ${index}`, model }),
          { concurrency: 1 },
        )
        // A busy parent parks every wake at the status gate: no turn, no
        // parent messages, and no wake rows consumed.
        yield* status.set(parent.id, { type: "busy" })

        // Subscribe before creating anything, and take exactly this run's
        // completions: the warm-up emits its own.
        const completed = yield* events
          .subscribe(DagEvent.WorkflowCompleted)
          .pipe(Stream.take(WORKFLOWS), Stream.runDrain, Effect.forkScoped({ startImmediately: true }))
        // Clear the setup's asynchronous projection work before measuring.
        yield* settle({ activity: fake.activity })
        reset()
        fake.reset()

        // Sample scheduler occupancy for the whole pass (Issue #1021).
        const peaks = emptyPeaks()
        const workflowIDs: string[] = []
        const sampler = yield* sampleCapacity(scheduler, workflowIDs, peaks).pipe(Effect.forkScoped)

        yield* Effect.forEach(
          Array.from({ length: WORKFLOWS }, (_, index) => index),
          (index) =>
            dag
              .create({
                projectID: parent.projectID,
                sessionID: parent.id,
                title: `${label} wf ${index}`,
                config: buildConfig(`${label}-${index}`, workers),
              })
              .pipe(Effect.tap((dagID) => Effect.sync(() => void workflowIDs.push(dagID)))),
          { concurrency: 1 },
        )
        const jobIDs = yield* Effect.forEach(
          children,
          (child, index) =>
            jobs
              .start({
                id: child.id,
                type: "task",
                title: `${label} bg ${index}`,
                metadata: { sessionID: child.id, parentSessionID: parent.id },
                run: prompt
                  .prompt({
                    sessionID: child.id,
                    agent: "build",
                    model: promptModel,
                    parts: [{ type: "text", text: `background ${index}` }],
                  })
                  .pipe(Effect.as("done")),
              })
              .pipe(Effect.map((info) => info.id)),
          { concurrency: 1 },
        )

        yield* Fiber.join(completed).pipe(
          Effect.timeoutOrElse({
            duration: "120 seconds",
            orElse: () => Effect.die(new Error("S5: workflows did not complete")),
          }),
        )
        const waited = yield* Effect.forEach(jobIDs, (id) => jobs.wait({ id, timeout: 120_000 }), {
          concurrency: "unbounded",
        })
        yield* Fiber.interrupt(sampler)
        // Model-stream occupancy can only rise at a grant: fold in the exact
        // snapshots the provider took there (the polling fiber cannot catch a
        // stream that lives for microseconds).
        for (const grant of fake.grants) record(peaks, grant)
        yield* settle({ quietMs: 500, timeoutMs: 60_000, activity: fake.activity })
        // Counts and the per-request book are captured before any store or
        // session read: those reads would otherwise be measured.
        const counts = snapshot()
        const book = stepBook()

        const workflows = yield* store.listBySession(parent.id)
        const nodes = yield* Effect.forEach(workflows, (workflow) => store.getCurrentNodes(workflow.id))
        const parentMessages = yield* sessions.messages({ sessionID: parent.id })
        const parentStatus = yield* status.get(parent.id)
        return {
          counts,
          steps: book.steps,
          perStep: book.perStep,
          workflows: workflows.map((workflow) => ({
            status: workflow.status,
            wakeReported: workflow.wakeReported,
            nodes: nodes[workflows.indexOf(workflow)].map((node) => ({
              status: node.status,
              childSessionId: node.childSessionId,
              wakeReported: node.wakeReported,
              worktreeState: node.worktreeState,
            })),
          })),
          waited: waited.map((result) => ({ timedOut: result.timedOut, status: result.info?.status })),
          requests: fingerprintRequests(fake.requests),
          parentMessages: parentMessages.length,
          parentStatus: parentStatus.type,
          capacity: {
            samples: peaks.samples,
            grants: fake.grants.length,
            requests: peaks.requests,
            providers: peaks.providers,
            children: peaks.children,
            workflows: [...peaks.workflows.values()],
          },
        } satisfies S5PassResult
      })

    const warmup = yield* runOnce("S5 warmup", 1)
    const first = yield* runOnce("S5 first", WORKERS)
    const second = yield* runOnce("S5 second", WORKERS)
    return {
      counts: second.counts,
      steps: second.steps,
      perStep: second.perStep,
      requests: second.requests,
      warmupWorkflows: warmup.workflows.length,
      first,
      second,
    } satisfies S5Result
  })

  return {
    id: "S5",
    layer: makeDagPerfLayer(fake),
    instance: {
      git: true,
      config: perfConfig,
      init: (directory) => Effect.promise(() => Bun.write(`${directory}/data.txt`, "data\n")),
    },
    timeout: 180_000,
    run,
  }
}
