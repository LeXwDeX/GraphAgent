import { describe, expect, it } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Clock, Deferred, Effect, Fiber, Layer, Option, Queue, Schema, Exit, Cause } from "effect"
import { eq } from "drizzle-orm"
import * as TestClock from "effect/testing/TestClock"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { TerminalViolationError } from "@opencode-ai/core/dag/core/types"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { WorkflowNodeTable, WorkflowTable } from "@opencode-ai/core/dag/sql"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Agent } from "@/agent/agent"
import { Provider as RuntimeProvider } from "@/provider/provider"
import { fingerprintBrief } from "@/dag/admission"
import { Dag, type NodeConfig } from "@/dag/dag"
import { DagLoop, isPausedReminderDue } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { WorkflowParameters, WorkflowTool } from "@/tool/workflow"
import { ProviderTest } from "../fake/provider"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"

const integration = testEffect(Layer.empty)

describe("paused workflow reminder lease", () => {
  it("becomes due once after five minutes and stays acknowledged across restart", () => {
    const paused = { status: "paused", wakeReported: false, timeUpdated: 1_000 }
    expect(isPausedReminderDue(paused, 300_999)).toBe(false)
    expect(isPausedReminderDue(paused, 301_000)).toBe(true)
    expect(isPausedReminderDue({ ...paused, wakeReported: true }, 1_000_000)).toBe(false)
    expect(isPausedReminderDue({ ...paused, status: "running" }, 1_000_000)).toBe(false)
    expect(isPausedReminderDue({ ...paused, timeUpdated: 900_000 }, 1_000_000)).toBe(false)
  })
})

interface PromptGate {
  readonly title: string
  readonly input: SessionPrompt.PromptInput
  readonly release: Deferred.Deferred<string>
}

interface ParentPromptGate {
  readonly input: SessionPrompt.PromptInput
  readonly release: Deferred.Deferred<"success" | "failure">
}

function takeWithin<A>(queue: Queue.Queue<A>, message: string, timeout: "1 second" | "40 seconds" = "1 second") {
  return Queue.take(queue).pipe(
    Effect.timeoutOption(timeout),
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
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: text ? [{ type: "text", text }] as never : [],
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

function promptText(input: SessionPrompt.PromptInput) {
  return input.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function waitForCompletion(store: DagStore.Interface, dagID: string, message: string) {
  return pollWithTimeout<true, Error, never>(
    store.getWorkflow(dagID).pipe(
      Effect.map((workflow) => workflow?.status === "completed" ? true : undefined),
    ),
    message,
  )
}

function wakeLayer(input: {
  readonly childPrompts: Queue.Queue<PromptGate>
  readonly parentPrompts: Queue.Queue<ParentPromptGate>
  readonly parentSettled: Queue.Queue<void>
  readonly agentPermissions: PermissionV1.Ruleset
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
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: () => Effect.succeed({
      id: SessionID.make("ses_parent"),
      slug: "parent",
      projectID: Project.ID.make("project-1"),
      directory: process.cwd(),
      title: "parent",
      agent: "build",
      model: { providerID: Provider.ID.make("test"), id: Model.ID.make("test-model") },
      version: "test",
      time: { created: 0, updated: 0 },
    }),
    create: (value) =>
      Effect.sync(() => {
        const id = `ses_child_${created.length + 1}`
        created.push(id)
        childTitles.set(id, (value?.title ?? id).replace(" (DAG node)", ""))
        return { id } as never
      }),
    messages: () => Effect.succeed([]),
  })
  const deliver = Effect.fn("test.SessionPrompt.deliver")(function* (value: SessionPrompt.PromptInput) {
    const sessionID = value.sessionID as string
    if (sessionID === "ses_parent") {
      const release = yield* Deferred.make<"success" | "failure">()
      yield* Queue.offer(input.parentPrompts, { input: value, release })
      const outcome = yield* Deferred.await(release).pipe(
        Effect.ensuring(Queue.offer(input.parentSettled, undefined)),
      )
      if (outcome === "failure") return yield* Effect.die(new Error("provider unavailable"))
      return reply(sessionID, "parent handled wake")
    }
    const release = yield* Deferred.make<string>()
    yield* Queue.offer(input.childPrompts, {
      title: childTitles.get(sessionID) ?? sessionID,
      input: value,
      release,
    })
    return reply(sessionID, yield* Deferred.await(release))
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
      permission: [...input.agentPermissions],
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
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(agent),
  )
  return Layer.mergeAll(base, loop, session, agent, provider, truncate)
}

function runWakeTest<A>(
  test: (services: {
    readonly dag: Dag.Interface
    readonly loop: DagLoop.Interface
    readonly store: DagStore.Interface
    readonly status: SessionStatus.Interface
    readonly childPrompts: Queue.Queue<PromptGate>
    readonly parentPrompts: Queue.Queue<ParentPromptGate>
    readonly parentSettled: Queue.Queue<void>
    readonly workflow: Tool.InferDef<typeof WorkflowTool>
  }) => Effect.Effect<A, Error>,
  beforeInit?: (services: {
    readonly database: Database.Interface
  }) => Effect.Effect<void>,
  agentPermissions: PermissionV1.Ruleset = [],
) {
  return Effect.gen(function* () {
    const childPrompts = yield* Queue.unbounded<PromptGate>()
    const parentPrompts = yield* Queue.unbounded<ParentPromptGate>()
    const parentSettled = yield* Queue.unbounded<void>()
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const status = yield* SessionStatus.Service
      const database = yield* Database.Service
      const workflow = yield* Tool.init(yield* WorkflowTool)
      yield* database.db.insert(ProjectTable).values({
        id: "project-1" as never,
        worktree: process.cwd() as never,
        sandboxes: [],
      }).run().pipe(Effect.orDie)
      yield* database.db.insert(SessionTable).values({
        id: "ses_parent" as never,
        project_id: "project-1" as never,
        slug: "parent",
        directory: process.cwd(),
        title: "Parent",
        version: "test",
      }).run().pipe(Effect.orDie)
      if (beforeInit) yield* beforeInit({ database })
      yield* loop.init()
      // This suite exercises the original parent wake contract. Its mocked
      // sessions do not persist direct final-response receipts, so keep the
      // workflow protocol explicit while preserving any case override.
      const legacyDag: Dag.Interface = {
        ...dag,
        create: (input) => dag.create({
          ...input,
          config: { ...input.config, result_protocol: input.config.result_protocol ?? "submit_result" },
        }),
      }
      return yield* test({ dag: legacyDag, loop, store, status, childPrompts, parentPrompts, parentSettled, workflow })
    }).pipe(
      Effect.provide(wakeLayer({ childPrompts, parentPrompts, parentSettled, agentPermissions })),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: { id: "project-1" },
      } as never),
      Effect.scoped,
    )
  })
}

describe("DagLoop atomic wake integration", () => {
  it("admits an aged pause reminder from the 30-second sweep once across restart", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const childTitles = new Map<string, string>()
        const created: string[] = []
        const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
          get: () =>
            Effect.succeed({
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
        })
        const deliver = (queues: {
          readonly childPrompts: Queue.Queue<PromptGate>
          readonly parentPrompts: Queue.Queue<ParentPromptGate>
          readonly parentSettled: Queue.Queue<void>
        }) =>
          Effect.fn("test.SessionPrompt.deliver")(function* (value: SessionPrompt.PromptInput) {
            const sessionID = value.sessionID as string
            if (sessionID === "ses_parent") {
              const release = yield* Deferred.make<"success" | "failure">()
              yield* Queue.offer(queues.parentPrompts, { input: value, release })
              const outcome = yield* Deferred.await(release).pipe(
                Effect.ensuring(Queue.offer(queues.parentSettled, undefined)),
              )
              if (outcome === "failure") return yield* Effect.die(new Error("provider unavailable"))
              return reply(sessionID, "parent handled reminder")
            }
            const release = yield* Deferred.make<string>()
            yield* Queue.offer(queues.childPrompts, {
              title: childTitles.get(sessionID) ?? sessionID,
              input: value,
              release,
            })
            return reply(sessionID, yield* Deferred.await(release))
          })
        const promptLayer = (queues: {
          readonly childPrompts: Queue.Queue<PromptGate>
          readonly parentPrompts: Queue.Queue<ParentPromptGate>
          readonly parentSettled: Queue.Queue<void>
        }) => Layer.mock(SessionPrompt.Service, withIdleAdmission({
          cancel: () => Effect.void,
          prompt: deliver(queues),
          promptIfIdle: (value) => deliver(queues)(value).pipe(Effect.map(Option.some)),
        }))

        const database = Database.layerFromPath(":memory:")
        const events = EventV2.layer.pipe(Layer.provide(database))
        const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
        const store = DagStore.layer.pipe(Layer.provide(database))
        const status = SessionStatus.layer.pipe(Layer.provide(bridge))
        const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
        const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
        const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status)

        yield* Effect.gen(function* () {
          const storeService = yield* DagStore.Service
          const databaseService = yield* Database.Service
          yield* databaseService.db.insert(ProjectTable).values({
            id: Project.ID.make("project-1"),
            worktree: AbsolutePath.make(process.cwd()),
            sandboxes: [],
          }).run().pipe(Effect.orDie)
          yield* databaseService.db.insert(SessionTable).values({
            id: SessionID.make("ses_parent"),
            project_id: Project.ID.make("project-1"),
            slug: "parent",
            directory: AbsolutePath.make(process.cwd()),
            title: "Parent",
            version: "test",
          }).run().pipe(Effect.orDie)

          const firstQueues = {
            childPrompts: yield* Queue.unbounded<PromptGate>(),
            parentPrompts: yield* Queue.unbounded<ParentPromptGate>(),
            parentSettled: yield* Queue.unbounded<void>(),
          }
          let workflowID = ""
          yield* Effect.scoped(
            Effect.gen(function* () {
              const dagService = yield* Dag.Service
              const loopService = yield* DagLoop.Service
              yield* loopService.init()
              workflowID = yield* dagService.create({
                projectID: "project-1",
                sessionID: "ses_parent",
                title: "Periodic pause reminder",
                config: {
                  name: "periodic-pause-reminder",
                  nodes: [{ ...node("work"), required: false, report_to_parent: false }],
                },
              })
              yield* takeWithin(firstQueues.childPrompts, "paused reminder worker did not start")
              yield* dagService.pause(workflowID)
              const paused = yield* storeService.getWorkflow(workflowID)
              expect(paused?.status).toBe("paused")
              expect(paused?.wakeReported).toBe(false)

              // The startup scan has already run. Age only the persisted pause
              // timestamp so the actual periodic 30-second sweep sees a due row.
              const now = yield* Clock.currentTimeMillis
              yield* databaseService.db
                .update(WorkflowTable)
                .set({ time_updated: now - 5 * 60_000 - 1 })
                .where(eq(WorkflowTable.id, workflowID))
                .run()

              // Advance across the production 30-second sleep in virtual time;
              // the actual DagLoop periodic fiber and sweep still execute.
              yield* TestClock.adjust("30 seconds")
              const parent = yield* takeWithin(
                firstQueues.parentPrompts,
                "30-second paused reminder sweep did not admit the parent prompt",
                "40 seconds",
              )
              expect(promptText(parent.input)).toContain(
                '[DAG Workflow paused] Workflow "Periodic pause reminder" has remained paused for five minutes.',
              )
              expect(parent.input.parts.some((part) => part.type === "text" && part.synthetic === true)).toBe(true)
              // Simulate a process crash while the admitted parent turn remains in flight.
              expect((yield* storeService.getWorkflow(workflowID))?.wakeReported).toBe(true)
            }).pipe(Effect.provide(DagLoop.layer.pipe(
              Layer.provide(session),
              Layer.provide(promptLayer(firstQueues)),
              Layer.provide(agent),
            ))),
          )

          expect((yield* storeService.getWorkflow(workflowID))?.wakeReported).toBe(true)
          expect(yield* storeService.getUnreportedWakeWorkflows("ses_parent")).toHaveLength(0)

          const restartedQueues = {
            childPrompts: yield* Queue.unbounded<PromptGate>(),
            parentPrompts: yield* Queue.unbounded<ParentPromptGate>(),
            parentSettled: yield* Queue.unbounded<void>(),
          }
          yield* Effect.scoped(
            Effect.gen(function* () {
              const loopService = yield* DagLoop.Service
              yield* loopService.init()
              // A new DagLoop InstanceState performs the startup sweep over the
              // same durable DB. A reported reminder must not be admitted again.
              yield* TestClock.adjust("1 second")
              expect(Option.isNone(yield* Queue.poll(restartedQueues.parentPrompts))).toBe(true)
            }).pipe(Effect.provide(DagLoop.layer.pipe(
              Layer.provide(session),
              Layer.provide(promptLayer(restartedQueues)),
              Layer.provide(agent),
            ))),
          )
        }).pipe(
          Effect.provide(base),
          Effect.provideService(InstanceRef, {
            directory: process.cwd(),
            worktree: process.cwd(),
            project: {
              id: Project.ID.make("project-1"),
              worktree: AbsolutePath.make(process.cwd()),
              time: { created: 0, updated: 0 },
              sandboxes: [],
            },
          }),
        )
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    )
  })

  // Hold time fixed so pause → resume → pause shares a timestamp. Each pause
  // episode must still project and rearm its reminder.
  integration.effect("acknowledges one paused reminder and rearms only on the next pause episode", () =>
    runWakeTest(({ dag, store, childPrompts }) => Effect.gen(function* () {
      const dagID = yield* dag.create({
        projectID: "project-1", sessionID: "ses_parent", title: "Pause reminder",
        config: { name: "pause-reminder", nodes: [node("work")] },
      })
      yield* takeWithin(childPrompts, "work did not start")
      yield* dag.pause(dagID)
      const firstPause = yield* store.getWorkflow(dagID)
      expect(firstPause?.status).toBe("paused")
      expect(firstPause?.wakeReported).toBe(false)
      yield* store.markWakeBatchReported({ nodes: [], workflows: [firstPause!] })
      expect((yield* store.getWorkflow(dagID))?.wakeReported).toBe(true)
      yield* dag.resume(dagID)
      expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
      yield* dag.pause(dagID)
      expect((yield* store.getWorkflow(dagID))?.wakeReported).toBe(false)
      const secondPause = yield* store.getWorkflow(dagID)
      expect(secondPause?.status).toBe("paused")
      expect(secondPause?.seq).toBeGreaterThan(firstPause!.seq)
      expect(secondPause?.timeUpdated).toBe(firstPause?.timeUpdated)
      yield* dag.cancel(dagID)
    })),
  )

  it("injects a bounded Requirement Brief without raw QA questions", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const brief = {
            goal: "Implement and verify durable deep admission",
            scope: {
              in: ["workflow start", "recovery"],
              out: ["new user interface"],
            },
            constraints: ["standard mode remains compatible"],
            assumptions: ["parent-session questions are available"],
            acceptance_criteria: ["deep work starts only when admitted"],
            evidence_required: ["typecheck", "unit tests"],
            risks: ["stale admission"],
            review_plan: ["verify the implementation diff"],
            open_questions: ["raw QA transcript must not reach child prompts"],
            blocking_questions: [],
          }
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Deep prompt context",
            config: {
              name: "deep-prompt-context",
              mode: "deep",
              admission: {
                protocol_version: 1,
                brief_revision: 1,
                qa_mode: "STANDARD",
                verdict: "READY",
                state: "READY",
                fingerprint: fingerprintBrief(brief),
                brief,
              },
              nodes: [node("implement")],
            },
          })

          const implement = yield* takeWithin(childPrompts, "implement did not start")
          const prompt = promptText(implement.input)
          expect(prompt).toContain("Requirement Brief")
          expect(prompt).toContain("Implement and verify durable deep admission")
          expect(prompt).toContain("standard mode remains compatible")
          expect(prompt).not.toContain("open_questions")
          expect(prompt).not.toContain("raw QA transcript must not reach child prompts")
          yield* Deferred.succeed(implement.release, "Implemented")

          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((workflow) => workflow?.status === "completed" ? workflow : undefined),
            ),
            "deep prompt workflow did not complete",
          )
        }),
      ),
    )
  })

  it("holds queued admissions durably until a permit frees (P0-2)", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Queued admission",
            config: { name: "queued-admission", max_concurrency: 1, nodes: [node("a"), node("b")] },
          })

          const first = yield* takeWithin(childPrompts, "no node acquired the permit")
          // While the permit is held, the other admission stays durably queued
          // with NO child session — the fan-out no longer eagerly creates one
          // session per ready node (P0-2).
          const queued = yield* pollWithTimeout(
            Effect.gen(function* () {
              const nodes = yield* store.getNodes(dagID)
              return nodes.find((n) => n.status === "queued")
            }),
            "second admission did not surface as durably queued",
          )
          expect(queued.childSessionId).toBeNull()
          expect(queued.deadlineMs).not.toBeNull()
          expect((yield* store.getNodes(dagID)).filter((n) => n.status === "running")).toHaveLength(1)

          yield* Deferred.succeed(first.release, "done")
          const second = yield* takeWithin(childPrompts, "queued node did not start after permit release")
          expect(second.title).toBe(queued.id)
          yield* Deferred.succeed(second.release, "done")

          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((workflow) => workflow?.status === "completed" ? workflow : undefined),
            ),
            "queued-admission workflow did not complete",
          )
        }),
      ),
    )
  })

  it("preserves documented template variables inside static template input", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, childPrompts }) =>
        Effect.gen(function* () {
          yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Static template documentation",
            config: {
              name: "static-template-documentation",
              nodes: [
                {
                  ...node("review-guidance"),
                  prompt_template: {
                    inline: "Review this guidance:\n{{guidance}}",
                    input: {
                      guidance: "Workflow examples use {{node-id}} as a documented template variable.",
                    },
                  },
                },
              ],
            },
          })

          const review = yield* takeWithin(childPrompts, "review-guidance did not start")
          expect(promptText(review.input)).toContain(
            "Workflow examples use {{node-id}} as a documented template variable.",
          )
          yield* Deferred.succeed(review.release, "The guidance is clear.")
        }),
      ),
    )
  })

  it("preserves documented template variables inside dependency output", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Documented template variable",
            config: {
              name: "documented-template-variable",
              nodes: [
                node("analyze-security"),
                {
                  ...node("review-security", ["analyze-security"]),
                  prompt_template: { inline: "Review this analysis:\n{{analyze-security}}" },
                },
              ],
            },
          })

          const analyze = yield* takeWithin(childPrompts, "analyze-security did not start")
          yield* Deferred.succeed(
            analyze.release,
            "Workflow examples use {{node-id}} as a documented template variable.",
          )

          const review = yield* takeWithin(childPrompts, "review-security did not start")
          expect(review.title).toBe("review-security")
          expect(promptText(review.input)).toContain(
            "Workflow examples use {{node-id}} as a documented template variable.",
          )
          yield* Deferred.succeed(review.release, "No security issues found.")

          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((workflow) => workflow?.status === "completed" ? workflow : undefined),
            ),
            "workflow did not complete",
          )
        }),
      ),
    )
  })

  it("runs a required fan-in after an optional dependency fails", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, store, childPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Optional review failure",
            config: {
              name: "optional-review-failure",
              nodes: [
                node("analysis"),
                {
                  ...node("review-quality", ["analysis"]),
                  required: false,
                },
                {
                  ...node("review-security", ["analysis"]),
                  required: false,
                  // Well-formed (create accepts it) but unevaluable at spawn:
                  // a numeric comparison on a prose output fails the node.
                  condition: "analysis.output.verdict > 0",
                },
                {
                  ...node("arbitrate", ["review-quality", "review-security"]),
                  prompt_template: {
                    inline: "Quality review: {{review-quality}}\nSecurity review: {{review-security}}",
                  },
                },
              ],
            },
          })

          const analysis = yield* takeWithin(childPrompts, "analysis did not start")
          yield* Deferred.succeed(analysis.release, "The implementation follows the approved design.")

          const quality = yield* takeWithin(childPrompts, "review-quality did not start")
          expect(quality.title).toBe("review-quality")
          yield* Deferred.succeed(quality.release, "No quality issues found.")

          const arbitrate = yield* takeWithin(childPrompts, "arbitrate did not start")
          const text = promptText(arbitrate.input)
          expect(text).toContain("No quality issues found.")
          expect(text).toContain('Dependency "review-security" failed:')
          yield* Deferred.succeed(arbitrate.release, "Proceed with one review unavailable.")

          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((workflow) => workflow?.status === "completed" ? workflow : undefined),
            ),
            "workflow did not complete",
          )
          expect((yield* store.getNode(dagID, "review-security"))?.status).toBe("failed")
          expect((yield* store.getNode(dagID, "review-security"))?.errorClass).toBe("exec_failed")
        }),
      ),
    )
  })

  it("injects direct dependency outputs into an aggregate node by default", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, childPrompts }) =>
        Effect.gen(function* () {
          yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Default aggregate inputs",
            config: {
              name: "default-aggregate-inputs",
              nodes: [
                node("node-a"),
                node("node-b"),
                {
                  ...node("summary", ["node-a", "node-b"]),
                  prompt_template: { inline: "汇总结果：{{node-a}} 和 {{node-b}}" },
                },
              ],
            },
          })

          const first = yield* takeWithin(childPrompts, "first parallel node did not start")
          const second = yield* takeWithin(childPrompts, "second parallel node did not start")
          const roots = new Map([first, second].map((item) => [item.title, item]))
          yield* Deferred.succeed(roots.get("node-a")!.release, "A")
          yield* Deferred.succeed(roots.get("node-b")!.release, "B")

          const summary = yield* takeWithin(childPrompts, "summary node did not start")
          expect(summary.title).toBe("summary")
          expect(promptText(summary.input)).toContain("汇总结果：A 和 B")
          expect(promptText(summary.input)).not.toContain("{{node-a}}")
          expect(promptText(summary.input)).not.toContain("{{node-b}}")
          yield* Deferred.succeed(summary.release, "A and B")
        }),
      ),
    )
  })

  it("keeps long wake output bounded and identifies the durable result target", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Long result retrieval",
            config: { name: "long-result-retrieval", nodes: [node("long-report")] },
          })

          const report = yield* takeWithin(childPrompts, "long-report did not start")
          yield* Deferred.succeed(report.release, `${"a".repeat(1_500)}WAKE_SENTINEL`)
          const parent = yield* takeWithin(parentPrompts, "long report did not wake the parent")
          const wake = promptText(parent.input)

          expect(wake).toContain(`workflow_id="${dagID}"`)
          expect(wake).toContain('node_id="long-report"')
          expect(wake).toContain("truncated=true")
          expect(wake).toContain("workflow result")
          expect(wake).not.toContain("WAKE_SENTINEL")
          expect(wake.length).toBeLessThan(1_500)
          yield* Deferred.succeed(parent.release, "success")
        }),
      ),
    )
  })

  it("marks a short wake preview as complete", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Short result retrieval",
            config: { name: "short-result-retrieval", nodes: [node("short-report")] },
          })

          const report = yield* takeWithin(childPrompts, "short-report did not start")
          yield* Deferred.succeed(report.release, "complete short output")
          const parent = yield* takeWithin(parentPrompts, "short report did not wake the parent")
          const wake = promptText(parent.input)

          expect(wake).toContain(`workflow_id="${dagID}"`)
          expect(wake).toContain('node_id="short-report"')
          expect(wake).toContain("truncated=false")
          expect(wake).toContain("complete short output")
          yield* Deferred.succeed(parent.release, "success")
        }),
      ),
    )
  })

  // issue #388 live path: when a schemaless node's final reply IS one
  // existing absolute file path, submit-time detection records the durable
  // {content_ref, size, sha256, summary} receipt while the settlement carries
  // the managed path. Keep in lockstep with dag-recovery.test.ts
  // "reconcileWorkflow output file refs (issue #388)" — live and recovery
  // must produce identical durable effects for the same reply.
  it("captures a file_ref receipt when a schemaless reply is one absolute path (issue #388)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dag-live-ref-"))
    const reportPath = path.join(dir, "report.md")
    const content = "live report body"
    await fs.writeFile(reportPath, content)
    try {
      await Effect.runPromise(
        runWakeTest(({ dag, store, childPrompts }) =>
          Effect.gen(function* () {
            const dagID = yield* dag.create({
              projectID: "project-1",
              sessionID: "ses_parent",
              title: "File-ref live capture",
              config: { name: "file-ref-live-capture", nodes: [node("file-report")] },
            })

            const report = yield* takeWithin(childPrompts, "file-report did not start")
            yield* Deferred.succeed(report.release, reportPath)
            const row = yield* pollWithTimeout(
              store.getNode(dagID, "file-report").pipe(
                Effect.map((item) => item?.status === "completed" ? item : undefined),
              ),
              "file-ref node did not complete",
            )
            expect(row.output).toEqual(expect.stringContaining("workflow-artifacts"))
            expect(row.capturedOutput).toEqual(expect.objectContaining({
              kind: "file_ref",
              storage: "managed-v1",
              source_path: FSUtil.normalizePath(reportPath),
              content_ref: row.output,
              path: row.output,
              size: Buffer.byteLength(content),
              sha256: createHash("sha256").update(content).digest("hex"),
              summary: content,
            }))
            yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
            expect(yield* Effect.promise(() => fs.readFile(String(row.output), "utf8"))).toBe(content)
          }),
          undefined,
          [
            { permission: "read", pattern: path.relative(process.cwd(), FSUtil.normalizePath(reportPath)), action: "allow" },
            { permission: "external_directory", pattern: FSUtil.normalizePathPattern(path.join(dir, "*")), action: "allow" },
          ],
        ),
      )
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  integration.live("runs an additive wave after a terminal checkpoint wake", () =>
    runWakeTest(({ dag, store, childPrompts, parentPrompts }) =>
      Effect.gen(function* () {
        const dagID = yield* dag.create({
          projectID: "project-1",
          sessionID: "ses_parent",
          title: "Additive checkpoint continuation",
          config: {
            name: "additive-checkpoint-continuation",
            nodes: [node("checkpoint")],
          },
        })

        const checkpoint = yield* takeWithin(childPrompts, "checkpoint did not start")
        yield* Deferred.succeed(checkpoint.release, "REVISE")
        yield* pollWithTimeout(
          store.getWorkflow(dagID).pipe(
            Effect.map((workflow) => workflow?.status === "completed" ? true : undefined),
          ),
          "checkpoint workflow did not complete",
        )

        const parent = yield* takeWithin(parentPrompts, "terminal checkpoint did not wake the parent")
        const result = yield* dag.extend(dagID, [node("repair", ["checkpoint"])])
        expect(result.add).toEqual(["repair"])

        const repair = yield* takeWithin(childPrompts, "additive repair node did not start")
        expect(repair.title).toBe("repair")
        expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
        expect((yield* store.getNode(dagID, "checkpoint"))?.status).toBe("completed")
        yield* Deferred.succeed(parent.release, "success")
        yield* Deferred.succeed(repair.release, "fixed")
        yield* pollWithTimeout(
          store.getWorkflow(dagID).pipe(
            Effect.map((workflow) => workflow?.status === "completed" ? true : undefined),
          ),
          "extended workflow did not complete",
        )
      }),
    ),
  )

  integration.live("reopens a completed workflow whose checkpoint dependents were condition-skipped", () =>
    runWakeTest(({ dag, store, childPrompts, parentPrompts }) =>
      Effect.gen(function* () {
        const dagID = yield* dag.create({
          projectID: "project-1",
          sessionID: "ses_parent",
          title: "Skipped-dependent checkpoint continuation",
          config: {
            name: "skipped-dependent-checkpoint-continuation",
            nodes: [
              node("checkpoint"),
              {
                ...node("downstream", ["checkpoint"]),
                condition: 'checkpoint.output == "GO"',
              },
            ],
          },
        })

        const checkpoint = yield* takeWithin(childPrompts, "checkpoint did not start")
        yield* Deferred.succeed(checkpoint.release, "REVISE")
        yield* waitForCompletion(store, dagID, "checkpoint workflow did not complete")
        expect((yield* store.getNode(dagID, "downstream"))?.status).toBe("skipped")
        expect((yield* store.getNode(dagID, "downstream"))?.errorReason).toBe("condition_false")

        const parent = yield* takeWithin(parentPrompts, "terminal checkpoint did not wake the parent")
        const result = yield* dag.extend(dagID, [node("repair", ["checkpoint"])])
        expect(result.add).toEqual(["repair"])

        const repair = yield* takeWithin(childPrompts, "additive repair node did not start")
        expect(repair.title).toBe("repair")
        expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
        expect((yield* store.getNode(dagID, "checkpoint"))?.status).toBe("completed")
        yield* Deferred.succeed(parent.release, "success")
        yield* Deferred.succeed(repair.release, "fixed")
        yield* waitForCompletion(store, dagID, "extended workflow did not complete")
      }),
    ),
  )

  integration.live("keeps a completed workflow terminal when the graph ran past the checkpoint", () =>
    runWakeTest(({ dag, store, childPrompts }) =>
      Effect.gen(function* () {
        const dagID = yield* dag.create({
          projectID: "project-1",
          sessionID: "ses_parent",
          title: "Post-checkpoint completion",
          config: {
            name: "post-checkpoint-completion",
            nodes: [node("checkpoint"), { ...node("downstream", ["checkpoint"]), report_to_parent: false }],
          },
        })

        const checkpoint = yield* takeWithin(childPrompts, "checkpoint did not start")
        yield* Deferred.succeed(checkpoint.release, "CHECK")
        const downstream = yield* takeWithin(childPrompts, "downstream did not start")
        yield* Deferred.succeed(downstream.release, "done")
        yield* waitForCompletion(store, dagID, "workflow did not complete")

        const error = yield* dag.extend(dagID, [node("repair", ["checkpoint"])]).pipe(
          Effect.catch((cause: Error) => Effect.succeed(cause)),
        )
        if (!(error instanceof TerminalViolationError)) throw new Error("extend unexpectedly succeeded past a terminal checkpoint")
        expect(error.message).toContain("continued past the checkpoint")
      }),
    ),
  )

  integration.live("keeps an early-completed workflow terminal", () =>
    runWakeTest(({ dag, store, childPrompts }) =>
      Effect.gen(function* () {
        const dagID = yield* dag.create({
          projectID: "project-1",
          sessionID: "ses_parent",
          title: "Early completion",
          config: {
            name: "early-completion",
            nodes: [node("checkpoint"), node("later", ["checkpoint"])],
          },
        })

        yield* takeWithin(childPrompts, "checkpoint did not start")
        yield* dag.complete(dagID)
        yield* pollWithTimeout(
          store.getWorkflow(dagID).pipe(
            Effect.map((workflow) => workflow?.status === "completed" ? true : undefined),
          ),
          "workflow did not early-complete",
        )
        expect((yield* store.getNode(dagID, "later"))?.errorReason).toBe("agent_complete")
        expect((yield* store.getNode(dagID, "checkpoint"))?.status).toBe("aborted")
        expect((yield* store.getNode(dagID, "later"))?.status).toBe("skipped")

        const error = yield* dag.extend(dagID, [node("repair", ["checkpoint"])]).pipe(
          Effect.catch((cause: Error) => Effect.succeed(cause)),
        )
        expect(error).toBeInstanceOf(TerminalViolationError)
      }),
    ),
  )

  integration.live("rejects early completion while a deep diff review is unresolved", () =>
    runWakeTest(({ dag, store, childPrompts }) =>
      Effect.gen(function* () {
        const brief = {
          goal: "Keep explicit completion behind the deep review gate",
          scope: { in: ["DAG completion"], out: ["standard workflow semantics"] },
          constraints: ["review rejection cannot become success"],
          assumptions: ["the review graph is valid"],
          acceptance_criteria: ["complete rejects unresolved reviews"],
          evidence_required: ["integration test"],
          risks: ["manual completion bypass"],
          review_plan: ["verify the final ACCEPT gate"],
          open_questions: [],
          blocking_questions: [],
        }
        const dagID = yield* dag.create({
          projectID: "project-1",
          sessionID: "ses_parent",
          title: "Deep early completion",
          config: {
            name: "deep-early-completion",
            mode: "deep",
            admission: {
              protocol_version: 1,
              brief_revision: 1,
              qa_mode: "STANDARD",
              verdict: "READY",
              state: "READY",
              fingerprint: fingerprintBrief(brief),
              brief,
            },
            nodes: [
              {
                ...node("implement"),
                output_schema: {
                  type: "object",
                  properties: {
                    diff: { type: "string" },
                    fingerprint: { type: "string" },
                  },
                  required: ["diff", "fingerprint"],
                },
              },
              {
                ...node("verify", ["implement"]),
                output_schema: {
                  type: "object",
                  properties: { verdict: { enum: ["PASS", "FAIL"] } },
                  required: ["verdict"],
                },
              },
              {
                ...node("review-diff", ["verify"]),
                worker_type: "review",
                review: {
                  phase: "diff",
                  implementation_node_id: "implement",
                  verification_node_id: "verify",
                },
                input_mapping: {
                  diff: "implement.output.diff",
                  implementation_fingerprint: "implement.output.fingerprint",
                  verification: "verify.output",
                },
                condition: 'verify.output.verdict == "PASS"',
                output_schema: {
                  type: "object",
                  properties: {
                    verdict: { enum: ["ACCEPT", "REJECT"] },
                    implementation_fingerprint: { type: "string" },
                  },
                  required: ["verdict", "implementation_fingerprint"],
                },
              },
              {
                ...node("final-audit", ["review-diff"]),
                worker_type: "audit",
                input_mapping: { review: "review-diff.output" },
                condition: 'review-diff.output.verdict == "ACCEPT"',
              },
            ],
          },
        })

        yield* takeWithin(childPrompts, "implementation did not start")
        const completion = yield* dag.complete(dagID).pipe(
          Effect.as(undefined),
          Effect.catch((error) => Effect.succeed(error)),
        )
        expect(completion).toBeInstanceOf(Error)
        if (!(completion instanceof Error)) throw new Error("deep completion unexpectedly succeeded")
        expect(completion.message).toContain("unresolved review outcome")
        // Issue #305: the gate message must not claim a mode it does not check.
        expect(completion.message).not.toContain("deep workflow")
        expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
        expect((yield* store.getNode(dagID, "review-diff"))?.status).toBe("pending")
      }),
    ),
  )

  integration.live("keeps a completed non-reporting leaf workflow terminal", () =>
    runWakeTest(({ dag, store, childPrompts }) =>
      Effect.gen(function* () {
        const dagID = yield* dag.create({
          projectID: "project-1",
          sessionID: "ses_parent",
          title: "Non-reporting completion",
          config: {
            name: "non-reporting-completion",
            nodes: [{ ...node("leaf"), report_to_parent: false }],
          },
        })

        const leaf = yield* takeWithin(childPrompts, "leaf did not start")
        yield* Deferred.succeed(leaf.release, "done")
        yield* pollWithTimeout(
          store.getWorkflow(dagID).pipe(
            Effect.map((workflow) => workflow?.status === "completed" ? true : undefined),
          ),
          "non-reporting workflow did not complete",
        )
        expect((yield* store.getNode(dagID, "leaf"))?.wakeEligible).toBe(false)

        const error = yield* dag.extend(dagID, [node("extra", ["leaf"])]).pipe(
          Effect.catch((cause: Error) => Effect.succeed(cause)),
        )
        expect(error).toBeInstanceOf(TerminalViolationError)
      }),
    ),
  )

  it("rejects an unbound inline placeholder at acceptance instead of spawning a doomed node", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, childPrompts }) =>
        Effect.gen(function* () {
          // Pre-fix this graph was created and the summary node died at spawn
          // (verdict_fail: Unresolved template placeholders). Acceptance-time
          // binding validation now rejects it before any node can spawn — the
          // "Added, then spawn-dead" silent window is gone.
          const createError = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Unresolved aggregate input",
            config: {
              name: "unresolved-aggregate-input",
              nodes: [
                node("node-a"),
                {
                  ...node("summary", ["node-a"]),
                  input_mapping: {},
                  prompt_template: { inline: "汇总结果：{{node-a}}" },
                },
              ],
            },
          }).pipe(Effect.catch((cause: Error) => Effect.succeed(cause.message)))
          expect(createError).toContain('unbound variable "{{node-a}}"')
          expect(yield* Queue.poll(childPrompts)).toEqual(Option.none())
        }),
      ),
    )
  })

  it("fails an id-template node at spawn and wakes the parent when placeholders remain unresolved", async () => {
    // Acceptance-time binding validation only covers inline templates; id
    // templates are read lazily from disk, so the spawn-time guard (and its
    // failure wake) stays live for them. Exercise that path with a real
    // template file carrying an unbound placeholder.
    const templateDir = path.join(process.cwd(), ".opencode", "dag-prompts")
    const templateFile = path.join(templateDir, "wake-unbound-fixture.md")
    await fs.mkdir(templateDir, { recursive: true })
    await fs.writeFile(templateFile, "汇总结果：{{never-bound}}")
    try {
      await Effect.runPromise(
        runWakeTest(({ dag, store, childPrompts, parentPrompts }) =>
          Effect.gen(function* () {
            const dagID = yield* dag.create({
              projectID: "project-1",
              sessionID: "ses_parent",
              title: "Unresolved aggregate input",
              config: {
                name: "unresolved-aggregate-input",
                nodes: [
                  node("node-a"),
                  {
                    ...node("summary", ["node-a"]),
                    input_mapping: {},
                    prompt_template: { id: "wake-unbound-fixture" },
                  },
                ],
              },
            })

            const root = yield* takeWithin(childPrompts, "root node did not start")
            yield* Deferred.succeed(root.release, "A")

            yield* pollWithTimeout(
              store.getNode(dagID, "summary").pipe(
                Effect.map((item) => item?.status === "failed" ? item : undefined),
              ),
              "summary node did not fail",
            )
            const summary = yield* store.getNode(dagID, "summary")
            expect(summary?.errorReason).toContain("Unresolved template placeholders")
            expect(summary?.errorClass).toBe("verdict_fail")
            const parent = yield* takeWithin(parentPrompts, "workflow failure did not wake the parent")
            const wakeText = promptText(parent.input)
            expect(wakeText).toContain('[DAG Workflow failed] Workflow "Unresolved aggregate input" has reached terminal status.')
            expect(wakeText).toContain('Failed nodes:\n- "summary" (verdict_fail):')
            yield* Deferred.succeed(parent.release, "success")
            expect(yield* Queue.poll(childPrompts)).toEqual(Option.none())
          }),
        ),
      )
    } finally {
      await fs.rm(templateFile, { force: true })
    }
  })

  it("does not block a second workflow's downstream scheduling on a parent wake", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Wake source",
            config: { name: "wake-source", nodes: [node("wake-source")] },
          })
          yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Independent pipeline",
            config: { name: "pipeline", nodes: [node("root"), node("downstream", ["root"])] },
          })

          const first = yield* takeWithin(childPrompts, "first root node did not start")
          const second = yield* takeWithin(childPrompts, `second root node did not start after ${first.title}`)
          const prompts = new Map([first, second].map((item) => [item.title, item]))
          yield* Deferred.succeed(prompts.get("wake-source")!.release, "wake result")

          const parent = yield* takeWithin(parentPrompts, "terminal workflow did not trigger a parent wake")
          yield* Deferred.succeed(prompts.get("root")!.release, "root result")

          const downstream = yield* takeWithin(
            childPrompts,
            "downstream scheduling waited for the blocked parent wake",
          )
          expect(downstream.title).toBe("downstream")

          yield* Deferred.succeed(parent.release, "success")
          yield* Deferred.succeed(downstream.release, "done")
        }),
      ),
    )
  })

  it("batches parallel results and the terminal workflow into one deterministic prompt", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Parallel batch",
            config: {
              name: "parallel-batch",
              nodes: [node("a"), node("b"), node("aggregate", ["a", "b"])],
            },
          })

          const first = yield* takeWithin(childPrompts, "first parallel node did not start")
          const second = yield* takeWithin(childPrompts, "second parallel node did not start")
          const parallel = new Map([first, second].map((item) => [item.title, item]))
          yield* Deferred.succeed(parallel.get("a")!.release, "A")
          yield* Deferred.succeed(parallel.get("b")!.release, "B")

          const aggregate = yield* takeWithin(
            childPrompts,
            "aggregate scheduling waited for an intermediate parent wake",
          )
          expect(aggregate.title).toBe("aggregate")
          expect(Option.isNone(yield* Queue.poll(parentPrompts))).toBe(true)
          yield* Deferred.succeed(aggregate.release, "AB")

          const parent = yield* takeWithin(parentPrompts, "terminal batch did not wake the parent")
          const text = promptText(parent.input)
          expect(text).toContain('Node "a" completed: A')
          expect(text).toContain('Node "b" completed: B')
          expect(text).toContain('Node "aggregate" completed: AB')
          expect(text).toContain('Workflow "Parallel batch" has reached terminal status')
          expect(text).not.toContain("Act on these workflows")
          expect(text.indexOf('Node "a"')).toBeLessThan(text.indexOf('Node "b"'))
          expect(text.indexOf('Node "b"')).toBeLessThan(text.indexOf('Node "aggregate"'))
          yield* Deferred.succeed(parent.release, "success")
        }),
      ),
    )
  })

  it("keeps rows committed during delivery for a later stable batch", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "First workflow",
            config: { name: "first", nodes: [node("first-node")] },
          })
          const firstNode = yield* takeWithin(childPrompts, "first workflow did not start")
          yield* Deferred.succeed(firstNode.release, "first")
          const firstParent = yield* takeWithin(parentPrompts, "first workflow did not wake the parent")

          yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Late workflow",
            config: { name: "late", nodes: [node("late-node")] },
          })
          const lateNode = yield* takeWithin(childPrompts, "late workflow did not start")
          yield* Deferred.succeed(lateNode.release, "late")
          expect(promptText(firstParent.input)).not.toContain("late-node")

          yield* Deferred.succeed(firstParent.release, "success")
          const secondParent = yield* takeWithin(parentPrompts, "late result was not delivered in a later batch")
          expect(promptText(secondParent.input)).toContain('Node "late-node" completed: late')
          yield* Deferred.succeed(secondParent.release, "success")
        }),
      ),
    )
  })

  // FLIPPED for issue #321: previously a failed parent turn left the whole
  // batch unreported (for later redelivery). Admit success now IS the
  // delivery — the mark lands at admit time, so a failed/interrupted turn
  // still leaves the batch reported.
  it("reports the wake batch at admit time even when the parent turn then fails (issue #321)", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, store, childPrompts, parentPrompts, parentSettled }) =>
        Effect.gen(function* () {
          yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Retryable workflow",
            config: { name: "retryable", nodes: [node("retryable-node")] },
          })
          const child = yield* takeWithin(childPrompts, "retryable node did not start")
          yield* Deferred.succeed(child.release, "retry me")
          const parent = yield* takeWithin(parentPrompts, "retryable batch did not wake the parent")
          yield* Deferred.succeed(parent.release, "failure")
          yield* takeWithin(parentSettled, "failed parent prompt did not settle")

          // The synthetic part is durable in transcript either way; marking at
          // admit time means a restart or mid-turn interruption has nothing to
          // re-inject.
          expect(yield* store.getUnreportedWakeNodes("ses_parent")).toHaveLength(0)
          expect(yield* store.getUnreportedWakeWorkflows("ses_parent")).toHaveLength(0)
        }),
      ),
    )
  })

  // FLIPPED for issue #321: previously a failed parent turn was retried — a
  // fresh idle event re-injected the SAME wake. Admit success is now the
  // delivery, so a later trigger must inject NO duplicate prompt.
  it("does not redeliver a wake whose parent turn failed (issue #321)", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, store, status, childPrompts, parentPrompts, parentSettled }) =>
        Effect.gen(function* () {
          yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Retryable workflow",
            config: { name: "retryable", nodes: [node("retryable-node")] },
          })
          const child = yield* takeWithin(childPrompts, "retryable node did not start")
          yield* Deferred.succeed(child.release, "retry me")
          const first = yield* takeWithin(parentPrompts, "retryable batch did not wake the parent")
          yield* Deferred.succeed(first.release, "failure")
          yield* takeWithin(parentSettled, "failed parent prompt did not settle")

          // The batch is reported at admit time even though the turn failed.
          expect(yield* store.getUnreportedWakeNodes("ses_parent")).toHaveLength(0)
          expect(yield* store.getUnreportedWakeWorkflows("ses_parent")).toHaveLength(0)

          // Re-trigger the delivery path: the idle gate must NOT inject a
          // duplicate prompt (pre-fix this re-delivered the identical wake).
          yield* status.set(SessionID.make("ses_parent"), { type: "idle" })
          yield* Effect.sleep("500 millis")
          expect(Option.isNone(yield* Queue.poll(parentPrompts))).toBe(true)
        }),
      ),
    )
  })

  it("redelivers an unreported durable batch during startup", async () => {
    await Effect.runPromise(
      runWakeTest(
        ({ parentPrompts }) =>
          Effect.gen(function* () {
            const parent = yield* takeWithin(parentPrompts, "startup scan did not redeliver the durable batch")
            const text = promptText(parent.input)
            expect(text).toContain('Node "recovered-node" completed: recovered')
            expect(text).toContain('Workflow "Recovered workflow" has reached terminal status')
            yield* Deferred.succeed(parent.release, "success")
          }),
        ({ database }) =>
          database.db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert(WorkflowTable).values({
                id: "recovered-workflow",
                project_id: "project-1" as never,
                session_id: "ses_parent" as never,
                directory: process.cwd(),
                title: "Recovered workflow",
                status: "completed",
                config: "{}",
                seq: 10,
                wake_reported: false,
              }).run()
              yield* tx.insert(WorkflowNodeTable).values({
                id: "recovered-node",
                workflow_id: "recovered-workflow",
                name: "recovered-node",
                worker_type: "build",
                status: "completed",
                required: true,
                depends_on: [],
                output: "recovered",
                wake_eligible: true,
                wake_reported: false,
                seq: 9,
              }).run()
            }),
          ).pipe(Effect.orDie),
      ),
    )
  })

  // NEW for issue #321: simulates the production restart. A wake is admitted
  // but its parent turn NEVER finishes (the process dies mid-turn). Pre-fix the
  // mark only landed after the turn completed, so the restart sweep saw
  // wake_reported=false and re-injected the byte-identical wake. Post-fix the
  // mark lands at admit time, so a fresh loop's startup sweep delivers nothing.
  it("does not redeliver an already-admitted wake across a restart (issue #321)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const childTitles = new Map<string, string>()
        const created: string[] = []
        const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
          get: () =>
            Effect.succeed({
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
        })
        const deliver = (queues: {
          readonly childPrompts: Queue.Queue<PromptGate>
          readonly parentPrompts: Queue.Queue<ParentPromptGate>
          readonly parentSettled: Queue.Queue<void>
        }) =>
          Effect.fn("test.SessionPrompt.deliver")(function* (value: SessionPrompt.PromptInput) {
            const sessionID = value.sessionID as string
            if (sessionID === "ses_parent") {
              const release = yield* Deferred.make<"success" | "failure">()
              yield* Queue.offer(queues.parentPrompts, { input: value, release })
              const outcome = yield* Deferred.await(release).pipe(
                Effect.ensuring(Queue.offer(queues.parentSettled, undefined)),
              )
              if (outcome === "failure") return yield* Effect.die(new Error("provider unavailable"))
              return reply(sessionID, "parent handled wake")
            }
            const release = yield* Deferred.make<string>()
            yield* Queue.offer(queues.childPrompts, {
              title: childTitles.get(sessionID) ?? sessionID,
              input: value,
              release,
            })
            return reply(sessionID, yield* Deferred.await(release))
          })
        const promptLayer = (queues: {
          readonly childPrompts: Queue.Queue<PromptGate>
          readonly parentPrompts: Queue.Queue<ParentPromptGate>
          readonly parentSettled: Queue.Queue<void>
        }) => Layer.mock(SessionPrompt.Service, withIdleAdmission({
          cancel: () => Effect.void,
          prompt: deliver(queues),
          promptIfIdle: (value) => deliver(queues)(value).pipe(Effect.map(Option.some)),
        }))

        const database = Database.layerFromPath(":memory:")
        const events = EventV2.layer.pipe(Layer.provide(database))
        const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
        const store = DagStore.layer.pipe(Layer.provide(database))
        const status = SessionStatus.layer.pipe(Layer.provide(bridge))
        const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
        const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
        const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status)

        yield* Effect.gen(function* () {
          const storeSvc = yield* DagStore.Service
          const databaseSvc = yield* Database.Service
          yield* databaseSvc.db.insert(ProjectTable).values({
            id: Project.ID.make("project-1"),
            worktree: AbsolutePath.make(process.cwd()),
            sandboxes: [],
          }).run().pipe(Effect.orDie)
          yield* databaseSvc.db.insert(SessionTable).values({
            id: SessionID.make("ses_parent"),
            project_id: Project.ID.make("project-1"),
            slug: "parent",
            directory: AbsolutePath.make(process.cwd()),
            title: "Parent",
            version: "test",
          }).run().pipe(Effect.orDie)

          // Phase 1: admit the wake, then "die" before the parent turn finishes.
          const q1 = {
            childPrompts: yield* Queue.unbounded<PromptGate>(),
            parentPrompts: yield* Queue.unbounded<ParentPromptGate>(),
            parentSettled: yield* Queue.unbounded<void>(),
          }
          yield* Effect.scoped(
            Effect.gen(function* () {
              const dagSvc = yield* Dag.Service
              const loopSvc = yield* DagLoop.Service
              yield* loopSvc.init()
              yield* dagSvc.create({
                projectID: "project-1",
                sessionID: "ses_parent",
                title: "Restart wake",
                config: { name: "restart-wake", result_protocol: "submit_result", nodes: [node("restart-node")] },
              })
              const child = yield* takeWithin(q1.childPrompts, "restart node did not start")
              yield* Deferred.succeed(child.release, "done")
              // The wake was admitted (mark landed at admit). Do NOT release the
              // parent turn — disposing the scope simulates a restart mid-turn.
              yield* takeWithin(q1.parentPrompts, "terminal workflow did not wake the parent")
            }).pipe(Effect.provide(DagLoop.layer.pipe(
              Layer.provide(session),
              Layer.provide(promptLayer(q1)),
              Layer.provide(agent),
            ))),
          )

          // The durable rows are already reported even though the turn never ran.
          expect(yield* storeSvc.getUnreportedWakeNodes("ses_parent")).toHaveLength(0)
          expect(yield* storeSvc.getUnreportedWakeWorkflows("ses_parent")).toHaveLength(0)
          expect(yield* storeSvc.getSessionsWithUnreportedWakes()).toHaveLength(0)

          // Phase 2: a fresh loop over the SAME store runs the startup sweep.
          const q2 = {
            childPrompts: yield* Queue.unbounded<PromptGate>(),
            parentPrompts: yield* Queue.unbounded<ParentPromptGate>(),
            parentSettled: yield* Queue.unbounded<void>(),
          }
          yield* Effect.scoped(
            Effect.gen(function* () {
              const loopSvc = yield* DagLoop.Service
              yield* loopSvc.init()
              // Bound the window in which a (now-forbidden) redelivery could appear.
              yield* Effect.sleep("500 millis")
              expect(Option.isNone(yield* Queue.poll(q2.parentPrompts))).toBe(true)
            }).pipe(Effect.provide(DagLoop.layer.pipe(
              Layer.provide(session),
              Layer.provide(promptLayer(q2)),
              Layer.provide(agent),
            ))),
          )
        }).pipe(
          Effect.provide(base),
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
        )
      }).pipe(Effect.scoped),
    )
  })

  it("keeps a wake unreported while the parent is busy and delivers it on idle", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, store, status, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          yield* status.set("ses_parent" as never, { type: "busy" })
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Busy parent",
            config: { name: "busy-parent", nodes: [node("busy-node")] },
          })
          const child = yield* takeWithin(childPrompts, "busy-parent node did not start")
          yield* Deferred.succeed(child.release, "held result")
          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((workflow) => workflow?.status === "completed" ? true as const : undefined),
            ),
            "workflow did not complete while its parent was busy",
          )

          expect(Option.isNone(yield* Queue.poll(parentPrompts))).toBe(true)
          expect(yield* store.getUnreportedWakeNodes("ses_parent")).toHaveLength(1)
          expect(yield* store.getUnreportedWakeWorkflows("ses_parent")).toHaveLength(1)

          yield* status.set("ses_parent" as never, { type: "idle" })
          const parent = yield* takeWithin(parentPrompts, "idle transition did not deliver the retained batch")
          expect(promptText(parent.input)).toContain('Node "busy-node" completed: held result')
          yield* Deferred.succeed(parent.release, "success")
        }),
      ),
    )
  })

  it("recovers after a false conditional branch and eventually wakes the parent", async () => {
    await Effect.runPromise(
      runWakeTest(
        ({ store, childPrompts, parentPrompts }) =>
          Effect.gen(function* () {
            const responder = yield* Effect.forever(
              Queue.take(childPrompts).pipe(
                Effect.flatMap((prompt) => Deferred.succeed(prompt.release, "done")),
              ),
            ).pipe(Effect.forkChild)

            const parent = yield* takeWithin(
              parentPrompts,
              "parent agent did not receive the durable DAG status after recovery",
            )
            expect(
              (yield* store.getNode("dag_recovered_conditional", "conditional"))?.status,
            ).toBe("skipped")
            // D13: after-conditional depends only on the skipped conditional
            // node, so it cascade-skips instead of running on a placeholder
            // input — the gate rejection blocks the whole downstream subtree.
            const afterConditional = yield* store.getNode("dag_recovered_conditional", "after-conditional")
            expect(afterConditional?.status).toBe("skipped")
            expect(afterConditional?.errorReason).toBe("orphan_cascade")
            expect(promptText(parent.input)).toContain(
              'Node "quality-gate" completed: REJECT',
            )
            expect(promptText(parent.input)).toContain(
              'Workflow "Recovered conditional workflow" has reached terminal status',
            )
            yield* Deferred.succeed(parent.release, "success")
            yield* Fiber.interrupt(responder)
          }),
        ({ database }) =>
          database.db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert(WorkflowTable).values({
                id: "dag_recovered_conditional",
                project_id: "project-1" as never,
                session_id: "ses_parent" as never,
                directory: process.cwd(),
                title: "Recovered conditional workflow",
                status: "running",
                config: JSON.stringify({
                  name: "dag_recovered_conditional",
                  nodes: [
                    node("quality-gate"),
                    {
                      ...node("conditional", ["quality-gate"]),
                      report_to_parent: false,
                      condition: 'quality-gate.output.verdict == "ACCEPT"',
                    },
                    {
                      ...node("after-conditional", ["conditional"]),
                      report_to_parent: false,
                    },
                  ],
                }),
                seq: 6,
                wake_reported: false,
              }).run()
              yield* tx.insert(WorkflowNodeTable).values([
                {
                  id: "quality-gate",
                  workflow_id: "dag_recovered_conditional",
                  name: "quality-gate",
                  worker_type: "build",
                  status: "completed",
                  required: true,
                  depends_on: [],
                  output: "REJECT",
                  wake_eligible: true,
                  wake_reported: false,
                  seq: 4,
                },
                {
                  id: "conditional",
                  workflow_id: "dag_recovered_conditional",
                  name: "conditional",
                  worker_type: "build",
                  status: "pending",
                  required: true,
                  depends_on: ["quality-gate"],
                  wake_eligible: false,
                  wake_reported: false,
                  seq: 2,
                },
                {
                  id: "after-conditional",
                  workflow_id: "dag_recovered_conditional",
                  name: "after-conditional",
                  worker_type: "build",
                  status: "pending",
                  required: true,
                  depends_on: ["conditional"],
                  wake_eligible: false,
                  wake_reported: false,
                  seq: 1,
                },
              ]).run()
            }),
          ).pipe(Effect.orDie),
      ),
    )
  })

  // Issue #294: a workflow whose verification skips every diff review settles
  // as COMPLETED at the checkpoint (not failed) so the parent can dispose of
  // the unresolved review verdict via reopen-extend; failed stays immutable.
  it.each(["deep", "standard"] as const)("completes a recovered %s workflow when verification skips every diff review", async (mode) => {
    await Effect.runPromise(
      runWakeTest(
        ({ store, parentPrompts }) =>
          Effect.gen(function* () {
            const workflow = yield* pollWithTimeout(
              store.getWorkflow("dag_recovered_review_rejection").pipe(
                Effect.map((row) => row && ["completed", "failed"].includes(row.status) ? row : undefined),
              ),
              "recovered workflow without an accepted review did not settle",
            )
            expect(workflow.status).toBe("completed")
            expect((yield* store.getNode(workflow.id, "review-diff"))?.status).toBe("skipped")
            expect((yield* store.getNode(workflow.id, "final-audit"))?.status).toBe("skipped")

            const parent = yield* takeWithin(parentPrompts, "review rejection completion did not wake the parent")
            expect(promptText(parent.input)).toContain(
              '[DAG Workflow completed] Workflow "Recovered review rejection" has reached terminal status.',
            )
            yield* Deferred.succeed(parent.release, "success")
          }),
        ({ database }) =>
          database.db.transaction((tx) =>
            Effect.gen(function* () {
              const nodes = [
                {
                  ...node("implement"),
                  output_schema: {
                    type: "object",
                    properties: {
                      diff: { type: "string" },
                      fingerprint: { type: "string" },
                    },
                    required: ["diff", "fingerprint"],
                  },
                },
                {
                  ...node("verify", ["implement"]),
                  output_schema: {
                    type: "object",
                    properties: { verdict: { enum: ["PASS", "FAIL"] } },
                    required: ["verdict"],
                  },
                },
                {
                  ...node("review-diff", ["verify"]),
                  worker_type: "review",
                  review: {
                    phase: "diff" as const,
                    implementation_node_id: "implement",
                    verification_node_id: "verify",
                  },
                  input_mapping: {
                    diff: "implement.output.diff",
                    implementation_fingerprint: "implement.output.fingerprint",
                    verification: "verify.output",
                  },
                  condition: 'verify.output.verdict == "PASS"',
                  output_schema: {
                    type: "object",
                    properties: {
                      verdict: { enum: ["ACCEPT", "REJECT"] },
                      implementation_fingerprint: { type: "string" },
                    },
                    required: ["verdict", "implementation_fingerprint"],
                  },
                },
                {
                  ...node("final-audit", ["review-diff"]),
                  worker_type: "audit",
                  input_mapping: { review: "review-diff.output" },
                  condition: 'review-diff.output.verdict == "ACCEPT"',
                },
              ]
              yield* tx.insert(WorkflowTable).values({
                id: "dag_recovered_review_rejection",
                project_id: "project-1" as never,
                session_id: "ses_parent" as never,
                directory: process.cwd(),
                title: "Recovered review rejection",
                status: "running",
                config: JSON.stringify({
                  name: "dag_recovered_review_rejection",
                  mode,
                  nodes,
                }),
                seq: 10,
                wake_reported: false,
              }).run()
              yield* tx.insert(WorkflowNodeTable).values([
                {
                  id: "implement",
                  workflow_id: "dag_recovered_review_rejection",
                  name: "implement",
                  worker_type: "build",
                  status: "completed",
                  required: true,
                  depends_on: [],
                  output: { diff: "diff --git a/a b/a", fingerprint: "fp-1" },
                  wake_eligible: false,
                  wake_reported: true,
                  seq: 6,
                },
                {
                  id: "verify",
                  workflow_id: "dag_recovered_review_rejection",
                  name: "verify",
                  worker_type: "build",
                  status: "completed",
                  required: true,
                  depends_on: ["implement"],
                  output: { verdict: "FAIL" },
                  wake_eligible: false,
                  wake_reported: true,
                  seq: 5,
                },
                {
                  id: "review-diff",
                  workflow_id: "dag_recovered_review_rejection",
                  name: "review-diff",
                  worker_type: "review",
                  status: "pending",
                  required: true,
                  depends_on: ["verify"],
                  wake_eligible: false,
                  wake_reported: false,
                  seq: 4,
                },
                {
                  id: "final-audit",
                  workflow_id: "dag_recovered_review_rejection",
                  name: "final-audit",
                  worker_type: "audit",
                  status: "pending",
                  required: true,
                  depends_on: ["review-diff"],
                  wake_eligible: false,
                  wake_reported: false,
                  seq: 3,
                },
              ]).run()
            }),
          ).pipe(Effect.orDie),
      ),
    )
  })

  it("wakes at paused and stepping decision boundaries", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, store, childPrompts, parentPrompts, parentSettled }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Controlled workflow",
            config: {
              name: "controlled",
              nodes: [node("root"), node("next", ["root"]), node("after", ["next"])],
            },
          })
          const root = yield* takeWithin(childPrompts, "controlled root did not start")
          yield* dag.pause(dagID)
          yield* Deferred.succeed(root.release, "checkpoint")

          const paused = yield* takeWithin(parentPrompts, "paused boundary did not wake the parent")
          expect(promptText(paused.input)).toContain('Node "root" completed: checkpoint')
          yield* Deferred.succeed(paused.release, "success")
          yield* takeWithin(parentSettled, "paused parent prompt did not settle")

          yield* dag.resume(dagID)
          expect(yield* dag.step(dagID)).toEqual({ status: "stepping", nodeID: "next" })
          const next = yield* takeWithin(childPrompts, "stepping boundary did not start the selected node")
          yield* Deferred.succeed(next.release, "stepped")
          const stepped = yield* takeWithin(parentPrompts, "stepping boundary did not wake the parent")
          expect(promptText(stepped.input)).toContain('Node "next" completed: stepped')
          yield* Deferred.succeed(stepped.release, "success")
          yield* takeWithin(parentSettled, "stepping parent prompt did not settle")

          expect((yield* store.getWorkflow(dagID))?.status).toBe("stepping")
          expect((yield* store.getNode(dagID, "after"))?.status).toBe("pending")
        }),
      ),
    )
  })

  it("cascade-skips the whole downstream subtree when a condition gate rejects", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, store, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "Gated pipeline",
            config: {
              name: "gated-pipeline",
              nodes: [
                node("quality-gate"),
                {
                  ...node("implement", ["quality-gate"]),
                  report_to_parent: false,
                  condition: 'quality-gate.output.verdict == "ACCEPT"',
                },
                { ...node("integrate", ["implement"]), report_to_parent: false },
                { ...node("final-audit", ["integrate"]), report_to_parent: false },
              ],
            },
          })

          const gate = yield* takeWithin(childPrompts, "quality-gate did not start")
          yield* Deferred.succeed(gate.release, "REJECT")

          // D13 regression: the gate rejection must terminalize the whole
          // subtree without executing it — implement skips on condition_false
          // and integrate / final-audit cascade-skip because their only
          // dependency is skipped. Pre-fix, skip ≡ satisfied ran the full
          // chain and the audit "passed" a rejected gate.
          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((workflow) => workflow?.status === "completed" ? workflow : undefined),
            ),
            "gated workflow did not complete after the gate rejection",
          )
          const implement = yield* store.getNode(dagID, "implement")
          expect(implement?.status).toBe("skipped")
          expect(implement?.errorReason).toBe("condition_false")
          const integrate = yield* store.getNode(dagID, "integrate")
          expect(integrate?.status).toBe("skipped")
          expect(integrate?.errorReason).toBe("orphan_cascade")
          const audit = yield* store.getNode(dagID, "final-audit")
          expect(audit?.status).toBe("skipped")
          expect(audit?.errorReason).toBe("orphan_cascade")
          // No downstream child session was ever spawned.
          expect(Option.isNone(yield* Queue.poll(childPrompts))).toBe(true)

          const parent = yield* takeWithin(parentPrompts, "gate wake did not reach the parent")
          expect(promptText(parent.input)).toContain('Node "quality-gate" completed: REJECT')
          yield* Deferred.succeed(parent.release, "success")
        }),
      ),
    )
  })

  it("does not misfire orchestrator_unresponsive while downstream work spawns after a completion", async () => {
    await Effect.runPromise(
      runWakeTest(({ dag, store, status, childPrompts, parentPrompts }) =>
        Effect.gen(function* () {
          const dagID = yield* dag.create({
            projectID: "project-1",
            sessionID: "ses_parent",
            title: "No unresponsive misfire",
            config: { name: "no-unresponsive-misfire", nodes: [node("a"), node("b", ["a"])] },
          })
          const a = yield* takeWithin(childPrompts, "a did not start")
          yield* Deferred.succeed(a.release, "A done")
          // Extra wake trigger racing b's spawn: the unresponsive check reads
          // its five conditions under the entry's evalLock, so it sees either
          // the pre-spawn ready set or the post-spawn fiber ownership — never
          // the torn markRunning→fibers.set middle that used to read as a
          // stalled orchestrator.
          yield* status.set("ses_parent" as never, { type: "idle" })
          const b = yield* takeWithin(childPrompts, "b did not start after a completed")
          yield* Effect.sleep("100 millis")
          expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
          yield* Deferred.succeed(b.release, "B done")
          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(
              Effect.map((workflow) => workflow?.status === "completed" ? workflow : undefined),
            ),
            "workflow did not complete",
          )
          const parent = yield* takeWithin(parentPrompts, "terminal wake did not reach the parent")
          yield* Deferred.succeed(parent.release, "success")
        }),
      ),
    )
  })

  it("parks a running timeout escalation after WorkflowTool rejects a replan and permits a corrected replan", async () => {
    const invalidPath = path.join(process.cwd(), `.dag-invalid-replan-${randomUUID()}.yaml`)
    const correctedPath = path.join(process.cwd(), `.dag-corrected-replan-${randomUUID()}.yaml`)
    await fs.writeFile(invalidPath, JSON.stringify({ nodes: [node("repair")] }))
    await fs.writeFile(correctedPath, JSON.stringify({ fragment: { name: "repair", nodes: [node("repair")] } }))
    try {
      await Effect.runPromise(
        runWakeTest(
          ({ dag, workflow, store, parentPrompts, parentSettled, childPrompts }) =>
            Effect.gen(function* () {
              const dagID = yield* dag.create({ projectID: "project-1", sessionID: "ses_parent",
                title: "Escalated replan", config: { name: "escalated-replan", nodes: [node("anchor")] } })
              const anchor = yield* takeWithin(childPrompts, "anchor did not start")
              const running = yield* pollWithTimeout(store.getNode(dagID, "anchor").pipe(
                Effect.map((current) => current?.status === "running" && current.childSessionId ? current : undefined),
              ), "anchor did not reach running")
              yield* dag.nodeTimeoutEscalated(dagID, "anchor", running.childSessionId!, 1)
              const parent = yield* takeWithin(parentPrompts, "timeout escalation did not wake the parent")
              expect(promptText(parent.input)).toContain("Act on these workflows this turn")
              const context = {
                sessionID: SessionID.make("ses_parent"),
                messageID: MessageID.ascending(),
                agent: "build",
                abort: new AbortController().signal,
                messages: [],
                metadata: () => Effect.void,
                ask: () => Effect.void,
              } satisfies Tool.Context
              const rejected = yield* workflow.execute(
                Schema.decodeUnknownSync(WorkflowParameters)({ params: {
                  action: "control", operation: "replan", workflow_id: dagID, spec_path: invalidPath,
                }}),
                context,
              ).pipe(Effect.exit)
              expect(Exit.isFailure(rejected)).toBe(true)
              if (Exit.isFailure(rejected)) expect(Cause.pretty(rejected.cause)).toContain("Workflow state: paused")
              expect((yield* store.getWorkflow(dagID))?.status).toBe("paused")

              yield* Deferred.succeed(parent.release, "success")
              yield* takeWithin(parentSettled, "parent did not settle after the rejected replan")
              expect((yield* store.getWorkflow(dagID))?.status).toBe("paused")

              const repaired = yield* workflow.execute(
                Schema.decodeUnknownSync(WorkflowParameters)({ params: {
                  action: "control", operation: "replan", workflow_id: dagID, spec_path: correctedPath,
                }}),
                context,
              )
              expect(repaired.title).toContain("Workflow replanned")
              expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
              const child = yield* takeWithin(childPrompts, "corrective node did not start")
              expect(child.title).toBe("repair")
              yield* Deferred.succeed(child.release, "repaired")
              yield* Deferred.succeed(anchor.release, "anchor done")
            }),
        ),
      )
    } finally {
      await Promise.all([fs.rm(invalidPath, { force: true }), fs.rm(correctedPath, { force: true })])
    }
  })
})
