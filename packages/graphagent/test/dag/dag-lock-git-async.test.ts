// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { $ } from "bun"
import { eq } from "drizzle-orm"
import { Effect, Fiber } from "effect"
import path from "node:path"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { Database } from "@graphagent/core/database/database"
import { WorkflowTable } from "@graphagent/core/dag/sql"
import { DagStore } from "@graphagent/core/dag/store"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { Session } from "@graphagent/schema/session"
import { Dag, type NodeConfig, type WorkflowConfig } from "@/dag/dag"
import { DagLocation } from "@/dag/location"
import { tmpdir } from "../fixture/fixture"
import { installGitGate, withoutGit } from "./fixture/git-shim"
import { spiedLayer, watchGit } from "./fixture/git-watch"

// #1344: the git a command runs while it holds the workflow lock waits without
// blocking the event loop, gives the verdict the synchronous call gave, and, where
// the command has a transaction, runs before it opens (ADR-0008 decision 3). The
// shims are bash scripts.
const posixIt = it.skipIf(process.platform === "win32")

/** The commands `resolveWorkspace` asks git for, as a shim pattern: slowed down by 150 ms each. */
const SLOW_RESOLVE = "*--git-common-dir*|*worktree*"

/** What an operation did to the event loop: a free loop runs a 10 ms interval about every 10 ms. */
async function measured<A>(run: () => Promise<A>) {
  let ticks = 0
  const timer = setInterval(() => {
    ticks++
  }, 10)
  const started = performance.now()
  try {
    const value = await run()
    return { value, ticks, elapsed: performance.now() - started }
  } finally {
    clearInterval(timer)
  }
}

/**
 * `commands` slowed git commands (150 ms each) really ran, and the loop kept
 * turning while they did. A blocked loop cannot run the interval while git runs;
 * a free one runs it about 15 times per command, so the bound leaves a wide
 * margin for load.
 */
function expectUnblocked(result: { ticks: number; elapsed: number }, commands: number) {
  expect(result.elapsed).toBeGreaterThan(commands * 100)
  expect(result.ticks).toBeGreaterThan(commands * 4)
}

const projectID = Project.ID.make("project-lock-git-async")
const sessionID = Session.ID.make("ses_lock_git_async_parent")

const node = (id: string, workerType: string, extra: Partial<NodeConfig> = {}): NodeConfig => ({
  id,
  name: id,
  worker_type: workerType,
  depends_on: [],
  required: false,
  prompt_template: { inline: id },
  ...extra,
})

/** A running workflow owned by `directory` (the directory of its session). */
function start(directory: string, config: WorkflowConfig) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: projectID, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        slug: "lock-git",
        directory,
        title: "Lock git",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const dag = yield* Dag.Service
    const dagID = yield* dag.create({ projectID, sessionID, title: "lock git", config })
    return { dag, dagID }
  })
}

/** The recording shim, installed for the rest of the scope; `slow` names the commands to slow down. */
const shimmed = (watch: ReturnType<typeof watchGit>, slow?: string) =>
  Effect.acquireRelease(
    Effect.promise(() => watch.install(slow)),
    (installed) => Effect.promise(() => installed.dispose()),
  )

/** A shim that parks every git command until released; disposing it releases whatever is still parked. */
const gate = Effect.acquireRelease(
  Effect.promise(() => installGitGate()),
  (installed) => Effect.promise(() => installed.dispose()),
)

describe("resolveWorkspaceAsync gives the verdicts of resolveWorkspace", () => {
  const resolveBoth = async (workspace: string, owner: string) => {
    const asynchronous = await Effect.runPromise(DagLocation.resolveWorkspaceAsync(workspace, owner))
    expect(asynchronous).toEqual(DagLocation.resolveWorkspace(workspace, owner))
    return asynchronous
  }

  const expectInvalid = async (workspace: string, owner: string, reason: string) => {
    const resolved = await resolveBoth(workspace, owner)
    expect(resolved._tag).toBe("invalid")
    if (resolved._tag === "invalid") expect(resolved.reason).toContain(reason)
  }

  it("accepts a linked worktree, through a link too, and rejects every other workspace the same way", async () => {
    await using owner = await tmpdir({ git: true })
    await using other = await tmpdir({ git: true })
    await using plain = await tmpdir()
    const linked = path.join(owner.path, "linked")
    await $`git worktree add ${linked} -b lock-git-linked`.cwd(owner.path).quiet()
    const alias = path.join(plain.path, "alias")
    symlinkSync(linked, alias)
    const file = path.join(plain.path, "file.txt")
    writeFileSync(file, "not a directory")
    const subdirectory = path.join(owner.path, "sub")
    mkdirSync(subdirectory)

    const ok = {
      _tag: "ok",
      directory: DagLocation.canonicalDirectory(linked),
    } satisfies DagLocation.WorkspaceResolution
    expect(await resolveBoth(linked, owner.path)).toEqual(ok)
    expect(await resolveBoth(alias, owner.path)).toEqual(ok)
    await expectInvalid("relative/path", owner.path, "must be an absolute path")
    await expectInvalid(path.join(plain.path, "missing"), owner.path, "does not exist")
    await expectInvalid(file, owner.path, "is not a directory")
    await expectInvalid(linked, plain.path, "requires the workflow owner to be a git project")
    await expectInvalid(plain.path, owner.path, "is not part of a git project")
    await expectInvalid(other.path, owner.path, "belongs to a different project")
    await expectInvalid(subdirectory, owner.path, "is not a linked worktree")
  })

  posixIt("treats a git that cannot be spawned as no git project", async () => {
    await using owner = await tmpdir({ git: true })
    await withoutGit(() => expectInvalid(owner.path, owner.path, "requires the workflow owner to be a git project"))
  })
})

describe("retarget resolves its workspace without blocking the event loop", () => {
  posixIt("keeps timers firing while git names the common directories and the worktrees", async () => {
    await using tmp = await tmpdir({ git: true })
    const linked = path.join(tmp.path, "linked")
    await $`git worktree add ${linked} -b lock-git-retarget`.cwd(tmp.path).quiet()
    const watch = watchGit()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { dag, dagID } = yield* start(tmp.path, { name: "lock-git", nodes: [node("build", "build")] })
          yield* shimmed(watch, SLOW_RESOLVE)
          // The owner's and the workspace's common directory, then the worktree list.
          const result = yield* Effect.promise(() =>
            measured(() => Effect.runPromise(dag.retarget(dagID, { workspace: linked }))),
          )
          expect(result.value.toDirectory).toBe(DagLocation.canonicalDirectory(linked))
          expectUnblocked(result, 3)
          expect(watch.insideTransaction()).toEqual([])
        }).pipe(Effect.provide(spiedLayer(watch.marker)), Effect.scoped),
      )
    } finally {
      watch.dispose()
    }
  })
})

describe("resolveExecutionAsync gives the verdicts of resolveExecution", () => {
  const executionBoth = async (row: { directory: string; executionDirectory?: string | null }) => {
    const asynchronous = await Effect.runPromise(DagLocation.resolveExecutionAsync(row))
    expect(asynchronous).toEqual(DagLocation.resolveExecution(row))
    return asynchronous
  }

  it("decides the owner fallback and an explicit binding like resolveExecution", async () => {
    await using owner = await tmpdir({ git: true })
    await using plain = await tmpdir()
    const linked = path.join(owner.path, "linked")
    await $`git worktree add ${linked} -b lock-git-execution`.cwd(owner.path).quiet()
    const alias = path.join(plain.path, "alias")
    symlinkSync(linked, alias)
    const file = path.join(plain.path, "file.txt")
    writeFileSync(file, "not a directory")
    const canonical = DagLocation.canonicalDirectory(linked)

    // The owner fallback needs no git: the directory only has to exist.
    expect(await executionBoth({ directory: owner.path, executionDirectory: null })).toEqual({
      _tag: "ok",
      directory: owner.path,
    })
    expect(await executionBoth({ directory: owner.path })).toEqual({ _tag: "ok", directory: owner.path })
    expect(await executionBoth({ directory: path.join(plain.path, "gone") })).toMatchObject({ _tag: "missing" })
    expect(await executionBoth({ directory: "" })).toMatchObject({
      _tag: "invalid",
      reason: "workflow has no recorded execution directory",
    })
    // An explicit binding is checked for identity.
    expect(await executionBoth({ directory: owner.path, executionDirectory: canonical })).toEqual({
      _tag: "ok",
      directory: canonical,
    })
    expect(await executionBoth({ directory: owner.path, executionDirectory: "" })).toMatchObject({
      _tag: "invalid",
      reason: "execution directory is empty",
    })
    expect(await executionBoth({ directory: owner.path, executionDirectory: file })).toMatchObject({ _tag: "missing" })
    expect(await executionBoth({ directory: owner.path, executionDirectory: alias })).toMatchObject({
      _tag: "invalid",
      reason: expect.stringContaining("instead of the bound realpath"),
    })
    expect(await executionBoth({ directory: "", executionDirectory: canonical })).toMatchObject({
      _tag: "invalid",
      reason: "workflow has no owner directory to validate the workspace against",
    })
    expect(await executionBoth({ directory: owner.path, executionDirectory: plain.path })).toMatchObject({
      _tag: "invalid",
      reason: expect.stringContaining("is not part of a git project"),
    })
  })

  it("observes the verdict with the directories it was taken against", async () => {
    await using tmp = await tmpdir()
    const row = { directory: tmp.path, executionDirectory: null }
    const observed = await Effect.runPromise(DagLocation.observeExecution(row))
    expect(observed).toEqual({
      directory: tmp.path,
      executionDirectory: null,
      location: { _tag: "ok", directory: tmp.path },
    })
    expect(DagLocation.executionObservationHolds(observed, row)).toBe(true)
    // An absent binding and a null one are the same owner fallback.
    expect(DagLocation.executionObservationHolds(observed, { directory: tmp.path })).toBe(true)
    expect(DagLocation.executionObservationHolds(observed, { ...row, directory: "/elsewhere" })).toBe(false)
    expect(DagLocation.executionObservationHolds(observed, { ...row, executionDirectory: "/rebound" })).toBe(false)
  })
})

describe("failUnrecoverable reads the execution location before its transaction", () => {
  /** A running workflow whose execution directory is bound to `bound`, an existing directory that is no worktree of the project. */
  const bind = (directory: string, bound: string) =>
    Effect.gen(function* () {
      const started = yield* start(directory, { name: "lock-git", nodes: [node("build", "build")] })
      const { db } = yield* Database.Service
      yield* db
        .update(WorkflowTable)
        .set({ execution_directory: bound })
        .where(eq(WorkflowTable.id, started.dagID))
        .run()
        .pipe(Effect.orDie)
      return started
    })

  posixIt(
    "keeps timers firing while git vouches for the bound workspace, and runs it outside the transaction",
    async () => {
      await using tmp = await tmpdir({ git: true })
      await using bound = await tmpdir()
      const watch = watchGit()
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const { dag, dagID } = yield* bind(tmp.path, bound.path)
            const store = yield* DagStore.Service
            yield* shimmed(watch, SLOW_RESOLVE)
            // The owner's and the workspace's common directory.
            const result = yield* Effect.promise(() =>
              measured(() => Effect.runPromise(dag.failUnrecoverable(dagID, "workspace_invalid: test"))),
            )
            expect(result.value).toBe("failed")
            expectUnblocked(result, 2)
            expect(watch.ran()).toContain("rev-parse")
            expect(watch.insideTransaction()).toEqual([])
            expect((yield* store.getWorkflow(dagID))?.status).toBe("failed")
          }).pipe(Effect.provide(spiedLayer(watch.marker)), Effect.scoped),
        )
      } finally {
        watch.dispose()
      }
    },
  )

  posixIt("ignores a workflow that was re-stamped to a usable location while git was being read", async () => {
    await using tmp = await tmpdir({ git: true })
    await using bound = await tmpdir()
    const watch = watchGit()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { dag, dagID } = yield* bind(tmp.path, bound.path)
          const store = yield* DagStore.Service
          const { db } = yield* Database.Service
          const installed = yield* gate
          const call = yield* dag.failUnrecoverable(dagID, "workspace_invalid: stale").pipe(Effect.forkScoped)
          yield* Effect.promise(() => installed.started())
          // A session move re-stamps the row to its owner directory while the read is parked at git.
          yield* db
            .update(WorkflowTable)
            .set({ execution_directory: null })
            .where(eq(WorkflowTable.id, dagID))
            .run()
            .pipe(Effect.orDie)
          yield* Effect.promise(() => installed.release())
          expect(yield* Fiber.join(call)).toBe("ignored")
          expect((yield* store.getWorkflow(dagID))?.status).toBe("running")
        }).pipe(Effect.provide(spiedLayer(watch.marker)), Effect.scoped),
      )
    } finally {
      watch.dispose()
    }
  })

  posixIt("ignores a workflow that is already terminal without asking git", async () => {
    await using tmp = await tmpdir({ git: true })
    await using bound = await tmpdir()
    const watch = watchGit()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { dag, dagID } = yield* bind(tmp.path, bound.path)
          yield* dag.cancel(dagID)
          yield* shimmed(watch)
          expect(yield* dag.failUnrecoverable(dagID, "workspace_invalid: late")).toBe("ignored")
          expect(watch.ran()).toEqual([])
        }).pipe(Effect.provide(spiedLayer(watch.marker)), Effect.scoped),
      )
    } finally {
      watch.dispose()
    }
  })
})
