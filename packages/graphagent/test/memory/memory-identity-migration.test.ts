import { describe, expect } from "bun:test"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Deferred, Effect, Fiber, Function, Layer } from "effect"
import { MemoryHome } from "@/memory/home"
import { MemoryIdentityMigration } from "@/memory/identity-migration"
import { MemorySchema } from "@/memory/schema"
import { MemoryStore } from "@/memory/store"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(FSUtil.defaultLayer, CrossSpawnSpawner.defaultLayer))

const now = "2026-08-12T00:00:00Z"
const oldID = ProjectV2.ID.make("mig-old")
const newID = ProjectV2.ID.make("mig-new")

function topic(id: string, summary: string): MemorySchema.Topic {
  return {
    schema_version: 1,
    id,
    name: `主题 ${id}`,
    summary,
    metadata: {
      categories: ["decision"],
      status: "active",
      importance: "core",
      keywords: ["架构"],
      related_topics: [],
      created_at: now,
      updated_at: now,
      last_matched_at: null,
      match_count: 0,
      revision: 1,
      item_count: 1,
    },
    items: [
      {
        id: `${id}-item`,
        kind: "decision",
        content: "已确认决定：核心模块之间使用稳定边界",
        rationale: "该边界由用户确认并长期适用",
        confirmed_at: now,
      },
    ],
  } satisfies MemorySchema.Topic
}

function layers(root: string, fs = FSUtil.defaultLayer, flock = EffectFlock.defaultLayer) {
  const home = Layer.succeed(MemoryHome.Service, MemoryHome.make(root))
  const store = MemoryStore.layer.pipe(Layer.provide(fs), Layer.provide(flock), Layer.provide(home))
  const migration = MemoryIdentityMigration.layer.pipe(
    Layer.provide(fs),
    Layer.provide(flock),
    Layer.provide(home),
    Layer.provide(store),
  )
  return Layer.mergeAll(home, store, migration)
}

function seed(projectID: ProjectV2.ID, topics: MemorySchema.Topic[]) {
  return Effect.gen(function* () {
    const store = yield* MemoryStore.Service
    yield* store.updateTopics(projectID, () => ({
      applied: { topics, changed: topics.map((value) => value.id), deleted: [] },
      result: undefined,
    }))
  })
}

describe("MEM-PR01-R1-12: identity upgrade survives the store's own crash residue", () => {
  it.live(
    "a leftover manifest temp file in the source Home does not wedge the merge",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const home = yield* MemoryHome.Service
          const store = yield* MemoryStore.Service
          const migration = yield* MemoryIdentityMigration.Service

          yield* seed(oldID, [topic("source-topic", "源仓库主题")])
          yield* seed(newID, [topic("target-topic", "另一仓库主题")])
          // Simulate a process killed between atomicWrite's temp write and rename:
          // the store's own residue sits at the Home root next to manifest.json.
          yield* fs.writeFileString(`${home.manifest(oldID)}.4242.deadbeef.tmp`, "partial")

          yield* migration.migrateHome(oldID, newID)

          const merged = yield* store.readSnapshot(newID)
          expect(merged.topics.map((value) => value.id).sort()).toEqual(["source-topic", "target-topic"])
          expect(yield* fs.existsSafe(home.directory(oldID))).toBe(false)
        }).pipe(Effect.provide(layers(root)))
      }),
    { timeout: 30_000 },
  )

  it.live(
    "a leftover manifest temp file in the target Home does not wedge the merge",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const home = yield* MemoryHome.Service
          const store = yield* MemoryStore.Service
          const migration = yield* MemoryIdentityMigration.Service

          yield* seed(oldID, [topic("source-topic", "源仓库主题")])
          yield* seed(newID, [topic("target-topic", "另一仓库主题")])
          yield* fs.writeFileString(`${home.manifest(newID)}.4242.deadbeef.tmp`, "partial")

          yield* migration.migrateHome(oldID, newID)

          const merged = yield* store.readSnapshot(newID)
          expect(merged.topics.map((value) => value.id).sort()).toEqual(["source-topic", "target-topic"])
          expect(yield* fs.existsSafe(home.directory(oldID))).toBe(false)
        }).pipe(Effect.provide(layers(root)))
      }),
    { timeout: 30_000 },
  )

  it.live(
    "foreign files at the Home root still fail closed",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const home = yield* MemoryHome.Service
          const migration = yield* MemoryIdentityMigration.Service

          yield* seed(oldID, [topic("source-topic", "源仓库主题")])
          yield* seed(newID, [topic("target-topic", "另一仓库主题")])
          yield* fs.writeFileString(`${home.directory(oldID)}/notes.txt`, "not ours")

          const error = yield* migration.migrateHome(oldID, newID).pipe(Effect.flip)
          expect(error._tag).toBe("MemoryIdentityMigration.InvalidHome")
        }).pipe(Effect.provide(layers(root)))
      }),
    { timeout: 30_000 },
  )
})

describe("identity migration preserves concurrent memory writers", () => {
  for (const targetExists of [false, true]) {
    it.live(
      `merges under the target lock when the target initially ${targetExists ? "exists" : "does not exist"}`,
      () =>
        Effect.gen(function* () {
          const root = yield* tmpdirScoped()
          const fs = yield* FSUtil.Service
          const homes = MemoryHome.make(root)
          const writerPaused = yield* Deferred.make<void>()
          const releaseWriter = yield* Deferred.make<void>()
          const targetLockRequested = yield* Deferred.make<void>()
          let pauseWriter = false
          let observeMigration = false
          const controlledFS = Layer.succeed(FSUtil.Service, {
            ...fs,
            makeDirectory: (directory, options) =>
              Effect.gen(function* () {
                if (pauseWriter && directory === homes.generations(newID)) {
                  pauseWriter = false
                  yield* Deferred.succeed(writerPaused, undefined)
                  yield* Deferred.await(releaseWriter)
                }
                return yield* fs.makeDirectory(directory, options)
              }),
          })
          const observedFlock = Layer.effect(
            EffectFlock.Service,
            Effect.gen(function* () {
              const flock = yield* EffectFlock.Service
              const withLock: EffectFlock.Interface["withLock"] = Function.dual(
                (args) => Effect.isEffect(args[0]),
                <A, E, R>(body: Effect.Effect<A, E, R>, key: string, directory?: string) =>
                  Effect.gen(function* () {
                    if (observeMigration && key === `memory-project:${newID}`)
                      yield* Deferred.succeed(targetLockRequested, undefined)
                    return yield* flock.withLock(body, key, directory)
                  }),
              )
              return EffectFlock.Service.of({ ...flock, withLock })
            }),
          ).pipe(Layer.provide(EffectFlock.defaultLayer))

          yield* Effect.gen(function* () {
            const store = yield* MemoryStore.Service
            const migration = yield* MemoryIdentityMigration.Service
            yield* seed(oldID, [topic("source-topic", "源仓库主题")])
            if (targetExists) yield* seed(newID, [topic("target-topic", "另一仓库主题")])
            pauseWriter = true
            // Pause after the writer reads its snapshot while it still holds
            // the real target flock, before it creates or commits a generation.
            const writer = yield* store
              .updateTopics(newID, (topics) => ({
                applied: {
                  topics: [...topics, topic("writer-topic", "并发写入主题")],
                  changed: ["writer-topic"],
                  deleted: [],
                },
                result: topics.length,
              }))
              .pipe(Effect.forkScoped)
            yield* Deferred.await(writerPaused)
            observeMigration = true
            const migrating = yield* migration.migrateHome(oldID, newID).pipe(Effect.forkScoped)
            yield* Deferred.await(targetLockRequested)
            // Migration must wait for the same flock instead of renaming into
            // a home whose live writer has already read an empty snapshot.
            expect(yield* fs.existsSafe(homes.directory(oldID))).toBe(true)
            yield* Deferred.succeed(releaseWriter, undefined)
            expect((yield* Fiber.join(writer)).result).toBe(targetExists ? 1 : 0)
            yield* Fiber.join(migrating)
            const merged = yield* store.readSnapshot(newID)
            expect(merged.topics.map((value) => value.id).sort()).toEqual(
              targetExists ? ["source-topic", "target-topic", "writer-topic"] : ["source-topic", "writer-topic"],
            )
            expect(yield* fs.existsSafe(homes.directory(oldID))).toBe(false)
          }).pipe(Effect.provide(layers(root, controlledFS, observedFlock)), Effect.timeout("10 seconds"))
        }),
      { timeout: 20_000 },
    )
  }

  it.live(
    "rechecks source topics removed from the target after the initial comparison",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const fs = yield* FSUtil.Service
        const homes = MemoryHome.make(root)
        const targetReadPaused = yield* Deferred.make<void>()
        const releaseRead = yield* Deferred.make<void>()
        let pauseRead = false
        const controlledFS = Layer.succeed(FSUtil.Service, {
          ...fs,
          readFileString: (file, encoding) =>
            Effect.gen(function* () {
              const content = yield* fs.readFileString(file, encoding)
              if (pauseRead && file.startsWith(homes.generations(newID)) && file.endsWith("/shared-topic.yaml")) {
                pauseRead = false
                yield* Deferred.succeed(targetReadPaused, undefined)
                yield* Deferred.await(releaseRead)
              }
              return content
            }),
        })
        yield* Effect.gen(function* () {
          const store = yield* MemoryStore.Service
          const migration = yield* MemoryIdentityMigration.Service
          const shared = topic("shared-topic", "两个仓库各自演化的同一主题")
          yield* seed(oldID, [shared])
          yield* seed(newID, [shared])
          pauseRead = true
          const migrating = yield* migration.migrateHome(oldID, newID).pipe(Effect.forkScoped)
          yield* Deferred.await(targetReadPaused)
          yield* store.updateTopics(newID, () => ({
            applied: { topics: [], changed: [], deleted: [shared.id] },
            result: undefined,
          }))
          yield* Deferred.succeed(releaseRead, undefined)
          yield* Fiber.join(migrating)
          expect((yield* store.readSnapshot(newID)).topics.map((value) => value.id)).toEqual(["shared-topic"])
          expect(yield* fs.existsSafe(homes.directory(oldID))).toBe(false)
        }).pipe(Effect.provide(layers(root, controlledFS)), Effect.timeout("10 seconds"))
      }),
    { timeout: 20_000 },
  )

  it.live(
    "keeps a changed source and converges without another write on repeated migration",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const fs = yield* FSUtil.Service
        const homes = MemoryHome.make(root)
        const targetWritePaused = yield* Deferred.make<void>()
        const releaseTarget = yield* Deferred.make<void>()
        let pauseTarget = true
        const controlledFS = Layer.succeed(FSUtil.Service, {
          ...fs,
          makeDirectory: (directory, options) =>
            Effect.gen(function* () {
              if (pauseTarget && directory === homes.generations(newID)) {
                pauseTarget = false
                yield* Deferred.succeed(targetWritePaused, undefined)
                yield* Deferred.await(releaseTarget)
              }
              return yield* fs.makeDirectory(directory, options)
            }),
        })
        yield* Effect.gen(function* () {
          const store = yield* MemoryStore.Service
          const migration = yield* MemoryIdentityMigration.Service
          const original = topic("source-topic", "源仓库主题")
          yield* seed(oldID, [original])
          const migrating = yield* migration.migrateHome(oldID, newID).pipe(Effect.flip, Effect.forkScoped)
          yield* Deferred.await(targetWritePaused)
          yield* seed(oldID, [original, topic("later-topic", "快照之后写入的主题")])
          yield* Deferred.succeed(releaseTarget, undefined)
          expect((yield* Fiber.join(migrating))._tag).toBe("MemoryIdentityMigration.SourceChanged")
          expect(yield* fs.existsSafe(homes.directory(oldID))).toBe(true)
          expect((yield* store.readSnapshot(oldID)).topics.map((value) => value.id).sort()).toEqual([
            "later-topic",
            "source-topic",
          ])

          yield* migration.migrateHome(oldID, newID)
          const merged = yield* store.readSnapshot(newID)
          expect(merged.topics.map((value) => value.id).sort()).toEqual(["later-topic", "source-topic"])
          expect(yield* fs.existsSafe(homes.directory(oldID))).toBe(false)
          yield* migration.migrateHome(oldID, newID)
          expect(yield* store.readSnapshot(newID)).toEqual(merged)
        }).pipe(Effect.provide(layers(root, controlledFS)), Effect.timeout("10 seconds"))
      }),
    { timeout: 20_000 },
  )
})

describe("MEM-PR01-R1-24: opposite-direction migrations cannot deadlock", () => {
  it.live(
    "concurrent A→B and B→A migrations complete instead of wedging on nested flocks",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const home = yield* MemoryHome.Service
          const store = yield* MemoryStore.Service
          const migration = yield* MemoryIdentityMigration.Service

          // Both Homes exist, so both directions take the merge path (not the
          // rename fast path). Under the legacy locking, A→B holds flock(A) and
          // waits for flock(B) inside the target update while B→A holds flock(B)
          // and waits for flock(A) — a deadlock broken only by the 5 minute lock
          // timeout, which this test's timeout deliberately undercuts.
          yield* seed(oldID, [topic("topic-old", "旧身份的主题")])
          yield* seed(newID, [topic("topic-new", "新身份的主题")])

          yield* Effect.all([migration.migrateHome(oldID, newID), migration.migrateHome(newID, oldID)], {
            concurrency: 2,
          })

          const oldExists = yield* fs.existsSafe(home.directory(oldID))
          const newExists = yield* fs.existsSafe(home.directory(newID))
          // Exactly one Home survives, holding the union of both topic sets.
          expect(oldExists).not.toBe(newExists)
          const survivor = oldExists ? oldID : newID
          const merged = yield* store.readSnapshot(survivor)
          expect(merged.topics.map((value) => value.id).sort()).toEqual(["topic-new", "topic-old"])
        }).pipe(Effect.provide(layers(root)))
      }),
    { timeout: 20_000 },
  )
})

describe("MEM-PR01-R1-13: interrupted migration retries to convergence", () => {
  it.live(
    "a crash after import but before source removal converges on retry",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const home = yield* MemoryHome.Service
          const store = yield* MemoryStore.Service
          const migration = yield* MemoryIdentityMigration.Service

          const shared = topic("carried-topic", "迁移中断后仍然保留的主题")
          // State a crash would leave behind: the import already landed in the
          // target, the source Home still exists with the same content.
          yield* seed(oldID, [shared])
          yield* seed(newID, [shared])

          yield* migration.migrateHome(oldID, newID)

          expect(yield* fs.existsSafe(home.directory(oldID))).toBe(false)
          const merged = yield* store.readSnapshot(newID)
          expect(merged.topics.map((value) => value.id)).toEqual(["carried-topic"])
        }).pipe(Effect.provide(layers(root)))
      }),
    { timeout: 30_000 },
  )
})

describe("MEM-PR01-R1-15: identity merge compares content, not controller metadata", () => {
  it.live(
    "the same topic with drifted match metadata is not a conflict",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const home = yield* MemoryHome.Service
          const store = yield* MemoryStore.Service
          const migration = yield* MemoryIdentityMigration.Service

          const shared = topic("shared-topic", "两个仓库各自演化的同一主题")
          // The target copy was matched live: controller metadata drifted while
          // the content stayed identical.
          const drifted = MemoryStore.markMatched([shared], ["shared-topic"]).topics[0]
          expect(JSON.stringify(drifted)).not.toBe(JSON.stringify(shared))

          yield* seed(oldID, [shared])
          yield* seed(newID, [drifted])

          yield* migration.migrateHome(oldID, newID)

          const merged = yield* store.readSnapshot(newID)
          expect(merged.topics.map((value) => value.id)).toEqual(["shared-topic"])
          // The target's own (newer) copy stays authoritative.
          expect(merged.topics[0].metadata.match_count).toBe(drifted.metadata.match_count)
          expect(yield* fs.existsSafe(home.directory(oldID))).toBe(false)
        }).pipe(Effect.provide(layers(root)))
      }),
    { timeout: 30_000 },
  )

  it.live(
    "a real content difference is still a conflict",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const migration = yield* MemoryIdentityMigration.Service

          yield* seed(oldID, [topic("shared-topic", "源版本的内容")])
          yield* seed(newID, [topic("shared-topic", "新版本的内容完全不同")])

          const error = yield* migration.migrateHome(oldID, newID).pipe(Effect.flip)
          expect(error._tag).toBe("MemoryIdentityMigration.Conflict")
        }).pipe(Effect.provide(layers(root)))
      }),
    { timeout: 30_000 },
  )
})
