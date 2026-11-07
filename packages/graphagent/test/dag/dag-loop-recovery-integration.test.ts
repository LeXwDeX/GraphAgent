import { describe, expect, it } from "bun:test"
import { DateTime, Effect, Layer, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { Agent } from "@/agent/agent"
import { Dag, type NodeConfig, type WorkflowConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { fingerprintBrief } from "@/dag/admission"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

type ChildStatus = "active" | "completed" | "failed" | "unknown"

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

function recoveryLayer(input: {
  childStatuses: Map<string, ChildStatus>
  cancelled: string[]
  created: string[]
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
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    create: Effect.fn("test.Session.create")((_value?: unknown) =>
      Effect.sync(() => {
        input.created.push("generated")
        return {} as never
      }),
    ),
    get: Effect.fn("test.Session.get")(() => Effect.succeed({} as never)),
    messages: Effect.fn("test.Session.messages")((value: { sessionID: string }) => {
      const status = input.childStatuses.get(value.sessionID) ?? "unknown"
      if (status === "unknown") return Effect.succeed([])
      if (status === "active") {
        return Effect.succeed([{ info: { role: "assistant", finish: undefined } }] as never)
      }
      if (status === "failed") {
        return Effect.succeed([{ info: { role: "assistant", error: { name: "failed" } } }] as never)
      }
      return Effect.succeed([{ info: { role: "assistant", finish: "stop" } }] as never)
    }),
  })
  const prompt = Layer.mock(SessionPrompt.Service, withIdleAdmission({
    cancel: Effect.fn("test.SessionPrompt.cancel")((sessionID: string) =>
      Effect.sync(() => input.cancelled.push(sessionID)),
    ),
    // Keep wake delivery pending so tests can inspect durable unreported rows.
    prompt: () => Effect.never,
    promptIfIdle: () => Effect.succeed(Option.none()),
  }))
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(Layer.mock(Agent.Service, {})),
  )
  return Layer.merge(base, loop)
}

function runRecovery<A>(
  status: ChildStatus,
  test: (services: {
    dag: Dag.Interface
    database: Database.Interface
    loop: DagLoop.Interface
    events: EventV2.Interface
    store: DagStore.Interface
    cancelled: string[]
    created: string[]
  }) => Effect.Effect<A, Error>,
) {
  const childStatuses = new Map([["ses_child1", status]])
  const cancelled: string[] = []
  const created: string[] = []
  return Effect.gen(function* () {
    const dag = yield* Dag.Service
    const database = yield* Database.Service
    const loop = yield* DagLoop.Service
    const events = yield* EventV2.Service
    const store = yield* DagStore.Service
    return yield* test({ dag, database, loop, events, store, cancelled, created })
  }).pipe(
    Effect.provide(recoveryLayer({ childStatuses, cancelled, created })),
    Effect.provideService(InstanceRef, {
      directory: process.cwd(),
      worktree: process.cwd(),
      project: { id: "project-1" },
    } as never),
    Effect.scoped,
  )
}

function createRunningNode(
  dag: Dag.Interface,
  database: Database.Interface,
  config: NodeConfig[],
  deadlineMs?: number,
  wakeEligible?: boolean,
  configOverrides: Partial<WorkflowConfig> = {},
) {
  return Effect.gen(function* () {
    yield* database.db.insert(ProjectTable).values({
      id: "project-1" as never,
      worktree: process.cwd() as never,
      sandboxes: [],
    }).run().pipe(Effect.orDie)
    yield* database.db.insert(SessionTable).values({
      id: "ses_parent1" as never,
      project_id: "project-1" as never,
      slug: "parent",
      directory: process.cwd() as never,
      title: "Parent",
      version: "test",
    }).run().pipe(Effect.orDie)
    const dagID = yield* dag.create({
      projectID: "project-1",
      sessionID: "ses_parent1",
      title: "Recovery",
      config: { name: "recovery", nodes: config, ...configOverrides },
    })
    yield* dag.nodeStarted(dagID, "n1", "ses_child1", deadlineMs, wakeEligible)
    return dagID
  })
}

describe("DagLoop crash recovery integration", () => {
  it("retains consumed deep admission across recovery without replaying QA", async () => {
    const brief = {
      goal: "Recover a qualified deep workflow",
      scope: { in: ["DAG recovery"], out: ["admission UI"] },
      constraints: ["keep the original brief"],
      assumptions: ["the durable config is available"],
      acceptance_criteria: ["recovery retains the consumed admission"],
      evidence_required: ["integration test"],
      risks: ["production rollout is unspecified"],
      review_plan: ["verify the recovered config"],
      open_questions: [],
      blocking_questions: ["Confirm production rollout"],
    }
    await Effect.runPromise(
      runRecovery("active", ({ dag, database, loop, store, created }) =>
        Effect.gen(function* () {
          const dagID = yield* createRunningNode(
            dag,
            database,
            [node()],
            undefined,
            undefined,
            {
              mode: "deep",
              admission: {
                protocol_version: 1,
                brief_revision: 2,
                qa_mode: "GRILL",
                verdict: "WAIVED",
                state: "WAIVED",
                fingerprint: fingerprintBrief(brief),
                brief,
                waiver_reason: "Preview recovery coverage only",
                acknowledged_risks: ["Production rollout is unspecified"],
              },
            },
          )

          yield* loop.init()

          const workflow = yield* store.getWorkflow(dagID)
          expect(Dag.parseWorkflowConfig(workflow?.config ?? "")).toEqual(expect.objectContaining({
            mode: "deep",
            admission: expect.objectContaining({
              state: "CONSUMED",
              verdict: "WAIVED",
              brief_revision: 2,
              brief,
              waiver_reason: "Preview recovery coverage only",
              acknowledged_risks: ["Production rollout is unspecified"],
            }),
          }))
          expect(created).toEqual([])
        }),
      ),
    )
  })

  it("cancels active children with future or absent deadlines without spawning replacements", async () => {
    for (const deadline of [Date.now() + 60_000, undefined]) {
      await Effect.runPromise(
        runRecovery("active", ({ dag, database, loop, store, cancelled, created }) =>
          Effect.gen(function* () {
            const dagID = yield* createRunningNode(dag, database, [node()], deadline)

            yield* loop.init()

            expect(cancelled).toEqual(["ses_child1"])
            expect(created).toEqual([])
            expect((yield* store.getNode(dagID, "n1"))?.status).toBe("failed")
          }),
        ),
      )
    }
  })

  it("preserves timeout trigger and reason for an expired recovered node", async () => {
    await Effect.runPromise(
      runRecovery("active", ({ dag, database, loop, events, store, cancelled }) =>
        Effect.gen(function* () {
          const failures: Array<{ reason: string; trigger: string }> = []
          const unsubscribe = yield* events.listen((event) =>
            event.type === DagEvent.NodeFailed.type
              ? Effect.sync(() => failures.push(event.data as never))
              : Effect.void,
          )
          const dagID = yield* createRunningNode(dag, database, [node()], Date.now() - 1)

          yield* loop.init()
          // Listener fan-out is async-ordered relative to publish (never rely
          // on it having run by the time init returns) — wait for the durable
          // failure to surface before unsubscribing.
          yield* pollWithTimeout(
            Effect.sync(() =>
              failures.some(
                (f) => f.reason === "deadline exceeded on recovery" && f.trigger === "timeout",
              )
                ? failures
                : undefined,
            ),
            "NodeFailed recovery timeout was not observed",
          )
          yield* unsubscribe

          expect(cancelled).toEqual(["ses_child1"])
          expect(failures).toContainEqual(expect.objectContaining({
            reason: "deadline exceeded on recovery",
            trigger: "timeout",
          }))
          expect((yield* store.getNode(dagID, "n1"))?.errorReason).toBe("deadline exceeded on recovery")
          expect((yield* store.getNode(dagID, "n1"))?.errorClass).toBe("timeout")
        }),
      ),
    )
  })

  it("projects captured output from a completed child session", async () => {
    await Effect.runPromise(
      runRecovery("completed", ({ dag, database, loop, store, cancelled }) =>
        Effect.gen(function* () {
          const dagID = yield* createRunningNode(dag, database, [
            node({ output_schema: { type: "object" } }),
          ], undefined, undefined, { result_protocol: "submit_result" })
          yield* store.setCapturedOutput("ses_child1", { summary: "done" })

          yield* loop.init()

          expect(cancelled).toEqual([])
          expect((yield* store.getNode(dagID, "n1"))?.output).toEqual({ summary: "done" })
          expect((yield* store.getWorkflow(dagID))?.status).toBe("completed")
        }),
      ),
    )
  })

  it("pauses on invented recovery failures and terminalizes only after explicit resume", async () => {
    await Effect.runPromise(
      runRecovery("active", ({ dag, database, loop, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createRunningNode(dag, database, [
            node(),
            node({ id: "n2", name: "Node 2", depends_on: ["n1"] }),
          ])

          yield* loop.init()

          // P2-2 recovery-pause: the ownership-lost failure is invented, so the
          // workflow pauses instead of cascading skips — downstream stays
          // pending (replannable), disposition belongs to the parent.
          expect((yield* store.getNode(dagID, "n1"))?.status).toBe("failed")
          expect((yield* store.getNode(dagID, "n2"))?.status).toBe("pending")
          expect((yield* store.getWorkflow(dagID))?.status).toBe("paused")

          // Explicit resume accepts the failure semantics: the required-node
          // failure terminalizes the workflow as FAILED (P2-1 attribution).
          yield* dag.resume(dagID)
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const wf = yield* store.getWorkflow(dagID)
              return wf?.status === "failed" ? wf : undefined
            }),
            "resumed workflow did not terminalize",
          )
          expect((yield* store.getNode(dagID, "n2"))?.status).toBe("skipped")
        }),
      ),
    )
  })

  it("keeps downstream replannable after recovery-pause", async () => {
    await Effect.runPromise(
      runRecovery("active", ({ dag, database, loop, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createRunningNode(dag, database, [
            node(),
            node({ id: "n2", name: "Node 2", depends_on: ["n1"] }),
          ])

          yield* loop.init()
          expect((yield* store.getWorkflow(dagID))?.status).toBe("paused")

          // The failed node is terminal-immutable, but its pending dependents
          // are not — replan can rewire them onto a replacement node. Under the
          // pre-P2-2 behavior n2 was already skipped (terminal) and the
          // workflow already failed, so this exact replan was impossible.
          yield* dag.replan(dagID, {
            nodes: [
              node({ id: "n1b", name: "Node 1 retry" }),
              node({ id: "n2", name: "Node 2", depends_on: ["n1b"] }),
            ],
          })

          expect((yield* store.getNode(dagID, "n1b"))?.status).toBe("pending")
          expect((yield* store.getNode(dagID, "n2"))?.dependsOn).toEqual(["n1b"])
          expect((yield* store.getWorkflow(dagID))?.status).toBe("paused")
        }),
      ),
    )
  })

  it("terminalizes a fully-settled workflow on resume after recovery-pause", async () => {
    await Effect.runPromise(
      runRecovery("active", ({ dag, database, loop, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createRunningNode(dag, database, [node()])

          yield* loop.init()
          expect((yield* store.getWorkflow(dagID))?.status).toBe("paused")

          // Every node is already settled at resume time — the WorkflowResumed
          // handler itself must re-run completion or the workflow would hang
          // in running forever.
          yield* dag.resume(dagID)
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const wf = yield* store.getWorkflow(dagID)
              return wf?.status === "failed" ? wf : undefined
            }),
            "resumed settled workflow did not terminalize",
          )
        }),
      ),
    )
  })

  it("keeps report-to-parent recovery failures in the durable unreported wake query", async () => {
    await Effect.runPromise(
      runRecovery("active", ({ dag, database, loop, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createRunningNode(
            dag,
            database,
            [node({ report_to_parent: true })],
            undefined,
            true,
          )

          yield* loop.init()

          expect(yield* store.getUnreportedWakeNodes("ses_parent1")).toContainEqual(
            expect.objectContaining({ workflowId: dagID, id: "n1", status: "failed" }),
          )
        }),
      ),
    )
  })

  it("leaves no recovered node running without current-process fiber ownership", async () => {
    await Effect.runPromise(
      runRecovery("unknown", ({ dag, database, loop, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createRunningNode(dag, database, [node()])

          yield* loop.init()

          expect((yield* store.getNodes(dagID)).filter((item) => item.status === "running")).toEqual([])
        }),
      ),
    )
  })

  it("rejects late start and completion projections after ownership-loss terminalization", async () => {
    await Effect.runPromise(
      runRecovery("active", ({ dag, database, loop, events, store }) =>
        Effect.gen(function* () {
          const dagID = yield* createRunningNode(dag, database, [node()])
          yield* loop.init()

          yield* events.publish(DagEvent.NodeStarted, {
            dagID,
            nodeID: "n1" as never,
            childSessionID: "ses_latechild" as never,
            timestamp: yield* DateTime.now,
          })
          yield* events.publish(DagEvent.NodeCompleted, {
            dagID,
            nodeID: "n1" as never,
            output: { stale: true },
            durationMs: 1 as never,
            timestamp: yield* DateTime.now,
          })

          expect(yield* store.getNode(dagID, "n1")).toEqual(
            expect.objectContaining({
              status: "failed",
              childSessionId: "ses_child1",
              output: null,
            }),
          )
        }),
      ),
    )
  })
})
