// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { $ } from "bun"
import { eq } from "drizzle-orm"
import { Effect, Fiber } from "effect"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import { Database } from "@graphagent/core/database/database"
import { WorkflowTable } from "@graphagent/core/dag/sql"
import { DagStore } from "@graphagent/core/dag/store"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import type { DagEvent } from "@graphagent/schema/dag-event"
import { Session } from "@graphagent/schema/session"
import { Dag, parseWorkflowConfig, type NodeConfig, type WorkflowConfig } from "@/dag/dag"
import { DagIsolation } from "@/dag/isolation"
import { DagLocation } from "@/dag/location"
import { workflowArtifactsRoot } from "@/dag/runtime/output-ref"
import { settleWorkflowWorktree } from "@/dag/runtime/worktree-completion"
import { tmpdir } from "../fixture/fixture"
import { makeWorkflowRow } from "./fixtures"
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

describe("replan and extend resolve node workspaces before their transaction", () => {
  const linkedWorktree = async (owner: string, branch: string) => {
    const linked = path.join(owner, "linked")
    await $`git worktree add ${linked} -b ${branch}`.cwd(owner).quiet()
    return linked
  }

  posixIt("replan pins a new node's workspace with timers firing, outside the transaction", async () => {
    await using tmp = await tmpdir({ git: true })
    const linked = await linkedWorktree(tmp.path, "lock-git-replan")
    const watch = watchGit()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { dag, dagID } = yield* start(tmp.path, { name: "lock-git", nodes: [node("build", "build")] })
          const store = yield* DagStore.Service
          yield* shimmed(watch, SLOW_RESOLVE)
          const result = yield* Effect.promise(() =>
            measured(() =>
              Effect.runPromise(dag.replan(dagID, { nodes: [node("extra", "build", { workspace: linked })] })),
            ),
          )
          expect(result.value.add).toEqual(["extra"])
          expectUnblocked(result, 3)
          expect(watch.ran()).toContain("worktree")
          expect(watch.insideTransaction()).toEqual([])
          const config = parseWorkflowConfig((yield* store.getWorkflow(dagID))!.config)
          expect(config?.nodes.find((n) => n.id === "extra")?.workspace).toBe(DagLocation.canonicalDirectory(linked))
        }).pipe(Effect.provide(spiedLayer(watch.marker)), Effect.scoped),
      )
    } finally {
      watch.dispose()
    }
  })

  posixIt("extend re-pins the workspace of a pending node it carries forward, outside the transaction", async () => {
    await using tmp = await tmpdir({ git: true })
    const linked = await linkedWorktree(tmp.path, "lock-git-extend")
    const watch = watchGit()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { dag, dagID } = yield* start(tmp.path, {
            name: "lock-git",
            nodes: [node("kept", "build", { workspace: linked })],
          })
          yield* shimmed(watch, SLOW_RESOLVE)
          const result = yield* Effect.promise(() =>
            measured(() => Effect.runPromise(dag.extend(dagID, [node("more", "build")]))),
          )
          expect(result.value.add).toEqual(["more"])
          expectUnblocked(result, 3)
          expect(watch.ran()).toContain("worktree")
          expect(watch.insideTransaction()).toEqual([])
        }).pipe(Effect.provide(spiedLayer(watch.marker)), Effect.scoped),
      )
    } finally {
      watch.dispose()
    }
  })

  it("reports an unusable workspace as it always did", async () => {
    await using tmp = await tmpdir({ git: true })
    const watch = watchGit()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { dag, dagID } = yield* start(tmp.path, { name: "lock-git", nodes: [node("build", "build")] })
          const missing = path.join(tmp.path, "missing")
          const error = yield* dag
            .replan(dagID, { nodes: [node("extra", "build", { workspace: missing })] })
            .pipe(Effect.flip)
          expect(error.message).toBe(`Invalid nodes[extra].workspace: workspace does not exist: "${missing}"`)
        }).pipe(Effect.provide(spiedLayer(watch.marker)), Effect.scoped),
      )
    } finally {
      watch.dispose()
    }
  })

  posixIt(
    "rejects a replan whose workflow moved to another owner while its workspaces were being resolved",
    async () => {
      await using tmp = await tmpdir({ git: true })
      await using elsewhere = await tmpdir()
      const linked = await linkedWorktree(tmp.path, "lock-git-moved")
      const watch = watchGit()
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const { dag, dagID } = yield* start(tmp.path, { name: "lock-git", nodes: [node("build", "build")] })
            const store = yield* DagStore.Service
            const { db } = yield* Database.Service
            const installed = yield* gate
            const call = yield* dag
              .replan(dagID, { nodes: [node("extra", "build", { workspace: linked })] })
              .pipe(Effect.flip, Effect.forkScoped)
            yield* Effect.promise(() => installed.started())
            // The owner directory is re-stamped while the read is parked at git.
            yield* db
              .update(WorkflowTable)
              .set({ directory: elsewhere.path })
              .where(eq(WorkflowTable.id, dagID))
              .run()
              .pipe(Effect.orDie)
            yield* Effect.promise(() => installed.release())
            const error = yield* Fiber.join(call)
            expect(error.message).toContain("changed while its workspaces were being resolved")
            expect(yield* store.getNode(dagID, "extra")).toBeUndefined()
          }).pipe(Effect.provide(spiedLayer(watch.marker)), Effect.scoped),
        )
      } finally {
        watch.dispose()
      }
    },
  )
})

describe("gitHeadAsync gives the answer of gitHead", () => {
  it("names HEAD, and nothing without one", async () => {
    await using repo = await tmpdir({ git: true })
    await using unborn = await tmpdir()
    await $`git init`.cwd(unborn.path).quiet()
    await using plain = await tmpdir()
    for (const directory of [repo.path, unborn.path, plain.path])
      expect(await Effect.runPromise(DagLocation.gitHeadAsync(directory))).toBe(DagLocation.gitHead(directory))
    expect(DagLocation.gitHead(repo.path)).toMatch(/^[0-9a-f]{40}$/)
    expect(DagLocation.gitHead(unborn.path)).toBeUndefined()
  })

  posixIt("is undefined when git cannot be spawned", async () => {
    await using repo = await tmpdir({ git: true })
    await withoutGit(async () => {
      expect(await Effect.runPromise(DagLocation.gitHeadAsync(repo.path))).toBeUndefined()
    })
  })
})

describe("commitWorktreeAsync gives the results of commitWorktree", () => {
  // A pinned identity and clock make a commit a function of its tree, its parent
  // and its message, so two copies of one repository commit the same hash.
  const PINNED = {
    GIT_AUTHOR_NAME: "Pinned",
    GIT_AUTHOR_EMAIL: "pinned@example.test",
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
    GIT_COMMITTER_NAME: "Pinned",
    GIT_COMMITTER_EMAIL: "pinned@example.test",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
  }
  const git = (directory: string, ...args: string[]) =>
    execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim()

  /** Runs `body` with the pinned identity in the environment that git inherits. */
  const pinned = async <A>(body: () => Promise<A>) => {
    const previous = Object.entries(PINNED).map(([key]) => [key, process.env[key]] as const)
    Object.assign(process.env, PINNED)
    try {
      return await body()
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
    }
  }

  /** What both runners answer on two copies of one repository after `setup`, the directory made comparable. */
  const both = async (setup: (directory: string) => void) =>
    pinned(async () => {
      const original = mkdtempSync(path.join(os.tmpdir(), "graphagent-commit-a-"))
      const copy = mkdtempSync(path.join(os.tmpdir(), "graphagent-commit-b-"))
      try {
        git(original, "init", "-q")
        git(original, "config", "commit.gpgsign", "false")
        git(original, "config", "core.fsmonitor", "false")
        writeFileSync(path.join(original, "tracked.txt"), "one\n")
        git(original, "add", "-A")
        git(original, "commit", "-q", "-m", "base")
        const baseHead = git(original, "rev-parse", "HEAD")
        setup(original)
        cpSync(original, copy, { recursive: true })
        const synchronous = DagIsolation.commitWorktree(original, baseHead, "dag: test")
        const asynchronous = await Effect.runPromise(DagIsolation.commitWorktreeAsync(copy, baseHead, "dag: test"))
        const comparable = (result: unknown, directory: string) =>
          JSON.parse(JSON.stringify(result).replaceAll(JSON.stringify(directory).slice(1, -1), "<dir>"))
        expect(comparable(asynchronous, copy)).toEqual(comparable(synchronous, original))
        return asynchronous
      } finally {
        rmSync(original, { recursive: true, force: true })
        rmSync(copy, { recursive: true, force: true })
      }
    })

  it("commits nothing for a clean tree, and carries the range of an earlier commit", async () => {
    expect(await both(() => {})).toEqual({ ok: true })
    expect(
      await both((directory) => {
        writeFileSync(path.join(directory, "tracked.txt"), "two\n")
        git(directory, "commit", "-aq", "-m", "ahead")
      }),
    ).toMatchObject({ ok: true, change: { touchedPaths: ["tracked.txt"] } })
  })

  it("commits a dirty tree with text, binary, and untracked changes", async () => {
    const result = await both((directory) => {
      writeFileSync(path.join(directory, "tracked.txt"), "changed\n")
      writeFileSync(path.join(directory, "untracked.txt"), "new\n")
      writeFileSync(path.join(directory, "binary.bin"), Buffer.from([0, 1, 2, 255, 0]))
    })
    expect(result).toMatchObject({
      ok: true,
      change: {
        touchedPaths: ["binary.bin", "tracked.txt", "untracked.txt"],
        patch: expect.stringContaining("GIT binary patch"),
      },
    })
  })

  posixIt("reports the git failure that stopped the commit", async () => {
    const result = await both((directory) => {
      writeFileSync(path.join(directory, "tracked.txt"), "changed\n")
      const hook = path.join(directory, ".git", "hooks", "pre-commit")
      writeFileSync(hook, "#!/bin/sh\necho no commits today >&2\nexit 1\n")
      chmodSync(hook, 0o755)
    })
    expect(result.ok).toBe(false)
    const reason = result.ok ? "" : result.reason
    expect(reason).toContain("git commit failed")
    expect(reason).toContain("no commits today")
  })

  it("reports a directory that is no repository, with the reason the synchronous call gave", async () => {
    await using plain = await tmpdir()
    const synchronous = DagIsolation.commitWorktree(plain.path, "", "dag: test")
    expect(await Effect.runPromise(DagIsolation.commitWorktreeAsync(plain.path, "", "dag: test"))).toEqual(synchronous)
    expect(synchronous).toMatchObject({ ok: false, reason: expect.stringContaining("git status failed") })
  })

  posixIt("reports a git that cannot be spawned", async () => {
    await using plain = await tmpdir()
    await withoutGit(async () => {
      const asynchronous = await Effect.runPromise(DagIsolation.commitWorktreeAsync(plain.path, "", "dag: test"))
      expect(asynchronous).toMatchObject({ ok: false, reason: expect.stringContaining("git status failed") })
    })
  })
})

describe("workflow worktree settlement waits for git under the lock without blocking the event loop", () => {
  const projectID = "proj-lock-git-settle"

  /** Settles a failed isolated workflow under a lock that keeps the watch marker, with every git command slowed. */
  const settle = async (dirty: boolean) => {
    await using tmp = await tmpdir({ git: true })
    const linked = path.join(tmp.path, "settle-tree")
    await $`git worktree add -b lock-git-settle ${linked}`.cwd(tmp.path).quiet()
    const baseHead = (await $`git rev-parse HEAD`.cwd(linked).text()).trim()
    if (dirty) writeFileSync(path.join(linked, "change.txt"), "dirty\n")
    const config: WorkflowConfig = {
      name: "settle",
      isolation: "worktree",
      worktree: { directory: linked, branch: "lock-git-settle", baseHead },
      nodes: [],
    }
    const row = makeWorkflowRow({
      id: "wf-lock-git-settle",
      projectId: projectID,
      status: "failed",
      directory: tmp.path,
      config: JSON.stringify(config),
      worktree: null,
    })
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a store with the one method settlement reads
    const store = { getWorkflow: () => Effect.succeed(row) } as unknown as DagStore.Interface
    const published: DagEvent.WorkflowWorktree[] = []
    const watch = watchGit()
    const critical = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => writeFileSync(watch.marker, "")),
        () => effect,
        () => Effect.sync(() => rmSync(watch.marker, { force: true })),
      )
    const installed = await watch.install("*")
    try {
      const result = await measured(() =>
        Effect.runPromise(
          settleWorkflowWorktree({
            dagID: row.id,
            status: "failed",
            config,
            store,
            projectID,
            remove: () => Effect.succeed(true),
            publish: (worktree) =>
              Effect.sync(() => {
                published.push(worktree)
              }),
            exclusive: critical,
          }),
        ),
      )
      const head = execFileSync("git", ["-C", linked, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
      return { result, published, ranUnderTheLock: watch.insideTransaction(), baseHead, linked, head }
    } finally {
      await installed.dispose()
      watch.dispose()
      rmSync(workflowArtifactsRoot(projectID), { recursive: true, force: true })
    }
  }

  posixIt("commits a dirty worktree with timers firing, inside the critical section", async () => {
    const { result, published, ranUnderTheLock, linked, head } = await settle(true)
    expect(result.value).toBe("settled")
    // status, add, commit, status, rev-parse, then the committed range twice.
    expectUnblocked(result, 7)
    // The shim names a command by its first word after `-C <directory>`: `-c core.quotePath=false status` is `-c`.
    expect(ranUnderTheLock).toEqual(expect.arrayContaining(["-c", "add", "commit", "rev-parse", "diff"]))
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      directory: linked,
      branch: "lock-git-settle",
      state: "kept",
      touchedPaths: ["change.txt"],
      head,
    })
  })

  posixIt("reads the head of a clean worktree with timers firing, inside the critical section", async () => {
    const { result, published, ranUnderTheLock, baseHead } = await settle(false)
    expect(result.value).toBe("settled")
    // status, rev-parse HEAD against the base, then the head for the evidence.
    expectUnblocked(result, 3)
    expect(ranUnderTheLock).toEqual(["-c", "rev-parse", "rev-parse"])
    expect(published[0]).toMatchObject({ state: "kept", head: baseHead, touchedPaths: [] })
  })
})
