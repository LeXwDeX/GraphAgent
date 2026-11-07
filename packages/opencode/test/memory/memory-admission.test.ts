import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "node:path"
import { MemoryAdmission } from "@/memory/admission"
import { MemoryConfig } from "@/memory/config"
import { MemoryHome } from "@/memory/home"
import { MemoryIdentityFence } from "@/memory/identity-fence"
import { MemoryStore } from "@/memory/store"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(FSUtil.defaultLayer, CrossSpawnSpawner.defaultLayer))
const projectID = ProjectV2.ID.make("project-memory-admission")
const config = {
  schema_version: 1,
  enabled: true,
  model: "test/memory-small",
  topic_limit: 10,
  turn_interval: 5,
  injection: { max_topics: 3, max_tokens: 1_200 },
} as const
function layers(root: string) {
  const home = Layer.succeed(MemoryHome.Service, MemoryHome.make(root))
  // One shared Database layer: the fence's liveness recheck and the test
  // body's row setup must see the same rows.
  const database = Database.defaultLayer
  const store = MemoryStore.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(EffectFlock.defaultLayer),
    Layer.provide(home),
  )
  const fence = MemoryIdentityFence.layer.pipe(
    Layer.provide(database),
    Layer.provide(EffectFlock.defaultLayer),
    Layer.provide(home),
  )
  const admission = MemoryAdmission.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(EffectFlock.defaultLayer),
    Layer.provide(MemoryConfig.defaultLayer),
    Layer.provide(home),
    Layer.provide(store),
    Layer.provide(fence),
  )
  return Layer.mergeAll(admission, store, MemoryConfig.defaultLayer, database)
}

describe("MemoryAdmission", () => {
  it.live("promotes one normalized sandbox configuration when the Project has no explicit configuration", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const primary = yield* tmpdirScoped({ git: true })
      const first = yield* tmpdirScoped()
      const second = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const admission = yield* MemoryAdmission.Service
        const configStore = yield* MemoryConfig.Service
        const { db } = yield* Database.Service
        // ensure() runs for live identities; the fence re-checks the row.
        yield* db
          .insert(ProjectTable)
          .values({ id: projectID, worktree: AbsolutePath.make(primary), vcs: "git", sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        const files = [first, second].map((directory) => path.join(directory, ".agents", "memory.jsonc"))
        yield* Effect.forEach(files, (file) => fs.makeDirectory(path.dirname(file), { recursive: true }), {
          concurrency: 1,
          discard: true,
        })
        yield* Effect.forEach(files, (file) => fs.writeFileString(file, JSON.stringify(config)), {
          concurrency: 1,
          discard: true,
        })

        const result = yield* admission.ensure({
          projectID,
          projectDirectory: primary,
          directories: [primary, first, second],
          updated: 1,
        })

        expect(result.diagnostics.map((item) => item.code)).toEqual(["config.promoted", "config.duplicate"])
        expect((yield* configStore.load(primary))?.config).toEqual(config)
        expect(yield* Effect.forEach(files, (file) => fs.existsSafe(file))).toEqual([false, false])
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live("caches one Project snapshot until worktree lifecycle invalidates it", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const primary = yield* tmpdirScoped({ git: true })
      const sandbox = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const admission = yield* MemoryAdmission.Service
        const { db } = yield* Database.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: projectID, worktree: AbsolutePath.make(primary), vcs: "git", sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        const snapshot = { projectID, projectDirectory: primary, directories: [primary, sandbox], updated: 1 }

        expect((yield* admission.ensure(snapshot)).diagnostics).toEqual([])
        const file = path.join(sandbox, ".agents", "memory.jsonc")
        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        yield* fs.writeFileString(file, "{ invalid")

        expect((yield* admission.ensure(snapshot)).diagnostics).toEqual([])
        yield* admission.invalidate(projectID)
        expect((yield* admission.ensure(snapshot)).diagnostics.map((item) => item.code)).toEqual(["config.invalid"])
        expect(yield* fs.existsSafe(file)).toBe(true)
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  const fullLayers = (root: string) => {
    const home = Layer.succeed(MemoryHome.Service, MemoryHome.make(root))
    const flock = EffectFlock.defaultLayer
    const database = Database.defaultLayer
    const fence = MemoryIdentityFence.layer.pipe(
      Layer.provide(database),
      Layer.provide(flock),
      Layer.provide(home),
    )
    const base = Layer.mergeAll(FSUtil.defaultLayer, flock, home, MemoryConfig.defaultLayer, database)
    const store = MemoryStore.layer.pipe(Layer.provide(base))
    const admission = MemoryAdmission.layer.pipe(Layer.provide(base), Layer.provide(store), Layer.provide(fence))
    return Layer.mergeAll(base, store, admission)
  }

  it.live(
    "follows the loader's jsonc-over-json precedence and diagnoses an in-project config fork (MEM-PR01-R1-10)",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const primary = yield* tmpdirScoped({ git: true })
        const sandbox = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const admission = yield* MemoryAdmission.Service
          const { db } = yield* Database.Service
          yield* db
            .insert(ProjectTable)
            .values({ id: projectID, worktree: AbsolutePath.make(primary), vcs: "git", sandboxes: [] })
            .run()
            .pipe(Effect.orDie)

          const configA = { ...config, model: "test/config-jsonc" }
          const configB = { ...config, model: "test/config-json" }
          const opencode = path.join(primary, ".agents")
          yield* fs.makeDirectory(opencode, { recursive: true })
          // The loader (MemoryConfig.load) prefers memory.jsonc; admission must
          // agree, and the disagreeing memory.json must be diagnosed as a fork
          // instead of silently becoming authoritative.
          yield* fs.writeFileString(path.join(opencode, "memory.jsonc"), JSON.stringify(configA))
          yield* fs.writeFileString(path.join(opencode, "memory.json"), JSON.stringify(configB))
          // A sandbox legacy config equal to the NON-effective json content must
          // not be deleted as a duplicate of the effective config.
          const sandboxFile = path.join(sandbox, ".agents", "memory.jsonc")
          yield* fs.makeDirectory(path.dirname(sandboxFile), { recursive: true })
          yield* fs.writeFileString(sandboxFile, JSON.stringify(configB))

          const result = yield* admission.ensure({
            projectID,
            projectDirectory: primary,
            directories: [primary, sandbox],
            updated: 1,
          })

          const fork = result.diagnostics.filter((item) => item.path.endsWith("memory.json"))
          expect(fork.length).toBe(1)
          expect(fork[0].code).toBe("config.conflict")
          expect(result.diagnostics.some((item) => item.path === sandboxFile && item.code === "config.conflict")).toBe(true)
          expect(yield* fs.existsSafe(sandboxFile)).toBe(true)
          expect(result.unresolved).toBeGreaterThan(0)
        }).pipe(Effect.provide(fullLayers(root)))
      }),
      { timeout: 30_000 },
  )

  it.live(
    "does not reconcile memory configs for a retired identity nor delete the files (MEM-PR01-R7-F1)",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const primary = yield* tmpdirScoped({ git: true })
        const sandbox = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const home = yield* MemoryHome.Service
          const admission = yield* MemoryAdmission.Service

          // A live identity would delete the sandbox copy as a duplicate of the
          // explicit project config.
          const projectFile = path.join(primary, ".agents", "memory.jsonc")
          const sandboxFile = path.join(sandbox, ".agents", "memory.jsonc")
          yield* fs.makeDirectory(path.dirname(projectFile), { recursive: true })
          yield* fs.makeDirectory(path.dirname(sandboxFile), { recursive: true })
          yield* fs.writeFileString(projectFile, JSON.stringify(config))
          yield* fs.writeFileString(sandboxFile, JSON.stringify(config))

          // The identity row was retired by a concurrent upgrade: the snapshot is
          // still stamped under the old identity but the row no longer exists.
          const result = yield* admission
            .ensure({ projectID, projectDirectory: primary, directories: [primary, sandbox], updated: 1 })
            .pipe(Effect.exit)

          // Fail-closed: reconciliation must not re-create the retired Home and
          // must not delete the sandbox copy.
          expect(Exit.isFailure(result)).toBe(true)
          const failReasons = Exit.isFailure(result) ? result.cause.reasons.filter(Cause.isFailReason) : []
          expect(failReasons.map((reason) => reason.error._tag)).toEqual(["MemoryAdmission.IdentityRetired"])
          expect(yield* fs.existsSafe(sandboxFile)).toBe(true)
          expect(yield* fs.existsSafe(home.directory(projectID))).toBe(false)
        }).pipe(Effect.provide(fullLayers(root)))
      }),
  )
})
