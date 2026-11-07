import { $ } from "bun"
import { describe, expect } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Worktree } from "../../src/worktree"
import { Project } from "../../src/project/project"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Worktree.defaultLayer, Project.defaultLayer, CrossSpawnSpawner.defaultLayer))
const wintest = process.platform === "win32" ? it.instance : it.instance.skip

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
})
