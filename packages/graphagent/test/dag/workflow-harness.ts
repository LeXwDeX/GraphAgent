// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// Shared harness for the workflow tool tests that need a real `Dag`,
// `DagControl`, and database (#1073): the tool entry points (`runWorkflow`,
// `inspectWorkflow`, and the spec actions) run against an in-memory database,
// with no execution loop, so started nodes stay `pending` and a started workflow
// stays `running`. The Worktree service is a stub: none of these tests isolate.
// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Typed service
// mocks and tool-call shapes implement only what this harness calls, the same
// idiom as workflow-start-write-guard.test.ts.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { DagLease } from "@graphagent/core/dag/lease"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { DagTransact } from "@graphagent/core/dag/transact"
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
import { controlWorkflow } from "@/tool/workflow/control"
import { inspectWorkflow } from "@/tool/workflow/inspect"
import { runWorkflow } from "@/tool/workflow/run"
import type { ControlParams, InspectParams, RunParams } from "@/tool/workflow/schema"
import { draftSpec, listSpecs, readSpec, validateSpec } from "@/tool/workflow/spec"
import { Worktree } from "@/worktree"

export const projectID = "project-1"

const roots: string[] = []

/** Removes every directory this harness created; call from `afterEach`. */
export function cleanup() {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

function git(directory: string, args: string[]) {
  execFileSync("git", ["-C", directory, ...args], { stdio: ["ignore", "pipe", "ignore"] })
}

/** A clean git checkout with one commit. */
export function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-harness-repo-"))
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

/** Spec files live outside the checkouts so they never dirty them. JSON is
 * valid YAML, so a plain object serializes to a `.yaml` spec. */
export const writeSpec = (() => {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-harness-specs-"))
  let counter = 0
  return (value: unknown) => {
    // cleanup() removes every registered root, so register it on each use.
    mkdirSync(root, { recursive: true })
    roots.push(root)
    const file = path.join(root, `spec-${counter++}.yaml`)
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value))
    return file
  }
})()

/** The user's global scope must never leak into a test: point it at an empty
 * directory for the duration of `fn`. */
export async function withEmptyGlobalConfig<A>(fn: () => Promise<A>): Promise<A> {
  const previous = process.env.GRAPHAGENT_CONFIG_DIR
  const directory = mkdtempSync(path.join(tmpdir(), "workflow-harness-global-"))
  roots.push(directory)
  process.env.GRAPHAGENT_CONFIG_DIR = directory
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.GRAPHAGENT_CONFIG_DIR
    else process.env.GRAPHAGENT_CONFIG_DIR = previous
  }
}

export function runtime() {
  const database = Database.defaultLayer
  const events = EventV2.defaultLayer.pipe(Layer.provide(database))
  const store = DagStore.defaultLayer.pipe(Layer.provide(database))
  const projector = DagProjector.defaultLayer.pipe(Layer.provide(Layer.merge(database, events)))
  const worktree = Layer.mock(Worktree.Service, {
    create: () => Effect.die(new Error("workflow harness does not create worktrees")),
    remove: () => Effect.succeed(true),
  })
  const instanceStore = Layer.succeed(InstanceStore.Service, {
    provide: (input: { directory: string }, effect: Effect.Effect<unknown>) =>
      Effect.provideService(effect, InstanceRef, { directory: input.directory } as never),
  } as never)
  const bridge = EventV2Bridge.defaultLayer.pipe(Layer.provide(Layer.merge(database, events)))
  // As in production every Dag command runs in one IMMEDIATE transaction (#1029).
  const transact = DagTransact.layer.pipe(
    Layer.provide(Layer.merge(database, DagLease.layer.pipe(Layer.provide(database)))),
  )
  const dag = Layer.provideMerge(
    Dag.layer,
    Layer.mergeAll(database, events, store, projector, worktree, instanceStore, bridge, transact),
  )
  return Layer.merge(dag, DagControl.layer.pipe(Layer.provide(dag)))
}

/** The catalog only names the write-capable workers; worker, prompt and model
 * checks are skipped, as in the write-guard tests. */
export const authoring = WorkflowAuthoring.make({
  loadEnvironment: () => Effect.succeed({ writer_types: new Set(["build", "general"]) }),
})

export type Services = Dag.Service | DagControl.Service | Database.Service | DagStore.Service

export const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(runtime())))

/** Seeds the project and one session per `[id, directory]`. */
export function seed(sessions: ReadonlyArray<readonly [string, string]>) {
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

export const toolContext = (sessionID: string, agent: string) =>
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

export interface Caller {
  readonly session: string
  readonly directory: string
  readonly agent?: string
  /** The calling session's DAG mode; "on" fixes the strict review gate (#1560). */
  readonly dagMode?: "on" | "off"
}

const session = (caller: Caller) => ({
  directory: caller.directory,
  projectID,
  model: undefined,
  ...(caller.dagMode !== undefined ? { dagMode: caller.dagMode } : {}),
})

const runContext = (caller: Caller) =>
  Effect.gen(function* () {
    const dag = yield* Dag.Service
    const control = yield* DagControl.Service
    return {
      dag,
      control,
      authoring,
      sessionID: caller.session,
      session: session(caller),
      ctx: toolContext(caller.session, caller.agent ?? "build"),
    }
  })

export const start = (caller: Caller, specPath: string, inputs?: Record<string, unknown>) =>
  Effect.gen(function* () {
    return yield* runWorkflow(yield* runContext(caller), {
      action: "run",
      operation: "start",
      spec_path: specPath,
      ...(inputs !== undefined ? { inputs } : {}),
    } as RunParams)
  })

export const extend = (caller: Caller, workflowID: string, specPath: string) =>
  Effect.gen(function* () {
    return yield* runWorkflow(yield* runContext(caller), {
      action: "run",
      operation: "extend",
      workflow_id: workflowID,
      spec_path: specPath,
    } as RunParams)
  })

export const replan = (caller: Caller, workflowID: string, specPath: string) =>
  Effect.gen(function* () {
    const context = yield* runContext(caller)
    return yield* controlWorkflow(context, {
      action: "control",
      operation: "replan",
      workflow_id: workflowID,
      spec_path: specPath,
    } as ControlParams)
  })

export const status = (caller: Caller, workflowID: string, maxTotalNodes?: number) =>
  Effect.gen(function* () {
    const dag = yield* Dag.Service
    // The user's global cap, when the caller wants one in play.
    const config =
      maxTotalNodes === undefined
        ? undefined
        : { dagGlobal: () => Effect.succeed({ max_total_nodes: maxTotalNodes } as never) }
    return yield* inspectWorkflow({ dag, sessionID: caller.session, ...(config ? { config } : {}) }, {
      action: "inspect",
      operation: "status",
      workflow_id: workflowID,
    } as InspectParams)
  })

export const control = (caller: Caller, workflowID: string, operation: "cancel" | "pause" | "resume") =>
  Effect.gen(function* () {
    const context = yield* runContext(caller)
    return yield* controlWorkflow(context, {
      action: "control",
      operation,
      workflow_id: workflowID,
    } as ControlParams)
  })

export const list = (caller: Caller) => listSpecs(authoring, session(caller))

export const read = (caller: Caller, specPath: string) =>
  readSpec(authoring, specPath, session(caller), toolContext(caller.session, caller.agent ?? "build"))

export const draft = (caller: Caller, config: Parameters<typeof draftSpec>[1], title?: string) =>
  draftSpec(authoring, config, title, session(caller), toolContext(caller.session, caller.agent ?? "build"))

export const validate = (caller: Caller, specPath: string, inputs?: Record<string, unknown>) =>
  validateSpec(
    authoring,
    specPath,
    "portable",
    inputs,
    session(caller),
    toolContext(caller.session, caller.agent ?? "build"),
  )

/** The error message a refused call surfaces to the model. */
export const failureText = <A, R>(effect: Effect.Effect<A, never, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) return yield* Effect.die(new Error("expected the call to be refused"))
    return Cause.pretty(exit.cause)
  })

export const workflowID = (output: string) => /<workflow id="([^"]+)"/.exec(output)?.[1] ?? ""
