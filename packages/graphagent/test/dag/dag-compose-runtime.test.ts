// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- service mocks use the narrow runtime surface exercised here
// #1158 PR3b-1: the loop's admission seam for an expansion slot, with a scripted worker. A compiled compose
// block is created directly (without the authoring check, as in compose-persistence.test.ts); each prompt
// a node receives is handed to the test, which answers it the way the model would, so the split node's plan,
// the children's artifacts and the join node all go through the real spawn and settlement path. PR3b-2 adds
// the nested plans of a recursive composer, and what cancellation and the token budget do to a subtree. The
// last group starts the same expansion through the workflow tool, over a spec file, the way a model does: the
// Workflow Authoring Check, `run.start` and `run.extend`, the expansion, the join and the coverage the parent reads.
import { afterAll, describe, expect } from "bun:test"
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
import { Config } from "@/config/config"
import { DagBlocks } from "@/dag/blocks"
import { WorkflowAuthoring } from "@/dag/authoring"
import { DagBudget } from "@/dag/budget"
import { DagCompose } from "@/dag/compose"
import { DagControl } from "@/dag/control"
import { Dag, type NodeConfig, parseWorkflowConfig } from "@/dag/dag"
import { DagLoop } from "@/dag/runtime/loop"
import type { DagValidation } from "@/dag/validation"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { AgentScheduler } from "@/session/agent-scheduler"
import { controlWorkflow } from "@/tool/workflow/control"
import { inspectWorkflow } from "@/tool/workflow/inspect"
import { runWorkflow } from "@/tool/workflow/run"
import type { ControlParams, InspectParams, RunParams } from "@/tool/workflow/schema"
import { awaitWithTimeout as awaitUntil, it, pollWithTimeout as pollUntil } from "../lib/effect"
import { withIdleAdmission } from "../lib/session-prompt"
import { stubChildren } from "../lib/child-runs"
import { agent, agents, catalog, compose, writerRules } from "./compose-fixtures"
import { transactLayer } from "./fixture/transact"
import { cleanup, failureText, toolContext, workflowID, writeSpec } from "./workflow-harness"

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
  // The user's token budget (#1031): no budget is set, so nothing runs out by itself; a test spends it with `exhaust`
  // and raises it with `onBudgetChanged`, which is what the usage and `/dag-mode budget` end in.
  const config = Layer.mock(Config.Service, { dagGlobal: () => Effect.succeed({} as never) })
  const budget = DagBudget.layer.pipe(Layer.provide(Layer.mergeAll(base, session, config)))
  // What the workflow tool applies a mutation through.
  const control = DagControl.layer.pipe(Layer.provide(base))
  return Layer.mergeAll(base, loop, budget, control)
}

function runLoopTest<A>(
  test: (services: {
    dag: Dag.Interface
    control: DagControl.Interface
    loop: DagLoop.Interface
    store: DagStore.Interface
    budget: DagBudget.Interface
    records: Queue.Queue<PromptRecord>
    harness: Harness
  }) => Effect.Effect<A, Error, Scope.Scope>,
) {
  return Effect.gen(function* () {
    const records = yield* Queue.unbounded<PromptRecord>()
    const harness: Harness = { catalog: agents(), starts: [] }
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const control = yield* DagControl.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const budget = yield* DagBudget.Service
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
      return yield* test({ dag, control, loop, store, budget, records, harness })
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

/** A compose block `survey` (the fan-out surveyor, or the recursive `mapper`), and a node `report` that reads it. */
function route(
  survey: Partial<ConstructorParameters<typeof DagBlocks.WorkflowBlock>[0]> = {},
  worker = "surveyor",
): NodeConfig[] {
  return [
    ...DagCompose.compileNodes(
      DagBlocks.compileWorkflowBlocks({
        objective: "Compare three session persistence designs",
        blocks: [
          new DagBlocks.WorkflowBlock({
            id: "survey",
            kind: "compose",
            worker_type: worker,
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

const failedNode = (store: DagStore.Interface, dagID: string, id: string, message: string) =>
  pollWithTimeout(
    store.getNode(dagID, id).pipe(Effect.map((row) => (row?.status === "failed" ? row : undefined))),
    message,
  )

describe("DagLoop compose join admission", () => {
  it.live("refuses a join node whose required item has no result before any model is asked, and carries on", () =>
    runLoopTest(({ dag, loop, store, records, harness }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* start(dag, route())
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        // `auditor` is an agent whose work is required, so its item is a required item; the block is optional, and
        // so is the child that runs the item: its failure does not fail the workflow, it is the join node that finds it.
        yield* Deferred.succeed(split.release, plan([item("official", "researcher"), item("security", "auditor")]))
        const taken = yield* take(records, 2, "the children did not start")
        yield* dag.nodeFailed(dagID, "survey--security", "the audit crashed", "exec_failed")
        yield* Deferred.succeed(named(taken, child("official")).release, research("official says"))

        const refused = yield* failedNode(store, dagID, "survey", "the join node was not refused")
        expect(refused.errorClass).toBe("compose_required_missing")
        expect(refused.errorReason).toContain('"security" (survey--security: failed)')
        // It never started: no session, no run registered for it, and no prompt for a model.
        expect(refused.childSessionId).toBeNull()
        expect(harness.starts.map((spec) => spec.owner.nodeID)).not.toContain("survey")
        // Its dependent is next, and gets the failure where it would have got the join.
        const report = yield* awaitWithTimeout(Queue.take(records), "the downstream node did not start")
        expect(report.title).toBe("report")
        expect(report.text).toContain("Compose join did not run")
        expect(report.text).toContain("security")
        expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
        yield* Deferred.succeed(report.release, "done")
        yield* pollWithTimeout(
          store.getWorkflow(dagID).pipe(Effect.map((row) => (row?.status === "completed" ? row : undefined))),
          "the workflow did not complete",
        )
        expect(Option.isNone(yield* Queue.poll(records))).toBe(true)
      }),
    ),
  )

  it.live("refuses a join node none of whose children has a result with compose_no_results, and carries on", () =>
    runLoopTest(({ dag, loop, store, records, harness }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* start(dag, route())
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        yield* Deferred.succeed(split.release, plan([item("official", "researcher"), item("code", "explore")]))
        yield* take(records, 2, "the children did not start")
        yield* dag.nodeFailed(dagID, "survey--official", "the source was unreachable", "exec_failed")
        yield* dag.nodeFailed(dagID, "survey--code", "the search timed out", "exec_failed")

        const refused = yield* failedNode(store, dagID, "survey", "the join node was not refused")
        expect(refused.errorClass).toBe("compose_no_results")
        expect(refused.errorReason).toContain("survey--official: failed")
        expect(refused.errorReason).toContain("survey--code: failed")
        expect(harness.starts.map((spec) => spec.owner.nodeID)).not.toContain("survey")
        const report = yield* awaitWithTimeout(Queue.take(records), "the downstream node did not start")
        expect(report.title).toBe("report")
        expect(report.text).toContain("no item produced a result")
        yield* Deferred.succeed(report.release, "done")
        yield* pollWithTimeout(
          store.getWorkflow(dagID).pipe(Effect.map((row) => (row?.status === "completed" ? row : undefined))),
          "the workflow did not complete",
        )
        expect(Option.isNone(yield* Queue.poll(records))).toBe(true)
      }),
    ),
  )

  it.live("refuses the join node of a degraded expansion when its fallback worker fails", () =>
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
        yield* dag.nodeFailed(dagID, "survey--fallback", "the worker gave up", "exec_failed")

        const refused = yield* failedNode(store, dagID, "survey", "the join node was not refused")
        expect(refused.errorClass).toBe("compose_no_results")
        expect(refused.errorReason).toContain("the fallback worker produced no result")
        expect(harness.starts.map((spec) => spec.owner.nodeID)).not.toContain("survey")
        const report = yield* awaitWithTimeout(Queue.take(records), "the downstream node did not start")
        expect(report.title).toBe("report")
        yield* Deferred.succeed(report.release, "done")
        yield* pollWithTimeout(
          store.getWorkflow(dagID).pipe(Effect.map((row) => (row?.status === "completed" ? row : undefined))),
          "the workflow did not complete",
        )
      }),
    ),
  )

  it.live(
    "fails the workflow when the join node of a required block is refused, since it takes the block's semantics",
    () =>
      runLoopTest(({ dag, loop, store, records, harness }) =>
        Effect.gen(function* () {
          yield* loop.init()
          const dagID = yield* start(dag, route({ required: true }))
          const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
          // Both items may be left out, so both children are optional and the scheduler lets the join node become ready.
          yield* Deferred.succeed(split.release, plan([item("official", "researcher"), item("code", "explore")]))
          yield* take(records, 2, "the children did not start")
          yield* dag.nodeFailed(dagID, "survey--official", "the source was unreachable", "exec_failed")
          yield* dag.nodeFailed(dagID, "survey--code", "the search timed out", "exec_failed")

          const refused = yield* failedNode(store, dagID, "survey", "the join node was not refused")
          expect(refused).toMatchObject({ errorClass: "compose_no_results", required: true })
          yield* pollWithTimeout(
            store.getWorkflow(dagID).pipe(Effect.map((row) => (row?.status === "failed" ? row : undefined))),
            "the workflow did not fail",
          )
          // The two children failed first, the refused join node is the last node that failed, and its dependent never ran.
          const rows = new Map((yield* store.getNodes(dagID)).map((row) => [row.id, row]))
          expect(
            [...rows.values()]
              .filter((row) => row.status === "failed")
              .map((row) => row.id)
              .sort(),
          ).toEqual(["survey", "survey--code", "survey--official"])
          expect(rows.get("report")).toMatchObject({ status: "skipped", errorReason: "workflow_failed" })
          expect(harness.starts.map((spec) => spec.owner.nodeID)).not.toContain("survey")
          expect(Option.isNone(yield* Queue.poll(records))).toBe(true)
        }),
      ),
  )
})

// A recursive composer: `mapper` plans, and an item that asks for `split: true` is planned again one level down.
const projectMap = (summary: string) => envelope("project_map", summary, { modules: [], cross_cutting: [] })
const nestedSplit = (id: string) => `${child(id)}: plan the expansion`
const nestedJoin = (id: string) => child(id)
const grandchild = (parent: string, id: string) => `${child(parent)} [${id}]`
const BIG_AND_SMALL = plan([item("big", "explore", { split: true }), item("small", "explore")])
const LEAVES = plan([item("leaf1", "explore"), item("leaf2", "explore", { split: true })])

const completedWorkflow = (store: DagStore.Interface, dagID: string, message = "the workflow did not complete") =>
  pollWithTimeout(
    store.getWorkflow(dagID).pipe(Effect.map((row) => (row?.status === "completed" ? row : undefined))),
    message,
  )

const TERMINAL = new Set(["completed", "failed", "skipped", "aborted"])

describe("DagLoop nested compose expansion", () => {
  it.live("runs a two-level recursive split to completion: the nested plan, the nested join, then the join above", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* start(dag, route({}, "mapper"))
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        expect(split.title).toBe(SPLIT)
        yield* Deferred.succeed(split.release, BIG_AND_SMALL)

        // The nested split node and the plain worker start together; the nested slot waits for its plan.
        const first = yield* take(records, 2, "the nested split node and the plain worker did not start")
        expect(first.map((record) => record.title).sort()).toEqual([child("small"), nestedSplit("big")].sort())
        const plan2 = named(first, nestedSplit("big"))
        // It is asked for the plan of the item's own instruction, one level down, and sees nothing of the plan above.
        expect(plan2.text).toContain("Look into big")
        expect(plan2.text).toContain("Depth 2 of 2")
        expect(plan2.text).not.toContain("Look into small")
        expect(plan2.text).not.toContain("split by source")
        expect(yield* nodeStatus(store, dagID, "survey--big")).toBe("pending")
        yield* Deferred.succeed(named(first, child("small")).release, findings("small says"))
        yield* Deferred.succeed(plan2.release, LEAVES)

        // Its plan is expanded by the same seam. `leaf2` asks to be split once more, and the block may not go deeper.
        const second = yield* take(records, 2, "the nested workers did not start")
        expect(second.map((record) => record.title).sort()).toEqual(
          [grandchild("big", "leaf1"), grandchild("big", "leaf2")].sort(),
        )
        const leaf1 = named(second, grandchild("big", "leaf1"))
        const leaf2 = named(second, grandchild("big", "leaf2"))
        expect(leaf1.text).toContain("Look into leaf1")
        expect(leaf1.text).not.toContain("runs as one worker")
        expect(leaf2.text).toContain("The plan asked to split this item further, but it runs as one worker")
        expect(leaf2.text).toContain("dag.compose.max_depth 2")
        const config = yield* workflowConfig(store, dagID)
        const nodes = new Map(config?.nodes.map((node) => [node.id, node]))
        expect(nodes.get("survey--big")).toMatchObject({
          depends_on: ["survey--big--leaf1", "survey--big--leaf2"],
          compose_subtree: { root: "survey", depth: 2 },
        })
        expect(nodes.get("survey--big")?.expand).toBeUndefined()
        expect(nodes.has("survey--big--leaf2--split")).toBe(false)

        yield* Deferred.succeed(leaf1.release, findings("leaf1 says"))
        yield* Deferred.succeed(leaf2.release, findings("leaf2 says"))
        // The nested join node is the mapper again, with the nested plan and its two results.
        const inner = yield* awaitWithTimeout(Queue.take(records), "the nested join node did not start")
        expect(inner.title).toBe(nestedJoin("big"))
        expect(inner.text).toContain('"survey--big--split"')
        expect(inner.text).toContain("leaf1 says")
        expect(inner.text).toContain("leaf2 says")
        expect(inner.text).toContain("ran as one worker")
        expect(inner.text).toContain("project_map")
        // It was not given the first plan's other item.
        expect(inner.text).not.toContain("small says")
        yield* Deferred.succeed(inner.release, projectMap("big joined"))

        // The join node above reads the nested join as its item `big`, by the id the item always had.
        const outer = yield* awaitWithTimeout(Queue.take(records), "the join node did not start")
        expect(outer.title).toBe(JOIN)
        expect(outer.text).toContain("big joined")
        expect(outer.text).toContain("small says")
        expect(outer.text).toContain('"survey--big": item "big", split again and joined by mapper; may be skipped.')
        yield* Deferred.succeed(outer.release, projectMap("everything joined"))
        const report = yield* awaitWithTimeout(Queue.take(records), "the downstream node did not start")
        expect(report.title).toBe("report")
        expect(report.text).toContain("everything joined")
        yield* Deferred.succeed(report.release, "done")
        yield* completedWorkflow(store, dagID)

        // Every node of the subtree is there once, completed, and the subtree is marked as one.
        const rows = yield* store.getNodes(dagID)
        const final = yield* workflowConfig(store, dagID)
        expect(rows.map((row) => row.id).sort()).toEqual(
          [
            "report",
            "survey",
            "survey--big",
            "survey--big--leaf1",
            "survey--big--leaf2",
            "survey--big--split",
            "survey--small",
            "survey--split",
          ].sort(),
        )
        expect(rows.every((row) => row.status === "completed")).toBe(true)
        expect(
          final?.nodes
            .filter((node) => node.compose_subtree !== undefined)
            .map((node) => `${node.id}@${node.compose_subtree?.depth}`)
            .sort(),
        ).toEqual(
          [
            "survey--big@2",
            "survey--big--leaf1@2",
            "survey--big--leaf2@2",
            "survey--big--split@2",
            "survey--small@1",
          ].sort(),
        )
        expect(Option.isNone(yield* Queue.poll(records))).toBe(true)
      }),
    ),
  )

  it.live("expands two nested slots that become ready together, one after the other, each once", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* start(dag, route({}, "mapper"))
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        yield* Deferred.succeed(
          split.release,
          plan([item("a", "explore", { split: true }), item("b", "explore", { split: true })]),
        )
        const planning = yield* take(records, 2, "the nested split nodes did not start")
        expect(planning.map((record) => record.title).sort()).toEqual([nestedSplit("a"), nestedSplit("b")].sort())
        // Both plans are answered before either slot is expanded: the scheduler finds two slots ready at once, and
        // expands the first (one expansion a round), whose replan brings it back for the second.
        const two = plan([item("x", "explore"), item("y", "explore")])
        yield* Deferred.succeed(named(planning, nestedSplit("a")).release, two)
        yield* Deferred.succeed(named(planning, nestedSplit("b")).release, two)
        const workers = yield* take(records, 4, "the nested workers did not start")
        expect(workers.map((record) => record.title).sort()).toEqual(
          [grandchild("a", "x"), grandchild("a", "y"), grandchild("b", "x"), grandchild("b", "y")].sort(),
        )
        for (const worker of workers) yield* Deferred.succeed(worker.release, findings(`${worker.title} says`))
        const joins = yield* take(records, 2, "the nested join nodes did not start")
        expect(joins.map((record) => record.title).sort()).toEqual([nestedJoin("a"), nestedJoin("b")].sort())
        for (const record of joins) yield* Deferred.succeed(record.release, projectMap(`${record.title} joined`))
        const outer = yield* awaitWithTimeout(Queue.take(records), "the join node did not start")
        expect(outer.title).toBe(JOIN)
        yield* Deferred.succeed(outer.release, projectMap("everything joined"))
        const report = yield* awaitWithTimeout(Queue.take(records), "the downstream node did not start")
        yield* Deferred.succeed(report.release, "done")
        yield* completedWorkflow(store, dagID)
        // One expansion for each slot: every node is there once.
        const ids = (yield* store.getNodes(dagID)).map((row) => row.id)
        expect(new Set(ids).size).toBe(ids.length)
        expect(ids.sort()).toEqual(
          [
            "report",
            "survey",
            "survey--a",
            "survey--a--split",
            "survey--a--x",
            "survey--a--y",
            "survey--b",
            "survey--b--split",
            "survey--b--x",
            "survey--b--y",
            "survey--split",
          ].sort(),
        )
        expect(Option.isNone(yield* Queue.poll(records))).toBe(true)
      }),
    ),
  )

  it.live("degrades a nested slot to its fallback worker when its plan fails, and the workflow carries on", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* start(dag, route({}, "mapper"))
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        yield* Deferred.succeed(split.release, BIG_AND_SMALL)
        const first = yield* take(records, 2, "the nested split node and the plain worker did not start")
        // The nested split node fails: it is optional, so the nested slot is expanded to one fallback worker.
        yield* dag.nodeFailed(dagID, "survey--big--split", "the model gave up", "exec_failed")
        yield* Deferred.succeed(named(first, child("small")).release, findings("small says"))
        const fallback = yield* awaitWithTimeout(Queue.take(records), "the fallback worker did not start")
        expect(fallback.title).toBe(grandchild("big", "fallback"))
        expect(fallback.text).toContain("Look into big")
        expect(fallback.text).toContain("Compose expansion was degraded")
        const config = yield* workflowConfig(store, dagID)
        const nodes = new Map(config?.nodes.map((node) => [node.id, node]))
        expect(nodes.get("survey--big")?.join?.degraded).toBe(
          'the split node "survey--big--split" failed: the model gave up',
        )
        // The fallback is the nested subtree's too, one level down.
        expect(nodes.get("survey--big--fallback")?.compose_subtree).toEqual({ root: "survey", depth: 2 })
        yield* Deferred.succeed(fallback.release, findings("big, alone"))
        const inner = yield* awaitWithTimeout(Queue.take(records), "the nested join node did not start")
        expect(inner.title).toBe(nestedJoin("big"))
        expect(inner.text).toContain("big, alone")
        yield* Deferred.succeed(inner.release, projectMap("big joined"))
        const outer = yield* awaitWithTimeout(Queue.take(records), "the join node did not start")
        expect(outer.title).toBe(JOIN)
        yield* Deferred.succeed(outer.release, projectMap("everything joined"))
        const report = yield* awaitWithTimeout(Queue.take(records), "the downstream node did not start")
        yield* Deferred.succeed(report.release, "done")
        yield* completedWorkflow(store, dagID)
      }),
    ),
  )
})

const allTerminal = (store: DagStore.Interface, dagID: string) =>
  store.getNodes(dagID).pipe(Effect.map((rows) => rows.filter((row) => !TERMINAL.has(row.status)).map((row) => row.id)))

/** Every node and where it stands, as one comparable list. */
const standing = (store: DagStore.Interface, dagID: string) =>
  store.getNodes(dagID).pipe(Effect.map((rows) => rows.map((row) => `${row.id}:${row.status}`).sort()))

const noPrompt = (records: Queue.Queue<PromptRecord>) =>
  // A prompt that never comes cannot be waited for: give a node that would have started time to, and look.
  Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 200))).pipe(
    Effect.andThen(Queue.poll(records)),
    Effect.map((taken) => Option.isNone(taken)),
  )

describe("DagLoop compose cancellation", () => {
  it.live("ends the whole subtree, nested nodes included, when the workflow is cancelled", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* start(dag, route({}, "mapper"))
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        yield* Deferred.succeed(split.release, BIG_AND_SMALL)
        const first = yield* take(records, 2, "the nested split node and the plain worker did not start")
        yield* Deferred.succeed(named(first, nestedSplit("big")).release, LEAVES)
        // Two nested workers are running, and the plain worker of the first plan too; the nested join and everything
        // above it wait.
        const second = yield* take(records, 2, "the nested workers did not start")
        expect((yield* store.getNodes(dagID)).filter((row) => row.status === "running")).toHaveLength(3)

        yield* dag.cancel(dagID)
        yield* pollWithTimeout(
          store.getWorkflow(dagID).pipe(Effect.map((row) => (row?.status === "cancelled" ? row : undefined))),
          "the workflow was not cancelled",
        )
        // Every node of the subtree reached a terminal state: the running ones were aborted, the waiting ones skipped.
        expect(yield* allTerminal(store, dagID)).toEqual([])
        const rows = new Map((yield* store.getNodes(dagID)).map((row) => [row.id, row]))
        const cancelled = yield* standing(store, dagID)
        expect(rows.size).toBe(8)
        for (const id of ["survey--big", "survey", "report"]) expect(rows.get(id)?.status, id).toBe("skipped")
        for (const id of ["survey--big--leaf1", "survey--big--leaf2", "survey--small"])
          expect(rows.get(id)?.status, id).toBe("aborted")

        // A worker that answers after the cancellation changes nothing and starts nothing.
        for (const record of [...first.filter((entry) => entry.title === child("small")), ...second])
          yield* Deferred.succeed(record.release, findings("too late"))
        expect(yield* noPrompt(records)).toBe(true)
        expect(yield* standing(store, dagID)).toEqual(cancelled)
      }),
    ),
  )

  it.live("expands nothing once the workflow is cancelled, though the plan of a nested slot arrives afterwards", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* start(dag, route({}, "mapper"))
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        yield* Deferred.succeed(split.release, BIG_AND_SMALL)
        const first = yield* take(records, 2, "the nested split node and the plain worker did not start")
        yield* dag.cancel(dagID)
        yield* pollWithTimeout(
          store.getWorkflow(dagID).pipe(Effect.map((row) => (row?.status === "cancelled" ? row : undefined))),
          "the workflow was not cancelled",
        )
        const before = yield* standing(store, dagID)
        yield* Deferred.succeed(named(first, nestedSplit("big")).release, LEAVES)
        expect(yield* noPrompt(records)).toBe(true)
        const after = yield* store.getNodes(dagID)
        expect(yield* standing(store, dagID)).toEqual(before)
        expect(after.some((row) => row.id.startsWith("survey--big--leaf"))).toBe(false)
        expect(yield* allTerminal(store, dagID)).toEqual([])
      }),
    ),
  )

  it.live(
    "never expands a nested slot that the parent cancelled before its plan arrived, and carries on without it",
    () =>
      runLoopTest(({ dag, loop, store, records }) =>
        Effect.gen(function* () {
          yield* loop.init()
          const dagID = yield* start(dag, route({}, "mapper"))
          const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
          yield* Deferred.succeed(split.release, BIG_AND_SMALL)
          const first = yield* take(records, 2, "the nested split node and the plain worker did not start")
          // control.cancel_node on the slot that has yet to be expanded.
          yield* dag.nodeCancelled(dagID, "survey--big", "not needed")
          // Its split node still answers, with a plan that would have been expanded.
          yield* Deferred.succeed(named(first, nestedSplit("big")).release, LEAVES)
          yield* Deferred.succeed(named(first, child("small")).release, findings("small says"))
          // The cancelled item is a failure the join node is given where it would have got the nested join; the block
          // and the item are optional, so the join node still runs for what is there.
          const join = yield* awaitWithTimeout(Queue.take(records), "the join node did not start")
          expect(join.title).toBe(JOIN)
          expect(join.text).toContain("small says")
          expect(join.text).toContain("cancelled by agent: not needed")
          yield* Deferred.succeed(join.release, projectMap("joined without big"))
          const report = yield* awaitWithTimeout(Queue.take(records), "the downstream node did not start")
          yield* Deferred.succeed(report.release, "done")
          yield* completedWorkflow(store, dagID)
          const ids = (yield* store.getNodes(dagID)).map((row) => row.id)
          expect(ids.some((id) => id.startsWith("survey--big--leaf"))).toBe(false)
          expect(new Set(ids).size).toBe(ids.length)
          expect(yield* nodeStatus(store, dagID, "survey--big")).toBe("failed")
          expect(Option.isNone(yield* Queue.poll(records))).toBe(true)
        }),
      ),
  )

  it.live("never expands a slot that a replan cancelled before its split node settled", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* start(dag, route())
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        const config = yield* workflowConfig(store, dagID)
        const slot = config?.nodes.find((node) => node.id === "survey")
        const report = config?.nodes.find((node) => node.id === "report")
        if (!slot || !report) throw new Error("the graph is gone")
        // replan `cancel: true`, on the slot and on what reads it.
        yield* dag.replan(dagID, {
          nodes: [
            { ...slot, cancel: true },
            { ...report, cancel: true },
          ],
        })
        yield* Deferred.succeed(split.release, plan([item("official", "researcher"), item("code", "explore")]))
        yield* completedWorkflow(store, dagID, "the workflow did not complete without the cancelled slot")
        // The plan was made and never used: no child was written, none started.
        const rows = yield* store.getNodes(dagID)
        expect(rows.map((row) => row.id).sort()).toEqual(["report", "survey", "survey--split"])
        expect(rows.find((row) => row.id === "survey")).toMatchObject({
          status: "failed",
          errorClass: "cancelled",
          superseded: true,
        })
        expect((yield* workflowConfig(store, dagID))?.nodes.map((node) => node.id)).toEqual(["survey--split"])
        expect(yield* noPrompt(records)).toBe(true)
      }),
    ),
  )
})

const PARENT = SessionID.make("ses_compose_parent")

const pausedForBudget = (store: DagStore.Interface, dagID: string) =>
  pollWithTimeout(
    store.getWorkflow(dagID).pipe(Effect.map((row) => (row?.status === "paused" ? row : undefined))),
    "the workflow was not paused",
  )

const nodeIDs = (store: DagStore.Interface, dagID: string) =>
  workflowConfig(store, dagID).pipe(Effect.map((config) => (config?.nodes ?? []).map((node) => node.id).sort()))

describe("DagLoop compose under the token budget", () => {
  it.live(
    "pauses a subtree for the budget while a nested plan is being made, and resumes it without expanding twice",
    () =>
      runLoopTest(({ dag, loop, store, budget, records }) =>
        Effect.gen(function* () {
          yield* loop.init()
          const dagID = yield* start(dag, route({}, "mapper"))
          const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
          yield* Deferred.succeed(split.release, BIG_AND_SMALL)
          yield* take(records, 2, "the nested split node and the plain worker did not start")
          const idsBefore = yield* nodeIDs(store, dagID)

          // The budget runs out: the workflow is paused with its reason, and the attempts in flight are failed for it.
          expect(yield* budget.exhaust(PARENT)).toBe(1)
          const paused = yield* pausedForBudget(store, dagID)
          expect(paused.pauseReason).toBe("budget_exhausted")
          const rows = new Map((yield* store.getNodes(dagID)).map((row) => [row.id, row]))
          for (const id of ["survey--big--split", "survey--small"])
            expect(rows.get(id), id).toMatchObject({ status: "failed", errorClass: "budget_exhausted" })
          // The nested slot still waits for its plan: a failed split node must not expand it while the workflow is paused.
          expect(rows.get("survey--big")?.status).toBe("pending")
          expect(yield* nodeIDs(store, dagID)).toEqual(idsBefore)
          expect(yield* noPrompt(records)).toBe(true)

          // The user raises the budget: the two attempts are requeued and run afresh, and nothing was expanded meanwhile.
          expect(yield* budget.onBudgetChanged(PARENT)).toBe(1)
          const again = yield* take(records, 2, "the requeued nodes did not start again")
          expect(again.map((record) => record.title).sort()).toEqual([child("small"), nestedSplit("big")].sort())
          expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
          expect(yield* nodeIDs(store, dagID)).toEqual(idsBefore)
          yield* Deferred.succeed(named(again, child("small")).release, findings("small says"))
          yield* Deferred.succeed(named(again, nestedSplit("big")).release, LEAVES)

          // The subtree goes on as if nothing happened: one expansion of the nested slot, and every node once.
          const leaves = yield* take(records, 2, "the nested workers did not start")
          expect(leaves.map((record) => record.title).sort()).toEqual(
            [grandchild("big", "leaf1"), grandchild("big", "leaf2")].sort(),
          )
          for (const leaf of leaves) yield* Deferred.succeed(leaf.release, findings(`${leaf.title} says`))
          const inner = yield* awaitWithTimeout(Queue.take(records), "the nested join node did not start")
          expect(inner.title).toBe(nestedJoin("big"))
          yield* Deferred.succeed(inner.release, projectMap("big joined"))
          const outer = yield* awaitWithTimeout(Queue.take(records), "the join node did not start")
          expect(outer.title).toBe(JOIN)
          yield* Deferred.succeed(outer.release, projectMap("everything joined"))
          const report = yield* awaitWithTimeout(Queue.take(records), "the downstream node did not start")
          yield* Deferred.succeed(report.release, "done")
          yield* completedWorkflow(store, dagID)
          const ids = (yield* store.getNodes(dagID)).map((row) => row.id)
          expect(new Set(ids).size).toBe(ids.length)
          expect(ids.sort()).toEqual([...idsBefore, "survey--big--leaf1", "survey--big--leaf2"].sort())
          expect(Option.isNone(yield* Queue.poll(records))).toBe(true)
        }),
      ),
  )

  it.live("holds the first expansion while the workflow is paused for the budget, and does not degrade the slot", () =>
    runLoopTest(({ dag, loop, store, budget, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const dagID = yield* start(dag, route({}, "mapper"))
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        expect(split.title).toBe(SPLIT)
        // The budget runs out while the first plan is being made: the split node is failed for it.
        expect(yield* budget.exhaust(PARENT)).toBe(1)
        const paused = yield* pausedForBudget(store, dagID)
        expect(paused.pauseReason).toBe("budget_exhausted")
        expect(yield* nodeStatus(store, dagID, "survey--split")).toBe("failed")
        // The optional split node failed, which would send its slot to the fallback worker, but nothing may be expanded now.
        expect(yield* noPrompt(records)).toBe(true)
        expect(yield* nodeIDs(store, dagID)).toEqual(["report", "survey", "survey--split"])
        expect((yield* workflowConfig(store, dagID))?.nodes.find((node) => node.id === "survey")?.expand).toBe(
          "survey--split",
        )

        // Raised: the split node is asked again, and its plan is expanded, not the fallback.
        expect(yield* budget.onBudgetChanged(PARENT)).toBe(1)
        const again = yield* awaitWithTimeout(Queue.take(records), "the split node was not asked again")
        expect(again.title).toBe(SPLIT)
        yield* Deferred.succeed(again.release, plan([item("big", "explore"), item("small", "explore")]))
        const taken = yield* take(records, 2, "the children did not start")
        expect(taken.map((record) => record.title).sort()).toEqual([child("big"), child("small")].sort())
        expect(yield* nodeIDs(store, dagID)).toEqual([
          "report",
          "survey",
          "survey--big",
          "survey--small",
          "survey--split",
        ])
        expect(
          (yield* workflowConfig(store, dagID))?.nodes.find((node) => node.id === "survey")?.join?.degraded,
        ).toBeUndefined()
      }),
    ),
  )
})

// ---------------------------------------------------------------------------------------------------------------------
// The same expansion, reached the way a model reaches it: a spec file the workflow tool starts or extends with. Nothing
// below builds a graph by hand, so the Workflow Authoring Check, the durable create or extend, the scheduler's
// expansion, the join and the coverage section sit on one path.
// ---------------------------------------------------------------------------------------------------------------------
describe("a compose block submitted through the workflow tool", () => {
  afterAll(cleanup)

  const OBJECTIVE = "Compare three session persistence designs"
  const DECIDE = "decide: plan"
  const PARENT_SESSION = "ses_compose_parent"

  const environment = (list: DagCompose.CatalogAgent[]): DagValidation.EnvironmentCatalogs => ({
    worker_types: new Set([...list.map((entry) => entry.name), "plan", "build", "general"]),
    composers: DagCompose.catalogFrom(list),
  })

  /** What the tool is called with: the live agent catalog of the harness, so a test may change it between calls. */
  const caller = (services: { dag: Dag.Interface; control: DagControl.Interface; harness: Harness }) => ({
    dag: services.dag,
    control: services.control,
    authoring: WorkflowAuthoring.make({
      loadEnvironment: () => Effect.sync(() => environment(services.harness.catalog)),
    }),
    sessionID: PARENT_SESSION,
    session: { directory: process.cwd(), projectID: Project.ID.global, model: undefined },
    ctx: toolContext(PARENT_SESSION, "build"),
  })

  const SURVEY = { id: "survey", kind: "compose", worker_type: "surveyor", instruction: "Compare the designs" }
  const DECIDE_BLOCK = { id: "decide", kind: "plan", depends_on: ["survey"], instruction: "Choose one design" }
  const specOf = (...blocks: unknown[]) => writeSpec({ config: { name: "survey-route", objective: OBJECTIVE, blocks } })
  const startOf = (specPath: string) => ({ action: "run", operation: "start", spec_path: specPath }) as RunParams

  const completed = (store: DagStore.Interface, dagID: string) =>
    pollWithTimeout(
      store.getWorkflow(dagID).pipe(Effect.map((row) => (row?.status === "completed" ? row : undefined))),
      "the workflow did not complete",
    )

  const status = (dag: Dag.Interface, dagID: string) =>
    inspectWorkflow({ dag, sessionID: PARENT_SESSION }, {
      action: "inspect",
      operation: "status",
      workflow_id: dagID,
    } as InspectParams).pipe(
      Effect.map(
        (result) =>
          JSON.parse(result.output) as {
            status: string
            coverage?: { node_id: string; reason: string }[]
            nodes: { id: string; status: string; error_class?: string }[]
          },
      ),
    )

  it.live("runs a block a model wrote from run.start to the join node: check, expansion, join, downstream", () =>
    runLoopTest((services) =>
      Effect.gen(function* () {
        const { dag, loop, store, records } = services
        yield* loop.init()
        const started = yield* runWorkflow(caller(services), startOf(specOf(SURVEY, DECIDE_BLOCK)))
        expect(started.metadata?.blocked).toBeUndefined()
        expect(started.output).toContain("3 nodes registered")
        const dagID = workflowID(started.output)
        // What the check prepared is what was stored: the split node and the slot, the marker on the slot alone.
        const stored = yield* workflowConfig(store, dagID)
        expect(stored?.nodes.map((node) => node.id)).toEqual(["survey--split", "survey", "decide"])
        expect(stored?.nodes.filter((node) => node.expand !== undefined).map((node) => node.id)).toEqual(["survey"])

        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        expect(split.title).toBe(SPLIT)
        // The plan the composer is asked for is bounded by the catalog the check compiled against.
        expect(split.text).toContain("researcher")
        yield* Deferred.succeed(split.release, plan([item("official", "researcher"), item("code", "explore")]))
        const taken = yield* take(records, 2, "the children did not start")
        expect(taken.map((record) => record.title).sort()).toEqual([child("code"), child("official")])
        yield* Deferred.succeed(named(taken, child("official")).release, research("official says"))
        yield* Deferred.succeed(named(taken, child("code")).release, findings("code says"))
        const join = yield* awaitWithTimeout(Queue.take(records), "the join node did not start")
        expect(join.title).toBe(JOIN)
        expect(join.text).toContain("official says")
        expect(join.text).toContain("code says")
        yield* Deferred.succeed(join.release, surveyReport("joined"))
        const decide = yield* awaitWithTimeout(Queue.take(records), "the downstream block did not start")
        expect(decide.title).toBe(DECIDE)
        expect(decide.text).toContain("joined")
        yield* Deferred.succeed(decide.release, "decided")
        yield* completed(store, dagID)

        // The expansion followed its plan: nothing degraded, nothing was left unsplit, nothing failed.
        const view = yield* status(dag, dagID)
        expect(view.status).toBe("completed")
        expect(view.coverage).toBeUndefined()
        expect(view.nodes.map((node) => node.id).sort()).toEqual(
          ["decide", "survey", "survey--code", "survey--official", "survey--split"].sort(),
        )
        expect(view.nodes.every((node) => node.status === "completed")).toBe(true)
        expect(Option.isNone(yield* Queue.poll(records))).toBe(true)
      }),
    ),
  )

  it.live("refuses a start whose composer the catalog cannot run, names the agent and why, and creates nothing", () =>
    runLoopTest((services) =>
      Effect.gen(function* () {
        const { loop, store, harness } = services
        yield* loop.init()
        // A user-level explore.md that lets explore write: public no more, so mapper has nothing to dispatch to.
        harness.catalog = agents().map((entry) =>
          entry.name === "explore" ? agent("explore", { permission: writerRules, contract: entry.contract }) : entry,
        )
        const refused = yield* failureText(
          runWorkflow(caller(services), startOf(specOf({ id: "map-repo", kind: "compose", worker_type: "mapper" }))),
        )
        expect(refused).toContain('compose block "map-repo": composer "mapper" is unavailable')
        expect(refused).toContain('agent "explore"')
        expect(refused).toContain("can write files")
        expect(yield* store.listWorkflows()).toEqual([])
        // A worker that is no composer is refused too, and a block with no worker_type at all.
        const worker = yield* failureText(
          runWorkflow(caller(services), startOf(specOf({ ...SURVEY, worker_type: "researcher" }))),
        )
        expect(worker).toContain('agent "researcher" is not a composer')
        const { worker_type: _worker, ...bare } = SURVEY
        const missing = yield* failureText(runWorkflow(caller(services), startOf(specOf(bare))))
        expect(missing).toContain('Block "survey" (compose) requires worker_type')
        expect(yield* store.listWorkflows()).toEqual([])
      }),
    ),
  )

  it.live("extends a live workflow with a compose block, which expands once the block it depends on is done", () =>
    runLoopTest((services) =>
      Effect.gen(function* () {
        const { loop, store, records } = services
        yield* loop.init()
        const context = caller(services)
        const started = yield* runWorkflow(
          context,
          startOf(
            writeSpec({
              config: { name: "map-first", objective: OBJECTIVE, blocks: [{ id: "map", kind: "explore" }] },
            }),
          ),
        )
        const dagID = workflowID(started.output)
        const map = yield* awaitWithTimeout(Queue.take(records), "the map node did not start")
        const extended = yield* runWorkflow(context, {
          action: "run",
          operation: "extend",
          workflow_id: dagID,
          spec_path: writeSpec({ objective: OBJECTIVE, blocks: [{ ...SURVEY, depends_on: ["map"] }] }),
        } as RunParams)
        expect(extended.output).toContain("Added: survey--split, survey")
        const config = yield* workflowConfig(store, dagID)
        expect(config?.nodes.find((node) => node.id === "survey")?.expand).toBe("survey--split")

        // Nothing of the extension runs before the block it depends on is done.
        expect(Option.isNone(yield* Queue.poll(records))).toBe(true)
        yield* Deferred.succeed(map.release, "mapped")
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        expect(split.title).toBe(SPLIT)
        yield* Deferred.succeed(split.release, plan([item("official", "researcher"), item("code", "explore")]))
        const taken = yield* take(records, 2, "the children did not start")
        yield* Deferred.succeed(named(taken, child("official")).release, research("official says"))
        yield* Deferred.succeed(named(taken, child("code")).release, findings("code says"))
        const join = yield* awaitWithTimeout(Queue.take(records), "the join node did not start")
        expect(join.title).toBe(JOIN)
        yield* Deferred.succeed(join.release, surveyReport("joined"))
        yield* completed(store, dagID)
      }),
    ),
  )

  it.live("adds a compose block with a replan fragment, which expands the same way", () =>
    runLoopTest((services) =>
      Effect.gen(function* () {
        const { loop, store, records } = services
        yield* loop.init()
        const context = caller(services)
        const started = yield* runWorkflow(
          context,
          startOf(
            writeSpec({
              config: { name: "map-first", objective: OBJECTIVE, blocks: [{ id: "map", kind: "explore" }] },
            }),
          ),
        )
        const dagID = workflowID(started.output)
        const map = yield* awaitWithTimeout(Queue.take(records), "the map node did not start")
        const replanned = yield* controlWorkflow(context, {
          action: "control",
          operation: "replan",
          workflow_id: dagID,
          spec_path: writeSpec({
            fragment: { name: "survey-too", objective: OBJECTIVE, blocks: [{ ...SURVEY, depends_on: ["map"] }] },
          }),
        } as ControlParams)
        expect(replanned.output).toContain("Added: survey--split, survey")
        const config = yield* workflowConfig(store, dagID)
        expect(config?.nodes.find((node) => node.id === "survey")?.expand).toBe("survey--split")

        yield* Deferred.succeed(map.release, "mapped")
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        expect(split.title).toBe(SPLIT)
        yield* Deferred.succeed(split.release, plan([item("official", "researcher"), item("code", "explore")]))
        const taken = yield* take(records, 2, "the children did not start")
        yield* Deferred.succeed(named(taken, child("official")).release, research("official says"))
        yield* Deferred.succeed(named(taken, child("code")).release, findings("code says"))
        const join = yield* awaitWithTimeout(Queue.take(records), "the join node did not start")
        expect(join.title).toBe(JOIN)
        yield* Deferred.succeed(join.release, surveyReport("joined"))
        yield* completed(store, dagID)
      }),
    ),
  )

  it.live("lists a degraded expansion in the coverage the parent reads, beside the split node that failed", () =>
    runLoopTest((services) =>
      Effect.gen(function* () {
        const { dag, loop, store, records } = services
        yield* loop.init()
        const started = yield* runWorkflow(caller(services), startOf(specOf(SURVEY, DECIDE_BLOCK)))
        const dagID = workflowID(started.output)
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        expect(split.title).toBe(SPLIT)
        yield* dag.nodeFailed(dagID, "survey--split", "the model gave up", "exec_failed")
        const fallback = yield* awaitWithTimeout(Queue.take(records), "the fallback worker did not start")
        expect(fallback.title).toBe(child("fallback"))
        yield* Deferred.succeed(fallback.release, research("everything, alone"))
        const join = yield* awaitWithTimeout(Queue.take(records), "the join node did not start")
        yield* Deferred.succeed(join.release, surveyReport("joined"))
        const decide = yield* awaitWithTimeout(Queue.take(records), "the downstream block did not start")
        yield* Deferred.succeed(decide.release, "decided")
        yield* completed(store, dagID)

        const view = yield* status(dag, dagID)
        expect(view.status).toBe("completed")
        expect(view.coverage).toEqual([
          { node_id: "survey--split", reason: "failed: exec_failed: the model gave up" },
          {
            node_id: "survey",
            reason: 'compose expansion degraded: the split node "survey--split" failed: the model gave up',
          },
        ])
      }),
    ),
  )

  it.live("lists a join the admission check refused, with its error class and the item that is missing", () =>
    runLoopTest((services) =>
      Effect.gen(function* () {
        const { dag, loop, store, records } = services
        yield* loop.init()
        const started = yield* runWorkflow(caller(services), startOf(specOf(SURVEY, DECIDE_BLOCK)))
        const dagID = workflowID(started.output)
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        // `auditor` is an agent whose work is required: in this optional block its child stays optional, and it is
        // the join node's admission check that finds the item missing.
        yield* Deferred.succeed(split.release, plan([item("official", "researcher"), item("security", "auditor")]))
        const taken = yield* take(records, 2, "the children did not start")
        yield* dag.nodeFailed(dagID, "survey--security", "the audit crashed", "exec_failed")
        yield* Deferred.succeed(named(taken, child("official")).release, research("official says"))
        const refused = yield* pollWithTimeout(
          store.getNode(dagID, "survey").pipe(Effect.map((row) => (row?.status === "failed" ? row : undefined))),
          "the join node was not refused",
        )
        expect(refused.errorClass).toBe("compose_required_missing")
        // The optional join node failed, so its dependent runs on the failure as its placeholder and the workflow ends.
        const decide = yield* awaitWithTimeout(Queue.take(records), "the downstream block did not start")
        yield* Deferred.succeed(decide.release, "decided")
        yield* completed(store, dagID)

        const view = yield* status(dag, dagID)
        // The refused join node is a failed node, listed with its error class and reason like any other; coverage adds
        // no second entry for it.
        expect(view.coverage?.map((entry) => entry.node_id).sort()).toEqual(["survey", "survey--security"])
        expect(view.coverage?.find((entry) => entry.node_id === "survey--security")?.reason).toBe(
          "failed: exec_failed: the audit crashed",
        )
        expect(view.coverage?.find((entry) => entry.node_id === "survey")?.reason).toBe(
          'failed: compose_required_missing: Compose join did not run: required item "security" (survey--security: failed) produced no result',
        )
      }),
    ),
  )
})
