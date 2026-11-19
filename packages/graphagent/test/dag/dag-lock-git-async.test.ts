// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from "bun:test"
import { $ } from "bun"
import { eq } from "drizzle-orm"
import { Cause, Effect, Exit, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import * as nodeFs from "node:fs"
import * as nodeFsPromises from "node:fs/promises"
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
import { workflowArtifactsRoot, workflowReportsArea } from "@/dag/runtime/output-ref"
import { completeIsolatedNode, settleWorkflowWorktree } from "@/dag/runtime/worktree-completion"
import { tmpdir } from "../fixture/fixture"
import { makeWorkflowRow } from "./fixtures"
import { legacyFingerprintTarget } from "./fixture/legacy-fingerprint"
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

  posixIt("refuses a link that loops, and one that leads to a file, as the synchronous version does", async () => {
    await using owner = await tmpdir({ git: true })
    const loop = path.join(owner.path, "loop")
    symlinkSync(loop, loop)
    const file = path.join(owner.path, "file.txt")
    writeFileSync(file, "not a directory")
    const toFile = path.join(owner.path, "to-file")
    symlinkSync(file, toFile)
    const dangling = path.join(owner.path, "dangling")
    symlinkSync(path.join(owner.path, "nowhere"), dangling)
    await expectInvalid(loop, owner.path, "does not exist")
    await expectInvalid(toFile, owner.path, "is not a directory")
    await expectInvalid(dangling, owner.path, "does not exist")
  })

  posixIt("names every worktree of a repository that has several, as the synchronous version does", async () => {
    await using owner = await tmpdir({ git: true })
    await using plain = await tmpdir()
    const names = ["first", "second", "third"]
    const worktrees = names.map((name) => path.join(owner.path, name))
    for (const [index, directory] of worktrees.entries())
      await $`git worktree add ${directory} -b lock-git-many-${names[index]}`.cwd(owner.path).quiet()
    // One of them reached through a link whose own path is not canonical.
    const alias = path.join(plain.path, "alias")
    symlinkSync(owner.path, alias)
    for (const directory of worktrees)
      expect(await resolveBoth(directory, owner.path)).toEqual({
        _tag: "ok",
        directory: DagLocation.canonicalDirectory(directory),
      })
    expect(await resolveBoth(path.join(alias, "second"), alias)).toEqual({
      _tag: "ok",
      directory: DagLocation.canonicalDirectory(worktrees[1] ?? ""),
    })
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

  posixIt("judges a binding written with a trailing separator, or through a loop, like resolveExecution", async () => {
    await using owner = await tmpdir({ git: true })
    const linked = path.join(owner.path, "linked")
    await $`git worktree add ${linked} -b lock-git-execution-spelling`.cwd(owner.path).quiet()
    const canonical = DagLocation.canonicalDirectory(linked)
    const loop = path.join(owner.path, "loop")
    symlinkSync(loop, loop)
    expect(await executionBoth({ directory: owner.path, executionDirectory: canonical + path.sep })).toMatchObject({
      _tag: "invalid",
      reason: expect.stringContaining("instead of the bound realpath"),
    })
    expect(await executionBoth({ directory: owner.path, executionDirectory: loop })).toMatchObject({ _tag: "missing" })
    expect(
      await executionBoth({ directory: owner.path, executionDirectory: path.join(owner.path, "nowhere") }),
    ).toEqual({
      _tag: "missing",
      directory: path.join(owner.path, "nowhere"),
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

describe("commitWorktreeAsync gives the results of commitWorktree", () => {
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

// #1583: the completion of an isolated node (the live path and crash recovery) waits for git and the disk off the
// event loop, and gives the results the synchronous completion gave.

/** The error `run` throws; a call that does not throw fails the test. */
const thrown = (run: () => unknown): Error => {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error("expected the call to throw")
}

describe("writePatchArtifactAsync gives the results of writePatchArtifact", () => {
  const PATCH = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-一\n+二\n"
  const writeAsync = (reportsArea: string, dagID: string, nodeID: string, patch = PATCH) =>
    DagIsolation.writePatchArtifactAsync(reportsArea, dagID, nodeID, patch)

  it("writes the same file and names the same path and checksum", async () => {
    await using tmp = await tmpdir()
    const synchronous = DagIsolation.writePatchArtifact(path.join(tmp.path, "sync"), "dag_1", "node-1", PATCH)
    const asynchronous = await Effect.runPromise(writeAsync(path.join(tmp.path, "async"), "dag_1", "node-1"))
    expect(asynchronous.path).toBe(path.join(tmp.path, "async", "dag_1", "node-1.patch"))
    expect(asynchronous.sha256).toBe(synchronous.sha256)
    expect(asynchronous.sha256).toBe(createHash("sha256").update(PATCH).digest("hex"))
    expect(readFileSync(asynchronous.path, "utf8")).toBe(PATCH)
    expect(readFileSync(synchronous.path, "utf8")).toBe(PATCH)
  })

  it("replaces the patch an earlier attempt of the node left", async () => {
    await using tmp = await tmpdir()
    await Effect.runPromise(writeAsync(tmp.path, "dag_1", "node-1", "first\n"))
    const second = await Effect.runPromise(writeAsync(tmp.path, "dag_1", "node-1", PATCH))
    expect(readFileSync(second.path, "utf8")).toBe(PATCH)
  })

  it("refuses an identifier that would leave the report directory, with the error the synchronous version throws", async () => {
    await using tmp = await tmpdir()
    const identifiers = [
      ["", "node-1"],
      [".", "node-1"],
      ["..", "node-1"],
      ["a/b", "node-1"],
      ["a\\b", "node-1"],
      ["a\0b", "node-1"],
      ["dag_1", ""],
      ["dag_1", ".."],
      ["dag_1", "../node"],
      ["dag_1", "a/b"],
    ] as const
    for (const [dagID, nodeID] of identifiers) {
      const synchronous = thrown(() => DagIsolation.writePatchArtifact(tmp.path, dagID, nodeID, PATCH))
      const asynchronous = await Effect.runPromise(writeAsync(tmp.path, dagID, nodeID).pipe(Effect.flip))
      expect(synchronous.message).toContain("for patch artifact")
      expect(asynchronous).toBeInstanceOf(Error)
      expect(asynchronous.message).toBe(synchronous.message)
    }
  })

  it("fails with the error of the disk, as the synchronous version throws it", async () => {
    await using tmp = await tmpdir()
    // A file where the directory of the workflow belongs.
    writeFileSync(path.join(tmp.path, "dag_1"), "not a directory")
    const synchronous = thrown(() => DagIsolation.writePatchArtifact(tmp.path, "dag_1", "node-1", PATCH))
    const asynchronous = await Effect.runPromise(writeAsync(tmp.path, "dag_1", "node-1").pipe(Effect.flip))
    expect(synchronous.message).toContain("EEXIST")
    expect(asynchronous.message).toBe(synchronous.message)
  })
})

/** The completion of a worktree that is at `baseHead`, the arguments both `completeWorktree` versions take. */
const completionOf = (
  directory: string,
  baseHead: string,
  reportsArea: string,
  options: { state?: DagIsolation.WorktreeState; dagID?: string; nodeID?: string } = {},
): DagIsolation.WorktreeCompletionInput => ({
  worktree: { directory, state: options.state ?? "active", touchedPaths: [], conflictsWith: [], baseHead },
  reportsArea,
  dagID: options.dagID ?? "dag_1",
  nodeID: options.nodeID ?? "node-1",
  message: "dag: test",
})

/** A text, a binary and an untracked change on top of the base commit. */
const withChanges = (directory: string) => {
  writeFileSync(path.join(directory, "tracked.txt"), "changed\n")
  writeFileSync(path.join(directory, "untracked.txt"), "new\n")
  writeFileSync(path.join(directory, "binary.bin"), Buffer.from([0, 1, 2, 255, 0]))
}

describe("completeWorktreeAsync gives the results of completeWorktree", () => {
  /** `value` as plain data, with the paths of one run replaced by a name both runs share. */
  const comparable = (value: unknown, names: ReadonlyArray<readonly [string, string]>) => {
    let text = JSON.stringify(value)
    for (const [directory, name] of names) text = text.replaceAll(JSON.stringify(directory).slice(1, -1), name)
    return JSON.parse(text)
  }

  /** The patch a node left in a report area; nothing where there is none, or where something else is in its place. */
  const patchOf = (reportsArea: string, dagID = "dag_1", nodeID = "node-1") => {
    const file = path.join(reportsArea, dagID, `${nodeID}.patch`)
    return existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : undefined
  }

  /**
   * What both versions answer on two copies of one repository after `setup`, each with a report area of its own
   * (prepared by `options.reports`), the paths made comparable; and the patch the asynchronous one wrote.
   */
  const both = async (
    setup: (directory: string) => void,
    options: {
      state?: DagIsolation.WorktreeState
      dagID?: string
      nodeID?: string
      reports?: (reportsArea: string) => void
    } = {},
  ) =>
    pinned(async () => {
      const original = mkdtempSync(path.join(os.tmpdir(), "graphagent-complete-a-"))
      const copy = mkdtempSync(path.join(os.tmpdir(), "graphagent-complete-b-"))
      const synchronousReports = mkdtempSync(path.join(os.tmpdir(), "graphagent-complete-reports-a-"))
      const asynchronousReports = mkdtempSync(path.join(os.tmpdir(), "graphagent-complete-reports-b-"))
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
        options.reports?.(synchronousReports)
        options.reports?.(asynchronousReports)
        const synchronous = DagIsolation.completeWorktree(completionOf(original, baseHead, synchronousReports, options))
        const asynchronous = await Effect.runPromise(
          DagIsolation.completeWorktreeAsync(completionOf(copy, baseHead, asynchronousReports, options)),
        )
        expect(
          comparable(asynchronous, [
            [copy, "<dir>"],
            [asynchronousReports, "<reports>"],
          ]),
        ).toEqual(
          comparable(synchronous, [
            [original, "<dir>"],
            [synchronousReports, "<reports>"],
          ]),
        )
        const patch = patchOf(asynchronousReports, options.dagID, options.nodeID)
        expect(patch).toBe(patchOf(synchronousReports, options.dagID, options.nodeID))
        return { result: asynchronous, patch }
      } finally {
        for (const directory of [original, copy, synchronousReports, asynchronousReports])
          rmSync(directory, { recursive: true, force: true })
      }
    })

  it("completes a directory that is missing as a failure while active, and as a removed worktree otherwise", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "gone")
    const reportsArea = path.join(tmp.path, "reports")
    for (const state of ["active", "removed", "kept"] as const) {
      const input = completionOf(directory, "abc", reportsArea, { state })
      input.worktree.touchedPaths = ["saved.txt"]
      const asynchronous = await Effect.runPromise(DagIsolation.completeWorktreeAsync(input))
      expect(asynchronous).toEqual(DagIsolation.completeWorktree(input))
      if (state === "active")
        expect(asynchronous).toEqual({ ok: false, reason: `active worktree directory is missing: ${directory}` })
      else
        expect(asynchronous).toEqual({
          ok: true,
          completion: { worktree: { ...input.worktree, state: "removed" }, touchedPaths: [] },
        })
    }
    expect(existsSync(reportsArea)).toBe(false)
  })

  it("reports a directory that is no repository with the reason the synchronous version gave", async () => {
    await using tmp = await tmpdir()
    const input = completionOf(tmp.path, "", path.join(tmp.path, "reports"))
    const asynchronous = await Effect.runPromise(DagIsolation.completeWorktreeAsync(input))
    expect(asynchronous).toEqual(DagIsolation.completeWorktree(input))
    expect(asynchronous).toMatchObject({ ok: false, reason: expect.stringContaining("git status failed") })
    expect(existsSync(path.join(tmp.path, "reports"))).toBe(false)
  })

  it("keeps the state of a clean tree, and writes no patch", async () => {
    for (const state of ["active", "kept"] as const) {
      const { result, patch } = await both(() => {}, { state })
      expect(result).toMatchObject({
        ok: true,
        completion: { worktree: { state, touchedPaths: [] }, touchedPaths: [] },
      })
      expect(patch).toBeUndefined()
    }
  })

  it("completes a clean tree from the range of a commit made earlier in the attempt", async () => {
    const { result, patch } = await both((directory) => {
      writeFileSync(path.join(directory, "tracked.txt"), "two\n")
      git(directory, "commit", "-aq", "-m", "ahead")
    })
    expect(result).toMatchObject({
      ok: true,
      completion: {
        worktree: { commit: expect.stringMatching(/^[0-9a-f]{40}$/), state: "active", touchedPaths: ["tracked.txt"] },
        touchedPaths: ["tracked.txt"],
      },
    })
    expect(patch).toContain("tracked.txt")
  })

  it("commits a dirty tree with text, binary and untracked changes, and records its patch", async () => {
    const { result, patch } = await both(withChanges)
    expect(result).toMatchObject({
      ok: true,
      completion: {
        worktree: {
          commit: expect.stringMatching(/^[0-9a-f]{40}$/),
          patchPath: expect.stringMatching(/node-1\.patch$/),
          state: "active",
          touchedPaths: ["binary.bin", "tracked.txt", "untracked.txt"],
        },
        touchedPaths: ["binary.bin", "tracked.txt", "untracked.txt"],
      },
    })
    expect(patch).toContain("GIT binary patch")
    expect(patch).toContain("untracked.txt")
    expect(result.ok && result.completion.worktree.patchSha256).toBe(createHash("sha256").update(patch!).digest("hex"))
  })

  it("fails with the error of the disk when the report directory of the workflow cannot be created", async () => {
    // A file where the directory of the workflow belongs; the work was committed before the patch was written.
    const { result, patch } = await both(withChanges, {
      reports: (reportsArea) => writeFileSync(path.join(reportsArea, "dag_1"), "not a directory"),
    })
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("EEXIST") })
    expect(patch).toBeUndefined()
  })

  it("fails with the error of the disk when the patch file cannot be written", async () => {
    // A directory where the patch file belongs.
    const { result } = await both(withChanges, {
      reports: (reportsArea) => mkdirSync(path.join(reportsArea, "dag_1", "node-1.patch"), { recursive: true }),
    })
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("EISDIR") })
  })

  posixIt("fails with the error of the disk when the report directory is read-only", async () => {
    if (process.getuid?.() === 0) return // root writes into a read-only directory
    const { result } = await both(withChanges, {
      reports: (reportsArea) => {
        mkdirSync(path.join(reportsArea, "dag_1"))
        chmodSync(path.join(reportsArea, "dag_1"), 0o555)
      },
    })
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("EACCES") })
  })

  it("refuses an identifier that would leave the report directory, with the same reason", async () => {
    const workflow = await both(withChanges, { dagID: ".." })
    expect(workflow.result).toMatchObject({ ok: false, reason: 'invalid workflow ID for patch artifact: ".."' })
    const node = await both(withChanges, { nodeID: "../node" })
    expect(node.result).toMatchObject({ ok: false, reason: 'invalid node ID for patch artifact: "../node"' })
  })
})

describe("completing a node waits for git without blocking the event loop", () => {
  /** A repository with one commit and a change on top of it, and a report area of its own. */
  const changed = () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "graphagent-complete-slow-"))
    const reportsArea = mkdtempSync(path.join(os.tmpdir(), "graphagent-complete-slow-reports-"))
    git(directory, "init", "-q")
    git(directory, "config", "user.name", "Slow")
    git(directory, "config", "user.email", "slow@example.test")
    git(directory, "config", "commit.gpgsign", "false")
    git(directory, "config", "core.fsmonitor", "false")
    writeFileSync(path.join(directory, "tracked.txt"), "one\n")
    git(directory, "add", "-A")
    git(directory, "commit", "-q", "-m", "base")
    const baseHead = git(directory, "rev-parse", "HEAD")
    writeFileSync(path.join(directory, "change.txt"), "dirty\n")
    return {
      directory,
      reportsArea,
      baseHead,
      dispose: () => {
        rmSync(directory, { recursive: true, force: true })
        rmSync(reportsArea, { recursive: true, force: true })
      },
    }
  }

  posixIt("commits a dirty tree with timers firing, and writes its patch", async () => {
    const tree = changed()
    const watch = watchGit()
    const installed = await watch.install("*")
    try {
      const result = await measured(() =>
        Effect.runPromise(
          DagIsolation.completeWorktreeAsync(completionOf(tree.directory, tree.baseHead, tree.reportsArea)),
        ),
      )
      // status, add, commit, status, rev-parse, then the committed range twice.
      expectUnblocked(result, 7)
      expect(result.value).toMatchObject({ ok: true, completion: { touchedPaths: ["change.txt"] } })
      expect(readFileSync(path.join(tree.reportsArea, "dag_1", "node-1.patch"), "utf8")).toContain("change.txt")
    } finally {
      await installed.dispose()
      watch.dispose()
      tree.dispose()
    }
  })

  posixIt("reads a clean tree with timers firing", async () => {
    const tree = changed()
    rmSync(path.join(tree.directory, "change.txt"))
    const watch = watchGit()
    const installed = await watch.install("*")
    try {
      const result = await measured(() =>
        Effect.runPromise(
          DagIsolation.completeWorktreeAsync(completionOf(tree.directory, tree.baseHead, tree.reportsArea)),
        ),
      )
      // status, then rev-parse HEAD against the base.
      expectUnblocked(result, 2)
      expect(result.value).toMatchObject({ ok: true, completion: { touchedPaths: [] } })
    } finally {
      await installed.dispose()
      watch.dispose()
      tree.dispose()
    }
  })

  posixIt("is still waiting, with timers firing, while its git is parked", async () => {
    const tree = changed()
    const installed = await installGitGate()
    try {
      const running = Effect.runPromise(
        DagIsolation.completeWorktreeAsync(completionOf(tree.directory, tree.baseHead, tree.reportsArea)),
      )
      let finished = false
      void running.then(() => {
        finished = true
      })
      await installed.started()
      // A blocked loop could not run this timer, and the gate would never be released.
      const parked = await measured(() => Bun.sleep(200))
      expect(parked.ticks).toBeGreaterThan(8)
      expect(finished).toBe(false)
      await installed.release()
      expect(await running).toMatchObject({ ok: true, completion: { touchedPaths: ["change.txt"] } })
    } finally {
      await installed.dispose()
      tree.dispose()
    }
  })

  posixIt("lets an interruption through while its git is parked, and records nothing", async () => {
    const tree = changed()
    try {
      const installed = await installGitGate()
      try {
        const controller = new AbortController()
        const running = Effect.runPromiseExit(
          DagIsolation.completeWorktreeAsync(completionOf(tree.directory, tree.baseHead, tree.reportsArea)),
          { signal: controller.signal },
        )
        await installed.started()
        controller.abort()
        expect(Exit.hasInterrupts(await running)).toBe(true)
      } finally {
        await installed.dispose()
      }
      // The worktree is as the node left it: nothing is committed and no patch was written, so a retry redoes it all.
      expect(git(tree.directory, "rev-parse", "HEAD")).toBe(tree.baseHead)
      expect(git(tree.directory, "status", "--porcelain")).toBe("?? change.txt")
      expect(existsSync(path.join(tree.reportsArea, "dag_1"))).toBe(false)
    } finally {
      tree.dispose()
    }
  })

  posixIt("finishes a node's commit and patch before an interruption lands, then keeps the worktree", async () => {
    const projectID = `proj-lock-git-interrupt-${process.pid}`
    const tree = changed()
    const removed: string[] = []
    try {
      const installed = await installGitGate()
      try {
        const controller = new AbortController()
        const running = Effect.runPromiseExit(
          completeIsolatedNode({
            worktree: {
              directory: tree.directory,
              state: "active",
              touchedPaths: [],
              conflictsWith: [],
              baseHead: tree.baseHead,
            },
            ownerDirectory: tree.directory,
            projectID,
            dagID: "dag_1",
            nodeID: "node-1",
            message: "dag: node-1",
            remove: (directory) =>
              Effect.sync(() => {
                removed.push(directory)
                return true
              }),
          }),
          { signal: controller.signal },
        )
        let settled = false
        void running.then(() => {
          settled = true
        })
        await installed.started()
        controller.abort()
        await Bun.sleep(100)
        // The interruption waits for the commit instead of cutting it between two git commands.
        expect(settled).toBe(false)
        await installed.release()
        expect(Exit.hasInterrupts(await running)).toBe(true)
      } finally {
        await installed.dispose()
      }
      expect(git(tree.directory, "rev-parse", "HEAD")).not.toBe(tree.baseHead)
      expect(git(tree.directory, "status", "--porcelain")).toBe("")
      expect(existsSync(path.join(workflowReportsArea(projectID), "dag_1", "node-1.patch"))).toBe(true)
      // The removal after the commit is still interruptible, so the worktree stays for recovery.
      expect(removed).toEqual([])
    } finally {
      tree.dispose()
      rmSync(workflowArtifactsRoot(projectID), { recursive: true, force: true })
    }
  })

  posixIt("lets the git timeout end an interrupted node completion whose git hangs", async () => {
    const projectID = `proj-lock-git-hang-${process.pid}`
    const tree = changed()
    const removed: string[] = []
    try {
      const installed = await installGitGate()
      try {
        const exit = await Effect.runPromise(
          Effect.gen(function* () {
            const fiber = yield* completeIsolatedNode({
              worktree: {
                directory: tree.directory,
                state: "active",
                touchedPaths: [],
                conflictsWith: [],
                baseHead: tree.baseHead,
              },
              ownerDirectory: tree.directory,
              projectID,
              dagID: "dag_1",
              nodeID: "node-1",
              message: "dag: node-1",
              remove: (directory) =>
                Effect.sync(() => {
                  removed.push(directory)
                  return true
                }),
            }).pipe(Effect.forkChild)
            yield* Effect.promise(() => installed.started())
            yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
            // The gate is never released: only the git command's own timeout can let the waiting cancel finish.
            yield* TestClock.adjust("21 seconds")
            return yield* Fiber.await(fiber)
          }).pipe(Effect.provide(TestClock.layer())),
        )
        expect(Exit.hasInterrupts(exit)).toBe(true)
      } finally {
        await installed.dispose()
      }
      // The timed-out commit recorded nothing and nothing was removed, so recovery redoes the node.
      expect(git(tree.directory, "rev-parse", "HEAD")).toBe(tree.baseHead)
      expect(existsSync(path.join(workflowReportsArea(projectID), "dag_1", "node-1.patch"))).toBe(false)
      expect(removed).toEqual([])
    } finally {
      tree.dispose()
      rmSync(workflowArtifactsRoot(projectID), { recursive: true, force: true })
    }
  })

  posixIt("completes an isolated node with timers firing, and removes its worktree after the commit", async () => {
    const projectID = `proj-lock-git-complete-${process.pid}`
    const tree = changed()
    const removed: string[] = []
    const watch = watchGit()
    const installed = await watch.install("*")
    try {
      const result = await measured(() =>
        Effect.runPromise(
          completeIsolatedNode({
            worktree: {
              directory: tree.directory,
              state: "active",
              touchedPaths: [],
              conflictsWith: [],
              baseHead: tree.baseHead,
            },
            ownerDirectory: tree.directory,
            projectID,
            dagID: "dag_1",
            nodeID: "node-1",
            message: "dag: node-1",
            remove: (directory) =>
              Effect.sync(() => {
                removed.push(directory)
                return true
              }),
          }),
        ),
      )
      expectUnblocked(result, 7)
      expect(result.value).toMatchObject({
        ok: true,
        worktree: {
          state: "removed",
          patchPath: path.join(workflowReportsArea(projectID), "dag_1", "node-1.patch"),
          touchedPaths: ["change.txt"],
        },
        touchedPaths: ["change.txt"],
      })
      expect(removed).toEqual([tree.directory])
    } finally {
      await installed.dispose()
      watch.dispose()
      tree.dispose()
      rmSync(workflowArtifactsRoot(projectID), { recursive: true, force: true })
    }
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

// ---------------------------------------------------------------------------
// #1583: the filesystem under the workflow lock
// ---------------------------------------------------------------------------

/** What a test needs of the `node:fs` calls that wait on the disk: spies that call through, and the paths they saw. */
function watchSyncFs() {
  const probes = {
    existsSync: spyOn(nodeFs, "existsSync"),
    mkdirSync: spyOn(nodeFs, "mkdirSync"),
    readFileSync: spyOn(nodeFs, "readFileSync"),
    realpathSync: spyOn(nodeFs, "realpathSync"),
    renameSync: spyOn(nodeFs, "renameSync"),
    rmSync: spyOn(nodeFs, "rmSync"),
    statSync: spyOn(nodeFs, "statSync"),
    writeFileSync: spyOn(nodeFs, "writeFileSync"),
  }
  const targets = (probe: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }) =>
    probe.mock.calls.map((call) => (typeof call[0] === "string" ? call[0] : ""))
  return {
    /** `<function> <path>` for every call on a path at or under one of `roots`. */
    callsUnder: (roots: readonly string[]) =>
      Object.entries(probes).flatMap(([name, probe]) =>
        targets(probe)
          .filter((target) => roots.some((root) => target === root || target.startsWith(root + path.sep)))
          .map((target) => `${name} ${target}`),
      ),
    restore: () => {
      for (const probe of Object.values(probes)) probe.mockRestore()
    },
  }
}

/** The synchronous `node:fs` calls `run` made on paths under `roots`: the calls that block the event loop. */
async function syncFsCalls<A>(roots: readonly string[], run: () => Promise<A>) {
  const watch = watchSyncFs()
  try {
    const value = await run()
    return { value, calls: watch.callsUnder(roots) }
  } finally {
    watch.restore()
  }
}

/** What an operation did to the event loop, as the longest time between two turns of a 10 ms interval: a free loop stays near 10 ms. */
async function longestStall<A>(run: () => Promise<A>) {
  let last = performance.now()
  let longest = 0
  const timer = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
  }, 10)
  try {
    const value = await run()
    return { value, longest: Math.max(longest, performance.now() - last) }
  } finally {
    clearInterval(timer)
  }
}

/** The other end of a pipe, opened by a process of its own `seconds` from now: a disk that answers late. */
const lateEnd = (seconds: number, script: string, ...args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("sh", ["-c", `sleep ${seconds}; ${script}`, "sh", ...args], { stdio: "ignore" })
    child.on("error", reject)
    child.on("exit", () => resolve())
  })

/** The settlement of an isolated workflow whose worktree is `directory`, with what it publishes and removes recorded. */
function settling(input: {
  dagID: string
  projectID: string
  owner: string
  directory: string
  status: "completed" | "failed"
  branch?: string
  baseHead?: string
}) {
  const config: WorkflowConfig = {
    name: "settle",
    isolation: "worktree",
    worktree: {
      directory: input.directory,
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.baseHead ? { baseHead: input.baseHead } : {}),
    },
    nodes: [],
  }
  const row = makeWorkflowRow({
    id: input.dagID,
    projectId: input.projectID,
    status: input.status,
    directory: input.owner,
    config: JSON.stringify(config),
    worktree: null,
  })
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a store with the one method settlement reads
  const store = { getWorkflow: () => Effect.succeed(row) } as unknown as DagStore.Interface
  const published: DagEvent.WorkflowWorktree[] = []
  const removed: string[] = []
  const effect = settleWorkflowWorktree({
    dagID: input.dagID,
    status: input.status,
    config,
    store,
    projectID: input.projectID,
    remove: (directory) =>
      Effect.sync(() => {
        removed.push(directory)
        return true
      }),
    publish: (worktree) =>
      Effect.sync(() => {
        published.push(worktree)
      }),
  })
  return { effect, published, removed }
}

describe("the filesystem checks under the workflow lock make no synchronous call (#1583)", () => {
  it("resolves a workspace and an execution location", async () => {
    await using owner = await tmpdir({ git: true })
    const linked = path.join(owner.path, "linked")
    await $`git worktree add ${linked} -b lock-fs-resolve`.cwd(owner.path).quiet()
    const row = { directory: owner.path, executionDirectory: DagLocation.canonicalDirectory(linked) }
    // The probe has to see what the synchronous versions do.
    const control = await syncFsCalls([owner.path], async () => ({
      workspace: DagLocation.resolveWorkspace(linked, owner.path),
      execution: DagLocation.resolveExecution(row),
    }))
    expect(control.calls.some((call) => call.startsWith("realpathSync "))).toBe(true)
    expect(control.calls.some((call) => call.startsWith("statSync "))).toBe(true)

    const asynchronous = await syncFsCalls([owner.path], () =>
      Effect.runPromise(
        Effect.all({
          workspace: DagLocation.resolveWorkspaceAsync(linked, owner.path),
          execution: DagLocation.resolveExecutionAsync(row),
        }),
      ),
    )
    expect(asynchronous.value).toEqual(control.value)
    expect(asynchronous.calls).toEqual([])
  })

  posixIt("fingerprints the untracked files of a target", async () => {
    await using tmp = await tmpdir({ git: true })
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(path.join(tmp.path, name), name)
    symlinkSync(path.join(tmp.path, "nowhere"), path.join(tmp.path, "dangling.txt"))
    const control = await syncFsCalls([tmp.path], async () => legacyFingerprintTarget(tmp.path))
    expect(control.calls.filter((call) => call.startsWith("statSync ")).length).toBeGreaterThanOrEqual(4)

    const asynchronous = await syncFsCalls([tmp.path], () => Effect.runPromise(DagLocation.fingerprintTarget(tmp.path)))
    expect(asynchronous.value).toEqual(control.value)
    expect(asynchronous.calls).toEqual([])
  })

  it("stops asking the disk about untracked files once its caller was interrupted", async () => {
    await using tmp = await tmpdir({ git: true })
    // Ten batches of untracked files.
    const total = 640
    for (let i = 0; i < total; i++) writeFileSync(path.join(tmp.path, `untracked-${i}.txt`), "x")
    const controller = new AbortController()
    const stat = nodeFsPromises.stat
    const interrupting = (target: nodeFs.PathLike) => {
      controller.abort()
      return stat(target)
    }
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the one overload `stat` is called with
    const probe = spyOn(nodeFsPromises, "stat").mockImplementation(interrupting as typeof stat)
    try {
      const exit = await Effect.runPromiseExit(DagLocation.fingerprintTarget(tmp.path), { signal: controller.signal })
      expect(Exit.hasInterrupts(exit)).toBe(true)
      // The batch in flight when the interruption landed finishes; the ones after it are never asked for.
      const asked = probe.mock.calls.filter((call) => String(call[0]).startsWith(tmp.path)).length
      expect(asked).toBeGreaterThan(0)
      expect(asked).toBeLessThan(total)
    } finally {
      probe.mockRestore()
    }
  })

  posixIt("settles a workflow worktree: the checkout, the patch and the evidence", async () => {
    await using tmp = await tmpdir({ git: true })
    const linked = path.join(tmp.path, "settle-fs-tree")
    await $`git worktree add -b lock-fs-settle ${linked}`.cwd(tmp.path).quiet()
    const baseHead = (await $`git rev-parse HEAD`.cwd(linked).text()).trim()
    writeFileSync(path.join(linked, "change.txt"), "dirty\n")
    const projectID = `proj-lock-fs-probe-${process.pid}`
    const reports = workflowReportsArea(projectID)
    const roots = [linked, reports]
    try {
      const control = await syncFsCalls(roots, async () => {
        existsSync(linked)
        DagIsolation.writePatchArtifact(reports, "dag_control", "_workflow", "patch")
      })
      expect(control.calls).toEqual(
        expect.arrayContaining([
          `existsSync ${linked}`,
          expect.stringMatching(/^mkdirSync /),
          expect.stringMatching(/^writeFileSync /),
        ]),
      )

      const settlement = settling({
        dagID: "dag_lock_fs_probe",
        projectID,
        owner: tmp.path,
        directory: linked,
        status: "completed",
        branch: "lock-fs-settle",
        baseHead,
      })
      const probed = await syncFsCalls(roots, () => Effect.runPromise(settlement.effect))
      expect(probed.value).toBe("settled")
      expect(settlement.published).toHaveLength(1)
      expect(settlement.published[0]).toMatchObject({ state: "removed", touchedPaths: ["change.txt"] })
      expect(settlement.removed).toEqual([linked])
      // The patch and the evidence were written all the same.
      const written = readdirSync(path.join(reports, "dag_lock_fs_probe")).sort()
      expect(written).toEqual(["_workflow.patch", "_workflow.settlement.json"])
      expect(probed.calls).toEqual([])
    } finally {
      rmSync(workflowArtifactsRoot(projectID), { recursive: true, force: true })
    }
  })

  posixIt("settles a workflow whose checkout is gone, reading the evidence an earlier settlement left", async () => {
    await using tmp = await tmpdir()
    const projectID = `proj-lock-fs-probe-gone-${process.pid}`
    const dagID = "dag_lock_fs_gone"
    const directory = path.join(tmp.path, "gone")
    const evidence = {
      directory,
      branch: "lock-fs-gone",
      head: "a".repeat(40),
      touchedPaths: ["x.txt"],
      state: "removed" as const,
    }
    const file = path.join(workflowReportsArea(projectID), dagID, "_workflow.settlement.json")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(evidence))
    try {
      const settlement = settling({ dagID, projectID, owner: tmp.path, directory, status: "completed" })
      const probed = await syncFsCalls([directory, workflowReportsArea(projectID)], () =>
        Effect.runPromise(settlement.effect),
      )
      expect(probed.value).toBe("settled")
      expect(settlement.published).toEqual([evidence])
      expect(probed.calls).toEqual([])
    } finally {
      rmSync(workflowArtifactsRoot(projectID), { recursive: true, force: true })
    }
  })
})

describe("workflow worktree settlement waits for the disk under the lock without blocking the event loop (#1583)", () => {
  /** A named pipe at `file`: opening it waits for the other end, as a slow disk does. */
  const pipeAt = (file: string) => {
    mkdirSync(path.dirname(file), { recursive: true })
    execFileSync("mkfifo", [file])
  }

  posixIt("reads the evidence of a removed checkout with timers firing", async () => {
    await using tmp = await tmpdir()
    const projectID = `proj-lock-fs-read-${process.pid}`
    const dagID = "dag_lock_fs_read"
    const directory = path.join(tmp.path, "gone")
    const evidence = {
      directory,
      branch: "lock-fs-read",
      head: "b".repeat(40),
      touchedPaths: ["x.txt"],
      state: "removed" as const,
    }
    const file = path.join(workflowReportsArea(projectID), dagID, "_workflow.settlement.json")
    pipeAt(file)
    const source = path.join(tmp.path, "evidence.json")
    writeFileSync(source, JSON.stringify(evidence))
    try {
      const settlement = settling({ dagID, projectID, owner: tmp.path, directory, status: "completed" })
      const writer = lateEnd(0.25, 'cat "$1" > "$2"', source, file)
      const result = await measured(() => Effect.runPromise(settlement.effect))
      await writer
      expect(result.value).toBe("settled")
      // The read waited for the pipe, and the loop turned meanwhile.
      expectUnblocked(result, 1)
      expect(settlement.published).toEqual([evidence])
    } finally {
      rmSync(workflowArtifactsRoot(projectID), { recursive: true, force: true })
    }
  })

  posixIt("writes the patch with timers firing", async () => {
    await using tmp = await tmpdir({ git: true })
    const linked = path.join(tmp.path, "settle-fs-slow-tree")
    await $`git worktree add -b lock-fs-patch ${linked}`.cwd(tmp.path).quiet()
    const baseHead = (await $`git rev-parse HEAD`.cwd(linked).text()).trim()
    writeFileSync(path.join(linked, "change.txt"), "dirty\n")
    const projectID = `proj-lock-fs-patch-${process.pid}`
    const dagID = "dag_lock_fs_patch"
    const patch = path.join(workflowReportsArea(projectID), dagID, "_workflow.patch")
    pipeAt(patch)
    const captured = path.join(tmp.path, "captured.patch")
    try {
      // A failed workflow keeps its worktree: the patch is the only disk work it waits for.
      const settlement = settling({
        dagID,
        projectID,
        owner: tmp.path,
        directory: linked,
        status: "failed",
        branch: "lock-fs-patch",
        baseHead,
      })
      // The commit runs git first, so the pipe is opened late enough for the write to be what waits for it.
      const reader = lateEnd(0.8, 'cat "$1" > "$2"', patch, captured)
      const started = performance.now()
      const result = await longestStall(() => Effect.runPromise(settlement.effect))
      await reader
      expect(result.value).toBe("settled")
      // The write really waited for the pipe, and the loop was never held for anything near that long.
      expect(performance.now() - started).toBeGreaterThan(700)
      expect(result.longest).toBeLessThan(300)
      expect(readFileSync(captured, "utf8")).toContain("change.txt")
      expect(settlement.published).toHaveLength(1)
      expect(settlement.published[0]).toMatchObject({
        state: "kept",
        touchedPaths: ["change.txt"],
        patchPath: patch,
        patchSha256: createHash("sha256").update(readFileSync(captured)).digest("hex"),
      })
    } finally {
      rmSync(workflowArtifactsRoot(projectID), { recursive: true, force: true })
    }
  })

  posixIt("lets an interruption through while the disk is slow, and publishes nothing", async () => {
    await using tmp = await tmpdir()
    const projectID = `proj-lock-fs-interrupt-${process.pid}`
    const dagID = "dag_lock_fs_interrupt"
    const directory = path.join(tmp.path, "gone")
    const file = path.join(workflowReportsArea(projectID), dagID, "_workflow.settlement.json")
    pipeAt(file)
    try {
      const settlement = settling({ dagID, projectID, owner: tmp.path, directory, status: "completed" })
      const controller = new AbortController()
      // The pipe is opened 1.5 s from now, which ends the read the interruption gives up on.
      const release = lateEnd(1.5, ': > "$1"', file)
      const started = performance.now()
      const running = Effect.runPromiseExit(settlement.effect, { signal: controller.signal })
      await Bun.sleep(100)
      controller.abort()
      const exit = await running
      // Nobody opened the pipe by then: the wait was given up, not finished; a synchronous read could not be.
      expect(performance.now() - started).toBeLessThan(1000)
      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(settlement.published).toEqual([])
      await release
    } finally {
      rmSync(workflowArtifactsRoot(projectID), { recursive: true, force: true })
    }
  })

  posixIt("lets the cap of the lock end a settlement whose disk stalls, and frees the lock", async () => {
    await using tmp = await tmpdir()
    const projectID = `proj-lock-fs-cap-${process.pid}`
    const dagID = "dag_lock_fs_cap"
    const file = path.join(workflowReportsArea(projectID), dagID, "_workflow.settlement.json")
    pipeAt(file)
    try {
      const settlement = settling({
        dagID,
        projectID,
        owner: tmp.path,
        directory: path.join(tmp.path, "gone"),
        status: "completed",
      })
      // Opened after the test is done with the pipe, which ends the read the cap gave up on.
      const release = lateEnd(2, ': > "$1"', file)
      const timedOut = await Effect.runPromise(
        Effect.gen(function* () {
          const dag = yield* Dag.Service
          const fiber = yield* dag.exclusive(dagID, settlement.effect).pipe(Effect.forkChild)
          // The read is parked on the pipe, in real time; then the clock of the test runs the cap out.
          yield* Effect.promise(() => Bun.sleep(100))
          yield* TestClock.adjust("31 seconds")
          const exit = yield* Fiber.await(fiber)
          // The lock went with the timeout: the next critical section of the workflow runs.
          expect(yield* dag.exclusive(dagID, Effect.succeed("again"))).toBe("again")
          return exit
        }).pipe(
          Effect.provide(spiedLayer(path.join(tmp.path, "transaction-open"))),
          Effect.provide(TestClock.layer()),
          Effect.scoped,
        ),
      )
      expect(Exit.isFailure(timedOut)).toBe(true)
      if (Exit.isFailure(timedOut)) {
        const defect = Cause.findDefect(timedOut.cause)
        expect(defect._tag).toBe("Success")
        if (defect._tag === "Success") expect(Cause.isTimeoutError(defect.success)).toBe(true)
      }
      expect(settlement.published).toEqual([])
      await release
    } finally {
      rmSync(workflowArtifactsRoot(projectID), { recursive: true, force: true })
    }
  })
})
