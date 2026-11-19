// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test"
import { $ } from "bun"
import { eq } from "drizzle-orm"
import { Effect, Fiber } from "effect"
import path from "node:path"
import { mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
import { Database } from "@graphagent/core/database/database"
import { WorkflowTable } from "@graphagent/core/dag/sql"
import { DagStore } from "@graphagent/core/dag/store"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { Session } from "@graphagent/schema/session"
import type { DagEvent } from "@graphagent/schema/dag-event"
import { Dag, type NodeConfig, type WorkflowConfig } from "@/dag/dag"
import { DagLocation } from "@/dag/location"
import { tmpdir } from "../fixture/fixture"
import { legacyFingerprintTarget } from "./fixture/legacy-fingerprint"
import { installGitGate, installGitShim, withoutGit } from "./fixture/git-shim"
import { spiedLayer, watchGit } from "./fixture/git-watch"

// #1344: the target fingerprint waits for git without blocking the event loop,
// gives the value the synchronous implementation gave, and is read before the
// DAG transaction opens. The shims are bash scripts.
const posixIt = it.skipIf(process.platform === "win32")

const fingerprintOf = (directory: string) => Effect.runPromise(DagLocation.fingerprintTarget(directory))

/** The asynchronous fingerprint must equal the pre-#1344 synchronous one. */
async function expectLegacyValue(directory: string) {
  const fingerprint = await fingerprintOf(directory)
  expect(fingerprint).toEqual(legacyFingerprintTarget(directory))
  return fingerprint
}

describe("fingerprintTarget waits for git without blocking the event loop", () => {
  posixIt("keeps timers firing while the git commands run", async () => {
    await using tmp = await tmpdir({ git: true })
    // An untracked file makes it five git commands, hash-object included.
    writeFileSync(path.join(tmp.path, "untracked.txt"), "untracked")
    const shim = await installGitShim("sleep 0.15")
    let ticks = 0
    const timer = setInterval(() => {
      ticks++
    }, 10)
    try {
      const started = performance.now()
      const fingerprint = await fingerprintOf(tmp.path)
      const elapsed = performance.now() - started
      expect(fingerprint.kind).toBe("git")
      // The shim really slowed git down: five commands of 150 ms each.
      expect(elapsed).toBeGreaterThan(700)
      // A blocked loop cannot run the interval while git runs; a free one runs
      // it about once per 10 ms, so the bound leaves a wide margin for load.
      expect(ticks).toBeGreaterThan(20)
    } finally {
      clearInterval(timer)
      await shim.dispose()
    }
  })

  posixIt("settles a timer set before the call ahead of the fingerprint", async () => {
    await using tmp = await tmpdir({ git: true })
    const shim = await installGitShim("sleep 0.1")
    try {
      const order: string[] = []
      const timer = new Promise<void>((resolve) =>
        setTimeout(() => {
          order.push("timer")
          resolve()
        }, 30),
      )
      const fingerprint = fingerprintOf(tmp.path).then((value) => {
        order.push("fingerprint")
        return value
      })
      await Promise.all([timer, fingerprint])
      expect(order).toEqual(["timer", "fingerprint"])
    } finally {
      await shim.dispose()
    }
  })
})

describe("fingerprintTarget keeps the value and the fallbacks of the synchronous version", () => {
  it("marks an empty path, a non-git directory, and an unborn HEAD as none", async () => {
    await using plain = await tmpdir()
    await using unborn = await tmpdir()
    await $`git init`.cwd(unborn.path).quiet()
    expect(await expectLegacyValue("")).toEqual({ kind: "none" })
    expect(await expectLegacyValue(plain.path)).toEqual({ kind: "none" })
    expect(await expectLegacyValue(unborn.path)).toEqual({ kind: "none" })
  })

  it("fingerprints a clean tree", async () => {
    await using tmp = await tmpdir({ git: true })
    const fingerprint = await expectLegacyValue(tmp.path)
    expect(fingerprint).toMatchObject({ kind: "git", diff: "clean", untracked: "clean" })
  })

  it("fingerprints tracked text and binary changes", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "text.txt"), "one\n")
        await Bun.write(path.join(dir, "binary.bin"), Buffer.from([0, 1, 2, 3, 0, 255]))
        await $`git add .`.cwd(dir).quiet()
        await $`git commit -m tracked`.cwd(dir).quiet()
      },
    })
    writeFileSync(path.join(tmp.path, "text.txt"), "two\n")
    writeFileSync(path.join(tmp.path, "binary.bin"), Buffer.from([9, 0, 8, 0, 7, 255, 254]))
    const fingerprint = await expectLegacyValue(tmp.path)
    expect(fingerprint).toMatchObject({ kind: "git", untracked: "clean" })
    if (fingerprint.kind === "git") expect(fingerprint.diff).not.toBe("clean")
  })

  posixIt("fingerprints an untracked set with ignored, odd, linked, and surplus files", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, ".gitignore"), "ignored.log\n")
        await $`git add .gitignore`.cwd(dir).quiet()
        await $`git commit -m ignore`.cwd(dir).quiet()
      },
    })
    writeFileSync(path.join(tmp.path, "ignored.log"), "never listed")
    mkdirSync(path.join(tmp.path, "nested"))
    writeFileSync(path.join(tmp.path, "nested", "inner.txt"), "inner")
    writeFileSync(path.join(tmp.path, "naïve é.txt"), "a non-ASCII name")
    writeFileSync(path.join(tmp.path, "line\nbreak.txt"), "a newline in the name")
    symlinkSync("nested/inner.txt", path.join(tmp.path, "link.txt"))
    // More than the 200 files whose content is hashed.
    for (let i = 0; i < 205; i++)
      writeFileSync(path.join(tmp.path, `bulk-${String(i).padStart(3, "0")}.txt`), `bulk ${i}`)
    const fingerprint = await expectLegacyValue(tmp.path)
    expect(fingerprint.kind).toBe("git")
    if (fingerprint.kind === "git") expect(["clean", "unavailable"]).not.toContain(fingerprint.untracked)
  })

  posixIt("marks an untracked path that cannot be looked at as missing", async () => {
    await using tmp = await tmpdir({ git: true })
    writeFileSync(path.join(tmp.path, "present.txt"), "present")
    // Git lists a link to nothing as untracked, and the stat of it fails.
    symlinkSync(path.join(tmp.path, "nowhere"), path.join(tmp.path, "dangling.txt"))
    const fingerprint = await expectLegacyValue(tmp.path)
    expect(fingerprint).toMatchObject({ kind: "git" })
    if (fingerprint.kind === "git") expect(["clean", "unavailable"]).not.toContain(fingerprint.untracked)
  })

  posixIt("spends the budget for hashed content in the order of the paths", async () => {
    await using tmp = await tmpdir({ git: true })
    // Sparse files of 30, 5 and 1 MiB against a 32 MiB budget: the first and the last are hashed, the middle one is
    // not, and a different order of the stats would hash another set and give another value.
    for (const [name, mebibytes] of [
      ["a.bin", 30],
      ["b.bin", 5],
      ["c.bin", 1],
    ] as const) {
      writeFileSync(path.join(tmp.path, name), "")
      truncateSync(path.join(tmp.path, name), mebibytes * 1024 * 1024)
    }
    const fingerprint = await expectLegacyValue(tmp.path)
    expect(fingerprint.kind).toBe("git")
  })

  posixIt("is none when git cannot be spawned", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutGit(async () => {
      expect(await expectLegacyValue(tmp.path)).toEqual({ kind: "none" })
    })
  })

  it("is none for a path that cannot be handed to a process", async () => {
    // A NUL byte makes the spawn itself throw, which the synchronous version caught.
    expect(await expectLegacyValue("/definitely/not\0a/path")).toEqual({ kind: "none" })
  })

  posixIt("marks the diff unavailable when git diff fails", async () => {
    await using tmp = await tmpdir({ git: true })
    const shim = await installGitShim('if [ "$SUB" = "diff" ]; then exit 1; fi')
    try {
      expect(await expectLegacyValue(tmp.path)).toMatchObject({ kind: "git", diff: "unavailable" })
    } finally {
      await shim.dispose()
    }
  })

  posixIt("marks the untracked set unavailable when git ls-files fails", async () => {
    await using tmp = await tmpdir({ git: true })
    const shim = await installGitShim('if [ "$SUB" = "ls-files" ]; then exit 1; fi')
    try {
      expect(await expectLegacyValue(tmp.path)).toMatchObject({ kind: "git", untracked: "unavailable" })
    } finally {
      await shim.dispose()
    }
  })

  posixIt("falls back to metadata when git hash-object fails", async () => {
    await using tmp = await tmpdir({ git: true })
    writeFileSync(path.join(tmp.path, "untracked.txt"), "untracked")
    const healthy = await expectLegacyValue(tmp.path)
    const shim = await installGitShim('if [ "$SUB" = "hash-object" ]; then exit 1; fi')
    try {
      const degraded = await expectLegacyValue(tmp.path)
      expect(degraded.kind).toBe("git")
      // The content hash is gone, so the value differs from the healthy one.
      expect(degraded).not.toEqual(healthy)
    } finally {
      await shim.dispose()
    }
  })
})

describe("DagLocation target observation", () => {
  const row = { directory: "/owner", executionDirectory: null }
  const observed = (overrides: Partial<Extract<DagLocation.TargetObservation, { _tag: "ok" }>> = {}) =>
    ({
      _tag: "ok",
      ownerDirectory: "/owner",
      toDirectory: undefined,
      executionDirectory: "/owner",
      fingerprint: { kind: "none" },
      ...overrides,
    }) satisfies DagLocation.TargetObservation

  it("holds while the row names the directories it was taken against", () => {
    expect(DagLocation.observationHolds(observed(), row)).toBe(true)
    expect(
      DagLocation.observationHolds(observed({ executionDirectory: "/bound" }), {
        ...row,
        executionDirectory: "/bound",
      }),
    ).toBe(true)
    // A requested workspace decides the tree whatever the row binds.
    expect(
      DagLocation.observationHolds(observed({ toDirectory: "/next", executionDirectory: "/next" }), {
        ...row,
        executionDirectory: "/bound",
      }),
    ).toBe(true)
    expect(DagLocation.observationHolds({ _tag: "invalid", ownerDirectory: "/owner", reason: "bad" }, row)).toBe(true)
  })

  it("stops holding when the owner or the bound execution directory moved", () => {
    expect(DagLocation.observationHolds(observed(), { ...row, directory: "/elsewhere" })).toBe(false)
    expect(DagLocation.observationHolds(observed(), { ...row, executionDirectory: "/rebound" })).toBe(false)
    expect(
      DagLocation.observationHolds(
        { _tag: "invalid", ownerDirectory: "/owner", reason: "bad" },
        { ...row, directory: "/elsewhere" },
      ),
    ).toBe(false)
  })

  it("fingerprints the owner directory, or reports an unusable workspace without fingerprinting", async () => {
    await using tmp = await tmpdir({ git: true })
    const owned = await Effect.runPromise(
      DagLocation.observeTarget({ directory: tmp.path, executionDirectory: null }, undefined),
    )
    expect(owned).toEqual({
      _tag: "ok",
      ownerDirectory: tmp.path,
      toDirectory: undefined,
      executionDirectory: tmp.path,
      fingerprint: await fingerprintOf(tmp.path),
    })
    const invalid = await Effect.runPromise(
      DagLocation.observeTarget({ directory: tmp.path }, path.join(tmp.path, "missing-workspace")),
    )
    expect(invalid._tag).toBe("invalid")
    if (invalid._tag === "invalid") expect(invalid.reason).toContain("workspace does not exist")
  })
})

const projectID = Project.ID.make("project-fingerprint-async")
const sessionID = Session.ID.make("ses_fingerprint_async_parent")

const node = (id: string, workerType: string): NodeConfig => ({
  id,
  name: id,
  worker_type: workerType,
  depends_on: [],
  required: true,
  prompt_template: { inline: id },
})

const config: WorkflowConfig = { name: "fingerprint-async", nodes: [node("review", "review"), node("build", "build")] }

const fingerprintArg = (fingerprint: DagEvent.TargetFingerprint) =>
  fingerprint.kind === "git" ? fingerprint.value : "none"

/** A workflow with a running review node that recorded its start fingerprint. */
function start(directory: string) {
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
        slug: "fingerprint",
        directory,
        title: "Fingerprint",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const dag = yield* Dag.Service
    const dagID = yield* dag.create({ projectID, sessionID, title: "fingerprint", config })
    const fingerprint = yield* DagLocation.fingerprintTarget(directory)
    yield* dag.nodeStarted(
      dagID,
      "review",
      "ses_review",
      undefined,
      true,
      undefined,
      directory,
      DagLocation.gitHead(directory),
      fingerprint,
    )
    yield* dag.nodeStarted(dagID, "build", "ses_build")
    return { dag, dagID, fingerprint }
  })
}

const gate = Effect.acquireRelease(
  Effect.promise(() => installGitGate()),
  (installed) => Effect.promise(() => installed.dispose()),
)

describe("the DAG reads git before its transaction opens (ADR-0008 decision 3)", () => {
  posixIt("retarget starts no git command inside its transaction", async () => {
    await using tmp = await tmpdir({ git: true })
    const watch = watchGit()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { dag, dagID, fingerprint } = yield* start(tmp.path)
          const shim = yield* Effect.acquireRelease(
            Effect.promise(() => watch.install()),
            (installed) => Effect.promise(() => installed.dispose()),
          )
          void shim
          const result = yield* dag.retarget(dagID, { fingerprint: fingerprintArg(fingerprint) })
          expect(result.nodes).toEqual(["review"])
          // The fingerprint ran (its diff is the telltale), and never inside the transaction.
          expect(watch.ran()).toContain("diff")
          expect(watch.insideTransaction()).toEqual([])
        }).pipe(Effect.provide(spiedLayer(watch.marker)), Effect.scoped),
      )
    } finally {
      watch.dispose()
    }
  })

  posixIt("retarget with a new workspace starts no git command inside its transaction", async () => {
    await using tmp = await tmpdir({ git: true })
    const linked = path.join(tmp.path, "linked")
    await $`git worktree add ${linked} -b fingerprint-async-linked`.cwd(tmp.path).quiet()
    const watch = watchGit()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { dag, dagID } = yield* start(tmp.path)
          const shim = yield* Effect.acquireRelease(
            Effect.promise(() => watch.install()),
            (installed) => Effect.promise(() => installed.dispose()),
          )
          void shim
          const result = yield* dag.retarget(dagID, { workspace: linked })
          expect(result.toDirectory).toBe(DagLocation.canonicalDirectory(linked))
          // resolveWorkspace asks git for the common directories and the worktree list.
          expect(watch.ran()).toContain("worktree")
          expect(watch.insideTransaction()).toEqual([])
        }).pipe(Effect.provide(spiedLayer(watch.marker)), Effect.scoped),
      )
    } finally {
      watch.dispose()
    }
  })

  posixIt("nodeCompleted starts no git command inside its transaction", async () => {
    await using tmp = await tmpdir({ git: true })
    const watch = watchGit()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { dag, dagID } = yield* start(tmp.path)
          const store = yield* DagStore.Service
          const shim = yield* Effect.acquireRelease(
            Effect.promise(() => watch.install()),
            (installed) => Effect.promise(() => installed.dispose()),
          )
          void shim
          yield* dag.nodeCompleted(dagID, "review", { verdict: "ACCEPT" })
          expect(yield* store.getNode(dagID, "review")).toMatchObject({ status: "completed", staleTarget: false })
          expect(watch.ran()).toContain("diff")
          expect(watch.insideTransaction()).toEqual([])
        }).pipe(Effect.provide(spiedLayer(watch.marker)), Effect.scoped),
      )
    } finally {
      watch.dispose()
    }
  })

  posixIt("retarget rejects a target that moved while git was being read, leaving no trace", async () => {
    await using tmp = await tmpdir({ git: true })
    const watch = watchGit()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { dag, dagID, fingerprint } = yield* start(tmp.path)
          const store = yield* DagStore.Service
          const { db } = yield* Database.Service
          const installed = yield* gate
          const call = yield* dag.retarget(dagID, { fingerprint: fingerprintArg(fingerprint) }).pipe(Effect.forkScoped)
          yield* Effect.promise(() => installed.started())
          // Another writer rebinds the workflow while the read is parked at git.
          yield* db
            .update(WorkflowTable)
            .set({ execution_directory: path.join(tmp.path, "rebound") })
            .where(eq(WorkflowTable.id, dagID))
            .run()
            .pipe(Effect.orDie)
          yield* Effect.promise(() => installed.release())
          const error = yield* Fiber.join(call).pipe(Effect.flip)
          expect(error.message).toContain("changed while it was being read")
          expect((yield* store.getNode(dagID, "review"))?.status).toBe("running")
          expect(yield* store.getLatestRetarget!(dagID)).toBeUndefined()
        }).pipe(Effect.provide(spiedLayer(watch.marker)), Effect.scoped),
      )
    } finally {
      watch.dispose()
    }
  })
})
