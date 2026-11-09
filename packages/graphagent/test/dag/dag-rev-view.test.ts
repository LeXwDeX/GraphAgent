// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Train A probes — graph-revision VIEW semantics (workflows/dag-engine-optimization.md,
 * v1.0.15 ledger, decisions A1–A6).
 *
 * Durable data is untouched by this feature: replaced segments stay in the
 * read model and in EventV2 history; only the CURRENT revision is exposed to
 * view and terminal-aggregation seams (summaries, status, loop rebuilds, wake
 * attribution). Replan/cancel engine semantics are unchanged (A5/A6).
 *
 * Probe map (evidence §9):
 * - A-p1/A-p3: a replan that bypasses a failed required node hides the
 *   replaced segment from summaries/status/rebuild input, and the workflow
 *   COMPLETES via the new path instead of failing on the old failure
 *   (the wake-up bug: replaced fails re-seeded as required-unsatisfied on
 *   every rebuild).
 * - A-p2 (PIN): a genuine current-rev required failure stays visible, is
 *   counted, and fails the workflow — before AND after the feature.
 * - A-p5(a): the wake digest's failure attribution excludes superseded
 *   replaced failures (only current-rev failures are attributed).
 */
import { describe, expect, it } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { ProjectV2 } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionSchema } from "@graphagent/core/session/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { Model } from "@graphagent/schema/model"
import { Provider } from "@graphagent/schema/provider"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

/** Child release: reply text (node completes) or a simulated exec failure. */
type ChildOutcome = { text: string } | { fail: true }

interface PromptGate {
  readonly title: string
  readonly release: Deferred.Deferred<ChildOutcome>
}

interface ParentPromptGate {
  readonly text: string
  readonly release: Deferred.Deferred<"success" | "failure">
}

function takeWithin<A>(queue: Queue.Queue<A>, message: string) {
  return Queue.take(queue).pipe(
    Effect.timeoutOption("2 seconds"),
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new Error(message)),
      onSome: Effect.succeed,
    })),
  )
}

function reply(sessionID: string, text: string): SessionV1.WithParts {
  const sid = SessionID.make(sessionID)
  const messageID = MessageID.ascending()
  const part: SessionV1.TextPart = {
    id: PartID.ascending(),
    sessionID: sid,
    messageID,
    type: "text",
    text,
  }
  return {
    info: {
      id: messageID,
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: sid,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: process.cwd(), root: process.cwd() },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: Model.ID.make("test-model"),
      providerID: Provider.ID.make("test"),
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: text ? [part] : [],
  }
}

function node(id: string, dependsOn: string[] = []): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    required: true,
    prompt_template: { inline: id },
    report_to_parent: true,
  }
}

function loopLayer(input: {
  readonly childPrompts: Queue.Queue<PromptGate>
  readonly parentPrompts: Queue.Queue<ParentPromptGate>
}) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
  )
  const dag = Dag.layer.pipe(
    Layer.provide(bridge),
    Layer.provide(store),
  )
  const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status)
  const childTitles = new Map<string, string>()
  const created: string[] = []
  const projectID = ProjectV2.ID.make("project-1")
  const sessionInfo = (id: SessionSchema.ID, title: string): Session.Info => ({
    id,
    slug: title,
    projectID,
    directory: process.cwd(),
    title,
    version: "test",
    time: { created: 0, updated: 0 },
  })
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: (id) => Effect.succeed(sessionInfo(id, "Parent")),
    create: (value) =>
      Effect.sync(() => {
        const id = SessionID.make(`ses_child_${created.length + 1}`)
        created.push(id)
        childTitles.set(id, (value?.title ?? id).replace(" (DAG node)", ""))
        return sessionInfo(id, value?.title ?? id)
      }),
    messages: () => Effect.succeed([]),
  })
  const deliver = Effect.fn("test.SessionPrompt.deliver")(function* (value: SessionPrompt.PromptInput) {
    const sessionID = value.sessionID as string
    const text = value.parts
      .map((part) => (part.type === "text" ? (part as { text: string }).text : ""))
      .join("\n")
    if (sessionID === "ses_parent") {
      const release = yield* Deferred.make<"success" | "failure">()
      yield* Queue.offer(input.parentPrompts, { text, release })
      const outcome = yield* Deferred.await(release)
      if (outcome === "failure") return yield* Effect.die(new Error("provider unavailable"))
      return reply(sessionID, "parent handled wake")
    }
    const release = yield* Deferred.make<ChildOutcome>()
    yield* Queue.offer(input.childPrompts, {
      title: childTitles.get(sessionID) ?? sessionID,
      release,
    })
    const outcome = yield* Deferred.await(release)
    // Simulated execution failure: the spawn fiber's catchCause publishes a
    // durable NodeFailed with trigger exec_failed — a GENUINE failure, the
    // same class of failure the ledger's replaced-segment scenarios carry.
    if ("fail" in outcome) return yield* Effect.die(new Error("simulated exec failure"))
    return reply(sessionID, outcome.text)
  })
  const prompt = Layer.mock(SessionPrompt.Service, withIdleAdmission({
    cancel: () => Effect.void,
    prompt: deliver,
    promptIfIdle: (value) => deliver(value).pipe(Effect.map(Option.some)),
  }))
  const agent = Layer.mock(Agent.Service, {
    get: () => Effect.succeed({
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
  })
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(agent),
  )
  return Layer.merge(base, loop)
}

function runLoopTest<A>(
  test: (services: {
    readonly dag: Dag.Interface
    readonly store: DagStore.Interface
    readonly childPrompts: Queue.Queue<PromptGate>
    readonly parentPrompts: Queue.Queue<ParentPromptGate>
  }) => Effect.Effect<A, Error>,
) {
  return Effect.gen(function* () {
    const childPrompts = yield* Queue.unbounded<PromptGate>()
    const parentPrompts = yield* Queue.unbounded<ParentPromptGate>()
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const database = yield* Database.Service
      const projectID = ProjectV2.ID.make("project-1")
      const parentSessionID = SessionID.make("ses_parent")
      yield* database.db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make(process.cwd()),
        sandboxes: [],
      }).run().pipe(Effect.orDie)
      yield* database.db.insert(SessionTable).values({
        id: parentSessionID,
        project_id: projectID,
        slug: "parent",
        directory: process.cwd(),
        title: "Parent",
        version: "test",
      }).run().pipe(Effect.orDie)
      yield* loop.init()
      return yield* test({ dag, store, childPrompts, parentPrompts })
    }).pipe(
      Effect.provide(loopLayer({ childPrompts, parentPrompts })),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        root: process.cwd(),
        project: {
          id: ProjectV2.ID.make("project-1"),
          worktree: process.cwd(),
          time: { created: 0, updated: 0 },
          sandboxes: [],
        },
      }),
      Effect.scoped,
    )
  })
}

describe("Train A rev-view (durable data untouched, view = current revision only)", () => {
  // A-p1 + A-p3: the ledger wake-up scenario. A→B→C→D all required plus an
  // independent Z (its running state keeps the workflow from going terminal
  // the moment C fails — the orchestrator gets its chance to replan, exactly
  // like a real wake-driven replan). C fails genuinely; the agent bypasses it
  // with a new E→G→H suffix and drops D. After the replan, the CURRENT
  // revision is {A,B,E,G,H,Z}: the view seams expose only it, and completing
  // the new path COMPLETES the workflow — the replaced C/D failures must not
  // re-seed as required-unsatisfied and fail it.
  //
  // RED on the unmodified engine: getWorkflowSummaries counts C+D (nodeCount
  // 8, failedNodes 2) and the WorkflowReplanned rebuild seeds them as
  // required-unsatisfied, so the workflow FAILS as soon as the runtime is
  // complete instead of completing.
  it("A-p1/A-p3: replan bypassing a failed node hides the replaced segment and the workflow completes", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Rev view",
            config: {
              name: "rev-view",
              nodes: [node("a"), node("b", ["a"]), node("c", ["b"]), node("d", ["c"]), node("z")],
            },
          })
          const first = yield* takeWithin(childPrompts, "a/z did not start")
          const second = yield* takeWithin(childPrompts, "a/z did not start")
          const gateA = first.title === "a" ? first : second
          const gateZ = first.title === "a" ? second : first
          expect([gateA.title, gateZ.title].sort()).toEqual(["a", "z"])

          // Run A then B; hold Z for the whole scenario.
          yield* Deferred.succeed(gateA.release, { text: "a done" })
          const gateB = yield* takeWithin(childPrompts, "b did not start")
          yield* Deferred.succeed(gateB.release, { text: "b done" })

          // C fails genuinely (exec_failed) while Z is still running, so the
          // workflow stays RUNNING and the orchestrator can replan.
          const gateC = yield* takeWithin(childPrompts, "c did not start")
          yield* Deferred.succeed(gateC.release, { fail: true })
          yield* pollWithTimeout(
            store.getNode(dagID, "c").pipe(
              Effect.map((n) => (n?.status === "failed" && n.errorClass === "exec_failed" ? n : undefined)),
            ),
            "c did not fail with exec_failed",
          )

          // Bypass C: new suffix E→G→H off B; D (pending) is dropped by the
          // fragment and cancels; C (terminal failed, absent from fragment) is
          // the replaced segment the view must hide.
          // DAG-02: E/G are fresh reporting checkpoints, so their new
          // dependents gate on their outputs (the merged checkpoint check);
          // the E-on-B edge is exempt because B already completed.
          const plan = yield* dag.replan(dagID, {
            nodes: [
              node("e", ["b"]),
              { ...node("g", ["e"]), condition: 'e.output == "e done"' },
              { ...node("h", ["g"]), condition: 'g.output == "g done"' },
            ],
          })
          expect(plan.cancel).toEqual(["d"])
          expect(plan.add.sort()).toEqual(["e", "g", "h"])

          // A-p1 VIEW seams, immediately after the replan: the summary counts
          // ONLY the current revision. The replaced C+D rows must not count.
          const summary = (yield* store.getWorkflowSummaries("ses_parent")).find((s) => s.id === dagID)
          expect(summary).toBeDefined()
          expect(summary!.nodeCount).toBe(6)
          expect(summary!.completedNodes).toBe(2)
          expect(summary!.failedNodes).toBe(0)

          // DURABLE TRUTH UNTOUCHED (A1/A2): the full read still carries all
          // eight rows with their outcomes intact — replaced segments survive
          // in the read model and remain resolvable via the result store.
          const all = yield* store.getNodes(dagID)
          expect(all.map((n) => n.id).sort()).toEqual(["a", "b", "c", "d", "e", "g", "h", "z"])
          const c = all.find((n) => n.id === "c")!
          expect(c.status).toBe("failed")
          expect(c.errorClass).toBe("exec_failed")
          const d = all.find((n) => n.id === "d")!
          expect(d.status).toBe("failed")
          expect(d.errorReason).toBe("cancelled via replan")

          // MARKER level: the replaced segment carries the superseded flag and
          // the workflow bumped its graph revision — while current-rev rows
          // (completed A, B; added E) stay unmarked.
          expect((yield* store.getNode(dagID, "c"))?.superseded).toBe(true)
          expect((yield* store.getNode(dagID, "d"))?.superseded).toBe(true)
          expect((yield* store.getNode(dagID, "a"))?.superseded).toBe(false)
          expect((yield* store.getNode(dagID, "e"))?.superseded).toBe(false)
          expect((yield* store.getWorkflow(dagID))?.graphRev).toBe(2)

          // Complete the new path (and Z). The workflow must COMPLETE — not
          // fail on the replaced required failures.
          const gateE = yield* takeWithin(childPrompts, "e did not start after replan")
          yield* Deferred.succeed(gateE.release, { text: "e done" })
          const gateG = yield* takeWithin(childPrompts, "g did not start")
          yield* Deferred.succeed(gateG.release, { text: "g done" })
          const gateH = yield* takeWithin(childPrompts, "h did not start")
          yield* Deferred.succeed(gateH.release, { text: "h done" })
          yield* Deferred.succeed(gateZ.release, { text: "z done" })

          const terminal = yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((wf) => (wf && (wf.status === "completed" || wf.status === "failed") ? wf : undefined)),
            ),
            "workflow did not reach terminal after the new path completed",
          )
          expect(terminal.status).toBe("completed")

          const finalSummary = (yield* store.getWorkflowSummaries("ses_parent")).find((s) => s.id === dagID)
          expect(finalSummary!.nodeCount).toBe(6)
          expect(finalSummary!.completedNodes).toBe(6)
          expect(finalSummary!.failedNodes).toBe(0)
        }),
      ),
    )
  })

  // A-p2 (PIN, green before and after): a genuine failure of the CURRENT
  // revision stays visible, is counted in failedNodes, and fails the
  // workflow. Regression guard for "current-rev true failures visible".
  it("A-p2: a genuine current-rev required failure stays visible and fails the workflow", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Current rev failure",
            config: { name: "current-rev-failure", nodes: [node("g")] },
          })
          const gate = yield* takeWithin(childPrompts, "g did not start")
          yield* Deferred.succeed(gate.release, { fail: true })

          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((wf) => (wf?.status === "failed" ? wf : undefined)),
            ),
            "workflow did not fail on the genuine required failure",
          )

          // Visible + counted: the failure belongs to the current revision.
          const summary = (yield* store.getWorkflowSummaries("ses_parent")).find((s) => s.id === dagID)
          expect(summary!.nodeCount).toBe(1)
          expect(summary!.failedNodes).toBe(1)
          const rows = yield* store.getNodes(dagID)
          expect(rows.map((n) => n.id)).toEqual(["g"])
          expect(rows[0].status).toBe("failed")
          expect(rows[0].errorClass).toBe("exec_failed")
        }),
      ),
    )
  })

  // A-p5(a): wake digest failure attribution is terminal aggregation — it
  // must attribute only CURRENT-revision failures. The replaced failure C is
  // superseded by the replan that adds G; when G fails genuinely and the
  // workflow goes terminal, the digest's "Failed nodes:" block names G and
  // NOT C.
  //
  // RED on the unmodified engine: the attribution reads every failed row
  // with an error class, so the superseded C is attributed alongside G.
  it("A-p5(a): wake attribution excludes superseded replaced failures", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Wake attribution",
            config: {
              name: "wake-attribution",
              nodes: [node("a"), node("b", ["a"]), node("c", ["b"]), node("z")],
            },
          })
          const first = yield* takeWithin(childPrompts, "a/z did not start")
          const second = yield* takeWithin(childPrompts, "a/z did not start")
          const gateA = first.title === "a" ? first : second
          const gateZ = first.title === "a" ? second : first

          yield* Deferred.succeed(gateA.release, { text: "a done" })
          const gateB = yield* takeWithin(childPrompts, "b did not start")
          yield* Deferred.succeed(gateB.release, { text: "b done" })
          const gateC = yield* takeWithin(childPrompts, "c did not start")
          yield* Deferred.succeed(gateC.release, { fail: true })
          yield* pollWithTimeout(
            store.getNode(dagID, "c").pipe(
              Effect.map((n) => (n?.status === "failed" && n.errorClass === "exec_failed" ? n : undefined)),
            ),
            "c did not fail with exec_failed",
          )

          // Bypass the failure with G; C becomes the replaced segment.
          const plan = yield* dag.replan(dagID, { nodes: [node("g", ["b"])] })
          expect(plan.add).toEqual(["g"])
          expect((yield* store.getNode(dagID, "c"))?.superseded).toBe(true)
          expect((yield* store.getNode(dagID, "g"))?.superseded).toBe(false)

          // G fails genuinely — the current revision's true failure.
          const gateG = yield* takeWithin(childPrompts, "g did not start after replan")
          yield* Deferred.succeed(gateG.release, { fail: true })
          yield* pollWithTimeout(
            store.getNode(dagID, "g").pipe(
              Effect.map((n) => (n?.status === "failed" && n.errorClass === "exec_failed" ? n : undefined)),
            ),
            "g did not fail with exec_failed",
          )

          // Z completes; the required G failure then fails the workflow.
          yield* Deferred.succeed(gateZ.release, { text: "z done" })
          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((wf) => (wf?.status === "failed" ? wf : undefined)),
            ),
            "workflow did not fail on the current-rev required failure",
          )

          // Drain wakes until the terminal one arrives. Node-terminal and idle
          // stimuli can deliver intermediate "actionable" wakes while the
          // workflow is still running — those carry node results but no
          // workflow-level failure attribution. The attribution block lives on
          // the wake delivered once the workflow is terminally failed.
          const wakes: string[] = []
          let terminalWake = ""
          for (;;) {
            const wake = yield* takeWithin(parentPrompts, "terminal wake did not reach the parent")
            wakes.push(wake.text)
            yield* Deferred.succeed(wake.release, "success")
            if (wake.text.includes("[DAG Workflow failed]")) {
              terminalWake = wake.text
              break
            }
          }
          // Attribution block format: `- "<name>" (<errorClass>): <reason>`.
          // The current-rev failure G is attributed; the superseded replaced
          // failure C must not be attributed on ANY delivered wake.
          expect(terminalWake).toContain("- \"g\" (exec_failed)")
          for (const text of wakes) expect(text.includes("- \"c\"")).toBe(false)
        }),
      ),
    )
  })
})
