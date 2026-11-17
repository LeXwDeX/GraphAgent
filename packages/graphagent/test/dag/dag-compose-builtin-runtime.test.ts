// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- service mocks use the narrow runtime surface exercised here
// #1158 PR4b: the two built-in composers through the real scheduling loop. The agent catalog is the real one
// (`Agent.list` of the built-in agents), not the fixtures of dag-compose-runtime.test.ts, so what runs is what a model
// that writes `kind: compose, worker_type: surveyor` (or `mapper`) gets: the Workflow Authoring Check compiles the
// block against the real contracts, the scheduler expands the plan, and the join node produces the declared artifact.
// Each node's prompt is handed to the test, which answers it the way the model would. The last assertions of each test
// read `inspect` status, which is where the parent sees how the expansion went (the `compose` summary).
import { afterAll, describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue, Scope } from "effect"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { LocationServiceMap } from "@graphagent/core/location-layer"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { AbsolutePath } from "@graphagent/core/schema"
import { Database } from "@graphagent/core/database/database"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { SessionTable } from "@graphagent/core/session/sql"
import { Agent } from "@/agent/agent"
import { AgentArtifact } from "@/agent/artifact"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { WorkflowAuthoring } from "@/dag/authoring"
import { DagBudget } from "@/dag/budget"
import { DagCompose } from "@/dag/compose"
import { DagControl } from "@/dag/control"
import { Dag, parseWorkflowConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import type { DagValidation } from "@/dag/validation"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Provider } from "@/provider/provider"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Skill } from "@/skill"
import { AgentScheduler } from "@/session/agent-scheduler"
import { inspectWorkflow } from "@/tool/workflow/inspect"
import { runWorkflow } from "@/tool/workflow/run"
import type { InspectParams, RunParams } from "@/tool/workflow/schema"
import { awaitWithTimeout as awaitUntil, it, pollWithTimeout as pollUntil } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"
import { stubChildren } from "../lib/child-runs"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { transactLayer } from "./fixture/transact"
import { cleanup, toolContext, workflowID, writeSpec } from "./workflow-harness"

// Every wait returns as soon as its state is reached, so the bound only decides how long a real failure takes to report.
const STALL_TOLERANCE = "20 seconds"
const awaitWithTimeout = <A, E, R>(self: Effect.Effect<A, E, R>, message: string) =>
  awaitUntil(self, message, STALL_TOLERANCE)
const pollWithTimeout = <A, E, R>(self: Effect.Effect<A | undefined, E, R>, message: string | (() => string)) =>
  pollUntil(self, message, STALL_TOLERANCE)

interface PromptRecord {
  readonly title: string
  readonly text: string
  readonly release: Deferred.Deferred<string>
}

function reply(sessionID: string, text = "done"): SessionV1.WithParts {
  return {
    info: { id: MessageID.ascending(), sessionID, role: "assistant", time: { created: Date.now() } },
    parts: [{ type: "text", text }],
  } as never
}

/** The loop, a real `Dag` over an in-memory database, and a scripted worker: every child prompt lands in `records`. */
function runtimeLayer(records: Queue.Queue<PromptRecord>, catalog: readonly Agent.Info[]) {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
  const store = DagStore.layer.pipe(Layer.provide(database))
  const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const status = SessionStatus.layer.pipe(Layer.provide(bridge))
  const dag = Dag.layer.pipe(Layer.provide(bridge), Layer.provide(store), Layer.provide(transactLayer(database)))
  const base = Layer.mergeAll(database, events, bridge, store, projector, status, dag, AgentScheduler.defaultLayer)
  const titles = new Map<string, string>()
  let created = 0
  const session = Layer.mock(Session.Service, {
    getPart: () => Effect.succeed(undefined),
    get: (id) => Effect.succeed({ id, permission: [], agent: "build" } as never),
    create: (input) =>
      Effect.sync(() => {
        const id = `ses_builtin_child_${++created}`
        titles.set(id, (input?.title ?? id).replace(" (DAG node)", ""))
        return { id } as never
      }),
    messages: () => Effect.succeed([]),
  })
  const deliver = Effect.fn("test.SessionPrompt.builtin")(function* (input: SessionPrompt.PromptInput) {
    const sessionID = input.sessionID as string
    if (sessionID === "ses_builtin_parent") return reply(sessionID)
    const release = yield* Deferred.make<string>()
    yield* Queue.offer(records, {
      title: titles.get(sessionID) ?? sessionID,
      text: input.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
      release,
    })
    return reply(sessionID, yield* Deferred.await(release))
  })
  const impl = withIdleAdmission({
    cancel: () => Effect.void,
    prompt: deliver,
    deliver: (input) => deliver(input).pipe(Effect.map(Option.some)),
  })
  const prompt = Layer.mock(SessionPrompt.Service, {
    ...impl,
    children: Effect.succeed(stubChildren(impl).children),
  } as never)
  const agent = Layer.mock(Agent.Service, {
    list: () => Effect.succeed(catalog as never),
    get: () =>
      Effect.succeed({
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
  )
  const config = Layer.mock(Config.Service, { dagGlobal: () => Effect.succeed({} as never) })
  const budget = DagBudget.layer.pipe(Layer.provide(Layer.mergeAll(base, session, config)))
  const control = DagControl.layer.pipe(Layer.provide(base))
  return Layer.mergeAll(base, loop, budget, control)
}

interface Services {
  readonly dag: Dag.Interface
  readonly control: DagControl.Interface
  readonly loop: DagLoop.Interface
  readonly store: DagStore.Interface
  readonly records: Queue.Queue<PromptRecord>
  /** The agents the loop and the authoring check see: the real built-in catalog. */
  readonly catalog: readonly Agent.Info[]
}

function runLoopTest<A>(
  catalog: readonly Agent.Info[],
  test: (services: Services) => Effect.Effect<A, Error, Scope.Scope>,
) {
  return Effect.gen(function* () {
    const records = yield* Queue.unbounded<PromptRecord>()
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const control = yield* DagControl.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(process.cwd()), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionID.make("ses_builtin_parent"),
          project_id: Project.ID.global,
          slug: "builtin-parent",
          directory: process.cwd(),
          title: "Built-in composers",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      return yield* test({ dag, control, loop, store, records, catalog })
    }).pipe(
      Effect.provide(runtimeLayer(records, catalog)),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: { id: Project.ID.global },
      } as never),
      Effect.scoped,
    )
  })
}

/**
 * The real built-in catalog, as the Agent service builds it for a project directory. The Agent service and the
 * layers under it are built in a scope of their own, with a memo map of their own, and released before the harness
 * above builds its in-memory database: a layer built in the same memo map would hand the harness the Agent service's
 * database, and the services of the Agent layer must not leak into the harness either. What comes back is plain data.
 */
const agentLayer = Agent.layer.pipe(
  Layer.provideMerge(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provideMerge(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(LocationServiceMap.layer),
  Layer.provide(RuntimeFlags.layer({})),
)
const builtinAgents = Effect.gen(function* () {
  const services = yield* Layer.buildWithMemoMap(agentLayer, yield* Layer.makeMemoMap, yield* Scope.Scope)
  return yield* provideTmpdirInstance(() => Agent.Service.use((svc) => svc.list())).pipe(
    Effect.provide(services),
    Effect.provide(CrossSpawnSpawner.defaultLayer),
  )
}).pipe(Effect.scoped)

// ---------------------------------------------------------------------------------------------------------------------
// What the model writes, and how the test answers what the nodes are asked
// ---------------------------------------------------------------------------------------------------------------------

const PARENT_SESSION = "ses_builtin_parent"

const environment = (list: readonly Agent.Info[]): DagValidation.EnvironmentCatalogs => ({
  worker_types: new Set([...list.map((entry) => entry.name), "plan", "build", "general"]),
  composers: DagCompose.catalogFrom(list),
})

const caller = (services: Services) => ({
  dag: services.dag,
  control: services.control,
  authoring: WorkflowAuthoring.make({ loadEnvironment: () => Effect.succeed(environment(services.catalog)) }),
  sessionID: PARENT_SESSION,
  session: { directory: process.cwd(), projectID: Project.ID.global, model: undefined },
  ctx: toolContext(PARENT_SESSION, "build"),
})

const specOf = (...blocks: unknown[]) =>
  writeSpec({ config: { name: "builtin-route", objective: "Understand the persistence layer", blocks } })
const startOf = (specPath: string) => ({ action: "run", operation: "start", spec_path: specPath }) as RunParams

const SURVEY = { id: "survey", kind: "compose", worker_type: "surveyor", instruction: "Compare the designs" }
const MAP = { id: "map", kind: "compose", worker_type: "mapper", instruction: "Map the repository" }

const item = (id: string, agent: string, extra: Record<string, unknown> = {}) => ({
  id,
  agent,
  instruction: `Look into ${id}`,
  ...extra,
})
const plan = (items: unknown[]) =>
  JSON.stringify({ rationale: "split by what has to be found out", items, not_planned: [] })

/** An artifact of the catalog, checked against its schema so a test cannot answer with something no worker could. */
const artifact = (name: string, summary: string, body: unknown) => {
  const text = JSON.stringify({ artifact: name, summary, body, evidence: [], not_examined: [] })
  const checked = AgentArtifact.validate(name, JSON.parse(text))
  if (!checked.ok) throw new Error(`the test's ${name} is not a ${name}: ${checked.error}`)
  return text
}
const research = (summary: string) =>
  artifact("research_findings", summary, {
    question: "q",
    answers: [{ claim: summary, sources: ["https://example.com/a"] }],
    conflicts: [],
  })
const findings = (summary: string) =>
  artifact("code_findings", summary, { scope: "src", findings: [{ claim: summary, refs: ["/src/a.ts:1"] }] })
const surveyReport = (summary: string) =>
  artifact("survey_report", summary, { question: "q", comparison: [], recommendation: "go" })
const projectMap = (summary: string) => artifact("project_map", summary, { modules: [], cross_cutting: [] })

const take = (records: Queue.Queue<PromptRecord>, count: number, message: string) =>
  Effect.forEach(Array.from({ length: count }), () => awaitWithTimeout(Queue.take(records), message))

const named = (taken: readonly PromptRecord[], title: string) => {
  const found = taken.find((record) => record.title === title)
  if (!found) throw new Error(`no prompt for "${title}" among ${taken.map((record) => record.title).join(", ")}`)
  return found
}

const completed = (store: DagStore.Interface, dagID: string) =>
  pollWithTimeout(
    store.getWorkflow(dagID).pipe(Effect.map((row) => (row?.status === "completed" ? row : undefined))),
    "the workflow did not complete",
  )

interface StatusView {
  readonly status: string
  readonly compose?: readonly Record<string, unknown>[]
  readonly coverage?: readonly { node_id: string; reason: string }[]
  readonly nodes: readonly { id: string; status: string }[]
}

/** What the parent reads: `inspect` status, parsed. `config` is the user's global config, when the test needs one. */
const status = (services: Services, dagID: string, config?: Parameters<typeof inspectWorkflow>[0]["config"]) =>
  inspectWorkflow({ dag: services.dag, sessionID: PARENT_SESSION, ...(config ? { config } : {}) }, {
    action: "inspect",
    operation: "status",
    workflow_id: dagID,
  } as InspectParams).pipe(Effect.map((result) => JSON.parse(result.output) as StatusView))

const statusText = (services: Services, dagID: string) =>
  inspectWorkflow({ dag: services.dag, sessionID: PARENT_SESSION }, {
    action: "inspect",
    operation: "status",
    workflow_id: dagID,
  } as InspectParams).pipe(Effect.map((result) => result.output))

describe("the built-in surveyor through the loop", () => {
  afterAll(async () => {
    cleanup()
    await disposeAllInstances()
  })

  it.live("expands one level over the researcher and explore, joins a survey_report, and tells the parent how", () =>
    Effect.gen(function* () {
      const catalog = yield* builtinAgents
      return yield* runLoopTest(catalog, (services) =>
        Effect.gen(function* () {
          const { loop, store, records } = services
          yield* loop.init()
          const started = yield* runWorkflow(
            caller(services),
            startOf(
              specOf(SURVEY, { id: "decide", kind: "plan", depends_on: ["survey"], instruction: "Choose one design" }),
            ),
          )
          expect(started.metadata?.blocked).toBeUndefined()
          expect(started.output).toContain("3 nodes registered")
          const dagID = workflowID(started.output)

          // The split node is the surveyor, asked for a plan over the two workers its contract dispatches to.
          const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
          expect(split.title).toBe("survey: compose: plan the expansion")
          expect(split.text).toContain("- researcher: produces research_findings")
          expect(split.text).toContain("- explore: produces code_findings")
          expect(split.text).toContain("Depth 1 of 2.")
          expect(split.text).toContain("Compare the designs")

          // While the plan is being made the block is not expanded yet, and the parent can see that.
          const planning = yield* status(services, dagID)
          expect(planning.compose).toEqual([
            {
              id: "survey",
              composer: "surveyor",
              expanded: false,
              items: 0,
              required_items: 0,
              depth: 1,
              max_depth: 2,
              subtree_nodes: 0,
              subtree_quota: 40,
              subtree_remaining: 40,
            },
          ])

          yield* Deferred.succeed(
            split.release,
            plan([item("official", "researcher"), item("code", "explore", { required: true })]),
          )
          const taken = yield* take(records, 2, "the children did not start")
          expect(taken.map((record) => record.title).toSorted()).toEqual([
            "survey: compose [code]",
            "survey: compose [official]",
          ])
          // A worker sees its own instruction and the artifact its agent declares, and nothing of the plan.
          const official = named(taken, "survey: compose [official]")
          expect(official.text).toContain("Look into official")
          expect(official.text).toContain("research_findings")
          expect(official.text).not.toContain("Look into code")
          yield* Deferred.succeed(official.release, research("official says"))
          yield* Deferred.succeed(named(taken, "survey: compose [code]").release, findings("code says"))

          const join = yield* awaitWithTimeout(Queue.take(records), "the join node did not start")
          expect(join.title).toBe("survey: compose")
          expect(join.text).toContain("Return the survey_report artifact.")
          expect(join.text).toContain('"survey--official": item "official", by researcher; may be skipped.')
          expect(join.text).toContain('"survey--code": item "code", by explore; required.')
          expect(join.text).toContain("official says")
          expect(join.text).toContain("code says")
          yield* Deferred.succeed(join.release, surveyReport("joined"))

          const decide = yield* awaitWithTimeout(Queue.take(records), "the downstream block did not start")
          expect(decide.text).toContain("joined")
          yield* Deferred.succeed(decide.release, "decided")
          yield* completed(store, dagID)
          expect(Option.isNone(yield* Queue.poll(records))).toBe(true)

          // Two items, one of them required; one level deep; the two workers are what the quota has been spent on.
          const done = yield* status(services, dagID)
          expect(done.status).toBe("completed")
          expect(done.coverage).toBeUndefined()
          expect(done.compose).toEqual([
            {
              id: "survey",
              composer: "surveyor",
              expanded: true,
              items: 2,
              required_items: 1,
              required_share: 0.5,
              depth: 1,
              max_depth: 2,
              subtree_nodes: 2,
              subtree_quota: 40,
              subtree_remaining: 38,
            },
          ])
          // The ceiling and the quota are the user's `dag.compose`, read from the global config only.
          const limited = yield* status(services, dagID, {
            dagGlobal: () => Effect.succeed({ compose: { max_depth: 3, max_subtree_nodes: 12 } } as never),
          })
          expect(limited.compose?.[0]).toMatchObject({ max_depth: 3, subtree_quota: 12, subtree_remaining: 10 })
        }),
      )
    }),
  )

  it.live("degrades to the researcher when the split fails, and the parent is told why, with no items planned", () =>
    Effect.gen(function* () {
      const catalog = yield* builtinAgents
      return yield* runLoopTest(catalog, (services) =>
        Effect.gen(function* () {
          const { dag, loop, store, records } = services
          yield* loop.init()
          const started = yield* runWorkflow(
            caller(services),
            startOf(
              specOf(SURVEY, { id: "decide", kind: "plan", depends_on: ["survey"], instruction: "Choose one design" }),
            ),
          )
          const dagID = workflowID(started.output)
          const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
          expect(split.title).toBe("survey: compose: plan the expansion")
          yield* dag.nodeFailed(dagID, "survey--split", "the model gave up", "exec_failed")

          // The surveyor's fallback is the researcher: one worker takes the whole task.
          const fallback = yield* awaitWithTimeout(Queue.take(records), "the fallback worker did not start")
          expect(fallback.title).toBe("survey: compose [fallback]")
          expect(fallback.text).toContain("Compare the designs")
          expect(fallback.text).toContain("research_findings")
          expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
          yield* Deferred.succeed(fallback.release, research("everything, alone"))
          const join = yield* awaitWithTimeout(Queue.take(records), "the join node did not start")
          yield* Deferred.succeed(join.release, surveyReport("joined without a comparison"))
          const decide = yield* awaitWithTimeout(Queue.take(records), "the downstream block did not start")
          yield* Deferred.succeed(decide.release, "decided")
          yield* completed(store, dagID)

          const done = yield* status(services, dagID)
          const reason = 'the split node "survey--split" failed: the model gave up'
          expect(done.compose).toEqual([
            {
              id: "survey",
              composer: "surveyor",
              expanded: true,
              items: 0,
              required_items: 0,
              degraded: [{ node_id: "survey", reason }],
              depth: 1,
              max_depth: 2,
              subtree_nodes: 1,
              subtree_quota: 40,
              subtree_remaining: 39,
            },
          ])
          // The coverage section names the same degradation, beside the split node that failed.
          expect(done.coverage).toEqual([
            { node_id: "survey--split", reason: "failed: exec_failed: the model gave up" },
            { node_id: "survey", reason: `compose expansion degraded: ${reason}` },
          ])
        }),
      )
    }),
  )

  it.live("leaves the status of a workflow with no compose block exactly as it was", () =>
    Effect.gen(function* () {
      const catalog = yield* builtinAgents
      return yield* runLoopTest(catalog, (services) =>
        Effect.gen(function* () {
          const { loop } = services
          yield* loop.init()
          const started = yield* runWorkflow(
            caller(services),
            startOf(specOf({ id: "look", kind: "explore", instruction: "Look at the code" })),
          )
          const dagID = workflowID(started.output)
          const text = yield* statusText(services, dagID)
          expect(JSON.parse(text)).not.toHaveProperty("compose")
          expect(text).not.toContain('"compose"')
        }),
      )
    }),
  )
})

describe("the built-in mapper through the loop", () => {
  afterAll(async () => {
    cleanup()
    await disposeAllInstances()
  })

  it.live("splits twice over explore, joins a project_map at each level, and tells the parent how deep it went", () =>
    Effect.gen(function* () {
      const catalog = yield* builtinAgents
      return yield* runLoopTest(catalog, (services) =>
        Effect.gen(function* () {
          const { loop, store, records } = services
          yield* loop.init()
          const started = yield* runWorkflow(caller(services), startOf(specOf(MAP)))
          expect(started.metadata?.blocked).toBeUndefined()
          expect(started.output).toContain("2 nodes registered")
          const dagID = workflowID(started.output)

          // The mapper is asked for a plan over explore alone, and may ask for an item to be split again.
          const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
          expect(split.title).toBe("map: compose: plan the expansion")
          expect(split.text).toContain("- explore: produces code_findings")
          expect(split.text).not.toContain("- researcher:")
          expect(split.text).toContain("Depth 1 of 2.")
          expect(split.text).toContain("- split: set true on an item that is still too large for one worker")
          yield* Deferred.succeed(
            split.release,
            plan([item("api", "explore", { split: true, required: true }), item("web", "explore")]),
          )

          // The nested split node and the plain worker start together; the nested slot waits for its plan.
          const first = yield* take(records, 2, "the nested split node and the plain worker did not start")
          expect(first.map((record) => record.title).toSorted()).toEqual([
            "map: compose [api]: plan the expansion",
            "map: compose [web]",
          ])
          const nested = named(first, "map: compose [api]: plan the expansion")
          expect(nested.text).toContain("Look into api")
          expect(nested.text).toContain("Depth 2 of 2.")
          // Nothing of the plan above, nor of the sibling, reaches it.
          expect(nested.text).not.toContain("Look into web")
          yield* Deferred.succeed(named(first, "map: compose [web]").release, findings("web says"))
          // At the deepest level an item that asks to be split again runs as one worker.
          yield* Deferred.succeed(
            nested.release,
            plan([item("routes", "explore"), item("models", "explore", { split: true })]),
          )

          const second = yield* take(records, 2, "the nested workers did not start")
          expect(second.map((record) => record.title).toSorted()).toEqual([
            "map: compose [api] [models]",
            "map: compose [api] [routes]",
          ])
          const models = named(second, "map: compose [api] [models]")
          expect(models.text).toContain("The plan asked to split this item further, but it runs as one worker")
          expect(models.text).toContain("dag.compose.max_depth 2")
          yield* Deferred.succeed(named(second, "map: compose [api] [routes]").release, findings("routes say"))
          yield* Deferred.succeed(models.release, findings("models say"))

          // The nested join node is the mapper again, with the nested plan and its two results.
          const inner = yield* awaitWithTimeout(Queue.take(records), "the nested join node did not start")
          expect(inner.title).toBe("map: compose [api]")
          expect(inner.text).toContain("Return the project_map artifact.")
          expect(inner.text).toContain("routes say")
          expect(inner.text).toContain("models say")
          expect(inner.text).not.toContain("web says")
          yield* Deferred.succeed(inner.release, projectMap("api joined"))

          // The join node above reads the nested join as its item `api`, by the id the item always had.
          const outer = yield* awaitWithTimeout(Queue.take(records), "the join node did not start")
          expect(outer.title).toBe("map: compose")
          expect(outer.text).toContain("Return the project_map artifact.")
          expect(outer.text).toContain('"map--api": item "api", split again and joined by mapper; required.')
          expect(outer.text).toContain("api joined")
          expect(outer.text).toContain("web says")
          yield* Deferred.succeed(outer.release, projectMap("everything joined"))
          yield* completed(store, dagID)
          expect(Option.isNone(yield* Queue.poll(records))).toBe(true)

          // Four items in two plans (one required), two levels, and five nodes spent: the nested split node and
          // join node, the plain worker and the two workers below. One item asked to be split at the deepest level.
          const done = yield* status(services, dagID)
          expect(done.status).toBe("completed")
          expect(done.compose).toEqual([
            {
              id: "map",
              composer: "mapper",
              expanded: true,
              items: 4,
              required_items: 1,
              required_share: 0.25,
              unsplit: 1,
              depth: 2,
              max_depth: 2,
              subtree_nodes: 5,
              subtree_quota: 40,
              subtree_remaining: 35,
            },
          ])
          // The reason is in coverage, on the item's own node.
          expect(done.coverage?.map((entry) => entry.node_id)).toEqual(["map--api--models"])
          expect(done.coverage?.[0]?.reason).toContain("compose split declined")
          expect(done.coverage?.[0]?.reason).toContain("dag.compose.max_depth 2")
        }),
      )
    }),
  )

  it.live("shows a nested plan that degraded as the node that holds it, and the rest of the block as it was", () =>
    Effect.gen(function* () {
      const catalog = yield* builtinAgents
      return yield* runLoopTest(catalog, (services) =>
        Effect.gen(function* () {
          const { dag, loop, store, records } = services
          yield* loop.init()
          const started = yield* runWorkflow(caller(services), startOf(specOf(MAP)))
          const dagID = workflowID(started.output)
          const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
          yield* Deferred.succeed(
            split.release,
            plan([item("api", "explore", { split: true }), item("web", "explore")]),
          )
          const first = yield* take(records, 2, "the nested split node and the plain worker did not start")
          yield* Deferred.succeed(named(first, "map: compose [web]").release, findings("web says"))
          // The nested plan never comes: its split node fails, and the nested slot falls back to one worker.
          yield* dag.nodeFailed(dagID, "map--api--split", "the model gave up", "exec_failed")
          const fallback = yield* awaitWithTimeout(Queue.take(records), "the nested fallback worker did not start")
          expect(fallback.title).toBe("map: compose [api] [fallback]")
          yield* Deferred.succeed(fallback.release, findings("api, alone"))
          const inner = yield* awaitWithTimeout(Queue.take(records), "the nested join node did not start")
          yield* Deferred.succeed(inner.release, projectMap("api joined"))
          const outer = yield* awaitWithTimeout(Queue.take(records), "the join node did not start")
          yield* Deferred.succeed(outer.release, projectMap("everything joined"))
          yield* completed(store, dagID)

          const done = yield* status(services, dagID)
          // The first plan listed two items and was followed; the nested one planned none and degraded.
          expect(done.compose).toEqual([
            {
              id: "map",
              composer: "mapper",
              expanded: true,
              items: 2,
              required_items: 0,
              required_share: 0,
              degraded: [
                {
                  node_id: "map--api",
                  reason: 'the split node "map--api--split" failed: the model gave up',
                },
              ],
              depth: 2,
              max_depth: 2,
              subtree_nodes: 4,
              subtree_quota: 40,
              subtree_remaining: 36,
            },
          ])
          // What the engine persisted is what the summary read.
          const config = parseWorkflowConfig((yield* store.getWorkflow(dagID))?.config ?? "")
          expect(config?.nodes.find((node) => node.id === "map--api")?.join?.degraded).toBe(
            'the split node "map--api--split" failed: the model gave up',
          )
        }),
      )
    }),
  )
})
