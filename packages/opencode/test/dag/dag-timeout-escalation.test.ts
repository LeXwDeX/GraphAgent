import { describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Layer, Option, Queue } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { WorkflowTable } from "@opencode-ai/core/dag/sql"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig, parseWorkflowConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

interface PromptGate {
  readonly title: string
  readonly release: Deferred.Deferred<string>
}

interface ParentPromptGate {
  readonly text: string
  readonly release: Deferred.Deferred<"success" | "failure">
}

function takeWithin<A>(queue: Queue.Queue<A>, message: string) {
  return Queue.take(queue).pipe(
    Effect.timeoutOption("3 seconds"),
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new Error(message)),
      onSome: Effect.succeed,
    })),
  )
}

function reply(sessionID: string, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: SessionID.make(sessionID),
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
    parts: text ? [{ id: PartID.ascending(), sessionID: SessionID.make(sessionID), messageID: id, type: "text", text }] : [],
  }
}

function node(id: string, dependsOn: string[] = [], timeoutMs?: number): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: dependsOn,
    required: true,
    prompt_template: { inline: id },
    report_to_parent: true,
    ...(timeoutMs ? { worker_config: { timeout_ms: timeoutMs } } : {}),
  }
}

function loopLayer(input: {
  readonly childPrompts: Queue.Queue<PromptGate>
  readonly parentPrompts: Queue.Queue<ParentPromptGate>
}, opts?: {
  readonly nodeExtendTimeout?: (dagID: string, nodeID: string, newDeadlineMs: number) => Effect.Effect<number, Error>
  readonly nodeTimeoutEscalated?: (dagID: string, nodeID: string, childSessionID: string, timeoutExtensions: number) => Effect.Effect<void, Error>
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
  const realDag = Dag.layer.pipe(
    Layer.provide(bridge),
    Layer.provide(store),
  )
  // N1-style fault injection: wrap the real Dag service and break selected
  // methods (everything else delegates), so a test can prove the loop and the
  // deadline watcher survive a failed durable write.
  const overrides = {
    ...(opts?.nodeExtendTimeout ? { nodeExtendTimeout: opts.nodeExtendTimeout } : {}),
    ...(opts?.nodeTimeoutEscalated ? { nodeTimeoutEscalated: opts.nodeTimeoutEscalated } : {}),
  }
  const dag = Object.keys(overrides).length > 0
    ? Layer.effect(
        Dag.Service,
        Effect.gen(function* () {
          const real = yield* Dag.Service
          return { ...real, ...overrides }
        }),
      ).pipe(Layer.provide(realDag))
    : realDag
  const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status)
  const childTitles = new Map<string, string>()
  const created: string[] = []
  let cancelCount = 0
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: () => Effect.succeed({
      id: SessionID.make("ses_parent"),
      slug: "parent",
      projectID: Project.ID.make("project-1"),
      directory: process.cwd(),
      title: "Parent",
      version: "test",
      time: { created: 0, updated: 0 },
      permission: [],
      agent: "build",
    }),
    create: (value) =>
      Effect.sync(() => {
        const id = `ses_child_${created.length + 1}`
        created.push(id)
        childTitles.set(id, (value?.title ?? id).replace(" (DAG node)", ""))
        return {
          id: SessionID.make(id),
          slug: "child",
          projectID: Project.ID.make("project-1"),
          directory: process.cwd(),
          title: value?.title ?? id,
          version: "test",
          time: { created: 0, updated: 0 },
        }
      }),
    messages: () => Effect.succeed([]),
  })
  const deliver = Effect.fn("test.SessionPrompt.deliver")(function* (value: SessionPrompt.PromptInput) {
    const sessionID = value.sessionID as string
    const text = value.parts.find((p) => p.type === "text")?.text ?? ""
    if (sessionID === "ses_parent") {
      const release = yield* Deferred.make<"success" | "failure">()
      yield* Queue.offer(input.parentPrompts, { text, release })
      const outcome = yield* Deferred.await(release)
      if (outcome === "failure") return yield* Effect.die(new Error("provider unavailable"))
      return reply(sessionID, "parent handled wake")
    }
    const release = yield* Deferred.make<string>()
    yield* Queue.offer(input.childPrompts, {
      title: childTitles.get(sessionID) ?? sessionID,
      release,
    })
    return reply(sessionID, yield* Deferred.await(release))
  })
  const prompt = Layer.mock(SessionPrompt.Service, withIdleAdmission({
    cancel: () => Effect.sync(() => { cancelCount++ }),
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
  return { layer: Layer.merge(base, loop), getCancelCount: () => cancelCount }
}

function runLoopTest<A>(
  test: (services: {
    readonly dag: Dag.Interface
    readonly store: DagStore.Interface
    readonly status: SessionStatus.Interface
    readonly childPrompts: Queue.Queue<PromptGate>
    readonly parentPrompts: Queue.Queue<ParentPromptGate>
    readonly getCancelCount: () => number
  }) => Effect.Effect<A, Error>,
  opts?: {
    readonly nodeExtendTimeout?: (dagID: string, nodeID: string, newDeadlineMs: number) => Effect.Effect<number, Error>
    readonly nodeTimeoutEscalated?: (dagID: string, nodeID: string, childSessionID: string, timeoutExtensions: number) => Effect.Effect<void, Error>
    readonly beforeInit?: (services: {
      readonly dag: Dag.Interface
      readonly store: DagStore.Interface
      readonly database: Database.Interface
    }) => Effect.Effect<void, Error>
  },
) {
  return Effect.gen(function* () {
    const childPrompts = yield* Queue.unbounded<PromptGate>()
    const parentPrompts = yield* Queue.unbounded<ParentPromptGate>()
    const harness = loopLayer({ childPrompts, parentPrompts }, opts)
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const status = yield* SessionStatus.Service
      const database = yield* Database.Service
      yield* database.db.insert(ProjectTable).values({
        id: Project.ID.make("project-1"),
        worktree: AbsolutePath.make(process.cwd()),
        sandboxes: [],
      }).run().pipe(Effect.orDie)
      yield* database.db.insert(SessionTable).values({
        id: SessionID.make("ses_parent"),
        project_id: Project.ID.make("project-1"),
        slug: "parent",
        directory: AbsolutePath.make(process.cwd()),
        title: "Parent",
        version: "test",
      }).run().pipe(Effect.orDie)
      if (opts?.beforeInit) yield* opts.beforeInit({ dag, store, database })
      yield* loop.init()
      return yield* test({
        dag,
        store,
        status,
        childPrompts,
        parentPrompts,
        getCancelCount: harness.getCancelCount,
      })
    }).pipe(
      Effect.provide(harness.layer),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: {
          id: Project.ID.make("project-1"),
          worktree: process.cwd(),
          time: { created: 0, updated: 0 },
          sandboxes: [],
        },
      }),
      Effect.scoped,
    )
  })
}

describe("DagLoop timeout escalation", () => {
  it("escalates on execution timeout without cancelling the child session, and wakes the main agent", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts, getCancelCount }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Timeout escalation",
            config: { name: "escalation", nodes: [node("a", [], 300)] },
          })
          const gate = yield* takeWithin(childPrompts, "a did not start")
          expect(gate.title).toBe("a")

          // Never release the child prompt — the deadline elapses. The child
          // session must NOT be cancelled; the node stays RUNNING with a
          // persisted extension count.
          const escalated = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) =>
                current?.timeoutExtensions === 1 && current.status === "running" ? current : undefined,
              ),
            ),
            "node did not escalate on timeout",
          )
          expect(escalated.timeoutExtensions).toBe(1)
          expect(escalated.status).toBe("running")
          expect(escalated.childSessionId).toBeTruthy()
          expect(getCancelCount()).toBe(0)

          // The main agent receives a timeout wake with the node identifier.
          const parent = yield* takeWithin(parentPrompts, "timeout wake did not reach the parent")
          expect(parent.text).toContain("[DAG Node Timeout]")
          expect(parent.text).toContain('"a"')
          // P0-A: the wake points the parent at the dedicated extend_timeout
          // adjudication, not a full replan, to grant more time.
          expect(parent.text).toContain("extend_timeout")
          yield* Deferred.succeed(parent.release, "success")

          // The child session is still alive — it can still finish the work.
          yield* Deferred.succeed(gate.release, "done")
          const completed = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) => current?.status === "completed" ? current : undefined),
            ),
            "node did not complete after the escalation",
          )
          expect(completed.status).toBe("completed")
          expect(getCancelCount()).toBe(0)
        }),
      ),
    )
  })

  it("extends the deadline via replan with a new timeout_ms and escalates again on the next deadline", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts, getCancelCount }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Timeout extension",
            config: { name: "extension", nodes: [node("a", [], 300)] },
          })
          yield* takeWithin(childPrompts, "a did not start")

          const first = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) =>
                current?.timeoutExtensions === 1 && current.status === "running" ? current : undefined,
              ),
            ),
            "first escalation did not fire",
          )
          const firstWake = yield* takeWithin(parentPrompts, "first wake did not reach the parent")
          yield* Deferred.succeed(firstWake.release, "success")

          // Main agent adjudicates: extend by replanning with a new timeout.
          // No restart marker — the running node keeps its execution.
          const plan = yield* dag.replan(dagID, { nodes: [{ ...node("a", [], 2000) }] })
          expect(plan.replace).toContain("a")
          const extended = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) =>
                current?.deadlineMs != null && current.deadlineMs > (first.deadlineMs ?? 0)
                  ? current
                  : undefined,
              ),
            ),
            "deadline was not extended by the replan",
          )
          expect(extended.status).toBe("running")
          // Cumulative cap: extend does NOT reset timeout_extensions.
          // The count persists across replan-extends; only a new attempt
          // (NodeStarted/NodeRestarted) resets it. This prevents an agent
          // from bypassing the cap by repeatedly replanning.
          expect(extended.timeoutExtensions).toBe(1)

          // The rebuilt watcher fires again once the new deadline elapses;
          // the count climbs to 2 (cumulative, not reset).
          const second = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) => current?.timeoutExtensions === 2 ? current : undefined),
            ),
            "second escalation did not fire after the extension",
          )
          expect(second.status).toBe("running")
          expect(getCancelCount()).toBe(0)
          const secondWake = yield* takeWithin(parentPrompts, "second wake did not reach the parent")
          expect(secondWake.text).toContain("[DAG Node Timeout]")
          yield* Deferred.succeed(secondWake.release, "success")
        }),
      ),
    )
  })

  it("N1: a died nodeExtendTimeout leaves the node under supervision — the watcher escalates again", async () => {
    let extendCalls = 0
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "N1 supervision survives failed extend",
            config: { name: "n1-failed-extend", nodes: [node("a", [], 300)] },
          })
          yield* takeWithin(childPrompts, "a did not start")

          // Deadline elapses → escalation #1 and a timeout wake.
          const first = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) =>
                current?.timeoutExtensions === 1 && current.status === "running" ? current : undefined,
              ),
            ),
            "first escalation did not fire",
          )
          const firstWake = yield* takeWithin(parentPrompts, "first wake did not reach the parent")
          expect(firstWake.text).toContain("[DAG Node Timeout]")
          yield* Deferred.succeed(firstWake.release, "success")

          // Adjudicate while the extend write is broken: the new timeout_ms
          // takes the re-time path (§3.7) and escalation_pending opens the cap
          // gate, but nodeExtendTimeout dies and guarded("WorkflowReplanned")
          // swallows the defect.
          yield* dag.replan(dagID, { nodes: [{ ...node("a", [], 2000) }] })

          // The re-time path did run against the broken write...
          yield* pollWithTimeout(
            Effect.sync(() => (extendCalls > 0 ? true : undefined)),
            "replan never attempted nodeExtendTimeout",
          )
          // ...and the deadline never moved (the write died).
          const afterReplan = yield* store.getNode(dagID, "a")
          expect(afterReplan?.deadlineMs).toBe(first.deadlineMs)

          // Supervision intact: the watcher the failed re-time left in place
          // escalates again on the stale deadline. Pre-fix order (interrupt the
          // watcher BEFORE the write) left the node with no watcher here and
          // timeoutExtensions stuck at 1 forever — the cap backstop (§5-5)
          // defeated by a failed write.
          const second = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) =>
                current?.timeoutExtensions === 2 && current.status === "running" ? current : undefined,
              ),
            ),
            "watcher died with the failed extend — node escaped supervision",
          )
          expect(second.timeoutExtensions).toBe(2)
          const secondWake = yield* takeWithin(parentPrompts, "second wake did not reach the parent")
          yield* Deferred.succeed(secondWake.release, "success")
        }),
        {
          nodeExtendTimeout: () =>
            Effect.sync(() => {
              extendCalls++
            }).pipe(Effect.flatMap(() => Effect.die(new Error("simulated nodeExtendTimeout defect (N1 test)")))),
        },
      ),
    )
  })

  it("D1: a failed nodeExtendTimeout does not abort the replan batch — a restarted node still gets scheduled", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "D1 batch survives failed extend",
            config: { name: "d1-batch", nodes: [node("a", [], 300), node("b", [], 5000)] },
          })
          const first = yield* takeWithin(childPrompts, "a did not start")
          const second = yield* takeWithin(childPrompts, "b did not start")
          expect([first.title, second.title].sort()).toEqual(["a", "b"])

          // a escalates on its 300ms deadline; b keeps running (prompt never
          // released, long timeout so it cannot interfere).
          yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) =>
                current?.timeoutExtensions === 1 && current.status === "running" ? current : undefined,
              ),
            ),
            "first escalation did not fire",
          )
          const firstWake = yield* takeWithin(parentPrompts, "first wake did not reach the parent")
          yield* Deferred.succeed(firstWake.release, "success")

          // One replan, two intents: a carries a NEW timeout_ms so it takes the
          // re-time path (which dies); b carries a restart marker, resetting it
          // to pending — only the handler's spawnReady reschedules the new
          // attempt. Pre-D1 the dying extend propagated to guarded() and skipped
          // spawnReady entirely, leaving b pending forever (half-applied replan).
          yield* dag.replan(dagID, {
            nodes: [{ ...node("a", [], 2000) }, { ...node("b", [], 5000), restart: true }],
          })

          const restartedB = yield* takeWithin(
            childPrompts,
            "restarted node was never re-spawned — the failed extend aborted the handler before spawnReady",
          )
          expect(restartedB.title).toBe("b")
        }),
        {
          nodeExtendTimeout: () => Effect.die(new Error("simulated nodeExtendTimeout defect (D1 test)")),
        },
      ),
    )
  })

  it("a failed escalate write does not end supervision — the watcher retries it", async () => {
    let escalateCalls = 0
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "watcher survives a failed escalate write",
            config: { name: "escalate-write-failure", nodes: [node("a", [], 300)] },
          })
          yield* takeWithin(childPrompts, "a did not start")

          // Every escalate write dies. The watcher's catchCause used to sit
          // OUTSIDE its for(;;) loop, so the first failed write ended the fiber:
          // no further escalation, timeout_extensions frozen at 0, and the §5-5
          // cap backstop could never fire (the node would hold a concurrency
          // slot unbounded). A second call proves supervision outlived the
          // failure — the read path was already hardened this way (R13), the
          // write path was not.
          yield* pollWithTimeout(
            Effect.sync(() => (escalateCalls >= 2 ? escalateCalls : undefined)),
            "watcher never retried the escalate write — the failed write ended supervision",
          )
          const current = yield* store.getNode(dagID, "a")
          expect(current?.status).toBe("running")
          expect(current?.timeoutExtensions).toBe(0)
        }),
        {
          nodeTimeoutEscalated: () =>
            Effect.sync(() => {
              escalateCalls++
            }).pipe(Effect.flatMap(() => Effect.die(new Error("simulated nodeTimeoutEscalated defect")))),
        },
      ),
    )
  })

  it("re-times NO running survivor whose deadline is healthy or timeout unchanged (§3.7 + cap gate)", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Merged semantics",
            config: {
              name: "merged",
              max_concurrency: 2,
              nodes: [node("a", [], 60_000), node("b", [], 300)],
            },
          })
          // b registers last → spawns first; a takes the second slot. Neither
          // child is ever released.
          const gates = [
            yield* takeWithin(childPrompts, "first node did not start"),
            yield* takeWithin(childPrompts, "second node did not start"),
          ]
          expect(gates.map((gate) => gate.title).sort()).toEqual(["a", "b"])

          // b escalates at its own 300ms deadline.
          const firstB = yield* pollWithTimeout(
            store.getNode(dagID, "b").pipe(
              Effect.map((current) =>
                current?.timeoutExtensions === 1 && current.status === "running" ? current : undefined,
              ),
            ),
            "b did not escalate",
          )
          const wake1 = yield* takeWithin(parentPrompts, "first wake did not reach the parent")
          expect(wake1.text).toContain("[DAG Node Timeout]")
          yield* Deferred.succeed(wake1.release, "success")

          const aBefore = yield* store.getNode(dagID, "a")

          // Replan mentions ONLY a with a new timeout — b is absent from the
          // fragment. NEITHER survivor is re-timed: §3.7 skips b (timeout
          // unchanged), and the cap gate skips a (timeout changed, but its
          // deadline is still in the future with no pending escalation). b's
          // self-renewing watcher keeps escalating the elapsed deadline toward
          // the cap.
          const plan = yield* dag.replan(dagID, { nodes: [{ ...node("a", [], 5000) }] })
          expect(plan.replace).toContain("a")
          expect(plan.replace).not.toContain("b")

          // b re-escalates one escalation interval later — well after the
          // WorkflowReplanned handler processed the fragment — with its
          // deadline frozen at the original value.
          const secondB = yield* pollWithTimeout(
            store.getNode(dagID, "b").pipe(
              Effect.map((current) =>
                current?.timeoutExtensions === 2 && current.deadlineMs === firstB.deadlineMs
                  ? current
                  : undefined,
              ),
            ),
            "self-renewing watcher did not re-escalate the unmentioned node",
          )
          expect(secondB.status).toBe("running")

          // a: the cap gate kept the healthy deadline frozen as well.
          const aAfter = yield* store.getNode(dagID, "a")
          expect(aAfter?.deadlineMs).toBe(aBefore?.deadlineMs)

          const wake2 = yield* takeWithin(parentPrompts, "second wake did not reach the parent")
          expect(wake2.text).toContain("[DAG Node Timeout]")
          yield* Deferred.succeed(wake2.release, "success")
        }),
      ),
    )
  })

  it("does not re-time a legacy running node when the fragment omits its inherited timeout", async () => {
    let dagID = ""
    let extendCalls = 0
    await Effect.runPromise(
      runLoopTest(
        ({ dag, store, childPrompts, parentPrompts }) =>
          Effect.gen(function* () {
            const first = yield* takeWithin(childPrompts, "legacy node did not start")
            expect(first.title).toBe("a")
            const running = yield* pollWithTimeout(
              store.getNode(dagID, "a").pipe(
                Effect.map((current) =>
                  current?.status === "running" && current.childSessionId ? current : undefined,
                ),
              ),
              "legacy node did not reach running",
            )
            const deadlineBefore = running.deadlineMs
            const childSessionID =
              running.childSessionId ?? (yield* Effect.fail(new Error("legacy node lost its child session")))

            // Put the node at the exact adjudication boundary where a real
            // timeout change is allowed to re-time it, then prove an omitted
            // inherited timeout is still treated as unchanged.
            yield* dag.nodeTimeoutEscalated(
              dagID,
              "a",
              childSessionID,
              running.timeoutExtensions + 1,
            )
            const wake = yield* takeWithin(parentPrompts, "legacy timeout wake did not reach the parent")
            yield* Deferred.succeed(wake.release, "success")
            yield* pollWithTimeout(
              store.getNode(dagID, "a").pipe(
                Effect.map((current) =>
                  current?.escalationPending && current.wakeReported ? current : undefined,
                ),
              ),
              "legacy timeout wake was not durably delivered",
            )

            yield* dag.replan(dagID, { nodes: [node("a"), node("b")] })
            const second = yield* takeWithin(childPrompts, "added node did not start after replan")
            expect(second.title).toBe("b")
            expect(extendCalls).toBe(0)
            expect((yield* store.getNode(dagID, "a"))?.deadlineMs).toBe(deadlineBefore)
          }),
        {
          nodeExtendTimeout: () =>
            Effect.sync(() => {
              extendCalls++
              return 1
            }),
          beforeInit: ({ dag, store, database }) =>
            Effect.gen(function* () {
              dagID = yield* dag.create({
                projectID: "project-1",
                sessionID: "ses_parent",
                title: "Inherited timeout omission",
                config: {
                  name: "inherited-timeout",
                  max_concurrency: 2,
                  node_defaults: { worker_config: { timeout_ms: 1_200 } },
                  nodes: [node("a")],
                },
              })
              const workflow =
                (yield* store.getWorkflow(dagID))
                ?? (yield* Effect.fail(new Error("workflow was not created")))
              const legacy =
                parseWorkflowConfig(workflow.config)
                ?? (yield* Effect.fail(new Error("workflow config was not readable")))
              delete legacy.nodes[0]?.worker_config
              yield* database.db
                .update(WorkflowTable)
                .set({ config: JSON.stringify(legacy) })
                .where(eq(WorkflowTable.id, dagID))
                .run()
                .pipe(Effect.orDie)
            }),
        },
      ),
    )
  })

  it("refuses a pre-escalation re-time (A1: proactive re-time cannot bypass the cap) but admits it once escalated", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "A1 cap gate",
            config: { name: "a1-cap-gate", nodes: [node("a", [], 500)] },
          })
          yield* takeWithin(childPrompts, "a did not start")
          const started = yield* store.getNode(dagID, "a")
          expect(started?.deadlineMs).not.toBeNull()

          // The agent extends PRE-EMPTIVELY before the deadline passes,
          // changing the timeout value. Without the cap gate this moved the
          // deadline to now+timeout and the node never escalated — an agent
          // cycling timeout values could push the deadline forward forever,
          // the extension count never climbed, and the ≈21× cap was bypassed.
          yield* dag.replan(dagID, { nodes: [{ ...node("a", [], 5000) }] })

          // The deadline must stay frozen at its original value and the node
          // must escalate there: extensions reaches 1 with the deadline
          // unchanged. If the re-time had fired, the deadline would be
          // now+5000 and this condition could never match.
          const escalated = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) =>
                current?.timeoutExtensions === 1 && current.deadlineMs === started?.deadlineMs
                  ? current
                  : undefined,
              ),
            ),
            "pre-escalation re-time moved the deadline (A1: the cap is bypassable)",
          )
          expect(escalated.status).toBe("running")
          const wake = yield* takeWithin(parentPrompts, "escalation wake did not reach the parent")
          expect(wake.text).toContain("[DAG Node Timeout]")
          yield* Deferred.succeed(wake.release, "success")

          // After the escalation the same extend IS admitted (deadline elapsed
          // + pending escalation), and the cumulative count survives it.
          yield* dag.replan(dagID, { nodes: [{ ...node("a", [], 2000) }] })
          const extended = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) =>
                current?.deadlineMs != null && current.deadlineMs > (started?.deadlineMs ?? 0)
                  ? current
                  : undefined,
              ),
            ),
            "post-escalation re-time was wrongly gated off",
          )
          expect(extended.timeoutExtensions).toBe(1)
          expect(extended.status).toBe("running")
        }),
      ),
    )
  }, 60_000)

  it("force-cancels and fails the node when the extension cap is exhausted", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts, getCancelCount }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Timeout cap exhausted",
            config: { name: "cap", max_timeout_extensions: 0, nodes: [node("a", [], 300)] },
          })
          yield* takeWithin(childPrompts, "a did not start")

          // With the cap at 0 the very first deadline forces a cancel+fail.
          const failed = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) => current?.status === "failed" ? current : undefined),
            ),
            "node did not fail after the extension cap was exhausted",
          )
          expect(failed.errorClass).toBe("timeout")
          expect(failed.errorReason).toContain("timeout extensions exhausted")
          expect(failed.timeoutExtensions).toBe(0)
          // The watcher force-cancels the child; the NodeFailed handler and
          // workflow terminalization then re-cancel the same (already dead)
          // session — what matters is that the child was killed.
          expect(getCancelCount()).toBeGreaterThanOrEqual(1)

          // Required-node failure cascades into a workflow failure.
          const workflow = yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((current) => current?.status === "failed" ? current : undefined),
            ),
            "workflow did not fail after the required node was force-failed",
          )
          expect(workflow.status).toBe("failed")
          const parent = yield* takeWithin(parentPrompts, "failure wake did not reach the parent")
          yield* Deferred.succeed(parent.release, "success")
        }),
      ),
    )
  })

  it("keeps the pre-permit queue-wait timeout as a direct nodeFailed (F4: queued admission deadline is fixed)", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          // Spawn order follows the node rows' desc(seq) read, so the LAST
          // registered node spawns FIRST. "a" must hold the only permit, so it
          // must be registered after "b" — "b" then waits in the queue.
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Pre-permit timeout",
            config: {
              name: "pre-permit",
              max_concurrency: 1,
              nodes: [node("b", [], 2000), node("a", [], 300)],
            },
          })
          // a holds the only permit and is never released.
          yield* takeWithin(childPrompts, "a did not start")
          const queuedB = yield* pollWithTimeout(
            store.getNode(dagID, "b").pipe(
              Effect.map((current) => current?.status === "queued" ? current : undefined),
            ),
            "b was not queued",
          )

          // a escalates at its own deadline — the RUNNING node's timeout
          // signal fires and wakes the main agent.
          const escalated = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) =>
                current?.timeoutExtensions === 1 && current.status === "running" ? current : undefined,
              ),
            ),
            "a did not escalate",
          )
          const wake = yield* takeWithin(parentPrompts, "timeout wake did not reach the parent")
          expect(wake.text).toContain("[DAG Node Timeout]")
          yield* Deferred.succeed(wake.release, "success")

          // F4: the running node's escalation/adjudication does NOT adjust the
          // queued node's admission deadline — it stays exactly as fixed at
          // admission (P0-2: queue wait counts toward the budget).
          const stillQueuedB = yield* store.getNode(dagID, "b")
          expect(stillQueuedB?.status).toBe("queued")
          expect(stillQueuedB?.deadlineMs).toBe(queuedB.deadlineMs)
          expect(escalated.timeoutExtensions).toBe(1)

          // b waits for the permit past its own deadline — the queue-wait
          // timeout still hard-fails with no progress to protect.
          const failedB = yield* pollWithTimeout(
            store.getNode(dagID, "b").pipe(
              Effect.map((current) => current?.status === "failed" ? current : undefined),
            ),
            "b did not fail on the queue-wait timeout",
          )
          expect(failedB.errorClass).toBe("timeout")
          expect(failedB.errorReason).toContain("execution permit")
        }),
      ),
    )
  })

  it("resets the extension budget on restart (S3) so a fresh attempt is not killed by a stale counter", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          // Cap of 1: the first attempt escalates exactly once (0 < 1). If the
          // counter survived the restart, the second attempt would read 1 >= 1
          // and be force-cancelled at its very first deadline.
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Restart resets extension budget",
            config: { name: "restart-budget", max_timeout_extensions: 1, nodes: [node("a", [], 300)] },
          })
          const gate1 = yield* takeWithin(childPrompts, "first attempt did not start")
          const first = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) => current?.timeoutExtensions === 1 ? current : undefined),
            ),
            "first escalation did not fire",
          )
          expect(first.status).toBe("running")
          const firstWake = yield* takeWithin(parentPrompts, "first wake did not reach the parent")
          yield* Deferred.succeed(firstWake.release, "success")
          // The child is left running (gate1 unreleased) — restart replaces
          // the attempt; the replan handler cancels the old child session.

          // Main agent restarts the node (new attempt, new budget).
          const plan = yield* dag.replan(dagID, { nodes: [{ ...node("a", [], 300), restart: true }] })
          expect(plan.restart).toContain("a")

          // The second attempt starts with a zeroed budget.
          const gate2 = yield* takeWithin(childPrompts, "second attempt did not start")
          const reset = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) => current?.status === "running" && current.timeoutExtensions === 0 ? current : undefined),
            ),
            "extension budget was not reset after restart",
          )
          expect(reset.timeoutExtensions).toBe(0)

          // Its own first deadline escalates (0 < cap 1) instead of force-killing.
          const second = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) => current?.timeoutExtensions === 1 && current.status === "running" ? current : undefined),
            ),
            "second attempt was force-cancelled by the stale extension counter (S3 regression)",
          )
          expect(second.status).toBe("running")
          const secondWake = yield* takeWithin(parentPrompts, "second wake did not reach the parent")
          yield* Deferred.succeed(secondWake.release, "success")
          yield* Deferred.succeed(gate2.release, "done")
        }),
      ),
    )
  })

  it("keeps supervising a running node after a same-value replan (§3.7: no re-time) and escalates again", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Same-value replan keeps supervision",
            config: { name: "same-value", nodes: [node("a", [], 300)] },
          })
          yield* takeWithin(childPrompts, "a did not start")
          const first = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) => current?.timeoutExtensions === 1 ? current : undefined),
            ),
            "first escalation did not fire",
          )
          const firstWake = yield* takeWithin(parentPrompts, "first wake did not reach the parent")
          yield* Deferred.succeed(firstWake.release, "success")

          // Same timeout_ms (300) — §3.7: the replan carries no NEW timeout,
          // so it is NOT an adjudication: the deadline does not move and the
          // self-renewing watcher keeps supervising. (The pre-§3.7 behavior
          // re-timed here, which let an agent stall the cap by replanning.)
          const plan = yield* dag.replan(dagID, { nodes: [{ ...node("a", [], 300) }] })
          expect(plan.replace).toContain("a")
          const second = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) =>
                current?.timeoutExtensions === 2 && current.deadlineMs === first.deadlineMs
                  ? current
                  : undefined,
              ),
            ),
            "second escalation never fired — supervision lost after same-value replan (§3.7 regression)",
          )
          expect(second.status).toBe("running")
          const secondWake = yield* takeWithin(parentPrompts, "second wake did not reach the parent")
          yield* Deferred.succeed(secondWake.release, "success")
        }),
      ),
    )
  })

  it("re-escalates without any replan until the extension cap force-cancels (S1 self-renew)", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts, getCancelCount }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "S1 self-renew without replan",
            config: { name: "s1-self-renew", max_timeout_extensions: 2, nodes: [node("a", [], 300)] },
          })
          yield* takeWithin(childPrompts, "a did not start")

          // The main agent NEVER replans. The watcher must keep escalating on
          // its own (one escalation per timeout period) instead of exiting
          // after the first one — before S1 the extension count froze at 1 and
          // the node ran unbounded, unreachable by the cap.
          for (let i = 0; i < 2; i++) {
            const escalated = yield* pollWithTimeout(
              store.getNode(dagID, "a").pipe(
                Effect.map((current) => current?.timeoutExtensions === i + 1 ? current : undefined),
              ),
              `escalation ${i + 1} did not fire without a replan (S1 regression)`,
            )
            expect(escalated.status).toBe("running")
            const wake = yield* takeWithin(parentPrompts, `wake ${i + 1} did not reach the parent`)
            expect(wake.text).toContain("[DAG Node Timeout]")
            yield* Deferred.succeed(wake.release, "success")
          }

          // Cap reached without any adjudication: force-cancel + nodeFailed.
          const failed = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) => current?.status === "failed" ? current : undefined),
            ),
            "cap-exhausted force-cancel never fired without a replan (S1 regression)",
            "10 seconds",
          )
          expect(failed.errorClass).toBe("timeout")
          expect(failed.errorReason).toContain("timeout extensions exhausted (2/2)")
          expect(getCancelCount()).toBeGreaterThanOrEqual(1)

          const failureWake = yield* takeWithin(parentPrompts, "workflow-failure wake did not reach the parent")
          yield* Deferred.succeed(failureWake.release, "success")
        }),
      ),
    )
  }, 60_000)

  it("preserves the extended timeout when a replan omits timeout_ms (F2) and keeps supervising", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Omitted timeout keeps extension",
            config: { name: "omitted-timeout", nodes: [node("a", [], 300)] },
          })
          yield* takeWithin(childPrompts, "a did not start")
          const first = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) => current?.timeoutExtensions === 1 ? current : undefined),
            ),
            "first escalation did not fire",
          )
          const firstWake = yield* takeWithin(parentPrompts, "first wake did not reach the parent")
          yield* Deferred.succeed(firstWake.release, "success")

          // Extend to 1500ms via an explicit timeout_ms (above the F9 clamp
          // floor of 1000, far below the 600000 DEFAULT).
          yield* dag.replan(dagID, { nodes: [{ ...node("a", [], 1500) }] })
          // Gate on the deadline move so the re-escalation poll below cannot
          // false-match the pre-replan count (the count is cumulative: it stays
          // 1 across the extend and only climbs on the next escalation).
          const extended = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) =>
                current?.deadlineMs != null && current.deadlineMs > (first.deadlineMs ?? 0)
                  ? current
                  : undefined,
              ),
            ),
            "deadline was not extended by the first replan",
          )
          expect(extended.status).toBe("running")
          expect(extended.timeoutExtensions).toBe(1)
          const second = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) => current?.timeoutExtensions === 2 ? current : undefined),
            ),
            "second escalation did not fire after the extension",
          )
          const secondWake = yield* takeWithin(parentPrompts, "second wake did not reach the parent")
          yield* Deferred.succeed(secondWake.release, "success")

          // Replan WITHOUT worker_config.timeout_ms. F2: the merged config must
          // keep 1500 (not silently fall back to the 600000 DEFAULT), and §3.7:
          // no NEW timeout means no re-time — the deadline stays frozen and the
          // self-renewing watcher keeps supervising.
          const bare = node("a", [])
          delete bare.worker_config
          yield* dag.replan(dagID, { nodes: [{ ...bare }] })
          const preserved = yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((wf) => {
                const config = wf ? JSON.parse(wf.config) : undefined
                return config?.nodes?.[0]?.worker_config?.timeout_ms === 1500 ? wf : undefined
              }),
            ),
            "omitted timeout_ms was overwritten by the DEFAULT (F2 regression)",
          )
          expect(preserved).toBeTruthy()
          // Omitted-timeout replan is NOT an adjudication: the deadline does not
          // move, the cumulative count climbs to 3, supervision continues.
          const third = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) =>
                current?.timeoutExtensions === 3
                  && current.deadlineMs != null
                  && current.deadlineMs === second.deadlineMs
                  ? current
                  : undefined,
              ),
            ),
            "supervision lost after omitted-timeout replan",
          )
          expect(third.status).toBe("running")
          const thirdWake = yield* takeWithin(parentPrompts, "third wake did not reach the parent")
          yield* Deferred.succeed(thirdWake.release, "success")
        }),
      ),
    )
  }, 60_000)

  it("re-delivers a completion wake after an escalation wake (F2b) instead of losing the result", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Completion wake after escalation",
            config: { name: "f2b", result_protocol: "submit_result", nodes: [node("a", [], 300)] },
          })
          const gate = yield* takeWithin(childPrompts, "a did not start")
          const escalated = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) => current?.timeoutExtensions === 1 ? current : undefined),
            ),
            "escalation did not fire",
          )
          // The escalation wake is delivered and marked reported.
          const timeoutWake = yield* takeWithin(parentPrompts, "timeout wake did not reach the parent")
          expect(timeoutWake.text).toContain("[DAG Node Timeout]")
          yield* Deferred.succeed(timeoutWake.release, "success")

          // The child finishes after the escalation; the completion must be
          // delivered as a NEW wake (NodeCompleted re-arms wake_reported).
          yield* Deferred.succeed(gate.release, "done")
          const completed = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) => current?.status === "completed" ? current : undefined),
            ),
            "node did not complete",
          )
          const completionWake = yield* takeWithin(parentPrompts, "completion wake was lost behind the escalation (F2b regression)")
          expect(completionWake.text).toContain("[DAG Node Result]")
          expect(completionWake.text).toContain("completed")
          yield* Deferred.succeed(completionWake.release, "success")
        }),
      ),
    )
  })

  // Q2 delivery-gated re-time (ADR-0002). re-time is a single path — this
  // WorkflowReplanned handler is the only caller of nodeExtendTimeout, and the
  // watchdog never re-times (it only proposes nodeTimeoutEscalated /
  // nodeFailed). The gate at loop.ts:800 decides skip vs proceed for every
  // re-time. Enumerated trigger paths reaching the gate with a NEW timeout_ms:
  //   P1 ¬escalationPending ∧ deadline>now          → A1 skip (cap)          [covered by the A1 tests above]
  //   P2 ¬escalationPending ∧ deadline≤now / null   → proceed                [A1 complement; deadline-driven re-time]
  //   P3  escalationPending ∧ ¬wakeReported         → Q2 skip (NEW)          [public path — test below]
  //   P4  escalationPending ∧ ¬wakeReported ∧ dl>now → Q2 skip (same conjunct; unreachable via the state machine: escalate never moves the deadline, so an escalated node always has deadline≤now)
  //   P5  escalationPending ∧ wakeReported          → proceed                [recovery — test below + L880/L567]
  it("blocks re-time while the escalation wake is undelivered (Q2: escalationPending ∧ ¬wakeReported ⇒ skip)", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, status, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Q2 delivery gate",
            config: { name: "q2-delivery-gate", nodes: [node("a", [], 300)] },
          })
          yield* takeWithin(childPrompts, "a did not start")

          // issue #321: wake_reported now lands at ADMIT time, so an in-flight
          // turn no longer holds wake_reported=false (the wake is reported as
          // soon as it is admitted). The only window that keeps the escalation
          // wake UNDELIVERED now is a BUSY parent session — the idle-gate never
          // admits it. Hold the wake there.
          yield* status.set(SessionID.make("ses_parent"), { type: "busy" })

          // Initial escalation fires; while the parent is busy its wake is held
          // UNDELIVERED (never admitted). The node sits at the public-path state
          // [escalationPending ∧ ¬wakeReported ∧ deadline≤now].
          const escalated = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) => current?.timeoutExtensions === 1 ? current : undefined),
            ),
            "initial escalation did not fire",
          )
          expect(escalated.status).toBe("running")
          expect(escalated.escalationPending).toBe(true)
          expect(escalated.wakeReported).toBe(false)
          const baselineDeadline = escalated.deadlineMs
          // The wake is held by the busy gate — nothing reached the parent yet.
          expect(Option.isNone(yield* Queue.poll(parentPrompts))).toBe(true)

          // Main agent replans with a NEW timeout. Q2 must SKIP the re-time:
          // adjudication cannot land before the escalation wake was delivered.
          yield* dag.replan(dagID, { nodes: [{ ...node("a", [], 5000) }] })

          // Positive discriminator (matches the L546 idiom): under Q2 the
          // re-time was skipped, so the deadline stays frozen and the
          // self-renewing watcher RE-ESCALATES there (count 1→2 with
          // deadlineMs unchanged). Under the bug the re-time fired
          // nodeExtendTimeout, moving the deadline to now+5000 (future), so
          // the watcher sleeps and the count never climbs within this window.
          // This also proves the watchdog is a pure PROPOSER: its escalation
          // drove the count up WITHOUT moving the deadline — only a re-time
          // (main-agent-initiated) moves it, and that path was gated.
          const reEscalated = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) =>
                current?.timeoutExtensions === 2 && current?.deadlineMs === baselineDeadline
                  ? current
                  : undefined,
              ),
            ),
            "re-time fired while the escalation wake was still undelivered — the deadline moved instead of staying frozen for re-escalation (Q2 delivery gate absent)",
            "3 seconds",
          )
          expect(reEscalated.escalationPending).toBe(true)
          expect(reEscalated.wakeReported).toBe(false)
          expect(reEscalated.deadlineMs).toBe(baselineDeadline)

          // Release the held wake: the parent goes idle, the wake is admitted
          // (wake_reported lands at admit, issue #321), and the turn settles.
          yield* status.set(SessionID.make("ses_parent"), { type: "idle" })
          const timeoutWake = yield* takeWithin(parentPrompts, "escalation wake did not reach the parent once idle")
          expect(timeoutWake.text).toContain("[DAG Node Timeout]")
          yield* Deferred.succeed(timeoutWake.release, "success")
        }),
      ),
    )
  }, 30_000)

  it("admits re-time once the escalation wake is delivered (Q2 recovery: escalationPending ∧ wakeReported ⇒ proceed)", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          // P5. A long timeout gives a wide re-escalation interval so the
          // delivered (wakeReported=true) state is observable before the
          // watchdog re-arms it.
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Q2 recovery after delivery",
            config: { name: "q2-recovery", nodes: [node("a", [], 5000)] },
          })
          yield* takeWithin(childPrompts, "a did not start")
          const escalated = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) => current?.timeoutExtensions === 1 ? current : undefined),
            ),
            "escalation did not fire",
            "15 seconds",
          )
          const baselineDeadline = escalated.deadlineMs
          const wake = yield* takeWithin(parentPrompts, "escalation wake did not reach the parent")
          yield* Deferred.succeed(wake.release, "success")

          // Delivery persisted — this is the state Q2 requires before re-time
          // may proceed.
          const delivered = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) => current?.wakeReported === true ? current : undefined),
            ),
            "wake_reported was not persisted after delivery",
          )
          expect(delivered.escalationPending).toBe(true)

          // Replan with a NEW timeout: Q2 no longer skips (wakeReported=true)
          // and the re-time recovers — the deadline moves past the frozen
          // baseline, adjudicating a wake the agent actually saw.
          yield* dag.replan(dagID, { nodes: [{ ...node("a", [], 15000) }] })
          const extended = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) =>
                current?.deadlineMs != null && current.deadlineMs > (baselineDeadline ?? 0) ? current : undefined,
              ),
            ),
            "re-time did not recover after the escalation wake was delivered (Q2 over-gated)",
          )
          expect(extended.status).toBe("running")
        }),
      ),
    )
  }, 30_000)

  // C1 (final-review 裁定): nodeExtendTimeout had two `return 0` paths — a
  // terminal rejection (node not running) and a Q2 delivery-gate rejection
  // (node STILL running, escalationPending ∧ ¬wakeReported). The handler
  // killed the watcher on every written===0, so under the T8↔T9 interleave
  // (getNodes reads under evalLock, nodeExtendTimeout re-reads under
  // workflowLock — the two locks are not synchronized) a Q2 reject orphaned
  // a running node (N1 violation: a running node left with no watcher, cap
  // backstop defeated). The fix splits the contract: Q2 returns -2, terminal
  // keeps 0; the handler's existing `written < 0 → continue` then keeps the
  // watcher for -2 (and -1 write-fail) while `written === 0` stays the
  // terminal-cleanup path.
  it("C1: nodeExtendTimeout distinguishes Q2 rejection (-2) from terminal rejection (0)", async () => {
    await Effect.runPromise(
      runLoopTest(({ dag, store, status, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "C1 distinct rejection contract",
            config: { name: "c1-contract", nodes: [node("a", [], 300)] },
          })
          const gate = yield* takeWithin(childPrompts, "a did not start")

          // issue #321: wake_reported lands at ADMIT time, so the Q2 state
          // [escalationPending ∧ ¬wakeReported] can no longer be held by an
          // in-flight turn — hold the escalation wake UNDELIVERED via the busy
          // idle-gate instead, which keeps it never admitted.
          yield* status.set(SessionID.make("ses_parent"), { type: "busy" })
          const escalated = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) =>
                current && current.status === "running" && current.escalationPending && !current.wakeReported
                  ? current
                  : undefined,
              ),
            ),
            "escalation did not reach the Q2 state",
          )
          const frozenDeadline = escalated.deadlineMs
          const farFuture = (escalated.deadlineMs ?? 0) + 99_999_999

          // The command must DISTINGUISH the two rejection reasons: Q2 returns
          // -2, NOT 0. Returning 0 made the handler kill the watcher on a
          // still-running node. No deadline is written on either reject.
          const q2Verdict = yield* dag.nodeExtendTimeout(dagID, "a", farFuture)
          expect(q2Verdict).toBe(-2)
          const afterQ2 = yield* store.getNode(dagID, "a")
          expect(afterQ2?.status).toBe("running")
          expect(afterQ2?.deadlineMs).toBe(frozenDeadline)

          // Release the held wake (idle admits it) and let the child finish —
          // the node terminalizes.
          yield* status.set(SessionID.make("ses_parent"), { type: "idle" })
          const wake = yield* takeWithin(parentPrompts, "escalation wake did not reach the parent")
          yield* Deferred.succeed(wake.release, "success")
          yield* Deferred.succeed(gate.release, "done")
          yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((current) => (current?.status === "completed" ? current : undefined)),
            ),
            "node did not complete",
          )

          // Terminal rejection stays 0 — the node is no longer running. The
          // handler's 0-branch (clear the stale watcher) is correct for THIS
          // value alone now that Q2 no longer collides into it.
          const terminalVerdict = yield* dag.nodeExtendTimeout(dagID, "a", farFuture)
          expect(terminalVerdict).toBe(0)
        }),
      ),
    )
  })

  it("C1: a Q2 rejection (-2) keeps the node supervised — the watcher re-escalates (N1)", async () => {
    let extendCalls = 0
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "C1 Q2 reject keeps supervision",
            config: { name: "c1-q2-keep", nodes: [node("a", [], 300)] },
          })
          yield* takeWithin(childPrompts, "a did not start")

          // Escalate, then DELIVER the wake so the re-time gate PROCEEDS (the
          // gate skips only while the wake is undelivered). This reaches
          // nodeExtendTimeout — the mock returns -2, simulating the T8
          // interleave (watchdog re-escalated under the workflow lock AFTER
          // the gate's evalLock snapshot read, flipping wakeReported false).
          yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((c) => (c?.timeoutExtensions === 1 ? c : undefined)),
            ),
            "first escalation did not fire",
          )
          const wake = yield* takeWithin(parentPrompts, "escalation wake did not reach the parent")
          yield* Deferred.succeed(wake.release, "success")
          yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((c) => (c?.wakeReported === true ? c : undefined)),
            ),
            "wake_reported was not persisted after delivery",
          )

          yield* dag.replan(dagID, { nodes: [{ ...node("a", [], 2000) }] })
          yield* pollWithTimeout(
            Effect.sync(() => (extendCalls > 0 ? true : undefined)),
            "replan never attempted nodeExtendTimeout",
          )

          // N1: the -2 verdict kept the watcher alive. The mock wrote nothing,
          // so the self-renewing watcher re-escalates the elapsed deadline —
          // count climbs 1→2. Under the bug (Q2 returned 0) the handler killed
          // the watcher here and the count froze, orphaning the running node.
          const second = yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((c) => (c?.timeoutExtensions === 2 && c.status === "running" ? c : undefined)),
            ),
            "watcher was killed on the Q2 reject — node escaped supervision (N1 violation)",
          )
          expect(second.status).toBe("running")
          const secondWake = yield* takeWithin(parentPrompts, "second wake did not reach the parent")
          yield* Deferred.succeed(secondWake.release, "success")
        }),
        {
          nodeExtendTimeout: () => Effect.sync(() => { extendCalls++ }).pipe(Effect.as(-2)),
        },
      ),
    )
  })

  it("C1: a terminal rejection (0) clears the stale watcher — the node stops escalating", async () => {
    let extendCalls = 0
    await Effect.runPromise(
      runLoopTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "C1 terminal reject clears watcher",
            config: { name: "c1-terminal-clear", nodes: [node("a", [], 300)] },
          })
          yield* takeWithin(childPrompts, "a did not start")

          // Escalate (count 0→1) and deliver the wake so the re-time gate
          // proceeds. The mock returns 0 — simulating nodeExtendTimeout's
          // terminal rejection. The handler must clear the stale watcher.
          yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((c) => (c?.timeoutExtensions === 1 ? c : undefined)),
            ),
            "first escalation did not fire",
          )
          const wake = yield* takeWithin(parentPrompts, "escalation wake did not reach the parent")
          yield* Deferred.succeed(wake.release, "success")
          yield* pollWithTimeout(
            store.getNode(dagID, "a").pipe(
              Effect.map((c) => (c?.wakeReported === true ? c : undefined)),
            ),
            "wake_reported was not persisted after delivery",
          )

          yield* dag.replan(dagID, { nodes: [{ ...node("a", [], 2000) }] })
          yield* pollWithTimeout(
            Effect.sync(() => (extendCalls > 0 ? true : undefined)),
            "replan never attempted nodeExtendTimeout",
          )

          // The 0-verdict cleared the watcher. The count captured after the
          // handler ran must FREEZE: a live self-renewing watcher escalates
          // every ~1s (escalateIntervalMs) on the elapsed deadline, so holding
          // past two escalate intervals with no climb is positive evidence the
          // watcher is gone. The contrast with the 0→1 climb above (and with
          // the -2 test where the count keeps climbing) makes the absence
          // legible. The sleep IS the assertion (non-escalation), not a sync
          // hack — a live watcher would deterministically escalate within it.
          const frozen = (yield* store.getNode(dagID, "a"))!.timeoutExtensions
          yield* Effect.sleep("2 seconds")
          const after = yield* store.getNode(dagID, "a")
          expect(after?.status).toBe("running")
          expect(after?.timeoutExtensions).toBe(frozen)
        }),
        {
          nodeExtendTimeout: () => Effect.sync(() => { extendCalls++ }).pipe(Effect.as(0)),
        },
      ),
    )
  })
})
