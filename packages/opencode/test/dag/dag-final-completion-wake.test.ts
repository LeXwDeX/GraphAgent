/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Synthetic branded DB rows and a Session service mock exercise the real store, event, and wake services without starting a model. */
import { expect, it } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue, Stream } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Agent } from "@/agent/agent"
import { Provider as RuntimeProvider } from "@/provider/provider"
import { Dag, type NodeConfig, type WorkflowConfig } from "@/dag/dag"
import { reportingCheckpoints } from "@/dag/runtime/report-delivery"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Truncate } from "@/tool/truncate"
import { ProviderTest } from "../fake/provider"
import { pollWithTimeout } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"
import { makeNodeRow } from "./fixtures"

interface PromptGate {
  readonly title: string
  readonly input: SessionPrompt.PromptInput
  readonly release: Deferred.Deferred<string>
}

interface ParentPromptGate {
  readonly input: SessionPrompt.PromptInput
  readonly release: Deferred.Deferred<"success" | "failure">
}

function takeWithin<A>(
  queue: Queue.Queue<A>,
  message: string,
  timeout: "1 second" | "2 seconds" | "5 seconds" = "2 seconds",
) {
  return Queue.take(queue).pipe(
    Effect.timeoutOption(timeout),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new Error(message)),
        onSome: Effect.succeed,
      }),
    ),
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

const verdictSchema = {
  type: "object",
  properties: { verdict: { enum: ["PASS", "FAIL"] } },
  required: ["verdict"],
}

function wakeLayer(input: {
  readonly childPrompts: Queue.Queue<PromptGate>
  readonly parentPrompts: Queue.Queue<ParentPromptGate>
}) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store))
  const base = Layer.mergeAll(database, events, bridge, store, projector, dag, status)
  const childTitles = new Map<string, string>()
  const created: string[] = []
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: () =>
      Effect.succeed({
        id: SessionID.make("ses_parent"),
        slug: "parent",
        projectID: "project-1",
        directory: process.cwd(),
        title: "parent",
        agent: "build",
        model: { providerID: "test", id: "test-model" },
        version: "test",
        time: { created: 0, updated: 0 },
      } as never),
    create: (value: { readonly title?: string } | undefined) =>
      Effect.sync(() => {
        const id = `ses_child_${created.length + 1}`
        created.push(id)
        childTitles.set(id, (value?.title ?? id).replace(" (DAG node)", ""))
        return { id } as never
      }),
    messages: () => Effect.succeed([]),
  } as unknown as Session.Interface)
  const deliver = Effect.fn("test.SessionPrompt.deliver")(function* (value: SessionPrompt.PromptInput) {
    const sessionID = value.sessionID as string
    if (sessionID === "ses_parent") {
      const release = yield* Deferred.make<"success" | "failure">()
      yield* Queue.offer(input.parentPrompts, { input: value, release })
      const outcome = yield* Deferred.await(release)
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
  const prompt = Layer.mock(
    SessionPrompt.Service,
    withIdleAdmission({
      cancel: () => Effect.void,
      prompt: deliver,
      promptIfIdle: (value) => deliver(value).pipe(Effect.map(Option.some)),
    }),
  )
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
  const loop = DagLoop.layer.pipe(
    Layer.provide(base),
    Layer.provide(session),
    Layer.provide(prompt),
    Layer.provide(agent),
  )
  return Layer.mergeAll(base, loop, session, agent, provider, truncate)
}

function isAnswerPart(event: EventV2.Payload) {
  if (event.type !== "message.part.updated") return undefined
  const part = (event.data as { part?: SessionV1.Part }).part
  if (part?.type !== "text" || part.metadata?.dag_delivery?.kind !== "answer") return undefined
  return part
}

function runTest<A>(
  test: (services: {
    readonly dag: Dag.Interface
    readonly store: DagStore.Interface
    readonly status: SessionStatus.Interface
    readonly childPrompts: Queue.Queue<PromptGate>
    readonly parentPrompts: Queue.Queue<ParentPromptGate>
    readonly reports: EventV2.Payload[]
  }) => Effect.Effect<A, Error>,
) {
  return Effect.gen(function* () {
    const childPrompts = yield* Queue.unbounded<PromptGate>()
    const parentPrompts = yield* Queue.unbounded<ParentPromptGate>()
    const reports: EventV2.Payload[] = []
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const status = yield* SessionStatus.Service
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      yield* database.db
        .insert(ProjectTable)
        .values({
          id: "project-1" as never,
          worktree: process.cwd() as never,
          sandboxes: [],
        })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionTable)
        .values({
          id: "ses_parent" as never,
          project_id: "project-1" as never,
          slug: "parent",
          directory: process.cwd(),
          title: "Parent",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* events.all().pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (isAnswerPart(event)) reports.push(event)
          }),
        ),
        Effect.forkScoped,
      )
      yield* loop.init()
      return yield* test({ dag, store, status, childPrompts, parentPrompts, reports })
    }).pipe(
      Effect.provide(wakeLayer({ childPrompts, parentPrompts })),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: { id: "project-1" },
      } as never),
      Effect.scoped,
    )
  }).pipe(Effect.runPromise)
}

function waitForCompletion(store: DagStore.Interface, dagID: string) {
  return pollWithTimeout(
    store.getWorkflow(dagID).pipe(Effect.map((workflow) => (workflow?.status === "completed" ? true : undefined))),
    "workflow did not complete",
    "5 seconds",
  )
}

function childGate(childPrompts: Queue.Queue<PromptGate>, id: string) {
  return Effect.gen(function* () {
    const gate = yield* takeWithin(childPrompts, `${id} did not start`)
    expect(gate.title).toBe(id)
    return gate
  })
}

it("keys parent involvement only to durable reporting evidence, not an ordinary delivery leaf", () => {
  const config: WorkflowConfig = {
    name: "evidence",
    delivery_node: "final",
    nodes: [
      { ...node("final"), depends_on: [] },
      { ...node("cp") },
      { ...node("gated-delivery"), depends_on: [] },
      { ...node("disabled"), report_to_parent: false },
    ],
  }
  const nodes = [
    makeNodeRow({ id: "final", status: "completed", wakeEligible: true }),
    makeNodeRow({ id: "cp", status: "completed", wakeEligible: true }),
    makeNodeRow({ id: "gated-delivery", status: "completed", wakeEligible: true }),
    makeNodeRow({ id: "disabled", status: "completed", wakeEligible: false }),
    makeNodeRow({ id: "superseded", status: "completed", wakeEligible: true, superseded: true }),
  ]
  const withDependent = [...nodes, makeNodeRow({ id: "after", dependsOn: ["gated-delivery"] })]
  expect(reportingCheckpoints(config, nodes).map((item) => item.id)).toEqual(["cp", "gated-delivery"])
  expect(reportingCheckpoints(config, withDependent).map((item) => item.id)).toEqual(["cp", "gated-delivery"])
})

it("keeps the final report and a completion wake after earlier checkpoint wakes were acknowledged", async () => {
  await runTest(({ dag, store, status, childPrompts, parentPrompts, reports }) =>
    Effect.gen(function* () {
      const dagID = yield* dag.create({
        projectID: "project-1",
        sessionID: "ses_parent",
        title: "Reporting completion",
        config: {
          name: "reporting-completion",
          result_protocol: "final_response",
          delivery_node: "final",
          max_concurrency: 8,
          nodes: [
            { ...node("cp1"), output_schema: verdictSchema },
            { ...node("cp2") },
            { ...node("cp3"), output_schema: verdictSchema },
            { ...node("cp4") },
            {
              ...node("w1", ["cp1"]),
              report_to_parent: false,
              condition: 'cp1.output.verdict == "PASS"',
            },
            {
              ...node("w2", ["cp3"]),
              report_to_parent: false,
              condition: 'cp3.output.verdict == "PASS"',
            },
            { ...node("final", ["w1", "w2"]), report_to_parent: false },
          ],
        },
      })

      const roots = new Map<string, PromptGate>()
      while (roots.size < 4) {
        const gate = yield* takeWithin(childPrompts, "reporting root did not start")
        roots.set(gate.title, gate)
      }
      expect([...roots.keys()].toSorted()).toEqual(["cp1", "cp2", "cp3", "cp4"])

      // Keep the parent busy before any checkpoint finishes. Every later
      // completion must reach one stable admission batch instead of one parent
      // turn per checkpoint.
      yield* status.set(SessionID.make("ses_parent"), { type: "busy" })

      yield* Deferred.succeed(roots.get("cp1")!.release, '{"verdict":"PASS"}')
      yield* Deferred.succeed(roots.get("cp2")!.release, "checkpoint two")
      yield* Deferred.succeed(roots.get("cp3")!.release, '{"verdict":"PASS"}')
      yield* Deferred.succeed(roots.get("cp4")!.release, "checkpoint four")

      // Start the downstream workers but keep them blocked: the workflow stays
      // running, so the wake below is a checkpoint batch, not a completion.
      const workers = new Map<string, PromptGate>()
      while (workers.size < 2) {
        const gate = yield* takeWithin(childPrompts, "downstream worker did not start")
        workers.set(gate.title, gate)
      }
      expect([...workers.keys()].toSorted()).toEqual(["w1", "w2"])

      const checkpointIDs = ["cp1", "cp2", "cp3", "cp4"]
      const checkpointOutputs = ['{"verdict":"PASS"}', "checkpoint two", '{"verdict":"PASS"}', "checkpoint four"]
      yield* pollWithTimeout(
        store.getCurrentNodes(dagID).pipe(
          Effect.map((nodes) => {
            const checkpoints = nodes.filter((node) => checkpointIDs.includes(node.id))
            return checkpoints.length === checkpointIDs.length &&
              checkpoints.every((node) => node.status === "completed" && !node.wakeReported)
              ? checkpoints
              : undefined
          }),
        ),
        "checkpoints did not finish while the parent stayed busy",
        "5 seconds",
      )
      yield* pollWithTimeout(
        store.getCurrentNodes(dagID).pipe(
          Effect.map((nodes) =>
            ["w1", "w2"].every((id) => nodes.find((node) => node.id === id)?.status === "running")
              ? true
              : undefined,
          ),
        ),
        "downstream workers did not enter the running state",
        "5 seconds",
      )
      expect((yield* store.getWorkflow(dagID))?.status).toBe("running")

      // Release admission once. A coalescing defect surfaces as a second parent
      // prompt here; retrying until four ids appear would tolerate it.
      yield* status.set(SessionID.make("ses_parent"), { type: "idle" })
      const wake = yield* takeWithin(parentPrompts, "coalesced checkpoint wake did not arrive")
      const wakeText = promptText(wake.input)
      expect(wakeText).toContain("[DAG Node Result]")
      expect(wakeText).not.toContain("[DAG Workflow completed]")
      expect(wakeText).not.toContain("Act on these workflows")
      for (const id of checkpointIDs) expect(wakeText).toContain(`node_id="${id}"`)
      for (const output of checkpointOutputs) expect(wakeText).toContain(output)
      yield* Deferred.succeed(wake.release, "success")

      yield* pollWithTimeout(
        store.getCurrentNodes(dagID).pipe(
          Effect.map((nodes) =>
            checkpointIDs.every((id) => nodes.find((node) => node.id === id)?.wakeReported) ? true : undefined,
          ),
        ),
        "the single wake did not acknowledge every checkpoint",
        "5 seconds",
      )
      for (let index = 0; index < 20; index++) yield* Effect.yieldNow
      expect(Option.isNone(yield* Queue.poll(parentPrompts))).toBe(true)

      yield* Deferred.succeed(workers.get("w1")!.release, "worker one")
      yield* Deferred.succeed(workers.get("w2")!.release, "worker two")
      const final = yield* childGate(childPrompts, "final")
      yield* Deferred.succeed(final.release, "final answer from synthesis")
      yield* waitForCompletion(store, dagID)

      // The parent transcript must already show the final report when the
      // completion turn is admitted.
      const answer = yield* pollWithTimeout(
        Effect.sync(() => reports.map(isAnswerPart).find((part) => part !== undefined)),
        "final report was not delivered before the completion turn",
        "5 seconds",
      )
      expect(answer?.text).toBe("final answer from synthesis")

      const completion = yield* takeWithin(parentPrompts, "completion wake did not reach the parent")
      const completionText = promptText(completion.input)
      yield* Deferred.succeed(completion.release, "success")
      expect(completionText).toContain("[DAG Workflow completed]")
      expect(completionText).toContain("[DAG Final Report]")
      expect(completionText).toContain("Continue the plan")
      expect(completionText).not.toContain("Act on these workflows")
      expect((yield* store.getWorkflow(dagID))?.wakeReported).toBe(true)
    }),
  )
})

it("treats a reporting delivery leaf as display-only and never acknowledges its node wake", async () => {
  await runTest(({ dag, store, childPrompts, parentPrompts, reports }) =>
    Effect.gen(function* () {
      const dagID = yield* dag.create({
        projectID: "project-1",
        sessionID: "ses_parent",
        title: "Reporting delivery leaf",
        config: {
          name: "reporting-delivery-leaf",
          result_protocol: "final_response",
          delivery_node: "final",
          nodes: [node("final")],
        },
      })
      const final = yield* childGate(childPrompts, "final")
      yield* Deferred.succeed(final.release, "displayed answer")
      yield* waitForCompletion(store, dagID)
      const answer = yield* pollWithTimeout(
        Effect.sync(() => reports.map(isAnswerPart).find((part) => part !== undefined)),
        "reporting delivery leaf was not displayed",
        "5 seconds",
      )
      expect(answer?.text).toBe("displayed answer")
      for (let index = 0; index < 20; index++) yield* Effect.yieldNow
      expect(Option.isNone(yield* Queue.poll(parentPrompts))).toBe(true)
      expect((yield* store.getWorkflow(dagID))?.wakeReported).toBe(true)
      expect((yield* store.getNode(dagID, "final"))?.wakeReported).toBe(false)
    }),
  )
})

it("delivers a direct final answer once without a redundant parent turn", async () => {
  await runTest(({ dag, store, childPrompts, parentPrompts, reports }) =>
    Effect.gen(function* () {
      const dagID = yield* dag.create({
        projectID: "project-1",
        sessionID: "ses_parent",
        title: "Direct answer",
        config: {
          name: "direct-answer",
          result_protocol: "final_response",
          delivery_node: "final",
          nodes: [{ ...node("final"), report_to_parent: false }],
        },
      })
      const final = yield* childGate(childPrompts, "final")
      yield* Deferred.succeed(final.release, "direct answer")
      yield* waitForCompletion(store, dagID)
      const answer = yield* pollWithTimeout(
        Effect.sync(() => reports.map(isAnswerPart).find((part) => part !== undefined)),
        "direct final report was not delivered",
        "5 seconds",
      )
      expect(answer?.text).toBe("direct answer")
      for (let index = 0; index < 20; index++) yield* Effect.yieldNow
      expect(Option.isNone(yield* Queue.poll(parentPrompts))).toBe(true)
      expect((yield* store.getWorkflow(dagID))?.wakeReported).toBe(true)
      expect((yield* store.getNode(dagID, "final"))?.wakeReported).toBe(false)
    }),
  )
})
