// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Typed service
// mocks and branded DB rows implement only the methods this harness calls,
// same idiom as dag-isolation-worktree.test.ts.
// oxlint-disable typescript-eslint/no-unnecessary-type-assertion -- Array
// indexing is checked by the preceding expectations; keep the assertions
// explicit for readability.
import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Cause, Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore } from "@graphagent/core/dag/store"
import { WorkflowNodeTable, WorkflowTable } from "@graphagent/core/dag/sql"
import { EventTable } from "@graphagent/core/event/sql"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionSchema } from "@graphagent/core/session/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { Dag, parseWorkflowConfig, type NodeConfig } from "@/dag/dag"
import { DagLocation } from "@/dag/location"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import { Worktree } from "@/worktree"

const roots: string[] = []

function git(directory: string, args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim()
}

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "dag-workflow-isolation-"))
  roots.push(root)
  git(root, ["init"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  writeFileSync(path.join(root, "base.txt"), "base\n")
  git(root, ["add", "-A"])
  git(root, ["commit", "-m", "base"])
  return root
}

function node(id: string): NodeConfig {
  return {
    id,
    name: id,
    worker_type: "build",
    depends_on: [],
    required: true,
    prompt_template: { inline: id },
  }
}

interface WorktreeProbe {
  creates: { name?: string }[]
  removals: { directory: string; keepBranch?: boolean }[]
  created: string[]
  failCreate: boolean
}

function baseLayer(probe: WorktreeProbe, bridge?: Layer.Layer<EventV2Bridge.Service>) {
  const database = Database.defaultLayer
  const events = EventV2.defaultLayer.pipe(Layer.provide(database))
  const store = DagStore.defaultLayer.pipe(Layer.provide(database))
  const projector = DagProjector.defaultLayer.pipe(Layer.provide(Layer.merge(database, events)))
  const worktree = Layer.mock(Worktree.Service, {
    create: (input?: { name?: string }) =>
      Effect.gen(function* () {
        probe.creates.push(input?.name ? { name: input.name } : {})
        if (probe.failCreate)
          return yield* Effect.fail(new Worktree.CreateFailedError({ message: "worktree create exploded" }))
        const ctx = yield* InstanceRef
        const directory = mkdtempSync(path.join(tmpdir(), "dag-workflow-wt-"))
        roots.push(directory)
        rmSync(directory, { recursive: true, force: true })
        execFileSync("git", ["-C", ctx!.directory, "worktree", "add", "--detach", directory, "HEAD"])
        probe.created.push(DagLocation.canonicalDirectory(directory))
        return { name: input?.name ?? "wt", branch: `opencode/${input?.name ?? "wt"}`, directory }
      }),
    remove: (input: { directory: string; keepBranch?: boolean }) =>
      Effect.gen(function* () {
        probe.removals.push(input)
        const ctx = yield* InstanceRef
        execFileSync("git", ["-C", ctx!.directory, "worktree", "remove", "--force", input.directory])
        return true
      }),
  })
  const instanceStore = Layer.succeed(InstanceStore.Service, {
    provide: (input: { directory: string }, effect: Effect.Effect<unknown>) =>
      Effect.provideService(effect, InstanceRef, { directory: input.directory } as never),
  } as never)
  const bridgeLayer = bridge ?? EventV2Bridge.defaultLayer.pipe(Layer.provide(Layer.merge(database, events)))
  return Layer.provideMerge(
    Dag.layer,
    Layer.mergeAll(database, events, store, projector, worktree, instanceStore, bridgeLayer),
  )
}

function seed(repository: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.make("project-1"), worktree: AbsolutePath.make(repository), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionSchema.ID.make("ses_create"),
        project_id: Project.ID.make("project-1"),
        slug: "create",
        directory: AbsolutePath.make(repository),
        title: "Create",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

const newProbe = (overrides: Partial<WorktreeProbe> = {}): WorktreeProbe => ({
  creates: [],
  removals: [],
  created: [],
  failCreate: false,
  ...overrides,
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("Dag.create workflow-level worktree isolation (#1030)", () => {
  it("creates the worktree before WorkflowCreated and binds the config and execution directory", async () => {
    const repository = repo()
    const probe = newProbe()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* seed(repository)
          const dag = yield* Dag.Service
          const store = yield* DagStore.Service
          const dagID = yield* dag
            .create({
              projectID: Project.ID.make("project-1"),
              sessionID: "ses_create",
              title: "isolated",
              config: { name: "isolated", isolation: "worktree", nodes: [node("a")] },
            })
            .pipe(Effect.orDie)

          const workflow = yield* store.getWorkflow(dagID)
          const config = parseWorkflowConfig(workflow?.config ?? "")
          expect(probe.creates).toHaveLength(1)
          expect(probe.creates[0]?.name).toStartWith("dag-dag_")
          expect(probe.creates[0]?.name).toEndWith("-workflow")
          expect(config?.isolation).toBe("worktree")
          expect(config?.worktree?.directory).toBe(probe.created[0])
          expect(config?.worktree?.branch).toBe(`opencode/${probe.creates[0]?.name}`)
          expect(config?.worktree?.baseHead).toBe(git(repository, ["rev-parse", "HEAD"]))
          expect(workflow?.executionDirectory).toBe(probe.created[0])
          expect(workflow?.targetFingerprint).toEqual(
            expect.objectContaining({ kind: "git", head: config?.worktree?.baseHead }),
          )
          // The workflow worktree is a plain checkout: children run at its top
          // level and create no nested worktree state of their own.
          expect(git(probe.created[0], ["status", "--porcelain"])).toBe("")
        }),
      ).pipe(Effect.provide(baseLayer(probe))) as Effect.Effect<never>,
    )
  })

  it("publishes zero events and removes nothing when worktree creation fails", async () => {
    const repository = repo()
    const probe = newProbe({ failCreate: true })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* seed(repository)
          const dag = yield* Dag.Service
          const { db } = yield* Database.Service
          const error = yield* dag
            .create({
              projectID: Project.ID.make("project-1"),
              sessionID: "ses_create",
              title: "isolated",
              config: { name: "isolated", isolation: "worktree", nodes: [node("a")] },
            })
            .pipe(Effect.catch((cause: Error) => Effect.succeed(cause)))
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).message).toContain("workflow worktree create failed: worktree create exploded")
          expect(yield* db.select().from(WorkflowTable).all()).toEqual([])
          expect(yield* db.select().from(EventTable).all()).toEqual([])
          expect(probe.removals).toEqual([])
        }),
      ).pipe(Effect.provide(baseLayer(probe))) as Effect.Effect<never>,
    )
  })

  it("rolls back the created worktree when a create event cannot be published", async () => {
    const repository = repo()
    const probe = newProbe()
    const failingBridge = Layer.mock(EventV2Bridge.Service, {
      publish: () => Effect.die(new Error("publish failed")),
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* seed(repository)
          const dag = yield* Dag.Service
          const { db } = yield* Database.Service
          const exit = yield* Effect.exit(
            dag.create({
              projectID: Project.ID.make("project-1"),
              sessionID: "ses_create",
              title: "isolated",
              config: { name: "isolated", isolation: "worktree", nodes: [node("a")] },
            }),
          )
          expect(exit._tag).toBe("Failure")
          expect(exit._tag === "Failure" ? Cause.pretty(exit.cause) : "").toContain("publish failed")
          expect(probe.creates).toHaveLength(1)
          expect(probe.removals).toEqual([{ directory: probe.created[0], keepBranch: false }])
          expect(yield* db.select().from(WorkflowTable).all()).toEqual([])
        }),
      ).pipe(Effect.provide(baseLayer(probe, failingBridge))) as Effect.Effect<never>,
    )
  })

  it("rejects reopening a completed isolated workflow instead of spawning into a removed worktree", async () => {
    const repository = repo()
    const probe = newProbe()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* seed(repository)
          const dag = yield* Dag.Service
          const { db } = yield* Database.Service
          const dagID = "dag_reopen"
          const config = {
            name: "isolated",
            isolation: "worktree",
            worktree: { directory: "/settled-away", branch: "opencode/dag-dag_reopen-workflow" },
            nodes: [node("checkpoint")],
          }
          yield* db
            .insert(WorkflowTable)
            .values({
              id: dagID,
              project_id: Project.ID.make("project-1"),
              session_id: SessionSchema.ID.make("ses_create"),
              directory: repository,
              execution_directory: "/settled-away",
              target_fingerprint: { kind: "none" },
              title: "reopen",
              status: "completed",
              config: JSON.stringify(config),
              seq: 5,
              wake_reported: true,
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(WorkflowNodeTable)
            .values({
              id: "checkpoint",
              workflow_id: dagID,
              name: "checkpoint",
              worker_type: "build",
              status: "completed",
              required: true,
              depends_on: [],
              wake_eligible: true,
              seq: 1,
            })
            .run()
            .pipe(Effect.orDie)

          const error = yield* dag
            .extend(Dag.ID.make(dagID), [node("next")])
            .pipe(Effect.catch((cause: Error) => Effect.succeed(cause)))
          expect((error as Error).message).toContain("Reopen rejected")
          expect((error as Error).message).toContain("bounded successor workflow")
        }),
      ).pipe(Effect.provide(baseLayer(probe))) as Effect.Effect<never>,
    )
  })

  it("never touches the Worktree service without config.isolation", async () => {
    const repository = repo()
    const probe = newProbe()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* seed(repository)
          const dag = yield* Dag.Service
          yield* dag
            .create({
              projectID: Project.ID.make("project-1"),
              sessionID: "ses_create",
              title: "plain",
              config: { name: "plain", nodes: [node("a")] },
            })
            .pipe(Effect.orDie)
          expect(probe.creates).toEqual([])
          expect(probe.removals).toEqual([])
        }),
      ).pipe(Effect.provide(baseLayer(probe))) as Effect.Effect<never>,
    )
  })
})