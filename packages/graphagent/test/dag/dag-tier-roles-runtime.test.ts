// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- service mocks use the narrow runtime surface exercised here
// #1158 PR4a: what the real scheduling loop does with a node's role. Two things are pinned here, both through the
// loop with a scripted worker. (1) The model tier of a node follows its role, not its `required` flag: the model each
// child session is prompted with is read off the prompt. (2) A writer block that leaves `required` out is required
// (D9), so its failure fails the workflow at the writer, and a `fan_out` package writer is as required as its block.
import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue, Scope } from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
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
import { transactLayer } from "./fixture/transact"

// Every wait returns as soon as its state is reached, so the bound only decides how long a real failure takes to report.
const STALL_TOLERANCE = "20 seconds"
const awaitWithTimeout = <A, E, R>(self: Effect.Effect<A, E, R>, message: string) =>
  awaitUntil(self, message, STALL_TOLERANCE)
const pollWithTimeout = <A, E, R>(self: Effect.Effect<A | undefined, E, R>, message: string | (() => string)) =>
  pollUntil(self, message, STALL_TOLERANCE)

const ADVANCED = { providerID: "tier", modelID: "advanced" }
const STANDARD = { providerID: "tier", modelID: "standard" }

interface PromptRecord {
  readonly title: string
  readonly text: string
  readonly model: unknown
  readonly release: Deferred.Deferred<string>
}

function reply(sessionID: string, text = "done"): SessionV1.WithParts {
  return {
    info: { id: MessageID.ascending(), sessionID, role: "assistant", time: { created: Date.now() } },
    parts: [{ type: "text", text }],
  } as never
}

function runtimeLayer(records: Queue.Queue<PromptRecord>) {
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
        const id = `ses_tier_child_${++created}`
        titles.set(id, (input?.title ?? id).replace(" (DAG node)", ""))
        return { id } as never
      }),
    messages: () => Effect.succeed([]),
  })
  const deliver = Effect.fn("test.SessionPrompt.tier")(function* (input: SessionPrompt.PromptInput) {
    const sessionID = input.sessionID as string
    if (sessionID === "ses_tier_parent") return reply(sessionID)
    const release = yield* Deferred.make<string>()
    yield* Queue.offer(records, {
      title: titles.get(sessionID) ?? sessionID,
      text: input.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
      model: input.model,
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
  const prompt = Layer.mock(SessionPrompt.Service, { ...impl, children: Effect.succeed(built.children) } as never)
  // The worker agent has a model of its own, so a node that resolves no tier would show it.
  const agent = Layer.mock(Agent.Service, {
    list: () => Effect.succeed([] as never),
    get: () =>
      Effect.succeed({
        name: "build",
        mode: "all",
        permission: [],
        options: {},
        description: "",
        prompt: "",
        model: { providerID: "test" as never, modelID: "agent-model" as never },
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

/** A project directory whose settings give the two model tiers; the loop reads `dag.model` from it. */
const project = Effect.acquireRelease(
  Effect.promise(async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dag-tier-roles-")))
    await fs.mkdir(path.join(directory, ".agents"), { recursive: true })
    await fs.writeFile(
      path.join(directory, ".agents", "settings.json"),
      JSON.stringify({ dag: { model: { advanced: "tier/advanced", standard: "tier/standard" } } }),
    )
    return directory
  }),
  (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
)

function runLoopTest<A>(
  test: (services: {
    dag: Dag.Interface
    loop: DagLoop.Interface
    store: DagStore.Interface
    records: Queue.Queue<PromptRecord>
  }) => Effect.Effect<A, Error, Scope.Scope>,
) {
  return Effect.gen(function* () {
    const directory = yield* project
    const records = yield* Queue.unbounded<PromptRecord>()
    return yield* Effect.gen(function* () {
      const dag = yield* Dag.Service
      const loop = yield* DagLoop.Service
      const store = yield* DagStore.Service
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionID.make("ses_tier_parent"),
          project_id: Project.ID.global,
          slug: "tier-parent",
          directory,
          title: "Tier parent",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      return yield* test({ dag, loop, store, records })
    }).pipe(
      Effect.provide(runtimeLayer(records)),
      Effect.provideService(InstanceRef, {
        directory,
        worktree: directory,
        project: { id: Project.ID.global },
      } as never),
      Effect.scoped,
    )
  })
}

const compile = (blocks: ConstructorParameters<typeof DagBlocks.WorkflowBlock>[0][]): NodeConfig[] =>
  DagBlocks.compileWorkflowBlocks({
    objective: "Deliver the change",
    blocks: blocks.map((block) => new DagBlocks.WorkflowBlock(block)),
  })

const start = (dag: Dag.Interface, nodes: NodeConfig[], extra: Record<string, unknown> = {}) =>
  dag.create({
    projectID: Project.ID.global,
    sessionID: "ses_tier_parent",
    title: "tier roles",
    config: { name: "tier-roles", max_concurrency: 16, ...extra, nodes },
  })

const pkg = (id: string, write_set: string[]) => ({ id, instruction: `Implement ${id}`, write_set })
const plan = (...packages: ReturnType<typeof pkg>[]) => JSON.stringify({ summary: "split", packages })
const implemented = JSON.stringify({ summary: "done", changed_files: ["src/a.ts"], fingerprint: "fp-1" })
const passed = JSON.stringify({ verdict: "PASS", summary: "ok", evidence: [] })

const take = (records: Queue.Queue<PromptRecord>, count: number, message: string) =>
  Effect.forEach(Array.from({ length: count }), () => awaitWithTimeout(Queue.take(records), message))

const named = (taken: readonly PromptRecord[], title: string) => {
  const found = taken.find((record) => record.title === title)
  if (!found) throw new Error(`no prompt for "${title}" among ${taken.map((record) => record.title).join(", ")}`)
  return found
}

const workflow = (store: DagStore.Interface, dagID: string) => store.getWorkflow(dagID)
const config = (store: DagStore.Interface, dagID: string) =>
  workflow(store, dagID).pipe(Effect.map((row) => parseWorkflowConfig(row?.config ?? "")))
const settled = (store: DagStore.Interface, dagID: string, status: string, message: string) =>
  pollWithTimeout(workflow(store, dagID).pipe(Effect.map((row) => (row?.status === status ? row : undefined))), message)

describe("DagLoop model tiers follow the node role", () => {
  it.live("prompts each node with the tier its role calls for, whatever its required flag says", () =>
    runLoopTest(({ dag, loop, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const nodes = [
          ...compile([
            // Judging blocks are advanced even when the author makes them optional.
            { id: "design", kind: "plan", required: false },
            { id: "check", kind: "verify" },
            { id: "report", kind: "synthesize" },
            // Exploring and writing are standard even when they are required.
            { id: "map", kind: "explore", required: true },
            { id: "build", kind: "coding" },
            { id: "experiment", kind: "prototype" },
          ]),
          // A node with no block keeps the older rule: required takes the advanced tier.
          {
            id: "hand-required",
            name: "hand required",
            worker_type: "general",
            depends_on: [],
            required: true,
            prompt_template: { inline: "required by hand" },
          },
          {
            id: "hand-optional",
            name: "hand optional",
            worker_type: "general",
            depends_on: [],
            required: false,
            prompt_template: { inline: "optional by hand" },
          },
        ]
        yield* start(dag, nodes)
        const taken = yield* take(records, nodes.length, "a node did not start")
        expect(Object.fromEntries(taken.map((record) => [record.title, record.model]))).toEqual({
          "design: plan": ADVANCED,
          "check: verify": ADVANCED,
          "report: synthesize": ADVANCED,
          "map: explore": STANDARD,
          "build: coding": STANDARD,
          "experiment: prototype": STANDARD,
          "hand required": ADVANCED,
          "hand optional": STANDARD,
        })
        // The answers are not the point; settle the nodes so nothing is left running.
        for (const record of taken) {
          yield* Deferred.succeed(
            record.release,
            record.title === "build: coding" || record.title === "experiment: prototype"
              ? implemented
              : record.title === "check: verify"
                ? passed
                : "done",
          )
        }
      }),
    ),
  )

  it.live("splits a debug block and a writer fan-out by role too: helpers and package writers stay standard", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const nodes = compile([
          { id: "plan", kind: "plan" },
          { id: "bug", kind: "debug", depends_on: ["plan"] },
          { id: "slices", kind: "coding", depends_on: ["bug", "plan"], fan_out: "plan" },
        ])
        const dagID = yield* start(dag, nodes)
        const models = new Map<string, unknown>()
        const next = (message: string) =>
          awaitWithTimeout(Queue.take(records), message).pipe(
            Effect.tap((record) => Effect.sync(() => models.set(record.title, record.model))),
          )
        const planned = yield* next("the plan did not start")
        yield* Deferred.succeed(planned.release, plan(pkg("api", ["src/api"]), pkg("ui", ["src/ui"])))
        const evidence = yield* next("the debug evidence did not start")
        yield* Deferred.succeed(evidence.release, "evidence")
        const diagnosis = yield* next("the diagnosis did not start")
        yield* Deferred.succeed(diagnosis.release, "root cause")
        const writers = yield* Effect.forEach(Array.from({ length: 2 }), () => next("a package writer did not start"))
        for (const writer of writers) yield* Deferred.succeed(writer.release, implemented)
        const aggregate = yield* next("the aggregator did not start")
        yield* Deferred.succeed(aggregate.release, implemented)
        yield* settled(store, dagID, "completed", "the workflow did not complete")

        expect(Object.fromEntries(models)).toEqual({
          "plan: plan": ADVANCED,
          "bug: reproduce and collect evidence": STANDARD,
          "bug: diagnose root cause": STANDARD,
          "slices: coding [api]": STANDARD,
          "slices: coding [ui]": STANDARD,
          "slices: coding: aggregate fan-out writers": STANDARD,
        })
      }),
    ),
  )

  // The children of an expansion carry no marker of their own: the join node that waits for them is what says they
  // are children, and the loop reads that from the persisted graph.
  it.live("prompts a compose split and join node with the advanced tier and the children with the standard one", () =>
    runLoopTest(({ dag, loop, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const child = (id: string, agent: string, required: boolean): NodeConfig => ({
          id: `survey--${id}`,
          name: `survey [${id}]`,
          worker_type: agent,
          depends_on: ["survey--split"],
          required,
          report_to_parent: false,
          workspace_writes: "deny",
          prompt_template: { inline: `Look into ${id}` },
        })
        const nodes: NodeConfig[] = [
          {
            id: "survey--split",
            name: "survey: plan the expansion",
            worker_type: "general",
            depends_on: [],
            required: false,
            report_to_parent: false,
            workspace_writes: "deny",
            prompt_template: { inline: "Plan the expansion" },
            generated_helper: "split",
          },
          // A required child of a required block is still a standard-tier worker.
          child("code", "explore", true),
          child("web", "researcher", false),
          {
            id: "survey",
            name: "survey: compose",
            worker_type: "general",
            depends_on: ["survey--code", "survey--web"],
            required: true,
            report_to_parent: false,
            workspace_writes: "deny",
            prompt_template: { inline: "Join the results" },
            join: {
              plan: "survey--split",
              items: [
                { id: "code", node: "survey--code", agent: "explore", required: true },
                { id: "web", node: "survey--web", agent: "researcher", required: false },
              ],
            },
          },
        ]
        yield* start(dag, nodes)
        const split = yield* awaitWithTimeout(Queue.take(records), "the split node did not start")
        yield* Deferred.succeed(split.release, "the plan")
        const children = yield* take(records, 2, "the children did not start")
        for (const record of children) yield* Deferred.succeed(record.release, `${record.title} says`)
        const join = yield* awaitWithTimeout(Queue.take(records), "the join node did not start")
        yield* Deferred.succeed(join.release, "joined")

        expect(split.title).toBe("survey: plan the expansion")
        expect(split.model).toEqual(ADVANCED)
        expect(named(children, "survey [code]").model).toEqual(STANDARD)
        expect(named(children, "survey [web]").model).toEqual(STANDARD)
        expect(join.title).toBe("survey: compose")
        expect(join.model).toEqual(ADVANCED)
      }),
    ),
  )
})

describe("DagLoop writer blocks are required by default", () => {
  const route = (build: Record<string, unknown> = {}) =>
    compile([
      { id: "plan", kind: "plan" },
      { id: "build", kind: "coding", depends_on: ["plan"], ...build },
      { id: "check", kind: "verify", depends_on: ["build"] },
    ])

  it.live("fails the workflow at a writer that left required out, without waiting for the verification", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const nodes = route()
        expect(nodes.find((node) => node.id === "build")?.required).toBe(true)
        const dagID = yield* start(dag, nodes)
        const planning = yield* awaitWithTimeout(Queue.take(records), "the plan did not start")
        yield* Deferred.succeed(planning.release, "the plan")
        const writer = yield* awaitWithTimeout(Queue.take(records), "the writer did not start")
        expect(writer.title).toBe("build: coding")
        yield* dag.nodeFailed(dagID, "build", "the writer crashed", "exec_failed")
        yield* settled(store, dagID, "failed", "the workflow did not fail at the writer")

        // The failure is the writer's, and the verification never ran on a placeholder.
        const rows = new Map((yield* store.getNodes(dagID)).map((row) => [row.id, row]))
        expect([...rows.values()].filter((row) => row.status === "failed").map((row) => row.id)).toEqual(["build"])
        expect(rows.get("build")?.errorReason).toBe("the writer crashed")
        expect(rows.get("check")).toMatchObject({
          status: "skipped",
          errorReason: "workflow_failed",
          childSessionId: null,
        })
        expect(Option.isNone(yield* Queue.poll(records))).toBe(true)
      }),
    ),
  )

  it.live(
    "keeps an explicit required: false writer optional: its failure reaches the verification as a placeholder",
    () =>
      runLoopTest(({ dag, loop, store, records }) =>
        Effect.gen(function* () {
          yield* loop.init()
          const nodes = route({ required: false })
          expect(nodes.find((node) => node.id === "build")?.required).toBe(false)
          const dagID = yield* start(dag, nodes)
          const planning = yield* awaitWithTimeout(Queue.take(records), "the plan did not start")
          yield* Deferred.succeed(planning.release, "the plan")
          const writer = yield* awaitWithTimeout(Queue.take(records), "the writer did not start")
          expect(writer.title).toBe("build: coding")
          yield* dag.nodeFailed(dagID, "build", "the writer crashed", "exec_failed")
          const verification = yield* awaitWithTimeout(Queue.take(records), "the verification did not start")
          expect(verification.title).toBe("check: verify")
          expect(verification.text).toContain("the writer crashed")
          yield* Deferred.succeed(verification.release, passed)
          yield* settled(store, dagID, "completed", "the workflow did not complete")
        }),
      ),
  )

  it.live("fails the workflow at the one package writer that fails, and the aggregation never runs", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const nodes = compile([
          { id: "plan", kind: "plan" },
          { id: "slices", kind: "coding", depends_on: ["plan"], fan_out: "plan" },
          { id: "check", kind: "verify", depends_on: ["slices"] },
        ])
        const dagID = yield* start(dag, nodes)
        const planning = yield* awaitWithTimeout(Queue.take(records), "the plan did not start")
        yield* Deferred.succeed(planning.release, plan(pkg("api", ["src/api"]), pkg("ui", ["src/ui"])))
        const writers = yield* take(records, 2, "the package writers did not start")
        expect(writers.map((record) => record.title).sort()).toEqual(["slices: coding [api]", "slices: coding [ui]"])
        const expanded = new Map((yield* config(store, dagID))?.nodes.map((node) => [node.id, node.required]))
        // Both packages and their aggregator are as required as the block they came from.
        expect(expanded.get("slices--api")).toBe(true)
        expect(expanded.get("slices--ui")).toBe(true)
        expect(expanded.get("slices")).toBe(true)

        yield* dag.nodeFailed(dagID, "slices--api", "the api package broke", "exec_failed")
        // The workflow ends once every node has settled: the other package still runs until it answers.
        yield* Deferred.succeed(named(writers, "slices: coding [ui]").release, implemented)
        yield* settled(store, dagID, "failed", "the workflow did not fail at the package writer")
        const rows = new Map((yield* store.getNodes(dagID)).map((row) => [row.id, row]))
        expect([...rows.values()].filter((row) => row.status === "failed").map((row) => row.id)).toEqual([
          "slices--api",
        ])
        for (const id of ["slices", "check"])
          expect(rows.get(id), id).toMatchObject({
            status: "skipped",
            errorReason: "workflow_failed",
            childSessionId: null,
          })
        expect(Option.isNone(yield* Queue.poll(records))).toBe(true)
      }),
    ),
  )

  it.live("lets a package writer of an explicit required: false block fail: the aggregation still runs", () =>
    runLoopTest(({ dag, loop, store, records }) =>
      Effect.gen(function* () {
        yield* loop.init()
        const nodes = compile([
          { id: "plan", kind: "plan" },
          { id: "slices", kind: "coding", depends_on: ["plan"], fan_out: "plan", required: false },
          { id: "check", kind: "verify", depends_on: ["slices"] },
        ])
        const dagID = yield* start(dag, nodes)
        const planning = yield* awaitWithTimeout(Queue.take(records), "the plan did not start")
        yield* Deferred.succeed(planning.release, plan(pkg("api", ["src/api"]), pkg("ui", ["src/ui"])))
        const writers = yield* take(records, 2, "the package writers did not start")
        const expanded = new Map((yield* config(store, dagID))?.nodes.map((node) => [node.id, node.required]))
        expect([expanded.get("slices--api"), expanded.get("slices--ui"), expanded.get("slices")]).toEqual([
          false,
          false,
          false,
        ])

        yield* dag.nodeFailed(dagID, "slices--api", "the api package broke", "exec_failed")
        yield* Deferred.succeed(named(writers, "slices: coding [ui]").release, implemented)
        const aggregation = yield* awaitWithTimeout(Queue.take(records), "the aggregation did not start")
        expect(aggregation.title).toBe("slices: coding: aggregate fan-out writers")
        expect(aggregation.text).toContain("the api package broke")
        expect((yield* workflow(store, dagID))?.status).toBe("running")
      }),
    ),
  )
})
