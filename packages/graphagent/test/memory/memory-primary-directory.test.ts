import { describe, expect, afterAll, beforeAll } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Config } from "@/config/config"
import { Project } from "@/project/project"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Memory } from "@/memory/memory"
import { MemoryConfig } from "@/memory/config"
import { MemoryHome } from "@/memory/home"
import { MemoryIdentityFence } from "@/memory/identity-fence"
import { MemoryLock } from "@/memory/lock"
import { MemoryStore } from "@/memory/store"
import { MemoryModel } from "@/memory/model"
import { ProviderTest } from "../fake/provider"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The Project row's `worktree` is the first-seen checkout and is never
// repointed. Once that checkout is deleted — or its path is reused by an
// unrelated repository — /memory on|off from another checkout of the same
// Project must not (re)create `.agents/settings.local.json` there.

// Private global config dir so other test files cannot leak a global memory.jsonc in.
const pinnedConfigDir = path.join(os.tmpdir(), `opencode-memory-primary-${process.pid}`)
const previousConfigDir = process.env.GRAPHAGENT_CONFIG_DIR
beforeAll(() => {
  fs.mkdirSync(pinnedConfigDir, { recursive: true })
  process.env.GRAPHAGENT_CONFIG_DIR = pinnedConfigDir
})
afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.GRAPHAGENT_CONFIG_DIR
  else process.env.GRAPHAGENT_CONFIG_DIR = previousConfigDir
})

const base = Layer.mergeAll(
  Layer.mock(Config.Service, { get: () => Effect.succeed({}) }),
  ProviderTest.fake().layer,
  Project.defaultLayer,
  ProjectV2.defaultLayer,
  Database.defaultLayer,
  Git.defaultLayer,
  FSUtil.defaultLayer,
  EffectFlock.defaultLayer,
  MemoryConfig.defaultLayer,
  MemoryHome.defaultLayer,
  MemoryIdentityFence.defaultLayer,
  MemoryLock.defaultLayer,
  MemoryStore.defaultLayer,
  Layer.mock(MemoryModel.Service, {
    generate: () => Effect.die(new Error("model calls are not expected in primary-directory tests")),
  }),
)

const it = testEffect(Layer.mergeAll(Memory.layer.pipe(Layer.provideMerge(base)), CrossSpawnSpawner.defaultLayer))

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
}

describe("memory primary directory", () => {
  for (const fate of ["deleted", "reused by another repository"] as const) {
    it.live(
      `/memory on writes project config to a live checkout when the primary was ${fate}`,
      () =>
        Effect.gen(function* () {
          const primary = yield* tmpdirScoped({ git: true })
          const sandbox = yield* tmpdirScoped()
          const projectID = yield* provideInstance(primary)(
            Effect.gen(function* () {
              const project = yield* Project.Service
              const { project: info } = yield* project.fromDirectory(primary)
              expect(info.id).not.toBe(ProjectV2.ID.global)
              yield* project.setInitialized(info.id)
              return info.id
            }),
          ).pipe(Effect.provide(testInstanceStoreLayer))

          // A second checkout of the same Project (same history and cached identity).
          fs.cpSync(primary, sandbox, { recursive: true })
          fs.rmSync(primary, { recursive: true, force: true })
          if (fate === "reused by another repository") {
            fs.mkdirSync(primary, { recursive: true })
            git(primary, "init")
            git(
              primary,
              "-c",
              "user.email=test@opencode.test",
              "-c",
              "user.name=Test",
              "-c",
              "commit.gpgsign=false",
              "commit",
              "--allow-empty",
              "-m",
              `unrelated root ${primary}`,
            )
          }

          yield* provideInstance(sandbox)(
            Effect.gen(function* () {
              const project = yield* Project.Service
              const memory = yield* Memory.Service
              const config = yield* MemoryConfig.Service
              const { project: info } = yield* project.fromDirectory(sandbox)
              expect(info.id).toBe(projectID)
              expect(info.worktree).toBe(primary)

              // The bootstrapped global config is enabled, so `off` is the first
              // command that must write Project configuration.
              expect(yield* memory.setEnabled(false)).toBe("Memory off")
              expect((yield* config.load(sandbox))?.level).toBe("project")
              expect((yield* config.load(sandbox))?.config.enabled).toBe(false)
              expect(fs.existsSync(path.join(primary, ".agents"))).toBe(false)
              if (fate === "deleted") expect(fs.existsSync(primary)).toBe(false)
              expect(yield* memory.status()).toBe("Memory remains off")

              expect(yield* memory.setEnabled(true)).toBe("Memory on")
              expect((yield* config.load(sandbox))?.config.enabled).toBe(true)
              expect(fs.existsSync(path.join(primary, ".agents"))).toBe(false)
              expect(yield* memory.status()).toBe("Memory on")
            }),
          ).pipe(Effect.provide(testInstanceStoreLayer))
        }),
      { timeout: 30_000 },
    )
  }

  it.live(
    "a primary verified earlier is re-checked after its path is reused by another repository",
    () =>
      Effect.gen(function* () {
        const primary = yield* tmpdirScoped({ git: true })
        const sandbox = yield* tmpdirScoped()
        yield* provideInstance(primary)(
          Effect.gen(function* () {
            const project = yield* Project.Service
            const { project: info } = yield* project.fromDirectory(primary)
            yield* project.setInitialized(info.id)
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
        fs.cpSync(primary, sandbox, { recursive: true })

        // Same Memory service throughout, as in a long-lived process.
        yield* provideInstance(sandbox)(
          Effect.gen(function* () {
            const memory = yield* Memory.Service
            expect(yield* memory.setEnabled(false)).toBe("Memory off")
            expect(fs.existsSync(path.join(primary, ".agents", "settings.local.json"))).toBe(true)
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))

        fs.rmSync(primary, { recursive: true, force: true })
        fs.mkdirSync(primary, { recursive: true })
        git(primary, "init")
        git(
          primary,
          "-c",
          "user.email=test@opencode.test",
          "-c",
          "user.name=Test",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--allow-empty",
          "-m",
          `unrelated root ${primary}`,
        )

        yield* provideInstance(sandbox)(
          Effect.gen(function* () {
            const memory = yield* Memory.Service
            const config = yield* MemoryConfig.Service
            // `off` must write Project configuration again (the global default is on).
            expect(yield* memory.setEnabled(false)).toBe("Memory off")
            expect(fs.existsSync(path.join(primary, ".agents"))).toBe(false)
            expect((yield* config.load(sandbox))?.config.enabled).toBe(false)
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
      }),
    { timeout: 30_000 },
  )

  it.live(
    "a primary verified earlier is re-checked after its remote is repointed in place",
    () =>
      Effect.gen(function* () {
        const primary = yield* tmpdirScoped({ git: true })
        const sandbox = yield* tmpdirScoped()
        yield* provideInstance(primary)(
          Effect.gen(function* () {
            const project = yield* Project.Service
            const { project: info } = yield* project.fromDirectory(primary)
            yield* project.setInitialized(info.id)
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
        fs.cpSync(primary, sandbox, { recursive: true })

        yield* provideInstance(sandbox)(
          Effect.gen(function* () {
            const memory = yield* Memory.Service
            expect(yield* memory.setEnabled(false)).toBe("Memory off")
            expect(fs.existsSync(path.join(primary, ".agents", "settings.local.json"))).toBe(true)
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))

        // Same directory and `.git` inode, different repository identity.
        fs.rmSync(path.join(primary, ".agents"), { recursive: true, force: true })
        git(primary, "remote", "add", "origin", "https://example.test/unrelated/repository.git")

        yield* provideInstance(sandbox)(
          Effect.gen(function* () {
            const memory = yield* Memory.Service
            const config = yield* MemoryConfig.Service
            expect(yield* memory.setEnabled(false)).toBe("Memory off")
            expect(fs.existsSync(path.join(primary, ".agents"))).toBe(false)
            expect((yield* config.load(sandbox))?.config.enabled).toBe(false)
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
      }),
    { timeout: 30_000 },
  )

  it.live(
    "the active primary checkout repointed in place leaves Memory inert",
    () =>
      Effect.gen(function* () {
        const primary = yield* tmpdirScoped({ git: true })
        yield* provideInstance(primary)(
          Effect.gen(function* () {
            const project = yield* Project.Service
            const { project: info } = yield* project.fromDirectory(primary)
            yield* project.setInitialized(info.id)
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))

        yield* provideInstance(primary)(
          Effect.gen(function* () {
            const memory = yield* Memory.Service
            expect(yield* memory.setEnabled(false)).toBe("Memory off")
            expect(fs.existsSync(path.join(primary, ".agents", "settings.local.json"))).toBe(true)

            // The live instance keeps its Project while the checkout now belongs elsewhere.
            fs.rmSync(path.join(primary, ".agents"), { recursive: true, force: true })
            git(primary, "remote", "add", "origin", "https://example.test/unrelated/repository.git")
            expect(yield* memory.setEnabled(false)).not.toBe("Memory off")
            expect(fs.existsSync(path.join(primary, ".agents"))).toBe(false)
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
      }),
    { timeout: 30_000 },
  )
})
