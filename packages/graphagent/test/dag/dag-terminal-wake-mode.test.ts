// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Branded ids and the InstanceRef shim stand in for the full services; the DAG loop, store, inbox and report delivery are real and no model is started. */

// #1015: every terminal workflow reaches the parent exactly once, and the one
// case the session's DAG mode decides is a completed workflow whose only
// parent-visible output is an ordinary delivery leaf. With the mode on the
// report is delivered first and the parent gets one completion turn (so a staged
// plan never stops half way); with it off the report is displayed alone (#891).
//
// These tests run real workflows through `DagLoop` and the shared inbox over an
// in-memory database. Only the model boundary is replaced: children and the
// parent's wake turn are gates the test releases. Report delivery is real, and
// `SessionProjector` writes its parts into the session tables, so "the report
// came before the wake" is read from the transcript at the moment the parent
// prompt arrives rather than from event timing.
import { describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Deferred, Effect, Layer, Option, Queue } from "effect"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { ProjectTable } from "@graphagent/core/project/sql"
import { PartTable, SessionTable } from "@graphagent/core/session/sql"
import { SessionProjector } from "@graphagent/core/session/projector"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { DagEvent } from "@graphagent/schema/dag-event"
import { Model } from "@graphagent/schema/model"
import { Provider } from "@graphagent/schema/provider"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig, type WorkflowConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Provider as RuntimeProvider } from "@/provider/provider"
import { AgentScheduler } from "@/session/agent-scheduler"
import { SessionInbox } from "@/session/inbox"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Truncate } from "@/tool/truncate"
import { ProviderTest } from "../fake/provider"
import { mockSessionPrompt } from "../lib/child-runs"
import { partText, reportPartKind, tableSession } from "../lib/dag-session-tables"
import { pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

const PARENT = SessionID.make("ses_parent")

interface ChildGate {
  readonly title: string
  readonly release: Deferred.Deferred<string>
}

interface ParentGate {
  readonly text: string
  /** Delivered DAG reports in the parent transcript when this prompt arrived. */
  readonly reports: number
  readonly release: Deferred.Deferred<void>
}

interface Queues {
  readonly children: Queue.Queue<ChildGate>
  readonly parent: Queue.Queue<ParentGate>
}

function takeWithin<A>(queue: Queue.Queue<A>, message: string, timeout: "2 seconds" | "5 seconds" = "5 seconds") {
  return Queue.take(queue).pipe(
    Effect.timeoutOption(timeout),
    Effect.flatMap(Option.match({ onNone: () => Effect.fail(new Error(message)), onSome: Effect.succeed })),
  )
}

function reply(sessionID: string, text: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: sessionID as never,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: process.cwd(), root: process.cwd() },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as never,
      providerID: "test" as never,
      time: { created: Date.now(), completed: Date.now() },
      finish: "stop",
    },
    parts: text ? ([{ type: "text", text }] as never) : [],
  }
}

function promptText(input: SessionPrompt.PromptInput) {
  return input.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

/** A node that settles from its plain-text reply; `report` is `report_to_parent`. */
function node(id: string, options: { readonly report?: boolean; readonly dependsOn?: string[] } = {}): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: options.dependsOn ?? [],
    required: true,
    prompt_template: { inline: id },
    report_to_parent: options.report ?? false,
  }
}

function harness(queues: Queues) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const transcript = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const base = Layer.mergeAll(
    database,
    events,
    bridge,
    store,
    projector,
    transcript,
    dag,
    status,
    AgentScheduler.defaultLayer,
  )
  const titles = new Map<string, string>()
  const session = tableSession({
    onCreate: (id, title) => titles.set(id, (title ?? id).replace(" (DAG node)", "")),
  }).pipe(Layer.provide(database))
  const prompt = Layer.unwrap(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const deliver = Effect.fn("test.SessionPrompt.deliver")(function* (value: SessionPrompt.PromptInput) {
        const sessionID = value.sessionID as string
        if (sessionID === PARENT) {
          const parts = yield* db.select().from(PartTable).all().pipe(Effect.orDie)
          const reports = parts.filter((part) => reportPartKind(part.data) === "answer").length
          const release = yield* Deferred.make<void>()
          yield* Queue.offer(queues.parent, { text: promptText(value), reports, release })
          yield* Deferred.await(release)
          return reply(sessionID, "parent handled wake")
        }
        const release = yield* Deferred.make<string>()
        yield* Queue.offer(queues.children, { title: titles.get(sessionID) ?? sessionID, release })
        return reply(sessionID, yield* Deferred.await(release))
      })
      return mockSessionPrompt(
        withIdleAdmission({
          cancel: () => Effect.void,
          prompt: deliver,
          deliver: (value) => deliver(value).pipe(Effect.map(Option.some)),
        }),
      )
    }),
  ).pipe(Layer.provide(database))
  const agent = Layer.mock(Agent.Service, {
    get: () =>
      Effect.succeed({
        name: "build",
        mode: "all",
        permission: [],
        options: {},
        description: "",
        prompt: "",
        model: { providerID: Provider.ID.make("test"), modelID: Model.ID.make("test-model") },
        tools: {},
        hooks: {},
      }),
    list: () => Effect.succeed([{ name: "build", mode: "all", permission: [], options: {} }]),
  })
  const testModel = ProviderTest.model({ providerID: Provider.ID.make("test"), id: Model.ID.make("test-model") })
  const provider = Layer.mock(RuntimeProvider.Service, {
    list: () => Effect.succeed({ test: ProviderTest.info({}, testModel) }),
    getModel: () => Effect.succeed(testModel),
  })
  const truncate = Layer.mock(Truncate.Service, {
    output: (content) => Effect.succeed({ content, truncated: false }),
  })
  const inbox = SessionInbox.layer.pipe(Layer.provide(bridge), Layer.provide(status))
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(agent),
    Layer.provide(inbox),
  )
  return Layer.mergeAll(base, loop, session, agent, provider, truncate, inbox)
}

interface Services {
  readonly dag: Dag.Interface
  readonly store: DagStore.Interface
  readonly status: SessionStatus.Interface
  readonly events: EventV2.Interface
  readonly database: Database.Interface
  readonly queues: Queues
  /** `/dag-mode`: write the durable session row delivery reads. */
  readonly setMode: (mode: "on" | "off") => Effect.Effect<void>
}

/** Runs one test over a fresh parent session in the given DAG mode. */
function runTest<A>(mode: "on" | "off", test: (services: Services) => Effect.Effect<A, Error>) {
  return Effect.gen(function* () {
    const queues: Queues = {
      children: yield* Queue.unbounded<ChildGate>(),
      parent: yield* Queue.unbounded<ParentGate>(),
    }
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const store = yield* DagStore.Service
      const status = yield* SessionStatus.Service
      const events = yield* EventV2Bridge.Service
      const database = yield* Database.Service
      const loop = yield* DagLoop.Service
      yield* database.db
        .insert(ProjectTable)
        .values({ id: "project-1" as never, worktree: process.cwd() as never, sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionTable)
        .values({
          id: PARENT,
          project_id: "project-1" as never,
          slug: "parent",
          directory: process.cwd(),
          title: "Parent",
          version: "test",
          dag_mode: mode,
        })
        .run()
        .pipe(Effect.orDie)
      yield* loop.init()
      yield* (yield* SessionInbox.Service).init()
      return yield* test({
        dag,
        store,
        status,
        events,
        database,
        queues,
        setMode: (next) =>
          database.db
            .update(SessionTable)
            .set({ dag_mode: next })
            .where(eq(SessionTable.id, PARENT))
            .run()
            .pipe(Effect.orDie, Effect.asVoid),
      })
    }).pipe(
      Effect.provide(harness(queues)),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        root: process.cwd(),
        project: { id: "project-1" },
      } as never),
      Effect.scoped,
    )
  }).pipe(Effect.runPromise)
}

function start(services: Services, title: string, config: WorkflowConfig) {
  return services.dag.create({ projectID: "project-1", sessionID: PARENT, title, config })
}

/** The next `count` child prompts, by node name: parallel roots start in any order. */
function gates(services: Services, count: number) {
  return Effect.gen(function* () {
    const found = new Map<string, ChildGate>()
    while (found.size < count) {
      const gate = yield* takeWithin(services.queues.children, `only ${found.size} of ${count} nodes started`)
      found.set(gate.title, gate)
    }
    return found
  })
}

function release(gate: ChildGate | undefined, text: string) {
  if (!gate) return Effect.die(new Error("missing child gate"))
  return Deferred.succeed(gate.release, text)
}

function waitForStatus(store: DagStore.Interface, dagID: string, status: string) {
  return pollWithTimeout(
    store.getWorkflow(dagID).pipe(Effect.map((workflow) => (workflow?.status === status ? true : undefined))),
    `workflow did not reach ${status}`,
  )
}

/** A real pause long enough for a wrongly scheduled second turn to show up. */
const quiesce = Effect.sleep("150 millis")

const noMorePrompts = (services: Services) =>
  Effect.gen(function* () {
    yield* quiesce
    expect(Option.isNone(yield* Queue.poll(services.queues.parent))).toBe(true)
  })

const answers = (services: Services) =>
  services.database.db
    .select()
    .from(PartTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((parts) =>
        parts.flatMap((part) => (reportPartKind(part.data) === "answer" ? [partText(part.data) ?? ""] : [])),
      ),
    )

const unreported = (services: Services) =>
  Effect.gen(function* () {
    return {
      workflows: (yield* services.store.getUnreportedWakeWorkflows(PARENT)).map((workflow) => workflow.id),
      nodes: (yield* services.store.getUnreportedWakeNodes(PARENT)).map((row) => `${row.workflowId}/${row.id}`),
    }
  })

/** One terminal outcome: how it is reached, what the parent transcript and the wake must carry. */
interface Outcome {
  readonly name: string
  readonly run: (services: Services) => Effect.Effect<string, Error>
  /** Delivered reports before the wake: a failed or cancelled workflow has none. */
  readonly report?: string
  readonly wake: readonly string[]
  readonly absentFromWake?: readonly string[]
  /** Nodes whose own wake the single wake acknowledges. */
  readonly acknowledgedNodes?: readonly string[]
}

const outcomes: readonly Outcome[] = [
  {
    name: "completes through an ordinary delivery leaf that reports to the parent",
    run: (services) =>
      Effect.gen(function* () {
        const dagID = yield* start(services, "Leaf reports", {
          name: "leaf-reports",
          delivery_node: "final",
          nodes: [node("final", { report: true })],
        })
        yield* release((yield* gates(services, 1)).get("final"), "leaf answer")
        return dagID
      }),
    report: "leaf answer",
    wake: ["[DAG Workflow completed]", "[DAG Final Report]", 'Node "final" completed: leaf answer'],
    acknowledgedNodes: ["final"],
  },
  {
    name: "completes through an ordinary delivery leaf that does not report to the parent",
    run: (services) =>
      Effect.gen(function* () {
        const dagID = yield* start(services, "Leaf silent", {
          name: "leaf-silent",
          delivery_node: "final",
          nodes: [node("final")],
        })
        yield* release((yield* gates(services, 1)).get("final"), "quiet answer")
        return dagID
      }),
    report: "quiet answer",
    wake: ["[DAG Workflow completed]", "[DAG Final Report]"],
    absentFromWake: ["[DAG Node Result]"],
  },
  {
    name: "completes with a reporting checkpoint next to the delivery leaf",
    run: (services) =>
      Effect.gen(function* () {
        const dagID = yield* start(services, "With checkpoint", {
          name: "with-checkpoint",
          delivery_node: "final",
          nodes: [node("cp", { report: true }), node("final")],
        })
        // Keep the parent busy so the checkpoint and the completion reach it
        // as one batch instead of one turn each.
        yield* services.status.set(PARENT, { type: "busy" })
        const started = yield* gates(services, 2)
        yield* release(started.get("cp"), "checkpoint verdict")
        yield* release(started.get("final"), "synthesis")
        yield* waitForStatus(services.store, dagID, "completed")
        yield* services.status.set(PARENT, { type: "idle" })
        return dagID
      }),
    report: "synthesis",
    wake: ["[DAG Workflow completed]", "[DAG Final Report]", 'Node "cp" completed: checkpoint verdict'],
    acknowledgedNodes: ["cp"],
  },
  {
    name: "completes without a delivery node and leaves only a result index",
    run: (services) =>
      Effect.gen(function* () {
        const dagID = yield* start(services, "No delivery", {
          name: "no-delivery",
          nodes: [node("only")],
        })
        yield* release((yield* gates(services, 1)).get("only"), "unused")
        return dagID
      }),
    report: 'node_id="only"',
    wake: ["[DAG Workflow completed]", "[DAG Final Report]"],
  },
  {
    name: "completes after a gate skipped the delivery node",
    run: (services) =>
      Effect.gen(function* () {
        const dagID = yield* start(services, "Gated delivery", {
          name: "gated-delivery",
          delivery_node: "summary",
          nodes: [
            node("gate"),
            { ...node("summary", { dependsOn: ["gate"] }), condition: 'gate.output == "GO"', skip_ok: true },
          ],
        })
        yield* release((yield* gates(services, 1)).get("gate"), "NO")
        return dagID
      }),
    report: 'node_id="summary"',
    wake: ["[DAG Workflow completed]", "[DAG Final Report]", '"summary" (skipped'],
  },
  {
    name: "fails",
    run: (services) =>
      Effect.gen(function* () {
        const dagID = yield* start(services, "Fails", { name: "fails", nodes: [node("work")] })
        yield* gates(services, 1)
        yield* services.dag.fail(dagID, "required node failed")
        return dagID
      }),
    wake: ["[DAG Workflow failed]"],
    absentFromWake: ["[DAG Final Report]"],
  },
  {
    name: "is cancelled",
    run: (services) =>
      Effect.gen(function* () {
        const dagID = yield* start(services, "Cancelled", { name: "cancelled", nodes: [node("work")] })
        yield* gates(services, 1)
        yield* services.dag.cancel(dagID)
        return dagID
      }),
    wake: ["[DAG Workflow cancelled]"],
    absentFromWake: ["[DAG Final Report]"],
  },
]

describe("DAG mode on: every terminal workflow wakes the parent exactly once", () => {
  for (const outcome of outcomes) {
    it(`a workflow that ${outcome.name} wakes the parent once${outcome.report === undefined ? "" : ", after its report"}`, () =>
      runTest("on", (services) =>
        Effect.gen(function* () {
          const dagID = yield* outcome.run(services)
          const wake = yield* takeWithin(services.queues.parent, "the terminal workflow did not wake the parent")
          // Exactly one workflow is named, and the report it owes is already in
          // the transcript when the model turn is admitted.
          expect(wake.text.match(/\[DAG Workflow (completed|failed|cancelled)\]/g)).toHaveLength(1)
          for (const expected of outcome.wake) expect(wake.text).toContain(expected)
          for (const unexpected of outcome.absentFromWake ?? []) expect(wake.text).not.toContain(unexpected)
          expect(wake.reports).toBe(outcome.report === undefined ? 0 : 1)
          yield* Deferred.succeed(wake.release, undefined)

          // The one wake acknowledged everything it carried.
          yield* pollWithTimeout(
            unreported(services).pipe(
              Effect.map((rows) => (rows.workflows.length === 0 && rows.nodes.length === 0 ? true : undefined)),
            ),
            "the wake did not acknowledge its batch",
          )
          expect((yield* services.store.getWorkflow(dagID))?.wakeReported).toBe(true)
          for (const nodeID of outcome.acknowledgedNodes ?? [])
            expect((yield* services.store.getNode(dagID, nodeID))?.wakeReported).toBe(true)
          const delivered = yield* answers(services)
          expect(delivered).toHaveLength(outcome.report === undefined ? 0 : 1)
          if (outcome.report !== undefined) expect(delivered[0]).toContain(outcome.report)

          // No second turn, not even after more idle transitions.
          yield* services.status.set(PARENT, { type: "busy" })
          yield* services.status.set(PARENT, { type: "idle" })
          yield* noMorePrompts(services)
        }),
      ))
  }

  it("holds a leaf completion while the parent is busy and runs exactly one turn when it goes idle", () =>
    runTest("on", (services) =>
      Effect.gen(function* () {
        yield* services.status.set(PARENT, { type: "busy" })
        const dagID = yield* start(services, "Busy parent", {
          name: "busy-parent",
          delivery_node: "final",
          nodes: [node("final")],
        })
        yield* release((yield* gates(services, 1)).get("final"), "answer while busy")
        yield* waitForStatus(services.store, dagID, "completed")
        yield* noMorePrompts(services)
        // Nothing is delivered behind a running turn: neither report nor wake.
        expect(yield* answers(services)).toEqual([])
        expect((yield* services.store.getWorkflow(dagID))?.wakeReported).toBe(false)

        yield* services.status.set(PARENT, { type: "idle" })
        const wake = yield* takeWithin(services.queues.parent, "going idle did not deliver the completion turn")
        expect(wake.reports).toBe(1)
        expect(wake.text).toContain("[DAG Workflow completed]")
        yield* Deferred.succeed(wake.release, undefined)
        yield* noMorePrompts(services)
        expect(yield* answers(services)).toEqual(["answer while busy"])
      }),
    ))

  it("delivers two leaf workflows that finish in the same window as one batch and one turn", () =>
    runTest("on", (services) =>
      Effect.gen(function* () {
        yield* services.status.set(PARENT, { type: "busy" })
        const first = yield* start(services, "First leaf", {
          name: "first-leaf",
          delivery_node: "first",
          nodes: [node("first", { report: true })],
        })
        const second = yield* start(services, "Second leaf", {
          name: "second-leaf",
          delivery_node: "second",
          nodes: [node("second")],
        })
        const started = yield* gates(services, 2)
        yield* release(started.get("first"), "first answer")
        yield* release(started.get("second"), "second answer")
        yield* waitForStatus(services.store, first, "completed")
        yield* waitForStatus(services.store, second, "completed")
        yield* services.status.set(PARENT, { type: "idle" })

        const wake = yield* takeWithin(services.queues.parent, "the two completions did not wake the parent")
        expect(wake.reports).toBe(2)
        expect(wake.text.match(/\[DAG Workflow completed\]/g)).toHaveLength(2)
        expect(wake.text).toContain('Workflow "First leaf"')
        expect(wake.text).toContain('Workflow "Second leaf"')
        yield* Deferred.succeed(wake.release, undefined)
        yield* noMorePrompts(services)
        expect((yield* answers(services)).toSorted()).toEqual(["first answer", "second answer"])
        expect(yield* unreported(services)).toEqual({ workflows: [], nodes: [] })
      }),
    ))

  it("carries the safety denial counts in the one terminal wake and never wakes for the denials", () =>
    runTest("on", (services) =>
      Effect.gen(function* () {
        const dagID = yield* start(services, "Denied calls", {
          name: "denied-calls",
          delivery_node: "final",
          nodes: [node("final", { report: true })],
        })
        const gate = (yield* gates(services, 1)).get("final")
        const denied = (index: number) =>
          services.events.publish(DagEvent.NodeSafetyDenied, {
            dagID: DagEvent.DagID.make(dagID),
            nodeID: DagEvent.NodeID.make("final"),
            attempt: 0,
            ruleID: index === 1 ? "SF-3" : "SF-4",
            permission: "bash",
            summary: `denied command ${index}`,
            timestamp: DateTime.makeUnsafe(1_700_000_000_000 + index),
          })
        yield* denied(1)
        yield* denied(2)
        expect((yield* services.store.getNode(dagID, "final"))?.safetyDenials?.total).toBe(2)
        // A denial is evidence, not a decision point: the idle parent hears nothing.
        yield* noMorePrompts(services)

        yield* release(gate, "answer despite the denials")
        const wake = yield* takeWithin(services.queues.parent, "the terminal workflow did not wake the parent")
        expect(wake.text).toContain("[DAG Safety] 2 tool calls in this node were denied")
        expect(wake.text).toContain("Safety policy denied 2 tool calls in this workflow")
        yield* Deferred.succeed(wake.release, undefined)
        yield* noMorePrompts(services)
      }),
    ))
})

describe("DAG mode is read when the terminal workflow is delivered", () => {
  it("a switch while the parent is busy decides, in both directions", () =>
    runTest("off", (services) =>
      Effect.gen(function* () {
        // Completed while the mode was off, delivered after the user turned it on.
        yield* services.status.set(PARENT, { type: "busy" })
        const dagID = yield* start(services, "Switched on", {
          name: "switched-on",
          delivery_node: "final",
          nodes: [node("final")],
        })
        yield* release((yield* gates(services, 1)).get("final"), "answer")
        yield* waitForStatus(services.store, dagID, "completed")
        yield* services.setMode("on")
        yield* services.status.set(PARENT, { type: "idle" })
        const wake = yield* takeWithin(services.queues.parent, "the switched-on mode did not wake the parent")
        expect(wake.reports).toBe(1)
        yield* Deferred.succeed(wake.release, undefined)
        yield* noMorePrompts(services)

        // And the other way round: on at completion, off at delivery.
        yield* services.status.set(PARENT, { type: "busy" })
        const later = yield* start(services, "Switched off", {
          name: "switched-off",
          delivery_node: "second",
          nodes: [node("second")],
        })
        yield* release((yield* gates(services, 1)).get("second"), "second answer")
        yield* waitForStatus(services.store, later, "completed")
        yield* services.setMode("off")
        yield* services.status.set(PARENT, { type: "idle" })
        yield* pollWithTimeout(
          answers(services).pipe(Effect.map((texts) => (texts.length === 2 ? texts : undefined))),
          "the displayed report did not arrive",
        )
        yield* noMorePrompts(services)
        expect((yield* services.store.getWorkflow(later))?.wakeReported).toBe(true)
      }),
    ))
})

describe("DAG mode off: the display-only completion stays display-only (#891)", () => {
  for (const report of [true, false]) {
    it(`displays an ordinary delivery leaf that ${report ? "reports" : "does not report"} to the parent and gives the model no turn`, () =>
      runTest("off", (services) =>
        Effect.gen(function* () {
          const dagID = yield* start(services, "Displayed", {
            name: "displayed",
            delivery_node: "final",
            nodes: [node("final", { report })],
          })
          yield* release((yield* gates(services, 1)).get("final"), "displayed answer")
          yield* waitForStatus(services.store, dagID, "completed")
          yield* pollWithTimeout(
            answers(services).pipe(Effect.map((texts) => (texts.length === 1 ? texts : undefined))),
            "the report was not displayed",
          )
          yield* noMorePrompts(services)
          expect(yield* answers(services)).toEqual(["displayed answer"])
          // The leaf's own wake is acknowledged with the report it carries, so
          // nothing is left for the inbox tick to look at again.
          expect((yield* services.store.getWorkflow(dagID))?.wakeReported).toBe(true)
          expect((yield* services.store.getNode(dagID, "final"))?.wakeReported).toBe(report)
          expect(yield* unreported(services)).toEqual({ workflows: [], nodes: [] })
        }),
      ))
  }

  it("still wakes the parent once for a failed workflow", () =>
    runTest("off", (services) =>
      Effect.gen(function* () {
        const dagID = yield* start(services, "Fails off", { name: "fails-off", nodes: [node("work")] })
        yield* gates(services, 1)
        yield* services.dag.fail(dagID, "required node failed")
        const wake = yield* takeWithin(services.queues.parent, "the failed workflow did not wake the parent")
        expect(wake.text).toContain("[DAG Workflow failed]")
        yield* Deferred.succeed(wake.release, undefined)
        yield* noMorePrompts(services)
      }),
    ))
})
