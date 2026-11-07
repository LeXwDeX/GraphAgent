import { afterAll, beforeAll, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { eq } from "drizzle-orm"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer } from "effect"
import { stringify } from "yaml"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { MemoryAdmission } from "@/memory/admission"
import { MemoryConfig } from "@/memory/config"
import { MemoryHome } from "@/memory/home"
import { MemoryIdentityFence } from "@/memory/identity-fence"
import { MemoryLock } from "@/memory/lock"
import { Memory } from "@/memory/memory"
import { MemoryModel } from "@/memory/model"
import { MemorySchema } from "@/memory/schema"
import { MemoryStore } from "@/memory/store"
import { Project } from "@/project/project"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ProviderTest } from "../fake/provider"
import { InstanceRef } from "@/effect/instance-ref"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// bun test runs all files in one process, sequentially, sharing one
// XDG_CONFIG_HOME — so a test file that runs before this one and triggers
// global-memory initialization leaves a VALID memory.jsonc whose model this
// file's fake provider does not know; writeGlobal then preserves it with a
// warning and search fails closed with "unavailable" (dev CI, deterministic).
// Pin a private config dir per file so the global file can never be
// contaminated by earlier files.
const pinnedConfigDir = path.join(os.tmpdir(), `opencode-memory-global-identity-${process.pid}`)
const previousConfigDir = process.env.GRAPHAGENT_CONFIG_DIR
beforeAll(() => {
  fs.mkdirSync(pinnedConfigDir, { recursive: true })
  process.env.GRAPHAGENT_CONFIG_DIR = pinnedConfigDir
})
afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.GRAPHAGENT_CONFIG_DIR
  else process.env.GRAPHAGENT_CONFIG_DIR = previousConfigDir
})

const now = "2026-08-12T12:00:00Z"
const providerID = ProviderV2.ID.make("test")
const enabledModel = ProviderTest.model({ providerID, id: ModelV2.ID.make("memory-on") })

const baseConfig = {
  schema_version: 1,
  enabled: true,
  model: "test/memory-on",
  topic_limit: 10,
  turn_interval: 5,
  injection: { max_topics: 3, max_tokens: 1_200 },
} satisfies MemorySchema.Config

function topic() {
  return {
    schema_version: 1,
    id: "project-architecture",
    name: "架构边界",
    summary: "已确认的核心架构边界",
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

function userMessage(sessionID: SessionID): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "user",
      sessionID,
      time: { created: 1 },
      agent: "build",
      model: { providerID, modelID: ModelV2.ID.make("memory-on") },
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID,
        type: "text",
        text: "架构边界是什么？",
      },
    ],
  }
}

const emptyConfigLayer = Layer.mock(Config.Service, {
  get: () => Effect.succeed({}),
})

const base = Layer.mergeAll(
  emptyConfigLayer,
  ProviderTest.fake({ model: enabledModel }).layer,
  Project.defaultLayer,
  Database.defaultLayer,
  Git.defaultLayer,
  EffectFlock.defaultLayer,
  MemoryAdmission.defaultLayer,
  MemoryConfig.defaultLayer,
  MemoryHome.defaultLayer,
  MemoryIdentityFence.defaultLayer,
  MemoryLock.defaultLayer,
  MemoryStore.defaultLayer,
  Layer.mock(MemoryModel.Service, {
    generate: () => Effect.die(new Error("model calls are not expected in global-identity tests")),
  }),
)

// provideMerge builds `base` once, provides it to Memory.layer AND re-exposes its
// services (Project/MemoryConfig/MemoryStore/...) to the test body. CrossSpawnSpawner
// is merged at the top level so the body itself can spawn git for the fixtures.
const layer = Layer.mergeAll(Memory.layer.pipe(Layer.provideMerge(base)), CrossSpawnSpawner.defaultLayer)

const it = testEffect(layer)

// A git repository WITHOUT any commit: identity resolution finds no remote, no
// cached id and no root commit, so it falls back to the shared ProjectV2.ID.global.
function gitInitWithoutCommit(dir: string) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const git = (...args: string[]) =>
      spawner.spawn(ChildProcess.make("git", args, { cwd: dir })).pipe(Effect.flatMap((handle) => handle.exitCode))
    yield* git("init")
    yield* git("config", "core.fsmonitor", "false")
    yield* git("config", "commit.gpgsign", "false")
    yield* git("config", "user.email", "test@opencode.test")
    yield* git("config", "user.name", "Test")
  })
}

describe("MEM-PR01-R1-03: memory is inert once the identity row is retired", () => {
  it.live(
    "a stale process whose project row was deleted by a concurrent upgrade does not fork a retired Home",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        // Resolve the identity ONCE and hand it to the instance store: the
        // boot-time resolution runs in a separate Effect graph (own Database)
        // and can transiently degrade to the global identity on loaded CI
        // runners (git failures are silently swallowed), which would make the
        // stamped context and this body disagree — failing the search closed.
        const project = yield* Project.Service
        const { project: info } = yield* project.fromDirectory(dir)
        expect(info.id).not.toBe(ProjectV2.ID.global)
        yield* provideInstance({ directory: dir, worktree: info.worktree, project: info })(
          Effect.gen(function* () {
            const project = yield* Project.Service
            const memory = yield* Memory.Service
            const configStore = yield* MemoryConfig.Service
            const { db } = yield* Database.Service

            yield* project.setInitialized(info.id)
            yield* configStore.writeGlobal(baseConfig)
            // Tripwire: writeGlobal preserves a pre-existing VALID config with
            // a warning, so a contaminated global dir would leave a foreign model
            // here and every search would fail closed.
            expect((yield* configStore.loadGlobal())?.config.model).toBe("test/memory-on")

            const sessionID = SessionID.make("ses_retired_identity")
            const active = yield* memory.search({ sessionID, messages: [userMessage(sessionID)], query: "任意查询" })
            expect(active.status).not.toBe("unavailable")

            // A long-running process holds a context stamped while the row
            // existed. Read the stamped row, then let another process complete
            // an identity upgrade: the old row is deleted.
            const stamped = yield* project.get(info.id)
            expect(stamped?.time.initialized).toBeDefined()
            yield* db.delete(ProjectTable).where(eq(ProjectTable.id, info.id)).run().pipe(Effect.orDie)

            yield* Effect.provideService(InstanceRef, { directory: dir, worktree: info.worktree, project: stamped! })(
              Effect.gen(function* () {
                const retired = yield* memory.search({ sessionID, messages: [userMessage(sessionID)], query: "任意查询" })
                expect(retired.status).toBe("unavailable")
                // #350: a /memory on that cannot activate says WHY instead of
                // the bare "remains off" (retired identity / global identity
                // are actionable reasons).
                expect(yield* memory.setEnabled(true)).toContain("unavailable")
              }),
            )
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
      }),
    { timeout: 30_000 },
  )
})

describe("MEM-PR01-R1-23: the runtime admission snapshot covers every registered sandbox", () => {
  it.live(
    "a legacy topic living only in a registered sandbox is imported on activation",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        const sandbox = yield* tmpdirScoped()
        const project = yield* Project.Service
        const { project: info } = yield* project.fromDirectory(dir)
        yield* provideInstance({ directory: dir, worktree: info.worktree, project: info })(
          Effect.gen(function* () {
            const project = yield* Project.Service
            const memory = yield* Memory.Service
            const configStore = yield* MemoryConfig.Service
            const store = yield* MemoryStore.Service

            yield* project.setInitialized(info.id)
            yield* project.addSandbox(info.id, sandbox)
            yield* configStore.writeGlobal(baseConfig)

            // The only legacy topic lives in the sandbox, not the primary.
            const legacyDir = path.join(sandbox, ".agents", "memory", "topics")
            fs.mkdirSync(legacyDir, { recursive: true })
            const seeded = topic()
            fs.writeFileSync(path.join(legacyDir, `${seeded.id}.yaml`), stringify(seeded))

            // Activation (any product surface) must admit the FULL snapshot —
            // primary plus every registered sandbox.
            const sessionID = SessionID.make("ses_sandbox_snapshot")
            yield* memory.search({ sessionID, messages: [userMessage(sessionID)], query: "架构边界" })

            const snapshot = yield* store.readSnapshot(info.id)
            expect(snapshot.topics.map((value) => value.id)).toContain(seeded.id)
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
      }),
    { timeout: 30_000 },
  )
})

describe("MEM-PR01-R1-07: /memory writes the Project config to the primary directory", () => {
  it.live(
    "enabling memory from a non-primary instance context still writes to the project worktree",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        const elsewhere = yield* tmpdirScoped()
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const project = yield* Project.Service
            const memory = yield* Memory.Service
            const configStore = yield* MemoryConfig.Service

            const { project: info } = yield* project.fromDirectory(dir)
            yield* project.setInitialized(info.id)
            const stamped = (yield* project.get(info.id))!
            // Memory activates from a DISABLED global config (no project config
            // yet): enabling must then CREATE the project config. Write the
            // global file directly because writeGlobal is a no-op over an
            // existing valid config. Clean it up afterwards so later tests see
            // a fresh global state.
            const globalFile = path.join(MemoryConfig.globalConfigDir(), "memory.jsonc")
            fs.mkdirSync(path.dirname(globalFile), { recursive: true })
            fs.writeFileSync(globalFile, JSON.stringify({ ...baseConfig, enabled: false }))
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                fs.rmSync(globalFile, { force: true })
              }),
            )

            // The instance context lives in a different worktree than the
            // project primary (a registered sandbox); the config must still
            // land in the project worktree, not the context's worktree.
            yield* Effect.provideService(InstanceRef, {
              directory: elsewhere,
              worktree: elsewhere,
              project: stamped,
            })(
              Effect.gen(function* () {
                expect(yield* memory.setEnabled(true)).toBe("Memory on")
              }),
            )

            const written = yield* configStore.load(info.worktree)
            expect(written?.config.enabled).toBe(true)
            expect(written?.level).toBe("project")
            expect(fs.existsSync(path.join(elsewhere, ".agents", "memory.jsonc"))).toBe(false)
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
      }),
    { timeout: 30_000 },
  )
})

describe("MEM-PR01-00: memory is inert under the shared global identity", () => {
  it.live(
    "search reports unavailable for a commit-less repository even when global config enables memory and the shared bucket holds topics",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        yield* gitInitWithoutCommit(dir)
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const project = yield* Project.Service
            const memory = yield* Memory.Service
            const configStore = yield* MemoryConfig.Service
            const store = yield* MemoryStore.Service

            const { project: info } = yield* project.fromDirectory(dir)
            expect(info.id).toBe(ProjectV2.ID.global)
            yield* project.setInitialized(info.id)

            // An enabled global config must NOT activate memory for a project that
            // has no identity of its own: every commit-less repository on the
            // machine resolves to the same global bucket, so any read or write
            // would leak across repositories and be orphaned by the first commit.
            yield* configStore.writeGlobal(baseConfig)
            // Simulate another commit-less repository having written into the
            // shared bucket: memory must still refuse to serve it from here.
            const seeded = topic()
            yield* store.updateTopics(info.id, () => ({
              applied: { topics: [seeded], changed: [seeded.id], deleted: [] },
              result: undefined,
            }))

            const sessionID = SessionID.make("ses_global_identity")
            const result = yield* memory.search({
              sessionID,
              messages: [userMessage(sessionID)],
              query: "架构边界",
            })
            expect(result.status).toBe("unavailable")
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
      }),
    { timeout: 30_000 },
  )

  it.live(
    "/memory on stays off for a commit-less repository and writes no project config",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        yield* gitInitWithoutCommit(dir)
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const project = yield* Project.Service
            const memory = yield* Memory.Service
            const configStore = yield* MemoryConfig.Service

            const { project: info } = yield* project.fromDirectory(dir)
            expect(info.id).toBe(ProjectV2.ID.global)
            yield* project.setInitialized(info.id)
            yield* configStore.writeGlobal(baseConfig)

            // #350: says WHY (commit-less repo under the shared global
            // identity) instead of the bare "remains off".
            expect(yield* memory.setEnabled(true)).toContain("unavailable")
            expect(fs.existsSync(path.join(dir, ".agents", "memory.jsonc"))).toBe(false)
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
      }),
    { timeout: 30_000 },
  )

  it.live(
    "inertness is identity-scoped: a repository with a commit activates normally under its real identity",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        const project = yield* Project.Service
        const { project: info } = yield* project.fromDirectory(dir)
        expect(info.id).not.toBe(ProjectV2.ID.global)
        yield* provideInstance({ directory: dir, worktree: info.worktree, project: info })(
          Effect.gen(function* () {
            const project = yield* Project.Service
            const memory = yield* Memory.Service
            const configStore = yield* MemoryConfig.Service

            yield* project.setInitialized(info.id)
            yield* configStore.writeGlobal(baseConfig)

            const sessionID = SessionID.make("ses_real_identity")
            const result = yield* memory.search({
              sessionID,
              messages: [userMessage(sessionID)],
              query: "架构边界",
            })
            // Active (model calls are stubbed to fail, so search cannot succeed —
            // but it must get PAST the activation gate, i.e. not "unavailable").
            expect(result.status).not.toBe("unavailable")
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
      }),
    { timeout: 30_000 },
  )

  // #350: the inert gates must be self-explanatory — /memory on and
  // memory_search surface the actionable reason instead of a bare "off".
  it.live(
    "statusReason names the missing /init stamp, and /memory on carries it",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* provideInstance(dir)(
          Effect.gen(function* () {
            const project = yield* Project.Service
            const memory = yield* Memory.Service

            const { project: info } = yield* project.fromDirectory(dir)
            expect(info.id).not.toBe(ProjectV2.ID.global)
            // NOT setInitialized: a real git identity without the /init stamp
            // is the exact shape that used to fail silently.
            expect(yield* memory.statusReason()).toContain("/init")

            const turningOn = yield* memory.setEnabled(true)
            expect(turningOn).toContain("/init")
            expect(turningOn).not.toBe("Memory remains off")

            yield* project.setInitialized(info.id)
            expect(yield* memory.statusReason()).toBeUndefined()
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer))
      }),
    { timeout: 30_000 },
  )
})
