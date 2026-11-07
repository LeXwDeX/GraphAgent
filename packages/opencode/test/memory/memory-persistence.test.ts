import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Exit, Fiber, Layer, Ref, Schema } from "effect"
import { chmod } from "node:fs/promises"
import path from "node:path"
import { MemoryConfig } from "@/memory/config"
import { MemoryHome } from "@/memory/home"
import { MemoryIdentityFence } from "@/memory/identity-fence"
import { MemoryIdentityMigration } from "@/memory/identity-migration"
import { MemoryAdmission } from "@/memory/admission"
import { MemoryPaths } from "@/memory/paths"
import { MemorySchema } from "@/memory/schema"
import { MemoryStore } from "@/memory/store"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(FSUtil.defaultLayer, CrossSpawnSpawner.defaultLayer))
const projectID = ProjectV2.ID.make("project-memory-test")
const otherProjectID = ProjectV2.ID.make("project-memory-other")
const now = "2026-08-11T00:00:00Z"

const config = {
  schema_version: 1,
  enabled: true,
  model: "test/memory-small",
  topic_limit: 10,
  turn_interval: 5,
  injection: { max_topics: 3, max_tokens: 1_200 },
} satisfies MemorySchema.Config

function topic(summary = "已确认的核心架构边界") {
  return {
    schema_version: 1,
    id: "project-architecture",
    name: "架构边界",
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
        id: "decision-01",
        kind: "decision",
        content: "已确认决定：核心模块之间使用稳定边界",
        rationale: "该边界由用户确认并长期适用",
        confirmed_at: now,
      },
    ],
  } satisfies MemorySchema.Topic
}

function terminologyTopic() {
  const value = topic("术语 Project Memory 指项目级持久化记忆")
  return {
    ...value,
    id: "project-memory-term",
    name: "Project Memory 术语",
    metadata: {
      ...value.metadata,
      categories: ["term"],
      keywords: ["Project Memory"],
    },
    items: [
      {
        id: "term-01",
        kind: "term",
        content: "术语 Project Memory 指项目级持久化记忆",
        rationale: "该术语由用户确认并长期适用",
        confirmed_at: now,
      },
    ],
  } satisfies MemorySchema.Topic
}

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
  return Layer.mergeAll(home, store, admission, MemoryConfig.defaultLayer, database)
}

/**
 * Inserts a live identity row. Production callers of ensure() always run with
 * a live row (configuration() re-reads it, the worktree guard requires an
 * initialized project); the fence's liveness recheck needs it in tests too.
 */
function insertLiveRow(id: ProjectV2.ID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id, worktree: AbsolutePath.make("/unused"), vcs: "git", sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
  })
}

function replaceTopics(store: MemoryStore.Interface, id: ProjectV2.ID, topics: MemorySchema.Topic[]) {
  return store
    .updateTopics(id, () => ({
      applied: { topics, changed: topics.map((topic) => topic.id), deleted: [] },
      result: undefined,
    }))
    .pipe(Effect.asVoid)
}

describe("Project-owned MEMORY persistence", () => {
  it.live("derives a path-safe home from Project identity", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const home = MemoryHome.make(root)
      const malicious = ProjectV2.ID.make("../../outside/project")
      const directory = home.directory(malicious)

      expect(path.relative(root, directory)).not.toStartWith("..")
      expect(path.dirname(directory)).toBe(path.join(root, "memory", "projects"))
      expect(home.directory(malicious)).toBe(directory)
      expect(home.directory(projectID)).not.toBe(home.directory(otherProjectID))
    }),
  )

  it.live("stores one authoritative Topic set per Project ID", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const home = yield* MemoryHome.Service
        const store = yield* MemoryStore.Service
        const value = topic()
        yield* replaceTopics(store, projectID, [value])

        expect(yield* store.readTopics(projectID)).toEqual([value])
        expect(yield* store.readTopics(otherProjectID)).toEqual([])
        const manifest = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Struct({ generation: Schema.String })),
        )(yield* fs.readFileString(home.manifest(projectID)))
        const yaml = yield* fs.readFileString(path.join(home.generations(projectID), manifest.generation, `${value.id}.yaml`))
        expect(yaml).toContain("schema_version: 1")
        expect(yaml).toContain("metadata:")
        expect(MemoryStore.decodeTopic(value, "wrong-file-id")).toBeUndefined()
        expect(MemoryStore.decodeTopic({ ...value, extra: "not allowed" })).toBeUndefined()
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live("moves the authoritative Topic set when Project identity changes", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const home = yield* MemoryHome.Service
        const migration = yield* MemoryIdentityMigration.Service
        const store = yield* MemoryStore.Service
        const value = topic()
        yield* replaceTopics(store, projectID, [value])

        yield* migration.migrateHome(projectID, otherProjectID)

        expect(yield* store.readTopics(otherProjectID)).toEqual([value])
        expect(yield* fs.exists(home.directory(projectID))).toBe(false)
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            MemoryIdentityMigration.layer.pipe(Layer.provide(EffectFlock.defaultLayer)),
            layers(root),
          ),
        ),
      )
    }),
  )

  it.live("merges non-conflicting Topic sets when the new identity already has Memory", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const home = yield* MemoryHome.Service
        const migration = yield* MemoryIdentityMigration.Service
        const store = yield* MemoryStore.Service
        const source = topic()
        const target = terminologyTopic()
        yield* replaceTopics(store, projectID, [source])
        yield* replaceTopics(store, otherProjectID, [target])

        yield* migration.migrateHome(projectID, otherProjectID)

        expect(yield* store.readTopics(otherProjectID)).toEqual([source, target])
        expect(yield* fs.exists(home.directory(projectID))).toBe(false)
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            MemoryIdentityMigration.layer.pipe(Layer.provide(EffectFlock.defaultLayer)),
            layers(root),
          ),
        ),
      )
    }),
  )

  it.live("fails closed when either Memory Home contains an unreadable Topic", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const home = yield* MemoryHome.Service
        const migration = yield* MemoryIdentityMigration.Service
        const store = yield* MemoryStore.Service
        const target = terminologyTopic()
        const invalid = path.join(home.topics(projectID), "broken.yaml")
        yield* fs.makeDirectory(path.dirname(invalid), { recursive: true })
        yield* fs.writeFileString(invalid, "{ invalid")
        yield* replaceTopics(store, otherProjectID, [target])

        const exit = yield* Effect.exit(migration.migrateHome(projectID, otherProjectID))

        expect(exit._tag).toBe("Failure")
        expect(yield* fs.exists(invalid)).toBe(true)
        expect(yield* store.readTopics(otherProjectID)).toEqual([target])
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            MemoryIdentityMigration.layer.pipe(Layer.provide(EffectFlock.defaultLayer)),
            layers(root),
          ),
        ),
      )
    }),
  )

  it.live("preserves unknown Memory Home resources instead of deleting them during a merge", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const home = yield* MemoryHome.Service
        const migration = yield* MemoryIdentityMigration.Service
        const store = yield* MemoryStore.Service
        const source = topic()
        const target = terminologyTopic()
        const unknown = path.join(home.directory(projectID), "future-resource.json")
        yield* replaceTopics(store, projectID, [source])
        yield* replaceTopics(store, otherProjectID, [target])
        yield* fs.writeFileString(unknown, "{}")

        const exit = yield* Effect.exit(migration.migrateHome(projectID, otherProjectID))

        expect(exit._tag).toBe("Failure")
        expect(yield* fs.exists(unknown)).toBe(true)
        expect(yield* store.readTopics(otherProjectID)).toEqual([target])
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            MemoryIdentityMigration.layer.pipe(Layer.provide(EffectFlock.defaultLayer)),
            layers(root),
          ),
        ),
      )
    }),
  )

  it.live("preserves both Memory Homes when the same Topic ID has different content", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const home = yield* MemoryHome.Service
        const migration = yield* MemoryIdentityMigration.Service
        const store = yield* MemoryStore.Service
        const source = topic("已确认的架构接口边界")
        const target = topic("已确认的模块接口边界")
        yield* replaceTopics(store, projectID, [source])
        yield* replaceTopics(store, otherProjectID, [target])

        const exit = yield* Effect.exit(migration.migrateHome(projectID, otherProjectID))

        expect(exit._tag).toBe("Failure")
        expect(yield* store.readTopics(projectID)).toEqual([source])
        expect(yield* store.readTopics(otherProjectID)).toEqual([target])
        expect(yield* fs.exists(home.directory(projectID))).toBe(true)
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            MemoryIdentityMigration.layer.pipe(Layer.provide(EffectFlock.defaultLayer)),
            layers(root),
          ),
        ),
      )
    }),
  )

  it.live("imports, deduplicates, and preserves conflicting legacy Topics", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const primary = yield* tmpdirScoped({ git: true })
      const sandbox = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const home = yield* MemoryHome.Service
        const admission = yield* MemoryAdmission.Service
        const store = yield* MemoryStore.Service
        yield* insertLiveRow(projectID)
        const file = path.join(MemoryPaths.legacyTopics(sandbox), "project-architecture.yaml")
        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        yield* fs.writeFileString(file, Bun.YAML.stringify(topic()))

        const imported = yield* admission.ensure({
          projectID,
          projectDirectory: primary,
          directories: [primary, sandbox],
          updated: 1,
        })
        expect(imported.diagnostics.map((item) => item.code)).toEqual(["topic.imported"])
        expect(yield* fs.exists(file)).toBe(false)
        expect(yield* store.readTopics(projectID)).toEqual([topic()])
        expect(yield* fs.exists(home.manifest(projectID))).toBe(true)

        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        yield* fs.writeFileString(file, Bun.YAML.stringify(topic()))
        const duplicate = yield* admission.ensure({
          projectID,
          projectDirectory: primary,
          directories: [sandbox],
          updated: 2,
        })
        expect(duplicate.diagnostics.map((item) => item.code)).toEqual(["topic.duplicate"])
        expect(yield* fs.exists(file)).toBe(false)

        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        yield* fs.writeFileString(file, Bun.YAML.stringify(topic("不同的已确认架构边界")))
        const conflict = yield* admission.ensure({
          projectID,
          projectDirectory: primary,
          directories: [sandbox],
          updated: 3,
        })
        expect(conflict.diagnostics.map((item) => item.code)).toEqual(["topic.conflict"])
        expect(conflict.unresolved).toBe(1)
        expect(yield* fs.exists(file)).toBe(true)
        expect(yield* store.readTopics(projectID)).toEqual([topic()])
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live("serializes concurrent migration attempts by Project ID", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const primary = yield* tmpdirScoped({ git: true })
      const first = yield* tmpdirScoped()
      const second = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const admission = yield* MemoryAdmission.Service
        const store = yield* MemoryStore.Service
        yield* insertLiveRow(projectID)
        const firstFile = path.join(MemoryPaths.legacyTopics(first), "project-architecture.yaml")
        const secondFile = path.join(MemoryPaths.legacyTopics(second), "project-architecture.yaml")
        yield* fs.makeDirectory(path.dirname(firstFile), { recursive: true })
        yield* fs.makeDirectory(path.dirname(secondFile), { recursive: true })
        yield* fs.writeFileString(firstFile, Bun.YAML.stringify(topic("first")))
        yield* fs.writeFileString(secondFile, Bun.YAML.stringify(topic("second")))

        const results = yield* Effect.all(
          [
            admission.ensure({ projectID, projectDirectory: primary, directories: [first], updated: 1 }),
            admission.ensure({ projectID, projectDirectory: primary, directories: [second], updated: 1 }),
          ],
          { concurrency: "unbounded" },
        )

        expect(results.flatMap((result) => result.diagnostics.map((item) => item.code)).sort()).toEqual([
          "topic.conflict",
          "topic.imported",
        ])
        expect(yield* store.readTopics(projectID)).toHaveLength(1)
        expect([yield* fs.exists(firstFile), yield* fs.exists(secondFile)].filter(Boolean)).toHaveLength(1)
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live("preserves concurrent updates from separate processes", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const coordination = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        const value = topic()
        yield* replaceTopics(store, projectID, [value])
        const go = path.join(coordination, "go")
        const workers = [
          { itemID: "decision-a", content: "已确认决定：保留并发更新甲" },
          { itemID: "decision-b", content: "已确认决定：保留并发更新乙" },
        ].map((worker) => {
          const ready = path.join(coordination, `${worker.itemID}.ready`)
          const child = Bun.spawn([
            process.execPath,
            path.join(import.meta.dir, "../fixture/memory-store-worker.ts"),
            JSON.stringify({ root, projectID, ready, go, ...worker }),
          ])
          return { child, ready }
        })
        while (
          !(yield* Effect.promise(() =>
            Promise.all(workers.map((worker) => Bun.file(worker.ready).exists())).then((ready) => ready.every(Boolean)),
          ))
        )
          yield* Effect.sleep("5 millis")
        yield* Effect.promise(() => Bun.write(go, "go"))

        expect(yield* Effect.promise(() => Promise.all(workers.map((worker) => worker.child.exited)))).toEqual([0, 0])
        expect((yield* store.readTopics(projectID))[0]?.items.map((item) => item.id).sort()).toEqual([
          "decision-01",
          "decision-a",
          "decision-b",
        ])
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live("recovers the complete committed generation after Store restart", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const value = topic()
      const committed = yield* Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        const initial = yield* store.readSnapshot(projectID)
        expect(initial).toEqual({ revision: 0, topics: [] })
        return yield* store.updateTopics(projectID, () => ({
          applied: { topics: [value], changed: [value.id], deleted: [] },
          result: undefined,
        }))
      }).pipe(Effect.provide(layers(root)))

      const recovered = yield* Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        return yield* store.readSnapshot(projectID)
      }).pipe(Effect.provide(layers(root)))

      expect(committed.revision).toBe(1)
      expect(recovered).toEqual({ revision: 1, topics: [value] })
    }),
  )

  it.live("rejects an invalid generation before publishing its manifest", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        const value = topic()
        yield* replaceTopics(store, projectID, [value])
        const invalid = { ...value, summary: "目标状态不允许进入 Project Memory" }

        const exit = yield* Effect.exit(
          store.updateTopics(projectID, () => ({
            applied: { topics: [invalid], changed: [invalid.id], deleted: [] },
            result: undefined,
          })),
        )

        expect(exit._tag).toBe("Failure")
        expect(yield* store.readSnapshot(projectID)).toEqual({ revision: 1, topics: [value] })
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live("rejects a stale expected revision without replacing the committed generation", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        const first = topic()
        const stale = terminologyTopic()

        const committed = yield* store.commit(projectID, 0, {
          topics: [first],
          changed: [first.id],
          deleted: [],
        })
        const exit = yield* Effect.exit(
          store.commit(projectID, 0, {
            topics: [stale],
            changed: [stale.id],
            deleted: [],
          }),
        )

        expect(committed).toEqual({ revision: 1, topics: [first] })
        expect(exit._tag).toBe("Failure")
        expect(yield* store.readSnapshot(projectID)).toEqual(committed)
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live("keeps invalid Topics and conflicting sandbox config for repair", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const primary = yield* tmpdirScoped({ git: true })
      const sandbox = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const configStore = yield* MemoryConfig.Service
        const admission = yield* MemoryAdmission.Service
        yield* insertLiveRow(projectID)
        const invalid = path.join(MemoryPaths.legacyTopics(sandbox), "broken.yaml")
        const sandboxConfig = path.join(sandbox, ".opencode", "memory.jsonc")
        yield* fs.makeDirectory(path.dirname(invalid), { recursive: true })
        yield* configStore.writeProject(primary, config)
        yield* fs.writeFileString(invalid, "{ invalid")
        yield* fs.writeFileString(sandboxConfig, JSON.stringify({ ...config, enabled: false }))

        const result = yield* admission.ensure({
          projectID,
          projectDirectory: primary,
          directories: [primary, sandbox],
          updated: 1,
        })
        expect(result.diagnostics.map((item) => item.code)).toEqual(["topic.invalid", "config.conflict"])
        expect(result.unresolved).toBe(2)
        expect(yield* fs.exists(invalid)).toBe(true)
        expect(yield* fs.exists(sandboxConfig)).toBe(true)

        yield* fs.writeFileString(sandboxConfig, JSON.stringify(config))
        const duplicate = yield* admission.ensure({
          projectID,
          projectDirectory: primary,
          directories: [sandbox],
          updated: 2,
        })
        expect(duplicate.diagnostics.map((item) => item.code)).toEqual(["topic.invalid", "config.duplicate"])
        expect(yield* fs.exists(sandboxConfig)).toBe(false)
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live("promotes a sandbox config even when it matches the global fallback", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const primary = yield* tmpdirScoped({ git: true })
      const sandbox = yield* tmpdirScoped()
      const global = yield* tmpdirScoped()
      const previous = process.env.GRAPHAGENT_CONFIG_DIR

      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          process.env.GRAPHAGENT_CONFIG_DIR = global
        }),
        () =>
          Effect.gen(function* () {
            const fs = yield* FSUtil.Service
            const admission = yield* MemoryAdmission.Service
            yield* insertLiveRow(projectID)
            const sandboxConfig = path.join(sandbox, ".opencode", "memory.jsonc")
            yield* fs.writeFileString(path.join(global, "memory.jsonc"), JSON.stringify(config))
            yield* fs.makeDirectory(path.dirname(sandboxConfig), { recursive: true })
            yield* fs.writeFileString(sandboxConfig, JSON.stringify(config))

            const result = yield* admission.ensure({
              projectID,
              projectDirectory: primary,
              directories: [sandbox],
              updated: 1,
            })

            expect(result.diagnostics.map((item) => item.code)).toEqual(["config.promoted"])
            expect(yield* fs.exists(sandboxConfig)).toBe(false)
            expect((yield* (yield* MemoryConfig.Service).load(primary))?.level).toBe("project")
          }).pipe(Effect.provide(layers(root))),
        () =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.GRAPHAGENT_CONFIG_DIR
            else process.env.GRAPHAGENT_CONFIG_DIR = previous
          }),
      )
    }),
  )

  it.live("compares normalized project and sandbox configs", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const primary = yield* tmpdirScoped({ git: true })
      const sandbox = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const configStore = yield* MemoryConfig.Service
        const admission = yield* MemoryAdmission.Service
        yield* insertLiveRow(projectID)
        const value = { ...config, topic_limit: 50, topic_limit_floor: 10 }
        const sandboxConfig = path.join(sandbox, ".opencode", "memory.jsonc")
        yield* configStore.writeProject(primary, value)
        yield* fs.makeDirectory(path.dirname(sandboxConfig), { recursive: true })
        yield* fs.writeFileString(sandboxConfig, JSON.stringify(value))

        const result = yield* admission.ensure({
          projectID,
          projectDirectory: primary,
          directories: [sandbox],
          updated: 1,
        })

        expect(result.diagnostics.map((item) => item.code)).toEqual(["config.duplicate"])
        expect(yield* fs.exists(sandboxConfig)).toBe(false)
      }).pipe(Effect.provide(layers(root)))
    }),
  )

  it.live(
    "fails closed on a corrupt manifest and never deletes the unread Home (MEM-PR01-R1-02)",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const home = yield* MemoryHome.Service
          const migration = yield* MemoryIdentityMigration.Service
          const store = yield* MemoryStore.Service
          // Both identities hold Memory so the migration takes the merge path
          // (the rename fast path never deletes anything).
          yield* replaceTopics(store, projectID, [topic()])
          yield* replaceTopics(store, otherProjectID, [topic("新身份的主题")])

          // (a) invalid manifest JSON
          yield* fs.writeFileString(home.manifest(projectID), "{ not json")
          expect(Exit.isFailure(yield* Effect.exit(store.readSnapshot(projectID)))).toBe(true)
          const invalid = yield* Effect.exit(migration.migrateHome(projectID, otherProjectID))
          expect(Exit.isFailure(invalid)).toBe(true)
          expect(yield* fs.exists(home.directory(projectID))).toBe(true)

          // (b) manifest referencing a generation that does not exist
          yield* fs.writeFileString(
            home.manifest(projectID),
            JSON.stringify({ schema_version: 1, revision: 1, generation: "1-deadbeef" }) + "\n",
          )
          expect(Exit.isFailure(yield* Effect.exit(store.readSnapshot(projectID)))).toBe(true)
          const missing = yield* Effect.exit(migration.migrateHome(projectID, otherProjectID))
          expect(Exit.isFailure(missing)).toBe(true)
          expect(yield* fs.exists(home.directory(projectID))).toBe(true)
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              MemoryIdentityMigration.layer.pipe(Layer.provide(EffectFlock.defaultLayer)),
              layers(root),
            ),
          ),
        )
      }),
  )

  it.live(
    "rejects Topics whose item_count disagrees with their items (MEM-PR01-R1-20)",
    () =>
      Effect.gen(function* () {
        const base = topic()
        const drifted = { ...base, metadata: { ...base.metadata, item_count: base.items.length + 1 } }
        expect(MemoryStore.decodeTopic(drifted, drifted.id)).toBeUndefined()

        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const store = yield* MemoryStore.Service
          const exit = yield* Effect.exit(replaceTopics(store, projectID, [drifted]))
          expect(Exit.isFailure(exit)).toBe(true)
          expect(yield* store.readTopics(projectID)).toEqual([])
        }).pipe(Effect.provide(layers(root)))
      }),
  )

  it.live(
    "serializes project config writes on a per-file lock (MEM-PR01-R2-02)",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const primary = yield* tmpdirScoped({ git: true })
        yield* Effect.gen(function* () {
          const flock = yield* EffectFlock.Service
          const fs = yield* FSUtil.Service
          const configStore = yield* MemoryConfig.Service
          const target = MemoryConfig.projectPath(primary)

          // Hold the file's write lock; a concurrent writeProject must queue
          // behind it and may only complete after the release.
          const done = yield* Ref.make(false)
          const writerCell = yield* Ref.make<Fiber.Fiber<void, unknown> | undefined>(undefined)
          // Hold the file's write lock; a writer forked while the lock is held
          // must stay blocked until the lock is released at the end of withLock.
          yield* flock.withLock(
            Effect.gen(function* () {
              const writer = yield* Effect.gen(function* () {
                yield* configStore.writeProject(primary, config)
                yield* Ref.set(done, true)
              }).pipe(Effect.forkDetach)
              yield* Ref.set(writerCell, writer)
              yield* Effect.sleep("300 millis")
              expect(yield* Ref.get(done)).toBe(false)
            }),
            MemoryConfig.writeLockKey(target),
          )
          const writer = (yield* Ref.get(writerCell))!
          yield* Fiber.join(writer)
          expect(yield* Ref.get(done)).toBe(true)
          expect(yield* fs.existsSafe(target)).toBe(true)
        }).pipe(Effect.provide(Layer.mergeAll(layers(root), EffectFlock.defaultLayer)))
      }),
    { timeout: 20_000 },
  )

  it.live(
    "a second process committing a stale revision observes the explicit conflict (MEM-PR01-R2-03)",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const coordination = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const store = yield* MemoryStore.Service
          const value = topic()
          yield* replaceTopics(store, projectID, [value])

          const go = path.join(coordination, "go")
          const ready = path.join(coordination, "stale.ready")
          const child = Bun.spawn([
            process.execPath,
            path.join(import.meta.dir, "../fixture/memory-commit-worker.ts"),
            JSON.stringify({
              root,
              projectID,
              ready,
              go,
              expectedRevision: 0,
              summary: "跨进程的陈旧修订",
            }),
          ])
          while (!(yield* Effect.promise(() => Bun.file(ready).exists()))) yield* Effect.sleep("5 millis")
          yield* Effect.promise(() => Bun.write(go, "go"))

          // Exit 0 means the worker observed CommitConflictError — the explicit
          // cross-process conflict guarantee of the commit protocol.
          expect(yield* Effect.promise(() => child.exited)).toBe(0)
          expect(yield* store.readSnapshot(projectID)).toEqual({ revision: 1, topics: [value] })
        }).pipe(Effect.provide(layers(root)))
      }),
  )

  it.live(
    "retains only the newest generations after repeated commits and sweeps orphan staging",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const home = yield* MemoryHome.Service
          const store = yield* MemoryStore.Service

          // Crash leftover: a staging directory that never reached its rename.
          const orphan = path.join(home.generations(projectID), ".0-crashed.tmp")
          yield* fs.makeDirectory(orphan, { recursive: true })
          yield* fs.writeFileString(path.join(orphan, "project-architecture.yaml"), "id: orphan\n")

          for (let i = 1; i <= 5; i++) {
            yield* replaceTopics(store, projectID, [topic(`第${i}版已确认架构边界`)])
          }

          const entries = yield* fs.readDirectoryEntries(home.generations(projectID))
          const generations = entries
            .filter((entry) => !entry.name.startsWith("."))
            .map((entry) => entry.name)
            .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
          expect(generations).toHaveLength(3)
          expect(generations.map((name) => Number.parseInt(name, 10))).toEqual([3, 4, 5])
          expect(entries.some((entry) => entry.name.endsWith(".tmp"))).toBe(false)
          // The manifest still points at a retained generation.
          expect(yield* store.readSnapshot(projectID)).toEqual({
            revision: 5,
            topics: [topic("第5版已确认架构边界")],
          })
        }).pipe(Effect.provide(layers(root)))
      }),
  )

  // Windows chmod is a no-op on directories, and root bypasses the permission
  // check, so the undeletable-generation injection cannot be staged there.
  const itPosix = process.platform === "win32" || process.getuid?.() === 0 ? it.live.skip : it.live
  itPosix(
    "keeps committing when generation GC cannot delete a stale generation",
    () =>
      Effect.gen(function* () {
        // A chmod-based undeletable entry only blocks removal for non-root
        // users; root bypasses permission checks, so the scenario cannot be
        // staged there.
        if (process.getuid?.() === 0) return
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const home = yield* MemoryHome.Service
          const store = yield* MemoryStore.Service

          for (let i = 1; i <= 3; i++) {
            yield* replaceTopics(store, projectID, [topic(`第${i}版已确认架构边界`)])
          }
          const entries = yield* fs.readDirectoryEntries(home.generations(projectID))
          const oldest = entries
            .filter((entry) => !entry.name.startsWith("."))
            .map((entry) => entry.name)
            .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))[0]
          const oldestPath = path.join(home.generations(projectID), oldest)

          // A read-only directory with a file inside cannot be removed; GC
          // fails while the commit that already landed must not.
          yield* Effect.acquireUseRelease(
            Effect.promise(() => chmod(oldestPath, 0o555)),
            () =>
              Effect.gen(function* () {
                const exit = yield* Effect.exit(replaceTopics(store, projectID, [topic("第四版已确认架构边界")]))
                expect(Exit.isSuccess(exit)).toBe(true)
                expect(yield* store.readSnapshot(projectID)).toEqual({
                  revision: 4,
                  topics: [topic("第四版已确认架构边界")],
                })
                // The undeletable generation is still on disk — the failure
                // is contained in GC, not the commit.
                expect(yield* fs.exists(oldestPath)).toBe(true)
              }),
            () => Effect.promise(() => chmod(oldestPath, 0o755)).pipe(Effect.ignore),
          )
        }).pipe(Effect.provide(layers(root)))
      }),
  )

  it.live(
    "an orphaned staging generation never shadows the committed generation (MEM-PR01-R1-21)",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const home = yield* MemoryHome.Service
          const store = yield* MemoryStore.Service
          const value = topic()
          yield* replaceTopics(store, projectID, [value])

          // Simulate a crash mid-writeSnapshot: a staging generation exists but
          // its manifest was never published.
          const staging = path.join(home.generations(projectID), ".2-orphaned.tmp")
          yield* fs.makeDirectory(staging, { recursive: true })
          yield* fs.writeFileString(path.join(staging, "orphan.yaml"), "id: orphan\n")

          expect(yield* store.readTopics(projectID)).toEqual([value])
          // The store still commits cleanly afterwards.
          const next = topic("第二版边界")
          yield* replaceTopics(store, projectID, [next])
          expect(yield* store.readTopics(projectID)).toEqual([next])
        }).pipe(Effect.provide(layers(root)))
      }),
  )

  it.live(
    "a store persisted under the earlier content rules stays readable and committable after the credential rules",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const store = yield* MemoryStore.Service
          // Legitimate prose that the earlier rules admitted but the extended
          // admission-time credential rules would now refuse.
          const legacy = {
            ...topic("已确认的报销凭证归档规则"),
            id: "project-voucher",
            items: [
              {
                id: "decision-voucher",
                kind: "decision",
                content: "已确认决定：报销凭证统一按月归档",
                rationale: "该做法由用户确认并长期适用",
                confirmed_at: now,
              },
            ],
          } satisfies MemorySchema.Topic
          expect(MemoryStore.isAllowedMemoryItem(legacy.items[0])).toBe(false)
          yield* replaceTopics(store, projectID, [legacy])
          expect(yield* store.readSnapshot(projectID)).toEqual({ revision: 1, topics: [legacy] })

          const add = (content: string) =>
            store.updateTopics(projectID, (topics) => {
              const applied = MemoryStore.applyActions({
                topics,
                topicLimit: 10,
                now,
                id: () => "01new",
                actions: [
                  {
                    type: "create_topic",
                    name: "回答偏好",
                    summary: "用户确认的回答偏好",
                    categories: ["preference"],
                    keywords: ["回答"],
                    related_topics: [],
                    item: { kind: "preference", content, rationale: "用户明确确认该要求长期有效" },
                  },
                ],
              })
              return { applied, result: undefined }
            })

          // An unrelated new item commits alongside the persisted topic.
          const committed = yield* add("用户要求回答使用简洁中文")
          expect(committed.revision).toBe(2)
          const snapshot = yield* store.readSnapshot(projectID)
          expect(snapshot.revision).toBe(2)
          expect(snapshot.topics.map((value) => value.id)).toEqual(["project-voucher", "topic-01new"])

          // A new credential-bearing item is still refused at admission.
          const refused = yield* Effect.exit(add("用户要求服务器登录密码保持为 Tr0ub4dor"))
          expect(Exit.isFailure(refused)).toBe(true)
          expect((yield* store.readSnapshot(projectID)).revision).toBe(2)
        }).pipe(Effect.provide(layers(root)))
      }),
    { timeout: 30_000 },
  )

  it.live(
    "a failed manifest publish leaves no orphan generation behind and the store stays committable",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const fs = yield* FSUtil.Service
        const home = MemoryHome.make(root)
        let failManifest = false
        const failingFS = Layer.succeed(FSUtil.Service, {
          ...fs,
          rename: (from, to) =>
            failManifest && to === home.manifest(projectID)
              ? Effect.die(new Error("simulated manifest publish failure"))
              : fs.rename(from, to),
        })
        const storeLayer = MemoryStore.layer.pipe(
          Layer.provide(failingFS),
          Layer.provide(EffectFlock.defaultLayer),
          Layer.provide(Layer.succeed(MemoryHome.Service, home)),
        )
        yield* Effect.gen(function* () {
          const store = yield* MemoryStore.Service
          yield* replaceTopics(store, projectID, [topic()])
          failManifest = true
          for (let i = 0; i < 3; i++) {
            const failed = yield* Effect.exit(replaceTopics(store, projectID, [topic(`第${i}次失败的发布`)]))
            expect(Exit.isFailure(failed)).toBe(true)
          }
          const names = (yield* fs.readDirectoryEntries(home.generations(projectID))).map((entry) => entry.name)
          // Only the live revision-1 generation: no renamed revision-2 orphans, no staging.
          expect(names).toHaveLength(1)
          expect(names[0]?.startsWith("1-")).toBe(true)
          failManifest = false
          const next = topic("第二版边界")
          yield* replaceTopics(store, projectID, [next])
          expect(yield* store.readSnapshot(projectID)).toEqual({ revision: 2, topics: [next] })
        }).pipe(Effect.provide(storeLayer))
      }),
    { timeout: 30_000 },
  )

  it.live(
    "generation GC never deletes the live generation when orphans reuse its revision",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const home = yield* MemoryHome.Service
          const store = yield* MemoryStore.Service
          yield* replaceTopics(store, projectID, [topic()]) // revision 1

          // Orphans at revision 2: the shape a crash between rename and manifest
          // publish leaves behind (older runtimes also left them on failure).
          // Their names sort above any random uuid, so before the fix they
          // outranked and evicted the live revision-2 generation.
          const live = (yield* fs.readDirectoryEntries(home.generations(projectID))).find((entry) =>
            entry.name.startsWith("1-"),
          )!.name
          for (const suffix of ["fffd", "fffe", "ffff"]) {
            const orphan = path.join(home.generations(projectID), `2-ffffffff-ffff-4fff-bfff-ffffffff${suffix}`)
            yield* fs.makeDirectory(orphan, { recursive: true })
            yield* fs.copyFile(
              path.join(home.generations(projectID), live, "project-architecture.yaml"),
              path.join(orphan, "project-architecture.yaml"),
            )
          }

          const next = topic("第二版边界")
          yield* replaceTopics(store, projectID, [next]) // revision 2
          expect(yield* store.readSnapshot(projectID)).toEqual({ revision: 2, topics: [next] })
          const names = (yield* fs.readDirectoryEntries(home.generations(projectID))).map((entry) => entry.name)
          // The orphans are swept; the live generation and its predecessor remain.
          expect(names.some((name) => name.startsWith("2-ffffffff"))).toBe(false)
          expect(names.map((name) => Number.parseInt(name, 10)).sort((a, b) => a - b)).toEqual([1, 2])
        }).pipe(Effect.provide(layers(root)))
      }),
    { timeout: 30_000 },
  )

  it.live(
    "write paths fail closed on a corrupt manifest (pins the strict re-read before write)",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const home = yield* MemoryHome.Service
          const store = yield* MemoryStore.Service
          yield* replaceTopics(store, projectID, [topic()])

          yield* fs.writeFileString(home.manifest(projectID), "{ not json")

          const exit = yield* Effect.exit(replaceTopics(store, projectID, [topic("修订后的边界")]))
          expect(Exit.isFailure(exit)).toBe(true)
          // The corrupt manifest is left untouched (no silent re-init).
          expect(yield* fs.readFileString(home.manifest(projectID))).toBe("{ not json")
        }).pipe(Effect.provide(layers(root)))
      }),
  )

  it.live(
    "never caches unresolved admission results (pins the ADR-0003 cache rule)",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const primary = yield* tmpdirScoped({ git: true })
        const sandbox = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const admission = yield* MemoryAdmission.Service
          yield* insertLiveRow(projectID)
          const file = path.join(sandbox, ".opencode", "memory", "topics", "broken.yaml")
          yield* fs.makeDirectory(path.dirname(file), { recursive: true })
          yield* fs.writeFileString(file, "id: broken\n")

          const snapshot = { projectID, projectDirectory: primary, directories: [primary, sandbox], updated: 1 }
          const first = yield* admission.ensure(snapshot)
          expect(first.unresolved).toBeGreaterThan(0)

          // Repair the legacy file. A cached unresolved result would keep
          // blocking; the cache rule requires a fresh scan.
          yield* fs.remove(file)
          const second = yield* admission.ensure(snapshot)
          expect(second.unresolved).toBe(0)
        }).pipe(Effect.provide(layers(root)))
      }),
  )

  it.live(
    "fails closed with SourceChanged when the source changes mid-merge (pins the verify-before-delete guard)",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const home = yield* MemoryHome.Service
          const flock = yield* EffectFlock.Service
          const migration = yield* MemoryIdentityMigration.Service
          const store = yield* MemoryStore.Service

          // Both Homes populated → merge path (not the rename fast path).
          yield* replaceTopics(store, projectID, [topic()])
          yield* replaceTopics(store, otherProjectID, [terminologyTopic()])

          // Hold the target's store lock in this flow; migrateHome blocks there
          // in phase 2 AFTER snapshotting the source — a deterministic window in
          // which the source may still change. Fork migrateHome detached so it
          // survives the withLock scope closing, then bump the source while the
          // target lock is still held; releasing the lock (withLock end) lets
          // the migration proceed into the verify-before-delete check.
          const migratingCell = yield* Ref.make<Fiber.Fiber<void, unknown> | undefined>(undefined)
          yield* flock.withLock(
            Effect.gen(function* () {
              const migrating = yield* migration.migrateHome(projectID, otherProjectID).pipe(Effect.forkDetach)
              yield* Ref.set(migratingCell, migrating)
              yield* Effect.sleep("500 millis")
              // A concurrent writer bumps the source revision mid-merge.
              yield* replaceTopics(store, projectID, [topic("迁移进行中被修订的边界")])
            }),
            `memory-project:${otherProjectID}`,
            home.locks,
          )
          const migrating = (yield* Ref.get(migratingCell))!
          const exit = yield* Fiber.join(migrating).pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("SourceChanged")
          // The source Home survives (verify-before-delete refused to remove it).
          expect(yield* fs.exists(home.directory(projectID))).toBe(true)
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.provideMerge(
                MemoryIdentityMigration.layer.pipe(Layer.provide(EffectFlock.defaultLayer)),
                layers(root),
              ),
              EffectFlock.defaultLayer,
            ),
          ),
        )
      }),
    { timeout: 20_000 },
  )
})
