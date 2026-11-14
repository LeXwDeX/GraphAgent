// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Typed service
 * mocks and a minimal instance context exercise the real store, event and
 * projector services; same idiom as dag-isolation-worktree.test.ts. */
import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"
import type { DagStore } from "@graphagent/core/dag/store"
import { DagProjector } from "@graphagent/core/dag/projector"
import { DagStore as DagStoreModule } from "@graphagent/core/dag/store"
import { WorkflowTable } from "@graphagent/core/dag/sql"
import { EventV2 } from "@graphagent/core/event"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionSchema } from "@graphagent/core/session/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import type { DagEvent } from "@graphagent/schema/dag-event"
import type { WorkflowConfig } from "@/dag/dag"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Worktree } from "@/worktree"
import { workflowArtifactsRoot } from "@/dag/runtime/output-ref"
import { settleTerminalWorkflowWorktree, settleWorkflowWorktree } from "@/dag/runtime/worktree-completion"
import { workflowWorktreeText } from "@/dag/runtime/report-delivery"
import { renderStatus } from "@/tool/workflow/render"
import { makeWorkflowRow } from "./fixtures"

const roots: string[] = []

function git(directory: string, args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim()
}

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "dag-workflow-settle-"))
  roots.push(root)
  git(root, ["init"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  writeFileSync(path.join(root, "base.txt"), "base\n")
  git(root, ["add", "-A"])
  git(root, ["commit", "-m", "base"])
  return root
}

function worktree(root: string, dagID: string): { directory: string; branch: string; baseHead: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "dag-workflow-settle-wt-"))
  roots.push(directory)
  rmSync(directory, { recursive: true, force: true })
  const branch = `opencode/dag-${dagID}-workflow`
  git(root, ["worktree", "add", "-b", branch, directory, "HEAD"])
  return { directory, branch, baseHead: git(root, ["rev-parse", "HEAD"]) }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Harness {
  published: DagEvent.WorkflowWorktree[]
  removals: { directory: string; keepBranch: boolean }[]
}

function settle(input: {
  repository: string
  dagID: string
  status: "completed" | "failed" | "cancelled"
  config: WorkflowConfig
  failRemoval?: boolean
}) {
  const harness: Harness = { published: [], removals: [] }
  let row = makeWorkflowRow({
    id: input.dagID,
    projectId: "proj-settle",
    status: input.status,
    directory: input.repository,
    config: JSON.stringify(input.config),
    worktree: null,
  })
  const store = {
    getWorkflow: () => Effect.succeed(row),
  } as unknown as DagStore.Interface
  const effect = settleWorkflowWorktree({
    dagID: input.dagID,
    status: input.status,
    config: input.config,
    store,
    projectID: "proj-settle",
    remove: (directory, options) =>
      Effect.sync(() => {
        harness.removals.push({ directory, ...options })
        if (input.failRemoval) return false
        execFileSync("git", ["-C", input.repository, "worktree", "remove", "--force", directory])
        return true
      }),
    publish: (worktree) =>
      Effect.sync(() => {
        harness.published.push(worktree)
        // The real projector folds workflow.worktree in the publish transaction.
        row = { ...row, worktree }
      }),
  })
  return { harness, effect, getRow: () => row }
}

function config(repository: string, dagID: string): { config: WorkflowConfig; pointer: ReturnType<typeof worktree> } {
  const pointer = worktree(repository, dagID)
  return {
    pointer,
    config: {
      name: "workflow",
      isolation: "worktree",
      worktree: pointer,
      nodes: [],
    },
  }
}

describe("workflow-level worktree settlement (#1030)", () => {
  it("commits pending work, writes a patch and removes the directory on completion (keeping the branch)", async () => {
    const repository = repo()
    const dagID = "dag_settle_completed"
    const { config: cfg, pointer } = config(repository, dagID)
    writeFileSync(path.join(pointer.directory, "fix.txt"), "fixed\n")
    const { harness, effect } = settle({ repository, dagID, status: "completed", config: cfg })

    expect(await Effect.runPromise(effect)).toBe("settled")

    const settled = harness.published[0]
    expect(settled).toEqual(
      expect.objectContaining({
        directory: pointer.directory,
        branch: pointer.branch,
        baseHead: pointer.baseHead,
        state: "removed",
        touchedPaths: ["fix.txt"],
      }),
    )
    expect(settled?.head).toBeDefined()
    expect(settled?.patchPath).toBeDefined()
    expect(readFileSync(settled?.patchPath ?? "", "utf8")).toContain("fix.txt")
    expect(harness.removals).toEqual([{ directory: pointer.directory, keepBranch: true }])
    expect(existsSync(pointer.directory)).toBe(false)
    expect(git(repository, ["branch", "--list", pointer.branch])).toContain(pointer.branch)
    rmSync(workflowArtifactsRoot("proj-settle"), { recursive: true, force: true })
  })

  for (const status of ["failed", "cancelled"] as const)
    it(`keeps the worktree and branch on ${status} while still committing evidence`, async () => {
      const repository = repo()
      const dagID = `dag_settle_${status}`
      const { config: cfg, pointer } = config(repository, dagID)
      writeFileSync(path.join(pointer.directory, "attempt.txt"), "attempt\n")
      const { harness, effect } = settle({ repository, dagID, status, config: cfg })

      expect(await Effect.runPromise(effect)).toBe("settled")

      const settled = harness.published[0]
      expect(settled?.state).toBe("kept")
      expect(settled?.head).toBeDefined()
      expect(settled?.patchPath).toBeDefined()
      expect(settled?.touchedPaths).toEqual(["attempt.txt"])
      expect(harness.removals).toEqual([])
      expect(existsSync(pointer.directory)).toBe(true)
      expect(git(repository, ["branch", "--list", pointer.branch])).toContain(pointer.branch)
      rmSync(workflowArtifactsRoot("proj-settle"), { recursive: true, force: true })
    })

  it("is idempotent: a repeated settlement publishes exactly once", async () => {
    const repository = repo()
    const dagID = "dag_settle_idempotent"
    const { config: cfg } = config(repository, dagID)
    const { harness, effect } = settle({ repository, dagID, status: "failed", config: cfg })

    expect(await Effect.runPromise(effect)).toBe("settled")
    expect(await Effect.runPromise(effect)).toBe("already_settled")

    expect(harness.published).toHaveLength(1)
    rmSync(workflowArtifactsRoot("proj-settle"), { recursive: true, force: true })
  })

  it("records a kept state with the reason when removal fails", async () => {
    const repository = repo()
    const dagID = "dag_settle_remove_fails"
    const { config: cfg, pointer } = config(repository, dagID)
    const { harness, effect } = settle({ repository, dagID, status: "completed", config: cfg, failRemoval: true })

    expect(await Effect.runPromise(effect)).toBe("settled")

    expect(harness.published[0]).toEqual(
      expect.objectContaining({ state: "kept", reason: "worktree remove returned false" }),
    )
    expect(existsSync(pointer.directory)).toBe(true)
    rmSync(workflowArtifactsRoot("proj-settle"), { recursive: true, force: true })
  })

  it("records a removed state when the directory is already gone", async () => {
    const repository = repo()
    const dagID = "dag_settle_missing"
    const { config: cfg, pointer } = config(repository, dagID)
    rmSync(pointer.directory, { recursive: true, force: true })
    const { harness, effect } = settle({ repository, dagID, status: "completed", config: cfg })

    expect(await Effect.runPromise(effect)).toBe("settled")
    expect(harness.published[0]).toEqual(
      expect.objectContaining({ state: "removed", reason: "worktree directory is missing" }),
    )
  })

  it("does nothing for a workflow without workflow-level isolation", async () => {
    const repository = repo()
    const dagID = "dag_settle_plain"
    const { harness, effect } = settle({
      repository,
      dagID,
      status: "completed",
      config: { name: "plain", nodes: [] },
    })

    expect(await Effect.runPromise(effect)).toBe("not_isolated")
    expect(harness.published).toEqual([])
  })
})

describe("terminal workflow worktree settlement seam (#1030)", () => {
  function layers(input: {
    repository: string
    removals: string[]
  }) {
    const database = Database.layerFromPath(":memory:")
    const events = EventV2.layer.pipe(Layer.provide(database))
    const bridge = EventV2Bridge.layer.pipe(Layer.provide(events))
    const store = DagStoreModule.layer.pipe(Layer.provide(database))
    const projector = DagProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
    const worktree = Layer.mock(Worktree.Service, {
      remove: (values: { directory: string; keepBranch?: boolean }) =>
        Effect.sync(() => {
          input.removals.push(values.directory)
          execFileSync("git", ["-C", input.repository, "worktree", "remove", "--force", values.directory])
          return true
        }),
    })
    return Layer.mergeAll(database, events, bridge, store, projector, worktree)
  }

  const seedWorkflow = (input: {
    repository: string
    dagID: string
    status: string
    config: WorkflowConfig
  }) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({
          id: Project.ID.make("project-1"),
          worktree: AbsolutePath.make(input.repository),
          sandboxes: [],
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionSchema.ID.make("ses_parent"),
          project_id: Project.ID.make("project-1"),
          slug: "parent",
          directory: AbsolutePath.make(input.repository),
          title: "Parent",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(WorkflowTable)
        .values({
          id: input.dagID,
          project_id: Project.ID.make("project-1"),
          session_id: SessionSchema.ID.make("ses_parent"),
          directory: input.repository,
          execution_directory: input.config.worktree?.directory ?? null,
          target_fingerprint: { kind: "none" },
          title: "terminal",
          status: input.status,
          config: JSON.stringify(input.config),
          seq: 7,
          completed_at: 1_000,
          time_updated: 1_000,
        })
        .run()
        .pipe(Effect.orDie)
    })

  it("settles through the real projector and folds workflow.worktree once", async () => {
    const repository = repo()
    const dagID = "dag_terminal"
    const { config: cfg, pointer } = config(repository, dagID)
    writeFileSync(path.join(pointer.directory, "final.txt"), "final\n")
    const removals: string[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* seedWorkflow({ repository, dagID, status: "completed", config: cfg })
          const store = yield* DagStoreModule.Service
          const bridge = yield* EventV2Bridge.Service
          const settle = () =>
            settleTerminalWorkflowWorktree({
              dagID,
              store,
              publish: bridge.publish,
              ambient: { directory: repository },
            }).pipe(
              Effect.provideService(InstanceRef, {
                directory: repository,
                worktree: repository,
                root: repository,
                project: { id: "project-1", directory: repository },
              } as never),
            )

          yield* settle()
          const settled = yield* store.getWorkflow(dagID)
          expect(settled?.worktree).toEqual(
            expect.objectContaining({
              directory: pointer.directory,
              branch: pointer.branch,
              state: "removed",
              touchedPaths: ["final.txt"],
            }),
          )
          expect(settled?.seq).toBe(7)
          expect(removals).toEqual([pointer.directory])

          // A second observer is a pure no-op: no second event, no disk action.
          yield* settle()
          expect(removals).toEqual([pointer.directory])
        }),
      ).pipe(Effect.provide(layers({ repository, removals }))) as Effect.Effect<never>,
    )
    expect(git(repository, ["branch", "--list", pointer.branch])).toContain(pointer.branch)
    rmSync(workflowArtifactsRoot("proj-settle"), { recursive: true, force: true })
  })

  it("does not settle when a sibling instance observes the terminal event", async () => {
    const repository = repo()
    const dagID = "dag_terminal_foreign"
    const { config: cfg, pointer } = config(repository, dagID)
    const other = mkdtempSync(path.join(tmpdir(), "dag-other-instance-"))
    roots.push(other)
    const removals: string[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* seedWorkflow({ repository, dagID, status: "completed", config: cfg })
          const store = yield* DagStoreModule.Service
          const bridge = yield* EventV2Bridge.Service
          yield* settleTerminalWorkflowWorktree({
            dagID,
            store,
            publish: bridge.publish,
            ambient: { directory: other },
          }).pipe(
            Effect.provideService(InstanceRef, {
              directory: other,
              worktree: other,
              root: other,
              project: { id: "project-1", directory: other },
            } as never),
          )

          expect((yield* store.getWorkflow(dagID))?.worktree ?? null).toBeNull()
          expect(removals).toEqual([])
          expect(existsSync(pointer.directory)).toBe(true)
        }),
      ).pipe(Effect.provide(layers({ repository, removals }))) as Effect.Effect<never>,
    )
  })
})

describe("workflow worktree views (#1030)", () => {
  const settled = {
    directory: "/repo/.agents/worktree/dag-dag_x-workflow",
    branch: "opencode/dag-dag_x-workflow",
    baseHead: "base-sha-123456",
    head: "head-sha-123456",
    patchPath: "/reports/dag_x/_workflow.patch",
    patchSha256: "patch-sha",
    touchedPaths: ["src/a.ts"],
    state: "kept" as const,
  }

  it("status distinguishes the live config pointer from the settled evidence", () => {
    const live = makeWorkflowRow({
      config: JSON.stringify({
        name: "wf",
        isolation: "worktree",
        worktree: { directory: settled.directory, branch: settled.branch, baseHead: settled.baseHead },
        nodes: [],
      }),
    })
    const liveView = JSON.parse(renderStatus({ workflow: live, nodes: [], allNodes: [] }).output)
    expect(liveView.isolation).toBe("worktree")
    expect(liveView.worktree).toEqual({
      directory: settled.directory,
      branch: settled.branch,
      base: settled.baseHead,
      state: "active",
    })

    const done = makeWorkflowRow({ status: "completed", worktree: settled })
    const doneView = JSON.parse(renderStatus({ workflow: done, nodes: [], allNodes: [] }).output)
    expect(doneView.worktree).toEqual({
      directory: settled.directory,
      branch: settled.branch,
      base: settled.baseHead,
      head: settled.head,
      patch: settled.patchPath,
      patch_sha256: settled.patchSha256,
      touched_paths: settled.touchedPaths,
      state: "kept",
    })
  })

  it("formats directory/branch/base/head/patch evidence for report and wake text", () => {
    const text = workflowWorktreeText(settled)
    expect(text).toContain(`directory=${settled.directory}`)
    expect(text).toContain(`branch=${settled.branch}`)
    expect(text).toContain("base=base-sha-123")
    expect(text).toContain("head=head-sha-123")
    expect(text).toContain(`patch=${settled.patchPath}`)
    expect(text).toContain("state=kept")
  })
})