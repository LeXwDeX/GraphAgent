import { $ } from "bun"
import { describe, expect } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { Duration, Effect, Exit, Fiber, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { eq } from "drizzle-orm"
import { MemoryHome } from "@/memory/home"
import { MemoryStore } from "@/memory/store"
import { Worktree } from "../../src/worktree"
import { Project } from "../../src/project/project"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Worktree.defaultLayer,
    Project.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    MemoryStore.defaultLayer,
    Database.defaultLayer,
    EffectFlock.defaultLayer,
    MemoryHome.defaultLayer,
  ),
)
const wintest = process.platform === "win32" ? it.instance : it.instance.skip

function memoryConfig(model = "test/memory-small") {
  return {
    schema_version: 1,
    enabled: true,
    model,
    topic_limit: 10,
    turn_interval: 5,
    injection: { max_topics: 3, max_tokens: 1_200 },
  } as const
}

describe("Worktree.remove", () => {
  it.instance(
    "continues when git remove exits non-zero after detaching",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const project = yield* Project.Service
        const svc = yield* Worktree.Service
        const name = `remove-regression-${Date.now().toString(36)}`
        const branch = `opencode/${name}`
        const dir = path.join(root, "..", name)

        yield* Effect.promise(() => $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet())
        yield* Effect.promise(() => $`git reset --hard`.cwd(dir).quiet())
        const current = yield* project.fromDirectory(root)
        yield* project.addSandbox(current.project.id, dir)

        const real = (yield* Effect.promise(() => $`which git`.quiet().text())).trim()
        expect(real).toBeTruthy()

        const bin = path.join(root, "bin")
        const shim = path.join(bin, "git")
        yield* Effect.promise(() => fs.mkdir(bin, { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(
            shim,
            [
              "#!/bin/bash",
              `REAL_GIT=${JSON.stringify(real)}`,
              'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
              '  "$REAL_GIT" "$@" >/dev/null 2>&1',
              '  echo "fatal: failed to remove worktree: Directory not empty" >&2',
              "  exit 1",
              "fi",
              'exec "$REAL_GIT" "$@"',
            ].join("\n"),
          ),
        )
        yield* Effect.promise(() => fs.chmod(shim, 0o755))

        const prev = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const prev = process.env.PATH ?? ""
            process.env.PATH = `${bin}${path.delimiter}${prev}`
            return prev
          }),
          (prev) =>
            Effect.sync(() => {
              process.env.PATH = prev
            }),
        )
        void prev

        const ok = yield* svc.remove({ directory: dir })

        expect(ok).toBe(true)
        expect(
          yield* Effect.promise(() =>
            fs
              .stat(dir)
              .then(() => true)
              .catch(() => false),
          ),
        ).toBe(false)

        const list = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(root).quiet().text())
        expect(list).not.toContain(`worktree ${dir}`)

        const ref = yield* Effect.promise(() =>
          $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow(),
        )
        expect(ref.exitCode).not.toBe(0)
      }),
    { git: true },
  )

  wintest(
    "stops fsmonitor before removing a worktree",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const svc = yield* Worktree.Service
        const name = `remove-fsmonitor-${Date.now().toString(36)}`
        const branch = `opencode/${name}`
        const dir = path.join(root, "..", name)

        yield* Effect.promise(() => $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet())
        yield* Effect.promise(() => $`git reset --hard`.cwd(dir).quiet())
        yield* Effect.promise(() => $`git config core.fsmonitor true`.cwd(dir).quiet())
        yield* Effect.promise(() => $`git fsmonitor--daemon stop`.cwd(dir).quiet().nothrow())
        yield* Effect.promise(() => Bun.write(path.join(dir, "tracked.txt"), "next\n"))
        yield* Effect.promise(() => $`git diff`.cwd(dir).quiet())

        const before = yield* Effect.promise(() => $`git fsmonitor--daemon status`.cwd(dir).quiet().nothrow())
        expect(before.exitCode).toBe(0)

        const ok = yield* svc.remove({ directory: dir })

        expect(ok).toBe(true)
        expect(
          yield* Effect.promise(() =>
            fs
              .stat(dir)
              .then(() => true)
              .catch(() => false),
          ),
        ).toBe(false)

        const ref = yield* Effect.promise(() =>
          $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow(),
        )
        expect(ref.exitCode).not.toBe(0)
      }),
    { git: true },
  )

  const exists = (file: string) =>
    Effect.promise(() =>
      fs
        .stat(file)
        .then(() => true)
        .catch(() => false),
    )

  const legacyConfig = (model: string, enabled: boolean) =>
    JSON.stringify({
      schema_version: 1,
      enabled,
      model,
      topic_limit: 10,
      turn_interval: 5,
      injection: { max_topics: 3, max_tokens: 1_200 },
    })

  it.instance(
    "removing one worktree does not promote a lone sandbox config past disagreeing siblings (MEM-PR01-R1-06)",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const project = yield* Project.Service
        const svc = yield* Worktree.Service
        const current = yield* project.fromDirectory(root)
        yield* project.setInitialized(current.project.id)

        const stamp = Date.now().toString(36)
        const dirA = path.join(root, "..", `promote-a-${stamp}`)
        const dirB = path.join(root, "..", `promote-b-${stamp}`)
        yield* Effect.promise(() => $`git worktree add --no-checkout -b opencode/promote-a-${stamp} ${dirA}`.cwd(root).quiet())
        yield* Effect.promise(() => $`git worktree add --no-checkout -b opencode/promote-b-${stamp} ${dirB}`.cwd(root).quiet())
        yield* project.addSandbox(current.project.id, dirA)
        yield* project.addSandbox(current.project.id, dirB)

        // Two sandboxes carry disagreeing legacy configs; the primary has none.
        yield* Effect.promise(() => Bun.write(path.join(dirA, ".agents", "memory.jsonc"), legacyConfig("test/config-a", false)))
        yield* Effect.promise(() => Bun.write(path.join(dirB, ".agents", "memory.jsonc"), legacyConfig("test/config-b", true)))

        // Removing A must reconcile against the FULL snapshot: A's lone config
        // disagrees with B's, so nothing may be promoted and the removal fails
        // closed instead of silently flipping the project-wide configuration.
        const outcome = yield* Effect.exit(svc.remove({ directory: dirA }))
        expect(Exit.isFailure(outcome)).toBe(true)
        expect(yield* exists(path.join(root, ".agents", "memory.jsonc"))).toBe(false)
        expect(yield* exists(path.join(dirA, ".agents", "memory.jsonc"))).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "worktree removal on an uninitialized project performs no memory migration (MEM-PR01-R1-08)",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const project = yield* Project.Service
        const svc = yield* Worktree.Service
        const current = yield* project.fromDirectory(root)
        // Deliberately NOT initialized: the spec keeps uninitialized projects inert.

        const stamp = Date.now().toString(36)
        const dirA = path.join(root, "..", `inert-${stamp}`)
        yield* Effect.promise(() => $`git worktree add --no-checkout -b opencode/inert-${stamp} ${dirA}`.cwd(root).quiet())
        yield* project.addSandbox(current.project.id, dirA)

        const legacyConfig = path.join(dirA, ".agents", "memory.jsonc")
        yield* Effect.promise(() => fs.mkdir(path.dirname(legacyConfig), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(legacyConfig, JSON.stringify(memoryConfig())))

        // No migration may run for an uninitialized project: the config file
        // stays put and the removal fails closed on the residue.
        const outcome = yield* Effect.exit(svc.remove({ directory: dirA }))
        expect(Exit.isFailure(outcome)).toBe(true)
        expect(yield* exists(legacyConfig)).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "list never prunes or deregisters a merely-prunable worktree (MEM-PR01-R1-16)",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const project = yield* Project.Service
        const svc = yield* Worktree.Service
        const current = yield* project.fromDirectory(root)

        const stamp = Date.now().toString(36)
        const dirA = path.join(root, "..", `prunable-${stamp}`)
        yield* Effect.promise(() => $`git worktree add -b opencode/prunable-${stamp} ${dirA}`.cwd(root).quiet())
        yield* project.addSandbox(current.project.id, dirA)

        // Break the gitdir link: git now reports the entry as prunable even
        // though the directory still exists.
        const adminDir = path.join(root, ".git", "worktrees", `prunable-${stamp}`)
        yield* Effect.promise(() => fs.writeFile(path.join(adminDir, "gitdir"), "/nonexistent/gitdir-link\n"))
        const porcelain = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(root).quiet().text())
        expect(porcelain).toContain("prunable")

        yield* svc.list()

        // Observation must not destroy: git admin data and the registration
        // both survive a list() that saw a prunable entry.
        expect(yield* exists(path.join(adminDir, "gitdir"))).toBe(true)
        const after = yield* project.get(current.project.id)
        expect(after?.sandboxes.some((sandbox) => sandbox === dirA)).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "remove recovers a registered worktree whose git admin data is gone (MEM-PR01-R1-18)",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const project = yield* Project.Service
        const svc = yield* Worktree.Service
        const current = yield* project.fromDirectory(root)

        const stamp = Date.now().toString(36)
        const dirA = path.join(root, "..", `zombie-${stamp}`)
        yield* Effect.promise(() => $`git worktree add -b opencode/zombie-${stamp} ${dirA}`.cwd(root).quiet())
        yield* project.addSandbox(current.project.id, dirA)

        // Lose the git admin data while the directory survives.
        yield* Effect.promise(() =>
          fs.rm(path.join(root, ".git", "worktrees", `zombie-${stamp}`), { recursive: true, force: true }),
        )

        expect(yield* svc.remove({ directory: dirA })).toBe(true)
        const after = yield* project.get(current.project.id)
        expect(after?.sandboxes.some((sandbox) => sandbox === dirA)).toBe(false)
        // Registration cleanup must never delete the directory itself.
        expect(yield* exists(dirA)).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "reset invalidates the admission cache before rescanning legacy memory (MEM-PR01-R1-19)",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const project = yield* Project.Service
        const svc = yield* Worktree.Service
        const current = yield* project.fromDirectory(root)
        yield* project.setInitialized(current.project.id)

        const stamp = Date.now().toString(36)
        const dirA = path.join(root, "..", `cache-a-${stamp}`)
        const dirB = path.join(root, "..", `cache-b-${stamp}`)
        yield* Effect.promise(() => $`git worktree add -b opencode/cache-a-${stamp} ${dirA}`.cwd(root).quiet())
        yield* Effect.promise(() => $`git worktree add -b opencode/cache-b-${stamp} ${dirB}`.cwd(root).quiet())
        yield* project.addSandbox(current.project.id, dirA)
        yield* project.addSandbox(current.project.id, dirB)

        // Prime the admission cache with a clean full-snapshot scan.
        yield* svc.reset({ directory: dirB })

        // A sandbox config appears in A after the cached clean scan; the reset of
        // A must invalidate the cache and rescan, promoting it before the sweep.
        const sandboxConfig = path.join(dirA, ".agents", "memory.jsonc")
        yield* Effect.promise(() => fs.mkdir(path.dirname(sandboxConfig), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(sandboxConfig, JSON.stringify(memoryConfig())))

        const outcome = yield* Effect.exit(svc.reset({ directory: dirA }))
        expect(Exit.isSuccess(outcome)).toBe(true)
        const promoted = path.join(root, ".agents", "memory.jsonc")
        expect(JSON.parse(yield* Effect.promise(() => fs.readFile(promoted, "utf8")))).toEqual(memoryConfig())
        expect(yield* exists(sandboxConfig)).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "reset fails closed over invalid legacy memory and preserves it (MEM-PR01-R1-17)",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const project = yield* Project.Service
        const svc = yield* Worktree.Service
        const current = yield* project.fromDirectory(root)
        yield* project.setInitialized(current.project.id)

        const stamp = Date.now().toString(36)
        const dirA = path.join(root, "..", `resetblock-${stamp}`)
        yield* Effect.promise(() => $`git worktree add -b opencode/resetblock-${stamp} ${dirA}`.cwd(root).quiet())
        yield* project.addSandbox(current.project.id, dirA)

        const invalidFile = path.join(dirA, ".agents", "memory.jsonc")
        yield* Effect.promise(() => fs.mkdir(path.dirname(invalidFile), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(invalidFile, "{ invalid"))

        const outcome = yield* Effect.exit(svc.reset({ directory: dirA }))
        expect(Exit.isFailure(outcome)).toBe(true)
        if (Exit.isFailure(outcome)) expect(String(outcome.cause)).toContain("config.invalid")
        expect(yield* exists(invalidFile)).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "blocks removal when the identity retires mid-remove with un-admitted legacy memory (MEM-PR01-R9-P2A)",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const project = yield* Project.Service
        const svc = yield* Worktree.Service
        const flock = yield* EffectFlock.Service
        const home = yield* MemoryHome.Service
        const { db } = yield* Database.Service
        const current = yield* project.fromDirectory(root)
        yield* project.setInitialized(current.project.id)

        const stamp = Date.now().toString(36)
        const dir = path.join(root, "..", `retired-remove-${stamp}`)
        yield* Effect.promise(() => $`git worktree add -b opencode/retired-remove-${stamp} ${dir}`.cwd(root).quiet())
        yield* project.addSandbox(current.project.id, dir)

        // A sandbox config that was never admitted into any Home. A live
        // identity reconciles (promotes and removes) it; a retirement must not.
        const legacyFile = path.join(dir, ".agents", "memory.jsonc")
        yield* Effect.promise(() => fs.mkdir(path.dirname(legacyFile), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(legacyFile, JSON.stringify(memoryConfig())))

        // Hold the admission lock: the remove's reconcile blocks inside ensure
        // AFTER its own row-liveness check passed. While it blocks, the
        // identity row is retired by a concurrent upgrade. The in-fence
        // liveness recheck must then fail the removal closed instead of
        // destroying the never-admitted legacy content.
        const fiber = yield* flock.withLock(
          Effect.gen(function* () {
            const fiber = yield* svc.remove({ directory: dir }).pipe(Effect.forkDetach)
            yield* Effect.sleep(Duration.millis(500))
            yield* db
              .delete(ProjectTable)
              .where(eq(ProjectTable.id, current.project.id))
              .run()
              .pipe(Effect.orDie)
            return fiber
          }),
          `memory-admission:${current.project.id}`,
          home.locks,
        )
        const outcome = yield* Fiber.join(fiber).pipe(Effect.exit)

        expect(Exit.isFailure(outcome)).toBe(true)
        if (Exit.isFailure(outcome)) expect(String(outcome.cause)).toContain("identity")
        expect(yield* exists(legacyFile)).toBe(true)
      }),
    { git: true },
  )
})
