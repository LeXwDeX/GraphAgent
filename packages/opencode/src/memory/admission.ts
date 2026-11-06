export * as MemoryAdmission from "./admission"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { basename, join } from "node:path"
import { parse } from "yaml"
import { MemoryConfig } from "./config"
import { MemoryHome } from "./home"
import { MemoryIdentityFence } from "./identity-fence"
import { MemoryPaths } from "./paths"
import { MemorySchema } from "./schema"
import { MemoryStore } from "./store"

const Code = Schema.Literals([
  "topic.imported",
  "topic.duplicate",
  "topic.invalid",
  "topic.conflict",
  "config.promoted",
  "config.duplicate",
  "config.invalid",
  "config.conflict",
])
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

export class Diagnostic extends Schema.Class<Diagnostic>("MemoryAdmission.Diagnostic")({
  code: Code,
  path: Schema.String,
  topic_id: Schema.optional(Schema.String),
  message: Schema.String,
}) {}

export class Result extends Schema.Class<Result>("MemoryAdmission.Result")({
  diagnostics: Schema.Array(Diagnostic),
  imported: Count,
  duplicates: Count,
  unresolved: Count,
}) {}

export class ProjectSnapshot extends Schema.Class<ProjectSnapshot>("MemoryAdmission.ProjectSnapshot")({
  projectID: ProjectV2.ID,
  projectDirectory: Schema.String,
  directories: Schema.Array(Schema.String),
  updated: Schema.Number,
}) {}

/**
 * The identity was retired between the caller's snapshot and fence
 * acquisition. The import is abandoned: writing would re-create the retired
 * Home and destroy the only remaining copy of the legacy content.
 */
export class IdentityRetiredError extends Schema.TaggedError<IdentityRetiredError>()(
  "MemoryAdmission.IdentityRetired",
  { project_id: Schema.String },
) {}

export interface Interface {
  readonly ensure: (
    snapshot: ProjectSnapshot,
  ) => Effect.Effect<Result, FSUtil.Error | MemoryStore.StoreError | EffectFlock.LockError | IdentityRetiredError>
  readonly invalidate: (projectID: ProjectV2.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryAdmission") {}

type TopicCandidate = {
  readonly file: string
  readonly id: string
  readonly topic?: MemoryStore.Snapshot["topics"][number]
}

type ConfigCandidate = {
  readonly file: string
  readonly config: MemorySchema.Config | undefined
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service
    const fence = yield* MemoryIdentityFence.Service
    const config = yield* MemoryConfig.Service
    const home = yield* MemoryHome.Service
    const store = yield* MemoryStore.Service
    const cache = new Map<ProjectV2.ID, { key: string; result: Result }>()

    const readTopicCandidates = Effect.fnUntraced(function* (directories: ReadonlyArray<string>) {
      return yield* Effect.forEach(
        directories,
        (directory) =>
          Effect.gen(function* () {
            const legacy = MemoryPaths.legacyTopics(directory)
            if (!(yield* fs.existsSafe(legacy))) return []
            const files = (yield* fs.readDirectoryEntries(legacy))
              .filter((entry) => entry.type === "file" && entry.name.endsWith(".yaml"))
              .map((entry) => join(legacy, entry.name))
              .sort()
            return yield* Effect.forEach(
              files,
              (file) =>
                Effect.gen(function* () {
                  const id = basename(file, ".yaml")
                  const text = yield* fs.readFileString(file)
                  const parsed = yield* Effect.try({
                    try: () => parse(text),
                    catch: () => new MemoryStore.StoreError({ message: "Legacy MEMORY topic YAML is invalid" }),
                  }).pipe(Effect.option)
                  return {
                    file,
                    id,
                    topic: Option.isSome(parsed) ? MemoryStore.decodeTopic(parsed.value, id) : undefined,
                  } satisfies TopicCandidate
                }),
              { concurrency: 8 },
            )
          }),
        { concurrency: 4 },
      ).pipe(Effect.map((items) => items.flat().sort((left, right) => left.file.localeCompare(right.file))))
    })

    // A legacy file may change between the scan and its removal (an older-version
    // runtime still writing .opencode/memory, or a hand edit). Re-read each file
    // right before deleting it; if the content no longer matches what was scanned,
    // preserve the file and surface a conflict instead of destroying the new content.
    const revalidateTopicFile = Effect.fnUntraced(function* (candidate: TopicCandidate) {
      const text = yield* fs.readFileStringSafe(candidate.file)
      if (text === undefined) return true
      const parsed = yield* Effect.try({
        try: () => parse(text),
        catch: () => undefined,
      }).pipe(Effect.option)
      if (Option.isNone(parsed) || parsed.value === undefined) return false
      const decoded = MemoryStore.decodeTopic(parsed.value, candidate.id)
      return decoded !== undefined && same(decoded, candidate.topic)
    })

    const reconcileTopics = Effect.fnUntraced(function* (snapshot: ProjectSnapshot, candidates: TopicCandidate[]) {
      const updated = yield* store.updateTopics(snapshot.projectID, (topics) => {
        const next = [...topics]
        const byID = new Map(next.map((topic) => [topic.id, topic]))
        const changed: string[] = []
        const removable: TopicCandidate[] = []
        const diagnostics = candidates.map((candidate) => {
          if (!candidate.topic)
            return new Diagnostic({
              code: "topic.invalid",
              path: candidate.file,
              topic_id: candidate.id,
              message: `Legacy MEMORY topic ${candidate.id} is invalid and was preserved`,
            })
          const existing = byID.get(candidate.id)
          if (!existing) {
            next.push(candidate.topic)
            byID.set(candidate.id, candidate.topic)
            changed.push(candidate.id)
            removable.push(candidate)
            return new Diagnostic({
              code: "topic.imported",
              path: candidate.file,
              topic_id: candidate.id,
              message: `Legacy MEMORY topic ${candidate.id} was imported into Project Memory`,
            })
          }
          if (same(existing, candidate.topic)) {
            removable.push(candidate)
            return new Diagnostic({
              code: "topic.duplicate",
              path: candidate.file,
              topic_id: candidate.id,
              message: `Legacy MEMORY topic ${candidate.id} already exists in Project Memory`,
            })
          }
          return new Diagnostic({
            code: "topic.conflict",
            path: candidate.file,
            topic_id: candidate.id,
            message: `Legacy MEMORY topic ${candidate.id} differs from Project Memory and was preserved`,
          })
        })
        return {
          applied: { topics: next, changed, deleted: [] },
          result: { diagnostics, removable },
        }
      })
      const preserved = new Set<string>()
      for (const candidate of updated.result.removable) {
        if (!(yield* revalidateTopicFile(candidate))) preserved.add(candidate.file)
      }
      yield* Effect.forEach(
        updated.result.removable.filter((candidate) => !preserved.has(candidate.file)),
        (candidate) => fs.remove(candidate.file, { force: true }),
        {
          concurrency: 1,
          discard: true,
        },
      )
      return updated.result.diagnostics.map((diagnostic) =>
        preserved.has(diagnostic.path)
          ? new Diagnostic({
              code: "topic.conflict",
              path: diagnostic.path,
              topic_id: diagnostic.topic_id,
              message: `Legacy MEMORY topic ${diagnostic.topic_id} changed during migration and was preserved`,
            })
          : diagnostic,
      )
    })

    const readConfigCandidates = Effect.fnUntraced(function* (directories: ReadonlyArray<string>) {
      const files = directories.flatMap((directory) =>
        MemoryPaths.PROJECT_CONFIG_PATHS.map((relative) => join(directory, relative)),
      )
      // Keep the flatMap order (directory-major, and within one directory
      // memory.jsonc BEFORE memory.json — exactly MemoryConfig.load's
      // precedence). A localeCompare sort would flip jsonc/json and make
      // admission disagree with the runtime loader about which file is
      // authoritative.
      const order = new Map(files.map((file, index) => [file, index]))
      return yield* Effect.forEach(
        files,
        (file) =>
          Effect.gen(function* () {
            const text = yield* fs.readFileStringSafe(file)
            if (text === undefined) return undefined
            const decoded = MemoryConfig.decodeConfig(text)
            return {
              file,
              config: Option.isSome(decoded) ? decoded.value : undefined,
            } satisfies ConfigCandidate
          }),
        { concurrency: 4 },
      ).pipe(
        Effect.map((items) =>
          items
            .filter((item): item is ConfigCandidate => item !== undefined)
            .sort((left, right) => (order.get(left.file) ?? 0) - (order.get(right.file) ?? 0)),
        ),
      )
    })

    // Same stale-scan protection as topics: a config file may change between the
    // scan and its removal. Re-read and compare before deleting.
    const revalidateConfigFile = Effect.fnUntraced(function* (candidate: ConfigCandidate) {
      const text = yield* fs.readFileStringSafe(candidate.file)
      if (text === undefined) return true
      const decoded = MemoryConfig.decodeConfig(text)
      if (Option.isNone(decoded)) return false
      return same(decoded.value, candidate.config)
    })

    const removeValidated = Effect.fnUntraced(function* (candidates: ReadonlyArray<ConfigCandidate>) {
      const preserved = new Set<string>()
      for (const candidate of candidates) {
        if (!(yield* revalidateConfigFile(candidate))) preserved.add(candidate.file)
      }
      yield* Effect.forEach(
        candidates.filter((candidate) => !preserved.has(candidate.file)),
        (candidate) => fs.remove(candidate.file, { force: true }),
        { concurrency: 1, discard: true },
      )
      return preserved
    })

    const reconcileConfigs = Effect.fnUntraced(function* (snapshot: ProjectSnapshot) {
      const project = yield* readConfigCandidates([snapshot.projectDirectory])
      const legacy = yield* readConfigCandidates(
        snapshot.directories.filter((directory) => directory !== snapshot.projectDirectory),
      )
      const explicit = project[0]
      if (explicit) {
        const diagnostics: Diagnostic[] = []
        if (!explicit.config)
          diagnostics.push(
            new Diagnostic({
              code: "config.invalid",
              path: explicit.file,
              message: "Project MEMORY config is invalid and was preserved",
            }),
          )
        // A project directory holding BOTH memory.jsonc and memory.json is a
        // fork of the durable configuration: diagnose it explicitly instead of
        // silently following one side. Equal copies collapse to a duplicate.
        for (const extra of project.slice(1)) {
          if (!extra.config || !explicit.config) {
            diagnostics.push(
              new Diagnostic({
                code: "config.invalid",
                path: extra.file,
                message: "Project MEMORY config is invalid and was preserved",
              }),
            )
          } else if (same(extra.config, explicit.config)) {
            const preserved = yield* removeValidated([extra])
            diagnostics.push(
              preserved.has(extra.file)
                ? new Diagnostic({
                    code: "config.conflict",
                    path: extra.file,
                    message: "Project MEMORY config changed during migration and was preserved",
                  })
                : new Diagnostic({
                    code: "config.duplicate",
                    path: extra.file,
                    message: "Project MEMORY config duplicates the authoritative config and was removed",
                  }),
            )
          } else {
            diagnostics.push(
              new Diagnostic({
                code: "config.conflict",
                path: extra.file,
                message: "Project MEMORY config fork (jsonc/json) disagrees with the authoritative config and was preserved",
              }),
            )
          }
        }
        const duplicates = legacy.filter(
          (candidate) => candidate.config && explicit.config && same(candidate.config, explicit.config),
        )
        const preserved = yield* removeValidated(duplicates)
        for (const candidate of legacy) {
          if (duplicates.some((duplicate) => duplicate.file === candidate.file)) {
            diagnostics.push(
              preserved.has(candidate.file)
                ? new Diagnostic({
                    code: "config.conflict",
                    path: candidate.file,
                    message: "Legacy sandbox MEMORY config changed during migration and was preserved",
                  })
                : new Diagnostic({
                    code: "config.duplicate",
                    path: candidate.file,
                    message: "Legacy sandbox MEMORY config duplicates the Project config",
                  }),
            )
          } else {
            diagnostics.push(
              new Diagnostic({
                code: candidate.config ? "config.conflict" : "config.invalid",
                path: candidate.file,
                message: candidate.config
                  ? "Legacy sandbox MEMORY config differs from the Project config and was preserved"
                  : "Legacy sandbox MEMORY config is invalid and was preserved",
              }),
            )
          }
        }
        return diagnostics
      }

      const valid = legacy.filter(
        (candidate): candidate is ConfigCandidate & { config: NonNullable<ConfigCandidate["config"]> } =>
          candidate.config !== undefined,
      )
      const values = new Map(valid.map((candidate) => [JSON.stringify(candidate.config), candidate.config]))
      if (values.size !== 1)
        return legacy.map(
          (candidate) =>
            new Diagnostic({
              code: candidate.config ? "config.conflict" : "config.invalid",
              path: candidate.file,
              message: candidate.config
                ? "Legacy sandbox MEMORY configs disagree and were preserved"
                : "Legacy sandbox MEMORY config is invalid and was preserved",
            }),
        )

      const promoted = valid[0]
      yield* config.writeProject(snapshot.projectDirectory, promoted.config)
      const preserved = yield* removeValidated(valid)
      return legacy.map(
        (candidate) =>
          new Diagnostic({
            code: !candidate.config
              ? "config.invalid"
              : preserved.has(candidate.file)
                ? "config.conflict"
                : candidate.file === promoted.file
                  ? "config.promoted"
                  : "config.duplicate",
            path: candidate.file,
            message: !candidate.config
              ? "Legacy sandbox MEMORY config is invalid and was preserved"
              : preserved.has(candidate.file)
                ? "Legacy sandbox MEMORY config changed during migration and was preserved"
                : candidate.file === promoted.file
                  ? "Legacy sandbox MEMORY config was promoted to the Project config"
                  : "Legacy sandbox MEMORY config duplicates the promoted Project config",
          }),
      )
    })

    const cleanupLegacyDirectory = Effect.fnUntraced(function* (directory: string) {
      const topics = MemoryPaths.legacyTopics(directory)
      if ((yield* fs.existsSafe(topics)) && (yield* fs.readDirectoryEntries(topics)).length === 0) {
        // Re-check immediately before removing: an older-version writer that
        // does not take our locks may have created a file after the first
        // listing. Removing on a stale empty listing would destroy it.
        if ((yield* fs.readDirectoryEntries(topics)).length === 0) yield* fs.remove(topics, { recursive: true })
      }
      const legacy = join(directory, ".opencode", "memory")
      if ((yield* fs.existsSafe(legacy)) && (yield* fs.readDirectoryEntries(legacy)).length === 0) {
        if ((yield* fs.readDirectoryEntries(legacy)).length === 0) yield* fs.remove(legacy, { recursive: true })
      }
    })

    const ensureUnsafe = Effect.fnUntraced(function* (snapshot: ProjectSnapshot, key: string) {
      const cached = cache.get(snapshot.projectID)
      if (cached?.key === key) return cached.result
      const candidates = yield* readTopicCandidates(snapshot.directories)
      const diagnostics = [
        ...(yield* reconcileTopics(snapshot, candidates)),
        ...(yield* reconcileConfigs(snapshot)),
      ]
      yield* Effect.forEach(snapshot.directories, cleanupLegacyDirectory, { concurrency: 1, discard: true })
      const result = new Result({
        diagnostics,
        imported: diagnostics.filter((item) => item.code === "topic.imported").length,
        duplicates: diagnostics.filter((item) => item.code.endsWith(".duplicate")).length,
        unresolved: diagnostics.filter((item) => item.code.endsWith(".invalid") || item.code.endsWith(".conflict")).length,
      })
      if (result.unresolved === 0) cache.set(snapshot.projectID, { key, result })
      return result
    })

    const ensure = Effect.fn("MemoryAdmission.ensure")(function* (snapshot: ProjectSnapshot) {
      const directories = Array.from(new Set([snapshot.projectDirectory, ...snapshot.directories])).sort()
      const normalized = new ProjectSnapshot({
        projectID: snapshot.projectID,
        projectDirectory: snapshot.projectDirectory,
        directories,
        updated: snapshot.updated,
      })
      const key = JSON.stringify([snapshot.projectID, directories, snapshot.updated])
      // Lock order (outermost→innermost): memory-admission → memory-identity →
      // memory-project (inside updateTopics). The identity fence is owned by
      // MemoryIdentityFence: it re-checks identity liveness inside the fence,
      // so the import can never re-create a retired Home or delete the legacy
      // source files after a concurrent retirement.
      return yield* flock.withLock(
        Effect.gen(function* () {
          const imported = yield* fence.withLiveIdentity(snapshot.projectID, ensureUnsafe(normalized, key))
          if (Option.isNone(imported)) {
            return yield* new IdentityRetiredError({ project_id: snapshot.projectID })
          }
          return imported.value
        }),
        `memory-admission:${snapshot.projectID}`,
        home.locks,
      )
    })

    const invalidate = Effect.fn("MemoryAdmission.invalidate")((projectID: ProjectV2.ID) =>
      Effect.sync(() => {
        cache.delete(projectID)
      }),
    )

    return Service.of({ ensure, invalidate })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(MemoryConfig.defaultLayer),
  Layer.provide(MemoryHome.defaultLayer),
  Layer.provide(MemoryStore.defaultLayer),
  Layer.provide(MemoryIdentityFence.defaultLayer),
)

export const node = LayerNode.make(layer, [
  FSUtil.node,
  EffectFlock.node,
  MemoryConfig.node,
  MemoryHome.node,
  MemoryStore.node,
  MemoryIdentityFence.node,
])

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}
