// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1324 §4: `dag.permission: "readonly"` refuses `workflow start` for any
// graph with a writer, ahead of and regardless of the plan-agent gate
// (#1031 M8) `run.ts` already has. `runWorkflow` runs against the real `Dag`
// and `DagControl` over an in-memory database, the same idiom as
// workflow-start-write-guard.test.ts; only `Config` is a test double here, so
// the tier under test is explicit.
// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Typed service
// mocks and tool-call shapes implement only what this harness calls, the same
// idiom as workflow-start-write-guard.test.ts.
import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionSchema } from "@graphagent/core/session/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { WorkflowAuthoring } from "@/dag/authoring"
import { DagControl } from "@/dag/control"
import { Dag } from "@/dag/dag"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, SessionID } from "@/session/schema"
import type { Tool } from "@/tool/tool"
import { runWorkflow } from "@/tool/workflow/run"
import type { RunParams } from "@/tool/workflow/schema"
import { Worktree } from "@/worktree"
import { TestConfig } from "../fixture/config"
import { transactLayer } from "./fixture/transact"

const roots: string[] = []
const projectID = "project-readonly-1"

function git(directory: string, args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim()
}

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "write-guard-readonly-repo-"))
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

const specs = (() => {
  const root = mkdtempSync(path.join(tmpdir(), "write-guard-readonly-specs-"))
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

/** The tier the fake global configuration reports; `undefined` is the `allow` default. */
function runtime(tier?: "allow" | "ask" | "readonly") {
  const database = Database.defaultLayer
  const events = EventV2.defaultLayer.pipe(Layer.provide(database))
  const store = DagStore.defaultLayer.pipe(Layer.provide(database))
  const projector = DagProjector.defaultLayer.pipe(Layer.provide(Layer.merge(database, events)))
  const worktree = Layer.mock(Worktree.Service, {
    create: () => Effect.die(new Error("not needed: no strict workflow in this file needs isolation")),
    remove: () => Effect.succeed(true),
  })
  const instanceStore = Layer.succeed(InstanceStore.Service, {
    provide: (input: { directory: string }, effect: Effect.Effect<unknown>) =>
      Effect.provideService(effect, InstanceRef, { directory: input.directory } as never),
  } as never)
  const bridge = EventV2Bridge.defaultLayer.pipe(Layer.provide(Layer.merge(database, events)))
  const dag = Layer.provideMerge(
    Dag.layer,
    Layer.mergeAll(database, events, store, projector, worktree, instanceStore, bridge, transactLayer(database)),
  )
  const config = TestConfig.layer({ dagGlobal: () => Effect.succeed(tier ? { permission: tier } : {}) })
  return Layer.mergeAll(dag, DagControl.layer.pipe(Layer.provide(dag)), config)
}

const authoring = WorkflowAuthoring.make({
  loadEnvironment: () => Effect.succeed({ writer_types: new Set(["build", "general"]) }),
})

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

const writerSpec = (name = "implement") => ({
  config: { name, objective: "Apply the change", blocks: [{ id: "impl", kind: "coding" }] },
})
const readOnlySpec = (name = "research") => ({
  config: { name, objective: "Map the module", blocks: [{ id: "scan", kind: "explore" }] },
})

interface Refusal {
  workflow_created: boolean
  error_code: string
  message: string
  writers?: string[]
}
const refusal = (output: string) => JSON.parse(output) as Refusal
const workflowID = (output: string) => /<workflow id="([^"]+)"/.exec(output)?.[1] ?? ""

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Services = Dag.Service | DagControl.Service | Database.Service | DagStore.Service

const run = <A, E>(tier: "allow" | "ask" | "readonly" | undefined, effect: Effect.Effect<A, E, Services>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(runtime(tier))))

describe("dag.permission: readonly on workflow start", () => {
  it("refuses a graph with a writer, for the build agent, with a message naming dag.permission", async () => {
    const dir = repo()
    await run(
      "readonly",
      Effect.gen(function* () {
        yield* seed([["ses_build", dir]])
        const result = yield* start({ session: "ses_build", directory: dir, agent: "build" }, specs(writerSpec()))
        expect(result.title).toBe('Workflow not started: dag.permission is "readonly"')
        expect(result.metadata).toMatchObject({ blocked: true })
        const body = refusal(result.output)
        expect(body.workflow_created).toBe(false)
        expect(body.error_code).toBe("permission_readonly")
        expect(body.writers).toEqual(["impl"])
        expect(body.message).toContain("dag.permission")
        expect(yield* (yield* DagStore.Service).listWorkflows()).toEqual([])
      }),
    )
  })

  it("starts a graph whose nodes are all read-only", async () => {
    const dir = repo()
    await run(
      "readonly",
      Effect.gen(function* () {
        yield* seed([["ses_build", dir]])
        const result = yield* start({ session: "ses_build", directory: dir, agent: "build" }, specs(readOnlySpec()))
        expect(result.title).toBe("Workflow started: research")
        expect(workflowID(result.output)).toStartWith("dag_")
        expect((yield* (yield* DagStore.Service).listWorkflows()).map((workflow) => workflow.status)).toEqual([
          "running",
        ])
      }),
    )
  })

  it("leaves the allow and ask tiers to start a writer graph", async () => {
    for (const tier of [undefined, "allow" as const, "ask" as const]) {
      const dir = repo()
      await run(
        tier,
        Effect.gen(function* () {
          yield* seed([["ses_build", dir]])
          const result = yield* start({ session: "ses_build", directory: dir, agent: "build" }, specs(writerSpec()))
          expect(result.title).toBe("Workflow started: implement")
        }),
      )
    }
  })
})
