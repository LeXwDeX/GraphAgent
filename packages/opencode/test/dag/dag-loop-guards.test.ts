/**
 * DagLoop guard regressions:
 *
 * 1. Cross-instance adoption (P0): DagLoop is per-directory InstanceState but
 *    the event bus and store are process-global. Only the instance whose
 *    project owns a workflow may adopt it — at WorkflowStarted AND at startup
 *    recovery. Regression: a foreign instance won the first-wave spawn race
 *    and children ran under the wrong directory context.
 *
 * 2. Subscription survival (P1): orDie defects punch through Effect.ignore
 *    (it only absorbs the error channel) and killed the forked runForEach
 *    fiber, leaving that event type permanently unhandled. Handlers are now
 *    guarded with catchCause.
 *
 * 3. Cancel-skip race (P1): workflow-level cancel publishes NodeSkipped for
 *    running nodes; when that handler won the cross-stream race against
 *    WorkflowCancelled it deleted the fiber uninterrupted and the child
 *    session kept running. The NodeSkipped handler now aborts live fibers.
 */
import { describe, expect, it } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer, Option, Queue } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { WorkflowNodeTable, WorkflowTable } from "@opencode-ai/core/dag/sql"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SettingsHook } from "@/hook/settings"
import { HookLifecycle } from "@/hook/lifecycle"
import { pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

interface PromptGate {
  readonly title: string
  readonly input: SessionPrompt.PromptInput
  readonly release: Deferred.Deferred<string>
}

function node(overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    id: "n1",
    name: "Node 1",
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: "work" },
    ...overrides,
  }
}

function takeWithin<A>(queue: Queue.Queue<A>, message: string) {
  return Queue.take(queue).pipe(
    Effect.timeoutOption("1 second"),
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new Error(message)),
      onSome: Effect.succeed,
    })),
  )
}

function reply(sessionID: string, text: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text }],
  } as never
}

function guardLayer(input: {
  readonly childPrompts: Queue.Queue<PromptGate>
  readonly cancels: string[]
  readonly created: string[]
  /** Injected one-shot defects for DagStore.getWorkflow (P1 survival test). */
  readonly failGetWorkflow?: { remaining: number }
  /** Injected Dag.pause failures (typed or defect) for the DAG-03 gate test. */
  readonly failPause?: { remaining: number; defect?: boolean }
  readonly hooks?: Layer.Layer<SettingsHook.Service>
}) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const realStore = DagStore.layer.pipe(Layer.provide(database))
  const store = input.failGetWorkflow
    ? Layer.effect(
        DagStore.Service,
        Effect.gen(function* () {
          const real = yield* DagStore.Service
          return DagStore.Service.of({
            ...real,
            getWorkflow: (id) =>
              Effect.suspend(() => {
                if (input.failGetWorkflow!.remaining > 0) {
                  input.failGetWorkflow!.remaining--
                  return Effect.die(new Error("injected transient db failure"))
                }
                return real.getWorkflow(id)
              }),
          })
        }),
      ).pipe(Layer.provide(realStore))
    : realStore
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
  )
  const realDag = Dag.layer.pipe(
    Layer.provide(bridge),
    Layer.provide(store),
  )
  const dag = input.failPause
    ? Layer.effect(
        Dag.Service,
        Effect.gen(function* () {
          const real = yield* Dag.Service
          return Dag.Service.of({
            ...real,
            pause: (id) =>
              Effect.suspend(() => {
                if (input.failPause!.remaining > 0) {
                  input.failPause!.remaining--
                  return input.failPause!.defect
                    ? Effect.die(new Error("injected pause defect"))
                    : Effect.fail(new Error("injected pause failure"))
                }
                return real.pause(id)
              }),
            pauseForCheckpoint: (id, checkpointSeq) =>
              Effect.gen(function* () {
                const acknowledgedSeq = yield* real.store.getLatestCheckpointControlSeq(id)
                if (acknowledgedSeq !== undefined && acknowledgedSeq >= checkpointSeq) {
                  return yield* real.pauseForCheckpoint(id, checkpointSeq)
                }
                if (input.failPause!.remaining > 0) {
                  input.failPause!.remaining--
                  return yield* input.failPause!.defect
                    ? Effect.die(new Error("injected checkpoint pause defect"))
                    : Effect.fail(new Error("injected checkpoint pause failure"))
                }
                return yield* real.pauseForCheckpoint(id, checkpointSeq)
              }),
          })
        }),
      ).pipe(Layer.provide(realDag))
    : realDag
  const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status)
  const childTitles = new Map<string, string>()
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: () => Effect.succeed({ id: "ses_parent", permission: [], agent: "build" } as never),
    create: (value) =>
      Effect.sync(() => {
        const id = `ses_child_${input.created.length + 1}`
        input.created.push(id)
        childTitles.set(id, (value?.title ?? id).replace(" (DAG node)", ""))
        return { id } as never
      }),
    messages: () => Effect.succeed([]),
  })
  const deliver = Effect.fn("test.SessionPrompt.deliver")(function* (value: SessionPrompt.PromptInput) {
    const sessionID = value.sessionID as string
    const release = yield* Deferred.make<string>()
    yield* Queue.offer(input.childPrompts, {
      title: childTitles.get(sessionID) ?? sessionID,
      input: value,
      release,
    })
    return reply(sessionID, yield* Deferred.await(release))
  })
  const prompt = Layer.mock(SessionPrompt.Service, withIdleAdmission({
    cancel: (sessionID) =>
      Effect.sync(() => {
        input.cancels.push(sessionID as string)
      }),
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
      model: { providerID: "test" as never, modelID: "test-model" as never },
      tools: {},
      hooks: {},
    }),
  })
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(agent),
    Layer.provide(input.hooks ?? Layer.empty),
    Layer.provide(input.hooks ? HookLifecycle.layer : Layer.empty),
  )
  return Layer.merge(base, loop)
}

function runGuardTest<A>(
  options: {
    /** Project the current instance belongs to. */
    readonly instanceProject: string
    readonly failGetWorkflow?: { remaining: number }
    readonly failPause?: { remaining: number; defect?: boolean }
    readonly hooks?: Layer.Layer<SettingsHook.Service>
  },
  test: (services: {
    readonly dag: Dag.Interface
    readonly loop: DagLoop.Interface
    readonly store: DagStore.Interface
    readonly childPrompts: Queue.Queue<PromptGate>
    readonly cancels: string[]
    readonly created: string[]
  }) => Effect.Effect<A, Error>,
  beforeInit?: (services: { readonly database: Database.Interface }) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const childPrompts = yield* Queue.unbounded<PromptGate>()
    const cancels: string[] = []
    const created: string[] = []
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const database = yield* Database.Service
      // Two projects sharing the process-global store, one session in each.
      for (const project of ["project-1", "project-2"]) {
        yield* database.db.insert(ProjectTable).values({
          id: project as never,
          worktree: process.cwd() as never,
          sandboxes: [],
        }).run().pipe(Effect.orDie)
        yield* database.db.insert(SessionTable).values({
          id: `ses_${project}` as never,
          project_id: project as never,
          slug: project,
          directory: process.cwd() as never,
          title: `Parent of ${project}`,
          version: "test",
        }).run().pipe(Effect.orDie)
      }
      if (beforeInit) yield* beforeInit({ database })
      yield* loop.init()
      return yield* test({ dag, loop, store, childPrompts, cancels, created })
    }).pipe(
      Effect.provide(
        guardLayer({
          childPrompts,
          cancels,
          created,
          failGetWorkflow: options.failGetWorkflow,
          failPause: options.failPause,
          hooks: options.hooks,
        }),
      ),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: { id: options.instanceProject },
      } as never),
      Effect.scoped,
    )
  })
}

describe("DagLoop cross-instance adoption guard", () => {
  it("does not adopt a foreign project's workflow at WorkflowStarted", async () => {
    await Effect.runPromise(
      runGuardTest({ instanceProject: "project-2" }, ({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_project-1",
            title: "Foreign workflow",
            config: { name: "foreign", nodes: [node({ id: "foreign-node", name: "foreign-node" })] },
          })
          // Give the (wrongly subscribed) handler time to act, then assert
          // nothing spawned and the durable node is untouched.
          yield* Effect.sleep("300 millis")
          expect(Option.isNone(yield* Queue.poll(childPrompts))).toBe(true)
          const nodes = yield* store.getNodes(dagID)
          expect(nodes).toHaveLength(1)
          expect(nodes[0].status).toBe("pending")
        }),
      ),
    )
  })

  it("adopts and spawns its own project's workflow (control)", async () => {
    await Effect.runPromise(
      runGuardTest({ instanceProject: "project-2" }, ({ dag, childPrompts }) =>
        Effect.gen(function* () {
          yield* dag.create({
            projectID: "project-2",
            sessionID: "ses_project-2",
            title: "Own workflow",
            config: { name: "own", nodes: [node({ id: "own-node", name: "own-node" })] },
          })
          const child = yield* takeWithin(childPrompts, "own-project node did not start")
          expect(child.title).toBe("own-node")
          yield* Deferred.succeed(child.release, "done")
        }),
      ),
    )
  })

  it("does not reconcile a foreign project's running workflow at startup recovery", async () => {
    await Effect.runPromise(
      runGuardTest(
        { instanceProject: "project-2" },
        ({ store, cancels }) =>
          Effect.gen(function* () {
            yield* Effect.sleep("300 millis")
            // Without the guard, recovery invents an ownership-lost failure
            // and cancels the child session. The foreign row must stay put.
            const nodes = yield* store.getNodes("foreign-recovery")
            expect(nodes[0].status).toBe("running")
            expect(cancels).toHaveLength(0)
          }),
        ({ database }) =>
          database.db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert(WorkflowTable).values({
                id: "foreign-recovery",
                project_id: "project-1" as never,
                session_id: "ses_project-1" as never,
                title: "Foreign running workflow",
                status: "running",
                config: "{}",
                seq: 10,
              }).run()
              yield* tx.insert(WorkflowNodeTable).values({
                id: "orphan-node",
                workflow_id: "foreign-recovery",
                name: "orphan-node",
                worker_type: "build",
                status: "running",
                required: true,
                depends_on: [],
                child_session_id: "ses_orphan",
                seq: 9,
              }).run()
            }),
          ).pipe(Effect.orDie),
      ),
    )
  })
})

describe("DagLoop missing node config guard (DAG-A03)", () => {
  it("fails an active row closed without creating or prompting a child session", async () => {
    await Effect.runPromise(
      runGuardTest(
        { instanceProject: "project-1" },
        ({ store, created }) =>
          Effect.gen(function* () {
            const failed = yield* pollWithTimeout(
              store.getNode("dag_missing_config", "orphan-node").pipe(
                Effect.map((row) => row?.status === "failed" ? row : undefined),
              ),
              "missing-config node was not failed closed",
            )
            expect(failed.errorReason).toBe("Node configuration missing for active node: orphan-node")
            expect(failed.errorClass).toBe("exec_failed")
            expect(created).toEqual([])
          }),
        ({ database }) =>
          database.db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert(WorkflowTable).values({
                id: "dag_missing_config",
                project_id: Project.ID.make("project-1"),
                session_id: SessionID.make("ses_project-1"),
                directory: process.cwd(),
                title: "Missing config",
                status: "running",
                config: JSON.stringify({ name: "missing-config", nodes: [] }),
                seq: 10,
              }).run()
              yield* tx.insert(WorkflowNodeTable).values({
                id: "orphan-node",
                workflow_id: "dag_missing_config",
                name: "orphan-node",
                worker_type: "build",
                status: "pending",
                required: true,
                depends_on: [],
                seq: 9,
              }).run()
            }),
          ).pipe(Effect.orDie),
      ),
    )
  })
})

describe("DagLoop subscription survival", () => {
  it("keeps processing WorkflowStarted after a handler defect", async () => {
    await Effect.runPromise(
      runGuardTest(
        { instanceProject: "project-1", failGetWorkflow: { remaining: 1 } },
        ({ dag, childPrompts }) =>
          Effect.gen(function* () {
            // First workflow: the handler's getWorkflow dies (injected defect).
            // The guarded boundary must log-and-survive, not kill the stream.
            yield* dag.create({
              projectID: "project-1",
              sessionID: "ses_project-1",
              title: "Poisoned workflow",
              config: { name: "poisoned", nodes: [node({ id: "poisoned-node", name: "poisoned-node" })] },
            })
            yield* Effect.sleep("200 millis")
            // Second workflow on the same subscription must still spawn.
            yield* dag.create({
              projectID: "project-1",
              sessionID: "ses_project-1",
              title: "Healthy workflow",
              config: { name: "healthy", nodes: [node({ id: "healthy-node", name: "healthy-node" })] },
            })
            const child = yield* takeWithin(childPrompts, "subscription died after defect — healthy workflow never spawned")
            expect(child.title).toBe("healthy-node")
            yield* Deferred.succeed(child.release, "done")
          }),
      ),
    )
  })
})

describe("DagLoop cancel-skip race", () => {
  it("aborts the live child session when NodeSkipped lands on a running node", async () => {
    await Effect.runPromise(
      runGuardTest({ instanceProject: "project-1" }, ({ dag, store, childPrompts, cancels }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_project-1",
            title: "Skip race",
            config: { name: "skip-race", nodes: [node({ id: "racy-node", name: "racy-node" })] },
          })
          // Node is running: its prompt is parked on the deferred gate.
          const child = yield* takeWithin(childPrompts, "racy-node did not start")
          const childSessionID = child.input.sessionID as string
          // Simulate the workflow-cancel skip arriving before the
          // WorkflowCancelled sweep: publish NodeSkipped directly.
          yield* dag.nodeSkipped(dagID, "racy-node", "workflow_cancelled")
          // The handler must abort the child instead of orphaning its fiber.
          yield* pollWithTimeout(
            Effect.sync(() => (cancels.includes(childSessionID) ? true as const : undefined)),
            "NodeSkipped handler did not cancel the live child session",
          )
          const updated = yield* store.getNode(dagID, "racy-node")
          expect(updated?.status).toBe("skipped")
        }),
      ),
    )
  })
})

describe("DagLoop replan verdict gate (issue #322)", () => {
  it("pauses the workflow on a reporting checkpoint's replan verdict and blocks dependents until resume", async () => {
    await Effect.runPromise(
      runGuardTest({ instanceProject: "project-1" }, ({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_project-1",
            title: "Gate replan verdict",
            config: {
              name: "gate-replan",
              nodes: [
                node({ id: "gate", name: "gate", required: true, report_to_parent: true, output_schema: { type: "object" } }),
                node({ id: "downstream", name: "downstream", required: false, depends_on: ["gate"] }),
              ],
            },
          })
          const gateChild = yield* takeWithin(childPrompts, "gate node did not start")
          expect(gateChild.title).toBe("gate")
          // The checkpoint submits a replan verdict (issue #322: the graph used
          // to spawn the dependent anyway and spin to terminal).
          yield* dag.nodeCompleted(dagID, "gate", { verdict: "replan", findings: "direction vetoed" })
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const wf = yield* store.getWorkflow(dagID)
              return wf?.status === "paused" ? (true as const) : undefined
            }),
            "workflow did not pause after the replan verdict",
          )
          // The only prompt that may land while paused is the report_to_parent
          // wake for the parent session — a dependent spawn would flip the
          // durable row to queued/running first.
          const woken = yield* takeWithin(childPrompts, "report_to_parent wake never delivered")
          expect(woken.title).toBe("ses_project-1")
          expect(Option.isNone(yield* Queue.poll(childPrompts))).toBe(true)
          expect((yield* store.getNode(dagID, "downstream"))?.status).toBe("pending")
          // Parent disposition: replan fragment + resume continues the graph.
          yield* dag.resume(dagID)
          const downstreamChild = yield* takeWithin(childPrompts, "downstream did not start after resume")
          expect(downstreamChild.title).toBe("downstream")
          yield* Deferred.succeed(downstreamChild.release, "done")
        }),
      ),
    )
  })

  it("advances normally when a reporting checkpoint submits verdict continue", async () => {
    await Effect.runPromise(
      runGuardTest({ instanceProject: "project-1" }, ({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_project-1",
            title: "Gate continue verdict",
            config: {
              name: "gate-continue",
              nodes: [
                node({ id: "gate", name: "gate", required: true, report_to_parent: true, output_schema: { type: "object" } }),
                node({ id: "downstream", name: "downstream", required: false, depends_on: ["gate"] }),
              ],
            },
          })
          const gateChild = yield* takeWithin(childPrompts, "gate node did not start")
          expect(gateChild.title).toBe("gate")
          yield* dag.nodeCompleted(dagID, "gate", { verdict: "continue", findings: "direction confirmed" })
          // The report_to_parent wake and the downstream spawn can land in
          // either order; accept the downstream prompt whichever comes second.
          const first = yield* takeWithin(childPrompts, "no prompt after continue verdict")
          const downstreamChild = first.title === "downstream"
            ? first
            : yield* takeWithin(childPrompts, "downstream did not spawn after continue verdict")
          expect(downstreamChild.title).toBe("downstream")
          expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
          yield* Deferred.succeed(downstreamChild.release, "done")
        }),
      ),
    )
  })

  it("pauses on a string-typed replan verdict (no output_schema bypass)", async () => {
    await Effect.runPromise(
      runGuardTest({ instanceProject: "project-1" }, ({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_project-1",
            title: "Gate string verdict",
            config: {
              name: "gate-string-verdict",
              nodes: [
                // report_to_parent without output_schema: the child's final
                // text lands as a raw string output.
                node({ id: "gate", name: "gate", required: true, report_to_parent: true }),
                node({ id: "downstream", name: "downstream", required: false, depends_on: ["gate"] }),
              ],
            },
          })
          const gateChild = yield* takeWithin(childPrompts, "gate node did not start")
          expect(gateChild.title).toBe("gate")
          // String-typed verdict (audit SOFT-2): must still trip the gate,
          // not slip past the Object-only decode.
          yield* dag.nodeCompleted(dagID, "gate", JSON.stringify({ verdict: "replan", findings: "vetoed" }))
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const wf = yield* store.getWorkflow(dagID)
              return wf?.status === "paused" ? (true as const) : undefined
            }),
            "workflow did not pause after the string-typed replan verdict",
          )
          expect((yield* store.getNode(dagID, "downstream"))?.status).toBe("pending")
        }),
      ),
    )
  })
})

// DAG-01 (runtime half): a schema-less reporting checkpoint completes with a
// RAW STRING output. Pre-fix the condition evaluator resolved
// `gate.output.<field>` on that string to undefined, so an equality gate was
// permanently false: every gated dependent skipped (condition_false), the
// orphan cascade terminalized the subtree, and checkCompletion marked the
// workflow COMPLETED with skipReviewGate — half the graph never ran, with
// no error anywhere. The fix normalizes string outputs through the same
// parseJsonOption the replan-verdict gate already uses.
describe("DagLoop equality gates on schema-less string outputs (DAG-01)", () => {
  it("evaluates a .output.<field> condition against a JSON-string checkpoint output", async () => {
    await Effect.runPromise(
      runGuardTest({ instanceProject: "project-1" }, ({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_project-1",
            title: "String equality gate",
            config: {
              name: "string-equality-gate",
              nodes: [
                node({ id: "gate", name: "gate", required: true, report_to_parent: true }),
                node({
                  id: "downstream",
                  name: "downstream",
                  required: false,
                  depends_on: ["gate"],
                  condition: 'gate.output.verdict == "continue"',
                }),
              ],
            },
          })
          const gateChild = yield* takeWithin(childPrompts, "gate node did not start")
          expect(gateChild.title).toBe("gate")
          yield* dag.nodeCompleted(dagID, "gate", JSON.stringify({ verdict: "continue", findings: "confirmed" }))
          // The report_to_parent wake and the downstream spawn can land in
          // either order; accept the downstream prompt whichever comes second.
          const first = yield* takeWithin(childPrompts, "no prompt after continue verdict — gate evaluated false on the string output")
          const downstreamChild = first.title === "downstream"
            ? first
            : yield* takeWithin(childPrompts, "downstream was silently skipped — string output never normalized (DAG-01)")
          expect(downstreamChild.title).toBe("downstream")
          expect((yield* store.getNode(dagID, "downstream"))?.status).not.toBe("skipped")
          yield* Deferred.succeed(downstreamChild.release, "done")
        }),
      ),
    )
  })

  it("keeps a non-JSON string output gate false without the subtree silently vanishing", async () => {
    await Effect.runPromise(
      runGuardTest({ instanceProject: "project-1" }, ({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_project-1",
            title: "Prose gate",
            config: {
              name: "prose-gate",
              nodes: [
                node({ id: "gate", name: "gate", required: true, report_to_parent: true }),
                node({
                  id: "downstream",
                  name: "downstream",
                  required: false,
                  depends_on: ["gate"],
                  condition: 'gate.output.verdict == "continue"',
                }),
              ],
            },
          })
          const gateChild = yield* takeWithin(childPrompts, "gate node did not start")
          expect(gateChild.title).toBe("gate")
          // Prose (non-JSON) output: normalization falls back to the raw
          // string, the field path resolves undefined, the equality gate is
          // false — the documented skip, not a crash.
          yield* dag.nodeCompleted(dagID, "gate", "All good, shipping it.")
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const downstream = yield* store.getNode(dagID, "downstream")
              return downstream?.status === "skipped" ? (true as const) : undefined
            }),
            "prose-output gate did not settle to condition_false",
          )
        }),
      ),
    )
  })
})

// DAG-02 (runtime half): the checkpoint gate must also police the MERGED
// graph at replan/extend — a fragment may attach a new dependent to an
// existing reporting checkpoint, which the fragment-scoped authoring check
// cannot see. Pre-fix replanStructuralDiagnostics never ran
// checkpointGateDiagnostics, so the engine spawned the dependent the moment
// the checkpoint completed, before the parent could read the verdict.
describe("Dag.replan merged-graph checkpoint gate (DAG-02)", () => {
  it("rejects a replan fragment that attaches an ungated dependent to an existing reporting checkpoint", async () => {
    await Effect.runPromise(
      runGuardTest({ instanceProject: "project-1" }, ({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_project-1",
            title: "Merged gate",
            config: {
              name: "merged-gate",
              nodes: [
                node({ id: "gate", name: "gate", required: true, report_to_parent: true, output_schema: { type: "object" } }),
                node({
                  id: "downstream",
                  name: "downstream",
                  required: false,
                  depends_on: ["gate"],
                  condition: 'gate.output.verdict == "continue"',
                }),
              ],
            },
          })
          const gateChild = yield* takeWithin(childPrompts, "gate node did not start")
          expect(gateChild.title).toBe("gate")
          // Fragment adds a dependent on the existing checkpoint WITHOUT a
          // condition — the merged graph must reject it.
          const attempt = yield* dag
            .replan(dagID, { nodes: [node({ id: "late", name: "late", depends_on: ["gate"] })] })
            .pipe(
              Effect.match({
                onFailure: (error) => ({ ok: false as const, message: String(error) }),
                onSuccess: () => ({ ok: true as const, message: "" }),
              }),
            )
          expect(attempt.ok).toBe(false)
          expect(attempt.message.includes('"gate"') && attempt.message.includes('"late"')).toBe(true)
          expect((yield* store.getNode(dagID, "late"))).toBeUndefined()
          yield* Deferred.succeed(gateChild.release, "done")
        }),
      ),
    )
  })
})

// DAG-03: the replan-verdict gate must FAIL CLOSED. The checkpoint vetoed
// the direction; if the durable pause cannot be persisted (both attempts
// fail/defect and the row still reads non-paused), the in-memory scheduler
// must still HOLD — pre-fix it returned `wf?.status === "paused"`
// (fail-OPEN) and explicitly un-paused the runtime, so the very next
// stimulus that calls spawnReady (here: a NodeFailed handler) spawned the
// vetoed dependent. Defects from dag.pause must also fold into the retry
// path: pre-fix `Effect.catch` only covered the error channel, a defect
// escaped to guarded() and dropped the whole NodeCompleted handler (no
// pause, no gate log).
describe("DagLoop replan verdict gate fail-closed (DAG-03)", () => {
  function vetoedGateGraph(title: string, name: string) {
    return {
      projectID: "project-1",
      sessionID: "ses_project-1",
      title,
      config: {
        name,
        nodes: [
          node({ id: "gate", name: "gate", required: true, report_to_parent: true, output_schema: { type: "object" } }),
          node({ id: "downstream", name: "downstream", required: false, depends_on: ["gate"] }),
          node({ id: "probe", name: "probe", required: false }),
        ],
      },
    }
  }

  // Create the graph; gate and probe are both ready at boot, so take both
  // prompts and index them by title (order is racy).
  function takeBootPrompts(childPrompts: Queue.Queue<PromptGate>) {
    return Effect.gen(function* () {
      const first = yield* takeWithin(childPrompts, "first boot prompt did not arrive")
      const second = yield* takeWithin(childPrompts, "second boot prompt did not arrive")
      const byTitle = new Map([[first.title, first], [second.title, second]])
      const gate = byTitle.get("gate")
      const probe = byTitle.get("probe")
      if (!gate || !probe) return yield* Effect.fail(new Error(`expected gate+probe, got ${first.title}/${second.title}`))
      return { gate, probe }
    })
  }

  it("holds the in-memory pause when the durable pause exhausts its retries", async () => {
    await Effect.runPromise(
      runGuardTest(
        { instanceProject: "project-1", failPause: { remaining: 99 } },
        ({ dag, store, childPrompts }) =>
          Effect.gen(function* () {
            const dagID = yield* dag.create(vetoedGateGraph("Fail-closed gate", "fail-closed-gate"))
            const { gate } = yield* takeBootPrompts(childPrompts)
            expect(gate.title).toBe("gate")
            yield* dag.nodeCompleted(dagID, "gate", { verdict: "replan", findings: "vetoed" })
            // The durable pause never landed
            expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
            // Post-veto stimulus on an unrelated node.
            yield* dag.nodeFailed(dagID, "probe", "probe exploded", "exec_failed")
            yield* Effect.sleep("300 millis")
            // Fail-closed: the vetoed dependent was NOT spawned by the
            // post-veto stimulus.
            expect((yield* store.getNode(dagID, "downstream"))?.status).toBe("pending")
          }),
      ),
    )
  })

  it("holds the in-memory pause when the pause attempts defect", async () => {
    await Effect.runPromise(
      runGuardTest(
        { instanceProject: "project-1", failPause: { remaining: 99, defect: true } },
        ({ dag, store, childPrompts }) =>
          Effect.gen(function* () {
            const dagID = yield* dag.create(vetoedGateGraph("Defect gate", "defect-gate"))
            const { gate } = yield* takeBootPrompts(childPrompts)
            expect(gate.title).toBe("gate")
            yield* dag.nodeCompleted(dagID, "gate", { verdict: "replan", findings: "vetoed" })
            expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
            yield* dag.nodeFailed(dagID, "probe", "probe exploded", "exec_failed")
            yield* Effect.sleep("300 millis")
            expect((yield* store.getNode(dagID, "downstream"))?.status).toBe("pending")
          }),
      ),
    )
  })

  // Review F2 (R1): the hold must SURVIVE the durable-row re-sync that the
  // next node terminal event performs, and it must be RELEASED by an explicit
  // parent control action (replan/resume/step) — otherwise the fail-closed
  // hold was lifted by any subsequent NodeCompleted/NodeSkipped/stepped
  // stimulus and spawnReady ran on the vetoed direction before the parent
  // ever adjudicated the verdict.
  it("the veto hold survives a terminal-event flag re-sync (DAG-03 / F2)", async () => {
    await Effect.runPromise(
      runGuardTest(
        { instanceProject: "project-1", failPause: { remaining: 99 } },
        ({ dag, store, childPrompts }) =>
          Effect.gen(function* () {
            const dagID = yield* dag.create(vetoedGateGraph("Resync hold", "resync-hold"))
            const { gate } = yield* takeBootPrompts(childPrompts)
            expect(gate.title).toBe("gate")
            yield* dag.nodeCompleted(dagID, "gate", { verdict: "replan", findings: "vetoed" })
            expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
            // Completing the unrelated probe lands in the NodeCompleted
            // handler, whose prologue re-syncs paused from the DURABLE row
            // ("running") and then calls spawnReady — the re-sync must not
            // lift the veto hold.
            yield* dag.nodeCompleted(dagID, "probe", "probe done")
            yield* Effect.sleep("300 millis")
            expect((yield* store.getNode(dagID, "downstream"))?.status).toBe("pending")
          }),
      ),
    )
  })

  it("a parent replan releases the hold and the corrective path spawns (DAG-03 / F2)", async () => {
    await Effect.runPromise(
      runGuardTest(
        { instanceProject: "project-1", failPause: { remaining: 99 } },
        ({ dag, store, childPrompts }) =>
          Effect.gen(function* () {
            const dagID = yield* dag.create(vetoedGateGraph("Replan release", "replan-release"))
            const { gate } = yield* takeBootPrompts(childPrompts)
            expect(gate.title).toBe("gate")
            yield* dag.nodeCompleted(dagID, "gate", { verdict: "replan", findings: "vetoed" })
            expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
            // Parent disposition: replan adds a corrective node off the
            // (terminal) checkpoint — exempt from the merged checkpoint gate.
            yield* dag.replan(dagID, { nodes: [node({ id: "corrective", name: "corrective", depends_on: ["gate"] })] })
            // The WorkflowReplanned handler releases the hold and re-syncs
            // flags from the durable row, so the corrective node spawns. The
            // wake prompt may interleave; drain until the corrective prompt.
            const corrective = yield* Effect.gen(function* () {
              for (let i = 0; i < 4; i++) {
                const next = yield* takeWithin(childPrompts, `prompt ${i} after replan never arrived`)
                if (next.title === "corrective") return next
              }
              return yield* Effect.fail(new Error("corrective node did not spawn after the releasing replan"))
            })
            expect(corrective.title).toBe("corrective")
            yield* Deferred.succeed(corrective.release, "fixed")
          }),
      ),
    )
  })
})

describe("DagLoop settled Stop notification", () => {
  for (const timeout of [false, true])
    it(`finishes Stop after real NodeFailed interruption (${timeout ? "hook timeout" : "hook completion"})`, async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const releaseStop = yield* Deferred.make<void>()
          const started: string[] = []
          const finished: string[] = []
          const exits: Exit.Exit<unknown, unknown>[] = []
          const hooks = Layer.mock(SettingsHook.Service, {
            registerScoped: () => Effect.void,
            unregisterScoped: () => Effect.void,
            trigger: (payload) =>
              Effect.gen(function* () {
                started.push(payload.event)
                if (payload.event === "SubagentStart")
                  yield* Effect.withFiber((fiber) => Effect.sync(() => fiber.addObserver((exit) => exits.push(exit))))
                if (payload.event === "SubagentStop")
                  yield* timeout ? Effect.never.pipe(Effect.timeoutOption(10)) : Deferred.await(releaseStop)
                finished.push(payload.event)
                return { additionalContexts: [], systemMessages: [] }
              }),
          })
          yield* runGuardTest({ instanceProject: "project-1", hooks }, ({ dag, store, childPrompts, cancels }) =>
            Effect.gen(function* () {
              const dagID = yield* dag.create({
                projectID: "project-1",
                sessionID: "ses_project-1",
                title: "Settled Stop race",
                config: {
                  name: "settled-stop-race",
                  max_concurrency: 1,
                  nodes: [node({ required: false }), node({ id: "n2", name: "Node 2", required: false })],
                },
              })
              const child = yield* takeWithin(childPrompts, "child did not start")
              // A clean model turn with empty output fails the node's result contract.
              yield* Deferred.succeed(child.release, "")
              yield* pollWithTimeout(
                Effect.sync(() => (cancels.includes(child.input.sessionID) ? true : undefined)),
                "NodeFailed consumer did not cancel the settled child",
              )
              yield* Effect.yieldNow
              if (!timeout) yield* Deferred.succeed(releaseStop, undefined)
              // This second child cannot prompt until the interrupted first fiber
              // completes its notification finalizer and releases the sole permit.
              const next = yield* takeWithin(childPrompts, "settled child did not release the concurrency permit")
              const failedNodeID = child.title === "Node 1" ? "n1" : "n2"
              expect((yield* store.getNode(dagID, failedNodeID))?.status).toBe("failed")
              expect(started.filter((event) => event === "SubagentStop")).toHaveLength(1)
              expect(finished.filter((event) => event === "SubagentStop")).toHaveLength(1)
              const interrupted = yield* pollWithTimeout(
                Effect.sync(() => exits.find((exit) => Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))),
                "the real NodeFailed consumer never interrupted the first execution fiber",
              )
              expect(Exit.isFailure(interrupted)).toBe(true)
              yield* Deferred.succeed(next.release, "done")
              yield* pollWithTimeout(
                store
                  .getWorkflow(dagID)
                  .pipe(Effect.map((workflow) => (workflow?.status === "completed" ? true : undefined))),
                "workflow did not finish after the next child completed",
              )
            }).pipe(Effect.ensuring(Deferred.succeed(releaseStop, undefined))),
          )
        }),
      )
    })

  it("does not notify Stop for user cancellation before settlement", async () => {
    const observed: string[] = []
    const exits: Exit.Exit<unknown, unknown>[] = []
    const hooks = Layer.mock(SettingsHook.Service, {
      registerScoped: () => Effect.void,
      unregisterScoped: () => Effect.void,
      trigger: (payload) =>
        Effect.gen(function* () {
          observed.push(payload.event)
          if (payload.event === "SubagentStart")
            yield* Effect.withFiber((fiber) => Effect.sync(() => fiber.addObserver((exit) => exits.push(exit))))
          return { additionalContexts: [], systemMessages: [] }
        }),
    })
    await Effect.runPromise(
      runGuardTest({ instanceProject: "project-1", hooks }, ({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_project-1",
            title: "Cancelled Stop",
            config: { name: "cancelled-stop", nodes: [node()] },
          })
          yield* takeWithin(childPrompts, "child did not start")
          yield* dag.nodeCancelled(dagID, "n1")
          yield* pollWithTimeout(
            Effect.sync(() => exits.find((exit) => Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))),
            "cancelled execution fiber did not finish",
          )
          const cancelled = yield* store.getNode(dagID, "n1")
          expect(cancelled?.status).toBe("failed")
          expect(cancelled?.superseded).toBe(true)
          expect(observed).toEqual(["SubagentStart"])
        }),
      ),
    )
  })
})
