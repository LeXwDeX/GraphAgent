// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1031 M8 through the workflow tool, on a real database: the plan agent may
// only run read-only workflows, two unisolated writers never share a workspace
// across live workflows, and a strict workflow with parallel writers defaults
// to workflow worktree isolation from a clean git checkout. `runWorkflow` and
// `controlWorkflow` run against the real `Dag` and `DagControl` over an
// in-memory database; only the Worktree service is a probe that makes real git
// worktrees, so "the worktree was created" is observable.
// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Typed service
// mocks and tool-call shapes implement only what this harness calls, the same
// idiom as dag-workflow-isolation.test.ts.
import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { EventTable } from "@graphagent/core/event/sql"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionSchema } from "@graphagent/core/session/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { WorkflowAuthoring } from "@/dag/authoring"
import { DagControl } from "@/dag/control"
import { Dag, parseWorkflowConfig } from "@/dag/dag"
import { DagLocation } from "@/dag/location"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, SessionID } from "@/session/schema"
import type { Tool } from "@/tool/tool"
import { controlWorkflow } from "@/tool/workflow/control"
import { runWorkflow } from "@/tool/workflow/run"
import type { ControlParams, RunParams } from "@/tool/workflow/schema"
import { Worktree } from "@/worktree"

const roots: string[] = []
const projectID = "project-1"

function git(directory: string, args: string[]): string {
  // stderr carries git's advice and progress lines, which only add noise here.
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim()
}

/** A clean git checkout with one commit. */
function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "write-guard-repo-"))
  roots.push(root)
  git(root, ["init"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  git(root, ["config", "commit.gpgsign", "false"])
  writeFileSync(path.join(root, "base.txt"), "base\n")
  git(root, ["add", "-A"])
  git(root, ["commit", "-m", "base"])
  return root
}

/** Spec files live outside the checkouts so they never dirty them. */
const specs = (() => {
  const root = mkdtempSync(path.join(tmpdir(), "write-guard-specs-"))
  let counter = 0
  return (value: unknown) => {
    // afterEach removes every registered root, so register it on each use.
    mkdirSync(root, { recursive: true })
    roots.push(root)
    const file = path.join(root, `spec-${counter++}.yaml`)
    writeFileSync(file, JSON.stringify(value))
    return file
  }
})()

interface Probe {
  creates: string[]
}

function runtime(probe: Probe) {
  const database = Database.defaultLayer
  const events = EventV2.defaultLayer.pipe(Layer.provide(database))
  const store = DagStore.defaultLayer.pipe(Layer.provide(database))
  const projector = DagProjector.defaultLayer.pipe(Layer.provide(Layer.merge(database, events)))
  const worktree = Layer.mock(Worktree.Service, {
    create: (input?: { name?: string }) =>
      Effect.gen(function* () {
        probe.creates.push(input?.name ?? "")
        const ctx = yield* InstanceRef
        const directory = mkdtempSync(path.join(tmpdir(), "write-guard-wt-"))
        roots.push(directory)
        rmSync(directory, { recursive: true, force: true })
        git(ctx!.directory, ["worktree", "add", "--detach", directory, "HEAD"])
        return { name: input?.name ?? "wt", branch: `opencode/${input?.name ?? "wt"}`, directory }
      }),
    remove: () => Effect.succeed(true),
  })
  const instanceStore = Layer.succeed(InstanceStore.Service, {
    provide: (input: { directory: string }, effect: Effect.Effect<unknown>) =>
      Effect.provideService(effect, InstanceRef, { directory: input.directory } as never),
  } as never)
  const bridge = EventV2Bridge.defaultLayer.pipe(Layer.provide(Layer.merge(database, events)))
  const dag = Layer.provideMerge(
    Dag.layer,
    Layer.mergeAll(database, events, store, projector, worktree, instanceStore, bridge),
  )
  return Layer.merge(dag, DagControl.layer.pipe(Layer.provide(dag)))
}

// The catalog only names the write-capable workers, which node-level isolation
// needs; worker, prompt and model checks are skipped.
const authoring = WorkflowAuthoring.make({
  loadEnvironment: () => Effect.succeed({ writer_types: new Set(["build", "general"]) }),
})

/** Seeds the project and one session per `[id, directory]`. */
function seed(sessions: ReadonlyArray<readonly [string, string]>) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make(projectID), worktree: AbsolutePath.make(sessions[0][1]), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    for (const [id, directory] of sessions) {
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionSchema.ID.make(id),
          project_id: Project.ID.make(projectID),
          slug: id,
          directory: AbsolutePath.make(directory),
          title: id,
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
    }
  })
}

const toolContext = (sessionID: string, agent: string) =>
  ({
    sessionID: SessionID.make(sessionID),
    messageID: MessageID.ascending(),
    agent,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
    extra: { bypassCwdCheck: true },
  }) satisfies Tool.Context

interface Caller {
  readonly session: string
  readonly directory: string
  readonly agent?: string
}

const start = (caller: Caller, specPath: string) =>
  Effect.gen(function* () {
    const dag = yield* Dag.Service
    const control = yield* DagControl.Service
    return yield* runWorkflow(
      {
        dag,
        control,
        authoring,
        sessionID: caller.session,
        session: { directory: caller.directory, projectID, model: undefined },
        ctx: toolContext(caller.session, caller.agent ?? "build"),
      },
      { action: "run", operation: "start", spec_path: specPath } as RunParams,
    )
  })

const extend = (caller: Caller, workflowID: string, specPath: string) =>
  Effect.gen(function* () {
    const dag = yield* Dag.Service
    const control = yield* DagControl.Service
    return yield* runWorkflow(
      {
        dag,
        control,
        authoring,
        sessionID: caller.session,
        session: { directory: caller.directory, projectID, model: undefined },
        ctx: toolContext(caller.session, caller.agent ?? "build"),
      },
      { action: "run", operation: "extend", workflow_id: workflowID, spec_path: specPath } as RunParams,
    )
  })

const replan = (caller: Caller, workflowID: string, specPath: string) =>
  Effect.gen(function* () {
    const dag = yield* Dag.Service
    const control = yield* DagControl.Service
    return yield* controlWorkflow(
      {
        dag,
        control,
        authoring,
        sessionID: caller.session,
        session: { directory: caller.directory, projectID, model: undefined },
        ctx: toolContext(caller.session, caller.agent ?? "build"),
      },
      { action: "control", operation: "replan", workflow_id: workflowID, spec_path: specPath } as ControlParams,
    )
  })

const retarget = (caller: Caller, workflowID: string, workspace: string) =>
  Effect.gen(function* () {
    const dag = yield* Dag.Service
    const control = yield* DagControl.Service
    return yield* controlWorkflow(
      {
        dag,
        control,
        authoring,
        sessionID: caller.session,
        session: { directory: caller.directory, projectID, model: undefined },
        ctx: toolContext(caller.session, caller.agent ?? "build"),
      },
      { action: "control", operation: "retarget", workflow_id: workflowID, workspace } as ControlParams,
    )
  })

/** The error message a refused extend, replan or retarget surfaces to the model. */
const failureText = <A, R>(effect: Effect.Effect<A, never, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) return yield* Effect.die(new Error("expected the call to be refused"))
    return Cause.pretty(exit.cause)
  })

const workflowID = (output: string) => /<workflow id="([^"]+)"/.exec(output)?.[1] ?? ""

interface Refusal {
  workflow_created: boolean
  error_code: string
  message: string
  writers?: string[]
  conflicts?: Array<{ workflow_id: string; session_id: string; workspace: string; nodes: string[] }>
}

const refusal = (output: string) => JSON.parse(output) as Refusal

// ---- specs -----------------------------------------------------------------

const readOnlySpec = (name = "research") => ({
  config: { name, objective: "Map the module", blocks: [{ id: "scan", kind: "explore" }] },
})
const writerSpec = (name = "implement") => ({
  config: { name, objective: "Apply the change", blocks: [{ id: "impl", kind: "coding" }] },
})
const strictSpec = (ordered: boolean, extra: Record<string, unknown> = {}) => ({
  config: {
    name: "strict-delivery",
    objective: "Ship two slices",
    review_gate: "strict",
    acceptance: [{ id: "AC1", text: "Both slices work" }],
    blocks: [
      { id: "slice-a", kind: "coding" },
      { id: "slice-b", kind: "coding", ...(ordered ? { depends_on: ["slice-a"] } : {}) },
      { id: "gates", kind: "verify", depends_on: ["slice-a", "slice-b"] },
      { id: "decision", kind: "review", depends_on: ["gates"], lenses: ["standards", "intent", "completeness"] },
      { id: "final", kind: "synthesize", depends_on: ["decision"] },
    ],
    ...extra,
  },
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Services = Dag.Service | DagControl.Service | Database.Service | DagStore.Service

const run = <A, E>(probe: Probe, effect: Effect.Effect<A, E, Services>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(runtime(probe))))

describe("the plan agent on workflow start", () => {
  it("refuses a graph with a writer before anything durable exists", async () => {
    const dir = repo()
    await run(
      { creates: [] },
      Effect.gen(function* () {
        yield* seed([["ses_plan", dir]])
        const result = yield* start({ session: "ses_plan", directory: dir, agent: "plan" }, specs(writerSpec()))
        expect(result.title).toBe("Workflow not started: the plan agent is read-only")
        expect(result.metadata).toMatchObject({ blocked: true })
        const body = refusal(result.output)
        expect(body.workflow_created).toBe(false)
        expect(body.error_code).toBe("plan_readonly")
        expect(body.writers).toEqual(["impl"])
        expect(body.message).toContain("Switch to build before running the implementation phase")
        const { db } = yield* Database.Service
        expect(yield* db.select().from(EventTable).all()).toEqual([])
        expect(yield* (yield* DagStore.Service).listWorkflows()).toEqual([])
      }),
    )
  })

  it("starts a graph whose nodes are all read-only", async () => {
    const dir = repo()
    await run(
      { creates: [] },
      Effect.gen(function* () {
        yield* seed([["ses_plan", dir]])
        const result = yield* start({ session: "ses_plan", directory: dir, agent: "plan" }, specs(readOnlySpec()))
        expect(result.title).toBe("Workflow started: research")
        expect(workflowID(result.output)).toStartWith("dag_")
        expect((yield* (yield* DagStore.Service).listWorkflows()).map((workflow) => workflow.status)).toEqual([
          "running",
        ])
      }),
    )
  })

  it("starts the same writer graph for the build agent", async () => {
    const dir = repo()
    await run(
      { creates: [] },
      Effect.gen(function* () {
        yield* seed([["ses_build", dir]])
        const result = yield* start({ session: "ses_build", directory: dir, agent: "build" }, specs(writerSpec()))
        expect(result.title).toBe("Workflow started: implement")
      }),
    )
  })

  it("refuses an extend or replan that adds a writer and leaves the workflow running, not parked", async () => {
    const dir = repo()
    await run(
      { creates: [] },
      Effect.gen(function* () {
        yield* seed([["ses_plan", dir]])
        const caller = { session: "ses_plan", directory: dir, agent: "plan" } as const
        const id = workflowID((yield* start(caller, specs(readOnlySpec()))).output)
        const dagStore = yield* DagStore.Service
        const before = (yield* dagStore.getNodes(id)).length
        const { db } = yield* Database.Service
        const eventsBefore = (yield* db.select().from(EventTable).all()).length

        const extendText = yield* failureText(
          extend(
            caller,
            id,
            specs({ objective: "Add the change", blocks: [{ id: "impl", kind: "coding", depends_on: ["scan"] }] }),
          ),
        )
        expect(extendText).toContain("Workflow extend rejected")
        expect(extendText).toContain("write-capable node(s): impl")
        expect(extendText).toContain("Switch to build")

        const replanText = yield* failureText(
          replan(
            caller,
            id,
            specs({
              fragment: {
                name: "fragment",
                nodes: [
                  {
                    id: "patch",
                    name: "Patch",
                    worker_type: "general",
                    depends_on: [],
                    prompt_template: { inline: "patch it" },
                  },
                ],
              },
            }),
          ),
        )
        expect(replanText).toContain("Workflow replan rejected")
        expect(replanText).toContain("write-capable node(s): patch")

        // Nothing was parked or mutated: same status, same nodes, no new events.
        expect((yield* dagStore.getWorkflow(id))?.status).toBe("running")
        expect((yield* dagStore.getNodes(id)).length).toBe(before)
        expect((yield* db.select().from(EventTable).all()).length).toBe(eventsBefore)

        // The same extend from build lands.
        const landed = yield* extend(
          { ...caller, agent: "build" },
          id,
          specs({ objective: "Add the change", blocks: [{ id: "impl", kind: "coding", depends_on: ["scan"] }] }),
        )
        expect(landed.title).toBe("Workflow extended: 1 nodes added")
      }),
    )
  })

  it("lets the plan agent extend with read-only nodes", async () => {
    const dir = repo()
    await run(
      { creates: [] },
      Effect.gen(function* () {
        yield* seed([["ses_plan", dir]])
        const caller = { session: "ses_plan", directory: dir, agent: "plan" } as const
        const id = workflowID((yield* start(caller, specs(readOnlySpec()))).output)
        const result = yield* extend(
          caller,
          id,
          specs({ objective: "Dig deeper", blocks: [{ id: "scan-2", kind: "explore", depends_on: ["scan"] }] }),
        )
        expect(result.title).toBe("Workflow extended: 1 nodes added")
      }),
    )
  })
})

describe("cross-workflow write conflicts on workflow start", () => {
  it("refuses the later start when both would write the same unisolated workspace", async () => {
    const dir = repo()
    await run(
      { creates: [] },
      Effect.gen(function* () {
        yield* seed([
          ["ses_a", dir],
          ["ses_b", dir],
        ])
        const first = yield* start({ session: "ses_a", directory: dir }, specs(writerSpec("first")))
        const firstID = workflowID(first.output)
        const second = yield* start({ session: "ses_b", directory: dir }, specs(writerSpec("second")))
        expect(second.title).toBe("Workflow not started: the workspace is being written by another workflow")
        expect(second.metadata).toMatchObject({ blocked: true })
        const body = refusal(second.output)
        expect(body.error_code).toBe("write_conflict")
        expect(body.workflow_created).toBe(false)
        expect(body.conflicts).toEqual([
          {
            workflow_id: firstID,
            session_id: "ses_a",
            workspace: DagLocation.canonicalDirectory(dir),
            nodes: ["impl"],
          },
        ])
        expect(body.message).toContain(firstID)
        expect(body.message).toContain("config.isolation: worktree")
        expect((yield* (yield* DagStore.Service).listWorkflows()).length).toBe(1)
      }),
    )
  })

  it("also refuses a second start from the same session", async () => {
    const dir = repo()
    await run(
      { creates: [] },
      Effect.gen(function* () {
        yield* seed([["ses_a", dir]])
        yield* start({ session: "ses_a", directory: dir }, specs(writerSpec("first")))
        const second = yield* start({ session: "ses_a", directory: dir }, specs(writerSpec("second")))
        expect(refusal(second.output).error_code).toBe("write_conflict")
      }),
    )
  })

  it("lets a read-only workflow start beside a writing one, and a writer beside a read-only one", async () => {
    const dir = repo()
    await run(
      { creates: [] },
      Effect.gen(function* () {
        yield* seed([
          ["ses_a", dir],
          ["ses_b", dir],
        ])
        yield* start({ session: "ses_a", directory: dir }, specs(writerSpec("writer")))
        const reader = yield* start({ session: "ses_b", directory: dir }, specs(readOnlySpec("reader")))
        expect(reader.title).toBe("Workflow started: reader")
      }),
    )
    await run(
      { creates: [] },
      Effect.gen(function* () {
        yield* seed([
          ["ses_a", dir],
          ["ses_b", dir],
        ])
        yield* start({ session: "ses_a", directory: dir }, specs(readOnlySpec("reader")))
        const writer = yield* start({ session: "ses_b", directory: dir }, specs(writerSpec("writer")))
        expect(writer.title).toBe("Workflow started: writer")
      }),
    )
  })

  it("lets writers start in different directories", async () => {
    const first = repo()
    const second = repo()
    await run(
      { creates: [] },
      Effect.gen(function* () {
        yield* seed([
          ["ses_a", first],
          ["ses_b", second],
        ])
        yield* start({ session: "ses_a", directory: first }, specs(writerSpec("first")))
        const other = yield* start({ session: "ses_b", directory: second }, specs(writerSpec("second")))
        expect(other.title).toBe("Workflow started: second")
      }),
    )
  })

  it("counts a paused workflow's pending writer but not a cancelled workflow", async () => {
    const dir = repo()
    await run(
      { creates: [] },
      Effect.gen(function* () {
        yield* seed([
          ["ses_a", dir],
          ["ses_b", dir],
        ])
        const dag = yield* Dag.Service
        const id = workflowID((yield* start({ session: "ses_a", directory: dir }, specs(writerSpec("first")))).output)
        yield* dag.pause(id)
        const blocked = yield* start({ session: "ses_b", directory: dir }, specs(writerSpec("second")))
        expect(refusal(blocked.output).error_code).toBe("write_conflict")
        yield* dag.cancel(id)
        const free = yield* start({ session: "ses_b", directory: dir }, specs(writerSpec("second")))
        expect(free.title).toBe("Workflow started: second")
      }),
    )
  })

  it("does not count a writer the other workflow isolated at node level", async () => {
    const dir = repo()
    await run(
      { creates: [] },
      Effect.gen(function* () {
        yield* seed([
          ["ses_a", dir],
          ["ses_b", dir],
        ])
        // A hand-written node with its own worktree writes elsewhere.
        yield* start(
          { session: "ses_a", directory: dir },
          specs({
            config: {
              name: "node-isolated",
              nodes: [
                {
                  id: "writer",
                  name: "Writer",
                  worker_type: "build",
                  depends_on: [],
                  isolation: "worktree",
                  prompt_template: { inline: "write in your own tree" },
                },
              ],
            },
          }),
        )
        const beside = yield* start({ session: "ses_b", directory: dir }, specs(writerSpec("beside")))
        expect(beside.title).toBe("Workflow started: beside")
      }),
    )
  })

  it("refuses an extend that adds a writer next to another workflow's writer", async () => {
    const dir = repo()
    await run(
      { creates: [] },
      Effect.gen(function* () {
        yield* seed([
          ["ses_a", dir],
          ["ses_b", dir],
        ])
        const writerID = workflowID(
          (yield* start({ session: "ses_a", directory: dir }, specs(writerSpec("writer")))).output,
        )
        const readerID = workflowID(
          (yield* start({ session: "ses_b", directory: dir }, specs(readOnlySpec("reader")))).output,
        )
        const text = yield* failureText(
          extend(
            { session: "ses_b", directory: dir },
            readerID,
            specs({ objective: "Fix it", blocks: [{ id: "fix", kind: "coding", depends_on: ["scan"] }] }),
          ),
        )
        expect(text).toContain("Workflow extend rejected")
        expect(text).toContain(`workflow ${writerID}`)
        expect(text).toContain("isolation: worktree")
        const dagStore = yield* DagStore.Service
        expect((yield* dagStore.getWorkflow(readerID))?.status).toBe("running")
        expect((yield* dagStore.getNodes(readerID)).map((node) => node.id)).toEqual(["scan"])
      }),
    )
  })

  it("refuses a replan that adds a writer next to another workflow's writer, without parking", async () => {
    const dir = repo()
    await run(
      { creates: [] },
      Effect.gen(function* () {
        yield* seed([
          ["ses_a", dir],
          ["ses_b", dir],
        ])
        const writerID = workflowID(
          (yield* start({ session: "ses_a", directory: dir }, specs(writerSpec("writer")))).output,
        )
        const readerID = workflowID(
          (yield* start({ session: "ses_b", directory: dir }, specs(readOnlySpec("reader")))).output,
        )
        const dagStore = yield* DagStore.Service
        const { db } = yield* Database.Service
        const eventsBefore = (yield* db.select().from(EventTable).all()).length
        const patch = {
          id: "patch",
          name: "Patch",
          worker_type: "general",
          depends_on: [],
          prompt_template: { inline: "patch it" },
        }
        const text = yield* failureText(
          replan(
            { session: "ses_b", directory: dir },
            readerID,
            specs({ fragment: { name: "fragment", nodes: [patch] } }),
          ),
        )
        expect(text).toContain("Workflow replan rejected")
        expect(text).toContain(`workflow ${writerID}`)
        expect(text).toContain("this replan also writes there (patch)")
        // Refused before any mutation: not parked, no new node, no new event.
        expect((yield* dagStore.getWorkflow(readerID))?.status).toBe("running")
        expect((yield* dagStore.getNodes(readerID)).map((node) => node.id)).toEqual(["scan"])
        expect((yield* db.select().from(EventTable).all()).length).toBe(eventsBefore)
        // Isolated in its own worktree, the same node does not share the workspace.
        const isolated = yield* replan(
          { session: "ses_b", directory: dir },
          readerID,
          specs({ fragment: { name: "fragment", nodes: [{ ...patch, isolation: "worktree" }] } }),
        )
        expect(isolated.title).toContain("Workflow replanned")
      }),
    )
  })

  it("refuses a retarget that moves a writer into a worktree another workflow is writing", async () => {
    // Two unisolated workflows in different worktrees of one project do not
    // clash; a retarget must not be the way to make them.
    const dir = repo()
    const linkedPath = path.join(tmpdir(), `write-guard-retarget-${Math.random().toString(36).slice(2)}`)
    roots.push(linkedPath)
    git(dir, ["worktree", "add", "--detach", linkedPath, "HEAD"])
    const linked = DagLocation.canonicalDirectory(linkedPath)
    await run(
      { creates: [] },
      Effect.gen(function* () {
        yield* seed([
          ["ses_a", dir],
          ["ses_b", linked],
        ])
        const first = workflowID(
          (yield* start({ session: "ses_a", directory: dir }, specs(writerSpec("first")))).output,
        )
        const second = workflowID(
          (yield* start({ session: "ses_b", directory: linked }, specs(writerSpec("second")))).output,
        )
        const dagStore = yield* DagStore.Service
        const { db } = yield* Database.Service
        const eventsBefore = (yield* db.select().from(EventTable).all()).length
        const text = yield* failureText(retarget({ session: "ses_a", directory: dir }, first, linked))
        expect(text).toContain("Workflow retarget rejected")
        expect(text).toContain(`workflow ${second}`)
        expect(text).toContain("this retarget would move write-capable node(s) there (impl)")
        // Refused before any mutation: still running, still bound to its own checkout.
        const refused = yield* dagStore.getWorkflow(first)
        expect(refused?.status).toBe("running")
        expect(refused?.executionDirectory ?? null).toBeNull()
        expect((yield* db.select().from(EventTable).all()).length).toBe(eventsBefore)
        // Once the other workflow has stopped writing there, the same retarget lands.
        yield* (yield* Dag.Service).cancel(second)
        const landed = yield* retarget({ session: "ses_a", directory: dir }, first, linked)
        expect(landed.title).toContain("Workflow retargeted")
        expect((yield* dagStore.getWorkflow(first))?.executionDirectory).toBe(linked)
      }),
    )
  })
})

describe("default worktree isolation on workflow start", () => {
  it("isolates a strict workflow with parallel writers in a clean git checkout", async () => {
    const dir = repo()
    const probe = { creates: [] as string[] }
    await run(
      probe,
      Effect.gen(function* () {
        yield* seed([["ses_a", dir]])
        const result = yield* start({ session: "ses_a", directory: dir }, specs(strictSpec(false)))
        expect(result.title).toBe("Workflow started: strict-delivery")
        expect(result.output).toContain("Default isolation: this strict workflow has parallel writers")
        expect(result.output).toContain("never merged automatically")
        const id = workflowID(result.output)
        const workflow = yield* (yield* DagStore.Service).getWorkflow(id)
        const config = parseWorkflowConfig(workflow?.config ?? "")
        expect(config?.isolation).toBe("worktree")
        expect(probe.creates).toHaveLength(1)
        expect(probe.creates[0]).toStartWith(`dag-${id}-`)
        expect(config?.worktree?.directory).toBeDefined()
        expect(workflow?.executionDirectory).toBe(config?.worktree?.directory)
        // The owner checkout is untouched and still clean.
        expect(git(dir, ["status", "--porcelain"])).toBe("")
      }),
    )
  })

  it("lets an isolated workflow's writers coexist with a later unisolated writer start", async () => {
    const dir = repo()
    const probe = { creates: [] as string[] }
    await run(
      probe,
      Effect.gen(function* () {
        yield* seed([
          ["ses_a", dir],
          ["ses_b", dir],
        ])
        yield* start({ session: "ses_a", directory: dir }, specs(strictSpec(false)))
        // The strict workflow writes in its own worktree, so another workflow
        // may still write the owner checkout.
        const beside = yield* start({ session: "ses_b", directory: dir }, specs(writerSpec("beside")))
        expect(beside.title).toBe("Workflow started: beside")
      }),
    )
  })

  it("does not isolate when the writers are ordered", async () => {
    const dir = repo()
    const probe = { creates: [] as string[] }
    await run(
      probe,
      Effect.gen(function* () {
        yield* seed([["ses_a", dir]])
        const result = yield* start({ session: "ses_a", directory: dir }, specs(strictSpec(true)))
        expect(result.title).toBe("Workflow started: strict-delivery")
        expect(result.output).not.toContain("isolation")
        expect(probe.creates).toEqual([])
        const workflow = yield* (yield* DagStore.Service).getWorkflow(workflowID(result.output))
        expect(parseWorkflowConfig(workflow?.config ?? "")?.isolation).toBeUndefined()
      }),
    )
  })

  it("does not isolate a standard workflow", async () => {
    const dir = repo()
    const probe = { creates: [] as string[] }
    await run(
      probe,
      Effect.gen(function* () {
        yield* seed([["ses_a", dir]])
        const result = yield* start(
          { session: "ses_a", directory: dir },
          specs({
            config: {
              name: "standard-parallel",
              objective: "Two slices",
              blocks: [
                { id: "slice-a", kind: "coding" },
                { id: "slice-b", kind: "coding" },
              ],
            },
          }),
        )
        expect(result.title).toBe("Workflow started: standard-parallel")
        expect(probe.creates).toEqual([])
      }),
    )
  })

  it("starts unisolated and warns when the checkout has uncommitted changes", async () => {
    const dir = repo()
    writeFileSync(path.join(dir, "wip.txt"), "unsaved work\n")
    const probe = { creates: [] as string[] }
    await run(
      probe,
      Effect.gen(function* () {
        yield* seed([["ses_a", dir]])
        const result = yield* start({ session: "ses_a", directory: dir }, specs(strictSpec(false)))
        expect(result.title).toBe("Workflow started: strict-delivery")
        expect(result.output).toContain("the checkout has uncommitted changes")
        expect(result.output).toContain("do not commit or stash the user's changes yourself")
        expect(result.output).toContain("not isolated because of the uncommitted changes")
        expect(probe.creates).toEqual([])
        // The user's work is exactly as they left it.
        expect(git(dir, ["status", "--porcelain"])).toBe("?? wip.txt")
        const workflow = yield* (yield* DagStore.Service).getWorkflow(workflowID(result.output))
        expect(parseWorkflowConfig(workflow?.config ?? "")?.isolation).toBeUndefined()
      }),
    )
  })

  it("starts unisolated and warns that a non-git project can only write serially", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "write-guard-plain-"))
    roots.push(dir)
    const probe = { creates: [] as string[] }
    await run(
      probe,
      Effect.gen(function* () {
        yield* seed([["ses_a", dir]])
        const result = yield* start({ session: "ses_a", directory: dir }, specs(strictSpec(false)))
        expect(result.title).toBe("Workflow started: strict-delivery")
        expect(result.output).toContain("not a git repository")
        expect(result.output).toContain("can only write serially")
        expect(probe.creates).toEqual([])
      }),
    )
  })

  it("leaves an explicit workspace alone and does not isolate it", async () => {
    const dir = repo()
    const linked = path.join(tmpdir(), `write-guard-linked-${Math.random().toString(36).slice(2)}`)
    roots.push(linked)
    git(dir, ["worktree", "add", "--detach", linked, "HEAD"])
    const probe = { creates: [] as string[] }
    await run(
      probe,
      Effect.gen(function* () {
        yield* seed([["ses_a", dir]])
        const result = yield* start(
          { session: "ses_a", directory: dir },
          specs(strictSpec(false, { workspace: DagLocation.canonicalDirectory(linked) })),
        )
        expect(result.title).toBe("Workflow started: strict-delivery")
        expect(result.output).not.toContain("Default isolation")
        expect(result.output).not.toContain("Warning:")
        expect(probe.creates).toEqual([])
        const workflow = yield* (yield* DagStore.Service).getWorkflow(workflowID(result.output))
        const config = parseWorkflowConfig(workflow?.config ?? "")
        expect(config?.isolation).toBeUndefined()
        expect(config?.workspace).toBe(DagLocation.canonicalDirectory(linked))
      }),
    )
  })

  it("keeps the existing error for an authored isolation on a checkout with uncommitted changes", async () => {
    const dir = repo()
    writeFileSync(path.join(dir, "wip.txt"), "unsaved work\n")
    const probe = { creates: [] as string[] }
    await run(
      probe,
      Effect.gen(function* () {
        yield* seed([["ses_a", dir]])
        const text = yield* failureText(
          start({ session: "ses_a", directory: dir }, specs(strictSpec(false, { isolation: "worktree" }))),
        )
        expect(text).toContain("workflow worktree isolation requires a clean target")
        expect(probe.creates).toEqual([])
        expect(yield* (yield* DagStore.Service).listWorkflows()).toEqual([])
      }),
    )
  })

  it("isolates a strict start beside a live writer, but refuses it unisolated when the checkout is dirty", async () => {
    const clean = repo()
    const cleanProbe = { creates: [] as string[] }
    await run(
      cleanProbe,
      Effect.gen(function* () {
        yield* seed([
          ["ses_a", clean],
          ["ses_b", clean],
        ])
        yield* start({ session: "ses_a", directory: clean }, specs(writerSpec("holder")))
        // Its own worktree is a different directory, so the live writer does not clash.
        const isolated = yield* start({ session: "ses_b", directory: clean }, specs(strictSpec(false)))
        expect(isolated.title).toBe("Workflow started: strict-delivery")
        expect(cleanProbe.creates).toHaveLength(1)
      }),
    )

    const dirty = repo()
    writeFileSync(path.join(dirty, "wip.txt"), "unsaved work\n")
    const dirtyProbe = { creates: [] as string[] }
    await run(
      dirtyProbe,
      Effect.gen(function* () {
        yield* seed([
          ["ses_a", dirty],
          ["ses_b", dirty],
        ])
        yield* start({ session: "ses_a", directory: dirty }, specs(writerSpec("holder")))
        // Without isolation the strict writers would share the workspace.
        const refused = yield* start({ session: "ses_b", directory: dirty }, specs(strictSpec(false)))
        expect(refusal(refused.output).error_code).toBe("write_conflict")
        expect(dirtyProbe.creates).toEqual([])
      }),
    )
  })

  it("leaves an authored isolation alone", async () => {
    const dir = repo()
    const probe = { creates: [] as string[] }
    await run(
      probe,
      Effect.gen(function* () {
        yield* seed([["ses_a", dir]])
        const result = yield* start(
          { session: "ses_a", directory: dir },
          specs(strictSpec(false, { isolation: "worktree" })),
        )
        expect(result.output).not.toContain("Default isolation")
        expect(probe.creates).toHaveLength(1)
      }),
    )
  })

  it("compares the bound workspace, not the owner directory", async () => {
    const dir = repo()
    const linked = path.join(tmpdir(), `write-guard-bound-${Math.random().toString(36).slice(2)}`)
    roots.push(linked)
    git(dir, ["worktree", "add", "--detach", linked, "HEAD"])
    const bound = DagLocation.canonicalDirectory(linked)
    const inLinked = (name: string) =>
      specs({ config: { name, objective: "Work there", workspace: bound, blocks: [{ id: "impl", kind: "coding" }] } })
    await run(
      { creates: [] },
      Effect.gen(function* () {
        yield* seed([
          ["ses_a", dir],
          ["ses_b", dir],
        ])
        const first = yield* start({ session: "ses_a", directory: dir }, inLinked("first"))
        expect(first.title).toBe("Workflow started: first")
        // Same bound worktree: the writers share it even though both owners are `dir`.
        const second = yield* start({ session: "ses_b", directory: dir }, inLinked("second"))
        const body = refusal(second.output)
        expect(body.error_code).toBe("write_conflict")
        expect(body.conflicts?.map((conflict) => conflict.workspace)).toEqual([bound])
        // The owner checkout itself is a different workspace, so it stays free.
        const owner = yield* start({ session: "ses_b", directory: dir }, specs(writerSpec("owner")))
        expect(owner.title).toBe("Workflow started: owner")
      }),
    )
  })
})
