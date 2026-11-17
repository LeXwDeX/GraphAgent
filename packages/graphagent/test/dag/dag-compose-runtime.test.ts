// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- service mocks use the narrow runtime surface exercised here
// #1158 PR3b-1: the loop's admission seam for an expansion slot, with a scripted worker. A compiled compose
// block is created directly (the authoring gate is bypassed, as in compose-persistence.test.ts); each prompt
// a node receives is handed to the test, which answers it the way the model would, so the split node's plan,
// the children's artifacts and the join node all go through the real spawn and settlement path.
import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue, Scope } from "effect"
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
import { DagBlocks } from "@/dag/blocks"
import { DagCompose } from "@/dag/compose"
import { Dag, type NodeConfig, parseWorkflowConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { AgentScheduler } from "@/session/agent-scheduler"
import { awaitWithTimeout as awaitUntil, it, pollWithTimeout as pollUntil } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"
import { stubChildren } from "../lib/child-runs"
import { agent, agents, catalog, compose } from "./compose-fixtures"
import { transactLayer } from "./fixture/transact"

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

interface RunSpec {
  readonly owner: { readonly nodeID: string }
  readonly permission: { readonly ask?: string; readonly workspaceWrites?: string }
}

function reply(sessionID: string, text = "done"): SessionV1.WithParts {
  return {
    info: { id: MessageID.ascending(), sessionID, role: "assistant", time: { created: Date.now() } },
    parts: [{ type: "text", text }],
  } as never
}

interface Harness {
  /** The agents the catalog holds now; a test may change it between rounds. */
  catalog: DagCompose.CatalogAgent[]
  readonly starts: RunSpec[]
}

function runtimeLayer(records: Queue.Queue<PromptRecord>, harness: Harness) {
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
        const id = `ses_compose_child_${++created}`
        titles.set(id, (input?.title ?? id).replace(" (DAG node)", ""))
        return { id } as never
      }),
    messages: () => Effect.succeed([]),
  })
  const deliver = Effect.fn("test.SessionPrompt.compose")(function* (input: SessionPrompt.PromptInput) {
    const sessionID = input.sessionID as string
    if (sessionID === "ses_compose_parent") return reply(sessionID)
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
  const built = stubChildren(impl)
  // What the engine registers each node's run with: its permission policy is where `workspace_writes` lands.
  const children = {
    ...built.children,
    forParent: (parentSessionID: SessionID) => {
      const scoped = built.children.forParent(parentSessionID)
      return {
        ...scoped,
        start: (spec: Parameters<typeof scoped.start>[0]) => {
          harness.starts.push(spec as never)
          return scoped.start(spec)
        },
      }
    },
  }
  const prompt = Layer.mock(SessionPrompt.Service, { ...impl, children: Effect.succeed(children) } as never)
  const agent = Layer.mock(Agent.Service, {
    list: () => Effect.sync(() => harness.catalog as never),
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
  return Layer.merge(base, loop)
}

function runLoopTest<A>(
  test: (services: {
    dag: Dag.Interface
    loop: DagLoop.Interface
    store: DagStore.Interface
    records: Queue.Queue<PromptRecord>
    harness: Harness
  }) => Effect.Effect<A, Error, Scope.Scope>,
) {
  return Effect.gen(function* () {
    const records = yield* Queue.unbounded<PromptRecord>()
    const harness: Harness = { catalog: agents(), starts: [] }
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
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
          id: SessionID.make("ses_compose_parent"),
          project_id: Project.ID.global,
          slug: "compose-parent",
          directory: process.cwd(),
          title: "Compose parent",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      return yield* test({ dag, loop, store, records, harness })
    }).pipe(
      Effect.provide(runtimeLayer(records, harness)),
      Effect.provideService(InstanceRef, {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: { id: Project.ID.global },
      } as never),
      Effect.scoped,
    )
  })
}

/** A compose block `survey` (the surveyor), and a node `report` that reads it. */
function route(survey: Partial<ConstructorParameters<typeof DagBlocks.WorkflowBlock>[0]> = {}): NodeConfig[] {
  return [
    ...DagCompose.compileNodes(
      DagBlocks.compileWorkflowBlocks({
        objective: "Compare three session persistence designs",
        blocks: [
          new DagBlocks.WorkflowBlock({
            id: "survey",
            kind: "compose",
            worker_type: "surveyor",
            instruction: "Compare the designs",
            ...survey,
          }),
        ],
      }),
      catalog(),
      DagCompose.DEFAULT_LIMITS,
    ).nodes,
    {
      id: "report",
      name: "report",
      worker_type: "build",
      depends_on: ["survey"],
      required: true,
      prompt_template: { inline: "Report on {{survey}}" },
    },
  ]
}

const SPLIT = "survey: compose: plan the expansion"
const JOIN = "survey: compose"
const child = (id: string) => `survey: compose [${id}]`

const item = (id: string, agent: string, extra: Record<string, unknown> = {}) => ({
  id,
  agent,
  instruction: `Look into ${id}`,
  ...extra,
})
const plan = (items: unknown[]) => JSON.stringify({ rationale: "split by source", items, not_planned: [] })

const envelope = (artifact: string, summary: string, body: unknown) =>
  JSON.stringify({ artifact, summary, body, evidence: [], not_examined: [] })
const research = (summary: string) =>
  envelope("research_findings", summary, {
    question: "q",
    answers: [{ claim: summary, sources: ["https://example.com/a"] }],
    conflicts: [],
  })
const findings = (summary: string) =>
  envelope("code_findings", summary, { scope: "src", findings: [{ claim: summary, refs: ["/src/a.ts:1"] }] })
const surveyReport = (summary: string) =>
  envelope("survey_report", summary, { question: "q", comparison: [], recommendation: "go" })

const take = (records: Queue.Queue<PromptRecord>, count: number, message: string) =>
  Effect.forEach(Array.from({ length: count }), () => awaitWithTimeout(Queue.take(records), message))

const named = (taken: readonly PromptRecord[], title: string) => {
  const found = taken.find((record) => record.title === title)
  if (!found) throw new Error(`no prompt for "${title}" among ${taken.map((record) => record.title).join(", ")}`)
  return found
}

const nodeStatus = (store: DagStore.Interface, dagID: string, id: string) =>
  store.getNode(dagID, id).pipe(Effect.map((row) => row?.status))

const workflowConfig = (store: DagStore.Interface, dagID: string) =>
  store.getWorkflow(dagID).pipe(Effect.map((row) => parseWorkflowConfig(row?.config ?? "")))

const start = (dag: Dag.Interface, nodes: NodeConfig[], extra: Record<string, unknown> = {}) =>
  dag.create({
    projectID: Project.ID.global,
    sessionID: "ses_compose_parent",
    title: "compose runtime",
    config: { name: "compose-runtime", ...extra, nodes },
  })

describe("DagLoop compose expansion", () => {
  it.live(
    "does not start the slot before the split node settles, then replaces it with children and the join node",
    () =>
      runLoopTest(({ dag, loop, store, records }) =>
        Effect.gen(function* () {
          yield* loop.init()
          const dagID = yield* start(dag, route())
          const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
          expect(split.title).toBe(SPLIT)
          // The plan is being made: the slot waits, and nothing else has been started on its behalf.
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)))
          expect(Option.isNone(yield* Queue.poll(records))).toBe(true)
          expect(yield* nodeStatus(store, dagID, "survey")).toBe("pending")
          expect((yield* workflowConfig(store, dagID))?.nodes.find((node) => node.id === "survey")?.expand).toBe(
            "survey--split",
          )

          yield* Deferred.succeed(
            split.release,
            plan([item("official", "researcher"), item("code", "explore"), item("security", "auditor")]),
          )
          const taken = yield* take(records, 3, "the children did not start")
          expect(taken.map((record) => record.title).sort()).toEqual(
            [child("code"), child("official"), child("security")].sort(),
          )
          // The prompt a child gets is its instruction and the read-only rules, not the plan or the other items.
          const official = named(taken, child("official"))
          expect(official.text).toContain("Look into official")
          expect(official.text).toContain("You run read-only")
          expect(official.text).not.toContain("Look into code")
          expect(official.text).not.toContain("rationale")
          expect(official.text).toContain("research_findings")

          const config = yield* workflowConfig(store, dagID)
          const nodes = new Map(config?.nodes.map((node) => [node.id, node]))
          expect(nodes.get("survey")?.expand).toBeUndefined()
          expect(nodes.get("survey")?.depends_on).toEqual(["survey--official", "survey--code", "survey--security"])
          // Downstream bindings were not rewritten.
          expect(nodes.get("report")?.depends_on).toEqual(["survey"])
          expect(yield* nodeStatus(store, dagID, "survey")).toBe("pending")

          yield* Deferred.succeed(official.release, research("official says"))
          yield* Deferred.succeed(named(taken, child("code")).release, findings("code says"))
          yield* Deferred.succeed(named(taken, child("security")).release, "security says")
          const join = yield* awaitWithTimeout(Queue.take(records), "the join node did not start")
          expect(join.title).toBe(JOIN)
          // It sees the plan and every child's result by node id, and is told what each key is.
          expect(join.text).toContain('"survey--split"')
          expect(join.text).toContain("split by source")
          expect(join.text).toContain("official says")
          expect(join.text).toContain("code says")
          expect(join.text).toContain("security says")
          expect(join.text).toContain('"survey--official": item "official", by researcher; may be skipped.')
          expect(join.text).toContain("survey_report")
          // The block's own task is still its prompt.
          expect(join.text).toContain("Compare the designs")

          yield* Deferred.succeed(join.release, surveyReport("joined"))
          const report = yield* awaitWithTimeout(Queue.take(records), "the downstream node did not start")
          expect(report.title).toBe("report")
          expect(report.text).toContain("joined")
          yield* Deferred.succeed(report.release, "done")
          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(Effect.map((row) => (row?.status === "completed" ? row : undefined))),
            "the workflow did not complete",
          )
          expect(Option.isNone(yield* Queue.poll(records))).toBe(true)
        }),
      ),
  )

  it.live("runs every composed node read-only: split, children and join are registered with workspaceWrites deny", () =>
    runLoopTest(({ dag, loop, records, harness }) =>
      Effect.gen(function* () {
        yield* loop.init()
        yield* start(dag, route())
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        yield* Deferred.succeed(split.release, plan([item("official", "researcher"), item("code", "explore")]))
        const taken = yield* take(records, 2, "the children did not start")
        for (const record of taken)
          yield* Deferred.succeed(record.release, record.title === child("code") ? findings("c") : research("o"))
        const join = yield* awaitWithTimeout(Queue.take(records), "the join node did not start")
        yield* Deferred.succeed(join.release, surveyReport("joined"))
        const policies = new Map(harness.starts.map((spec) => [spec.owner.nodeID, spec.permission]))
        expect([...policies.keys()].sort()).toEqual(["survey", "survey--code", "survey--official", "survey--split"])
        for (const [nodeID, permission] of policies)
          expect(permission, nodeID).toEqual({ ask: "auto", workspaceWrites: "deny" })
      }),
    ),
  )

  it.live("lets a skippable child fail: the join node still runs, with the failure as its placeholder", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* start(dag, route())
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        yield* Deferred.succeed(split.release, plan([item("official", "researcher"), item("code", "explore")]))
        const taken = yield* take(records, 2, "the children did not start")
        yield* dag.nodeFailed(dagID, "survey--official", "the source was unreachable", "exec_failed")
        yield* Deferred.succeed(named(taken, child("code")).release, findings("code says"))
        const join = yield* awaitWithTimeout(Queue.take(records), "the join node did not start")
        expect(join.title).toBe(JOIN)
        expect(join.text).toContain('Dependency \\"survey--official\\" failed: the source was unreachable')
        expect(join.text).toContain("code says")
        yield* Deferred.succeed(join.release, surveyReport("joined without official"))
        const report = yield* awaitWithTimeout(Queue.take(records), "the downstream node did not start")
        yield* Deferred.succeed(report.release, "done")
        yield* pollWithTimeout(
          store.getWorkflow(dagID).pipe(Effect.map((row) => (row?.status === "completed" ? row : undefined))),
          "the workflow did not complete",
        )
      }),
    ),
  )

  it.live("fails the workflow at a required child of a required block, and the join node never runs", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* start(dag, route({ required: true }))
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        // `auditor` is an agent whose work is required, so its item is a required child.
        yield* Deferred.succeed(split.release, plan([item("official", "researcher"), item("security", "auditor")]))
        const taken = yield* take(records, 2, "the children did not start")
        const config = yield* workflowConfig(store, dagID)
        expect(new Map(config?.nodes.map((node) => [node.id, node.required])).get("survey--security")).toBe(true)
        yield* dag.nodeFailed(dagID, "survey--security", "the audit crashed", "exec_failed")
        // The workflow ends once every node has settled: the skippable sibling still runs until it answers.
        yield* Deferred.succeed(named(taken, child("official")).release, research("late"))
        yield* pollWithTimeout(
          store.getWorkflow(dagID).pipe(Effect.map((row) => (row?.status === "failed" ? row : undefined))),
          "the workflow did not fail",
        )
        // The failure is the child's: it is the one node that failed, and the join node and its dependent never ran.
        const rows = new Map((yield* store.getNodes(dagID)).map((row) => [row.id, row]))
        expect([...rows.values()].filter((row) => row.status === "failed").map((row) => row.id)).toEqual([
          "survey--security",
        ])
        expect(rows.get("survey--security")?.errorReason).toBe("the audit crashed")
        for (const id of ["survey", "report"]) {
          expect(rows.get(id), id).toMatchObject({
            status: "skipped",
            errorReason: "workflow_failed",
            childSessionId: null,
          })
        }
        expect(Option.isNone(yield* Queue.poll(records))).toBe(true)
      }),
    ),
  )

  it.live(
    "degrades to one fallback worker when the catalog no longer allows the plan, without failing or pausing",
    () =>
      runLoopTest(({ dag, loop, store, records, harness }) =>
        Effect.gen(function* () {
          yield* loop.init()
          const dagID = yield* start(dag, route())
          const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
          // The plan is valid for the schema the split node was given; by the time it is expanded, `researcher` is private.
          harness.catalog = [
            ...agents().filter((entry) => entry.name !== "researcher" && entry.name !== "surveyor"),
            agent("researcher", { contract: { visibility: "private", output: { artifact: "research_findings" } } }),
            agent("surveyor", {
              contract: {
                role: "composer",
                output: { artifact: "survey_report" },
                compose: compose("fan_out", ["researcher", "explore"], "explore"),
              },
            }),
          ]
          yield* Deferred.succeed(split.release, plan([item("official", "researcher"), item("code", "explore")]))
          const fallback = yield* awaitWithTimeout(Queue.take(records), "the fallback worker did not start")
          expect(fallback.title).toBe(child("fallback"))
          expect(fallback.text).toContain("Compare the designs")
          expect(fallback.text).toContain("Compose expansion was degraded")
          expect(fallback.text).toContain("code_findings")
          const config = yield* workflowConfig(store, dagID)
          const nodes = new Map(config?.nodes.map((node) => [node.id, node]))
          expect(nodes.get("survey--fallback")?.worker_type).toBe("explore")
          expect(nodes.get("survey")?.join?.degraded).toContain("the plan was rejected")
          expect([...nodes.keys()].some((id) => id === "survey--official")).toBe(false)

          yield* Deferred.succeed(fallback.release, findings("everything, alone"))
          const join = yield* awaitWithTimeout(Queue.take(records), "the join node did not start")
          expect(join.text).toContain("Compose expansion was degraded")
          expect(join.text).toContain("everything, alone")
          yield* Deferred.succeed(join.release, surveyReport("joined"))
          const report = yield* awaitWithTimeout(Queue.take(records), "the downstream node did not start")
          yield* Deferred.succeed(report.release, "done")
          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(Effect.map((row) => (row?.status === "completed" ? row : undefined))),
            "the workflow did not complete",
          )
        }),
      ),
  )

  it.live("degrades when the split node fails, since a failed split must not fail the workflow", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* start(dag, route())
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        expect(split.title).toBe(SPLIT)
        yield* dag.nodeFailed(dagID, "survey--split", "the model gave up", "exec_failed")
        const fallback = yield* awaitWithTimeout(Queue.take(records), "the fallback worker did not start")
        expect(fallback.title).toBe(child("fallback"))
        expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
        const config = yield* workflowConfig(store, dagID)
        expect(config?.nodes.find((node) => node.id === "survey")?.join?.degraded).toBe(
          'the split node "survey--split" failed: the model gave up',
        )
      }),
    ),
  )

  it.live("fails an optional slot with compose_capacity when nothing fits, and the workflow carries on", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        // split, slot and report fill the three nodes the workflow may have: not even the fallback worker fits.
        const dagID = yield* start(dag, route(), { max_total_nodes: 3 })
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        yield* Deferred.succeed(split.release, plan([item("official", "researcher"), item("code", "explore")]))
        const failed = yield* pollWithTimeout(
          store.getNode(dagID, "survey").pipe(Effect.map((row) => (row?.status === "failed" ? row : undefined))),
          "the slot did not fail",
        )
        expect(failed.errorClass).toBe("compose_capacity")
        // The failed optional slot reaches its dependent as a placeholder; the workflow is neither failed nor paused.
        const report = yield* awaitWithTimeout(Queue.take(records), "the downstream node did not start")
        expect(report.title).toBe("report")
        expect(report.text).toContain("Compose expansion does not fit the graph")
        expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
        yield* Deferred.succeed(report.release, "done")
        yield* pollWithTimeout(
          store.getWorkflow(dagID).pipe(Effect.map((row) => (row?.status === "completed" ? row : undefined))),
          "the workflow did not complete",
        )
      }),
    ),
  )
})
