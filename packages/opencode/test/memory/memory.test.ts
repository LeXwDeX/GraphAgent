import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Deferred, Duration, Effect, Fiber, Layer } from "effect"
import { logLines } from "effect/testing/TestConsole"
import fs from "node:fs/promises"
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
import { MemoryPrompts } from "@/memory/prompts"
import { MemorySchema } from "@/memory/schema"
import { MemoryStore } from "@/memory/store"
import { Project } from "@/project/project"
import { Provider } from "@/provider/provider"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Token } from "@/util/token"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { MCP } from "@/mcp"
import { Skill } from "@/skill"
import { SystemPrompt } from "@/session/system"
import { tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"

const config = {
  schema_version: 1,
  enabled: true,
  model: "test/memory-small",
  topic_limit: 10,
  turn_interval: 5,
  injection: { max_topics: 3, max_tokens: 1_200 },
} satisfies MemorySchema.Config

const now = "2026-08-09T12:00:00Z"
const replacementModel = ProviderTest.model({
  providerID: ProviderV2.ID.make("test"),
  id: ModelV2.ID.make("replacement"),
})
const replacementProvider = ProviderTest.fake({ model: replacementModel })
let writtenGlobalConfig: MemorySchema.Config | undefined
let writtenProjectConfig: MemorySchema.Config | undefined
const emptyConfigLayer = Layer.mock(Config.Service, {
  get: () => Effect.succeed({}),
})
const readyAdmissionLayer = Layer.mock(MemoryAdmission.Service, {
  ensure: () =>
    Effect.succeed(new MemoryAdmission.Result({ diagnostics: [], imported: 0, duplicates: 0, unresolved: 0 })),
  invalidate: () => Effect.void,
})
let loadedProjectDirectory: string | undefined
let migrationUnresolved = 0

function topic(id = "architecture-boundaries") {
  return {
    schema_version: 1,
    id,
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

const it = testEffect(
  Layer.mergeAll(Git.defaultLayer, MemoryConfig.defaultLayer, MemoryStore.defaultLayer, CrossSpawnSpawner.defaultLayer),
)
const memoryIt = testEffect(Memory.defaultLayer)
const unavailableModelIt = testEffect(
  Memory.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        emptyConfigLayer,
        EffectFlock.defaultLayer,
        MemoryHome.defaultLayer,
        MemoryIdentityFence.defaultLayer,
        replacementProvider.layer,
        Layer.mock(Project.Service, {
          get: (id) =>
            Effect.succeed({
              id,
              worktree: "/unused",
              vcs: "git" as const,
              time: { created: 0, updated: 0, initialized: 1 },
              sandboxes: [],
            }),
        }),
        Layer.mock(MemoryConfig.Service, {
          load: (directory) =>
            Effect.sync(() => {
              loadedProjectDirectory = directory
              return {
                config: { ...config, enabled: false, model: "removed/model" },
                path: directory,
                level: "project" as const,
              }
            }),
          loadGlobal: () =>
            Effect.succeed({
              config: { ...config, model: "removed/model" },
              path: "/global/memory.jsonc",
              level: "global" as const,
            }),
          writeGlobal: (next) =>
            Effect.sync(() => {
              writtenGlobalConfig = next
              return true
            }),
          writeProject: (_directory, next) =>
            Effect.sync(() => {
              writtenProjectConfig = next
            }),
        }),
        Layer.mock(MemoryAdmission.Service, {
          ensure: () =>
            Effect.succeed(
              new MemoryAdmission.Result({
                diagnostics: [],
                imported: 0,
                duplicates: 0,
                unresolved: migrationUnresolved,
              }),
            ),
          invalidate: () => Effect.void,
        }),
        MemoryLock.defaultLayer,
        Layer.mock(MemoryModel.Service, {
          generate: () => Effect.succeed({ model: "test/replacement", topic_limit: 10, turn_interval: 5 }),
        }),
        Layer.mock(MemoryStore.Service, {
          updateTopics: (_projectID, update) =>
            Effect.sync(() => {
              const next = update([])
              return { revision: 1, topics: next.applied.topics, result: next.result }
            }),
        }),
      ),
    ),
  ),
)

function bootstrapFixture() {
  const providerID = ProviderV2.ID.make("test")
  const models = {
    small: ProviderTest.model({ providerID, id: ModelV2.ID.make("small") }),
    compaction: ProviderTest.model({ providerID, id: ModelV2.ID.make("compaction") }),
    default: ProviderTest.model({ providerID, id: ModelV2.ID.make("default") }),
    conversation: ProviderTest.model({ providerID, id: ModelV2.ID.make("conversation") }),
  }
  const state: {
    available: Set<string>
    smallModel?: string
    compactionModel?: string
    defaultModel?: string
    project?: MemorySchema.Config
    global?: MemorySchema.Config
    written?: MemorySchema.Config
    modelCalls: number
    defaultModelHook?: Effect.Effect<void>
    loadHook?: Effect.Effect<void>
  } = {
    available: new Set(Object.values(models).map((model) => `${model.providerID}/${model.id}`)),
    smallModel: "test/small",
    compactionModel: "test/compaction",
    defaultModel: "test/default",
    modelCalls: 0,
  }
  const layer = Memory.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        EffectFlock.defaultLayer,
        MemoryHome.defaultLayer,
        MemoryIdentityFence.defaultLayer,
        Layer.mock(Config.Service, {
          get: () =>
            Effect.succeed({
              small_model: state.smallModel,
              agent: state.compactionModel ? { compaction: { model: state.compactionModel } } : undefined,
            }),
        }),
        Layer.mock(Provider.Service, {
          list: () =>
            Effect.succeed({
              [providerID]: ProviderTest.info({
                id: providerID,
                models: Object.fromEntries(
                  Object.values(models)
                    .filter((model) => state.available.has(`${model.providerID}/${model.id}`))
                    .map((model) => [model.id, model]),
                ),
              }),
            }),
          getModel: (candidateProviderID, candidateModelID) => {
            const model = Object.values(models).find(
              (item) => item.providerID === candidateProviderID && item.id === candidateModelID,
            )
            if (model && state.available.has(`${model.providerID}/${model.id}`)) return Effect.succeed(model)
            return Effect.die(new Error(`Unknown test model: ${candidateProviderID}/${candidateModelID}`))
          },
          defaultModel: () =>
            Effect.gen(function* () {
              if (state.defaultModelHook) yield* state.defaultModelHook
              if (state.defaultModel) return Provider.parseModel(state.defaultModel)
              return yield* new Provider.NoProvidersError()
            }),
        }),
        Layer.mock(Project.Service, {
          get: (id) =>
            Effect.succeed({
              id,
              worktree: "/unused",
              vcs: "git" as const,
              time: { created: 0, updated: 0, initialized: 1 },
              sandboxes: [],
            }),
        }),
        Layer.mock(MemoryConfig.Service, {
          load: () =>
            Effect.gen(function* () {
              if (state.loadHook) yield* state.loadHook
              if (state.project)
                return { config: state.project, path: "/project/.opencode/memory.jsonc", level: "project" as const }
              return state.global
                ? { config: state.global, path: "/global/memory.jsonc", level: "global" as const }
                : undefined
            }),
          loadGlobal: () =>
            Effect.succeed(
              state.global
                ? { config: state.global, path: "/global/memory.jsonc", level: "global" as const }
                : undefined,
            ),
          writeGlobal: (next) =>
            Effect.sync(() => {
              state.written = next
              state.global = next
              return true
            }),
          writeProject: () => Effect.void,
        }),
        Layer.mock(MemoryModel.Service, {
          generate: () =>
            Effect.sync(() => {
              state.modelCalls++
              throw new Error("bootstrap must not call a model")
            }),
        }),
        readyAdmissionLayer,
        MemoryLock.defaultLayer,
        Layer.mock(MemoryStore.Service, {
          readTopics: () => Effect.succeed([]),
        }),
      ),
    ),
  )
  return {
    state,
    models,
    reset: () => {
      state.available = new Set(Object.values(models).map((model) => `${model.providerID}/${model.id}`))
      state.smallModel = "test/small"
      state.compactionModel = "test/compaction"
      state.defaultModel = "test/default"
      state.project = undefined
      state.global = undefined
      state.written = undefined
      state.modelCalls = 0
      state.defaultModelHook = undefined
      state.loadHook = undefined
    },
    it: testEffect(layer),
  }
}

function recallFixture() {
  const model = ProviderTest.model({
    providerID: ProviderV2.ID.make("test"),
    id: ModelV2.ID.make("memory-small"),
  })
  const provider = ProviderTest.fake({ model })
  const state: {
    queries: string[]
    reads: number
    topics: MemorySchema.Topic[]
    failQueries: Set<string>
    maintenance: number
    budgets: number[]
    config: MemorySchema.Config
    projectInitialized: number
    matcher?: (query: string) => Effect.Effect<unknown>
    maintenanceHook?: () => Effect.Effect<unknown>
    /** Parks the runner's pre-select topics read (interrupt-window probe). */
    parkReads?: { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
  } = {
    queries: [],
    reads: 0,
    topics: [topic()],
    failQueries: new Set<string>(),
    maintenance: 0,
    budgets: [],
    config,
    projectInitialized: 1,
  }
  const layer = Memory.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        emptyConfigLayer,
        EffectFlock.defaultLayer,
        MemoryHome.defaultLayer,
        MemoryIdentityFence.defaultLayer,
        provider.layer,
        Layer.mock(Project.Service, {
          get: (id) =>
            Effect.succeed({
              id,
              worktree: "/unused",
              vcs: "git" as const,
              time: { created: 0, updated: 0, initialized: state.projectInitialized },
              sandboxes: [],
            }),
        }),
        Layer.mock(MemoryConfig.Service, {
          load: (directory) => Effect.succeed({ config: state.config, path: directory, level: "project" as const }),
        }),
        Layer.mock(MemoryModel.Service, {
          generate: (input) =>
            Effect.gen(function* () {
              state.budgets.push(input.maxOutputTokens)
              if (input.system === MemoryPrompts.MATCH_SYSTEM) {
                const request: unknown = JSON.parse(input.prompt)
                const query =
                  request !== null &&
                  typeof request === "object" &&
                  "user_text" in request &&
                  typeof request.user_text === "string"
                    ? request.user_text
                    : ""
                state.queries.push(query)
                if (state.failQueries.has(query)) throw new Error("matcher failed")
                if (state.matcher) return yield* state.matcher(query)
                return { topic_ids: query.includes("架构") ? [state.topics[0]?.id] : [] }
              }
              state.maintenance++
              if (state.maintenanceHook) return yield* state.maintenanceHook()
              return { actions: [{ type: "no_change" }] }
            }),
        }),
        readyAdmissionLayer,
        MemoryLock.defaultLayer,
        Layer.mock(MemoryStore.Service, {
          readTopics: () =>
            Effect.gen(function* () {
              state.reads++
              if (state.parkReads) {
                yield* Deferred.succeed(state.parkReads.started, undefined)
                yield* Deferred.await(state.parkReads.release)
              }
              return state.topics
            }),
          updateTopics: (_projectID, update) =>
            Effect.sync(() => {
              const next = update(state.topics)
              state.topics = next.applied.topics
              return { revision: 1, topics: state.topics, result: next.result }
            }),
        }),
      ),
    ),
  )
  const systemLayer = SystemPrompt.layer.pipe(
    Layer.provide(LocationServiceMap.layer),
    Layer.provide(Layer.mock(MCP.Service, { instructions: () => Effect.succeed([]) })),
    Layer.provide(
      Layer.mock(Skill.Service, {
        available: () => Effect.succeed([]),
      }),
    ),
    Layer.provideMerge(layer),
  )
  return {
    state,
    reset: () => {
      state.queries.length = 0
      state.reads = 0
      state.topics = [topic()]
      state.failQueries.clear()
      state.maintenance = 0
      state.budgets.length = 0
      state.config = config
      state.projectInitialized = 1
      state.matcher = undefined
      state.maintenanceHook = undefined
      state.parkReads = undefined
    },
    it: testEffect(layer),
    systemIt: testEffect(systemLayer),
  }
}

describe("memory config and YAML store", () => {
  memoryIt.instance(
    "builds the production MEMORY layer without ambient dependencies",
    () =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        expect(typeof memory.prepare).toBe("function")
        expect(typeof memory.checkpoint).toBe("function")
      }),
    { git: true },
  )

  it.live("uses the first existing project config and never falls through when it is invalid", () =>
    Effect.gen(function* () {
      const memoryConfig = yield* MemoryConfig.Service
      const tmp = yield* tmpdirScoped()
      const directory = path.join(tmp, ".opencode")
      yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(path.join(directory, "memory.json"), JSON.stringify({ ...config, enabled: true })),
      )
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(directory, "memory.jsonc"),
          `// project override\n${JSON.stringify({ ...config, enabled: false })}`,
        ),
      )

      const loaded = yield* memoryConfig.load(tmp)
      expect(loaded?.level).toBe("project")
      expect(loaded?.path).toBe(path.join(directory, "memory.jsonc"))
      expect(loaded?.config.enabled).toBe(false)

      yield* Effect.promise(() => fs.writeFile(path.join(directory, "memory.jsonc"), "{ invalid"))
      expect(yield* memoryConfig.load(tmp)).toBeUndefined()

      yield* Effect.promise(() =>
        fs.writeFile(path.join(directory, "memory.jsonc"), `${JSON.stringify(config)} trailing-garbage`),
      )
      expect(yield* memoryConfig.load(tmp)).toBeUndefined()

      // topic_limit_floor was removed — legacy files still carrying it decode
      // normally (extra property tolerated); the decoded config never has it,
      // and load never rewrites the file.
      yield* Effect.promise(() =>
        fs.writeFile(path.join(directory, "memory.jsonc"), JSON.stringify({ ...config, topic_limit_floor: 50 })),
      )
      expect((yield* memoryConfig.load(tmp))?.config.topic_limit).toBe(10)

      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(directory, "memory.jsonc"),
          JSON.stringify({ ...config, topic_limit: 50, topic_limit_floor: 10 }),
        ),
      )
      expect((yield* memoryConfig.load(tmp))?.config).toMatchObject({ topic_limit: 50 })

      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(directory, "memory.jsonc"),
          JSON.stringify({ ...config, topic_limit: 20, topic_limit_floor: 50 }),
        ),
      )
      expect((yield* memoryConfig.load(tmp))?.config.topic_limit).toBe(20)
    }),
  )

  it.live("replaces an invalid global winner so a later startup can retry initialization", () =>
    Effect.gen(function* () {
      const memoryConfig = yield* MemoryConfig.Service
      const global = yield* tmpdirScoped()
      const project = yield* tmpdirScoped()
      const previous = process.env.OPENCODE_CONFIG_DIR

      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          process.env.OPENCODE_CONFIG_DIR = global
        }),
        () =>
          Effect.gen(function* () {
            yield* Effect.promise(() => fs.writeFile(path.join(global, "memory.jsonc"), "{ invalid"))
            expect(yield* memoryConfig.loadGlobal()).toBeUndefined()
            expect(yield* memoryConfig.writeGlobal(config)).toBe(true)
            expect((yield* memoryConfig.load(project))?.config).toEqual(config)
          }),
        () =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
            else process.env.OPENCODE_CONFIG_DIR = previous
          }),
      )
    }),
  )

  it.live("warns when preserving an existing valid global configuration", () =>
    Effect.gen(function* () {
      const memoryConfig = yield* MemoryConfig.Service
      const global = yield* tmpdirScoped()
      const previous = process.env.OPENCODE_CONFIG_DIR
      const existing = { ...config, model: "test/existing" }
      const requested = { ...config, model: "test/requested" }

      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          process.env.OPENCODE_CONFIG_DIR = global
        }),
        () =>
          Effect.gen(function* () {
            expect(yield* memoryConfig.writeGlobal(existing)).toBe(true)
            expect(yield* memoryConfig.writeGlobal(requested)).toBe(false)
            expect((yield* memoryConfig.loadGlobal())?.config).toEqual(existing)

            const logs = JSON.stringify(yield* logLines)
            expect(logs).toContain("WARN")
            expect(logs).toContain("global MEMORY config write declined — preserving existing valid config")
            expect(logs).toContain(path.join(global, "memory.jsonc"))
            expect(logs).toContain("existingModel")
            expect(logs).toContain("test/existing")
            expect(logs).toContain("requestedModel")
            expect(logs).toContain("test/requested")
          }),
        () =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
            else process.env.OPENCODE_CONFIG_DIR = previous
          }),
      )
    }),
  )
})

describe("memory controller policy", () => {
  test("owns IDs and metadata and rejects partial or prohibited action batches", () => {
    const ids = ["alpha", "beta"]
    const created = MemoryStore.applyActions({
      topics: [],
      topicLimit: 10,
      now,
      id: () => ids.shift() ?? "unexpected",
      actions: [
        {
          type: "create_topic",
          name: "交互偏好",
          summary: "长期交互偏好",
          categories: ["preference"],
          keywords: ["简洁"],
          related_topics: [],
          item: {
            kind: "preference",
            content: "回答保持简洁中文",
            rationale: "用户长期明确偏好这种表达方式",
          },
        },
      ],
    })

    expect(created.topics[0]).toMatchObject({
      id: "topic-alpha",
      metadata: { created_at: now, updated_at: now, revision: 1, item_count: 1 },
      items: [{ id: "item-beta", confirmed_at: now }],
    })

    const original = structuredClone(created.topics)
    expect(() =>
      MemoryStore.applyActions({
        topics: created.topics,
        topicLimit: 10,
        now,
        actions: [
          { type: "update_topic", topic_id: "topic-alpha", name: "已修改名称" },
          {
            type: "upsert_item",
            topic_id: "topic-alpha",
            item: { kind: "decision", content: "const x = 1", rationale: "下一步执行这个计划" },
          },
        ],
      }),
    ).toThrow("prohibited content")
    expect(created.topics).toEqual(original)

    expect(() =>
      MemoryStore.applyActions({
        topics: created.topics,
        topicLimit: 10,
        actions: [
          {
            type: "upsert_item",
            topic_id: "topic-alpha",
            item_id: "item-not-owned",
            item: { kind: "preference", content: "回答保持简洁中文", rationale: "用户确认这是长期偏好" },
          },
        ],
      }),
    ).toThrow("Memory item not found")
  })

  test("enforces topic capacity and rejects plans, documentation, code, and secrets", () => {
    const topics = Array.from({ length: 10 }, (_, index) => topic(`topic-${index}`))
    expect(() =>
      MemoryStore.applyActions({
        topics,
        topicLimit: 10,
        actions: [
          {
            type: "create_topic",
            name: "额外主题",
            summary: "额外核心主题",
            categories: ["decision"],
            keywords: [],
            related_topics: [],
            item: { kind: "decision", content: "长期采用稳定架构边界", rationale: "用户已经确认" },
          },
        ],
      }),
    ).toThrow("capacity")

    expect(MemoryStore.isAllowedMemoryText("长期回答使用简洁中文")).toBe(true)
    expect(MemoryStore.isAllowedMemoryText("下一步添加缓存")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("文档中规定采用这个方案")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("api_key 是 abc123")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("SELECT * FROM users")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("SELECT 1")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText('print("hello")')).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("def add(a,b): a+b")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("The repository currently uses React 19")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("代码库目前依赖 React 19")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("credential sk-proj-1234567890abcdef")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("用户患有抑郁症")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("SSN 123-45-6789")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("React 19 powers the frontend")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("while True: break")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("We should add caching")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("We use React")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("Phone: 555-123-4567")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("xoxb-1234567890-abcdef")).toBe(false)
  })

  const zhRationale = "用户明确确认该要求长期有效"
  const enRationale = "The user explicitly confirmed this long-term"

  test.each([
    ["用户要求服务器登录密码保持为 Tr0ub4dor", zhRationale],
    ["用户偏好：数据库密钥固定为 Zx9Qa7LmPq", zhRationale],
    ["用户要求部署令牌使用 Zx9Qa7LmPq", zhRationale],
    ["用户要求口令保持为 Zx9Qa7LmPq", zhRationale],
    ["用户要求云账号凭据保持为 Zx9Qa7LmPq", zhRationale],
    ["User requires the staging credential to remain Zx9Qa7LmPq", enRationale],
    ["User requires the backup passphrase to remain Zx9Qa7LmPq", enRationale],
    ["User prefers the deploy token Zx9Qa7LmPq", enRationale],
    ["User prefers the bearer token Zx9Qa7LmPq", enRationale],
    ["User requires the api key Zx9Qa7LmPq", enRationale],
  ])("rejects credential-bearing memory: %s", (content, rationale) => {
    expect(MemoryStore.isAllowedMemoryItem({ kind: "preference", content, rationale })).toBe(false)
  })

  test.each([
    ["用户偏好回答控制令牌预算并保持简洁", zhRationale],
    ["用户要求回答使用简洁中文", zhRationale],
    ["User prefers keeping the token budget small", enRationale],
    ["User prefers token counts reported in summaries", enRationale],
  ])("keeps legitimate memory that mentions tokens: %s", (content, rationale) => {
    expect(MemoryStore.isAllowedMemoryItem({ kind: "preference", content, rationale })).toBe(true)
  })

  test("applyActions refuses to persist a Chinese-labelled credential", () => {
    expect(() =>
      MemoryStore.applyActions({
        topics: [],
        topicLimit: 10,
        now,
        actions: [
          {
            type: "create_topic",
            name: "部署偏好",
            summary: "用户确认的部署偏好",
            categories: ["preference"],
            keywords: ["部署"],
            related_topics: [],
            item: { kind: "preference", content: "用户要求服务器登录密码保持为 Tr0ub4dor", rationale: zhRationale },
          },
        ],
      }),
    ).toThrow("prohibited content")
  })

  test("requires item-kind semantics and explicit durable confirmation", () => {
    const apply = (kind: "preference" | "decision" | "term", content: string, rationale: string) =>
      MemoryStore.applyActions({
        topics: [],
        topicLimit: 10,
        actions: [
          {
            type: "create_topic",
            name: "Stable context",
            summary: "Confirmed durable context",
            categories: [kind],
            keywords: ["stable"],
            related_topics: [],
            item: { kind, content, rationale },
          },
        ],
      })

    expect(() => apply("decision", "Cache responses", "User explicitly confirmed this long-term decision")).toThrow(
      "prohibited content",
    )
    expect(() =>
      apply("decision", "Confirmed decision: while True: break", "User explicitly confirmed this durable decision"),
    ).toThrow("prohibited content")
    expect(() =>
      apply("decision", "Confirmed decision: echo hello", "User explicitly confirmed this durable decision"),
    ).toThrow("prohibited content")
    expect(() =>
      apply("decision", "Confirmed decision: python -c pass", "User explicitly confirmed this durable decision"),
    ).toThrow("prohibited content")
    expect(() =>
      apply("decision", "Confirmed decision: sh -c id", "User explicitly confirmed this durable decision"),
    ).toThrow("prohibited content")
    expect(() =>
      apply("decision", "Confirmed decision: lambda x: x", "User explicitly confirmed this durable decision"),
    ).toThrow("prohibited content")
    expect(() => apply("decision", "Confirmed decision: use stable boundaries", "Temporary experiment")).toThrow(
      "prohibited content",
    )
    expect(MemoryStore.isAllowedMemoryText("User prefers concise answers")).toBe(true)
    expect(MemoryStore.isAllowedMemoryText("User explicitly confirmed this long-term preference")).toBe(true)
    expect(
      MemoryStore.isAllowedMemoryItem({
        kind: "preference",
        content: "User prefers concise answers",
        rationale: "User explicitly confirmed this long-term preference",
      }),
    ).toBe(true)
    expect(() =>
      apply("preference", "User prefers concise answers", "User explicitly confirmed this long-term preference"),
    ).not.toThrow()
    expect(() =>
      apply("decision", "Confirmed decision: use stable boundaries", "User explicitly confirmed this durable decision"),
    ).not.toThrow()
    expect(() =>
      apply("term", "MEMORY means Project-owned durable preferences", "User explicitly confirmed this stable term"),
    ).not.toThrow()
  })

  test("renders only complete fields within the injection budget", () => {
    const first = topic("first-topic")
    const base = topic("second-topic")
    const second = {
      ...base,
      items: [{ ...base.items[0], content: "长期偏好".repeat(180) }],
    } satisfies MemorySchema.Topic
    const rendered = Memory.renderTopics([first, second], {
      ...config,
      injection: { max_topics: 2, max_tokens: 200 },
    })

    expect(rendered).toHaveLength(1)
    expect(rendered[0]).toContain("first-topic")
    expect(rendered[0]).not.toContain("second-topic")
    expect(rendered[0]).toContain("Project-owned historical data shared by this Project's worktrees")
    expect(rendered[0]).toContain("Current user input and higher-priority instructions always win")
    expect(
      [
        "created_at",
        "updated_at",
        "last_matched_at",
        "match_count",
        "revision",
        "item_count",
        "confirmed_at",
        "schema_version",
      ].filter((hidden) => rendered[0]?.includes(hidden)),
    ).toEqual([])
    expect(Token.estimate(rendered[0])).toBeLessThanOrEqual(200)

    expect(
      Memory.renderTopics([second, first], {
        ...config,
        injection: { max_topics: 2, max_tokens: 200 },
      }),
    ).toEqual([])
  })

  test("keeps CJK memory within max_tokens under the CJK-aware estimate", () => {
    const filler = "回答使用简洁中文并保持礼貌语气与清晰结构"
    const topics = [1, 2, 3].map((index) => {
      const base = topic(`cjk-topic-${index}`)
      return {
        ...base,
        metadata: { ...base.metadata, item_count: 2 },
        items: [1, 2].map((n) => ({
          ...base.items[0],
          id: `cjk-topic-${index}-item-${n}`,
          content: `已确认决定：${filler.repeat(20)}`,
        })),
      } satisfies MemorySchema.Topic
    })
    for (const value of topics) expect(MemoryStore.decodeTopic(value, value.id)).toBeDefined()
    const cap = { ...config, injection: { max_topics: 3, max_tokens: MemorySchema.MAX_INJECTION_TOKENS } }

    const rendered = Memory.renderTopics(topics, cap)
    expect(rendered).toHaveLength(1)
    expect(rendered[0]).toContain("cjk-topic-1")
    // length/4 would admit all six items (~2800 CJK tokens against a 1200 cap).
    expect(Token.estimateReserve(rendered[0])).toBeLessThanOrEqual(cap.injection.max_tokens)
  })
})

describe("memory cadence evidence", () => {
  test("treats a pasted absolute path as real user input but still skips slash commands", () => {
    const sessionID = SessionID.make("ses_memory_pasted_path")
    const providerID = ProviderV2.ID.make("test")
    const modelID = ModelV2.ID.make("test-model")
    const turn = (text: string, command?: string) => {
      const id = MessageID.ascending()
      const message = user(id, sessionID, text)
      if (command) message.parts = message.parts.map((part) => ({ ...part, metadata: { command } }))
      return [message, { info: assistant(id, sessionID, providerID, modelID, "end_turn"), parts: [] }]
    }

    for (const text of [
      "/Users/me/app/src/x.ts:12 throws on startup",
      "/home/me/project/build.log shows the failure",
      "/srv/app/main.go:40:7 panics",
      "/tmp/output.log",
      // Arbitrary mounts without an extension or line suffix.
      "/data/project/logs",
      "/repo/checkout is empty after the merge",
    ])
      expect(Memory.completedTurns(turn(text))).toBe(1)

    // SessionPrompt.command marks its invocation part, whatever the name looks like.
    for (const [text, command] of [
      ["/memory on", "memory"],
      ["/git/commit fix typo", "git/commit"],
      ["/server:prompt arg", "server:prompt"],
    ])
      expect(Memory.completedTurns(turn(text, command))).toBe(0)

    // Invocations persisted before command parts were marked.
    for (const text of ["/memory on", "/goal write the docs", "/init"])
      expect(Memory.completedTurns(turn(text))).toBe(0)
  })

  test("counts only completed real user-to-main-agent turns and removes code evidence", () => {
    const sessionID = SessionID.make("ses_memory_test")
    const providerID = ProviderV2.ID.make("test")
    const modelID = ModelV2.ID.make("test-model")
    const userID = MessageID.ascending()
    const syntheticID = MessageID.ascending()
    const commandID = MessageID.ascending()
    const unfinishedID = MessageID.ascending()
    const messages: SessionV1.WithParts[] = [
      {
        info: {
          id: userID,
          role: "user",
          sessionID,
          time: { created: 1 },
          agent: "build",
          model: { providerID, modelID },
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: userID,
            sessionID,
            type: "text",
            text: "长期偏好是简洁中文\n```ts\nconst token = 'secret'\n```\n查看 /tmp/output.log",
          },
        ],
      },
      {
        info: assistant(userID, sessionID, providerID, modelID, "end_turn"),
        parts: [],
      },
      {
        info: {
          id: syntheticID,
          role: "user",
          sessionID,
          time: { created: 2 },
          agent: "build",
          model: { providerID, modelID },
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: syntheticID,
            sessionID,
            type: "text",
            text: "synthetic continuation",
            synthetic: true,
          },
        ],
      },
      {
        info: assistant(syntheticID, sessionID, providerID, modelID, "end_turn"),
        parts: [],
      },
      {
        info: {
          id: commandID,
          role: "user",
          sessionID,
          time: { created: 3 },
          agent: "build",
          model: { providerID, modelID },
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: commandID,
            sessionID,
            type: "text",
            text: "/goal write the docs",
          },
          {
            id: PartID.ascending(),
            messageID: commandID,
            sessionID,
            type: "text",
            text: "目标已设定",
          },
        ],
      },
      {
        info: assistant(commandID, sessionID, providerID, modelID, "end_turn"),
        parts: [],
      },
      {
        info: {
          id: unfinishedID,
          role: "user",
          sessionID,
          time: { created: 4 },
          agent: "build",
          model: { providerID, modelID },
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: unfinishedID,
            sessionID,
            type: "text",
            text: "尚未完成",
          },
        ],
      },
      {
        info: assistant(unfinishedID, sessionID, providerID, modelID, "tool-calls"),
        parts: [],
      },
    ]

    expect(Memory.completedTurns(messages)).toBe(1)
    expect(Memory.cleanEvidence(messages)).toContain("长期偏好是简洁中文")
    expect(Memory.cleanEvidence(messages)).not.toContain("const token")
    expect(Memory.cleanEvidence(messages)).not.toContain("/tmp/output.log")
    expect(Memory.cleanEvidence(messages)).not.toContain("synthetic continuation")
    expect(Memory.cleanEvidence(messages)).not.toContain("目标已设定")
  })
})

describe("memory turn-scoped retrieval", () => {
  const recall = recallFixture()

  recall.systemIt.instance(
    "publishes first-turn and explicit-query views through SystemPrompt only for their real user turn",
    () =>
      Effect.gen(function* () {
        recall.reset()
        const memory = yield* Memory.Service
        const prompt = yield* SystemPrompt.Service
        const sessionID = SessionID.make("ses_memory_system_context")
        const firstID = MessageID.ascending()
        const first = user(firstID, sessionID, "继续之前确认的架构边界")

        expect((yield* prompt.memory({ sessionID, messages: [first], main: true })).join("\n")).toContain(
          "architecture-boundaries",
        )

        const second = user(MessageID.ascending(), sessionID, "处理一个没有自动记忆的新问题")
        const secondTurn = [
          first,
          {
            info: assistant(firstID, sessionID, ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"), "end_turn"),
            parts: [],
          },
          second,
        ]
        expect(yield* prompt.memory({ sessionID, messages: secondTurn, main: true })).toEqual([])

        yield* memory.search({ sessionID, messages: secondTurn, query: "架构边界" })
        expect((yield* prompt.memory({ sessionID, messages: secondTurn, main: true })).join("\n")).toContain(
          "architecture-boundaries",
        )

        const thirdTurn = [...secondTurn, user(MessageID.ascending(), sessionID, "开始下一轮")]
        expect(yield* prompt.memory({ sessionID, messages: thirdTurn, main: true })).toEqual([])
      }),
    { git: true },
  )

  recall.systemIt.instance(
    "does not treat the first real user message after compaction as the session first turn",
    () =>
      Effect.gen(function* () {
        recall.reset()
        const memory = yield* Memory.Service
        const prompt = yield* SystemPrompt.Service
        const sessionID = SessionID.make("ses_memory_compacted_history")
        const markerID = MessageID.ascending()
        const current = user(MessageID.ascending(), sessionID, "继续压缩后的架构问题")
        const messages: SessionV1.WithParts[] = [
          {
            info: {
              ...user(markerID, sessionID, "").info,
              id: markerID,
            },
            parts: [
              {
                id: PartID.ascending(),
                messageID: markerID,
                sessionID,
                type: "compaction",
                auto: true,
              },
            ],
          },
          current,
        ]

        expect(yield* prompt.memory({ sessionID, messages, main: true })).toEqual([])
        expect(recall.state.queries).toEqual([])

        expect(yield* memory.search({ sessionID, messages, query: "架构边界" })).toEqual({
          status: "attached",
          count: 1,
          reused: false,
        })
        expect((yield* prompt.memory({ sessionID, messages, main: true })).join("\n")).toContain(
          "architecture-boundaries",
        )
        expect(recall.state.queries).toEqual(["架构边界"])
      }),
    { git: true },
  )

  recall.systemIt.instance(
    "keeps child, disabled, and ineligible sessions isolated from Topic reads and matching",
    () =>
      Effect.gen(function* () {
        recall.reset()
        const memory = yield* Memory.Service
        const prompt = yield* SystemPrompt.Service
        const sessionID = SessionID.make("ses_memory_isolation")
        const messages = [user(MessageID.ascending(), sessionID, "继续之前确认的架构边界")]

        expect(yield* prompt.memory({ sessionID, messages, main: false })).toEqual([])
        expect(recall.state.reads).toBe(0)
        expect(recall.state.queries).toEqual([])

        recall.state.config = { ...config, enabled: false }
        yield* memory.prepare({ sessionID, messages })
        expect(yield* memory.search({ sessionID, messages, query: "架构边界" })).toEqual({
          status: "unavailable",
        })
        expect(recall.state.reads).toBe(0)
        expect(recall.state.queries).toEqual([])

        recall.state.config = config
        recall.state.projectInitialized = 0
        yield* memory.prepare({ sessionID, messages })
        expect(yield* memory.search({ sessionID, messages, query: "架构边界" })).toEqual({
          status: "unavailable",
        })
        expect(recall.state.reads).toBe(0)
        expect(recall.state.queries).toEqual([])
      }),
    { git: true },
  )

  recall.it.instance(
    "waits for the first real user message and matches it once across provider steps",
    () =>
      Effect.gen(function* () {
        recall.reset()
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_first_turn")
        const messageID = MessageID.ascending()

        yield* memory.prepare({ sessionID, messages: [] })
        expect(recall.state.queries).toEqual([])
        expect(yield* memory.context(sessionID)).toEqual([])

        const messages = [user(messageID, sessionID, "继续之前确认的架构边界")]
        yield* memory.prepare({ sessionID, messages })
        yield* memory.prepare({ sessionID, messages })

        expect(recall.state.queries).toEqual(["继续之前确认的架构边界"])
        expect((yield* memory.context(sessionID)).join("\n")).toContain("architecture-boundaries")
      }),
    { git: true },
  )

  recall.it.instance(
    "emits no MEMORY block when the first-turn matcher finds no material topic",
    () =>
      Effect.gen(function* () {
        recall.reset()
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_empty_first_turn")
        const messages = [user(MessageID.ascending(), sessionID, "解释今天的新问题")]

        yield* memory.prepare({ sessionID, messages })
        yield* memory.prepare({ sessionID, messages })

        expect(recall.state.queries).toEqual(["解释今天的新问题"])
        expect(yield* memory.context(sessionID)).toEqual([])
      }),
    { git: true },
  )

  recall.it.instance(
    "keeps context through synthetic activity and expires it on the next real user turn",
    () =>
      Effect.gen(function* () {
        recall.reset()
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_turn_expiry")
        const firstID = MessageID.ascending()
        const first = user(firstID, sessionID, "继续之前确认的架构边界")

        yield* memory.prepare({ sessionID, messages: [first] })
        expect((yield* memory.context(sessionID)).join("\n")).toContain("architecture-boundaries")

        const synthetic = user(MessageID.ascending(), sessionID, "synthetic continuation", true)
        const command = user(MessageID.ascending(), sessionID, "/memory on")
        yield* memory.prepare({ sessionID, messages: [first, synthetic, command] })
        expect((yield* memory.context(sessionID)).join("\n")).toContain("architecture-boundaries")

        const second = user(MessageID.ascending(), sessionID, "继续讨论架构边界")
        yield* memory.prepare({ sessionID, messages: [first, synthetic, command, second] })

        expect(recall.state.queries).toEqual(["继续之前确认的架构边界"])
        expect(yield* memory.context(sessionID)).toEqual([])
      }),
    { git: true },
  )

  recall.it.instance(
    "attaches one normalized explicit query and reuses an identical query in the same turn",
    () =>
      Effect.gen(function* () {
        recall.reset()
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_explicit_query")
        const firstID = MessageID.ascending()
        const secondID = MessageID.ascending()
        const messages = [
          user(firstID, sessionID, "先处理当前问题"),
          {
            info: assistant(firstID, sessionID, ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"), "end_turn"),
            parts: [],
          },
          user(secondID, sessionID, "现在需要历史背景"),
        ]

        const attached = yield* memory.search({ sessionID, messages, query: "  架构   边界  " })
        const reused = yield* memory.search({ sessionID, messages, query: "架构 边界" })

        expect(attached).toEqual({ status: "attached", count: 1, reused: false })
        expect(reused).toEqual({ status: "attached", count: 1, reused: true })
        expect(recall.state.queries).toEqual(["架构 边界"])
        expect((yield* memory.context(sessionID)).join("\n")).toContain("architecture-boundaries")
      }),
    { git: true },
  )

  recall.it.instance(
    "coalesces concurrent identical queries without consuming another query slot",
    () =>
      Effect.gen(function* () {
        recall.reset()
        const started = yield* Deferred.make<void>()
        const repeatedStarted = yield* Deferred.make<void>()
        recall.state.matcher = () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(repeatedStarted)
            return { topic_ids: [recall.state.topics[0]?.id ?? ""] }
          })
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_concurrent_query")
        const messages = [
          user(MessageID.ascending(), sessionID, "先处理当前问题"),
          user(MessageID.ascending(), sessionID, "召回相关历史"),
        ]

        const first = yield* memory.search({ sessionID, messages, query: "并发架构查询" }).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const repeated = yield* Effect.gen(function* () {
          yield* Deferred.succeed(repeatedStarted, undefined)
          return yield* memory.search({ sessionID, messages, query: " 并发架构查询 " })
        }).pipe(Effect.forkChild)

        expect(yield* Fiber.join(first)).toEqual({ status: "attached", count: 1, reused: false })
        expect(yield* Fiber.join(repeated)).toEqual({ status: "attached", count: 1, reused: true })
        expect(recall.state.queries).toEqual(["并发架构查询"])
        expect(yield* memory.search({ sessionID, messages, query: "没有相关记录" })).toEqual({
          status: "attached",
          count: 1,
          reused: false,
        })
      }),
    { git: true },
  )

  recall.it.instance(
    "replaces successful selections, reuses cached queries, and caps distinct queries at two",
    () =>
      Effect.gen(function* () {
        recall.reset()
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_query_limit")
        const firstID = MessageID.ascending()
        const messages = [
          user(firstID, sessionID, "先处理当前问题"),
          {
            info: assistant(firstID, sessionID, ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"), "end_turn"),
            parts: [],
          },
          user(MessageID.ascending(), sessionID, "现在需要历史背景"),
        ]

        expect(yield* memory.search({ sessionID, messages, query: "架构边界" })).toEqual({
          status: "attached",
          count: 1,
          reused: false,
        })
        expect(yield* memory.search({ sessionID, messages, query: "没有相关记录" })).toEqual({
          status: "empty",
          reused: false,
        })
        expect(yield* memory.context(sessionID)).toEqual([])

        expect(yield* memory.search({ sessionID, messages, query: " 架构边界 " })).toEqual({
          status: "attached",
          count: 1,
          reused: true,
        })
        expect(yield* memory.search({ sessionID, messages, query: "第三个不同查询" })).toEqual({ status: "limit" })
        expect(recall.state.queries).toEqual(["架构边界", "没有相关记录"])
        expect((yield* memory.context(sessionID)).join("\n")).toContain("architecture-boundaries")
      }),
    { git: true },
  )

  recall.it.instance(
    "acknowledges only complete topic views that fit the injection budget",
    () =>
      Effect.gen(function* () {
        recall.reset()
        const large = topic("oversized-topic")
        recall.state.topics = [
          topic(),
          {
            ...large,
            items: [{ ...large.items[0], content: "长期偏好".repeat(180) }],
          },
        ]
        recall.state.config = { ...config, injection: { max_topics: 2, max_tokens: 200 } }
        recall.state.matcher = () => Effect.succeed({ topic_ids: recall.state.topics.map((item) => item.id) })
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_bounded_count")
        const messages = [
          user(MessageID.ascending(), sessionID, "先处理当前问题"),
          user(MessageID.ascending(), sessionID, "召回相关历史"),
        ]

        expect(yield* memory.search({ sessionID, messages, query: "架构边界" })).toEqual({
          status: "attached",
          count: 1,
          reused: false,
        })
        const rendered = (yield* memory.context(sessionID)).join("\n")
        expect(rendered).toContain("architecture-boundaries")
        expect(rendered).not.toContain("oversized-topic")
      }),
    { git: true },
  )

  recall.it.instance(
    "keeps the last successful selection when a replacement query fails",
    () =>
      Effect.gen(function* () {
        recall.reset()
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_failed_replacement")
        const firstID = MessageID.ascending()
        const messages = [
          user(firstID, sessionID, "先处理当前问题"),
          {
            info: assistant(firstID, sessionID, ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"), "end_turn"),
            parts: [],
          },
          user(MessageID.ascending(), sessionID, "现在需要历史背景"),
        ]

        yield* memory.search({ sessionID, messages, query: "架构边界" })
        recall.state.failQueries.add("失败替换")
        expect(yield* memory.search({ sessionID, messages, query: "失败替换" })).toEqual({ status: "failed" })
        expect((yield* memory.context(sessionID)).join("\n")).toContain("architecture-boundaries")
      }),
    { git: true },
  )

  recall.it.instance(
    "fails open without partial attachment when the matcher returns malformed output",
    () =>
      Effect.gen(function* () {
        recall.reset()
        recall.state.matcher = () => Effect.succeed({ topic_ids: "architecture-boundaries" })
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_malformed_match")
        const messages = [
          user(MessageID.ascending(), sessionID, "先处理当前问题"),
          user(MessageID.ascending(), sessionID, "召回相关历史"),
        ]

        expect(yield* memory.search({ sessionID, messages, query: "架构边界" })).toEqual({ status: "failed" })
        expect(yield* memory.context(sessionID)).toEqual([])
      }),
    { git: true },
  )

  recall.it.instance(
    "runs due maintenance without refreshing retrieval context for a later turn",
    () =>
      Effect.gen(function* () {
        recall.reset()
        recall.state.config = { ...config, turn_interval: 1 }
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_maintenance_cadence")
        const firstID = MessageID.ascending()
        const first = user(firstID, sessionID, "继续之前确认的架构边界")

        yield* memory.prepare({ sessionID, messages: [first] })
        const messages = [
          first,
          {
            info: assistant(firstID, sessionID, ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"), "end_turn"),
            parts: [],
          },
          user(MessageID.ascending(), sessionID, "再次讨论架构边界"),
        ]
        yield* memory.prepare({ sessionID, messages })

        // Maintenance runs in the background after the render fence (issue
        // #324): polling stands in for the old synchronous completion.
        yield* pollWithTimeout(
          Effect.sync(() => (recall.state.maintenance === 1 ? true : undefined)),
          "due maintenance never ran in the background",
        )
        expect(recall.state.queries).not.toContain("再次讨论架构边界")
        expect(yield* memory.context(sessionID)).toEqual([])
      }),
    { git: true },
  )

  recall.it.instance(
    "keeps the fence and project lock free while background maintenance streams",
    () =>
      Effect.gen(function* () {
        recall.reset()
        recall.state.config = { ...config, turn_interval: 1 }
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_maintenance_lock_free")
        const firstID = MessageID.ascending()
        const first = user(firstID, sessionID, "继续之前确认的架构边界")

        yield* memory.prepare({ sessionID, messages: [first] })
        const messages = [
          first,
          {
            info: assistant(firstID, sessionID, ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"), "end_turn"),
            parts: [],
          },
          user(MessageID.ascending(), sessionID, "第二次架构讨论"),
        ]

        const release = yield* Deferred.make<void>()
        recall.state.maintenanceHook = () =>
          Effect.gen(function* () {
            yield* Deferred.await(release)
            return { actions: [{ type: "no_change" }] }
          })

        const pending = yield* memory.prepare({ sessionID, messages }).pipe(Effect.forkChild)
        yield* pollWithTimeout(
          Effect.sync(() => (recall.state.maintenance >= 1 ? true : undefined)),
          "due maintenance never reached the model call",
        )

        // The maintenance model call is in flight. Because prepare kicked it
        // outside the fence (issue #324), a concurrent checkpoint — whose
        // render select needs the same identity fence and project lock — is
        // not starved; under the old inline shape it would wait on the fence
        // until the streaming call finished.
        const rendered = yield* awaitWithTimeout(
          memory.checkpoint({ sessionID, messages }),
          "checkpoint starved by background maintenance",
        )
        expect(rendered.length).toBeGreaterThan(0)

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(pending)
        expect(recall.state.maintenance).toBe(1)
      }),
    { git: true },
  )

  recall.it.instance(
    "discards a query that completes after a new real user turn starts",
    () =>
      Effect.gen(function* () {
        recall.reset()
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_stale_query")
        const firstID = MessageID.ascending()
        const secondID = MessageID.ascending()
        const current = [
          user(firstID, sessionID, "先处理当前问题"),
          {
            info: assistant(firstID, sessionID, ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"), "end_turn"),
            parts: [],
          },
          user(secondID, sessionID, "现在需要历史背景"),
        ]
        yield* memory.search({ sessionID, messages: current, query: "架构边界" })

        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        recall.state.matcher = (query) =>
          query === "慢查询"
            ? Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
                return { topic_ids: [recall.state.topics[0]?.id ?? ""] }
              })
            : Effect.succeed({ topic_ids: [] })
        const pending = yield* memory.search({ sessionID, messages: current, query: "慢查询" }).pipe(Effect.forkChild)
        yield* Deferred.await(started)

        const next = [...current, user(MessageID.ascending(), sessionID, "新的用户问题")]
        const advanced = yield* memory.prepare({ sessionID, messages: next }).pipe(Effect.forkChild)
        yield* pollWithTimeout(
          memory.context(sessionID).pipe(Effect.map((value) => (value.length === 0 ? true : undefined))),
          "new user turn did not expire the preceding memory context",
          "250 millis",
        )
        yield* Deferred.succeed(release, undefined)

        expect(yield* Fiber.join(pending)).toEqual({ status: "stale" })
        yield* Fiber.join(advanced)
        expect(yield* memory.context(sessionID)).toEqual([])
      }),
    { git: true },
  )

  // MEM-02 follow-up (acceptance): the cross-process identity fence must not
  // be held across the SEARCH matcher model call — only the markMatched
  // commit is fenced. While the matcher is parked mid-call, a concurrent
  // checkpoint (whose render select needs the same identity fence) must not
  // starve. Under the old shape the fence wrapped the whole lock block, so
  // the checkpoint waited on the streaming matcher.
  recall.it.instance(
    "keeps the identity fence free while the search matcher streams",
    () =>
      Effect.gen(function* () {
        recall.reset()
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        // Only the SLOW search query parks; the checkpoint's own render match
        // must sail through — that is the assertion.
        recall.state.matcher = (query) =>
          query === "慢架构查询"
            ? Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
                return { topic_ids: [recall.state.topics[0]?.id ?? ""] }
              })
            : Effect.succeed({ topic_ids: [recall.state.topics[0]?.id ?? ""] })
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_search_fence_free")
        const messages = [
          user(MessageID.ascending(), sessionID, "先处理当前问题"),
          user(MessageID.ascending(), sessionID, "召回相关历史"),
        ]

        const pending = yield* memory.search({ sessionID, messages, query: "慢架构查询" }).pipe(Effect.forkChild)
        yield* Deferred.await(started)

        const rendered = yield* awaitWithTimeout(
          memory.checkpoint({ sessionID, messages }),
          "checkpoint starved by the search matcher — fence held across the model call (MEM-02)",
        )
        expect(rendered.length).toBeGreaterThan(0)

        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(pending)).toEqual({ status: "attached", count: 1, reused: false })
      }),
    { git: true },
  )

  recall.it.instance(
    "interrupting foreground prepare cancels its matcher without caching late output",
    () =>
      Effect.gen(function* () {
        recall.reset()
        const started = yield* Deferred.make<void>()
        const cancelled = yield* Deferred.make<void>()
        recall.state.matcher = () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }).pipe(Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)))
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_prepare_cancel")
        const messages = [user(MessageID.ascending(), sessionID, "first real user input")]
        const pending = yield* memory.prepare({ sessionID, messages }).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(pending)
        yield* awaitWithTimeout(Deferred.await(cancelled), "memory matcher was not interrupted")
        expect(yield* memory.context(sessionID)).toEqual([])
      }),
    { git: true },
  )

  // MEM-01 follow-up (acceptance): same discipline for the prepare
  // first-turn (shouldMatch) branch — the bounded matcher moved out of the
  // fence/lock, so a parked first-turn matcher cannot starve the fence.
  recall.it.instance(
    "keeps the identity fence free while the first-turn prepare matcher streams",
    () =>
      Effect.gen(function* () {
        recall.reset()
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        // Only the FIRST matcher call (the first-turn prepare) parks; the
        // concurrent checkpoint's render match — same text, so query-based
        // discrimination is impossible — must sail through on its own call.
        let matcherCalls = 0
        recall.state.matcher = () =>
          Effect.gen(function* () {
            matcherCalls++
            if (matcherCalls > 1) return { topic_ids: [recall.state.topics[0]?.id ?? ""] }
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            return { topic_ids: [recall.state.topics[0]?.id ?? ""] }
          })
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_prepare_fence_free")
        const messages = [user(MessageID.ascending(), sessionID, "首次真实用户输入关于架构")]

        const pending = yield* memory.prepare({ sessionID, messages }).pipe(Effect.forkChild)
        yield* Deferred.await(started)

        const rendered = yield* awaitWithTimeout(
          memory.checkpoint({ sessionID, messages }),
          "checkpoint starved by the first-turn prepare matcher — fence held across the model call (MEM-01)",
        )
        expect(rendered.length).toBeGreaterThan(0)

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(pending)
        // Both the first-turn prepare and the concurrent checkpoint render
        // matched the same text; each recorded exactly its own call.
        expect(recall.state.queries).toEqual(["首次真实用户输入关于架构", "首次真实用户输入关于架构"])
      }),
    { git: true },
  )

  // Review R-1: the runner must complete the in-flight deferred on EVERY
  // exit. A failed first matcher call must not wedge the (session,key): a
  // coalesced awaiter wakes (degraded) and a later identical query re-runs
  // the matcher instead of parking on a leaked in-flight entry.
  recall.it.instance(
    "a failed first query never wedges the session key or its coalesced awaiter",
    () =>
      Effect.gen(function* () {
        recall.reset()
        const started = yield* Deferred.make<void>()
        let matcherCalls = 0
        recall.state.matcher = () =>
          Effect.gen(function* () {
            matcherCalls++
            if (matcherCalls === 1) {
              yield* Deferred.succeed(started, undefined)
              throw new Error("matcher exploded")
            }
            return { topic_ids: [recall.state.topics[0]?.id ?? ""] }
          })
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_failed_first")
        const messages = [
          user(MessageID.ascending(), sessionID, "先处理当前问题"),
          user(MessageID.ascending(), sessionID, "召回相关历史"),
        ]

        const failing = yield* memory.search({ sessionID, messages, query: "易碎查询" }).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        // Concurrent identical query — either it coalesced onto the failing
        // run (wakes degraded to "failed") or it raced past the in-flight
        // window and re-runs (attached). Both are non-hang outcomes; a
        // parked-forever awaiter or a wedged key fails the bounded waits.
        const coalesced = yield* memory.search({ sessionID, messages, query: "易碎查询" }).pipe(Effect.forkChild)
        const failingResult = yield* awaitWithTimeout(Fiber.join(failing), "failing query hung")
        const coalescedResult = yield* awaitWithTimeout(
          Fiber.join(coalesced),
          "coalesced awaiter hung on the failing run",
        )
        expect(failingResult).toEqual({ status: "failed" })
        expect(["failed", "attached", "empty"]).toContain(coalescedResult.status)
        // The (session,key) is NOT wedged: the next identical query resolves
        // within the bounded window (fresh run or cached reuse from the
        // coalesced fiber's successful re-run — either proves liveness).
        expect(
          yield* awaitWithTimeout(
            memory.search({ sessionID, messages, query: "易碎查询" }),
            "later identical query wedged on the leaked in-flight entry",
          ),
        ).toMatchObject({
          status: "attached",
        })
      }),
    { git: true },
  )

  // Review R2 issue 1: the exit bracket must start at REGISTRATION, not at
  // the select pipeline — an interrupt during the runner's pre-select topics
  // read (a real async fs suspension in production) previously unwound
  // before onExit attached, leaking the in-flight entry and wedging the
  // (turn,key) forever.
  recall.it.instance(
    "an interrupted topics read releases the in-flight entry and never wedges the key",
    () =>
      Effect.gen(function* () {
        recall.reset()
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_interrupted_read")
        const messages = [
          user(MessageID.ascending(), sessionID, "先处理当前问题"),
          user(MessageID.ascending(), sessionID, "召回相关历史"),
        ]
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        recall.state.parkReads = { started, release }

        const runner = yield* memory.search({ sessionID, messages, query: "可中断查询" }).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(runner).pipe(Effect.ignore)

        // The entry must be released despite the interrupt landing before
        // the select pipeline attached its bracket: a later identical query
        // resolves within the bounded window instead of parking forever
        // (empty: the query text matches no topic — liveness is the point).
        yield* Deferred.succeed(release, undefined)
        expect(
          yield* awaitWithTimeout(
            memory.search({ sessionID, messages, query: "可中断查询" }),
            "later identical query wedged on the entry leaked by the interrupted read",
          ),
        ).toMatchObject({
          status: "empty",
        })
      }),
    { git: true },
  )
})

describe("memory project config Git exclusions", () => {
  it.live("installs exact config exclusions idempotently without touching .gitignore", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const git = yield* Git.Service
      const configStore = yield* MemoryConfig.Service
      yield* Effect.promise(() => fs.writeFile(path.join(tmp, ".gitignore"), "keep-me\n"))

      yield* configStore.writeProject(tmp, config)
      yield* configStore.writeProject(tmp, config)

      const resolved = yield* git.run(["rev-parse", "--git-path", "info/exclude"], { cwd: tmp })
      const raw = resolved.text().trim()
      const exclude = path.isAbsolute(raw) ? raw : path.resolve(tmp, raw)
      const lines = (yield* Effect.promise(() => fs.readFile(exclude, "utf-8"))).split(/\r?\n/)

      for (const rule of [".opencode/memory.jsonc", ".opencode/memory.json"]) {
        expect(lines.filter((line) => line === rule)).toHaveLength(1)
      }
      expect(lines).not.toContain(".opencode/memory/")
      expect(yield* Effect.promise(() => fs.readFile(path.join(tmp, ".gitignore"), "utf-8"))).toBe("keep-me\n")
    }),
  )
})

describe("memory hidden model", () => {
  it.live("interrupts an unsettled hidden call at the controller deadline", () =>
    Effect.gen(function* () {
      let interrupted = false
      const service = MemoryModel.make({
        execute: () =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true
              }),
            ),
          ),
        timeout: Duration.millis(10),
      })

      const exit = yield* service
        .generate({
          model: ProviderTest.model(),
          system: "system",
          prompt: "prompt",
          schema: MemorySchema.MatchResponse,
          maxOutputTokens: 32,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(interrupted).toBe(true)
    }),
  )

  it.live("guarantees the json token reaches the model and leaves json-aware prompts untouched", () =>
    Effect.gen(function* () {
      const seen: MemoryModel.Request[] = []
      const service = MemoryModel.make({
        execute: (request) =>
          Effect.sync(() => {
            seen.push(request)
            return {}
          }),
      })

      yield* service.generate({
        model: ProviderTest.model(),
        system: "Select relevant topics.",
        prompt: "plain evidence without the token",
        schema: MemorySchema.MatchResponse,
        maxOutputTokens: 32,
      })
      yield* service.generate({
        model: ProviderTest.model(),
        system: "Propose updates as a JSON object.",
        prompt: "evidence",
        schema: MemorySchema.MaintenanceResponse,
        maxOutputTokens: 32,
      })

      expect(seen[0].system).toContain("JSON")
      expect(seen[1].system).toBe("Propose updates as a JSON object.")
    }),
  )

  it.live("keeps an actively streaming call alive regardless of total duration", () =>
    Effect.gen(function* () {
      // Thirty parts arriving every 8ms: ~240ms total, far past the 40ms
      // idle window — every arrival re-arms the watchdog, so the call lives.
      async function* streaming() {
        for (let index = 0; index < 30; index++) {
          await new Promise((resolve) => setTimeout(resolve, 8))
          yield { type: index % 2 === 0 ? "reasoning" : "text-delta" }
        }
      }
      yield* Effect.promise(() =>
        MemoryModel.drainWithLiveness({
          parts: streaming(),
          connectTimeout: Duration.millis(40),
          idleTimeout: Duration.millis(40),
          onStall: () => {},
          errorOf: () => undefined,
        }),
      )
    }),
  )

  it.live("stalls a silent stream after the idle window and invokes the abort hook", () =>
    Effect.gen(function* () {
      let aborts = 0
      async function* onePartThenSilence() {
        yield { type: "reasoning" }
        await new Promise(() => {})
      }
      const error = yield* Effect.tryPromise({
        try: () =>
          MemoryModel.drainWithLiveness({
            parts: onePartThenSilence(),
            connectTimeout: Duration.millis(250),
            idleTimeout: Duration.millis(40),
            onStall: () => {
              aborts++
            },
            errorOf: () => undefined,
          }),
        catch: (cause) => cause,
      }).pipe(Effect.flip)
      expect(error instanceof MemoryModel.Stalled).toBe(true)
      expect(aborts).toBe(1)
    }),
  )

  it.live("fails on a dead connection that never delivers a first part", () =>
    Effect.gen(function* () {
      async function* nothing() {
        await new Promise(() => {})
      }
      const started = Date.now()
      const error = yield* Effect.tryPromise({
        try: () =>
          MemoryModel.drainWithLiveness({
            parts: nothing(),
            connectTimeout: Duration.millis(40),
            idleTimeout: Duration.millis(250),
            onStall: () => {},
            errorOf: () => undefined,
          }),
        catch: (cause) => cause,
      }).pipe(Effect.flip)
      expect(error instanceof MemoryModel.Stalled).toBe(true)
      // Fail-fast bound, not a scheduler bound: drainWithLiveness arms raw
      // setTimeout (no TestClock), and a loaded linux runner was observed
      // firing the 40ms connectTimeout at 288ms. 2000ms still separates
      // fail-fast from hang (a hang trips the test timeout instead).
      expect(Date.now() - started).toBeLessThan(2000)
    }),
  )

  it.live("propagates a stream error part without treating it as a stall", () =>
    Effect.gen(function* () {
      const boom = new Error("provider stream error")
      async function* erroring() {
        yield { type: "text-delta" }
        yield { type: "error", error: boom }
      }
      const error = yield* Effect.tryPromise({
        try: () =>
          MemoryModel.drainWithLiveness({
            parts: erroring(),
            connectTimeout: Duration.millis(250),
            idleTimeout: Duration.millis(250),
            onStall: () => {},
            errorOf: (part: { type: string; error?: unknown }) => (part.type === "error" ? part.error : undefined),
          }),
        catch: (cause) => cause,
      }).pipe(Effect.flip)
      expect(error).toBe(boom)
    }),
  )
})

describe("memory maintenance budgets", () => {
  const recall = recallFixture()

  recall.it.instance(
    "sizes match and maintenance output for reasoning-heavy models during checkpoint",
    () =>
      Effect.gen(function* () {
        recall.reset()
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_budget")
        const userID = MessageID.ascending()
        const messages: SessionV1.WithParts[] = [
          user(userID, sessionID, "确认一条长期偏好：回复保持简洁"),
          {
            info: assistant(userID, sessionID, ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"), "end_turn"),
            parts: [],
          },
        ]

        yield* memory.checkpoint({ sessionID, messages })
        // Checkpoint select runs synchronously; the kicked maintenance job
        // completes in the background (its inspect-match + maintain calls).
        yield* pollWithTimeout(
          Effect.sync(() => (recall.state.budgets.length === 3 ? (true as const) : undefined)),
          "background maintenance never completed",
        )
        expect([...recall.state.budgets].sort((a, b) => a - b)).toEqual([2_048, 2_048, 16_384])
        // A second checkpoint must run a second maintenance: the in-flight
        // slot is released when the first job finishes, never wedged.
        yield* pollWithTimeout(
          Effect.gen(function* () {
            if (recall.state.budgets.filter((budget) => budget === 16_384).length >= 2) return true as const
            yield* memory.checkpoint({ sessionID, messages })
            return undefined
          }),
          "second background maintenance never ran — in-flight slot wedged",
        )
      }),
    { git: true },
  )
})

describe("memory bootstrap", () => {
  const bootstrap = bootstrapFixture()

  bootstrap.it.instance(
    "creates global configuration from small_model without an initializer model call",
    () =>
      Effect.gen(function* () {
        bootstrap.reset()
        const memory = yield* Memory.Service

        yield* memory.init()

        expect(bootstrap.state.written).toEqual({
          schema_version: 1,
          enabled: true,
          model: "test/small",
          topic_limit: 10,
          turn_interval: 5,
          injection: { max_topics: 3, max_tokens: 1_200 },
        })
        expect(bootstrap.state.modelCalls).toBe(0)
        const logs = JSON.stringify(yield* logLines)
        expect(logs).toContain("global MEMORY config initialized")
        expect(logs).not.toContain("global MEMORY model replaced")
      }),
    { git: true },
  )

  bootstrap.it.instance(
    "falls through an unavailable small_model to configured agent.compaction.model",
    () =>
      Effect.gen(function* () {
        bootstrap.reset()
        bootstrap.state.smallModel = "test/removed"
        const memory = yield* Memory.Service

        yield* memory.init()

        expect(bootstrap.state.written?.model).toBe("test/compaction")
        expect(bootstrap.state.modelCalls).toBe(0)
      }),
    { git: true },
  )

  bootstrap.it.instance(
    "falls through unavailable configured models to the system default model",
    () =>
      Effect.gen(function* () {
        bootstrap.reset()
        bootstrap.state.smallModel = undefined
        bootstrap.state.compactionModel = "test/removed"
        const memory = yield* Memory.Service

        yield* memory.init()

        expect(bootstrap.state.written?.model).toBe("test/default")
        expect(bootstrap.state.modelCalls).toBe(0)
      }),
    { git: true },
  )

  bootstrap.it.instance(
    "preserves an existing configuration whose model remains available",
    () =>
      Effect.gen(function* () {
        bootstrap.reset()
        bootstrap.state.global = {
          ...config,
          model: "test/conversation",
          topic_limit: 42,
          turn_interval: 9,
        }
        const memory = yield* Memory.Service

        yield* memory.init()

        expect(bootstrap.state.written).toBeUndefined()
        expect(bootstrap.state.global).toMatchObject({
          model: "test/conversation",
          topic_limit: 42,
          turn_interval: 9,
        })
        expect(bootstrap.state.modelCalls).toBe(0)
      }),
    { git: true },
  )

  bootstrap.it.instance(
    "repairs a stale global model with the ordered resolver and preserves its settings",
    () =>
      Effect.gen(function* () {
        bootstrap.reset()
        bootstrap.state.smallModel = undefined
        bootstrap.state.global = {
          ...config,
          model: "removed/model",
          topic_limit: 37,
          turn_interval: 7,
        }
        const memory = yield* Memory.Service

        yield* memory.init()

        expect(bootstrap.state.written).toMatchObject({
          model: "test/compaction",
          topic_limit: 37,
          turn_interval: 7,
        })
        expect(bootstrap.state.modelCalls).toBe(0)
        const logs = JSON.stringify(yield* logLines)
        expect(logs).toContain("global MEMORY model replaced")
        expect(logs).toContain("previousModel")
        expect(logs).toContain("removed/model")
        expect(logs).toContain("test/compaction")
        expect(logs).toContain("/global/memory.jsonc")
        expect(logs).not.toContain("global MEMORY config initialized")
      }),
    { git: true },
  )

  bootstrap.it.instance(
    "defers without startup sources and creates configuration from the first real conversation model",
    () =>
      Effect.gen(function* () {
        bootstrap.reset()
        bootstrap.state.available = new Set(["test/conversation"])
        bootstrap.state.smallModel = undefined
        bootstrap.state.compactionModel = undefined
        bootstrap.state.defaultModel = undefined
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_lazy_bootstrap")

        yield* memory.init()
        expect(bootstrap.state.written).toBeUndefined()

        yield* memory.prepare({
          sessionID,
          messages: [user(MessageID.ascending(), sessionID, "记住这次对话", false, ModelV2.ID.make("conversation"))],
        })

        expect(bootstrap.state.written).toMatchObject({
          model: "test/conversation",
          topic_limit: 10,
          turn_interval: 5,
        })
        expect(bootstrap.state.modelCalls).toBe(0)
      }),
    { git: true },
  )

  bootstrap.it.instance(
    "repairs a stale global model from the first real conversation model after startup defers",
    () =>
      Effect.gen(function* () {
        bootstrap.reset()
        bootstrap.state.available = new Set(["test/conversation"])
        bootstrap.state.smallModel = undefined
        bootstrap.state.compactionModel = undefined
        bootstrap.state.defaultModel = undefined
        bootstrap.state.global = {
          ...config,
          model: "removed/model",
          topic_limit: 37,
          turn_interval: 7,
        }
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_lazy_stale_repair")

        yield* memory.init()
        expect(bootstrap.state.written).toBeUndefined()

        yield* memory.prepare({
          sessionID,
          messages: [user(MessageID.ascending(), sessionID, "继续这次对话", false, ModelV2.ID.make("conversation"))],
        })

        expect(bootstrap.state.written).toMatchObject({
          model: "test/conversation",
          topic_limit: 37,
          turn_interval: 7,
        })
        expect(bootstrap.state.modelCalls).toBe(0)
      }),
    { git: true },
  )

  bootstrap.it.instance(
    "creates missing global configuration from the first conversation even when project configuration exists",
    () =>
      Effect.gen(function* () {
        bootstrap.reset()
        bootstrap.state.available = new Set(["test/conversation"])
        bootstrap.state.smallModel = undefined
        bootstrap.state.compactionModel = undefined
        bootstrap.state.defaultModel = undefined
        bootstrap.state.project = { ...config, model: "test/conversation" }
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_project_config_global_bootstrap")

        yield* memory.init()
        expect(bootstrap.state.written).toBeUndefined()

        yield* memory.prepare({
          sessionID,
          messages: [
            user(
              MessageID.ascending(),
              sessionID,
              "为其他项目建立默认记忆配置",
              false,
              ModelV2.ID.make("conversation"),
            ),
          ],
        })

        expect(bootstrap.state.written).toMatchObject({
          model: "test/conversation",
          topic_limit: 10,
          turn_interval: 5,
        })
        expect(bootstrap.state.modelCalls).toBe(0)
      }),
    { git: true },
  )

  bootstrap.it.instance(
    "does not initialize from a historical real user when the current message is synthetic or a command",
    () =>
      Effect.gen(function* () {
        bootstrap.reset()
        bootstrap.state.available = new Set(["test/conversation"])
        bootstrap.state.smallModel = undefined
        bootstrap.state.compactionModel = undefined
        bootstrap.state.defaultModel = undefined
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_ineligible_bootstrap")
        const historical = user(
          MessageID.ascending(),
          sessionID,
          "historical real user",
          false,
          ModelV2.ID.make("conversation"),
        )

        yield* memory.prepare({
          sessionID,
          messages: [
            historical,
            user(MessageID.ascending(), sessionID, "synthetic continuation", true, ModelV2.ID.make("conversation")),
          ],
        })
        yield* memory.prepare({
          sessionID,
          messages: [
            historical,
            user(MessageID.ascending(), sessionID, "/goal write the docs", false, ModelV2.ID.make("conversation")),
          ],
        })

        expect(bootstrap.state.written).toBeUndefined()
        expect(bootstrap.state.modelCalls).toBe(0)
      }),
    { git: true },
  )

  bootstrap.it.instance(
    "serializes a first-turn fallback behind an overlapping startup attempt",
    () =>
      Effect.gen(function* () {
        bootstrap.reset()
        bootstrap.state.available = new Set(["test/conversation"])
        bootstrap.state.smallModel = undefined
        bootstrap.state.compactionModel = undefined
        bootstrap.state.defaultModel = undefined
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const preparationReady = yield* Deferred.make<void>()
        bootstrap.state.defaultModelHook = Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        })
        bootstrap.state.loadHook = Deferred.succeed(preparationReady, undefined)
        const memory = yield* Memory.Service
        const sessionID = SessionID.make("ses_memory_overlapping_bootstrap")

        const startup = yield* memory.init().pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const preparation = yield* memory
          .prepare({
            sessionID,
            messages: [
              user(MessageID.ascending(), sessionID, "并发启动后的首轮", false, ModelV2.ID.make("conversation")),
            ],
          })
          .pipe(Effect.forkChild)
        yield* Deferred.await(preparationReady)
        expect(bootstrap.state.written).toBeUndefined()
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(startup)
        yield* Fiber.join(preparation)

        expect(bootstrap.state.written?.model).toBe("test/conversation")
        expect(bootstrap.state.modelCalls).toBe(0)
      }),
    { git: true },
  )
})

describe("memory enablement", () => {
  unavailableModelIt.instance(
    "reselects an available model for startup and the only enable command",
    () =>
      Effect.gen(function* () {
        writtenGlobalConfig = undefined
        writtenProjectConfig = undefined
        loadedProjectDirectory = undefined
        migrationUnresolved = 0
        const memory = yield* Memory.Service
        yield* memory.init()
        expect(writtenGlobalConfig).toMatchObject({ model: "test/replacement" })
        expect(yield* memory.setEnabled(true)).toBe("Memory on")
        expect(writtenProjectConfig).toMatchObject({ enabled: true, model: "test/replacement" })
        expect(String(loadedProjectDirectory)).toBe("/unused")
      }),
    { git: true },
  )

  unavailableModelIt.instance(
    "keeps MEMORY inert until Project admission succeeds",
    () =>
      Effect.gen(function* () {
        loadedProjectDirectory = undefined
        migrationUnresolved = 1
        const memory = yield* Memory.Service

        expect(yield* memory.context(SessionID.make("ses_memory_unresolved"))).toEqual([])
        expect(loadedProjectDirectory).toBeUndefined()
        migrationUnresolved = 0
      }),
    { git: true },
  )
})

function statusFixture() {
  const replacement = ProviderTest.model({
    providerID: ProviderV2.ID.make("test"),
    id: ModelV2.ID.make("replacement"),
  })
  const state: { config: MemorySchema.Config; available: boolean } = {
    config: { ...config, enabled: true, model: "removed/model" },
    available: true,
  }
  const providerLayer = Layer.mock(Provider.Service, {
    list: () =>
      Effect.succeed(
        state.available
          ? {
              [replacement.providerID]: ProviderTest.info({
                id: replacement.providerID,
                models: { [replacement.id]: replacement },
              }),
            }
          : {},
      ),
    getModel: (providerID, modelID) =>
      Effect.succeed(
        ProviderTest.model({
          providerID,
          id: modelID,
        }),
      ),
  })
  const layer = Memory.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        emptyConfigLayer,
        EffectFlock.defaultLayer,
        MemoryHome.defaultLayer,
        MemoryIdentityFence.defaultLayer,
        providerLayer,
        Layer.mock(Project.Service, {
          get: (id) =>
            Effect.succeed({
              id,
              worktree: "/unused",
              vcs: "git" as const,
              time: { created: 0, updated: 0, initialized: 1 },
              sandboxes: [],
            }),
        }),
        Layer.mock(MemoryConfig.Service, {
          load: (directory) => Effect.succeed({ config: state.config, path: directory, level: "project" as const }),
          loadGlobal: () => Effect.succeed(undefined),
          writeGlobal: () => Effect.succeed(true),
          writeProject: () => Effect.void,
        }),
        readyAdmissionLayer,
        MemoryLock.defaultLayer,
        Layer.mock(MemoryModel.Service, {
          generate: () => Effect.die(new Error("status surfaces must not call a model")),
        }),
        Layer.mock(MemoryStore.Service, {
          readTopics: () => Effect.succeed([]),
        }),
      ),
    ),
  )
  return { state, it: testEffect(layer) }
}

describe("memory status truthfulness (issues #396 #397)", () => {
  const status = statusFixture()

  status.it.instance(
    "reports why an enabled config is inert when its model is gone",
    () =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const reason = yield* memory.statusReason()
        if (reason === undefined) return yield* Effect.fail(new Error("expected a model-unavailability reason"))
        expect(reason).toContain("model is unavailable")
        expect(yield* memory.status()).toBe(reason)
        expect(yield* memory.setEnabled(true)).toContain("model is unavailable")
      }),
    { git: true },
  )

  status.it.instance(
    "reports the true on/off state once the model resolves",
    () =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        status.state.config = { ...config, enabled: true, model: "test/replacement" }
        expect(yield* memory.statusReason()).toBeUndefined()
        expect(yield* memory.status()).toBe("Memory on")
        status.state.config = { ...config, enabled: false, model: "test/replacement" }
        expect(yield* memory.status()).toBe("Memory remains off")
      }),
    { git: true },
  )

  status.it.instance(
    "surfaces the model reason when /memory on cannot reselect any model",
    () =>
      Effect.gen(function* () {
        status.state.config = { ...config, enabled: true, model: "removed/model" }
        status.state.available = false
        const memory = yield* Memory.Service
        expect(yield* memory.setEnabled(true)).toContain("model is unavailable")
      }),
    { git: true },
  )
})

function assistant(
  parentID: MessageID,
  sessionID: SessionID,
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  finish: string,
): SessionV1.Assistant {
  return {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    parentID,
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    providerID,
    modelID,
    time: { created: 1 },
    finish,
  }
}

function user(
  id: MessageID,
  sessionID: SessionID,
  text: string,
  synthetic = false,
  modelID = ModelV2.ID.make("test-model"),
): SessionV1.WithParts {
  const providerID = ProviderV2.ID.make("test")
  return {
    info: {
      id,
      role: "user",
      sessionID,
      time: { created: 1 },
      agent: "build",
      model: { providerID, modelID },
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID,
        type: "text",
        text,
        ...(synthetic ? { synthetic: true } : {}),
      },
    ],
  }
}
